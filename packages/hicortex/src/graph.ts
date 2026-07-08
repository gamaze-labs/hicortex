/**
 * Graph analysis for the memory link network.
 *
 * Pure-JS Louvain community detection + hub node identification.
 * Operates on the memory_links table without external dependencies.
 *
 * Louvain algorithm: iteratively merges nodes into communities to maximize
 * modularity. Produces quality comparable to Leiden for the graph sizes
 * we deal with (hundreds to low thousands of nodes).
 */

import type Database from "better-sqlite3";
import type { MemoryLink } from "./types.js";
import { effectiveStrength } from "./retrieval.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GraphCommunity {
  id: number;
  members: string[];   // memory IDs
  size: number;
}

export interface HubNode {
  id: string;
  linkCount: number;
  project: string | null;
  domain: string | null;
  content: string;
}

export interface GraphAnalysis {
  communities: GraphCommunity[];
  hubs: HubNode[];
  nodeCount: number;
  edgeCount: number;
  modularity: number;
}

// ---------------------------------------------------------------------------
// Graph loading
// ---------------------------------------------------------------------------

interface AdjEntry { neighbor: string; weight: number }

function loadGraph(db: Database.Database): {
  adj: Map<string, AdjEntry[]>;
  nodes: Set<string>;
  edgeCount: number;
} {
  const rows = db
    .prepare("SELECT source_id, target_id, strength FROM memory_links")
    .all() as Array<{ source_id: string; target_id: string; strength: number }>;

  const adj = new Map<string, AdjEntry[]>();
  const nodes = new Set<string>();

  for (const { source_id, target_id, strength } of rows) {
    nodes.add(source_id);
    nodes.add(target_id);
    const w = strength || 0.5;

    if (!adj.has(source_id)) adj.set(source_id, []);
    adj.get(source_id)!.push({ neighbor: target_id, weight: w });

    if (!adj.has(target_id)) adj.set(target_id, []);
    adj.get(target_id)!.push({ neighbor: source_id, weight: w });
  }

  return { adj, nodes, edgeCount: rows.length };
}

// ---------------------------------------------------------------------------
// Louvain community detection
// ---------------------------------------------------------------------------

/**
 * Compute modularity of the current partition.
 * Q = (1/2m) * sum_ij [ A_ij - k_i*k_j/(2m) ] * delta(c_i, c_j)
 */
function computeModularity(
  adj: Map<string, AdjEntry[]>,
  community: Map<string, number>,
  totalWeight: number,
): number {
  if (totalWeight === 0) return 0;
  const m2 = 2 * totalWeight;
  let q = 0;

  for (const [node, neighbors] of adj) {
    const ki = neighbors.reduce((s, e) => s + e.weight, 0);
    const ci = community.get(node)!;
    for (const { neighbor, weight } of neighbors) {
      const kj = adj.get(neighbor)?.reduce((s, e) => s + e.weight, 0) ?? 0;
      const cj = community.get(neighbor)!;
      if (ci === cj) {
        q += weight - (ki * kj) / m2;
      }
    }
  }

  return q / m2;
}

/**
 * Run Louvain community detection. Returns community assignments.
 */
