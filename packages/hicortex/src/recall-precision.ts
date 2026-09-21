/**
 * Memory Precision (#476) — the event store behind the console's Memory
 * Precision card, and the two-level context model made visible:
 *
 *   - Level 1 (pushed index): what every prompt receives unasked. One
 *     `recall_pushes` row per NON-skipped /recall-index call + one
 *     `recall_events` kind='shown' row per pushed line, carrying the RAW
 *     cosines (similarity to the prompt, redundancy vs standing context) —
 *     stored threshold-free, verdicts computed at render so recalibration
 *     never rewrites history.
 *   - Level 2 (recall depth): what the agent fetches when needed. One
 *     `recall_events` kind='fetch' row per handleMemoryGet — the ONE funnel
 *     the REST GET /memory and MCP hicortex_get paths share.
 *
 * Layering (the recall-index.ts / capture-health.ts convention): all write +
 * aggregation logic lives here as pure functions over the db handle so tests
 * exercise them without HTTP; mcp-server.ts only wires the record calls into
 * the /recall-index and fetch funnels, and dashboard.ts spreads the window
 * aggregation into /dashboard/data.
 *
 * FAIL-SOFT LAW: recording is telemetry. Any error here is caught by the
 * CALLER (handleRecallIndex / handleMemoryGet) and swallowed — the recall
 * response (status 200 + block) is never affected, and the exposure signal
 * (touchMemoriesShown) never depends on it (the handler falls back to the
 * plain exposure write when recording is absent or fails).
 *
 * The perf law (bounded hot-path cost): the recorder computes cosines with
 * the request's ALREADY-MEMOIZED prompt embedding (createRecallRetrieveFn's
 * embedPrompt — zero extra embeds) against STORED memory vectors, and writes
 * one transaction of ≤ maxItems+1 INSERTs — microseconds inside an endpoint
 * that already writes and spends ~100-300 ms embedding and searching.
 */

import type Database from "better-sqlite3";

import * as storage from "./storage.js";
import { cosineBetweenVectors } from "./retrieval.js";
import { embedBatch } from "./embedder.js";
import { readSections, KNOWN_IDENTITY_CLIENTS } from "./identity-store.js";
import { formatIndexLine } from "./recall-index.js";
import {
  MEMORY_PRECISION_PROMPT_EXCERPT_CHARS,
  MEMORY_PRECISION_WINDOW_DAYS,
  MEMORY_PRECISION_REDUNDANT_ABOVE,
  MEMORY_PRECISION_DIVERGENCE_MIN_SHOWN,
  RECALL_TITLE_CHARS,
} from "./calibration.js";

/** One non-skipped /recall-index call to record (recorder seam contract —
 *  recall-index.ts types its precision deps against this). */
export interface RecallPushEntry {
  /** ISO timestamp of the push; defaults to now. */
  ts?: string;
  /** The request's session_id (nullable — the wire field is optional). */
  sessionId: string | null;
  /** The prompt text (only the ≤256-char excerpt is persisted). */
  prompt: string;
  /** The shown memory ids, in index order. EMPTY = silent turn (the push row
   *  is still recorded — the silence rate is computable and the judge's
   *  population complete — but no event rows, no exposure touch). */
  ids: string[];
  /** The PURE-prompt embedding — REQUIRED when ids.length > 0 (the request's
   *  memoized embed; unused on a silent turn, so no embed is ever spent on
   *  recording). */
  promptEmbedding?: Float32Array;
}

/**
 * Record one /recall-index push: the push row + (when lines were shown) the
 * per-line kind='shown' event rows, in ONE transaction WITH the existing
 * exposure write (storage.touchMemoriesShown — the spec's "same transaction";
 * better-sqlite3 nests the inner transaction as a savepoint, so a recording
 * failure rolls back the whole unit and the CALLER's fallback re-runs the
 * exposure touch alone — shown_count never depends on telemetry).
 *
 * similarity = cosine(memory embedding, PURE prompt embedding), computed
 * UNIFORMLY via cosineBetweenVectors against the stored vector — FTS-sourced
 * picks (which bypass the cosine floor and carry similarity:null in
 * MemorySearchResult) get a measured value here too. redundancy = MAX cosine
 * against the standing-context basis vectors (NULL when the basis is empty —
 * embed failure degrades to "unmeasured", never a guessed 0). Both stored
 * raw; no thresholds touch this row.
 */
