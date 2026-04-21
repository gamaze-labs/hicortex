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
