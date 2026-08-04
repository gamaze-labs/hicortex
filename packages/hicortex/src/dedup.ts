/**
 * `hicortex dedup` — cluster + merge near-duplicate memories (issue #100).
 *
 * Corpus-quality companion to `hicortex relink`/`classify-domains`: instead of
 * discovering NEW structure, this command collapses memories that are
 * near-identical (top-10 KNN cosine >= dedupMergeThreshold, default 0.92,
 * union-find clustered — same math as the #191 D1 duplicate-rate audit; see
 * cluster.ts). Default is a DRY RUN: report only, zero writes. `--apply`
 * executes the merge.
 *
 * Per cluster:
 *   - Canonical = highest access_count (tie: oldest created_at, then
 *     lexicographically smallest id — fully deterministic for audit).
 *   - Losers' links are re-pointed onto the canonical (a link that would
 *     become a self-link, or one whose (canonical, target) ordered pair
 *     ALREADY holds an edge, is skipped rather than overwritten — see
 *     planLinkRepoints for why `relationship` cannot be part of that guard).
 *   - canonical.access_count/shown_count = summed across the cluster;
 *     last_accessed = max; base_strength = max.
 *   - Tags are UNIONED onto the canonical (weights NULL — the next nightly's
 *     reconsolidation pass recomputes weights and the derived primary from
 *     the merged tag set).
 *   - A `dedup_log` row is written per loser BEFORE it is deleted — audit
 *     trail AND the safety net /distill consults (mcp-server.ts) so a
 *     deleted loser's `source_session` marker still blocks a re-ingest.
 *   - Losers are deleted via storage.deleteMemory (cascades links/tags/
 *     vectors/FTS).
 *
 * A cluster whose members disagree on project, privacy, or source_agent is
 * SKIPPED entirely and listed for manual review — no --force in this release.
 *
 * Safety rails on --apply:
 *   - A full DB backup (SQLite backup API) is taken FIRST, to
 *     ~/.hicortex/backups/pre-dedup-<ISO>.db. Abort (no merges attempted) if
 *     the backup fails.
 *   - The existing single-flight capture lock (capture.ts) is held for the
 *     duration of the merge so a concurrent nightly/capture run can't race
 *     the dedup_log bookkeeping the merge relies on.
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

const HICORTEX_HOME = hicortexHome();

/**
 * Default merge threshold. Measured on the #191 mechanical audit corpus:
 * 89 clusters / 110 excess rows at 0.92 (data/audit-20260729/eval-report.md).
 */
export const DEFAULT_DEDUP_MERGE_THRESHOLD = 0.92;

/** KNN neighbors considered per memory — same as the #191 audit (cluster.ts default). */
const DEDUP_KNN_K = 10;

function readConfig(stateDir: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(join(stateDir, "config.json"), "utf-8"));
  } catch {
    return null;
  }
}

function resolveThreshold(explicit: number | undefined, config: Record<string, unknown> | null): number {
  if (explicit !== undefined) {
    if (!Number.isFinite(explicit) || explicit <= 0 || explicit > 1) {
      throw new Error(`[hicortex] dedup: invalid --threshold value: ${explicit} (must be in (0, 1])`);
    }
    return explicit;
  }
  const fromConfig = Number(config?.dedupMergeThreshold);
  return Number.isFinite(fromConfig) && fromConfig > 0 && fromConfig <= 1
    ? fromConfig
    : DEFAULT_DEDUP_MERGE_THRESHOLD;
}

// ---------------------------------------------------------------------------
// Cluster loading + merge decision
// ---------------------------------------------------------------------------

