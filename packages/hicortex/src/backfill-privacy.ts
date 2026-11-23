/**
 * `hicortex backfill-spaces` (#642 AC-14; the #332 `backfill-privacy` command
 * generalized — the old name stays a hidden alias via resolveCommandAlias) —
 * one-shot space stamping for EXISTING rows, by member roster and workspace
 * path, PER SPACE.
 *
 * The intake derivation stamps every NEW delivery; this command heals history
 * when a space's members or paths change (an agent joins a space, a folder
 * tree is listed, or the feature lands on a store that already has captures
 * from a now-covered birthplace). The plan is a pure function of the resolved
 * spaces × the rows' stored values:
 *   - every memories/distill_queue row whose source_agent matches a space's
 *     members (isConfidentialSourceAgent — the same `<harness>/`-stripping
 *     matcher the intake uses) AND is still shared → stamped with that
 *     space's id, grouped per (space, stored source_agent);
 *   - every row whose stored `workspace_path` matches a space's path pattern
 *     (matchesConfidentialPath — the same pure matcher the intake uses),
 *     grouped per (space, pattern). NULL-path rows are NEVER path-matched
 *     (pre-v28 rows have no path by construction; they are reported as
 *     unmatched, not silently stamped);
 *   - CANDIDATES are ONLY rows with `privacy IS NULL OR privacy = 'standard'`
 *     — an already-stamped row NEVER moves (no demotion, no space→space);
 *     today's `!= 'confidential'` was the N=1 equivalent of this rule;
 *   - claim order: agent groups first (spaces in config order), then path
 *     groups (spaces in config order, patterns in entry order) — the FIRST
 *     matching space in config order claims a row (single flip, never
 *     double-counted);
 *   - NOTHING is ever stamped BACK to standard (a members/pattern removal is
 *     not a demotion — memories stay in their space until the operator
 *     explicitly changes them; re-running with a smaller config is a no-op by
 *     design).
 *
 * A pure-legacy config (confidentialAgents/confidentialPaths, no `spaces`
 * key) resolves to the MATERIALIZED confidential space — byte-identical
 * legacy behavior: the same groups, the same 'confidential' stamps, the same
 * report fields (roster/patterns stay the confidential space's).
 *
 * Safety rails (the `hicortex dedup` / `reconcile-projects` pattern): dry run
 * by default (report only, zero writes); `--apply` takes a pre-apply DB
 * backup (abort all writes on failure), the single-flight capture lock
 * (waitMs 0 — busy aborts), and stamps in ONE transaction, with the space id
 * PARAMETERIZED (never interpolated into SQL). The queue rows are stamped
 * too: a pre-upgrade queued segment from a covered birthplace would
 * otherwise distill as standard — the backfill closes that seam.
 *
 * Idempotent by construction: a second run finds every covered row already
 * stamped and reports zero.
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
  matchesConfidentialPath,
  type ConfidentialPathPattern,
} from "./classification.js";
import { resolveSpaces, type SpaceDef } from "./spaces.js";
import { REFLECTION_PRIVACY_LINE_CONFIDENTIAL } from "./prompts.js";

const HICORTEX_HOME = hicortexHome();

function readConfig(stateDir: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(join(stateDir, "config.json"), "utf-8"));
  } catch {
    return null;
  }
}

/** One planned stamp group: rows from one space's rostered source agent, or
 *  from one space's path pattern. */
export interface BackfillGroup {
  /** #642: the space whose birthplace claimed these rows (the stamp value). */
  space: string;
  /**
   * The DISTINCT source_agent value as stored (not the roster entry) — or,
   * for a path group, the pattern's raw config entry (display label).
   */
  sourceAgent: string;
  /** Rows in `memories` that would flip to the space. */
  memoryRows: number;
  /** Rows in `distill_queue` that would flip (distill into the space). */
  queuedRows: number;
  /**
   * Present on path groups only. Path groups stamp by exact row ids (the
   * matcher is JS-side; SQL cannot express the three pattern forms); agent
   * groups leave these unset and stamp by the source_agent predicate.
   */
  pattern?: ConfidentialPathPattern;
  memoryIds?: string[];
  queuedIds?: number[];
}

