/**
 * Tests for the no-fit lifecycle (owner amendment 07.07 to the graded-schema
 * spec): no "Unsorted" fallback category + weak-primary floor + no-association
 * accelerated decay.
 *
 *   - LLM no-fit ({"tags": []}) + argmax prototype cosine >= floor → WEAK
 *     primary (single argmax tag; primary derives naturally).
 *   - Below the floor → NO tags, domain NULL, base_strength HALVED (floored
 *     at 0.05) — accelerated decay toward the existing prune stage.
 *   - domain NULL keeps the memory in the nightly staleness scope: every run
 *     re-evaluates it and re-halves ONLY while it is still a no-fit below the
 *     floor (exactly one halving per run).
 *   - Rescue paths: access (prune only considers access_count = 0) and later
 *     re-classification (tagged → halving stops).
 *   - Prune interaction: base_strength 0.5 can NEVER prune (effectiveStrength
 *     floor 0.5² × 0.1 = 0.025 > the 0.01 prune threshold); halving toward
 *     0.05 is what makes pruning reachable (~143 days unaccessed at 0.05).
 *
 * Axis-embedding fixtures: memory vectors are inserted directly; the embedFn
 * only embeds domain-description prototype seeds (cold start — every domain
 * has < 5 members). The mock LLM's completeFast THROWS so importance scoring
 * never rewrites base_strength mid-test (scoring failures are caught and
 * reported, not fatal).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { initDb } from "../src/db.js";
import * as storage from "../src/storage.js";
import { runConsolidation } from "../src/consolidate.js";
import { runClassifyDomains } from "../src/classify-domains.js";
import {
  DEFAULT_WEAK_PRIMARY_FLOOR,
  NO_ASSOCIATION_MIN_STRENGTH,
  resolveWeakPrimaryFloor,
} from "../src/nofit.js";
import type { LlmClient } from "../src/llm.js";
import type { DomainDef } from "../src/domain-classify.js";

const TEST_DIR = join(tmpdir(), `hicortex-nofit-${randomUUID().slice(0, 8)}`);

beforeAll(() => mkdirSync(TEST_DIR, { recursive: true }));
afterAll(() => rmSync(TEST_DIR, { recursive: true, force: true }));

// NO "Unsorted" entry — a vocabulary without a fallback bucket is the norm.
const DOMAINS: DomainDef[] = [
  { name: "Boating", description: "Boat, marina, outboard, sailing" },
  { name: "Work", description: "Employer, manager, day job" },
];

/** Unit basis vector on axis i. */
function basis(i: number, scale = 1): Float32Array {
  const v = new Float32Array(384);
  v[i] = scale;
  return v;
}

/**
 * Axis embedder for the domain-description prototype SEEDS only (all domains
 * are cold-start): Boating → axis 0, Work → axis 2, anything else → axis 9.
 */
const axisEmbed = async (text: string): Promise<Float32Array> => {
  const lower = text.toLowerCase();
  if (lower.includes("boat")) return basis(0);
  if (lower.includes("employer")) return basis(2);
  return basis(9);
};

/** Memory that WEAKLY associates with Boating: cosine vs its seed = 0.6. */
function weakBoatingVec(): Float32Array {
  const v = new Float32Array(384);
  v[0] = 0.6;
  v[5] = 0.8; // ‖v‖ = 1
  return v;
}

/** Memory that associates with NOTHING: orthogonal to every prototype. */
function noAssociationVec(): Float32Array {
  return basis(7);
}

/**
 * Mock LLM: completeClassify always replies the EXPLICIT no-fit ({"tags":[]})
 * unless a keyword matches; completeFast THROWS (disables importance scoring
 * writes — see header). Tracks classify calls.
 */
function noFitLlm(): LlmClient & { calls: number } {
  const obj = {
    calls: 0,
    completeClassify: async (prompt: string) => {
      obj.calls++;
      const body = (prompt.split("MEMORY:\n")[1] ?? prompt).toLowerCase();
      if (body.includes("impeller")) return JSON.stringify({ tags: ["Boating"] });
      return JSON.stringify({ tags: [] });
    },
    completeFast: async () => {
      throw new Error("scoring disabled in fixture");
    },
  };
  return obj as unknown as LlmClient & { calls: number };
}

