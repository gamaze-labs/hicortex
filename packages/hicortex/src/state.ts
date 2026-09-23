/**
 * Centralized state management — single ~/.hicortex/state.json file.
 *
 * Replaces 4 separate state files used by previous versions:
 *   - nightly-last-run.txt   → state.lastNightly
 *   - last-consolidated.txt  → state.lastConsolidated
 *   - tier.json              → state.tier
 *   - license-validated.txt  → state.tier.validatedAt (subsumed)
 *
 * Why one file:
 *   - Atomic writes (write to temp + rename)
 *   - Easier debugging (one file to inspect)
 *   - No filesystem chatter from multiple separate writes
 *   - Single migration path going forward
 *
 * Note: ~/.hicortex/config.json is intentionally NOT merged here. Config is
 * user-edited and tracked separately from machine state.
 */

import { hicortexHome } from "./paths.js";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
  renameSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { LicenseInfo, ModuleIndex, ResolutionBandStat } from "./types.js";

const HICORTEX_HOME = hicortexHome();
const STATE_FILE = "state.json";

/** Persisted tier information — reflects the last successful validation. */
export interface PersistedTier {
  /** Tier name from the validation API response. */
  tier: LicenseInfo["tier"];
  /** ISO timestamp of when this tier was validated against the API. */
  validatedAt: string;
  /** Cached features object — used by features.ts and offline fallback. */
  features: LicenseInfo["features"];
}

export interface HicortexState {
  /** ISO timestamp of the last nightly transcript scan watermark. */
  lastNightly?: string;
  /** ISO timestamp of the last consolidation pipeline run. */
  lastConsolidated?: string;
  /** Last-known license tier (replaces tier.json + license-validated.txt). */
  tier?: PersistedTier;
  /** Anonymous telemetry UUID — generated once, never linked to personal info. */
  telemetryId?: string;
  /** Cached MODULE_INDEX from domain curation (generated during consolidation). */
  moduleIndex?: ModuleIndex;
  /**
   * Resume cursor for `hicortex relink` — highest memories.rowid whose batch
   * has been fully committed. Absent/0 = never run (or reset). Cleared is not
   * required on completion; a finished run simply leaves the cursor at the
   * max rowid processed.
   */
  relinkCursor?: number;
  /**
   * Resume cursor for `hicortex classify-domains` — highest memories.rowid
   * whose batch has been fully committed. Absent/0 = never run (or reset).
   * Same discipline as relinkCursor.
   */
  domainCursor?: number;
  /**
   * #206-B: the retired supersession stage's cursor key
   * (`supersessionCursor`) is deliberately NOT modeled here anymore. The
   * stage (3.7, #191 Phase B) is retired into the reconsolidation pass, the
   * whole-corpus backfill was complete before retirement, and nothing reads
   * the key — pre-#206-B installs keep their stale value on disk, left to
   * rot unread (no migration, no deletion). Do not repurpose the name.
   */
  /**
   * Resume cursor for the nightly's reconsolidation stage (#384) — highest
   * memories.rowid whose candidates have been evaluated (or infra-skipped)
   * with all their CONFIRMED work applied. Absent/0 = never run. Same
   * advance-past-considered-candidates discipline (formerly the retired
   * supersessionCursor's),
   * with one addition (#439): confirmed merges and rewrite groups apply at
   * the candidate boundary — the END of the iteration that confirmed them —
   * and the cursor advances past a candidate only when that apply landed.
   * A deferral (budget refusal at the rewrite call, deadline at the
   * boundary, backup failure, lock-busy merge surviving the final drain)
   * holds the cursor BELOW the current candidate, so the hold is bounded to
   * ONE candidate's pairs: next run re-detects and re-judges exactly those
   * (dup-over-loss — a confirmed resolution is never silently dropped by the
   * cursor passing it). The ONE cross-candidate window is the lock-busy
   * retry list (plus deadline/backup-dropped tails re-queued at their
   * boundary): while any retry merge is pending, every persisted checkpoint
   * clamps below its earliest contributor, so a killed or stopped run can
   * never strand a confirmed merge behind the cursor (fix round, #440).
   */
  reconsolidationCursor?: number;
  /**
   * #439 scan high-water for the reconsolidation stage — the highest
   * memories.rowid any run has ENTERED, never held back by un-applied work
   * (unlike reconsolidationCursor, which holds below deferred applies).
   * Seeds the re-judged/new verdict split: a verdict call on a candidate
   * at/below this mark is a re-judgment of previously judged work. Absent =
   * never run; persisted alongside the cursor at every checkpoint.
   */
  reconsolidationScannedRowid?: number;
  /**
   * Resume cursor for `hicortex classify-types` (#216) — highest memories.rowid
   * whose batch has been fully committed. Absent/0 = never run (or reset).
   * Same discipline as domainCursor: advances per committed batch so an
   * interruption never loses more than the in-flight batch.
   */
  typeCursor?: number;
  /**
   * Resume cursor for `hicortex rescore-importance` (#425) — highest live
   * memories.rowid re-judged under the current rubric. Absent/0 = never run
   * (or reset). Advances per committed batch (LLM calls are 10 rows each
   * inside a `--batch` slice); an infra error holds it at the last fully
   * committed slice so a re-run resumes cleanly.
   */
  rescoreImportanceCursor?: number;
  /**
   * LLM token usage accrued this billing period (#246). Period reset is
   * monthly: when `periodStart` is in a previous calendar month, the totals
   * reset to 0 + a new periodStart (handled in nightly.ts after each run).
   * The fair-use cap (`config.llmTokensPerMonth`) consults `.total` before
   * each consolidation to throttle when over budget. Absent = no usage
   * recorded yet (treated as 0 by the throttle).
   */
  llmTokensThisPeriod?: {
    prompt: number;
    completion: number;
    total: number;
    /** ISO timestamp of the start of the current accrual period. */
    periodStart: string;
  };
  /**
   * Total tokens consumed by the previous nightly's consolidation (#246).
   * Used as the ESTIMATE for the next run's fair-use check (this-period total
   * + last-run total > cap → throttle). 0/absent on the first metered run,
   * which means the first run is never throttled (correct: no baseline yet).
   */
  llmTokensLastRun?: number;
  /**
   * Cumulative per-band verdict statistics for the unified resolution pass
   * (#392), keyed by cosine band label ("0.75-0.8", …, ">=0.92" — labels
   * derive from the live floor/ceiling at write time). Accumulated across
   * runs, never reset: labeled calibration evidence for moving the
   * floor/ceiling boundaries later. The deterministic zone persists its own
   * band; the reconsolidation stage persists the judged bands. Never written
   * on dry runs. The per-run snapshot lives in the stage report
   * (`stages.reconsolidation.band_stats`).
   */
  resolutionBandStats?: Record<string, ResolutionBandStat>;
}

