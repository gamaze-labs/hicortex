/**
 * `hicortex sweep-volatile` (#489, deliverable iii — owner decision 3).
 *
 * The ONE-SHOT store sweep: the live corpus already holds the GH-status /
 * version-bump rows gold set A adjudicated ("not healthy to have GH in mem").
 * This command reuses the SAME deterministic gate the distill path applies
 * (distiller.ts isVolatileStatusEntry — one gate, one meaning) over the stored
 * corpus. Mirrors `dedup`:
 *
 *   - DRY RUN by default: report candidates only, zero writes.
 *   - `--apply` is explicit and ordered capture-lock (fail fast) →
 *     pre-sweep backup (abort ALL writes if it fails) → one transaction.
 *   - NO hard deletes: swept rows are DEMOTED via storage.absorbMemory —
 *     status 'absorbed' (recall-invisible everywhere: vector + FTS rows
 *     dropped, and every read path already handles the state), plain row +
 *     links retained as evidence. Recovery posture = the dedup posture: the
 *     pre-sweep backup IS the rollback. The shared absorb primitive means no
 *     new status vocabulary to thread through candidate paths.
 *   - Tags cleared + domain NULL'd before absorb (dedup's rule: an absorbed
 *     row must not count in moduleIndex/tag recomputes).
 *   - Audit trail: one `volatile_sweep_log` row per swept memory (migration
 *     v23) — inspectable forever, never silent. No runtime consumer; the
 *     CAPTURE-side volatility gate is the re-ingest safety net.
 *
 * Server-mode only (needs the local DB), like dedup/relink/classify-domains.
 */

import { hicortexHome } from "./paths.js";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { initDb, resolveDbPath } from "./db.js";
import * as storage from "./storage.js";
import { isVolatileStatusEntry } from "./distiller.js";
import { acquireCaptureLock } from "./capture.js";
import { readNonNegativeConfig } from "./config-read.js";
import { VOLATILE_STATUS_FILTER } from "./calibration.js";
import { DEFAULT_BACKUP_RETENTION, pruneBackupArtifacts } from "./backup.js";

const HICORTEX_HOME = hicortexHome();

/** Pre-sweep backup filename pattern — scoped retention (like pre-dedup). */
const PRE_SWEEP_BACKUP_PATTERN = /^pre-sweep-volatile-.*\.db$/;

function readConfig(stateDir: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(join(stateDir, "config.json"), "utf-8"));
  } catch {
    return null;
  }
}

export interface SweepVolatileOptions {
  /** Execute the sweep. Default false = dry run (report only, zero writes). */
  apply?: boolean;
  /** DB path override (tests / manual snapshot verification). */
  dbPath?: string;
  /** State dir override (tests). Defaults to ~/.hicortex. Backup lands under
   *  here/backups/. */
  stateDir?: string;
  /** Config override (tests). Defaults to reading stateDir/config.json. */
  config?: Record<string, unknown> | null;
  /** Capture-lock acquirer override (tests). Defaults to capture.ts's lock. */
  acquireLock?: typeof acquireCaptureLock;
}

export interface SweepVolatileReport {
  dryRun: boolean;
  /** Live rows the gate flags, in store order. Empty when the kill-switch is
   *  off (the sweep is inert without the gate — same release-managed switch,
   *  one meaning). */
  candidates: Array<{ id: string; preview: string }>;
  /** --apply only: rows actually swept (absorbed). */
  swept?: number;
  /** --apply only: path to the pre-sweep backup. */
  backupPath?: string;
}

/** Live-row filter: active or content-rewritten rows only. Already-retired
 *  states are not candidates — 'absorbed' is invisible already; 'superseded'
 *  / 'retracted' are demoted already. */
const LIVE_ROW_WHERE = `COALESCE(status, '') NOT IN ('absorbed', 'superseded', 'retracted')`;

/**
 * Pre-sweep DB backup to <stateDir>/backups/pre-sweep-volatile-<ISO>.db,
 * pruned to `backupRetention` newest (pattern-scoped, like pre-dedup).
 * THROWS on failure — runSweepVolatile aborts the whole sweep when it does.
 */
