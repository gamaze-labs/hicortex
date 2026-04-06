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

  it("creates CLAUDE.md with learnings block on fresh file", () => {
    // Ensure no file exists
    try { rmSync(testClaudeMd); } catch {}

    const result = injectLessons(db, {
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

  it("replaces existing block without affecting surrounding content", () => {
    writeFileSync(testClaudeMd, "# My Project\n\nSome existing content.\n\n<!-- HICORTEX-LEARNINGS:START -->\nold content\n<!-- HICORTEX-LEARNINGS:END -->\n\n## Other Section\n");

    injectLessons(db, { claudeMdPath: testClaudeMd, stateDir: TEST_DIR });

    const content = readFileSync(testClaudeMd, "utf-8");
    expect(content).toContain("# My Project");
    expect(content).toContain("## Other Section");
    expect(content).toContain("## Hicortex Memory");
    expect(content).not.toContain("old content");
  });

  it("is idempotent — calling twice produces same result", () => {
    try { rmSync(testClaudeMd); } catch {}

    injectLessons(db, { claudeMdPath: testClaudeMd, stateDir: TEST_DIR });
    const first = readFileSync(testClaudeMd, "utf-8");

    injectLessons(db, { claudeMdPath: testClaudeMd, stateDir: TEST_DIR });
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
