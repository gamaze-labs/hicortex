/**
 * `hicortex reconcile-projects` (#567) — one-shot project-label
 * reconciliation for EXISTING rows.
 *
 * The server canonicalizes every project string at entry (project-
 * canonicalize.ts, wired in mcp-server.ts); this command heals the corpus
 * that predates it: the 5,544-row `hicortex`/`Hicortex` case split and the
 * 14% junk-label share measured in #565 WS1. Dry run by default (report
 * only, zero writes); `--apply` renames along the dedup rails.
 *
 * What a rename is: a pure function of the config alias map + the current
 * labels — canonicalize(label) ≠ label. Same single-hop semantics as the
 * entry-point fold, computed from the ORIGINAL labels BEFORE any write (the
 * per-group `WHERE project = ?` updates are then order-independent). Touches
 * `memories.project` and `distill_queue.project` (the inbox must not
 * re-distill old labels post-rename) and NOTHING else:
 *   - no `memories.domain`, no `memory_tags` — tag-derived, recomputed
 *     nightly; a rename is not a re-classification;
 *   - no `dedup_log`, no new audit table — relabels are not destructive
 *     (dedup needed its log because merges absorb rows; the pre-apply
 *     backup IS the safety net here).
 *
 * Safety rails (the #100 `hicortex dedup` pattern): pre-apply DB backup via
 * takePreDedupBackup (abort all writes on failure) → single-flight capture
 * lock (waitMs 0 — a busy lock aborts, never waits) → ONE transaction per
 * rename group, fail-soft per group. The FTS row syncs automatically: the
 * `memories_fts_update` trigger (db.ts) fires `AFTER UPDATE OF … project`.
 * SQLite's BINARY collation on `memories.project` makes the `WHERE
 * project = ?` match case-sensitive — exactly what a case-split rename
 * needs (`Hicortex` → `hicortex` rewrites only the variant rows).
 *
 * Idempotent by construction: a second run finds every label already
 * canonical and reports zero groups.
 */

import { hicortexHome } from "./paths.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { initDb, resolveDbPath } from "./db.js";
import { acquireCaptureLock } from "./capture.js";
import { takePreDedupBackup } from "./dedup.js";
import { canonicalizeProject, parseProjectAliases } from "./project-canonicalize.js";

const HICORTEX_HOME = hicortexHome();

function readConfig(stateDir: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(join(stateDir, "config.json"), "utf-8"));
  } catch {
    return null;
  }
}

/** One planned rename: every row labeled `from` becomes `to`. */
export interface ReconcileGroup {
  from: string;
  to: string;
  /** Rows in `memories` carrying the old label. */
  memoryRows: number;
  /** Rows in `distill_queue` carrying the old label (re-distilled canonical). */
  queuedRows: number;
}

/**
 * One SURVIVING label after canonicalization, with its post-rename row
 * count (memories) — the junk-curation evidence: every label the alias map
 * does NOT fold is listed so the operator can curate from data, and
 * pure-numeric labels (the version-suffix class, e.g. `3` from
 * `CAB-v0-0-3`) are flagged explicitly.
 */
export interface ReconcileLabel {
  label: string;
  rows: number;
  numeric: boolean;
}

/** --apply outcome counts. */
export interface ReconcileApplied {
  groups: number;
  memories: number;
  queued: number;
  /** Groups whose transaction failed (rolled back; retried on a re-run). */
  failed: number;
}

export interface ReconcileReport {
  dryRun: boolean;
  /** Planned (dry run) or executed (apply) rename groups. */
  groups: ReconcileGroup[];
  /** Post-canonical surviving labels with row counts, numeric ones flagged. */
  labels: ReconcileLabel[];
  /** The pure-numeric surviving labels (the flagged subset of `labels`). */
  numericLabels: string[];
  /** --apply only. */
  applied?: ReconcileApplied;
  /** --apply only: path to the pre-apply backup. */
  backupPath?: string;
  /** --apply only: the capture lock was busy — zero writes, retried later. */
  lockBusy?: boolean;
}