export function recordRecallPush(
  db: Database.Database,
  entry: RecallPushEntry,
  basis: Float32Array[] = [],
): void {
  const ts = entry.ts ?? new Date().toISOString();
  // UTC YYYY-MM-DD of ts — day buckets are UTC everywhere (dashboard
  // conventions; SQLite date('now') is UTC too).
  const day = ts.slice(0, 10);
  const excerpt = entry.prompt.slice(0, MEMORY_PRECISION_PROMPT_EXCERPT_CHARS);

  const insertEvent = db.prepare(
    `INSERT INTO recall_events (ts, day, push_id, memory_id, similarity, redundancy, kind)
     VALUES (?, ?, ?, ?, ?, ?, 'shown')`,
  );

  const tx = db.transaction(() => {
    if (entry.ids.length > 0) {
      // The exposure write rides INSIDE the recording transaction (spec: one
      // atomic unit). Nested db.transaction → savepoint.
      storage.touchMemoriesShown(db, entry.ids, ts);
    }
    const info = db
      .prepare(
        "INSERT INTO recall_pushes (ts, day, session_id, prompt_excerpt) VALUES (?, ?, ?, ?)",
      )
      .run(ts, day, entry.sessionId, excerpt);
    const pushId = Number(info.lastInsertRowid);

    if (entry.ids.length === 0) return; // silent turn — push row only
    const promptEmb = entry.promptEmbedding;
    if (!promptEmb) {
      // Contract violation (ids without an embedding): record the lines with
      // NULL measures rather than guessing — honesty over fabrication.
      for (const id of entry.ids) insertEvent.run(ts, day, pushId, id, null, null);
      return;
    }
    for (const id of entry.ids) {
      const memEmb = storage.getStoredEmbedding(db, id);
      const similarity = memEmb ? cosineBetweenVectors(memEmb, promptEmb) : null;
      let redundancy: number | null = null;
      if (memEmb && basis.length > 0) {
        for (const b of basis) {
          const c = cosineBetweenVectors(memEmb, b);
          if (redundancy === null || c > redundancy) redundancy = c;
        }
      }
      insertEvent.run(ts, day, pushId, id, similarity, redundancy);
    }
  });
  tx();
}

/** Fetch-event recorder contract (handleMemoryGet's optional #476 dep —
 *  mcp-server wires recordRecallFetch; tests can force a failure). */
export type RecallFetchRecorder = (
  db: Database.Database,
  memoryId: string,
  ts?: string
) => void;

/**
 * Record one explicit fetch (handleMemoryGet — the funnel both REST GET
 * /memory and MCP hicortex_get route through, so the row is written exactly
 * once per fetch). similarity/redundancy are NULL on fetch rows: Level 2 is
 * the use signal, not a relevance measure. push_id NULL — a fetch stands
 * alone. Fail-soft at the CALLER (handleMemoryGet wraps this).
 */
