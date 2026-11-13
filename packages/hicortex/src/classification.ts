/**
 * The confidential circle (#332) — the pure decision core for the two-level
 * memory classification (`standard` | `confidential`, carried by
 * `memories.privacy`; see MemoryPrivacy in types.ts).
 *
 * The model, in one paragraph: an operator lists inner-circle agents in
 * config (`confidentialAgents`, the same agent-id namespace as
 * `identityAgents` / `?agent=`). Captures whose `source_agent` is rostered
 * are stamped `confidential` at intake — server-derived, deterministic, by
 * birthplace; never a content judgment (content classification was rejected,
 * #197) and never client-declared. The workspace marker (#609/#614) is
 * client-RELAYED but server-VALIDATED: the marker file carries the owner-set
 * `confidentialMarkerKey` as its content, compared timing-safe at intake —
 * marker content without the key never stamps (the client-writable
 * classification channel #614 closes; an unkeyed install ignores markers
 * entirely, fail-closed both directions). Every agent-facing read path accepts an
 * optional `agent` requester id: absent or unknown = non-member = HARD OMIT
 * of confidential rows (fail-closed both ends — unrostered sources are
 * standard, unknown requesters are non-members). The circle is ADDITIVE:
 * members see both pools. Every LLM touch of confidential text routes to a
 * separately configured second model (`llmConfidential*` config keys /
 * `HICORTEX_LLM_CONFIDENTIAL_*` env) — when that model is absent, the work
 * HOLDS (queue stays, deliveries refuse), never falls back to the main
 * model. An install that configures nothing sees zero change: no roster, no
 * confidential rows, no warning, no second client.
 *
 * All functions here are pure (no DB, no HTTP): the handlers in mcp-server.ts
 * and the pipeline stages consume them, and the tests exercise the decisions
 * directly.
 */

import { timingSafeEqual } from "node:crypto";
import { sanitizeAgentId } from "./identity-store.js";
import {
  resolveExplicitLlmConfig,
  resolveSavedLlmConfig,
  applyTierTuningOverlay,
  LlmClient,
  type LlmConfig,
} from "./llm.js";
import { readStringConfig } from "./config-read.js";
import type { MemoryPrivacy } from "./types.js";

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

/**
 * Resolve the `confidentialAgents` config value into a clean roster of agent
 * ids. Each entry is sanitized EXACTLY like `?agent=` (sanitizeAgentId —
 * lowercase, collapse invalid runs to `-`, allowlist-validated) so the roster,
 * the wire `agent` param, and capture's `<harness>/<id>` stamps live in one
 * id namespace. Entries that sanitize to null are dropped and their raw
 * values returned in `dropped` for a one-time boot warning (the
 * resolveIdentityAgents pattern — a typo must surface, not silently drop an
 * agent out of the circle).
 */
export function resolveConfidentialAgents(
  config: Record<string, unknown> | null | undefined,
): { roster: string[]; dropped: string[] } {
  const raw = config?.confidentialAgents;
  if (!Array.isArray(raw)) return { roster: [], dropped: [] };
  const roster: string[] = [];
  const dropped: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") {
      dropped.push(String(entry));
      continue;
    }
    const id = sanitizeAgentId(entry);
    if (id && !roster.includes(id)) roster.push(id);
    else if (!id) dropped.push(entry);
  }
  return { roster, dropped };
}

/**
 * Normalize a capture-side `source_agent` for roster matching. Capture stamps
 * harness-qualified ids (`hermes/nano`, `claude-code/myproject`), while the
 * roster carries bare agent ids (the same ids the read side receives as
 * `agent`) — ONE config list, no read-ids/capture-ids sync hazard. The match
 * is exact, or exact after stripping the FIRST path segment (so `hermes/nano`
 * matches roster `nano`, and a future `anything/nano` matches too — generic
 * prefix, not a per-harness table). Case-insensitive on the id half via the
 * roster's sanitized (lowercased) form.
 */
