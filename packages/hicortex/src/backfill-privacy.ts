/**
 * `hicortex backfill-privacy` (#332) — one-shot classification stamping for
 * EXISTING rows, by source agent, and (#609) by workspace path.
 *
 * The intake derivation stamps every NEW delivery; this command heals history
 * when the roster or the path patterns change (an agent joins the circle, a
 * folder is listed, or the feature lands on a store that already has captures
 * from a now-covered birthplace). The plan is a pure function of the config ×
 * the rows' stored values:
 *   - every memories/distill_queue row whose source_agent matches the roster
 *     (isConfidentialSourceAgent — the same `<harness>/`-stripping matcher the
 *     intake uses) AND whose privacy != 'confidential' → stamped confidential;
 *   - #609: every row whose stored `workspace_path` matches a
 *     `confidentialPaths` pattern (the same pure matcher the intake uses),
 *     grouped per pattern. NULL-path rows are NEVER path-matched (pre-v28
 *     rows have no path by construction; they are reported as unmatched, not
 *     silently stamped). A row matching both a rostered agent and a pattern
 *     flips once (agent groups claim it first; each remaining row joins its
 *     first matching pattern so overlapping patterns never double-count);
 *   - NOTHING is ever stamped BACK to standard (a roster/pattern removal is
 *     not a demotion — memories stay confidential until the operator
 *     explicitly changes them; re-running with a smaller config is a no-op by
 *     design).
 *
 * Safety rails (the `hicortex dedup` / `reconcile-projects` pattern): dry run
 * by default (report only, zero writes); `--apply` takes a pre-apply DB
 * backup (abort all writes on failure), the single-flight capture lock
 * (waitMs 0 — busy aborts), and stamps in ONE transaction. The queue rows are
 * stamped too: a pre-upgrade queued segment from a covered birthplace would
 * otherwise distill as standard (migration v27 normalized it) — the backfill
 * closes that seam.
 *
 * Idempotent by construction: a second run finds every covered row already
 * confidential and reports zero.
 */

import { hicortexHome } from "./paths.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { initDb, resolveDbPath } from "./db.js";
import { acquireCaptureLock } from "./capture.js";
import { takePreDedupBackup } from "./dedup.js";
import {
  isConfidentialSourceAgent,
  resolveConfidentialAgents,
  resolveConfidentialPaths,
  matchesConfidentialPath,
  type ConfidentialPathPattern,
} from "./classification.js";

const HICORTEX_HOME = hicortexHome();

function readConfig(stateDir: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(join(stateDir, "config.json"), "utf-8"));
  } catch {
    return null;
  }
}

/** One planned stamp group: rows from one rostered source agent, or (#609)
 *  from one confidentialPaths pattern. */
export interface BackfillGroup {
  /**
   * The DISTINCT source_agent value as stored (not the roster entry) — or,
   * for a #609 path group, the pattern's raw config entry (display label).
   */
  sourceAgent: string;
  /** Rows in `memories` that would flip to confidential. */
  memoryRows: number;
  /** Rows in `distill_queue` that would flip (distill as confidential). */
  queuedRows: number;
  /**
   * #609: the pattern this group matches — present on path groups only.
   * Path groups stamp by exact row ids (the matcher is JS-side; SQL cannot
   * express the three pattern forms); agent groups leave these unset and
   * stamp by the source_agent predicate.
   */
  pattern?: ConfidentialPathPattern;
  memoryIds?: string[];
  queuedIds?: number[];
}

export interface BackfillReport {
  dryRun: boolean;
  /** The roster entries the plan matched (subset of confidentialAgents). */
  roster: string[];
  /** #609: the resolved confidentialPaths entries (raw strings). */
  patterns: string[];
  /** Planned/executed stamp groups, largest first. */
  groups: BackfillGroup[];
  /** Total rows that would flip / flipped. */
  totalMemories: number;
  totalQueued: number;
  /** --apply only: rows actually stamped (memories). */
  appliedMemories?: number;
  /** --apply only: queue rows actually stamped. */
  appliedQueued?: number;
  /** --apply only: path to the pre-apply backup. */
  backupPath?: string;
  /** --apply only: the capture lock was busy — zero writes, retried later. */
  lockBusy?: boolean;
}

