/**
 * `hicortex dedup` + the nightly deterministic merge zone (issues #100, #392).
 *
 * Corpus-quality companion to `hicortex relink`/`classify-domains`: instead of
 * discovering NEW structure, this collapses memories that are near-identical
 * (top-10 KNN cosine >= threshold, default 0.92, union-find clustered — same
 * math as the #191 D1 duplicate-rate audit; see cluster.ts). Two surfaces,
 * ONE core:
 *
 *  - `runDedup` — the manual CLI. Default is a DRY RUN: report only, zero
 *    writes. `--apply` executes the merge. Threshold resolution (#408):
 *    `--threshold` > the release-managed calibration ceiling (0.92,
 *    calibration.ts DEDUP_AUTO_MERGE_THRESHOLD — the config keys are gone).
 *  - `runDeterministicMergeZone` (#392) — the nightly's LLM-free merge zone:
 *    pairs at/above the ceiling merge deterministically, ZERO LLM calls,
 *    bounded by the run-wide pipeline deadline's stop-check (#405 — the
 *    dedupNightlyMaxMerges pacing cap is gone; merges are local transactions,
 *    so the deadline bounds their wall-clock). Called from the
 *    reconsolidation stage (and from the quiet-night skip path in
 *    consolidate.ts) so one stage report covers all resolution work.
 *
 * Per cluster (shared `planDedup`/`mergeCluster` core — no forks):
 *   - Canonical = highest access_count (tie: NEWEST created_at — newest-wins,
 *     #206 decision 3 — then lexicographically smallest id, fully
 *     deterministic for audit).
 *   - Losers' links are re-pointed onto the canonical (a link that would
 *     become a self-link, or one whose (canonical, target) ordered pair
 *     ALREADY holds an edge, is skipped rather than overwritten — see
 *     planLinkRepoints for why `relationship` cannot be part of that guard);
 *     the losers' own link rows are then deleted (previously cascade-deleted
 *     with the row).
 *   - canonical.access_count/shown_count = summed across the cluster;
 *     last_accessed = max; base_strength = max.
 *   - Tags are UNIONED onto the canonical (weights NULL — the next nightly's
 *     reconsolidation pass recomputes weights and the derived primary from
 *     the merged tag set); the losers' tag rows are cleared and their domain
 *     set NULL — a loser must not count in moduleIndex/tag recomputes.
 *   - A `dedup_log` row is written per loser — audit trail AND the safety net
 *     /distill consults (mcp-server.ts) so an absorbed loser's
 *     `source_session` marker still blocks a re-ingest.
 *   - Losers are ABSORBED (storage.absorbMemory), not deleted (#392): status
 *     'absorbed', vector + FTS rows dropped, plain row retained — invisible
 *     to recall, fetchable by id as evidence. Same vocabulary as the
 *     reconsolidation rewrite path. Merges are NOT history-rollback-able —
 *     dedup_log (loser_id → canonical_id) + the retained loser row is the
 *     record.
 *
 * A cluster whose members disagree on project is SKIPPED entirely and listed
 * for manual review (reason `project_mismatch`) — no --force in this release.
 * The source_agent rail was REMOVED (#206 decision 2, 2026-09-21): cross-agent
 * clusters merge — attribution is preserved on the retained evidence row and
 * no recall path filters by agent.
 *
 * Safety rails when applying (CLI and zone alike):
 *   - A full DB backup (SQLite backup API) is taken FIRST, to
 *     <state>/backups/pre-dedup-<ISO>.db, pruned to `backupRetention` newest
 *     (pattern-scoped: full `hicortex-*.tar.gz` artifacts keep their own
 *     count). The CLI aborts (no merges attempted) if the backup fails; the
 *     nightly zone is fail-soft (backup_failed flag, zero merges).
 *   - The existing single-flight capture lock (capture.ts) is held for the
 *     duration of the merge so a concurrent nightly/capture run can't race
 *     the dedup_log bookkeeping the merge relies on. The CLI fails fast on a
 *     busy lock; the zone reports lock_busy and merges nothing.
 *
 * Server-mode only (needs the local DB), like relink/classify-domains.
 */

import { hicortexHome } from "./paths.js";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { initDb, resolveDbPath } from "./db.js";
import * as storage from "./storage.js";
import {
  buildKnnEdges,
  clusterEdges,
  clusterMetadataMismatch,
  type ClusterMetadataMismatch,
} from "./cluster.js";
import { acquireCaptureLock } from "./capture.js";
import { updateState } from "./state.js";
import { readNonNegativeConfig } from "./config-read.js";
import * as CALIBRATION from "./calibration.js";
import { DEFAULT_BACKUP_RETENTION, pruneBackupArtifacts } from "./backup.js";
import type { DeterministicMergeZoneReport, ResolutionBandStat } from "./types.js";
import type { RunDeadline } from "./run-deadline.js";

const HICORTEX_HOME = hicortexHome();

/**
 * Default merge threshold — RELEASE-MANAGED since #408: the constant (with
 * its provenance: measured on the #191 mechanical audit corpus, 89 clusters /
 * 110 excess rows at 0.92, data/audit-20260729/eval-report.md) lives in
 * calibration.ts. #392: also the deterministic/LLM boundary of the unified
 * resolution pass.
 */
export const DEFAULT_DEDUP_MERGE_THRESHOLD = CALIBRATION.DEDUP_AUTO_MERGE_THRESHOLD;

/** KNN neighbors considered per memory — same as the #191 audit (cluster.ts default). */
const DEDUP_KNN_K = 10;

/** Pre-merge backup filename pattern (takePreDedupBackup) — scoped retention. */
const PRE_DEDUP_BACKUP_PATTERN = /^pre-dedup-.*\.db$/;

