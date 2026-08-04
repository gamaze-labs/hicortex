/**
 * Database initialization with better-sqlite3 + sqlite-vec.
 * Ported from hicortex/db.py — same schema for migration compatibility.
 */

import { hicortexHome } from "./paths.js";
import Database from "better-sqlite3";
import { existsSync, lstatSync, mkdirSync, renameSync, symlinkSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const EMBEDDING_DIMENSIONS = 384;

/** Canonical Hicortex home directory. */
const HICORTEX_HOME = hicortexHome();

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

// Fielded FTS5 (#205, migration v10 "fts_fielded"): three columns so bm25()
// can weight matches per field (body / project / domain). Column order matters
// — the weights passed to `bm25(memories_fts, w_body, w_project, w_domain)` in
// storage.searchFts are positional on this declaration. `domain` reads the
// derived PRIMARY `memories.domain` (the argmax-weight tag from the classifier,
// set nightly), NOT a memory_tags join — that was judged too fiddly for this
// phase (a multi-table FTS trigger is fragile and rebuilds on every tag edit).
// `content_rowid='rowid'` is preserved for lockstep with the legacy schema.
const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    content,
    project,
    domain,
    content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories
BEGIN
    INSERT INTO memories_fts (rowid, content, project, domain)
    VALUES (NEW.rowid, NEW.content, NEW.project, NEW.domain);
END;

CREATE TRIGGER IF NOT EXISTS memories_fts_update AFTER UPDATE OF content, project, domain ON memories
BEGIN
    UPDATE memories_fts
       SET content = NEW.content, project = NEW.project, domain = NEW.domain
     WHERE rowid = NEW.rowid;
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

// ---------------------------------------------------------------------------
// Versioned migrations
// ---------------------------------------------------------------------------

interface Migration {
  version: number;
  name: string;
  up: (db: Database.Database) => void;
}

/**
 * Helper: check if a column exists on a table without aborting.
 * Used by migrations to stay idempotent across partially-migrated databases.
 */
function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const cols = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

/**
 * Migrations are append-only. Add new entries at the end with monotonically
 * increasing version numbers. Each migration runs in a single transaction
 * and the schema_version row is inserted only on success.
 *
 * IMPORTANT: never edit a migration after it has shipped — write a new one.
 *
 * IMPORTANT: sqlite-vec virtual tables (memory_vectors) and FTS5 virtual
 * tables (memories_fts) cannot be ALTER'd. If a future Pro feature needs
 * per-vector metadata, add a sidecar table and JOIN, do not try to extend
 * the virtual table in place.
 */
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "add_ingested_at",
    up: (db) => {
      if (!hasColumn(db, "memories", "ingested_at")) {
        db.exec("ALTER TABLE memories ADD COLUMN ingested_at TIMESTAMP");
        db.exec("UPDATE memories SET ingested_at = created_at WHERE ingested_at IS NULL");
      }
      db.exec("CREATE INDEX IF NOT EXISTS idx_memories_ingested ON memories(ingested_at)");
    },
  },
  {
    version: 2,
    name: "add_updated_at",
    up: (db) => {
      if (!hasColumn(db, "memories", "updated_at")) {
        db.exec("ALTER TABLE memories ADD COLUMN updated_at TIMESTAMP");
      }
    },
  },
  {
    version: 3,
    name: "add_domain",
    up: (db) => {
      if (!hasColumn(db, "memories", "domain")) {
        db.exec("ALTER TABLE memories ADD COLUMN domain TEXT");
      }
      db.exec("CREATE INDEX IF NOT EXISTS idx_memories_domain ON memories(domain)");
    },
  },
  {
    version: 4,
    name: "unique_source_session",
    up: (db) => {
      // De-duplicate any pre-existing source_session values (e.g. from the
      // /ingest + /distill race before this migration): keep the oldest row per
      // source_session, NULL the rest so they lose their dedup key (the memory
      // itself is preserved). Then add a UNIQUE partial index so the server can
      // idempotently re-distill a segment without double-inserting.
      db.exec(`
        UPDATE memories SET source_session = NULL
        WHERE rowid NOT IN (
          SELECT MIN(rowid) FROM memories
          WHERE source_session IS NOT NULL
          GROUP BY source_session
        )
        AND source_session IS NOT NULL
      `);
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_source_session_unique
          ON memories(source_session) WHERE source_session IS NOT NULL
      `);
    },
  },
  {
    version: 5,
    name: "rescale_link_strength_to_cosine",
    up: (db) => {
      // memory_links.strength was stored on an accidental 1−L2 scale
      // (consolidate.ts computed similarity as `1 − distance`, where distance
      // is sqlite-vec's L2 distance). Embeddings are L2-normalized, so the
      // true cosine is 1 − d²/2; with old = 1 − d this rewrites to
      //   cosine = 1 − (1 − old)² / 2.
      // LLM-classified links also stored the candidate similarity as
      // strength, so the rewrite applies to ALL rows. Guarded to strengths in
      // (0, 1] — the only range the old formula could have written above the
      // link threshold (values are 0.55–0.8 in practice); anything outside is
      // left untouched. The rewrite is NOT self-idempotent: it must run
      // exactly once, which the schema_version gate in migrate() guarantees
      // (up() and the version-row insert share one transaction).
      db.exec(`
        UPDATE memory_links
        SET strength = 1.0 - ((1.0 - strength) * (1.0 - strength)) / 2.0
        WHERE strength > 0 AND strength <= 1
      `);
    },
  },
  {
    version: 6,
    name: "add_memory_tags",
    up: (db) => {
      // Multi-tag classification (feat/memory-tags). `memories.domain` keeps its
      // meaning as the PRIMARY tag; this sidecar table carries the full label
      // set (including the primary). Sidecar (not a virtual-table column) per
      // the migration rules above. FK → memories(id); deletes cascade in code
      // (storage.deleteMemory) since foreign_keys pragma is on but existing rows
      // predate the constraint. Idempotent: IF NOT EXISTS on table + index.
      db.exec(`
        CREATE TABLE IF NOT EXISTS memory_tags (
          memory_id TEXT NOT NULL,
          tag TEXT NOT NULL,
          PRIMARY KEY (memory_id, tag),
          FOREIGN KEY (memory_id) REFERENCES memories(id)
        )
      `);
      db.exec("CREATE INDEX IF NOT EXISTS idx_memory_tags_tag ON memory_tags(tag)");
    },
  },
  {
    version: 7,
    name: "graded_tag_weights",
    up: (db) => {
      // Graded schema membership (spec 2026-07-07): every tag assignment gets a
      // derived association weight = cosine(memory embedding, domain prototype).
      // NULL until the first prototype/weight computation runs (nightly stage or
      // classification-time write). Guarded with hasColumn for idempotency
      // across partially-migrated databases.
      if (!hasColumn(db, "memory_tags", "weight")) {
        db.exec("ALTER TABLE memory_tags ADD COLUMN weight REAL");
      }
      // Domain prototypes: L2-normalized centroid of member embeddings (or the
      // embedded config description as a cold-start seed when member_count < 5).
      // Sidecar table, NOT a vec0 virtual table — prototypes are point-read by
      // name, never KNN-searched (see the virtual-table rule above).
      db.exec(`
        CREATE TABLE IF NOT EXISTS domain_prototypes (
          domain TEXT PRIMARY KEY,
          embedding BLOB,
          member_count INTEGER,
          updated_at TIMESTAMP
        )
      `);
    },
  },
  {
    version: 8,
    name: "add_shown_count",
    up: (db) => {
      // #192 recall alignment: exposure tracking separate from use. shown_count
      // counts appearances in the pushed recall index (/recall-index), which
      // refreshes last_accessed (mild strengthen: decay clock resets) but does
      // NOT touch access_count — hardening, the prune shield, and the adoption
      // metric (uses per showing) stay driven by real use only.
      if (!hasColumn(db, "memories", "shown_count")) {
        db.exec("ALTER TABLE memories ADD COLUMN shown_count INTEGER DEFAULT 0");
      }
    },
  },
  {
    version: 9,
    name: "add_dedup_log",
    up: (db) => {
      // `hicortex dedup` (#100) audit trail. Every merged-away loser gets a
      // row here BEFORE it is deleted, keyed by loser_id so a loser can only
      // be logged once (defensive — the CLI never re-merges a deleted id).
      // `source_session` is the loser's OWN source_session value (may be
      // NULL): it is CRITICAL that /distill's dedup prechecks in
      // mcp-server.ts also consult this table, because a deleted loser may
      // have carried the ONLY marker for a session — without this table a
      // `--recapture-window` run could re-ingest content the merge already
      // consolidated. Sidecar table (not a memories column) since it survives
      // the row it describes being deleted.
      db.exec(`
        CREATE TABLE IF NOT EXISTS dedup_log (
          loser_id TEXT PRIMARY KEY,
          canonical_id TEXT NOT NULL,
          source_session TEXT,
          content_head TEXT,
          merged_at TIMESTAMP NOT NULL
        )
      `);
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_dedup_log_source_session ON dedup_log(source_session)",
      );
    },
  },
  {
    version: 10,
    name: "fts_fielded",
    up: (db) => {
      // #205 fielded BM25F. FTS5 cannot be ALTERed (see the virtual-table rule
      // above), so the single-column `memories_fts(content)` from pre-v10 must
      // be dropped + recreated multi-column (`content, project, domain`) and
      // rebuilt from the canonical `memories` rows. The runner wraps up() in a
      // single transaction (db.ts:216) — that transaction IS the crash window:
      // a power loss mid-migration rolls back, leaving the OLD single-column
      // FTS intact (recall falls back to vector-only until the next open;
      // never silently empty). The nightly capture lock does NOT cover
      // initDb migrations, so the tx guard is the only safety net.
      //
      // Idempotent by construction: DROP IF EXISTS + CREATE + rebuild. On a
      // fresh DB (where FTS_SCHEMA already created the multi-column form) this
      // is a 0-row rebuild — wasted but harmless. On a legacy single-column DB
      // it converts in place. Re-running against an already-migrated DB is a
      // no-op shape + a refill of the same rows.
      //
      // Triggers are dropped + recreated to pick up the new column list (the
      // pre-v10 update trigger fired only on `UPDATE OF content`; the new one
      // also fires on project/domain updates so a tag reclassification lands
      // in FTS without a content edit).
      db.exec("DROP TRIGGER IF EXISTS memories_fts_insert");
      db.exec("DROP TRIGGER IF EXISTS memories_fts_update");
      db.exec("DROP TRIGGER IF EXISTS memories_fts_delete");
      db.exec("DROP TABLE IF EXISTS memories_fts");
      db.exec(`
        CREATE VIRTUAL TABLE memories_fts USING fts5(
          content,
          project,
          domain,
          content_rowid='rowid'
        )
      `);
      // COALESCE on project/domain because FTS5 stores NULL as no-tokens,
      // which is what we want for unscoped memories (NULL domain = not yet
      // classified; NULL project = no cwd-derived label). content is NOT NULL
      // by the insert contract.
      db.exec(`
        INSERT INTO memories_fts (rowid, content, project, domain)
        SELECT rowid, content, COALESCE(project, ''), COALESCE(domain, '') FROM memories
      `);
      db.exec(`
        CREATE TRIGGER memories_fts_insert AFTER INSERT ON memories
        BEGIN
          INSERT INTO memories_fts (rowid, content, project, domain)
          VALUES (NEW.rowid, NEW.content, NEW.project, NEW.domain);
        END
      `);
      db.exec(`
        CREATE TRIGGER memories_fts_update AFTER UPDATE OF content, project, domain ON memories
        BEGIN
          UPDATE memories_fts
             SET content = NEW.content, project = NEW.project, domain = NEW.domain
           WHERE rowid = NEW.rowid;
        END
      `);
      db.exec(`
        CREATE TRIGGER memories_fts_delete AFTER DELETE ON memories
        BEGIN
          DELETE FROM memories_fts WHERE rowid = OLD.rowid;
        END
      `);
    },
  },
  {
    version: 11,
    name: "add_source_attribution",
    up: (db) => {
      // 0.16.x attribution + provenance. Two nullable columns on `memories`,
      // both populated ONLY by capture (/distill) from client-declared values;
      // nothing filters, scopes, or scores on either (attribution + echo).
      //
      // `source_agent_id`: the capturing client's stable UUID (config.json
      //   `agentId`, generated once by init). Survives agent/machine renames
      //   — unlike `source_agent`, a readable name. NULL on legacy rows.
      // `source_domain`: the client-declared topic/domain of the capturing
      //   agent (config.json `domain`). Distinct from the content-classified
      //   `domain` column (which stays the LLM/prototype-derived primary).
      // Guarded with hasColumn for idempotency across partially-migrated DBs.
      if (!hasColumn(db, "memories", "source_agent_id")) {
        db.exec("ALTER TABLE memories ADD COLUMN source_agent_id TEXT");
      }
      if (!hasColumn(db, "memories", "source_domain")) {
        db.exec("ALTER TABLE memories ADD COLUMN source_domain TEXT");
      }
    },
  },
];

/**
 * Run all pending migrations against the database.
 *
 * Creates the schema_version tracking table if missing, then applies any
 * migration whose version > the current max. Each migration runs inside its
 * own transaction so a partial failure rolls back cleanly. Existing databases
 * with the relevant columns already present pass through as no-ops because
 * each migration's up() is idempotent.
 */
function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const row = db
    .prepare("SELECT MAX(version) as v FROM schema_version")
    .get() as { v: number | null };
  const currentVersion = row.v ?? 0;

  const pending = MIGRATIONS.filter((m) => m.version > currentVersion);
  if (pending.length === 0) return;

  for (const m of pending) {
    const tx = db.transaction(() => {
      m.up(db);
      db.prepare(
        "INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)",
      ).run(m.version, m.name, new Date().toISOString());
    });

    try {
      tx();
      console.log(`[hicortex] Applied migration ${m.version}: ${m.name}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Migration ${m.version} (${m.name}) failed: ${msg}`);
    }
  }
}

/** Read the currently-applied schema version. Returns 0 if no migrations applied. */
export function getSchemaVersion(db: Database.Database): number {
  try {
    const row = db
      .prepare("SELECT MAX(version) as v FROM schema_version")
      .get() as { v: number | null };
    return row.v ?? 0;
  } catch {
    return 0;
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
