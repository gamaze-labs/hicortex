/**
 * Tests for content-based MULTI-TAG integration (feat/memory-tags):
 *   1. runConsolidation nightly stage — multi-tag path vs legacy project path,
 *      infra-error skip, strict-skip when endpoint down.
 *   2. `hicortex classify-domains` command — resumable cursor, --reset, --all,
 *      server-mode guard, per-primary summary, and infra-error abort-clean.
 *
 * The LLM is mocked (a keyword classifier returning JSON) so tests are
 * deterministic and offline. Embeddings use a trivial fixed vector — link
 * discovery is not under test here.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { initDb } from "../src/db.js";
import * as storage from "../src/storage.js";
import { runConsolidation } from "../src/consolidate.js";
import { runClassifyDomains } from "../src/classify-domains.js";
import { loadState } from "../src/state.js";
import type { LlmClient } from "../src/llm.js";
import type { DomainDef } from "../src/domain-classify.js";

const TEST_DIR = join(tmpdir(), `hicortex-memory-tags-${randomUUID().slice(0, 8)}`);

// NOTE: no "Unsorted" entry — a config WITHOUT any fallback bucket is the
// norm (owner amendment 07.07: no-fit = empty tag set, handled by nofit.ts).
const DOMAINS: DomainDef[] = [
  { name: "Boating", description: "Boat, marina, outboard, sailing" },
  { name: "Work", description: "Employer, manager, day job" },
  { name: "Hardware", description: "Servers, agents, fleet, infra" },
  { name: "Ventures", description: "Gamaze, side business" },
];

beforeAll(() => mkdirSync(TEST_DIR, { recursive: true }));
afterAll(() => rmSync(TEST_DIR, { recursive: true, force: true }));

/**
 * Keyword-based mock classifier standing in for the classify-tier LLM. Returns
 * a graded-schema tags-only JSON object ({"tags": [...]}, most-relevant first)
 * based on keywords in the content. A memory mentioning both "bedrock/fleet"
 * AND "gamaze" gets Hardware + Ventures. Records call count so tests can
 * assert only stale/untagged rows are touched.
 *
 * NOTE: the test embedder is a fixed zero vector, so every derived weight is 0
 * and the primary falls back to the FIRST tag (LLM order tiebreak) — same
 * observable primaries as the old {primary, tags} contract.
 *
 * Optionally throws on a specific call index to simulate an infra error.
 */
function keywordLlm(throwOnCall?: number): LlmClient & { calls: number } {
  const obj = {
    calls: 0,
    completeClassify: async (prompt: string) => {
      obj.calls++;
      if (throwOnCall !== undefined && obj.calls === throwOnCall) {
        throw new Error("ECONNREFUSED (simulated reflect death)");
      }
      const body = prompt.split("MEMORY:\n")[1] ?? prompt;
      const lower = body.toLowerCase();
      const tags: string[] = [];
      if (lower.includes("outboard") || lower.includes("marina")) tags.push("Boating");
      if (lower.includes("bedrock") || lower.includes("fleet") || lower.includes("server")) tags.push("Hardware");
      if (lower.includes("gamaze") || lower.includes("client")) tags.push("Ventures");
      if (lower.includes("manager") || lower.includes("standup") || lower.includes("pull request")) tags.push("Work");
      // No-fit → EXPLICIT empty tags array (no fallback category exists).
      return JSON.stringify({ tags });
    },
    completeFast: async () => "[]",
  };
  return obj as unknown as LlmClient & { calls: number };
}

const fixedEmbed = async () => new Float32Array(384);

interface Fixture {
  db: Database.Database;
  dbPath: string;
  stateDir: string;
  ids: string[];
}