export interface BackfillOptions {
  /** Execute the stamps. Default false = dry run (report only, zero writes). */
  apply?: boolean;
  /** DB path override (tests / snapshot verification). Defaults to resolveDbPath(). */
  dbPath?: string;
  /** State dir override (tests). Defaults to ~/.hicortex. */
  stateDir?: string;
  /** Config override (tests). Defaults to reading stateDir/config.json. */
  config?: Record<string, unknown> | null;
  /** Capture-lock acquirer override (tests). Defaults to the real capture.ts lock. */
  acquireLock?: typeof acquireCaptureLock;
}

/** Distinct source_agent values (with row counts) from one table. */
function readSourceAgents(
  db: Database.Database,
  table: "memories" | "distill_queue",
): Map<string, number> {
  const column = table === "memories" ? "source_agent" : "source_agent";
  const rows = db
    .prepare(
      `SELECT ${column} AS agent, COUNT(*) AS c FROM ${table}
       WHERE ${column} IS NOT NULL AND ${column} != '' GROUP BY ${column}`,
    )
    .all() as Array<{ agent: string; c: number }>;
  return new Map(rows.map((r) => [r.agent, r.c]));
}

/**
 * The pure plan: which stored source_agent values match the roster, and how
 * many of their rows are not yet confidential. Roster matching uses the
 * INTAKE matcher (isConfidentialSourceAgent — `<harness>/`-stripping) so the
 * backfill and the intake can never disagree about who is rostered. #609 adds
 * the per-pattern groups (see planPathGroups) alongside the agent groups —
 * same rails, same never-demotes rule.
 */
export function planBackfill(
  db: Database.Database,
  roster: string[],
  patterns: ConfidentialPathPattern[] = [],
): BackfillGroup[] {
  const memoryAgents = readSourceAgents(db, "memories");
  const queuedAgents = readSourceAgents(db, "distill_queue");

  // Row ids the agent groups below claim — the path groups skip them so a row
  // covered by BOTH a rostered agent and a pattern flips (and is counted)
  // exactly once.
  const agentClaimedMem = new Set<string>();
  const agentClaimedQueue = new Set<number>();

  const groups: BackfillGroup[] = [];
  for (const [agent, memoryRows] of memoryAgents) {
    if (!isConfidentialSourceAgent(agent, roster)) continue;
    const pending = (
      db
        .prepare(
          "SELECT COUNT(*) AS c FROM memories WHERE source_agent = ? AND privacy != 'confidential'",
        )
        .get(agent) as { c: number }
    ).c;
    const queued = queuedAgents.has(agent)
      ? (
          db
            .prepare(
              "SELECT COUNT(*) AS c FROM distill_queue WHERE source_agent = ? AND privacy != 'confidential'",
            )
            .get(agent) as { c: number }
        ).c
      : 0;
    if (pending === 0 && queued === 0) continue;
    if (pending > 0) {
      for (const r of db
        .prepare(
          "SELECT id FROM memories WHERE source_agent = ? AND privacy != 'confidential'",
        )
        .all(agent) as Array<{ id: string }>) {
        agentClaimedMem.add(r.id);
      }
    }
    if (queued > 0) {
      for (const r of db
        .prepare(
          "SELECT id FROM distill_queue WHERE source_agent = ? AND privacy != 'confidential'",
        )
        .all(agent) as Array<{ id: number }>) {
        agentClaimedQueue.add(r.id);
      }
    }
    groups.push({ sourceAgent: agent, memoryRows: pending, queuedRows: queued });
  }
  // Queue-only groups (memories already stamped, inbox holds old rows).
  for (const agent of queuedAgents.keys()) {
    if (memoryAgents.has(agent)) continue;
    if (!isConfidentialSourceAgent(agent, roster)) continue;
    const queued = (
      db
        .prepare(
          "SELECT COUNT(*) AS c FROM distill_queue WHERE source_agent = ? AND privacy != 'confidential'",
        )
        .get(agent) as { c: number }
    ).c;
    if (queued > 0) {
      groups.push({ sourceAgent: agent, memoryRows: 0, queuedRows: queued });
      for (const r of db
        .prepare(
          "SELECT id FROM distill_queue WHERE source_agent = ? AND privacy != 'confidential'",
        )
        .all(agent) as Array<{ id: number }>) {
        agentClaimedQueue.add(r.id);
      }
    }
  }
  groups.push(...planPathGroups(db, patterns, agentClaimedMem, agentClaimedQueue));
  groups.sort((a, b) => b.memoryRows - a.memoryRows || a.sourceAgent.localeCompare(b.sourceAgent));
  return groups;
}

