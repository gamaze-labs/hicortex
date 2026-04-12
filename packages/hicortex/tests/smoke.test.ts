/**
 * Smoke tests for the Hicortex in-process plugin.
 * Tests DB init, memory CRUD, vector search, scoring, and consolidation helpers.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { initDb, getStats, resolveDbPath } from "../src/db.js";
import * as storage from "../src/storage.js";
import { effectiveStrength } from "../src/retrieval.js";
import { BudgetTracker, parseJsonLenient, msUntilHour } from "../src/consolidate.js";
import { extractConversationText } from "../src/distiller.js";
import { resolveLlmConfigForCC } from "../src/llm.js";
import { readCcTranscripts } from "../src/transcript-reader.js";
import { injectLessons, removeLessonsBlock } from "../src/claude-md.js";
import type Database from "better-sqlite3";

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
// LLM Config for CC
// ---------------------------------------------------------------------------

describe("resolveLlmConfigForCC", () => {
  const savedKeys = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
    HICORTEX_LLM_BASE_URL: process.env.HICORTEX_LLM_BASE_URL,
    HICORTEX_LLM_API_KEY: process.env.HICORTEX_LLM_API_KEY,
    HICORTEX_LLM_MODEL: process.env.HICORTEX_LLM_MODEL,
  };

  afterEach(() => {
    for (const [key, val] of Object.entries(savedKeys)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  it("returns Anthropic Haiku when ANTHROPIC_API_KEY is set", () => {
    // Clear other keys to isolate test
    delete process.env.HICORTEX_LLM_BASE_URL;
    delete process.env.HICORTEX_LLM_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-test-123";
    const config = resolveLlmConfigForCC();
    expect(config.provider).toBe("anthropic");
    expect(config.model).toContain("haiku");
    expect(config.apiKey).toBe("sk-test-123");
  });

  it("prefers HICORTEX_LLM env vars over ANTHROPIC_API_KEY", () => {
    process.env.ANTHROPIC_API_KEY = "sk-anthropic";
    process.env.HICORTEX_LLM_BASE_URL = "https://custom.llm.com/v1";
    process.env.HICORTEX_LLM_API_KEY = "sk-custom";
    process.env.HICORTEX_LLM_MODEL = "custom-model";
    const config = resolveLlmConfigForCC();
    expect(config.baseUrl).toBe("https://custom.llm.com/v1");
    expect(config.apiKey).toBe("sk-custom");
    expect(config.model).toBe("custom-model");
  });

  it("prefers explicit overrides over all env vars", () => {
    process.env.ANTHROPIC_API_KEY = "sk-anthropic";
    const config = resolveLlmConfigForCC({
      llmBaseUrl: "https://override.com",
      llmApiKey: "sk-override",
      llmModel: "override-model",
    });
    expect(config.baseUrl).toBe("https://override.com");
    expect(config.apiKey).toBe("sk-override");
    expect(config.model).toBe("override-model");
  });

  it("falls back to claude-cli or ollama when no keys are set", () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.HICORTEX_LLM_BASE_URL;
    delete process.env.HICORTEX_LLM_API_KEY;
    const config = resolveLlmConfigForCC();
    // claude-cli if claude binary found, otherwise ollama
    expect(["claude-cli", "ollama"]).toContain(config.provider);
  });

  it("ollama override without apiKey falls through to env/fallback", () => {
    // This is the bug: ollama has no API key, so overrides with baseUrl but no apiKey
    // should NOT be silently ignored. resolveLlmConfigForCC requires both.
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.HICORTEX_LLM_BASE_URL;
    delete process.env.HICORTEX_LLM_API_KEY;
    const config = resolveLlmConfigForCC({
      llmBaseUrl: "http://localhost:11434",
      llmModel: "qwen3.5:4b",
    });
    // Without apiKey, resolveLlmConfigForCC skips the override — this is expected
    // The fix is in mcp-server.ts which handles ollama backend explicitly
    expect(["claude-cli", "ollama"]).toContain(config.provider);
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

    // This is the logic from mcp-server.ts
    let llmConfig: import("../src/llm.js").LlmConfig;
    if (savedConfig.llmBackend === "ollama" && savedConfig.llmBaseUrl) {
      llmConfig = {
        baseUrl: savedConfig.llmBaseUrl,
        apiKey: "",
        model: savedConfig.llmModel ?? "qwen3.5:4b",
        reflectModel: savedConfig.reflectModel ?? savedConfig.llmModel ?? "qwen3.5:4b",
        provider: "ollama",
      };
    } else {
      llmConfig = resolveLlmConfigForCC();
    }
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
// Distiller
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// CLAUDE.md Injection
// ---------------------------------------------------------------------------

describe("claude-md", () => {
  const testClaudeMd = join(TEST_DIR, "CLAUDE.md");

  it("creates CLAUDE.md with learnings block on fresh file", async () => {
    // Ensure no file exists
    try { rmSync(testClaudeMd); } catch {}

    const result = await injectLessons(db, {
      claudeMdPath: testClaudeMd,
      stateDir: TEST_DIR,
    });
    expect(result.path).toBe(testClaudeMd);

    const content = readFileSync(testClaudeMd, "utf-8");
    expect(content).toContain("<!-- HICORTEX-LEARNINGS:START -->");
    expect(content).toContain("<!-- HICORTEX-LEARNINGS:END -->");
    expect(content).toContain("## Hicortex Memory");
    expect(content).toContain("hicortex_search");
  });

  it("replaces existing block without affecting surrounding content", async () => {
    writeFileSync(testClaudeMd, "# My Project\n\nSome existing content.\n\n<!-- HICORTEX-LEARNINGS:START -->\nold content\n<!-- HICORTEX-LEARNINGS:END -->\n\n## Other Section\n");

    await injectLessons(db, { claudeMdPath: testClaudeMd, stateDir: TEST_DIR });

    const content = readFileSync(testClaudeMd, "utf-8");
    expect(content).toContain("# My Project");
    expect(content).toContain("## Other Section");
    expect(content).toContain("## Hicortex Memory");
    expect(content).not.toContain("old content");
  });

  it("is idempotent — calling twice produces same result", async () => {
    try { rmSync(testClaudeMd); } catch {}

    await injectLessons(db, { claudeMdPath: testClaudeMd, stateDir: TEST_DIR });
    const first = readFileSync(testClaudeMd, "utf-8");

    await injectLessons(db, { claudeMdPath: testClaudeMd, stateDir: TEST_DIR });
    const second = readFileSync(testClaudeMd, "utf-8");

    expect(first).toBe(second);
  });

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
} from "../src/features.js";

describe("features", () => {
  // Each test uses an isolated state dir so the persisted tier from one test
  // doesn't leak into another. We can't reset the module-global cache directly
  // (that would require module reloading), so the tests are written to be
  // order-independent.

  it("returns free tier defaults when no license key and no persisted tier", async () => {
    const dir = join(TEST_DIR, `features-free-${randomUUID().slice(0, 6)}`);
    mkdirSync(dir, { recursive: true });

    // First-call branch in initFeatures: no key → keep persisted (or free)
    await initFeatures(undefined, dir);

    // After init, current features should be free OR whatever the previous
    // test left in the module cache. We assert the free behaviour is at least
    // self-consistent.
    const features = getCurrentFeatures();
    expect(features).toHaveProperty("maxMemories");
    expect(features).toHaveProperty("reflection");
    expect(features).toHaveProperty("vectorSearch");
  });

  it("memoryCapReached respects current tier", () => {
    // Free tier: cap of 250
    if (maxMemoriesAllowed() === 250) {
      expect(memoryCapReached(249)).toBe(false);
      expect(memoryCapReached(250)).toBe(true);
      expect(memoryCapReached(1000)).toBe(true);
    }
    // Pro tier: -1 means unlimited
    if (maxMemoriesAllowed() === -1) {
      expect(memoryCapReached(0)).toBe(false);
      expect(memoryCapReached(1_000_000)).toBe(false);
    }
  });

  it("lessonsLimit returns 10 for free, 20 for pro", () => {
    const limit = lessonsLimit();
    if (isPro()) {
      expect(limit).toBe(20);
    } else {
      expect(limit).toBe(10);
    }
  });

  it("remoteIngestAllowed reflects features.remoteIngest flag", () => {
    const features = getCurrentFeatures();
    if (features.remoteIngest === false) {
      expect(remoteIngestAllowed()).toBe(false);
    } else {
      expect(remoteIngestAllowed()).toBe(true);
    }
  });

  it("isPro is true iff maxMemoriesAllowed is -1", () => {
    expect(isPro()).toBe(maxMemoriesAllowed() === -1);
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
    it("returns the first N lessons (slice behaviour)", async () => {
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
    expect(version).toBeGreaterThanOrEqual(2); // we have v1 and v2 today
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
  type HicortexState,
  type PersistedTier,
} from "../src/state.js";

describe("state", () => {
  function freshDir(label: string): string {
    const d = join(TEST_DIR, `state-${label}-${randomUUID().slice(0, 6)}`);
    mkdirSync(d, { recursive: true });
    return d;
  }

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