/**
 * Row shape read from `memories` for merge decisions — a superset of the
 * fields the Memory type declares (shown_count isn't on that interface yet).
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

export interface DedupReport {
  dryRun: boolean;
  threshold: number;
  /** Every cluster found at the threshold (mergeable + mismatch-skipped). */
  clusterCount: number;
  mergeable: DedupClusterPlan[];
  mismatchSkipped: DedupMismatchCluster[];
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
  /** --apply only: loser rows deleted. */
  losersDeleted?: number;
  /** --apply only: clusters that errored mid-merge (rolled back; left for a re-run). */
  failedClusters?: number;
  /** --apply only: path to the pre-merge backup. */
  backupPath?: string;
}

export interface DedupOptions {
  /** Execute the merge. Default false = dry run (report only, zero writes). */
  apply?: boolean;
  /** Override config.dedupMergeThreshold for one run. */
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
   * link/tag/counter writes but before the audit-log + delete step. Throwing
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
              created_at, project, privacy, source_agent, source_session
       FROM memories WHERE id IN (${placeholders})`,
    )
    .all(...ids) as DedupMemberRow[];
}

/** Canonical = highest access_count; ties broken by oldest created_at, then lexicographically smallest id. */
function pickCanonical(members: DedupMemberRow[]): { canonical: DedupMemberRow; losers: DedupMemberRow[] } {
  const sorted = [...members].sort((a, b) => {
    if (b.access_count !== a.access_count) return b.access_count - a.access_count;
    if (a.created_at !== b.created_at) return a.created_at.localeCompare(b.created_at);
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

/**
 * Apply one cluster's merge. Pure DB writes against the passed connection —
 * the caller wraps this in db.transaction() so a mid-merge error rolls back
 * the whole cluster (dup-over-loss: a failed cluster is retried on a later
 * `dedup --apply`, never left half-merged).
 *
 * Returns the link-repoint plan that was actually applied (computed live,
 * here, against current DB state — NOT a caller-supplied discovery-time
 * snapshot, so it stays correct even if an earlier cluster in the same
 * --apply run already rewrote a link that touches this cluster).
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

  // 2. Union tags onto the canonical. Weights NULL — the next nightly's
  // reconsolidation pass (recomputeAllTagWeights/refreshPrimaries) recomputes
  // them and the derived primary from the merged tag set.
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

  // 3. Merge counters onto the canonical.
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
  });

  injectFailure?.(canonical.id);

  // 4. Audit trail (BEFORE delete — dedup_log is the only surviving record of
  // a loser's source_session) then delete each loser (cascades links/tags/
  // vectors/FTS via storage.deleteMemory).
  const mergedAt = new Date().toISOString();
  const logStmt = db.prepare(
    `INSERT OR REPLACE INTO dedup_log (loser_id, canonical_id, source_session, content_head, merged_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  for (const loser of losers) {
    logStmt.run(loser.id, canonical.id, loser.source_session, loser.content.slice(0, 200), mergedAt);
    storage.deleteMemory(db, loser.id);
  }

  return plan;
}

/**
 * Run `hicortex dedup`. Dry run by default (options.apply falsy) — discovery
 * + merge planning only, zero writes. `options.apply` executes: backup, then
 * one transaction per cluster.
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

  const threshold = resolveThreshold(options.threshold, config);
  const apply = options.apply ?? false;
  const dbPath = resolveDbPath(options.dbPath);
  const db = initDb(dbPath);

  try {
    console.log(
      `[hicortex] dedup starting (${apply ? "APPLY" : "dry-run"}): threshold ${threshold}, db ${dbPath}`,
    );

    const edges = buildKnnEdges(db, { k: DEDUP_KNN_K, minCosine: threshold });
    const clusters = clusterEdges(edges, threshold);

    const mergeable: DedupClusterPlan[] = [];
    const mismatchSkipped: DedupMismatchCluster[] = [];
    const plans: Array<{ canonical: DedupMemberRow; losers: DedupMemberRow[] }> = [];

    for (const memberIds of clusters) {
      const members = loadMembers(db, memberIds);
      if (members.length < 2) continue; // defensive — a member vanished between KNN and load

      const mismatch = clusterMetadataMismatch(members);
      if (mismatch.projectMismatch || mismatch.sourceAgentMismatch) {
        mismatchSkipped.push({ size: members.length, memberIds: members.map((m) => m.id), mismatch });
        continue;
      }

      const { canonical, losers } = pickCanonical(members);
      plans.push({ canonical, losers });
      // Read-only preview against the CURRENT DB state — see planLinkRepoints
      // for why apply recomputes this live rather than reusing this snapshot.
      const linkPlan = planLinkRepoints(db, canonical, losers);
      mergeable.push({
        size: members.length,
        canonicalId: canonical.id,
        loserIds: losers.map((l) => l.id),
        members: [...members]
          .sort((a, b) => a.created_at.localeCompare(b.created_at))
          .map((m) => ({
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
      clusterCount: clusters.length,
      mergeable,
      mismatchSkipped,
      plannedMerges,
      linksSkippedExisting: linksSkippedExistingPreview,
    };

    console.log(
      `[hicortex] dedup: ${clusters.length} cluster(s) found, ${mergeable.length} mergeable ` +
        `(${plannedMerges} row(s) would be removed), ${mismatchSkipped.length} skipped (metadata mismatch), ` +
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
      for (const c of mismatchSkipped) {
        const reasons = Object.entries(c.mismatch)
          .filter(([, v]) => v)
          .map(([k]) => k)
          .join(", ");
        console.log(
          `[hicortex]   SKIPPED (${reasons}): ${c.memberIds.map((id) => id.slice(0, 8)).join(", ")}`,
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
      const backupDir = join(stateDir, "backups");
      mkdirSync(backupDir, { recursive: true });
      const backupPath = join(backupDir, `pre-dedup-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
      try {
        await db.backup(backupPath);
      } catch (err) {
        throw new Error(
          `[hicortex] dedup --apply aborted: backup failed (${err instanceof Error ? err.message : String(err)}). No merges attempted.`,
        );
      }
      console.log(`[hicortex] Backup written: ${backupPath}`);
      report.backupPath = backupPath;

      let merged = 0;
      let losersDeleted = 0;
      let failedClusters = 0;
      // Recomputed from the ACTUAL, live per-cluster merges below (may differ
      // from the discovery-time preview if an earlier cluster in this same
      // run rewrote a link that a later cluster's plan also touches).
      let linksSkippedExistingApplied = 0;

      for (const plan of plans) {
        try {
          const tx = db.transaction(() =>
            mergeCluster(db, plan.canonical, plan.losers, options._injectFailureAfterWrites),
          );
          const appliedPlan = tx();
          merged++;
          losersDeleted += plan.losers.length;
          linksSkippedExistingApplied += appliedPlan.skippedExisting;
          console.log(
            `[hicortex]   merged cluster: canonical ${plan.canonical.id.slice(0, 8)} absorbed ${plan.losers.length} loser(s), ` +
              `${appliedPlan.toAdd.length} link(s) re-pointed, ${appliedPlan.skippedExisting} skipped (existing edge)`,
          );
        } catch (err) {
          failedClusters++;
          console.error(
            `[hicortex]   cluster merge FAILED (canonical ${plan.canonical.id.slice(0, 8)}): ` +
              `${err instanceof Error ? err.message : String(err)} — rolled back, left for a re-run`,
          );
        }
      }

      report.merged = merged;
      report.losersDeleted = losersDeleted;
      report.failedClusters = failedClusters;
      report.linksSkippedExisting = linksSkippedExistingApplied;

      console.log(
        `[hicortex] dedup complete: ${merged} cluster(s) merged, ${losersDeleted} loser(s) deleted` +
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
// A merged-away loser's `source_session` marker moves to `dedup_log` (see
// mergeCluster above) before the memories row is deleted. /distill's dedup
// prechecks must therefore consult BOTH tables — otherwise a
// `--recapture-window` run (or any retried capture) could re-ingest content a
// dedup merge already consolidated, because the only memories row carrying
// that session's marker is gone.

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