export function isConfidentialSourceAgent(
  sourceAgent: string | null | undefined,
  roster: string[],
): boolean {
  if (!sourceAgent || roster.length === 0) return false;
  const agent = sourceAgent.toLowerCase();
  if (roster.includes(agent)) return true;
  const slash = agent.indexOf("/");
  if (slash < 0) return false;
  const bare = agent.slice(slash + 1);
  const rest = bare.indexOf("/");
  // Strip only the FIRST segment — `hermes/nano` → `nano`, but
  // `a/b/nano` → `b/nano` (never a deep-suffix match; capture ids are
  // single-qualified by construction).
  return rest < 0 && roster.includes(bare);
}

// ---------------------------------------------------------------------------
// Workspace paths (#609)
// ---------------------------------------------------------------------------

/**
 * One validated `confidentialPaths` entry, compiled once at boot (the
 * resolveConfidentialAgents pattern). The three match forms are deliberately
 * tiny — no glob library, no character classes, no brace expansion — so the
 * auditable surface is exactly what the spec rules:
 *   - absolute exact path (`/home/alice/finance`);
 *   - `*` as a FULL path segment — matches exactly ONE segment (a lone-star
 *     segment between /home/ and /finance matches any single middle segment);
 *   - trailing `/**` — the whole subtree INCLUDING the prefix itself
 *     (`/home/alice/**` matches `/home/alice`);
 *   - a leading `~/` matches any single home prefix STRUCTURALLY
 *     (`/home/<user>/…` or `/Users/<user>/…`) so one entry covers a
 *     multi-OS fleet.
 * Comparison normalizes separators to `/` + Unicode NFC and is
 * case-insensitive — over-match is the fail-closed direction (more
 * confidential, never less).
 */
export interface ConfidentialPathPattern {
  /** The raw config entry as written (boot warnings, backfill reports). */
  raw: string;
  /** Leading `~/` — match any user's home directory as the prefix. */
  home: boolean;
  /** Trailing `/**` — prefix match including the prefix path itself. */
  subtree: boolean;
  /** Normalized segments of the literal part; `"*"` = exactly one segment. */
  segments: string[];
}

/**
 * Shared normalization for pattern and path sides: NFC, `\` → `/`, lowercase
 * (the case-insensitive compare). Pure string prep — no fs, no symlinks.
 */
function normalizePathForMatch(p: string): string {
  return p.normalize("NFC").replace(/\\/g, "/").toLowerCase();
}

/** Glob metacharacters a LITERAL segment must not contain (`*` alone is the
 *  one-segment wildcard; anything else is a typo, not a form). */
const SEGMENT_METACHARS = /[*?[\]{}]/;

/**
 * Compile one raw config entry into a pattern, or null when the entry is not
 * one of the three forms. Dropped kinds: relative entries (nothing to anchor
 * a match on), a double-star anywhere but the end, a star that is not a whole
 * segment (partial-segment wildcards), other metacharacters, blank, and
 * ~user-style entries (whose home?). Dropped entries are reported by name at
 * boot — a typo must surface, never silently match nothing.
 */
function compileConfidentialPath(entry: string): ConfidentialPathPattern | null {
  const trimmed = entry.trim();
  if (!trimmed) return null;
  let s = trimmed;
  let home = false;
  if (s.startsWith("~")) {
    if (s === "~" || s.startsWith("~/")) {
      home = true;
      s = s === "~" ? "" : s.slice(2);
    } else {
      return null; // "~user/…" — whose home? Not one of the forms.
    }
  }
  if (!home && !s.startsWith("/")) return null; // relative — no anchor
  let subtree = false;
  if (s.endsWith("/**")) {
    subtree = true;
    s = s.slice(0, -3);
  }
  if (s.includes("**")) return null; // ** mid-path (incl. a second trailing one)
  const segments = normalizePathForMatch(s)
    .split("/")
    .filter((seg) => seg !== "");
  for (const seg of segments) {
    if (seg === "*") continue; // the one-segment wildcard
    if (SEGMENT_METACHARS.test(seg)) return null;
  }
  return { raw: entry, home, subtree, segments };
}

