/**
 * Hicortex OpenClaw Plugin — Long-term Memory That Learns.
 *
 * Pure in-process plugin: no sidecar, no HTTP. Uses better-sqlite3 + sqlite-vec
 * for storage, @huggingface/transformers for embeddings, and multi-provider LLM
 * for distillation and consolidation.
 */

import { join } from "node:path";
import type Database from "better-sqlite3";
import { initDb, getStats, resolveDbPath } from "./db.js";
import { initFeatures, lessonsLimit, memoryCapReached, maxMemoriesAllowed } from "./features.js";
import { getLessonSelector } from "./extensions.js";
import { migrateLegacyState } from "./state.js";
import { resolveLlmConfig, LlmClient, type LlmConfig } from "./llm.js";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { embed } from "./embedder.js";
import * as storage from "./storage.js";
import { injectSeedLesson } from "./seed-lesson.js";
import * as retrieval from "./retrieval.js";
import { extractConversationText, distillSession } from "./distiller.js";
import {
  runConsolidation,
  scheduleConsolidation,
} from "./consolidate.js";
import type { HicortexConfig, MemorySearchResult } from "./types.js";

// ---------------------------------------------------------------------------
// Module state — initialized in registerService.start()
// ---------------------------------------------------------------------------

let db: Database.Database | null = null;
let llm: LlmClient | null = null;
let cancelConsolidation: (() => void) | null = null;
let stateDir = "";

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------