export function louvainCommunities(
  db: Database.Database,
): { communities: GraphCommunity[]; modularity: number; nodeCount: number; edgeCount: number } {
  const { adj, nodes, edgeCount } = loadGraph(db);

  if (nodes.size === 0) {
    return { communities: [], modularity: 0, nodeCount: 0, edgeCount: 0 };
  }

  const totalWeight = [...adj.values()]
    .reduce((s, edges) => s + edges.reduce((s2, e) => s2 + e.weight, 0), 0) / 2;

  // Initialize: each node in its own community
  const community = new Map<string, number>();
  let nextId = 0;
  for (const node of nodes) {
    community.set(node, nextId++);
  }

  // Phase 1: local moves — repeatedly move nodes to neighbor community with best modularity gain
  let improved = true;
  let iterations = 0;
  const MAX_ITERATIONS = 50;

  while (improved && iterations < MAX_ITERATIONS) {
    improved = false;
    iterations++;

    for (const node of nodes) {
      const currentComm = community.get(node)!;
      const neighbors = adj.get(node) ?? [];

      // Compute weight to each neighbor community
      const commWeights = new Map<number, number>();
      for (const { neighbor, weight } of neighbors) {
        const nc = community.get(neighbor)!;
        commWeights.set(nc, (commWeights.get(nc) ?? 0) + weight);
      }

      // Find best community to move to
      let bestComm = currentComm;
      let bestGain = 0;
      const ki = neighbors.reduce((s, e) => s + e.weight, 0);

      for (const [targetComm, weightToComm] of commWeights) {
        if (targetComm === currentComm) continue;
        // Simplified modularity gain: delta_Q ~ weight_to_comm - ki * sum_comm / (2m)
        const sumComm = [...community.entries()]
          .filter(([, c]) => c === targetComm)
          .reduce((s, [n]) => s + (adj.get(n)?.reduce((s2, e) => s2 + e.weight, 0) ?? 0), 0);
        const gain = weightToComm - (ki * sumComm) / (2 * totalWeight);
        if (gain > bestGain) {
          bestGain = gain;
          bestComm = targetComm;
        }
      }

      if (bestComm !== currentComm) {
        community.set(node, bestComm);
        improved = true;
      }
    }
  }

  // Build community list
  const commMembers = new Map<number, string[]>();
  for (const [node, comm] of community) {
    if (!commMembers.has(comm)) commMembers.set(comm, []);
    commMembers.get(comm)!.push(node);
  }

  // Renumber communities 0..N-1
  const communities: GraphCommunity[] = [];
  let idx = 0;
  for (const [, members] of commMembers) {
    if (members.length > 0) {
      communities.push({ id: idx++, members, size: members.length });
    }
  }

  // Sort by size desc
  communities.sort((a, b) => b.size - a.size);

  const modularity = computeModularity(adj, community, totalWeight);

  return { communities, modularity, nodeCount: nodes.size, edgeCount };
}

// ---------------------------------------------------------------------------
// Hub node detection
// ---------------------------------------------------------------------------

/**
 * Find hub nodes — memories with link count significantly above median.
 * Returns nodes with links > threshold (default: 2x median, minimum 3 links).
 */
export function detectHubs(
  db: Database.Database,
  thresholdMultiplier = 2,
  minLinks = 3,
): HubNode[] {
  const rows = db
    .prepare(
      `SELECT id, cnt FROM (
         SELECT id, COUNT(*) as cnt FROM (
           SELECT source_id AS id FROM memory_links
           UNION ALL
           SELECT target_id AS id FROM memory_links
         ) GROUP BY id
       ) ORDER BY cnt DESC`
    )
    .all() as Array<{ id: string; cnt: number }>;

  if (rows.length === 0) return [];

  // Compute median link count
  const sorted = rows.map((r) => r.cnt).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const threshold = Math.max(median * thresholdMultiplier, minLinks);

  const hubs: HubNode[] = [];
  for (const { id, cnt } of rows) {
    if (cnt < threshold) break; // sorted desc, no more hubs
    const mem = db
      .prepare("SELECT content, project, domain FROM memories WHERE id = ?")
      .get(id) as { content: string; project: string | null; domain: string | null } | undefined;
    if (!mem) continue;
    hubs.push({
      id,
      linkCount: cnt,
      project: mem.project,
      domain: mem.domain,
      content: mem.content.slice(0, 200),
    });
  }

  return hubs;
}

// ---------------------------------------------------------------------------
// Neighbor query (for MCP tool)
// ---------------------------------------------------------------------------

export interface GraphNeighbor {
  id: string;
  relationship: string;
  strength: number;
  direction: "outgoing" | "incoming";
  content: string;
  project: string | null;
}