export interface ReconcileOptions {
  /** Execute the renames. Default false = dry run (report only, zero writes). */
  apply?: boolean;
  /** DB path override (tests / snapshot verification). Defaults to resolveDbPath(). */
  dbPath?: string;
  /** State dir override (tests). Defaults to ~/.hicortex. Backups land under <stateDir>/backups/. */
  stateDir?: string;
  /** Config override (tests). Defaults to reading stateDir/config.json. */
  config?: Record<string, unknown> | null;
  /** Capture-lock acquirer override (tests). Defaults to the real capture.ts lock. */
  acquireLock?: typeof acquireCaptureLock;
}

/** Distinct non-blank labels + row counts from one table's project column. */
function readLabels(db: Database.Database, table: "memories" | "distill_queue"): Map<string, number> {
  const rows = db
    .prepare(`SELECT project, COUNT(*) AS c FROM ${table} WHERE project IS NOT NULL AND project != '' GROUP BY project`)
    .all() as Array<{ project: string; c: number }>;
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.project, r.c);
  return out;
}

/**
 * Compute the FULL plan from the ORIGINAL labels, before any write:
 * rename groups (canonical ≠ label) + the post-canonical surviving-label
 * report. A blank/whitespace label canonicalizes to null — not a rename
 * target (blank rows are excluded by the read; they predate this command
 * and carry no identity either way).
 */
function planReconcile(
  db: Database.Database,
  aliases: Readonly<Record<string, string>> | null,
): { groups: ReconcileGroup[]; labels: ReconcileLabel[] } {
  const memoryLabels = readLabels(db, "memories");
  const queuedLabels = readLabels(db, "distill_queue");

  const groups: ReconcileGroup[] = [];
  const canonicalRows = new Map<string, number>();
  for (const [label, rows] of memoryLabels) {
    const canon = canonicalizeProject(label, aliases);
    if (canon !== null) canonicalRows.set(canon, (canonicalRows.get(canon) ?? 0) + rows);
    if (canon !== null && canon !== label) {
      groups.push({ from: label, to: canon, memoryRows: rows, queuedRows: queuedLabels.get(label) ?? 0 });
    }
  }
  // Queue-only labels (memories row already renamed, inbox holds the old
  // label — e.g. a reconcile run between delivery and drain) group too.
  for (const [label, rows] of queuedLabels) {
    const canon = canonicalizeProject(label, aliases);
    if (canon !== null && canon !== label && !memoryLabels.has(label)) {
      groups.push({ from: label, to: canon, memoryRows: 0, queuedRows: rows });
    }
  }
  groups.sort((a, b) => b.memoryRows - a.memoryRows || a.from.localeCompare(b.from));

  const labels: ReconcileLabel[] = [...canonicalRows.entries()]
    .map(([label, rows]) => ({ label, rows, numeric: /^\d+$/.test(label) }))
    .sort((a, b) => b.rows - a.rows || a.label.localeCompare(b.label));
  return { groups, labels };
}

/**
 * Run `hicortex reconcile-projects`. Dry run by default (options.apply
 * falsy) — plan + report only, zero writes. `options.apply` executes:
 * backup, then one transaction per rename group. A busy capture lock is an
 * abort with the dedup wording (reported as `lockBusy: true`, never a
 * wait); a failed backup aborts all writes (throw, like dedup).
 */