interface Fixture {
  db: Database.Database;
  dbPath: string;
  stateDir: string;
}

function fixture(name: string): Fixture {
  const dir = join(TEST_DIR, name);
  const stateDir = join(dir, "state");
  mkdirSync(stateDir, { recursive: true });
  const dbPath = join(dir, "test.db");
  return { db: initDb(dbPath), dbPath, stateDir };
}

function insert(
  db: Database.Database,
  content: string,
  vec: Float32Array,
  opts: { baseStrength?: number; createdAt?: string } = {},
): string {
  return storage.insertMemory(db, content, vec, {
    sourceAgent: "test",
    project: "misc",
    memoryType: "episode",
    ...opts,
  });
}

function memRow(db: Database.Database, id: string): { domain: string | null; base_strength: number } {
  return db
    .prepare("SELECT domain, base_strength FROM memories WHERE id = ?")
    .get(id) as { domain: string | null; base_strength: number };
}

async function runNightly(
  fx: Fixture,
  llm: LlmClient,
  weakPrimaryFloor?: number,
) {
  return runConsolidation(fx.db, llm, axisEmbed, false, true, fx.stateDir, {
    domains: DOMAINS,
    contentDomainsReady: true,
    ...(weakPrimaryFloor !== undefined ? { weakPrimaryFloor } : {}),
  });
}

// ---------------------------------------------------------------------------
// resolveWeakPrimaryFloor (config key)
// ---------------------------------------------------------------------------

describe("resolveWeakPrimaryFloor", () => {
  it("defaults to 0.45 when absent", () => {
    expect(DEFAULT_WEAK_PRIMARY_FLOOR).toBe(0.45);
    expect(resolveWeakPrimaryFloor(null)).toBe(0.45);
    expect(resolveWeakPrimaryFloor({})).toBe(0.45);
  });
  it("accepts a finite number in (0, 1)", () => {
    expect(resolveWeakPrimaryFloor({ weakPrimaryFloor: 0.3 })).toBe(0.3);
    expect(resolveWeakPrimaryFloor({ weakPrimaryFloor: 0.99 })).toBe(0.99);
  });
  it("falls back to the default on invalid values", () => {
    expect(resolveWeakPrimaryFloor({ weakPrimaryFloor: "high" })).toBe(0.45);
    expect(resolveWeakPrimaryFloor({ weakPrimaryFloor: 0 })).toBe(0.45);
    expect(resolveWeakPrimaryFloor({ weakPrimaryFloor: 1 })).toBe(0.45);
    expect(resolveWeakPrimaryFloor({ weakPrimaryFloor: 1.5 })).toBe(0.45);
    expect(resolveWeakPrimaryFloor({ weakPrimaryFloor: NaN })).toBe(0.45);
  });
});

// ---------------------------------------------------------------------------
// Nightly stage — weak primary + no-association decay
// ---------------------------------------------------------------------------

