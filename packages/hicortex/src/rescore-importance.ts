/**
 * `hicortex rescore-importance` (#425) — the one-shot LLM backfill that
 * re-judges the EXISTING corpus under the re-anchored importance rubric
 * (owner decision D1, 2026-09-13: rescore via LLM, resumable, local
 * gateway).
 *
 * Precedents, deliberately mixed per the issue's attribution:
 *   - classify-domains (src/classify-domains.ts): resumable rowid cursor in
 *     state.json, --batch rows per invocation, --reset, server-mode-only,
 *     infra-error abort that leaves the cursor at the last committed batch.
 *   - dedup (src/dedup.ts): dry-run DEFAULT with --apply, and a DB backup
 *     taken FIRST — the CLI aborts (nothing written) if the backup fails.
 *
 * The scoring itself is the SHARED production loop — consolidate.ts
 * `scoreMemoriesImportance` (the extracted stageImportance core): batches of
 * 10, serial calls, the 0.95 write cap and the importance_scored_at
 * watermark identical to the nightly. No forked scoring code.
 *
 * Scope: every LIVE (non-absorbed) memory, rowid-ascending. A row's
 * corroboration_count survives untouched; base_strength is re-judged (that
 * is D1's explicit trade: one rubric for all rows, the 2026-08-21-validated
 * ORDERING is re-derived rather than mapped).
 */

import { readFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";

import { hicortexHome } from "./paths.js";
import { initDb, resolveDbPath } from "./db.js";
import { loadState, updateState } from "./state.js";
import { scoreMemoriesImportance } from "./consolidate.js";
import {
  LlmClient,
  resolveSavedLlmConfig,
} from "./llm.js";
import { DEFAULT_BACKUP_RETENTION, pruneBackupArtifacts } from "./backup.js";
import { readNonNegativeConfig } from "./config-read.js";
import { IMPORTANCE_CEILING } from "./calibration.js";

const HICORTEX_HOME = hicortexHome();

/** Rows per invocation chunk (LLM calls are 10 rows each inside a chunk). */
const DEFAULT_BATCH = 500;
/** The scoring loop's fixed 10-per-call slice (mirrors stageImportance). */
const LLM_SLICE = 10;
const PRE_RESCORE_BACKUP_PATTERN = /^pre-rescore-.*\.db$/;

export interface RescoreImportanceOptions {
  /** Execute (default: dry run — report only, zero writes, no backup). */
  apply?: boolean;
  /** Rows per invocation chunk (default 500). */
  batchSize?: number;
  /** Ignore the saved cursor and restart from rowid 0. */
  reset?: boolean;
  /** DB path override (tests). Defaults to resolveDbPath(). */
  dbPath?: string;
  /** State dir override (tests). Defaults to ~/.hicortex. */
  stateDir?: string;
  /** LLM override (tests). Bypasses config resolution. */
  llm?: LlmClient;
  /** Config override (tests). Defaults to reading stateDir/config.json. */
  config?: Record<string, unknown> | null;
}

export interface RescoreImportanceReport {
  /** True when this invocation was a dry run (zero writes). */
  dryRun: boolean;
  /** Live rows remaining to process AFTER this invocation (whole corpus minus cursor). */
  remaining: number;
  /** Rows this invocation re-judged (0 on a dry run). */
  rescored: number;
  /** Rows whose scoring call failed (endpoint down / unusable) — untouched. */
  failed: number;
  /** LLM calls made (10 rows each). */
  calls: number;
  /** Cursor after this invocation. */
  cursor: number;
  /** True when the run stopped early on an infra error (cursor holds). */
  aborted: boolean;
  /** Path to the pre-run DB backup (apply mode only). */
  backupPath?: string;
  /** CURRENT base_strength percentiles over the remaining rows (preview). */
  currentDistribution: DistributionPreview;
  /** For apply runs over rows that were actually re-judged: before → after. */
  before?: DistributionPreview;
  after?: DistributionPreview;
}

export interface DistributionPreview {
  n: number;
  min: number;
  p25: number;
  median: number;
  p75: number;
  p90: number;
  max: number;
  atCeiling: number;
  atSentinel: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function distributionPreview(values: number[]): DistributionPreview {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: values.length,
    min: percentile(sorted, 0),
    p25: percentile(sorted, 25),
    median: percentile(sorted, 50),
    p75: percentile(sorted, 75),
    p90: percentile(sorted, 90),
    max: percentile(sorted, 100),
    atCeiling: values.filter((v) => v >= IMPORTANCE_CEILING).length,
    atSentinel: values.filter((v) => v === 0.5).length,
  };
}

function readConfig(stateDir: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(join(stateDir, "config.json"), "utf-8"));
  } catch {
    return null;
  }
}

