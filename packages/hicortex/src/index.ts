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
 *   - before_agent_start  → GET /context + GET /lessons + POST /recall-index
 *     (fail-soft, 3s timeout each, concurrent) → inject context. In OpenClaw
 *     every inbound message spawns an embedded run, so this hook fires PER
 *     TURN with the current prompt and session id — it is the per-turn
 *     /recall-index surface, not just session start.
 *   - after_compaction / before_reset → POST /recall-index {reset:true}
 *     (context rebuilt → the server's per-session shown-set is stale)
 *   - Tools               → HTTP proxies to /search, /memory, /recent, /ingest, /lessons
 *
 * CAPTURE IS NOT THIS PLUGIN'S JOB. OpenClaw persists sessions at
 * ~/.openclaw/agents/<agentId>/sessions/*.jsonl in the Pi v3 format; the
 * machine's Hicortex nightly reads them via oc-transcript-reader.ts —
 * canonical nightly-from-logs, same as CC JSONL and Hermes state.db.
 */

import { hicortexHome as resolveHicortexHome } from "./paths.js";
import { initFeatures, lessonsLimit } from "./features.js";
import { getLessonSelector } from "./extensions.js";
import { loadState } from "./state.js";
import { sanitizeAgentId } from "./context-store.js";
import { gateAndRenderContext, type ContextResponse } from "./lessons-context.js";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { HicortexConfig, MemorySearchResult, ModuleIndex } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_SERVER_URL = "http://127.0.0.1:8787";
const LESSONS_TIMEOUT_MS = 3000;
const CONTEXT_TIMEOUT_MS = 3000;
const RECALL_TIMEOUT_MS = 3000;
const HICORTEX_HOME = resolveHicortexHome();

/** Harness name this plugin injects for — used to self-gate on GET /context `clients`. */
const THIS_HARNESS = "oc";

// ---------------------------------------------------------------------------
// Module state — initialized in registerService.start()
// ---------------------------------------------------------------------------

let serverUrl = DEFAULT_SERVER_URL;
let authToken: string | undefined;
let hicortexHome = HICORTEX_HOME;
/** Old-server guard (F2): 0 = not latched; otherwise the Date.now() epoch-ms
 *  until which /recall-index is skipped after a 404 (pre-0.14 server). The
 *  latch EXPIRES so a client-first rollout heals itself once the server is
 *  upgraded — a permanent latch would silently disable recall on a
 *  long-running gateway until restart. OC has no pre-0.14 per-turn recall to
 *  fall back to, so "skip" IS the old behavior. */
let recallIndexRetryAtMs = 0;
/** How long a 404 latches the guard before re-probing. Long enough not to
 *  hammer an old server every turn, short enough that a server upgrade is
 *  picked up within minutes. */
const RECALL_REPROBE_INTERVAL_MS = 600_000;
/** Warn-once flag (F5): the recall index needs ctx.sessionId from the
 *  gateway; if a gateway variant doesn't pass it the feature must not run
 *  silently dead. */
let warnedMissingSessionId = false;
/** Plugin logger captured at service start (ctx.logger or console). */
let pluginLog: (msg: string) => void = console.log;

function recallIndexLatched(): boolean {
  return recallIndexRetryAtMs !== 0 && Date.now() < recallIndexRetryAtMs;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function authHeaders(): Record<string, string> {
  return authToken ? { Authorization: `Bearer ${authToken}` } : {};
}

async function serverGet<T>(
  path: string,
  timeoutMs: number,
): Promise<{ data: T | null; status: number | null }> {
  try {
    const resp = await fetch(`${serverUrl}${path}`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return { data: null, status: resp.status };
    return { data: await resp.json() as T, status: resp.status };
  } catch {
    return { data: null, status: null };
  }
}

/**
 * Human-readable GET failure. Distinguishes a down server from an HTTP error —
 * in particular a 404, so plugin/server version skew reads as a version
 * problem, not a network one. The /context→/recent rename hint (0.12) is
 * added only for /recent, where it is the overwhelmingly likely cause.
 */
function describeGetFailure(status: number | null, endpoint: string): string {
  if (status === null) return "server unreachable";
  if (status === 404) {
    const renameHint = endpoint.startsWith("/recent")
      ? " (0.12 renamed /context to /recent)"
      : "";
    return `HTTP 404 — ${endpoint} not found on the server; likely plugin/server version skew${renameHint}. Upgrade the server first.`;
  }
  return `server returned HTTP ${status}`;
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
// Context layer (L2) — per-agent standing context (0.13)
// ---------------------------------------------------------------------------

/**
 * Fetch GET /context (per-agent when an id is supplied) and build the
 * `## Context` block via the shared gate (gateAndRenderContext), or null when
 * nothing should be injected. The old-server guard is required only when an
 * agent id was actually sent (amendment A2 — a bare fetch skips it). The server
 * does the merge; the plugin stays dumb (no client-side mode logic).
 */
async function fetchOcContextBlock(agentId: string | null): Promise<string | null> {
  const path = agentId ? `/context?agent=${encodeURIComponent(agentId)}` : "/context";
  const { data } = await serverGet<ContextResponse>(path, CONTEXT_TIMEOUT_MS);
  if (!data) return null;
  return gateAndRenderContext(data, THIS_HARNESS, { requireAgentEcho: agentId !== null });
}

/**
 * Fetch /lessons and build the `## Hicortex Lessons` block, or null on any
 * failure or when no lessons survive selection. Preserves the pre-0.13 lesson
 * output; the caller prepends the `## Context` block and adds separators.
 */
async function buildLessonsBlock(project?: string): Promise<string | null> {
  const { data } = await serverGet<LessonsApiResponse>("/lessons", LESSONS_TIMEOUT_MS);
  if (!data || !data.lessons || data.lessons.length === 0) return null;

  const maxLessons = lessonsLimit();
  const state = loadState(hicortexHome);
  const moduleIndex = data.moduleIndex ?? state.moduleIndex;
  const selected = await getLessonSelector().select(data.lessons, {
    maxLessons,
    project,
    moduleIndex,
  });
  if (selected.length === 0) return null;

  const formatted = selected.map((l) => {
    const typeMatch = l.content.match(/\*\*Type:\*\* (\w+)/);
    const severityMatch = l.content.match(/\*\*Severity:\*\* (\w+)/);
    // First line, with any legacy `## Lesson:` prefix stripped — new lessons
    // are stored topic-first without the prefix (memory_type carries the type).
    const title = l.content.replace(/^##\s*Lesson:\s*/i, "").split("\n")[0].slice(0, 150);
    const meta = [severityMatch?.[1], typeMatch?.[1]].filter(Boolean).join(", ");
    return `- ${title}${meta ? ` (${meta})` : ""}`;
  });

  return (
    `## Hicortex Lessons (auto-injected from long-term memory)\n` +
    `These are actionable lessons learned from past sessions:\n\n` +
    formatted.join("\n")
  );
}

// ---------------------------------------------------------------------------
// Pushed recall index (#193) — per-turn POST /recall-index
// ---------------------------------------------------------------------------

/**
 * Fetch the pushed recall index for this turn, or null when there is nothing
 * to inject (null block, no session id, failure, or a pre-0.14 server). The
 * server does all relevance gating and per-session TURN-based dedup — the
 * plugin sends every turn and carries no tuning constants. A 404 flips the
 * module-level guard so an old server is probed once per gateway process.
 */
async function fetchRecallIndexBlock(
  sessionId: string | undefined,
  prompt: string | undefined,
  project?: string,
): Promise<string | null> {
  if (recallIndexLatched()) return null;
  if (!sessionId || !prompt) {
    // Verified against the installed OpenClaw gateway dist (auth-profiles
    // bundle, runEmbeddedPiAgent → hookCtx): before_agent_start receives
    // {agentId, sessionKey, sessionId, workspaceDir, …} on every run. If a
    // gateway variant does NOT pass sessionId, the feature would run silently
    // dead behind fail-soft — warn once per process so it is diagnosable.
    if (!sessionId && prompt && !warnedMissingSessionId) {
      warnedMissingSessionId = true;
      pluginLog(
        "[hicortex] WARNING: before_agent_start ctx has no sessionId — " +
        "per-turn memory recall is disabled. Upgrade OpenClaw (the gateway " +
        "must pass sessionId to plugin hooks).",
      );
    }
    return null;
  }
  // #203 scope: send the gateway-supplied project so retrieval can apply a soft
  // project-affinity boost (no hard filter — "no hard filters in brains").
  // Absent ⇒ no scope sent ⇒ no-op (preserves pre-#203 behavior).
  const body: { session_id: string; prompt: string; project?: string } = {
    session_id: sessionId,
    prompt,
  };
  if (project) body.project = project;
  const { ok, status, data } = await serverPost<{ block?: string | null }>(
    "/recall-index",
    body,
    RECALL_TIMEOUT_MS,
  );
  if (status === 404) {
    recallIndexRetryAtMs = Date.now() + RECALL_REPROBE_INTERVAL_MS;
    return null;
  }
  if (!ok || !data) return null;
  recallIndexRetryAtMs = 0;
  return typeof data.block === "string" && data.block.trim() !== "" ? data.block : null;
}

/**
 * Reset the session's server-side recall dedup — the context window was
 * rebuilt (compaction or session reset), so the shown-set is stale by
 * definition. Fire-and-forget fail-soft: a reset that is lost only means some
 * memories stay suppressed until the re-show window (`recallReshowTurns`)
 * passes.
 */
async function postRecallReset(sessionId: string | undefined): Promise<void> {
  if (recallIndexLatched()) return;
  if (!sessionId) return;
  const { status } = await serverPost<unknown>(
    "/recall-index",
    { session_id: sessionId, reset: true },
    RECALL_TIMEOUT_MS,
  );
  if (status === 404) recallIndexRetryAtMs = Date.now() + RECALL_REPROBE_INTERVAL_MS;
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
        // Re-probe /recall-index support on every (re)start — the server may
        // have been upgraded while the gateway was down.
        recallIndexRetryAtMs = 0;
        warnedMissingSessionId = false;
        pluginLog = log;

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
    // Hook: before_agent_start — fetch context + lessons + recall index
    // (fail-soft). Fires per embedded run = per inbound message in OpenClaw,
    // so the recall index rides the same hook as the per-turn surface.
    // -----------------------------------------------------------------------
    api.on(
      "before_agent_start",
      async (
        event: { prompt?: string },
        ctx?: { agentId?: string; project?: string; sessionId?: string },
      ) => {
        // Outer guard: the hook must NEVER throw (a rejection could block the
        // agent). `ctx` itself can be nullish on some gateway variants, and the
        // synchronous sanitize below runs before any per-fetch .catch — so the
        // whole body is wrapped, not just the fetches.
        try {
          // Per-agent context id: sanitize the OC agent id (a symbols-only id
          // sanitizes to null → bare /context → global set). Null id never sends
          // ?agent=, so an old server behaves exactly as before.
          const agentId = sanitizeAgentId(ctx?.agentId ?? "");

          // Fetch all three concurrently with INDEPENDENT fail-soft: no block
          // may ever cost another. Order in the injected context: `## Context`
          // (standing context, 0.13) → `## Hicortex Lessons` → the per-turn
          // `## Memory recall (auto)` index (#193, closest to the prompt).
          const [contextBlock, lessonsBlock, recallBlock] = await Promise.all([
            fetchOcContextBlock(agentId).catch(() => null),
            buildLessonsBlock(ctx?.project).catch(() => null),
            fetchRecallIndexBlock(ctx?.sessionId, event?.prompt, ctx?.project).catch(() => null),
          ]);

          const blocks = [contextBlock, lessonsBlock, recallBlock].filter(
            (b): b is string => b !== null && b !== "",
          );
          if (blocks.length === 0) return {};
          return { appendSystemContext: `\n\n${blocks.join("\n\n")}\n` };
        } catch {
          return {};
        }
      },
    );

    // -----------------------------------------------------------------------
    // Hooks: after_compaction / before_reset — reset the session's recall
    // dedup (#193). Both rebuild the context window, so the server's
    // per-session shown-set no longer reflects what the agent can see.
    // Unknown hook names are ignored by older gateways (typed-hook registry
    // warns and drops them), so registering both is safe everywhere.
    // -----------------------------------------------------------------------
    const recallResetHook = (
      _event: unknown,
      ctx?: { sessionId?: string },
    ) => {
      // Genuinely fire-and-forget (F9): no await — a slow server must never
      // add latency to compaction or session reset in the gateway.
      void postRecallReset(ctx?.sessionId).catch(() => {
        /* fail-soft — never surface into the gateway */
      });
    };
    api.on("after_compaction", recallResetHook);
    api.on("before_reset", recallResetHook);

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
            const { data, status } = await serverGet<{ results: MemorySearchResult[] }>(
              `/search?${params}`,
              10000,
            );
            if (!data) return { error: `Search failed: ${describeGetFailure(status, "/search")}` };
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
        name: "hicortex_get",
        description:
          "Fetch ONE memory's full content by id — use this to lazy-load entries from the '## Memory recall (auto)' index or from search results whose snippet was not enough. Fetching a memory marks it as used (strengthens it), so fetch entries that could change your action — not every shown one. When the memory shapes your answer, cite it as given in the response — mark a fetched memory `FETCHED` and a one-line entry cited unread `SNIPPET`; don't pass SNIPPET off as established.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "Memory ID (as shown in the recall index or search results)" },
          },
          required: ["id"],
        },
        async execute(_callId: any, args: any, _ctx: any) {
          try {
            if (!args?.id) return { error: "id is required" };
            const params = new URLSearchParams({ id: String(args.id) });
            const { data, status } = await serverGet<{
              memory?: { content?: string };
              citation?: string;
            }>(`/memory?${params}`, 10000);
            if (status === 404) {
              // Either no such memory (0.14+) or a pre-0.14 server with no
              // /memory endpoint — the id hint covers the common case.
              return { error: `Memory not found: ${args.id} (or the server predates 0.14 — upgrade the server)` };
            }
            if (!data) return { error: `Get failed: ${describeGetFailure(status, "/memory")}` };
            // Render the content BEHIND the server's citation string — the
            // server-side rendering is the single provenance norm (0.14.1).
            const text = `${data.citation ?? ""}\n\n${data.memory?.content ?? ""}`.trim();
            return { content: [{ type: "text", text }] };
          } catch (err) {
            return { error: `Get failed: ${err instanceof Error ? err.message : String(err)}` };
          }
        },
      }),
      { name: "hicortex_get" },
    );

    api.registerTool(
      (_ctx: any) => ({
        name: "hicortex_recent",
        description:
          "Get recent memories, optionally filtered by project. Queryless recall of the latest memories by project, ranked by importance. Useful to catch up on what happened recently.",
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
            const { data, status } = await serverGet<{ results: MemorySearchResult[] }>(
              `/recent${qs ? `?${qs}` : ""}`,
              10000,
            );
            if (!data) return { error: `Recent recall failed: ${describeGetFailure(status, "/recent")}` };
            return formatToolResults(data.results ?? []);
          } catch (err) {
            return { error: `Recent recall failed: ${err instanceof Error ? err.message : String(err)}` };
          }
        },
      }),
      { name: "hicortex_recent" },
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
            const { data, status } = await serverGet<LessonsApiResponse>("/lessons", LESSONS_TIMEOUT_MS);
            if (!data) return { error: `Lessons fetch failed: ${describeGetFailure(status, "/lessons")}` };
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
            const { data, status } = await serverGet<{ domains?: unknown[]; projects?: unknown[] }>(
              "/index",
              10000,
            );
            if (!data) return { error: `Index fetch failed: ${describeGetFailure(status, "/index")}` };
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
            const { data, status } = await serverGet<Record<string, unknown>>(
              `/graph?${params}`,
              10000,
            );
            if (!data) return { error: `Graph query failed: ${describeGetFailure(status, "/graph")}` };
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
  "hicortex_get",
  "hicortex_recent",
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