export function recordRecallFetch(
  db: Database.Database,
  memoryId: string,
  ts?: string,
): void {
  const nowIso = ts ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO recall_events (ts, day, push_id, memory_id, similarity, redundancy, kind)
     VALUES (?, ?, NULL, ?, NULL, NULL, 'fetch')`,
  ).run(nowIso, nowIso.slice(0, 10), memoryId);
}

/**
 * Nightly retention prune (zero-LLM): drop both event tables' rows outside
 * the rolling window whose length IS the retention constant (the
 * CAPTURE_HEALTH_WINDOW_DAYS single-constant law — the card can never claim a
 * window the store no longer has rows for). Inclusive cutoff: the last N
 * calendar days with today counted stay (day >= today−(N−1)), the complement
 * is deleted — retained rows == window rows.
 */
export function pruneRecallPrecision(db: Database.Database): void {
  db.exec(
    `DELETE FROM recall_pushes WHERE day < date('now', '-${MEMORY_PRECISION_WINDOW_DAYS - 1} days')`,
  );
  db.exec(
    `DELETE FROM recall_events WHERE day < date('now', '-${MEMORY_PRECISION_WINDOW_DAYS - 1} days')`,
  );
}

// ---------------------------------------------------------------------------
// Standing-context basis — the redundancy reference (what every session
// ALREADY knows before the index pushes anything)
// ---------------------------------------------------------------------------

/** Cache TTL for the embedded basis (module constant, not a tuning value: it
 *  bounds how stale the redundancy reference may be — 24h mirrors the daily
 *  lesson/identity cadence the /learnings + /identity surfaces serve). */
const BASIS_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * True when the identity scope is served to EVERY known client — the only
 * case where identity sections belong in the corpus-level standing-context
 * basis. /recall-index carries no client type, so a SCOPED identity config
 * (any subset) excludes identity rather than guessing which sections the
 * calling session sees. `clients` is the boot-resolved
 * resolveIdentityClientsConfig output; the absent-config default ["cc"] is
 * NOT all → identity excluded.
 */
export function identityServedToAllClients(clients: string[]): boolean {
  return KNOWN_IDENTITY_CLIENTS.every((c) => clients.includes(c));
}

export interface StandingContextBasisConfig {
  /** The daemon's boot-resolved identityClients (read lazily — assigned at
   *  boot, after the routes that consume the basis are registered). */
  clients: () => string[];
  /** The daemon's identity dir (sections read only when all-clients). */
  identityDir: () => string;
  /** Embedding seam — tests inject a deterministic embedder. Default embedBatch. */
  embedFn?: (texts: string[]) => Promise<Float32Array[]>;
  /** Clock seam (tests). Default Date.now. */
  now?: () => number;
  /** Cache TTL seam (tests). Default 24h. */
  ttlMs?: number;
}

/** The basis provider: db → basis vectors (may be empty). Callable, plus a
 *  test-only cache reset (the cache is deliberately per-provider so suites
 *  with different configs never share it). */
export interface StandingContextBasis {
  (db: Database.Database): Promise<Float32Array[]>;
  resetForTests(): void;
}

/**
 * The standing-context basis: the top lessons in /learnings order
 * (storage.getLessons(db, 30) — exactly what the /learnings handler serves
 * and every client's session-start hook injects) PLUS identity sections ONLY
 * when identityServedToAllClients (see above). Embedded with the LOCAL
 * embedder — no LLM anywhere in this feature. Cached for 24h (single-flight:
 * concurrent callers share the embedding pass); an embed failure degrades to
 * an EMPTY cached basis (redundancy NULL — "unmeasured", never guessed) and
 * is retried after the TTL.
 */
export function createStandingContextBasis(
  config: StandingContextBasisConfig,
): StandingContextBasis {
  const embedFn = config.embedFn ?? embedBatch;
  const now = config.now ?? Date.now;
  const ttlMs = config.ttlMs ?? BASIS_TTL_MS;
  let cache: { vectors: Float32Array[]; expiresAt: number } | null = null;
  let inFlight: Promise<Float32Array[]> | null = null;

  const build = async (db: Database.Database): Promise<Float32Array[]> => {
    const texts: string[] = [];
    // Lessons: the /learnings set + order (last 30 days, created_at DESC).
    // Read errors degrade to an empty lesson half — the basis is a reference,
    // not a ledger.
    try {
      for (const lesson of storage.getLessons(db, 30)) texts.push(lesson.content);
    } catch (err) {
      console.warn(
        `[hicortex] standing-context basis: lesson read failed (degraded): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // Identity: only when the scope is served to EVERY client — never guessed.
    if (identityServedToAllClients(config.clients())) {
      try {
        const { sections } = readSections(config.identityDir());
        for (const content of Object.values(sections)) texts.push(content);
      } catch (err) {
        console.warn(
          `[hicortex] standing-context basis: identity read failed (degraded): ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return texts.length > 0 ? await embedFn(texts) : [];
  };

  const provider = async (db: Database.Database): Promise<Float32Array[]> => {
    if (cache && now() < cache.expiresAt) return cache.vectors;
    if (!inFlight) {
      inFlight = build(db)
        .catch((err: unknown) => {
          // Embed failure → EMPTY basis cached for the TTL: redundancy reads
          // NULL (unmeasured) on every push in the period, never a guessed 0.
          console.warn(
            `[hicortex] standing-context basis: embed failed (redundancy NULL this TTL): ` +
              `${err instanceof Error ? err.message : String(err)}`,
          );
          return [] as Float32Array[];
        })
        .then((vectors) => {
          cache = { vectors, expiresAt: now() + ttlMs };
          return vectors;
        })
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  };

  const basis = provider as StandingContextBasis;
  basis.resetForTests = (): void => {
    cache = null;
  };
  return basis;
}

// ---------------------------------------------------------------------------
// Window aggregation — the /dashboard/data memory_precision block
// ---------------------------------------------------------------------------

/** The Level-1 half: pushed-index precision proxies over the window's stored
 *  events. Thresholds are ECHOED (the page never hardcodes an edge);
 *  mean/share are computed at read time from raw values. */
export interface MemoryPrecisionLevel1 {
  /** Non-skipped /recall-index calls in the window (silent turns included). */
  pushes: number;
  /** Pushed index lines (kind='shown' event rows) in the window. */
  lines: number;
  /** Mean cosine(line, its prompt) over lines with a measured similarity;
   *  null when nothing was measured. */
  mean_similarity: number | null;
  /** Share of measured lines at/above the redundancy threshold; null when
   *  nothing was measured (empty/unmeasured — undefined, not zero). */
  redundant_share: number | null;
  thresholds: {
    /** The redundancy render edge (calibration MEMORY_PRECISION_REDUNDANT_ABOVE). */
    redundant_above: number;
    /** The divergence bar (calibration MEMORY_PRECISION_DIVERGENCE_MIN_SHOWN). */
    divergence_min_shown: number;
  };
}

/** The Level-2 half: recall depth (fetches per showing) over the window,
 *  derived from corpus-wide cumulative counter DELTAS — live adoption minus
 *  the newest pre-window snapshot. No second source of truth: the events
 *  above are per-line; this is the corpus aggregate the nightly already
 *  snapshots. Null = no honest value (no pre-window baseline), never 0. */
export interface MemoryPrecisionLevel2 {
  shown: number | null;
  used: number | null;
  uses_per_showing: number | null;
}

/** The whole /dashboard/data memory_precision block (one card's payload,
 *  budget ≤ 2 KB — the top-3 divergence lines are the only content). */
export interface MemoryPrecision {
  /** The EFFECTIVE window (min(range, retention)); the page renders
   *  "last N days" from this echo, never a hardcoded literal. */
  window_days: number;
  level1: MemoryPrecisionLevel1;
  level2: MemoryPrecisionLevel2;
  divergence: {
    /** Live memories with ≥ thresholds.divergence_min_shown window showings
     *  and ZERO window fetches — the index keeps pushing, nothing reads. */
    count: number;
    /** Top-3 by window showings DESC, lines rendered through the SHARED
     *  formatIndexLine (≤ RECALL_TITLE_CHARS — the card cannot drift from
     *  what agents see). Hover-only on the card face (no memory lists on
     *  the main page — owner ruling 2026-09-12). */
    top: Array<{ id: string; line: string; shown: number }>;
  };
}

/** Read-time seams (the #408 experiment pattern — the eval/tests sweep
 *  values through them; production never passes anything). */
export interface MemoryPrecisionReadOptions {
  /** Fixed clock (tests); default now. */
  now?: Date;
  /** Redundancy render threshold override (tests — changing it must move
   *  only the share, never a stored row). */
  redundantAbove?: number;
}

const DAY_MS = 86_400_000;
const round4 = (v: number): number => Math.round(v * 10000) / 10000;

/** Range string ("7d"|"30d"|…) → days; null when unparseable/"all" (the
 *  caller — handleDashboardData — has already validated against
 *  VALID_RANGES; anything unexpected degrades to the retention clamp). */
function rangeToDays(range: string): number | null {
  if (range === "all") return null;
  const n = parseInt(range, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The window aggregation behind /dashboard/data's memory_precision block
 * (the readCaptureHealthWindow pattern). Effective window = min(range,
 * MEMORY_PRECISION_WINDOW_DAYS) for every range incl. 180d/all (the #452
 * selector's wide options clamp to what the retention honestly holds).
 *
 * Level 1 groups the stored event rows over the window (day >= today−(N−1),
 * the inclusive capture-health convention); Level 2 is the corpus-wide
 * adoption delta — live sums minus the NEWEST non-null `adoption` in
 * dashboard_snapshots at/before now−N days (cumulative counters telescope:
 * a missing nightly widens the effective window rather than corrupting it;
 * two snapshots on one day are harmless — the newest wins; no pre-window
 * baseline → null, undefined rather than zero). Divergence joins the
 * window's per-memory shown/fetch counts against LIVE (non-absorbed)
 * memories and renders the top-3 through the shared index-line path.
 */
export function readMemoryPrecision(
  db: Database.Database,
  range: string,
  liveAdoption: { shown_sum: number; used_sum: number },
  opts?: MemoryPrecisionReadOptions,
): MemoryPrecision {
  const now = opts?.now ?? new Date();
  const redundantAbove = opts?.redundantAbove ?? MEMORY_PRECISION_REDUNDANT_ABOVE;
  const windowDays = Math.min(rangeToDays(range) ?? MEMORY_PRECISION_WINDOW_DAYS, MEMORY_PRECISION_WINDOW_DAYS);
  // Inclusive window start (UTC YYYY-MM-DD): today counts as day 1.
  const cutoffDay = new Date(now.getTime() - (windowDays - 1) * DAY_MS).toISOString().slice(0, 10);

  // --- Level 1: group the window's shown events (raw values, no thresholds
  // in SQL beyond the redundant-share counter — the verdict stays at render). ---
  const agg = db.prepare(
    `SELECT COUNT(*) AS lines,
            SUM(CASE WHEN similarity IS NOT NULL THEN similarity ELSE 0 END) AS sim_sum,
            SUM(CASE WHEN similarity IS NOT NULL THEN 1 ELSE 0 END) AS sim_n,
            SUM(CASE WHEN redundancy IS NOT NULL AND redundancy >= ? THEN 1 ELSE 0 END) AS red_n,
            SUM(CASE WHEN redundancy IS NOT NULL THEN 1 ELSE 0 END) AS red_measured
       FROM recall_events
      WHERE day >= ? AND kind = 'shown'`,
  ).get(redundantAbove, cutoffDay) as {
    lines: number; sim_sum: number | null; sim_n: number; red_n: number; red_measured: number;
  };
  const pushes = (
    db.prepare("SELECT COUNT(*) AS c FROM recall_pushes WHERE day >= ?").get(cutoffDay) as { c: number }
  ).c;

  // --- Level 2: corpus adoption delta over the window (snapshot series). ---
  const baselineCutoff = new Date(now.getTime() - windowDays * DAY_MS).toISOString();
  const snapRows = db
    .prepare("SELECT run_at, metrics FROM dashboard_snapshots WHERE run_at <= ? ORDER BY run_at DESC")
    .all(baselineCutoff) as Array<{ run_at: string; metrics: string }>;
  let baseline: { shown_sum: number; used_sum: number } | null = null;
  for (const r of snapRows) {
    // Backfilled rows OMIT adoption (point-in-time, not reconstructable) —
    // walk to the newest row that actually carries it.
    try {
      const m = JSON.parse(r.metrics) as { adoption?: { shown_sum?: unknown; used_sum?: unknown } };
      if (
        m.adoption &&
        typeof m.adoption.shown_sum === "number" &&
        typeof m.adoption.used_sum === "number"
      ) {
        baseline = { shown_sum: m.adoption.shown_sum, used_sum: m.adoption.used_sum };
        break;
      }
    } catch {
      // A malformed metrics blob is skipped, not fatal — the walk continues
      // to the next-older candidate.
    }
  }
  const shown = baseline ? liveAdoption.shown_sum - baseline.shown_sum : null;
  const used = baseline ? liveAdoption.used_sum - baseline.used_sum : null;
  // Divide guard + honesty: no baseline → null (undefined, never 0); a window
  // with zero (or negative — a restored DB) shown delta has no ratio.
  const usesPerShowing = shown !== null && shown > 0 && used !== null ? round4(used / shown) : null;

  // --- Divergence: per-memory window counters, gated to live rows. ---
  const perMemory = db
    .prepare(
      `SELECT memory_id,
              SUM(CASE WHEN kind = 'shown' THEN 1 ELSE 0 END) AS shown,
              SUM(CASE WHEN kind = 'fetch' THEN 1 ELSE 0 END) AS fetches
         FROM recall_events
        WHERE day >= ?
        GROUP BY memory_id`,
    )
    .all(cutoffDay) as Array<{ memory_id: string; shown: number; fetches: number }>;
  const divergingIds = perMemory
    .filter((r) => r.shown >= MEMORY_PRECISION_DIVERGENCE_MIN_SHOWN && r.fetches === 0)
    .map((r) => ({ id: r.memory_id, shown: r.shown }));
  const memStmt = db.prepare(
    `SELECT id, content, created_at, domain, project, source_agent, memory_type
       FROM memories WHERE id = ? AND COALESCE(status, '') != 'absorbed'`,
  );
  const diverging: Array<{ id: string; shown: number; line: string }> = [];
  for (const d of divergingIds) {
    const row = memStmt.get(d.id) as {
      id: string; content: string; created_at: string; domain: string | null;
      project: string | null; source_agent: string | null; memory_type: string;
    } | undefined;
    if (!row) continue; // absorbed/deleted since — not a LIVE divergence
    diverging.push({
      id: row.id,
      shown: d.shown,
      // The SHARED index-line path (what agents see in the pushed index) —
      // formatIndexLine at the default title cap, same as the digest.
      line: formatIndexLine(
        {
          id: row.id,
          content: row.content,
          score: 0,
          effective_strength: 0,
          access_count: 0,
          memory_type: row.memory_type,
          project: row.project,
          domain: row.domain,
          source_agent: row.source_agent,
          created_at: row.created_at,
          connections: 0,
        },
        RECALL_TITLE_CHARS,
      ),
    });
  }
  diverging.sort((a, b) => b.shown - a.shown);

  return {
    window_days: windowDays,
    level1: {
      pushes,
      lines: agg.lines,
      mean_similarity: agg.sim_n > 0 ? round4((agg.sim_sum ?? 0) / agg.sim_n) : null,
      redundant_share: agg.red_measured > 0 ? round4(agg.red_n / agg.red_measured) : null,
      thresholds: {
        redundant_above: redundantAbove,
        divergence_min_shown: MEMORY_PRECISION_DIVERGENCE_MIN_SHOWN,
      },
    },
    level2: { shown, used, uses_per_showing: usesPerShowing },
    divergence: { count: diverging.length, top: diverging.slice(0, 3) },
  };
}
