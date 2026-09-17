/**
 * /dashboard — view-only memory analytics (#224) + the console's live-data
 * endpoints (#409/#421 Phase 1: /dashboard/field, /dashboard/events).
 *
 * STRICTLY view-only: this module computes metrics, reads snapshots, writes
 * ONE snapshot row per full nightly run (the writer is here because the
 * metric SQL lives next to its definition, not in nightly.ts), and exposes
 * the pure data handlers mounted at GET /dashboard/data,
 * GET /dashboard/field and GET /dashboard/events. There are NO mutation
 * endpoints on the dashboard surface — the only write path is the nightly
 * snapshot writer + the one-time backfill, both internal.
 *
 * Layering (mirrors how recall-index.ts holds pure logic and viz.ts holds
 * thin express adapters): all metric SQL + snapshot shape lives HERE so it
 * can be unit-tested without booting express. viz.ts owns only the HTML
 * shell handler + the auth exemption; mcp-server.ts wires both.
 *
 * Headline metric: uses-per-showing = SUM(access_count) / SUM(shown_count)
 * across the corpus — the recall-quality signal (#192 adoption aggregate,
 * promoted to a top-line metric here). Divide-by-zero → null (no showings
 * means undefined, not zero).
 */

import type express from "express";
import type Database from "better-sqlite3";
import { gzipSync } from "node:zlib";

import { formatIndexLine, memoryTitle } from "./recall-index.js";
import { readPositiveConfig, readNonNegativeConfig, readAccount } from "./config-read.js";
import { resolveMemorySoftCap } from "./consolidate.js";
import { readCaptureHealth, readCaptureHealthWindow, type CaptureHealthRow } from "./capture-health.js";
import { listCapturePauses, readFleetLastSeen, setCapturePause } from "./capture-pause.js";
import { loadState } from "./state.js";
import { effectiveStrength } from "./retrieval.js";
import { deriveStage, type Stage } from "./stages.js";
import {
  RECALL_TITLE_CHARS,
  RECALL_MIN_SIMILARITY,
  RECALL_USES_LOW_MAX,
  RECALL_USES_NORMAL_MAX,
  RECALL_USES_AXIS_MAX,
  STAGE_FADING_DAYS,
  STAGE_FADING_STRENGTH,
  STAGE_BELIEF_STRENGTH,
  STAGE_TRUTH_STRENGTH,
} from "./calibration.js";

// ---------------------------------------------------------------------------
// Types — the JSON blob shape documented in the issue (a stable contract the
// HTML page renders against; new keys can be added, existing ones stay).
// ---------------------------------------------------------------------------

/** Corpus-shape snapshot. `adoption` is null in backfilled rows (point-in-time,
 *  can't be reconstructed from created_at). */
export interface DashboardMetrics {
  /**
   * `mem` counts ALL rows (backcompat — the growth chart's series). #422 adds
   * `live_mem` (non-absorbed: what recall serves + the field paints) and
   * `absorbed` (= mem − live_mem, the dedup/reconsol evidence rows). Both are
   * undefined on backfilled rows — whether a historical row was absorbed at
   * that moment is not reconstructable from created_at (honest omission).
   */
  totals: { mem: number; lesson: number; link: number; live_mem?: number; absorbed?: number };
  /**
   * #422 Phase 2 — per-stage counts over LIVE (non-absorbed) rows, derived
   * with the SAME math as /dashboard/field (the shared deriveStageForRow —
   * one formula, two surfaces, drift impossible). Undefined on backfilled
   * rows (historical strengths are not reconstructable). Drives the
   * graduation deltas in the activity bars.
   */
  stage_counts?: { forming: number; belief: number; truth: number; fading: number };
  by_type: Record<string, number>;
  by_domain: Record<string, number>;
  by_source_agent: Record<string, number>;
  /** #421 machine × harness: memories per capture machine. Rows written
   *  before migration v15 have NULL source_machine → grouped under
   *  "(unstamped)" (the console labels them "earlier captures"). */
  by_source_machine: Record<string, number>;
  /** Per-run deltas; undefined on backfilled rows (created_at can't reconstruct
   *  what a given nightly produced). */
  new_this_run?: {
    added: number;
    lessonsGenerated?: number;
    dedup: number;
    supersession: number;
    /** Memories evicted by the capacity stage this run (#245). 0 when under
     *  cap; undefined on backfill rows (a stage outcome, not reconstructable). */
    evicted?: number;
    /**
     * Total LLM tokens consumed by this run (#246 consolidation meter; #287
     * widened to the TRUE total — distill + consolidation). Undefined in
     * lockstep with `tokens_by_stage` (and on backfill rows, which can't
     * reconstruct a per-run meter). Older snapshots are consolidation-only:
     * historical rows can't be reconstructed, which is accepted (#287).
     * Inherent under-count, same acceptance: attribution is response-based,
     * so tokens a FAILED distill already spent (500 after spend, response
     * lost after commit) reach the monthly meter but never a run's total —
     * after such a night, the month's bars sum slightly below the headline.
     */
    tokens?: number;
    /**
     * Per-stage breakdown of `tokens` (#246; #287 adds a `distill` entry for
     * capture-time distillation). Undefined on backfill rows.
     */
    tokens_by_stage?: Record<string, { prompt: number; completion: number; total: number }>;
    /**
     * Always-on consolidation-budget usage metric (#255 CR; ceiling renamed
     * nightlyLlmCallBudget in #405). `calls_used` is
     * how many LLM calls the run actually spent; `max_calls` is the configured
     * `nightlyLlmCallBudget` ceiling (#405). Forwarded whenever consolidation ran
     * (the digest renders a continuous used/max bar, like the token-usage
     * metric, so you can see the budget climbing before exhaustion). Undefined
     * on backfill rows and on runs where consolidation didn't execute
     * (capture-only / no_llm / throttled / skipped) — the page renders no bar.
     */
    budget_calls_used?: number;
    budget_max_calls?: number;
    /**
     * True when this run's consolidation budget (`nightlyLlmCallBudget`)
     * was exhausted — LLM-bound stages deferred remaining work (#255).
     * Forwarded ONLY on exhaustion (the alert state on top of the always-on
     * usage bar). Undefined on healthy runs (where budget_calls_used is still
     * present), backfill rows, and non-run nights.
     */
    budget_exhausted?: boolean;
    /**
     * Per-stage count of refused LLM-call requests on an exhausted run (#255).
     * Mirrors ConsolidationReport.budget.deferred_by_stage. Forwarded in
     * lockstep with `budget_exhausted` (exhausted runs only) so the snapshot
     * shape is clean on healthy runs.
     */
    budget_deferred_by_stage?: Record<string, number>;
    /**
     * #6 backup stage outcome (Phase 0B). Present whenever the backup stage
     * ran (full nightly); absent on capture-only / dry-run / backfill rows.
     * `ok` is false when the snapshot OR the operator's offsite hook failed —
     * the page flags a night the offsite copy didn't land. `bytes` is the
     * compressed artifact size; `path` is the on-disk artifact (for "where
     * did the last backup land?" debugging — not a restore button).
     */
    backup?: {
      ok: boolean;
      bytes: number;
      path?: string;
    };
    /**
     * #427: reconsolidation scout counters, flat snake_case mirroring the
     * stage report (scout_scanned / scout_correction_shaped /
     * scout_candidates_found). Present whenever consolidation ran —
     * quiet-night zeros are real values; undefined = no consolidation that
     * night (and always absent on backfill rows).
     */
    scout_scanned?: number;
    scout_correction_shaped?: number;
    scout_candidates_found?: number;
  };
  /** Corpus capacity (#245). `memory_soft_cap` is the configured ceiling (0 =
   *  disabled); always present in real snapshots, undefined on backfilled
   *  rows (the historical config isn't recoverable from created_at). */
  capacity?: {
    memory_soft_cap: number;
  };
  /** Recall adoption aggregate. Null in backfilled rows. uses_per_showing is
   *  null when shown_sum = 0 (divide-by-zero guard). */
  adoption?: {
    shown_sum: number;
    used_sum: number;
    cold_count: number;
    uses_per_showing: number | null;
  };
}

/** One row of the snapshot series (run_at + parsed metrics). */
export interface DashboardSnapshot {
  run_at: string;
  metrics: DashboardMetrics;
}