export default {
  id: "hicortex",
  name: "Hicortex \u2014 Long-term Memory That Learns",
  kind: "lifecycle" as const,

  register(api: any) {
    // -----------------------------------------------------------------------
    // Background service: init DB, embedder, LLM, consolidation timer
    // -----------------------------------------------------------------------
    api.registerService({
      id: "hicortex-service",

      async start(ctx: any) {
        const config = (ctx.config ?? {}) as HicortexConfig;
        stateDir = ctx.stateDir ?? join(process.env.HOME ?? "~", ".hicortex");
        const log = ctx.logger
          ? (msg: string) => ctx.logger.info(msg)
          : console.log;

        // Resolve database path (handles migration from legacy OC location)
        const dbPath = resolveDbPath(config.dbPath);
        log(`[hicortex] Initializing database at ${dbPath}`);
        db = initDb(dbPath);

        // Auto-configure LLM: resolve → test → persist
        const llmConfig = await autoConfigureLlm(config, log);
        llm = new LlmClient(llmConfig);
        log(
          `[hicortex] LLM: ${llmConfig.provider}/${llmConfig.model} ` +
            `(reflect: ${llmConfig.reflectModel})`
        );

        // One-time migration of legacy state files (no-op if state.json exists)
        migrateLegacyState(stateDir);

        // License: init feature cache (sync after this returns)
        await initFeatures(config.licenseKey, stateDir);

        // Schedule nightly consolidation
        const consolidateHour = config.consolidateHour ?? 2;
        cancelConsolidation = scheduleConsolidation(
          db,
          llm,
          embed,
          consolidateHour
        );

        // Seed the bootstrap lesson on first run
        await injectSeedLesson(db, log);

        // Auto-add tools to tools.allow if using a restrictive profile
        ensureToolsAllowed(log);

        // Log stats
        const stats = getStats(db, dbPath);
        log(
          `[hicortex] Ready: ${stats.memories} memories, ${stats.links} links, ` +
            `${Math.round(stats.db_size_bytes / 1024)} KB`
        );
      },

      async stop() {
        if (cancelConsolidation) {
          cancelConsolidation();
          cancelConsolidation = null;
        }
        if (db) {
          db.close();
          db = null;
        }
        llm = null;
      },
    });

    // -----------------------------------------------------------------------
    // Hook: before_agent_start — inject lessons into agent context
    // -----------------------------------------------------------------------
    api.on(
      "before_agent_start",
      async (
        event: { prompt: string },
        ctx: { agentId?: string; project?: string }
      ) => {
        if (!db) return {};

        try {
          const lessons = storage.getLessons(db, 7, ctx.project);
          if (lessons.length === 0) return {};

          const maxLessons = lessonsLimit();
          const selected = await getLessonSelector().select(lessons, {
            maxLessons,
            project: ctx.project,
            agentId: ctx.agentId,
          });

          const formatted = selected.map((l) => {
            // Extract just the lesson text from the structured content
            const match = l.content.match(/## Lesson: (.+)/);
            return match ? `- ${match[1]}` : `- ${l.content.slice(0, 200)}`;
          });

          let context =
            `\n\n## Hicortex Lessons (auto-injected from long-term memory)\n` +
            `These are actionable lessons learned from past sessions:\n\n` +
            formatted.join("\n") +
            "\n";

          // Daily friendly reminder when at memory cap
          const memCount = storage.countMemories(db!);
          if (memoryCapReached(memCount)) {
            context +=
              `\n---\nHicortex free tier: ${maxMemoriesAllowed()} memories stored. ` +
              `New memories can no longer be saved, and your agent has stopped learning and self-improving from new sessions. ` +
              `Existing memories, lessons, and search still work. ` +
              `Upgrade for unlimited usage: https://hicortex.gamaze.com/ ` +
              `— after purchase, tell me your key and I'll activate it for you.\n`;
          }

          return { appendSystemContext: context };
        } catch {
          return {};
        }
      }
    );

    // -----------------------------------------------------------------------
    // Hook: agent_end — distill conversation into memories
    // -----------------------------------------------------------------------
    api.on(
      "agent_end",
      async (
        event: {
          messages: unknown[];
          success: boolean;
          durationMs?: number;
        },
        ctx: { agentId?: string; sessionKey?: string; project?: string }
      ) => {
        if (!db || !llm) return;
        if (!event.success || event.messages.length < 4) return;

        try {
          const transcript = extractConversationText(event.messages);
          if (transcript.length < 200) return;

          const date = new Date().toISOString().slice(0, 10);
          const projectName = ctx.project ?? "unknown";
          const sourceAgent = `openclaw/${ctx.agentId ?? "unknown"}`;

          const entries = await distillSession(
            llm,
            transcript,
            projectName,
            date
          );

          if (entries.length === 0) return;

          // Check license cap
          if (memoryCapReached(storage.countMemories(db!))) {
            console.warn(
              `[hicortex] Free tier limit reached (${maxMemoriesAllowed()} memories). ` +
                `Search and lessons still work, but new memories won't be saved. ` +
                `Upgrade for unlimited usage: https://hicortex.gamaze.com/`
            );
            return;
          }

          // Embed and ingest each entry
          for (const entry of entries) {
            try {
              const embedding = await embed(entry);
              storage.insertMemory(db!, entry, embedding, {
                sourceAgent,
                sourceSession: ctx.sessionKey,
                project: projectName,
                privacy: "WORK",
                memoryType: "episode",
              });
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              console.error(`[hicortex] Failed to ingest entry: ${msg}`);
            }
          }
        } catch {
          // Non-fatal — session capture failing shouldn't break the agent
        }
      }
    );

    // -----------------------------------------------------------------------
    // Hook: session_end — check if consolidation is overdue
    // -----------------------------------------------------------------------
    api.on(
      "session_end",
      async (
        event: { sessionId: string; messageCount: number },
        _ctx: any
      ) => {
        if (!db || !llm || event.messageCount < 4) return;

        // Opportunistic consolidation if no nightly run in 48h
        try {
          const { readFileSync: readFs } = await import("node:fs");
          const { join: joinPath } = await import("node:path");
          const { homedir: homeDir } = await import("node:os");
          const lastPath = joinPath(
            homeDir(),
            ".hicortex",
            "last-consolidated.txt"
          );
          const lastTs = readFs(lastPath, "utf-8").trim();
          const lastDate = new Date(lastTs);
          const hoursSince =
            (Date.now() - lastDate.getTime()) / (1000 * 60 * 60);

          if (hoursSince > 48) {
            console.log(
              "[hicortex] Consolidation overdue — triggering now"
            );
            runConsolidation(db!, llm!, embed).catch((err) => {
              console.error("[hicortex] Opportunistic consolidation failed:", err);
            });
          }
        } catch {
          // No timestamp file — first run, consolidation will happen on schedule
        }
      }
    );

    // -----------------------------------------------------------------------
    // Tools — registered as factory functions per OC plugin API
    // -----------------------------------------------------------------------
    api.registerTool(
      (_ctx: any) => ({
        name: "hicortex_search",
        description:
          "Search long-term memory using semantic similarity. Returns the most relevant memories from past sessions.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query text" },
            limit: { type: "number", description: "Max results (default 5)" },
            project: { type: "string", description: "Filter by project name" },
          },
          required: ["query"],
        },
        async execute(_callId: any, args: any, _ctx: any) {
          if (!db) return { error: "Hicortex not initialized" };
          try {
            const results = await retrieval.retrieve(db, embed, args.query, {
              limit: args.limit,
              project: args.project,
            });
            return formatToolResults(results);
          } catch (err) {
            return { error: `Search failed: ${err instanceof Error ? err.message : String(err)}` };
          }
        },
      }),
      { name: "hicortex_search" }
    );

    api.registerTool(
      (_ctx: any) => ({
        name: "hicortex_context",
        description:
          "Get recent context memories, optionally filtered by project. Useful to recall what happened recently.",
        parameters: {
          type: "object",
          properties: {
            project: { type: "string", description: "Filter by project name" },
            limit: { type: "number", description: "Max results (default 10)" },
          },
        },
        execute(_callId: any, args: any, _ctx: any) {
          if (!db) return { error: "Hicortex not initialized" };
          try {
            const results = retrieval.searchContext(db, {
              project: args?.project,
              limit: args?.limit,
            });
            return formatToolResults(results);
          } catch (err) {
            return { error: `Context search failed: ${err instanceof Error ? err.message : String(err)}` };
          }
        },
      }),
      { name: "hicortex_context" }
    );

    api.registerTool(
      (_ctx: any) => ({
        name: "hicortex_ingest",
        description:
          "Store a new memory in long-term storage. Use for important facts, decisions, or lessons.",
        parameters: {
          type: "object",
          properties: {
            content: { type: "string", description: "Memory content to store" },
            project: { type: "string", description: "Project this memory belongs to" },
            memory_type: {
              type: "string",
              enum: ["episode", "lesson", "fact", "decision"],
              description: "Type of memory (default: episode)",
            },
          },
          required: ["content"],
        },
        async execute(_callId: any, args: any, context: any) {
          if (!db) return { error: "Hicortex not initialized" };
          if (memoryCapReached(storage.countMemories(db))) {
            return {
              content: [{
                type: "text",
                text: `Free tier limit reached (${maxMemoriesAllowed()} memories). ` +
                  `Your existing memories and lessons still work — search and recall are unaffected. ` +
                  `New memories won't be saved until you upgrade.\n\n` +
                  `Upgrade for unlimited usage: https://hicortex.gamaze.com/`
              }],
            };
          }
          try {
            const embedding = await embed(args.content);
            const id = storage.insertMemory(db, args.content, embedding, {
              sourceAgent: `openclaw/${context?.agentId ?? "manual"}`,
              project: args.project,
              memoryType: args.memory_type ?? "episode",
              privacy: "WORK",
            });
            return { content: [{ type: "text", text: `Memory stored (id: ${id.slice(0, 8)})` }] };
          } catch (err) {
            return { error: `Ingest failed: ${err instanceof Error ? err.message : String(err)}` };
          }
        },
      }),
      { name: "hicortex_ingest" }
    );

    api.registerTool(
      (_ctx: any) => ({
        name: "hicortex_lessons",
        description:
          "Get actionable lessons learned from past sessions. Auto-generated insights about mistakes to avoid.",
        parameters: {
          type: "object",
          properties: {
            days: { type: "number", description: "Look back N days (default 7)" },
            project: { type: "string", description: "Filter by project name" },
          },
        },
        execute(_callId: any, args: any, _ctx: any) {
          if (!db) return { error: "Hicortex not initialized" };
          try {
            const lessons = storage.getLessons(db, args.days ?? 7, args.project);
            if (lessons.length === 0) {
              return { content: [{ type: "text", text: "No lessons found for the specified period." }] };
            }
            const text = lessons.map((l) => `- ${l.content.slice(0, 500)}`).join("\n");
            return { content: [{ type: "text", text }] };
          } catch (err) {
            return { error: `Lessons fetch failed: ${err instanceof Error ? err.message : String(err)}` };
          }
        },
      }),
      { name: "hicortex_lessons" }
    );

    api.registerTool(
      (_ctx: any) => ({
        name: "hicortex_update",
        description:
          "Update an existing memory. Use after searching to fix incorrect information. If content changes, the embedding is re-computed.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "Memory ID (from search results, first 8 chars or full UUID)" },
            content: { type: "string", description: "New content text" },
            project: { type: "string", description: "New project name" },
            memory_type: { type: "string", enum: ["episode", "lesson", "fact", "decision"], description: "New memory type" },
          },
          required: ["id"],
        },
        async execute(_callId: any, args: any, _ctx: any) {
          if (!db) return { error: "Hicortex not initialized" };
          try {
            const fullId = resolveMemoryId(db, args.id);
            if (!fullId) return { error: `Memory not found: ${args.id}` };

            const fields: Record<string, unknown> = {};
            if (args.content !== undefined) fields.content = args.content;
            if (args.project !== undefined) fields.project = args.project;
            if (args.memory_type !== undefined) fields.memory_type = args.memory_type;

            if (Object.keys(fields).length === 0) return { error: "No fields to update" };

            storage.updateMemory(db, fullId, fields);

            if (args.content !== undefined) {
              const embedding = await embed(args.content);
              db.prepare("DELETE FROM memory_vectors WHERE id = ?").run(fullId);
              db.prepare("INSERT INTO memory_vectors (id, embedding) VALUES (?, ?)").run(
                fullId, Buffer.from(embedding.buffer)
              );
            }

            return { content: [{ type: "text", text: `Memory updated (id: ${fullId.slice(0, 8)})` }] };
          } catch (err) {
            return { error: `Update failed: ${err instanceof Error ? err.message : String(err)}` };
          }
        },
      }),
      { name: "hicortex_update" }
    );

    api.registerTool(
      (_ctx: any) => ({
        name: "hicortex_delete",
        description:
          "Permanently delete a memory and its links. Use when a memory is incorrect and should be removed entirely.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "Memory ID (from search results, first 8 chars or full UUID)" },
          },
          required: ["id"],
        },
        execute(_callId: any, args: any, _ctx: any) {
          if (!db) return { error: "Hicortex not initialized" };
          try {
            const fullId = resolveMemoryId(db, args.id);
            if (!fullId) return { error: `Memory not found: ${args.id}` };

            storage.deleteMemory(db, fullId);
            return { content: [{ type: "text", text: `Memory deleted (id: ${fullId.slice(0, 8)})` }] };
          } catch (err) {
            return { error: `Delete failed: ${err instanceof Error ? err.message : String(err)}` };
          }
        },
      }),
      { name: "hicortex_delete" }
    );
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveMemoryId(database: import("better-sqlite3").Database, idPrefix: string): string | null {
  if (idPrefix.length >= 36) {
    const row = database.prepare("SELECT id FROM memories WHERE id = ?").get(idPrefix) as { id: string } | undefined;
    return row?.id ?? null;
  }
  const rows = database.prepare("SELECT id FROM memories WHERE id LIKE ?").all(`${idPrefix}%`) as { id: string }[];
  if (rows.length === 1) return rows[0].id;
  return null;
}

