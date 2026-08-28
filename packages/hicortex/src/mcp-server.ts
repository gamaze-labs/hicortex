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
import { resolveExplicitLlmConfig, applyTierTuningOverlay, LlmClient, findClaudeBinary, claudeCliConfig, type LlmConfig } from "./llm.js";
import { initFeatures } from "./features.js";
import { warnIgnoredConfigKeys, readStrictBoolean } from "./config-read.js";
import { localhostBypassEnabled, writeLocalhostBypassMarker } from "./localhost-bypass.js";
import { checkHostedBoot, shouldEmitBypassWarning } from "./hosted-boot.js";
import { initTokenBudget, isTokenBudgetExceeded, recordDistillUsage } from "./token-budget.js";
import { hicortexHome } from "./paths.js";
import { loadState, migrateLegacyState } from "./state.js";
import { embed, warmEmbedder } from "./embedder.js";
import * as storage from "./storage.js";
import { getNeighbors, shortestPath, detectHubs, exportGraph, EXPORT_DEFAULT_LIMIT } from "./graph.js";
import { createAuthMiddleware, vizHandler, vizVendorHandler, identityUiHandler, dashboardHandler } from "./viz.js";
import { dashboardDataHandler, accountHandler } from "./dashboard.js";
import {
  handleIdentityGet,
  handleIdentityPut,
  serveIdentityBody,
  resolveIdentityClientsConfig,
  resolveIdentityAgentsConfig,
  migrateIdentityDir,
  type AgentMode,
} from "./identity-store.js";
import * as retrieval from "./retrieval.js";
import { SessionRecallRegistry } from "./recall-registry.js";
import { isReservedSectionName, MEMORY_SECTION_NAME } from "./memory-instructions.js";
import { handleRecallIndex, handleMemoryGet, formatMemoryGetText, createRecallRetrieveFn, resolveNoveltyFloorSlots, type RecallIndexOptions } from "./recall-index.js";
import { labelForType, normalizeMemoryType, ACCEPTED_MEMORY_TYPES } from "./type-labels.js";
import { publicHealthResponse, detailedHealthResponse, logAndSendInternalError } from "./health.js";
import { injectSeedLesson } from "./seed-lesson.js";
import { buildIdentityToolResult } from "./learnings-identity.js";
import { extractConversationText, distillSession, detectChunkSize } from "./distiller.js";
import { countExistingSegment, countExistingSession } from "./dedup.js";
import { redact } from "./redact.js";
import { ensureAndPersistAgentId, loadConfigStrict } from "./init.js";
import type { MemorySearchResult } from "./types.js";

// ---------------------------------------------------------------------------
// Server state
// ---------------------------------------------------------------------------

let db: Database.Database | null = null;
let llm: LlmClient | null = null;
// llmConfig is module-level so the /distill handler can read numCtx without
// re-resolving on every request. null when no LLM is configured.
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
let stateDir = "";
// Resolved identityClients list (spec §2) — the harness names allowed to inject
// the standing identity layer. Echoed by GET /identity so each hook self-gates.
// (#264: was contextClients; the legacy key is still read with a one-time
// deprecation warning via resolveIdentityClientsConfig.)
let identityClients: string[] = ["cc"];
// Resolved identityAgents map (0.13) — agent id → mode (override/global/off).
// Read once at boot (like identityClients); the drop-in-a-dir presence path is
// per-request, so only explicit config entries need a daemon restart to apply.
let identityAgents: Record<string, AgentMode> = {};
// Pushed-recall dedup registry (#192) + options; configured at boot.
let recallRegistry = new SessionRecallRegistry();
let recallIndexOptions: RecallIndexOptions = {};
// Product-owned memory instructions (#192): on unless config says false.
let memoryInstructionsEnabled = true;

// Cache detectChunkSize results keyed by "<provider>/<model>@<baseUrl>" so we
// probe each endpoint once per server boot rather than once per /distill request.
const chunkSizeCache = new Map<string, number>();

// #337: /distill readiness-probe outcomes, keyed like chunkSizeCache. The
// daemon probes the GENERATION path (one 1-token completion) before
// distilling — liveness-style endpoint checks cannot catch the incident
// signature (a wedged gateway that keeps answering /v1/models while every
// completion hangs). Outcomes are cached for llmProbeTtlMs (default 5 min),
// so a healthy capture cadence pays at most one probe per window and a DEAD
// endpoint turns into fast cached 503s instead of every request paying the
// probe timeout. Module-scoped like chunkSizeCache (state spans requests).
const distillProbeCache = new Map<string, { ok: boolean; at: number }>();

/**
 * Resolve the /distill probe gate (#337): true when the endpoint recently
 * proved it can GENERATE (cached outcome inside its TTL, or a fresh probe),
 * false when the probe failed — the caller answers 503 so the capture client
 * holds its cursor and retries next run (nothing lost, dup-over-loss).
 * Structural `llm` parameter (anything with probe()) so wiring tests drive
 * the real cache + TTL discipline with a counting stub.
 */
