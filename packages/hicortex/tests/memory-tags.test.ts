/**
 * Tests for the memory_tags sidecar table (feat/memory-tags + graded-schema
 * spec 2026-07-07):
 *   - migration v6: table + index created, idempotent, FK column shape.
 *   - migration v7: weight column + domain_prototypes table, idempotent.
 *   - setMemoryTags / getMemoryTags round-trip (derived primary → domain,
 *     ordered tag set, per-tag weights, compartment override).
 *   - deleteMemory cascades memory_tags rows.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { initDb, getSchemaVersion } from "../src/db.js";
import * as storage from "../src/storage.js";

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = join(tmpdir(), `hicortex-memtags-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  db = initDb(join(dir, "test.db"));
});

afterEach(() => {
  try { db.close(); } catch { /* already closed */ }
  rmSync(dir, { recursive: true, force: true });
});

function insert(content = "a memory"): string {
  return storage.insertMemory(db, content, new Float32Array(384), {
    sourceAgent: "test",
    project: "p",
    memoryType: "episode",
  });
}

function domainOf(id: string): string | null {
  return (db.prepare("SELECT domain FROM memories WHERE id = ?").get(id) as { domain: string | null }).domain;
}

function weightOf(id: string, tag: string): number | null {
  const row = db
    .prepare("SELECT weight FROM memory_tags WHERE memory_id = ? AND tag = ?")
    .get(id, tag) as { weight: number | null } | undefined;
  return row ? row.weight : null;
}

// ---------------------------------------------------------------------------
// Migration v6
// ---------------------------------------------------------------------------

