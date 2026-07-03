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
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import type Database from "better-sqlite3";

import { initDb, getStats, resolveDbPath } from "./db.js";
import { resolveExplicitLlmConfig, LlmClient, findClaudeBinary, claudeCliConfig, resolveDistillFallback, type LlmConfig } from "./llm.js";
import { initFeatures } from "./features.js";
import { loadState, migrateLegacyState } from "./state.js";
import { embed } from "./embedder.js";
import * as storage from "./storage.js";
import { getNeighbors, shortestPath, detectHubs } from "./graph.js";
import * as retrieval from "./retrieval.js";
import { injectSeedLesson } from "./seed-lesson.js";
import { extractConversationText, distillSession, detectChunkSize } from "./distiller.js";
import type { MemorySearchResult } from "./types.js";

// ---------------------------------------------------------------------------
// Server state
// ---------------------------------------------------------------------------

let db: Database.Database | null = null;
let llm: LlmClient | null = null;
// llmConfig is module-level so the /distill handler can call resolveDistillFallback
// without having to read config on every request. null when no LLM is configured.
let llmConfig: LlmConfig | null = null;
// distillFallbackMode controls whether a failed remote distill endpoint causes an
// immediate abort ("strict", default) or a fallback to the base model ("local").
let distillFallbackMode: "strict" | "local" = "strict";
let stateDir = "";

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
    "Search long-term memory using semantic similarity. Returns the most relevant memories from past sessions.",
    {
      query: z.string().describe("Search query text"),
      limit: z.coerce.number().optional().describe("Max results (default 5)"),
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

  // -- hicortex_context --
  server.tool(
    "hicortex_context",
    "Get recent context memories, optionally filtered by project. Useful to recall what happened recently.",
    {
      project: z.string().optional().describe("Filter by project name"),
      limit: z.coerce.number().optional().describe("Max results (default 10)"),
    },
    async ({ project, limit }) => {
      if (!db) return { content: [{ type: "text" as const, text: "Hicortex not initialized" }], isError: true };
      try {
        const results = retrieval.searchContext(db, { project, limit });
        return { content: [{ type: "text" as const, text: formatResults(results) }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Context search failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
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
          privacy: "WORK",
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
        const text = moduleIndex.domains.map((d) =>
          `**${d.name}** (${d.memoryCount} memories, ${d.lessonCount} lessons)\n` +
          `  Projects: ${d.projects.join(", ")}` +
          (d.keywords.length > 0 ? `\n  Keywords: ${d.keywords.join(", ")}` : "")
        ).join("\n\n");
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
      relationship: z.string().optional().describe("Filter neighbors by relationship type (e.g., CONTRADICTS, SUPERSEDES, derives)"),
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
  const savedConfig = readConfigFile(stateDir);
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
    console.warn("║  search / lessons / context: ENABLED                        ║");
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

  // Express app
  const app = express();
  // Raise the body limit — whole-session denoised transcripts exceed the 100 kB default.
  app.use(express.json({ limit: "25mb" }));

  // CORS: must be before auth so preflight OPTIONS requests get proper headers
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization");
      res.setHeader("Access-Control-Allow-Credentials", "true");
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
  console.log(
    authToken
      ? `[hicortex] Bearer token auth enabled`
      : `[hicortex] No auth token configured — remote access DISABLED (localhost only). Run init to generate a token.`
  );
  app.use((req, res, next) => {
    if (req.path === "/health") return next();
    const ip = req.ip ?? req.socket.remoteAddress ?? "";
    if (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1") return next();
    if (authToken && req.headers.authorization === `Bearer ${authToken}`) return next();
    res.status(401).json({
      error: authToken
        ? "Unauthorized"
        : "No auth token configured on this server — run `npx @gamaze/hicortex init` on the server, then connect with its token.",
    });
  });

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

    const { content, source_agent, project, memory_type, privacy, source_session, session_date } = req.body ?? {};

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
        sourceSession: source_session ?? undefined,
        project: project ?? undefined,
        memoryType: memory_type ?? "episode",
        privacy: privacy ?? "WORK",
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
    const limit = req.query.limit ? Number(req.query.limit) : 5;
    const project = typeof req.query.project === "string" && req.query.project ? req.query.project : undefined;
    const privacy = typeof req.query.privacy === "string" && req.query.privacy
      ? req.query.privacy.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;
    try {
      const results = await retrieval.retrieve(db, embed, query, { limit, project, privacy });
      res.json({ results });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // REST /context — recent context memories, optionally filtered by project.
  app.get("/context", (req, res) => {
    if (!db) { res.status(503).json({ error: "Server not initialized" }); return; }
    const project = typeof req.query.project === "string" && req.query.project ? req.query.project : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : 10;
    const privacy = typeof req.query.privacy === "string" && req.query.privacy
      ? req.query.privacy.split(",").map((s) => s.trim()).filter(Boolean)
      : undefined;
    try {
      const results = retrieval.searchContext(db, { project, limit, privacy });
      res.json({ results });
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

    const { text, messages, source_agent, project, session_id, segment_id, session_date, privacy } = req.body ?? {};

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

    // Session-level dedup: when session_id is present and this is a whole-session
    // POST (no segment_id), skip if any chunk of this session is already stored.
    if (session_id && !segment_id) {
      // Escape LIKE wildcards — Hermes ids contain "_" (e.g. 20260701_045744_...).
      const likePrefix = `${(session_id as string).replace(/[\\%_]/g, (m) => "\\" + m)}#%`;
      const existing = (db.prepare(
        "SELECT COUNT(*) as c FROM memories WHERE source_session = ? OR source_session LIKE ? ESCAPE '\\'"
      ).get(session_id, likePrefix) as { c: number });
      if (existing.c > 0) {
        res.status(200).json({ skipped: true, existing_count: existing.c });
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
      const entries = await distillSession(llm, conversationText, project ?? "unknown", date, chunkSize);
      const ids: string[] = [];
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (typeof entry !== "string" || !entry.trim()) continue;
        const embedding = await embed(entry);
        const id = storage.insertMemory(db, entry, embedding, {
          sourceAgent: source_agent ?? "unknown",
          // Per-chunk key: "<session_id>#<i>". The prefix matches the nightly
          // dedup check above, so a re-run of the same session is fully idempotent.
          sourceSession: sourcePrefix ? `${sourcePrefix}#${i}` : undefined,
          project: project ?? undefined,
          memoryType: "episode",
          privacy: privacy ?? "WORK",
          createdAt: new Date(date).toISOString(),
        });
        ids.push(id);
      }
      res.status(201).json({ ids, distilled: ids.length });
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
  // NOTE for #124: this is the JSON surface that /viz will later consume.
  // Keep the response shape clean: {domains} or {projects} fallback.
  // -------------------------------------------------------------------------
  app.get("/index", (_req, res) => {
    try {
      const state = loadState(stateDir);
      const moduleIndex = state.moduleIndex;
      if (moduleIndex && moduleIndex.domains && moduleIndex.domains.length > 0) {
        res.json({ domains: moduleIndex.domains });
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
  // Supported ops: neighbors, hubs, path
  //   GET /graph?op=neighbors&id=<id>&limit=10&relationship=<rel>
  //   GET /graph?op=hubs&limit=10&domain=<domain>
  //   GET /graph?op=path&id=<from>&target_id=<to>
  //
  // NOTE for #124 (/viz): this endpoint IS the JSON surface that /viz will
  // reuse for its graph visualisation. The response shape is intentionally
  // clean ({results} for neighbors/path, {hubs} for hubs) so /viz can consume
  // it without transformation. Do not add MCP-style text formatting here.
  // -------------------------------------------------------------------------
  app.get("/graph", (req, res) => {
    if (!db) { res.status(503).json({ error: "Server not initialized" }); return; }
    const op = typeof req.query.op === "string" ? req.query.op : "";
    const VALID_OPS = ["neighbors", "hubs", "path"];
    if (!VALID_OPS.includes(op)) {
      res.status(400).json({ error: `Invalid op: must be one of ${VALID_OPS.join(", ")}` });
      return;
    }

    const rawLimit = req.query.limit ? Number(req.query.limit) : undefined;
    const resultLimit = rawLimit && Number.isFinite(rawLimit) ? rawLimit : 10;
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
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

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
 */
function resolveMemoryId(database: Database.Database, idPrefix: string): string | null {
  if (idPrefix.length >= 36) {
    // Full UUID — check existence
    const row = database.prepare("SELECT id FROM memories WHERE id = ?").get(idPrefix) as { id: string } | undefined;
    return row?.id ?? null;
  }
  // Short prefix — find matching memory
  const rows = database.prepare("SELECT id FROM memories WHERE id LIKE ?").all(`${idPrefix}%`) as { id: string }[];
  if (rows.length === 1) return rows[0].id;
  if (rows.length > 1) return null; // Ambiguous
  return null;
}

/**
 * Read ~/.hicortex/config.json (persisted by init with LLM and license config).
 */
function readConfigFile(stateDir: string): Record<string, unknown> | null {
  try {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const { join } = require("node:path") as typeof import("node:path");
    const configPath = join(stateDir, "config.json");
    return JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return null;
  }
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
  return results
    .map(
      (r) =>
        `[${r.memory_type}] (score: ${r.score.toFixed(3)}, strength: ${r.effective_strength.toFixed(3)}) ${r.content.slice(0, 500)}`
    )
    .join("\n\n");
}
