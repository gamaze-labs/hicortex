/**
 * Tests for graded schema membership (specs/2026-07-07-graded-schema-memory-tags.md):
 *   - l2Normalize / tagWeight vector helpers.
 *   - derivePrimary: argmax weight, compartment override, LLM-order tiebreak,
 *     all-null fallback, empty-set throw.
 *   - computeDomainPrototypes: member centroid at >= 5 members (embedder NOT
 *     loaded), description seed below (embedder called with "Name: description"),
 *     persistence to domain_prototypes.
 *   - recomputeAllTagWeights: one pass sets weight = cosine(embedding, prototype),
 *     NULLs out-of-vocabulary tags.
 *   - refreshPrimaries: re-derives memories.domain (argmax + compartment),
 *     leaves untagged memories alone.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { initDb } from "../src/db.js";
import * as storage from "../src/storage.js";
import {
  PROTOTYPE_MIN_MEMBERS,
  l2Normalize,
  tagWeight,
  derivePrimary,
  compartmentSet,
  computeDomainPrototypes,
  computeTagWeights,
  loadDomainPrototypes,
  recomputeAllTagWeights,
  refreshPrimaries,
  blobToVec,
} from "../src/schema-prototypes.js";
import type { DomainDef } from "../src/types.js";
import type { EmbedFn } from "../src/retrieval.js";

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = join(tmpdir(), `hicortex-proto-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  db = initDb(join(dir, "test.db"));
});

afterEach(() => {
  try { db.close(); } catch { /* already closed */ }
  rmSync(dir, { recursive: true, force: true });
});

/** Unit vector along axis i (384-dim). */
function basis(i: number, value = 1): Float32Array {
  const v = new Float32Array(384);
  v[i] = value;
  return v;
}

function insert(content: string, embedding: Float32Array): string {
  return storage.insertMemory(db, content, embedding, {
    sourceAgent: "test",
    project: "p",
    memoryType: "episode",
  });
}

/** Deterministic embedder: axis-0 unit vector per call; records inputs. */
function recordingEmbed(): EmbedFn & { calls: string[] } {
  const calls: string[] = [];
  const fn = async (text: string) => {
    calls.push(text);
    return basis(0);
  };
  return Object.assign(fn, { calls });
}

const failingEmbed = () => Promise.reject<EmbedFn>(new Error("embedder must NOT be loaded"));

// ---------------------------------------------------------------------------
// Vector helpers
// ---------------------------------------------------------------------------

describe("l2Normalize / tagWeight", () => {
  it("normalizes to unit length", () => {
    const v = l2Normalize(basis(3, 5));
    let norm = 0;
    for (const x of v) norm += x * x;
    expect(Math.sqrt(norm)).toBeCloseTo(1, 6);
    expect(v[3]).toBeCloseTo(1, 6);
  });

  it("returns an all-zero copy for a zero vector (no divide-by-zero)", () => {
    const v = l2Normalize(new Float32Array(384));
    expect([...v].every((x) => x === 0)).toBe(true);
  });

  it("tagWeight is the dot product (cosine for normalized inputs)", () => {
    expect(tagWeight(basis(0), basis(0))).toBeCloseTo(1, 6);
    expect(tagWeight(basis(0), basis(1))).toBeCloseTo(0, 6);
    const mixed = l2Normalize(new Float32Array([1, 1, ...new Array(382).fill(0)]));
    expect(tagWeight(mixed, basis(0))).toBeCloseTo(Math.SQRT1_2, 5);
  });
});

// ---------------------------------------------------------------------------
// derivePrimary (pure)
// ---------------------------------------------------------------------------

describe("derivePrimary", () => {
  const none = new Set<string>();

  it("picks the argmax-weight tag", () => {
    expect(derivePrimary(
      [{ tag: "Ventures", weight: 0.4 }, { tag: "Boating", weight: 0.8 }],
      none,
    )).toBe("Boating");
  });

  it("breaks exact-weight ties by array (LLM) order", () => {
    expect(derivePrimary(
      [{ tag: "Hardware", weight: 0.5 }, { tag: "Ventures", weight: 0.5 }],
      none,
    )).toBe("Hardware");
  });

  it("all-null weights → first tag (LLM order)", () => {
    expect(derivePrimary(
      [{ tag: "A", weight: null }, { tag: "B", weight: null }],
      none,
    )).toBe("A");
  });

  it("a null weight loses to any numeric weight", () => {
    expect(derivePrimary(
      [{ tag: "A", weight: null }, { tag: "B", weight: -0.2 }],
      none,
    )).toBe("B");
  });

  it("compartment override beats argmax", () => {
    expect(derivePrimary(
      [{ tag: "Ventures", weight: 0.9 }, { tag: "Work", weight: 0.1 }],
      new Set(["Work"]),
    )).toBe("Work");
  });

  it("compartment NOT tagged → no effect", () => {
    expect(derivePrimary(
      [{ tag: "Ventures", weight: 0.9 }, { tag: "Boating", weight: 0.1 }],
      new Set(["Work"]),
    )).toBe("Ventures");
  });

  it("throws on an empty tag set", () => {
    expect(() => derivePrimary([], none)).toThrow(/empty tag set/);
  });
});

