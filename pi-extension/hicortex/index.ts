/**
 * Hicortex extension for the Pi coding agent (#348) — recall + identity +
 * lessons injection, no capture.
 *
 * The OpenClaw-plugin architecture on Pi's extension API: one dependency-free
 * file (Node built-ins only, global fetch) that gives Pi agents the same
 * memory experience as CC/OC —
 *
 *   before_agent_start  → POST /recall-index per prompt; the returned index
 *                         block is injected as a custom message alongside the
 *                         user message (the push-recall channel), and the
 *                         identity + lessons blocks are appended to the
 *                         system prompt for THIS TURN (identity/lessons
 *                         channel). Pi resets a systemPrompt override to the
 *                         base prompt on any turn no extension returns one
 *                         (verified against pi 0.84.3), so the blocks are
 *                         re-applied EVERY turn from a session-scoped cache.
 *   session_start       → POST /recall-index {reset:true} (fresh context
 *                         window — the server's per-session shown-set is
 *                         stale by definition) and drop the block caches.
 *   session_compact     → same reset + cache drop: the rebuilt window may
 *                         have dropped the injected blocks.
 *   registerTool × 9    → the hicortex_* tools as direct REST proxies.
 *
 * Capture is NOT the extension's job — the nightly reader on the server
 * machine distills `~/.pi/agent/sessions/` centrally (pi-transcript-reader).
 *
 * Fail-soft by construction: ANY failure (no config, timeout, non-2xx, parse
 * error) injects nothing and never blocks a session — every injection-path
 * fetch carries a 1000 ms timeout (the CC-hook budget), tool fetches 10 s
 * (the OC serverGet budget). No ctx.ui calls anywhere, so print mode
 * (`pi -p`) is safe by construction.
 *
 * Loose structural typing throughout (`pi: any`, inline narrowing): Pi
 * publishes its extension types under a package this file must not depend
 * on — the extension has ZERO imports beyond Node built-ins so it works on
 * any Pi install straight from the npm tarball.
 */

import { readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

const FETCH_TIMEOUT_MS = 1000;
const TOOL_TIMEOUT_MS = 10_000;
const DEFAULT_PORT = 8787;
/** Harness name this extension injects for — self-gates on /identity `clients`. */
const THIS_HARNESS = "pi";
const DEFAULT_LESSONS_LIMIT = 10;

/**
 * HTML-comment fence around the appended identity/lessons blocks. The end
 * marker is the idempotency guard: pi resets a systemPrompt override to base
 * on any turn no extension returns one, so we re-append every turn — but if a
 * future pi PERSISTS an override (or the incoming base already carries our
 * block), appending again would double it. Comments are invisible to the
 * model, so the fence costs nothing on the wire.
 */
const CONTEXT_START = "<!-- hicortex-context-start -->";
const CONTEXT_END = "<!-- hicortex-context-end -->";

// ---------------------------------------------------------------------------
// Config resolution — duplicated from the CC hook's resolveConfig
// (learnings-identity.ts) because this file cannot import package code.
// ---------------------------------------------------------------------------

export interface PiConfig {
  serverUrl: string;
  authToken: string | undefined;
  /** Max lessons in the injected block (config lessonsLimit, default 10). */
  lessonsLimit: number;
}

/**
 * Read ~/.hicortex/config.json and resolve the server URL + auth token, or
 * null when there is no usable config (server not set up — fail soft).
 * Mirrors resolveConfig: client mode → `serverUrl` (trailing slashes
 * stripped), server mode → localhost:port. The auth token follows the
 * server's precedence — config first, HICORTEX_AUTH_TOKEN env fills gaps.
 */
export function resolvePiConfig(): PiConfig | null {
  const home = process.env.HICORTEX_HOME ?? join(homedir(), ".hicortex");
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(readFileSync(join(home, "config.json"), "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) return null;

  const serverUrl = config.mode === "client" && typeof config.serverUrl === "string"
    ? config.serverUrl.replace(/\/+$/, "")
    : `http://127.0.0.1:${typeof config.port === "number" ? config.port : DEFAULT_PORT}`;

  const authToken = (typeof config.authToken === "string" && config.authToken
    ? config.authToken
    : undefined) ?? process.env.HICORTEX_AUTH_TOKEN;

  const rawLimit = config.lessonsLimit;
  const lessonsLimit = typeof rawLimit === "number" && rawLimit > 0
    ? Math.floor(rawLimit)
    : DEFAULT_LESSONS_LIMIT;

  return { serverUrl, authToken, lessonsLimit };
}

function authHeaders(cfg: PiConfig): Record<string, string> {
  return cfg.authToken ? { "Authorization": `Bearer ${cfg.authToken}` } : {};
}

// ---------------------------------------------------------------------------
// Pure renderers — exported so tests exercise them directly
// ---------------------------------------------------------------------------

/** "user" → "User", "my_notes" → "My Notes" (mirrors titleCaseSection). */
export function titleCaseSection(name: string): string {
  return name
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export interface IdentityResponse {
  sections?: Record<string, unknown>;
  clients?: unknown;
}

/**
 * Render the `## Identity` block from a resolved section map, or null when
 * every section is blank. Mirrors renderIdentityBlock (learnings-identity.ts)
 * with one dependency-free simplification: section headings are the
 * title-cased key (which matches the server's labels for the seeded
 * sections); sections are rendered in the SERVER's wire order — the server
 * already applies the #313 precedence when it builds the response, so the
 * extension does not re-sort.
 */
export function renderIdentityBlock(sections: Record<string, unknown> | undefined): string | null {
  if (!sections || typeof sections !== "object" || Array.isArray(sections)) return null;
  const bodyParts: string[] = [];
  for (const name of Object.keys(sections)) {
    const body = sections[name];
    if (typeof body !== "string" || body.trim() === "") continue;
    bodyParts.push(`### ${titleCaseSection(name)}`, "", body.trim());
  }
  if (bodyParts.length === 0) return null;
  return ["## Identity", "", ...bodyParts].join("\n");
}

/**
 * Gate a GET /identity response and render the block, or null when nothing
 * should be injected: this harness ("pi") not in the server-resolved
 * `clients` list, or no non-empty sections. Mirrors gateAndRenderIdentity
 * (the single CC/OC gate — keep the three in sync).
 */
export function gateAndRenderIdentity(data: IdentityResponse | null): string | null {
  if (!data || typeof data !== "object") return null;
  const clients = Array.isArray(data.clients) ? data.clients : [];
  if (!clients.includes(THIS_HARNESS)) return null;
  return renderIdentityBlock(data.sections);
}

export interface LessonsResponse {
  lessons?: Array<{ content?: unknown }>;
  index?: {
    total?: number;
    lessonCount?: number;
    sourceCount?: number;
    projects?: Array<{ name?: unknown; count?: unknown }>;
  };
  moduleIndex?: { domains?: Array<{ name?: unknown; keywords?: unknown[]; memoryCount?: number; lessonCount?: number; projects?: unknown[] }> } | null;
}

/**
 * Render the `## Hicortex Memory` block from a GET /learnings response, or
 * null on a shape we cannot render. Format follows the CC hook's
 * fetchLessonsBlock (guidance lines + lesson lines + memory-index footer)
 * with the dependency-free simplification the Hermes plugin also makes: a
 * plain top-N slice instead of the package's domain-aware lesson selector
 * (which this file cannot import). N = config lessonsLimit (default 10).
 */
export function renderLessonsBlock(data: LessonsResponse | null, maxLessons: number): string | null {
  if (!data || typeof data !== "object") return null;
  const lessons = Array.isArray(data.lessons) ? data.lessons : [];

  const lessonLines = lessons.slice(0, maxLessons).map((l) => {
    const content = typeof l?.content === "string" ? l.content : "";
    const typeMatch = content.match(/\*\*Type:\*\* (\w+)/);
    const severityMatch = content.match(/\*\*Severity:\*\* (\w+)/);
    // First line, with any legacy `## Lesson:` prefix stripped — new lessons
    // are stored topic-first (memory_type carries the type).
    const title = content.replace(/^##\s*Lesson:\s*/i, "").split("\n")[0].slice(0, 150);
    const meta = [severityMatch?.[1], typeMatch?.[1]].filter(Boolean).join(", ");
    return `- ${title}${meta ? ` (${meta})` : ""}`;
  });

  const parts: string[] = ["## Hicortex Memory", ""];
  parts.push("You have access to shared long-term memory across all agents and sessions.");
  parts.push("BEFORE making decisions, search memory: `hicortex_search` for prior decisions on the same topic.");
  parts.push("Use `hicortex_recent` at session start for recent project state.");

  if (lessonLines.length > 0) {
    parts.push("", "### Learnings (updated nightly)");
    parts.push(...lessonLines);
  }

  const index = data.index ?? {};
  const domains = data.moduleIndex?.domains ?? [];
  if (domains.length > 0) {
    parts.push("", "### Memory Index");
    for (const domain of domains) {
      const keywords = Array.isArray(domain.keywords) ? domain.keywords : [];
      const kwStr = keywords.length > 0 ? `: ${keywords.join(", ")}` : "";
      parts.push(`${domain.name} (${domain.memoryCount} memories, ${domain.lessonCount} Learnings)${kwStr}`);
      if (Array.isArray(domain.projects) && domain.projects.length > 0) {
        parts.push(`  ${domain.projects.join(" | ")}`);
      }
    }
    parts.push(`${index.total} memories, ${index.lessonCount} Learnings, ${index.sourceCount} agents. Search with \`hicortex_search\`.`);
  } else if (Array.isArray(index.projects) && index.projects.length > 0) {
    parts.push("", "### Memory Index");
    parts.push(index.projects.map((p) => `${p.name}: ${p.count}`).join(" | "));
    parts.push(`${index.total} memories, ${index.lessonCount} Learnings, ${index.sourceCount} agents. Search with \`hicortex_search\`.`);
  }

  return parts.join("\n");
}

/**
 * Build the /recall-index request body, or null when there is nothing to
 * send (no session id, or an empty prompt). Mirrors the CC hook's
 * buildHookRequest: project = basename(cwd) so retrieval can apply the soft
 * project-affinity boost.
 */
export function buildRecallBody(
  sessionId: string,
  prompt: string,
  cwd: string,
): Record<string, unknown> | null {
  if (!sessionId || !prompt) return null;
  const body: Record<string, unknown> = { session_id: sessionId, prompt };
  const project = basename(cwd ?? "");
  if (project) body.project = project;
  return body;
}

/**
 * Append the identity/lessons blocks to a base system prompt behind a marker
 * fence, or undefined when there is nothing to append (no non-empty blocks,
 * or the base ALREADY carries our end marker — the not-doubled guard; see
 * CONTEXT_END). The caller returns the result as `{systemPrompt}` EVERY turn
 * because pi resets an override to base whenever no extension supplies one.
 */
export function appendContextBlocks(
  basePrompt: unknown,
  blocks: Array<string | null>,
): string | undefined {
  const base = typeof basePrompt === "string" ? basePrompt : "";
  const parts = blocks.filter((b): b is string => typeof b === "string" && b.trim() !== "");
  if (parts.length === 0) return undefined;
  if (base.includes(CONTEXT_END)) return undefined;
  return `${base}\n\n${CONTEXT_START}\n\n${parts.join("\n\n")}\n\n${CONTEXT_END}`;
}

// ---------------------------------------------------------------------------
// Session-scoped state
// ---------------------------------------------------------------------------

/**
 * Per-session caches: a SETTLED render (a block, or a gated/empty null) is
 * memoized for the session; a FAILED fetch is NOT — it retries next turn
 * (the OC plugin's #313 memoize-only-on-success rule). Bounded: a long-lived
 * pi process accumulating sessions would otherwise grow the maps forever.
 */
const IDENTITY_BLOCKS = new Map<string, string | null>();
const LESSONS_BLOCKS = new Map<string, string | null>();
/** In-flight / recently-fired dedup resets, keyed by session id (#316 ordering). */
const PENDING_RESETS = new Map<string, Promise<void>>();
const SESSION_STATE_CAP = 32;

/** Test seam: wipe the module-level session state between cases. */
export function __resetSessionState(): void {
  IDENTITY_BLOCKS.clear();
  LESSONS_BLOCKS.clear();
  PENDING_RESETS.clear();
}

function pruneSessionState(): void {
  if (IDENTITY_BLOCKS.size > SESSION_STATE_CAP || LESSONS_BLOCKS.size > SESSION_STATE_CAP) {
    IDENTITY_BLOCKS.clear();
    LESSONS_BLOCKS.clear();
  }
}

function dropSessionState(sessionId: string): void {
  IDENTITY_BLOCKS.delete(sessionId);
  LESSONS_BLOCKS.delete(sessionId);
}

function getSessionId(ctx: unknown): string | null {
  const sid = (ctx as { sessionManager?: { getSessionId?: () => unknown } } | null)
    ?.sessionManager?.getSessionId?.();
  // Without a session id the recall key would collapse to "" and merge every
  // session on the server — inject nothing instead (OC warns; pi has no
  // logger we may safely use in print mode, so this fails silently).
  return typeof sid === "string" && sid ? sid : null;
}

/** Fetch-and-memoize one block; a throw degrades to null WITHOUT caching. */
async function cachedBlock(
  cache: Map<string, string | null>,
  sessionId: string,
  fetcher: () => Promise<string | null>,
): Promise<string | null> {
  if (cache.has(sessionId)) return cache.get(sessionId) ?? null;
  try {
    const block = await fetcher();
    cache.set(sessionId, block);
    return block;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fetchers — every failure path THROWS to the caller's fail-soft catch
// ---------------------------------------------------------------------------

async function fetchRecallBlock(
  cfg: PiConfig,
  sessionId: string,
  prompt: string,
  cwd: string,
): Promise<string | null> {
  const body = buildRecallBody(sessionId, prompt, cwd);
  if (!body) return null;
  const resp = await fetch(`${cfg.serverUrl}/recall-index`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(cfg) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  // 404 = a pre-0.14 server with no /recall-index; any other non-2xx is the
  // same outcome for injection purposes — nothing this turn (CC-hook
  // contract; the server-side /search tool remains available).
  if (!resp.ok) return null;
  const data = await resp.json() as { block?: string | null };
  return typeof data.block === "string" && data.block.trim() !== "" ? data.block : null;
}

async function fetchIdentityBlock(cfg: PiConfig): Promise<string | null> {
  const resp = await fetch(`${cfg.serverUrl}/identity`, {
    headers: authHeaders(cfg),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return gateAndRenderIdentity(await resp.json() as IdentityResponse);
}

async function fetchLessonsBlock(cfg: PiConfig): Promise<string | null> {
  const resp = await fetch(`${cfg.serverUrl}/learnings`, {
    headers: authHeaders(cfg),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const block = renderLessonsBlock(await resp.json() as LessonsResponse, cfg.lessonsLimit);
  return block === null ? null : block;
}

/**
 * POST {session_id, reset:true}. Fail-soft: a lost reset only means some
 * memories stay suppressed until the re-show window (recallReshowTurns)
 * passes. Registered in PENDING_RESETS so the session's next recall fetch
 * AWAITS it — the reset can never land AFTER the fetch and wipe the
 * shown-set state that turn just built (the Hermes initialize() race,
 * closed by ordering).
 */
function resetRecallDedup(cfg: PiConfig, sessionId: string): Promise<void> {
  const inFlight = PENDING_RESETS.get(sessionId);
  if (inFlight) return inFlight;
  const p = fetch(`${cfg.serverUrl}/recall-index`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(cfg) },
    body: JSON.stringify({ session_id: sessionId, reset: true }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
    .then(() => undefined)
    .catch(() => {
      /* fail-soft — never surface into the session */
    })
    .finally(() => {
      if (PENDING_RESETS.get(sessionId) === p) PENDING_RESETS.delete(sessionId);
    });
  PENDING_RESETS.set(sessionId, p);
  return p;
}

// ---------------------------------------------------------------------------
// Tool plumbing — REST proxies (names/descriptions/schemas mirror the OC
// plugin verbatim; Pi validates plain JSON Schema, no TypeBox needed)
// ---------------------------------------------------------------------------

/** Canonical memory_type mapping — mirrors normalizeMemoryType (type-labels). */
const TO_CANONICAL_TYPE: Record<string, string> = {
  fact: "knowledge", episode: "experience", decision: "decisions", lesson: "learnings",
  knowledge: "knowledge", experience: "experience", decisions: "decisions", learnings: "learnings",
};

/** Render labels for search/recent results — mirrors MEMORY_TYPE_LABELS. */
const TYPE_LABELS: Record<string, string> = {
  knowledge: "Knowledge", experience: "Experience", decisions: "Decisions", learnings: "Learnings",
  fact: "Knowledge", episode: "Experience", decision: "Decisions", lesson: "Learnings",
};

const NOT_CONFIGURED =
  "Hicortex is not configured on this machine — run `npx @gamaze/hicortex init` " +
  "(or create ~/.hicortex/config.json).";

function textResult(text: string): { content: Array<{ type: string; text: string }>; details: undefined } {
  return { content: [{ type: "text", text }], details: undefined };
}

/** Error results are plain text (pi renders the content array); never throw. */
function errorResult(message: string) {
  return textResult(`error: ${message}`);
}

async function serverGet(
  cfg: PiConfig,
  path: string,
): Promise<{ data: any | null; status: number | null }> {
  try {
    const resp = await fetch(`${cfg.serverUrl}${path}`, {
      headers: authHeaders(cfg),
      signal: AbortSignal.timeout(TOOL_TIMEOUT_MS),
    });
    if (!resp.ok) return { data: null, status: resp.status };
    return { data: await resp.json(), status: resp.status };
  } catch {
    return { data: null, status: null };
  }
}

async function serverPost(
  cfg: PiConfig,
  path: string,
  body: unknown,
): Promise<{ ok: boolean; status: number; data: any | null }> {
  try {
    const resp = await fetch(`${cfg.serverUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(cfg) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TOOL_TIMEOUT_MS),
    });
    let data: any = null;
    try { data = await resp.json(); } catch { /* non-JSON body */ }
    return { ok: resp.ok, status: resp.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

/** Human-readable GET failure — mirrors describeGetFailure (skew vs down). */
function describeGetFailure(status: number | null): string {
  if (status === null) return "server unreachable";
  return `server returned HTTP ${status}`;
}

interface SearchHit {
  content?: unknown;
  memory_type?: unknown;
  score?: unknown;
  effective_strength?: unknown;
}

function formatSearchResults(results: Array<SearchHit>) {
  if (!Array.isArray(results) || results.length === 0) {
    return textResult("No memories found.");
  }
  const text = results
    .map((r) => {
      const type = typeof r.memory_type === "string" ? String(r.memory_type) : "";
      const label = TYPE_LABELS[type] ?? type ?? "—";
      const score = typeof r.score === "number" ? r.score.toFixed(3) : "0.000";
      const strength = typeof r.effective_strength === "number" ? r.effective_strength.toFixed(3) : "0.000";
      const content = typeof r.content === "string" ? r.content.slice(0, 500) : "";
      return `[${label}] (score: ${score}, strength: ${strength}) ${content}`;
    })
    .join("\n\n");
  return textResult(text);
}

/** The nine tools. `execute` resolves config per call (no startup capture). */
function registerTools(pi: any): void {
  pi.registerTool({
    name: "hicortex_search",
    label: "Hicortex: search memory",
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
    async execute(_toolCallId: string, args: any) {
      try {
        const cfg = resolvePiConfig();
        if (!cfg) return errorResult(NOT_CONFIGURED);
        const params = new URLSearchParams({ query: String(args?.query ?? "") });
        if (args?.limit) params.set("limit", String(args.limit));
        if (args?.project) params.set("project", String(args.project));
        const { data, status } = await serverGet(cfg, `/search?${params}`);
        if (!data) return errorResult(`Search failed: ${describeGetFailure(status)}`);
        return formatSearchResults(data.results ?? []);
      } catch (err) {
        return errorResult(`Search failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });

  pi.registerTool({
    name: "hicortex_get",
    label: "Hicortex: get memory",
    description:
      "Fetch ONE memory's full content by id — use this to lazy-load entries from the '## Memory recall (auto)' index or from search results whose snippet was not enough. Fetching a memory marks it as used (strengthens it), so fetch entries that could change your action — not every shown one. When the memory shapes your answer, cite it as given in the response — mark a fetched memory `FETCHED` and a one-line entry cited unread `SNIPPET`; don't pass SNIPPET off as established.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Memory ID (as shown in the recall index or search results)" },
      },
      required: ["id"],
    },
    async execute(_toolCallId: string, args: any) {
      try {
        if (!args?.id) return errorResult("id is required");
        const cfg = resolvePiConfig();
        if (!cfg) return errorResult(NOT_CONFIGURED);
        const params = new URLSearchParams({ id: String(args.id) });
        const { data, status } = await serverGet(cfg, `/memory?${params}`);
        if (status === 404) {
          // Either no such memory (0.14+) or a pre-0.14 server with no
          // /memory endpoint — the id hint covers the common case.
          return errorResult(`Memory not found: ${args.id} (or the server predates 0.14 — upgrade the server)`);
        }
        if (!data) return errorResult(`Get failed: ${describeGetFailure(status)}`);
        // Render the content BEHIND the server's citation string — the
        // server-side rendering is the single provenance norm (0.14.1).
        const text = `${data.citation ?? ""}\n\n${data.memory?.content ?? ""}`.trim();
        return textResult(text);
      } catch (err) {
        return errorResult(`Get failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });

  pi.registerTool({
    name: "hicortex_recent",
    label: "Hicortex: recent memories",
    description:
      "Get recent memories, optionally filtered by project. Queryless recall of the latest memories by project, ranked by importance. Useful to catch up on what happened recently.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "Filter by project name" },
        limit: { type: "number", description: "Max results (default 10)" },
      },
    },
    async execute(_toolCallId: string, args: any) {
      try {
        const cfg = resolvePiConfig();
        if (!cfg) return errorResult(NOT_CONFIGURED);
        const params = new URLSearchParams();
        if (args?.project) params.set("project", String(args.project));
        if (args?.limit) params.set("limit", String(args.limit));
        const qs = params.toString();
        const { data, status } = await serverGet(cfg, `/recent${qs ? `?${qs}` : ""}`);
        if (!data) return errorResult(`Recent recall failed: ${describeGetFailure(status)}`);
        return formatSearchResults(data.results ?? []);
      } catch (err) {
        return errorResult(`Recent recall failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });

  pi.registerTool({
    name: "hicortex_ingest",
    label: "Hicortex: save memory",
    description:
      "Store a new memory in long-term storage. Use for Knowledge, Decisions, or Learnings.",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "Memory content to store" },
        project: { type: "string", description: "Project this memory belongs to" },
        memory_type: {
          type: "string",
          enum: ["knowledge", "experience", "decisions", "learnings", "fact", "episode", "decision", "lesson"],
          description: "Type of memory (default: Experience). Accepted: Knowledge/Experience/Decisions/Learnings (legacy raw enum also accepted, normalized to the canonical term).",
        },
      },
      required: ["content"],
    },
    async execute(_toolCallId: string, args: any) {
      try {
        const cfg = resolvePiConfig();
        if (!cfg) return errorResult(NOT_CONFIGURED);
        const rawType = typeof args?.memory_type === "string" ? args.memory_type : "";
        const result = await serverPost(cfg, "/ingest", {
          content: args?.content,
          source_agent: "pi/manual",
          project: args?.project,
          memory_type: rawType ? (TO_CANONICAL_TYPE[rawType.toLowerCase()] ?? rawType) : "experience",
        });
        if (!result.ok) {
          return errorResult(`Ingest failed: ${result.data?.error ?? `HTTP ${result.status}`}`);
        }
        const id = result.data?.id ?? "unknown";
        return textResult(`Memory stored (id: ${String(id).slice(0, 8)})`);
      } catch (err) {
        return errorResult(`Ingest failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });

  pi.registerTool({
    name: "hicortex_lessons",
    label: "Hicortex: learnings",
    description:
      "Get actionable Learnings distilled from past sessions. Auto-generated insights about mistakes to avoid.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "Filter by project name (optional)" },
      },
    },
    async execute(_toolCallId: string, _args: any) {
      try {
        const cfg = resolvePiConfig();
        if (!cfg) return errorResult(NOT_CONFIGURED);
        const { data, status } = await serverGet(cfg, "/learnings");
        if (!data) return errorResult(`Lessons fetch failed: ${describeGetFailure(status)}`);
        const lessons = data.lessons ?? [];
        if (lessons.length === 0) {
          return textResult("No Learnings found.");
        }
        const text = lessons.map((l: { content?: unknown }) =>
          `- ${typeof l.content === "string" ? l.content.slice(0, 500) : ""}`).join("\n");
        return textResult(text);
      } catch (err) {
        return errorResult(`Lessons fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });

  pi.registerTool({
    name: "hicortex_index",
    label: "Hicortex: memory index",
    description:
      "Get the knowledge domain index — shows what topics and projects are stored in memory, grouped by domain.",
    parameters: {
      type: "object",
      properties: {},
    },
    async execute(_toolCallId: string, _args: any) {
      try {
        const cfg = resolvePiConfig();
        if (!cfg) return errorResult(NOT_CONFIGURED);
        const { data, status } = await serverGet(cfg, "/index");
        if (!data) return errorResult(`Index fetch failed: ${describeGetFailure(status)}`);
        return textResult(JSON.stringify(data));
      } catch (err) {
        return errorResult(`Index fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });

  pi.registerTool({
    name: "hicortex_graph",
    label: "Hicortex: memory graph",
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
    async execute(_toolCallId: string, args: any) {
      try {
        const cfg = resolvePiConfig();
        if (!cfg) return errorResult(NOT_CONFIGURED);
        const params = new URLSearchParams({ op: String(args?.operation ?? "") });
        if (args?.id) params.set("id", String(args.id));
        if (args?.target_id) params.set("target_id", String(args.target_id));
        if (args?.limit) params.set("limit", String(args.limit));
        if (args?.domain) params.set("domain", String(args.domain));
        if (args?.relationship) params.set("relationship", String(args.relationship));
        const { data, status } = await serverGet(cfg, `/graph?${params}`);
        if (!data) return errorResult(`Graph query failed: ${describeGetFailure(status)}`);
        return textResult(JSON.stringify(data));
      } catch (err) {
        return errorResult(`Graph query failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });

  pi.registerTool({
    name: "hicortex_update",
    label: "Hicortex: update memory",
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
          enum: ["knowledge", "experience", "decisions", "learnings", "fact", "episode", "decision", "lesson"],
          description: "New memory type. Accepted: Knowledge/Experience/Decisions/Learnings (legacy raw enum also accepted, normalized to the canonical term).",
        },
      },
      required: ["id"],
    },
    async execute(_toolCallId: string, args: any) {
      try {
        const cfg = resolvePiConfig();
        if (!cfg) return errorResult(NOT_CONFIGURED);
        const rawType = typeof args?.memory_type === "string" ? args.memory_type : "";
        const result = await serverPost(cfg, "/update", {
          id: args?.id,
          content: args?.content,
          project: args?.project,
          memory_type: rawType ? (TO_CANONICAL_TYPE[rawType.toLowerCase()] ?? rawType) : undefined,
        });
        if (result.status === 404) {
          return errorResult(`Memory not found: ${args?.id}`);
        }
        if (!result.ok) {
          return errorResult(`Update failed: ${result.data?.error ?? `HTTP ${result.status}`}`);
        }
        const id = result.data?.id ?? args?.id;
        return textResult(`Memory updated (id: ${String(id).slice(0, 8)})`);
      } catch (err) {
        return errorResult(`Update failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });

  pi.registerTool({
    name: "hicortex_delete",
    label: "Hicortex: delete memory",
    description:
      "Permanently delete a memory and its links. Use when a memory is incorrect and should be removed entirely.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Memory ID (from search results, first 8 chars or full UUID)" },
      },
      required: ["id"],
    },
    async execute(_toolCallId: string, args: any) {
      try {
        const cfg = resolvePiConfig();
        if (!cfg) return errorResult(NOT_CONFIGURED);
        const result = await serverPost(cfg, "/delete", { id: args?.id });
        if (result.status === 404) {
          return errorResult(`Memory not found: ${args?.id}`);
        }
        if (!result.ok) {
          return errorResult(`Delete failed: ${result.data?.error ?? `HTTP ${result.status}`}`);
        }
        return textResult(`Memory deleted (id: ${String(args?.id).slice(0, 8)})`);
      } catch (err) {
        return errorResult(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

/**
 * The one export pi calls. Registers the event handlers and the nine tools;
 * never throws — a broken extension must not take down the agent loop.
 */
export default function hicortexExtension(pi: any): void {
  try {
    // session_start (startup|reload|new|resume|fork): the context window was
    // (re)built, so the server's per-session shown-set is stale and the
    // cached blocks may no longer be in the window. The reset is
    // fire-and-forget (registered in PENDING_RESETS, caught) — the first
    // before_agent_start AWAITS it before fetching recall, so it can never
    // land after that fetch and wipe the state the turn just built.
    pi.on("session_start", (_event: unknown, ctx: unknown) => {
      try {
        const sessionId = getSessionId(ctx);
        if (!sessionId) return;
        dropSessionState(sessionId);
        const cfg = resolvePiConfig();
        if (cfg) void resetRecallDedup(cfg, sessionId);
      } catch {
        /* fail-soft */
      }
    });

    // Compaction rebuilt the window: reset the dedup again and force a
    // re-fetch of the standing blocks next turn.
    pi.on("session_compact", (_event: unknown, ctx: unknown) => {
      try {
        const sessionId = getSessionId(ctx);
        if (!sessionId) return;
        dropSessionState(sessionId);
        const cfg = resolvePiConfig();
        if (cfg) void resetRecallDedup(cfg, sessionId);
      } catch {
        /* fail-soft */
      }
    });

    pi.on("before_agent_start", async (event: any, ctx: any) => {
      try {
        const cfg = resolvePiConfig();
        if (!cfg) return;
        const sessionId = getSessionId(ctx);
        if (!sessionId) return;
        pruneSessionState();

        // Ordering (#316): a pending reset for THIS session registered
        // before this fetch must complete first — bounded by the reset's own
        // 1 s timeout, so a stalled server cannot stall the turn beyond it.
        const pending = PENDING_RESETS.get(sessionId);
        if (pending) await pending;

        const prompt = typeof event?.prompt === "string" ? event.prompt : "";
        let message: { customType: string; content: string; display: boolean } | undefined;
        if (prompt) {
          const block = await fetchRecallBlock(cfg, sessionId, prompt, ctx?.cwd ?? "").catch(() => null);
          if (block) {
            // display:false — the index is FOR the model; pi hides it from
            // the transcript UI but sends it alongside the user message.
            message = { customType: "hicortex-recall", content: block, display: false };
          }
        }

        // Identity + lessons: fetched once per session (independent
        // fail-soft), re-APPLIED every turn — pi resets a systemPrompt
        // override to base whenever no extension returns one.
        const [identityBlock, lessonsBlock] = await Promise.all([
          cachedBlock(IDENTITY_BLOCKS, sessionId, () => fetchIdentityBlock(cfg)),
          cachedBlock(LESSONS_BLOCKS, sessionId, () => fetchLessonsBlock(cfg)),
        ]);
        const systemPrompt = appendContextBlocks(event?.systemPrompt, [identityBlock, lessonsBlock]);

        const result: { message?: unknown; systemPrompt?: string } = {};
        if (message) result.message = message;
        if (systemPrompt !== undefined) result.systemPrompt = systemPrompt;
        return Object.keys(result).length > 0 ? result : undefined;
      } catch {
        // Total fail-soft: inject nothing, never block the turn.
        return undefined;
      }
    });

    registerTools(pi);
  } catch {
    // Registration itself failed (unexpected pi API change) — stay silent;
    // the session must proceed without memory either way.
  }
}
