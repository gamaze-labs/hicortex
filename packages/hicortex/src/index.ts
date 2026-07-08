/**
 * Hicortex OpenClaw Plugin — Long-term Memory That Learns. (0.10.0)
 *
 * Thin-client model: the plugin requires a Hicortex server (co-located at
 * http://127.0.0.1:8787 by default, or a remote URL via `serverUrl` config).
 * No local database, no local LLM, no embedder, no consolidation scheduler.
 *
 * Install once: `openclaw plugins install @gamaze/hicortex`
 * Run server:   `npx @gamaze/hicortex init`
 *
 * Responsibilities (recall-only adapter, like the Hermes plugin):
 *   - before_agent_start  → GET /lessons (fail-soft, 3s timeout) → inject context
 *   - Tools               → HTTP proxies to /search, /context, /ingest, /lessons
 *
 * CAPTURE IS NOT THIS PLUGIN'S JOB. OpenClaw persists sessions at
 * ~/.openclaw/agents/<agentId>/sessions/*.jsonl in the Pi v3 format; the
 * machine's Hicortex nightly reads them via oc-transcript-reader.ts —
 * canonical nightly-from-logs, same as CC JSONL and Hermes state.db.
 */

import { initFeatures, lessonsLimit } from "./features.js";
import { getLessonSelector } from "./extensions.js";
import { loadState } from "./state.js";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { HicortexConfig, MemorySearchResult, ModuleIndex } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_SERVER_URL = "http://127.0.0.1:8787";
const LESSONS_TIMEOUT_MS = 3000;
const HICORTEX_HOME = join(homedir(), ".hicortex");

// ---------------------------------------------------------------------------
// Module state — initialized in registerService.start()
// ---------------------------------------------------------------------------

let serverUrl = DEFAULT_SERVER_URL;
let authToken: string | undefined;
let hicortexHome = HICORTEX_HOME;

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function authHeaders(): Record<string, string> {
  return authToken ? { Authorization: `Bearer ${authToken}` } : {};
}