export interface BackfillReport {
  dryRun: boolean;
  /** The LEGACY report fields: the (materialized or explicit) confidential
   *  space's roster — [] when no confidential space exists. Groups carry the
   *  per-space truth. */
  roster: string[];
  /** The confidential space's raw path patterns (legacy field, same rule). */
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
 * The pre-#642 call shape — planBackfill(db, roster, patterns) — delegating
 * to the generalized core with the roster+patterns materialized as the
 * reserved confidential space (exactly what resolveSpaces does for a legacy
 * config). The OLD tests pin this overload; it must keep answering the same
 * groups (now carrying space: 'confidential').
 */
function legacyConfidentialSpace(
  roster: string[],
  patterns: ConfidentialPathPattern[],
): SpaceDef {
  return {
    id: "confidential",
    members: roster,
    paths: patterns,
    llm: null,
    privacyLine: REFLECTION_PRIVACY_LINE_CONFIDENTIAL,
  };
}

/** Discriminate the two planBackfill argument forms (string[] roster vs
 *  SpaceDef[]). A non-empty patterns argument means the LEGACY roster form
 *  (SpaceDef callers pass everything in arg 2); an empty first arg with no
 *  patterns is legacy-empty (and plans nothing as either shape); otherwise
 *  the first element's shape decides. */
function isSpaceDefList(v: unknown[], patterns: ConfidentialPathPattern[]): v is SpaceDef[] {
  if (patterns.length > 0) return false;
  if (v.length === 0) return false;
  return typeof v[0] === "object" && v[0] !== null && "id" in v[0];
}

/**
 * The pure plan. #642 AC-14: `planBackfill(db, resolveSpaces(config).spaces)`
 * plans per-space groups; the legacy `planBackfill(db, roster, patterns)`
 * form delegates with the confidential space. Roster matching uses the
 * INTAKE matcher (isConfidentialSourceAgent — `<harness>/`-stripping) so the
 * backfill and the intake can never disagree about who is a member; path
 * matching uses the intake's pure matcher over the stored workspace_path.
 * Candidates are ONLY still-shared rows (privacy IS NULL OR 'standard') — an
 * already-stamped row never moves.
 */
export function planBackfill(
  db: Database.Database,
  rosterOrSpaces: string[] | SpaceDef[],
  patterns: ConfidentialPathPattern[] = [],
): BackfillGroup[] {
  const spaces = isSpaceDefList(rosterOrSpaces, patterns)
    ? rosterOrSpaces
    : [legacyConfidentialSpace(rosterOrSpaces, patterns)];
  return planSpaceBackfill(db, spaces);
}

/** The generalized core: per-space agent groups (config order, first space
 *  claims) then per-space path groups. Shared rows only — never demotes. */
function planSpaceBackfill(db: Database.Database, spaces: SpaceDef[]): BackfillGroup[] {
  const memoryAgents = readSourceAgents(db, "memories");
  const queuedAgents = readSourceAgents(db, "distill_queue");

  // Row ids the agent groups claim — the path groups skip them so a row
  // covered by BOTH a rostered agent and a pattern flips (and is counted)
  // exactly once.
  const agentClaimedMem = new Set<string>();
  const agentClaimedQueue = new Set<number>();

  const pendingMemIds = db.prepare(
    "SELECT id FROM memories WHERE source_agent = ? AND (privacy IS NULL OR privacy = 'standard')",
  );
  const pendingQueueIds = db.prepare(
    "SELECT id FROM distill_queue WHERE source_agent = ? AND (privacy IS NULL OR privacy = 'standard')",
  );

  const groups: BackfillGroup[] = [];
  // AGENT GROUPS — spaces in CONFIG ORDER (the first space whose members
  // match claims the row), one group per (space, observed source_agent).
  for (const space of spaces) {
    for (const [agent] of memoryAgents) {
      if (!isConfidentialSourceAgent(agent, space.members)) continue;
      const memIds = (pendingMemIds.all(agent) as Array<{ id: string }>)
        .map((r) => r.id)
        .filter((id) => !agentClaimedMem.has(id));
      const queueIds = queuedAgents.has(agent)
        ? (pendingQueueIds.all(agent) as Array<{ id: number }>)
            .map((r) => r.id)
            .filter((id) => !agentClaimedQueue.has(id))
        : [];
      if (memIds.length === 0 && queueIds.length === 0) continue;
      for (const id of memIds) agentClaimedMem.add(id);
      for (const id of queueIds) agentClaimedQueue.add(id);
      groups.push({
        space: space.id,
        sourceAgent: agent,
        memoryRows: memIds.length,
        queuedRows: queueIds.length,
      });
    }
    // Queue-only groups (memories already stamped, inbox holds old rows).
    for (const agent of queuedAgents.keys()) {
      if (memoryAgents.has(agent)) continue;
      if (!isConfidentialSourceAgent(agent, space.members)) continue;
      const queueIds = (pendingQueueIds.all(agent) as Array<{ id: number }>)
        .map((r) => r.id)
        .filter((id) => !agentClaimedQueue.has(id));
      if (queueIds.length === 0) continue;
      for (const id of queueIds) agentClaimedQueue.add(id);
      groups.push({ space: space.id, sourceAgent: agent, memoryRows: 0, queuedRows: queueIds.length });
    }
  }
  groups.push(...planPathGroups(db, spaces, agentClaimedMem, agentClaimedQueue));
  groups.sort((a, b) => b.memoryRows - a.memoryRows || a.sourceAgent.localeCompare(b.sourceAgent));
  return groups;
}

/**
 * The per-(space, pattern) stamp groups. Rows whose STORED `workspace_path`
 * matches a configured pattern flip to that space — matched in JS with the
 * same pure matcher the intake uses (SQL cannot express the three forms),
 * over the still-shared rows that carry a path. NULL-path rows are never
 * matched (they have no path to match — reported as unmatched, never
 * silently stamped). Rows already claimed by an agent group are skipped
 * (single flip); each remaining row joins the FIRST matching (space,
 * pattern) in config order so overlapping patterns never double-count.
 */
function planPathGroups(
  db: Database.Database,
  spaces: SpaceDef[],
  agentClaimedMem: Set<string>,
  agentClaimedQueue: Set<number>,
): BackfillGroup[] {
  const withPaths = spaces.filter((s) => s.paths.length > 0);
  if (withPaths.length === 0) return [];
  // claims keyed by space id + pattern raw (patterns are deduped per space at
  // resolution, so the pair is unique).
  const claims = new Map<string, { space: SpaceDef; pattern: ConfidentialPathPattern; memIds: string[]; queueIds: number[] }>();
  const claimFor = (space: SpaceDef, pattern: ConfidentialPathPattern) => {
    const key = `${space.id}\u0000${pattern.raw}`;
    let c = claims.get(key);
    if (!c) {
      c = { space, pattern, memIds: [], queueIds: [] };
      claims.set(key, c);
    }
    return c;
  };

  const memRows = db
    .prepare(
      "SELECT id, workspace_path FROM memories WHERE (privacy IS NULL OR privacy = 'standard') AND workspace_path IS NOT NULL",
    )
    .all() as Array<{ id: string; workspace_path: string }>;
  for (const row of memRows) {
    if (agentClaimedMem.has(row.id)) continue;
    for (const space of withPaths) {
      let claimed = false;
      for (const pattern of space.paths) {
        if (matchesConfidentialPath(row.workspace_path, [pattern])) {
          claimFor(space, pattern).memIds.push(row.id);
          claimed = true;
          break;
        }
      }
      if (claimed) break;
    }
  }

  const queueRows = db
    .prepare(
      "SELECT id, workspace_path FROM distill_queue WHERE (privacy IS NULL OR privacy = 'standard') AND workspace_path IS NOT NULL",
    )
    .all() as Array<{ id: number; workspace_path: string }>;
  for (const row of queueRows) {
    if (agentClaimedQueue.has(row.id)) continue;
    for (const space of withPaths) {
      let claimed = false;
      for (const pattern of space.paths) {
        if (matchesConfidentialPath(row.workspace_path, [pattern])) {
          claimFor(space, pattern).queueIds.push(row.id);
          claimed = true;
          break;
        }
      }
      if (claimed) break;
    }
  }

  // Emit in (space config order, pattern entry order) — the deterministic
  // claim order, before the caller's count sort.
  const groups: BackfillGroup[] = [];
  for (const space of withPaths) {
    for (const pattern of space.paths) {
      const c = claims.get(`${space.id}\u0000${pattern.raw}`);
      if (!c || (c.memIds.length === 0 && c.queueIds.length === 0)) continue;
      groups.push({
        space: space.id,
        // Display label: the pattern's raw config entry.
        sourceAgent: pattern.raw,
        pattern,
        memoryRows: c.memIds.length,
        queuedRows: c.queueIds.length,
        memoryIds: c.memIds,
        queuedIds: c.queueIds,
      });
    }
  }
  return groups;
}

/**
 * Run `hicortex backfill-spaces` (alias `backfill-privacy`). Dry run by
 * default (options.apply falsy) — plan + report only, zero writes.
 * `options.apply` executes: backup, capture lock, ONE transaction stamping
 * every planned row in BOTH tables with its group's space id (parameterized
 * SQL). A busy lock is an abort (reported as `lockBusy: true`, never a
 * wait); a failed backup aborts all writes (throw, like
 * dedup/reconcile-projects).
 */
export async function runBackfillPrivacy(options: BackfillOptions = {}): Promise<BackfillReport> {
  const stateDir = options.stateDir ?? HICORTEX_HOME;
  const config = options.config !== undefined ? options.config : readConfig(stateDir);
  // The spaces come from the SAME resolution the server uses at boot
  // (resolveSpaces) — one config shape, one matcher, so the backfill can
  // never disagree with the intake about what is covered. A pure-legacy
  // config materializes the confidential space here: byte-identical legacy
  // behavior (same groups, same 'confidential' stamps, same report fields).
  const resolved = resolveSpaces(config);
  const spaces = resolved.spaces;
  const conf = resolved.byId.get("confidential");
  const roster = conf ? conf.members : [];
  const patterns = conf ? conf.paths : [];

  // Server-mode only — client installs have no local DB.
  if (config?.mode === "client") {
    throw new Error(
      "[hicortex] backfill-spaces (alias backfill-privacy) is server-mode only (it needs the local DB). " +
        `This machine is a client of ${config.serverUrl ?? "a remote server"} — run backfill-spaces on the server.`,
    );
  }

  const apply = options.apply ?? false;
  const dbPath = resolveDbPath(options.dbPath);
  const db = initDb(dbPath);

  try {
    console.log(
      `[hicortex] backfill-spaces starting (${apply ? "APPLY" : "dry-run"}): db ${dbPath}, ` +
        `${spaces.length} space(s)${spaces.length > 0 ? ` (${spaces.map((s) => s.id).join(", ")})` : ""}` +
        (conf ? ` · confidential roster (${roster.length})${roster.length > 0 ? ` ${roster.join(", ")}` : ""}, ${patterns.length} path pattern(s)` : ""),
    );

    if (spaces.length === 0) {
      console.log(
        "[hicortex] backfill-spaces: no spaces configured — nothing to stamp. Add a spaces map " +
          "(space id → { members, paths, optional llm }) to config.json, or the legacy confidentialAgents/" +
          "confidentialPaths keys, then re-run.",
      );
      return { dryRun: !apply, roster, patterns: [], groups: [], totalMemories: 0, totalQueued: 0 };
    }

    const groups = planBackfill(db, spaces);
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
      `[hicortex] backfill-spaces: ${groups.length} group(s) match the config, ` +
        `${totalMemories} memory row(s)${totalQueued > 0 ? `, ${totalQueued} queued row(s)` : ""} ` +
        `→ their spaces (${apply ? "applying" : "dry run — zero writes"})`,
    );
    for (const g of groups) {
      const label = g.pattern ? `pattern ${g.pattern.raw}` : g.sourceAgent;
      console.log(
        `[hicortex]   space '${g.space}' · ${label}: ${g.memoryRows} memory row(s)${g.queuedRows > 0 ? `, ${g.queuedRows} queued` : ""}`,
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
        "[hicortex] backfill-spaces --apply aborted: another capture/nightly run holds the lock. Retry when it finishes.",
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
          `[hicortex] backfill-spaces --apply aborted: backup failed (${err instanceof Error ? err.message : String(err)}). No stamps attempted.`,
        );
      }
      console.log(`[hicortex] Backup written: ${backupPath}`);
      report.backupPath = backupPath;

      // ONE transaction: every group's memory + queue stamps commit together
      // (the plan is order-independent — pure predicates). The space id is a
      // SQL PARAMETER everywhere (never interpolated). Agent groups stamp by
      // source_agent; path groups stamp by exact row id (the JS-side matcher
      // planned them — SQL cannot express the pattern forms).
      const stampMem = db.prepare(
        "UPDATE memories SET privacy = ? WHERE source_agent = ? AND (privacy IS NULL OR privacy = 'standard')",
      );
      const stampQueue = db.prepare(
        "UPDATE distill_queue SET privacy = ? WHERE source_agent = ? AND (privacy IS NULL OR privacy = 'standard')",
      );
      const stampMemById = db.prepare(
        "UPDATE memories SET privacy = ? WHERE id = ? AND (privacy IS NULL OR privacy = 'standard')",
      );
      const stampQueueById = db.prepare(
        "UPDATE distill_queue SET privacy = ? WHERE id = ? AND (privacy IS NULL OR privacy = 'standard')",
      );
      const applied = db.transaction(() => {
        let memories = 0;
        let queued = 0;
        for (const g of groups) {
          if (g.pattern) {
            for (const id of g.memoryIds ?? []) memories += stampMemById.run(g.space, id).changes;
            for (const id of g.queuedIds ?? []) queued += stampQueueById.run(g.space, id).changes;
          } else {
            memories += stampMem.run(g.space, g.sourceAgent).changes;
            queued += stampQueue.run(g.space, g.sourceAgent).changes;
          }
        }
        return { memories, queued };
      })();
      report.appliedMemories = applied.memories;
      report.appliedQueued = applied.queued;

      console.log(
        `[hicortex] backfill-spaces complete: ${applied.memories} memory row(s) stamped` +
          (applied.queued > 0 ? `, ${applied.queued} queued row(s)` : "") +
          " (nothing is ever stamped back to standard — a members/pattern removal is not a demotion)",
      );
      return report;
    } finally {
      releaseLock();
    }
  } finally {
    db.close();
  }
}

/** #642: the canonical command name — same runner, clearer export. */
export const runBackfillSpaces = runBackfillPrivacy;
