/**
 * Hicortex MCP HTTP/SSE Server.
 *
 * Persistent HTTP server that exposes Hicortex tools via MCP protocol.
 * Shared across all CC sessions (and future Codex/Gemini adapters).
 * One process, one DB connection, one embedder — no per-session overhead.
 *
 * Endpoints:
 *   GET  /health     — health check
 *   GET  /sse        — SSE stream for MCP clients
 *   POST /messages   — message endpoint for MCP clients
 */

import express from "express";
import { join as pathJoin } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import type Database from "better-sqlite3";

import { initDb, getStats, resolveDbPath } from "./db.js";
import { resolveExplicitLlmConfig, applyModelsBlock, LlmClient, findClaudeBinary, claudeCliConfig, resolveDistillFallback, type LlmConfig } from "./llm.js";
import { initFeatures } from "./features.js";
import { loadState, migrateLegacyState } from "./state.js";
import { embed } from "./embedder.js";
import * as storage from "./storage.js";
import { getNeighbors, shortestPath, detectHubs, exportGraph, EXPORT_DEFAULT_LIMIT } from "./graph.js";
import { createAuthMiddleware, vizHandler, vizVendorHandler, contextUiHandler } from "./viz.js";
import {
  handleContextGet,
  handleContextPut,
  resolveContextClients,
  resolveContextAgents,
  type AgentMode,
} from "./context-store.js";
import * as retrieval from "./retrieval.js";
import { SessionRecallRegistry } from "./recall-registry.js";
import { injectMemorySection, isReservedSectionName, MEMORY_SECTION_NAME } from "./memory-instructions.js";
import { handleRecallIndex, handleMemoryGet, formatMemoryGetText, type RecallIndexOptions } from "./recall-index.js";
import { injectSeedLesson } from "./seed-lesson.js";
import { extractConversationText, distillSession, detectChunkSize } from "./distiller.js";
import { countExistingSegment, countExistingSession } from "./dedup.js";
import { ensureAndPersistAgentId, loadConfigStrict } from "./init.js";
import type { MemorySearchResult } from "./types.js";

// ---------------------------------------------------------------------------
// Server state
// ---------------------------------------------------------------------------

let db: Database.Database | null = null;
let llm: LlmClient | null = null;
// llmConfig is module-level so the /distill handler can call resolveDistillFallback
// without having to read config on every request. null when no LLM is configured.
let llmConfig: LlmConfig | null = null;

// One-time-per-process deprecation warning for the `?privacy=` query param
// (0.16.x: the column is vestigial, never filtered). Old clients/plugins still
// send it; we accept it (backward compat) but warn ONCE so an operator relying
// on privacy filtering discovers from the logs that it is now a no-op.
let privacyDeprecationWarned = false;
function warnDeprecatedPrivacyParamIfPresent(query: Record<string, unknown>, route: string): void {
  if (privacyDeprecationWarned) return;
  if (query.privacy === undefined || query.privacy === null || query.privacy === "") return;
  privacyDeprecationWarned = true;
  console.warn(
    `[hicortex] client sent ?privacy= on /${route}, which is ignored since 0.16.2 — ` +
    `privacy is no longer filtered server-side (the column is vestigial). ` +
    `Use a separate Hicortex server for isolation. (This warning fires once per process.)`
  );
}
// distillFallbackMode controls whether a failed remote distill endpoint causes an
// immediate abort ("strict", default) or a fallback to the base model ("local").
let distillFallbackMode: "strict" | "local" = "strict";
let stateDir = "";
// Resolved contextClients list (spec §2) — the harness names allowed to inject
// the standing context layer. Echoed by GET /context so each hook self-gates.
let contextClients: string[] = ["cc"];
// Resolved contextAgents map (0.13) — agent id → mode (override/global/off).
// Read once at boot (like contextClients); the drop-in-a-dir presence path is
// per-request, so only explicit config entries need a daemon restart to apply.
let contextAgents: Record<string, AgentMode> = {};
// Pushed-recall dedup registry (#192) + options; configured at boot.
let recallRegistry = new SessionRecallRegistry();
let recallIndexOptions: RecallIndexOptions = {};
// Product-owned memory instructions (#192): on unless config says false.
let memoryInstructionsEnabled = true;

// Cache detectChunkSize results keyed by "<provider>/<model>@<baseUrl>" so we
// probe each endpoint once per server boot rather than once per /distill request.
const chunkSizeCache = new Map<string, number>();

let VERSION = "0.3.x";
try {
  const pkg = JSON.parse(require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "package.json"), "utf-8"));
  VERSION = pkg.version;
} catch { /* fallback */ }