/** The /dashboard/data response — the full payload the page renders. */
export interface DashboardData {
  /**
   * Account identity (hosted): who the viewer is, so a user holding two
   * tenant tokens can tell whose data the page shows. Each field is null when
   * its config key (displayName/orgName/planLabel) is absent — the page
   * renders nothing when ALL are null (the self-hosted default).
   */
  account: { name: string | null; org: string | null; plan: string | null };
  headline: {
    total_memories: number;
    /**
     * #422 Phase 2 — LIVE (non-absorbed) memory count: what recall serves and
     * the field paints. The console's overview counter and cap bar key off
     * THIS (total_memories stays ALL rows for backcompat — the growth chart).
     */
    live_memories: number;
    uses_per_showing: number | null;
    cold_count: number;
    /** Corpus vs cap (#245). `memory_soft_cap` is 0 when the cap is disabled
     *  (indefinite growth); the page renders no gauge in that case. */
    memory_soft_cap: number;
    /**
     * LLM token usage this billing period (#246). `used` is the running total
     * (state.llmTokensThisPeriod.total after monthly reset); `cap` is the
     * configured `llmTokensPerMonth` (0 = unlimited, page renders no cap).
     * `used` is 0 when no consolidation has metered tokens yet — the page
     * hides the stat in that case. `period_start` is the ISO timestamp of the
     * current accrual period (for the "X this month" label).
     */
    tokens: {
      used: number;
      cap: number;
      period_start: string | null;
    };
  };
  range: "7d" | "30d" | "90d" | "180d" | "all";
  series: DashboardSnapshot[];
  composition: {
    by_type: Record<string, number>;
    by_domain: Record<string, number>;
    by_source_agent: Record<string, number>;
    /** #421 machine × harness; "(unstamped)" = pre-v15 rows. */
    by_source_machine: Record<string, number>;
  };
  /**
   * #422 Phase 2 — capture health: per machine × agent /distill outcome
   * accounting. ALWAYS present; {day: null, rows: []} when nothing is
   * recorded (fresh install / all rows pruned — the page degrades to the
   * phase-1 counts-only rows).
   *
   * #409 fix round 7 (owner ruling 2026-09-14: "the normal 30 day as the
   * other cards"): `day`/`rows` keep the NEWEST night with rows (secondary
   * info — the card's "tonight" suffix), while `window_days`/`window_rows`
   * carry the ROLLING capture window's per machine × agent sums — the card's
   * face. Both derive from the same distill_activity rows and the same
   * CAPTURE_HEALTH_WINDOW_DAYS constant (retention == window). window_rows
   * is [] exactly when rows is (same table) — the counts fallback then still
   * applies. A pre-round-7 server sends neither window key; the page guards.
   */
  capture_health: {
    day: string | null;
    rows: CaptureHealthRow[];
    /** Echoed window length (the page renders "last N days" from it — never
     *  hardcoded client-side). */
    window_days: number;
    /** Per machine × agent sums over the rolling window (posts / sessions /
     *  bytes / held / retried), bytes DESC. */
    window_rows: CaptureHealthRow[];
  };
  /**
   * #423 phase 3 — fleet presence: the operator's capture pauses + per-bundle
   * last-seen (derived ONLY from /distill activity — see capture-pause.ts's
   * module doc for why recall traffic can never attribute). ALWAYS present;
   * empty arrays when nothing is recorded (fresh install). The page degrades
   * to the phase-2 rendering when the block is absent (pre-phase-3 server).
   */
  fleet: {
    pauses: Array<{ machine: string; harness: string; paused_at: string }>;
    last_seen: Array<{ machine: string; harness: string; last_seen: string; last_outcome: string }>;
  };
  digest: {
    date: string | null;
    run_at: string | null;
    sample: { id: string; line: string; created_at: string }[];
    lessons: { id: string; content: string; created_at: string }[];
    stages: {
      lessonsGenerated?: number;
      dedup: number;
      supersession: number;
      added: number;
      evicted?: number;
      /** Total tokens consumed that run (#246; #287: distill + consolidation).
       *  Undefined = no metered run. */
      tokens?: number;
      /** Per-stage breakdown of `tokens` (#246; #287 adds `distill`). */
      tokens_by_stage?: Record<string, { prompt: number; completion: number; total: number }>;
      /**
       * Always-on consolidation-budget usage (#255 CR). Present whenever the
       * day's snapshot carries them (consolidation ran). The page renders a
       * used/max bar in the same style as the token-usage metric.
       */
      budget_calls_used?: number;
      budget_max_calls?: number;
      /** True when the run exhausted its consolidation budget (#255). */
      budget_exhausted?: boolean;
      /** Per-stage refused-request counts on an exhausted run (#255). */
      budget_deferred_by_stage?: Record<string, number>;
    };
    dedup_merges: {
      loser_id: string;
      canonical_id: string;
      content_head: string | null;
      merged_at: string;
    }[];
  };
}

// ---------------------------------------------------------------------------
// Metric computation — one SELECT each, prepared inline. Pure: takes a db,
// returns a value. No side effects, no I/O beyond the open db handle.
// ---------------------------------------------------------------------------

function countBy(
  db: Database.Database,
  col: string,
  nullLabel = "(unscoped)",
): Record<string, number> {
  // Column name is from a fixed allowlist at the call site (never user input).
  const rows = db
    .prepare(
      `SELECT COALESCE(${col}, ?) AS k, COUNT(*) AS c
         FROM memories
        GROUP BY ${col}`
    )
    .all(nullLabel) as Array<{ k: string; c: number }>;
  const out: Record<string, number> = {};
  for (const r of rows) out[r.k] = r.c;
  return out;
}

/**
 * Compute the full corpus-shape metrics from the live DB. The same function
 * backs both the nightly snapshot writer and the live /dashboard/data
 * composition view — one definition of corpus shape. #422 adds the
 * live/absorbed split (`totals.live_mem`/`absorbed`) and `stage_counts` —
 * both derived here so every snapshot row carries them automatically.
 */