/**
 * #609: the per-PATTERN stamp groups. Rows whose STORED `workspace_path`
 * matches a configured pattern flip to confidential — matched in JS with the
 * same pure matcher the intake uses (SQL cannot express the three forms),
 * over the not-yet-confidential rows that carry a path. NULL-path rows are
 * never matched (they have no path to match — reported as unmatched, never
 * silently stamped). Rows already claimed by an agent group are skipped
 * (single flip); each remaining row joins its FIRST matching pattern (config
 * order) so overlapping patterns never double-count.
 */
function planPathGroups(
  db: Database.Database,
  patterns: ConfidentialPathPattern[],
  agentClaimedMem: Set<string>,
  agentClaimedQueue: Set<number>,
): BackfillGroup[] {
  if (patterns.length === 0) return [];
  const claims = patterns.map(() => ({ memIds: [] as string[], queueIds: [] as number[] }));

  const memRows = db
    .prepare(
      "SELECT id, workspace_path FROM memories WHERE privacy != 'confidential' AND workspace_path IS NOT NULL",
    )
    .all() as Array<{ id: string; workspace_path: string }>;
  for (const row of memRows) {
    if (agentClaimedMem.has(row.id)) continue;
    for (let p = 0; p < patterns.length; p++) {
      if (matchesConfidentialPath(row.workspace_path, [patterns[p]])) {
        claims[p].memIds.push(row.id);
        break;
      }
    }
  }

  const queueRows = db
    .prepare(
      "SELECT id, workspace_path FROM distill_queue WHERE privacy != 'confidential' AND workspace_path IS NOT NULL",
    )
    .all() as Array<{ id: number; workspace_path: string }>;
  for (const row of queueRows) {
    if (agentClaimedQueue.has(row.id)) continue;
    for (let p = 0; p < patterns.length; p++) {
      if (matchesConfidentialPath(row.workspace_path, [patterns[p]])) {
        claims[p].queueIds.push(row.id);
        break;
      }
    }
  }

  const groups: BackfillGroup[] = [];
  for (let p = 0; p < patterns.length; p++) {
    const { memIds, queueIds } = claims[p];
    if (memIds.length === 0 && queueIds.length === 0) continue;
    groups.push({
      // Display label: the pattern's raw config entry.
      sourceAgent: patterns[p].raw,
      pattern: patterns[p],
      memoryRows: memIds.length,
      queuedRows: queueIds.length,
      memoryIds: memIds,
      queuedIds: queueIds,
    });
  }
  return groups;
}

/**
 * Run `hicortex backfill-privacy`. Dry run by default (options.apply falsy) —
 * plan + report only, zero writes. `options.apply` executes: backup, capture
 * lock, ONE transaction stamping every planned row in BOTH tables. A busy
 * lock is an abort (reported as `lockBusy: true`, never a wait); a failed
 * backup aborts all writes (throw, like dedup/reconcile-projects).
 */