async function takePreSweepBackup(
  db: Database.Database,
  stateDir: string,
  config?: Record<string, unknown> | null,
): Promise<string> {
  const backupDir = join(stateDir, "backups");
  mkdirSync(backupDir, { recursive: true });
  const backupPath = join(
    backupDir,
    `pre-sweep-volatile-${new Date().toISOString().replace(/[:.]/g, "-")}.db`,
  );
  await db.backup(backupPath);
  const retention = readNonNegativeConfig(config ?? {}, "backupRetention", DEFAULT_BACKUP_RETENTION);
  pruneBackupArtifacts(backupDir, retention, PRE_SWEEP_BACKUP_PATTERN);
  return backupPath;
}

export async function runSweepVolatile(
  options: SweepVolatileOptions = {},
): Promise<SweepVolatileReport> {
  const stateDir = options.stateDir ?? HICORTEX_HOME;
  const config = options.config !== undefined ? options.config : readConfig(stateDir);

  // Server-mode only — client installs have no local DB.
  if (config?.mode === "client") {
    throw new Error(
      "[hicortex] sweep-volatile is server-mode only (it needs the local DB). " +
        `This machine is a client of ${config.serverUrl ?? "a remote server"} — run sweep-volatile on the server.`,
    );
  }

  const apply = options.apply ?? false;
  const dbPath = resolveDbPath(options.dbPath);
  const db = initDb(dbPath);

  try {
    console.log(
      `[hicortex] sweep-volatile starting (${apply ? "APPLY" : "dry-run"}): db ${dbPath}`,
    );

    const rows = db
      .prepare(`SELECT id, content FROM memories WHERE ${LIVE_ROW_WHERE}`)
      .all() as Array<{ id: string; content: string }>;
    const candidates = VOLATILE_STATUS_FILTER
      ? rows
          .filter((r) => isVolatileStatusEntry(r.content))
          .map((r) => ({ id: r.id, preview: r.content.slice(0, 120) }))
      : [];
    if (!VOLATILE_STATUS_FILTER) {
      console.warn(
        "[hicortex] sweep-volatile: the volatility gate is switched off in this release (VOLATILE_STATUS_FILTER) — nothing to sweep.",
      );
    }

    const report: SweepVolatileReport = { dryRun: !apply, candidates };
    console.log(
      `[hicortex] sweep-volatile: ${candidates.length} volatile row(s) among ${rows.length} live (` +
        `${apply ? "demoting via absorb" : "dry run — zero writes"})`,
    );

    if (!apply) {
      for (const c of candidates) {
        console.log(`[hicortex]   ${c.id.slice(0, 8)}: "${c.preview}"`);
      }
      if (candidates.length === 0) console.log("[hicortex]   (nothing matched the gate)");
      return report;
    }

    if (candidates.length === 0) return report;

    // --apply: fail fast on a busy capture lock — the audit rows and absorb
    // writes must not race a nightly/capture run (dedup posture).
    const acquireLock = options.acquireLock ?? acquireCaptureLock;
    const releaseLock = await acquireLock(stateDir, 0);
    if (!releaseLock) {
      throw new Error(
        "[hicortex] sweep-volatile --apply aborted: another capture/nightly run holds the lock. Retry when it finishes.",
      );
    }

    try {
      // Backup FIRST — abort entirely (no writes attempted) if it fails.
      let backupPath: string;
      try {
        backupPath = await takePreSweepBackup(db, stateDir, config);
      } catch (err) {
        throw new Error(
          `[hicortex] sweep-volatile --apply aborted: backup failed (${err instanceof Error ? err.message : String(err)}). No rows swept.`,
        );
      }
      console.log(`[hicortex] Backup written: ${backupPath}`);
      report.backupPath = backupPath;

      // ONE transaction: audit row + tag/domain clear + absorb per row. Any
      // failure rolls back the whole sweep (all-or-nothing, like /distill's
      // insert phase) — a partial sweep is never left behind.
      const sweep = db.transaction(() => {
        const clearTags = db.prepare("DELETE FROM memory_tags WHERE memory_id = ?");
        const audit = db.prepare(
          "INSERT OR REPLACE INTO volatile_sweep_log (memory_id, swept_at, preview) VALUES (?, ?, ?)",
        );
        const now = new Date().toISOString();
        for (const c of candidates) {
          audit.run(c.id, now, c.preview);
          clearTags.run(c.id);
          storage.updateMemory(db, c.id, { domain: null });
          storage.absorbMemory(db, c.id);
        }
      });
      sweep();

      report.swept = candidates.length;
      console.log(
        `[hicortex] sweep-volatile: swept (absorbed) ${report.swept} row(s); ` +
          `rollback = restore ${backupPath}`,
      );
      return report;
    } finally {
      releaseLock();
    }
  } finally {
    db.close();
  }
}