// ---------------------------------------------------------------------------
// Auto-configure LLM: resolve config → test connection → persist if new
// ---------------------------------------------------------------------------

async function autoConfigureLlm(
  pluginConfig: HicortexConfig,
  log: (msg: string) => void
): Promise<LlmConfig> {
  // Step 1: Resolve LLM config from all sources
  const llmConfig = resolveLlmConfig({
    llmBaseUrl: pluginConfig.llmBaseUrl,
    llmApiKey: pluginConfig.llmApiKey,
    llmModel: pluginConfig.llmModel,
    reflectModel: pluginConfig.reflectModel,
  });

  // Step 2: Test the connection
  log(`[hicortex] Testing LLM connection: ${llmConfig.provider}/${llmConfig.model} @ ${llmConfig.baseUrl}`);
  const testClient = new LlmClient(llmConfig);
  try {
    const response = await testClient.completeFast("Respond with just the word OK", 10);
    if (response && response.length > 0) {
      log(`[hicortex] LLM connection verified`);
      // Step 3: Persist to OC config so future startups skip detection
      persistProviderConfig(llmConfig, log);
      return llmConfig;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[hicortex] LLM test failed (${llmConfig.baseUrl}): ${msg}`);
  }

  // Step 4: Fall back — return the config anyway, log instructions
  log(
    `[hicortex] WARNING: Could not verify LLM connection. ` +
    `Distillation and consolidation may fail. ` +
    `To fix: add models.providers.${llmConfig.provider}.baseUrl to ~/.openclaw/openclaw.json ` +
    `or set llmBaseUrl in the hicortex plugin config.`
  );
  return llmConfig;
}

/**
 * Persist verified provider config to openclaw.json so future startups
 * skip detection and go straight to the verified URL.
 */
function persistProviderConfig(llmConfig: LlmConfig, log: (msg: string) => void): void {
  try {
    const configPath = join(homedir(), ".openclaw", "openclaw.json");
    const raw = readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw);

    // Check if baseUrl already stored for this provider
    const existing = config?.models?.providers?.[llmConfig.provider]?.baseUrl;
    if (existing === llmConfig.baseUrl) return; // Already persisted

    // Write the provider config
    if (!config.models) config.models = {};
    if (!config.models.providers) config.models.providers = {};
    if (!config.models.providers[llmConfig.provider]) {
      config.models.providers[llmConfig.provider] = {};
    }
    const prov = config.models.providers[llmConfig.provider];
    prov.baseUrl = llmConfig.baseUrl;
    // OC requires a models array — preserve existing or add the active model
    if (!prov.models || !Array.isArray(prov.models)) {
      prov.models = [{
        id: llmConfig.model,
        name: llmConfig.model,
        input: ["text"],
        contextWindow: 128000,
        maxTokens: 8192,
      }];
    }

    writeFileSync(configPath, JSON.stringify(config, null, 2));
    log(`[hicortex] Persisted LLM config: ${llmConfig.provider} → ${llmConfig.baseUrl}`);
  } catch {
    // Non-fatal — config works in memory even if we can't persist
  }
}

const HICORTEX_TOOLS = [
  "hicortex_search",
  "hicortex_context",
  "hicortex_ingest",
  "hicortex_lessons",
  "hicortex_update",
  "hicortex_delete",
];

/**
 * Ensure hicortex tools are in tools.allow so they're visible to agents
 * regardless of the tools.profile setting.
 */
function ensureToolsAllowed(log: (msg: string) => void): void {
  try {
    const configPath = join(homedir(), ".openclaw", "openclaw.json");
    const raw = readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw);

    if (!config.tools) config.tools = {};
    if (!Array.isArray(config.tools.allow)) config.tools.allow = [];

    const missing = HICORTEX_TOOLS.filter(
      (t) => !config.tools.allow.includes(t)
    );
    if (missing.length === 0) return;

    config.tools.allow.push(...missing);
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    log(`[hicortex] Added tools to allow list: ${missing.join(", ")}`);
  } catch {
    // Non-fatal
  }
}

function formatToolResults(
  results: MemorySearchResult[]
): { content: Array<{ type: string; text: string }> } {
  if (results.length === 0) {
    return {
      content: [{ type: "text", text: "No memories found." }],
    };
  }

  const text = results
    .map(
      (r) =>
        `[${r.memory_type}] (score: ${r.score.toFixed(3)}, strength: ${r.effective_strength.toFixed(3)}) ${r.content.slice(0, 500)}`
    )
    .join("\n\n");

  return { content: [{ type: "text", text }] };
}