function seed(name: string, withDomains = true): Fixture {
  const dir = join(TEST_DIR, name);
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, "test.db");
  const stateDir = join(dir, "state");
  mkdirSync(stateDir, { recursive: true });
  const db = initDb(dbPath);

  const config: Record<string, unknown> = { llmBackend: "ollama" };
  if (withDomains) config.domains = DOMAINS;
  writeFileSync(join(stateDir, "config.json"), JSON.stringify(config));

  const specs = [
    { content: "Replaced the outboard impeller before the trip", project: "nano" },
    { content: "Set up bedrock server for the gamaze agent fleet", project: "raider" },
    { content: "Standup with manager about the roadmap", project: "lenny" },
    { content: "Reviewed pull request from a teammate", project: "lenny" },
  ];
  const ids = specs.map((s) =>
    storage.insertMemory(db, s.content, new Float32Array(384), {
      sourceAgent: "test",
      project: s.project,
      memoryType: "episode",
    }),
  );
  return { db, dbPath, stateDir, ids };
}

function domainOf(db: Database.Database, id: string): string | null {
  return (db.prepare("SELECT domain FROM memories WHERE id = ?").get(id) as { domain: string | null }).domain;
}

// ---------------------------------------------------------------------------
// 1. Nightly stage
// ---------------------------------------------------------------------------