interface LiveRow {
  __rowid: number;
  id: string;
  base_strength: number;
}

function fetchChunk(db: Database.Database, cursor: number, limit: number): LiveRow[] {
  return db
    .prepare(
      `SELECT rowid AS __rowid, id, base_strength FROM memories
       WHERE rowid > ? AND COALESCE(status, '') != 'absorbed'
       ORDER BY rowid ASC LIMIT ?`
    )
    .all(cursor, limit) as LiveRow[];
}

function countRemaining(db: Database.Database, cursor: number): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM memories
         WHERE rowid > ? AND COALESCE(status, '') != 'absorbed'`
      )
      .get(cursor) as { n: number }
  ).n;
}

/** Full Memory rows for the ids in `rows` (the scoring loop's input type). */
function memoriesForIds(db: Database.Database, rows: LiveRow[]) {
  const byId = new Map(
    rows.map((r) => {
      const mem = db
        .prepare("SELECT * FROM memories WHERE id = ?")
        .get(r.id) as Record<string, unknown>;
      return [r.id, mem];
    })
  );
  return rows.map((r) => byId.get(r.id)).filter((m) => m !== undefined) as never[];
}

/** Pre-run DB backup (the dedup precedent): throws on failure — abort. */
async function takePreRescoreBackup(
  db: Database.Database,
  stateDir: string,
  config?: Record<string, unknown> | null
): Promise<string> {
  const backupDir = join(stateDir, "backups");
  mkdirSync(backupDir, { recursive: true });
  const backupPath = join(
    backupDir,
    `pre-rescore-${new Date().toISOString().replace(/[:.]/g, "-")}.db`
  );
  await db.backup(backupPath);
  const retention = readNonNegativeConfig(config ?? {}, "backupRetention", DEFAULT_BACKUP_RETENTION);
  pruneBackupArtifacts(backupDir, retention, PRE_RESCORE_BACKUP_PATTERN);
  return backupPath;
}

/**
 * Run the rescore pass. Returns a structured report. Throws on setup errors
 * (client mode, no LLM, backup failure) — the cursor always reflects the
 * last committed batch.
 */
export async function runRescoreImportance(
  options: RescoreImportanceOptions = {}
): Promise<RescoreImportanceReport> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH;
  const stateDir = options.stateDir ?? HICORTEX_HOME;
  const apply = options.apply ?? false;

  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error(`[hicortex] rescore-importance: invalid --batch value: ${options.batchSize}`);
  }

  const config = options.config !== undefined ? options.config : readConfig(stateDir);

  // Server-mode only — client installs have no local DB (classify-domains).
  if (config?.mode === "client") {
    throw new Error(
      "[hicortex] rescore-importance is server-mode only (it needs the local DB). " +
        `This machine is a client of ${config.serverUrl ?? "a remote server"} — run it on the server.`,
    );
  }

  let llm: LlmClient;
  if (options.llm) {
    llm = options.llm;
  } else {
    const resolved = resolveSavedLlmConfig(config);
    if (!resolved.config) {
      throw new Error(
        "[hicortex] rescore-importance: no LLM configured — run `npx @gamaze/hicortex init`.",
      );
    }
    llm = new LlmClient(resolved.config);
  }

  const dbPath = resolveDbPath(options.dbPath);
  const db = initDb(dbPath);

  try {
    let cursor = options.reset ? 0 : (loadState(stateDir).rescoreImportanceCursor ?? 0);
    const remaining = countRemaining(db, cursor);
    const plannedCalls = Math.ceil(Math.min(remaining, batchSize) / LLM_SLICE);

    // Current distribution preview over the REMAINING rows (what is queued).
    const remainingRows = fetchChunk(db, cursor, Number.MAX_SAFE_INTEGER);
    const currentDistribution = distributionPreview(
      remainingRows.map((r) => r.base_strength ?? 0.5)
    );

    console.log(
      `[hicortex] rescore-importance ${apply ? "APPLY" : "dry run"}: ${remaining} live rows queued, ` +
        `batch ${batchSize}, cursor ${cursor}${options.reset ? " (reset)" : ""}, ` +
        `~${plannedCalls} LLM calls this invocation (10 rows each)`
    );
    console.log(
      `[hicortex]   current base_strength of queued rows: median ${currentDistribution.median.toFixed(2)}, ` +
        `p90 ${currentDistribution.p90.toFixed(2)}, max ${currentDistribution.max.toFixed(2)}, ` +
        `at ceiling ${currentDistribution.atCeiling}, at 0.5 sentinel ${currentDistribution.atSentinel}`
    );

    if (!apply) {
      console.log(
        "[hicortex] rescore-importance dry run complete — zero writes. Re-run with --apply to execute."
      );
      return {
        dryRun: true,
        remaining,
        rescored: 0,
        failed: 0,
        calls: 0,
        cursor,
        aborted: false,
        currentDistribution,
      };
    }

    // Backup FIRST (dedup precedent) — abort with zero writes if it fails.
    const backupPath = await takePreRescoreBackup(db, stateDir, config);
    console.log(`[hicortex] rescore-importance backup written: ${backupPath}`);

    const chunk = fetchChunk(db, cursor, batchSize);
    const before = distributionPreview(chunk.map((r) => r.base_strength ?? 0.5));

    let rescored = 0;
    let failed = 0;
    let calls = 0;
    let committedRowid = cursor;
    let aborted = false;
    const touchedIds: string[] = [];

    // LLM slices of 10 INSIDE the invocation chunk, cursor-ordered: an infra
    // error holds the cursor at the last fully committed slice (the
    // classify-domains posture — the failing rows are untouched, re-run
    // resumes there).
    for (let i = 0; i < chunk.length; i += LLM_SLICE) {
      const sliceRows = chunk.slice(i, i + LLM_SLICE);
      const memories = memoriesForIds(db, sliceRows);
      const r = await scoreMemoriesImportance(db, memories, llm, {
        onBatch: (written, batchFailed) => {
          calls++;
        },
      });
      if (r.failed > 0) {
        // The slice's call threw (endpoint down) or a write failed — nothing
        // usable came out of it. Stop; the cursor stays at the last
        // committed slice's end.
        failed += r.failed;
        aborted = true;
        console.warn(
          `[hicortex] rescore-importance ABORTED on a scoring-endpoint error ` +
            `(slice at rowid ${sliceRows[0].__rowid}). Cursor at last committed slice — ` +
            `re-run when the endpoint is back up.`
        );
        break;
      }
      rescored += r.scored;
      touchedIds.push(...sliceRows.map((row) => row.id));
      committedRowid = sliceRows[sliceRows.length - 1].__rowid;
      updateState((s) => { s.rescoreImportanceCursor = committedRowid; }, stateDir);
      if ((i / LLM_SLICE) % 25 === 0) {
        console.log(
          `[hicortex]   ${rescored} rows re-judged (cursor ${committedRowid}, ` +
            `${countRemaining(db, committedRowid)} remaining)`
        );
      }
    }
    cursor = committedRowid;

    // before → after over the rows this invocation actually touched.
    const afterRows = touchedIds
      .map((id) =>
        db
          .prepare("SELECT base_strength FROM memories WHERE id = ?")
          .get(id) as { base_strength: number } | undefined
      )
      .filter((r): r is { base_strength: number } => r !== undefined);
    const after = distributionPreview(afterRows.map((r) => r.base_strength ?? 0.5));

    const afterLog = (label: string, d: DistributionPreview) =>
      `${label}: median ${d.median.toFixed(2)} p90 ${d.p90.toFixed(2)} max ${d.max.toFixed(2)} at-ceiling ${d.atCeiling}`;
    console.log(
      `[hicortex] rescore-importance ${aborted ? "ABORTED" : "chunk complete"}: ` +
        `${rescored} re-judged, ${failed} failed, ${calls} calls, cursor ${cursor}, ` +
        `${countRemaining(db, cursor)} remaining`
    );
    console.log(`[hicortex]   re-judged rows — ${afterLog("before", before)}`);
    console.log(`[hicortex]   re-judged rows — ${afterLog("after ", after)}`);

    return {
      dryRun: false,
      remaining: countRemaining(db, cursor),
      rescored,
      failed,
      calls,
      cursor,
      aborted,
      backupPath,
      currentDistribution,
      before,
      after,
    };
  } finally {
    db.close();
  }
}