export function getNeighbors(
  db: Database.Database,
  memoryId: string,
  limit = 10,
  relationship?: string,
): GraphNeighbor[] {
  let sql = `SELECT source_id, target_id, relationship, strength
       FROM memory_links
       WHERE (source_id = ? OR target_id = ?)`;
  const params: unknown[] = [memoryId, memoryId];

  if (relationship) {
    sql += ` AND relationship = ?`;
    params.push(relationship);
  }

  sql += ` ORDER BY strength DESC LIMIT ?`;
  params.push(limit);

  const rows = db
    .prepare(sql)
    .all(...params) as Array<{
      source_id: string; target_id: string; relationship: string; strength: number;
    }>;

  const results: GraphNeighbor[] = [];
  for (const row of rows) {
    const isOutgoing = row.source_id === memoryId;
    const neighborId = isOutgoing ? row.target_id : row.source_id;
    const mem = db
      .prepare("SELECT content, project FROM memories WHERE id = ?")
      .get(neighborId) as { content: string; project: string | null } | undefined;
    if (!mem) continue;
    results.push({
      id: neighborId,
      relationship: row.relationship,
      strength: row.strength,
      direction: isOutgoing ? "outgoing" : "incoming",
      content: mem.content.slice(0, 200),
      project: mem.project,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Full graph export (for GET /graph?op=export — the /viz page, #124)
// ---------------------------------------------------------------------------

// Default shows the whole graph for corpora up to 5k memories (owner request
// 05.07 — the strongest-500 default hid most edges). Payload note: nodes carry
// content up to 4000 chars, so 5k nodes can be a several-MB JSON response —
// acceptable on localhost/LAN, which is the /viz deployment model.
export const EXPORT_DEFAULT_LIMIT = 5000;
export const EXPORT_MAX_LIMIT = 10000;

export interface VizNode {
  id: string;
  label: string;          // first line of content, ~80 chars
  content: string;        // truncated to 4000 chars (detail panel)
  memory_type: string | null;
  domain: string | null;  // derived PRIMARY tag — the node colour (graded-schema spec)
  tags: string[];         // full multi-label set incl. primary, ORDERED by weight desc
  tagWeights: number[];   // parallel to tags — association weights, rounded 4dp (0 = unknown/NULL)
  project: string | null;
  strength: number;       // effective (decayed) strength, not base_strength
  linkCount: number;
  isHub: boolean;
  created_at: string | null;
}

export interface VizEdge {
  source: string;
  target: string;
  relationship: string;
  strength: number;
}

export interface VizGraph {
  nodes: VizNode[];
  edges: VizEdge[];
  domains: string[];      // distinct across the WHOLE DB (filter dropdowns)
  types: string[];        // distinct across the WHOLE DB (filter dropdowns)
  meta: { total: number; shown: number; edgeCount: number };
}

export interface ExportGraphOptions {
  domain?: string;
  type?: string;          // memory_type
  /**
   * "Everything touching X" (graded-schema spec): keep only nodes CARRYING the
   * tag, any weight. A node with no memory_tags rows counts as carrying its
   * `domain` (mirrors the payload's tags fallback). Unlike `domain`, which
   * matches only the derived primary.
   */
  tag?: string;
  minStrength?: number;   // 0..1, applied to EFFECTIVE strength
  limit?: number;         // default 5000, hard max 10000
}

/** First non-empty line of content, capped at 80 chars. */
function makeLabel(content: string): string {
  const firstLine = content.split("\n").find((l) => l.trim().length > 0) ?? content;
  return firstLine.trim().slice(0, 80);
}

/**
 * Assemble the full node/edge payload for the /viz page.
 *
 * Nodes are ranked by effective (decayed) strength and capped at `limit`.
 * Edges include only links where BOTH endpoints made the cut.
 * Link counts come from one aggregate query over memory_links (no per-row
 * queries) and feed both the effectiveStrength hardening term and the
 * per-node linkCount field.
 */
export function exportGraph(
  db: Database.Database,
  options: ExportGraphOptions = {},
): VizGraph {
  const limit = Math.min(
    Math.max(Math.floor(options.limit ?? EXPORT_DEFAULT_LIMIT), 1),
    EXPORT_MAX_LIMIT,
  );
  const now = new Date();

  // Per-memory link counts — single aggregate query (same shape as detectHubs)
  const linkCountRows = db
    .prepare(
      `SELECT id, COUNT(*) as cnt FROM (
         SELECT source_id AS id FROM memory_links
         UNION ALL
         SELECT target_id AS id FROM memory_links
       ) GROUP BY id`
    )
    .all() as Array<{ id: string; cnt: number }>;
  const linkCounts = new Map(linkCountRows.map((r) => [r.id, r.cnt]));

  // Candidate memories — domain/type filters pushed into SQL
  let sql =
    `SELECT id, content, memory_type, domain, project, base_strength,
            last_accessed, access_count, created_at
     FROM memories`;
  const where: string[] = [];
  const params: unknown[] = [];
  if (options.domain) { where.push("domain = ?"); params.push(options.domain); }
  if (options.type) { where.push("memory_type = ?"); params.push(options.type); }
  if (options.tag) {
    // Tag match (any weight) OR the domain fallback for never-multi-tagged
    // rows — consistent with the tags payload fallback below.
    where.push(
      `(id IN (SELECT memory_id FROM memory_tags WHERE tag = ?)
        OR (domain = ? AND id NOT IN (SELECT DISTINCT memory_id FROM memory_tags)))`,
    );
    params.push(options.tag, options.tag);
  }
  if (where.length > 0) sql += ` WHERE ${where.join(" AND ")}`;

  const rows = db.prepare(sql).all(...params) as Array<{
    id: string;
    content: string;
    memory_type: string | null;
    domain: string | null;
    project: string | null;
    base_strength: number | null;
    last_accessed: string | null;
    access_count: number | null;
    created_at: string | null;
  }>;

  const hubIds = new Set(detectHubs(db).map((h) => h.id));

  // Score, filter on effective strength, rank, cap
  const scored = rows.map((row) => {
    const linkCount = linkCounts.get(row.id) ?? 0;
    const strength = effectiveStrength(
      row.base_strength ?? 0.5,
      row.last_accessed,
      now,
      { accessCount: row.access_count ?? 0, linkCount },
    );
    return { row, strength, linkCount };
  });

  const filtered = options.minStrength !== undefined
    ? scored.filter((s) => s.strength >= options.minStrength!)
    : scored;

  filtered.sort((a, b) => b.strength - a.strength);
  const top = filtered.slice(0, limit);

  // Multi-label tags (graded-schema spec) — fetch only for the capped node
  // set. One query keyed on the included ids; grouped into per-node parallel
  // arrays ORDERED BY WEIGHT DESC (NULL weights last, in insertion/relevance
  // order). The derived primary remains on `domain` (the colour); `tags` is
  // the full set, `tagWeights` the parallel association weights (rounded 4dp;
  // 0 for NULL/not-yet-computed).
  const topIds = top.map((t) => t.row.id);
  const tagsByMemory = new Map<string, Array<{ tag: string; weight: number | null }>>();
  if (topIds.length > 0) {
    const idPlaceholders = topIds.map(() => "?").join(", ");
    const tagRows = db
      .prepare(
        `SELECT memory_id, tag, weight FROM memory_tags
         WHERE memory_id IN (${idPlaceholders})
         ORDER BY memory_id, (weight IS NULL) ASC, weight DESC, rowid ASC`,
      )
      .all(...topIds) as Array<{ memory_id: string; tag: string; weight: number | null }>;
    for (const r of tagRows) {
      const arr = tagsByMemory.get(r.memory_id);
      const entry = { tag: r.tag, weight: r.weight };
      if (arr) arr.push(entry);
      else tagsByMemory.set(r.memory_id, [entry]);
    }
  }

  const nodes: VizNode[] = top.map(({ row, strength, linkCount }) => {
    const weighted = tagsByMemory.get(row.id)
      ?? (row.domain ? [{ tag: row.domain, weight: null }] : []);
    return {
      id: row.id,
      label: makeLabel(row.content),
      content: row.content.slice(0, 4000),
      memory_type: row.memory_type,
      domain: row.domain,
      tags: weighted.map((w) => w.tag),
      tagWeights: weighted.map((w) => (w.weight == null ? 0 : Math.round(w.weight * 10000) / 10000)),
      project: row.project,
      strength: Math.round(strength * 10000) / 10000,
      linkCount,
      isHub: hubIds.has(row.id),
      created_at: row.created_at,
    };
  });

  // Edges — only where both endpoints are in the included set
  const included = new Set(nodes.map((n) => n.id));
  const linkRows = db
    .prepare("SELECT source_id, target_id, relationship, strength FROM memory_links")
    .all() as Array<{ source_id: string; target_id: string; relationship: string; strength: number }>;
  const edges: VizEdge[] = linkRows
    .filter((l) => included.has(l.source_id) && included.has(l.target_id))
    .map((l) => ({
      source: l.source_id,
      target: l.target_id,
      relationship: l.relationship,
      strength: l.strength,
    }));

  // Filter dropdown values — distinct across the WHOLE DB, not the shown subset
  const domains = (db
    .prepare("SELECT DISTINCT domain FROM memories WHERE domain IS NOT NULL AND domain != '' ORDER BY domain")
    .all() as Array<{ domain: string }>).map((r) => r.domain);
  const types = (db
    .prepare("SELECT DISTINCT memory_type FROM memories WHERE memory_type IS NOT NULL AND memory_type != '' ORDER BY memory_type")
    .all() as Array<{ memory_type: string }>).map((r) => r.memory_type);

  const total = (db.prepare("SELECT COUNT(*) as cnt FROM memories").get() as { cnt: number }).cnt;

  return {
    nodes,
    edges,
    domains,
    types,
    meta: { total, shown: nodes.length, edgeCount: edges.length },
  };
}

// ---------------------------------------------------------------------------
// Shortest path (for MCP tool)
// ---------------------------------------------------------------------------

export function shortestPath(
  db: Database.Database,
  fromId: string,
  toId: string,
  maxDepth = 5,
): string[] | null {
  // BFS on the memory_links graph
  const links = db
    .prepare("SELECT source_id, target_id FROM memory_links")
    .all() as Array<{ source_id: string; target_id: string }>;

  const adj = new Map<string, Set<string>>();
  for (const { source_id, target_id } of links) {
    if (!adj.has(source_id)) adj.set(source_id, new Set());
    adj.get(source_id)!.add(target_id);
    if (!adj.has(target_id)) adj.set(target_id, new Set());
    adj.get(target_id)!.add(source_id);
  }

  if (!adj.has(fromId) || !adj.has(toId)) return null;

  const visited = new Set<string>([fromId]);
  const parent = new Map<string, string>();
  const queue: Array<{ node: string; depth: number }> = [{ node: fromId, depth: 0 }];

  while (queue.length > 0) {
    const { node, depth } = queue.shift()!;
    if (node === toId) {
      // Reconstruct path
      const path: string[] = [toId];
      let current = toId;
      while (parent.has(current)) {
        current = parent.get(current)!;
        path.unshift(current);
      }
      return path;
    }
    if (depth >= maxDepth) continue;
    for (const neighbor of adj.get(node) ?? []) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        parent.set(neighbor, node);
        queue.push({ node: neighbor, depth: depth + 1 });
      }
    }
  }

  return null;
}
