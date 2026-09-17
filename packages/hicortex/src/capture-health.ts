/**
 * /distill capture-health accounting (#422 Phase 2).
 *
 * BOTH halves of the console's capture-health card live here (the same
 * layering as recall-index.ts / identity-store.ts: pure logic, unit-testable
 * without booting express — mcp-server.ts only wires the record calls into
 * the /distill exits):
 *
 *  - recordDistillActivity(db, entry) — one row per /distill POST, whatever
 *    the outcome ('ok' | 'skipped' | 'held'). Held rows are the point: they
 *    are the failed posts the client will retry next run (its cursor is
 *    held), so the card can show "2 held" instead of a silently missing
 *    night. `retried` is computed at INSERT (an earlier row with the same
 *    session_id + segment_id = this POST is the retry) and never updated.
 *
 *  - readCaptureHealth(db) — the aggregation /dashboard/data exposes as
 *    `capture_health`: the most recent day with rows, grouped by machine ×
 *    agent (posts / sessions / bytes / held / retried), bytes DESC.
 *
 *  - readCaptureHealthWindow(db) — the same grouping over the ROLLING
 *    capture window (#409 fix round 7, owner ruling 2026-09-14: the card
 *    shows the normal 30 days like the band's other cards). The newest
 *    night's rows stay on the payload too (secondary info: the card's
 *    "tonight" suffix); the window sums are the card's face.
 *
 * Retention: CAPTURE_HEALTH_WINDOW_DAYS (30), pruned inside
 * recordDistillActivity at most ONCE per process per UTC day (in-module
 * memo) — the insert path must not pay a DELETE on every POST. Retention and
 * the window aggregate share the ONE constant, so the card can never claim a
 * window the store no longer has rows for. Old rows exist to feed the card's
 * rolling window, nothing else; the durable record of WHAT was captured is
 * the memories themselves.
 */

import type Database from "better-sqlite3";

import { sanitizeSourceMachine } from "./storage.js";

/** A /distill POST outcome. 'held' = the client will retry (cursor held):
 *  no-LLM, dead-endpoint probe, budget 429, distill failure. 'skipped' = a
 *  duplicate the dedup prechecks rejected (nothing owed). 'ok' = stored.
 *  'paused' (#423 phase 3, D3) = deliberately skipped by the operator's
 *  capture pause — the session is NOT captured and will not be backfilled
 *  (the 200 advances the client's cursor by design). */
export type DistillOutcome = "ok" | "skipped" | "held" | "paused";

/** One /distill POST to record. The wire fields arrive as-is from the request
 *  body (machine/agent/sessionId/segmentId may be absent or mistyped) —
 *  normalization happens HERE so every handler call site is a one-liner. */
export interface DistillActivityEntry {
  /** ISO timestamp of the POST; defaults to now. */
  ts?: string;
  /** Raw source_machine wire value — sanitized via storage.sanitizeSourceMachine, '' when absent. */
  machine: unknown;
  /** Raw source_agent wire value — 'unknown' when absent/blank. */
  agent: unknown;
  /** Raw session_id wire value — stored when a non-empty string, else NULL. */
  sessionId: unknown;
  /** Raw segment_id wire value — stored when a non-empty string, else NULL. */
  segmentId: unknown;
  /** Resolved conversationText length (post-redaction), 0 when unresolved. */
  bytes: number;
  outcome: DistillOutcome;
}

/** One aggregated machine × agent row of readCaptureHealth(). */
export interface CaptureHealthRow {
  machine: string;
  agent: string;
  posts: number;
  sessions: number;
  bytes: number;
  held: number;
  retried: number;
}

/** The /dashboard/data capture_health block. day=null + rows=[] when nothing
 *  is recorded (fresh install, or every row pruned). */
export interface CaptureHealth {
  day: string | null;
  rows: CaptureHealthRow[];
}

/** Once-per-process-per-UTC-day prune memo (see module doc). The UTC day of
 *  the last insert that ran the DELETE. Tests reset it because vitest runs
 *  every suite in ONE process — see resetDistillPruneMemoForTests. */
let lastPruneDay: string | null = null;

/** The rolling capture window the console's card shows, in days — ALSO the
 *  retention horizon for distill_activity (the recorder prunes past it).
 *  Owner ruling 2026-09-14: the capture card shows the normal 30 day like
 *  the band's other cards, so the store must retain enough nights to sum
 *  one. ONE constant feeds both the window aggregate and the prune: the card
 *  can never claim a window the store no longer has rows for. */
export const CAPTURE_HEALTH_WINDOW_DAYS = 30;

/** Inclusive window cutoff as SQL: day >= today−(N−1) — the last N calendar
 *  days with today counted (the same inclusive convention as
 *  /dashboard/events' days param). The prune keeps exactly this predicate's
 *  complement (day < cutoff is deleted), so retained rows == window rows. */
const WINDOW_CUTOFF_SQL = `date('now', '-${CAPTURE_HEALTH_WINDOW_DAYS - 1} days')`;

/** Test-only: re-arm the once-per-day prune memo. The memo is deliberately
 *  process-global (production must not DELETE per insert); the test suite
 *  needs it fresh per case. Exported for testability, same precedent as
 *  quarantineMalformedConfig. */
export function resetDistillPruneMemoForTests(): void {
  lastPruneDay = null;
}