async function serverGet<T>(path: string, timeoutMs: number): Promise<T | null> {
  try {
    const resp = await fetch(`${serverUrl}${path}`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return null;
    return await resp.json() as T;
  } catch {
    return null;
  }
}

async function serverPost<T>(
  path: string,
  body: unknown,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; data: T | null }> {
  try {
    const resp = await fetch(`${serverUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let data: T | null = null;
    try { data = await resp.json() as T; } catch { /* non-JSON body */ }
    return { ok: resp.ok, status: resp.status, data };
  } catch (err) {
    return { ok: false, status: 0, data: null };
  }
}

// ---------------------------------------------------------------------------
// Shared response type for /lessons API
// ---------------------------------------------------------------------------

interface LessonsApiResponse {
  lessons: Array<{ content: string; created_at: string; base_strength: number; access_count: number }>;
  index: { total: number; lessonCount: number; sourceCount: number; projects: Array<{ name: string; count: number }> };
  moduleIndex?: ModuleIndex;
}

// ---------------------------------------------------------------------------
// Tool result formatter
// ---------------------------------------------------------------------------

function formatToolResults(
  results: MemorySearchResult[],
): { content: Array<{ type: string; text: string }> } {
  if (results.length === 0) {
    return { content: [{ type: "text", text: "No memories found." }] };
  }
  const text = results
    .map(
      (r) =>
        `[${r.memory_type}] (score: ${r.score.toFixed(3)}, strength: ${r.effective_strength.toFixed(3)}) ${r.content.slice(0, 500)}`,
    )
    .join("\n\n");
  return { content: [{ type: "text", text }] };
}

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------

export default {
  id: "hicortex",
  name: "Hicortex — Long-term Memory That Learns",
  kind: "lifecycle" as const,

  register(api: any) {
    // -----------------------------------------------------------------------
    // Background service: resolve config, verify server, init features
    // -----------------------------------------------------------------------
    api.registerService({
      id: "hicortex-service",

      async start(ctx: any) {
        const config = (ctx.config ?? {}) as HicortexConfig;
        const log = ctx.logger
          ? (msg: string) => ctx.logger.info(msg)
          : console.log;

        // Resolve server URL and auth token from plugin config
        serverUrl = (config.serverUrl ?? DEFAULT_SERVER_URL).replace(/\/+$/, "");
        authToken = config.authToken;
        // Use stateDir from context so tests can redirect state writes
        hicortexHome = ctx.stateDir ?? HICORTEX_HOME;

        log(`[hicortex] Thin-client mode — server: ${serverUrl}`);

        // License: init feature cache (only needs licenseKey, no DB access)
        await initFeatures(config.licenseKey, hicortexHome);

        // Verify server reachability at startup (non-fatal — warn only)
        try {
          const resp = await fetch(`${serverUrl}/health`, {
            signal: AbortSignal.timeout(5000),
          });
          if (resp.ok) {
            const data = await resp.json() as Record<string, unknown>;
            log(`[hicortex] Server OK: v${data.version}, ${data.memories} memories`);
          } else {
            log(`[hicortex] Server returned HTTP ${resp.status} — capture and tools may fail`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log(
            `[hicortex] WARNING: Server unreachable at ${serverUrl}: ${msg}. ` +
            `Run \`npx @gamaze/hicortex init\` to start the server. ` +
            `Capture and tool calls will fail until the server is available.`,
          );
        }

        ensureToolsAllowed(log);
      },

      async stop() {
        // Nothing to clean up — no DB, no LLM, no timer
      },
    });

    // -----------------------------------------------------------------------
    // Hook: before_agent_start — fetch lessons from server (fail-soft)
    // -----------------------------------------------------------------------
    api.on(
      "before_agent_start",
      async (
        _event: { prompt: string },
        ctx: { agentId?: string; project?: string },
      ) => {
        try {
          // One fetch — build context and check cap from the same response.
          const data = await serverGet<LessonsApiResponse>("/lessons", LESSONS_TIMEOUT_MS);
          if (!data || !data.lessons || data.lessons.length === 0) return {};

          const maxLessons = lessonsLimit();
          const state = loadState(hicortexHome);
          const moduleIndex = data.moduleIndex ?? state.moduleIndex;
          const selected = await getLessonSelector().select(data.lessons, {
            maxLessons,
            project: ctx.project,
            moduleIndex,
          });
          if (selected.length === 0) return {};

          const formatted = selected.map((l) => {
            const titleMatch = l.content.match(/## Lesson: (.+)/);
            const typeMatch = l.content.match(/\*\*Type:\*\* (\w+)/);
            const severityMatch = l.content.match(/\*\*Severity:\*\* (\w+)/);
            const title = titleMatch ? titleMatch[1] : l.content.slice(0, 150);
            const meta = [severityMatch?.[1], typeMatch?.[1]].filter(Boolean).join(", ");
            return `- ${title}${meta ? ` (${meta})` : ""}`;
          });

          const context =
            `\n\n## Hicortex Lessons (auto-injected from long-term memory)\n` +
            `These are actionable lessons learned from past sessions:\n\n` +
            formatted.join("\n") +
            "\n";

          return { appendSystemContext: context };
        } catch {
          // Fail-soft — a broken lessons fetch must not block the agent
          return {};
        }
      },
    );

    // -----------------------------------------------------------------------
    // Tools — HTTP proxies to server REST API
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
          try {
            const params = new URLSearchParams({ query: args.query });
            if (args.limit) params.set("limit", String(args.limit));
            if (args.project) params.set("project", args.project);
            const data = await serverGet<{ results: MemorySearchResult[] }>(
              `/search?${params}`,
              10000,
            );
            if (!data) return { error: "Search failed: server unreachable" };
            return formatToolResults(data.results ?? []);
          } catch (err) {
            return { error: `Search failed: ${err instanceof Error ? err.message : String(err)}` };
          }
        },
      }),
      { name: "hicortex_search" },
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
        async execute(_callId: any, args: any, _ctx: any) {
          try {
            const params = new URLSearchParams();
            if (args?.project) params.set("project", args.project);
            if (args?.limit) params.set("limit", String(args.limit));
            const qs = params.toString();
            const data = await serverGet<{ results: MemorySearchResult[] }>(
              `/context${qs ? `?${qs}` : ""}`,
              10000,
            );
            if (!data) return { error: "Context search failed: server unreachable" };
            return formatToolResults(data.results ?? []);
          } catch (err) {
            return { error: `Context search failed: ${err instanceof Error ? err.message : String(err)}` };
          }
        },
      }),
      { name: "hicortex_context" },
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
          try {
            const result = await serverPost<{ id?: string; error?: string }>(
              "/ingest",
              {
                content: args.content,
                source_agent: `openclaw/${context?.agentId ?? "manual"}`,
                project: args.project,
                memory_type: args.memory_type ?? "episode",
                privacy: "WORK",
              },
              15000,
            );
            if (!result.ok) {
              return { error: `Ingest failed: ${result.data?.error ?? `HTTP ${result.status}`}` };
            }
            const id = result.data?.id ?? "unknown";
            return { content: [{ type: "text", text: `Memory stored (id: ${id.slice(0, 8)})` }] };
          } catch (err) {
            return { error: `Ingest failed: ${err instanceof Error ? err.message : String(err)}` };
          }
        },
      }),
      { name: "hicortex_ingest" },
    );

    api.registerTool(
      (_ctx: any) => ({
        name: "hicortex_lessons",
        description:
          "Get actionable lessons learned from past sessions. Auto-generated insights about mistakes to avoid.",
        parameters: {
          type: "object",
          properties: {
            project: { type: "string", description: "Filter by project name (optional)" },
          },
        },
        async execute(_callId: any, args: any, _ctx: any) {
          try {
            const data = await serverGet<LessonsApiResponse>("/lessons", LESSONS_TIMEOUT_MS);
            if (!data) return { error: "Lessons fetch failed: server unreachable" };
            const lessons = data.lessons ?? [];
            if (lessons.length === 0) {
              return { content: [{ type: "text", text: "No lessons found." }] };
            }
            const text = lessons.map((l) => `- ${l.content.slice(0, 500)}`).join("\n");
            return { content: [{ type: "text", text }] };
          } catch (err) {
            return { error: `Lessons fetch failed: ${err instanceof Error ? err.message : String(err)}` };
          }
        },
      }),
      { name: "hicortex_lessons" },
    );

    api.registerTool(
      (_ctx: any) => ({
        name: "hicortex_index",
        description:
          "Get the knowledge domain index — shows what topics and projects are stored in memory, grouped by domain.",
        parameters: {
          type: "object",
          properties: {},
        },
        async execute(_callId: any, _args: any, _ctx: any) {
          try {
            const data = await serverGet<{ domains?: unknown[]; projects?: unknown[] }>(
              "/index",
              10000,
            );
            if (!data) return { error: "Index fetch failed: server unreachable" };
            return { content: [{ type: "text", text: JSON.stringify(data) }] };
          } catch (err) {
            return { error: `Index fetch failed: ${err instanceof Error ? err.message : String(err)}` };
          }
        },
      }),
      { name: "hicortex_index" },
    );

    api.registerTool(
      (_ctx: any) => ({
        name: "hicortex_graph",
        description:
          "Query the memory knowledge graph — find connected memories, hub nodes, or paths between memories.",
        parameters: {
          type: "object",
          properties: {
            operation: {
              type: "string",
              enum: ["neighbors", "hubs", "path"],
              description: "Graph operation to perform",
            },
            id: { type: "string", description: "Memory ID (required for neighbors and path operations)" },
            target_id: { type: "string", description: "Target memory ID (required for path operation)" },
            limit: { type: "number", description: "Max results (default 10)" },
            domain: { type: "string", description: "Filter hubs by domain" },
            relationship: { type: "string", description: "Filter neighbors by relationship type (e.g., extends, relates_to; legacy data may also have CONTRADICTS, SUPERSEDES, updates)" },
          },
          required: ["operation"],
        },
        async execute(_callId: any, args: any, _ctx: any) {
          try {
            const params = new URLSearchParams({ op: args.operation });
            if (args.id) params.set("id", args.id);
            if (args.target_id) params.set("target_id", args.target_id);
            if (args.limit) params.set("limit", String(args.limit));
            if (args.domain) params.set("domain", args.domain);
            if (args.relationship) params.set("relationship", args.relationship);
            const data = await serverGet<Record<string, unknown>>(
              `/graph?${params}`,
              10000,
            );
            if (!data) return { error: "Graph query failed: server unreachable" };
            return { content: [{ type: "text", text: JSON.stringify(data) }] };
          } catch (err) {
            return { error: `Graph query failed: ${err instanceof Error ? err.message : String(err)}` };
          }
        },
      }),
      { name: "hicortex_graph" },
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
            memory_type: {
              type: "string",
              enum: ["episode", "lesson", "fact", "decision"],
              description: "New memory type",
            },
          },
          required: ["id"],
        },
        async execute(_callId: any, args: any, _ctx: any) {
          try {
            const result = await serverPost<{ updated?: boolean; id?: string; error?: string }>(
              "/update",
              {
                id: args.id,
                content: args.content,
                project: args.project,
                memory_type: args.memory_type,
              },
              15000,
            );
            if (result.status === 404) {
              return { error: `Memory not found: ${args.id}` };
            }
            if (!result.ok) {
              return { error: `Update failed: ${result.data?.error ?? `HTTP ${result.status}`}` };
            }
            const id = result.data?.id ?? args.id;
            return { content: [{ type: "text", text: `Memory updated (id: ${String(id).slice(0, 8)})` }] };
          } catch (err) {
            return { error: `Update failed: ${err instanceof Error ? err.message : String(err)}` };
          }
        },
      }),
      { name: "hicortex_update" },
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
        async execute(_callId: any, args: any, _ctx: any) {
          try {
            const result = await serverPost<{ deleted?: boolean; id?: string; error?: string }>(
              "/delete",
              { id: args.id },
              15000,
            );
            if (result.status === 404) {
              return { error: `Memory not found: ${args.id}` };
            }
            if (!result.ok) {
              return { error: `Delete failed: ${result.data?.error ?? `HTTP ${result.status}`}` };
            }
            return { content: [{ type: "text", text: `Memory deleted (id: ${String(args.id).slice(0, 8)})` }] };
          } catch (err) {
            return { error: `Delete failed: ${err instanceof Error ? err.message : String(err)}` };
          }
        },
      }),
      { name: "hicortex_delete" },
    );
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HICORTEX_TOOLS = [
  "hicortex_search",
  "hicortex_context",
  "hicortex_ingest",
  "hicortex_lessons",
  "hicortex_index",
  "hicortex_graph",
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
      (t) => !config.tools.allow.includes(t),
    );
    if (missing.length === 0) return;

    config.tools.allow.push(...missing);
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    log(`[hicortex] Added tools to allow list: ${missing.join(", ")}`);
  } catch {
    // Non-fatal — openclaw.json may not exist in test environments
  }
}
