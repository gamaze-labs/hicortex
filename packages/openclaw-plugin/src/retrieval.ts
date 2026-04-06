/**
 * Retrieval layer with composite scoring, RRF fusion, and graph traversal.
 * Ported from hicortex/retrieval.py — same scoring model and weights.
 *
 * Scoring model:
 *   score = similarity * 0.4 + effective_strength * 0.3 + connection_score * 0.2 + recency * 0.1
 *
 * Decay model (B+E+D):
 *   base_decay = 0.0005 (~60-day half-life at importance 0.5)
 *   decay_rate = 1 - base_decay * (1 - importance)
 *   decay_rate = 1 - (1 - decay_rate) * 0.7^access_count
 *   decay_rate = 1 - (1 - decay_rate) * 0.7^link_count
 *   floor = base_strength * importance * 0.1
 *   effective = floor + (base - floor) * decay_rate^hours
 */

import type Database from "better-sqlite3";
import type { Memory, MemorySearchResult } from "./types.js";
import * as storage from "./storage.js";

const BASE_DECAY = 0.0005;
const DEFAULT_GRAPH_DISTANCE = 0.5;
const RRF_K = 60;

// ---------------------------------------------------------------------------
// Timestamp parsing
// ---------------------------------------------------------------------------

function parseTimestamp(ts: string | null): Date {
  if (!ts) return new Date();
  try {
    const dt = new Date(ts);
    if (isNaN(dt.getTime())) return new Date();
    return dt;
  } catch {
    return new Date();
  }
}

// ---------------------------------------------------------------------------
// Scoring helpers
// ---------------------------------------------------------------------------

/**
 * Compute decayed strength with adaptive decay (B+E+D model).
 * Exported for use by consolidation decay/prune stage.
 */
export function effectiveStrength(
  baseStrength: number,
  lastAccessed: string | null,
  now: Date,
  options?: {
    importance?: number;
    accessCount?: number;
    linkCount?: number;
  }
): number {
  const importance = options?.importance ?? baseStrength;
  const accessCount = options?.accessCount ?? 0;
  const linkCount = options?.linkCount ?? 0;

  const hours = Math.max(
    (now.getTime() - parseTimestamp(lastAccessed).getTime()) / 3_600_000,
    0
  );

  // B: Importance slows decay
  let decayRate = 1.0 - BASE_DECAY * (1.0 - importance);

  // E: Access hardening
  const hardening = 0.7;
  decayRate = 1.0 - (1.0 - decayRate) * Math.pow(hardening, accessCount);

  // E: Connectivity hardening
  decayRate = 1.0 - (1.0 - decayRate) * Math.pow(hardening, linkCount);

  // D: Asymptotic floor
  const floor = baseStrength * importance * 0.1;

  return floor + (baseStrength - floor) * Math.pow(decayRate, hours);
}

/**
 * Return a composite relevance score in [0, 1] for a candidate memory.
 */
function computeScore(
  memory: Memory,
  distance: number,
  connectionCount: number,
  maxConnections: number,
  now: Date
): number {
  const similarity = Math.max(0, 1.0 - distance);
  const effStrength = effectiveStrength(
    memory.base_strength ?? 0.5,
    memory.last_accessed,
    now,
    {
      accessCount: memory.access_count ?? 0,
      linkCount: connectionCount,
    }
  );
  const connScore =
    maxConnections > 0 ? connectionCount / maxConnections : 0;
  const hoursSinceCreated = Math.max(
    (now.getTime() - parseTimestamp(memory.created_at).getTime()) / 3_600_000,
    0
  );
  const recency = Math.pow(0.9995, hoursSinceCreated);

  return similarity * 0.4 + effStrength * 0.3 + connScore * 0.2 + recency * 0.1;
}

// ---------------------------------------------------------------------------
// Graph traversal
// ---------------------------------------------------------------------------

