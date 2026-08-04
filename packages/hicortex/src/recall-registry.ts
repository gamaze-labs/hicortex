/**
 * SessionRecallRegistry — per-session, TURN-based dedup for pushed recall
 * (#192, POST /recall-index), and owner of the session-intent rolling
 * centroid (#192 session-intent keying, 0.15.3).
 *
 * Why turn-based, not time-based: suppression must track the session's
 * CONTEXT, not the wall clock. A multi-day CC session with a 1M window can
 * hold hundreds of turns; a shown memory is redundant while it is plausibly
 * still in context and useful again once enough turns have passed (or the
 * context was compacted away). Turn count is the proxy the server can own
 * without clients reporting token volumes.
 *
 * Semantics:
 *   - Every non-reset /recall-index call for a session advances its turn
 *     counter by one.
 *   - A memory id shown at turn T is suppressed until turn T + reshowTurns.
 *   - reset(sessionId) clears the session's shown-set (fired by the CC
 *     SessionStart hook — which includes source=compact, i.e. after
 *     compaction the fresh context may legitimately re-receive everything).
 *
 * Session-intent centroid (0.15.3): a rolling EMA of the session's prompt
 * embeddings lives on SessionState. The recall path blends the current prompt
 * with this centroid before the vector search so recall follows the session's
 * intent instead of being query-literal. reset() deletes the whole session
 * entry, so the centroid is cleared for free on SessionStart/compact — the
 * next recall re-seeds.
 *
 * Concurrency: the registry assumes ONE in-flight recall per session at a time
 * (CC's UserPromptSubmit fires once per turn; Hermes/OC plugins call per-turn
 * too). Two concurrent same-session calls could race updateCentroid and drop
 * one EMA step — harmless (self-correcting on the next turn) and not worth a
 * lock for a path that does not fire concurrently in any current harness.
 *
 * Purely in-memory: a server restart forgets shown-state, worst case a few
 * early re-shows (~15 tokens each) — harmless by design. Sessions are pruned
 * LRU beyond maxSessions so long-running servers don't accumulate state.
 */

import { l2Normalize, weightedAdd } from "./schema-prototypes.js";

export interface RecallRegistryOptions {
  /** Turns a shown id stays suppressed. Config `recallReshowTurns`, default 30. */
  reshowTurns?: number;
  /** Max tracked sessions before LRU eviction. */
  maxSessions?: number;
}

interface SessionState {
  turn: number;
  /** memory id → turn at which it was last shown */
  shown: Map<string, number>;
  lastUsedAt: number;
  /** Session-intent rolling centroid (#192 session-intent keying). Undefined
   *  until the first updateCentroid() call seeds it; reset() (which deletes
   *  the session entry) clears it. Stored L2-normalized. */
  centroid?: Float32Array;
}

export const DEFAULT_RESHOW_TURNS = 30;
const DEFAULT_MAX_SESSIONS = 500;

export class SessionRecallRegistry {
  private readonly reshowTurns: number;
  private readonly maxSessions: number;
  private readonly sessions = new Map<string, SessionState>();

  constructor(options?: RecallRegistryOptions) {
    const turns = Number(options?.reshowTurns);
    this.reshowTurns =
      Number.isFinite(turns) && turns > 0 ? Math.floor(turns) : DEFAULT_RESHOW_TURNS;
    const max = Number(options?.maxSessions);
    this.maxSessions =
      Number.isFinite(max) && max > 0 ? Math.floor(max) : DEFAULT_MAX_SESSIONS;
  }

  /** Advance the session's turn counter (one call = one turn). */
  beginTurn(sessionId: string): number {
    const s = this.getOrCreate(sessionId);
    s.turn += 1;
    s.lastUsedAt = Date.now();
    return s.turn;
  }

  /** True when the id has not been shown within the last reshowTurns turns. */
  isShowable(sessionId: string, memoryId: string): boolean {
    const s = this.sessions.get(sessionId);
    if (!s) return true;
    const shownAt = s.shown.get(memoryId);
    if (shownAt === undefined) return true;
    return s.turn - shownAt >= this.reshowTurns;
  }

  /** Record ids as shown at the session's current turn. */
  markShown(sessionId: string, memoryIds: string[]): void {
    if (memoryIds.length === 0) return;
    const s = this.getOrCreate(sessionId);
    for (const id of memoryIds) s.shown.set(id, s.turn);
    s.lastUsedAt = Date.now();
  }

  /** Forget a session's shown-set (SessionStart / compaction). */
  reset(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * Current session-intent centroid, or undefined when no prompt has seeded it
   * yet (first turn / after a reset). The recall path reads this BEFORE
   * updateCentroid to decide whether to blend — a missing centroid means
   * "first turn, pure prompt, no behavior change".
   */
  getCentroid(sessionId: string): Float32Array | undefined {
    return this.sessions.get(sessionId)?.centroid;
  }

  /**
   * Fold this turn's prompt embedding into the session-intent centroid via
   * EMA: `centroid_new = l2Normalize((1-α)·centroid_old + α·prompt)`.
   *
   * First call (no centroid yet) SEEDS the centroid = l2Normalize(prompt) —
   * this is the "after that first recall" step in the design: turn 1's search
   * runs with pure prompt, then the centroid is seeded so turn 2+ can blend.
   *
   * `alpha` is the EMA rate (a shipped constant — retrieval.SESSION_INTENT_ALPHA,
   * 0.4; NOT a config knob per the 0.15.3 scope). Callers (the recall closure)
   * read it from retrieval.getSessionIntent(). We do not re-clamp here — the
   * registry is a pure data owner, not a config interpreter.
   *
   * Returns the new centroid. The centroid lives on SessionState, so reset()
   * (which deletes the session entry) clears it for free.
   */
  updateCentroid(
    sessionId: string,
    promptEmbedding: Float32Array,
    alpha: number
  ): Float32Array {
    const s = this.getOrCreate(sessionId);
    if (!s.centroid) {
      s.centroid = l2Normalize(promptEmbedding);
    } else {
      s.centroid = l2Normalize(
        weightedAdd(s.centroid, 1 - alpha, promptEmbedding, alpha)
      );
    }
    s.lastUsedAt = Date.now();
    return s.centroid;
  }

  /** Number of tracked sessions (for /recall-index introspection + tests). */
  size(): number {
    return this.sessions.size;
  }

  private getOrCreate(sessionId: string): SessionState {
    let s = this.sessions.get(sessionId);
    if (!s) {
      this.evictIfNeeded();
      s = { turn: 0, shown: new Map(), lastUsedAt: Date.now() };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  private evictIfNeeded(): void {
    if (this.sessions.size < this.maxSessions) return;
    let oldestId: string | null = null;
    let oldestAt = Infinity;
    for (const [id, s] of this.sessions) {
      if (s.lastUsedAt < oldestAt) {
        oldestAt = s.lastUsedAt;
        oldestId = id;
      }
    }
    if (oldestId) this.sessions.delete(oldestId);
  }
}