function readConfig(stateDir: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(join(stateDir, "config.json"), "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Threshold resolution for the manual CLI (#408): explicit `--threshold` >
 * the release-managed calibration constant. An invalid explicit value throws
 * (existing error style). The config keys (`dedupAutoMergeThreshold` /
 * legacy `dedupMergeThreshold`) are gone from the surface — a config carrying
 * them changes nothing (warned at the config boundary, config-read.ts).
 */
function resolveThreshold(explicit: number | undefined): number {
  if (explicit !== undefined) {
    if (!Number.isFinite(explicit) || explicit <= 0 || explicit > 1) {
      throw new Error(`[hicortex] dedup: invalid --threshold value: ${explicit} (must be in (0, 1])`);
    }
    return explicit;
  }
  return DEFAULT_DEDUP_MERGE_THRESHOLD;
}

// ---------------------------------------------------------------------------
// Cluster loading + merge decision (the shared core — CLI and nightly zone)
// ---------------------------------------------------------------------------

/**
 * Row shape read from `memories` for merge decisions — a superset of the
 * fields the Memory type declares (shown_count isn't on that interface yet).
 * `status` rides along so judged-pair merges can defensively drop rows that
 * were absorbed between verdict and apply.
 */
interface DedupMemberRow {
  id: string;
  content: string;
  access_count: number;
  shown_count: number | null;
  last_accessed: string | null;
  base_strength: number;
  created_at: string;
  project: string | null;
  privacy: string | null;
  source_agent: string;
  source_session: string | null;
  status: string | null;
}

export interface DedupClusterPlan {
  size: number;
  canonicalId: string;
  loserIds: string[];
  /** Preview lines for the dry-run report / manual review, oldest first. */
  members: Array<{ id: string; created_at: string; access_count: number; preview: string }>;
  /** Losers' links that will be (or were) re-pointed onto the canonical. */
  linksRepointed: number;
  /** Would-be self-links dropped (both endpoints normalize to the canonical). */
  linksSkippedSelfLink: number;
  /**
   * Losers' links dropped because the canonical (or an earlier loser in this
   * same cluster) already holds an edge for that ordered (source, target)
   * pair. NEVER silently overwritten — see planLinkRepoints for why the
   * schema forces this to be counted rather than replaced.
   */
  linksSkippedExisting: number;
}

export interface DedupMismatchCluster {
  size: number;
  memberIds: string[];
  mismatch: ClusterMetadataMismatch;
}

/** #393 guard-C: a cluster set aside because a member pair is conflicts-linked. */
export interface DedupConflictCluster {
  size: number;
  memberIds: string[];
}

export interface DedupReport {
  dryRun: boolean;
  threshold: number;
  /** Every cluster found at the threshold (mergeable + mismatch-skipped). */
  clusterCount: number;
  mergeable: DedupClusterPlan[];
  mismatchSkipped: DedupMismatchCluster[];
  /** #393 guard-C: clusters skipped because a member pair is conflicts-linked. */
  conflictSkipped: DedupConflictCluster[];
  /** Rows that would disappear if every mergeable cluster merged (loser count). */
  plannedMerges: number;
  /**
   * Sum of `linksSkippedExisting` across every mergeable cluster (dry-run:
   * computed from the discovery-time read; --apply: recomputed live per
   * cluster as it merges, so it reflects any same-run ripple across
   * clusters — see planLinkRepoints). Surfaced at the top level so a
   * clobber-risk is never buried in per-cluster output only.
   */
  linksSkippedExisting: number;
  /** --apply only: clusters actually merged. */
  merged?: number;
  /** --apply only: loser rows absorbed (hidden from recall, kept as evidence). */
  losersAbsorbed?: number;
  /** --apply only: clusters that errored mid-merge (rolled back; left for a re-run). */
  failedClusters?: number;
  /** --apply only: path to the pre-merge backup. */
  backupPath?: string;
}

export interface DedupOptions {
  /** Execute the merge. Default false = dry run (report only, zero writes). */
  apply?: boolean;
  /** Override the configured threshold for one run. */
  threshold?: number;
  /** DB path override (tests / manual snapshot verification). Defaults to resolveDbPath(). */
  dbPath?: string;
  /** State dir override (tests). Defaults to ~/.hicortex. Backups also land under here/backups/. */
  stateDir?: string;
  /** Config override (tests). Defaults to reading stateDir/config.json. */
  config?: Record<string, unknown> | null;
  /** Capture-lock acquirer override (tests). Defaults to the real capture.ts lock. */
  acquireLock?: typeof acquireCaptureLock;
  /**
   * Test-only failure injection: called once per cluster merge, after the
   * link/tag/counter writes but before the audit-log + absorb step. Throwing
   * here proves a mid-merge error rolls the WHOLE cluster's writes back
   * (better-sqlite3 transaction semantics) rather than leaving a half-merged
   * cluster. Never set in production.
   */
  _injectFailureAfterWrites?: (canonicalId: string) => void;
}

function loadMembers(db: Database.Database, ids: string[]): DedupMemberRow[] {
  const placeholders = ids.map(() => "?").join(", ");
  return db
    .prepare(
      `SELECT id, content, access_count, shown_count, last_accessed, base_strength,
              created_at, project, privacy, source_agent, source_session, status
       FROM memories WHERE id IN (${placeholders})`,
    )
    .all(...ids) as DedupMemberRow[];
}

/** Canonical = highest access_count; ties broken by NEWEST created_at (newest-wins,
 *  #206 decision 3 — most-used still wins first, newest is the tie-break), then
 *  lexicographically smallest id. */
function pickCanonical(members: DedupMemberRow[]): { canonical: DedupMemberRow; losers: DedupMemberRow[] } {
  const sorted = [...members].sort((a, b) => {
    if (b.access_count !== a.access_count) return b.access_count - a.access_count;
    if (a.created_at !== b.created_at) return b.created_at.localeCompare(a.created_at);
    return a.id.localeCompare(b.id);
  });
  const [canonical, ...losers] = sorted;
  return { canonical, losers };
}

/** One link the merge will (or would) add onto the canonical. */
interface PlannedLink {
  source: string;
  target: string;
  relationship: string;
  strength: number;
}

export interface LinkRepointPlan {
  toAdd: PlannedLink[];
  skippedSelfLink: number;
  skippedExisting: number;
}

/**
 * Compute (read-only — no writes) what re-pointing the cluster's losers'
 * links onto the canonical would do. Shared by the dry-run/apply report (a
 * preview against the CURRENT DB state) and mergeCluster (the live,
 * authoritative computation at execution time, inside the transaction).
 *
 * The guard checks the ordered (source, target) pair ONLY — never
 * `relationship`. `memory_links`' primary key is `(source_id, target_id)`
 * with NO relationship column in the key, and storage.addLink is
 * `INSERT OR REPLACE`: a loser's link to some target X under a DIFFERENT
 * relationship than the canonical's EXISTING X-edge would otherwise slip past
 * a triple-keyed guard and REPLACE silently erase the canonical's edge
 * (relationship + strength). Since the schema physically holds at most one
 * edge per ordered pair, ANY existing edge for that pair — regardless of its
 * relationship — must skip, never overwrite.
 *
 * `plannedPairs` also dedups WITHIN this same plan: two different losers
 * linking to the same external target both remap to (canonical, target), and
 * only the first is kept — the DB isn't touched between planning and
 * applying a single cluster, so a pair "already added" and a pair "already in
 * the DB" are the same kind of collision from the canonical's point of view.
 *
 * Links are fetched with ONE query across all losers (source_id OR target_id
 * IN the loser set) rather than per-loser `storage.getLinks` calls — an edge
 * BETWEEN two losers in the same cluster would otherwise be visited twice
 * (once from each side), double-counting it as two self-link skips instead
 * of one. Each row in `memory_links` is a single (source_id, target_id) pair
 * (the primary key), so this query returns each affected edge exactly once.
 */
function planLinkRepoints(
  db: Database.Database,
  canonical: DedupMemberRow,
  losers: DedupMemberRow[],
): LinkRepointPlan {
  const loserIdSet = new Set(losers.map((l) => l.id));
  const remap = (id: string): string => (loserIdSet.has(id) ? canonical.id : id);

  const placeholders = losers.map(() => "?").join(", ");
  const loserIds = losers.map((l) => l.id);
  const affectedLinks = db
    .prepare(
      `SELECT source_id, target_id, relationship, strength FROM memory_links
       WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})`,
    )
    .all(...loserIds, ...loserIds) as Array<{
    source_id: string;
    target_id: string;
    relationship: string;
    strength: number;
  }>;

  const existsStmt = db.prepare("SELECT 1 FROM memory_links WHERE source_id = ? AND target_id = ?");
  const plannedPairs = new Set<string>();
  const toAdd: PlannedLink[] = [];
  let skippedSelfLink = 0;
  let skippedExisting = 0;

  for (const link of affectedLinks) {
    const newSource = remap(link.source_id);
    const newTarget = remap(link.target_id);
    // Would-be self-link — e.g. a link between two losers in this same
    // cluster, or a loser already linked to the canonical.
    if (newSource === newTarget) {
      skippedSelfLink++;
      continue;
    }
    const pairKey = `${newSource}|${newTarget}`;
    // Already present on the canonical (in the DB, or already queued by an
    // earlier link in this same plan) — the ordered pair can hold only one
    // edge, so it is skipped and counted, NEVER overwritten.
    if (plannedPairs.has(pairKey) || existsStmt.get(newSource, newTarget)) {
      skippedExisting++;
      continue;
    }
    plannedPairs.add(pairKey);
    toAdd.push({ source: newSource, target: newTarget, relationship: link.relationship, strength: link.strength });
  }

  return { toAdd, skippedSelfLink, skippedExisting };
}

/** One cluster's execution plan from `planDedup` — canonical, losers, members. */
export interface DedupMergePlan {
  canonical: DedupMemberRow;
  losers: DedupMemberRow[];
  /** All member rows, oldest first (CLI preview lines derive from this). */
  membersOldestFirst: DedupMemberRow[];
}

export interface PlanDedupResult {
  /** Every cluster found at the threshold (mergeable + mismatch-skipped). */
  clusterCount: number;
  /** Clusters that passed the metadata rails, in discovery order. */
  mergePlans: DedupMergePlan[];
  mismatchSkipped: DedupMismatchCluster[];
  /** #393 guard-C: clusters set aside on a conflicts-linked member pair. */
  conflictSkipped: DedupConflictCluster[];
}

/**
 * True when ANY member pair of the set holds a `conflicts` link. The member-set
 * IN(...) on both endpoints makes the check symmetric by construction —
 * whichever direction the edge was written in, both ids are in the set. #393
 * guard-C: a conflicts link is the judge's word that two records cannot both
 * be true, so no merge path may ever blend them.
 */
function clusterHasConflictLink(db: Database.Database, memberIds: string[]): boolean {
  if (memberIds.length < 2) return false;
  const placeholders = memberIds.map(() => "?").join(", ");
  const row = db
    .prepare(
      `SELECT 1 FROM memory_links WHERE relationship = 'conflicts'
       AND source_id IN (${placeholders}) AND target_id IN (${placeholders}) LIMIT 1`,
    )
    .get(...memberIds, ...memberIds);
  return !!row;
}

/**
 * Discovery + merge planning at a cosine threshold (read-only — no writes).
 * The ONE clustering core shared by the manual CLI (`runDedup`) and the
 * nightly deterministic merge zone (`runDeterministicMergeZone`): KNN edges
 * (k=10) → union-find clusters → member load → conflicts/metadata-rail
 * classification → canonical pick. Never forked.
 */
export function planDedup(db: Database.Database, threshold: number): PlanDedupResult {
  const edges = buildKnnEdges(db, { k: DEDUP_KNN_K, minCosine: threshold });
  const clusters = clusterEdges(edges, threshold);

  const mergePlans: DedupMergePlan[] = [];
  const mismatchSkipped: DedupMismatchCluster[] = [];
  const conflictSkipped: DedupConflictCluster[] = [];

  for (const memberIds of clusters) {
    const members = loadMembers(db, memberIds);
    if (members.length < 2) continue; // defensive — a member vanished between KNN and load

    // #393 guard-C: the conflicts check runs BEFORE the metadata rails — a
    // conflicts link is the judge's semantic verdict ("never blend"), which
    // outranks the metadata classification; a cluster that is both
    // conflict-linked and metadata-mismatched reports as conflict-skipped
    // (the stronger, semantic reason).
    if (clusterHasConflictLink(db, members.map((m) => m.id))) {
      conflictSkipped.push({ size: members.length, memberIds: members.map((m) => m.id) });
      continue;
    }

    const mismatch = clusterMetadataMismatch(members);
    // #206 decision 2: project is the ONLY rail — the source_agent rail was
    // removed (cross-agent clusters merge; the skip reason is project_mismatch).
    if (mismatch.projectMismatch) {
      mismatchSkipped.push({ size: members.length, memberIds: members.map((m) => m.id), mismatch });
      continue;
    }

    const { canonical, losers } = pickCanonical(members);
    mergePlans.push({
      canonical,
      losers,
      membersOldestFirst: [...members].sort((a, b) => a.created_at.localeCompare(b.created_at)),
    });
  }

  return { clusterCount: clusters.length, mergePlans, mismatchSkipped, conflictSkipped };
}

/**
 * Apply one cluster's merge. Pure DB writes against the passed connection —
 * the caller wraps this in db.transaction() so a mid-merge error rolls back
 * the whole cluster (dup-over-loss: a failed cluster is retried on a later
 * run, never left half-merged).
 *
 * #392 absorb semantics: losers LEAVE RECALL but stay fetchable by id —
 * links re-pointed onto the canonical then deleted from the losers, tags
 * unioned onto the canonical then cleared from the losers (domain NULL),
 * counters summed, a dedup_log row written, and the loser absorbed via
 * storage.absorbMemory (status 'absorbed', vector + FTS rows dropped, plain
 * row retained as evidence). This mirrors the reconsolidation rewrite path's
 * absorb mechanics exactly — one vocabulary, one primitive.
 *
 * Returns the link-repoint plan that was actually applied (computed live,
 * here, against current DB state — NOT a caller-supplied discovery-time
 * snapshot, so it stays correct even if an earlier cluster in the same run
 * already rewrote a link that touches this cluster).
 */
function mergeCluster(
  db: Database.Database,
  canonical: DedupMemberRow,
  losers: DedupMemberRow[],
  injectFailure?: (canonicalId: string) => void,
): LinkRepointPlan {
  // 1. Re-point losers' links onto the canonical.
  const plan = planLinkRepoints(db, canonical, losers);
  for (const link of plan.toAdd) {
    storage.addLink(db, link.source, link.target, link.relationship, link.strength);
  }

  // 2. Delete the losers' own link rows — the pre-#392 delete cascaded them
  // with the row; with the row retained, the stale edges must go explicitly
  // (they were either re-pointed in step 1 or deliberately skipped).
  const deleteLoserLinks = db.prepare(
    "DELETE FROM memory_links WHERE source_id = ? OR target_id = ?",
  );
  for (const loser of losers) deleteLoserLinks.run(loser.id, loser.id);

  // 3. Union tags onto the canonical (reads the losers' tags BEFORE they are
  // cleared below). Weights NULL — the next nightly's reconsolidation pass
  // (recomputeAllTagWeights/refreshPrimaries) recomputes them and the derived
  // primary from the merged tag set.
  const allTags = new Set<string>(storage.getMemoryTags(db, canonical.id));
  for (const loser of losers) {
    for (const tag of storage.getMemoryTags(db, loser.id)) allTags.add(tag);
  }
  if (allTags.size > 0) {
    const tagList = [...allTags];
    storage.setMemoryTags(db, canonical.id, tagList, {
      weights: Object.fromEntries(tagList.map((t) => [t, null])),
    });
  }

  // 4. Clear the losers' tag rows + domain NULL — closest to the old delete
  // semantics: an absorbed loser must not count in moduleIndex/tag recomputes.
  const clearLoserTags = db.prepare("DELETE FROM memory_tags WHERE memory_id = ?");
  for (const loser of losers) {
    clearLoserTags.run(loser.id);
    storage.updateMemory(db, loser.id, { domain: null });
  }

  // 5. Merge counters onto the canonical. promotion_last_count moves WITH the
  // summed access_count (#448): a held baseline would replay the losers'
  // lifetime accesses as fresh promotions on the next nightly run.
  const accessCount = canonical.access_count + losers.reduce((s, l) => s + l.access_count, 0);
  const shownCount = (canonical.shown_count ?? 0) + losers.reduce((s, l) => s + (l.shown_count ?? 0), 0);
  const lastAccessed = [canonical, ...losers]
    .map((m) => m.last_accessed)
    .filter((v): v is string => Boolean(v))
    .sort()
    .pop();
  const baseStrength = Math.max(canonical.base_strength, ...losers.map((l) => l.base_strength));
  storage.updateMemory(db, canonical.id, {
    access_count: accessCount,
    shown_count: shownCount,
    ...(lastAccessed ? { last_accessed: lastAccessed } : {}),
    base_strength: baseStrength,
    promotion_last_count: accessCount,
  });

  injectFailure?.(canonical.id);

  // 6. Audit trail (dedup_log is the merge record — and the only surviving
  // marker of a loser's source_session) then absorb each loser (never delete:
  // the row stays as evidence, session lineage, and the dedup_log companion).
  const mergedAt = new Date().toISOString();
  const logStmt = db.prepare(
    `INSERT OR REPLACE INTO dedup_log (loser_id, canonical_id, source_session, content_head, merged_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  for (const loser of losers) {
    logStmt.run(loser.id, canonical.id, loser.source_session, loser.content.slice(0, 200), mergedAt);
    storage.absorbMemory(db, loser.id);
  }

  return plan;
}

export type MergeMemoryIdsResult =
  | { ok: true; canonicalId: string; loserIds: string[]; linksRepointed: number }
  | { ok: false; reason: "project_mismatch" | "conflict_linked" | "no_members" };

/**
 * Merge an explicit set of memories (the judged-pair phase of #392: the
 * reconsolidation stage queues verdict-confirmed pairs and applies them
 * through THIS function so the merge math stays single-definition). Loads the
 * LIVE rows at apply time — members that vanished or were absorbed between
 * verdict and apply are dropped defensively; a project disagreement refuses
 * the merge (both memories stay live — the only metadata rail left, #206
 * decision 2); a conflicts-linked pair refuses it exactly the same way
 * (#393 guard-C). One transaction for the whole set.
 */
export function mergeMemoryIds(db: Database.Database, ids: string[]): MergeMemoryIdsResult {
  const unique = [...new Set(ids)];
  const members = loadMembers(db, unique).filter((m) => m.status !== "absorbed");
  if (members.length < 2) return { ok: false, reason: "no_members" };

  // #393 guard-C: a conflicts-linked pair is never blended — the mirror of the
  // project rail (both memories stay live; the caller's verdict was still
  // rendered, so its cursor advances).
  if (clusterHasConflictLink(db, members.map((m) => m.id))) {
    return { ok: false, reason: "conflict_linked" };
  }

  const mismatch = clusterMetadataMismatch(members);
  if (mismatch.projectMismatch) {
    return { ok: false, reason: "project_mismatch" };
  }

  const { canonical, losers } = pickCanonical(members);
  const tx = db.transaction(() => mergeCluster(db, canonical, losers));
  const plan = tx();
  return {
    ok: true,
    canonicalId: canonical.id,
    loserIds: losers.map((l) => l.id),
    linksRepointed: plan.toAdd.length,
  };
}

// ---------------------------------------------------------------------------
// Pre-merge backup (shared by the CLI and the nightly zone)
// ---------------------------------------------------------------------------

/**
 * Take a pre-merge DB backup to <stateDir>/backups/pre-dedup-<ISO>.db and
 * prune older pre-dedup backups to `backupRetention` (config, default 7;
 * pattern-scoped so full `hicortex-*.tar.gz` artifacts keep their own,
 * independent retention count). THROWS on failure — the callers own the
 * policy: the CLI aborts, the nightly zone is fail-soft. Returns the path.
 */
export async function takePreDedupBackup(
  db: Database.Database,
  stateDir: string,
  config?: Record<string, unknown> | null,
): Promise<string> {
  const backupDir = join(stateDir, "backups");
  mkdirSync(backupDir, { recursive: true });
  const backupPath = join(backupDir, `pre-dedup-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
  await db.backup(backupPath);
  const retention = readNonNegativeConfig(config ?? {}, "backupRetention", DEFAULT_BACKUP_RETENTION);
  pruneBackupArtifacts(backupDir, retention, PRE_DEDUP_BACKUP_PATTERN);
  return backupPath;
}

// ---------------------------------------------------------------------------
// The deterministic merge zone (#392)
// ---------------------------------------------------------------------------

export interface DeterministicMergeZoneOptions {
  /** State dir (lock + backup + band-stats persistence). Defaults to ~/.hicortex. */
  stateDir?: string;
  /** Cosine ceiling; validated (0,1] → DEFAULT_DEDUP_MERGE_THRESHOLD. */
  threshold?: number;
  /** Discovery + bounded preview only — zero writes, no lock, no backup. */
  dryRun?: boolean;
  /** Config override (backupRetention) — defaults to reading stateDir/config.json. */
  config?: Record<string, unknown> | null;
  /** Capture-lock acquirer override (tests). Defaults to the real capture.ts lock. */
  acquireLock?: typeof acquireCaptureLock;
  /**
   * The run-wide pipeline deadline (#405) — checked BETWEEN cluster merges
   * (each merge is a local transaction, so the boundary is safe). On expiry
   * the un-attempted clusters count as deadline_deferred and drain next run
   * (re-discovery is structural: the pairs stay above the threshold).
   */
  deadline?: RunDeadline;
}

/**
 * The >= dedupAutoMergeThreshold band of the unified resolution pass (#392):
 * planDedup discovery + per-cluster mergeCluster — LLM-free, budget-free, so
 * an LLM-less night still drains duplicates. Its own short capture-lock
 * window and pre-merge backup; fail-soft on a busy lock (lock_busy) and on a
 * backup failure (backup_failed) — zero merges either way, never a throw.
 *
 * Also persists the deterministic band's cumulative statistics to state.json
 * `resolutionBandStats` (label `>=threshold`; losers count as merge verdicts
 * at confidence 1.0, mismatch clusters as project_skipped) — skipped
 * entirely on dry-run. Called from the reconsolidation stage (main path) and
 * from runConsolidation's quiet-night skip path — exactly one of the two per
 * run.
 */
export async function runDeterministicMergeZone(
  db: Database.Database,
  opts: DeterministicMergeZoneOptions = {},
): Promise<DeterministicMergeZoneReport> {
  const validNumber = (v: unknown, fallback: number, ok: (n: number) => boolean): number => {
    const n = Number(v);
    return Number.isFinite(n) && ok(n) ? n : fallback;
  };
  const threshold = validNumber(opts.threshold, DEFAULT_DEDUP_MERGE_THRESHOLD, (n) => n > 0 && n <= 1);
  const stateDir = opts.stateDir ?? HICORTEX_HOME;
  const dryRun = opts.dryRun ?? false;

  try {
    const plan = planDedup(db, threshold);
    const report: DeterministicMergeZoneReport = {
      threshold,
      clusters_found: plan.clusterCount,
      mergeable_clusters: plan.mergePlans.length,
      merged_clusters: 0,
      losers_merged: 0,
      links_repointed: 0,
      skipped_project_mismatch: plan.mismatchSkipped.length,
      skipped_conflict: plan.conflictSkipped.length,
      capped: 0,
      failed: 0,
    };

    // Dry-run: discovery counts + a bounded preview (first 10 clusters) only —
    // zero writes, no lock, no backup, no state.json persistence.
    if (dryRun) {
      report.preview = plan.mergePlans.slice(0, 10).map((p) => ({
        size: p.membersOldestFirst.length,
        canonical_id: p.canonical.id,
        loser_ids: p.losers.map((l) => l.id),
      }));
      return report;
    }

    // Cumulative deterministic-band stats (state.json) — one write at zone
    // end, on every apply-path exit, never when there is nothing to record.
    const persistBand = (): void => {
      if (report.losers_merged === 0 && report.skipped_project_mismatch === 0) return;
      updateState((s) => {
        const label = `>=${threshold}`;
        const bands = s.resolutionBandStats ?? {};
        const b = bands[label] ?? {
          pairs: 0, merge: 0, corrects: 0, supersedes: 0, conflicts: 0, none: 0,
          merge_below_gate: 0, conf_sum: 0,
        };
        bands[label] = {
          ...b,
          pairs: b.pairs + report.losers_merged,
          merge: b.merge + report.losers_merged,
          // Deterministic merges carry no verdict — model confidence 1.0 each
          // (the calibration line: measured ~100% same-memory at the ceiling).
          conf_sum: b.conf_sum + report.losers_merged,
          project_skipped: (b.project_skipped ?? 0) + report.skipped_project_mismatch,
        } satisfies ResolutionBandStat;
        s.resolutionBandStats = bands;
      }, stateDir);
    };

    // Idle corpus: nothing mergeable at the ceiling — no lock window, no
    // backup (a clean corpus pays discovery only; the metadata rails' skips
    // still record in the band stats). This is the common nightly case.
    if (plan.mergePlans.length === 0) {
      persistBand();
      return report;
    }

    // Short single-flight lock window (waitMs 0): a busy capture/nightly run
    // defers the whole zone to the next run — fail-soft, never a wait.
    const acquire = opts.acquireLock ?? acquireCaptureLock;
    const release = await acquire(stateDir, 0);
    if (!release) {
      report.lock_busy = true;
      persistBand();
      console.warn(
        `[hicortex] deterministic-merge zone: capture lock busy — zero merges this run (retried next run).`,
      );
      return report;
    }

    try {
      // Backup FIRST — abort all merges (fail-soft) if it fails.
      let backupPath: string;
      try {
        const config = opts.config !== undefined ? opts.config : readConfig(stateDir);
        backupPath = await takePreDedupBackup(db, stateDir, config);
      } catch (err) {
        report.backup_failed = true;
        console.error(
          `[hicortex] deterministic-merge zone: pre-merge backup failed ` +
            `(${err instanceof Error ? err.message : String(err)}) — zero merges attempted.`,
        );
        persistBand();
        return report;
      }
      report.backup_path = backupPath;

      // Discovery order. #405: no pacing slice — the deadline stop-check
      // below is the only bound (the deferred clusters count as
      // deadline_deferred/capped and drain next run; re-discovery is
      // content-based, so they re-appear).
      const toAttempt = plan.mergePlans;

      for (let pi = 0; pi < toAttempt.length; pi++) {
        const p = toAttempt[pi];
        // #405: stop-check between cluster merges — each merge is a local
        // transaction, so this is a safe boundary. The un-attempted clusters
        // drain next run (discovery is content-based, so they re-appear).
        if (opts.deadline?.hit("dedup_merge_zone")) {
          report.deadline_deferred = toAttempt.length - pi;
          report.capped += toAttempt.length - pi;
          console.warn(
            `[hicortex] deterministic-merge zone: run deadline reached — ` +
              `${report.deadline_deferred} cluster merge(s) deferred to the next run`,
          );
          break;
        }
        try {
          const tx = db.transaction(() => mergeCluster(db, p.canonical, p.losers));
          const appliedPlan = tx();
          report.merged_clusters++;
          report.losers_merged += p.losers.length;
          report.links_repointed += appliedPlan.toAdd.length;
        } catch (err) {
          report.failed++;
          console.error(
            `[hicortex] deterministic-merge zone: cluster merge FAILED (canonical ` +
              `${p.canonical.id.slice(0, 8)}): ${err instanceof Error ? err.message : String(err)} ` +
              `— rolled back, left for a re-run`,
          );
        }
      }

      console.log(
        `[hicortex] deterministic-merge zone (>= ${threshold}): ${report.merged_clusters}/${plan.mergePlans.length} ` +
          `cluster(s) merged, ${report.losers_merged} loser(s) absorbed, ` +
          `${report.skipped_project_mismatch} skipped (project mismatch), ` +
          `${report.skipped_conflict} skipped (conflict-flagged)` +
          (report.capped > 0 ? `, ${report.capped} deferred (run deadline)` : "") +
          (report.failed > 0 ? `, ${report.failed} FAILED` : ""),
      );

      persistBand();
      return report;
    } finally {
      release();
    }
  } catch (err) {
    // Total fail-soft: the zone must never take the nightly down. A
    // discovery-level failure is logged and reported as an empty run.
    console.error(
      `[hicortex] deterministic-merge zone failed: ${err instanceof Error ? err.message : String(err)} ` +
        `(no merges attempted; retried next run).`,
    );
    return {
      threshold, clusters_found: 0, mergeable_clusters: 0,
      merged_clusters: 0, losers_merged: 0, links_repointed: 0,
      skipped_project_mismatch: 0, skipped_conflict: 0, capped: 0, failed: 0,
    };
  }
}

// ---------------------------------------------------------------------------
// The manual CLI (`hicortex dedup`)
// ---------------------------------------------------------------------------

/**
 * Run `hicortex dedup`. Dry run by default (options.apply falsy) — discovery
 * + merge planning only, zero writes. `options.apply` executes: backup, then
 * one transaction per cluster. Fails fast (throws) on a busy capture lock or
 * a failed backup — a deliberate manual command should be retried by the
 * operator, not silently deferred (the nightly zone is the fail-soft twin).
 */
export async function runDedup(options: DedupOptions = {}): Promise<DedupReport> {
  const stateDir = options.stateDir ?? HICORTEX_HOME;
  const config = options.config !== undefined ? options.config : readConfig(stateDir);

  // Server-mode only — client installs have no local DB.
  if (config?.mode === "client") {
    throw new Error(
      "[hicortex] dedup is server-mode only (it needs the local DB). " +
        `This machine is a client of ${config.serverUrl ?? "a remote server"} — run dedup on the server.`,
    );
  }

  const threshold = resolveThreshold(options.threshold);
  const apply = options.apply ?? false;
  const dbPath = resolveDbPath(options.dbPath);
  const db = initDb(dbPath);

  try {
    console.log(
      `[hicortex] dedup starting (${apply ? "APPLY" : "dry-run"}): threshold ${threshold}, db ${dbPath}`,
    );

    // Shared discovery core (planDedup) — the manual CLI and the nightly
    // zone must never disagree on what a cluster is.
    const plan = planDedup(db, threshold);

    const mergeable: DedupClusterPlan[] = [];
    for (const p of plan.mergePlans) {
      // Read-only preview against the CURRENT DB state — see planLinkRepoints
      // for why apply recomputes this live rather than reusing this snapshot.
      const linkPlan = planLinkRepoints(db, p.canonical, p.losers);
      mergeable.push({
        size: p.membersOldestFirst.length,
        canonicalId: p.canonical.id,
        loserIds: p.losers.map((l) => l.id),
        members: p.membersOldestFirst.map((m) => ({
          id: m.id,
          created_at: m.created_at,
          access_count: m.access_count,
          preview: m.content.slice(0, 80),
        })),
        linksRepointed: linkPlan.toAdd.length,
        linksSkippedSelfLink: linkPlan.skippedSelfLink,
        linksSkippedExisting: linkPlan.skippedExisting,
      });
    }

    const plannedMerges = mergeable.reduce((s, c) => s + c.loserIds.length, 0);
    const linksSkippedExistingPreview = mergeable.reduce((s, c) => s + c.linksSkippedExisting, 0);

    const report: DedupReport = {
      dryRun: !apply,
      threshold,
      clusterCount: plan.clusterCount,
      mergeable,
      mismatchSkipped: plan.mismatchSkipped,
      conflictSkipped: plan.conflictSkipped,
      plannedMerges,
      linksSkippedExisting: linksSkippedExistingPreview,
    };

    console.log(
      `[hicortex] dedup: ${plan.clusterCount} cluster(s) found, ${mergeable.length} mergeable ` +
        `(${plannedMerges} row(s) would be absorbed), ${plan.mismatchSkipped.length} skipped (project mismatch), ` +
        `${plan.conflictSkipped.length} skipped (conflict-flagged), ` +
        `${linksSkippedExistingPreview} link(s) would be skipped (existing edge on the canonical)`,
    );

    if (!apply) {
      for (const c of mergeable) {
        console.log(
          `[hicortex]   cluster size ${c.size}: canonical ${c.canonicalId.slice(0, 8)}, ` +
            `losers ${c.loserIds.map((id) => id.slice(0, 8)).join(", ")}, ` +
            `links: ${c.linksRepointed} to re-point, ${c.linksSkippedExisting} skipped (existing edge), ` +
            `${c.linksSkippedSelfLink} skipped (self-link)`,
        );
      }
      for (const c of plan.mismatchSkipped) {
        // #206 decision 2: project_mismatch is the only skip reason left on
        // this rail (the source_agent rail was removed) — the bedrock dry run
        // sizes the project rail alone off this line.
        console.log(
          `[hicortex]   SKIPPED (project_mismatch): ${c.memberIds.map((id) => id.slice(0, 8)).join(", ")}`,
        );
      }
      // #393 guard-C: listed for review like the mismatch clusters — a
      // conflicts-linked near-duplicate pair is deliberate, not an error.
      for (const c of plan.conflictSkipped) {
        console.log(
          `[hicortex]   SKIPPED (conflict-flagged): ${c.memberIds.map((id) => id.slice(0, 8)).join(", ")}`,
        );
      }
      return report;
    }

    // --apply: acquire the single-flight capture lock so a concurrent
    // nightly/capture run can't race the merge's dedup_log writes. Fails fast
    // (waitMs 0) — dedup is a deliberate manual command; a busy nightly should
    // be retried later, not silently waited on.
    const acquireLock = options.acquireLock ?? acquireCaptureLock;
    const releaseLock = await acquireLock(stateDir, 0);
    if (!releaseLock) {
      throw new Error(
        "[hicortex] dedup --apply aborted: another capture/nightly run holds the lock. Retry when it finishes.",
      );
    }

    try {
      // Backup FIRST — abort entirely (no merges attempted) if it fails.
      let backupPath: string;
      try {
        backupPath = await takePreDedupBackup(db, stateDir, config);
      } catch (err) {
        throw new Error(
          `[hicortex] dedup --apply aborted: backup failed (${err instanceof Error ? err.message : String(err)}). No merges attempted.`,
        );
      }
      console.log(`[hicortex] Backup written: ${backupPath}`);
      report.backupPath = backupPath;

      let merged = 0;
      let losersAbsorbed = 0;
      let failedClusters = 0;
      // Recomputed from the ACTUAL, live per-cluster merges below (may differ
      // from the discovery-time preview if an earlier cluster in this same
      // run rewrote a link that a later cluster's plan also touches).
      let linksSkippedExistingApplied = 0;

      for (const p of plan.mergePlans) {
        try {
          const tx = db.transaction(() =>
            mergeCluster(db, p.canonical, p.losers, options._injectFailureAfterWrites),
          );
          const appliedPlan = tx();
          merged++;
          losersAbsorbed += p.losers.length;
          linksSkippedExistingApplied += appliedPlan.skippedExisting;
          console.log(
            `[hicortex]   merged cluster: canonical ${p.canonical.id.slice(0, 8)} absorbed ${p.losers.length} loser(s), ` +
              `${appliedPlan.toAdd.length} link(s) re-pointed, ${appliedPlan.skippedExisting} skipped (existing edge)`,
          );
        } catch (err) {
          failedClusters++;
          console.error(
            `[hicortex]   cluster merge FAILED (canonical ${p.canonical.id.slice(0, 8)}): ` +
              `${err instanceof Error ? err.message : String(err)} — rolled back, left for a re-run`,
          );
        }
      }

      report.merged = merged;
      report.losersAbsorbed = losersAbsorbed;
      report.failedClusters = failedClusters;
      report.linksSkippedExisting = linksSkippedExistingApplied;

      console.log(
        `[hicortex] dedup complete: ${merged} cluster(s) merged, ${losersAbsorbed} loser(s) absorbed ` +
          `(hidden from recall, kept as evidence)` +
          (failedClusters > 0 ? `, ${failedClusters} cluster(s) FAILED (see errors above)` : ""),
      );

      return report;
    } finally {
      releaseLock();
    }
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// /distill dedup_log consultation (shared with mcp-server.ts)
// ---------------------------------------------------------------------------
//
// A merged-away loser's `source_session` marker is recorded in `dedup_log`
// (see mergeCluster above). Since #392 the loser row itself is retained
// (absorbed, not deleted), so the marker survives on the row too — but
// pre-#392 merges DELETED their losers, and /distill's dedup prechecks must
// consult BOTH tables so a `--recapture-window` run (or any retried capture)
// can never re-ingest content a dedup merge already consolidated regardless
// of which era merged it.

/** Escape SQL LIKE wildcards — session ids (e.g. Hermes) can contain "_"/"%". */
export function escapeLikeSessionId(s: string): string {
  return s.replace(/[\\%_]/g, (m) => "\\" + m);
}

/**
 * Count of memories + dedup_log rows matching an exact segment
 * (`<sid>#<segment_id>#<i>`). Mirrors the /distill segment-exact precheck.
 */
export function countExistingSegment(db: Database.Database, sessionId: string, segmentId: string): number {
  const likePrefix = `${escapeLikeSessionId(sessionId)}#${escapeLikeSessionId(segmentId)}#%`;
  const memCount = (
    db.prepare("SELECT COUNT(*) as c FROM memories WHERE source_session LIKE ? ESCAPE '\\'").get(likePrefix) as {
      c: number;
    }
  ).c;
  const logCount = (
    db.prepare("SELECT COUNT(*) as c FROM dedup_log WHERE source_session LIKE ? ESCAPE '\\'").get(likePrefix) as {
      c: number;
    }
  ).c;
  return memCount + logCount;
}

/**
 * Count of memories + dedup_log rows matching a whole legacy session (exact
 * id, or any `<sid>#...` chunk). Mirrors the /distill legacy session-level
 * precheck.
 */
export function countExistingSession(db: Database.Database, sessionId: string): number {
  const likePrefix = `${escapeLikeSessionId(sessionId)}#%`;
  const memCount = (
    db
      .prepare("SELECT COUNT(*) as c FROM memories WHERE source_session = ? OR source_session LIKE ? ESCAPE '\\'")
      .get(sessionId, likePrefix) as { c: number }
  ).c;
  const logCount = (
    db
      .prepare("SELECT COUNT(*) as c FROM dedup_log WHERE source_session = ? OR source_session LIKE ? ESCAPE '\\'")
      .get(sessionId, likePrefix) as { c: number }
  ).c;
  return memCount + logCount;
}