describe("runConsolidation — multi-tag stage", () => {
  it("writes primary + full tag set when config.domains is set", async () => {
    const fx = seed(`nightly-content-${randomUUID().slice(0, 6)}`);
    const llm = keywordLlm();
    const report = await runConsolidation(
      fx.db, llm, fixedEmbed, false, true, fx.stateDir,
      { domains: DOMAINS, contentDomainsReady: true },
    );

    expect(report.status).toBe("completed");
    expect(report.stages.domain_curation?.curated).toBe(true);
    expect(report.stages.domain_curation?.classified).toBe(4);
    // Graded-schema pass ran: prototypes for all 4 domains + weights for
    // every tag row (5 assignments incl. the Ventures secondary).
    expect(report.stages.domain_curation?.prototypes).toBe(4);
    expect(report.stages.domain_curation?.weights_recomputed).toBe(5);
    // No no-fits in this fixture.
    expect(report.stages.domain_curation?.weak_primary).toBe(0);
    expect(report.stages.domain_curation?.no_association_decayed).toBe(0);

    // Primary (memories.domain) = derived; with the zero-vector test embedder
    // all weights tie at 0, so the first (most-relevant) tag wins.
    expect(domainOf(fx.db, fx.ids[0])).toBe("Boating");
    expect(domainOf(fx.db, fx.ids[1])).toBe("Hardware");
    expect(domainOf(fx.db, fx.ids[2])).toBe("Work");

    // The multi-span memory carries BOTH tags (primary + secondary).
    expect(storage.getMemoryTags(fx.db, fx.ids[1]).sort()).toEqual(["Hardware", "Ventures"]);
    // primary always ∈ tags for a single-tag memory too.
    expect(storage.getMemoryTags(fx.db, fx.ids[0])).toEqual(["Boating"]);

    const idx = loadState(fx.stateDir).moduleIndex!;
    expect(idx.mode).toBe("content");
    fx.db.close();
  });

  it("only touches NULL/stale/untagged rows on re-run (idempotent, cheap)", async () => {
    const fx = seed(`nightly-stale-${randomUUID().slice(0, 6)}`);
    const llm1 = keywordLlm();
    await runConsolidation(fx.db, llm1, fixedEmbed, false, true, fx.stateDir,
      { domains: DOMAINS, contentDomainsReady: true });
    expect(llm1.calls).toBe(4);

    // Second run: all rows have a valid domain AND tags → zero classify calls.
    const llm2 = keywordLlm();
    const report = await runConsolidation(fx.db, llm2, fixedEmbed, false, true, fx.stateDir,
      { domains: DOMAINS, contentDomainsReady: true });
    expect(llm2.calls).toBe(0);
    expect(report.stages.domain_curation?.classified).toBe(0);
    fx.db.close();
  });

  it("re-files a row whose domain is set but has NO tags (content-domains migrant)", async () => {
    const fx = seed(`nightly-notags-${randomUUID().slice(0, 6)}`);
    // Simulate a pre-multi-tag memory: domain set, no memory_tags rows.
    fx.db.prepare("UPDATE memories SET domain = 'Boating' WHERE id = ?").run(fx.ids[0]);
    const llm = keywordLlm();
    await runConsolidation(fx.db, llm, fixedEmbed, false, true, fx.stateDir,
      { domains: DOMAINS, contentDomainsReady: true });
    // All 4 rows classify (ids[0] because no tags; the rest because NULL).
    expect(llm.calls).toBe(4);
    expect(storage.getMemoryTags(fx.db, fx.ids[0])).toEqual(["Boating"]);
    fx.db.close();
  });

  it("skips a memory on infra error (classifier null) — leaves it NULL for retry", async () => {
    const fx = seed(`nightly-infra-${randomUUID().slice(0, 6)}`);
    // Throw on the 2nd + 3rd calls (both attempts for the 2nd memory).
    // Sequence: mem1 ok (call1), mem2 attempt1 throws (call2), attempt2 throws (call3) → null.
    const obj = {
      calls: 0,
      completeClassify: async (prompt: string) => {
        obj.calls++;
        // Second memory (bedrock/fleet) → its two attempts throw.
        if (prompt.includes("bedrock")) throw new Error("ECONNREFUSED");
        const body = prompt.split("MEMORY:\n")[1] ?? prompt;
        const lower = body.toLowerCase();
        if (lower.includes("outboard")) return JSON.stringify({ tags: ["Boating"] });
        if (lower.includes("manager") || lower.includes("pull request")) return JSON.stringify({ tags: ["Work"] });
        return JSON.stringify({ tags: [] });
      },
      completeFast: async () => "[]",
    };
    const llm = obj as unknown as LlmClient;
    await runConsolidation(fx.db, llm, fixedEmbed, false, true, fx.stateDir,
      { domains: DOMAINS, contentDomainsReady: true });

    // The infra-failed memory is left unclassified (NULL) — not filed anywhere.
    expect(domainOf(fx.db, fx.ids[1])).toBeNull();
    expect(storage.getMemoryTags(fx.db, fx.ids[1])).toEqual([]);
    // Infra skip is NOT a no-fit: strength untouched (no accelerated decay).
    const strength = (fx.db.prepare("SELECT base_strength FROM memories WHERE id = ?")
      .get(fx.ids[1]) as { base_strength: number }).base_strength;
    expect(strength).toBe(0.5);
    // Others still classified.
    expect(domainOf(fx.db, fx.ids[0])).toBe("Boating");
    fx.db.close();
  });

  it("SKIPS the whole stage when reflect endpoint is not ready (strict)", async () => {
    const fx = seed(`nightly-skip-${randomUUID().slice(0, 6)}`);
    const llm = keywordLlm();
    const report = await runConsolidation(fx.db, llm, fixedEmbed, false, true, fx.stateDir,
      { domains: DOMAINS, contentDomainsReady: false });
    expect(report.stages.domain_curation?.reason).toBe("reflect_endpoint_offline");
    expect(llm.calls).toBe(0);
    expect(domainOf(fx.db, fx.ids[0])).toBeNull();
    fx.db.close();
  });

  it("derives the primary from prototype weights (argmax beats LLM order) and honors compartments", async () => {
    const dirName = `nightly-graded-${randomUUID().slice(0, 6)}`;
    const dir = join(TEST_DIR, dirName);
    mkdirSync(dir, { recursive: true });
    const stateDir = join(dir, "state");
    mkdirSync(stateDir, { recursive: true });
    const db = initDb(join(dir, "test.db"));

    // Work is a compartment (work/life firewall).
    const D2: DomainDef[] = [
      { name: "Boating", description: "Boat, marina, outboard, sailing" },
      { name: "Ventures", description: "Gamaze, side business" },
      { name: "Work", description: "Employer, manager, day job", compartment: true },
    ];

    const basis = (i: number) => {
      const v = new Float32Array(384);
      v[i] = 1;
      return v;
    };
    // Axis embedder for the DESCRIPTION SEEDS (all domains start empty →
    // seeded): Boating → axis 0, Work → axis 2, everything else → axis 3.
    const axisEmbed = async (text: string) => {
      const lower = text.toLowerCase();
      if (lower.includes("boat")) return basis(0);
      if (lower.includes("employer")) return basis(2);
      return basis(3);
    };

    // Memory A sits on the BOATING axis but the LLM lists Ventures FIRST —
    // the weight argmax must flip the primary to Boating.
    const a = storage.insertMemory(db, "replaced the impeller before the trip", basis(0), {
      sourceAgent: "test", project: "nano", memoryType: "episode",
    });
    // Memory B is tagged Work (compartment) with a HIGHER Ventures weight —
    // the compartment must win anyway.
    const b = storage.insertMemory(db, "quarterly client project plan", basis(3), {
      sourceAgent: "test", project: "lenny", memoryType: "episode",
    });

    const llm = {
      completeClassify: async (prompt: string) =>
        prompt.includes("impeller")
          ? JSON.stringify({ tags: ["Ventures", "Boating"] })
          : JSON.stringify({ tags: ["Ventures", "Work"] }),
      completeFast: async () => "[]",
    } as unknown as LlmClient;

    await runConsolidation(db, llm, axisEmbed, false, true, stateDir,
      { domains: D2, contentDomainsReady: true });

    expect(domainOf(db, a)).toBe("Boating"); // argmax weight beat LLM order
    expect(domainOf(db, b)).toBe("Work");    // compartment override
    // Weights persisted: A's Boating weight is the cosine vs the seed (= 1).
    const aBoating = db
      .prepare("SELECT weight FROM memory_tags WHERE memory_id = ? AND tag = 'Boating'")
      .get(a) as { weight: number };
    expect(aBoating.weight).toBeCloseTo(1, 4);
    const aVentures = db
      .prepare("SELECT weight FROM memory_tags WHERE memory_id = ? AND tag = 'Ventures'")
      .get(a) as { weight: number };
    expect(aVentures.weight).toBeCloseTo(0, 4);
    db.close();
  });

  it("keeps legacy project-grouping when config.domains is absent", async () => {
    const fx = seed(`nightly-legacy-${randomUUID().slice(0, 6)}`, false);
    const llm = keywordLlm();
    const report = await runConsolidation(fx.db, llm, fixedEmbed, false, true, fx.stateDir);
    expect(report.stages.domain_curation?.classified).toBeUndefined();
    const d0 = domainOf(fx.db, fx.ids[0]);
    expect(d0).toBe("nano");
    const idx = loadState(fx.stateDir).moduleIndex!;
    expect(idx.mode).not.toBe("content");
    fx.db.close();
  });
});

