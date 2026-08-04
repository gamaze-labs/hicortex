/**
 * Graded schema membership — domain prototypes + per-tag association weights
 * (spec: specs/2026-07-07-graded-schema-memory-tags.md).
 *
 * MODEL (cognitive grounding → mechanism)
 * ---------------------------------------
 * A configured domain is a SCHEMA with graded membership (Rosch prototypes):
 *   - prototype(domain) = L2-normalized mean of the embeddings of memories
 *     whose tag set includes the domain. Cold start / thin domains
 *     (member_count < PROTOTYPE_MIN_MEMBERS) seed the prototype from the
 *     embedding of the domain's config description instead.
 *   - weight(memory, tag) = cosine(memory embedding, prototype(tag)). Both
 *     vectors are L2-normalized, so cosine reduces to a dot product.
 *   - PRIMARY (memories.domain) = argmax-weight tag, with LLM tag order
 *     breaking exact-weight ties. Fully mechanical, no LLM.
 *
 * The LLM decides ONLY the discrete part (which schemas apply — see
 * domain-classify.ts); ALL gradation is derived from embeddings here.
 * Prototypes + weights are recomputed each nightly, so categories drift with
 * the data ("reconsolidation") without any re-classification runs.
 *
 * Persistence: `domain_prototypes(domain, embedding, member_count, updated_at)`
 * and `memory_tags.weight` (both migration v7).
 */

import type Database from "better-sqlite3";
import type { DomainDef } from "./types.js";
import type { EmbedFn } from "./retrieval.js";

/**
 * Below this member count a domain's prototype is seeded from its config
 * description instead of the member centroid (cold start / thin domains).
 */
export const PROTOTYPE_MIN_MEMBERS = 5;

// ---------------------------------------------------------------------------
// Vector helpers (local — this module must not import storage.ts, which
// imports derivePrimary from here; keep the dependency one-way)
// ---------------------------------------------------------------------------

