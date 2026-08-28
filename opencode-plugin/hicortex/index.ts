/**
 * Hicortex plugin for the opencode coding agent (#347) — recall + identity +
 * lessons injection + memory tools, no capture.
 *
 * The Pi-extension architecture on opencode's plugin API: one dependency-free
 * file (Node built-ins only, global fetch) that gives opencode agents the same
 * memory experience as CC/Pi —
 *
 *   experimental.chat.messages.transform → per model request, find the LAST
 *                         user-role message; when its id is new for the
 *                         session, POST /recall-index {session_id, prompt,
 *                         project} (1 s timeout, fail-soft) and stash the
 *                         returned block; then append ONE synthetic user
 *                         message after the real one carrying the fenced
 *                         block (cloned info, fresh id — existing entries are
 *                         never mutated). Tool-loop requests of the same turn
 *                         re-inject the stashed block. The channel was chosen
 *                         by live verification on opencode 1.18.20: parts
 *                         appended via the chat.message hook never reach the
 *                         model call (0/3 runs completed), while a synthetic
 *                         message from messages.transform provably does — and
 *                         is NOT persisted to opencode's session store.
 *   experimental.chat.system.transform → append the `## Identity` (gated on
 *                         the server-resolved clients containing "opencode")
 *                         and Learnings blocks as ONE fenced system entry;
 *                         per-session memoize-on-success; the fence guard
 *                         prevents doubling.
 *   event                → session.created / session.compacted POST
 *                         /recall-index {session_id, reset:true} (the two
 *                         events carry the id at different paths:
 *                         properties.info.id vs properties.sessionID) and
 *                         drop the session's caches.
 *   tool × 9             → the hicortex_* tools as direct REST proxies with
 *                         plain-object args (no zod — verified live).
 *
 * Capture is NOT the plugin's job — the nightly reader on the server machine
 * distills ~/.local/share/opencode/opencode.db centrally
 * (opencode-transcript-reader).
 *
 * Verified against opencode 1.18.20 (hooks fire as above; the `experimental.*`
 * names may drift upstream — a missing hook degrades to no injection, never an
 * error). Fail-soft by construction: ANY failure (no config, timeout,
 * non-2xx, parse error) injects nothing and never blocks a session — every
 * injection-path fetch carries a 1000 ms timeout, tool fetches 10 s.
 *
 * Loose structural typing throughout (`input: any`, `output: any`, inline
 * narrowing): this file must not depend on @opencode-ai/plugin types — the
 * plugin has ZERO imports beyond Node built-ins so it works on any opencode
 * install straight from the npm tarball.
 *
 * LOADER CONTRACT (#353): opencode's plugin loader invokes EVERY exported
 * function in this file as a plugin factory. This file therefore exports
 * exactly ONE runtime binding — the `HicortexPlugin` const — and every
 * helper stays module-private. Do NOT add an export, not even an
 * `export default` and not "just for the tests": one extra export is enough
 * for the loader to call it with undefined and reject the whole plugin
 * (0.21.0 shipped helper exports; the loader's `renderContextEntry(undefined)`
 * crashed with `blocks.filter is not a function` and the plugin never loaded
 * — live-isolated on opencode 1.18.23). The vitest suite drives this file
 * the way the loader does — through the factory's hooks — never via helper
 * imports, and a structural test pins the export surface.
 */

import { readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

const FETCH_TIMEOUT_MS = 1000;
const TOOL_TIMEOUT_MS = 10_000;
const DEFAULT_PORT = 8787;
/** Harness name this plugin injects for — self-gates on /identity `clients`. */
const THIS_HARNESS = "opencode";
const DEFAULT_LESSONS_LIMIT = 10;

/**
 * HTML-comment fence around every injected block. Doubles as the idempotency
 * guard (system.transform skips a request whose system array already carries
 * the end marker) and as the reader's self-echo skip: any text inside the
 * fence is Hicortex injection, not conversation, and is excluded from capture
 * (defense in depth — messages.transform output is not persisted anyway).
 * Comments are invisible to the model, so the fence costs nothing on the wire.
 */
const CONTEXT_START = "<!-- hicortex-context-start -->";
const CONTEXT_END = "<!-- hicortex-context-end -->";

// ---------------------------------------------------------------------------
// Config resolution — duplicated from the CC hook's resolveConfig
// (learnings-identity.ts) because this file cannot import package code.
// ---------------------------------------------------------------------------

interface OpencodeConfig {
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
function resolveOpencodeConfig(): OpencodeConfig | null {
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

function authHeaders(cfg: OpencodeConfig): Record<string, string> {
  return cfg.authToken ? { "Authorization": `Bearer ${cfg.authToken}` } : {};
}

// ---------------------------------------------------------------------------
// Pure renderers — module-private (loader contract, see header); tests reach
// them through the hooks' observable output.
// ---------------------------------------------------------------------------

/** "user" → "User", "my_notes" → "My Notes" (mirrors titleCaseSection). */
function titleCaseSection(name: string): string {
  return name
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

interface IdentityResponse {
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
 * plugin does not re-sort.
 */
function renderIdentityBlock(sections: Record<string, unknown> | undefined): string | null {
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
 * should be injected: this harness ("opencode") not in the server-resolved
 * `clients` list, or no non-empty sections. Mirrors gateAndRenderIdentity
 * (the single CC/OC gate — keep the copies in sync).
 */
function gateAndRenderIdentity(data: IdentityResponse | null): string | null {
  if (!data || typeof data !== "object") return null;
  const clients = Array.isArray(data.clients) ? data.clients : [];
  if (!clients.includes(THIS_HARNESS)) return null;
  return renderIdentityBlock(data.sections);
}

interface LessonsResponse {
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
function renderLessonsBlock(data: LessonsResponse | null, maxLessons: number): string | null {
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
 * buildHookRequest: project = basename(working directory) so retrieval can
 * apply the soft project-affinity boost (retrieval-scoping: opencode is a
 * cwd-based client and must send `project`).
 */
function buildRecallBody(
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

/** Wrap one injected block in the marker fence (invisible to the model). */
function fenceBlock(block: string): string {
  return `${CONTEXT_START}\n\n${block}\n\n${CONTEXT_END}`;
}

/**
 * Build the single fenced system entry from the identity/lessons blocks, or
 * null when there is nothing to inject (no non-empty blocks). opencode's
 * system is a string ARRAY — this is the one entry we push, so the blocks
 * travel together inside one fence.
 */
function renderContextEntry(blocks: Array<string | null>): string | null {
  const parts = blocks.filter((b): b is string => typeof b === "string" && b.trim() !== "");
  if (parts.length === 0) return null;
  return `${CONTEXT_START}\n\n${parts.join("\n\n")}\n\n${CONTEXT_END}`;
}

/** True when a system array already carries our end marker → skip (no doubling). */
function systemAlreadyFenced(system: unknown): boolean {
  return Array.isArray(system) && system.some((s) => typeof s === "string" && s.includes(CONTEXT_END));
}

// ---------------------------------------------------------------------------
// Message-shape helpers (the model-request messages are structurally typed)
// ---------------------------------------------------------------------------

/**
 * The last REAL user message in a model request, with its index, or null.
 * Skips our own synthetic recall message (fresh id on a cloned shape): the
 * transform output is verified NOT to persist, but if one ever loops back
 * into a request it must not be mistaken for the turn's prompt (defense in
 * depth — same reason the reader skips fenced text).
 */
function lastUserMessage(
  messages: unknown,
): { msg: Record<string, unknown>; index: number } | null {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || typeof m !== "object" || (m as { role?: unknown }).role !== "user") continue;
    const id = (m as { id?: unknown }).id;
    if (id === "hicortex-recall" || (typeof id === "string" && id.endsWith("/hicortex-recall"))) continue;
    return { msg: m as Record<string, unknown>, index: i };
  }
  return null;
}

/** A message's text: a plain string content, or its text parts joined by "\n". */
function messageText(msg: unknown): string {
  if (!msg || typeof msg !== "object") return "";
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) =>
      p && typeof p === "object" && (p as { type?: unknown }).type === "text" && typeof (p as { text?: unknown }).text === "string"
        ? (p as { text: string }).text
        : "")
    .filter(Boolean)
    .join("\n");
}

/** The session id opencode attaches to a message (info.sessionID), or null. */
function messageSessionId(msg: unknown): string | null {
  const sid = (msg as { info?: { sessionID?: unknown } } | null)?.info?.sessionID;
  // Without a session id the recall key would collapse to "" and merge every
  // session on the server — inject nothing instead.
  return typeof sid === "string" && sid ? sid : null;
}

/**
 * Build the synthetic user message that carries the recall block: a clone of
 * the real message's `info` with a FRESH id and exactly one text part. Never
 * mutates the real message; the fresh id keeps the synthetic entry distinct
 * from the real one anywhere downstream.
 */
function buildRecallMessage(real: unknown, fenced: string): Record<string, unknown> | null {
  if (!real || typeof real !== "object") return null;
  const r = real as Record<string, unknown>;
  const msg: Record<string, unknown> = {
    role: "user",
    content: [{ type: "text", text: fenced }],
  };
  if (r.info && typeof r.info === "object") msg.info = { ...r.info };
  msg.id = typeof r.id === "string" && r.id ? `${r.id}/hicortex-recall` : "hicortex-recall";
  return msg;
}

/**
 * The session id of a dedup-reset event, or null when the event is not a
 * reset or carries no id. The two events carry it at DIFFERENT paths:
 * session.created → properties.info.id, session.compacted →
 * properties.sessionID (the @opencode-ai/sdk Event union). `name` is read as
 * a fallback discriminator so a rename upstream degrades to a no-op, not a
 * wrong-shape post.
 */
function extractResetSessionId(event: unknown): string | null {
  if (!event || typeof event !== "object") return null;
  const ev = event as { type?: unknown; name?: unknown; properties?: unknown };
  const type = typeof ev.type === "string" ? ev.type : typeof ev.name === "string" ? ev.name : "";
  const props = ev.properties as Record<string, unknown> | null | undefined;
  if (!props || typeof props !== "object") return null;
  if (type === "session.created") {
    const id = (props.info as { id?: unknown } | undefined)?.id;
    return typeof id === "string" && id ? id : null;
  }
  if (type === "session.compacted") {
    const id = props.sessionID;
    return typeof id === "string" && id ? id : null;
  }
  return null;
}

/** The working directory a hook input carries, falling back to process cwd. */
function cwdFromInput(input: unknown): string {
  const i = input as { directory?: unknown; cwd?: unknown } | null | undefined;
  if (typeof i?.directory === "string" && i.directory) return i.directory;
  if (typeof i?.cwd === "string" && i.cwd) return i.cwd;
  return process.cwd();
}

/** Best-effort session id from a hook input (shape not stable upstream). */
function inputSessionId(input: unknown): string | null {
  const i = input as { info?: { sessionID?: unknown }; sessionID?: unknown; session?: { id?: unknown } } | null | undefined;
  const candidates = [i?.info?.sessionID, i?.sessionID, i?.session?.id];
  for (const c of candidates) if (typeof c === "string" && c) return c;
  return null;
}

// ---------------------------------------------------------------------------
// Session-scoped state
// ---------------------------------------------------------------------------

/**
 * Per-session caches. RECALL_BLOCKS/PROMPT_KEYS key the per-prompt fetch:
 * a settled fetch (block, or a nothing-relevant null) is memoized for the
 * prompt; tool-loop requests of the same turn re-inject from the stash
 * instead of re-POSTing. IDENTITY/LESSONS memoize a SETTLED render (a block,
 * or a gated/empty null); a FAILED fetch is NOT cached — it retries next
 * request (the OC plugin's #313 memoize-only-on-success rule). Bounded: a
 * long-lived opencode process accumulating sessions would otherwise grow the
 * maps forever.
 */
const RECALL_BLOCKS = new Map<string, string | null>();
const PROMPT_KEYS = new Map<string, string>();
const IDENTITY_BLOCKS = new Map<string, string | null>();
const LESSONS_BLOCKS = new Map<string, string | null>();
/** In-flight / recently-fired dedup resets, keyed by session id (#316 ordering). */
const PENDING_RESETS = new Map<string, Promise<void>>();
const SESSION_STATE_CAP = 32;
/** Cache key when a hook input carries no session id (fail-soft freshness trade). */
const FALLBACK_SESSION_KEY = "__opencode__";

function pruneSessionState(): void {
  if (
    RECALL_BLOCKS.size > SESSION_STATE_CAP ||
    IDENTITY_BLOCKS.size > SESSION_STATE_CAP ||
    LESSONS_BLOCKS.size > SESSION_STATE_CAP
  ) {
    RECALL_BLOCKS.clear();
    PROMPT_KEYS.clear();
    IDENTITY_BLOCKS.clear();
    LESSONS_BLOCKS.clear();
  }
}

function dropSessionState(sessionId: string): void {
  RECALL_BLOCKS.delete(sessionId);
  PROMPT_KEYS.delete(sessionId);
  IDENTITY_BLOCKS.delete(sessionId);
  LESSONS_BLOCKS.delete(sessionId);
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
  cfg: OpencodeConfig,
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

async function fetchIdentityBlock(cfg: OpencodeConfig): Promise<string | null> {
  const resp = await fetch(`${cfg.serverUrl}/identity`, {
    headers: authHeaders(cfg),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return gateAndRenderIdentity(await resp.json() as IdentityResponse);
}

async function fetchLessonsBlock(cfg: OpencodeConfig): Promise<string | null> {
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
function resetRecallDedup(cfg: OpencodeConfig, sessionId: string): Promise<void> {
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
// Tool plumbing — REST proxies (names/descriptions mirror the OC/Pi plugins;
// args are opencode's FLAT per-arg property maps, verified live on 1.18.20 —
// plain objects, no zod). `execute` returns a plain string.
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

/** Error results are plain text strings; never throw. */
function errorResult(message: string): string {
  return `error: ${message}`;
}

async function serverGet(
  cfg: OpencodeConfig,
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
  cfg: OpencodeConfig,
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

function formatSearchResults(results: Array<SearchHit>): string {
  if (!Array.isArray(results) || results.length === 0) {
    return "No memories found.";
  }
  return results
    .map((r) => {
      const type = typeof r.memory_type === "string" ? String(r.memory_type) : "";
      const label = TYPE_LABELS[type] ?? type ?? "—";
      const score = typeof r.score === "number" ? r.score.toFixed(3) : "0.000";
      const strength = typeof r.effective_strength === "number" ? r.effective_strength.toFixed(3) : "0.000";
      const content = typeof r.content === "string" ? r.content.slice(0, 500) : "";
      return `[${label}] (score: ${score}, strength: ${strength}) ${content}`;
    })
    .join("\n\n");
}

/** The nine tools. `execute` resolves config per call (no startup capture). */
function registerTools(): Record<string, unknown> {
  return {
    hicortex_search: {
      description:
        "Search long-term memory using semantic similarity. Returns the most relevant memories from past sessions.",
      args: {
        query: { type: "string", description: "Search query text (required)" },
        limit: { type: "number", description: "Max results (default 5)" },
        project: { type: "string", description: "Filter by project name" },
      },
      async execute(args: any): Promise<string> {
        try {
          const cfg = resolveOpencodeConfig();
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
    },

    hicortex_get: {
      description:
        "Fetch ONE memory's full content by id — use this to lazy-load entries from the '## Memory recall (auto)' index or from search results whose snippet was not enough. Fetching a memory marks it as used (strengthens it), so fetch entries that could change your action — not every shown one. When the memory shapes your answer, cite it as given in the response — mark a fetched memory `FETCHED` and a one-line entry cited unread `SNIPPET`; don't pass SNIPPET off as established.",
      args: {
        id: { type: "string", description: "Memory ID (required; as shown in the recall index or search results)" },
      },
      async execute(args: any): Promise<string> {
        try {
          if (!args?.id) return errorResult("id is required");
          const cfg = resolveOpencodeConfig();
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
          return `${data.citation ?? ""}\n\n${data.memory?.content ?? ""}`.trim();
        } catch (err) {
          return errorResult(`Get failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    },

    hicortex_recent: {
      description:
        "Get recent memories, optionally filtered by project. Queryless recall of the latest memories by project, ranked by importance. Useful to catch up on what happened recently.",
      args: {
        project: { type: "string", description: "Filter by project name" },
        limit: { type: "number", description: "Max results (default 10)" },
      },
      async execute(args: any): Promise<string> {
        try {
          const cfg = resolveOpencodeConfig();
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
    },

    hicortex_ingest: {
      description:
        "Store a new memory in long-term storage. Use for Knowledge, Decisions, or Learnings.",
      args: {
        content: { type: "string", description: "Memory content to store (required)" },
        project: { type: "string", description: "Project this memory belongs to" },
        memory_type: {
          type: "string",
          description:
            "Type of memory (default: Experience). Accepted: knowledge/experience/decisions/learnings (legacy fact/episode/decision/lesson also accepted, normalized to the canonical term).",
        },
      },
      async execute(args: any): Promise<string> {
        try {
          const cfg = resolveOpencodeConfig();
          if (!cfg) return errorResult(NOT_CONFIGURED);
          const rawType = typeof args?.memory_type === "string" ? args.memory_type : "";
          const result = await serverPost(cfg, "/ingest", {
            content: args?.content,
            source_agent: "opencode/manual",
            project: args?.project,
            memory_type: rawType ? (TO_CANONICAL_TYPE[rawType.toLowerCase()] ?? rawType) : "experience",
          });
          if (!result.ok) {
            return errorResult(`Ingest failed: ${result.data?.error ?? `HTTP ${result.status}`}`);
          }
          const id = result.data?.id ?? "unknown";
          return `Memory stored (id: ${String(id).slice(0, 8)})`;
        } catch (err) {
          return errorResult(`Ingest failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    },

    hicortex_lessons: {
      description:
        "Get actionable Learnings distilled from past sessions. Auto-generated insights about mistakes to avoid.",
      args: {
        project: { type: "string", description: "Filter by project name (optional)" },
      },
      async execute(_args: any): Promise<string> {
        try {
          const cfg = resolveOpencodeConfig();
          if (!cfg) return errorResult(NOT_CONFIGURED);
          const { data, status } = await serverGet(cfg, "/learnings");
          if (!data) return errorResult(`Lessons fetch failed: ${describeGetFailure(status)}`);
          const lessons = data.lessons ?? [];
          if (lessons.length === 0) {
            return "No Learnings found.";
          }
          return lessons.map((l: { content?: unknown }) =>
            `- ${typeof l.content === "string" ? l.content.slice(0, 500) : ""}`).join("\n");
        } catch (err) {
          return errorResult(`Lessons fetch failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    },

    hicortex_index: {
      description:
        "Get the knowledge domain index — shows what topics and projects are stored in memory, grouped by domain.",
      args: {},
      async execute(_args: any): Promise<string> {
        try {
          const cfg = resolveOpencodeConfig();
          if (!cfg) return errorResult(NOT_CONFIGURED);
          const { data, status } = await serverGet(cfg, "/index");
          if (!data) return errorResult(`Index fetch failed: ${describeGetFailure(status)}`);
          return JSON.stringify(data);
        } catch (err) {
          return errorResult(`Index fetch failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    },

    hicortex_graph: {
      description:
        "Query the memory knowledge graph — find connected memories, hub nodes, or paths between memories.",
      args: {
        operation: { type: "string", description: "Graph operation to perform: neighbors, hubs, or path (required)" },
        id: { type: "string", description: "Memory ID (required for neighbors and path operations)" },
        target_id: { type: "string", description: "Target memory ID (required for path operation)" },
        limit: { type: "number", description: "Max results (default 10)" },
        domain: { type: "string", description: "Filter hubs by domain" },
        relationship: { type: "string", description: "Filter neighbors by relationship type (e.g., extends, relates_to; legacy data may also have CONTRADICTS, SUPERSEDES, updates)" },
      },
      async execute(args: any): Promise<string> {
        try {
          const cfg = resolveOpencodeConfig();
          if (!cfg) return errorResult(NOT_CONFIGURED);
          const params = new URLSearchParams({ op: String(args?.operation ?? "") });
          if (args?.id) params.set("id", String(args.id));
          if (args?.target_id) params.set("target_id", String(args.target_id));
          if (args?.limit) params.set("limit", String(args.limit));
          if (args?.domain) params.set("domain", String(args.domain));
          if (args?.relationship) params.set("relationship", String(args.relationship));
          const { data, status } = await serverGet(cfg, `/graph?${params}`);
          if (!data) return errorResult(`Graph query failed: ${describeGetFailure(status)}`);
          return JSON.stringify(data);
        } catch (err) {
          return errorResult(`Graph query failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    },

    hicortex_update: {
      description:
        "Update an existing memory. Use after searching to fix incorrect information. If content changes, the embedding is re-computed.",
      args: {
        id: { type: "string", description: "Memory ID (required; from search results, first 8 chars or full UUID)" },
        content: { type: "string", description: "New content text" },
        project: { type: "string", description: "New project name" },
        memory_type: {
          type: "string",
          description:
            "New memory type. Accepted: knowledge/experience/decisions/learnings (legacy fact/episode/decision/lesson also accepted, normalized to the canonical term).",
        },
      },
      async execute(args: any): Promise<string> {
        try {
          const cfg = resolveOpencodeConfig();
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
          return `Memory updated (id: ${String(id).slice(0, 8)})`;
        } catch (err) {
          return errorResult(`Update failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    },

    hicortex_delete: {
      description:
        "Permanently delete a memory and its links. Use when a memory is incorrect and should be removed entirely.",
      args: {
        id: { type: "string", description: "Memory ID (required; from search results, first 8 chars or full UUID)" },
      },
      async execute(args: any): Promise<string> {
        try {
          const cfg = resolveOpencodeConfig();
          if (!cfg) return errorResult(NOT_CONFIGURED);
          const result = await serverPost(cfg, "/delete", { id: args?.id });
          if (result.status === 404) {
            return errorResult(`Memory not found: ${args?.id}`);
          }
          if (!result.ok) {
            return errorResult(`Delete failed: ${result.data?.error ?? `HTTP ${result.status}`}`);
          }
          return `Memory deleted (id: ${String(args?.id).slice(0, 8)})`;
        } catch (err) {
          return errorResult(`Delete failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

/**
 * The ONE runtime export — opencode's loader invokes every exported function
 * as a plugin factory, so this single factory IS the plugin (named
 * `HicortexPlugin`; deliberately NO `export default` — a second binding of
 * the same factory is a second factory call for the loader, #353). The
 * single-export shape is live-verified on opencode 1.18.20 and 1.18.23;
 * the 0.21.0 multi-export shape was live-refuted on 1.18.23 (helper called
 * with undefined → plugin rejected). An async factory returning the hooks
 * object; never throws — a broken plugin must not take down the agent loop.
 */
export const HicortexPlugin: any = async (_input: any): Promise<Record<string, unknown>> => {
  try {
    return {
      // Dedup resets. The event hook receives { event } — narrowed
      // structurally so either the wrapper or a bare event works.
      event: async (input: any, _output: any): Promise<void> => {
        try {
          const sessionId = extractResetSessionId(input?.event ?? input);
          if (!sessionId) return;
          dropSessionState(sessionId);
          const cfg = resolveOpencodeConfig();
          if (cfg) void resetRecallDedup(cfg, sessionId);
        } catch {
          /* fail-soft */
        }
      },

      // Pushed recall (the amended #347 channel — see the header). The
      // transform output is rebuilt per model request from the STORED
      // messages, so re-injecting the stashed block on tool-loop requests
      // cannot double, and the injected message never reaches the store.
      "experimental.chat.messages.transform": async (input: any, output: any): Promise<void> => {
        try {
          const messages = Array.isArray(output?.messages) ? output.messages : null;
          if (!messages) return;
          const last = lastUserMessage(messages);
          if (!last) return;
          const sessionId = messageSessionId(last.msg);
          if (!sessionId) return;
          const cfg = resolveOpencodeConfig();
          if (!cfg) return;
          pruneSessionState();

          // Ordering (#316): a pending reset for THIS session registered
          // before this fetch must complete first — bounded by the reset's
          // own 1 s timeout, so a stalled server cannot stall the turn beyond it.
          const pending = PENDING_RESETS.get(sessionId);
          if (pending) await pending;

          const prompt = messageText(last.msg);
          // A tool-loop request repeats the SAME user message id — only a new
          // id (falling back to the prompt text when ids are absent) is a new
          // prompt worth a fetch.
          const promptKey = typeof last.msg.id === "string" && last.msg.id ? last.msg.id : prompt;
          if (PROMPT_KEYS.get(sessionId) !== promptKey) {
            const block = prompt
              ? await fetchRecallBlock(cfg, sessionId, prompt, cwdFromInput(input)).catch(() => null)
              : null;
            RECALL_BLOCKS.set(sessionId, block);
            PROMPT_KEYS.set(sessionId, promptKey);
          }
          const block = RECALL_BLOCKS.get(sessionId) ?? null;
          if (!block) return;
          const synthetic = buildRecallMessage(last.msg, fenceBlock(block));
          if (synthetic) messages.splice(last.index + 1, 0, synthetic);
        } catch {
          // Total fail-soft: inject nothing, never block the request.
        }
      },

      // Identity + lessons: ONE fenced entry appended to the system array.
      // Fetched once per session (independent fail-soft); the fence guard
      // prevents doubling when an entry already carries our end marker.
      "experimental.chat.system.transform": async (input: any, output: any): Promise<void> => {
        try {
          const system = Array.isArray(output?.system) ? output.system : null;
          if (!system || systemAlreadyFenced(system)) return;
          const cfg = resolveOpencodeConfig();
          if (!cfg) return;
          pruneSessionState();
          // The hook input's session shape is not stable across opencode
          // versions — fall back to one process-wide cache key rather than
          // skipping injection entirely.
          const sessionId = inputSessionId(input) ?? FALLBACK_SESSION_KEY;
          const [identityBlock, lessonsBlock] = await Promise.all([
            cachedBlock(IDENTITY_BLOCKS, sessionId, () => fetchIdentityBlock(cfg)),
            cachedBlock(LESSONS_BLOCKS, sessionId, () => fetchLessonsBlock(cfg)),
          ]);
          const entry = renderContextEntry([identityBlock, lessonsBlock]);
          if (entry) (system as unknown[]).push(entry);
        } catch {
          // Total fail-soft: inject nothing, never block the request.
        }
      },

      tool: registerTools(),
    };
  } catch {
    // Registration itself failed (unexpected opencode API change) — stay
    // silent; the session must proceed without memory either way.
    return {};
  }
};