export function computeDashboardMetrics(db: Database.Database): DashboardMetrics {
  const mem = (
    db.prepare("SELECT COUNT(*) AS c FROM memories").get() as { c: number }
  ).c;
  // LIVE = non-absorbed (the same predicate as /dashboard/field and the cap
  // eviction stage — #317's one-definition discipline). Absorbed rows are
  // retained evidence, invisible to recall; they must not read as "memories
  // the brain has" in the console's headline (the field paints live only, so
  // the band number and the field must agree).
  const liveMem = (
    db
      .prepare("SELECT COUNT(*) AS c FROM memories WHERE COALESCE(status, '') != 'absorbed'")
      .get() as { c: number }
  ).c;
  const lesson = (
    db
      .prepare("SELECT COUNT(*) AS c FROM memories WHERE memory_type = 'learnings'")
      .get() as { c: number }
  ).c;
  const link = (
    db.prepare("SELECT COUNT(*) AS c FROM memory_links").get() as { c: number }
  ).c;

  const adoptionRow = db
    .prepare(
      `SELECT
         COALESCE(SUM(shown_count), 0) AS shown,
         COALESCE(SUM(access_count), 0) AS uses,
         SUM(CASE WHEN COALESCE(shown_count, 0) = 0
                   AND COALESCE(access_count, 0) = 0 THEN 1 ELSE 0 END) AS cold
         FROM memories`
    )
    .get() as { shown: number; uses: number; cold: number };

  return {
    totals: { mem, lesson, link, live_mem: liveMem, absorbed: mem - liveMem },
    stage_counts: computeStageCounts(db),
    by_type: countBy(db, "memory_type"),
    by_domain: countBy(db, "domain"),
    by_source_agent: countBy(db, "source_agent"),
    by_source_machine: countBy(db, "source_machine", "(unstamped)"),
    adoption: {
      shown_sum: adoptionRow.shown,
      used_sum: adoptionRow.uses,
      cold_count: adoptionRow.cold,
      // Divide-by-zero guard: no showings → undefined adoption, not 0.
      uses_per_showing:
        adoptionRow.shown > 0
          ? Number((adoptionRow.uses / adoptionRow.shown).toFixed(4))
          : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Stage derivation — ONE formula shared by /dashboard/field (per-memory
// stage on the wire) and the snapshot stage_counts (#422). Extracted so the
// two surfaces cannot drift; both feed deriveStage from calibration-tier
// constants via the same effectiveStrength + recency rule.
// ---------------------------------------------------------------------------

/** The decay-relevant columns every stage derivation reads. */
interface StageRow {
  id: string;
  base_strength: number | null;
  last_accessed: string | null;
  created_at: string;
}

/**
 * Derive one memory's {strength, stage} — the exact math of the field
 * payload: effectiveStrength (importance = base) rounded to the 1e-6 wire
 * format, then the recency gate (days since
 * last_accessed, falling back to created_at; unparseable → null, the gate is
 * skipped rather than guessing "very old") and the calibrated strength bands.
 */
function deriveStageForRow(
  row: StageRow,
  now: Date,
  nowDay: number,
): { strength: number; stage: Stage } {
  const base = row.base_strength ?? 0.5;
  const effStr = effectiveStrength(base, row.last_accessed, now, {
    importance: base,
  });
  const strength = Math.round(effStr * 1e6) / 1e6;
  const refDay = utcDayNumber(row.last_accessed) ?? utcDayNumber(row.created_at);
  const daysSince = refDay === null ? null : nowDay - refDay;
  return { strength, stage: deriveStage(strength, daysSince) };
}

/**
 * Count LIVE (non-absorbed) memories per derived stage — the snapshot's
 * `stage_counts` (#422 Phase 2). Same math as the field payload via the
 * shared deriveStageForRow; absorbed rows are excluded exactly like the
 * field paints them (invisible evidence is not a maturity stage).
 */
export function computeStageCounts(db: Database.Database): {
  forming: number;
  belief: number;
  truth: number;
  fading: number;
} {
  const now = new Date();
  const nowDay = Math.floor(now.getTime() / 86_400_000);
  const rows = db
    .prepare(
      `SELECT id, base_strength, last_accessed, created_at
         FROM memories
        WHERE COALESCE(status, '') != 'absorbed'`,
    )
    .all() as StageRow[];
  const counts = { forming: 0, belief: 0, truth: 0, fading: 0 };
  for (const r of rows) {
    counts[deriveStageForRow(r, now, nowDay).stage]++;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Snapshot writer — runs at the end of each FULL nightly only (never
// capture-only). The `new_this_run` deltas are passed in by nightly.ts (it
// already has the report + dedup/supersession counts in scope); adoption +
// corpus shape are recomputed here from the live DB (one source of truth).
// ---------------------------------------------------------------------------

export interface NightlyDelta {
  added: number;
  lessonsGenerated?: number;
  dedup: number;
  supersession: number;
  /** Memories evicted by the capacity stage this run (#245). */
  evicted?: number;
  /**
   * Total LLM tokens consumed by this run's consolidation (#246). Undefined
   * when consolidation didn't run (capture-only / no_llm / throttled / skipped)
   * or made no metered calls. Stamped into the snapshot so the dashboard can
   * show a usage trend.
   */
  tokensThisRun?: number;
  /**
   * Per-stage breakdown of `tokensThisRun` (#246) — same shape as
   * ConsolidationReport.budget.tokens_by_stage. Undefined in lockstep with
   * `tokensThisRun`.
   */
  tokensByStage?: Record<string, { prompt: number; completion: number; total: number }>;
  /**
   * Distill tokens metered by the daemon across this run's capture POSTs
   * (#287) — summed from the /distill responses by the capture loop. Merged
   * into the snapshot so `new_this_run.tokens` is the run's TRUE total
   * (distill + consolidation) and `distill` joins `tokens_by_stage`. Zero
   * (a daemon predating the usage field, or nothing distilled) is a no-op:
   * the row keeps its consolidation-only shape.
   */
  distillUsage?: { prompt: number; completion: number; total: number };
  /**
   * Always-on consolidation-budget usage (#255 CR). Forwarded whenever
   * consolidation ran so the dashboard renders a continuous used/max bar.
   * `callsUsed` = LLM calls spent this run; `maxCalls` = configured ceiling.
   * Undefined in lockstep (both set together when consolidation ran).
   */
  budgetCallsUsed?: number;
  budgetMaxCalls?: number;
  /**
   * True when this run's consolidation budget was exhausted (#255) — same as
   * ConsolidationReport.budget.exhausted. Undefined when consolidation didn't
   * run (capture-only / no_llm / throttled / skipped) or didn't exhaust.
   */
  budgetExhausted?: boolean;
  /**
   * Per-stage refused-request counts on an exhausted run (#255) — same shape
   * as ConsolidationReport.budget.deferred_by_stage. Undefined in lockstep
   * with `budgetExhausted`.
   */
  budgetDeferredByStage?: Record<string, number>;
  /**
   * #6 backup stage (Phase 0B). Hoisted from the nightly backup block. Present
   * whenever the backup stage ran (full nightly); undefined on capture-only /
   * dry-run. `backupOk` flips to false on snapshot OR hook failure so the
   * digest can flag a night the offsite copy didn't land.
   */
  backupPath?: string;
  backupBytes?: number;
  backupOk?: boolean;
  /**
   * #427: reconsolidation scout counters. Forwarded whenever consolidation
   * ran (the stage's quiet-night shape carries real zeros — the scan doesn't
   * run on a quiet night); undefined when consolidation didn't run at all.
   * Stamped flat snake_case, mirroring the stage report.
   */
  scoutScanned?: number;
  scoutCorrectionShaped?: number;
  scoutCandidatesFound?: number;
}

/**
 * Write one snapshot row for `runAt` (an ISO timestamp the caller chooses —
 * nightly.ts passes `now`). OR-replace on the PRIMARY KEY is intentional: a
 * manual re-run for the same instant overwrites, the nightly never produces
 * two rows for the same instant. Returns the row that was written.
 *
 * `memorySoftCap` (#245) is the resolved cap (0 = disabled) from the config;
 * it is stamped into `metrics.capacity` so a historical snapshot records what
 * cap produced its eviction count. Optional for callers that don't track it.
 */
export function writeSnapshot(
  db: Database.Database,
  runAt: string,
  delta: NightlyDelta,
  memorySoftCap?: number,
): DashboardSnapshot {
  const metrics = computeDashboardMetrics(db);
  // #287: merge the run's two meters into the customer-facing total. `tokens`
  // = consolidation (tokensThisRun) + distill (distillUsage.total); the distill
  // share joins the stage map under its own key. Both fields stay in lockstep —
  // emitted when EITHER phase metered, omitted when neither did (the page
  // treats undefined as "no data for this day"). A zero/absent distillUsage
  // (old daemon, nothing distilled) changes nothing: tokens/tokens_by_stage
  // come through exactly as the consolidation report produced them.
  const hasDistill = (delta.distillUsage?.total ?? 0) > 0;
  const metered = delta.tokensThisRun !== undefined || hasDistill;
  const mergedTokens = metered
    ? (delta.tokensThisRun ?? 0) + (hasDistill ? delta.distillUsage!.total : 0)
    : undefined;
  const mergedStages = metered
    ? { ...(delta.tokensByStage ?? {}), ...(hasDistill ? { distill: delta.distillUsage } : {}) }
    : undefined;
  // Shape fidelity: `tokens_by_stage` with zero keys never existed pre-#287
  // (the key was simply absent) — keep it that way so consumers that treat
  // "present" as "has a breakdown" stay right.
  const emitStages =
    mergedStages && Object.keys(mergedStages).length > 0 ? mergedStages : undefined;
  metrics.new_this_run = {
    added: delta.added,
    lessonsGenerated: delta.lessonsGenerated,
    dedup: delta.dedup,
    supersession: delta.supersession,
    evicted: delta.evicted,
    // #246: forward only when a phase actually metered tokens this run. Absent
    // on capture-only / throttled / no-LLM / no-metered-call runs — the page
    // treats undefined as "no data for this day", matching adoption.
    ...(mergedTokens !== undefined ? { tokens: mergedTokens } : {}),
    ...(emitStages !== undefined ? { tokens_by_stage: emitStages } : {}),
    // #255 CR: always-on usage metric — forward calls_used + max_calls
    // whenever consolidation ran (regardless of exhaustion) so the page can
    // render a continuous used/max bar. Presence = a run happened; absence =
    // consolidation didn't execute (capture-only / no_llm / throttled / skipped).
    ...(delta.budgetCallsUsed !== undefined ? { budget_calls_used: delta.budgetCallsUsed } : {}),
    ...(delta.budgetMaxCalls !== undefined ? { budget_max_calls: delta.budgetMaxCalls } : {}),
    // #255: the alert state. budget_exhausted + budget_deferred_by_stage are
    // gated on the SAME condition (exhausted=true) so the snapshot shape is
    // clean on healthy runs — no empty {} leaking through (W4). The healthy
    // signal is carried by budget_calls_used above, not by a false flag here.
    ...(delta.budgetExhausted
      ? {
          budget_exhausted: true,
          ...(delta.budgetDeferredByStage !== undefined
            ? { budget_deferred_by_stage: delta.budgetDeferredByStage }
            : {}),
        }
      : {}),
    // #6 backup stage — forwarded as a nested object only when the stage ran
    // (backupOk !== undefined). Absent on capture-only / dry-run / backfill.
    ...(delta.backupOk !== undefined
      ? {
          backup: {
            ok: delta.backupOk === true,
            bytes: delta.backupBytes ?? 0,
            ...(delta.backupPath ? { path: delta.backupPath } : {}),
          },
        }
      : {}),
    // #427: scout counters — flat snake_case mirroring the stage report,
    // forwarded whenever consolidation ran (zeros are real quiet-night
    // values). Backfill rows never reach this writer with them set.
    ...(delta.scoutScanned !== undefined ? { scout_scanned: delta.scoutScanned } : {}),
    ...(delta.scoutCorrectionShaped !== undefined
      ? { scout_correction_shaped: delta.scoutCorrectionShaped }
      : {}),
    ...(delta.scoutCandidatesFound !== undefined
      ? { scout_candidates_found: delta.scoutCandidatesFound }
      : {}),
  };
  if (memorySoftCap !== undefined) {
    metrics.capacity = { memory_soft_cap: memorySoftCap };
  }
  db.prepare(
    "INSERT OR REPLACE INTO dashboard_snapshots (run_at, metrics) VALUES (?, ?)",
  ).run(runAt, JSON.stringify(metrics));
  return { run_at: runAt, metrics };
}

// ---------------------------------------------------------------------------
// Backfill — synthesize one snapshot per day from memories.created_at so the
// growth/composition charts have history on day one. Adoption is point-in-time
// and CANNOT be reconstructed from created_at, so backfilled rows OMIT it
// (the page treats undefined as "no data for this day"). See backfillSnapshots
// for the full derivation.
// ---------------------------------------------------------------------------

function utcDay(iso: string): string {
  // created_at is ISO; slice the YYYY-MM-DD prefix. Best-effort — malformed
  // rows fall to the '(unknown)' bucket (rare; created_at is NOT NULL by the
  // insert contract, but legacy imports can carry odd shapes).
  const d = iso.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : "(unknown)";
}

/**
 * When the dashboard_snapshots table is empty, synthesize one row per day from
 * existing memories. Idempotent (only runs when the table is empty — the
 * caller gates on that). Returns the number of rows written.
 *
 * Rows are keyed with a SYNTHETIC ISO timestamp `<YYYY-MM-DD>T00:00:00.000Z`
 * (start of the UTC day), NOT a `backfill-` string prefix. The column is a
 * timestamp sort key everywhere it is read (nightly delta floor, series ASC,
 * digest-day picker), so the value MUST sort like a real ISO timestamp. A
 * `backfill-` prefix would sort AFTER every `2xxx-...` ISO value (`'b' 0x62 >
 * '2' 0x32`), silently breaking the delta floor and the chart ordering. Using
 * midnight-of-day means a real nightly for the same day (which runs later,
 * e.g. 03:00) sorts AFTER its day's backfill row — correct chronological
 * intent, and every `ORDER BY run_at` query is uniform with no special-casing.
 *
 * Derivation:
 *   - For each day D (UTC date of created_at), the row carries cumulative
 *     counts up to and including D (memories whose created_at <= end of D).
 *   - by_type / by_domain / by_source_agent are likewise cumulative slices.
 *   - new_this_run.added/dedup/supersession are derivable (row counts +
 *     timestamp aggregations); lessonsGenerated is NOT (a stage outcome) and
 *     stays undefined.
 *   - adoption is point-in-time and CANNOT be reconstructed from created_at,
 *     so backfilled rows OMIT it (the page treats undefined as "no data").
 */
export function backfillSnapshots(db: Database.Database): number {
  const existing = (
    db.prepare("SELECT COUNT(*) AS c FROM dashboard_snapshots").get() as {
      c: number;
    }
  ).c;
  if (existing > 0) return 0; // never overwrite real history

  // Build cumulative per-day counts in JS — a single query per dimension, then
  // accumulate. Cheaper than N window functions and the corpus is small enough
  // (the snapshot series is bounded by #days since first memory).
  type Row = { created_at: string; memory_type: string; domain: string | null; source_agent: string };
  const rows = db
    .prepare(
      "SELECT created_at, memory_type, domain, source_agent FROM memories ORDER BY created_at ASC",
    )
    .all() as Row[];

  // Daily dedup merges + supersession links (timestamp-derived → aggregable).
  const dedupByDay = new Map<string, number>();
  const dedupRows = db
    .prepare("SELECT merged_at FROM dedup_log")
    .all() as Array<{ merged_at: string }>;
  for (const r of dedupRows) {
    const d = utcDay(r.merged_at);
    dedupByDay.set(d, (dedupByDay.get(d) ?? 0) + 1);
  }

  const superByDay = new Map<string, number>();
  const superRows = db
    .prepare(
      "SELECT created_at FROM memory_links WHERE relationship = 'superseded_by'",
    )
    .all() as Array<{ created_at: string }>;
  for (const r of superRows) {
    const d = utcDay(r.created_at);
    superByDay.set(d, (superByDay.get(d) ?? 0) + 1);
  }

  // Accumulate.
  let mem = 0;
  let lesson = 0;
  let link = 0;
  const byType: Record<string, number> = {};
  const byDomain: Record<string, number> = {};
  const byAgent: Record<string, number> = {};
  // Cumulative link count — memory_links has no created_at? It DOES (schema
  // line 122). Aggregate the same way as memories.
  const linkRows = db
    .prepare("SELECT created_at FROM memory_links ORDER BY created_at ASC")
    .all() as Array<{ created_at: string }>;
  const linkDays = new Map<string, number>();
  for (const r of linkRows) {
    const d = utcDay(r.created_at);
    linkDays.set(d, (linkDays.get(d) ?? 0) + 1);
  }

  // Group memory rows by day, preserve ascending order.
  const byDay = new Map<string, Row[]>();
  for (const r of rows) {
    const d = utcDay(r.created_at);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d)!.push(r);
  }

  const allDays = Array.from(byDay.keys()).sort();
  if (allDays.length === 0) return 0; // nothing to backfill

  const insert = db.prepare(
    "INSERT OR REPLACE INTO dashboard_snapshots (run_at, metrics) VALUES (?, ?)",
  );

  // Walk days in order; each day's snapshot is cumulative THROUGH that day.
  // We include every memory's day — a backfill row only exists for a day with
  // at least one memory (the chart interpolates visually between sparse days).
  const tx = db.transaction(() => {
    for (const d of allDays) {
      const dayRows = byDay.get(d)!;
      for (const r of dayRows) {
        mem++;
        if (r.memory_type === "learnings") lesson++;
        byType[r.memory_type] = (byType[r.memory_type] ?? 0) + 1;
        const domKey = r.domain ?? "(unscoped)";
        byDomain[domKey] = (byDomain[domKey] ?? 0) + 1;
        byAgent[r.source_agent] = (byAgent[r.source_agent] ?? 0) + 1;
      }
      link += linkDays.get(d) ?? 0;
      const metrics: DashboardMetrics = {
        totals: { mem, lesson, link },
        by_type: { ...byType },
        by_domain: { ...byDomain },
        by_source_agent: { ...byAgent },
        // Backfilled history predates stamping by construction — every
        // synthesized row is honestly "(unstamped)" (#421).
        by_source_machine: { "(unstamped)": mem },
        // new_this_run on a backfill row = the deltas DERIVED for that day
        // (added/lesson/dedup/supersession); lessonsGenerated is undefined
        // (it's a stage-outcome, not a row count — can't be reconstructed).
        new_this_run: {
          added: dayRows.length,
          dedup: dedupByDay.get(d) ?? 0,
          supersession: superByDay.get(d) ?? 0,
        },
        // adoption intentionally omitted — point-in-time, not derivable.
      };
      insert.run(`${d}T00:00:00.000Z`, JSON.stringify(metrics));
    }
  });
  tx();

  return allDays.length;
}

// ---------------------------------------------------------------------------
// Data query — reads the snapshot series for the selected range, computes the
// LIVE composition (so day-one, before any snapshot is written, still shows
// the current corpus shape), and builds the digest for the selected day.
// ---------------------------------------------------------------------------

const VALID_RANGES = new Set(["7d", "30d", "90d", "180d", "all"]);
const DEFAULT_RANGE = "30d";
const DEFAULT_DIGEST_LIMIT = 10;

function rangeToCutoff(range: string): string | null {
  if (range === "all") return null;
  const days = parseInt(range, 10);
  if (!Number.isFinite(days)) return null;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return cutoff.toISOString();
}

/**
 * Render a memory row the SAME way the recall index does — imported directly
 * from recall-index.ts, never reimplemented. This is an acceptance criterion:
 * the dashboard cannot drift from what agents see. Returns the rendered line
 * plus the row's bare fields (the page links the id to /memory?id= and /viz).
 */
function renderIndexLine(
  row: {
    id: string;
    content: string;
    created_at: string;
    domain: string | null;
    project: string | null;
    source_agent: string | null;
    memory_type: string;
  },
  maxLen: number,
): { id: string; line: string; created_at: string } {
  // Shape matches MemorySearchResult & { domain } — formatIndexLine reads only
  // these fields. access_count / connections / score are not used by the
  // renderer (only provenance + title), so stubbing them is safe.
  const line = formatIndexLine(
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
    maxLen,
  );
  return { id: row.id, line, created_at: row.created_at };
}

/**
 * The pure data handler for GET /dashboard/data. Reads query params
 * (`range`, `date`, `digestLimit`) off the request, returns the DashboardData
 * payload. Never throws on empty/missing data — returns a valid empty shape.
 *
 * `config` is the saved config object (for `dashboardDigestLimit`); it is read
 * DEFENSIVELY via readPositiveConfig (invalid → default + warn, never crash).
 */
export function handleDashboardData(
  db: Database.Database,
  query: { range?: unknown; date?: unknown },
  config: Record<string, unknown> | null | undefined,
): { status: number; body: DashboardData } {
  const rangeParam =
    typeof query.range === "string" && VALID_RANGES.has(query.range)
      ? (query.range as "7d" | "30d" | "90d" | "180d" | "all")
      : DEFAULT_RANGE;
  const digestLimit = readPositiveConfig(
    config ?? {},
    "dashboardDigestLimit",
    DEFAULT_DIGEST_LIMIT,
  );

  // Series: snapshots within the range window.
  const cutoff = rangeToCutoff(rangeParam);
  const seriesRows = cutoff
    ? (db
        .prepare(
          "SELECT run_at, metrics FROM dashboard_snapshots WHERE run_at >= ? ORDER BY run_at ASC",
        )
        .all(cutoff) as Array<{ run_at: string; metrics: string }>)
    : (db
        .prepare("SELECT run_at, metrics FROM dashboard_snapshots ORDER BY run_at ASC")
        .all() as Array<{ run_at: string; metrics: string }>);
  const series: DashboardSnapshot[] = seriesRows.map((r) => ({
    run_at: r.run_at,
    metrics: JSON.parse(r.metrics) as DashboardMetrics,
  }));

  // Live composition (so day-one with no snapshots still shows the corpus).
  const live = computeDashboardMetrics(db);

  // Headline = live corpus (the chart shows history; the headline shows now).
  // `memory_soft_cap` (#245): resolve from the live config (the source of
  // truth for "what cap is in force right now"), defaulting to the production
  // default. The page renders no gauge when it's 0 (disabled). #317: routes
  // through resolveMemorySoftCap so a HICORTEX_MEMORY_CAP env pin is honored
  // here too — the DISPLAYED cap can never disagree with the ENFORCED cap
  // (both consumers share the one resolver).
  //
  // `tokens` (#246): period accrual from state.json (the same single source
  // the throttle check reads, so the dashboard always agrees with the runtime
  // decision). The cap is `llmTokensPerMonth` (0 = unlimited). The page hides
  // the stat entirely when `used` is 0 (no metered run yet).
  const tokenState = loadState().llmTokensThisPeriod;
  const headline = {
    total_memories: live.totals.mem,
    // #422: the field paints live rows only, so the band number must too —
    // this closes the "console says 574 more than the field shows" gap.
    // `?? mem` is type-narrowing only (computeDashboardMetrics always sets it).
    live_memories: live.totals.live_mem ?? live.totals.mem,
    uses_per_showing: live.adoption?.uses_per_showing ?? null,
    cold_count: live.adoption?.cold_count ?? 0,
    memory_soft_cap: resolveMemorySoftCap(config?.memorySoftCap),
    tokens: {
      used: tokenState?.total ?? 0,
      cap: readNonNegativeConfig(config ?? {}, "llmTokensPerMonth", 0),
      period_start: tokenState?.periodStart ?? null,
    },
  };

  // Digest: pick the day to summarize. `date` (YYYY-MM-DD) wins; else the most
  // recent snapshot's day (real nightly OR backfill — both carry valid ISO
  // run_at since backfill rows use a synthetic midnight timestamp); else today.
  let dateStr: string | null = null;
  if (typeof query.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(query.date)) {
    dateStr = query.date;
  } else {
    const last = db
      .prepare("SELECT run_at FROM dashboard_snapshots ORDER BY run_at DESC LIMIT 1")
      .get() as { run_at: string } | undefined;
    dateStr = last ? last.run_at.slice(0, 10) : new Date().toISOString().slice(0, 10);
  }

  const dayStart = `${dateStr}T00:00:00.000Z`;
  const dayEnd = `${dateStr}T23:59:59.999Z`;

  // Sample of memories created that day, rendered via the production index
  // line renderer. Ordered by created_at so the page is stable across reloads.
  const sampleRows = db
    .prepare(
      `SELECT id, content, created_at, domain, project, source_agent, memory_type
         FROM memories
        WHERE created_at BETWEEN ? AND ?
        ORDER BY created_at ASC
        LIMIT ?`,
    )
    .all(dayStart, dayEnd, digestLimit) as Array<{
    id: string;
    content: string;
    created_at: string;
    domain: string | null;
    project: string | null;
    source_agent: string | null;
    memory_type: string;
  }>;
  // Render each sample through the production index line at its DEFAULT title
  // length (100) — the issue spec: the digest matches what agents see, so the
  // title truncation is identical, not dashboard-specific.
  const sample = sampleRows.map((r) => renderIndexLine(r, 100));

  // Lessons created that day — full content (the issue says "full text").
  const lessonRows = db
    .prepare(
      `SELECT id, content, created_at
         FROM memories
        WHERE memory_type = 'learnings' AND created_at BETWEEN ? AND ?
        ORDER BY created_at ASC`,
    )
    .all(dayStart, dayEnd) as Array<{
    id: string;
    content: string;
    created_at: string;
  }>;

  // Stage outcomes for the day: dedup merges + supersession links that day.
  const dedupRows = db
    .prepare(
      `SELECT loser_id, canonical_id, content_head, merged_at
         FROM dedup_log
        WHERE merged_at BETWEEN ? AND ?
        ORDER BY merged_at ASC`,
    )
    .all(dayStart, dayEnd) as Array<{
    loser_id: string;
    canonical_id: string;
    content_head: string | null;
    merged_at: string;
  }>;

  const supersessionCount = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM memory_links
          WHERE relationship = 'superseded_by'
            AND created_at BETWEEN ? AND ?`,
      )
      .get(dayStart, dayEnd) as { c: number }
  ).c;

  // Try to find the night's snapshot for lessonsGenerated + the real added
  // count (new_this_run.added reflects the distill count for that run, a more
  // faithful signal than created_at when the snapshot exists). One query for
  // both run_at and metrics.
  const daySnap = db
    .prepare(
      `SELECT run_at, metrics FROM dashboard_snapshots
        WHERE run_at BETWEEN ? AND ?
        ORDER BY run_at DESC LIMIT 1`,
    )
    .get(dayStart, dayEnd) as { run_at: string; metrics: string } | undefined;
  const dayMetrics = daySnap
    ? (JSON.parse(daySnap.metrics) as DashboardMetrics)
    : undefined;

  const digest: DashboardData["digest"] = {
    date: dateStr,
    run_at: daySnap ? daySnap.run_at : null,
    sample,
    lessons: lessonRows,
    stages: {
      lessonsGenerated: dayMetrics?.new_this_run?.lessonsGenerated,
      dedup: dayMetrics?.new_this_run?.dedup ?? dedupRows.length,
      supersession: dayMetrics?.new_this_run?.supersession ?? supersessionCount,
      added: dayMetrics?.new_this_run?.added ?? sampleRows.length,
      evicted: dayMetrics?.new_this_run?.evicted,
      // #246/#287: only present when the day's nightly metered tokens (distill
      // or consolidation). Both fields are forwarded together — the page
      // renders either the breakdown or nothing.
      tokens: dayMetrics?.new_this_run?.tokens,
      tokens_by_stage: dayMetrics?.new_this_run?.tokens_by_stage,
      // #255 CR: always-on usage metric — present whenever consolidation ran
      // (under-cap OR exhausted). The page renders a continuous used/max bar.
      budget_calls_used: dayMetrics?.new_this_run?.budget_calls_used,
      budget_max_calls: dayMetrics?.new_this_run?.budget_max_calls,
      // #255: budget exhaustion — only present when the run actually hit the
      // cap (undefined on backfill / non-run / under-cap nights).
      budget_exhausted: dayMetrics?.new_this_run?.budget_exhausted,
      budget_deferred_by_stage: dayMetrics?.new_this_run?.budget_deferred_by_stage,
    },
    dedup_merges: dedupRows.map((r) => ({
      loser_id: r.loser_id,
      canonical_id: r.canonical_id,
      content_head: r.content_head,
      merged_at: r.merged_at,
    })),
  };

  return {
    status: 200,
    body: {
      // Account identity — read defensively like the numeric knobs above:
      // null when absent/not a string (page renders nothing, never "null").
      // Shared readAccount() so GET /account renders the identical shape.
      account: readAccount(config),
      range: rangeParam,
      headline,
      series,
      composition: {
        by_type: live.by_type,
        by_domain: live.by_domain,
        by_source_agent: live.by_source_agent,
        by_source_machine: live.by_source_machine,
      },
      capture_health: { ...readCaptureHealth(db), ...readCaptureHealthWindow(db) },
      // #423 phase 3: pauses + presence in one block — one source of truth
      // for the rail's dots, toggles and the capture card's PAUSED badges.
      fleet: {
        pauses: listCapturePauses(db),
        last_seen: readFleetLastSeen(db),
      },
      digest,
    },
  };
}

/**
 * Express adapter for GET /dashboard/data. Wraps the pure handler so the
 * route stays thin (same convention as identity-store handlers in viz.ts).
 * Failures surface as a 500 with the usual {error} shape — no silent degrade.
 */
export function dashboardDataHandler(
  getDb: () => Database.Database,
  getConfig: () => Record<string, unknown> | null | undefined,
): express.RequestHandler {
  return (req, res) => {
    try {
      const { status, body } = handleDashboardData(
        getDb(),
        req.query as Record<string, unknown>,
        getConfig(),
      );
      res.status(status).json(body);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  };
}

/**
 * Express adapter for GET /account — the account identity ONLY (name/org/plan
 * from config), so the /viz and /identity/ui pages can render the nav account
 * element without pulling the full /dashboard/data payload. Same readAccount()
 * construction as the dashboard payload — one shape, two surfaces. Also the
 * natural whoami for the future OAuth session (#292). Failures surface as a
 * 500 with the usual {error} shape (same as dashboardDataHandler).
 */
export function accountHandler(
  getConfig: () => Record<string, unknown> | null | undefined,
): express.RequestHandler {
  return (_req, res) => {
    try {
      res.status(200).json({ account: readAccount(getConfig()) });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  };
}

/**
 * Express adapter for GET /account/token — the install's connection token for
 * the console account menu (#365). SECURITY: echo-only — the caller must
 * ALREADY present the token (bearer, or the localhost bypass) to receive it,
 * so this endpoint grants no privilege. It exists so the menu shows the
 * AUTHORITATIVE server-side token instead of trusting localStorage, which can
 * be stale after token rotation and is absent entirely for browser sessions
 * the hosted router authenticates via its session→bearer injection.
 *
 * `getToken` receives the boot-resolved PRIMARY token (config authToken ??
 * HICORTEX_AUTH_TOKEN env) — the value the auth middleware itself accepts as
 * current, so the menu survives rotation and never echoes the rotation-grace
 * token. When no token is configured the handler answers 503 (mirrors how the
 * /auth/* endpoints answer "not configured"); other failures surface as a 500
 * {error} exactly like accountHandler.
 */
export function accountTokenHandler(
  getToken: () => string | undefined,
): express.RequestHandler {
  return (_req, res) => {
    try {
      const token = getToken();
      if (!token) {
        res.status(503).json({ error: "no auth token configured on this install" });
        return;
      }
      res.status(200).json({ token });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  };
}

// ---------------------------------------------------------------------------
// /dashboard/field — the console flight-field payload (#409/#421 Phase 1).
//
// The whole LIVE store as minimal fields (no content bodies — titles are the
// same ≤100-char de-markdowned first line the recall index shows, via the
// IMPORTED memoryTitle) plus every link edge as {a, b, rel}. Derived stage
// rides every memory: the E-reframe holds — stages are presentation computed
// here from effectiveStrength + recency, never stored state.
//
// HIDDEN rows are excluded with the store's own predicate: dedup/reconsol
// losers carry status 'absorbed' (retained as evidence, invisible to recall —
// no vector, no FTS row). Superseded/retracted/corrected rows stay in: they
// are demoted, not hidden, and the field should show the whole living graph.
// ---------------------------------------------------------------------------

/** One memory in the field payload — minimal fields, no content body. */
export interface DashboardFieldMemory {
  id: string;
  /** First content line, de-markdowned, ≤ RECALL_TITLE_CHARS (memoryTitle). */
  title: string;
  /** Derived primary domain (argmax tag weight); null = unscoped. */
  domain: string | null;
  /** Derived maturity stage (E-reframe: presentation, never stored). */
  stage: Stage;
  /** effectiveStrength rounded to 1e-6, same as retrieval's wire format. */
  strength: number;
  access_count: number;
  created_at: string;
  source_agent: string | null;
  /** Machine the capture ran on (#421 machine × harness). Null on rows
   *  written before migration v15 — the console groups those under
   *  "earlier captures". */
  source_machine: string | null;
}

/** One link edge — endpoints + relationship only (strength stays off-wire). */
export interface DashboardFieldLink {
  a: string;
  b: string;
  rel: string;
}

/** The /dashboard/field response. */
export interface DashboardField {
  generated_at: string;
  /** The thresholds the stages were derived with, echoed so the page paints
   *  from the same constants the server scored with (calibration.ts is the
   *  single home — the echo is display, not a second source). Recall grades
   *  are GONE (#426 owner semantics ruling 2026-09-13: recall depends on the
   *  conversation, a graded scale implies a target that does not exist). */
  thresholds: {
    stage: { fading_days: number; fading_strength: number; belief: number; truth: number };
    /** The recall relevance floor (RECALL_MIN_SIMILARITY) — echoed so the
     *  console gates its /search calls with the same constant the server's
     *  own recall gates with (#409 console polish; the echo is display, not
     *  a second source — same rule as the stage bands). Absent nothing: the
     *  key always rides the payload; a pre-polish page ignores it. */
    recall_min_similarity: number;
    /** #426 final ruling 2026-09-13: the console's recall-level band edges
     *  (RECALL_USES_* — PROVISIONAL, owner anchor 2026-09-13, pending fleet
     *  telemetry). Same echo rule as recall_min_similarity: calibration.ts is
     *  the single home, the page never hardcodes the edges, and a page older
     *  than this key simply ignores it (no band). These classify the console
     *  card's zone word and position the gradient; per-memory recall grades
     *  remain GONE from the field payload (the earlier #426 ruling — a
     *  memory's recall fitness is conversation-dependent). */
    recall_uses: {
      /** Below this reads Low. */
      low_max: number;
      /** Below this (and ≥ low_max) reads Normal; at/above reads Overfetching. */
      normal_max: number;
      /** Display-axis maximum (marker clamps here). */
      axis_max: number;
    };
  };
  memories: DashboardFieldMemory[];
  links: DashboardFieldLink[];
}

/** UTC day number (days since epoch) for an ISO timestamp; null when the
 *  string does not parse — the night-resolution clock for stage recency. */
function utcDayNumber(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor(t / 86_400_000) : null;
}

/**
 * The pure data handler for GET /dashboard/field. Reads the whole live store
 * (minus absorbed rows) + all link edges, derives stage + effective strength
 * per memory, and returns the field payload. Never throws on empty stores —
 * an empty brain is a valid field.
 */
export function handleDashboardField(
  db: Database.Database,
): { status: number; body: DashboardField } {
  const now = new Date();
  const nowDay = Math.floor(now.getTime() / 86_400_000);

  const rows = db
    .prepare(
      `SELECT id, content, base_strength, last_accessed, access_count,
              created_at, domain, source_agent, source_machine
         FROM memories
        WHERE COALESCE(status, '') != 'absorbed'
        ORDER BY created_at ASC, id ASC`,
    )
    .all() as Array<{
    id: string;
    content: string;
    base_strength: number | null;
    last_accessed: string | null;
    access_count: number | null;
    created_at: string;
    domain: string | null;
    source_agent: string | null;
    source_machine: string | null;
  }>;

  const memories: DashboardFieldMemory[] = rows.map((r) => {
    // Shared per-row derivation — the SAME math the snapshot stage_counts
    // uses (deriveStageForRow); the field only adds its wire fields.
    const { strength, stage } = deriveStageForRow(r, now, nowDay);
    return {
      id: r.id,
      title: memoryTitle(r.content, RECALL_TITLE_CHARS),
      domain: r.domain,
      stage,
      strength,
      access_count: r.access_count ?? 0,
      created_at: r.created_at,
      source_agent: r.source_agent,
      source_machine: r.source_machine ?? null,
    };
  });

  const linkRows = db
    .prepare(
      "SELECT source_id, target_id, relationship FROM memory_links ORDER BY created_at ASC",
    )
    .all() as Array<{ source_id: string; target_id: string; relationship: string }>;

  return {
    status: 200,
    body: {
      generated_at: now.toISOString(),
      // #426 owner semantics ruling 2026-09-13: recall grades are REMOVED —
      // recall depends on the conversation, higher is not a target. Only the
      // stage thresholds ride the echo (calibrated 2026-09-13), plus the two
      // #409/#426 display keys: the search floor and the recall-level band
      // edges (PROVISIONAL — see calibration.ts).
      thresholds: {
        stage: {
          fading_days: STAGE_FADING_DAYS,
          fading_strength: STAGE_FADING_STRENGTH,
          belief: STAGE_BELIEF_STRENGTH,
          truth: STAGE_TRUTH_STRENGTH,
        },
        recall_min_similarity: RECALL_MIN_SIMILARITY,
        recall_uses: {
          low_max: RECALL_USES_LOW_MAX,
          normal_max: RECALL_USES_NORMAL_MAX,
          axis_max: RECALL_USES_AXIS_MAX,
        },
      },
      memories,
      links: linkRows.map((l) => ({ a: l.source_id, b: l.target_id, rel: l.relationship })),
    },
  };
}

/** True when the request genuinely accepts a gzip response (quality-aware —
 *  `gzip;q=0` negotiates to no). Uses the framework's content negotiation
 *  rather than substring-matching the header (#424 review). */
function acceptsGzip(req: express.Request): boolean {
  return req.acceptsEncodings("gzip") === "gzip";
}

/**
 * Express adapter for GET /dashboard/field. Bearer-only by construction
 * (mounted after createAuthMiddleware — no exemption). Gzips the payload
 * when the client advertises Accept-Encoding: gzip: the field is one row per
 * memory on possibly very large stores, so the wire cost is the point
 * (minimal fields + compression, per the #409 payload-size risk note).
 * Failures surface as a 500 {error} like the sibling adapters.
 */
export function dashboardFieldHandler(
  getDb: () => Database.Database,
): express.RequestHandler {
  return (req, res) => {
    try {
      const { status, body } = handleDashboardField(getDb());
      if (status !== 200) {
        res.status(status).json(body);
        return;
      }
      if (acceptsGzip(req)) {
        const buf = gzipSync(JSON.stringify(body));
        res
          .set({
            "Content-Type": "application/json",
            "Content-Encoding": "gzip",
            "Vary": "Accept-Encoding",
          })
          .status(status)
          .send(buf);
        return;
      }
      res.status(status).json(body);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  };
}

// ---------------------------------------------------------------------------
// /dashboard/events — the console's night-resolution event ledger
// (#409/#421 Phase 1; truth-management sources #452).
//
// A SYNTHESIS query over existing tables (no event-sourcing store, no schema
// change): added from memories.created_at (absorbed rows INCLUDED — the
// replay needs their birth AND their merge-out), enriched from
// memory_history.created_at (distinct memory per night, EXCLUDING
// reconsolidation rewrites — those render as `rewritten`, one caption
// instead of "Enriched"+"Rewritten"), merged from dedup_log.merged_at,
// linked from memory_links.created_at, superseded from
// memory_links.created_at WHERE relationship='superseded_by' (the link ALSO
// rings `linked` — supersession is still a connection), retracted from
// corrected_by links whose SOURCE's current status is 'retracted' (INNER
// JOIN so the current-status filter applies — rewrite-path corrected_by
// links leave status 'corrected' and are NOT retractions; marks write no
// memory_history row), rewritten from memory_history WHERE
// cause='reconsolidation'. Only nights with ≥1 event are returned (the
// scrub spaces by date; empty nights would render nothing). Every count
// reconciles with its source table by construction — a night's `merged`
// length equals the dedup_log rows for that UTC day, `superseded` the
// superseded_by link rows, `retracted` the status-filtered corrected_by
// rows, `rewritten` the distinct reconsolidation-rewritten memories.
// ---------------------------------------------------------------------------

/** One night of the replay ledger. `by_agent` keys are source_agent strings
 *  ("(unknown)" when the memory row is gone); learned counts added, enriched
 *  counts distinct enriched memories, merged counts dedup losers, and the
 *  #452 truth-management keys count superseded/retracted sources and
 *  reconsolidation rewrites (agent = the OLD memory's source — the event
 *  belongs to the memory that was demoted). */
export interface DashboardEventsNight {
  date: string;
  added: string[];
  enriched: string[];
  merged: Array<{ loser: string; canonical: string }>;
  linked: Array<{ a: string; b: string }>;
  /** #452 — superseded_by links born that night ({old, by} ids). */
  superseded: Array<{ old: string; by: string }>;
  /** #452 — corrected_by links whose source is currently status='retracted'. */
  retracted: Array<{ old: string; by: string }>;
  /** #452 — distinct memories reconsolidation rewrote that night. */
  rewritten: string[];
  by_agent: Record<
    string,
    {
      learned: number;
      enriched: number;
      merged: number;
      superseded: number;
      retracted: number;
      rewritten: number;
    }
  >;
}

/** The /dashboard/events response. */
export interface DashboardEvents {
  nights: DashboardEventsNight[];
}

// #452 (owner directive 2026-09-16): the default window is 30 days for ALL
// views — longer ranges are opt-in via the page's selector. MAX stays 365:
// it is the generic API cap and an explicit ?days= is honored up to it.
const EVENTS_DEFAULT_DAYS = 30;
const EVENTS_MAX_DAYS = 365;

/** Parse the ?days= param: integer 1..365, default 30. Returns null when the
 *  value is present but invalid (→ 400); undefined when absent (→ default). */
function parseEventsDays(raw: unknown): number | null | undefined {
  if (raw === undefined) return undefined;
  const first = Array.isArray(raw) ? raw[0] : raw;
  const n = typeof first === "number" ? first : Number(first);
  if (!Number.isInteger(n) || n < 1 || n > EVENTS_MAX_DAYS) return null;
  return n;
}

/**
 * The pure data handler for GET /dashboard/events?days=N. Buckets the event
 * sources into UTC nights (only nights with events, ascending) within the
 * last `days` calendar days (today inclusive).
 */
export function handleDashboardEvents(
  db: Database.Database,
  query: { days?: unknown },
): { status: number; body: DashboardEvents | { error: string } } {
  const parsed = parseEventsDays(query.days);
  if (parsed === null) {
    return {
      status: 400,
      body: { error: `Invalid 'days' — expected an integer between 1 and ${EVENTS_MAX_DAYS}` },
    };
  }
  const days = parsed ?? EVENTS_DEFAULT_DAYS;

  // Calendar-day window: today's UTC day back through (days - 1) days ago.
  const todayDay = Math.floor(Date.now() / 86_400_000);
  const cutoffDay = todayDay - (days - 1);
  const cutoffIso = new Date(cutoffDay * 86_400_000).toISOString();

  const nights = new Map<string, DashboardEventsNight>();
  const inWindow = (iso: string | null): string | null => {
    const d = utcDayNumber(iso);
    if (d === null || d < cutoffDay || d > todayDay) return null;
    return new Date(d * 86_400_000).toISOString().slice(0, 10);
  };
  const nightFor = (date: string): DashboardEventsNight => {
    let n = nights.get(date);
    if (!n) {
      n = {
        date,
        added: [],
        enriched: [],
        merged: [],
        linked: [],
        superseded: [],
        retracted: [],
        rewritten: [],
        by_agent: {},
      };
      nights.set(date, n);
    }
    return n;
  };
  const bumpAgent = (
    n: DashboardEventsNight,
    agent: string | null,
    key: "learned" | "enriched" | "merged" | "superseded" | "retracted" | "rewritten",
  ): void => {
    const k = agent ?? "(unknown)";
    const rec =
      n.by_agent[k] ?? {
        learned: 0,
        enriched: 0,
        merged: 0,
        superseded: 0,
        retracted: 0,
        rewritten: 0,
      };
    rec[key] += 1;
    n.by_agent[k] = rec;
  };

  // added — every memory row born in the window (absorbed included: the
  // replay needs the birth of rows a later merge folds away).
  const addedRows = db
    .prepare("SELECT id, source_agent, created_at FROM memories WHERE created_at >= ?")
    .all(cutoffIso) as Array<{ id: string; source_agent: string | null; created_at: string }>;
  for (const r of addedRows) {
    const date = inWindow(r.created_at);
    if (date === null) continue;
    const n = nightFor(date);
    n.added.push(r.id);
    bumpAgent(n, r.source_agent, "learned");
  }

  // enriched — memory_history rows, DISTINCT memory per night (one rewrite of
  // the same memory on a night is one enrichment). LEFT JOIN: the memory row
  // can be gone (hard-deleted legacy losers); those count under "(unknown)".
  // #452: reconsolidation rewrites are EXCLUDED — they render as `rewritten`
  // below, so one rewrite is one caption, never "Enriched"+"Rewritten".
  const enrichRows = db
    .prepare(
      `SELECT h.memory_id, h.created_at, m.source_agent AS agent
         FROM memory_history h LEFT JOIN memories m ON m.id = h.memory_id
        WHERE h.created_at >= ? AND h.cause <> 'reconsolidation'`,
    )
    .all(cutoffIso) as Array<{ memory_id: string; created_at: string; agent: string | null }>;
  const enrichedSeen = new Set<string>(); // `${date}|${memory_id}` dedup
  for (const r of enrichRows) {
    const date = inWindow(r.created_at);
    if (date === null) continue;
    const key = `${date}|${r.memory_id}`;
    if (enrichedSeen.has(key)) continue;
    enrichedSeen.add(key);
    const n = nightFor(date);
    n.enriched.push(r.memory_id);
    bumpAgent(n, r.agent, "enriched");
  }

  // merged — dedup_log rows; agent = the LOSER's source_agent (the merge
  // event belongs to the memory that went away).
  const mergedRows = db
    .prepare(
      `SELECT d.loser_id, d.canonical_id, d.merged_at, m.source_agent AS agent
         FROM dedup_log d LEFT JOIN memories m ON m.id = d.loser_id
        WHERE d.merged_at >= ?`,
    )
    .all(cutoffIso) as Array<{
    loser_id: string;
    canonical_id: string;
    merged_at: string;
    agent: string | null;
  }>;
  for (const r of mergedRows) {
    const date = inWindow(r.merged_at);
    if (date === null) continue;
    const n = nightFor(date);
    n.merged.push({ loser: r.loser_id, canonical: r.canonical_id });
    bumpAgent(n, r.agent, "merged");
  }

  // linked — memory_links rows born in the window.
  const linkedRows = db
    .prepare("SELECT source_id, target_id, created_at FROM memory_links WHERE created_at >= ?")
    .all(cutoffIso) as Array<{ source_id: string; target_id: string; created_at: string }>;
  for (const r of linkedRows) {
    const date = inWindow(r.created_at);
    if (date === null) continue;
    nightFor(date).linked.push({ a: r.source_id, b: r.target_id });
  }

  // superseded (#452) — superseded_by links born in the window; agent = the
  // OLD memory's source (the event belongs to the demoted claim). The link
  // ALSO stays in `linked` above — supersession is still a connection, the
  // ring is unchanged.
  const supersededRows = db
    .prepare(
      `SELECT l.source_id, l.target_id, l.created_at, m.source_agent AS agent
         FROM memory_links l LEFT JOIN memories m ON m.id = l.source_id
        WHERE l.relationship = 'superseded_by' AND l.created_at >= ?`,
    )
    .all(cutoffIso) as Array<{
    source_id: string;
    target_id: string;
    created_at: string;
    agent: string | null;
  }>;
  for (const r of supersededRows) {
    const date = inWindow(r.created_at);
    if (date === null) continue;
    const n = nightFor(date);
    n.superseded.push({ old: r.source_id, by: r.target_id });
    bumpAgent(n, r.agent, "superseded");
  }

  // retracted (#452) — corrected_by links whose SOURCE's CURRENT status is
  // 'retracted'. INNER JOIN so the status filter applies: rewrite-path
  // corrected_by links leave status 'corrected' (or NULL on legacy rows) and
  // are NOT retractions. Marks write no memory_history row (grounding: the
  // only two INSERT sites are the reconsolidation rewrite + rollback), so
  // the link + current status IS the retraction record. Dedup per
  // (date, source_id) — the enriched pattern — in case a pair's link row was
  // re-created on the same night.
  const retractedRows = db
    .prepare(
      `SELECT l.source_id, l.target_id, l.created_at, m.source_agent AS agent
         FROM memory_links l JOIN memories m ON m.id = l.source_id
        WHERE l.relationship = 'corrected_by' AND m.status = 'retracted' AND l.created_at >= ?`,
    )
    .all(cutoffIso) as Array<{
    source_id: string;
    target_id: string;
    created_at: string;
    agent: string | null;
  }>;
  const retractedSeen = new Set<string>(); // `${date}|${source_id}` dedup
  for (const r of retractedRows) {
    const date = inWindow(r.created_at);
    if (date === null) continue;
    const key = `${date}|${r.source_id}`;
    if (retractedSeen.has(key)) continue;
    retractedSeen.add(key);
    const n = nightFor(date);
    n.retracted.push({ old: r.source_id, by: r.target_id });
    bumpAgent(n, r.agent, "retracted");
  }

  // rewritten (#452) — memory_history rows from the reconsolidation rewrite
  // (cause='reconsolidation'; rollback rows keep their own cause and stay
  // enriched-shaped). DISTINCT memory per night, the enriched pattern.
  const rewrittenRows = db
    .prepare(
      `SELECT h.memory_id, h.created_at, m.source_agent AS agent
         FROM memory_history h LEFT JOIN memories m ON m.id = h.memory_id
        WHERE h.cause = 'reconsolidation' AND h.created_at >= ?`,
    )
    .all(cutoffIso) as Array<{ memory_id: string; created_at: string; agent: string | null }>;
  const rewrittenSeen = new Set<string>(); // `${date}|${memory_id}` dedup
  for (const r of rewrittenRows) {
    const date = inWindow(r.created_at);
    if (date === null) continue;
    const key = `${date}|${r.memory_id}`;
    if (rewrittenSeen.has(key)) continue;
    rewrittenSeen.add(key);
    const n = nightFor(date);
    n.rewritten.push(r.memory_id);
    bumpAgent(n, r.agent, "rewritten");
  }

  const sorted = Array.from(nights.values())
    .filter(
      (n) =>
        n.added.length +
          n.enriched.length +
          n.merged.length +
          n.linked.length +
          n.superseded.length +
          n.retracted.length +
          n.rewritten.length >
        0,
    )
    .sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));

  return { status: 200, body: { nights: sorted } };
}

/**
 * Express adapter for GET /dashboard/events. Bearer-only by construction
 * (mounted after createAuthMiddleware — no exemption). The ledger is ids
 * only (no titles), so it stays plain JSON — gzip is the /field adapter's
 * concern. Failures surface as a 500 {error} like the sibling adapters.
 */
export function dashboardEventsHandler(
  getDb: () => Database.Database,
): express.RequestHandler {
  return (req, res) => {
    try {
      const { status, body } = handleDashboardEvents(getDb(), req.query as Record<string, unknown>);
      res.status(status).json(body);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  };
}

// ---------------------------------------------------------------------------
// GET/PUT /dashboard/model — the console's model-settings surface (#422
// Phase 2).
//
// The dashboard stays view-only EXCEPT this one scoped writer: model knobs are
// the install's operational identity, the console is where the operator looks
// at them, and the alternative (hand-editing config.json over SSH) is exactly
// the failure mode the strict loader exists for. The surface is deliberately
// NARROW — an allowlisted subset of the llm*/maxTokens/enableThinking keys,
// validated per-key, persisted through init.ts persistConfigUpdates (strict
// load; a malformed config throws and the file is never overwritten).
//
// SECURITY: no key material on the wire, ever. GET reports only `api_key_set`
// (a boolean); PUT accepts a NEW key (write-only). The GET/PUT handlers are
// pure; the express adapters follow the dashboardDataHandler convention.
// ---------------------------------------------------------------------------

/** The GET /dashboard/model + PUT-success response shape (snake_case wire). */
export interface DashboardModelSettings {
  /** Boot-resolved runtime provider label (e.g. "ollama", "claude-cli",
   *  "openai" for the openai-compat path); null when the daemon runs no LLM.
   *  Runtime truth, not config — the card's model line comes from
   *  /health/detail, this carries only the provider. */
  provider: string | null;
  /** config llmBackend — null when unset (baseUrl+apiKey = openai-compat). */
  backend: string | null;
  /** config llmBaseUrl — null when unset (defaults are the UI's placeholders,
   *  never resolved here). */
  base_url: string | null;
  /** config llmModel — null when unset. */
  model: string | null;
  /** config maxTokens — null when unset. */
  max_tokens: number | null;
  /** config enableThinking — null when unset. */
  enable_thinking: boolean | null;
  /** Whether llmApiKey is set. The VALUE is never on the wire. */
  api_key_set: boolean;
  /** Constant true — the daemon resolves config at boot, so every write
   *  lands on restart. The modal footnotes it. */
  applies_on_restart: true;
}

/** A config value echoed as a non-blank string, else null. */
function configString(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

/**
 * The pure GET handler: echo the CONFIG values raw (null when unset — the UI
 * shows defaults as placeholders, so this never resolves them) + the runtime
 * provider from the daemon's in-memory llmConfig.
 */
export function handleDashboardModelGet(
  config: Record<string, unknown> | null | undefined,
  llmConfig: { provider: string } | null,
): { status: 200; body: DashboardModelSettings } {
  const cfg = config ?? {};
  return {
    status: 200,
    body: {
      provider: llmConfig?.provider ?? null,
      backend: configString(cfg.llmBackend),
      base_url: configString(cfg.llmBaseUrl),
      model: configString(cfg.llmModel),
      max_tokens: typeof cfg.maxTokens === "number" && Number.isFinite(cfg.maxTokens)
        ? cfg.maxTokens
        : null,
      enable_thinking: typeof cfg.enableThinking === "boolean" ? cfg.enableThinking : null,
      api_key_set: Boolean(configString(cfg.llmApiKey)),
      applies_on_restart: true,
    },
  };
}

/** The PUT's allowlisted body keys → the config keys they write. */
const MODEL_PUT_KEYS: Record<string, string> = {
  backend: "llmBackend",
  base_url: "llmBaseUrl",
  model: "llmModel",
  api_key: "llmApiKey",
  max_tokens: "maxTokens",
  enable_thinking: "enableThinking",
};

/** The backends init ever writes (absence of llmBackend + baseUrl+apiKey =
 *  the openai-compat path). "" clears (the modal's "auto" option). */
const MODEL_BACKEND_VALUES = new Set(["", "ollama", "claude-cli"]);

/**
 * The pure PUT handler: validate the allowlisted subset, persist via the
 * injected writer (which THROWS on a malformed config — the adapter maps that
 * to a 500 and the file stays untouched), answer with the fresh GET shape
 * built from the post-write config. `null` REMOVES a config key.
 */
export function handleDashboardModelPut(
  body: unknown,
  persist: (updates: Record<string, unknown>) => Record<string, unknown>,
  getLlmConfig: () => { provider: string } | null,
): { status: number; body: DashboardModelSettings | { error: string } } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { status: 400, body: { error: "Body must be a JSON object of model settings" } };
  }
  const input = body as Record<string, unknown>;

  const updates: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const configKey = MODEL_PUT_KEYS[key];
    if (!configKey) {
      return {
        status: 400,
        body: {
          error: `Unknown key '${key}' — allowed: ${Object.keys(MODEL_PUT_KEYS).join(", ")}`,
        },
      };
    }
    // Per-key validation → a SPECIFIC message (the modal surfaces it in the
    // toast). null is valid everywhere (the clear).
    if (value === null) {
      updates[configKey] = null;
      continue;
    }
    switch (key) {
      case "backend":
        if (typeof value !== "string" || !MODEL_BACKEND_VALUES.has(value)) {
          return {
            status: 400,
            body: { error: `Invalid 'backend' — expected null, "", "ollama" or "claude-cli" (absent + base_url + api_key = OpenAI-compatible)` },
          };
        }
        // "" (the modal's "auto / OpenAI-compatible" option) means NO named
        // backend — normalize to the clear so config.json never carries a
        // vestigial "" key (absence IS the openai-compat path).
        if (value === "") {
          updates[configKey] = null;
          continue;
        }
        break;
      case "base_url": {
        if (typeof value !== "string") {
          return { status: 400, body: { error: "Invalid 'base_url' — expected null or an http(s) URL string" } };
        }
        let url: URL;
        try {
          url = new URL(value);
        } catch {
          return { status: 400, body: { error: `Invalid 'base_url' — "${value}" does not parse as a URL` } };
        }
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          return { status: 400, body: { error: `Invalid 'base_url' — protocol must be http(s), got "${url.protocol}"` } };
        }
        break;
      }
      case "model":
        if (typeof value !== "string" || value.trim().length === 0) {
          return { status: 400, body: { error: "Invalid 'model' — expected null or a non-empty string" } };
        }
        break;
      case "api_key":
        // Empty string is a 400, NOT a clear — the classic "pasted nothing"
        // typo guard. Clearing the key entirely is null (deliberate).
        if (typeof value !== "string" || value.length === 0) {
          return { status: 400, body: { error: "Invalid 'api_key' — expected null (clear) or a non-empty string" } };
        }
        break;
      case "max_tokens":
        // Strict integer ≥ 1 — floats and numeric strings are rejected so the
        // config never carries a value the runtime would have to re-coerce.
        if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
          return { status: 400, body: { error: "Invalid 'max_tokens' — expected null or an integer ≥ 1" } };
        }
        break;
      case "enable_thinking":
        // Strict boolean — "false" (string) is the JSON-encoder artifact this
        // catches; null clears back to the default.
        if (typeof value !== "boolean") {
          return { status: 400, body: { error: "Invalid 'enable_thinking' — expected null or a boolean" } };
        }
        break;
    }
    updates[configKey] = value;
  }

  // persist THROWS on a malformed config (strict load) — propagated to the
  // adapter → 500, file untouched. On success it returns the fresh config.
  const fresh = persist(updates);
  return handleDashboardModelGet(fresh, getLlmConfig());
}

/**
 * Express adapter for GET /dashboard/model. Bearer-only by construction
 * (mounted after createAuthMiddleware — NO exemption, unlike the page shells:
 * this carries install config). Failures surface as a 500 {error}.
 */
export function dashboardModelGetHandler(
  getConfig: () => Record<string, unknown> | null | undefined,
  getLlmConfig: () => { provider: string } | null,
): express.RequestHandler {
  return (_req, res) => {
    try {
      const { status, body } = handleDashboardModelGet(getConfig(), getLlmConfig());
      res.status(status).json(body);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  };
}

/**
 * Express adapter for PUT /dashboard/model. Same auth posture as the GET.
 * The injected persist closure owns the config path (the server passes
 * init.ts persistConfigUpdates over stateDir/config.json); its load/persist
 * failures (malformed config, unwritable file) map to a 500 {error} with the
 * file left untouched — never a silent partial write.
 */
export function dashboardModelPutHandler(
  persist: (updates: Record<string, unknown>) => Record<string, unknown>,
  getLlmConfig: () => { provider: string } | null,
): express.RequestHandler {
  return (req, res) => {
    try {
      const { status, body } = handleDashboardModelPut(req.body ?? null, persist, getLlmConfig);
      res.status(status).json(body);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  };
}

// ---------------------------------------------------------------------------
// PUT /dashboard/capture-pause — the console's pause/resume toggle (#423
// phase 3, D3). Same layering as the model PUT: a pure validation handler +
// an injected setter closure (the live adapter wires setCapturePause over
// the daemon's db), so the route stays thin and the logic is unit-testable.
// ---------------------------------------------------------------------------

/** The PUT's body: {machine?: string|null, harness: string, paused: boolean}. */
export function handleDashboardCapturePausePut(
  body: unknown,
  setPause: (machine: string, harness: string, paused: boolean) => string | null,
): { status: number; body: Record<string, unknown> } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { status: 400, body: { error: "Body must be a JSON object {harness, paused, machine?}" } };
  }
  const { machine, harness, paused } = body as Record<string, unknown>;

  // harness: the bundle's harness half, as the /distill pause key derives it.
  // Not trimmed — the key must match the traffic byte-for-byte; the console
  // derives it from already-normalized ids.
  if (typeof harness !== "string" || harness.length === 0 || harness.length > 128) {
    return { status: 400, body: { error: "Invalid 'harness' — expected a non-empty string of at most 128 chars" } };
  }
  // machine: null/undefined/"" → the unstamped bundle (''); any other value
  // must be a non-empty string ≤128 (never a number/object from a bad caller).
  let machineKey: string;
  if (machine === null || machine === undefined || machine === "") {
    machineKey = "";
  } else if (typeof machine === "string" && machine.length > 0 && machine.length <= 128) {
    machineKey = machine;
  } else {
    return { status: 400, body: { error: "Invalid 'machine' — expected null, \"\", or a non-empty string of at most 128 chars" } };
  }
  // Strict boolean — "false" (string) is the JSON-encoder artifact this
  // catches; there is no clear/null form of a two-state toggle.
  if (typeof paused !== "boolean") {
    return { status: 400, body: { error: "Invalid 'paused' — expected a boolean" } };
  }

  const pausedAt = setPause(machineKey, harness, paused);
  return { status: 200, body: { machine: machineKey, harness, paused, paused_at: pausedAt } };
}

/**
 * Express adapter for PUT /dashboard/capture-pause. Bearer-only by
 * construction (mounted after createAuthMiddleware, no shell exemption).
 * The effect is immediate — no restart: the /distill handler reads the
 * pause table on every post, so the very next capture POST from the bundle
 * is skipped (200) or captured as before.
 */
export function dashboardCapturePausePutHandler(
  getDb: () => Database.Database,
): express.RequestHandler {
  return (req, res) => {
    try {
      const { status, body } = handleDashboardCapturePausePut(
        req.body ?? null,
        (machine, harness, paused) => setCapturePause(getDb(), machine, harness, paused),
      );
      res.status(status).json(body);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  };
}
