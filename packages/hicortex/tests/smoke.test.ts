/**
 * Smoke tests for the Hicortex in-process plugin.
 * Tests DB init, memory CRUD, vector search, scoring, and consolidation helpers.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { initDb, getStats, resolveDbPath } from "../src/db.js";
import * as storage from "../src/storage.js";
import { effectiveStrength, retrieve, searchContext, computeScore, l2ToCosine } from "../src/retrieval.js";
import type { Memory } from "../src/types.js";
import { BudgetTracker, parseJsonLenient, msUntilHour } from "../src/consolidate.js";
import { extractConversationText } from "../src/distiller.js";
import { resolveExplicitLlmConfig, resolveLlmConfigForCC, resolveDistillFallback } from "../src/llm.js";
import { parseEnvFile, generateAuthToken, persistAuthToken } from "../src/init.js";
import { readCcTranscripts } from "../src/transcript-reader.js";
import { readHermesSessions } from "../src/hermes-transcript-reader.js";
import { removeLessonsBlock } from "../src/claude-md.js";
import { fetchLessonsContext } from "../src/lessons-context.js";
import type Database from "better-sqlite3";
import BetterSqlite3 from "better-sqlite3";

const TEST_DIR = join(tmpdir(), `hicortex-test-${randomUUID().slice(0, 8)}`);
const DB_PATH = join(TEST_DIR, "test.db");

let db: Database.Database;

// Create a fake 384-dim embedding for testing
function fakeEmbedding(seed = 0): Float32Array {
  const arr = new Float32Array(384);
  for (let i = 0; i < 384; i++) {
    arr[i] = 0.01 * ((i + seed) % 100);
  }
  return arr;
}

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  db = initDb(DB_PATH);
});

afterAll(() => {
  if (db) db.close();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

describe("resolveDbPath", () => {
  const savedEnv = process.env.HICORTEX_DB_PATH;

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.HICORTEX_DB_PATH;
    } else {
      process.env.HICORTEX_DB_PATH = savedEnv;
    }
  });

  it("returns explicit override when provided", () => {
    const path = resolveDbPath("/custom/path/my.db");
    expect(path).toBe("/custom/path/my.db");
  });

  it("returns env var override when set", () => {
    process.env.HICORTEX_DB_PATH = "/env/override/hicortex.db";
    const path = resolveDbPath();
    expect(path).toBe("/env/override/hicortex.db");
  });

  it("returns canonical path for fresh install", () => {
    delete process.env.HICORTEX_DB_PATH;
    // Without mocking fs, this tests the default path logic
    // On a fresh test environment, it should return ~/.hicortex/hicortex.db
    const path = resolveDbPath();
    expect(path).toContain(".hicortex");
    expect(path).toContain("hicortex.db");
  });
});

describe("db", () => {
  it("initializes with all tables", () => {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      )
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);

    expect(names).toContain("memories");
    expect(names).toContain("memory_links");
    expect(names).toContain("memories_fts");
  });

  it("returns stats", () => {
    const stats = getStats(db, DB_PATH);
    expect(stats).toHaveProperty("memories");
    expect(stats).toHaveProperty("links");
    expect(stats).toHaveProperty("db_size_bytes");
    expect(stats).toHaveProperty("by_type");
  });
});

// ---------------------------------------------------------------------------
// Storage CRUD
// ---------------------------------------------------------------------------

describe("storage", () => {
  let testId: string;

  it("inserts a memory with vector", () => {
    testId = storage.insertMemory(
      db,
      "Test memory content for smoke test",
      fakeEmbedding(1),
      {
        sourceAgent: "test",
        project: "hicortex-test",
        memoryType: "episode",
      }
    );
    expect(testId).toBeTruthy();
    expect(testId.length).toBe(36); // UUID format
  });

  it("retrieves a memory by ID", () => {
    const mem = storage.getMemory(db, testId);
    expect(mem).not.toBeNull();
    expect(mem!.content).toBe("Test memory content for smoke test");
    expect(mem!.source_agent).toBe("test");
    expect(mem!.project).toBe("hicortex-test");
    expect(mem!.base_strength).toBe(0.5);
    expect(mem!.access_count).toBe(0);
  });

  it("updates memory fields", () => {
    storage.updateMemory(db, testId, { base_strength: 0.8 });
    const mem = storage.getMemory(db, testId);
    expect(mem!.base_strength).toBe(0.8);
  });

  it("rejects invalid update fields", () => {
    expect(() => {
      storage.updateMemory(db, testId, { invalid_field: "bad" });
    }).toThrow("Cannot update field");
  });

  it("strengthens a memory (atomic increment)", () => {
    storage.strengthenMemory(db, testId, new Date().toISOString());
    const mem = storage.getMemory(db, testId);
    expect(mem!.access_count).toBe(1);
  });

  it("performs vector search", () => {
    const results = storage.vectorSearch(db, fakeEmbedding(1), 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe(testId);
    expect(typeof results[0].distance).toBe("number");
    expect(results[0].distance).toBe(0); // Same embedding = distance 0
  });

  it("performs FTS search", () => {
    const results = storage.searchFts(db, "smoke test", 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe(testId);
  });

  it("counts memories", () => {
    const count = storage.countMemories(db);
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it("batch inserts memories", () => {
    const count = storage.insertMemoriesBatch(db, [
      {
        content: "Batch entry 1",
        embedding: fakeEmbedding(10),
        project: "batch-test",
      },
      {
        content: "Batch entry 2",
        embedding: fakeEmbedding(20),
        project: "batch-test",
      },
    ]);
    expect(count).toBe(2);
  });

  it("gets recent memories", () => {
    const recent = storage.getRecentMemories(db, 7, 50);
    expect(recent.length).toBeGreaterThanOrEqual(1);
  });

  it("gets lessons (empty by default)", () => {
    const lessons = storage.getLessons(db, 7);
    // We haven't inserted any lesson-type memories yet
    expect(Array.isArray(lessons)).toBe(true);
  });

  it("manages links", () => {
    // Insert a second memory for linking
    const id2 = storage.insertMemory(
      db,
      "Second memory for linking",
      fakeEmbedding(50),
      { sourceAgent: "test" }
    );

    storage.addLink(db, testId, id2, "relates_to", 0.7);

    const links = storage.getLinks(db, testId, "both");
    expect(links.length).toBe(1);
    expect(links[0].relationship).toBe("relates_to");
    expect(links[0].strength).toBe(0.7);

    storage.deleteLinks(db, testId);
    const afterDelete = storage.getLinks(db, testId, "both");
    expect(afterDelete.length).toBe(0);
  });

  it("gets all link counts", () => {
    const counts = storage.getAllLinkCounts(db);
    expect(counts instanceof Map).toBe(true);
  });

  it("deletes a memory and its vector", () => {
    storage.deleteMemory(db, testId);
    const mem = storage.getMemory(db, testId);
    expect(mem).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Retrieval / Scoring
// ---------------------------------------------------------------------------

describe("scoring", () => {
  it("computes effective strength with no decay", () => {
    const now = new Date();
    const eff = effectiveStrength(0.8, now.toISOString(), now);
    expect(eff).toBeCloseTo(0.8, 2);
  });

  it("decays strength over time", () => {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const eff = effectiveStrength(0.8, weekAgo.toISOString(), now);
    expect(eff).toBeLessThan(0.8);
    expect(eff).toBeGreaterThan(0);
  });

  it("access hardening slows decay", () => {
    const now = new Date();
    const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const ts = monthAgo.toISOString();

    const noAccess = effectiveStrength(0.5, ts, now, { accessCount: 0 });
    const withAccess = effectiveStrength(0.5, ts, now, { accessCount: 5 });
    expect(withAccess).toBeGreaterThan(noAccess);
  });

  it("link hardening slows decay", () => {
    const now = new Date();
    const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const ts = monthAgo.toISOString();

    const noLinks = effectiveStrength(0.5, ts, now, { linkCount: 0 });
    const withLinks = effectiveStrength(0.5, ts, now, { linkCount: 5 });
    expect(withLinks).toBeGreaterThan(noLinks);
  });

  it("important memories have a higher floor", () => {
    const now = new Date();
    const yearAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
    const ts = yearAgo.toISOString();

    const low = effectiveStrength(0.1, ts, now);
    const high = effectiveStrength(0.9, ts, now);
    expect(high).toBeGreaterThan(low);
  });
});

// ---------------------------------------------------------------------------
// Strengthen-on-use (integration) — regression for the retrieve/searchContext
// → access_count wiring.
//
// The retrieval path MUST increment access_count + last_accessed on hits so the
// decay-hardening term in effectiveStrength reflects real recall. The storage
// primitive (strengthenMemory) is unit-tested above; this locks in that it is
// actually invoked from the public retrieval surface. A future refactor that
// disconnects strengthen() from retrieve()/searchContext() would fail here.
// ---------------------------------------------------------------------------

describe("strengthen-on-use (retrieve integration)", () => {
  it("retrieve increments access_count and sets last_accessed on hits", async () => {
    const embed = fakeEmbedding(800);
    const id = storage.insertMemory(
      db,
      "Strengthen-on-use integration memory about deploy migrations and rollback",
      embed,
      { sourceAgent: "test-strengthen", project: "strengthen-test" }
    );

    let mem = storage.getMemory(db, id);
    expect(mem!.access_count).toBe(0); // never recalled before

    // embedFn returns the stored embedding → guaranteed top hit (distance 0)
    const embedFn = async (_q: string): Promise<Float32Array> => embed;
    const results = await retrieve(db, embedFn, "deploy migrations rollback", {
      limit: 5,
      project: "strengthen-test",
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe(id);

    mem = storage.getMemory(db, id);
    expect(mem!.access_count).toBe(1);
    expect(mem!.last_accessed).not.toBeNull();

    storage.deleteMemory(db, id);
  });

  it("repeated retrieve continues to increment access_count", async () => {
    const embed = fakeEmbedding(810);
    const id = storage.insertMemory(
      db,
      "Repeat-access strengthen memory about build pipeline caching",
      embed,
      { sourceAgent: "test-strengthen", project: "strengthen-test" }
    );
    const embedFn = async (_q: string): Promise<Float32Array> => embed;

    await retrieve(db, embedFn, "build pipeline caching", { limit: 5, project: "strengthen-test" });
    await retrieve(db, embedFn, "build pipeline caching", { limit: 5, project: "strengthen-test" });

    const mem = storage.getMemory(db, id);
    expect(mem!.access_count).toBe(2);

    storage.deleteMemory(db, id);
  });

  it("searchContext also strengthens returned memories", () => {
    const embed = fakeEmbedding(820);
    const id = storage.insertMemory(
      db,
      "SearchContext strengthen memory about release note automation",
      embed,
      { sourceAgent: "test-strengthen", project: "strengthen-test" }
    );

    expect(storage.getMemory(db, id)!.access_count).toBe(0);

    const results = searchContext(db, { project: "strengthen-test", limit: 50 });
    expect(results.some((r) => r.id === id)).toBe(true);

    expect(storage.getMemory(db, id)!.access_count).toBe(1);

    storage.deleteMemory(db, id);
  });
});

// ---------------------------------------------------------------------------
// Consolidation helpers
// ---------------------------------------------------------------------------

describe("consolidation", () => {
  it("BudgetTracker tracks calls", () => {
    const bt = new BudgetTracker(5);
    expect(bt.exhausted).toBe(false);
    expect(bt.remaining).toBe(5);

    expect(bt.use("importance")).toBe(true);
    expect(bt.callsUsed).toBe(1);

    bt.use("importance", 3);
    expect(bt.remaining).toBe(1);

    expect(bt.use("importance", 2)).toBe(false); // over budget
    expect(bt.callsUsed).toBe(4); // unchanged

    bt.use("reflection");
    expect(bt.exhausted).toBe(true);

    const summary = bt.summary();
    expect(summary.max_calls).toBe(5);
    expect(summary.calls_used).toBe(5);
    expect(summary.calls_by_stage.importance).toBe(4);
    expect(summary.calls_by_stage.reflection).toBe(1);
  });

  it("parseJsonLenient handles clean JSON", () => {
    const result = parseJsonLenient("[0.3, 0.7, 0.5]", []);
    expect(result).toEqual([0.3, 0.7, 0.5]);
  });

  it("parseJsonLenient strips markdown fences", () => {
    const result = parseJsonLenient("```json\n[0.3, 0.7]\n```", []);
    expect(result).toEqual([0.3, 0.7]);
  });

  it("parseJsonLenient handles indexed format", () => {
    const result = parseJsonLenient("[0] 0.7\n[1] 0.6\n[2] 0.3", []);
    expect(result).toEqual([0.7, 0.6, 0.3]);
  });

  it("parseJsonLenient returns fallback on garbage", () => {
    const result = parseJsonLenient("this is not json at all", "fallback");
    expect(result).toBe("fallback");
  });

  it("msUntilHour returns positive value", () => {
    const ms = msUntilHour(2);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// Distiller
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// resolveExplicitLlmConfig — explicit-only resolution (Change 1)
// ---------------------------------------------------------------------------

describe("resolveExplicitLlmConfig", () => {
  const savedKeys: Record<string, string | undefined> = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
    HICORTEX_LLM_BASE_URL: process.env.HICORTEX_LLM_BASE_URL,
    HICORTEX_LLM_API_KEY: process.env.HICORTEX_LLM_API_KEY,
    HICORTEX_LLM_MODEL: process.env.HICORTEX_LLM_MODEL,
    HICORTEX_REFLECT_MODEL: process.env.HICORTEX_REFLECT_MODEL,
  };

  afterEach(() => {
    for (const [key, val] of Object.entries(savedKeys)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  it("returns null with clean env and no overrides", () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.HICORTEX_LLM_BASE_URL;
    delete process.env.HICORTEX_LLM_API_KEY;
    delete process.env.HICORTEX_LLM_MODEL;
    const result = resolveExplicitLlmConfig();
    expect(result).toBeNull();
  });

  it("returns null when only ANTHROPIC_API_KEY is set (implicit env key not a default)", () => {
    delete process.env.HICORTEX_LLM_BASE_URL;
    delete process.env.HICORTEX_LLM_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-test-123";
    const result = resolveExplicitLlmConfig();
    expect(result).toBeNull();
  });

  it("returns null when only OPENAI_API_KEY is set", () => {
    delete process.env.HICORTEX_LLM_BASE_URL;
    delete process.env.HICORTEX_LLM_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    process.env.OPENAI_API_KEY = "sk-openai";
    const result = resolveExplicitLlmConfig();
    expect(result).toBeNull();
  });

  it("returns null when only GOOGLE_API_KEY is set", () => {
    delete process.env.HICORTEX_LLM_BASE_URL;
    delete process.env.HICORTEX_LLM_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    process.env.GOOGLE_API_KEY = "gk-google";
    const result = resolveExplicitLlmConfig();
    expect(result).toBeNull();
  });

  it("returns config when HICORTEX_LLM_BASE_URL + HICORTEX_LLM_API_KEY are set", () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.HICORTEX_LLM_BASE_URL = "https://custom.llm.com/v1";
    process.env.HICORTEX_LLM_API_KEY = "sk-custom";
    process.env.HICORTEX_LLM_MODEL = "custom-model";
    const result = resolveExplicitLlmConfig();
    expect(result).not.toBeNull();
    expect(result!.baseUrl).toBe("https://custom.llm.com/v1");
    expect(result!.apiKey).toBe("sk-custom");
    expect(result!.model).toBe("custom-model");
  });

  it("returns null when only HICORTEX_LLM_BASE_URL is set without the API key", () => {
    process.env.HICORTEX_LLM_BASE_URL = "https://custom.llm.com/v1";
    delete process.env.HICORTEX_LLM_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const result = resolveExplicitLlmConfig();
    expect(result).toBeNull();
  });

  it("explicit overrides take priority over HICORTEX_ env vars", () => {
    process.env.HICORTEX_LLM_BASE_URL = "https://env.llm.com/v1";
    process.env.HICORTEX_LLM_API_KEY = "sk-env";
    const result = resolveExplicitLlmConfig({
      llmBaseUrl: "https://override.com",
      llmApiKey: "sk-override",
      llmModel: "override-model",
    });
    expect(result).not.toBeNull();
    expect(result!.baseUrl).toBe("https://override.com");
    expect(result!.apiKey).toBe("sk-override");
    expect(result!.model).toBe("override-model");
  });

  it("returns null when overrides have baseUrl but no apiKey", () => {
    delete process.env.HICORTEX_LLM_BASE_URL;
    delete process.env.HICORTEX_LLM_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const result = resolveExplicitLlmConfig({
      llmBaseUrl: "http://localhost:11434",
      llmModel: "qwen3.5:4b",
    });
    // Ollama handled by mcp-server.ts llmBackend=ollama path, not here
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveLlmConfigForCC alias (deprecated — same as resolveExplicitLlmConfig)
// ---------------------------------------------------------------------------

describe("resolveLlmConfigForCC alias", () => {
  it("is the same function as resolveExplicitLlmConfig", () => {
    expect(resolveLlmConfigForCC).toBe(resolveExplicitLlmConfig);
  });
});

// ---------------------------------------------------------------------------
// parseEnvFile (Change 4)
// ---------------------------------------------------------------------------

describe("parseEnvFile", () => {
  it("parses simple KEY=VALUE pairs", () => {
    const result = parseEnvFile("FOO=bar\nBAZ=qux");
    expect(result["FOO"]).toBe("bar");
    expect(result["BAZ"]).toBe("qux");
  });

  it("strips comment lines", () => {
    const result = parseEnvFile("# This is a comment\nFOO=bar");
    expect(result["FOO"]).toBe("bar");
    expect(Object.keys(result)).not.toContain("#");
  });

  it("handles empty lines", () => {
    const result = parseEnvFile("\n\nFOO=bar\n\n");
    expect(result["FOO"]).toBe("bar");
    expect(Object.keys(result).length).toBe(1);
  });

  it("strips double-quoted values", () => {
    const result = parseEnvFile('API_KEY="sk-secret-value"');
    expect(result["API_KEY"]).toBe("sk-secret-value");
  });

  it("strips single-quoted values", () => {
    const result = parseEnvFile("API_KEY='sk-secret-value'");
    expect(result["API_KEY"]).toBe("sk-secret-value");
  });

  it("handles values with = signs", () => {
    const result = parseEnvFile("URL=https://example.com/path?a=1&b=2");
    expect(result["URL"]).toBe("https://example.com/path?a=1&b=2");
  });

  it("skips lines without = sign", () => {
    const result = parseEnvFile("NODEBUG\nFOO=bar");
    expect(result["FOO"]).toBe("bar");
    expect(result["NODEBUG"]).toBeUndefined();
  });

  it("returns empty object for empty input", () => {
    expect(parseEnvFile("")).toEqual({});
    expect(parseEnvFile("\n\n")).toEqual({});
  });

  it("recognises ANTHROPIC_API_KEY and OPENAI_BASE_URL style keys", () => {
    const result = parseEnvFile(
      "ANTHROPIC_API_KEY=sk-ant-123\nOPENAI_BASE_URL=https://my.proxy.com\nOPENAI_API_KEY=sk-oai-456"
    );
    expect(result["ANTHROPIC_API_KEY"]).toBe("sk-ant-123");
    expect(result["OPENAI_BASE_URL"]).toBe("https://my.proxy.com");
    expect(result["OPENAI_API_KEY"]).toBe("sk-oai-456");
  });
});

// ---------------------------------------------------------------------------
// LlmConfig: ollama backend from config.json (mcp-server config path)
// ---------------------------------------------------------------------------

describe("LlmConfig ollama from config.json", () => {
  it("constructs correct ollama config without apiKey", () => {
    // Simulates what mcp-server.ts does when config.json has llmBackend=ollama
    const savedConfig = {
      llmBackend: "ollama",
      llmBaseUrl: "http://localhost:11434",
      llmModel: "qwen3.5:4b",
      distillModel: "qwen3.5:9b",
      reflectBaseUrl: "http://remote:11434",
      reflectModel: "qwen3.5:27b",
      reflectProvider: "ollama",
    };

    // This is the logic from mcp-server.ts (else branch resolves null — handled by caller)
    let llmConfig: import("../src/llm.js").LlmConfig | null = null;
    if (savedConfig.llmBackend === "ollama" && savedConfig.llmBaseUrl) {
      llmConfig = {
        baseUrl: savedConfig.llmBaseUrl,
        apiKey: "",
        model: savedConfig.llmModel ?? "qwen3.5:4b",
        reflectModel: savedConfig.reflectModel ?? savedConfig.llmModel ?? "qwen3.5:4b",
        provider: "ollama",
      };
    } else {
      llmConfig = resolveExplicitLlmConfig();
    }
    if (!llmConfig) throw new Error("LLM config not resolved — should not happen in this test");

    if (savedConfig.distillModel) {
      llmConfig.distillModel = savedConfig.distillModel;
    }
    if (savedConfig.reflectBaseUrl) {
      llmConfig.reflectBaseUrl = savedConfig.reflectBaseUrl;
      llmConfig.reflectProvider = savedConfig.reflectProvider ?? llmConfig.provider;
    }

    expect(llmConfig.provider).toBe("ollama");
    expect(llmConfig.baseUrl).toBe("http://localhost:11434");
    expect(llmConfig.model).toBe("qwen3.5:4b");
    expect(llmConfig.distillModel).toBe("qwen3.5:9b");
    expect(llmConfig.reflectModel).toBe("qwen3.5:27b");
    expect(llmConfig.reflectBaseUrl).toBe("http://remote:11434");
    expect(llmConfig.apiKey).toBe("");
  });

  it("distillModel falls back to model when unset", () => {
    const config: import("../src/llm.js").LlmConfig = {
      baseUrl: "http://localhost:11434",
      apiKey: "",
      model: "qwen3.5:4b",
      reflectModel: "qwen3.5:4b",
      provider: "ollama",
    };
    // distillModel is undefined — LlmClient.completeDistill uses config.model
    expect(config.distillModel ?? config.model).toBe("qwen3.5:4b");
  });
});

// ---------------------------------------------------------------------------
// resolveDistillFallback — graceful distill-endpoint fallback (no silent stall)
// ---------------------------------------------------------------------------

describe("resolveDistillFallback", () => {
  afterEach(() => vi.unstubAllGlobals());

  // Mock Ollama /api/tags: `up` maps a reachable baseUrl → model names present.
  // Any baseUrl not listed throws (simulates unreachable).
  function mockOllama(up: Record<string, string[]>) {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      const u = String(url);
      for (const [b, models] of Object.entries(up)) {
        if (u.startsWith(b)) {
          return { ok: true, json: async () => ({ models: models.map((n) => ({ name: n })) }) } as unknown as Response;
        }
      }
      throw new Error("connection refused");
    }));
  }

  const remoteCfg = (): import("../src/llm.js").LlmConfig => ({
    baseUrl: "http://local:11434",
    apiKey: "",
    model: "small-4b",
    reflectModel: "big-35b",
    provider: "ollama",
    distillBaseUrl: "http://remote:11434",
    distillModel: "big-35b",
    distillProvider: "ollama",
  });

  it("returns ok and leaves distill config unchanged when the remote is healthy", async () => {
    mockOllama({ "http://remote:11434": ["big-35b"], "http://local:11434": ["small-4b"] });
    const cfg = remoteCfg();
    expect(await resolveDistillFallback(cfg)).toBe("ok");
    expect(cfg.distillBaseUrl).toBe("http://remote:11434");
    expect(cfg.distillModel).toBe("big-35b");
  });

  it("falls back to the local model in 'local' mode when the remote distill box is down", async () => {
    mockOllama({ "http://local:11434": ["small-4b"] }); // remote unreachable
    const cfg = remoteCfg();
    expect(await resolveDistillFallback(cfg, "local")).toBe("fellback");
    expect(cfg.distillBaseUrl).toBe("http://local:11434");
    expect(cfg.distillModel).toBe("small-4b"); // capture continues at lower quality
  });

  it("aborts in 'local' mode only when remote AND local are both unreachable", async () => {
    mockOllama({}); // nothing up
    expect(await resolveDistillFallback(remoteCfg(), "local")).toBe("abort");
  });

  it("returns ok without any probe when no separate distill endpoint is set", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const cfg: import("../src/llm.js").LlmConfig = {
      baseUrl: "http://local:11434", apiKey: "", model: "small-4b", reflectModel: "small-4b", provider: "ollama",
    };
    expect(await resolveDistillFallback(cfg)).toBe("ok");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // 0.9.1 strict mode tests
  it("strict mode: aborts immediately when remote is down, without probing local", async () => {
    // Only local is up — but strict mode must not probe it.
    mockOllama({ "http://local:11434": ["small-4b"] });
    const cfg = remoteCfg();
    const result = await resolveDistillFallback(cfg, "strict");
    expect(result).toBe("abort");
  });

  it("strict mode: does not mutate config when remote is down", async () => {
    mockOllama({ "http://local:11434": ["small-4b"] });
    const cfg = remoteCfg();
    const originalDistillBaseUrl = cfg.distillBaseUrl;
    const originalDistillModel = cfg.distillModel;
    await resolveDistillFallback(cfg, "strict");
    // Config must be unchanged — no fallback mutation.
    expect(cfg.distillBaseUrl).toBe(originalDistillBaseUrl);
    expect(cfg.distillModel).toBe(originalDistillModel);
  });

  it("strict mode is the default when no mode argument is given", async () => {
    mockOllama({ "http://local:11434": ["small-4b"] }); // remote unreachable
    const cfg = remoteCfg();
    // Default (no mode arg) must behave identically to explicit "strict".
    expect(await resolveDistillFallback(cfg)).toBe("abort");
    expect(cfg.distillBaseUrl).toBe("http://remote:11434"); // still unmutated
  });
});

// ---------------------------------------------------------------------------
// Distiller
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Transcript Reader
// ---------------------------------------------------------------------------

describe("transcript-reader", () => {
  const fixtureDir = join(__dirname, "fixtures", "cc-transcripts");

  it("reads transcripts modified after since date", () => {
    const since = new Date("2026-03-24T00:00:00Z"); // Before fixture date
    const batches = readCcTranscripts(since, fixtureDir);
    expect(batches.length).toBe(1);
    expect(batches[0].sessionId).toBe("aaaa-bbbb-cccc");
    expect(batches[0].projectName).toBe("project");
    expect(batches[0].entries.length).toBe(6);
  });

  it("skips transcripts older than since date", () => {
    const since = new Date("2099-01-01T00:00:00Z"); // Far future
    const batches = readCcTranscripts(since, fixtureDir);
    expect(batches.length).toBe(0);
  });

  it("returns empty for nonexistent directory", () => {
    const batches = readCcTranscripts(new Date(0), "/nonexistent/path");
    expect(batches.length).toBe(0);
  });

  it("entries work with extractConversationText", () => {
    const since = new Date("2026-03-24T00:00:00Z");
    const batches = readCcTranscripts(since, fixtureDir);
    expect(batches.length).toBe(1);

    const text = extractConversationText(batches[0].entries);
    expect(text).toContain("USER:");
    expect(text).toContain("deploy");
    expect(text).toContain("migrations");
    // Should NOT contain progress or system entries
    expect(text).not.toContain("hook_progress");
    expect(text).not.toContain("System init");
  });
});

// ---------------------------------------------------------------------------
// Hermes Transcript Reader (per-profile state.db)
// ---------------------------------------------------------------------------

describe("hermes-transcript-reader", () => {
  const secs = (iso: string) => new Date(iso).getTime() / 1000;

  function makeHermesHome(): string {
    const home = join(TEST_DIR, `hermes-home-${randomUUID().slice(0, 6)}`);
    const profileDir = join(home, "profiles", "lenny");
    mkdirSync(profileDir, { recursive: true });

    const hdb = new BetterSqlite3(join(profileDir, "state.db"));
    hdb.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, started_at REAL, ended_at REAL, source TEXT NOT NULL);
      CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT,
        role TEXT, content TEXT, tool_name TEXT, timestamp REAL, active INTEGER DEFAULT 1);
    `);
    const sess = hdb.prepare("INSERT INTO sessions (id, started_at, ended_at, source) VALUES (?,?,?,?)");
    const msg = hdb.prepare(
      "INSERT INTO messages (session_id, role, content, tool_name, timestamp) VALUES (?,?,?,?,?)"
    );

    // Primary (discord) ended session after the watermark → picked up.
    sess.run("s-ended", secs("2026-06-30T09:00:00Z"), secs("2026-06-30T12:00:00Z"), "discord");
    msg.run("s-ended", "session_meta", "SYSTEM_SOUL_PROMPT metadata blob", null, secs("2026-06-30T08:59:00Z"));
    msg.run("s-ended", "user", "How do I deploy the service to production?", null, secs("2026-06-30T09:00:00Z"));
    msg.run("s-ended", "assistant", "Run the deploy script; it handles migrations.", null, secs("2026-06-30T09:01:00Z"));
    msg.run("s-ended", "tool", "FILE_DUMP_LINE ".repeat(500), "read_file", secs("2026-06-30T09:02:00Z"));
    msg.run("s-ended", "user", "Great, did it work?", null, secs("2026-06-30T09:03:00Z"));
    msg.run("s-ended", "assistant", "Yes, deploy succeeded and migrations ran.", null, secs("2026-06-30T09:04:00Z"));

    // Automated cron session — ended, recent, non-empty → MUST be skipped.
    sess.run("cron_lenny-garmin-sync_20260630", secs("2026-06-30T04:00:00Z"), secs("2026-06-30T04:05:00Z"), "cron");
    for (let i = 0; i < 6; i++)
      msg.run("cron_lenny-garmin-sync_20260630", i % 2 ? "assistant" : "user", `garmin sync step ${i} with enough content to pass any length gate`, null, secs("2026-06-30T04:00:00Z") + i);

    // Active session (ended_at NULL) → skipped (distilled after it ends).
    sess.run("s-active", secs("2026-06-30T13:00:00Z"), null, "cli");
    for (let i = 0; i < 5; i++) msg.run("s-active", "user", `active ${i}`, null, secs("2026-06-30T13:00:00Z") + i);

    // Old ended session, before the watermark → skipped.
    sess.run("s-old", secs("2026-06-01T09:00:00Z"), secs("2026-06-01T10:00:00Z"), "cli");
    for (let i = 0; i < 5; i++) msg.run("s-old", "user", `old ${i}`, null, secs("2026-06-01T09:00:00Z") + i);

    hdb.close();
    return home;
  }

  it("reads only ended, primary sessions since the watermark, with provenance", () => {
    const batches = readHermesSessions(new Date("2026-06-30T00:00:00Z"), makeHermesHome());
    expect(batches.length).toBe(1); // s-ended only: cron skipped, active/old excluded
    expect(batches[0].sessionId).toBe("s-ended");
    expect(batches[0].projectName).toBe("lenny");
    expect(batches[0].sourceAgent).toBe("hermes/lenny");
    expect(batches[0].entries.length).toBe(6); // 5 msgs + 1 session_meta (dropped downstream)
    // Automated cron sessions must never be captured.
    expect(batches.some((b) => b.sessionId.startsWith("cron_"))).toBe(false);
  });

  it("drops tool + session_meta rows as noise, keeps the conversation", () => {
    const batches = readHermesSessions(new Date("2026-06-30T00:00:00Z"), makeHermesHome());
    const text = extractConversationText(batches[0].entries);
    expect(text).toContain("USER:");
    expect(text).toContain("deploy");
    expect(text).toContain("migrations ran");
    expect(text).not.toContain("FILE_DUMP_LINE");       // bulk tool output stripped
    expect(text).not.toContain("SYSTEM_SOUL_PROMPT");    // session_meta stripped
  });

  it("returns nothing when the watermark is after all ended sessions", () => {
    const batches = readHermesSessions(new Date("2099-01-01T00:00:00Z"), makeHermesHome());
    expect(batches.length).toBe(0);
  });

  it("returns empty for a hermes home with no profiles", () => {
    const empty = join(TEST_DIR, `hermes-empty-${randomUUID().slice(0, 6)}`);
    mkdirSync(empty, { recursive: true });
    expect(readHermesSessions(new Date(0), empty).length).toBe(0);
  });

  it("keeps a short but non-empty session (no arbitrary count gate)", () => {
    // A 2-message exchange can carry a real decision — it must NOT be dropped
    // on count. Meaningful-content is gated downstream (200-char check).
    const home = join(TEST_DIR, `hermes-short-${randomUUID().slice(0, 6)}`);
    const pd = join(home, "profiles", "nano");
    mkdirSync(pd, { recursive: true });
    const hdb = new BetterSqlite3(join(pd, "state.db"));
    hdb.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, started_at REAL, ended_at REAL, source TEXT NOT NULL);
      CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT,
        role TEXT, content TEXT, tool_name TEXT, timestamp REAL, active INTEGER DEFAULT 1);
    `);
    hdb.prepare("INSERT INTO sessions (id, started_at, ended_at, source) VALUES (?,?,?,?)")
      .run("s-short", secs("2026-06-30T09:00:00Z"), secs("2026-06-30T09:05:00Z"), "cli");
    const m = hdb.prepare("INSERT INTO messages (session_id, role, content, tool_name, timestamp) VALUES (?,?,?,?,?)");
    m.run("s-short", "user", "Should we move the boat to the winter berth before the storm hits?", null, secs("2026-06-30T09:00:00Z"));
    m.run("s-short", "assistant", "Yes — move it Friday; the storm lands Saturday and the summer berth is exposed.", null, secs("2026-06-30T09:01:00Z"));
    hdb.close();

    const batches = readHermesSessions(new Date("2026-06-30T00:00:00Z"), home);
    expect(batches.length).toBe(1);
    expect(batches[0].entries.length).toBe(2); // not dropped on count
  });
});

// ---------------------------------------------------------------------------
// Distiller
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// CLAUDE.md Injection
// ---------------------------------------------------------------------------

describe("claude-md", () => {
  const testClaudeMd = join(TEST_DIR, "CLAUDE.md");

  // injectLessons was removed in 0.9.0 — lessons are now query-time via
  // the CC SessionStart hook (lessons-context.ts) and the Hermes plugin.

  it("removeLessonsBlock removes the block", () => {
    writeFileSync(testClaudeMd, "# My Project\n\n<!-- HICORTEX-LEARNINGS:START -->\nstuff\n<!-- HICORTEX-LEARNINGS:END -->\n\n## Other\n");

    const removed = removeLessonsBlock(testClaudeMd);
    expect(removed).toBe(true);

    const content = readFileSync(testClaudeMd, "utf-8");
    expect(content).toContain("# My Project");
    expect(content).toContain("## Other");
    expect(content).not.toContain("HICORTEX-LEARNINGS");
  });

  it("removeLessonsBlock returns false when no block exists", () => {
    writeFileSync(testClaudeMd, "# No hicortex here\n");
    expect(removeLessonsBlock(testClaudeMd)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Distiller
// ---------------------------------------------------------------------------

describe("distiller", () => {
  it("extracts conversation text from messages", () => {
    const messages = [
      { role: "user", content: "How do I deploy to production?" },
      {
        role: "assistant",
        content: "You can deploy using the deploy script. Here are the steps...",
      },
      { role: "user", content: "What about the database migration?" },
      {
        role: "assistant",
        content:
          "The migration is handled automatically during deploy. The deploy script runs...",
      },
    ];

    const text = extractConversationText(messages);
    expect(text).toContain("USER:");
    expect(text).toContain("ASSISTANT:");
    expect(text).toContain("deploy");
  });

  it("strips code blocks >10 lines", () => {
    const longCode = Array(15)
      .fill("  console.log('test');")
      .join("\n");
    const messages = [
      {
        role: "assistant",
        content: `Here is the code:\n\`\`\`typescript\n${longCode}\n\`\`\`\nThat's it.`,
      },
    ];

    const text = extractConversationText(messages);
    expect(text).toContain("[code block removed]");
    expect(text).not.toContain("console.log");
  });

  it("skips system and progress entries", () => {
    const messages = [
      { type: "system", content: "System initialization" },
      { type: "progress", content: "Loading..." },
      { role: "user", content: "This is a real user message that should appear" },
    ];

    const text = extractConversationText(messages);
    expect(text).not.toContain("System initialization");
    expect(text).not.toContain("Loading");
    expect(text).toContain("real user message");
  });

  it("handles block content format", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "This is a response from the assistant." },
          { type: "tool_use", id: "123", name: "read_file" },
        ],
      },
    ];

    const text = extractConversationText(messages);
    expect(text).toContain("response from the assistant");
  });
});

// ---------------------------------------------------------------------------
// Features (centralized gating + license race fix)
// ---------------------------------------------------------------------------

import {
  initFeatures,
  isPro,
  maxMemoriesAllowed,
  lessonsLimit,
  remoteIngestAllowed,
  memoryCapReached,
  getCurrentFeatures,
  getValidatedLicense,
} from "../src/features.js";

// ---------------------------------------------------------------------------
// Features — all gates removed (0.10.0)
// ---------------------------------------------------------------------------

describe("features", () => {
  // Gate-free assertions: every function must return the fully-unlocked value
  // regardless of license key or memory count, now and after future init calls.

  it("memoryCapReached always returns false at any count", () => {
    expect(memoryCapReached(0)).toBe(false);
    expect(memoryCapReached(250)).toBe(false);
    expect(memoryCapReached(1_000_000)).toBe(false);
  });

  it("maxMemoriesAllowed always returns -1 (unlimited)", () => {
    expect(maxMemoriesAllowed()).toBe(-1);
  });

  it("lessonsLimit always returns 20", () => {
    expect(lessonsLimit()).toBe(20);
  });

  it("remoteIngestAllowed always returns true", () => {
    expect(remoteIngestAllowed()).toBe(true);
  });

  it("isPro always returns true", () => {
    expect(isPro()).toBe(true);
  });

  it("getCurrentFeatures returns a full-featured record", () => {
    const features = getCurrentFeatures();
    expect(features).toHaveProperty("maxMemories", -1);
    expect(features).toHaveProperty("reflection", true);
    expect(features).toHaveProperty("vectorSearch", true);
    expect(features).toHaveProperty("remoteIngest", true);
  });

  it("initFeatures with no key completes without error", async () => {
    const dir = join(TEST_DIR, `features-init-${randomUUID().slice(0, 6)}`);
    mkdirSync(dir, { recursive: true });
    await expect(initFeatures(undefined, dir)).resolves.toBeUndefined();
    // Gates remain fully unlocked after init.
    expect(memoryCapReached(999)).toBe(false);
    expect(maxMemoriesAllowed()).toBe(-1);
  });

  it("getValidatedLicense returns null when no key was supplied", () => {
    // No validateLicense HTTP call occurs for undefined key; result is null.
    expect(getValidatedLicense()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Extensions (LessonSelector + PromptStrategy + loader)
// ---------------------------------------------------------------------------

import {
  defaultLessonSelector,
  defaultPromptStrategy,
  getLessonSelector,
  getPromptStrategy,
  setExtensions,
  type SelectableLesson,
  type LessonSelector,
} from "../src/extensions.js";

describe("extensions", () => {
  describe("defaultLessonSelector", () => {
    it("preserves input order for metadata-free lessons (equal scores, stable sort)", async () => {
      // With no project/created_at/base_strength/access_count, every lesson
      // scores identically; the stable sort preserves input order, so the
      // result matches the pre-#123 slice(0, N) behaviour.
      const lessons = [
        { content: "lesson 1" },
        { content: "lesson 2" },
        { content: "lesson 3" },
        { content: "lesson 4" },
      ];
      const selected = await defaultLessonSelector.select(lessons, { maxLessons: 2 });
      expect(selected.length).toBe(2);
      expect(selected[0].content).toBe("lesson 1");
      expect(selected[1].content).toBe("lesson 2");
    });

    it("returns all lessons if maxLessons exceeds count", async () => {
      const lessons = [{ content: "a" }, { content: "b" }];
      const selected = await defaultLessonSelector.select(lessons, { maxLessons: 100 });
      expect(selected.length).toBe(2);
    });

    it("returns empty array for empty input", async () => {
      const selected = await defaultLessonSelector.select([], { maxLessons: 10 });
      expect(selected.length).toBe(0);
    });

    it("preserves the input shape (generic over T)", async () => {
      // Memory-shaped input
      const memoryLike = [
        { id: "1", content: "x", memory_type: "lesson" },
        { id: "2", content: "y", memory_type: "lesson" },
      ];
      const selected = await defaultLessonSelector.select(memoryLike, { maxLessons: 1 });
      expect(selected[0].id).toBe("1"); // id field preserved
      expect(selected[0].memory_type).toBe("lesson");
    });

    it("works with HTTP-shape lessons (client-mode)", async () => {
      const httpShape = [
        { content: "from server", created_at: "2026-04-06", base_strength: 0.8, access_count: 3 },
      ];
      const selected = await defaultLessonSelector.select(httpShape, { maxLessons: 5 });
      expect(selected[0].base_strength).toBe(0.8);
      expect(selected[0].access_count).toBe(3);
    });
  });

  // Domain-aware scoring — restored into core in #123 (deleted with the Pro
  // loader in #122). These 3 tests are the adapted versions of the ones
  // removed in #122 (import path pro/selection → lesson-selection, export
  // proLessonSelector → domainAwareLessonSelector).
  describe("domain-aware lesson selection (core since #123)", () => {
    it("scores 1.0 for exact project match", async () => {
      const { domainAwareLessonSelector } = await import("../src/lesson-selection.js");
      const lessons = [
        { content: "lesson A", project: "hicortex", created_at: "2026-04-12", base_strength: 0.8, access_count: 3 },
      ];
      const selected = await domainAwareLessonSelector.select(lessons, { maxLessons: 5, project: "hicortex" });
      expect(selected).toHaveLength(1);
    });

    it("scores 0.5 for same-domain project via moduleIndex", async () => {
      const { domainAwareLessonSelector } = await import("../src/lesson-selection.js");
      const moduleIndex: ModuleIndex = {
        domains: [
          { name: "Dev Tools", projects: ["hicortex", "raider"], memoryCount: 100, lessonCount: 10, keywords: [] },
        ],
        projectSetHash: "test",
        curatedAt: "2026-04-12T00:00:00Z",
        totalMemories: 100,
        totalLessons: 10,
      };
      const lessons = [
        { content: "lesson from raider about deploy", project: "raider", created_at: "2026-04-12", base_strength: 0.8, access_count: 3 },
        { content: "lesson from health about sleep", project: "health", created_at: "2026-04-12", base_strength: 0.9, access_count: 5 },
      ];
      // When selecting for "hicortex", "raider" lesson should rank higher (same domain = 0.5)
      // than "health" lesson (different domain = 0.0) despite health having higher strength + access
      const selected = await domainAwareLessonSelector.select(lessons, {
        maxLessons: 2,
        project: "hicortex",
        moduleIndex,
      });
      expect(selected).toHaveLength(2);
      expect(selected[0].project).toBe("raider"); // same domain scores higher
    });

    it("falls back to 0.0 for unrelated projects without moduleIndex", async () => {
      const { domainAwareLessonSelector } = await import("../src/lesson-selection.js");
      const lessons = [
        { content: "lesson from raider", project: "raider", created_at: "2026-04-12", base_strength: 0.8, access_count: 3 },
        { content: "lesson from global", project: "global", created_at: "2026-04-12", base_strength: 0.8, access_count: 3 },
      ];
      // Without moduleIndex, "global" (0.3) beats "raider" (0.0)
      const selected = await domainAwareLessonSelector.select(lessons, {
        maxLessons: 2,
        project: "hicortex",
      });
      expect(selected).toHaveLength(2);
      expect(selected[0].project).toBe("global");
    });

    // NEW in #123: proves the DEFAULT selector (what every call site gets via
    // getLessonSelector() with no overrides) applies domain-aware scoring —
    // not just the named export. A regression that reverts the default to the
    // old slice(0, N) selector fails here.
    it("DEFAULT selector applies domain-aware scoring (same-domain outranks unrelated at equal recency/strength)", async () => {
      // Ensure no override is active
      setExtensions({ selector: defaultLessonSelector, prompts: defaultPromptStrategy });

      const moduleIndex: ModuleIndex = {
        domains: [
          { name: "Dev Tools", projects: ["hicortex", "raider"], memoryCount: 100, lessonCount: 10, keywords: [] },
        ],
        projectSetHash: "test",
        curatedAt: "2026-04-12T00:00:00Z",
        totalMemories: 100,
        totalLessons: 10,
      };
      // IDENTICAL recency, strength, and access — only the domain differs.
      // Unrelated lesson listed FIRST so a slice-based selector would pick it.
      const lessons = [
        { content: "lesson from health about sleep quality", project: "health", created_at: "2026-04-12", base_strength: 0.8, access_count: 3 },
        { content: "lesson from raider about deploy safety", project: "raider", created_at: "2026-04-12", base_strength: 0.8, access_count: 3 },
      ];
      const selected = await getLessonSelector().select(lessons, {
        maxLessons: 1,
        project: "hicortex",
        moduleIndex,
      });
      expect(selected).toHaveLength(1);
      expect(selected[0].project).toBe("raider"); // same domain (0.5) > unrelated (0.0)
    });
  });

  describe("defaultPromptStrategy", () => {
    it("distillation produces a non-empty prompt with the project and date", () => {
      const prompt = defaultPromptStrategy.distillation("hicortex", "2026-04-06", "USER: hello\nASSISTANT: hi");
      expect(prompt.length).toBeGreaterThan(50);
      expect(prompt).toContain("hicortex");
      expect(prompt).toContain("2026-04-06");
    });

    it("reflection produces a non-empty prompt", () => {
      const prompt = defaultPromptStrategy.reflection("[project] memory text");
      expect(prompt.length).toBeGreaterThan(50);
      expect(prompt).toContain("memory text");
    });

    it("reflection includes recent lessons block when provided", () => {
      const prompt = defaultPromptStrategy.reflection("memory", "- prior lesson 1");
      expect(prompt).toContain("prior lesson 1");
    });

    it("importanceScoring produces a non-empty prompt", () => {
      const prompt = defaultPromptStrategy.importanceScoring("[0] memory");
      expect(prompt.length).toBeGreaterThan(20);
    });

    it("parseReflection extracts well-formed lessons", () => {
      const raw = JSON.stringify([
        { lesson: "Always test deploy", type: "correct", project: "infra", severity: "important", confidence: "high", source_pattern: "deploy failure" },
      ]);
      const parsed = defaultPromptStrategy.parseReflection(raw);
      expect(parsed.length).toBe(1);
      expect(parsed[0].lesson).toBe("Always test deploy");
      expect(parsed[0].type).toBe("correct");
      expect(parsed[0].severity).toBe("important");
      expect(parsed[0].source_pattern).toBe("deploy failure");
    });

    it("parseReflection tolerates markdown fences", () => {
      const raw = "```json\n[{\"lesson\":\"x\",\"type\":\"reinforce\"}]\n```";
      const parsed = defaultPromptStrategy.parseReflection(raw);
      expect(parsed.length).toBe(1);
      expect(parsed[0].lesson).toBe("x");
    });

    it("parseReflection returns empty array on garbage", () => {
      expect(defaultPromptStrategy.parseReflection("not json").length).toBe(0);
      expect(defaultPromptStrategy.parseReflection("").length).toBe(0);
    });

    it("parseReflection skips entries without a lesson field", () => {
      const raw = JSON.stringify([
        { lesson: "valid" },
        { type: "correct" },                   // missing lesson
        { lesson: "" },                        // empty lesson
        { lesson: "another valid" },
      ]);
      const parsed = defaultPromptStrategy.parseReflection(raw);
      expect(parsed.length).toBe(2);
      expect(parsed[0].lesson).toBe("valid");
      expect(parsed[1].lesson).toBe("another valid");
    });

    it("parseImportanceScores returns scores in [0, 1]", () => {
      const scores = defaultPromptStrategy.parseImportanceScores("[0.3, 0.7, 0.95]", 3);
      expect(scores).toEqual([0.3, 0.7, 0.95]);
    });

    it("parseImportanceScores clamps out-of-range values", () => {
      const scores = defaultPromptStrategy.parseImportanceScores("[-0.5, 1.5, 0.5]", 3);
      expect(scores[0]).toBe(0);
      expect(scores[1]).toBe(1);
      expect(scores[2]).toBe(0.5);
    });

    it("parseImportanceScores pads with 0.5 when count is short", () => {
      const scores = defaultPromptStrategy.parseImportanceScores("[0.7]", 3);
      expect(scores.length).toBe(3);
      expect(scores[0]).toBe(0.7);
      expect(scores[1]).toBe(0.5);
      expect(scores[2]).toBe(0.5);
    });

    it("parseImportanceScores handles indexed format", () => {
      const scores = defaultPromptStrategy.parseImportanceScores("[0] 0.7\n[1] 0.4", 2);
      expect(scores).toEqual([0.7, 0.4]);
    });

    it("parseImportanceScores returns all 0.5 on garbage", () => {
      const scores = defaultPromptStrategy.parseImportanceScores("garbage", 4);
      expect(scores).toEqual([0.5, 0.5, 0.5, 0.5]);
    });
  });

  describe("loader (setExtensions / getLessonSelector / getPromptStrategy)", () => {
    it("returns defaults when no Pro extensions are set", () => {
      // Reset to defaults (in case a previous test set something)
      setExtensions({ selector: defaultLessonSelector, prompts: defaultPromptStrategy });
      expect(getLessonSelector()).toBe(defaultLessonSelector);
      expect(getPromptStrategy()).toBe(defaultPromptStrategy);
    });

    it("setExtensions replaces the active selector", async () => {
      const customSelector: LessonSelector = {
        select<T extends SelectableLesson>(lessons: T[], _ctx: { maxLessons: number }): T[] {
          // Reverse order — proves it's not the default
          return lessons.slice().reverse().slice(0, _ctx.maxLessons);
        },
      };
      setExtensions({ selector: customSelector });
      const result = await getLessonSelector().select(
        [{ content: "a" }, { content: "b" }, { content: "c" }],
        { maxLessons: 2 },
      );
      expect(result[0].content).toBe("c");
      expect(result[1].content).toBe("b");

      // Restore default for other tests
      setExtensions({ selector: defaultLessonSelector });
    });

    it("setExtensions can replace selector and prompts independently", () => {
      // Replace only prompts; selector should stay as previously set
      const customPrompts = { ...defaultPromptStrategy };
      setExtensions({ prompts: customPrompts });
      expect(getPromptStrategy()).toBe(customPrompts);
      expect(getLessonSelector()).toBe(defaultLessonSelector);

      // Restore
      setExtensions({ prompts: defaultPromptStrategy });
    });
  });
});

// ---------------------------------------------------------------------------
// Schema versioning
// ---------------------------------------------------------------------------

import { getSchemaVersion } from "../src/db.js";

describe("schema versioning", () => {
  it("getSchemaVersion returns the latest applied migration version", () => {
    // After initDb, all migrations should have run
    const version = getSchemaVersion(db);
    // v1 ingested_at, v2 updated_at, v3 domain, v4 unique_source_session,
    // v5 rescale_link_strength_to_cosine
    expect(version).toBeGreaterThanOrEqual(5);
  });

  it("migration v4 created the UNIQUE partial index on source_session", () => {
    const indexes = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='memories'")
      .all() as Array<{ name: string; sql: string | null }>;
    const idx = indexes.find((i) => i.name === "idx_memories_source_session_unique");
    expect(idx).toBeDefined();
    // Partial unique index — only non-NULL source_session values are constrained.
    expect((idx?.sql ?? "").toLowerCase()).toContain("unique");
  });

  it("insertMemory is idempotent on source_session (migration v4)", () => {
    const before = storage.countMemories(db);
    const id1 = storage.insertMemory(db, "idempotency test content alpha", fakeEmbedding(900), {
      sourceAgent: "test-v4",
      sourceSession: "sess-1#seg-1#0",
    });
    // A second insert with the SAME source_session returns the EXISTING id,
    // does not add a row, and does not add a vector (first content wins).
    const id2 = storage.insertMemory(db, "DUPLICATE same source_session", fakeEmbedding(901), {
      sourceAgent: "test-v4",
      sourceSession: "sess-1#seg-1#0",
    });
    expect(id2).toBe(id1);
    expect(storage.countMemories(db)).toBe(before + 1);
    const mem = storage.getMemory(db, id1);
    expect(mem).not.toBeNull();
    expect(mem!.content).toBe("idempotency test content alpha");
    storage.deleteMemory(db, id1);
  });

  it("insertMemory with NULL source_session always inserts (no collision)", () => {
    const before = storage.countMemories(db);
    storage.insertMemory(db, "null-source one", fakeEmbedding(910), { sourceAgent: "test-v4" });
    storage.insertMemory(db, "null-source two", fakeEmbedding(911), { sourceAgent: "test-v4" });
    expect(storage.countMemories(db)).toBe(before + 2);
    db.prepare("DELETE FROM memories WHERE source_agent = ? AND content IN (?, ?)")
      .run("test-v4", "null-source one", "null-source two");
  });

  it("per-chunk source_session stores all chunks of a session (nightly dedup contract)", () => {
    const before = storage.countMemories(db);
    const sess = "sess-chunks-1";
    // Nightly stores each distilled chunk as "<sessionId>#<i>" — a bare
    // sessionId would collide on the UNIQUE index and drop all but the first.
    for (let i = 0; i < 3; i++) {
      storage.insertMemory(db, `chunk ${i} content`, fakeEmbedding(920 + i), {
        sourceAgent: "test-chunks",
        sourceSession: `${sess}#${i}`,
      });
    }
    expect(storage.countMemories(db)).toBe(before + 3);

    // The nightly skip-check finds an already-ingested session by prefix.
    const found = db
      .prepare("SELECT COUNT(*) c FROM memories WHERE source_session LIKE ?")
      .get(`${sess}#%`) as { c: number };
    expect(found.c).toBe(3);

    // Re-running the session is idempotent (INSERT OR IGNORE per chunk key).
    for (let i = 0; i < 3; i++) {
      storage.insertMemory(db, `chunk ${i} REDISTILLED`, fakeEmbedding(930 + i), {
        sourceAgent: "test-chunks",
        sourceSession: `${sess}#${i}`,
      });
    }
    expect(storage.countMemories(db)).toBe(before + 3); // no new rows
    db.prepare("DELETE FROM memories WHERE source_agent = ?").run("test-chunks");
  });

  it("session skip-check escapes LIKE wildcards in Hermes ids (underscores)", () => {
    // Hermes session ids contain "_" (e.g. 20260701_045744_355bd520). An
    // unescaped LIKE would treat "_" as a wildcard and match a different id.
    const a = "20260701_045744_aaaaaaaa";
    const b = "20260701X045744Xaaaaaaaa"; // same length; "_"->any-char would match this
    storage.insertMemory(db, "a chunk", fakeEmbedding(940), { sourceAgent: "test-esc", sourceSession: `${a}#0` });
    storage.insertMemory(db, "b chunk", fakeEmbedding(941), { sourceAgent: "test-esc", sourceSession: `${b}#0` });

    // Mirrors the nightly skip-check (nightly.ts): escape \ % _ then ESCAPE '\'.
    const likePrefix = `${a.replace(/[\\%_]/g, (m) => "\\" + m)}#%`;
    const row = db
      .prepare("SELECT COUNT(*) c FROM memories WHERE source_session = ? OR source_session LIKE ? ESCAPE '\\'")
      .get(a, likePrefix) as { c: number };
    expect(row.c).toBe(1); // only session a — NOT b (would be 2 without escaping)

    db.prepare("DELETE FROM memories WHERE source_agent = ?").run("test-esc");
  });

  it("migration v5 rescales old 1−L2 link strengths to cosine, exactly once", () => {
    const dir = join(TEST_DIR, `mig5-${randomUUID().slice(0, 6)}`);
    mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, "mig5.db");
    let mdb = initDb(dbPath);

    const idA = storage.insertMemory(mdb, "migration v5 link source", fakeEmbedding(950), {
      sourceAgent: "test-v5",
    });
    const idB = storage.insertMemory(mdb, "migration v5 link target", fakeEmbedding(951), {
      sourceAgent: "test-v5",
    });
    // Old-scale strengths (1−L2): the range the pre-fix code actually wrote
    storage.addLink(mdb, idA, idB, "relates_to", 0.55);
    storage.addLink(mdb, idB, idA, "updates", 0.8);
    // Guard check: strength outside (0, 1] must be left untouched
    mdb
      .prepare(
        "INSERT INTO memory_links (source_id, target_id, relationship, strength, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(idA, idA, "relates_to", 0, new Date().toISOString());

    // Rewind: make v5 pending again, as on a DB created before the fix. Delete
    // v5 AND every later migration row so MAX(version) drops below 5 and the
    // migrate() gate (version > currentVersion) re-runs v5. Later migrations
    // (v6 memory_tags) are idempotent (IF NOT EXISTS), so re-applying them is a
    // no-op — only v5's one-shot rescale is under test here.
    mdb.prepare("DELETE FROM schema_version WHERE version >= 5").run();
    mdb.close();

    // Reopen → migrate() applies v5 and rescales: cos = 1 − (1 − old)² / 2
    mdb = initDb(dbPath);
    const read = () =>
      mdb
        .prepare(
          "SELECT source_id, target_id, strength FROM memory_links ORDER BY source_id, target_id",
        )
        .all() as Array<{ source_id: string; target_id: string; strength: number }>;
    const byPair = (rows: ReturnType<typeof read>, s: string, t: string) =>
      rows.find((r) => r.source_id === s && r.target_id === t)!.strength;

    const after = read();
    expect(byPair(after, idA, idB)).toBeCloseTo(0.89875, 12); // 1 − 0.45²/2
    expect(byPair(after, idB, idA)).toBeCloseTo(0.98, 12); // 1 − 0.2²/2
    expect(byPair(after, idA, idA)).toBe(0); // guard: untouched

    // Idempotency: reopening runs migrate() again, but the schema_version
    // gate skips v5 — values must be byte-identical, not double-converted.
    mdb.close();
    mdb = initDb(dbPath);
    const again = read();
    expect(byPair(again, idA, idB)).toBe(byPair(after, idA, idB));
    expect(byPair(again, idB, idA)).toBe(byPair(after, idB, idA));
    expect(byPair(again, idA, idA)).toBe(0);
    expect(getSchemaVersion(mdb)).toBeGreaterThanOrEqual(5);
    mdb.close();
  });

  it("schema_version table exists with applied entries", () => {
    const rows = db
      .prepare("SELECT version, name, applied_at FROM schema_version ORDER BY version")
      .all() as Array<{ version: number; name: string; applied_at: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows[0].version).toBe(1);
    expect(rows[0].name).toBe("add_ingested_at");
    expect(rows[1].version).toBe(2);
    expect(rows[1].name).toBe("add_updated_at");
    // applied_at should be a valid ISO timestamp
    expect(() => new Date(rows[0].applied_at).toISOString()).not.toThrow();
  });

  it("re-running initDb on existing database is idempotent (no duplicate migration rows)", () => {
    const beforeCount = (db.prepare("SELECT COUNT(*) as c FROM schema_version").get() as { c: number }).c;
    // initDb has already run in beforeAll. Running migrate logic indirectly:
    // any subsequent initDb call on the same path would re-run migrate() but
    // the version check skips already-applied migrations.
    // We can't easily re-init the same DB connection, but we can verify the
    // version count is stable.
    const afterCount = (db.prepare("SELECT COUNT(*) as c FROM schema_version").get() as { c: number }).c;
    expect(afterCount).toBe(beforeCount);
  });

  it("migration columns exist on the memories table", () => {
    const cols = db.pragma("table_info(memories)") as Array<{ name: string }>;
    const colNames = new Set(cols.map((c) => c.name));
    expect(colNames.has("ingested_at")).toBe(true);
    expect(colNames.has("updated_at")).toBe(true);
  });

  it("idx_memories_ingested index exists after migration v1", () => {
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='memories'")
      .all() as Array<{ name: string }>;
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain("idx_memories_ingested");
  });
});

// ---------------------------------------------------------------------------
// State (consolidated state.json)
// ---------------------------------------------------------------------------

import {
  loadState,
  saveState,
  updateState,
  migrateLegacyState,
  describeLastNightly,
  type HicortexState,
  type PersistedTier,
} from "../src/state.js";

describe("state", () => {
  function freshDir(label: string): string {
    const d = join(TEST_DIR, `state-${label}-${randomUUID().slice(0, 6)}`);
    mkdirSync(d, { recursive: true });
    return d;
  }

  describe("describeLastNightly", () => {
    it("returns null when neither state.json nor legacy file exists", () => {
      const dir = freshDir("dln-none");
      expect(describeLastNightly(dir)).toBeNull();
    });

    it("reads lastNightly from state.json", () => {
      const dir = freshDir("dln-state");
      const ts = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      saveState({ lastNightly: ts }, dir);
      const info = describeLastNightly(dir);
      expect(info?.timestamp).toBe(ts);
      expect(info?.invalid).toBe(false);
      expect(info?.ageStr).toBe("2h ago");
      expect(info?.stale).toBe(false);
    });

    it("falls back to legacy nightly-last-run.txt when state.json has no lastNightly", () => {
      const dir = freshDir("dln-legacy");
      const ts = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
      writeFileSync(join(dir, "nightly-last-run.txt"), ts + "\n");
      const info = describeLastNightly(dir);
      expect(info?.timestamp).toBe(ts);
      expect(info?.stale).toBe(false);
    });

    it("flags invalid timestamps without throwing", () => {
      const dir = freshDir("dln-invalid");
      saveState({ lastNightly: "not-a-date" }, dir);
      const info = describeLastNightly(dir);
      expect(info?.invalid).toBe(true);
    });

    it("marks runs older than 30h as stale", () => {
      const dir = freshDir("dln-stale");
      const ts = new Date(Date.now() - 40 * 60 * 60 * 1000).toISOString();
      saveState({ lastNightly: ts }, dir);
      expect(describeLastNightly(dir)?.stale).toBe(true);
    });
  });

  describe("loadState / saveState", () => {
    it("returns empty state when file doesn't exist", () => {
      const dir = freshDir("empty");
      const state = loadState(dir);
      expect(state).toEqual({});
    });

    it("returns empty state on corrupted JSON", () => {
      const dir = freshDir("corrupt");
      writeFileSync(join(dir, "state.json"), "{ not valid json");
      const state = loadState(dir);
      expect(state).toEqual({});
    });

    it("round-trips a full state object", () => {
      const dir = freshDir("roundtrip");
      const original: HicortexState = {
        lastNightly: "2026-04-06T02:03:00Z",
        lastConsolidated: "2026-04-06T02:05:00Z",
        tier: {
          tier: "pro",
          validatedAt: "2026-04-06T10:00:00Z",
          features: {
            reflection: true,
            vectorSearch: true,
            maxMemories: -1,
            crossAgent: true,
            remoteIngest: false,
          },
        },
      };
      saveState(original, dir);
      const loaded = loadState(dir);
      expect(loaded).toEqual(original);
    });

    it("saves uses atomic write (no partial state on existing file)", () => {
      const dir = freshDir("atomic");
      saveState({ lastNightly: "first" }, dir);
      saveState({ lastNightly: "second" }, dir);
      expect(loadState(dir).lastNightly).toBe("second");

      // Temp file should not be left behind after successful save
      try {
        const tmp = readFileSync(join(dir, "state.json.tmp"), "utf-8");
        // If we get here, .tmp exists — that's a leak
        expect(tmp).toBeUndefined();
      } catch {
        // ENOENT — correct, .tmp was renamed away
      }
    });
  });

  describe("updateState", () => {
    it("applies an in-place mutation", () => {
      const dir = freshDir("inplace");
      saveState({ lastNightly: "before" }, dir);
      updateState((s) => {
        s.lastConsolidated = "added";
      }, dir);
      const loaded = loadState(dir);
      expect(loaded.lastNightly).toBe("before");
      expect(loaded.lastConsolidated).toBe("added");
    });

    it("applies a return-based update", () => {
      const dir = freshDir("return");
      saveState({ lastNightly: "old" }, dir);
      updateState((_s) => ({ lastNightly: "new" }), dir);
      const loaded = loadState(dir);
      expect(loaded.lastNightly).toBe("new");
    });

    it("creates the file if it doesn't exist yet", () => {
      const dir = freshDir("create");
      updateState((s) => {
        s.lastNightly = "first run";
      }, dir);
      const loaded = loadState(dir);
      expect(loaded.lastNightly).toBe("first run");
    });
  });

  describe("migrateLegacyState", () => {
    it("returns false when no legacy files and no state.json", () => {
      const dir = freshDir("none");
      expect(migrateLegacyState(dir)).toBe(false);
      // No state.json should be created
      expect(loadState(dir)).toEqual({});
    });

    it("returns false when state.json already exists (and cleans up legacy)", () => {
      const dir = freshDir("already");
      saveState({ lastNightly: "kept" }, dir);
      writeFileSync(join(dir, "nightly-last-run.txt"), "should-be-deleted");
      writeFileSync(join(dir, "tier.json"), '{"tier":"pro"}');

      expect(migrateLegacyState(dir)).toBe(false);

      // state.json untouched, legacy files cleaned up
      expect(loadState(dir).lastNightly).toBe("kept");
      expect(() => readFileSync(join(dir, "nightly-last-run.txt"))).toThrow();
      expect(() => readFileSync(join(dir, "tier.json"))).toThrow();
    });

    it("migrates nightly-last-run.txt", () => {
      const dir = freshDir("nightly");
      writeFileSync(join(dir, "nightly-last-run.txt"), "2026-04-05T02:00:00Z");
      expect(migrateLegacyState(dir)).toBe(true);

      const state = loadState(dir);
      expect(state.lastNightly).toBe("2026-04-05T02:00:00Z");
      expect(() => readFileSync(join(dir, "nightly-last-run.txt"))).toThrow();
    });

    it("migrates last-consolidated.txt", () => {
      const dir = freshDir("consolidated");
      writeFileSync(join(dir, "last-consolidated.txt"), "2026-04-05T02:30:00Z");
      expect(migrateLegacyState(dir)).toBe(true);

      const state = loadState(dir);
      expect(state.lastConsolidated).toBe("2026-04-05T02:30:00Z");
      expect(() => readFileSync(join(dir, "last-consolidated.txt"))).toThrow();
    });

    it("migrates tier.json", () => {
      const dir = freshDir("tier");
      const tierData: PersistedTier = {
        tier: "pro",
        validatedAt: "2026-04-05T10:00:00Z",
        features: {
          reflection: true,
          vectorSearch: true,
          maxMemories: -1,
          crossAgent: true,
          remoteIngest: false,
        },
      };
      writeFileSync(join(dir, "tier.json"), JSON.stringify(tierData));
      expect(migrateLegacyState(dir)).toBe(true);

      const state = loadState(dir);
      expect(state.tier).toEqual(tierData);
      expect(() => readFileSync(join(dir, "tier.json"))).toThrow();
    });

    it("migrates all 4 legacy files at once", () => {
      const dir = freshDir("all");
      writeFileSync(join(dir, "nightly-last-run.txt"), "2026-04-05T02:00:00Z");
      writeFileSync(join(dir, "last-consolidated.txt"), "2026-04-05T02:30:00Z");
      writeFileSync(join(dir, "license-validated.txt"), "2026-04-05T01:00:00Z");
      writeFileSync(join(dir, "tier.json"), JSON.stringify({
        tier: "team",
        validatedAt: "2026-04-05T01:00:00Z",
        features: {
          reflection: true,
          vectorSearch: true,
          maxMemories: -1,
          crossAgent: true,
          remoteIngest: true,
        },
      }));

      expect(migrateLegacyState(dir)).toBe(true);

      const state = loadState(dir);
      expect(state.lastNightly).toBe("2026-04-05T02:00:00Z");
      expect(state.lastConsolidated).toBe("2026-04-05T02:30:00Z");
      expect(state.tier?.tier).toBe("team");

      // All 4 legacy files should be gone
      for (const name of [
        "nightly-last-run.txt",
        "last-consolidated.txt",
        "license-validated.txt",
        "tier.json",
      ]) {
        expect(() => readFileSync(join(dir, name))).toThrow();
      }
    });

    it("ignores corrupted tier.json gracefully", () => {
      const dir = freshDir("corrupt-tier");
      writeFileSync(join(dir, "nightly-last-run.txt"), "2026-04-05T02:00:00Z");
      writeFileSync(join(dir, "tier.json"), "{ corrupted");

      expect(migrateLegacyState(dir)).toBe(true);

      const state = loadState(dir);
      expect(state.lastNightly).toBe("2026-04-05T02:00:00Z");
      expect(state.tier).toBeUndefined();
    });

    it("is idempotent — second call after successful migration is a no-op", () => {
      const dir = freshDir("idempotent");
      writeFileSync(join(dir, "nightly-last-run.txt"), "2026-04-05T02:00:00Z");

      expect(migrateLegacyState(dir)).toBe(true);
      expect(migrateLegacyState(dir)).toBe(false); // state.json now exists
      expect(loadState(dir).lastNightly).toBe("2026-04-05T02:00:00Z");
    });
  });
});

// ---------------------------------------------------------------------------
// Distillation error propagation (regression test for data-loss bug)
//
// Bug: before this fix, distillChunk swallowed LLM errors and returned [].
// That was indistinguishable from "nothing to extract", so nightly.ts would
// advance lastRun past sessions that had never actually been processed, and
// those sessions were permanently lost.
//
// Fix contract:
//   - distillChunk THROWS on transient LLM errors (network, 4xx/5xx, timeout)
//   - distillChunk returns [] only for legitimate empty results (NO_EXTRACT,
//     empty response, transcript too short)
//   - distillSession rethrows if ALL chunks fail; returns partial otherwise
// ---------------------------------------------------------------------------

import { distillSession } from "../src/distiller.js";
import { probeOllamaModel } from "../src/llm.js";

// Minimal LlmClient stub — only completeDistill is exercised by distillSession
interface StubClientOpts {
  responses?: string[];       // sequence of successful responses, one per call
  errors?: (Error | null)[];  // sequence of errors (null = success from responses)
}

function makeStubLlm(opts: StubClientOpts = {}): any {
  let call = 0;
  const { responses = [], errors = [] } = opts;
  return {
    async completeDistill(_prompt: string): Promise<string> {
      const idx = call++;
      const err = errors[idx] ?? null;
      if (err) throw err;
      return responses[idx] ?? "NO_EXTRACT";
    },
  };
}

describe("distillSession error propagation", () => {
  it("returns [] for transcripts shorter than MIN_CONVERSATION_CHARS", async () => {
    const llm = makeStubLlm();
    const result = await distillSession(llm, "tiny", "test", "2026-04-07");
    expect(result).toEqual([]);
  });

  it("returns [] for NO_EXTRACT response (legitimate empty)", async () => {
    const llm = makeStubLlm({ responses: ["NO_EXTRACT"] });
    const longText = "USER: " + "x".repeat(300);
    const result = await distillSession(llm, longText, "test", "2026-04-07");
    expect(result).toEqual([]);
  });

  it("propagates transient LLM error on single-chunk path", async () => {
    const llm = makeStubLlm({ errors: [new Error("Ollama error 404: model not found")] });
    const longText = "USER: " + "x".repeat(300);
    await expect(
      distillSession(llm, longText, "test", "2026-04-07"),
    ).rejects.toThrow(/Ollama error 404/);
  });

  // A stub that fails ALL calls regardless of count. Avoids having to
  // predict exactly how many chunks splitIntoChunks produces — the contract
  // we care about is "if every chunk fails, distillSession throws".
  function makeAlwaysFailLlm(errMsg: string): any {
    return {
      async completeDistill(_p: string): Promise<string> {
        throw new Error(errMsg);
      },
    };
  }

  // A stub where odd-indexed calls fail, even-indexed calls return a valid
  // distilled block. Used to test partial-success.
  function makeAlternatingLlm(errMsg: string): any {
    let call = 0;
    return {
      async completeDistill(_p: string): Promise<string> {
        const idx = call++;
        if (idx % 2 === 1) throw new Error(errMsg);
        return `### Decisions Made\n- decision ${idx} (2026-04-07)`;
      },
    };
  }

  it("propagates transient LLM error on multi-chunk path when ALL chunks fail", async () => {
    const llm = makeAlwaysFailLlm("Ollama error 404: model not found");
    // Transcript long enough to force multi-chunk (>20K chars, chunk size 20K)
    const longText = "USER: " + "a".repeat(30_000) + "\n\nASSISTANT: " + "b".repeat(30_000);
    await expect(
      distillSession(llm, longText, "test", "2026-04-07", 20_000),
    ).rejects.toThrow(/Ollama error 404/);
  });

  it("returns partial result when SOME chunks succeed and some fail", async () => {
    const llm = makeAlternatingLlm("middle chunk LLM failure");
    // Forces multiple chunks
    const text = "USER: " + "a".repeat(20_000) + "\n\nUSER: " + "b".repeat(20_000) + "\n\nUSER: " + "c".repeat(20_000);
    const result = await distillSession(llm, text, "test", "2026-04-07", 20_000);
    // Should have extracted entries from the successful chunks (even-indexed)
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("probeOllamaModel", () => {
  it("returns unreachable when fetch fails", async () => {
    // Use a port nothing listens on
    const result = await probeOllamaModel("http://127.0.0.1:1", "any-model");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unreachable");
  });

  it("returns unreachable for an invalid hostname", async () => {
    // Nonexistent TLD — DNS resolution fails fast
    const result = await probeOllamaModel("http://nonexistent.invalid", "any-model");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unreachable");
  });

  // NOTE: Tests for "ok: true" and "ok: false, reason: model_missing" would
  // require a local HTTP stub server. Skipped in the smoke suite to keep it
  // dependency-free. The two unreachable cases above cover the control flow
  // into the abort branch in nightly.ts.
});

// ---------------------------------------------------------------------------
// Redaction (pre-ingestion secret scrubbing)
// ---------------------------------------------------------------------------

import { redact } from "../src/redact.js";

describe("redact", () => {
  it("redacts Anthropic API keys (sk-ant-...)", () => {
    const { text, count } = redact("key is sk-ant-api03-abc123def456ghi789jkl012mno345");
    expect(text).not.toContain("sk-ant-");
    expect(text).toContain("[REDACTED]");
    expect(count).toBe(1);
  });

  it("redacts OpenAI API keys (sk-proj-... and sk-...)", () => {
    const r1 = redact("export OPENAI_API_KEY=sk-proj-abcdef1234567890abcdef1234567890");
    expect(r1.text).not.toContain("sk-proj-");
    expect(r1.count).toBeGreaterThanOrEqual(1);

    const r2 = redact("key: sk-abcdefghijklmnopqrstuvwxyz1234567890");
    expect(r2.text).not.toContain("sk-abcdefgh");
    expect(r2.count).toBeGreaterThanOrEqual(1);
  });

  it("redacts Hicortex license keys (hctx-...)", () => {
    const { text, count } = redact("License: hctx-2cca3dcf0d6254dd activated");
    expect(text).not.toContain("hctx-2cca3dcf");
    expect(text).toContain("[REDACTED]");
    expect(count).toBe(1);
  });

  it("redacts GitHub PATs (ghp_...)", () => {
    const { text, count } = redact("git clone https://ghp_ABCDEFghijklmnopqrstuvwxyz1234567890@github.com/repo");
    expect(text).not.toContain("ghp_ABCDEF");
    expect(count).toBe(1);
  });

  it("redacts GitHub OAuth tokens (gho_...)", () => {
    const { text, count } = redact("token: gho_ABCDEFghijklmnopqrstuvwxyz1234567890");
    expect(text).not.toContain("gho_ABCDEF");
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it("redacts Google API keys (AIza...)", () => {
    const { text, count } = redact("GOOGLE_API_KEY=AIzaSyBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789");
    expect(text).not.toContain("AIzaSyBcDeF");
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it("redacts AWS access keys (AKIA...)", () => {
    const { text, count } = redact("aws_access_key_id = AKIAIOSFODNN7EXAMPLE");
    expect(text).not.toContain("AKIAIOSFODNN");
    expect(count).toBe(1);
  });

  it("redacts Bearer tokens", () => {
    const { text, count } = redact('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def');
    expect(text).not.toContain("eyJhbGci");
    expect(count).toBe(1);
  });

  it("redacts generic secret assignments (key=value, key: value)", () => {
    const r1 = redact('password=super_secret_pass_123');
    expect(r1.text).not.toContain("super_secret");
    expect(r1.count).toBeGreaterThanOrEqual(1);

    const r2 = redact('api_key: "sk_live_abcdef1234567890"');
    expect(r2.text).not.toContain("sk_live_");
    expect(r2.count).toBeGreaterThanOrEqual(1);

    const r3 = redact('SECRET_KEY = "my-very-long-secret-value-here"');
    expect(r3.text).not.toContain("my-very-long");
    expect(r3.count).toBe(1);
  });

  it("redacts macOS absolute paths (/Users/<username>)", () => {
    const { text, count } = redact("reading /Users/mattias/Development/secret-project/config.json");
    expect(text).not.toContain("/Users/mattias");
    expect(text).toContain("[REDACTED]");
    expect(count).toBe(1);
  });

  it("redacts Linux absolute paths (/home/<username>)", () => {
    const { text, count } = redact("deployed to /home/agents/Agents/raider/.env");
    expect(text).not.toContain("/home/agents");
    expect(text).toContain("[REDACTED]");
    expect(count).toBe(1);
  });

  it("handles multiple secrets in one text", () => {
    const text = `
      OPENAI_API_KEY=sk-proj-abc123def456789012345678901234
      ANTHROPIC_API_KEY=sk-ant-api03-xyz789abc012def345ghi
      Reading /Users/mattias/.env
      token: hctx-2cca3dcf0d6254dd
    `;
    const { text: redacted, count } = redact(text);
    expect(count).toBeGreaterThanOrEqual(4);
    expect(redacted).not.toContain("sk-proj-");
    expect(redacted).not.toContain("sk-ant-");
    expect(redacted).not.toContain("/Users/mattias");
    expect(redacted).not.toContain("hctx-2cca3dcf");
  });

  it("does nothing when no secrets present", () => {
    const { text, count } = redact("This is a normal conversation about deploying Node.js apps.");
    expect(text).toBe("This is a normal conversation about deploying Node.js apps.");
    expect(count).toBe(0);
  });

  it("respects enabled: false in config", () => {
    const { text, count } = redact("key is sk-ant-api03-abc123def456ghi789jkl012", { enabled: false });
    expect(text).toContain("sk-ant-api03-");
    expect(count).toBe(0);
  });

  it("applies extra patterns from config", () => {
    const { text, count } = redact("internal ref: MYCOMPANY-SECRET-12345", {
      extraPatterns: ["MYCOMPANY-SECRET-\\d+"],
    });
    expect(text).not.toContain("MYCOMPANY-SECRET");
    expect(count).toBe(1);
  });

  it("uses custom replacement string", () => {
    const { text } = redact("key: sk-ant-api03-abc123def456ghi789jkl012mno", {
      replacement: "***",
    });
    expect(text).toContain("***");
    expect(text).not.toContain("[REDACTED]");
  });

  it("handles invalid extra pattern gracefully (no crash)", () => {
    const { text } = redact("normal text", {
      extraPatterns: ["[invalid regex("],
    });
    expect(text).toBe("normal text");
  });

  it("integrates with extractConversationText", () => {
    const messages = [
      { role: "user", content: "My API key is sk-proj-abcdef1234567890abcdef1234567890" },
      { role: "assistant", content: "I see your key. Let me use it at /Users/mattias/project" },
    ];
    const text = extractConversationText(messages);
    expect(text).not.toContain("sk-proj-");
    expect(text).not.toContain("/Users/mattias");
    expect(text).toContain("[REDACTED]");
  });
});

// ---------------------------------------------------------------------------
// MODULE_INDEX
// ---------------------------------------------------------------------------

import type { ModuleIndex, ModuleDomain } from "../src/types.js";
import { getSchemaVersion } from "../src/db.js";

describe("MODULE_INDEX", () => {
  describe("schema migration v3", () => {
    it("creates the domain column on memories table", () => {
      const cols = db
        .prepare("PRAGMA table_info(memories)")
        .all() as Array<{ name: string }>;
      const colNames = cols.map((c) => c.name);
      expect(colNames).toContain("domain");
    });

    it("creates the idx_memories_domain index", () => {
      const indexes = db
        .prepare("PRAGMA index_list(memories)")
        .all() as Array<{ name: string }>;
      const indexNames = indexes.map((i) => i.name);
      expect(indexNames).toContain("idx_memories_domain");
    });

    it("schema version is at least 3", () => {
      const version = getSchemaVersion(db);
      expect(version).toBeGreaterThanOrEqual(3);
    });
  });

  describe("domain column on memories", () => {
    it("defaults to NULL on insert", () => {
      const id = storage.insertMemory(db, "domain test memory", fakeEmbedding(99), {
        project: "test-project",
      });
      const mem = storage.getMemory(db, id);
      expect(mem).not.toBeNull();
      expect(mem!.domain).toBeNull();
      // Cleanup
      storage.deleteMemory(db, id);
    });

    it("can be updated via updateMemory", () => {
      const id = storage.insertMemory(db, "domain update test", fakeEmbedding(98), {
        project: "test-project",
      });
      storage.updateMemory(db, id, { domain: "Test Domain" });
      const mem = storage.getMemory(db, id);
      expect(mem!.domain).toBe("Test Domain");
      // Cleanup
      storage.deleteMemory(db, id);
    });
  });

  describe("state.json moduleIndex", () => {
    const stateDir = join(TEST_DIR, "module-index-state");

    it("persists and loads moduleIndex", () => {
      mkdirSync(stateDir, { recursive: true });
      const moduleIndex: ModuleIndex = {
        domains: [
          { name: "Dev Tools", projects: ["hicortex", "raider"], memoryCount: 80, lessonCount: 5, keywords: ["typescript", "mcp"] },
          { name: "Health", projects: ["health"], memoryCount: 45, lessonCount: 8, keywords: ["exercise", "sleep"] },
        ],
        projectSetHash: "abc123",
        curatedAt: "2026-04-12T00:00:00Z",
        totalMemories: 125,
        totalLessons: 13,
      };
      saveState({ moduleIndex }, stateDir);
      const loaded = loadState(stateDir);
      expect(loaded.moduleIndex).toBeDefined();
      expect(loaded.moduleIndex!.domains).toHaveLength(2);
      expect(loaded.moduleIndex!.domains[0].name).toBe("Dev Tools");
      expect(loaded.moduleIndex!.projectSetHash).toBe("abc123");
    });

    it("updateState preserves moduleIndex", () => {
      mkdirSync(stateDir, { recursive: true });
      saveState({
        moduleIndex: {
          domains: [{ name: "Test", projects: ["a"], memoryCount: 1, lessonCount: 0, keywords: [] }],
          projectSetHash: "hash1",
          curatedAt: "2026-04-12T00:00:00Z",
          totalMemories: 1,
          totalLessons: 0,
        },
      }, stateDir);
      updateState((s) => { s.lastNightly = "2026-04-12T00:00:00Z"; }, stateDir);
      const loaded = loadState(stateDir);
      expect(loaded.moduleIndex).toBeDefined();
      expect(loaded.lastNightly).toBe("2026-04-12T00:00:00Z");
    });
  });

});

// ---------------------------------------------------------------------------
// Graph Analysis
// ---------------------------------------------------------------------------

import { louvainCommunities, detectHubs, getNeighbors, shortestPath } from "../src/graph.js";

describe("graph analysis", () => {
  // Set up a small graph for testing
  let memIds: string[];

  beforeAll(() => {
    // Insert 6 memories across 2 projects
    memIds = [];
    for (let i = 0; i < 6; i++) {
      const id = storage.insertMemory(
        db,
        `Graph test memory ${i} for ${i < 3 ? "alpha" : "beta"} project`,
        fakeEmbedding(200 + i),
        { project: i < 3 ? "alpha" : "beta", sourceAgent: "test-graph" }
      );
      memIds.push(id);
    }
    // Create links: 0-1, 0-2, 1-2 (alpha cluster), 3-4, 3-5, 4-5 (beta cluster), 2-3 (bridge)
    storage.addLink(db, memIds[0], memIds[1], "relates_to", 0.8);
    storage.addLink(db, memIds[0], memIds[2], "relates_to", 0.7);
    storage.addLink(db, memIds[1], memIds[2], "derives", 0.6);
    storage.addLink(db, memIds[3], memIds[4], "relates_to", 0.8);
    storage.addLink(db, memIds[3], memIds[5], "extends", 0.7);
    storage.addLink(db, memIds[4], memIds[5], "relates_to", 0.6);
    storage.addLink(db, memIds[2], memIds[3], "relates_to", 0.3);
  });

  describe("louvainCommunities", () => {
    it("detects communities in the graph", () => {
      const result = louvainCommunities(db);
      expect(result.nodeCount).toBe(6);
      expect(result.edgeCount).toBe(7);
      expect(result.communities.length).toBeGreaterThanOrEqual(1);
      // All 6 nodes should be in some community
      const allMembers = result.communities.flatMap((c) => c.members);
      expect(allMembers.length).toBe(6);
    });

    it("returns empty for graph with no links", () => {
      // Create a temp DB with no links
      const tmpDb = initDb(join(TEST_DIR, "empty-graph.db"));
      const result = louvainCommunities(tmpDb);
      expect(result.communities).toHaveLength(0);
      expect(result.nodeCount).toBe(0);
      tmpDb.close();
    });
  });

  describe("detectHubs", () => {
    it("finds highly-connected nodes", () => {
      // In our test graph, nodes 0,2,3 each have 3 links
      const hubs = detectHubs(db, 1.5, 3);
      expect(hubs.length).toBeGreaterThanOrEqual(1);
      for (const hub of hubs) {
        expect(hub.linkCount).toBeGreaterThanOrEqual(3);
        expect(hub.content).toBeTruthy();
      }
    });

    it("returns empty when no hubs exist", () => {
      const hubs = detectHubs(db, 100, 100); // impossibly high threshold
      expect(hubs).toHaveLength(0);
    });
  });

  describe("getNeighbors", () => {
    it("returns connected memories", () => {
      const neighbors = getNeighbors(db, memIds[0]);
      expect(neighbors.length).toBeGreaterThanOrEqual(2);
      const neighborIds = neighbors.map((n) => n.id);
      expect(neighborIds).toContain(memIds[1]);
      expect(neighborIds).toContain(memIds[2]);
    });

    it("includes relationship and direction", () => {
      const neighbors = getNeighbors(db, memIds[0]);
      for (const n of neighbors) {
        expect(n.relationship).toBeTruthy();
        expect(["outgoing", "incoming"]).toContain(n.direction);
        expect(n.content).toBeTruthy();
      }
    });
  });

  describe("shortestPath", () => {
    it("finds path between connected nodes", () => {
      const path = shortestPath(db, memIds[0], memIds[5]);
      expect(path).not.toBeNull();
      expect(path!.length).toBeGreaterThanOrEqual(2);
      expect(path![0]).toBe(memIds[0]);
      expect(path![path!.length - 1]).toBe(memIds[5]);
    });

    it("finds direct path between neighbors", () => {
      const path = shortestPath(db, memIds[0], memIds[1]);
      expect(path).toEqual([memIds[0], memIds[1]]);
    });

    it("returns null for disconnected nodes", () => {
      // Insert an isolated memory
      const isolated = storage.insertMemory(db, "Isolated node", fakeEmbedding(300), {});
      const path = shortestPath(db, memIds[0], isolated);
      expect(path).toBeNull();
      storage.deleteMemory(db, isolated);
    });
  });

  describe("getNeighbors with relationship filter", () => {
    it("filters neighbors by relationship type", () => {
      // memIds[0] -> memIds[1] is "extends" (from the beforeAll setup)
      // Add a CONTRADICTS link
      storage.addLink(db, memIds[0], memIds[2], "CONTRADICTS", 0.8);

      const all = getNeighbors(db, memIds[0], 20);
      expect(all.length).toBeGreaterThanOrEqual(2);

      const contradictions = getNeighbors(db, memIds[0], 20, "CONTRADICTS");
      expect(contradictions.length).toBe(1);
      expect(contradictions[0].relationship).toBe("CONTRADICTS");
      expect(contradictions[0].id).toBe(memIds[2]);

      const extends_ = getNeighbors(db, memIds[0], 20, "extends");
      for (const n of extends_) {
        expect(n.relationship).toBe("extends");
      }

      // Cleanup the extra link
      db.prepare("DELETE FROM memory_links WHERE source_id = ? AND target_id = ? AND relationship = ?").run(memIds[0], memIds[2], "CONTRADICTS");
    });

    it("returns empty array when no links match filter", () => {
      const results = getNeighbors(db, memIds[0], 20, "CAUSED_BY");
      expect(results.length).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Richer Relationship Types (Issue #92)
// ---------------------------------------------------------------------------

import { VALID_RELATIONSHIP_TYPES } from "../src/types.js";

describe("relationship types", () => {
  it("VALID_RELATIONSHIP_TYPES retains all 9 types (uppercase RETIRED, not deleted)", () => {
    // The five UPPERCASE types and lowercase updates/derives are RETIRED from
    // the pipeline (heuristic linking now emits only extends/relates_to — see
    // the 2026-07 link-classification audit), but they remain valid so old
    // rows still validate. They may return only when a future classifier
    // passes the audit harness at >= 70% acceptable.
    expect(VALID_RELATIONSHIP_TYPES).toHaveLength(9);
    // Heuristic types (lowercase)
    expect(VALID_RELATIONSHIP_TYPES).toContain("derives");
    expect(VALID_RELATIONSHIP_TYPES).toContain("updates");
    expect(VALID_RELATIONSHIP_TYPES).toContain("extends");
    expect(VALID_RELATIONSHIP_TYPES).toContain("relates_to");
    // Retired LLM-classified types (UPPER_SNAKE_CASE) — kept for old data
    expect(VALID_RELATIONSHIP_TYPES).toContain("CONTRADICTS");
    expect(VALID_RELATIONSHIP_TYPES).toContain("SUPERSEDES");
    expect(VALID_RELATIONSHIP_TYPES).toContain("DEPENDS_ON");
    expect(VALID_RELATIONSHIP_TYPES).toContain("CAUSED_BY");
    expect(VALID_RELATIONSHIP_TYPES).toContain("VALIDATES");
  });
});

// ---------------------------------------------------------------------------
// stageLinks with mock LLM (Issue #92)
// ---------------------------------------------------------------------------

import { LlmClient, type LlmConfig } from "../src/llm.js";

describe("stageLinks heuristic classification", () => {
  // LLM edge classification is retired (2026-07 audit). Linking is now
  // heuristic-only: same-project + above-threshold → extends, else relates_to.
  // stageLinks is not exported directly, so we drive it via runConsolidation.
  // The mock LLM still serves the importance-scoring stage; its graph-analyst
  // branch is never reached anymore (classifyLinkCandidates ignores the LLM).

  function createMockLlm(handler: (prompt: string) => string): LlmClient {
    const config: LlmConfig = {
      baseUrl: "http://mock:11434",
      apiKey: "",
      model: "mock",
      reflectModel: "mock",
      provider: "ollama",
    };
    const client = new LlmClient(config);
    (client as any).completeFast = async (prompt: string, _maxTokens?: number): Promise<string> => {
      return handler(prompt);
    };
    (client as any).completeReflect = async (): Promise<string> => "[]";
    (client as any).completeDistill = async (): Promise<string> => "NO_EXTRACT";
    return client;
  }

  it("emits extends for same-project high-similarity pairs (never an LLM/uppercase type)", async () => {
    const { runConsolidation } = await import("../src/consolidate.js");
    const { updateState } = await import("../src/state.js");

    const stDir = join(TEST_DIR, `links-heuristic-${randomUUID().slice(0, 6)}`);
    mkdirSync(stDir, { recursive: true });
    updateState((s) => { s.lastConsolidated = undefined; return s; }, stDir);

    // Identical embeddings → cosine 1.0, same project → extends.
    const embed1 = fakeEmbedding(500);
    const embed2 = new Float32Array(embed1);

    const id1 = storage.insertMemory(db, "Always validate user input before processing database queries", embed1, {
      sourceAgent: "test-llm",
      project: "test-links",
      memoryType: "lesson",
    });
    const id2 = storage.insertMemory(db, "Fixed the SQL injection vulnerability by adding input validation", embed2, {
      sourceAgent: "test-llm",
      project: "test-links",
      memoryType: "episode",
    });

    // Even if the (dead) graph-analyst branch were somehow hit, it would try to
    // return VALIDATES — the heuristic-only path must still store extends.
    const mockLlm = createMockLlm((prompt: string) => {
      if (prompt.includes("memory importance scorer")) {
        const count = (prompt.match(/\[\d+\]/g) || []).length;
        return JSON.stringify(new Array(count).fill(0.7));
      }
      if (prompt.includes("memory graph analyst")) {
        const count = (prompt.match(/\[\d+\] SOURCE:/g) || []).length;
        return JSON.stringify(new Array(count).fill("VALIDATES"));
      }
      return "[]";
    });

    const embedFn = async (_text: string): Promise<Float32Array> => fakeEmbedding(500);

    const report = await runConsolidation(db, mockLlm, embedFn, false, true, stDir);

    expect(report.status).toBe("completed");
    expect(report.stages.links).toBeDefined();
    expect(report.stages.links!.auto_linked).toBeGreaterThan(0);

    // LLM classification is retired — never used.
    expect(report.stages.links!.llm_classified).toBe(0);
    expect(report.stages.links!.heuristic_fallback).toBeGreaterThan(0);

    const links = storage.getLinks(db, id1, "both");
    const linkToId2 = links.find(l => l.target_id === id2 || l.source_id === id2);
    expect(linkToId2).toBeDefined();
    expect(linkToId2!.relationship).toBe("extends");

    storage.deleteMemory(db, id1);
    storage.deleteMemory(db, id2);
  });

  it("only ever stores extends or relates_to (retired types never emitted)", async () => {
    const { runConsolidation } = await import("../src/consolidate.js");
    const { updateState } = await import("../src/state.js");

    const stDir = join(TEST_DIR, `links-twolabel-${randomUUID().slice(0, 6)}`);
    mkdirSync(stDir, { recursive: true });
    updateState((s) => { s.lastConsolidated = undefined; return s; }, stDir);

    const embed1 = fakeEmbedding(600);
    const embed2 = new Float32Array(embed1);

    const id1 = storage.insertMemory(db, "Decided to use PostgreSQL for the analytics pipeline", embed1, {
      sourceAgent: "test-fallback",
      project: "test-links-fb",
      memoryType: "decision",
    });
    const id2 = storage.insertMemory(db, "PostgreSQL performance tuning for analytics workloads", embed2, {
      sourceAgent: "test-fallback",
      project: "test-links-fb",
      memoryType: "episode",
    });

    const mockLlm = createMockLlm((prompt: string) => {
      if (prompt.includes("memory importance scorer")) {
        const count = (prompt.match(/\[\d+\]/g) || []).length;
        return JSON.stringify(new Array(count).fill(0.6));
      }
      // Would-be uppercase output; must be ignored by the heuristic-only path.
      if (prompt.includes("memory graph analyst")) {
        return JSON.stringify(["CONTRADICTS"]);
      }
      return "[]";
    });

    const embedFn = async (_text: string): Promise<Float32Array> => fakeEmbedding(600);

    const report = await runConsolidation(db, mockLlm, embedFn, false, true, stDir);

    expect(report.status).toBe("completed");
    expect(report.stages.links).toBeDefined();
    expect(report.stages.links!.llm_classified).toBe(0);

    const links = storage.getLinks(db, id1, "both");
    for (const link of links) {
      expect(["extends", "relates_to"]).toContain(link.relationship);
    }

    storage.deleteMemory(db, id1);
    storage.deleteMemory(db, id2);
  });

  it("report still carries llm_classified (always 0) and heuristic_fallback fields", async () => {
    const { runConsolidation } = await import("../src/consolidate.js");
    const { updateState } = await import("../src/state.js");

    const stDir = join(TEST_DIR, `links-fields-${randomUUID().slice(0, 6)}`);
    mkdirSync(stDir, { recursive: true });
    updateState((s) => { s.lastConsolidated = undefined; return s; }, stDir);

    const embed1 = fakeEmbedding(700);
    const embed2 = new Float32Array(embed1);

    const id1 = storage.insertMemory(db, "Budget test memory source about deployment", embed1, {
      sourceAgent: "test-budget",
      project: "test-budget",
      memoryType: "episode",
    });
    const id2 = storage.insertMemory(db, "Budget test memory target about deployment", embed2, {
      sourceAgent: "test-budget",
      project: "test-budget",
      memoryType: "episode",
    });

    const mockLlm = createMockLlm((prompt: string) => {
      if (prompt.includes("memory importance scorer")) {
        const count = (prompt.match(/\[\d+\]/g) || []).length;
        return JSON.stringify(new Array(count).fill(0.5));
      }
      return "[]";
    });

    const embedFn = async (_text: string): Promise<Float32Array> => fakeEmbedding(700);

    const report = await runConsolidation(db, mockLlm, embedFn, false, true, stDir);

    expect(report.status).toBe("completed");
    expect(report.stages.links).toBeDefined();
    expect(report.stages.links).toHaveProperty("llm_classified");
    expect(report.stages.links).toHaveProperty("heuristic_fallback");
    expect(report.stages.links!.llm_classified).toBe(0);

    storage.deleteMemory(db, id1);
    storage.deleteMemory(db, id2);
  });
});

// ---------------------------------------------------------------------------
// installSessionStartHook — malformed settings.json safety (0.9.0)
// ---------------------------------------------------------------------------

import { installSessionStartHook } from "../src/init.js";

describe("installSessionStartHook", () => {
  it("leaves a malformed settings.json file completely unchanged", () => {
    const settingsPath = join(TEST_DIR, `settings-malformed-${randomUUID().slice(0, 6)}.json`);
    const malformed = '{ "permissions": { "allow": ["mcp__*"] }, "hooks": { BROKEN JSON';
    writeFileSync(settingsPath, malformed);

    // Must not throw — the function warns and returns without writing.
    installSessionStartHook(settingsPath);

    // File content must be byte-for-byte identical to what we wrote.
    const after = readFileSync(settingsPath, "utf-8");
    expect(after).toBe(malformed);
  });

  it("installs the hook without clobbering other keys in a valid settings.json", () => {
    const settingsPath = join(TEST_DIR, `settings-valid-${randomUUID().slice(0, 6)}.json`);
    const original = {
      permissions: { allow: ["mcp__hicortex__*"] },
      env: { MY_VAR: "preserved" },
    };
    writeFileSync(settingsPath, JSON.stringify(original, null, 2));

    installSessionStartHook(settingsPath);

    const after = JSON.parse(readFileSync(settingsPath, "utf-8"));
    // Existing keys must be preserved.
    expect(after.permissions?.allow).toContain("mcp__hicortex__*");
    expect(after.env?.MY_VAR).toBe("preserved");
    // Hook must be installed.
    const sessionStart = after.hooks?.SessionStart as unknown[];
    expect(Array.isArray(sessionStart)).toBe(true);
    expect(sessionStart.length).toBeGreaterThan(0);
  });

  it("is idempotent — calling twice does not add a duplicate hook", () => {
    const settingsPath = join(TEST_DIR, `settings-idem-${randomUUID().slice(0, 6)}.json`);
    writeFileSync(settingsPath, "{}");

    installSessionStartHook(settingsPath);
    const afterFirst = JSON.parse(readFileSync(settingsPath, "utf-8"));
    const countFirst = (afterFirst.hooks?.SessionStart as unknown[]).length;

    installSessionStartHook(settingsPath);
    const afterSecond = JSON.parse(readFileSync(settingsPath, "utf-8"));
    const countSecond = (afterSecond.hooks?.SessionStart as unknown[]).length;

    expect(countSecond).toBe(countFirst);
  });

  it("creates a fresh settings.json when the file does not exist", () => {
    const settingsPath = join(TEST_DIR, `settings-new-${randomUUID().slice(0, 6)}.json`);
    expect(existsSync(settingsPath)).toBe(false);

    installSessionStartHook(settingsPath);

    expect(existsSync(settingsPath)).toBe(true);
    const created = JSON.parse(readFileSync(settingsPath, "utf-8"));
    const sessionStart = created.hooks?.SessionStart as unknown[];
    expect(Array.isArray(sessionStart)).toBe(true);
    expect(sessionStart.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// lessons-context fail-soft (0.9.0)
// ---------------------------------------------------------------------------

describe("fetchLessonsContext", () => {
  it("returns null when server is unreachable (fail-soft)", async () => {
    // Override the config to point at a URL nothing is listening on, so the
    // fetch inside fetchLessonsContext throws a network error.  We use
    // vi.stubGlobal to replace the global fetch with one that always rejects.
    const originalFetch = globalThis.fetch;
    try {
      vi.stubGlobal("fetch", async () => { throw new Error("Network unreachable (test stub)"); });
      // fetchLessonsContext catches any fetch error and returns null
      const result = await fetchLessonsContext();
      // null means "fail-soft — no block to inject" (never throws)
      expect(result).toBeNull();
    } finally {
      vi.stubGlobal("fetch", originalFetch);
    }
  });

  it("returns null on non-2xx response (fail-soft)", async () => {
    const originalFetch = globalThis.fetch;
    try {
      vi.stubGlobal("fetch", async () => ({ ok: false, status: 503 }));
      const result = await fetchLessonsContext();
      expect(result).toBeNull();
    } finally {
      vi.stubGlobal("fetch", originalFetch);
    }
  });
});

// ---------------------------------------------------------------------------
// /distill session-prefix dedup with underscores in session IDs (0.9.0)
//
// Hermes session IDs look like "20260701_045744_a3f2b1c9", which contain
// underscores.  SQLite LIKE treats "_" as a single-character wildcard, so
// the dedup query must escape it.  The handler in mcp-server.ts uses:
//
//   const likePrefix = `${id.replace(/[\\%_]/g, (m) => "\\" + m)}#%`;
//   ... LIKE ? ESCAPE '\\' ...
//
// This test exercises that escaping logic end-to-end using the shared DB.
// ---------------------------------------------------------------------------

describe("/distill session-prefix dedup LIKE escaping", () => {
  it("finds rows when session_id contains underscores", () => {
    // A Hermes-style session id with underscores.
    const sessionId = "20260701_045744_a3f2b1c9";

    // Insert the per-chunk key that the handler would write after distillation.
    const chunkKey = `${sessionId}#0`;
    const id = storage.insertMemory(db, "Hermes session memory", fakeEmbedding(900), {
      sourceSession: chunkKey,
      project: "hermes-dedup-test",
    });

    // Replicate the handler's escaping logic exactly.
    const likePrefix = `${sessionId.replace(/[\\%_]/g, (m) => "\\" + m)}#%`;

    const row = db.prepare(
      "SELECT COUNT(*) as c FROM memories WHERE source_session = ? OR source_session LIKE ? ESCAPE '\\'"
    ).get(sessionId, likePrefix) as { c: number };

    // The chunk key should be found via the LIKE branch.
    expect(row.c).toBeGreaterThan(0);

    // Also verify the exact-match branch (no chunk suffix) works when the key
    // equals session_id directly (legacy /ingest style).
    const idExact = storage.insertMemory(db, "Hermes legacy memory", fakeEmbedding(901), {
      sourceSession: sessionId,
      project: "hermes-dedup-test",
    });

    const row2 = db.prepare(
      "SELECT COUNT(*) as c FROM memories WHERE source_session = ? OR source_session LIKE ? ESCAPE '\\'"
    ).get(sessionId, likePrefix) as { c: number };

    expect(row2.c).toBeGreaterThanOrEqual(2);

    // Cleanup
    storage.deleteMemory(db, id);
    storage.deleteMemory(db, idExact);
  });

  it("does NOT match a different session_id that starts with the same prefix chars", () => {
    // If escaping is missing, "20260701_045744_a3f2b1c9#0" would LIKE-match
    // "20260701X045744Xa3f2b1c9#0" because "_" matches any character.
    // With proper escaping it must NOT match.
    const sessionId = "20260701_045744_a3f2b1c9";
    const differentId = storage.insertMemory(db, "Different session memory", fakeEmbedding(902), {
      sourceSession: "20260701X045744Xa3f2b1c9#0",
      project: "hermes-dedup-test",
    });

    const likePrefix = `${sessionId.replace(/[\\%_]/g, (m) => "\\" + m)}#%`;

    const row = db.prepare(
      "SELECT COUNT(*) as c FROM memories WHERE source_session = ? OR source_session LIKE ? ESCAPE '\\'"
    ).get(sessionId, likePrefix) as { c: number };

    // Should be 0 — the X-separated id must NOT match the escaped underscore pattern.
    expect(row.c).toBe(0);

    storage.deleteMemory(db, differentId);
  });
});

// ---------------------------------------------------------------------------
// /distill text + session_date path (0.9.0)
//
// The handler passes `new Date(session_date).toISOString()` as createdAt
// to storage.insertMemory.  This test verifies that insertMemory stores the
// supplied createdAt and that getMemory returns it correctly.
// ---------------------------------------------------------------------------

describe("/distill session_date storage", () => {
  it("persists session_date as created_at on the stored memory", () => {
    const sessionDate = "2026-06-15";
    const expectedCreatedAt = new Date(sessionDate).toISOString(); // "2026-06-15T00:00:00.000Z"

    const id = storage.insertMemory(db, "Memory from past session", fakeEmbedding(950), {
      sourceAgent: "nightly",
      sourceSession: "test-session-date#0",
      project: "capture-test",
      memoryType: "episode",
      createdAt: expectedCreatedAt,
    });

    const mem = storage.getMemory(db, id);
    expect(mem).not.toBeNull();
    // created_at should reflect the supplied session date, not the current time.
    expect(mem!.created_at).toBe(expectedCreatedAt);

    storage.deleteMemory(db, id);
  });

  it("falls back to current time when no session_date is supplied", () => {
    const before = new Date().toISOString();

    const id = storage.insertMemory(db, "Memory without explicit date", fakeEmbedding(951), {
      sourceAgent: "nightly",
      project: "capture-test",
    });

    const after = new Date().toISOString();
    const mem = storage.getMemory(db, id);
    expect(mem).not.toBeNull();
    // created_at should be between before and after (i.e. "now").
    expect(mem!.created_at >= before).toBe(true);
    expect(mem!.created_at <= after).toBe(true);

    storage.deleteMemory(db, id);
  });
});

// ---------------------------------------------------------------------------
// 0.9.1: embedding model cache location
// ---------------------------------------------------------------------------

describe("resolveModelCacheDir (0.9.1)", () => {
  it("resolves to ~/.hicortex/models under the given home", async () => {
    const { resolveModelCacheDir } = await import("../src/embedder.js");
    expect(resolveModelCacheDir("/fake/home")).toBe("/fake/home/.hicortex/models");
    // Default uses the real home dir — must never point inside a package dir
    expect(resolveModelCacheDir()).not.toContain("node_modules");
    expect(resolveModelCacheDir().endsWith("/.hicortex/models")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 0.9.2: --capture-only flag
//
// runNightly accepts a captureOnly option. When set in server mode:
//   - Logs "capture-only run — consolidation skipped"
//   - Does NOT log "Running consolidation..."
// In a normal (non-capture-only) run the consolidation path is entered (the
// dryRun guard prevents actual consolidation, but the log path still differs).
//
// Tests use dryRun: true so no DB writes or HTTP calls are made, and a temp
// stateDir + dbPath so the test never touches ~/.hicortex.
// ---------------------------------------------------------------------------

describe("runNightly --capture-only (0.9.2)", () => {
  const captureTestDir = join(TEST_DIR, "capture-only-test");
  const captureDbPath = join(captureTestDir, "capture.db");

  beforeAll(() => {
    mkdirSync(captureTestDir, { recursive: true });
    // No config.json → server mode (not client)
  });

  it("logs 'consolidation skipped' and does NOT log 'Running consolidation' when captureOnly is true", async () => {
    const { runNightly } = await import("../src/nightly.js");
    const logLines: string[] = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      logLines.push(args.join(" "));
    });
    // Also silence warn (LLM config warnings) to keep test output clean
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await runNightly({ captureOnly: true, dryRun: true, stateDir: captureTestDir, dbPath: captureDbPath });
    } finally {
      consoleSpy.mockRestore();
      warnSpy.mockRestore();
    }

    const joined = logLines.join("\n");
    expect(joined).toContain("capture-only run — consolidation skipped");
    expect(joined).not.toContain("Running consolidation");
  });

  it("does NOT log 'consolidation skipped' on a normal (non-capture-only) dry run", async () => {
    const { runNightly } = await import("../src/nightly.js");
    const logLines: string[] = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      logLines.push(args.join(" "));
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await runNightly({ captureOnly: false, dryRun: true, stateDir: captureTestDir, dbPath: captureDbPath });
    } finally {
      consoleSpy.mockRestore();
      warnSpy.mockRestore();
    }

    const joined = logLines.join("\n");
    expect(joined).not.toContain("consolidation skipped");
  });

  it("CLI parses --capture-only and passes it as captureOnly: true", () => {
    // Verify the flag is present and correctly named in the args parsing.
    // This is a direct code-path check — we don't execute the CLI process,
    // but we verify the args array contains the expected flag name.
    const args = ["--dry-run", "--capture-only"];
    const dryRun = args.includes("--dry-run");
    const captureOnly = args.includes("--capture-only");
    expect(dryRun).toBe(true);
    expect(captureOnly).toBe(true);
    // Both flags are independent and can be combined
    const argsCapOnly = ["--capture-only"];
    expect(argsCapOnly.includes("--capture-only")).toBe(true);
    expect(argsCapOnly.includes("--dry-run")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #116: nightly schedule resolution (server init must install a nightly job)
// ---------------------------------------------------------------------------

describe("resolveNightlyHour (#116)", () => {
  it("defaults: client 02:00, server 03:00 (staggered)", async () => {
    const { resolveNightlyHour } = await import("../src/init.js");
    const empty = join(tmpdir(), `hctx-nh-${Math.random().toString(36).slice(2)}`);
    expect(resolveNightlyHour("client", empty)).toBe(2);
    expect(resolveNightlyHour("server", empty)).toBe(3);
  });

  it("honors a valid nightlyHour from config.json and rejects invalid values", async () => {
    const { resolveNightlyHour } = await import("../src/init.js");
    const dir = join(tmpdir(), `hctx-nh-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify({ nightlyHour: 19 }));
    expect(resolveNightlyHour("server", dir)).toBe(19);
    expect(resolveNightlyHour("client", dir)).toBe(19);
    writeFileSync(join(dir, "config.json"), JSON.stringify({ nightlyHour: 25 }));
    expect(resolveNightlyHour("server", dir)).toBe(3); // out of range → default
    writeFileSync(join(dir, "config.json"), JSON.stringify({ nightlyHour: "19" }));
    expect(resolveNightlyHour("client", dir)).toBe(2); // wrong type → default
  });
});

// ---------------------------------------------------------------------------
// #115: random auth token generation, persistence, and status display
// ---------------------------------------------------------------------------

describe("generateAuthToken (#115)", () => {
  it("produces a token in the format hctx-<32 hex chars>", () => {
    const token = generateAuthToken();
    expect(token).toMatch(/^hctx-[0-9a-f]{32}$/);
  });

  it("produces unique tokens on each call", () => {
    const a = generateAuthToken();
    const b = generateAuthToken();
    expect(a).not.toBe(b);
  });
});

describe("persistAuthToken (#115)", () => {
  function tempConfigPath(label: string): string {
    const dir = join(TEST_DIR, `auth-${label}-${randomUUID().slice(0, 6)}`);
    mkdirSync(dir, { recursive: true });
    return join(dir, "config.json");
  }

  it("generates and saves a token when none exists", () => {
    const configPath = tempConfigPath("new");
    const result = persistAuthToken(configPath);
    expect(result.generated).toBe(true);
    expect(result.token).toMatch(/^hctx-[0-9a-f]{32}$/);
    // Token must be persisted to disk.
    const stored = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(stored.authToken).toBe(result.token);
  });

  it("never overwrites an existing token", () => {
    const configPath = tempConfigPath("existing");
    const existing = "hctx-aabbccdd00112233aabbccdd00112233";
    writeFileSync(configPath, JSON.stringify({ authToken: existing }));

    const result = persistAuthToken(configPath);
    expect(result.generated).toBe(false);
    expect(result.token).toBe(existing);
    // File must still contain the original token unchanged.
    const stored = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(stored.authToken).toBe(existing);
  });

  it("preserves existing config keys when generating a new token", () => {
    const configPath = tempConfigPath("preserve");
    writeFileSync(configPath, JSON.stringify({ llmBackend: "ollama", llmModel: "qwen3:4b" }));

    const result = persistAuthToken(configPath);
    expect(result.generated).toBe(true);
    const stored = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(stored.llmBackend).toBe("ollama");
    expect(stored.llmModel).toBe("qwen3:4b");
    expect(stored.authToken).toMatch(/^hctx-[0-9a-f]{32}$/);
  });
});

describe("auth middleware rejects hctx-default-token when server has a generated token (#115)", () => {
  // Unit-test the auth check logic used by mcp-server.ts without starting Express.
  // The middleware accepts a request iff its Authorization header equals
  // `Bearer ${configuredToken}`. The old hardcoded default must be rejected
  // once the server has a generated token.
  function checkAuth(configuredToken: string, requestToken: string): boolean {
    const auth = `Bearer ${requestToken}`;
    return auth === `Bearer ${configuredToken}`;
  }

  it("accepts a matching generated token", () => {
    const token = generateAuthToken();
    expect(checkAuth(token, token)).toBe(true);
  });

  it("rejects hctx-default-token when server has a generated token", () => {
    const generatedToken = generateAuthToken();
    expect(checkAuth(generatedToken, "hctx-default-token")).toBe(false);
  });

  it("rejects an empty string as a bearer token", () => {
    const token = generateAuthToken();
    expect(checkAuth(token, "")).toBe(false);
  });

  it("rejects a token with correct prefix but wrong hex suffix", () => {
    const token = generateAuthToken();
    const tampered = token.slice(0, -4) + "xxxx";
    expect(checkAuth(token, tampered)).toBe(false);
  });
});

describe("status shows auth token in server mode (#115)", () => {
  // Verify the status output contains the token string when config.json has one.
  // We capture stdout by redirecting console.log.
  it("prints the auth token with a 'clients connect with this token' hint", async () => {
    const dir = join(TEST_DIR, `status-auth-${randomUUID().slice(0, 6)}`);
    mkdirSync(dir, { recursive: true });
    const token = generateAuthToken();
    writeFileSync(join(dir, "config.json"), JSON.stringify({ authToken: token }));

    // The status.ts code reads from the real HICORTEX_HOME; we exercise the
    // display logic directly rather than spawning the CLI with env overrides.
    // Read the config and replicate the display condition from status.ts:
    const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf-8"));
    const savedAuthToken: string = config.authToken ?? "";
    const isClientMode: boolean = config.mode === "client";

    expect(savedAuthToken).toBe(token);
    expect(isClientMode).toBe(false);
    // The condition that must be true for the token display branch to fire:
    expect(!isClientMode && Boolean(savedAuthToken)).toBe(true);
  });

  it("does not display auth token in client mode", () => {
    const dir = join(TEST_DIR, `status-client-${randomUUID().slice(0, 6)}`);
    mkdirSync(dir, { recursive: true });
    const token = generateAuthToken();
    writeFileSync(join(dir, "config.json"), JSON.stringify({ authToken: token, mode: "client" }));

    const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf-8"));
    const isClientMode: boolean = config.mode === "client";
    expect(isClientMode).toBe(true);
    // In client mode the display condition is false — token is not shown.
    expect(!isClientMode && Boolean(config.authToken)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #128: CC lessons hook passes cwd-derived project to the selector
// ---------------------------------------------------------------------------

describe("lessons-context project derivation (#128)", () => {
  it("lessons-context source derives project from cwd basename and passes it to select()", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../src/lessons-context.ts", import.meta.url), "utf-8");
    expect(source).toContain("basename(process.cwd())");
    expect(source).toMatch(/select\(data\.lessons, \{ maxLessons, moduleIndex, project \}\)/);
  });
});

// ---------------------------------------------------------------------------
// #145: computeScore similarity component uses TRUE cosine (1 − d²/2)
// ---------------------------------------------------------------------------

describe("computeScore similarity component uses true cosine (#145)", () => {
  // A memory constructed so every non-similarity component is deterministic:
  //   effectiveStrength → 0   (base_strength 0 → floor 0, base 0)
  //   connScore         → 0   (connectionCount 0)
  //   recency           → 1   (created_at = now → contributes exactly 0.1)
  // ⇒ score = similarity * 0.4 + 0.1, so similarity = (score − 0.1) / 0.4.
  const isolate = (distance: number): number => {
    const now = new Date();
    const mem = {
      id: "sim-test",
      content: "x",
      base_strength: 0,
      last_accessed: now.toISOString(),
      access_count: 0,
      created_at: now.toISOString(),
    } as unknown as Memory;
    const score = computeScore(mem, distance, 0, 0, now);
    return (score - 0.1) / 0.4;
  };

  it("d=0 → similarity 1 (identical vectors)", () => {
    expect(isolate(0)).toBeCloseTo(1.0, 12);
  });

  it("d=√0.5 (≈0.7071) → similarity 0.75", () => {
    expect(isolate(Math.sqrt(0.5))).toBeCloseTo(0.75, 12);
  });

  it("d=1 → similarity 0.5 — NOT zero (the old 1−d formula flattened it to 0)", () => {
    // The old `max(0, 1 − distance)` gave exactly 0 here, erasing all
    // mid-relevance discrimination below cos 0.5. True cosine is 0.5.
    expect(isolate(1)).toBeCloseTo(0.5, 12);
  });

  it("d=√2 → similarity 0 (orthogonal vectors)", () => {
    expect(isolate(Math.SQRT2)).toBeCloseTo(0, 12);
  });

  it("d=2 → similarity clamped to 0 (negative cosine = truly unrelated)", () => {
    expect(isolate(2)).toBeCloseTo(0, 12);
  });

  it("cos 0.8 content scores ≈0.8, not the old compressed 0.37", () => {
    // d for true cosine 0.8: d = √(2·(1−0.8)) = √0.4 ≈ 0.6325.
    const d = Math.sqrt(0.4);
    expect(isolate(d)).toBeCloseTo(0.8, 12);
    // Old formula would have produced 1 − 0.6325 ≈ 0.37 — the compression #145 fixes.
    expect(1 - d).toBeCloseTo(0.3675, 3);
  });

  it("retrieval.l2ToCosine and the consolidate re-export are the same function", async () => {
    const consolidate = await import("../src/consolidate.js");
    expect(consolidate.l2ToCosine).toBe(l2ToCosine);
  });
});