/** Deserialize a BLOB column into a Float32Array (same layout as sqlite-vec). */
export function blobToVec(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

/** Serialize a Float32Array to a BLOB (same layout as storage.embedToBlob). */
function vecToBlob(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/**
 * L2-normalize a vector IN A COPY. A zero vector (norm 0 — e.g. test fixtures)
 * is returned as an all-zero copy rather than dividing by zero.
 */
export function l2Normalize(vec: Float32Array): Float32Array {
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) sumSq += vec[i] * vec[i];
  const norm = Math.sqrt(sumSq);
  const out = new Float32Array(vec.length);
  if (norm === 0) return out;
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

/**
 * Weighted sum of two vectors into a NEW Float32Array (inputs untouched). The
 * result is NOT renormalized — callers normalize explicitly via `l2Normalize`
 * when they need a unit vector (both call sites below do, because embeddings
 * are L2-normalized and the blend must stay on the unit sphere to keep cosine
 * meaningful). Throws on a dimension mismatch rather than silently truncating:
 * the embedding dim is fixed at 384 in practice, so a mismatch signals a
 * mid-process model swap or a bug, which must surface (CLAUDE.md: fail
 * explicitly), not get quietly papered over.
 *
 * Used by the session-intent centroid EMA and the recall query blend (#192
 * session-intent keying): `weightedAdd(a, 1-α, b, α)` is the EMA step,
 * `weightedAdd(prompt, 1-w, centroid, w)` is the blended search vector.
 */
export function weightedAdd(
  a: Float32Array,
  wA: number,
  b: Float32Array,
  wB: number
): Float32Array {
  if (a.length !== b.length) {
    throw new Error(
      `weightedAdd: dimension mismatch (${a.length} vs ${b.length}) — expected equal-length L2-normalized embeddings`
    );
  }
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] * wA + b[i] * wB;
  return out;
}

/**
 * Association weight of a memory for a tag = cosine(memory embedding, domain
 * prototype). Both inputs are L2-normalized (embedder.ts normalizes memory
 * embeddings; computeDomainPrototypes normalizes prototypes), so cosine is
 * exactly the dot product.
 */
export function tagWeight(memoryEmbedding: Float32Array, prototype: Float32Array): number {
  const n = Math.min(memoryEmbedding.length, prototype.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += memoryEmbedding[i] * prototype[i];
  return dot;
}

// ---------------------------------------------------------------------------
// Primary derivation (pure)
// ---------------------------------------------------------------------------

/** One tag with its association weight (null = never computed / no prototype). */
export interface WeightedTag {
  tag: string;
  weight: number | null;
}

/**
 * Derive the PRIMARY tag (memories.domain) from a weighted tag set.
 *
 * Rules (deterministic, no LLM):
 *   1. The argmax-weight tag. `tags` MUST be in LLM most-relevant-first
 *      order: ties (and all-null weights) resolve to the EARLIEST array
 *      position — strict `>` comparison keeps the first maximum.
 *   2. A null weight loses to any numeric weight (treated as -Infinity).
 *
 * Throws on an empty tag set — callers guarantee >= 1 tag (an empty tag set
 * from the classifier is a NO-FIT and must be routed through nofit.ts, never
 * here); an empty set reaching this function is a programming error.
 */
export function derivePrimary(tags: WeightedTag[]): string {
  if (tags.length === 0) {
    throw new Error("derivePrimary: empty tag set (callers must pass >= 1 tag)");
  }
  let best = tags[0];
  let bestWeight = best.weight ?? Number.NEGATIVE_INFINITY;
  for (let i = 1; i < tags.length; i++) {
    const w = tags[i].weight ?? Number.NEGATIVE_INFINITY;
    if (w > bestWeight) {
      best = tags[i];
      bestWeight = w;
    }
  }
  return best.tag;
}

// ---------------------------------------------------------------------------
// Prototype computation + persistence
// ---------------------------------------------------------------------------

export interface PrototypeStat {
  domain: string;
  memberCount: number;
  /** true = description seed (member_count < PROTOTYPE_MIN_MEMBERS). */
  seeded: boolean;
}

/** Read a single memory's stored embedding (point lookup on memory_vectors). */
function getMemoryEmbedding(db: Database.Database, memoryId: string): Float32Array | null {
  const row = db
    .prepare("SELECT embedding FROM memory_vectors WHERE id = ?")
    .get(memoryId) as { embedding: Buffer } | undefined;
  if (!row?.embedding) return null;
  return blobToVec(row.embedding);
}

/** Load all stored prototypes into a name → vector map. */
export function loadDomainPrototypes(db: Database.Database): Map<string, Float32Array> {
  const rows = db
    .prepare("SELECT domain, embedding FROM domain_prototypes")
    .all() as Array<{ domain: string; embedding: Buffer | null }>;
  const map = new Map<string, Float32Array>();
  for (const r of rows) {
    if (r.embedding) map.set(r.domain, blobToVec(r.embedding));
  }
  return map;
}

/**
 * Compute + persist the prototype of every configured domain.
 *
 * Per domain: mean of the embeddings of memories whose memory_tags include the
 * domain, L2-normalized. When member_count < PROTOTYPE_MIN_MEMBERS the
 * prototype is instead the embedding of `"<Name>: <description>"` (the same
 * "name: description" line the classifier prompt shows) — this seeds cold
 * starts and keeps thin domains from collapsing onto 1-2 outliers.
 *
 * `getEmbedFn` is LAZY (a function returning a promise of the embedder) so the
 * ~130 MB ONNX embedder is loaded ONLY when at least one domain actually needs
 * a description seed — same pattern as relink.ts's lazy fallback embedder.
 *
 * Returns the fresh prototype map (for immediate classification-time weights)
 * plus per-domain stats. Rows in domain_prototypes are REPLACED per domain;
 * domains removed from the config keep a stale row until the next config-set
 * change (harmless — nothing reads prototypes outside the configured set).
 */
export async function computeDomainPrototypes(
  db: Database.Database,
  domains: DomainDef[],
  getEmbedFn: () => Promise<EmbedFn>,
): Promise<{ prototypes: Map<string, Float32Array>; stats: PrototypeStat[] }> {
  const memberStmt = db.prepare("SELECT memory_id FROM memory_tags WHERE tag = ?");
  const upsert = db.prepare(
    `INSERT OR REPLACE INTO domain_prototypes (domain, embedding, member_count, updated_at)
     VALUES (?, ?, ?, ?)`,
  );

  const prototypes = new Map<string, Float32Array>();
  const stats: PrototypeStat[] = [];

  for (const d of domains) {
    const memberIds = (memberStmt.all(d.name) as Array<{ memory_id: string }>)
      .map((r) => r.memory_id);

    // Collect member embeddings (a tag row without a vector is skipped — it
    // cannot contribute to a centroid and would poison the mean with zeros).
    const embeddings: Float32Array[] = [];
    for (const id of memberIds) {
      const emb = getMemoryEmbedding(db, id);
      if (emb) embeddings.push(emb);
    }
    const memberCount = embeddings.length;

    let prototype: Float32Array;
    let seeded = false;
    if (memberCount >= PROTOTYPE_MIN_MEMBERS) {
      const dim = embeddings[0].length;
      const mean = new Float32Array(dim);
      for (const emb of embeddings) {
        for (let i = 0; i < dim; i++) mean[i] += emb[i];
      }
      for (let i = 0; i < dim; i++) mean[i] /= memberCount;
      prototype = l2Normalize(mean);
    } else {
      // Cold start / thin domain → description seed.
      const embedFn = await getEmbedFn();
      prototype = l2Normalize(await embedFn(`${d.name}: ${d.description}`));
      seeded = true;
    }

    upsert.run(d.name, vecToBlob(prototype), memberCount, new Date().toISOString());
    prototypes.set(d.name, prototype);
    stats.push({ domain: d.name, memberCount, seeded });
  }

  return { prototypes, stats };
}

// ---------------------------------------------------------------------------
// Weight computation
// ---------------------------------------------------------------------------

/**
 * Compute the per-tag weights for ONE memory from the current prototypes
 * (classification-time path: newly tagged memories get weights immediately).
 * A missing memory vector or missing prototype yields null (stored as NULL;
 * repaired by the next nightly recompute).
 */
export function computeTagWeights(
  db: Database.Database,
  memoryId: string,
  tags: string[],
  prototypes: Map<string, Float32Array>,
): Record<string, number | null> {
  const emb = getMemoryEmbedding(db, memoryId);
  const out: Record<string, number | null> = {};
  for (const tag of tags) {
    const proto = prototypes.get(tag);
    out[tag] = emb && proto ? tagWeight(emb, proto) : null;
  }
  return out;
}

/**
 * Best prototype match for one memory across ALL configured domains:
 * argmax of cosine(memory embedding, prototype(domain)).
 *
 * Used by the no-fit path (nofit.ts, owner amendment 07.07): when the LLM
 * says no domain fits, the memory can still earn a WEAK primary from pure
 * embedding association — provided the best cosine clears the configured
 * weakPrimaryFloor (the caller checks the floor; this function just reports
 * the argmax).
 *
 * Returns null when the memory has no stored vector or no configured domain
 * has a prototype (nothing to associate against). Ties resolve to the FIRST
 * domain in config order (strict `>` comparison), mirroring derivePrimary.
 */
export function bestPrototypeMatch(
  db: Database.Database,
  memoryId: string,
  domains: DomainDef[],
  prototypes: Map<string, Float32Array>,
): { domain: string; weight: number } | null {
  const emb = getMemoryEmbedding(db, memoryId);
  if (!emb) return null;

  let best: { domain: string; weight: number } | null = null;
  for (const d of domains) {
    const proto = prototypes.get(d.name);
    if (!proto) continue;
    const w = tagWeight(emb, proto);
    if (best === null || w > best.weight) {
      best = { domain: d.name, weight: w };
    }
  }
  return best;
}

/**
 * One pass over ALL memory_tags rows: weight = cosine(memory embedding,
 * prototype(tag)). Rows whose memory has no stored vector, or whose tag has no
 * prototype (out-of-vocabulary leftovers), are set to NULL. Cheap: one point
 * lookup per distinct memory + one dot product per tag row (3–5k on the
 * production corpus).
 */
export function recomputeAllTagWeights(
  db: Database.Database,
  prototypes: Map<string, Float32Array>,
): { updated: number; nulled: number } {
  const rows = db
    .prepare("SELECT memory_id, tag FROM memory_tags ORDER BY memory_id")
    .all() as Array<{ memory_id: string; tag: string }>;
  const update = db.prepare(
    "UPDATE memory_tags SET weight = ? WHERE memory_id = ? AND tag = ?",
  );

  let updated = 0;
  let nulled = 0;
  const tx = db.transaction(() => {
    let currentId: string | null = null;
    let currentEmb: Float32Array | null = null;
    for (const row of rows) {
      if (row.memory_id !== currentId) {
        currentId = row.memory_id;
        currentEmb = getMemoryEmbedding(db, row.memory_id);
      }
      const proto = prototypes.get(row.tag);
      if (currentEmb && proto) {
        update.run(tagWeight(currentEmb, proto), row.memory_id, row.tag);
        updated++;
      } else {
        update.run(null, row.memory_id, row.tag);
        nulled++;
      }
    }
  });
  tx();
  return { updated, nulled };
}

/**
 * Re-derive the PRIMARY (memories.domain) of every tagged memory from its
 * current tag weights: argmax weight, LLM order (memory_tags insertion order =
 * rowid, written most-relevant-first by storage.setMemoryTags) breaking
 * exact-weight ties.
 *
 * Memories with NO memory_tags rows are untouched (e.g. infra-skipped rows
 * awaiting classification — issue #150 discipline).
 */
export function refreshPrimaries(
  db: Database.Database,
  domains: DomainDef[],
): { examined: number; updated: number } {
  // `domains` is accepted for API symmetry with the other reconsolidation
  // passes (which need prototypes/weights); the primary is now pure argmax
  // and does not depend on the domain set.
  void domains;
  const rows = db
    .prepare(
      `SELECT mt.memory_id, mt.tag, mt.weight, m.domain
       FROM memory_tags mt JOIN memories m ON m.id = mt.memory_id
       ORDER BY mt.memory_id, mt.rowid`,
    )
    .all() as Array<{ memory_id: string; tag: string; weight: number | null; domain: string | null }>;

  // Group per memory, preserving rowid (LLM) order within each group.
  const byMemory = new Map<string, { tags: WeightedTag[]; domain: string | null }>();
  for (const r of rows) {
    let entry = byMemory.get(r.memory_id);
    if (!entry) {
      entry = { tags: [], domain: r.domain };
      byMemory.set(r.memory_id, entry);
    }
    entry.tags.push({ tag: r.tag, weight: r.weight });
  }

  const update = db.prepare("UPDATE memories SET domain = ? WHERE id = ?");
  let updated = 0;
  const tx = db.transaction(() => {
    for (const [memoryId, entry] of byMemory) {
      const primary = derivePrimary(entry.tags);
      if (primary !== entry.domain) {
        update.run(primary, memoryId);
        updated++;
      }
    }
  });
  tx();
  return { examined: byMemory.size, updated };
}