export async function runBackfillPrivacy(options: BackfillOptions = {}): Promise<BackfillReport> {
  const stateDir = options.stateDir ?? HICORTEX_HOME;
  const config = options.config !== undefined ? options.config : readConfig(stateDir);
  // The roster AND the path patterns come from the SAME resolutions the
  // server uses at boot (resolveConfidentialAgents / resolveConfidentialPaths)
  // — one config shape, one matcher, so the backfill can never disagree with
  // the intake about what is covered.
  const roster = resolveConfidentialAgents(config).roster;
  const patterns = resolveConfidentialPaths(config).patterns;

  // Server-mode only — client installs have no local DB.
  if (config?.mode === "client") {
    throw new Error(
      "[hicortex] backfill-privacy is server-mode only (it needs the local DB). " +
        `This machine is a client of ${config.serverUrl ?? "a remote server"} — run backfill-privacy on the server.`,
    );
  }

  const apply = options.apply ?? false;
  const dbPath = resolveDbPath(options.dbPath);
  const db = initDb(dbPath);

  try {
    console.log(
      `[hicortex] backfill-privacy starting (${apply ? "APPLY" : "dry-run"}): db ${dbPath}, ` +
        `${roster.length} rostered agent(s)${roster.length > 0 ? ` (${roster.join(", ")})` : ""}` +
        `, ${patterns.length} path pattern(s)${patterns.length > 0 ? ` (${patterns.map((p) => p.raw).join(", ")})` : ""}`,
    );

    if (roster.length === 0 && patterns.length === 0) {
      console.log(
        "[hicortex] backfill-privacy: no confidentialAgents or confidentialPaths configured — nothing to stamp. " +
          "Add agent ids to config.json confidentialAgents and/or path patterns to confidentialPaths first.",
      );
      return { dryRun: !apply, roster, patterns: [], groups: [], totalMemories: 0, totalQueued: 0 };
    }

    const groups = planBackfill(db, roster, patterns);
    const totalMemories = groups.reduce((s, g) => s + g.memoryRows, 0);
    const totalQueued = groups.reduce((s, g) => s + g.queuedRows, 0);
    const report: BackfillReport = {
      dryRun: !apply,
      roster,
      patterns: patterns.map((p) => p.raw),
      groups,
      totalMemories,
      totalQueued,
    };

    console.log(
      `[hicortex] backfill-privacy: ${groups.length} group(s) match the config, ` +
        `${totalMemories} memory row(s)${totalQueued > 0 ? `, ${totalQueued} queued row(s)` : ""} ` +
        `→ confidential (${apply ? "applying" : "dry run — zero writes"})`,
    );
    for (const g of groups) {
      const label = g.pattern ? `pattern ${g.pattern.raw}` : g.sourceAgent;
      console.log(
        `[hicortex]   ${label}: ${g.memoryRows} memory row(s)${g.queuedRows > 0 ? `, ${g.queuedRows} queued` : ""}`,
      );
    }

    if (!apply) return report;

    // --apply: single-flight capture lock (waitMs 0) so a concurrent
    // nightly/capture run cannot race the stamps. Busy → abort (reported,
    // never a silent wait — a deliberate manual command is retried by the
    // operator, like dedup/reconcile-projects).
    const acquireLock = options.acquireLock ?? acquireCaptureLock;
    const releaseLock = await acquireLock(stateDir, 0);
    if (!releaseLock) {
      console.error(
        "[hicortex] backfill-privacy --apply aborted: another capture/nightly run holds the lock. Retry when it finishes.",
      );
      report.lockBusy = true;
      return report;
    }

    try {
      // Backup FIRST — abort entirely (no stamps attempted) if it fails.
      let backupPath: string;
      try {
        backupPath = await takePreDedupBackup(db, stateDir, config);
      } catch (err) {
        throw new Error(
          `[hicortex] backfill-privacy --apply aborted: backup failed (${err instanceof Error ? err.message : String(err)}). No stamps attempted.`,
        );
      }
      console.log(`[hicortex] Backup written: ${backupPath}`);
      report.backupPath = backupPath;

      // ONE transaction: every group's memory + queue stamps commit together
      // (the plan is order-independent — pure predicates). Agent groups stamp
      // by source_agent; #609 path groups stamp by exact row id (the JS-side
      // matcher planned them — SQL cannot express the pattern forms).
      const stampMem = db.prepare(
        "UPDATE memories SET privacy = 'confidential' WHERE source_agent = ? AND privacy != 'confidential'",
      );
      const stampQueue = db.prepare(
        "UPDATE distill_queue SET privacy = 'confidential' WHERE source_agent = ? AND privacy != 'confidential'",
      );
      const stampMemById = db.prepare(
        "UPDATE memories SET privacy = 'confidential' WHERE id = ? AND privacy != 'confidential'",
      );
      const stampQueueById = db.prepare(
        "UPDATE distill_queue SET privacy = 'confidential' WHERE id = ? AND privacy != 'confidential'",
      );
      const applied = db.transaction(() => {
        let memories = 0;
        let queued = 0;
        for (const g of groups) {
          if (g.pattern) {
            for (const id of g.memoryIds ?? []) memories += stampMemById.run(id).changes;
            for (const id of g.queuedIds ?? []) queued += stampQueueById.run(id).changes;
          } else {
            memories += stampMem.run(g.sourceAgent).changes;
            queued += stampQueue.run(g.sourceAgent).changes;
          }
        }
        return { memories, queued };
      })();
      report.appliedMemories = applied.memories;
      report.appliedQueued = applied.queued;

      console.log(
        `[hicortex] backfill-privacy complete: ${applied.memories} memory row(s) stamped confidential` +
          (applied.queued > 0 ? `, ${applied.queued} queued row(s)` : "") +
          " (nothing is ever stamped back to standard — a roster/pattern removal is not a demotion)",
      );
      return report;
    } finally {
      releaseLock();
    }
  } finally {
    db.close();
  }
}
