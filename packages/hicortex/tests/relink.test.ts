/**
 * Tests for `hicortex relink` (issue #143) — resumable link-discovery pass
 * over the entire memories corpus.
 *
 * Classification is heuristic-only (LLM edge classification retired 2026-07),
 * so the emitted vocabulary is exactly `extends` / `relates_to`.
 *
 * Covers: link creation, pair dedup (incl. reverse direction), cursor resume
 * across batches, --reset, --dry-run (zero writes), client-mode refusal, and
 * the stored-embedding read with missing-vector fallback.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { initDb } from "../src/db.js";
import * as storage from "../src/storage.js";
import { runRelink, getStoredEmbedding } from "../src/relink.js";
import { loadState } from "../src/state.js";
import { VALID_RELATIONSHIP_TYPES } from "../src/types.js";

const TEST_DIR = join(tmpdir(), `hicortex-relink-test-${randomUUID().slice(0, 8)}`);

// The only two relationship types the heuristic ever emits now.
const HEURISTIC_TYPES = new Set(["extends", "relates_to"]);

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** One-hot-ish embedding: clusters share a vector, clusters are far apart. */
function clusterEmbedding(cluster: number): Float32Array {
  const arr = new Float32Array(384);
  arr[cluster] = 1.0;
  return arr;
}

interface Fixture {
  db: Database.Database;
  dbPath: string;
  stateDir: string;
  ids: string[];
}

/**
 * Seed a temp DB with two clusters of identical embeddings:
 *   cluster A: 3 memories (3 unordered pairs)
 *   cluster B: 2 memories (1 unordered pair)
 * Within a cluster: L2 distance 0 → cosine 1.0 (above the 0.75 threshold).
 * Cross-cluster (orthogonal one-hot vectors): L2 distance √2 → cosine 0,
 * far below the 0.75 threshold.
 * Expected links from a full relink pass: 4.
 */
function seedDb(name: string): Fixture {
  const dir = join(TEST_DIR, name);
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, "test.db");
  const stateDir = join(dir, "state");
  mkdirSync(stateDir, { recursive: true });
  const db = initDb(dbPath);

  const ids: string[] = [];
  const specs = [
    { cluster: 0, content: "Deploy pipeline uses systemd timers on bedrock" },
    { cluster: 0, content: "Deploy pipeline switched to systemd user units" },
    { cluster: 0, content: "Deploy pipeline health check added to systemd unit" },
    { cluster: 100, content: "Embedding model is bge-small running on CPU" },
    { cluster: 100, content: "Embedding model upgraded to ONNX runtime" },
  ];
  specs.forEach((spec, i) => {
    ids.push(
      storage.insertMemory(db, spec.content, clusterEmbedding(spec.cluster), {
        sourceAgent: "relink-test",
        project: "relink-proj",
        memoryType: "episode",
        // Distinct timestamps so the heuristic can pick "updates" for cosine > 0.9
        createdAt: `2026-01-0${i + 1}T00:00:00.000Z`,
      }),
    );
  });

  return { db, dbPath, stateDir, ids };
}

const EXPECTED_LINKS = 4;

/** All links as unordered pair keys — asserts no bidirectional duplicates. */
function unorderedPairs(db: Database.Database): string[] {
  const rows = db
    .prepare("SELECT source_id, target_id FROM memory_links")
    .all() as Array<{ source_id: string; target_id: string }>;
  return rows.map((r) =>
    r.source_id < r.target_id ? `${r.source_id}|${r.target_id}` : `${r.target_id}|${r.source_id}`,
  );
}