// ---------------------------------------------------------------------------
// 2. classify-domains command
// ---------------------------------------------------------------------------

describe("hicortex classify-domains", () => {
  it("classifies NULL/untagged rows and reports per-primary + total tags", async () => {
    const fx = seed(`cmd-basic-${randomUUID().slice(0, 6)}`);
    fx.db.close();
    const llm = keywordLlm();
    const report = await runClassifyDomains({
      dbPath: fx.dbPath,
      stateDir: fx.stateDir,
      llm,
      config: { domains: DOMAINS },
      embedFn: fixedEmbed,
    });
    expect(report.scanned).toBe(4);
    expect(report.classified).toBe(4);
    expect(report.aborted).toBe(false);
    // byDomain = primary counts: Boating 1, Hardware 1, Work 2.
    expect(report.byDomain).toEqual({ Boating: 1, Hardware: 1, Work: 2 });
    // totalTags counts every assignment incl. the Ventures secondary tag → 5.
    expect(report.totalTags).toBe(5);
  });

  it("resumes from the saved cursor across batches", async () => {
    const fx = seed(`cmd-resume-${randomUUID().slice(0, 6)}`);
    fx.db.close();
    const llm = keywordLlm();
    const r1 = await runClassifyDomains({
      dbPath: fx.dbPath, stateDir: fx.stateDir, llm, config: { domains: DOMAINS },
      batchSize: 2, embedFn: fixedEmbed,
    });
    expect(r1.batches).toBe(2);
    expect(r1.scanned).toBe(4);
    expect(loadState(fx.stateDir).domainCursor!).toBeGreaterThan(0);

    const llm2 = keywordLlm();
    const r2 = await runClassifyDomains({
      dbPath: fx.dbPath, stateDir: fx.stateDir, llm: llm2, config: { domains: DOMAINS },
      batchSize: 2, embedFn: fixedEmbed,
    });
    expect(r2.scanned).toBe(0);
    expect(llm2.calls).toBe(0);
  });

  it("--reset + --all rescans and reclassifies every memory", async () => {
    const fx = seed(`cmd-reset-${randomUUID().slice(0, 6)}`);
    fx.db.close();
    await runClassifyDomains({
      dbPath: fx.dbPath, stateDir: fx.stateDir, llm: keywordLlm(), config: { domains: DOMAINS },
      embedFn: fixedEmbed,
    });
    const llm = keywordLlm();
    const r = await runClassifyDomains({
      dbPath: fx.dbPath, stateDir: fx.stateDir, llm, config: { domains: DOMAINS },
      reset: true, all: true, embedFn: fixedEmbed,
    });
    expect(r.scanned).toBe(4);
    expect(llm.calls).toBe(4);
    // Already correctly filed → same primary → unchanged.
    expect(r.unchanged).toBe(4);
    expect(r.classified).toBe(0);
  });

  it("ABORTS cleanly on infra error mid-run — failing row untouched, cursor at last commit", async () => {
    const fx = seed(`cmd-abort-${randomUUID().slice(0, 6)}`);
    fx.db.close();
    // batchSize 4 (one batch); throw on the 2nd memory's classify.
    const obj = {
      calls: 0,
      completeClassify: async (prompt: string) => {
        obj.calls++;
        if (prompt.includes("bedrock")) throw new Error("ECONNREFUSED");
        const body = prompt.split("MEMORY:\n")[1] ?? prompt;
        const lower = body.toLowerCase();
        if (lower.includes("outboard")) return JSON.stringify({ tags: ["Boating"] });
        return JSON.stringify({ tags: ["Work"] });
      },
      completeFast: async () => "[]",
    };
    const llm = obj as unknown as LlmClient;
    const r = await runClassifyDomains({
      dbPath: fx.dbPath, stateDir: fx.stateDir, llm, config: { domains: DOMAINS },
      batchSize: 4, embedFn: fixedEmbed,
    });
    expect(r.aborted).toBe(true);
    expect(r.failed).toBe(1);
    // Only the first memory got classified before the abort.
    expect(r.classified).toBe(1);

    // Verify the failed/unreached memories were left completely untouched:
    // no domain, no tags, no decay (infra error ≠ no-fit).
    const db2 = initDb(fx.dbPath);
    const failedRow = db2
      .prepare("SELECT domain, base_strength FROM memories WHERE id = ?")
      .get(fx.ids[1]) as { domain: string | null; base_strength: number };
    expect(failedRow.domain).toBeNull();
    expect(failedRow.base_strength).toBe(0.5);
    // First memory has its tags; the failed one does not.
    expect(storage.getMemoryTags(db2, fx.ids[0])).toEqual(["Boating"]);
    expect(storage.getMemoryTags(db2, fx.ids[1])).toEqual([]);
    // Cursor advanced only to the last committed (first) memory's rowid.
    expect(loadState(fx.stateDir).domainCursor).toBe(1);
    db2.close();
  });

  it("refuses to run in client mode", async () => {
    const fx = seed(`cmd-client-${randomUUID().slice(0, 6)}`);
    fx.db.close();
    await expect(
      runClassifyDomains({
        dbPath: fx.dbPath,
        stateDir: fx.stateDir,
        llm: keywordLlm(),
        config: { mode: "client", serverUrl: "http://bedrock:8787", domains: DOMAINS },
        embedFn: fixedEmbed,
      }),
    ).rejects.toThrow(/server-mode only/);
  });

  it("errors clearly when no domains are configured", async () => {
    const fx = seed(`cmd-nodomains-${randomUUID().slice(0, 6)}`, false);
    fx.db.close();
    await expect(
      runClassifyDomains({
        dbPath: fx.dbPath, stateDir: fx.stateDir, llm: keywordLlm(), config: {}, embedFn: fixedEmbed,
      }),
    ).rejects.toThrow(/needs a `domains` list/);
  });
});