export async function runReconcileProjects(options: ReconcileOptions = {}): Promise<ReconcileReport> {
  const stateDir = options.stateDir ?? HICORTEX_HOME;
  const config = options.config !== undefined ? options.config : readConfig(stateDir);
  const aliases = parseProjectAliases(config);

  // Server-mode only — client installs have no local DB.
  if (config?.mode === "client") {
    throw new Error(
      "[hicortex] reconcile-projects is server-mode only (it needs the local DB). " +
        `This machine is a client of ${config.serverUrl ?? "a remote server"} — run reconcile-projects on the server.`,
    );
  }

  const apply = options.apply ?? false;
  const dbPath = resolveDbPath(options.dbPath);
  const db = initDb(dbPath);

  try {
    console.log(
      `[hicortex] reconcile-projects starting (${apply ? "APPLY" : "dry-run"}): db ${dbPath}` +
        (aliases ? `, ${Object.keys(aliases).length} alias(es)` : ", no aliases (mechanical fold only)"),
    );

    const { groups, labels } = planReconcile(db, aliases);
    const numericLabels = labels.filter((l) => l.numeric).map((l) => l.label);
    const report: ReconcileReport = { dryRun: !apply, groups, labels, numericLabels };

    const totalMemories = groups.reduce((s, g) => s + g.memoryRows, 0);
    const totalQueued = groups.reduce((s, g) => s + g.queuedRows, 0);
    console.log(
      `[hicortex] reconcile-projects: ${groups.length} rename group(s), ` +
        `${totalMemories} memory row(s)${totalQueued > 0 ? `, ${totalQueued} queued row(s)` : ""} ` +
        `(${apply ? "applying" : "dry run — zero writes"})`,
    );
    for (const g of groups) {
      console.log(
        `[hicortex]   ${g.from} → ${g.to} (${g.memoryRows} row(s)${g.queuedRows > 0 ? `, ${g.queuedRows} queued` : ""})`,
      );
    }

    // The unmapped-labels report: every SURVIVING post-canonical label with
    // its row count, numerics flagged — the junk-curation evidence.
    console.log(`[hicortex] surviving project labels (post-canonicalization): ${labels.length}`);
    for (const l of labels) {
      console.log(
        `[hicortex]   ${l.label}: ${l.rows} row(s)${l.numeric ? "  [NUMERIC — likely a junk label; consider an alias]" : ""}`,
      );
    }

    if (!apply) return report;

    // --apply: single-flight capture lock (waitMs 0) so a concurrent
    // nightly/capture run cannot race the renames. Busy → abort (reported,
    // never a silent wait — a deliberate manual command is retried by the
    // operator, like dedup).
    const acquireLock = options.acquireLock ?? acquireCaptureLock;
    const releaseLock = await acquireLock(stateDir, 0);
    if (!releaseLock) {
      console.error(
        "[hicortex] reconcile-projects --apply aborted: another capture/nightly run holds the lock. Retry when it finishes.",
      );
      report.lockBusy = true;
      return report;
    }

    try {
      // Backup FIRST — abort entirely (no renames attempted) if it fails.
      let backupPath: string;
      try {
        backupPath = await takePreDedupBackup(db, stateDir, config);
      } catch (err) {
        throw new Error(
          `[hicortex] reconcile-projects --apply aborted: backup failed (${err instanceof Error ? err.message : String(err)}). No renames attempted.`,
        );
      }
      console.log(`[hicortex] Backup written: ${backupPath}`);
      report.backupPath = backupPath;

      const applied: ReconcileApplied = { groups: 0, memories: 0, queued: 0, failed: 0 };
      // ONE transaction per group: both table updates commit together, and a
      // failed group rolls back whole (fail-soft — the rest proceed, the
      // failed group is retried on a re-run; idempotency makes that safe).
      for (const g of groups) {
        try {
          const renamed = db.transaction(() => {
            const m = db
              .prepare("UPDATE memories SET project = ? WHERE project = ?")
              .run(g.to, g.from);
            const q = db
              .prepare("UPDATE distill_queue SET project = ? WHERE project = ?")
              .run(g.to, g.from);
            return { memories: m.changes, queued: q.changes };
          })();
          applied.groups++;
          applied.memories += renamed.memories;
          applied.queued += renamed.queued;
          console.log(
            `[hicortex]   renamed ${g.from} → ${g.to}: ${renamed.memories} memory row(s)${renamed.queued > 0 ? `, ${renamed.queued} queued` : ""}`,
          );
        } catch (err) {
          applied.failed++;
          console.error(
            `[hicortex]   rename FAILED (${g.from} → ${g.to}): ` +
              `${err instanceof Error ? err.message : String(err)} — rolled back, left for a re-run`,
          );
        }
      }
      report.applied = applied;

      console.log(
        `[hicortex] reconcile-projects complete: ${applied.groups} group(s) renamed, ` +
          `${applied.memories} memory row(s), ${applied.queued} queued row(s)` +
          (applied.failed > 0 ? `, ${applied.failed} group(s) FAILED (see errors above)` : ""),
      );
      return report;
    } finally {
      releaseLock();
    }
  } finally {
    db.close();
  }
}