function linkCount(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM memory_links").get() as { c: number }).c;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("relink — heuristic classification", () => {
  it("creates the expected links with heuristic types only", async () => {
    const fx = seedDb(`heuristic-${randomUUID().slice(0, 6)}`);
    try {
      const report = await runRelink({
        dbPath: fx.dbPath,
        stateDir: fx.stateDir,
      });

      expect(report.stoppedReason).toBe("complete");
      expect(report.scanned).toBe(5);
      expect(report.linksCreated).toBe(EXPECTED_LINKS);
      expect(report.llmClassified).toBe(0);
      expect(report.heuristicFallback).toBe(EXPECTED_LINKS);
      expect(report.failed).toBe(0);
      // Fresh DB: nothing was "already linked"; the reverse discoveries of
      // each pair are within-run duplicates (8 candidates → 4 links + 4 dups).
      expect(report.skippedExisting).toBe(0);
      expect(report.skippedDuplicate).toBe(4);
      expect(linkCount(fx.db)).toBe(EXPECTED_LINKS);

      // Heuristic types only, all valid
      const rows = fx.db
        .prepare("SELECT relationship FROM memory_links")
        .all() as Array<{ relationship: string }>;
      for (const row of rows) {
        expect(HEURISTIC_TYPES.has(row.relationship)).toBe(true);
      }
      // byType breakdown sums to links created
      const byTypeSum = Object.values(report.byType).reduce((a, b) => a + b, 0);
      expect(byTypeSum).toBe(EXPECTED_LINKS);
      for (const t of Object.keys(report.byType)) {
        expect(HEURISTIC_TYPES.has(t)).toBe(true);
      }

      // No bidirectional duplicates
      const pairs = unorderedPairs(fx.db);
      expect(new Set(pairs).size).toBe(pairs.length);

      // Cursor persisted at the last rowid
      expect(loadState(fx.stateDir).relinkCursor).toBe(5);
    } finally {
      fx.db.close();
    }
  });

  it("re-run with --reset creates ZERO new links (pair dedup)", async () => {
    const fx = seedDb(`rerun-${randomUUID().slice(0, 6)}`);
    try {
      await runRelink({ dbPath: fx.dbPath, stateDir: fx.stateDir });
      expect(linkCount(fx.db)).toBe(EXPECTED_LINKS);

      const report2 = await runRelink({
        reset: true,
        dbPath: fx.dbPath,
        stateDir: fx.stateDir,
      });

      expect(report2.scanned).toBe(5);
      expect(report2.linksCreated).toBe(0);
      // Every discovery (both directions of all 4 pairs) hits a pre-existing link
      expect(report2.skippedExisting).toBe(8);
      expect(report2.skippedDuplicate).toBe(0);
      expect(linkCount(fx.db)).toBe(EXPECTED_LINKS);
      const pairs = unorderedPairs(fx.db);
      expect(new Set(pairs).size).toBe(pairs.length);
    } finally {
      fx.db.close();
    }
  });

  it("skips candidates whose REVERSE direction already exists", async () => {
    const dir = join(TEST_DIR, `reverse-${randomUUID().slice(0, 6)}`);
    mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, "test.db");
    const stateDir = join(dir, "state");
    mkdirSync(stateDir, { recursive: true });
    const db = initDb(dbPath);
    try {
      const idA = storage.insertMemory(db, "Memory A about caching", clusterEmbedding(0), {
        project: "p",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      const idB = storage.insertMemory(db, "Memory B about caching too", clusterEmbedding(0), {
        project: "p",
        createdAt: "2026-01-02T00:00:00.000Z",
      });
      // Pre-existing link in the direction relink would NOT insert first (B→A)
      storage.addLink(db, idB, idA, "relates_to", 0.9);

      const report = await runRelink({ dbPath, stateDir });

      expect(report.linksCreated).toBe(0);
      // Both directions of the pair hit the pre-existing B→A link
      expect(report.skippedExisting).toBe(2);
      expect(report.skippedDuplicate).toBe(0);
      expect(linkCount(db)).toBe(1);
      // The original direction is untouched
      const row = db
        .prepare("SELECT source_id, target_id FROM memory_links")
        .get() as { source_id: string; target_id: string };
      expect(row.source_id).toBe(idB);
      expect(row.target_id).toBe(idA);
    } finally {
      db.close();
    }
  });
});