/**
 * Resolve the `confidentialPaths` config value into validated patterns.
 * Entries that do not compile are dropped and their raw values returned in
 * `dropped` for a one-time boot warning (a dropped pattern matches nothing —
 * the operator learns from the log, not from a folder silently staying
 * standard). Duplicates (same raw entry) collapse. Absent/non-array/empty →
 * no patterns, nothing dropped — the zero-change default.
 */
export function resolveConfidentialPaths(
  config: Record<string, unknown> | null | undefined,
): { patterns: ConfidentialPathPattern[]; dropped: string[] } {
  const raw = config?.confidentialPaths;
  if (!Array.isArray(raw)) return { patterns: [], dropped: [] };
  const patterns: ConfidentialPathPattern[] = [];
  const dropped: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") {
      dropped.push(String(entry));
      continue;
    }
    const compiled = compileConfidentialPath(entry);
    if (!compiled) {
      dropped.push(entry);
    } else if (!patterns.some((p) => p.raw === compiled.raw)) {
      patterns.push(compiled);
    }
  }
  return { patterns, dropped };
}

/**
 * The pure matcher: does `workspacePath` fall under any resolved pattern?
 * Empty pattern list matches nothing (and the zero-change default is exactly
 * that); a null/empty path matches nothing (Hermes has no workspace — path
 * signals never fire there). No fs access — callers pass the delivery's
 * declared workspace path; the server decides (the client never knows the
 * patterns).
 */
export function matchesConfidentialPath(
  workspacePath: string | null | undefined,
  patterns: ConfidentialPathPattern[],
): boolean {
  if (!workspacePath || patterns.length === 0) return false;
  const pathSegs = normalizePathForMatch(workspacePath)
    .split("/")
    .filter((seg) => seg !== "");
  return patterns.some((p) => patternMatchesSegments(p, pathSegs));
}

/** Segment-level match of one compiled pattern against a normalized path. */
function patternMatchesSegments(
  p: ConfidentialPathPattern,
  pathSegs: string[],
): boolean {
  let rest = pathSegs;
  if (p.home) {
    // Any single home prefix: /home/<user>/… or /Users/<user>/… — structural,
    // so `~/finance` covers the same folder on Linux and macOS fleets.
    if (pathSegs.length < 2) return false;
    if (pathSegs[0] !== "home" && pathSegs[0] !== "users") return false;
    rest = pathSegs.slice(2);
  }
  // Subtree: the path equals the prefix OR extends it. Exact: lengths equal.
  if (rest.length < p.segments.length) return false;
  if (!p.subtree && rest.length !== p.segments.length) return false;
  // "*" matches exactly ONE segment — never zero, never two.
  return p.segments.every((seg, i) => seg === "*" || seg === rest[i]);
}

// ---------------------------------------------------------------------------
// The marker key (#614) — server-validated marker content
// ---------------------------------------------------------------------------

/**
 * Constant-time marker-content × key comparison (#614) — the safeBearerMatch
 * pattern (viz.ts auth). `crypto.timingSafeEqual` THROWS RangeError on
 * mismatched buffer lengths, so the length check MUST gate the call; the
 * short-circuit leaks only the CONTENT length, which is already visible on
 * the wire (the delivery body carries the content verbatim) — the key bytes
 * are never compared byte-by-byte through a timing side channel. Empty
 * content never matches: an empty (pre-#614) marker file is inert by DESIGN,
 * not by luck of the length gate.
 */