// ---------------------------------------------------------------------------
// MCP Server setup
// ---------------------------------------------------------------------------

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "hicortex",
    version: VERSION,
  });

  // -- hicortex_search --
  server.tool(
    "hicortex_search",
    "Search shared long-term memory (all agents, all sessions). CALL THIS BEFORE assuming, guessing, or asking the user about anything that may have come up before: prior decisions, preferences, project facts, people, hardware, past incidents. If you are about to write 'I don't have information about…', search first.",
    {
      query: z.string().describe("Search query text"),
      limit: z.coerce.number().optional().describe("Max results (default: server config searchLimit)"),
      project: z.string().optional().describe("Filter by project name"),
    },
    async ({ query, limit, project }) => {
      if (!db) return { content: [{ type: "text" as const, text: "Hicortex not initialized" }], isError: true };
      try {
        const results = await retrieval.retrieve(db, embed, query, { limit, project });
        return { content: [{ type: "text" as const, text: formatResults(results) }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Search failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );

  // -- hicortex_get --
  server.tool(
    "hicortex_get",
    "Fetch ONE memory's full content by id — use this to lazy-load entries from the '## Memory recall (auto)' index or from search results whose snippet was not enough. Fetching a memory marks it as used (strengthens it), so fetch entries that could change your action — not every shown one. When the memory shapes your answer, cite it to the user (id + date + origin agent) — mark a fetched memory `FETCHED` and a one-line entry cited unread `SNIPPET`; don't pass SNIPPET off as established.",
    {
      id: z.string().describe("Memory id (as shown in recall index/search results)"),
    },
    async ({ id }) => {
      if (!db) return { content: [{ type: "text" as const, text: "Hicortex not initialized" }], isError: true };
      // Delegates to formatMemoryGetText → handleMemoryGet, so the citation
      // (incl. the #204 FETCHED marker) is built in ONE place shared with the
      // REST GET /memory path. CC reaches Hicortex through THIS MCP tool;
      // before #207's fix it got a marker-less citation built inline here.
      try {
        const r = formatMemoryGetText(db, { id });
        return { content: [{ type: "text" as const, text: r.text }], isError: r.status !== 200 };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Get failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );

  // -- hicortex_recent --
  server.tool(
    "hicortex_recent",
    "Get recent memories, optionally filtered by project. CALL THIS AT THE START of substantive work on a project to catch up on its latest state — cheaper than asking the user what happened.",
    {
      project: z.string().optional().describe("Filter by project name"),
      limit: z.coerce.number().optional().describe("Max results (default: server config recentLimit)"),
    },
    async ({ project, limit }) => {
      if (!db) return { content: [{ type: "text" as const, text: "Hicortex not initialized" }], isError: true };
      try {
        const results = retrieval.searchRecent(db, { project, limit });
        return { content: [{ type: "text" as const, text: formatResults(results) }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Recent recall failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );

  // -- hicortex_ingest --
  server.tool(
    "hicortex_ingest",
    "Store a new memory in long-term storage. Use for important facts, decisions, or lessons.",
    {
      content: z.string().describe("Memory content to store"),
      project: z.string().optional().describe("Project this memory belongs to"),
      memory_type: z.enum(["episode", "lesson", "fact", "decision"]).optional().describe("Type of memory (default: episode)"),
    },
    async ({ content, project, memory_type }) => {
      if (!db) return { content: [{ type: "text" as const, text: "Hicortex not initialized" }], isError: true };
      try {
        const embedding = await embed(content);
        const id = storage.insertMemory(db, content, embedding, {
          sourceAgent: "claude-code/manual",
          project,
          memoryType: memory_type ?? "episode",
        });
        return { content: [{ type: "text" as const, text: `Memory stored (id: ${id.slice(0, 8)})` }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Ingest failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );

  // -- hicortex_update --
  server.tool(
    "hicortex_update",
    "Update an existing memory. Use after searching to fix incorrect information. If content changes, the embedding is re-computed.",
    {
      id: z.string().describe("Memory ID (from search results, first 8 chars or full UUID)"),
      content: z.string().optional().describe("New content text"),
      project: z.string().optional().describe("New project name"),
      memory_type: z.enum(["episode", "lesson", "fact", "decision"]).optional().describe("New memory type"),
    },
    async ({ id, content, project, memory_type }) => {
      if (!db) return { content: [{ type: "text" as const, text: "Hicortex not initialized" }], isError: true };
      try {
        // Resolve short ID prefix to full ID
        const fullId = resolveMemoryId(db, id);
        if (!fullId) return { content: [{ type: "text" as const, text: `Memory not found: ${id}` }], isError: true };

        const fields: Record<string, unknown> = {};
        if (content !== undefined) fields.content = content;
        if (project !== undefined) fields.project = project;
        if (memory_type !== undefined) fields.memory_type = memory_type;

        if (Object.keys(fields).length === 0) {
          return { content: [{ type: "text" as const, text: "No fields to update" }], isError: true };
        }

        const before = storage.getMemory(db, fullId);
        storage.updateMemory(db, fullId, fields);

        // Re-embed if content changed
        if (content !== undefined) {
          const embedding = await embed(content);
          db.prepare("DELETE FROM memory_vectors WHERE id = ?").run(fullId);
          db.prepare("INSERT INTO memory_vectors (id, embedding) VALUES (?, ?)").run(
            fullId,
            Buffer.from(embedding.buffer)
          );
        }

        const changed = Object.keys(fields).map(k => `${k}: "${String(before?.[k as keyof typeof before] ?? "").slice(0, 80)}" → "${String(fields[k]).slice(0, 80)}"`).join(", ");
        return { content: [{ type: "text" as const, text: `Memory updated (id: ${fullId.slice(0, 8)}). Changed: ${changed}` }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Update failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );

  // -- hicortex_delete --
  server.tool(
    "hicortex_delete",
    "Permanently delete a memory and its links. Use when a memory is incorrect and should be removed entirely.",
    {
      id: z.string().describe("Memory ID (from search results, first 8 chars or full UUID)"),
    },
    async ({ id }) => {
      if (!db) return { content: [{ type: "text" as const, text: "Hicortex not initialized" }], isError: true };
      try {
        const fullId = resolveMemoryId(db, id);
        if (!fullId) return { content: [{ type: "text" as const, text: `Memory not found: ${id}` }], isError: true };

        const memory = storage.getMemory(db, fullId);
        storage.deleteMemory(db, fullId);
        const preview = memory?.content?.slice(0, 200) ?? "(unknown)";
        return { content: [{ type: "text" as const, text: `Memory deleted (id: ${fullId.slice(0, 8)}). Content was: ${preview}` }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Delete failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );

  // -- hicortex_lessons --
  server.tool(
    "hicortex_lessons",
    "Get actionable lessons learned from past sessions. Auto-generated insights about mistakes to avoid.",
    {
      days: z.coerce.number().optional().describe("Look back N days (default 7)"),
      project: z.string().optional().describe("Filter by project name"),
    },
    async ({ days, project }) => {
      if (!db) return { content: [{ type: "text" as const, text: "Hicortex not initialized" }], isError: true };
      try {
        const lessons = storage.getLessons(db, days ?? 7, project);
        if (lessons.length === 0) {
          return { content: [{ type: "text" as const, text: "No lessons found for the specified period." }] };
        }
        const text = lessons.map((l) => `- ${l.content.slice(0, 500)}`).join("\n");
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Lessons fetch failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );

  // -- hicortex_index --
  server.tool(
    "hicortex_index",
    "Get the knowledge domain index — shows what topics and projects are stored in memory, grouped by domain.",
    {},
    async () => {
      const state = loadState(stateDir);
      const moduleIndex = state.moduleIndex;
      if (moduleIndex && moduleIndex.domains.length > 0) {
        const text = moduleIndex.domains.map((d) => {
          const head = `**${d.name}** (${d.memoryCount} memories, ${d.lessonCount} lessons)`;
          // Content-based domains carry a description and no projects; legacy
          // project-grouping domains carry a project list + keywords.
          if (d.description && d.projects.length === 0) {
            return `${head}\n  ${d.description}`;
          }
          return head +
            (d.projects.length > 0 ? `\n  Projects: ${d.projects.join(", ")}` : "") +
            (d.keywords.length > 0 ? `\n  Keywords: ${d.keywords.join(", ")}` : "");
        }).join("\n\n");
        return { content: [{ type: "text" as const, text }] };
      }
      // Fallback: flat project counts
      if (!db) return { content: [{ type: "text" as const, text: "No index available" }] };
      const rows = db.prepare(
        "SELECT project, COUNT(*) as cnt FROM memories WHERE project IS NOT NULL GROUP BY project ORDER BY cnt DESC LIMIT 20"
      ).all() as Array<{ project: string; cnt: number }>;
      const text = rows.length > 0
        ? rows.map((r) => `${r.project}: ${r.cnt} memories`).join("\n")
        : "No memories yet.";
      return { content: [{ type: "text" as const, text }] };
    }
  );

  // -- hicortex_graph --
  server.tool(
    "hicortex_graph",
    "Query the memory knowledge graph — find connected memories, hub nodes, or paths between memories.",
    {
      operation: z.enum(["neighbors", "hubs", "path"]).describe("Graph operation to perform"),
      id: z.string().optional().describe("Memory ID (required for neighbors and path operations)"),
      target_id: z.string().optional().describe("Target memory ID (required for path operation)"),
      limit: z.coerce.number().optional().describe("Max results (default 10)"),
      domain: z.string().optional().describe("Filter hubs by domain"),
      relationship: z.string().optional().describe("Filter neighbors by relationship type (e.g., extends, relates_to; legacy data may also have CONTRADICTS, SUPERSEDES, updates)"),
    },
    async ({ operation, id, target_id, limit: resultLimit, domain: filterDomain, relationship: filterRelationship }) => {
      if (!db) return { content: [{ type: "text" as const, text: "Hicortex not initialized" }], isError: true };
      try {
        if (operation === "neighbors") {
          if (!id) return { content: [{ type: "text" as const, text: "id is required for neighbors operation" }], isError: true };
          const resolvedId = resolveMemoryId(db, id);
          if (!resolvedId) return { content: [{ type: "text" as const, text: `Memory not found: ${id}` }], isError: true };
          const neighbors = getNeighbors(db, resolvedId, resultLimit ?? 10, filterRelationship);
          if (neighbors.length === 0) return { content: [{ type: "text" as const, text: "No connected memories found." }] };
          const text = neighbors.map((n) =>
            `[${n.direction}] ${n.relationship} (${n.strength.toFixed(2)})\n  ${n.id.slice(0, 8)} | ${n.project ?? "global"} | ${n.content}`
          ).join("\n\n");
          return { content: [{ type: "text" as const, text }] };
        }

        if (operation === "hubs") {
          let hubs = detectHubs(db);
          if (filterDomain) {
            hubs = hubs.filter((h) => h.domain === filterDomain || h.project === filterDomain);
          }
          if (hubs.length === 0) return { content: [{ type: "text" as const, text: "No hub memories found." }] };
          const text = hubs.slice(0, resultLimit ?? 10).map((h) =>
            `**${h.id.slice(0, 8)}** (${h.linkCount} links) | ${h.domain ?? h.project ?? "global"}\n  ${h.content}`
          ).join("\n\n");
          return { content: [{ type: "text" as const, text }] };
        }

        if (operation === "path") {
          if (!id || !target_id) return { content: [{ type: "text" as const, text: "id and target_id are required for path operation" }], isError: true };
          const fromId = resolveMemoryId(db, id);
          const toId = resolveMemoryId(db, target_id);
          if (!fromId || !toId) return { content: [{ type: "text" as const, text: "One or both memory IDs not found" }], isError: true };
          const path = shortestPath(db, fromId, toId);
          if (!path) return { content: [{ type: "text" as const, text: "No path found between these memories." }] };
          const text = path.map((nodeId, i) => {
            const mem = storage.getMemory(db!, nodeId);
            return `${i + 1}. ${nodeId.slice(0, 8)} | ${mem?.project ?? "?"} | ${mem?.content.slice(0, 150) ?? "?"}`;
          }).join("\n");
          return { content: [{ type: "text" as const, text: `Path (${path.length} hops):\n${text}` }] };
        }

        return { content: [{ type: "text" as const, text: `Unknown operation: ${operation}` }], isError: true };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Graph query failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// HTTP server with SSE transport
// ---------------------------------------------------------------------------

export async function startServer(options: {
  port?: number;
  host?: string;
  dbPath?: string;
  licenseKey?: string;
} = {}): Promise<void> {
  const port = options.port ?? 8787;
  const host = options.host ?? "0.0.0.0";

  // Initialize core
  const dbPath = resolveDbPath(options.dbPath);
  console.log(`[hicortex] Initializing database at ${dbPath}`);
  db = initDb(dbPath);
  stateDir = require("node:path").dirname(dbPath);

  // LLM config: explicit config only — no silent harness auto-detection.
  // Named backends (claude-cli, ollama) → immediate config; everything else
  // goes through resolveExplicitLlmConfig which requires a user-chosen provider.
  // If nothing is configured: start recall-only with an unmissable warning.
  const savedConfig = applyModelsBlock(readConfigFile(stateDir));
  // 0.16.2 activation gap: self-heal the agentId provenance field for
  // pre-0.16.2 server installs on first boot after upgrade. The server's own
  // nightly captures its sessions to localhost:8787/distill and needs this id;
  // without it every self-captured memory landed with source_agent_id NULL.
  // Hardened wrapper: throws on a malformed config instead of wiping, saves
  // only when a new id was generated. Mutate savedConfig so any downstream
  // read picks up the id even before the file is re-read.
  if (savedConfig) {
    const { agentId } = ensureAndPersistAgentId(pathJoin(stateDir, "config.json"));
    savedConfig.agentId = agentId;
  }
  if (savedConfig?.llmBackend === "claude-cli") {
    const claudePath = findClaudeBinary();
    if (claudePath) {
      llmConfig = claudeCliConfig(claudePath);
    } else {
      console.warn("[hicortex] claude-cli configured but claude binary not found — LLM disabled");
      llmConfig = null;
    }
  } else if (savedConfig?.llmBackend === "ollama") {
    // Ollama: no API key needed, default to localhost:11434
    llmConfig = {
      baseUrl: (savedConfig.llmBaseUrl as string | undefined) ?? "http://localhost:11434",
      apiKey: "",
      model: (savedConfig.llmModel as string) ?? "qwen3.5:4b",
      reflectModel: (savedConfig.reflectModel as string) ?? (savedConfig.llmModel as string) ?? "qwen3.5:4b",
      provider: "ollama",
    };
  } else {
    llmConfig = resolveExplicitLlmConfig({
      llmBaseUrl: savedConfig?.llmBaseUrl as string | undefined,
      llmApiKey: savedConfig?.llmApiKey as string | undefined,
      llmModel: savedConfig?.llmModel as string | undefined,
      reflectModel: savedConfig?.reflectModel as string | undefined,
    });
  }

  if (llmConfig) {
    // Apply optional distill endpoint (e.g. remote Ollama with faster model)
    if (savedConfig?.distillModel) {
      llmConfig.distillModel = savedConfig.distillModel as string;
    }
    if (savedConfig?.distillBaseUrl) {
      llmConfig.distillBaseUrl = savedConfig.distillBaseUrl as string;
      llmConfig.distillApiKey = (savedConfig.distillApiKey as string | undefined) ?? llmConfig.apiKey;
      llmConfig.distillProvider = (savedConfig.distillProvider as string | undefined) ?? llmConfig.provider;
    }
    // Apply separate reflect endpoint if configured (e.g. remote Ollama with larger model)
    if (savedConfig?.reflectBaseUrl) {
      llmConfig.reflectBaseUrl = savedConfig.reflectBaseUrl as string;
      llmConfig.reflectApiKey = (savedConfig.reflectApiKey as string | undefined) ?? llmConfig.apiKey;
      llmConfig.reflectProvider = (savedConfig.reflectProvider as string | undefined) ?? llmConfig.provider;
    }
    // distillFallback: "strict" (default) aborts on remote failure so the session
    // is retried next run. "local" restores 0.9.0 fallback-to-base-model behavior.
    const df = savedConfig?.distillFallback as string | undefined;
    distillFallbackMode = df === "local" ? "local" : "strict";
    llm = new LlmClient(llmConfig);
    const distillInfo = llmConfig.distillBaseUrl
      ? `${llmConfig.distillProvider}/${llmConfig.distillModel}@${llmConfig.distillBaseUrl}`
      : llmConfig.distillModel ? llmConfig.distillModel : "";
    const reflectInfo = llmConfig.reflectBaseUrl
      ? `${llmConfig.reflectProvider}/${llmConfig.reflectModel}@${llmConfig.reflectBaseUrl}`
      : llmConfig.reflectModel;
    console.log(`[hicortex] LLM fast: ${llmConfig.provider}/${llmConfig.model}${distillInfo ? `, distill: ${distillInfo}` : ""}, reflect: ${reflectInfo}`);
  } else {
    llm = null;
    console.warn("");
    console.warn("╔══════════════════════════════════════════════════════════════╗");
    console.warn("║  NO LLM CONFIGURED — running in recall-only mode            ║");
    console.warn("║                                                              ║");
    console.warn("║  search / lessons / recent: ENABLED                         ║");
    console.warn("║  /distill (capture) and consolidation: DISABLED             ║");
    console.warn("║                                                              ║");
    console.warn("║  To enable capture, run:                                    ║");
    console.warn("║    npx @gamaze/hicortex init                                ║");
    console.warn("╚══════════════════════════════════════════════════════════════╝");
    console.warn("");
  }

  // One-time migration of legacy state files (no-op if state.json exists)
  migrateLegacyState(stateDir);

  // License: read from options, config file, or env var, init feature cache
  const licenseKey = options.licenseKey
    ?? (savedConfig?.licenseKey as string | undefined)
    ?? process.env.HICORTEX_LICENSE_KEY;

  await initFeatures(licenseKey, stateDir);
  if (licenseKey) {
    console.log(`[hicortex] License key configured`);
  }

  // Seed lesson on first run
  await injectSeedLesson(db);

  // Self-heal: fix pinned version in daemon config
  fixDaemonVersionPin();

  // Stats
  const stats = getStats(db, dbPath);
  console.log(
    `[hicortex] Ready: ${stats.memories} memories, ${stats.links} links, ` +
    `${Math.round(stats.db_size_bytes / 1024)} KB`
  );

  // Auth token: from config file or HICORTEX_AUTH_TOKEN env var.
  // No hardcoded default — each server install generates its own token via init.
  // Localhost connections bypass auth regardless (unchanged).
  const authToken = (savedConfig?.authToken as string | undefined)
    ?? process.env.HICORTEX_AUTH_TOKEN;
  if (!authToken) {
    console.warn(
      "[hicortex] WARNING: no authToken configured — remote connections will be rejected " +
      "(localhost still works). Run `npx @gamaze/hicortex init` to generate a token."
    );
  }

  // Context layer (0.12): resolve which harnesses may inject the standing
  // context. Warn once per boot on unknown names so typos (e.g. "herms")
  // surface instead of silently dropping.
  const resolvedClients = resolveContextClients(savedConfig?.contextClients);
  contextClients = resolvedClients.clients;
  if (resolvedClients.dropped.length > 0) {
    console.warn(
      `[hicortex] Ignoring unknown contextClients: ${resolvedClients.dropped.join(", ")} ` +
      `(known: cc, hermes, oc)`
    );
  }

  // Per-agent context (0.13): resolve the config-declared modes. Warn once per
  // boot on dropped entries (bad key or bad mode) so typos surface. NOTE: this
  // map is boot-time; editing contextAgents needs a daemon restart. Dropping an
  // agents/<id> dir onto disk takes effect immediately (per-request presence).
  const resolvedAgents = resolveContextAgents(savedConfig?.contextAgents);
  contextAgents = resolvedAgents.agents;

  // #192 recall/decay alignment: decay speed + recall breadth + pushed-recall
  // knobs, ALL from config (see retrieval.ts configureRecall for the key list)
  // so calibration is a config edit + restart, never a release.
  retrieval.configureDecay({ halfLifeDays: savedConfig?.decayHalfLifeDays });
  const recallCfg = retrieval.configureRecall(savedConfig);
  const scoringCfg = retrieval.configureScoring(savedConfig);
  const sessionIntentCfg = retrieval.configureSessionIntent(savedConfig);
  console.log(
    `[hicortex] Recall: k=${recallCfg.searchLimit}/recent=${recallCfg.recentLimit}` +
    `/window=${recallCfg.recentWindowDays}d/cold=${recallCfg.coldExposureSlots} · ` +
    `score sim=${scoringCfg.similarity}/str=${scoringCfg.strength}/conn=${scoringCfg.connections}` +
    `/rec=${scoringCfg.recency}, fresh=${scoringCfg.freshnessBoostWeight}@${scoringCfg.freshnessBoostDays}d, ` +
    `superseded×${scoringCfg.supersededDemotion}` +
    `, intent w=${sessionIntentCfg.weight}` +
    (sessionIntentCfg.weight === 0 ? " (disabled)" : "")
  );
  recallRegistry = new SessionRecallRegistry({
    reshowTurns: savedConfig?.recallReshowTurns as number | undefined,
  });
  recallIndexOptions = {
    minSimilarity: savedConfig?.recallMinSimilarity as number | undefined,
    maxItems: savedConfig?.recallMaxItems as number | undefined,
    minPromptLength: savedConfig?.recallMinPromptChars as number | undefined,
    titleChars: savedConfig?.recallTitleChars as number | undefined,
  };
  memoryInstructionsEnabled = savedConfig?.memoryInstructions !== false;
  if (resolvedAgents.dropped.length > 0) {
    console.warn(
      `[hicortex] Ignoring invalid contextAgents entries: ${resolvedAgents.dropped.join(", ")} ` +
      `(keys must match ^[a-z0-9][a-z0-9_-]*$; modes must be override|global|off)`
    );
  }

  // Express app
  const app = express();
  // Raise the body limit — whole-session denoised transcripts exceed the 100 kB default.
  app.use(express.json({ limit: "25mb" }));

  // CORS: reflect ONLY explicitly-allowlisted origins (config.corsAllowedOrigins),
  // and never send Access-Control-Allow-Credentials. Reflecting any origin with
  // credentials — combined with the localhost auth bypass and the default 0.0.0.0
  // bind — let any web page the user visits read/mutate the memory store via
  // fetch() to localhost with no token (the browser connects from 127.0.0.1, so
  // the bypass grants access, and the reflected Allow-Origin let the page read the
  // response). The bundled UIs (/viz, /context/ui) are same-origin and need no CORS
  // headers at all; cross-origin access is opt-in per the hosted plan (#110 §2).
  // Must run before auth so allowlisted preflight OPTIONS get their headers.
  const corsAllowedOrigins = Array.isArray(savedConfig?.corsAllowedOrigins)
    ? (savedConfig!.corsAllowedOrigins as unknown[]).filter((o): o is string => typeof o === "string")
    : [];
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && corsAllowedOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization");
      res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  // Bearer token auth — ALWAYS installed, fail-closed. /health, OPTIONS, and
  // localhost bypass. With no token configured, remote requests are REJECTED
  // (not open): the default bind is 0.0.0.0, so "no token = no auth" would
  // expose the whole memory store to the network.
  // Extracted to viz.ts (createAuthMiddleware) so the middleware is
  // unit-testable; includes the narrow GET /viz?token= browser handoff (#124).
  console.log(
    authToken
      ? `[hicortex] Bearer token auth enabled`
      : `[hicortex] No auth token configured — remote access DISABLED (localhost only). Run init to generate a token.`
  );
  app.use(createAuthMiddleware(authToken));

  // SSE transport management — each connection gets its own McpServer instance
  const transports = new Map<string, SSEServerTransport>();

  // Health endpoint
  app.get("/health", (_req, res) => {
    const s = db ? getStats(db, dbPath) : { memories: 0, links: 0, db_size_bytes: 0, by_type: {} };
    res.json({
      status: "ok",
      version: VERSION,
      memories: s.memories,
      links: s.links,
      db_size_kb: Math.round(s.db_size_bytes / 1024),
      llm: llmConfig ? `${llmConfig.provider}/${llmConfig.model}` : "not configured",
    });
  });

  // REST /lessons — return lessons + memory index for client CLAUDE.md injection
  app.get("/lessons", (_req, res) => {
    if (!db) { res.status(503).json({ error: "Server not initialized" }); return; }
    try {
      const lessons = storage.getLessons(db, 30);
      const totalCount = storage.countMemories(db);

      // Project index
      const projects = db
        .prepare("SELECT project, COUNT(*) as cnt FROM memories WHERE project IS NOT NULL GROUP BY project ORDER BY cnt DESC LIMIT 10")
        .all() as Array<{ project: string; cnt: number }>;

      const sourceCount = (db.prepare("SELECT COUNT(DISTINCT source_agent) as cnt FROM memories").get() as { cnt: number }).cnt;
      const lessonCount = lessons.length;

      const state = loadState();
      res.json({
        lessons: lessons.map(l => ({
          content: l.content,
          created_at: l.created_at,
          base_strength: l.base_strength,
          access_count: l.access_count,
        })),
        index: {
          total: totalCount,
          lessonCount,
          sourceCount,
          projects: projects.map(p => ({ name: p.project, count: p.cnt })),
        },
        moduleIndex: state.moduleIndex ?? null,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // REST /ingest — accept pre-distilled memories from remote clients
  app.post("/ingest", async (req, res) => {
    if (!db) { res.status(503).json({ error: "Server not initialized" }); return; }

    const { content, source_agent, source_agent_id, source_domain, project, memory_type, privacy, source_session, session_date } = req.body ?? {};

    if (!content || typeof content !== "string") {
      res.status(400).json({ error: "Missing or invalid 'content' field" });
      return;
    }

    const validTypes = ["episode", "lesson", "fact", "decision"];
    if (memory_type && !validTypes.includes(memory_type)) {
      res.status(400).json({ error: `Invalid memory_type: ${memory_type}` });
      return;
    }

    // Dedup by source_session (idempotent — skip if already ingested)
    if (source_session) {
      const existing = (db.prepare(
        "SELECT COUNT(*) as cnt FROM memories WHERE source_session = ?"
      ).get(source_session) as { cnt: number });
      if (existing.cnt > 0) {
        res.status(200).json({ id: null, skipped: true, existing_count: existing.cnt });
        return;
      }
    }

    try {
      const embedding = await embed(content);
      const id = storage.insertMemory(db, content, embedding, {
        sourceAgent: source_agent ?? "remote-client",
        // Attribution + provenance passthrough (0.16.x); null when absent.
        sourceAgentId: typeof source_agent_id === "string" ? source_agent_id : null,
        sourceDomain: typeof source_domain === "string" ? source_domain : null,
        sourceSession: source_session ?? undefined,
        project: project ?? undefined,
        memoryType: memory_type ?? "episode",
        // 0.16.x: privacy defaults to null (vestigial column). A legacy client
        // that sends an explicit value is honored; absent → null.
        privacy: typeof privacy === "string" ? privacy : null,
        createdAt: session_date ? new Date(session_date).toISOString() : undefined,
      });
      res.status(201).json({ id, message: "Memory ingested" });
    } catch (err) {
      res.status(500).json({ error: "Ingestion failed", message: err instanceof Error ? err.message : String(err) });
    }
  });

  // REST /search — semantic search over the memory store.
  // Common recall path for adapters (Hermes prefetch, CC push-hook). Stateless GET.
  app.get("/search", async (req, res) => {
    if (!db) { res.status(503).json({ error: "Server not initialized" }); return; }
    const query = typeof req.query.query === "string" ? req.query.query.trim() : "";
    if (!query) { res.status(400).json({ error: "Missing 'query'" }); return; }
    // No hardcoded default: absent limit → config-driven (searchLimit).
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const project = typeof req.query.project === "string" && req.query.project ? req.query.project : undefined;
    // 0.16.x: `privacy` query param is ACCEPTED for backward compat (old
    // clients/plugins still send it) but no longer read — retrieval ignores
    // privacy entirely (the column is vestigial, never filtered).
    warnDeprecatedPrivacyParamIfPresent(req.query as Record<string, unknown>, "search");
    try {
      const results = await retrieval.retrieve(db, embed, query, { limit, project });
      res.json({ results });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // REST /recall-index — pushed recall index (#192). One recall logic for all
  // harnesses: CC UserPromptSubmit hook, Hermes/OC per-turn plugins. Returns a
  // compact index block (or null); exposure is recorded as shown_count +
  // last_accessed, NOT access_count (that stays reserved for hicortex_get /
  // GET /memory — real use). {reset: true} clears the session's dedup state
  // (SessionStart/compaction).
  app.post("/recall-index", async (req, res) => {
    if (!db) { res.status(503).json({ error: "Server not initialized" }); return; }
    const r = await handleRecallIndex(
      {
        db,
        registry: recallRegistry,
        // Client-pushed project/privacy scoping (F1) rides through to
        // retrieval, which handles the filtered over-fetch itself.
        // #192 session-intent keying (0.15.3): embed the prompt ONCE here,
        // blend with the session's rolling centroid, and pass the blended
        // vector to retrieve() via queryEmbedding so retrieve() does NOT
        // re-embed. Turn 1 (no centroid yet) and weight=0 both reduce to a
        // pure-prompt search (the kill-switch). The centroid is updated AFTER
        // reading the prior one — so turn 1 searches with pure prompt, then
        // seeds the centroid for turn 2+ to blend against.
        retrieveFn: async (query, limit, filters, sessionId) => {
          const { weight, alpha } = retrieval.getSessionIntent();
          const promptEmb = await embed(query);
          // weight=0 (kill-switch): the centroid is neither read nor written.
          const centroid = weight > 0 ? recallRegistry.getCentroid(sessionId) : undefined;
          const queryVec = retrieval.blendQueryVector(promptEmb, centroid, weight);
          if (weight > 0) recallRegistry.updateCentroid(sessionId, promptEmb, alpha);
          return retrieval.retrieve(db!, embed, query, {
            limit,
            noStrengthen: true,
            // #203: project + mission_domains are SOFT affinity (zero-boost
            // neutral), threaded into computeScore. 0.16.x: privacy is no
            // longer threaded (vestigial column, never filtered).
            project: filters?.project,
            missionDomains: filters?.mission_domains,
            queryEmbedding: queryVec,
          });
        },
        options: recallIndexOptions,
      },
      req.body
    );
    res.status(r.status).json(r.body);
  });

  // REST /memory?id= — fetch one memory's full content (lazy-load counterpart
  // of /recall-index for REST clients: Hermes/OC plugins). Marks it as used.
  // Prefix ids resolve. 0.16.x: the `privacy` query param is accepted but
  // ignored (column is vestigial, never filtered). Logic in handleMemoryGet.
  app.get("/memory", (req, res) => {
    if (!db) { res.status(503).json({ error: "Server not initialized" }); return; }
    warnDeprecatedPrivacyParamIfPresent(req.query as Record<string, unknown>, "memory");
    try {
      const r = handleMemoryGet(db, { id: req.query.id });
      res.status(r.status).json(r.body);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // REST /recent — recent memories, optionally filtered by project.
  app.get("/recent", (req, res) => {
    if (!db) { res.status(503).json({ error: "Server not initialized" }); return; }
    const project = typeof req.query.project === "string" && req.query.project ? req.query.project : undefined;
    // No hardcoded default: absent limit → config-driven (recentLimit).
    // 0.16.x: `privacy` query param accepted but ignored (vestigial column).
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    warnDeprecatedPrivacyParamIfPresent(req.query as Record<string, unknown>, "recent");
    try {
      const results = retrieval.searchRecent(db, { project, limit });
      res.json({ results });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // -------------------------------------------------------------------------
  // REST /context — standing context layer (0.12, spec 2026-07-12).
  //
  // GET  → { sections, updated_at, clients } read from <hicortex-home>/context/.
  // PUT  → partial upsert of named sections (allowlisted names, atomic).
  //
  // This is NOT recall. The recall endpoint that previously held this name is
  // now /recent (§Naming). Stale-client tripwire: old recall callers always
  // send project/limit/privacy query params; context-layer callers never do —
  // so those params on GET /context return a loud, self-explaining 400 instead
  // of silently degrading recall to an empty {sections} response.
  //
  // Auth is the standard model (bearer; localhost bypass) via the shared
  // middleware — no special-casing here.
  // -------------------------------------------------------------------------
  // Thin adapters: all logic (tripwire, validation, allowlist, atomicity,
  // symlink safety, size warn) lives in the pure handlers in context-store.ts,
  // which the tests exercise directly — no mirror-app drift.
  app.get("/context", (req, res) => {
    try {
      const r = handleContextGet(pathJoin(stateDir, "context"), contextClients, req.query as Record<string, unknown>, contextAgents);
      // #192: product-owned memory instructions ride as a synthetic read-only
      // `memory` section (config memoryInstructions !== false; agent mode
      // "off" respected inside the helper). Every harness renders it via the
      // shared section renderer — zero client changes.
      if (r.status === 200) {
        injectMemorySection(r.body as { sections?: Record<string, string>; mode?: string }, memoryInstructionsEnabled);
      }
      res.status(r.status).json(r.body);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.put("/context", (req, res) => {
    try {
      // Reserved product section: never writable, loud error (no silent skip).
      const putSections = (req.body as { sections?: Record<string, unknown> } | null)?.sections;
      if (putSections && Object.keys(putSections).some((n) => isReservedSectionName(n))) {
        res.status(400).json({ error: `Section name '${MEMORY_SECTION_NAME}' is reserved for the product-owned memory instructions (config memoryInstructions to disable them)` });
        return;
      }
      const r = handleContextPut(pathJoin(stateDir, "context"), req.body, req.query as Record<string, unknown>, contextAgents);
      if (r.warn) console.warn(`[hicortex] ${r.warn}`);
      res.status(r.status).json(r.body);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // REST /distill — canonical capture endpoint (0.9.0+).
  // Every machine (including the server itself) POSTs denoised session text here.
  // The server distills, embeds, stores. Body limit: 25 MB (raised at app init).
  //
  // Accepts text (string, preferred nightly path) OR messages (array, legacy).
  // Performs session-level dedup when session_id is present without segment_id.
  // Uses cached detectChunkSize per endpoint so the probe runs once per boot.
  app.post("/distill", async (req, res) => {
    if (!db) { res.status(503).json({ error: "Server not initialized" }); return; }
    if (!llm || !llmConfig) { res.status(503).json({ error: "No LLM configured — run npx @gamaze/hicortex init. Session will be retried." }); return; }

    const { text, messages, source_agent, source_agent_id, source_domain, project, session_id, segment_id, session_date, privacy } = req.body ?? {};

    // Resolve the conversation text from either the pre-denoised string or raw messages array.
    let conversationText: string;
    if (typeof text === "string" && text.length > 0) {
      conversationText = text;
    } else if (Array.isArray(messages) && messages.length > 0) {
      conversationText = extractConversationText(messages);
    } else {
      res.status(400).json({ error: "Provide either 'text' (string) or 'messages' (array)" });
      return;
    }

    // Segment-exact dedup (#189): an incremental capture POST carries
    // segment_id "<start>-<end>[.pN]". Skip iff THIS exact segment's chunks are
    // already stored (keys "<sid>#<segment_id>#<i>"). This is what lets a failed
    // segment be safely retried with the same id, and a legacy session-level row
    // (key "<sid>#<i>", no segment) does NOT match — so the #189 recovery
    // re-ingest is never blocked by night-1's whole-session rows.
    // ALSO consults dedup_log (#100): a merged-away loser's source_session
    // marker survives there after the `memories` row is deleted, so a
    // `hicortex dedup --apply` merge can't be undone by a retried/recaptured
    // segment silently re-ingesting the same content.
    if (session_id && segment_id) {
      const existingCount = countExistingSegment(db, session_id as string, segment_id as string);
      if (existingCount > 0) {
        res.status(200).json({ skipped: true, existing_count: existingCount });
        return;
      }
    }

    // Session-level dedup: when session_id is present and this is a whole-session
    // POST (no segment_id — legacy ≤0.13.1 clients), skip if any chunk of this
    // session is already stored (memories OR dedup_log — see above).
    // Unchanged: legacy clients keep exact behaviour.
    if (session_id && !segment_id) {
      const existingCount = countExistingSession(db, session_id as string);
      if (existingCount > 0) {
        res.status(200).json({ skipped: true, existing_count: existingCount });
        return;
      }
    }

    // Pre-flight the distill endpoint. In strict mode (default) a failed remote
    // probe returns "abort" immediately without mutating llmConfig — the nightly
    // watermark stays put so the session is re-shipped next run. In "local" mode
    // the config is mutated to fall back to the base model.
    const cfg = llmConfig;
    const distillFallbackStatus = await resolveDistillFallback(cfg, distillFallbackMode);
    if (distillFallbackStatus === "abort") {
      res.status(503).json({ error: "Distill endpoint unavailable — session will be retried next run" });
      return;
    }

    // Cache detectChunkSize per endpoint so we probe at most once per server boot.
    const effectiveProvider = cfg.distillProvider ?? cfg.provider;
    const effectiveModel = cfg.distillModel ?? cfg.model;
    const effectiveBaseUrl = cfg.distillBaseUrl ?? cfg.baseUrl;
    const cacheKey = `${effectiveProvider}/${effectiveModel}@${effectiveBaseUrl}`;
    if (!chunkSizeCache.has(cacheKey)) {
      chunkSizeCache.set(cacheKey, await detectChunkSize(effectiveProvider, effectiveModel, effectiveBaseUrl));
    }
    const chunkSize = chunkSizeCache.get(cacheKey)!;

    const date = typeof session_date === "string" && session_date ? session_date : new Date().toISOString().slice(0, 10);

    // Per-entry idempotency prefix for the legacy segment_id path.
    const sourcePrefix = session_id
      ? `${session_id as string}${segment_id ? `#${segment_id as string}` : ""}`
      : undefined;

    try {
      // Collect gate-dropped entries so they can ride back in the response and
      // land in the caller's file-persisted nightly log (#156 audit trail); the
      // server-side per-entry console.log in distillChunk stays as well.
      const dropped: string[] = [];
      const entries = await distillSession(llm, conversationText, project ?? "unknown", date, chunkSize, dropped);

      // Phase 1 — embed every chunk up front (async). If ANY embed fails we
      // never reach the insert, so nothing is stored.
      const createdAt = new Date(date).toISOString();
      const toStore: Array<{ entry: string; embedding: Float32Array; i: number }> = [];
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (typeof entry !== "string" || !entry.trim()) continue;
        toStore.push({ entry, embedding: await embed(entry), i });
      }

      // Phase 2 — insert all chunks in ONE transaction (fix 4). A segment's
      // chunks are all-or-nothing: any insert failure rolls back the whole set
      // and returns 500, so the content-blind segment-exact dedup never sees a
      // half-stored segment and the retry re-distills cleanly. (Applies to the
      // legacy whole-session path too — same loop.)
      const insertAll = db!.transaction((): string[] => {
        const out: string[] = [];
        for (const { entry, embedding, i } of toStore) {
          out.push(
            storage.insertMemory(db!, entry, embedding, {
              sourceAgent: source_agent ?? "unknown",
              // Attribution + provenance only (0.16.x): client-declared, never
              // filtered. Default null for older clients that don't send them.
              sourceAgentId: typeof source_agent_id === "string" ? source_agent_id : null,
              sourceDomain: typeof source_domain === "string" ? source_domain : null,
              // Per-chunk key: "<session_id>[#<segment_id>]#<i>". The prefix
              // matches the dedup checks above, so a re-run is idempotent.
              sourceSession: sourcePrefix ? `${sourcePrefix}#${i}` : undefined,
              project: project ?? undefined,
              memoryType: "episode",
              // 0.16.x: privacy defaults to null (vestigial column). A legacy
              // client that sends an explicit value is honored; absent → null.
              privacy: typeof privacy === "string" ? privacy : null,
              createdAt,
            }),
          );
        }
        return out;
      });
      const ids = insertAll();

      res.status(201).json({
        ids,
        distilled: ids.length,
        dropped: dropped.map((d) => (d.length > 120 ? `${d.slice(0, 120)}…` : d)),
      });
    } catch (err) {
      res.status(500).json({ error: "Distillation failed", message: err instanceof Error ? err.message : String(err) });
    }
  });

  // -------------------------------------------------------------------------
  // REST /update — update a memory (and re-embed when content changes).
  //
  // NOTE for #124: this endpoint returns the clean {updated: true, id} JSON
  // shape that the future /viz surface can consume directly — no MCP wrapping.
  // -------------------------------------------------------------------------
  app.post("/update", async (req, res) => {
    if (!db) { res.status(503).json({ error: "Server not initialized" }); return; }
    const { id, content, project, memory_type, privacy } = req.body ?? {};
    if (!id || typeof id !== "string") {
      res.status(400).json({ error: "Missing or invalid 'id' field" });
      return;
    }

    const fullId = resolveMemoryId(db, id);
    if (!fullId) {
      res.status(404).json({ error: `Memory not found: ${id}` });
      return;
    }

    const fields: Record<string, unknown> = {};
    if (content !== undefined) fields.content = content;
    if (project !== undefined) fields.project = project;
    if (memory_type !== undefined) fields.memory_type = memory_type;
    if (privacy !== undefined) fields.privacy = privacy;

    if (Object.keys(fields).length === 0) {
      res.status(400).json({ error: "No fields to update" });
      return;
    }

    const validTypes = ["episode", "lesson", "fact", "decision"];
    if (memory_type !== undefined && !validTypes.includes(memory_type)) {
      res.status(400).json({ error: `Invalid memory_type: ${memory_type}` });
      return;
    }

    try {
      storage.updateMemory(db, fullId, fields);

      // Re-embed when content changes
      if (content !== undefined) {
        const embedding = await embed(content);
        db.prepare("DELETE FROM memory_vectors WHERE id = ?").run(fullId);
        db.prepare("INSERT INTO memory_vectors (id, embedding) VALUES (?, ?)").run(
          fullId,
          Buffer.from(embedding.buffer)
        );
      }

      res.json({ updated: true, id: fullId });
    } catch (err) {
      res.status(500).json({ error: "Update failed", message: err instanceof Error ? err.message : String(err) });
    }
  });

  // -------------------------------------------------------------------------
  // REST /delete — permanently delete a memory and its links.
  //
  // NOTE for #124: returns {deleted: true, id} — clean JSON for future /viz.
  // -------------------------------------------------------------------------
  app.post("/delete", async (req, res) => {
    if (!db) { res.status(503).json({ error: "Server not initialized" }); return; }
    const { id } = req.body ?? {};
    if (!id || typeof id !== "string") {
      res.status(400).json({ error: "Missing or invalid 'id' field" });
      return;
    }

    const fullId = resolveMemoryId(db, id);
    if (!fullId) {
      res.status(404).json({ error: `Memory not found: ${id}` });
      return;
    }

    try {
      storage.deleteMemory(db, fullId);
      res.json({ deleted: true, id: fullId });
    } catch (err) {
      res.status(500).json({ error: "Delete failed", message: err instanceof Error ? err.message : String(err) });
    }
  });

  // -------------------------------------------------------------------------
  // REST /index — knowledge domain index (same payload as hicortex_index MCP).
  //
  // NOTE (#124): /viz consumes this JSON surface. Keep the response shape
  // clean: {domains} or {projects} fallback.
  // -------------------------------------------------------------------------
  app.get("/index", (_req, res) => {
    try {
      const state = loadState(stateDir);
      const moduleIndex = state.moduleIndex;
      if (moduleIndex && moduleIndex.domains && moduleIndex.domains.length > 0) {
        // domains[].memoryCount = PRIMARY-tag counts (unchanged). tagCounts is
        // additive: total assignments per tag across memory_tags (multi-label
        // breadth, incl. secondary tags). Absent when no tags exist yet.
        let tagCounts: Record<string, number> | undefined;
        if (db) {
          const tagRows = db.prepare(
            "SELECT tag, COUNT(*) as cnt FROM memory_tags GROUP BY tag ORDER BY cnt DESC",
          ).all() as Array<{ tag: string; cnt: number }>;
          if (tagRows.length > 0) {
            tagCounts = {};
            for (const r of tagRows) tagCounts[r.tag] = r.cnt;
          }
        }
        res.json(tagCounts ? { domains: moduleIndex.domains, tagCounts } : { domains: moduleIndex.domains });
        return;
      }
      // Fallback: flat project counts when moduleIndex is not yet built
      if (!db) { res.json({ domains: [] }); return; }
      const rows = db.prepare(
        "SELECT project, COUNT(*) as cnt FROM memories WHERE project IS NOT NULL GROUP BY project ORDER BY cnt DESC LIMIT 20"
      ).all() as Array<{ project: string; cnt: number }>;
      res.json({ projects: rows.map((r) => ({ name: r.project, count: r.cnt })) });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // -------------------------------------------------------------------------
  // REST /graph — knowledge graph query (same operations as hicortex_graph MCP).
  //
  // Supported ops: neighbors, hubs, path, export
  //   GET /graph?op=neighbors&id=<id>&limit=10&relationship=<rel>
  //   GET /graph?op=hubs&limit=10&domain=<domain>
  //   GET /graph?op=path&id=<from>&target_id=<to>
  //   GET /graph?op=export&domain=&type=&tag=&minStrength=&limit=  (#124: /viz data;
  //     tag= filters to nodes CARRYING the tag at any weight — graded-schema spec)
  //
  // NOTE (#124): this endpoint is the JSON surface consumed by /viz — op=export
  // returns the full {nodes, edges, domains, types, meta} payload the page
  // renders. The response shapes are intentionally clean ({results} for
  // neighbors/path, {hubs} for hubs) — do not add MCP-style text formatting.
  // -------------------------------------------------------------------------
  app.get("/graph", (req, res) => {
    if (!db) { res.status(503).json({ error: "Server not initialized" }); return; }
    const op = typeof req.query.op === "string" ? req.query.op : "";
    const VALID_OPS = ["neighbors", "hubs", "path", "export"];
    if (!VALID_OPS.includes(op)) {
      res.status(400).json({ error: `Invalid op: must be one of ${VALID_OPS.join(", ")}` });
      return;
    }

    const rawLimit = req.query.limit ? Number(req.query.limit) : undefined;
    // Floor + minimum 1: negative/fractional values would otherwise reach SQL
    // LIMIT (negative = unlimited in SQLite; fractional = binding error).
    const resultLimit = rawLimit && Number.isFinite(rawLimit) && rawLimit >= 1 ? Math.floor(rawLimit) : 10;
    const filterDomain = typeof req.query.domain === "string" && req.query.domain ? req.query.domain : undefined;
    const filterRelationship = typeof req.query.relationship === "string" && req.query.relationship ? req.query.relationship : undefined;

    try {
      if (op === "neighbors") {
        const idParam = typeof req.query.id === "string" ? req.query.id : "";
        if (!idParam) { res.status(400).json({ error: "id is required for neighbors operation" }); return; }
        const resolvedId = resolveMemoryId(db, idParam);
        if (!resolvedId) { res.status(404).json({ error: `Memory not found: ${idParam}` }); return; }
        const neighbors = getNeighbors(db, resolvedId, resultLimit, filterRelationship);
        res.json({ results: neighbors });
        return;
      }

      if (op === "hubs") {
        let hubs = detectHubs(db);
        if (filterDomain) {
          hubs = hubs.filter((h) => h.domain === filterDomain || h.project === filterDomain);
        }
        res.json({ hubs: hubs.slice(0, resultLimit) });
        return;
      }

      if (op === "path") {
        const fromParam = typeof req.query.id === "string" ? req.query.id : "";
        const toParam = typeof req.query.target_id === "string" ? req.query.target_id : "";
        if (!fromParam || !toParam) {
          res.status(400).json({ error: "id and target_id are required for path operation" });
          return;
        }
        const fromId = resolveMemoryId(db, fromParam);
        const toId = resolveMemoryId(db, toParam);
        if (!fromId || !toId) { res.status(404).json({ error: "One or both memory IDs not found" }); return; }
        const path = shortestPath(db, fromId, toId);
        res.json({ path: path ?? null });
        return;
      }

      if (op === "export") {
        const filterType = typeof req.query.type === "string" && req.query.type ? req.query.type : undefined;
        const filterTag = typeof req.query.tag === "string" && req.query.tag ? req.query.tag : undefined;
        let minStrength: number | undefined;
        if (req.query.minStrength !== undefined) {
          const v = Number(req.query.minStrength);
          if (!Number.isFinite(v) || v < 0 || v > 1) {
            res.status(400).json({ error: "minStrength must be a number between 0 and 1" });
            return;
          }
          minStrength = v;
        }
        // Export has its own default (EXPORT_DEFAULT_LIMIT) — the shared
        // resultLimit default of 10 is for neighbors/hubs. exportGraph clamps
        // to EXPORT_MAX_LIMIT.
        const exportLimit = rawLimit && Number.isFinite(rawLimit) ? rawLimit : EXPORT_DEFAULT_LIMIT;
        res.json(exportGraph(db, {
          domain: filterDomain,
          type: filterType,
          tag: filterTag,
          minStrength,
          limit: exportLimit,
        }));
        return;
      }
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // -------------------------------------------------------------------------
  // GET /viz — knowledge-graph visualization page (#124).
  //
  // Self-contained HTML (inline CSS/JS, zero external requests) served from
  // assets/viz.html. Fetches /graph?op=export from its own origin. The page
  // SHELL is public (exempted in createAuthMiddleware, like /health — it
  // carries no data); the /graph data fetch is bearer-only. The page collects
  // the token client-side: ?token= URL param (stripped on load) or an in-page
  // prompt on 401, persisted in localStorage.
  // -------------------------------------------------------------------------
  app.get("/viz", vizHandler());

  // GET /viz/vendor/:file — pinned renderer bundles for the /viz page (#139).
  //
  // STRICT allowlist (VIZ_VENDOR_FILES in viz.ts): only the exact vendored
  // filenames are served; everything else is 404. Public like the /viz shell
  // (static third-party code from the npm tarball, no data) — the exemption
  // lives in createAuthMiddleware next to the /viz one.
  app.get("/viz/vendor/:file", vizVendorHandler());

  // GET /context/ui — standing-context editor page (0.12, spec 2026-07-12 §5).
  //
  // The PRIMARY edit surface for the context layer. Self-contained HTML (inline
  // CSS/JS, zero external requests) served from assets/context.html; builds one
  // tab per section from GET /context and saves via PUT /context. The page
  // SHELL is public (exempted in createAuthMiddleware, like /viz — it carries
  // no data); the GET/PUT /context data calls stay bearer-only (localhost
  // bypass). The page collects the token client-side: ?token= URL param
  // (stripped on load) or an in-page prompt on 401, persisted in localStorage.
  app.get("/context/ui", contextUiHandler());

  // SSE endpoint — each connection gets its own McpServer + transport
  app.get("/sse", async (req, res) => {
    const transport = new SSEServerTransport("/messages", res);
    const mcpServer = createMcpServer();
    transports.set(transport.sessionId, transport);

    transport.onclose = () => {
      transports.delete(transport.sessionId);
    };

    try {
      await mcpServer.connect(transport);
    } catch (err) {
      transports.delete(transport.sessionId);
      if (!res.headersSent) res.status(500).json({ error: "MCP connect failed" });
    }
  });

  // Message endpoint — client POSTs MCP messages here
  app.post("/messages", async (req, res) => {
    const sessionId = req.query.sessionId as string | undefined;
    if (!sessionId || !transports.has(sessionId)) {
      res.status(400).json({ error: "Invalid or missing sessionId" });
      return;
    }
    const transport = transports.get(sessionId)!;
    try {
      // Pass parsed body since express.json() already consumed the stream
      await transport.handlePostMessage(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) res.status(500).json({ error: "Message handling failed" });
    }
  });

  // Start listening
  const server = app.listen(port, host, () => {
    console.log(`[hicortex] MCP server listening on http://${host}:${port}`);
    console.log(`[hicortex] SSE endpoint: http://${host}:${port}/sse`);
    console.log(`[hicortex] Health: http://${host}:${port}/health`);
    console.log(`[hicortex] Graph viz: http://${host}:${port}/viz`);
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `[hicortex] Port ${port} is already in use. ` +
        `Another Hicortex server or service may be running.\n` +
        `  Check: lsof -i :${port}\n` +
        `  Use a different port: npx @gamaze/hicortex server --port ${port + 1}`
      );
      process.exit(1);
    }
    throw err;
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log("[hicortex] Shutting down...");
    for (const transport of transports.values()) {
      transport.close().catch(() => {});
    }
    transports.clear();
    server.close(() => {
      if (db) {
        db.close();
        db = null;
      }
      console.log("[hicortex] Server stopped.");
      process.exit(0);
    });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a short ID prefix (e.g. "a1b2c3d4") to a full memory UUID.
 * Canonical implementation lives in storage.ts (shared with handleMemoryGet).
 */
const resolveMemoryId = storage.resolveMemoryId;

/**
 * Read ~/.hicortex/config.json (persisted by init with LLM and license config).
 * Routes through loadConfigStrict: a malformed existing file (bad JSON /
 * non-object / unreadable) emits a visible WARN then fails-soft to null; an
 * absent file (ENOENT) silently returns null. Without this routing the
 * agentId self-heal's throw would be unreachable from boot (the old swallow
 * → null → `if (savedConfig)` guard skipped it).
 */
function readConfigFile(stateDir: string): Record<string, unknown> | null {
  const configPath = pathJoin(stateDir, "config.json");
  let loaded: { config: Record<string, unknown>; hadFile: boolean };
  try {
    loaded = loadConfigStrict(configPath);
  } catch (e) {
    console.warn(
      `[hicortex] ${configPath} exists but could not be parsed — server booting degraded ` +
      `(config-driven LLM/decay/recall knobs and agentId self-heal will not apply). ` +
      `Fix the JSON and restart. Cause: ${e instanceof Error ? e.message : String(e)}`
    );
    return null;
  }
  return loaded.hadFile ? loaded.config : null;
}

/**
 * Self-heal: if the daemon plist/systemd unit has a pinned version
 * (e.g. @gamaze/hicortex@0.3.4), rewrite it to use the bare package
 * name so future restarts pick up the latest version automatically.
 */
function fixDaemonVersionPin(): void {
  try {
    const os = require("node:os") as typeof import("node:os");
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");

    if (os.platform() === "darwin") {
      const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", "com.gamaze.hicortex.plist");
      if (!fs.existsSync(plistPath)) return;
      const content = fs.readFileSync(plistPath, "utf-8");
      // Match @gamaze/hicortex@X.Y.Z (pinned to specific version)
      if (/@gamaze\/hicortex@\d+\.\d+\.\d+/.test(content)) {
        const fixed = content.replace(/@gamaze\/hicortex@\d+\.\d+\.\d+/, "@gamaze/hicortex");
        fs.writeFileSync(plistPath, fixed);
        console.log("[hicortex] Fixed daemon config: removed pinned version (will use latest on next restart)");
      }
    } else if (os.platform() === "linux") {
      const servicePath = path.join(os.homedir(), ".config", "systemd", "user", "hicortex.service");
      if (!fs.existsSync(servicePath)) return;
      const content = fs.readFileSync(servicePath, "utf-8");
      if (/@gamaze\/hicortex@\d+\.\d+\.\d+/.test(content)) {
        const fixed = content.replace(/@gamaze\/hicortex@\d+\.\d+\.\d+/, "@gamaze/hicortex");
        fs.writeFileSync(servicePath, fixed);
        console.log("[hicortex] Fixed daemon config: removed pinned version");
      }
    }
  } catch {
    // Non-fatal
  }
}

function formatResults(results: MemorySearchResult[]): string {
  if (results.length === 0) return "No memories found.";
  // The id makes every recall surface feed the rest of the toolset: cite-on-use
  // (id + date), hicortex_get lazy-load of truncated content, hicortex_graph
  // entry points, and hicortex_update/delete self-correction (#192).
  return results
    .map(
      (r) =>
        `[${r.id}] [${r.memory_type}] (${(r.created_at ?? "").slice(0, 10)}, score: ${r.score.toFixed(3)}, strength: ${r.effective_strength.toFixed(3)}) ${r.content.slice(0, 500)}`
    )
    .join("\n\n");
}