describe("relink — batched resume (heuristic-only)", () => {
  it("processes in batches, advancing the cursor, with no duplicate links", async () => {
    const fx = seedDb(`resume-${randomUUID().slice(0, 6)}`);
    try {
      // Batch of 2 → first pass over rowids 1..2 only.
      const report1 = await runRelink({
        batchSize: 2,
        dbPath: fx.dbPath,
        stateDir: fx.stateDir,
      });

      expect(report1.stoppedReason).toBe("complete");
      expect(report1.scanned).toBe(5); // heuristic-only never stops early
      expect(loadState(fx.stateDir).relinkCursor).toBe(5);
      expect(linkCount(fx.db)).toBe(EXPECTED_LINKS);

      // Re-run without --reset — cursor at end, nothing to do, no duplicates.
      const report2 = await runRelink({
        batchSize: 2,
        dbPath: fx.dbPath,
        stateDir: fx.stateDir,
      });

      expect(report2.stoppedReason).toBe("complete");
      expect(report2.scanned).toBe(0);
      expect(linkCount(fx.db)).toBe(EXPECTED_LINKS);
      const pairs = unorderedPairs(fx.db);
      expect(new Set(pairs).size).toBe(pairs.length);
    } finally {
      fx.db.close();
    }
  });

  it("resumes mid-corpus from a saved cursor without re-linking earlier rows", async () => {
    const fx = seedDb(`midresume-${randomUUID().slice(0, 6)}`);
    try {
      // Simulate an interruption: seed the cursor at rowid 2, then run.
      const { updateState } = await import("../src/state.js");
      updateState((s) => {
        s.relinkCursor = 2;
      }, fx.stateDir);

      const report = await runRelink({
        batchSize: 2,
        dbPath: fx.dbPath,
        stateDir: fx.stateDir,
      });

      expect(report.stoppedReason).toBe("complete");
      expect(report.scanned).toBe(3); // rowids 3..5 only
      expect(loadState(fx.stateDir).relinkCursor).toBe(5);
      const pairs = unorderedPairs(fx.db);
      expect(new Set(pairs).size).toBe(pairs.length);
    } finally {
      fx.db.close();
    }
  });

  it("llmClassified is always 0 (LLM classification retired)", async () => {
    const fx = seedDb(`nollm-${randomUUID().slice(0, 6)}`);
    try {
      const report = await runRelink({ dbPath: fx.dbPath, stateDir: fx.stateDir });
      expect(report.llmClassified).toBe(0);
      expect(report.heuristicFallback).toBe(EXPECTED_LINKS);
      for (const t of Object.keys(report.byType)) {
        expect(HEURISTIC_TYPES.has(t)).toBe(true);
      }
    } finally {
      fx.db.close();
    }
  });
});

describe("relink — cursor semantics", () => {
  it("a completed run leaves nothing to scan; --reset rescans everything", async () => {
    const fx = seedDb(`reset-${randomUUID().slice(0, 6)}`);
    try {
      await runRelink({ dbPath: fx.dbPath, stateDir: fx.stateDir });

      // Without reset: cursor is at the end, nothing scanned.
      const noReset = await runRelink({ dbPath: fx.dbPath, stateDir: fx.stateDir });
      expect(noReset.scanned).toBe(0);
      expect(noReset.batches).toBe(0);

      // With reset: full rescan (but dedup keeps the graph unchanged).
      const withReset = await runRelink({
        reset: true,
        dbPath: fx.dbPath,
        stateDir: fx.stateDir,
      });
      expect(withReset.scanned).toBe(5);
      expect(withReset.linksCreated).toBe(0);
      expect(linkCount(fx.db)).toBe(EXPECTED_LINKS);
    } finally {
      fx.db.close();
    }
  });
});