/**
 * Load the state file. Returns an empty state if the file is missing
 * or corrupted (callers should handle missing fields with defaults).
 */
export function loadState(stateDir: string = HICORTEX_HOME): HicortexState {
  const path = join(stateDir, STATE_FILE);
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as HicortexState;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Atomically write the state file. Uses write-to-temp + rename so a crash
 * during write cannot leave a half-written state.json on disk.
 */
export function saveState(
  state: HicortexState,
  stateDir: string = HICORTEX_HOME,
): void {
  try {
    mkdirSync(stateDir, { recursive: true });
    const path = join(stateDir, STATE_FILE);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, path);
  } catch (err) {
    console.warn(
      `[hicortex] Failed to save state: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Read-modify-write helper. The updater receives the current state and
 * returns the next state (or void if it mutates in place).
 */
export function updateState(
  updater: (state: HicortexState) => HicortexState | void,
  stateDir: string = HICORTEX_HOME,
): HicortexState {
  const current = loadState(stateDir);
  const result = updater(current);
  const next = result ?? current;
  saveState(next, stateDir);
  return next;
}

// ---------------------------------------------------------------------------
// One-time legacy migration
// ---------------------------------------------------------------------------

const LEGACY_FILES = [
  "nightly-last-run.txt",
  "last-consolidated.txt",
  "license-validated.txt",
  "tier.json",
] as const;

/**
 * One-time migration from the 4 legacy state files to state.json.
 *
 * Behaviour:
 *   1. If state.json already exists, do nothing (and clean up any leftover
 *      legacy files from a previously interrupted migration).
 *   2. Otherwise, read whichever legacy files exist, build a HicortexState,
 *      write state.json, and delete the legacy files.
 *
 * Idempotent: safe to call on every boot.
 * Returns true if migration ran, false if state.json already existed.
 */
export function migrateLegacyState(stateDir: string = HICORTEX_HOME): boolean {
  const statePath = join(stateDir, STATE_FILE);

  if (existsSync(statePath)) {
    cleanupLegacyFiles(stateDir);
    return false;
  }

  const state: HicortexState = {};
  let foundAny = false;

  // 1. nightly-last-run.txt → state.lastNightly
  const ln = readLegacyText(stateDir, "nightly-last-run.txt");
  if (ln) {
    state.lastNightly = ln;
    foundAny = true;
  }

  // 2. last-consolidated.txt → state.lastConsolidated
  const lc = readLegacyText(stateDir, "last-consolidated.txt");
  if (lc) {
    state.lastConsolidated = lc;
    foundAny = true;
  }

  // 3. tier.json → state.tier (full object)
  const tierRaw = readLegacyText(stateDir, "tier.json");
  if (tierRaw) {
    try {
      state.tier = JSON.parse(tierRaw) as PersistedTier;
      foundAny = true;
    } catch {
      // Corrupted tier.json — ignore
    }
  }

  // 4. license-validated.txt → state.tier.validatedAt (only if no tier yet)
  //    (subsumed by tier.json when it exists)
  if (!state.tier) {
    const lv = readLegacyText(stateDir, "license-validated.txt");
    if (lv) {
      // We have a validation timestamp but no tier object — preserve as
      // a placeholder so offline grace can still work. The features module
      // will re-validate on next boot to get the full features back.
      // We deliberately don't fabricate features here.
      foundAny = true;
    }
  }

  if (foundAny) {
    saveState(state, stateDir);
    cleanupLegacyFiles(stateDir);
    console.log("[hicortex] Migrated legacy state files to ~/.hicortex/state.json");
    return true;
  }

  return false;
}

const STALE_THRESHOLD_HOURS = 30;

export interface LastNightlyInfo {
  /** Raw timestamp string as stored. */
  timestamp: string;
  /** True when the stored value is not a parseable date. */
  invalid: boolean;
  ageHours?: number;
  /** Human age, e.g. "just now", "5h ago", "2d ago". */
  ageStr?: string;
  /** True when older than the missed-a-night threshold (30h). */
  stale?: boolean;
}

/**
 * Last nightly run for status display, shared by `hicortex status` and
 * `hicortex nightly --status`. Read-only: prefers state.json but falls
 * back to the pre-migration nightly-last-run.txt so upgraded installs
 * report correctly before their first nightly performs the migration.
 * Returns null when no run has ever been recorded.
 */
export function describeLastNightly(
  stateDir: string = HICORTEX_HOME,
): LastNightlyInfo | null {
  const ts =
    loadState(stateDir).lastNightly ??
    readLegacyText(stateDir, "nightly-last-run.txt");
  if (!ts) return null;
  const d = new Date(ts);
  if (isNaN(d.getTime())) return { timestamp: ts, invalid: true };
  const ageHours = Math.round((Date.now() - d.getTime()) / (60 * 60 * 1000));
  const ageStr =
    ageHours < 1 ? "just now" :
    ageHours < 24 ? `${ageHours}h ago` :
    `${Math.round(ageHours / 24)}d ago`;
  return {
    timestamp: ts,
    invalid: false,
    ageHours,
    ageStr,
    stale: ageHours > STALE_THRESHOLD_HOURS,
  };
}

function readLegacyText(stateDir: string, name: string): string | null {
  try {
    const raw = readFileSync(join(stateDir, name), "utf-8").trim();
    return raw || null;
  } catch {
    return null;
  }
}

function cleanupLegacyFiles(stateDir: string): void {
  for (const name of LEGACY_FILES) {
    try {
      unlinkSync(join(stateDir, name));
    } catch {
      // File didn't exist — fine
    }
  }
}