function collectLinks(
  db: Database.Database,
  seedIds: string[],
  maxHops = 2
): Map<string, number> {
  const visited = new Set(seedIds);
  const connectionCounts = new Map<string, number>();
  let frontier = new Set(seedIds);

  for (let hop = 0; hop < maxHops; hop++) {
    const nextFrontier = new Set<string>();
    for (const mid of frontier) {
      const links = storage.getLinks(db, mid, "both");
      const count = links.length;
      connectionCounts.set(
        mid,
        (connectionCounts.get(mid) ?? 0) + count
      );
      for (const link of links) {
        const linkedId =
          link.source_id === mid ? link.target_id : link.source_id;
        if (linkedId && !visited.has(linkedId)) {
          visited.add(linkedId);
          nextFrontier.add(linkedId);
        }
      }
    }
    frontier = nextFrontier;
    if (frontier.size === 0) break;
  }

  // Ensure newly discovered nodes also have a connection count
  for (const mid of visited) {
    if (!connectionCounts.has(mid)) {
      const links = storage.getLinks(db, mid, "both");
      connectionCounts.set(mid, links.length);
    }
  }

  return connectionCounts;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatResult(
  memory: Memory,
  score: number,
  effStr: number,
  connections: number
): MemorySearchResult {
  return {
    id: memory.id,
    content: memory.content ?? "",
    score: Math.round(score * 1e6) / 1e6,
    effective_strength: Math.round(effStr * 1e6) / 1e6,
    access_count: memory.access_count ?? 0,
    memory_type: memory.memory_type ?? "episode",
    project: memory.project ?? null,
    created_at: memory.created_at ?? "",
    connections,
  };
}

// ---------------------------------------------------------------------------
// Strengthening
// ---------------------------------------------------------------------------

function strengthen(
  db: Database.Database,
  memories: Memory[],
  now: Date
): void {
  const nowIso = now.toISOString();
  for (const mem of memories) {
    if (!mem.id) continue;
    try {
      storage.strengthenMemory(db, mem.id, nowIso);
    } catch {
      // Non-fatal — log would be ideal but we keep going
    }
  }
}

// ---------------------------------------------------------------------------
// Reciprocal Rank Fusion
// ---------------------------------------------------------------------------

function reciprocalRankFusion(
  rankedLists: string[][],
  k = RRF_K
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const ranked of rankedLists) {
    for (let rank = 0; rank < ranked.length; rank++) {
      const mid = ranked[rank];
      scores.set(mid, (scores.get(mid) ?? 0) + 1.0 / (k + rank + 1));
    }
  }
  return scores;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface EmbedFn {
  (text: string): Promise<Float32Array>;
}

/**
 * Main retrieval: BM25 + vector search with RRF fusion, graph traversal,
 * and composite scoring. Strengthens accessed memories.
 */
export async function retrieve(
  db: Database.Database,
  embedFn: EmbedFn,
  query: string,
  options?: {
    limit?: number;
    project?: string | null;
    privacy?: string[];
    sourceAgent?: string;
  }
): Promise<MemorySearchResult[]> {
  const limit = options?.limit ?? 5;
  const project = options?.project;
  const privacy = options?.privacy;
  const sourceAgent = options?.sourceAgent;
  const now = new Date();

  // 1. Embed
  const queryEmbedding = await embedFn(query);

  // 2. Dual retrieval — vector + BM25
  const fetchLimit = limit * 3;
  let vecCandidates = storage.vectorSearch(db, queryEmbedding, fetchLimit, []);

  let ftsCandidates: Array<Memory & { rank: number }> = [];
  try {
    ftsCandidates = storage.searchFts(db, query, fetchLimit, privacy, sourceAgent);
  } catch {
    // FTS5 search can fail on special characters; fall back to vector-only
  }

  if (vecCandidates.length === 0 && ftsCandidates.length === 0) {
    return [];
  }

  // Post-filter vector candidates (sqlite-vec can't filter)
  if (project) {
    vecCandidates = vecCandidates.filter((c) => c.project === project);
    ftsCandidates = ftsCandidates.filter((c) => c.project === project);
  }
  if (privacy) {
    vecCandidates = vecCandidates.filter((c) => privacy.includes(c.privacy));
  }
  if (sourceAgent) {
    vecCandidates = vecCandidates.filter(
      (c) => c.source_agent === sourceAgent
    );
  }

  // 3. RRF fusion
  const vecRanked = vecCandidates.map((c) => c.id);
  const ftsRanked = ftsCandidates.map((c) => c.id);
  const rrfScores = reciprocalRankFusion([vecRanked, ftsRanked]);

  // Build unified candidate map
  const candidateMap = new Map<string, { mem: Memory; distance: number }>();
  for (const c of vecCandidates) {
    candidateMap.set(c.id, { mem: c, distance: c.distance });
  }
  for (const c of ftsCandidates) {
    if (!candidateMap.has(c.id)) {
      candidateMap.set(c.id, { mem: c, distance: DEFAULT_GRAPH_DISTANCE });
    }
  }

  // 4. Graph traversal
  const seedIds = [...candidateMap.keys()];
  const connectionCounts = collectLinks(db, seedIds, 2);

  // Pull in graph-discovered memories not in the candidate set
  const graphIds = [...connectionCounts.keys()].filter(
    (mid) => !candidateMap.has(mid)
  );
  for (const gid of graphIds) {
    const mem = storage.getMemory(db, gid);
    if (!mem) continue;
    if (project && mem.project !== project) continue;
    if (privacy && !privacy.includes(mem.privacy)) continue;
    if (sourceAgent && mem.source_agent !== sourceAgent) continue;
    candidateMap.set(gid, { mem, distance: DEFAULT_GRAPH_DISTANCE });
  }

  // 5. Compute composite scores
  const maxConnections = Math.max(
    ...([...connectionCounts.values()].length > 0
      ? [...connectionCounts.values()]
      : [0])
  );

  const scored: Array<{
    mem: Memory;
    finalScore: number;
    effStr: number;
    connCount: number;
  }> = [];

  const maxRrf = Math.max(
    ...([...rrfScores.values()].length > 0 ? [...rrfScores.values()] : [1])
  );

  for (const [mid, { mem, distance }] of candidateMap) {
    const connCount = connectionCounts.get(mid) ?? 0;
    const composite = computeScore(mem, distance, connCount, maxConnections, now);
    const effStr = effectiveStrength(
      mem.base_strength ?? 0.5,
      mem.last_accessed,
      now,
      {
        accessCount: mem.access_count ?? 0,
        linkCount: connectionCounts.get(mem.id) ?? 0,
      }
    );

    const rrf = rrfScores.get(mid) ?? 0;
    const normalizedRrf = maxRrf > 0 ? rrf / maxRrf : 0;
    const finalScore = composite * 0.8 + normalizedRrf * 0.2;

    scored.push({ mem, finalScore, effStr, connCount });
  }

  // 6. Sort and take top N
  scored.sort((a, b) => b.finalScore - a.finalScore);
  const top = scored.slice(0, limit);

  const results = top.map((t) =>
    formatResult(t.mem, t.finalScore, t.effStr, t.connCount)
  );

  // 7. Strengthen
  strengthen(db, top.map((t) => t.mem), now);

  return results;
}

/**
 * Get recent context, optionally filtered by project and privacy.
 */
export function searchContext(
  db: Database.Database,
  options?: {
    project?: string | null;
    limit?: number;
    privacy?: string[];
  }
): MemorySearchResult[] {
  const limit = options?.limit ?? 10;
  const project = options?.project;
  const privacy = options?.privacy;
  const now = new Date();

  let candidates = storage.getRecentMemories(db, 30, limit * 3);

  if (project) {
    candidates = candidates.filter((c) => c.project === project);
  }
  if (privacy) {
    candidates = candidates.filter((c) => privacy.includes(c.privacy));
  }
  if (candidates.length === 0) return [];

  const allIds = candidates.map((c) => c.id);
  const connectionCounts = collectLinks(db, allIds, 1);
  const maxConnections = Math.max(
    ...([...connectionCounts.values()].length > 0
      ? [...connectionCounts.values()]
      : [0])
  );

  const scored: Array<{
    mem: Memory;
    score: number;
    effStr: number;
    connCount: number;
  }> = [];

  for (const mem of candidates) {
    const connCount = connectionCounts.get(mem.id) ?? 0;
    const score = computeScore(mem, DEFAULT_GRAPH_DISTANCE, connCount, maxConnections, now);
    const effStr = effectiveStrength(
      mem.base_strength ?? 0.5,
      mem.last_accessed,
      now,
      {
        accessCount: mem.access_count ?? 0,
        linkCount: connectionCounts.get(mem.id) ?? 0,
      }
    );
    scored.push({ mem, score, effStr, connCount });
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, limit);

  const results = top.map((t) =>
    formatResult(t.mem, t.score, t.effStr, t.connCount)
  );
  strengthen(db, top.map((t) => t.mem), now);
  return results;
}
