/**
 * Shared vector-cluster utilities: union-find clustering + KNN edge building.
 *
 * Originally lived entirely in src/eval/dups.ts (the #191 D1 duplicate-rate
 * audit). Extracted so `hicortex dedup` (#100) reuses the EXACT same
 * clustering math instead of re-implementing it — the read-only audit and the
 * live merge command must agree on what a "cluster" is.
 */

import type Database from "better-sqlite3";
import { l2ToCosine } from "./retrieval.js";

/** An undirected similarity edge between two memory ids. */
export interface Edge {
  a: string;
  b: string;
  cosine: number;
}

// ---------------------------------------------------------------------------
// Union-Find (pure — unit tested)
// ---------------------------------------------------------------------------

/** Minimal union-find over string ids, with path compression. */
export class UnionFind {
  private parent = new Map<string, string>();

  find(x: string): string {
    if (!this.parent.has(x)) {
      this.parent.set(x, x);
      return x;
    }
    let root = x;
    while (this.parent.get(root) !== root) {
      root = this.parent.get(root) as string;
    }
    let cur = x;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur) as string;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }

  /** All known nodes grouped by cluster root (includes singletons). */
  clusters(): Map<string, string[]> {
    const groups = new Map<string, string[]>();
    for (const node of this.parent.keys()) {
      const root = this.find(node);
      const arr = groups.get(root) ?? [];
      arr.push(node);
      groups.set(root, arr);
    }
    return groups;
  }
}

/** Build clusters (size >= 2) from edges at/above a cosine threshold. */
export function clusterEdges(edges: Edge[], threshold: number): string[][] {
  const uf = new UnionFind();
  for (const e of edges) {
    if (e.cosine >= threshold) uf.union(e.a, e.b);
  }
  return [...uf.clusters().values()].filter((g) => g.length >= 2);
}

/** Excess = sum(cluster size − 1) — rows that would disappear if every cluster merged to one. */
export function clusterExcess(clusters: string[][]): number {
  return clusters.reduce((sum, c) => sum + (c.length - 1), 0);
}

// ---------------------------------------------------------------------------
// Metadata-mismatch guard (shared by the #191 audit dump and `hicortex dedup`)
// ---------------------------------------------------------------------------

/** Metadata fields a merge candidate cluster must agree on. `privacy` is on the row (the
 *  column still exists) but is NOT a merge-safety field — vestigial since 0.16.2. */
export interface ClusterMetaRow {
  project: string | null;
  privacy: string | null;
  source_agent: string;
}

export interface ClusterMetadataMismatch {
  projectMismatch: boolean;
  sourceAgentMismatch: boolean;
}

/** Do cluster members disagree on project / source_agent? (merge-safety input for #100).
 *  Privacy is intentionally NOT checked — it is vestigial since 0.16.2. */
export function clusterMetadataMismatch(members: ClusterMetaRow[]): ClusterMetadataMismatch {
  const projects = new Set(members.map((m) => m.project ?? "\u0000null"));
  const agents = new Set(members.map((m) => m.source_agent));
  return {
    projectMismatch: projects.size > 1,
    sourceAgentMismatch: agents.size > 1,
  };
}

// ---------------------------------------------------------------------------
// KNN edge building
// ---------------------------------------------------------------------------

/** Neighbors requested per memory (excluding the memory itself), unless overridden. */
const DEFAULT_KNN_K = 10;

/**
 * Build the max-cosine edge set via top-K KNN on `memory_vectors`, keeping
 * only pairs at/above `minCosine`. Shared by the #191 audit (which then
 * clusters at several report thresholds) and `hicortex dedup` (a single merge
 * threshold) — same query, same math, so the two never disagree on what
 * counts as a near-duplicate pair.
 */
export function buildKnnEdges(
  db: Database.Database,
  opts: { k?: number; minCosine: number },
): Edge[] {
  const k = opts.k ?? DEFAULT_KNN_K;
  const vectorRows = db.prepare("SELECT id, embedding FROM memory_vectors").all() as Array<{
    id: string;
    embedding: Buffer;
  }>;

  const knnStmt = db.prepare(
    "SELECT id, distance FROM memory_vectors WHERE embedding MATCH ? AND k = ? ORDER BY distance",
  );

  const edgeMap = new Map<string, number>(); // "a|b" (a < b) -> max cosine seen from either direction

  for (const row of vectorRows) {
    const neighbors = knnStmt.all(row.embedding, k + 1) as Array<{ id: string; distance: number }>;
    for (const n of neighbors) {
      if (n.id === row.id) continue;
      const cosine = l2ToCosine(n.distance);
      if (cosine < opts.minCosine) continue;
      const key = row.id < n.id ? `${row.id}|${n.id}` : `${n.id}|${row.id}`;
      const existing = edgeMap.get(key);
      if (existing === undefined || cosine > existing) edgeMap.set(key, cosine);
    }
  }

  return [...edgeMap.entries()].map(([key, cosine]) => {
    const [a, b] = key.split("|");
    return { a, b, cosine };
  });
}