describe("migration v6 — memory_tags", () => {
  it("creates the memory_tags table at schema version >= 6", () => {
    expect(getSchemaVersion(db)).toBeGreaterThanOrEqual(6);
    const tbl = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_tags'")
      .get();
    expect(tbl).toBeTruthy();
  });

  it("creates the tag index and the (memory_id, tag) primary key", () => {
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_memory_tags_tag'")
      .get();
    expect(idx).toBeTruthy();
    const cols = db.pragma("table_info(memory_tags)") as Array<{ name: string; pk: number }>;
    const pkCols = cols.filter((c) => c.pk > 0).map((c) => c.name).sort();
    expect(pkCols).toEqual(["memory_id", "tag"]);
  });

  it("is idempotent: re-opening the DB does not error or re-apply", () => {
    const v1 = getSchemaVersion(db);
    db.close();
    const db2 = initDb(join(dir, "test.db"));
    try {
      expect(getSchemaVersion(db2)).toBe(v1);
      // Only one row per applied migration.
      const rows = db2.prepare("SELECT COUNT(*) AS c FROM schema_version WHERE version = 6").get() as { c: number };
      expect(rows.c).toBe(1);
    } finally {
      db2.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Migration v7 — graded tag weights (spec 2026-07-07)
// ---------------------------------------------------------------------------

describe("migration v7 — weight column + domain_prototypes", () => {
  it("reaches schema version >= 7", () => {
    expect(getSchemaVersion(db)).toBeGreaterThanOrEqual(7);
  });

  it("adds the REAL weight column to memory_tags (NULL default)", () => {
    const cols = db.pragma("table_info(memory_tags)") as Array<{ name: string; type: string }>;
    const weight = cols.find((c) => c.name === "weight");
    expect(weight).toBeTruthy();
    expect(weight!.type.toUpperCase()).toBe("REAL");

    // Fresh rows without an explicit weight store NULL.
    const id = insert();
    db.prepare("INSERT INTO memory_tags (memory_id, tag) VALUES (?, ?)").run(id, "Work");
    expect(weightOf(id, "Work")).toBeNull();
  });

  it("creates the domain_prototypes table with the documented shape", () => {
    const tbl = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='domain_prototypes'")
      .get();
    expect(tbl).toBeTruthy();
    const cols = db.pragma("table_info(domain_prototypes)") as Array<{ name: string; pk: number }>;
    expect(cols.map((c) => c.name).sort()).toEqual(
      ["domain", "embedding", "member_count", "updated_at"],
    );
    const pk = cols.filter((c) => c.pk > 0).map((c) => c.name);
    expect(pk).toEqual(["domain"]);
  });

  it("is idempotent: re-opening the DB does not error or re-apply v7", () => {
    db.close();
    const db2 = initDb(join(dir, "test.db"));
    try {
      const rows = db2.prepare("SELECT COUNT(*) AS c FROM schema_version WHERE version = 7").get() as { c: number };
      expect(rows.c).toBe(1);
      // Column not duplicated.
      const cols = db2.pragma("table_info(memory_tags)") as Array<{ name: string }>;
      expect(cols.filter((c) => c.name === "weight")).toHaveLength(1);
    } finally {
      db2.close();
    }
  });
});

// ---------------------------------------------------------------------------
// setMemoryTags / getMemoryTags round-trip (graded-schema contract)
// ---------------------------------------------------------------------------

describe("setMemoryTags / getMemoryTags", () => {
  it("derives the primary (argmax weight) into memories.domain and stores the tag set", () => {
    const id = insert();
    const primary = storage.setMemoryTags(db, id, ["Hardware", "Ventures"], {
      weights: { Hardware: 0.4, Ventures: 0.9 },
    });
    expect(primary).toBe("Ventures"); // argmax weight wins over LLM order
    expect(domainOf(id)).toBe("Ventures");
    expect(storage.getMemoryTags(db, id).sort()).toEqual(["Hardware", "Ventures"]);
  });

  it("stores the per-tag weights on the memory_tags rows", () => {
    const id = insert();
    storage.setMemoryTags(db, id, ["Hardware", "Ventures"], {
      weights: { Hardware: 0.4, Ventures: 0.9 },
    });
    expect(weightOf(id, "Hardware")).toBeCloseTo(0.4, 6);
    expect(weightOf(id, "Ventures")).toBeCloseTo(0.9, 6);
  });

  it("falls back to the FIRST tag (LLM order) when no weights are given", () => {
    const id = insert();
    const primary = storage.setMemoryTags(db, id, ["Hardware", "Ventures"]);
    expect(primary).toBe("Hardware");
    expect(domainOf(id)).toBe("Hardware");
    expect(weightOf(id, "Hardware")).toBeNull();
  });

  it("compartment override: a tagged compartment domain wins regardless of weight", () => {
    const id = insert();
    const primary = storage.setMemoryTags(db, id, ["Ventures", "Work"], {
      weights: { Ventures: 0.95, Work: 0.1 },
      compartments: new Set(["Work"]),
    });
    expect(primary).toBe("Work");
    expect(domainOf(id)).toBe("Work");
  });

  it("dedupes duplicate tags (first occurrence kept)", () => {
    const id = insert();
    storage.setMemoryTags(db, id, ["Work", "Work", "Ventures"]);
    expect(storage.getMemoryTags(db, id).sort()).toEqual(["Ventures", "Work"]);
  });

  it("REPLACES the previous tag set (and weights) on a re-classify", () => {
    const id = insert();
    storage.setMemoryTags(db, id, ["Work", "Ventures"], { weights: { Work: 0.8, Ventures: 0.2 } });
    storage.setMemoryTags(db, id, ["Boating"], { weights: { Boating: 0.7 } });
    expect(storage.getMemoryTags(db, id)).toEqual(["Boating"]);
    expect(domainOf(id)).toBe("Boating");
    expect(weightOf(id, "Boating")).toBeCloseTo(0.7, 6);
  });

  it("persists LLM relevance order via rowid (insertion order)", () => {
    const id = insert();
    storage.setMemoryTags(db, id, ["Ventures", "Hardware", "Work"]);
    const inOrder = db
      .prepare("SELECT tag FROM memory_tags WHERE memory_id = ? ORDER BY rowid")
      .all(id) as Array<{ tag: string }>;
    expect(inOrder.map((r) => r.tag)).toEqual(["Ventures", "Hardware", "Work"]);
  });

  it("throws on an empty tag set (fail explicitly)", () => {
    const id = insert();
    expect(() => storage.setMemoryTags(db, id, [])).toThrow(/empty tag set/);
  });

  it("returns [] for a memory with no tags", () => {
    const id = insert();
    expect(storage.getMemoryTags(db, id)).toEqual([]);
  });

  it("getMemoryTagsWeighted returns weight-descending order, NULLs last", () => {
    const id = insert();
    storage.setMemoryTags(db, id, ["A", "B", "C"], { weights: { A: 0.2, B: 0.9 } });
    const weighted = storage.getMemoryTagsWeighted(db, id);
    expect(weighted.map((w) => w.tag)).toEqual(["B", "A", "C"]);
    expect(weighted[2].weight).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// deleteMemory cascade
// ---------------------------------------------------------------------------

describe("deleteMemory cascades memory_tags", () => {
  it("removes the memory's tag rows", () => {
    const id = insert();
    storage.setMemoryTags(db, id, ["Work", "Ventures"]);
    expect(storage.getMemoryTags(db, id)).toHaveLength(2);

    storage.deleteMemory(db, id);
    expect(storage.getMemoryTags(db, id)).toEqual([]);
    const remaining = db.prepare("SELECT COUNT(*) AS c FROM memory_tags WHERE memory_id = ?").get(id) as { c: number };
    expect(remaining.c).toBe(0);
  });

  it("does not touch other memories' tags", () => {
    const a = insert("a");
    const b = insert("b");
    storage.setMemoryTags(db, a, ["Work"]);
    storage.setMemoryTags(db, b, ["Boating"]);
    storage.deleteMemory(db, a);
    expect(storage.getMemoryTags(db, b)).toEqual(["Boating"]);
  });
});