describe("relink — dry-run", () => {
  it("writes nothing: no links, cursor untouched, heuristic breakdown reported", async () => {
    const fx = seedDb(`dry-${randomUUID().slice(0, 6)}`);
    try {
      const stateBefore = JSON.stringify(loadState(fx.stateDir));

      const report = await runRelink({
        dryRun: true,
        dbPath: fx.dbPath,
        stateDir: fx.stateDir,
      });

      expect(report.dryRun).toBe(true);
      expect(report.scanned).toBe(5);
      expect(report.linksCreated).toBe(EXPECTED_LINKS); // would-be count
      // Classification is heuristic-only now — llmClassified is always 0.
      expect(report.llmClassified).toBe(0);
      expect(report.heuristicFallback).toBe(EXPECTED_LINKS);
      expect(report.skippedExisting).toBe(0); // fresh DB — nothing pre-existing
      expect(report.skippedDuplicate).toBe(4);
      for (const t of Object.keys(report.byType)) {
        expect(HEURISTIC_TYPES.has(t)).toBe(true);
      }

      // Zero writes
      expect(linkCount(fx.db)).toBe(0);
      expect(JSON.stringify(loadState(fx.stateDir))).toBe(stateBefore);
      expect(loadState(fx.stateDir).relinkCursor).toBeUndefined();
    } finally {
      fx.db.close();
    }
  });
});

