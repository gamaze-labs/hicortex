/**
 * Storage layer — CRUD operations for the SQLite + sqlite-vec database.
 * Ported from hicortex/storage.py. All functions are synchronous (better-sqlite3).
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Memory, MemoryLink, InsertMemoryOptions } from "./types.js";
import { derivePrimary, type WeightedTag } from "./schema-prototypes.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Serialize a Float32Array embedding to a Buffer for sqlite-vec.
 */
export function embedToBlob(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

function rowToMemory(row: Record<string, unknown>): Memory {
  return row as unknown as Memory;
}

// ---------------------------------------------------------------------------
// Single memory CRUD
// ---------------------------------------------------------------------------

/**
 * Insert a memory and its vector embedding. Returns the memory's UUID.
 *
 * Idempotent on `sourceSession`: if a memory with that source_session already
 * exists (UNIQUE index from migration v4), the insert is skipped and the
 * EXISTING memory's id is returned (no vector re-insert). This lets `/ingest`
 * and `/distill` safely retry a segment without double-inserting. Callers that
 * omit sourceSession (NULL — nightly distillation, tests) never collide.
 */
export function insertMemory(
  db: Database.Database,
  content: string,
  embedding: Float32Array,
  opts: InsertMemoryOptions = {}
): string {
  const id = randomUUID();
  const ts = opts.createdAt ?? nowIso();
  const ingestedTs = nowIso();
  const sourceSession = opts.sourceSession ?? null;

  const result = db
    .prepare(
      `INSERT OR IGNORE INTO memories
       (id, content, base_strength, last_accessed, access_count,
        created_at, ingested_at, source_agent, source_agent_id, source_session,
        source_domain, project, privacy, memory_type)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      content,
      opts.baseStrength ?? 0.5,
      ts,
      ts,
      ingestedTs,
      opts.sourceAgent ?? "default",
      opts.sourceAgentId ?? null,
      sourceSession,
      opts.sourceDomain ?? null,
      opts.project ?? null,
      opts.privacy ?? null,
      opts.memoryType ?? "experience"
    );

  if (result.changes > 0) {
    // New row — store its vector.
    db.prepare(
      "INSERT INTO memory_vectors (id, embedding) VALUES (?, ?)"
    ).run(id, embedToBlob(embedding));
    return id;
  }

  // Collision on UNIQUE source_session — return the existing memory's id.
  if (sourceSession) {
    const existing = db
      .prepare("SELECT id FROM memories WHERE source_session = ?")
      .get(sourceSession) as { id: string } | undefined;
    if (existing) return existing.id;
  }
  return id;
}

/**
 * Resolve a short ID prefix (e.g. the 8-char id shown in citations and the
 * recall index) to a full memory UUID. Null when unknown or ambiguous.
 */
export function resolveMemoryId(
  db: Database.Database,
  idPrefix: string
): string | null {
  if (idPrefix.length >= 36) {
    const row = db
      .prepare("SELECT id FROM memories WHERE id = ?")
      .get(idPrefix) as { id: string } | undefined;
    return row?.id ?? null;
  }
  const rows = db
    .prepare("SELECT id FROM memories WHERE id LIKE ?")
    .all(`${idPrefix}%`) as { id: string }[];
  return rows.length === 1 ? rows[0].id : null;
}

/**
 * Get a single memory by ID. Returns null if not found.
 */
export function getMemory(
  db: Database.Database,
  memoryId: string
): Memory | null {
  const row = db
    .prepare("SELECT * FROM memories WHERE id = ?")
    .get(memoryId) as Record<string, unknown> | undefined;
  return row ? rowToMemory(row) : null;
}

// Allowed columns for updateMemory
const ALLOWED_UPDATE_FIELDS = new Set([
  "content",
  "base_strength",
  "last_accessed",
  "access_count",
  // shown_count is normally maintained by touchMemoriesShown (bulk +1 per
  // recall-index appearance); it's also allowed here so `hicortex dedup`
  // (#100) can sum a merged cluster's counters onto the canonical row.
  "shown_count",
  "source_agent",
  "source_session",
  "project",
  "domain",
  "privacy",
  "memory_type",
  "updated_at",
]);

/**
 * Update specific fields on a memory.
 */
export function updateMemory(
  db: Database.Database,
  memoryId: string,
  fields: Record<string, unknown>
): void {
  // Auto-set updated_at timestamp
  const fieldsWithTimestamp: Record<string, unknown> = { ...fields, updated_at: new Date().toISOString() };
  const keys = Object.keys(fieldsWithTimestamp);

  for (const k of keys) {
    if (!ALLOWED_UPDATE_FIELDS.has(k)) {
      throw new Error(`Cannot update field: ${k}`);
    }
  }

  const setClause = keys.map((k) => `"${k}" = ?`).join(", ");
  const values = keys.map((k) => fieldsWithTimestamp[k]);
  values.push(memoryId);

  db.prepare(`UPDATE memories SET ${setClause} WHERE id = ?`).run(...values);
}

/**
 * Atomically increment access_count and reset last_accessed.
 */
export function strengthenMemory(
  db: Database.Database,
  memoryId: string,
  nowIsoStr: string
): void {
  db.prepare(
    `UPDATE memories
     SET access_count = access_count + 1, last_accessed = ?
     WHERE id = ?`
  ).run(nowIsoStr, memoryId);
}

/**
 * Record that memories appeared in a pushed recall index (#192): bump
 * shown_count and refresh last_accessed (a mild strengthen — the decay clock
 * resets so topically-live memories stop sinking) WITHOUT touching
 * access_count, which stays reserved for real use (hardening + prune shield).
 */
export function touchMemoriesShown(
  db: Database.Database,
  memoryIds: string[],
  nowIsoStr: string
): void {
  if (memoryIds.length === 0) return;
  const stmt = db.prepare(
    `UPDATE memories
     SET shown_count = COALESCE(shown_count, 0) + 1, last_accessed = ?
     WHERE id = ?`
  );
  const run = db.transaction((ids: string[]) => {
    for (const id of ids) stmt.run(nowIsoStr, id);
  });
  run(memoryIds);
}

/**
 * Delete a memory, its vector, its tags, and all its links.
 */
export function deleteMemory(
  db: Database.Database,
  memoryId: string
): void {
  db.prepare(
    "DELETE FROM memory_links WHERE source_id = ? OR target_id = ?"
  ).run(memoryId, memoryId);
  db.prepare("DELETE FROM memory_tags WHERE memory_id = ?").run(memoryId);
  db.prepare("DELETE FROM memory_vectors WHERE id = ?").run(memoryId);
  db.prepare("DELETE FROM memories WHERE id = ?").run(memoryId);
}

// ---------------------------------------------------------------------------
// Multi-tag classification (feat/memory-tags)
// ---------------------------------------------------------------------------

/** Options for setMemoryTags (graded-schema spec 2026-07-07). */
export interface SetMemoryTagsOptions {
  /**
   * Per-tag association weights (cosine vs the domain prototype), computed by
   * schema-prototypes.computeTagWeights. A missing/null entry stores NULL
   * (repaired by the next nightly recompute).
   */
  weights?: Record<string, number | null>;
}

/**
 * Set a memory's classification tags (graded schema model).
 *
 * `tags` is the ORDERED tag set from the classifier (most-relevant first —
 * the order is persisted via insertion/rowid order and breaks exact-weight
 * ties). The `memory_tags` sidecar rows for this memory are REPLACED; each
 * row stores its association weight (NULL when not yet computed).
 *
 * The PRIMARY (memories.domain) is DERIVED here — never passed in by the LLM:
 * argmax weight, else first tag (all-null weights). The whole update is one
 * transaction so domain, tag set, and weights never diverge.
 *
 * @returns the derived primary written to memories.domain
 */
export function setMemoryTags(
  db: Database.Database,
  memoryId: string,
  tags: string[],
  options: SetMemoryTagsOptions = {}
): string {
  // Dedup preserving first (most-relevant) occurrence; defensive — the
  // classifier already dedups.
  const unique = Array.from(new Set(tags));
  if (unique.length === 0) {
    throw new Error("setMemoryTags: empty tag set (callers must pass >= 1 tag)");
  }

  const weighted: WeightedTag[] = unique.map((tag) => ({
    tag,
    weight: options.weights?.[tag] ?? null,
  }));
  const primary = derivePrimary(weighted);

  const setDomain = db.prepare("UPDATE memories SET domain = ? WHERE id = ?");
  const clearTags = db.prepare("DELETE FROM memory_tags WHERE memory_id = ?");
  const insertTag = db.prepare(
    "INSERT OR IGNORE INTO memory_tags (memory_id, tag, weight) VALUES (?, ?, ?)"
  );

  const tx = db.transaction(() => {
    setDomain.run(primary, memoryId);
    clearTags.run(memoryId);
    // Insert in LLM order — rowid order IS the persisted relevance order.
    // schema-prototypes.ts refreshPrimaries depends on this (ORDER BY mt.rowid
    // as the argmax tiebreak): any future bulk writer of memory_tags MUST
    // insert most-relevant-first or tiebreak ordering silently corrupts.
    for (const w of weighted) insertTag.run(memoryId, w.tag, w.weight);
  });
  tx();
  return primary;
}

/**
 * Get a memory's tag set (the full multi-label set, including the primary).
 * Returns tags sorted alphabetically for stable output; empty array if none.
 */
export function getMemoryTags(
  db: Database.Database,
  memoryId: string
): string[] {
  const rows = db
    .prepare("SELECT tag FROM memory_tags WHERE memory_id = ? ORDER BY tag")
    .all(memoryId) as Array<{ tag: string }>;
  return rows.map((r) => r.tag);
}

/**
 * Get a memory's tags WITH weights, ordered by weight descending (NULL
 * weights last, in insertion/relevance order). Empty array if none.
 */
export function getMemoryTagsWeighted(
  db: Database.Database,
  memoryId: string
): Array<{ tag: string; weight: number | null }> {
  const rows = db
    .prepare(
      `SELECT tag, weight FROM memory_tags WHERE memory_id = ?
       ORDER BY (weight IS NULL) ASC, weight DESC, rowid ASC`
    )
    .all(memoryId) as Array<{ tag: string; weight: number | null }>;
  return rows;
}

/**
 * Batched weighted-tag load for a candidate set (#203 domain affinity). ONE
 * query for the whole set — never call getMemoryTagsWeighted per-candidate in
 * a ranking loop. Returns a Map keyed by memory_id; memories with no tags are
 * simply absent from the map (caller treats missing as "no domain boost").
 * Ordering within each memory mirrors getMemoryTagsWeighted (weight DESC).
 */
export function getMemoryTagsWeightedBatched(
  db: Database.Database,
  memoryIds: string[]
): Map<string, Array<{ tag: string; weight: number | null }>> {
  const out = new Map<string, Array<{ tag: string; weight: number | null }>>();
  if (memoryIds.length === 0) return out;
  const placeholders = memoryIds.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT memory_id, tag, weight FROM memory_tags
       WHERE memory_id IN (${placeholders})
       ORDER BY memory_id, (weight IS NULL) ASC, weight DESC, rowid ASC`
    )
    .all(...memoryIds) as Array<{ memory_id: string; tag: string; weight: number | null }>;
  for (const r of rows) {
    let arr = out.get(r.memory_id);
    if (!arr) {
      arr = [];
      out.set(r.memory_id, arr);
    }
    arr.push({ tag: r.tag, weight: r.weight });
  }
  return out;
}

/**
 * Read the stored embedding for a memory from memory_vectors.
 * Returns null when the row is missing (caller falls back to re-embedding).
 *
 * Shared by `hicortex relink` and the nightly's supersession stage
 * (consolidate.ts) — lives here (not in relink.ts) so consolidate.ts can use
 * it without importing from relink.ts, which itself imports from
 * consolidate.ts (BudgetTracker, discoverLinkCandidates).
 */
export function getStoredEmbedding(
  db: Database.Database,
  memoryId: string
): Float32Array | null {
  const row = db
    .prepare("SELECT embedding FROM memory_vectors WHERE id = ?")
    .get(memoryId) as { embedding: Buffer } | undefined;
  if (!row?.embedding) return null;
  const buf = row.embedding;
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

// ---------------------------------------------------------------------------
// Vector search
// ---------------------------------------------------------------------------

/**
 * Find similar memories by vector distance. Returns memories with distance field.
 */
export function vectorSearch(
  db: Database.Database,
  queryEmbedding: Float32Array,
  limit = 10,
  excludeIds: string[] = []
): Array<Memory & { distance: number }> {
  const rows = db
    .prepare(
      "SELECT id, distance FROM memory_vectors WHERE embedding MATCH ? AND k = ? ORDER BY distance"
    )
    .all(embedToBlob(queryEmbedding), limit) as Array<{
    id: string;
    distance: number;
  }>;

  const excludeSet = new Set(excludeIds);
  const results: Array<Memory & { distance: number }> = [];

  for (const row of rows) {
    if (excludeSet.has(row.id)) continue;

    const mem = db
      .prepare("SELECT * FROM memories WHERE id = ?")
      .get(row.id) as Record<string, unknown> | undefined;
    if (!mem) continue;

    results.push({ ...rowToMemory(mem), distance: row.distance });
  }

  return results;
}

// ---------------------------------------------------------------------------
// FTS5 search — fielded BM25F (#205)
// ---------------------------------------------------------------------------

/**
 * BM25F field weights (config-driven via {@link configureBm25Fts}, called from
 * retrieval.configureScoring at boot). The order mirrors the FTS5 column
 * declaration in db.ts (content, project, domain) — `bm25(memories_fts, …)`
 * takes weights POSITIONALLY, so a new FTS column MUST be added here in the
 * same position or the weighting silently shifts. Defaults favor scope fields
 * (project/domain) over body so cross-scope noise that wins on raw token
 * frequency (the marine "battery" memory on a hardware query) is demoted
 * without excluding it — the same "graded, never binary" discipline as
 * computeScore's affinity terms.
 */
export interface Bm25Weights {
  body: number;
  project: number;
  domain: number;
}

const BM25_DEFAULTS: Bm25Weights = {
  body: 1.0,
  project: 2.0,
  domain: 2.0,
};

let bm25Weights: Bm25Weights = { ...BM25_DEFAULTS };

/**
 * Configure BM25F weights from config. Called by retrieval.configureScoring
 * (which itself is called at server + nightly boot) so storage and retrieval
 * rank identically. Invalid/out-of-range values keep the shipped default per
 * key. Range [0, ∞) — a 0 weight effectively drops that field from the score;
 * negative values are rejected (BM25F sign semantics break otherwise). Returns
 * the resolved set for logging/tests.
 */
export function configureBm25Fts(config?: Record<string, unknown> | null): Bm25Weights {
  const num = (key: string, dflt: number): number => {
    const v = Number(config?.[key]);
    return Number.isFinite(v) && v >= 0 ? v : dflt;
  };
  bm25Weights = {
    body: num("bm25WeightBody", BM25_DEFAULTS.body),
    project: num("bm25WeightProject", BM25_DEFAULTS.project),
    domain: num("bm25WeightDomain", BM25_DEFAULTS.domain),
  };
  return { ...bm25Weights };
}

/** Current resolved weights (tests + status output). */
export function getBm25Weights(): Bm25Weights {
  return { ...bm25Weights };
}

/**
 * Cap on tokens fed to an FTS5 MATCH expression (#329 CR finding 1a).
 * Quoting made pasted term lists LEGAL queries — and an all-common-tokens AND
 * is expensive: measured at 100K rows, a 50-token AND runs ~518ms and a
 * 200-token one 6.3s, and the /recall-index hot path would pay it twice per
 * prompt. Beyond ~24 tokens the implicit AND is semantic noise anyway (a
 * memory matching 24+ ANDed prompt tokens is either the exact text or
 * nothing), so the FIRST 24 tokens are used. 24 is a shipped bound, not a
 * config knob — change it deliberately, with a perf measurement.
 */
export const FTS_MATCH_MAX_TOKENS = 24;

/**
 * FTS5 MATCH-safety quoting (#329 item 1). The raw prompt is NOT valid FTS5
 * query syntax: ordinary prompt punctuation (?, -, (, :, URLs, apostrophes, a
 * leading AND/OR) crashes the FTS5 parser, and retrieval.retrieve's catch then
 * silently drops the ENTIRE FTS candidate list — the perf sweep measured 8/12
 * realistic prompts affected, and it is why relevance eval #3 saw 0 FTS rows
 * in 2,208 candidates. Fix: tokenize on whitespace, strip embedded double
 * quotes (a raw `"` would terminate our own quoting), and wrap each token in
 * double quotes — a quoted token is a phrase of LITERAL strings, immune to
 * FTS5 query syntax (`"what" "is" "the" "deployment" "status"`). Punctuation
 * INSIDE a token is kept: the tokenizer strips it identically on both sides,
 * so `"status?"` still matches content containing "status". Joined with spaces
 * (implicit AND — the same semantics clean prompts always had; a PROSE prompt
 * whose content holds only most of the tokens matches nothing, which is why
 * FTS fires on short keyword prompts, not prose recall). Capped at the first
 * FTS_MATCH_MAX_TOKENS tokens. A query that quotes away to nothing yields ""
 * and the caller skips the SQL entirely.
 */
export function buildFtsMatchExpression(query: string): string {
  return query
    .split(/\s+/)
    .map((token) => token.replace(/"/g, ""))
    .filter((token) => token.length > 0)
    .slice(0, FTS_MATCH_MAX_TOKENS)
    .map((token) => `"${token}"`)
    .join(" ");
}

/**
 * Full-text search using FTS5 fielded BM25 (BM25F) ranking.
 * Returns memories with a rank field (lower is better — see sign note below).
 *
 * `project` is NOT a filter here (#203): the hard project WHERE from #192 was
 * removed — project is now a soft affinity boost in retrieval.computeScore AND
 * a weighted field in BM25F (#205). `privacy` is NOT a filter (0.16.x: the
 * column is fully vestigial — stored, never filtered; the privacy IN-clause
 * was removed). `sourceAgent` stays a hard filter (kept for completeness; no
 * production caller of retrieve() currently passes it).
 *
 * #205 sign handling: FTS5's `bm25(table, w0, w1, …)` returns a NEGATIVE score
 * where MORE-negative = better match (it is 1 − the normalized BM25 score,
 * which is itself positive — the negation is the FTS5 convention so that
 * `ORDER BY bm25(…)` ASC gives best-first, matching the legacy `ORDER BY
 * fts.rank` direction). Higher field weight ⇒ that column contributes MORE to
 * the per-row score ⇒ matches in that field float up. We bind weights
 * positionally as parameters (NOT string-interpolated) so query-planner
 * caching is unaffected and the config path is the only editor.
 */
export function searchFts(
  db: Database.Database,
  query: string,
  limit = 10,
  sourceAgent?: string
): Array<Memory & { rank: number }> {
  // #329: quote the query into literal phrases — a raw prompt crashes the
  // FTS5 parser on punctuation and the caller's catch drops the whole list.
  const matchExpr = buildFtsMatchExpression(query);
  if (!matchExpr) return [];

  const conditions = ["memories_fts MATCH ?"];
  const params: unknown[] = [matchExpr];

  if (sourceAgent) {
    conditions.push("m.source_agent = ?");
    params.push(sourceAgent);
  }

  const where = conditions.join(" AND ");
  // SQLite binds `?` parameters in LEXICAL SQL order (left-to-right) — the
  // `bm25(memories_fts, ?, ?, ?)` in the SELECT clause comes BEFORE the WHERE
  // and LIMIT `?`s, so the weights must be pushed FIRST. Get this order wrong
  // and FTS5 ends up with a numeric weight as its MATCH expression (parsed as
  // FTS5 query syntax → "syntax error near '.'" on the decimal point).
  const boundParams: unknown[] = [
    bm25Weights.body,
    bm25Weights.project,
    bm25Weights.domain,
    ...params,
    limit,
  ];

  const rows = db
    .prepare(
      `SELECT m.*, bm25(memories_fts, ?, ?, ?) AS rank
       FROM memories_fts fts
       JOIN memories m ON m.rowid = fts.rowid
       WHERE ${where}
       ORDER BY rank
       LIMIT ?`
    )
    .all(...boundParams) as Array<Record<string, unknown>>;

  return rows.map((r) => {
    const rank = r.rank as number;
    const mem = rowToMemory(r);
    return { ...mem, rank };
  });
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/**
 * Create a link between two memories.
 */
export function addLink(
  db: Database.Database,
  sourceId: string,
  targetId: string,
  relationship: string,
  strength = 0.5
): void {
  // Guard: superseded_by is the sole ranking-demotion signal, so never let a
  // different relationship clobber an existing superseded_by link for the same
  // pair — INSERT OR REPLACE would otherwise silently remove the demotion.
  if (relationship !== "superseded_by") {
    const protectedLink = db
      .prepare(
        "SELECT 1 FROM memory_links WHERE source_id = ? AND target_id = ? AND relationship = 'superseded_by' LIMIT 1"
      )
      .get(sourceId, targetId);
    if (protectedLink) return;
  }
  db.prepare(
    `INSERT OR REPLACE INTO memory_links
     (source_id, target_id, relationship, strength, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(sourceId, targetId, relationship, strength, nowIso());
}

/**
 * Get links for a memory. direction: 'outgoing', 'incoming', or 'both'.
 */
export function getLinks(
  db: Database.Database,
  memoryId: string,
  direction: "outgoing" | "incoming" | "both" = "both"
): MemoryLink[] {
  let rows: unknown[];
  if (direction === "outgoing") {
    rows = db
      .prepare("SELECT * FROM memory_links WHERE source_id = ?")
      .all(memoryId);
  } else if (direction === "incoming") {
    rows = db
      .prepare("SELECT * FROM memory_links WHERE target_id = ?")
      .all(memoryId);
  } else {
    rows = db
      .prepare(
        "SELECT * FROM memory_links WHERE source_id = ? OR target_id = ?"
      )
      .all(memoryId, memoryId);
  }
  return rows as MemoryLink[];
}

/**
 * Delete all links involving a memory.
 */
export function deleteLinks(
  db: Database.Database,
  memoryId: string
): void {
  db.prepare(
    "DELETE FROM memory_links WHERE source_id = ? OR target_id = ?"
  ).run(memoryId, memoryId);
}

// ---------------------------------------------------------------------------
// Batch & query helpers
// ---------------------------------------------------------------------------

/**
 * Batch insert memories. Returns count inserted.
 */
export function insertMemoriesBatch(
  db: Database.Database,
  memories: Array<{
    content: string;
    embedding: Float32Array;
    sourceAgent?: string;
    sourceAgentId?: string | null;
    sourceDomain?: string | null;
    sourceSession?: string | null;
    project?: string | null;
    privacy?: string;
    memoryType?: string;
    baseStrength?: number;
  }>
): number {
  // privacy default is null (0.16.x: the distiller no longer sets WORK — the
  // column is vestigial, never filtered, and goes NULL unless a caller sends
  // an explicit value).
  const insertMem = db.prepare(
    `INSERT INTO memories
     (id, content, base_strength, last_accessed, access_count,
      created_at, ingested_at, source_agent, source_agent_id, source_session,
      source_domain, project, privacy, memory_type)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertVec = db.prepare(
    "INSERT INTO memory_vectors (id, embedding) VALUES (?, ?)"
  );

  const tx = db.transaction(() => {
    let count = 0;
    for (const mem of memories) {
      const id = randomUUID();
      const ts = nowIso();
      insertMem.run(
        id,
        mem.content,
        mem.baseStrength ?? 0.5,
        ts,
        ts,
        ts,
        mem.sourceAgent ?? "default",
        mem.sourceAgentId ?? null,
        mem.sourceSession ?? null,
        mem.sourceDomain ?? null,
        mem.project ?? null,
        mem.privacy ?? null,
        mem.memoryType ?? "experience"
      );
      insertVec.run(id, embedToBlob(mem.embedding));
      count++;
    }
    return count;
  });

  return tx();
}

/**
 * Return total memory count.
 */
export function countMemories(db: Database.Database): number {
  return (
    db.prepare("SELECT count(*) as cnt FROM memories").get() as { cnt: number }
  ).cnt;
}

/**
 * Get memories created in the last N days, newest first.
 */
export function getRecentMemories(
  db: Database.Database,
  days = 7,
  limit = 50
): Memory[] {
  const rows = db
    .prepare(
      `SELECT * FROM memories
       WHERE created_at >= datetime('now', ?)
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(`-${days} days`, limit) as Array<Record<string, unknown>>;
  return rows.map(rowToMemory);
}

/**
 * Get all memories ingested after a timestamp.
 * Uses ingested_at (when the memory entered the DB) for consolidation correctness.
 */
export function getMemoriesSince(
  db: Database.Database,
  sinceIso: string
): Memory[] {
  const rows = db
    .prepare(
      `SELECT * FROM memories
       WHERE ingested_at > ?
       ORDER BY ingested_at ASC`
    )
    .all(sinceIso) as Array<Record<string, unknown>>;
  return rows.map(rowToMemory);
}

/**
 * Get lesson-type memories from the last N days.
 */
export function getLessons(
  db: Database.Database,
  days = 7,
  project?: string | null
): Memory[] {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  if (project) {
    const rows = db
      .prepare(
        `SELECT * FROM memories
         WHERE memory_type = 'learnings' AND created_at > ? AND project = ?
         ORDER BY created_at DESC`
      )
      .all(cutoff, project) as Array<Record<string, unknown>>;
    return rows.map(rowToMemory);
  }

  const rows = db
    .prepare(
      `SELECT * FROM memories
       WHERE memory_type = 'learnings' AND created_at > ?
       ORDER BY created_at DESC`
    )
    .all(cutoff) as Array<Record<string, unknown>>;
  return rows.map(rowToMemory);
}

/**
 * Get memories older than cutoff with zero access (prune candidates).
 */
export function getPruneCandidates(
  db: Database.Database,
  cutoffIso: string
): Memory[] {
  const rows = db
    .prepare(
      `SELECT * FROM memories
       WHERE created_at < ? AND access_count = 0
       ORDER BY created_at ASC`
    )
    .all(cutoffIso) as Array<Record<string, unknown>>;
  return rows.map(rowToMemory);
}

/**
 * Get link counts for all memories in a single query.
 * Returns a map of memory_id -> total link count (both directions).
 */
export function getAllLinkCounts(
  db: Database.Database
): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT id, COUNT(*) as cnt FROM (
         SELECT source_id AS id FROM memory_links
         UNION ALL
         SELECT target_id AS id FROM memory_links
       ) GROUP BY id`
    )
    .all() as Array<{ id: string; cnt: number }>;

  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.id, row.cnt);
  }
  return counts;
}

/**
 * Get all memories with default base_strength (never scored).
 */
export function getUnscoredMemories(db: Database.Database): Memory[] {
  const rows = db
    .prepare(
      `SELECT * FROM memories
       WHERE base_strength = 0.5
       ORDER BY ingested_at ASC`
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map(rowToMemory);
}
