/**
 * Operator capture pause (#423 phase 3, D3) — the server-side 200-skip.
 *
 * A pause is a row in `capture_pauses` (migration v18): machine × harness →
 * paused_at. A row EXISTS = paused for that bundle; the /distill handler
 * reads the table per POST, so a pause takes effect on the very next post —
 * no restart — and answers 200 {skipped: true, paused: true}. The 200 is the
 * whole point: capture.ts treats every 200 as confirmed and advances its
 * cursor, so sessions that arrive while paused are deliberately NOT captured
 * and are never re-sent or backfilled. Zero client changes.
 *
 * THE BUNDLE KEY. The pause's (machine, harness) must derive EXACTLY like
 * the traffic it gates: machine via storage.sanitizeSourceMachine ('' when
 * absent) and harness via harnessOfAgent below — the same normalization
 * recordDistillActivity applies when it writes distill_activity, and the same
 * "harness/profile" → "harness" split the console groups its bundles on. A
 * key derived any other way would never match and the pause would silently
 * not fire.
 *
 * LAST-SEEN (presence dots) derives ONLY from /distill activity — the one
 * per-agent-identified traffic the server sees. Recall traffic (/search,
 * /recall-index, /memory) carries no agent/machine identity on the wire, so
 * attributing it would need new client fields — the heartbeats the spec
 * forbids. Thresholds (green ≤36h — a nightly poster reads online through
 * the following day; amber ≤7d; none beyond or with no rows) are page-side
 * presentation; this module just reports the newest ts per bundle. (Amber's
 * 7d predates and outlives the old 7-day retention — activity rows are now
 * kept for the capture card's 30-day window, CAPTURE_HEALTH_WINDOW_DAYS;
 * the dot's thresholds are a design choice, not a retention artifact.)
 *
 * Pure, unit-testable without express (the capture-health.ts layering):
 * mcp-server.ts and dashboard.ts wire these functions to the live db.
 */

import type Database from "better-sqlite3";

import { sanitizeSourceMachine } from "./storage.js";

/** The bundle half of a pause key: "harness/profile" → "harness". */
export interface CapturePauseKey {
  /** Sanitized machine ('' when the post carried none) — matches distill_activity. */
  machine: string;
  /** The harness name (pre-slash part, 128-char cap; 'unknown' when absent/blank). */
  harness: string;
}

/** One paused bundle as the dashboard fleet block serves it. */
export interface CapturePause {
  machine: string;
  harness: string;
  paused_at: string;
}

/** One bundle's newest /distill activity row (the presence signal). */
export interface FleetLastSeen {
  machine: string;
  harness: string;
  last_seen: string;
  /** The outcome of that newest row ('ok' | 'skipped' | 'held' | 'paused'). */
  last_outcome: string;
}

/**
 * Derive the harness from a source_agent wire value — the bundle split the
 * console already uses ("claude-code/main" → "claude-code"): the part before
 * the first '/' when a slash is present at index > 0, else the whole trimmed
 * string, capped at 128. Non-string/blank → "unknown" (mirrors how
 * recordDistillActivity stores the agent when absent).
 */
export function harnessOfAgent(sourceAgent: unknown): string {
  if (typeof sourceAgent !== "string") return "unknown";
  const t = sourceAgent.trim();
  if (t.length === 0) return "unknown";
  const slash = t.indexOf("/");
  return (slash > 0 ? t.slice(0, slash) : t).slice(0, 128);
}

/**
 * Normalize the raw /distill wire fields into the pause key. MUST match the
 * recordDistillActivity normalization (machine '' when absent, agent
 * 'unknown' when absent) and the console's bundle grouping
 * ((machine||'')+'|'+harness) — see the module doc.
 */
export function capturePauseKey(machine: unknown, sourceAgent: unknown): CapturePauseKey {
  return {
    machine: sanitizeSourceMachine(machine) ?? "",
    harness: harnessOfAgent(sourceAgent),
  };
}

/** True when a pause row exists for the (machine, harness) bundle. */
export function isCapturePaused(
  db: Database.Database,
  machine: string,
  harness: string,
): boolean {
  return (
    db
      .prepare("SELECT 1 FROM capture_pauses WHERE machine = ? AND harness = ?")
      .get(machine, harness) !== undefined
  );
}

/**
 * Pause (upsert the row, timestamp now) or resume (delete it). Returns the
 * persisted paused_at when pausing, null when resuming. No pruning, ever —
 * see migration v18's provenance comment.
 */
export function setCapturePause(
  db: Database.Database,
  machine: string,
  harness: string,
  paused: boolean,
): string | null {
  if (!paused) {
    db.prepare("DELETE FROM capture_pauses WHERE machine = ? AND harness = ?").run(machine, harness);
    return null;
  }
  const pausedAt = new Date().toISOString();
  db.prepare(
    "INSERT OR REPLACE INTO capture_pauses (machine, harness, paused_at) VALUES (?, ?, ?)",
  ).run(machine, harness, pausedAt);
  return pausedAt;
}

/** Every paused bundle (newest first) — the dashboard fleet.pauses block. */
export function listCapturePauses(db: Database.Database): CapturePause[] {
  return db
    .prepare("SELECT machine, harness, paused_at FROM capture_pauses ORDER BY paused_at DESC")
    .all() as CapturePause[];
}

/**
 * The newest /distill activity per bundle: for each (machine, agent) take
 * MAX(ts) with that latest row's outcome, derive the harness per agent, then
 * merge same-bundle agents keeping the newest ts (one dot per bundle, not
 * per profile). Reads only distill_activity, which the recorder prunes to
 * the capture card's rolling window (CAPTURE_HEALTH_WINDOW_DAYS) —
 * older-than-window bundles simply have no rows and no dot.
 */
export function readFleetLastSeen(db: Database.Database): FleetLastSeen[] {
  const rows = db
    .prepare(
      `SELECT a.machine, a.agent, a.ts, a.outcome
         FROM distill_activity a
         JOIN (
           SELECT machine, agent, MAX(ts) AS max_ts
             FROM distill_activity
            GROUP BY machine, agent
         ) latest
           ON a.machine = latest.machine AND a.agent = latest.agent AND a.ts = latest.max_ts`,
    )
    .all() as Array<{ machine: string; agent: string; ts: string; outcome: string }>;

  const byBundle = new Map<string, FleetLastSeen>();
  for (const r of rows) {
    const key = `${r.machine}|${harnessOfAgent(r.agent)}`;
    const prev = byBundle.get(key);
    if (!prev || r.ts > prev.last_seen) {
      byBundle.set(key, {
        machine: r.machine,
        harness: harnessOfAgent(r.agent),
        last_seen: r.ts,
        last_outcome: r.outcome,
      });
    }
  }
  return [...byBundle.values()].sort((a, b) => (a.last_seen < b.last_seen ? 1 : -1));
}