describe("compartmentSet", () => {
  it("collects only compartment-flagged domain names", () => {
    const domains: DomainDef[] = [
      { name: "Work", description: "job", compartment: true },
      { name: "Ventures", description: "biz" },
    ];
    expect(compartmentSet(domains)).toEqual(new Set(["Work"]));
  });
});

// ---------------------------------------------------------------------------
// computeDomainPrototypes
// ---------------------------------------------------------------------------

describe("computeDomainPrototypes", () => {
  const DOMAINS: DomainDef[] = [
    { name: "Boating", description: "Boat maintenance, marina, sailing" },
  ];

  it("uses the member centroid (L2-normalized) at >= PROTOTYPE_MIN_MEMBERS, embedder untouched", async () => {
    // 5 members: 3 on axis 0, 2 on axis 1 → mean direction (3, 2, 0, ...).
    for (let i = 0; i < PROTOTYPE_MIN_MEMBERS; i++) {
      const id = insert(`boat memory ${i}`, basis(i < 3 ? 0 : 1));
      storage.setMemoryTags(db, id, ["Boating"]);
    }

    const { prototypes, stats } = await computeDomainPrototypes(db, DOMAINS, failingEmbed);
    expect(stats).toEqual([{ domain: "Boating", memberCount: 5, seeded: false }]);
    const proto = prototypes.get("Boating")!;
    const expected = l2Normalize(new Float32Array([3 / 5, 2 / 5, ...new Array(382).fill(0)]));
    expect(proto[0]).toBeCloseTo(expected[0], 5);
    expect(proto[1]).toBeCloseTo(expected[1], 5);
    // L2 norm = 1
    let norm = 0;
    for (const x of proto) norm += x * x;
    expect(Math.sqrt(norm)).toBeCloseTo(1, 5);

    // Persisted with member_count.
    const row = db
      .prepare("SELECT member_count, embedding FROM domain_prototypes WHERE domain = 'Boating'")
      .get() as { member_count: number; embedding: Buffer };
    expect(row.member_count).toBe(5);
    expect(blobToVec(row.embedding)[0]).toBeCloseTo(expected[0], 5);
  });

  it("seeds from the 'Name: description' embedding below the member threshold", async () => {
    const id = insert("one boat memory", basis(1));
    storage.setMemoryTags(db, id, ["Boating"]);

    const embed = recordingEmbed();
    const { prototypes, stats } = await computeDomainPrototypes(db, DOMAINS, async () => embed);
    expect(stats).toEqual([{ domain: "Boating", memberCount: 1, seeded: true }]);
    expect(embed.calls).toEqual(["Boating: Boat maintenance, marina, sailing"]);
    // Seed = normalized embed output (basis 0).
    expect(prototypes.get("Boating")![0]).toBeCloseTo(1, 6);
  });

  it("loadDomainPrototypes round-trips the stored vectors", async () => {
    const embed = recordingEmbed();
    await computeDomainPrototypes(db, DOMAINS, async () => embed);
    const loaded = loadDomainPrototypes(db);
    expect(loaded.has("Boating")).toBe(true);
    expect(loaded.get("Boating")![0]).toBeCloseTo(1, 6);
  });

  it("computeTagWeights derives per-tag cosine from the prototypes", async () => {
    for (let i = 0; i < PROTOTYPE_MIN_MEMBERS; i++) {
      const id = insert(`boat ${i}`, basis(0));
      storage.setMemoryTags(db, id, ["Boating"]);
    }
    const { prototypes } = await computeDomainPrototypes(db, DOMAINS, failingEmbed);
    const onAxis = insert("axis-0 memory", basis(0));
    const offAxis = insert("axis-1 memory", basis(1));
    expect(computeTagWeights(db, onAxis, ["Boating"], prototypes).Boating).toBeCloseTo(1, 5);
    expect(computeTagWeights(db, offAxis, ["Boating"], prototypes).Boating).toBeCloseTo(0, 5);
    // Unknown prototype → null.
    expect(computeTagWeights(db, onAxis, ["Nope"], prototypes).Nope).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// recomputeAllTagWeights + refreshPrimaries (the nightly reconsolidation pass)
// ---------------------------------------------------------------------------

describe("recomputeAllTagWeights + refreshPrimaries", () => {
  const DOMAINS: DomainDef[] = [
    { name: "Boating", description: "boats" },
    { name: "Ventures", description: "businesses" },
    { name: "Work", description: "day job", compartment: true },
  ];

  /** Seed >= 5 members per domain so prototypes are pure centroids: Boating on
   *  axis 0, Ventures on axis 1, Work on axis 2. */
  function seedAnchors(): void {
    for (const [domain, axis] of [["Boating", 0], ["Ventures", 1], ["Work", 2]] as const) {
      for (let i = 0; i < PROTOTYPE_MIN_MEMBERS; i++) {
        const id = insert(`${domain} anchor ${i}`, basis(axis));
        storage.setMemoryTags(db, id, [domain]);
      }
    }
  }

  it("recomputes every weight and re-derives primaries from the new weights", async () => {
    seedAnchors();
    // A memory tagged [Ventures, Boating] (LLM order) whose embedding sits on
    // the BOATING axis — LLM order alone would make Ventures primary, but the
    // weights must flip it to Boating.
    const boaty = insert("replaced the impeller for the charter business", basis(0));
    storage.setMemoryTags(db, boaty, ["Ventures", "Boating"]); // no weights yet → primary Ventures
    expect((db.prepare("SELECT domain FROM memories WHERE id = ?").get(boaty) as { domain: string }).domain)
      .toBe("Ventures");

    const { prototypes } = await computeDomainPrototypes(db, DOMAINS, failingEmbed);
    const { updated, nulled } = recomputeAllTagWeights(db, prototypes);
    expect(updated).toBe(3 * PROTOTYPE_MIN_MEMBERS + 2);
    expect(nulled).toBe(0);

    const weights = storage.getMemoryTagsWeighted(db, boaty);
    expect(weights[0]).toMatchObject({ tag: "Boating" });
    expect(weights[0].weight).toBeCloseTo(1, 5);
    // Ventures prototype = mean of 5 axis-1 anchors + boaty itself (axis 0):
    // normalized (1, 5)/√26 → cosine vs axis 0 = 1/√26.
    expect(weights[1].weight).toBeCloseTo(1 / Math.sqrt(26), 4);

    const { examined, updated: primariesUpdated } = refreshPrimaries(db, DOMAINS);
    expect(examined).toBe(3 * PROTOTYPE_MIN_MEMBERS + 1);
    expect(primariesUpdated).toBe(1); // only boaty flips
    expect((db.prepare("SELECT domain FROM memories WHERE id = ?").get(boaty) as { domain: string }).domain)
      .toBe("Boating");
  });

  it("compartment override survives the refresh regardless of weights", async () => {
    seedAnchors();
    // Embedding on the Ventures axis but tagged Work too → Work must win.
    const workVenture = insert("client project plan", basis(1));
    storage.setMemoryTags(db, workVenture, ["Ventures", "Work"]);

    const { prototypes } = await computeDomainPrototypes(db, DOMAINS, failingEmbed);
    recomputeAllTagWeights(db, prototypes);
    refreshPrimaries(db, DOMAINS);

    expect((db.prepare("SELECT domain FROM memories WHERE id = ?").get(workVenture) as { domain: string }).domain)
      .toBe("Work");
  });

  it("NULLs weights for out-of-vocabulary tags and leaves untagged memories alone", async () => {
    seedAnchors();
    const stray = insert("stray", basis(0));
    db.prepare("INSERT INTO memory_tags (memory_id, tag) VALUES (?, ?)").run(stray, "Removed");
    const untagged = insert("never classified", basis(3));

    const { prototypes } = await computeDomainPrototypes(db, DOMAINS, failingEmbed);
    const { nulled } = recomputeAllTagWeights(db, prototypes);
    expect(nulled).toBe(1);
    expect(
      (db.prepare("SELECT weight FROM memory_tags WHERE memory_id = ?").get(stray) as { weight: number | null }).weight,
    ).toBeNull();

    refreshPrimaries(db, DOMAINS);
    expect(
      (db.prepare("SELECT domain FROM memories WHERE id = ?").get(untagged) as { domain: string | null }).domain,
    ).toBeNull();
  });
});