export async function resolveDistillProbeGate(
  llm: { probe(timeoutMs?: number): Promise<boolean> },
  llmConfig: { provider: string; model: string; baseUrl: string; probeTtlMs?: number },
): Promise<boolean> {
  const key = `${llmConfig.provider}/${llmConfig.model}@${llmConfig.baseUrl}`;
  const ttlMs = llmConfig.probeTtlMs ?? 300_000;
  const cached = distillProbeCache.get(key);
  if (cached && Date.now() - cached.at < ttlMs) return cached.ok;
  const ok = await llm.probe();
  distillProbeCache.set(key, { ok, at: Date.now() });
  return ok;
}

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
    "Store a new memory in long-term storage. Use for Knowledge, Decisions, or Learnings.",
    {
      content: z.string().describe("Memory content to store"),
      project: z.string().optional().describe("Project this memory belongs to"),
      memory_type: z.enum(["knowledge", "experience", "decisions", "learnings", "fact", "episode", "decision", "lesson"]).optional().describe("Type of memory (default: Experience). Accepted: Knowledge/Experience/Decisions/Learnings (legacy raw enum also accepted, normalized to the canonical term)."),
    },
    async ({ content, project, memory_type }) => {
      if (!db) return { content: [{ type: "text" as const, text: "Hicortex not initialized" }], isError: true };
      try {
        const embedding = await embed(content);
        const id = storage.insertMemory(db, content, embedding, {
          sourceAgent: "claude-code/manual",
          project,
          // Normalize legacy raw enum to the canonical term the DB stores.
          memoryType: memory_type ? normalizeMemoryType(memory_type) : "experience",
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
      memory_type: z.enum(["knowledge", "experience", "decisions", "learnings", "fact", "episode", "decision", "lesson"]).optional().describe("New memory type. Accepted: Knowledge/Experience/Decisions/Learnings (legacy raw enum also accepted, normalized to the canonical term)."),
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
        // Normalize legacy raw enum to canonical human terms before DB write.
        if (memory_type !== undefined) fields.memory_type = normalizeMemoryType(memory_type);

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

  // -- hicortex_learnings (canonical) + hicortex_lessons (alias) --
  const learningsHandler = async ({ days, project }: { days?: number; project?: string }) => {
    if (!db) return { content: [{ type: "text" as const, text: "Hicortex not initialized" }], isError: true };
    try {
      const lessons = storage.getLessons(db, days ?? 7, project);
      if (lessons.length === 0) {
        return { content: [{ type: "text" as const, text: "No Learnings found for the specified period." }] };
      }
      const text = lessons.map((l) => `- ${l.content.slice(0, 500)}`).join("\n");
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Learnings fetch failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  };
  const learningsSchema = {
    days: z.coerce.number().optional().describe("Look back N days (default 7)"),
    project: z.string().optional().describe("Filter by project name"),
  };
  server.tool(
    "hicortex_learnings",
    "Get actionable Learnings from past sessions. Auto-generated insights about mistakes to avoid.",
    learningsSchema,
    learningsHandler
  );
  server.tool(
    "hicortex_lessons",
    "Get actionable Learnings from past sessions. (Alias for hicortex_learnings.)",
    learningsSchema,
    learningsHandler
  );

  // -- hicortex_identity --
  // Standing identity layer on-demand (the same data GET /identity returns and
  // the SessionStart hook injects). Lets an agent re-read its identity after
  // context compaction, or look up one named section, mid-session. Renders the
  // same `### <Title>` section markdown the hook injects (shared pipeline in
  // learnings-identity.ts → buildIdentityToolResult) so the agent sees one
  // consistent shape. The handler is a thin wrapper over that pure function;
  // tests exercise it directly (no MCP SDK plumbing re-implemented).
  server.tool(
    "hicortex_identity",
    "Fetch your standing identity — the hand-edited 'who you are + how you work' layer (personality, rules, preferences). Returns all sections or a specific one. Use this to re-read your identity after context compaction or to look up a specific rule. On multi-agent installs, pass `agent` to fetch a specific agent's scoped identity; omit for the global identity.",
    {
      name: z.string().optional().describe("Fetch a specific identity section by name (e.g. 'rules'). Omit for all sections."),
      agent: z.string().optional().describe("Fetch a specific agent's identity scope (for per-agent installs). Omit for global."),
    },
    async ({ name, agent }: { name?: string; agent?: string }) => {
      if (!db) return { content: [{ type: "text" as const, text: "Hicortex not initialized" }], isError: true };
      try {
        const identityDir = pathJoin(stateDir, "identity");
        // Single pipeline shared with REST /identity + the SessionStart hook
        // (#264 CRITICAL + WARNING-1 + WARNING-2). The pure function owns
        // handleIdentityGet → serveIdentityBody → renderIdentityBlock.
        const result = buildIdentityToolResult(identityDir, identityClients, identityAgents, {
          name,
          agent,
          memoryInstructionsEnabled,
        });
        return { content: [{ type: "text" as const, text: result.text }], isError: result.isError };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Identity fetch failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
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
          const head = `**${d.name}** (${d.memoryCount} memories, ${d.lessonCount} Learnings)`;
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

/**
 * Env override for the body limit (#328 item 2b — hosted tenant-immutable
 * pin, same ENV-WINS pattern as HICORTEX_TOKEN_CAP in token-budget.ts). The
 * hosted tenant's /data is tenant-writable, so a `distillBodyLimitMb` in the
 * tenant's own config.json could raise the limit the provider intended; an
 * env baked into the container (`-e`, provisioner-written .env) cannot be
 * mutated by the tenant process. Self-hosted installs may also use it as an
 * operator knob — precedence below puts it above config in every mode.
 */
const DISTILL_BODY_LIMIT_MB_ENV = "HICORTEX_DISTILL_BODY_LIMIT_MB";

/**
 * Resolve the request body-size limit in MB (#7, #328 item 2b). Pure —
 * exported for tests. Precedence: HICORTEX_DISTILL_BODY_LIMIT_MB env >
 * explicit config value > hosted-mode default (5) > self-hosted default (25,
 * the historical fixed value → no regression). A finite positive value wins
 * at each step; invalid/absent falls through.
 */
export function resolveBodyLimitMb(configVal: unknown, hostedMode: boolean): number {
  const envCap = Number(process.env[DISTILL_BODY_LIMIT_MB_ENV]);
  if (Number.isFinite(envCap) && envCap > 0) return envCap;
  const cfg = Number(configVal);
  if (Number.isFinite(cfg) && cfg > 0) return cfg;
  return hostedMode ? 5 : 25;
}

/**
 * Express error middleware (#7): translate express.json's default HTML 413
 * (entity.too.large) into a consistent JSON response. Catches body-parser
 * errors only — which express.json emits BEFORE any route runs — so by
 * registration order (this sits ahead of the routes) it never intercepts an
 * error thrown inside a route handler; those reach Express's default handler.
 * The `status === 413 || type === "entity.too.large"` check is defense-in-depth
 * on top of that ordering. Exported so tests exercise the real handler.
 */
export function makeBodyLimitErrorHandler(limitMb: number): express.ErrorRequestHandler {
  return (err, _req, res, next) => {
    const status = (err as { status?: number }).status;
    const type = (err as { type?: string }).type;
    if (status === 413 || type === "entity.too.large") {
      res.status(413).json({ error: "request body too large", limit_mb: limitMb });
      return;
    }
    next(err);
  };
}

/**
 * #328 item 4 (package-server half, CR-corrected ORDERING): a Content-Length
 * pre-check that MUST be registered BEFORE express.json. Registered after the
 * parser (the first #328 pass had it inside createAuthMiddleware, which sits
 * after the parser) it is inert as a bounding measure — body-parser buffers
 * the body up to its own limit BEFORE auth runs and refuses oversize itself,
 * so the check only ever saw bodies the parser had already accepted and
 * buffered. Registered FIRST it refuses a DECLARED-oversize body before a
 * single byte is read and before any route/auth work, on every path. The
 * twin check inside createAuthMiddleware (viz.ts) is kept as a belt — but the
 * GATE here is the one that actually bounds pre-auth buffering.
 *
 * RESIDUAL RISK (deliberate, documented): chunked transfer-encoding sends no
 * Content-Length, so this gate cannot see it — those requests still buffer up
 * to the parser limit inside express.json (bounded per request, no
 * concurrency cap here). Full pre-auth bounding lives in the hosted router's
 * webhook path (stripe.ts); the tenant data plane trusts its bearer
 * (self-hosted threat model) or sits behind the provider's edge (hosted).
 */
export function makeContentLengthGate(limitBytes: number): express.RequestHandler {
  return (req, res, next) => {
    const declared = req.headers["content-length"];
    const declaredNum = typeof declared === "string" ? Number(declared) : NaN;
    if (Number.isFinite(declaredNum) && declaredNum > limitBytes) {
      res.status(413).json({ error: "request body too large" });
      return;
    }
    next();
  };
}

export async function startServer(options: {
  port?: number;
  host?: string;
  dbPath?: string;
  licenseKey?: string;
} = {}): Promise<void> {
  const port = options.port ?? 8787;
  const host = options.host ?? "0.0.0.0";

  // ---------------------------------------------------------------------------
  // Hosted-mode boot gate (#110 §1-§2, #271 — Phase 0B).
  //
  // MUST run BEFORE resolveDbPath/initDb: in hosted mode with HICORTEX_DB_PATH
  // set, the server must refuse the attacker-chosen DB location WITHOUT first
  // touching it. The hosted signals (hostedMode from config, bypassMarkerPresent
  // from the marker file) do NOT depend on the DB, so reading them now is safe.
  // CR warning 3: this block was previously after initDb, letting a hostile
  // HICORTEX_DB_PATH create/touch a file at the chosen path before the gate.
  //
  // CR warning 1: the marker is a HOME-level file (like config.json, written by
  // init to HICORTEX_HOME). Read it from hicortexHome() — NOT stateDir, which
  // is dirname(dbPath) and drifts when HICORTEX_DB_PATH relocates the DB. The
  // config key hostedMode likewise lives at <hicortexHome>/config.json.
  //
  // Decision logic lives in hosted-boot.ts (pure, unit-tested); the side-effect
  // (console.error + process.exit) is local to boot. The marker state is
  // captured once here and reused below to gate the localhost bypass in
  // createAuthMiddleware (no per-request stat). CR warning 4: the upgrade-path
  // warning is decided by the pure shouldEmitBypassWarning helper (behavior-
  // tested), not an inline branch.
  const bootConfig = readConfigFile(hicortexHome());
  const hostedMode = readStrictBoolean(bootConfig ?? {}, "hostedMode") === true;
  let bypassMarkerPresent = localhostBypassEnabled();
  const bootDecision = checkHostedBoot({
    hostedMode,
    dbPathEnvSet: !!process.env.HICORTEX_DB_PATH,
    bypassMarkerPresent,
  });
  if (!bootDecision.ok) {
    console.error(bootDecision.message);
    process.exit(1);
  }
  // Upgrade migration (CR S1): self-hosted server-mode CC MCP registration
  // carries NO bearer token (init.ts:192 — only client-mode adds the header),
  // so it relies entirely on the localhost bypass. An existing install that
  // upgrades without re-running init has no marker → the bypass silently
  // disappears → every server-mode CC MCP call 401s. Auto-write the marker on
  // first post-upgrade boot in self-hosted mode to preserve the prior
  // unconditional-bypass behaviour. Hosted mode is untouched: checkHostedBoot
  // refuses to start with a marker present, so this block — gated on
  // !hostedMode — never runs for a hosted tenant. bypassMarkerPresent is
  // reassigned so createAuthMiddleware below gates the bypass for THIS boot
  // too (the file write and the in-memory flag stay in sync).
  if (!hostedMode && !bypassMarkerPresent) {
    writeLocalhostBypassMarker(hicortexHome());
    bypassMarkerPresent = true;
    console.log("[hicortex] Localhost auth-bypass marker written (upgrade migration).");
  }
  const bypassWarning = shouldEmitBypassWarning(hostedMode, bypassMarkerPresent);
  if (bypassWarning) {
    console.warn(bypassWarning);
  }

  // Initialize core
  const dbPath = resolveDbPath(options.dbPath);
  console.log(`[hicortex] Initializing database at ${dbPath}`);
  db = initDb(dbPath);
  stateDir = require("node:path").dirname(dbPath);

  // LLM config: explicit config only — no silent harness auto-detection.
  // Named backends (claude-cli, ollama) → immediate config; everything else
  // goes through resolveExplicitLlmConfig which requires a user-chosen provider.
  // If nothing is configured: start recall-only with an unmissable warning.
  // One model serves all phases (#231) — no per-tier overlay here.
  const savedConfig = readConfigFile(stateDir);
  // 0.16.8 upgrade guard: per-stage keys are silently ignored now. Warn loudly
  // so a carried-over distill/reflect model doesn't silently downgrade quality.
  warnIgnoredConfigKeys(savedConfig);
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
  // #5: token-budget enforcement. Mode-agnostic — gates on cap > 0. Self-hosted
  // uses config llmTokensPerMonth (default 0 = off); hosted uses HICORTEX_TOKEN_CAP
  // env (provider-set, tenant-immutable) which takes precedence. Initialised here
  // (after stateDir + savedConfig are known) so the warn-dedup can seed from state.
  initTokenBudget(stateDir, savedConfig?.llmTokensPerMonth);
  // #7: request body-size limit. Env (HICORTEX_DISTILL_BODY_LIMIT_MB) wins;
  // else the config key; else 5 MB hosted / 25 MB self-hosted (the prior
  // fixed value → no regression). Guards the OOM vector (the body is fully
  // parsed into memory before the distiller truncates to 80K chars).
  // Legitimate capture segments are ≤60K chars (~200KB), so this never
  // constrains real flow — it's an abuse/backstop. Oversized → 413.
  // #328 item 2b: in HOSTED mode the env is the provider's tenant-immutable
  // pin — the tenant-writable /data/config.json must not be able to raise it.
  const bodyLimitMb = resolveBodyLimitMb(savedConfig?.distillBodyLimitMb, hostedMode);
  // Label the source truthfully (token-budget.ts pattern): only claim env
  // when the env value was actually used (a malformed env falls through).
  if (Number(process.env.HICORTEX_DISTILL_BODY_LIMIT_MB) === bodyLimitMb) {
    console.log(`[hicortex] Body limit: ${bodyLimitMb} MB (HICORTEX_DISTILL_BODY_LIMIT_MB env — overrides config)`);
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
      provider: "ollama",
    };
  } else {
    llmConfig = resolveExplicitLlmConfig({
      llmBaseUrl: savedConfig?.llmBaseUrl as string | undefined,
      llmApiKey: savedConfig?.llmApiKey as string | undefined,
      llmModel: savedConfig?.llmModel as string | undefined,
    });
  }

  if (llmConfig) {
    // Tuning (#220: maxTokens + enableThinking + numCtx + flush), validated +
    // copied via the shared overlay (also applied in resolveSavedLlmConfig for
    // the nightly). Wrong-typed values warn + drop.
    applyTierTuningOverlay(llmConfig, savedConfig as Record<string, unknown> | null);
    llm = new LlmClient(llmConfig);
    console.log(`[hicortex] LLM (one model, all phases): ${llmConfig.provider}/${llmConfig.model}`);
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
  // Optional rotation-grace token (#254): config-only (no env var — rotation is
  // an explicit, deliberate op). When set, both tokens are accepted so client
  // reconfiguration never causes failed requests.
  const authTokenPrevious = savedConfig?.authTokenPrevious as string | undefined;

  // Identity layer (0.12; renamed from context layer in 0.18 #264): resolve
  // which harnesses may inject the standing identity. Warn once per boot on
  // unknown names so typos (e.g. "herms") surface instead of silently dropping.
  const resolvedClients = resolveIdentityClientsConfig(savedConfig);
  identityClients = resolvedClients.clients;
  if (resolvedClients.legacy) {
    console.warn(
      "[hicortex] Config uses the legacy 'contextClients' key — renamed to 'identityClients' in 0.18 (#264). " +
      "The legacy key still works; update your config to silence this warning."
    );
  }
  if (resolvedClients.dropped.length > 0) {
    console.warn(
      `[hicortex] Ignoring unknown identityClients: ${resolvedClients.dropped.join(", ")} ` +
      `(known: cc, hermes, oc)`
    );
  }

  // Per-agent identity (0.13): resolve the config-declared modes. Warn once per
  // boot on dropped entries (bad key or bad mode) so typos surface. NOTE: this
  // map is boot-time; editing identityAgents needs a daemon restart. Dropping an
  // agents/<id> dir onto disk takes effect immediately (per-request presence).
  const resolvedAgents = resolveIdentityAgentsConfig(savedConfig);
  identityAgents = resolvedAgents.agents;
  if (resolvedAgents.legacy) {
    console.warn(
      "[hicortex] Config uses the legacy 'contextAgents' key — renamed to 'identityAgents' in 0.18 (#264). " +
      "The legacy key still works; update your config to silence this warning."
    );
  }

  // #192 recall/decay alignment: decay speed + recall breadth + pushed-recall
  // knobs, ALL from config (see retrieval.ts configureRecall for the key list)
  // so calibration is a config edit + restart, never a release.
  retrieval.configureDecay({ halfLifeDays: savedConfig?.decayHalfLifeDays });
  const recallCfg = retrieval.configureRecall(savedConfig);
  const scoringCfg = retrieval.configureScoring(savedConfig);
  const sessionIntentCfg = retrieval.configureSessionIntent(savedConfig);
  console.log(
    `[hicortex] Recall: k=${recallCfg.searchLimit}/recent=${recallCfg.recentLimit}` +
    `/window=${recallCfg.recentWindowDays}d/cold=${recallCfg.coldExposureSlots}` +
    `/novelty=${resolveNoveltyFloorSlots(savedConfig?.noveltyFloorSlots, savedConfig?.recallMaxItems)}` +
    ` · ` +
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
    // #324 novelty floor: slots of recallMaxItems guaranteed to the
    // pure-prompt (unblended) search's top passing hit(s). 0 disables.
    noveltyFloorSlots: savedConfig?.noveltyFloorSlots as number | undefined,
  };
  memoryInstructionsEnabled = savedConfig?.memoryInstructions !== false;
  if (resolvedAgents.dropped.length > 0) {
    console.warn(
      `[hicortex] Ignoring invalid identityAgents entries: ${resolvedAgents.dropped.join(", ")} ` +
      `(keys must match ^[a-z0-9][a-z0-9_-]*$; modes must be override|global|off)`
    );
  }

  // #264 dir migration: rename <hicortex-home>/context/ → identity/ on boot
  // when only the legacy dir exists. The fallback read in identity-store.ts
  // (readSectionsWithFallback) is the safety net for a partial/no migration.
  const idMig = migrateIdentityDir(stateDir);
  if (idMig.renamed) {
    console.log(`[hicortex] Migrated identity dir: ${idMig.from} → ${idMig.to}`);
  } else if (idMig.reason && idMig.reason !== "no legacy context/ dir" && !idMig.reason.startsWith("identity/ already exists")) {
    console.warn(`[hicortex] Identity dir migration skipped: ${idMig.reason}`);
  }

  // Express app
  const app = express();
  // #328 item 4: the Content-Length pre-check MUST precede express.json (the
  // parser buffers unauthenticated bodies up to its own limit; refusing the
  // DECLARED oversize first bounds that). See makeContentLengthGate.
  app.use(makeContentLengthGate(bodyLimitMb * 1024 * 1024));
  // Raise the body limit — whole-session denoised transcripts exceed the 100 kB default.
  app.use(express.json({ limit: `${bodyLimitMb}mb` }));
  // #7: JSON 413 on body-limit exceed (see makeBodyLimitErrorHandler). Server-side
  // only — the client capture loop treats 413 like any non-2xx (holds cursor);
  // it never fires for legitimate capture (segments ≤200KB ≪ the limit).
  app.use(makeBodyLimitErrorHandler(bodyLimitMb));

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
  // Root → dashboard redirect (#249). Registered BEFORE the auth middleware so
  // the redirect itself is public — it carries no data; the destination
  // /dashboard has its own shell-exemption pattern. Gives the console one entry
  // point: http://<host>:8787/ → /dashboard.
  app.get("/", (_req, res) => res.redirect("/dashboard"));

  app.use(createAuthMiddleware(authToken, authTokenPrevious, bypassMarkerPresent, bodyLimitMb * 1024 * 1024));

  // SSE transport management — each connection gets its own McpServer instance
  const transports = new Map<string, SSEServerTransport>();

  // Health endpoint — PUBLIC minimal probe. Unauthenticated (the auth
  // middleware exempts /health) and carries NO data: just liveness for load
  // balancers, watchdogs, and anonymous probers. Tenant/install BI (memory
  // count, link count, DB size, version, the full LLM backend string) lives
  // on /health/detail, which is auth-gated (localhost bypasses auth so
  // co-located tooling — `hicortex status`, nightly preflight, `init` detect
  // — sees it without a token). #253 — spec 2026-07-27-hosted-service §6.
  app.get("/health", (_req, res) => {
    res.json(publicHealthResponse());
  });

  // Operator-only diagnostics. Goes through the standard auth middleware
  // (not in the public-path exemption list in viz.ts); localhost bypasses
  // auth, remote needs the bearer token. Keeps the public LB/watchdog path
  // cheap (no COUNT(*)) and the diagnostics off the public surface.
  app.get("/health/detail", (_req, res) => {
    const s = db ? getStats(db, dbPath) : { memories: 0, links: 0, db_size_bytes: 0, by_type: {} };
    res.json(
      detailedHealthResponse({
        memories: s.memories,
        links: s.links,
        dbSizeBytes: s.db_size_bytes,
        version: VERSION,
        llmLabel: llmConfig ? `${llmConfig.provider}/${llmConfig.model}` : "not configured",
      }),
    );
  });

  // REST /learnings (canonical, #264) + /lessons (alias) — return lessons +
  // memory index for client CLAUDE.md injection. Both routes share ONE handler
  // so the alias can never drift from the canonical shape. The legacy name is
  // kept indefinitely (existing SessionStart hooks literally fetch /lessons).
  const learningsIndexHandler = (_req: express.Request, res: express.Response): void => {
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
      logAndSendInternalError(res, "learnings", err);
    }
  };
  app.get("/learnings", learningsIndexHandler);
  app.get("/lessons", learningsIndexHandler); // #264 backcompat alias

  // REST /ingest — accept pre-distilled memories from remote clients
  app.post("/ingest", async (req, res) => {
    if (!db) { res.status(503).json({ error: "Server not initialized" }); return; }

    const { content, source_agent, source_agent_id, source_domain, project, memory_type, privacy, source_session, session_date } = req.body ?? {};

    if (!content || typeof content !== "string") {
      res.status(400).json({ error: "Missing or invalid 'content' field" });
      return;
    }

    const validTypes = ACCEPTED_MEMORY_TYPES;
    if (memory_type && !validTypes.includes(memory_type)) {
      res.status(400).json({ error: `Invalid memory_type: ${memory_type}` });
      return;
    }
    // Normalize legacy raw enum (fact/episode/decision/lesson) to the
    // canonical term the DB stores (knowledge/experience/decisions/learnings).
    // Canonical values pass through unchanged.
    const normalizedType = memory_type ? normalizeMemoryType(memory_type) : memory_type;

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
        memoryType: normalizedType ?? "experience",
        // 0.16.x: privacy defaults to null (vestigial column). A legacy client
        // that sends an explicit value is honored; absent → null.
        privacy: typeof privacy === "string" ? privacy : null,
        createdAt: session_date ? new Date(session_date).toISOString() : undefined,
      });
      res.status(201).json({ id, message: "Memory ingested" });
    } catch (err) {
      res.status(500).json({ error: "Ingestion failed" });
      console.error(`[hicortex] /ingest: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
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
      logAndSendInternalError(res, "search", err);
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
    // Client-pushed project/privacy scoping (F1) rides through to retrieval,
    // which handles the filtered over-fetch itself. The search closure itself
    // lives in recall-index.ts (createRecallRetrieveFn): per-request prompt
    // embed memo (ONE embed for the blended + pure-prompt searches), the
    // session-intent centroid blend/EMA fold via retrieval.recallQueryVector
    // (#192 session-intent keying, 0.15.3), and the #324 pure-prompt branch
    // that searches unblended and touches no centroid state. Extracted so the
    // exact behavior is unit-testable without HTTP (blendQueryVector
    // precedent); this adapter stays thin.
    const r = await handleRecallIndex(
      {
        db,
        registry: recallRegistry,
        retrieveFn: createRecallRetrieveFn({
          db,
          registry: recallRegistry,
          embedFn: embed,
        }),
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
      logAndSendInternalError(res, "memory", err);
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
      logAndSendInternalError(res, "recent", err);
    }
  });

  // -------------------------------------------------------------------------
  // REST /identity — standing identity layer (0.12, spec 2026-07-12; renamed
  // from /context in 0.18 #264).
  //
  // GET  → { sections, updated_at, clients } read from <hicortex-home>/identity/.
  // PUT  → partial upsert of named sections (allowlisted names, atomic).
  //
  // This is NOT recall. The recall endpoint that previously held the /context
  // name is now /recent (§Naming). Stale-client tripwire: old recall callers
  // always send project/limit/privacy query params; identity-layer callers
  // never do — so those params on GET /identity return a loud, self-explaining
  // 400 instead of silently degrading recall to an empty {sections} response.
  //
  // Auth is the standard model (bearer; localhost bypass) via the shared
  // middleware — no special-casing here.
  // -------------------------------------------------------------------------
  // Thin adapters: all logic (tripwire, validation, allowlist, atomicity,
  // symlink safety, size warn) lives in the pure handlers in identity-store.ts,
  // which the tests exercise directly — no mirror-app drift.
  //
  // #264 backcompat: GET/PUT /context remain mounted BELOW as aliases that
  // route to the SAME handlers (Hermes/OC plugins and pre-0.18 clients keep
  // working unchanged). Both endpoints read/write the SAME identity dir.
  const identityDir = pathJoin(stateDir, "identity");

  app.get("/identity", (req, res) => {
    try {
      // serveIdentityBody (#192 + #313): the ONE composition — synthetic
      // product-owned `memory` section, then the SECTION_PRECEDENCE wire
      // order. Shared with GET /context and the MCP hicortex_identity tool so
      // every surface serves byte-identical ordering.
      const r = serveIdentityBody(
        handleIdentityGet(identityDir, identityClients, req.query as Record<string, unknown>, identityAgents),
        memoryInstructionsEnabled,
      );
      res.status(r.status).json(r.body);
    } catch (err) {
      logAndSendInternalError(res, "identity", err);
    }
  });

  app.put("/identity", (req, res) => {
    try {
      // Reserved product section: never writable, loud error (no silent skip).
      const putSections = (req.body as { sections?: Record<string, unknown> } | null)?.sections;
      if (putSections && Object.keys(putSections).some((n) => isReservedSectionName(n))) {
        res.status(400).json({ error: `Section name '${MEMORY_SECTION_NAME}' is reserved for the product-owned memory instructions (config memoryInstructions to disable them)` });
        return;
      }
      const r = handleIdentityPut(identityDir, req.body, req.query as Record<string, unknown>, identityAgents);
      if (r.warn) console.warn(`[hicortex] ${r.warn}`);
      res.status(r.status).json(r.body);
    } catch (err) {
      logAndSendInternalError(res, "identity", err);
    }
  });

  // #264 backcompat aliases: /context → /identity handlers (same dir, same
  // clients/agents). Kept indefinitely so external callers (the Hermes plugin,
  // pre-0.18 OC clients, operator scripts) never break. The dir is "identity"
  // in BOTH aliases — the rename + migration is server-side; clients see no
  // difference in behaviour, only the URL.
  app.get("/context", (req, res) => {
    try {
      // Same serveIdentityBody composition as GET /identity — the alias
      // serves byte-equal behaviour by construction.
      const r = serveIdentityBody(
        handleIdentityGet(identityDir, identityClients, req.query as Record<string, unknown>, identityAgents),
        memoryInstructionsEnabled,
      );
      res.status(r.status).json(r.body);
    } catch (err) {
      logAndSendInternalError(res, "context", err);
    }
  });

  app.put("/context", (req, res) => {
    try {
      const putSections = (req.body as { sections?: Record<string, unknown> } | null)?.sections;
      if (putSections && Object.keys(putSections).some((n) => isReservedSectionName(n))) {
        res.status(400).json({ error: `Section name '${MEMORY_SECTION_NAME}' is reserved for the product-owned memory instructions (config memoryInstructions to disable them)` });
        return;
      }
      const r = handleIdentityPut(identityDir, req.body, req.query as Record<string, unknown>, identityAgents);
      if (r.warn) console.warn(`[hicortex] ${r.warn}`);
      res.status(r.status).json(r.body);
    } catch (err) {
      logAndSendInternalError(res, "context", err);
    }
  });

  // REST /distill — canonical capture endpoint (0.9.0+).
  // Every machine (including the server itself) POSTs denoised session text here.
  // The server distills, embeds, stores. Body limit: see `distillBodyLimitMb`
  // (default 25 MB self-hosted / 5 MB hosted); oversized → 413 (#7).
  //
  // Accepts text (string, preferred nightly path) OR messages (array, legacy).
  // Performs session-level dedup when session_id is present without segment_id.
  // Uses cached detectChunkSize per endpoint so the probe runs once per boot.
  app.post("/distill", async (req, res) => {
    if (!db) { res.status(503).json({ error: "Server not initialized" }); return; }
    if (!llm || !llmConfig) { res.status(503).json({ error: "No LLM configured — run npx @gamaze/hicortex init. Session will be retried." }); return; }

    const { text, messages, source_agent, source_agent_id, source_domain, project, session_id, segment_id, session_date, privacy } = req.body ?? {};

    // Resolve the conversation text from either the pre-denoised string or raw messages array.
    // `fromTextBranch` is captured once so the redaction gate below uses the SAME
    // discriminator as the resolution (avoids re-redacting the messages-derived
    // text in the `{text: "", messages: [...]}` edge case — harmless only because
    // redaction is idempotent, but the comment/code must agree).
    const fromTextBranch = typeof text === "string" && text.length > 0;
    let conversationText: string;
    if (fromTextBranch) {
      conversationText = text;
    } else if (Array.isArray(messages) && messages.length > 0) {
      // The messages branch already redacts via extractConversationText
      // (distiller.ts), which calls redact() as its final step.
      conversationText = extractConversationText(messages);
    } else {
      res.status(400).json({ error: "Provide either 'text' (string) or 'messages' (array)" });
      return;
    }

    // SERVER-SIDE REDACTION (#252): scrub secrets/PII from the text branch
    // BEFORE it reaches the distillation LLM or storage. Client-side redaction
    // (capture.ts) is customer-disableable; a processor cannot base a privacy
    // claim on scrubbing the caller can switch off, and unredacted secrets
    // would reach the LLM subprocessor. Unconditional + idempotent — safe for
    // self-hosted too (a second pass over already-redacted text is a no-op;
    // the [REDACTED] marker is excluded by the generic_secret pattern's
    // negative lookahead, and format-specific patterns don't match it). The
    // messages branch is already covered above. Disable-resistance
    // (hostedMode) is Phase 0b.
    if (fromTextBranch) {
      const { text: redacted, count } = redact(conversationText);
      if (count > 0) {
        console.log(`[hicortex] Redacted ${count} secret(s) from /distill text`);
      }
      conversationText = redacted;
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

    // #337: readiness gate — cached minimal generation probe BEFORE
    // detectChunkSize + distillSession, so a dead endpoint never even pays the
    // chunk-size probe. Placed AFTER the dedup short-circuits (a duplicate
    // costs nothing and must not trip the gate). On failure: 503 with the
    // diagnosis — the capture client treats non-201/200 as transient and holds
    // its cursor (capture.ts), so the segment is retried next run, never lost.
    if (!(await resolveDistillProbeGate(llm, llmConfig))) {
      res.status(503).json({ error: "LLM endpoint not generating — session will be retried" });
      return;
    }

    // Cache detectChunkSize per endpoint so we probe at most once per server boot.
    // numCtx is passed so chunk size derives from the request's ACTUAL context
    // window (#231, #228) — the chunker and the request agree by construction.
    const cacheKey = `${llmConfig.provider}/${llmConfig.model}@${llmConfig.baseUrl}`;
    if (!chunkSizeCache.has(cacheKey)) {
      chunkSizeCache.set(cacheKey, await detectChunkSize(llmConfig.provider, llmConfig.model, llmConfig.baseUrl, llmConfig.numCtx));
    }
    const chunkSize = chunkSizeCache.get(cacheKey)!;

    const date = typeof session_date === "string" && session_date ? session_date : new Date().toISOString().slice(0, 10);

    // Per-entry idempotency prefix for the legacy segment_id path.
    const sourcePrefix = session_id
      ? `${session_id as string}${segment_id ? `#${segment_id as string}` : ""}`
      : undefined;

    // #5: declared outside the try so the finally can record tokens spent even
    // when distillSession throws partway through (the LLM calls already happened).
    let distillUsage = { prompt: 0, completion: 0, total: 0 };
    try {
      // #5: token-budget gate — refuse (429) BEFORE the LLM call if the tenant is
      // already at/over the monthly cap. Placed after the dedup short-circuits so
      // a skipped duplicate neither trips the gate nor consumes budget. The client
      // capture loop holds its cursor on 429 (dup-over-loss, capture.ts:303).
      if (isTokenBudgetExceeded(stateDir)) {
        res.status(429).json({ error: "token budget exceeded", retry: "next billing period" });
        return;
      }
      // Collect gate-dropped entries so they can ride back in the response and
      // land in the caller's file-persisted nightly log (#156 audit trail); the
      // server-side per-entry console.log in distillChunk stays as well.
      const dropped: string[] = [];
      const entries = await distillSession(
        llm, conversationText, project ?? "unknown", date, chunkSize, dropped,
        (u) => {
          distillUsage.prompt += u.prompt_tokens ?? 0;
          distillUsage.completion += u.completion_tokens ?? 0;
          distillUsage.total += u.total_tokens ?? 0;
        },
        // #339: identify this POST in the NO_EXTRACT over-firing warning —
        // segment_id (incremental capture), else session_id (legacy), else none.
        typeof segment_id === "string" && segment_id
          ? segment_id
          : typeof session_id === "string" && session_id
            ? session_id
            : undefined,
      );

      // Phase 1 — embed every chunk up front (async). If ANY embed fails we
      // never reach the insert, so nothing is stored.
      const createdAt = new Date(date).toISOString();
      const toStore: Array<{ content: string; memoryType: string; embedding: Float32Array; i: number }> = [];
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (typeof entry !== "object" || !entry.content || !entry.content.trim()) continue;
        toStore.push({
          content: entry.content,
          memoryType: entry.memoryType,
          embedding: await embed(entry.content),
          i,
        });
      }

      // Phase 2 — insert all chunks in ONE transaction (fix 4). A segment's
      // chunks are all-or-nothing: any insert failure rolls back the whole set
      // and returns 500, so the content-blind segment-exact dedup never sees a
      // half-stored segment and the retry re-distills cleanly. (Applies to the
      // legacy whole-session path too — same loop.)
      const insertAll = db!.transaction((): string[] => {
        const out: string[] = [];
        for (const { content, memoryType, embedding, i } of toStore) {
          out.push(
            storage.insertMemory(db!, content, embedding, {
              sourceAgent: source_agent ?? "unknown",
              // Attribution + provenance only (0.16.x): client-declared, never
              // filtered. Default null for older clients that don't send them.
              sourceAgentId: typeof source_agent_id === "string" ? source_agent_id : null,
              sourceDomain: typeof source_domain === "string" ? source_domain : null,
              // Per-chunk key: "<session_id>[#<segment_id>]#<i>". The prefix
              // matches the dedup checks above, so a re-run is idempotent.
              sourceSession: sourcePrefix ? `${sourcePrefix}#${i}` : undefined,
              project: project ?? undefined,
              // #216: the distiller now classifies each entry as
              // experience/knowledge/decisions via the [E]/[K]/[D] tag parsed in
              // distiller.ts. Pre-#216 distiller output (no tag) defaults to
              // experience in the parser, so this is backward compatible.
              memoryType,
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
        // #287: this segment's metered usage — the same breakdown
        // recordDistillUsage accrues below. Lets the capturing nightly
        // attribute distill tokens in its dashboard snapshot
        // (new_this_run.tokens_by_stage.distill). Always present (zeros when
        // no chunk reached an LLM call); pre-#287 clients ignore it.
        usage: distillUsage,
      });
    } catch (err) {
      res.status(500).json({ error: "Distillation failed" });
      console.error(`[hicortex] /distill: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    } finally {
      // #5: record tokens spent against the monthly budget — in finally so a
      // mid-distil throw (some chunks' LLM calls already happened) still counts.
      // No-op when cap=0 (enforcement off) or distillUsage.total=0 (gate refused
      // / no chunk reached an LLM call).
      if (distillUsage.total > 0) recordDistillUsage(stateDir, distillUsage);
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
    if (privacy !== undefined) fields.privacy = privacy;

    // Validate + normalize memory_type BEFORE adding to `fields` so the
    // empty-fields check below correctly counts a memory_type-only update.
    const validTypes = ACCEPTED_MEMORY_TYPES;
    if (memory_type !== undefined && !validTypes.includes(memory_type)) {
      res.status(400).json({ error: `Invalid memory_type: ${memory_type}` });
      return;
    }
    // Normalize legacy raw enum (fact/episode/decision/lesson) to the
    // canonical term the DB stores (knowledge/experience/decisions/learnings).
    // Canonical values pass through unchanged.
    if (memory_type !== undefined) fields.memory_type = normalizeMemoryType(memory_type);

    if (Object.keys(fields).length === 0) {
      res.status(400).json({ error: "No fields to update" });
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
      res.status(500).json({ error: "Update failed" });
      console.error(`[hicortex] /update: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
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
      res.status(500).json({ error: "Delete failed" });
      console.error(`[hicortex] /delete: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
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
      logAndSendInternalError(res, "index", err);
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
      logAndSendInternalError(res, "graph", err);
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

  // GET /identity/ui — standing-identity editor page (0.12, spec 2026-07-12 §5;
  // renamed from /context/ui in 0.18 #264).
  //
  // The PRIMARY edit surface for the identity layer. Self-contained HTML (inline
  // CSS/JS, zero external requests) served from assets/identity.html; builds one
  // tab per section from GET /identity and saves via PUT /identity. The page
  // SHELL is public (exempted in createAuthMiddleware, like /viz — it carries
  // no data); the GET/PUT /identity data calls stay bearer-only (localhost
  // bypass). The page collects the token client-side: ?token= URL param
  // (stripped on load) or an in-page prompt on 401, persisted in localStorage.
  // #264 backcompat: /context/ui remains mounted below as an alias.
  app.get("/identity/ui", identityUiHandler());
  app.get("/context/ui", identityUiHandler());

  // GET /dashboard — view-only memory analytics page (#224).
  //
  // Self-contained HTML (inline CSS/JS, hand-rolled inline SVG charts, zero
  // external requests) served from assets/dashboard.html. Fetches
  // /dashboard/data from its own origin. The page SHELL is public (exempted
  // in createAuthMiddleware, like /viz and /context/ui — it carries no data);
  // the /dashboard/data fetch is bearer-only (localhost bypass). The page
  // collects the token client-side: ?token= URL param (stripped on load) or an
  // in-page prompt on 401, persisted in localStorage.
  app.get("/dashboard", dashboardHandler());

  // GET /dashboard/data — the metric payload (series, composition, digest).
  // Bearer-only (the auth middleware is installed at app boot); no separate
  // exemption. The handler lives in src/dashboard.ts (pure); this is the thin
  // express adapter that injects the live db + config. STRICTLY view-only —
  // no mutation endpoints on the dashboard surface.
  app.get("/dashboard/data", dashboardDataHandler(
    () => db!,
    () => readConfigFile(stateDir),
  ));

  // GET /account — account identity for the console nav (name/org/plan from
  // config). The LIGHTWEIGHT twin of the account block inside /dashboard/data:
  // the /viz and /identity/ui pages need only this, not the metric payload;
  // also the natural whoami for the future OAuth session (#292). Bearer-only
  // (standard auth middleware, no shell exemption — it carries data); localhost
  // bypass applies. Handler lives in src/dashboard.ts next to its twin.
  app.get("/account", accountHandler(
    () => readConfigFile(stateDir),
  ));

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

  // #329 item 2: warm the embedder NOW, in the background. The ONNX pipeline
  // lazy-loads inside the first embed() (~0.5-3s cold) — without this, the
  // first /recall-index after every restart paid that load inside its own
  // latency budget and the 1s client hook failed soft (silent recall loss).
  // Fire-and-forget AFTER listen: never blocks boot, never fatal (a failed
  // warm-up just logs once; the next real embed lazy-loads as before).
  //
  // HOSTED MEMORY IMPLICATION (accepted, #329 CR finding 3): this makes the
  // embedding model (~150-300MB resident) load in EVERY tenant container from
  // boot, idle tenants included — previously an idle tenant never loaded it.
  // Accepted for the current single-tenant-VPS sizing: containers run under
  // 2g caps, and any ACTIVE tenant loaded the model on first use anyway. If
  // tenant density grows, revisit (e.g. warm on first authenticated request
  // instead of boot). Capacity math: hosted/README.md (TENANT_MEMORY_LIMIT).
  warmEmbedder(embed);
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

export function formatResults(results: MemorySearchResult[]): string {
  if (results.length === 0) return "No memories found.";
  // The id makes every recall surface feed the rest of the toolset: cite-on-use
  // (id + date), hicortex_get lazy-load of truncated content, hicortex_graph
  // entry points, and hicortex_update/delete self-correction (#192).
  return results
    .map(
      (r) =>
        `[${r.id}] [${labelForType(r.memory_type)}] (${(r.created_at ?? "").slice(0, 10)}, score: ${r.score.toFixed(3)}, strength: ${r.effective_strength.toFixed(3)}) ${r.content.slice(0, 500)}`
    )
    .join("\n\n");
}