describe("nightly no-fit path", () => {
  it("no-fit with argmax prototype cosine >= floor earns a WEAK primary", async () => {
    const fx = fixture(`weak-${randomUUID().slice(0, 6)}`);
    const id = insert(fx.db, "an unclassifiable note that drifts near boats", weakBoatingVec());

    const report = await runNightly(fx, noFitLlm());

    const row = memRow(fx.db, id);
    expect(row.domain).toBe("Boating"); // primary derives from the single weak tag
    expect(storage.getMemoryTags(fx.db, id)).toEqual(["Boating"]);
    const weight = (fx.db
      .prepare("SELECT weight FROM memory_tags WHERE memory_id = ? AND tag = 'Boating'")
      .get(id) as { weight: number }).weight;
    expect(weight).toBeCloseTo(0.6, 4); // cosine vs the Boating seed
    expect(row.base_strength).toBe(0.5); // weak primary = it LIVES, no decay

    expect(report.stages.domain_curation?.weak_primary).toBe(1);
    expect(report.stages.domain_curation?.no_association_decayed).toBe(0);
    expect(report.stages.domain_curation?.classified).toBe(0); // LLM tagged nothing
    fx.db.close();
  });

  it("no-fit BELOW the floor decays: strength halved, no tags, domain NULL", async () => {
    const fx = fixture(`decay-${randomUUID().slice(0, 6)}`);
    const id = insert(fx.db, "noise that associates with nothing", noAssociationVec());

    const report = await runNightly(fx, noFitLlm());

    const row = memRow(fx.db, id);
    expect(row.domain).toBeNull(); // stays in the staleness scope for re-attempts
    expect(storage.getMemoryTags(fx.db, id)).toEqual([]);
    expect(row.base_strength).toBe(0.25); // 0.5 halved

    expect(report.stages.domain_curation?.no_association_decayed).toBe(1);
    expect(report.stages.domain_curation?.weak_primary).toBe(0);
    fx.db.close();
  });

  it("re-halves once per run while still below the floor, flooring at 0.05", async () => {
    const fx = fixture(`rehalve-${randomUUID().slice(0, 6)}`);
    const id = insert(fx.db, "noise that associates with nothing", noAssociationVec());

    // 0.5 → 0.25 → 0.125 → 0.0625 → 0.05 (floored) → 0.05 (stays)
    const expected = [0.25, 0.125, 0.0625, 0.05, 0.05];
    for (const target of expected) {
      const llm = noFitLlm();
      await runNightly(fx, llm);
      expect(llm.calls).toBe(1); // still evaluated every run (domain NULL keeps it in scope)
      expect(memRow(fx.db, id).base_strength).toBe(target); // exactly ONE halving per run
    }
    expect(NO_ASSOCIATION_MIN_STRENGTH).toBe(0.05);
    fx.db.close();
  });

  it("later re-classification stops the decay (LLM fit on a subsequent run)", async () => {
    const fx = fixture(`rescue-classify-${randomUUID().slice(0, 6)}`);
    // "impeller" is invisible to the mock until we update the content — first
    // run is a no-fit, second run the LLM tags it Boating.
    const id = insert(fx.db, "cryptic note", noAssociationVec());
    await runNightly(fx, noFitLlm());
    expect(memRow(fx.db, id).base_strength).toBe(0.25);

    storage.updateMemory(fx.db, id, { content: "replaced the impeller" });
    await runNightly(fx, noFitLlm());
    const row = memRow(fx.db, id);
    expect(row.domain).toBe("Boating");
    expect(storage.getMemoryTags(fx.db, id)).toEqual(["Boating"]);
    expect(row.base_strength).toBe(0.25); // halving stopped; strength NOT restored

    // Third run: tagged rows are out of the staleness scope — no re-halving.
    const llm = noFitLlm();
    await runNightly(fx, llm);
    expect(llm.calls).toBe(0);
    expect(memRow(fx.db, id).base_strength).toBe(0.25);
    fx.db.close();
  });

  it("access-strengthening remains a rescue path: accessed memories are never prune candidates", async () => {
    const fx = fixture(`rescue-access-${randomUUID().slice(0, 6)}`);
    const id = insert(fx.db, "noise that associates with nothing", noAssociationVec());
    await runNightly(fx, noFitLlm());
    await runNightly(fx, noFitLlm());
    expect(memRow(fx.db, id).base_strength).toBe(0.125);

    // Recall the memory (what /search etc. do on access).
    storage.strengthenMemory(fx.db, id, new Date().toISOString());

    // Still re-evaluated (and re-halved — access does not restore strength)…
    const llm = noFitLlm();
    await runNightly(fx, llm);
    expect(llm.calls).toBe(1);
    expect(memRow(fx.db, id).base_strength).toBe(0.0625);

    // …but access_count > 0 permanently shields it from pruning: prune
    // candidates are ONLY never-accessed memories, at ANY age.
    const futureCutoff = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const candidates = storage.getPruneCandidates(fx.db, futureCutoff);
    expect(candidates.map((m) => m.id)).not.toContain(id);
    fx.db.close();
  });

  it("floor is configurable: a 0.6-cosine memory decays under a 0.7 floor", async () => {
    const fx = fixture(`floor-${randomUUID().slice(0, 6)}`);
    const id = insert(fx.db, "an unclassifiable note that drifts near boats", weakBoatingVec());

    const report = await runNightly(fx, noFitLlm(), 0.7);

    const row = memRow(fx.db, id);
    expect(row.domain).toBeNull();
    expect(storage.getMemoryTags(fx.db, id)).toEqual([]);
    expect(row.base_strength).toBe(0.25);
    expect(report.stages.domain_curation?.no_association_decayed).toBe(1);
    expect(report.stages.domain_curation?.weak_primary).toBe(0);
    fx.db.close();
  });

  it("prune interaction: strength at the 0.05 floor prunes when old + unaccessed; 0.5 never does", async () => {
    const fx = fixture(`prune-${randomUUID().slice(0, 6)}`);
    const oldIso = new Date(Date.now() - 200 * 24 * 3600 * 1000).toISOString();
    // Both are Boating-tagged by the LLM (content says "impeller") so the
    // no-fit path does not interfere — this test isolates stageDecayPrune.
    const decayed = insert(fx.db, "replaced the impeller (decayed)", basis(0), {
      baseStrength: 0.05,
      createdAt: oldIso,
    });
    const healthy = insert(fx.db, "replaced the impeller (healthy)", basis(1), {
      baseStrength: 0.5,
      createdAt: oldIso,
    });

    const report = await runNightly(fx, noFitLlm());

    // b=0.05, 200 days unaccessed → effectiveStrength ≈ 0.0053 < 0.01 → pruned.
    expect(storage.getMemory(fx.db, decayed)).toBeNull();
    // b=0.5 → asymptotic floor 0.5²×0.1 = 0.025 > 0.01 → can NEVER prune.
    expect(storage.getMemory(fx.db, healthy)).not.toBeNull();
    expect(report.stages.decay_prune?.pruned).toBe(1);
    fx.db.close();
  });
});

