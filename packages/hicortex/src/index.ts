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
 * Responsibilities (recall-only adapter, behaviorally aligned with the Hermes
 * reference plugin — hermes-plugin/hicortex/provider.py — since #316):
 *   - before_agent_start  → GET /identity + GET /lessons once per SESSION
 *     (#316: standing blocks are not re-sent every turn; a FAILED identity
 *     fetch is retried next turn — only success memoizes, so the #313 dead-man
 *     banner keeps firing until identity returns) + POST /recall-index EVERY
 *     turn (fail-soft, concurrent; recall hot path capped at 1.5 s like
 *     Hermes). The FIRST recall fetch of a session is preceded by an AWAITED
 *     {reset:true} so a gateway restart resuming a session cannot inherit a
 *     stale server-side shown-set, and no reset can land after a fetch and
 *     wipe what it built. In OpenClaw every inbound message spawns an embedded
 *     run, so this hook fires PER TURN — it is the per-turn /recall-index
 *     surface, not just session start.
 *   - 404 on /recall-index → 600 s TTL latch + GET /search fallback that
 *     renders CONTENT (Hermes's legacy `_format_hits` shape — the pushed
 *     index's `hicortex_get(id)` menu is useless against the pre-0.14 servers
 *     the fallback exists for) — old servers keep full-content recall instead
 *     of degrading to nothing. Auth/5xx errors do NOT latch-fallback (they
 *     are errors, not version skew): fail soft per turn + warn ONCE per HTTP
 *     status.
 *   - after_compaction / before_reset → POST /recall-index {reset:true}
 *     (context window rebuilt → the server's per-session shown-set is stale
 *     AND the standing blocks may have been dropped → re-injected next turn)
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
import { sanitizeAgentId } from "./identity-store.js";
import { gateAndRenderIdentity, type IdentityResponse } from "./learnings-identity.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import type { HicortexConfig, MemorySearchResult, ModuleIndex } from "./types.js";
import { labelForType, normalizeMemoryType } from "./type-labels.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_SERVER_URL = "http://127.0.0.1:8787";
const LESSONS_TIMEOUT_MS = 3000;
const IDENTITY_TIMEOUT_MS = 3000;
/**
 * Recall hot-path ceiling (#316): /recall-index (and /memory via hicortex_get)
 * run inside every turn / tool call, so a slow or wedged server must cost at
 * most this much — matching the Hermes reference (client.py RECALL_TIMEOUT
 * 1.5 s), NOT the general tool ceilings (5–15 s) meant for interactive use.
 */
const RECALL_TIMEOUT_MS = 1500;
/**
 * Pre-0.14 /search fallback ceiling (#316 CR): its own budget, NOT the pushed-
 * index hot path — /search runs a server-side embed of the prompt (a cold
 * embedder loads the ONNX model), which the 1.5 s ceiling can starve. Hermes
 * gives this exact path its 5 s client default; we match it.
 */
const SEARCH_FALLBACK_TIMEOUT_MS = 5000;
/** Content cap per line in the pre-0.14 /search fallback block — Hermes's
 *  `_INJECT_CONTENT_CAP` (provider.py): the fallback renders CONTENT (the
 *  pushed index's one-liner menu is useless here — its `hicortex_get(id)`
 *  instruction points at a 0.14+ endpoint that 404s on these servers). */
const LEGACY_CONTENT_CAP = 500;
/** Default max memories per recall on the legacy /search fallback (config
 *  `recallLimit`, #316). The pushed /recall-index is sized by SERVER config
 *  (`recallMaxItems`) — the server accepts no client limit — so this knob
 *  applies where a client limit actually exists: the pre-0.14 fallback. */
const DEFAULT_RECALL_LIMIT = 8;
/** Cap for the per-session LRU trackers (#316 CR: raised from 50 — a
 *  multi-agent gateway fans sessions across agents; evicting a live session's
 *  memo only costs ONE re-injection / re-reset, never per-turn spam, so a
 *  generous cap is cheap insurance. Eviction is accepted behavior.) */
const SESSION_TRACKER_CAP = 200;
const HICORTEX_HOME = resolveHicortexHome();

/** Harness name this plugin injects for — used to self-gate on GET /identity `clients`. */
const THIS_HARNESS = "oc";

// ---------------------------------------------------------------------------
// Module state — initialized in registerService.start()
// ---------------------------------------------------------------------------

let serverUrl = DEFAULT_SERVER_URL;
let authToken: string | undefined;
let hicortexHome = HICORTEX_HOME;
/** Resolved plugin config captured at service start — used for tunable knobs
 *  (e.g. lessonsLimit, recallLimit) that injected context blocks read at hook
 *  time. */
let pluginConfig: HicortexConfig | null = null;
/** `defaultProject` from plugin config (#316): sent as the `project` fallback
 *  on recall-index, the /search fallback, and the search/recent/ingest tools
 *  whenever the gateway supplies no project (Hermes `default_project`). */
let defaultProject: string | undefined;
/** Old-server guard (F2): 0 = not latched; otherwise the Date.now() epoch-ms
 *  until which /recall-index is skipped after a 404 (pre-0.14 server) and the
 *  legacy /search fallback is used instead (#316 — full Hermes parity: recall
 *  degrades to full-content /search injection, not to nothing). The latch
 *  EXPIRES so a client-first rollout heals itself once the server is
 *  upgraded — a permanent latch would pin the legacy path on a long-running
 *  gateway until restart. */
let recallIndexRetryAtMs = 0;
/** How long a 404 latches the guard before re-probing. Long enough not to
 *  hammer an old server every turn, short enough that a server upgrade is
 *  picked up within minutes. */
const RECALL_REPROBE_INTERVAL_MS = 600_000;
/** Warn-once flag (F5): the recall index needs ctx.sessionId from the
 *  gateway; if a gateway variant doesn't pass it the feature must not run
 *  silently dead. */
let warnedMissingSessionId = false;
/** Warn-once bookkeeping for /recall-index HTTP errors (#316, mirrors Hermes
 *  review F3): a persistent non-404 error — especially 401/403 from a bad
 *  token — surfaces at WARNING once per DISTINCT status, then fails soft per
 *  turn. Without this, a bad token kills per-turn recall with zero logging. */
const warnedRecallStatuses = new Set<number>();
/** Warn-once flag for /search fallback failures (#316 CR finding 3): fires on
 *  the first failure of a streak, re-armed by any successful fallback fetch. */
let warnedLegacyFallbackFailure = false;
/** Warn-once-per-PROCESS flag (#326): unpinned gateway plugins.allow. NOT
 *  reset at start() — a gateway restart inside one process must not re-warn
 *  (a new process starts with clean flags anyway). */
let warnedUnpinnedPlugins = false;
/** Warn-once-per-PROCESS bookkeeping (#326) for dead-man scaffold SKIPS and
 *  failures — one warning per distinct cause (relative path, missing dir,
 *  non-UTF-8 file, fs error), never reset at start(). */
const warnedScaffoldSkips = new Set<string>();
/** Plugin logger captured at service start (ctx.logger or console). */
let pluginLog: (msg: string) => void = console.log;

/** Sessions whose server-side recall dedup was already reset this process
 *  (#316): the reset rides BEFORE the session's first recall fetch so a
 *  gateway restart resuming a live session cannot inherit a stale shown-set
 *  (suppression otherwise persists for recallReshowTurns turns). */
const sessionsReset = makeBoundedSessionTracker(SESSION_TRACKER_CAP);
/**
 * #316 once-per-session standing blocks — per-turn injection is the recall
 * block ONLY. Two INDEPENDENT memos (#316 CR finding 4): identity and lessons
 * settle separately (an OK identity + a failed /lessons must not memoize the
 * lessons away for the whole session), so each block memoizes on its own
 * success and is skipped only when ITS memo holds.
 *
 * PERSISTENCE PREMISE (verified live against the gateway dist on the fleet,
 * reply-Bm8VrLQh.js, #316 CR finding 1): the gateway composes hook results as
 * `prependSystemContext + baseSystemPrompt + appendSystemContext` and applies
 * them via `applySystemPromptOverrideToSession(activeSession, composed)` — the
 * append PERSISTS on the session across turns. So the once-per-session memo
 * is not just token hygiene, it is CORRECTNESS: re-sending identity/lessons
 * every turn would duplicate them into the stored prompt.
 *
 * Residual (accepted): after a gateway RESTART resumes a persisted session the
 * memos are empty while the session may already carry an overridden prompt —
 * one duplicate append per restart is possible. Whether the override persists
 * to disk was not determined (no local dist to verify); even in the worst case
 * the cost is a single duplicated block per restart, never per turn.
 *
 * Residual (delta CR N5, accepted): two OVERLAPPING before_agent_start runs
 * for the same session can both pass has() before either add() — one duplicate
 * standing append. OC embedded runs are serialized per session in practice;
 * if that ever changes, an in-flight promise per key (pendingResets shape)
 * closes it. Not a regression: pre-#316 injected every turn.
 */
const identityInjected = makeBoundedSessionTracker(SESSION_TRACKER_CAP);
const lessonsInjected = makeBoundedSessionTracker(SESSION_TRACKER_CAP);
/**
 * #327 banner lifecycle — notices memoized SEPARATELY from identityInjected.
 * appendSystemContext persists on the session (premise above), so a FAILED
 * identity fetch that re-injects the IDENTITY UNAVAILABLE banner every turn
 * accumulates one copy per turn of an outage (dozens over an hour) — and the
 * suspension wording then never retracts. The FETCH still retries every turn
 * (identityInjected is only set on success); the NOTICE (banner or 404
 * version-skew note) is appended once per outage, and the first success that
 * delivers identity content prepends a one-line retraction (see
 * IDENTITY_RESTORED_RETRACTION). Two trackers so the kinds settle
 * independently — a 404 note must not suppress a later genuine-outage banner.
 * Evicted on compaction/reset with the other memos: a rebuilt window may have
 * dropped the notice, so one re-inject after the rebuild is wanted, not lost.
 */
const identityBannerShown = makeBoundedSessionTracker(SESSION_TRACKER_CAP);
const identityNoteShown = makeBoundedSessionTracker(SESSION_TRACKER_CAP);
/** In-flight {reset:true} POSTs by session key (#316). A compaction hook fires
 *  a reset fire-and-forget (F9 — no latency on compaction); the NEXT recall
 *  fetch for that session AWAITS the entry here, so a slow reset can never
 *  land after the fetch and wipe the shown-set the fetch just built. */
const pendingResets = new Map<string, Promise<void>>();

/**
 * Tracker key: `${agentId}:${sessionId}` (#316 CR finding 7) — the trackers
 * are process-global, and a multi-agent gateway can reuse a session id across
 * agents; keying on the bare sessionId would let one agent's memo suppress
 * another's injection. The sanitized agent id charset ([a-z0-9_-]) makes ":"
 * an unambiguous separator; null id (symbols-only / absent) → "" prefix.
 */
function sessionKey(agentId: string | null, sessionId: string): string {
  return `${agentId ?? ""}:${sessionId}`;
}

/**
 * Insertion-ordered Map used as a bounded LRU set of session ids. `has`
 * touches (re-inserts) the entry; `add` evicts the least-recently-used when
 * over cap. Long-running gateways see unbounded sessions — the plugin's view
 * of them must stay bounded.
 */
function makeBoundedSessionTracker(cap: number) {
  const seen = new Map<string, true>();
  return {
    has(id: string): boolean {
      if (!seen.has(id)) return false;
      seen.delete(id);
      seen.set(id, true);
      return true;
    },
    add(id: string): void {
      seen.delete(id);
      seen.set(id, true);
      if (seen.size > cap) {
        const oldest = seen.keys().next().value;
        if (oldest !== undefined) seen.delete(oldest);
      }
    },
    evict(id: string): void {
      seen.delete(id);
    },
    clear(): void {
      seen.clear();
    },
  };
}

function recallIndexLatched(): boolean {
  return recallIndexRetryAtMs !== 0 && Date.now() < recallIndexRetryAtMs;
}

/** Recall limit for the legacy /search fallback (#316): config `recallLimit`
 *  (a POSITIVE INTEGER, default 8). Validated at the boundary like
 *  readPositiveConfig, but integer-strict (#316 CR 8b): readPositiveConfig +
 *  Math.floor accepts 0.5 and floors it to 0 — an empty (header-only) fallback
 *  block. A non-integer or non-positive value warns once and uses 8. */
let warnedRecallLimitInvalid = false;
function recallLimit(config?: HicortexConfig | null): number {
  if (!config) return DEFAULT_RECALL_LIMIT;
  const v = config.recallLimit;
  if (v === undefined) return DEFAULT_RECALL_LIMIT;
  if (typeof v === "number" && Number.isInteger(v) && v > 0) return v;
  // Warn ONCE (delta CR N2): recallLimit() runs per fallback fetch — a raw
  // per-turn console.warn on a latched pre-0.14 server is stderr spam, and it
  // bypassed the gateway's plugin-log capture like no other #316 warning.
  if (!warnedRecallLimitInvalid) {
    warnedRecallLimitInvalid = true;
    pluginLog(
      `[hicortex] WARNING: config "recallLimit" = ${String(v)} is not a positive integer — using default ${DEFAULT_RECALL_LIMIT}.`,
    );
  }
  return DEFAULT_RECALL_LIMIT;
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
// Identity layer — per-agent standing identity (0.13; renamed from context
// layer in 0.18 #264)
// ---------------------------------------------------------------------------

/**
 * Outcome of an identity fetch at hook time: the rendered `## Identity` block
 * (null when deliberately nothing — gated out, mode off, or all sections
 * blank), whether the FETCH ITSELF failed, and the HTTP status of that
 * failure. The distinction powers the dead-man banner (#313): only a genuine
 * failure (unreachable, non-2xx, parse error) is "identity unavailable"; a
 * gated response is an operator decision and must not cry wolf. A 404 is its
 * own taxonomy (version skew, not outage — see IDENTITY_VERSION_SKEW_NOTE).
 */
interface OcIdentityResult {
  block: string | null;
  failed: boolean;
  /** HTTP status of a failed fetch (500, 404, …); null when unreachable/thrown. */
  status: number | null;
}

/**
 * Fetch GET /identity (per-agent when an id is supplied) and build the
 * `## Identity` block via the shared gate (gateAndRenderIdentity). The
 * old-server guard is required only when an agent id was actually sent
 * (amendment A2 — a bare fetch skips it). The server does the merge; the
 * plugin stays dumb (no client-side mode logic). `failed: true` ONLY when the
 * fetch itself failed (serverGet null data) — gating to null stays `failed:
 * false` (the guard fired, or the harness is not in `clients`).
 */
async function fetchOcIdentity(agentId: string | null): Promise<OcIdentityResult> {
  const path = agentId ? `/identity?agent=${encodeURIComponent(agentId)}` : "/identity";
  const { data, status } = await serverGet<IdentityResponse>(path, IDENTITY_TIMEOUT_MS);
  if (!data) return { block: null, failed: true, status };
  return {
    block: gateAndRenderIdentity(data, THIS_HARNESS, { requireAgentEcho: agentId !== null }),
    failed: false,
    status,
  };
}

/**
 * Dead-man banner (#313): injected INSTEAD of nothing when the /identity fetch
 * fails at session start. OC agents are PUBLIC-facing — an agent whose
 * standing identity (who it is + its conduct rules) could not be fetched must
 * be told so mechanically, not run voiceless on silence: suspend public
 * actions until identity returns. A prompt-only sentence is weak; as plugin
 * behavior it is testable, and the next successful turn replaces it
 * automatically (the hook re-fetches per turn). Scope: OC plugin only — CC and
 * Hermes keep plain fail-soft (they are operator-facing harnesses, not
 * autonomous public agents). A 404 is NOT a banner-worthy failure — version
 * skew gets IDENTITY_VERSION_SKEW_NOTE (CR2).
 */
const IDENTITY_UNAVAILABLE_BANNER = [
  "## IDENTITY UNAVAILABLE — public actions suspended",
  "",
  "The standing identity layer (who this agent is, and its conduct rules) could not be fetched from the memory server. Until it returns:",
  "- Do NOT take public-facing actions (posting, replying, messaging, purchasing — anything visible to third parties).",
  "- Do NOT speak or act in the agent persona's voice.",
  "- Limit yourself to private, reversible work.",
  "",
  "This banner stands in for the missing identity block. Restore the Hicortex server; identity is re-fetched on the next turn.",
].join("\n");

/**
 * Version-skew note (#313 CR2): the dead-man banner must NOT fire on a 404.
 * A plugin pinned in a gateway against a pre-0.12 server (no /identity
 * route) would otherwise inject "public actions suspended" on EVERY turn —
 * permanent self-suspension from version skew, with the wrong remediation
 * (the server is not down, it is old). One diagnostic line, reusing
 * describeGetFailure's wording; identity injection resumes once the server
 * is upgraded.
 */
const IDENTITY_VERSION_SKEW_NOTE =
  `[hicortex] Identity layer skipped — ${describeGetFailure(404, "/identity")}. ` +
  `This is version skew, not an outage: no action suspension applies; identity returns once the server is upgraded.`;

/**
 * Recovery retraction (#327): when identity content arrives for a session that
 * earlier got the dead-man banner, this line rides FIRST in that turn's
 * injection. The banner persists on the session prompt, so without an explicit
 * lift the "public actions suspended" wording outlives the outage for the rest
 * of the session. NOT sent for the 404 note (it carries no suspension) and NOT
 * for a gated/off success — identity content is the one outcome that actually
 * restores what the banner said was missing.
 */
const IDENTITY_RESTORED_RETRACTION =
  `[hicortex] The earlier IDENTITY UNAVAILABLE notice no longer applies — ` +
  `identity restored.`;

/**
 * The #313 SECONDARY layer, verbatim (#326): the bootstrap-file sentence that
 * still guards the agent when the plugin itself cannot inject anything — the
 * banner above needs a live hook, while this line rides the agent's persisted
 * bootstrap instructions. Installs kept forgetting to add it by hand, so the
 * plugin now scaffolds it itself at service start (scaffoldDeadManGuard).
 */
const DEAD_MAN_GUARD_LINE =
  "If your identity block is missing at session start, something is wrong with your memory — take no public actions until it returns.";

/** Agent workspace bootstrap file the guard line is scaffolded into (#326). */
const BOOTSTRAP_FILENAME = "BOOTSTRAP.md";

/** Result of a lessons fetch at hook time: the rendered block (null when
 *  nothing survives selection) and whether the FETCH ITSELF failed. The
 *  distinction powers the independent per-session memo (#316 CR finding 4):
 *  a failed fetch must retry next turn, while an empty-but-successful fetch
 *  is settled and memoizes. */
interface OcLessonsResult {
  block: string | null;
  failed: boolean;
}

/**
 * Fetch /lessons and build the `## Hicortex Learnings` block. `failed: true`
 * ONLY when the fetch itself failed (serverGet null data — unreachable,
 * non-2xx, parse error); a successful fetch that selects zero lessons is
 * `failed: false` with a null block. Preserves the pre-0.13 lesson output;
 * the caller prepends the `## Identity` block and adds separators.
 */
async function buildLessonsBlock(project?: string): Promise<OcLessonsResult> {
  const { data } = await serverGet<LessonsApiResponse>("/lessons", LESSONS_TIMEOUT_MS);
  if (!data) return { block: null, failed: true };
  if (!data.lessons || data.lessons.length === 0) return { block: null, failed: false };

  const maxLessons = lessonsLimit(pluginConfig);
  const state = loadState(hicortexHome);
  const moduleIndex = data.moduleIndex ?? state.moduleIndex;
  const selected = await getLessonSelector().select(data.lessons, {
    maxLessons,
    project,
    moduleIndex,
  });
  if (selected.length === 0) return { block: null, failed: false };

  const formatted = selected.map((l) => {
    const typeMatch = l.content.match(/\*\*Type:\*\* (\w+)/);
    const severityMatch = l.content.match(/\*\*Severity:\*\* (\w+)/);
    // First line, with any legacy `## Lesson:` prefix stripped — new lessons
    // are stored topic-first without the prefix (memory_type carries the type).
    const title = l.content.replace(/^##\s*Lesson:\s*/i, "").split("\n")[0].slice(0, 150);
    const meta = [severityMatch?.[1], typeMatch?.[1]].filter(Boolean).join(", ");
    return `- ${title}${meta ? ` (${meta})` : ""}`;
  });

  return {
    block:
      `## Hicortex Learnings (auto-injected from long-term memory)\n` +
      `These are actionable Learnings from past sessions:\n\n` +
      formatted.join("\n"),
    failed: false,
  };
}

// ---------------------------------------------------------------------------
// Pushed recall index (#193) — per-turn POST /recall-index
// ---------------------------------------------------------------------------

/** Arm the pre-0.14 latch and log it — called only on a definitive 404. The
 *  guard makes the log fire at most ONCE per latch window: two probes can see
 *  the same 404 inside one turn (session-start reset + recall fetch), and
 *  while latched no further probe runs to 404 again. Hermes parity (#316):
 *  the latch note must be visible, not a silent skip to nothing. */
function latchRecallIndex(): void {
  if (recallIndexLatched()) return;
  recallIndexRetryAtMs = Date.now() + RECALL_REPROBE_INTERVAL_MS;
  pluginLog(
    "[hicortex] /recall-index not on the server (pre-0.14) — recall falls " +
    "back to /search; re-probing in 10 min.",
  );
}

/**
 * Pre-0.14 fallback recall (#316, Hermes parity): GET /search with the turn's
 * prompt and render CONTENT, not the pushed index's one-liner menu — Hermes's
 * legacy `_format_hits` shape (`provider.py`): the index shape is useless
 * here because its `hicortex_get(id)` instruction points at a 0.14+ endpoint
 * that 404s on exactly the servers this fallback exists for (#316 CR
 * finding 2). So an old server degrades to full-content recall, not nothing.
 * Timeout: 5 s (its OWN ceiling — /search embeds the prompt server-side and a
 * cold embedder loads the ONNX model; this is not the pushed-index hot path).
 * No per-session dedup exists on this path (same as Hermes's legacy
 * prefetch); a latched plugin re-probes /recall-index when the TTL expires.
 */
async function legacySearchRecallBlock(prompt: string, project?: string): Promise<string | null> {
  const limit = recallLimit(pluginConfig);
  const params = new URLSearchParams({ query: prompt, limit: String(limit) });
  const effectiveProject = project ?? defaultProject;
  if (effectiveProject) params.set("project", effectiveProject);
  const { data, status } = await serverGet<{ results?: MemorySearchResult[] }>(
    `/search?${params}`,
    SEARCH_FALLBACK_TIMEOUT_MS,
  );
  if (!data || !Array.isArray(data.results)) {
    // Warn ONCE per failure streak (#316 CR finding 3 — this path was totally
    // silent): a server old enough to latch the fallback can also be broken
    // for /search, and a permanently-empty recall must be diagnosable. A
    // SUCCESSFUL fetch re-arms the warning so a later regression is heard.
    // Delta CR N4: carry the status (and the token hint for 401/403) so the
    // operator isn't always told to "check server health" on an auth problem.
    if (!warnedLegacyFallbackFailure) {
      warnedLegacyFallbackFailure = true;
      const tokenHint = status === 401 || status === 403 ? " — check the authToken config" : "";
      const statusNote = status ? `; last status ${status}` : "";
      pluginLog(
        "[hicortex] WARNING: /search recall fallback failed — recall is empty " +
        `while this persists (the server predates /recall-index; check its health${statusNote}${tokenHint}).`,
      );
    }
    return null;
  }
  warnedLegacyFallbackFailure = false;
  if (data.results.length === 0) return null;
  // Hermes's `_format_hits` line: `- [YYYY-MM-DD, project] content…` — content
  // flattened (newlines → spaces) and capped at LEGACY_CONTENT_CAP.
  const lines = data.results.slice(0, limit).map((r) => {
    const date = (r.created_at ?? "").slice(0, 10);
    const proj = r.project || "global";
    let content = (r.content ?? "").trim().replace(/\n+/g, " ");
    if (content.length > LEGACY_CONTENT_CAP) {
      // Code-point truncation (Hermes slices a Python str): a UTF-16 cut at
      // exactly 500 can split an astral char (emoji are common in chat-derived
      // memories) and inject a lone surrogate at the boundary.
      content = `${Array.from(content).slice(0, LEGACY_CONTENT_CAP).join("")}…`;
    }
    return `- [${date}, ${proj}] ${content}`;
  });
  return [
    "## Memory recall (auto)",
    "Relevant prior context from your long-term memory (verify before relying on these — each shows date and project):",
    ...lines,
  ].join("\n");
}

/**
 * Fetch the pushed recall index for this turn, or null when there is nothing
 * to inject (null block, no session id, failure, or a pre-0.14 server on the
 * /search fallback). The server does all relevance gating and per-session
 * TURN-based dedup — the plugin sends every turn and carries no tuning
 * constants. Error taxonomy (#316, Hermes parity):
 *   - 404   → version skew: latch the TTL guard + fall back to /search THIS
 *             turn and until the latch expires.
 *   - other !ok → an error, not a version signal: warn ONCE per distinct
 *             status (401/403 with a token hint) and fail soft this turn —
 *             the /search fallback would hit the same wall anyway.
 */
async function fetchRecallIndexBlock(
  sessionId: string | undefined,
  prompt: string | undefined,
  project?: string,
  resetKey?: string,
): Promise<string | null> {
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
  if (recallIndexLatched()) return legacySearchRecallBlock(prompt, project);
  // #316 ordering: a pending {reset:true} for THIS session (session-start or
  // compaction) registered BEFORE this fetch must complete first — a reset
  // landing after the fetch would wipe the shown-set/turn state the fetch
  // just built. Awaited by the composite agentId:sessionId key (finding 7)
  // so concurrent agents on one gateway never wait on each other's resets.
  // Residual (delta CR N3, accepted): a compaction reset registered WHILE a
  // same-session fetch is already in flight, or under a degraded compaction
  // ctx (missing agentId → ":sid" key mismatch), can still land after it —
  // one turn of re-show, never suppression; sequential turns are covered.
  await pendingResets.get(resetKey ?? sessionId);
  // The awaited reset may itself have 404-latched (that is often how the
  // latch is first discovered) — skip the doomed probe and go to fallback.
  if (recallIndexLatched()) return legacySearchRecallBlock(prompt, project);
  // #203 scope: send the gateway-supplied project so retrieval can apply a soft
  // project-affinity boost (no hard filter — "no hard filters in brains").
  // Absent ⇒ defaultProject (if configured) ⇒ else no scope sent.
  const body: { session_id: string; prompt: string; project?: string } = {
    session_id: sessionId,
    prompt,
  };
  const effectiveProject = project ?? defaultProject;
  if (effectiveProject) body.project = effectiveProject;
  const { ok, status, data } = await serverPost<{ block?: string | null }>(
    "/recall-index",
    body,
    RECALL_TIMEOUT_MS,
  );
  if (status === 404) {
    latchRecallIndex();
    return legacySearchRecallBlock(prompt, project);
  }
  if (!ok) {
    // Warn once per distinct status; network errors (status 0) stay silent —
    // the server-down case is already surfaced by the startup probe and the
    // #313 identity banner (Hermes logs those at debug too). Routed through
    // pluginLog (#316 CR 8a), not raw console.warn: a gateway capturing plugin
    // logs must not lose the one warning that explains dead recall.
    if (status > 0 && !warnedRecallStatuses.has(status)) {
      warnedRecallStatuses.add(status);
      const hint = status === 401 || status === 403
        ? " — check the authToken config (or the HICORTEX_AUTH_TOKEN env var)"
        : "";
      pluginLog(
        `[hicortex] WARNING: /recall-index returned HTTP ${status}; recall ` +
        `injection is disabled while this persists${hint}.`,
      );
    }
    return null;
  }
  if (!data) return null;
  recallIndexRetryAtMs = 0;
  return typeof data.block === "string" && data.block.trim() !== "" ? data.block : null;
}

/**
 * POST {session_id, reset:true}. Fail-soft: a reset that is lost only means
 * some memories stay suppressed until the re-show window
 * (`recallReshowTurns`) passes. The wire session_id stays the RAW gateway
 * session id (the server registry's key — unchanged contract); only the
 * LOCAL in-flight map uses the composite agentId:sessionId key.
 */
async function postRecallReset(sessionId: string): Promise<void> {
  if (recallIndexLatched()) return;
  const { status } = await serverPost<unknown>(
    "/recall-index",
    { session_id: sessionId, reset: true },
    RECALL_TIMEOUT_MS,
  );
  if (status === 404) latchRecallIndex();
}

/**
 * Reset the session's server-side recall dedup, deduplicated per session:
 * concurrent callers share ONE in-flight POST (registered in pendingResets so
 * the next recall fetch for the session awaits it — see fetchRecallIndexBlock).
 * `key` is the composite agentId:sessionId (#316 CR finding 7) used for the
 * LOCAL map only; the wire body carries the raw `sessionId`. Never rejects.
 */
function resetRecallDedup(sessionId: string, key: string): Promise<void> {
  const inFlight = pendingResets.get(key);
  if (inFlight) return inFlight;
  const p = postRecallReset(sessionId)
    .catch(() => {
      /* fail-soft — never surface into the gateway */
    })
    .finally(() => {
      if (pendingResets.get(key) === p) pendingResets.delete(key);
    });
  pendingResets.set(key, p);
  return p;
}

// ---------------------------------------------------------------------------
// Tool result formatter
// ---------------------------------------------------------------------------

export function formatToolResults(
  results: MemorySearchResult[],
): { content: Array<{ type: string; text: string }> } {
  if (results.length === 0) {
    return { content: [{ type: "text", text: "No memories found." }] };
  }
  const text = results
    .map(
      (r) =>
        `[${labelForType(r.memory_type)}] (score: ${r.score.toFixed(3)}, strength: ${r.effective_strength.toFixed(3)}) ${r.content.slice(0, 500)}`,
    )
    .join("\n\n");
  return { content: [{ type: "text", text }] };
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

/** Object (not null, not array) → itself as a record; anything else → undefined. */
function isRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? v as Record<string, unknown>
    : undefined;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** Human name for a config value that failed validation. Only ever called
 *  with INVALID values (non-strings and empty strings), so the string branch
 *  means "empty string". */
function describeInvalid(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "an array";
  if (typeof v === "string") return "an empty string";
  return typeof v === "object" ? "an object" : `a ${typeof v}`;
}

/**
 * Resolve the plugin's config from the raw `ctx.config` OC hands the service
 * (the ENTIRE openclaw.json — verified against gateway-cli createServiceContext:
 * config = params.cfg — not a per-plugin section). Stateless: touches no module
 * state, never mutates the input, never throws (console.warn is its only side
 * effect). Three branches, first match wins:
 *
 *   1. `plugins.entries.hicortex.config` — the canonical OC per-plugin
 *      section. Only eligible when it is a non-null object with ≥1 OWN key:
 *      OC scaffolds `config: {}` for an installed-but-unconfigured plugin,
 *      and that empty object must not shadow real config further down.
 *   2. `hicortex` at the top level — but only when `typeof === "object"`:
 *      a string/bool/number there (e.g. `"hicortex": true` as a feature
 *      toggle) is not a config and is skipped, not cast.
 *   3. the top level itself — bare keys (`serverUrl`, `authToken`, …) at the
 *      root of openclaw.json; the pre-0.19 shape, kept for backcompat.
 *
 * `serverUrl` and `authToken` are validated at this boundary: a present but
 * non-string (or empty-string) value warns naming the key and degrades —
 * serverUrl falls back to DEFAULT_SERVER_URL, authToken to undefined. No
 * throw paths: a malformed config degrades to defaults instead of leaving
 * the plugin half-initialized.
 */
export function resolveOcPluginConfig(raw: unknown): HicortexConfig {
  const warn = (msg: string) => console.warn(`[hicortex] WARNING: ${msg}`);
  const full: Record<string, unknown> = isRecord(raw) ?? {};

  // Branch 1 — isRecord at every level: a missing key, string, array, or
  // null anywhere in the chain just falls through to the next branch.
  const plugins = isRecord(full.plugins);
  const entries = isRecord(plugins?.entries);
  const entry = isRecord(entries?.hicortex);
  const entryConfig = isRecord(entry?.config);
  const nested = entryConfig !== undefined && Object.keys(entryConfig).length > 0
    ? entryConfig
    : undefined;

  // Branch 2 — top-level `hicortex`, object-guarded (see doc block).
  const hicortexObj = isRecord(full.hicortex);

  const winner = nested ?? hicortexObj ?? full;
  const winnerPath = nested !== undefined
    ? "plugins.entries.hicortex.config"
    : hicortexObj !== undefined ? "hicortex" : "the top level of openclaw.json";

  // Copy, never the caller's object: sanitizing below must not mutate
  // ctx.config, and pluginConfig must not alias OC's config state.
  const resolved = { ...winner } as HicortexConfig;

  const rawUrl: unknown = winner.serverUrl;
  if (rawUrl !== undefined && !isNonEmptyString(rawUrl)) {
    warn(
      `plugin config key "serverUrl" must be a non-empty string (got ${describeInvalid(rawUrl)}) ` +
      `— falling back to ${DEFAULT_SERVER_URL}`,
    );
    resolved.serverUrl = DEFAULT_SERVER_URL;
  }
  const rawToken: unknown = winner.authToken;
  if (rawToken !== undefined && !isNonEmptyString(rawToken)) {
    warn(
      `plugin config key "authToken" must be a non-empty string (got ${describeInvalid(rawToken)}) — ignoring it`,
    );
    resolved.authToken = undefined;
  }
  const rawProject: unknown = winner.defaultProject;
  if (rawProject !== undefined && !isNonEmptyString(rawProject)) {
    warn(
      `plugin config key "defaultProject" must be a non-empty string (got ${describeInvalid(rawProject)}) — ignoring it`,
    );
    resolved.defaultProject = undefined;
  }
  // #326 kill-switch: boolean-only. typeof (not describeInvalid — that helper
  // names INVALID-STRING shapes and would misreport a non-empty string).
  const rawScaffold: unknown = winner.scaffoldDeadMan;
  if (rawScaffold !== undefined && typeof rawScaffold !== "boolean") {
    warn(
      `plugin config key "scaffoldDeadMan" must be a boolean (got ${typeof rawScaffold}) — ignoring it`,
    );
    resolved.scaffoldDeadMan = undefined;
  }

  // Shadow detection (F2) — two configs disagreeing, surfaced instead of
  // silently honoring one of them. Case 1: an OC-scaffolded EMPTY
  // plugins.entries.hicortex.config was skipped while a bare top-level
  // serverUrl exists (the exact shape the ≥1-own-key rule exists for).
  // Gate on the ACTUAL winner (re-CR F1): in the compound shape (empty
  // nested config + a top-level hicortex object + bare serverUrl) the hicortex
  // object wins — the warn must not claim the bare key is being used.
  if (nested === undefined && entryConfig !== undefined && winner === full && isNonEmptyString(full.serverUrl)) {
    warn(
      `plugins.entries.hicortex.config is empty, so the top-level serverUrl is used instead — ` +
      `remove the empty config section or move serverUrl into it`,
    );
  }
  // Case 2: a real nested/hicortex section won the chain but carries no valid
  // serverUrl, while a bare top-level serverUrl is set and will NOT be read.
  if (winner !== full && !isNonEmptyString(rawUrl) && isNonEmptyString(full.serverUrl)) {
    warn(
      `top-level serverUrl is set but ${winnerPath} takes precedence and has no valid serverUrl — ` +
      `the plugin will NOT use the top-level value; move serverUrl into ${winnerPath}`,
    );
  }

  return resolved;
}

/**
 * Resolve the agent workspace directory from the RAW gateway config (#326):
 * OpenClaw's `agents.defaults.workspace`. Pure — no module state, no fs, no
 * mutation, never throws. Absent/non-string/empty → null (the caller falls
 * back to the OC default workspace). Deliberately does NOT read the plugin's
 * own config section: the workspace is a gateway-level fact, not a plugin
 * knob, so it is resolved from ctx.config directly (the whole openclaw.json,
 * same object resolveOcPluginConfig walks).
 */
export function resolveOcWorkspaceDir(raw: unknown): string | null {
  const agents = isRecord(isRecord(raw)?.agents);
  const workspace = isRecord(agents?.defaults)?.workspace;
  return isNonEmptyString(workspace) ? workspace : null;
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
        // OC passes the ENTIRE openclaw.json as ctx.config (verified against
        // gateway-cli createServiceContext: config = params.cfg), not a
        // per-plugin section. resolveOcPluginConfig picks our section out of
        // it (branch order documented on the function) and validates the
        // scalar keys at the boundary. It never throws, so a malformed config
        // can only degrade (warn + default), never half-initialize the plugin.
        const config = resolveOcPluginConfig(ctx.config);
        pluginConfig = config;
        const log = ctx.logger
          ? (msg: string) => ctx.logger.info(msg)
          : console.log;

        // Resolve server URL and auth token: plugin config first, then the
        // HICORTEX_URL / HICORTEX_AUTH_TOKEN env vars as FALLBACKS when config
        // omits them (#316). Deliberate divergence from Hermes (whose env
        // OVERRIDES its config file): openclaw.json is operator-managed via
        // the gateway UI, so an env var silently winning over it would
        // surprise; here env only fills gaps (empty env values = unset).
        const envUrl = process.env.HICORTEX_URL?.trim();
        const envToken = process.env.HICORTEX_AUTH_TOKEN?.trim();
        serverUrl = (config.serverUrl ?? (envUrl || undefined) ?? DEFAULT_SERVER_URL)
          .replace(/\/+$/, "");
        authToken = config.authToken ?? (envToken || undefined);
        defaultProject = config.defaultProject;
        // Use stateDir from context so tests can redirect state writes
        hicortexHome = ctx.stateDir ?? HICORTEX_HOME;
        // Re-probe /recall-index support on every (re)start — the server may
        // have been upgraded while the gateway was down. Session trackers
        // reset too: a restarted gateway re-injects standing blocks and re-
        // resets the dedup for any session it resumes.
        recallIndexRetryAtMs = 0;
        warnedMissingSessionId = false;
        warnedRecallStatuses.clear();
        warnedLegacyFallbackFailure = false;
        warnedRecallLimitInvalid = false;
        sessionsReset.clear();
        identityInjected.clear();
        lessonsInjected.clear();
        identityBannerShown.clear();
        identityNoteShown.clear();
        pendingResets.clear();
        pluginLog = log;

        log(`[hicortex] Thin-client mode — server: ${serverUrl}`);

        // License: init feature cache (only needs licenseKey, no DB access)
        await initFeatures(config.licenseKey, hicortexHome);

        // Verify server reachability at startup (non-fatal — warn only).
        // /health is the public minimal {status:"ok"} probe (#253) — fine for
        // a liveness check. Diagnostics (version, memories) live on
        // /health/detail; the OC plugin is authenticated by its server token,
        // so use that path for the richer log line.
        try {
          // Authenticated diagnostics probe. Only send the Authorization
          // header when a token actually exists — an empty `Bearer ` header
          // is worse than absent (it can trip strict middlewares and signals
          // a misconfigured client). When there's no token, fall straight to
          // the public /health liveness probe below. Uses the RESOLVED token
          // (config ?? env, #316 CR finding 5) — an env-token deployment must
          // not probe unauthenticated and log a misleading "diagnostics
          // gated" line every start.
          const headers: Record<string, string> = {};
          if (authToken) headers.Authorization = `Bearer ${authToken}`;
          const resp = await fetch(`${serverUrl}/health/detail`, {
            signal: AbortSignal.timeout(5000),
            headers,
          });
          if (resp.ok) {
            const data = await resp.json() as Record<string, unknown>;
            log(`[hicortex] Server OK: v${data.version}, ${data.memories} memories`);
          } else if (resp.status === 401) {
            // Token-less fallback: the public probe confirms liveness; the
            // diagnostic fields aren't available without auth. The public
            // probe carries no version, so log reachability honestly rather
            // than a fabricated "vok"/"vn/a".
            const pub = await fetch(`${serverUrl}/health`, {
              signal: AbortSignal.timeout(5000),
            });
            log(pub.ok
              ? `[hicortex] Server OK (reachable, diagnostics gated)`
              : `[hicortex] Server returned HTTP ${pub.status} on public /health`);
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

        // #326 self-hardening — install hygiene, both fail-soft by design:
        // keep the dead-man guard line (#313 secondary layer) present in the
        // agent workspace bootstrap, and surface an unpinned gateway trust
        // list. The kill-switch (config scaffoldDeadMan, default on) disables
        // the scaffold entirely; the trust warning always runs.
        scaffoldDeadManGuard({
          workspaceDir: resolveOcWorkspaceDir(ctx.config) ?? fallbackOcWorkspace(),
          enabled: config.scaffoldDeadMan !== false,
          log,
        });
        warnIfPluginsUnpinned(ctx.config, log);

        ensureToolsAllowed(log);
      },

      async stop() {
        // Nothing to clean up — no DB, no LLM, no timer
      },
    });

    // -----------------------------------------------------------------------
    // Hook: before_agent_start — fetch identity + lessons + recall index
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
          // Per-agent identity id: sanitize the OC agent id (a symbols-only id
          // sanitizes to null → bare /identity → global set). Null id never sends
          // ?agent=, so an old server behaves exactly as before.
          const agentId = sanitizeAgentId(ctx?.agentId ?? "");
          const sessionId = ctx?.sessionId || undefined;
          const prompt = event?.prompt;
          // Composite tracker/reset key (#316 CR finding 7): agentId + sessionId.
          const sKey = sessionId !== undefined ? sessionKey(agentId, sessionId) : undefined;

          // #316 session-start dedup reset (Hermes initialize parity): the
          // FIRST recall fetch of a session is preceded by an {reset:true} —
          // a gateway restart resuming a live session would otherwise inherit
          // a stale server-side shown-set (suppression for up to
          // recallReshowTurns turns). Registered SYNCHRONOUSLY here (before
          // the fetch below) and awaited by fetchRecallIndexBlock, so it can
          // never land after the fetch and wipe what it built. Gated on a
          // real prompt+session: no recall traffic without a real turn.
          if (sessionId && sKey !== undefined && prompt && !sessionsReset.has(sKey)) {
            sessionsReset.add(sKey);
            void resetRecallDedup(sessionId, sKey);
          }

          // #316 once-per-session standing blocks: `## Identity` +
          // `## Hicortex Learnings` are injected on a session's FIRST turn
          // only (they PERSIST on the session prompt — see the tracker docs);
          // subsequent turns inject the per-turn recall block alone. The two
          // blocks memoize INDEPENDENTLY (CR finding 4): identity on identity
          // success, lessons on a successful lessons fetch — an OK identity +
          // a failed /lessons must not bury the learnings for the session.
          // Without a sessionId there is no per-session key — inject per turn
          // (pre-#316 shape) rather than never.
          const skipIdentity = sKey !== undefined && identityInjected.has(sKey);
          const skipLessons = sKey !== undefined && lessonsInjected.has(sKey);
          const [identity, lessons, recallBlock] = await Promise.all([
            skipIdentity
              ? Promise.resolve(null)
              : fetchOcIdentity(agentId).catch((): OcIdentityResult => ({ block: null, failed: true, status: null })),
            skipLessons
              ? Promise.resolve(null)
              : buildLessonsBlock(ctx?.project).catch((): OcLessonsResult => ({ block: null, failed: true })),
            fetchRecallIndexBlock(sessionId, prompt, ctx?.project, sKey).catch(() => null),
          ]);

          // Memoize each block ONLY on its own success (#313 + #316): a
          // FAILED identity fetch (banner / version-skew note) must retry next
          // turn — the banner's "identity is re-fetched on the next turn"
          // promise stays true — and a failed /lessons fetch must retry too.
          // A gated identity response (no echo, oc ∉ clients, mode off) and
          // an empty-but-successful lessons fetch are settled outcomes and
          // memoize like any other success.
          if (!skipIdentity && sKey !== undefined && identity !== null && !identity.failed) {
            identityInjected.add(sKey);
          }
          if (!skipLessons && sKey !== undefined && lessons !== null && !lessons.failed) {
            lessonsInjected.add(sKey);
          }

          // Dead-man enforcement (#313): a FAILED identity fetch injects the
          // hard banner in the identity slot — never silence. Two non-failure
          // exceptions: a gated-null (old-server guard, harness not in
          // clients) stays silent, and a 404 is version skew — the one-line
          // note, NOT the banner (CR2: a pinned plugin on an old server must
          // not self-suspend every turn). Lessons/recall keep their own
          // independent fail-soft.
          //
          // #327 lifecycle: the notice is appended ONCE per outage (appends
          // persist on the session — every-turn copies accumulate), and the
          // first success carrying identity content prepends the retraction so
          // the suspension wording cannot linger. Without a sessionId there is
          // no per-session key — inject per turn (pre-#316 shape), matching
          // the standing-block behavior above.
          let identityBlock: string | null;
          if (identity !== null && identity.block !== null) {
            identityBlock = identity.block;
            if (sKey !== undefined && identityBannerShown.has(sKey)) {
              identityBlock = `${IDENTITY_RESTORED_RETRACTION}\n\n${identityBlock}`;
            }
            if (sKey !== undefined) {
              identityBannerShown.evict(sKey);
              identityNoteShown.evict(sKey);
            }
          } else if (identity !== null && identity.failed) {
            const isSkew = identity.status === 404;
            const shown = isSkew ? identityNoteShown : identityBannerShown;
            if (sKey === undefined || !shown.has(sKey)) {
              if (sKey !== undefined) shown.add(sKey);
              identityBlock = isSkew ? IDENTITY_VERSION_SKEW_NOTE : IDENTITY_UNAVAILABLE_BANNER;
            } else {
              // Already appended earlier in the outage — it persists on the
              // session; re-sending would duplicate it (see tracker docs).
              identityBlock = null;
            }
          } else {
            // Gated-null success (old server / oc ∉ clients / mode off): a
            // settled outcome with no content. A prior banner stays standing —
            // identity is still effectively missing to the agent, and the
            // bootstrap dead-man guard line keeps advising caution.
            identityBlock = null;
          }

          const lessonsBlock = lessons !== null ? lessons.block : null;
          const blocks = [identityBlock, lessonsBlock, recallBlock].filter(
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
    // Hooks: after_compaction / before_reset — the context window was
    // rebuilt (#193): the server's per-session shown-set no longer reflects
    // what the agent can see, and the standing blocks injected on earlier
    // turns may have been dropped from the rebuilt window — so the session's
    // memo is evicted and the next turn re-injects them (#316; once per
    // rebuild, never per turn). Unknown hook names are ignored by older
    // gateways (typed-hook registry warns and drops them), so registering
    // both is safe everywhere.
    // -----------------------------------------------------------------------
    const recallResetHook = (
      _event: unknown,
      ctx?: { sessionId?: string; agentId?: string },
    ) => {
      const sid = ctx?.sessionId || undefined;
      if (!sid) return;
      // Same composite key as before_agent_start (finding 7) — an agent id
      // absent from the compaction ctx degrades to the bare-session key, and
      // the eviction may miss (accepted: one duplicate standing injection).
      const key = sessionKey(sanitizeAgentId(ctx?.agentId ?? ""), sid);
      // Genuinely fire-and-forget (F9): no await — a slow server must never
      // add latency to compaction or session reset in the gateway. The race
      // with the next turn's recall fetch is closed by ORDERING (#316), not
      // by awaiting here: resetRecallDedup registers the POST in
      // pendingResets, and fetchRecallIndexBlock awaits that entry before
      // fetching — the reset can no longer land after the fetch.
      void resetRecallDedup(sid, key);
      identityInjected.evict(key);
      lessonsInjected.evict(key);
      // #327: a rebuilt window may have dropped the notice too — evict so one
      // re-inject (banner while still failing) can happen after the rebuild.
      identityBannerShown.evict(key);
      identityNoteShown.evict(key);
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
            const projectFilter = args.project ?? defaultProject;
            if (projectFilter) params.set("project", projectFilter);
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
            }>(`/memory?${params}`, RECALL_TIMEOUT_MS);
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
            const projectFilter = args?.project ?? defaultProject;
            if (projectFilter) params.set("project", projectFilter);
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
        async execute(_callId: any, args: any, context: any) {
          try {
            const result = await serverPost<{ id?: string; error?: string }>(
              "/ingest",
              {
                content: args.content,
                source_agent: `openclaw/${context?.agentId ?? "manual"}`,
                project: args.project ?? defaultProject,
                memory_type: args.memory_type ? normalizeMemoryType(args.memory_type) : "experience",
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
          "Get actionable Learnings distilled from past sessions. Auto-generated insights about mistakes to avoid.",
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
              return { content: [{ type: "text", text: "No Learnings found." }] };
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
              enum: ["knowledge", "experience", "decisions", "learnings", "fact", "episode", "decision", "lesson"],
              description: "New memory type. Accepted: Knowledge/Experience/Decisions/Learnings (legacy raw enum also accepted, normalized to the canonical term).",
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
                memory_type: args.memory_type ? normalizeMemoryType(args.memory_type) : undefined,
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
 * The OpenClaw home this plugin resolves against (#326). `HICORTEX_OC_HOME`
 * redirects it for tests, mirroring how HICORTEX_HOME redirects the hicortex
 * home (paths.ts) — one resolution shared by the workspace fallback and the
 * unpinned-trust warning so they can never disagree.
 */
function ocHomeDir(): string {
  return process.env.HICORTEX_OC_HOME ?? join(homedir(), ".openclaw");
}

/**
 * Normalize a gateway-config workspace path for WRITING (#326 CR1): a bare
 * `~` or leading `~/` expands against the real home dir; anything still
 * RELATIVE afterwards is rejected (null). OpenClaw's semantics for relative
 * workspace values are not verifiable from the plugin, and writing under
 * process.cwd() would place the guard where OC never reads it — a silent
 * no-op safety — so the caller skips with a warning instead. Pure; no fs.
 */
export function normalizeWorkspacePath(ws: string): string | null {
  let p = ws;
  if (p === "~") p = homedir();
  else if (p.startsWith("~/")) p = join(homedir(), p.slice(2));
  return isAbsolute(p) ? p : null;
}

/**
 * Fallback workspace when the gateway config names none (#326): OpenClaw's
 * default `<ocHome>/workspace`. Returned ONLY when a real OC install is
 * present (`<ocHome>/openclaw.json` exists — the same touchpoint
 * ensureToolsAllowed reads): outside a gateway (tests, CI, a bare import) the
 * plugin must not conjure `~/.openclaw` into existence just to drop a
 * bootstrap file.
 */
function fallbackOcWorkspace(): string | null {
  const ocHome = ocHomeDir();
  return existsSync(join(ocHome, "openclaw.json")) ? join(ocHome, "workspace") : null;
}

/** Per-cause warn-once for scaffold skips/failures (#326). */
function warnScaffoldSkipOnce(
  cause: string,
  log: (msg: string) => void,
  reason: string,
): void {
  if (warnedScaffoldSkips.has(cause)) return;
  warnedScaffoldSkips.add(cause);
  log(`[hicortex] WARNING: ${reason} — the dead-man guard line was not scaffolded.`);
}

/**
 * Scaffold the dead-man guard line into the agent workspace bootstrap (#326 —
 * the #313 SECONDARY layer; the primary layer is the injected
 * IDENTITY UNAVAILABLE banner, which needs a live plugin hook). The sentence
 * used to be a manual install step every public-agent setup could forget, so
 * the plugin maintains it itself at service start:
 *
 *   - bootstrap absent            → created containing ONLY the guard line
 *   - present without the line    → one-time .bak of the operator's original
 *                                   BYTES, then the line appended exactly once
 *   - present with the line       → untouched (idempotent: no write, no backup)
 *
 * Deliberately conservative (CR):
 *   - the workspace DIRECTORY is never created — OC may scaffold workspaces
 *     from templates, and a pre-created dir could interfere; absent dir →
 *     warn once + skip (a gateway restart after the first agent run retries)
 *   - a non-absolute workspace path (after ~ expansion) → warn once + skip
 *     (never write somewhere speculative like process.cwd())
 *   - a bootstrap that is not valid UTF-8 → warn once + skip; decoding would
 *     be lossy and rewriting the file would mangle the operator's bytes
 *
 * Fail-soft by construction: any filesystem failure (unreadable path,
 * permissions) warns ONCE per cause and never breaks plugin start. The
 * kill-switch (config `scaffoldDeadMan: false`, default on) returns before a
 * single fs call — no write, no file creation.
 */
function scaffoldDeadManGuard(opts: {
  workspaceDir: string | null;
  enabled: boolean;
  log: (msg: string) => void;
}): void {
  if (!opts.enabled) return;
  const rawWorkspace = opts.workspaceDir;
  if (!rawWorkspace) return; // no workspace resolvable — not an OC install / no workspace key
  const log = opts.log;
  const workspaceDir = normalizeWorkspacePath(rawWorkspace);
  if (!workspaceDir) {
    warnScaffoldSkipOnce(
      "relative-workspace",
      log,
      `workspace path "${rawWorkspace}" in the gateway config is relative — OpenClaw's ` +
      "resolution for it is unknown, so the plugin will not write speculatively",
    );
    return;
  }
  const bootstrapPath = join(workspaceDir, BOOTSTRAP_FILENAME);
  try {
    // CR3: never create the workspace dir itself (template interference).
    if (!existsSync(workspaceDir)) {
      warnScaffoldSkipOnce(
        "missing-workspace-dir",
        log,
        `workspace directory ${workspaceDir} does not exist yet (OpenClaw creates it; ` +
        "restart the gateway after the first agent run to retry)",
      );
      return;
    }

    // Read BYTES (CR2): the .bak must hold the operator's original exactly,
    // and an append must splice onto the original bytes, not a lossy decode.
    let original: Buffer | null = null;
    try {
      original = readFileSync(bootstrapPath);
    } catch (err) {
      // Only "does not exist" means "create it" — anything else (EACCES,
      // EISDIR, …) is a genuine failure and must reach the warn below, not
      // be mistaken for an absent file and overwritten.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (original !== null) {
      const decoded = original.toString("utf-8");
      // Invalid UTF-8 (round-trip compare): appending would rewrite the file
      // with mangled bytes — leave it untouched and say so once.
      if (!Buffer.from(decoded, "utf-8").equals(original)) {
        warnScaffoldSkipOnce(
          "invalid-utf8",
          log,
          `${bootstrapPath} is not valid UTF-8 — leaving the file untouched`,
        );
        return;
      }
      if (decoded.includes(DEAD_MAN_GUARD_LINE)) return;
    }

    if (original === null) {
      writeFileSync(bootstrapPath, `${DEAD_MAN_GUARD_LINE}\n`);
    } else {
      // One-time backup of the operator's original BYTES — never churned.
      const bakPath = `${bootstrapPath}.bak`;
      if (!existsSync(bakPath)) writeFileSync(bakPath, original);
      // Separator at the BYTE level (0x0A), so a no-trailing-newline file is
      // spliced correctly without decoding.
      const needsSep = original.length > 0 && original[original.length - 1] !== 0x0a;
      writeFileSync(bootstrapPath, Buffer.concat([
        original,
        needsSep ? Buffer.from("\n", "utf-8") : Buffer.alloc(0),
        Buffer.from(`${DEAD_MAN_GUARD_LINE}\n`, "utf-8"),
      ]));
    }
    log(`[hicortex] Added the dead-man identity guard line to ${bootstrapPath}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnScaffoldSkipOnce(
      "fs-error",
      log,
      `could not scaffold the dead-man guard line into ${bootstrapPath}: ${msg}`,
    );
  }
}

/**
 * Warn once per process when the gateway's plugin trust list is unpinned
 * (#326): while `plugins.allow` is absent or empty, OpenClaw auto-loads ANY
 * extension dropped into the plugins directory. A plugin must not pin trust
 * itself — a self-pinned list defeats the point of the list — so this only
 * WARNS with the fix. It never writes plugins.allow (or any gateway config;
 * ensureToolsAllowed's tools.allow edit is the one intentional config write).
 * Any non-empty array counts as pinned → silent.
 */
function warnIfPluginsUnpinned(raw: unknown, log: (msg: string) => void): void {
  if (warnedUnpinnedPlugins) return;
  const allow = isRecord(isRecord(raw)?.plugins)?.allow;
  if (Array.isArray(allow) && allow.length > 0) return;
  warnedUnpinnedPlugins = true;
  log(
    "[hicortex] WARNING: the OpenClaw plugin trust list (plugins.allow) is not " +
    "pinned — any extension dropped into the plugins directory loads " +
    'automatically. Fix: set "plugins": { "allow": ["hicortex"] } in ' +
    `${join(ocHomeDir(), "openclaw.json")} (list every plugin you trust). See ` +
    "https://hicortex.gamaze.com/docs/installation.html — hicortex never " +
    "edits the trust list itself.",
  );
}

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
