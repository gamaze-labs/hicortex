/**
 * Database initialization with better-sqlite3 + sqlite-vec.
 * Ported from hicortex/db.py — same schema for migration compatibility.
 */

import Database from "better-sqlite3";
import { existsSync, lstatSync, mkdirSync, renameSync, symlinkSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const EMBEDDING_DIMENSIONS = 384;

/** Canonical Hicortex home directory. */
const HICORTEX_HOME = join(homedir(), ".hicortex");

/** Legacy OC plugin DB path (pre-v0.3 installations). */
const LEGACY_OC_DB = join(homedir(), ".openclaw", "data", "hicortex.db");

/**
 * Resolve the database path. Handles migration from legacy OC location.
 *
 * Priority:
 * 1. Explicit override (env var or config)
 * 2. Canonical ~/.hicortex/hicortex.db (if exists)
 * 3. Legacy ~/.openclaw/data/hicortex.db (migrate to canonical, leave symlink)
 * 4. Default: create ~/.hicortex/hicortex.db
 */
export function resolveDbPath(override?: string): string {
  // 1. Explicit override
  if (override) return override;
  const envOverride = process.env.HICORTEX_DB_PATH;
  if (envOverride) return envOverride;

  const canonicalPath = join(HICORTEX_HOME, "hicortex.db");

  // 2. Canonical path exists — use it
  if (existsSync(canonicalPath)) {
    if (existsSync(LEGACY_OC_DB) && !isSymlink(LEGACY_OC_DB)) {
      console.warn(
        `[hicortex] WARNING: DB exists at both ${canonicalPath} and ${LEGACY_OC_DB}. ` +
        `Using canonical path. Remove the legacy file if it is stale.`
      );
    }
    return canonicalPath;
  }

  // 3. Legacy OC path exists — migrate
  if (existsSync(LEGACY_OC_DB)) {
    return migrateDb(LEGACY_OC_DB, canonicalPath);
  }

  // 4. Fresh install — ensure directory exists
  mkdirSync(HICORTEX_HOME, { recursive: true });
  return canonicalPath;
}

/**
 * Migrate DB from legacy path to canonical ~/.hicortex/.
 * Moves the main DB file plus WAL/SHM if present.
 * Leaves a symlink at the old path for backward compatibility.
 */
function migrateDb(legacyPath: string, canonicalPath: string): string {
  mkdirSync(dirname(canonicalPath), { recursive: true });

  // Move main DB file
  renameSync(legacyPath, canonicalPath);

  // Move WAL and SHM files if present
  for (const suffix of ["-wal", "-shm"]) {
    const legacySuffix = legacyPath + suffix;
    if (existsSync(legacySuffix)) {
      renameSync(legacySuffix, canonicalPath + suffix);
    }
  }

  // Leave symlink at old path for backward compat
  try {
    symlinkSync(canonicalPath, legacyPath);
  } catch {
    // Non-fatal — symlink may fail on some filesystems
  }

  console.log(`[hicortex] Migrated database to ${canonicalPath}`);
  return canonicalPath;
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,

    -- Decay & Strengthening
    base_strength REAL DEFAULT 0.5,
    last_accessed TIMESTAMP,
    access_count INTEGER DEFAULT 0,
    created_at TIMESTAMP NOT NULL,
    ingested_at TIMESTAMP NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f+00:00', 'now')),

    -- Classification
    source_agent TEXT DEFAULT 'default',
    source_session TEXT,
    project TEXT,
    privacy TEXT DEFAULT 'WORK',
    memory_type TEXT DEFAULT 'episode',
    updated_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS memory_links (
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    relationship TEXT NOT NULL,
    strength REAL DEFAULT 0.5,
    created_at TIMESTAMP NOT NULL,
    PRIMARY KEY (source_id, target_id),
    FOREIGN KEY (source_id) REFERENCES memories(id),
    FOREIGN KEY (target_id) REFERENCES memories(id)
);

CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project);
CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(memory_type);
CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);
CREATE INDEX IF NOT EXISTS idx_links_source ON memory_links(source_id);
CREATE INDEX IF NOT EXISTS idx_links_target ON memory_links(target_id);
`;

const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    content,
    content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories
BEGIN
    INSERT INTO memories_fts (rowid, content) VALUES (NEW.rowid, NEW.content);
END;

CREATE TRIGGER IF NOT EXISTS memories_fts_update AFTER UPDATE OF content ON memories
BEGIN
    UPDATE memories_fts SET content = NEW.content WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memories
BEGIN
    DELETE FROM memories_fts WHERE rowid = OLD.rowid;
END;
`;

const VEC_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS memory_vectors USING vec0(
    id TEXT PRIMARY KEY,
    embedding float[${EMBEDDING_DIMENSIONS}]
);
`;

/**
 * Initialize the database: load sqlite-vec, enable WAL, create all tables.
 * Returns the open Database instance (caller manages lifetime).
 */
export function initDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);

  // Load sqlite-vec extension
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sqliteVec = require("sqlite-vec");
  sqliteVec.load(db);

  // Pragmas
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Create core tables and indexes
  db.exec(SCHEMA);

  // Create FTS5 virtual table and sync triggers
  db.exec(FTS_SCHEMA);

  // Create vec0 virtual table
  db.exec(VEC_SCHEMA);

  // Run migrations for existing databases
  migrate(db);

  return db;
}

/**
 * Apply schema migrations for existing databases.
 */
function migrate(db: Database.Database): void {
  const cols = db.pragma("table_info(memories)") as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));

  if (!colNames.has("ingested_at")) {
    db.exec("ALTER TABLE memories ADD COLUMN ingested_at TIMESTAMP");
    db.exec("UPDATE memories SET ingested_at = created_at");
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_memories_ingested ON memories(ingested_at)"
    );
  }

  if (!colNames.has("updated_at")) {
    db.exec("ALTER TABLE memories ADD COLUMN updated_at TIMESTAMP");
  }
}

/**
 * Return database statistics.
 */
export function getStats(
  db: Database.Database,
  dbPath: string
): {
  memories: number;
  links: number;
  db_size_bytes: number;
  by_type: Record<string, number>;
} {
  const memoryCount = (
    db.prepare("SELECT count(*) as cnt FROM memories").get() as {
      cnt: number;
    }
  ).cnt;
  const linkCount = (
    db.prepare("SELECT count(*) as cnt FROM memory_links").get() as {
      cnt: number;
    }
  ).cnt;

  let dbSize = 0;
  try {
    dbSize = statSync(dbPath).size;
  } catch {
    // File may not exist yet
  }

  const typeCounts: Record<string, number> = {};
  const rows = db
    .prepare("SELECT memory_type, count(*) as cnt FROM memories GROUP BY memory_type")
    .all() as Array<{ memory_type: string; cnt: number }>;
  for (const row of rows) {
    typeCounts[row.memory_type] = row.cnt;
  }

  return {
    memories: memoryCount,
    links: linkCount,
    db_size_bytes: dbSize,
    by_type: typeCounts,
  };
}
