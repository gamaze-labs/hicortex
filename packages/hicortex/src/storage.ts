/**
 * Storage layer — CRUD operations for the SQLite + sqlite-vec database.
 * Ported from hicortex/storage.py. All functions are synchronous (better-sqlite3).
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Memory, MemoryLink, InsertMemoryOptions } from "./types.js";

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
 * Insert a memory and its vector embedding. Returns the generated UUID.
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

  db.prepare(
    `INSERT INTO memories
     (id, content, base_strength, last_accessed, access_count,
      created_at, ingested_at, source_agent, source_session, project,
      privacy, memory_type)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    content,
    opts.baseStrength ?? 0.5,
    ts,
    ts,
    ingestedTs,
    opts.sourceAgent ?? "default",
    opts.sourceSession ?? null,
    opts.project ?? null,
    opts.privacy ?? "WORK",
    opts.memoryType ?? "episode"
  );

  db.prepare(
    "INSERT INTO memory_vectors (id, embedding) VALUES (?, ?)"
  ).run(id, embedToBlob(embedding));

  return id;
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
 * Delete a memory, its vector, and all its links.
 */
export function deleteMemory(
  db: Database.Database,
  memoryId: string
): void {
  db.prepare(
    "DELETE FROM memory_links WHERE source_id = ? OR target_id = ?"
  ).run(memoryId, memoryId);
  db.prepare("DELETE FROM memory_vectors WHERE id = ?").run(memoryId);
  db.prepare("DELETE FROM memories WHERE id = ?").run(memoryId);
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
// FTS5 search
// ---------------------------------------------------------------------------

/**
 * Full-text search using FTS5 BM25 ranking.
 * Returns memories with a rank field (lower is better).
 */
export function searchFts(
  db: Database.Database,
  query: string,
  limit = 10,
  privacy?: string[],
  sourceAgent?: string
): Array<Memory & { rank: number }> {
  const conditions = ["memories_fts MATCH ?"];
  const params: unknown[] = [query];

  if (privacy && privacy.length > 0) {
    const placeholders = privacy.map(() => "?").join(", ");
    conditions.push(`m.privacy IN (${placeholders})`);
    params.push(...privacy);
  }

  if (sourceAgent) {
    conditions.push("m.source_agent = ?");
    params.push(sourceAgent);
  }

  const where = conditions.join(" AND ");
  params.push(limit);

  const rows = db
    .prepare(
      `SELECT m.*, fts.rank
       FROM memories_fts fts
       JOIN memories m ON m.rowid = fts.rowid
       WHERE ${where}
       ORDER BY fts.rank
       LIMIT ?`
    )
    .all(...params) as Array<Record<string, unknown>>;

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
    sourceSession?: string | null;
    project?: string | null;
    privacy?: string;
    memoryType?: string;
    baseStrength?: number;
  }>
): number {
  const insertMem = db.prepare(
    `INSERT INTO memories
     (id, content, base_strength, last_accessed, access_count,
      created_at, ingested_at, source_agent, source_session, project,
      privacy, memory_type)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`
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
        mem.sourceSession ?? null,
        mem.project ?? null,
        mem.privacy ?? "WORK",
        mem.memoryType ?? "episode"
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
         WHERE memory_type = 'lesson' AND created_at > ? AND project = ?
         ORDER BY created_at DESC`
      )
      .all(cutoff, project) as Array<Record<string, unknown>>;
    return rows.map(rowToMemory);
  }

  const rows = db
    .prepare(
      `SELECT * FROM memories
       WHERE memory_type = 'lesson' AND created_at > ?
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