/** Normalize an optional wire string: non-empty trimmed string, else null. */
function optString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

/**
 * Record one /distill POST outcome. Computes `retried` at insert: 1 when an
 * EARLIER row exists with the same session_id AND same segment_id (matched on
 * COALESCE(segment_id, '') so legacy whole-session POSTs — no segment_id —
 * retry-match on the empty key). A NULL session_id never matches anything:
 * without a session id the POST has no identity to be a retry OF. Also prunes
 * rows outside the rolling capture window (CAPTURE_HEALTH_WINDOW_DAYS), at
 * most once per process per UTC day.
 */
export function recordDistillActivity(
  db: Database.Database,
  entry: DistillActivityEntry,
): void {
  const ts = entry.ts ?? new Date().toISOString();
  // UTC YYYY-MM-DD of ts — day buckets are UTC everywhere (dashboard
  // conventions; SQLite date('now') is UTC too).
  const day = ts.slice(0, 10);
  const sessionId = optString(entry.sessionId);
  const segmentId = optString(entry.segmentId);

  // Retry detection BEFORE the insert (the new row must not match itself).
  // `IS ?` binds NULL correctly for the session half.
  const retried =
    sessionId !== null &&
    (db
      .prepare(
        "SELECT 1 FROM distill_activity WHERE session_id IS ? AND COALESCE(segment_id, '') = ? LIMIT 1",
      )
      .get(sessionId, segmentId ?? "") !== undefined)
      ? 1
      : 0;

  db.prepare(
    `INSERT INTO distill_activity (ts, day, machine, agent, session_id, segment_id, bytes, outcome, retried)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ts,
    day,
    sanitizeSourceMachine(entry.machine) ?? "",
    optString(entry.agent) ?? "unknown",
    sessionId,
    segmentId,
    entry.bytes,
    entry.outcome,
    retried,
  );

  // Prune, at most once per process per UTC day. Runs AFTER the insert so the
  // triggering row is subject to the same window as everything else. The
  // cutoff is the capture window's own edge — retention keeps exactly the
  // nights the card's rolling view sums (see CAPTURE_HEALTH_WINDOW_DAYS).
  if (lastPruneDay !== day) {
    db.prepare(`DELETE FROM distill_activity WHERE day < ${WINDOW_CUTOFF_SQL}`).run();
    lastPruneDay = day;
  }
}

/**
 * Aggregate the most recent day with rows into per machine × agent bundles.
 * day = today when today has rows, else the most recent day with rows, else
 * null (empty shape). sessions = COUNT(DISTINCT session_id) — NULL session
 * ids don't count (no identity). Sorted bytes DESC (the card's bar scale).
 */
export function readCaptureHealth(db: Database.Database): CaptureHealth {
  const dayRow = db
    .prepare("SELECT MAX(day) AS day FROM distill_activity")
    .get() as { day: string | null };
  if (!dayRow.day) return { day: null, rows: [] };

  const rows = db
    .prepare(
      `SELECT machine, agent,
              COUNT(*) AS posts,
              COUNT(DISTINCT session_id) AS sessions,
              COALESCE(SUM(bytes), 0) AS bytes,
              COALESCE(SUM(outcome = 'held'), 0) AS held,
              COALESCE(SUM(retried), 0) AS retried
         FROM distill_activity
        WHERE day = ?
        GROUP BY machine, agent
        ORDER BY bytes DESC`,
    )
    .all(dayRow.day) as CaptureHealthRow[];
  return { day: dayRow.day, rows };
}

/** The /dashboard/data capture_health window block: the echoed window length
 *  + the per machine × agent rows over it. Field names are the WIRE keys —
 *  dashboard.ts spreads this over the newest-night shape, so the keys must
 *  not collide with {day, rows}. window_rows=[] when the window is empty
 *  (fresh install, static snapshot without activity rows — the page keeps its
 *  counts fallback). */
export interface CaptureHealthWindow {
  window_days: number;
  window_rows: CaptureHealthRow[];
}

/**
 * Aggregate the ROLLING capture window (CAPTURE_HEALTH_WINDOW_DAYS calendar
 * days, today inclusive) into per machine × agent bundles — the card's face
 * (#409 fix round 7: the band's other cards are all 30-day; the newest night
 * moves to secondary info). Same shape as readCaptureHealth's rows, but
 * summed across nights: sessions stays COUNT(DISTINCT session_id), so a
 * session retried on a later night counts once (identity, not occurrences).
 * Sorted bytes DESC (the card's bar scale).
 */
export function readCaptureHealthWindow(db: Database.Database): CaptureHealthWindow {
  const rows = db
    .prepare(
      `SELECT machine, agent,
              COUNT(*) AS posts,
              COUNT(DISTINCT session_id) AS sessions,
              COALESCE(SUM(bytes), 0) AS bytes,
              COALESCE(SUM(outcome = 'held'), 0) AS held,
              COALESCE(SUM(retried), 0) AS retried
         FROM distill_activity
        WHERE day >= ${WINDOW_CUTOFF_SQL}
        GROUP BY machine, agent
        ORDER BY bytes DESC`,
    )
    .all() as CaptureHealthRow[];
  return { window_days: CAPTURE_HEALTH_WINDOW_DAYS, window_rows: rows };
}