export function safeMarkerKeyEqual(markerContent: string, key: string): boolean {
  if (markerContent.length === 0) return false;
  const a = Buffer.from(markerContent);
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Resolve the `confidentialMarkerKey` (#614) — the owner-set secret a
 * workspace marker must carry for its folder to stamp confidential at
 * intake. Precedence: env `HICORTEX_CONFIDENTIAL_MARKER_KEY` OVERRIDES the
 * config value (the env-last-word ops override, so a restart-free rotation
 * or override path exists beside the file), then the config value through
 * the readStringConfig boundary (wrong type warns + null — never coerced;
 * a JSON slip like a number cannot silently arm the arm). Blank/absent →
 * null = the marker arm is INERT: no key configured means client markers
 * are ignored entirely (fail-closed both directions — the empty-marker
 * attack surface ships disabled by default, AC-1). Boot-time like the
 * roster; restart to apply. Distributed like authToken: mirror the server's
 * value into each client machine's config.json (or its env).
 */
export function resolveConfidentialMarkerKey(
  config: Record<string, unknown> | null | undefined,
): string | null {
  const env = process.env.HICORTEX_CONFIDENTIAL_MARKER_KEY;
  if (typeof env === "string" && env.trim()) return env.trim();
  return readStringConfig(config ?? {}, "confidentialMarkerKey");
}

/**
 * The intake-side derivation: which class a delivery from `sourceAgent`
 * stores as. Fail-closed by construction — anything unattributed or
 * unrostered is `standard` (the global pool).
 *
 * #609/#614 composition invariant: confidential iff roster agent OR server
 * path pattern OR VALIDATED marker content. The marker arm is key-gated
 * (#614): the delivery's relayed marker CONTENT must equal the boot-resolved
 * `confidentialMarkerKey` (timing-safe, server-side — a client-side match is
 * never trusted, the client only relays). An absent key makes every marker
 * inert (the empty-marker client-writable channel is closed), and a
 * present-but-refused marker never reduces a server rule (markers only add,
 * never subtract — safe because a token holder can already POST arbitrary
 * content, the #599 F5 ruling, token = owner). The optional third argument
 * keeps every existing caller byte-identical (no signals = the #332
 * agent-only rule).
 */
export function deriveIntakePrivacy(
  sourceAgent: string | null | undefined,
  roster: string[],
  signals?: IntakeWorkspaceSignals,
): MemoryPrivacy {
  if (isConfidentialSourceAgent(sourceAgent, roster)) return "confidential";
  if (
    typeof signals?.markerKey === "string" &&
    signals.markerKey.length > 0 &&
    typeof signals?.markerContent === "string" &&
    safeMarkerKeyEqual(signals.markerContent, signals.markerKey)
  ) {
    return "confidential";
  }
  if (matchesConfidentialPath(signals?.workspacePath, signals?.paths ?? [])) {
    return "confidential";
  }
  return "standard";
}

/**
 * The #609/#614 workspace birthplace signals `deriveIntakePrivacy` composes
 * with the roster. Every field optional/nullable — a delivery from a harness
 * with no workspace (Hermes) or a pre-#609 client carries none of them.
 */
export interface IntakeWorkspaceSignals {
  /** The delivery's workspace path (wire `workspace_path`). Null/absent when
   *  unknown — never invented client-side. */
  workspacePath?: string | null;
  /**
   * #614: the relayed marker content (wire `client_marker`) — the trimmed
   * first line of `.hicortex-confidential` at the workspace or an ancestor
   * (readConfidentialMarker in capture.ts). Null/absent = no marker found;
   * "" = a marker file exists but is empty (the pre-#614 shape — present,
   * never valid). The field's MEANING is "what the marker carried" (a key
   * today, a space-id + key pair later, #613) — validity is decided HERE,
   * against `markerKey`, never client-side.
   */
  markerContent?: string | null;
  /**
   * #614: the boot-resolved `confidentialMarkerKey`
   * (resolveConfidentialMarkerKey). Null = markers INERT — no key, no
   * marker-derived stamp (fail-closed both directions).
   */
  markerKey?: string | null;
  /** Boot-resolved confidentialPaths patterns (resolveConfidentialPaths). */
  paths?: ConfidentialPathPattern[];
}

/**
 * The read-side membership check: is the requester a circle member? Absent,
 * blank, or unknown `agent` → false (fail-closed: an unknown id can never
 * widen visibility, exactly like the identity layer's mode resolution). The
 * `agent` value is sanitized first so a wire id arrives in the roster's
 * namespace (`Nano` → `nano`); note sanitizeAgentId also collapses inner
 * separators, so `hermes/nano` sent as a requester id reads as `hermes-nano`
 * — the read side intentionally matches BARE ids only (plugins send their
 * resolved profile name, not their capture-side qualified stamp).
 */
export function isCircleMember(
  agent: string | null | undefined,
  roster: string[],
): boolean {
  if (!agent || roster.length === 0) return false;
  const id = sanitizeAgentId(agent);
  return id !== null && roster.includes(id);
}

// ---------------------------------------------------------------------------
// The confidential LLM client
// ---------------------------------------------------------------------------

/**
 * Resolve the confidential model's CONFIG from explicit config keys or env —
 * the same shape and precedence as the main model
 * (resolveExplicitLlmConfig):
 *
 *   1. config `llmConfidentialBaseUrl` + `llmConfidentialApiKey` (both
 *      required; `llmConfidentialModel` optional; `llmConfidentialProvider`
 *      selects the request dialect, else URL detection — the llmProvider
 *      precedent);
 *   2. env `HICORTEX_LLM_CONFIDENTIAL_BASE_URL` +
 *      `HICORTEX_LLM_CONFIDENTIAL_API_KEY` (both required;
 *      `HICORTEX_LLM_CONFIDENTIAL_MODEL` optional) — mirroring the main
 *      model's HICORTEX_LLM_* env pattern.
 *
 * null when nothing explicit is set — the caller holds/skips confidential
 * work and warns (never falls back to the main model).
 *
 * Deliberately NOT routed through the named backends (claude-cli / ollama):
 * the confidential model is a full explicit-config surface by spec — a
 * second claude-cli subprocess or a local ollama alias would silently be the
 * SAME trust domain as the main model.
 */
export function resolveConfidentialLlmConfig(
  savedConfig: Record<string, unknown> | null | undefined,
): LlmConfig | null {
  const s = savedConfig ?? {};
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v ? v : undefined;
  const cfgBase = str(s.llmConfidentialBaseUrl);
  const cfgKey = str(s.llmConfidentialApiKey);
  // Both config keys required (the main model's contract). Called with BOTH
  // set, resolveExplicitLlmConfig answers from them alone — it only falls to
  // the MAIN HICORTEX_LLM_* env vars when its overrides are absent, which
  // would silently configure the confidential client as the main model. The
  // explicit guard keeps that branch unreachable here.
  if (cfgBase && cfgKey) {
    return resolveExplicitLlmConfig({
      llmBaseUrl: cfgBase,
      llmApiKey: cfgKey,
      llmModel: str(s.llmConfidentialModel),
      llmProvider: str(s.llmConfidentialProvider),
    });
  }
  const envBase = str(process.env.HICORTEX_LLM_CONFIDENTIAL_BASE_URL);
  const envKey = str(process.env.HICORTEX_LLM_CONFIDENTIAL_API_KEY);
  if (envBase && envKey) {
    return resolveExplicitLlmConfig({
      llmBaseUrl: envBase,
      llmApiKey: envKey,
      llmModel: str(process.env.HICORTEX_LLM_CONFIDENTIAL_MODEL),
    });
  }
  return null;
}

/**
 * Build the confidential LlmClient for a resolved config — the daemon
 * funnel's construction half. Applies the SAME tuning overlay as the main
 * client (applyTierTuningOverlay, the both-sites discipline: maxTokens,
 * timeouts, single-flight apply per-process at construction) so the second
 * model is not a second-class client.
 */
export function buildConfidentialLlm(
  savedConfig: Record<string, unknown> | null | undefined,
): { llm: LlmClient; config: LlmConfig } | null {
  const config = resolveConfidentialLlmConfig(savedConfig);
  if (!config) return null;
  applyTierTuningOverlay(config, savedConfig ?? null);
  return { llm: new LlmClient(config), config };
}

// ---------------------------------------------------------------------------
// The pair — per-pool client selection at the stage call sites
// ---------------------------------------------------------------------------

/**
 * The two clients a pipeline run needs. `standard` is the main model (always
 * present when the run does LLM work at all); `confidential` is null when the
 * circle is active but the second model is unconfigured — callers HOLD
 * confidential work in that case (clientForPool returns null), never fall
 * back.
 */
export interface LlmPair {
  standard: LlmClient;
  confidential: LlmClient | null;
}

/**
 * Resolve the full pair for a pipeline process (the nightly/CLI funnel —
 * resolveSavedLlmConfig for the standard client, buildConfidentialLlm for
 * the confidential one). Returns the pair plus both configs (the drain and
 * the /distill sync path need the config for chunk-size detection/probing),
 * and passes through resolveSavedLlmConfig's `reason` so callers keep their
 * claude-binary-missing logging.
 */
export function resolveLlmPair(
  savedConfig: Record<string, unknown> | null | undefined,
): {
  pair: LlmPair | null;
  standardConfig: LlmConfig | null;
  confidentialConfig: LlmConfig | null;
  reason?: "claude_binary_missing";
} {
  const resolved = resolveSavedLlmConfig(savedConfig ?? null);
  const confidential = buildConfidentialLlm(savedConfig);
  if (!resolved.config) {
    return {
      pair: null,
      standardConfig: null,
      confidentialConfig: confidential?.config ?? null,
      reason: resolved.reason,
    };
  }
  return {
    pair: {
      standard: new LlmClient(resolved.config),
      confidential: confidential?.llm ?? null,
    },
    standardConfig: resolved.config,
    confidentialConfig: confidential?.config ?? null,
  };
}

/**
 * The per-pool selection every stage call site goes through: the client that
 * MUST serve a memory class, or null when the confidential pool has no
 * client configured (the caller holds/skips that pool's work — the
 * structurally-hard guarantee that confidential text can never reach the
 * standard model: there is no code path that answers "give me SOME client
 * for confidential").
 */
export function clientForPool(
  pair: LlmPair,
  privacy: MemoryPrivacy | null | undefined,
): LlmClient | null {
  if (privacy === "confidential") return pair.confidential;
  return pair.standard;
}

// ---------------------------------------------------------------------------
// Boot warning
// ---------------------------------------------------------------------------

/**
 * The ONE loud boot warning when the circle is ACTIVE (a roster OR
 * confidentialPaths patterns are configured, OR confidential rows exist, OR
 * confidential items sit queued) but the confidential model is not. Called at
 * daemon boot and nightly start; prints once per call site (the callers are
 * once-per-process). The wording names the exposure and the HOLD behavior —
 * the operator learns from the logs that deliveries are piling up, not
 * silently distilling on the main model. Returns whether the warning fired
 * (tests + callers that compose their own log lines).
 */
export function warnIfCircleUnconfigured(opts: {
  roster: string[];
  /** #609: boot-resolved confidentialPaths patterns — configured patterns
   *  activate the circle exactly like a roster (deliveries can derive
   *  confidential with no rostered agent involved). Absent = none. */
  patterns?: ConfidentialPathPattern[];
  confidentialLlm: LlmClient | LlmConfig | null;
  confidentialRows: number;
  queueConfidential: number;
}): boolean {
  if (opts.confidentialLlm) return false;
  const active =
    opts.roster.length > 0 ||
    (opts.patterns?.length ?? 0) > 0 ||
    opts.confidentialRows > 0 ||
    opts.queueConfidential > 0;
  if (!active) return false;
  console.warn("");
  console.warn("╔══════════════════════════════════════════════════════════════╗");
  console.warn("║  CONFIDENTIAL CIRCLE ACTIVE WITHOUT A CONFIDENTIAL MODEL    ║");
  console.warn("║                                                              ║");
  console.warn("║  Confidential memories exist (or a confidentialAgents        ║");
  console.warn("║  roster / confidentialPaths patterns are set) but           ║");
  console.warn("║  llmConfidentialBaseUrl/ApiKey are not.                     ║");
  console.warn("║  Confidential deliveries are HELD, not distilled — they     ║");
  console.warn("║  accumulate until a confidential model is configured         ║");
  console.warn("║  (they never fall back to the main model). Standard          ║");
  console.warn("║  capture and consolidation continue normally.               ║");
  console.warn("║                                                              ║");
  console.warn("║  Set llmConfidentialBaseUrl + llmConfidentialApiKey         ║");
  console.warn("║  (+ llmConfidentialModel) in config.json and restart.       ║");
  console.warn("╚══════════════════════════════════════════════════════════════╝");
  console.warn("");
  return true;
}

/**
 * The boot note when the circle is ACTIVE but the marker key is not (#614):
 * one line naming `confidentialMarkerKey` and that client workspace markers
 * are IGNORED (inert) until it is set — an operator running a marked folder
 * learns from the log why it stamps standard, not from silently
 * unclassified captures. Fires ONLY when the key is absent AND the circle is
 * otherwise active (the SAME active predicate as warnIfCircleUnconfigured:
 * roster, confidentialPaths patterns, stored confidential rows, or queued
 * confidential items); a zero-config install stays silent (the header's
 * zero-change-default discipline). Pure — returns the note string, the
 * caller prints it (testable without console spies). Null = say nothing.
 */
export function confidentialMarkerKeyNote(opts: {
  markerKey: string | null;
  roster: string[];
  /** Boot-resolved confidentialPaths patterns — configured patterns
   *  activate the circle exactly like a roster (#609). Absent = none. */
  patterns?: unknown[];
  confidentialRows: number;
  queueConfidential: number;
}): string | null {
  if (opts.markerKey) return null;
  const active =
    opts.roster.length > 0 ||
    (opts.patterns?.length ?? 0) > 0 ||
    opts.confidentialRows > 0 ||
    opts.queueConfidential > 0;
  if (!active) return null;
  return (
    "[hicortex] confidentialMarkerKey is not set — client workspace markers are IGNORED " +
    "(deliveries from marked folders stamp standard). Set confidentialMarkerKey in " +
    "config.json (or the HICORTEX_CONFIDENTIAL_MARKER_KEY env var) and mirror it to the " +
    "machines that mark folders, then restart."
  );
}

/**
 * Module-level once-latch for the refused-marker warn — ONE line per process
 * (that IS the rate limit: a fleet of nightly segments from a mis-keyed
 * folder must not flood the daemon log). resetRefusedMarkerWarn re-arms it
 * for tests.
 */
let refusedMarkerWarned = false;

/** Test seam: re-arm the warnRefusedMarker once-latch. */
export function resetRefusedMarkerWarn(): void {
  refusedMarkerWarned = false;
}

/**
 * The refused-marker warn (#614): a delivery carried marker content that did
 * NOT validate at intake — present with NO key configured (the marker arm is
 * inert) or present but NOT equal to the key (a stale pre-key marker, a
 * rotated key, or a forgery attempt). The CALLER guards the call
 * (`clientMarker !== null && clientMarker !== key` — one guard covers both
 * reasons); the reason wording here distinguishes them for the operator.
 * NEVER echoes the marker content or the key (log discipline — the secret
 * and the guess both stay out of the logs); naming the workspace path is
 * fine (it is the operator's own path, and it is what they need to fix).
 * Returns whether the line printed (the once-latch ate it → false).
 */
export function warnRefusedMarker(opts: {
  markerKey: string | null;
  workspacePath: string | null;
}): boolean {
  if (refusedMarkerWarned) return false;
  refusedMarkerWarned = true;
  const reason = opts.markerKey
    ? "does not match this server's confidentialMarkerKey"
    : "arrived but no confidentialMarkerKey is configured (markers are inert)";
  const where = opts.workspacePath ? ` (workspace ${opts.workspacePath})` : "";
  console.warn(
    `[hicortex] Confidential marker refused${where}: marker content ${reason} — the delivery stamps standard. ` +
    `Re-run \`hicortex confidential\` in that folder to rewrite the marker, or align the key.`,
  );
  return true;
}