describe("relink — guards", () => {
  it("refuses to run in client mode", async () => {
    const dir = join(TEST_DIR, `client-${randomUUID().slice(0, 6)}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "config.json"),
      JSON.stringify({ mode: "client", serverUrl: "http://bedrock:8787" }),
    );

    await expect(
      runRelink({ stateDir: dir, dbPath: join(dir, "unused.db") }),
    ).rejects.toThrow(/server-mode only/);
  });

  it("rejects invalid --batch values", async () => {
    await expect(runRelink({ batchSize: 0 })).rejects.toThrow(/invalid --batch/);
    await expect(runRelink({ batchSize: -5 })).rejects.toThrow(/invalid --batch/);
  });
});

describe("relink — stored embeddings", () => {
  it("getStoredEmbedding returns the exact stored vector", () => {
    const dir = join(TEST_DIR, `stored-${randomUUID().slice(0, 6)}`);
    mkdirSync(dir, { recursive: true });
    const db = initDb(join(dir, "test.db"));
    try {
      const emb = clusterEmbedding(7);
      const id = storage.insertMemory(db, "stored embedding check", emb, {});
      const roundTrip = getStoredEmbedding(db, id);
      expect(roundTrip).not.toBeNull();
      expect(Array.from(roundTrip!)).toEqual(Array.from(emb));
      expect(getStoredEmbedding(db, "no-such-id")).toBeNull();
    } finally {
      db.close();
    }
  });

  it("falls back to the embedder only for memories missing a vector row", async () => {
    const dir = join(TEST_DIR, `fallback-${randomUUID().slice(0, 6)}`);
    mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, "test.db");
    const stateDir = join(dir, "state");
    mkdirSync(stateDir, { recursive: true });
    const db = initDb(dbPath);
    try {
      const idA = storage.insertMemory(db, "vector present", clusterEmbedding(0), {
        project: "p",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      const idB = storage.insertMemory(db, "vector missing", clusterEmbedding(0), {
        project: "p",
        createdAt: "2026-01-02T00:00:00.000Z",
      });
      // Simulate a legacy row without a stored vector
      db.prepare("DELETE FROM memory_vectors WHERE id = ?").run(idB);
      expect(getStoredEmbedding(db, idB)).toBeNull();

      const embedCalls: string[] = [];
      const report = await runRelink({
        dbPath,
        stateDir,
        embedFn: async (text: string) => {
          embedCalls.push(text);
          return clusterEmbedding(0);
        },
      });

      // Fallback used exactly once (only for the missing row)
      expect(embedCalls).toEqual(["vector missing"]);
      expect(report.failed).toBe(0);
      // idB has no vector row, so idA's search can't see it — but idB's own
      // fallback embedding finds idA → exactly one link either way.
      expect(linkCount(db)).toBe(1);
      const row = db
        .prepare("SELECT source_id, target_id FROM memory_links")
        .get() as { source_id: string; target_id: string };
      expect([row.source_id, row.target_id].sort()).toEqual([idA, idB].sort());
    } finally {
      db.close();
    }
  });
});

describe("relink — nightly refactor safety", () => {
  it("exports the shared machinery consumed by stageLinks", async () => {
    const consolidate = await import("../src/consolidate.js");
    // Cosine-space threshold (calibrated on the production corpus) + top-K cap
    expect(consolidate.CONSOLIDATE_LINK_THRESHOLD).toBe(0.75);
    expect(consolidate.CONSOLIDATE_LINK_TOP_K).toBe(3);
    // Cross-project strength floor (2026-07 link-classification audit)
    expect(consolidate.CROSS_PROJECT_LINK_THRESHOLD).toBe(0.8);
    expect(typeof consolidate.l2ToCosine).toBe("function");
    expect(typeof consolidate.discoverLinkCandidates).toBe("function");
    expect(typeof consolidate.classifyLinkCandidates).toBe("function");
    expect(typeof consolidate.classifyRelationship).toBe("function");
  });

  it("classifyRelationship returns ONLY extends | relates_to (retired types not emitted)", async () => {
    const { classifyRelationship } = await import("../src/consolidate.js");
    const mem = (over: Partial<Record<string, unknown>>) =>
      ({
        id: randomUUID(),
        content: "x",
        memory_type: "episode",
        project: "p",
        created_at: "2026-01-01T00:00:00.000Z",
        ...over,
      }) as any;

    // Same project + above the link threshold → extends
    expect(
      classifyRelationship(mem({}), mem({ created_at: "2026-01-02T00:00:00.000Z" }), 0.85),
    ).toBe("extends");
    // Very high cosine, same project → still extends (no "updates" anymore)
    expect(
      classifyRelationship(mem({}), mem({ created_at: "2026-01-02T00:00:00.000Z" }), 0.95),
    ).toBe("extends");
    // lesson ← episode used to be "derives" — now relates_to (cross project or
    // low sim path). Same project + high sim → extends regardless of type.
    expect(
      classifyRelationship(mem({ memory_type: "lesson" }), mem({}), 0.95),
    ).toBe("extends");
    // Boundary: exactly 0.75 is NOT above the threshold (strict >) → relates_to
    expect(
      classifyRelationship(mem({}), mem({ created_at: "2026-01-02T00:00:00.000Z" }), 0.75),
    ).toBe("relates_to");
    // Different projects → relates_to (never extends)
    expect(
      classifyRelationship(mem({ project: "a" }), mem({ project: "b" }), 0.99),
    ).toBe("relates_to");
    // No project on either side → relates_to
    expect(
      classifyRelationship(mem({ project: null }), mem({ project: null }), 0.99),
    ).toBe("relates_to");

    // Exhaustive: the function NEVER returns a retired type.
    const RETIRED = new Set([
      "derives",
      "updates",
      "CONTRADICTS",
      "SUPERSEDES",
      "DEPENDS_ON",
      "CAUSED_BY",
      "VALIDATES",
    ]);
    for (const sim of [0.76, 0.8, 0.9, 0.95, 0.99, 1.0]) {
      for (const [pa, pb] of [
        ["p", "p"],
        ["a", "b"],
        [null, null],
      ] as Array<[string | null, string | null]>) {
        for (const [ta, tb] of [
          ["episode", "episode"],
          ["lesson", "episode"],
          ["episode", "lesson"],
        ]) {
          const out = classifyRelationship(
            mem({ project: pa, memory_type: ta }),
            mem({ project: pb, memory_type: tb, created_at: "2026-02-02T00:00:00.000Z" }),
            sim,
          );
          expect(HEURISTIC_TYPES.has(out)).toBe(true);
          expect(RETIRED.has(out)).toBe(false);
        }
      }
    }

    // The emitted types remain valid relationship types.
    for (const t of ["extends", "relates_to"]) {
      expect((VALID_RELATIONSHIP_TYPES as readonly string[]).includes(t)).toBe(true);
    }
  });
});

describe("cross-project link guard (2026-07 audit)", () => {
  it("rejects a cross-project candidate below CROSS_PROJECT_LINK_THRESHOLD (0.80)", async () => {
    const { discoverLinkCandidates } = await import("../src/consolidate.js");
    const dir = join(TEST_DIR, `xproj-below-${randomUUID().slice(0, 6)}`);
    mkdirSync(dir, { recursive: true });
    const db = initDb(join(dir, "test.db"));
    try {
      // Query vector e0; neighbor at cosine 0.78 (above same-project 0.75 but
      // below the cross-project 0.80 floor).
      const e0 = clusterEmbedding(0);
      const atCosine = (cos: number): Float32Array => {
        const arr = new Float32Array(384);
        arr[0] = cos;
        arr[1] = Math.sqrt(1 - cos * cos);
        return arr;
      };
      const queryId = storage.insertMemory(db, "query in project A", e0, {
        project: "proj-a",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      storage.insertMemory(db, "neighbor in project B", atCosine(0.78), {
        project: "proj-b",
        createdAt: "2026-01-02T00:00:00.000Z",
      });

      const mem = storage.getMemory(db, queryId)!;
      const candidates = discoverLinkCandidates(db, mem, e0);
      expect(candidates.length).toBe(0);
    } finally {
      db.close();
    }
  });

  it("allows a cross-project candidate at/above 0.80 (typed relates_to)", async () => {
    const { discoverLinkCandidates } = await import("../src/consolidate.js");
    const dir = join(TEST_DIR, `xproj-above-${randomUUID().slice(0, 6)}`);
    mkdirSync(dir, { recursive: true });
    const db = initDb(join(dir, "test.db"));
    try {
      const e0 = clusterEmbedding(0);
      const atCosine = (cos: number): Float32Array => {
        const arr = new Float32Array(384);
        arr[0] = cos;
        arr[1] = Math.sqrt(1 - cos * cos);
        return arr;
      };
      const queryId = storage.insertMemory(db, "query in project A", e0, {
        project: "proj-a",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      storage.insertMemory(db, "strong cross-project neighbor", atCosine(0.9), {
        project: "proj-b",
        createdAt: "2026-01-02T00:00:00.000Z",
      });

      const mem = storage.getMemory(db, queryId)!;
      const candidates = discoverLinkCandidates(db, mem, e0);
      expect(candidates.length).toBe(1);
      expect(candidates[0].similarity).toBeGreaterThanOrEqual(0.8);
      // Cross-project is never "extends"
      expect(candidates[0].heuristicType).toBe("relates_to");
    } finally {
      db.close();
    }
  });

  it("same-project candidate uses the 0.75 floor (0.78 accepted → extends)", async () => {
    const { discoverLinkCandidates } = await import("../src/consolidate.js");
    const dir = join(TEST_DIR, `sameproj-${randomUUID().slice(0, 6)}`);
    mkdirSync(dir, { recursive: true });
    const db = initDb(join(dir, "test.db"));
    try {
      const e0 = clusterEmbedding(0);
      const atCosine = (cos: number): Float32Array => {
        const arr = new Float32Array(384);
        arr[0] = cos;
        arr[1] = Math.sqrt(1 - cos * cos);
        return arr;
      };
      const queryId = storage.insertMemory(db, "query in project A", e0, {
        project: "proj-a",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      storage.insertMemory(db, "same-project neighbor at 0.78", atCosine(0.78), {
        project: "proj-a",
        createdAt: "2026-01-02T00:00:00.000Z",
      });

      const mem = storage.getMemory(db, queryId)!;
      const candidates = discoverLinkCandidates(db, mem, e0);
      // 0.78 clears the same-project 0.75 floor.
      expect(candidates.length).toBe(1);
      expect(candidates[0].heuristicType).toBe("extends");
    } finally {
      db.close();
    }
  });
});

describe("link similarity semantics (L2 → cosine)", () => {
  it("l2ToCosine converts exactly: d=0 → 1, d=0.7071 → 0.75, d=√2 → 0", async () => {
    const { l2ToCosine } = await import("../src/consolidate.js");
    expect(l2ToCosine(0)).toBe(1.0);
    // d = √0.5 ≈ 0.7071 → cos = 1 − 0.5/2 = 0.75 (the link threshold)
    expect(l2ToCosine(0.7071)).toBeCloseTo(0.75, 4);
    expect(l2ToCosine(Math.sqrt(0.5))).toBeCloseTo(0.75, 12);
    // Orthogonal unit vectors: d = √2 → cos = 0
    expect(l2ToCosine(Math.SQRT2)).toBeCloseTo(0, 12);
    // Antipodal unit vectors: d = 2 → cos = −1
    expect(l2ToCosine(2)).toBe(-1);
  });

  it("reflection contradiction check fires at TRUE cosine 0.80 (#145)", async () => {
    const {
      isContradictionCandidate,
      REFLECTION_CONTRADICTION_MIN_COSINE,
    } = await import("../src/consolidate.js");

    expect(REFLECTION_CONTRADICTION_MIN_COSINE).toBe(0.8);

    // Identical lessons (d=0, cos=1) → candidate.
    expect(isContradictionCandidate(0)).toBe(true);

    // Boundary at true cosine 0.80 ⇔ d = √(2·0.2) = √0.4 ≈ 0.6325.
    // Strict > : just above the bar fires, just below does not.
    expect(isContradictionCandidate(Math.sqrt(2 * (1 - 0.81)))).toBe(true);  // cos 0.81
    expect(isContradictionCandidate(Math.sqrt(0.4) - 1e-6)).toBe(true);      // cos 0.80 + ε
    expect(isContradictionCandidate(Math.sqrt(2 * (1 - 0.79)))).toBe(false); // cos 0.79
    expect(isContradictionCandidate(Math.SQRT2)).toBe(false);                // orthogonal

    // Regression: pre-#145 the check was `1 − d > 0.80` (needed cos > 0.98).
    // A strongly-similar lesson pair at true cosine 0.9 (d = √0.2 ≈ 0.447)
    // never fired under the old formula (1 − 0.447 = 0.55) — it must now.
    const d90 = Math.sqrt(2 * (1 - 0.9));
    expect(1 - d90).toBeLessThan(0.8); // old formula would NOT fire
    expect(isContradictionCandidate(d90)).toBe(true); // new formula fires
  });

  it("discoverLinkCandidates keeps only the TOP_K highest-cosine neighbors above threshold", async () => {
    const { discoverLinkCandidates, CONSOLIDATE_LINK_TOP_K } = await import(
      "../src/consolidate.js"
    );
    const dir = join(TEST_DIR, `topk-${randomUUID().slice(0, 6)}`);
    mkdirSync(dir, { recursive: true });
    const db = initDb(join(dir, "test.db"));
    try {
      // Unit query vector e0; neighbors at controlled cosines to it:
      // v = [cos, √(1−cos²), 0, …] is unit-norm with cos(v, e0) = cos.
      const e0 = clusterEmbedding(0);
      const atCosine = (cos: number): Float32Array => {
        const arr = new Float32Array(384);
        arr[0] = cos;
        arr[1] = Math.sqrt(1 - cos * cos);
        return arr;
      };

      const queryId = storage.insertMemory(db, "query memory", e0, {
        project: "topk",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      // 5 neighbors above the 0.75 threshold, 1 below — cap must keep the
      // 3 highest cosines and drop 0.93, 0.91, and 0.60.
      const cosines = [0.99, 0.97, 0.95, 0.93, 0.91, 0.6];
      cosines.forEach((c, i) => {
        storage.insertMemory(db, `neighbor at cosine ${c}`, atCosine(c), {
          project: "topk",
          createdAt: `2026-01-0${i + 2}T00:00:00.000Z`,
        });
      });

      const mem = storage.getMemory(db, queryId)!;
      const candidates = discoverLinkCandidates(db, mem, e0);

      expect(candidates.length).toBe(CONSOLIDATE_LINK_TOP_K);
      const sims = candidates.map((c) => c.similarity);
      // Highest-cosine neighbors kept, in descending order (float32 storage
      // round-trips introduce tiny error — compare to 3 decimals)
      expect(sims[0]).toBeCloseTo(0.99, 3);
      expect(sims[1]).toBeCloseTo(0.97, 3);
      expect(sims[2]).toBeCloseTo(0.95, 3);
    } finally {
      db.close();
    }
  });
});