// ---------------------------------------------------------------------------
// classify-domains command — same no-fit path, config-resolved floor
// ---------------------------------------------------------------------------

describe("classify-domains no-fit path", () => {
  it("applies weak primary / decay and reports both counters", async () => {
    const fx = fixture(`cmd-nofit-${randomUUID().slice(0, 6)}`);
    const weakId = insert(fx.db, "an unclassifiable note that drifts near boats", weakBoatingVec());
    const noneId = insert(fx.db, "noise that associates with nothing", noAssociationVec());
    fx.db.close();

    const report = await runClassifyDomains({
      dbPath: fx.dbPath,
      stateDir: fx.stateDir,
      llm: noFitLlm(),
      config: { domains: DOMAINS },
      embedFn: axisEmbed,
    });

    expect(report.scanned).toBe(2);
    expect(report.weakPrimary).toBe(1);
    expect(report.noAssociationDecayed).toBe(1);
    expect(report.classified).toBe(1); // the weak primary (NULL → Boating)
    expect(report.aborted).toBe(false);
    expect(report.byDomain).toEqual({ Boating: 1 });
    expect(report.totalTags).toBe(1);

    const db2 = initDb(fx.dbPath);
    expect(memRow(db2, weakId)).toEqual({ domain: "Boating", base_strength: 0.5 });
    expect(memRow(db2, noneId)).toEqual({ domain: null, base_strength: 0.25 });
    expect(storage.getMemoryTags(db2, noneId)).toEqual([]);
    db2.close();
  });

  it("reads weakPrimaryFloor from config: 0.7 floor decays the 0.6-cosine memory", async () => {
    const fx = fixture(`cmd-floor-${randomUUID().slice(0, 6)}`);
    const weakId = insert(fx.db, "an unclassifiable note that drifts near boats", weakBoatingVec());
    fx.db.close();

    const report = await runClassifyDomains({
      dbPath: fx.dbPath,
      stateDir: fx.stateDir,
      llm: noFitLlm(),
      config: { domains: DOMAINS, weakPrimaryFloor: 0.7 },
      embedFn: axisEmbed,
    });

    expect(report.weakPrimary).toBe(0);
    expect(report.noAssociationDecayed).toBe(1);

    const db2 = initDb(fx.dbPath);
    expect(memRow(db2, weakId)).toEqual({ domain: null, base_strength: 0.25 });
    db2.close();
  });
});
