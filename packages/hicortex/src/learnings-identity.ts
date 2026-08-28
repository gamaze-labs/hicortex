/**
 * learnings-identity — query-time identity + lessons injection for the CC
 * SessionStart hook. (Canonical command name `learnings-identity` since #264;
 * the legacy `lessons-context` subcommand is kept as a backcompat alias via
 * resolveCommandAlias so existing installed hooks keep working. Fetches the
 * identity layer + the lessons block.)
 *
 * Replaces file-based injection (injectLessons / injectLessonsFromServer).
 * Reads ~/.hicortex/config.json to find the server URL, then fetches TWO
 * endpoints concurrently and prints a compact Markdown block to stdout so CC
 * picks it up as session context:
 *
 *   GET /identity → the standing identity layer (user info + rules; 0.12,
 *                   renamed from /context in 0.18 #264). Injected as a
 *                   `## Identity` block ONLY when this harness ("cc") is in
 *                   the server-resolved `clients` list (self-gate).
 *   GET /lessons  → episodic memory lessons + memory index, rendered as the
 *                   existing `## Hicortex Memory` block.
 *
 * The two fetches run in Promise.all, each with its OWN 3 s timeout and
 * INDEPENDENT fail-soft: an /identity failure must never cost the lessons
 * block, and vice versa. Sequential fetches would double worst-case
 * SessionStart latency (~6 s) — see spec §7.
 *
 * Fail-soft by design: ANY failure (missing config, network error, non-2xx,
 * parse error) results in silent exit-0. A broken hook must never block a
 * CC session, and a broken /identity fetch must never blank the whole output.
 */

import { readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import {
  handleIdentityGet,
  resolveAgentIdentity,
  SECTION_LABELS,
  SECTION_PRECEDENCE,
  serveIdentityBody,
  type AgentMode,
} from "./identity-store.js";
import { lessonsLimit } from "./features.js";
import { getLessonSelector } from "./extensions.js";
import { loadState } from "./state.js";
import { hicortexHome } from "./paths.js";
import type { ModuleIndex } from "./types.js";

const DEFAULT_PORT = 8787;

/** Harness name this hook injects for — used to self-gate on GET /identity `clients`. */
const THIS_HARNESS = "cc";

interface LessonsResponse {
  lessons: Array<{ content: string; created_at: string; base_strength: number; access_count: number }>;
  index: { total: number; lessonCount: number; sourceCount: number; projects: Array<{ name: string; count: number }> };
  moduleIndex?: ModuleIndex;
}

/**
 * The GET /identity response shape, shared by the CC hook and the OC plugin so
 * their gating cannot drift. `agent`/`mode` are echoed by a 0.13 server whenever
 * `?agent=` was sent (in EVERY mode); a pre-0.13 server omits them.
 */
export interface IdentityResponse {
  sections?: Record<string, string>;
  updated_at?: string;
  clients?: string[];
  agent?: string;
  mode?: string;
}

export interface ResolvedConfig {
  serverUrl: string;
  authToken: string | undefined;
  home: string;
  /** Per-agent identity id sent as ?agent= (0.13); null → global (no param). */
  agentName: string | null;
  /** Max lessons to inject (config.lessonsLimit, default 10). */
  lessonsLimit?: number;
}

/**
 * Read ~/.hicortex/config.json and resolve the server URL + auth token, or
 * null when there is no usable config (server not set up yet — fail soft).
 * Exported for reuse by the recall-hook CLI (#192) so the two CC hooks can
 * never resolve the server differently.
 */
export function resolveConfig(): ResolvedConfig | null {
  const home = hicortexHome();
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(readFileSync(join(home, "config.json"), "utf-8"));
  } catch {
    return null;
  }

  // Client mode uses serverUrl; server mode uses localhost.
  const serverUrl = config.mode === "client" && typeof config.serverUrl === "string"
    ? (config.serverUrl as string).replace(/\/+$/, "")
    : `http://127.0.0.1:${(config.port as number | undefined) ?? DEFAULT_PORT}`;

  // Per-agent identity id (0.13) via the shared resolver, so the id sent here
  // always matches what `hicortex status` reports. No configured agentName →
  // agentId null → NO ?agent= (bare fetch): CC's default is the shared global
  // identity. A configured agentName that sanitizes to null → agentId null too
  // (NO ?agent=), never a 400 that the fail-soft hook would silently swallow.
  const agentName = resolveAgentIdentity(config).agentId;

  return {
    serverUrl,
    authToken: config.authToken as string | undefined,
    home,
    agentName,
    lessonsLimit: typeof config.lessonsLimit === "number" ? config.lessonsLimit : undefined,
  };
}

function authHeaders(authToken: string | undefined): Record<string, string> {
  return authToken ? { "Authorization": `Bearer ${authToken}` } : {};
}

/**
 * Fetch /lessons and build the `## Hicortex Memory` block, or null on any
 * failure (missing/non-2xx/parse). Preserves the pre-0.12 behavior exactly.
 */
async function fetchLessonsBlock(cfg: ResolvedConfig): Promise<string | null> {
  const resp = await fetch(`${cfg.serverUrl}/lessons`, {
    headers: authHeaders(cfg.authToken),
    signal: AbortSignal.timeout(3000),
  });
  if (!resp.ok) return null;
  const data = await resp.json() as LessonsResponse;

  const maxLessons = lessonsLimit(cfg);
  const moduleIndex = data.moduleIndex ?? loadState(cfg.home).moduleIndex;
  // The SessionStart hook runs in the session's working directory, whose last
  // path component matches the capture-side CC project name convention
  // (transcript-reader's decodeProjectDirName also takes the last component).
  // This enables in-project + same-domain lesson boosting on the CC path.
  const project = basename(process.cwd()) || null;
  const selected = await getLessonSelector().select(data.lessons, { maxLessons, moduleIndex, project });

  const lessonLines = selected.map((l) => {
    const typeMatch = l.content.match(/\*\*Type:\*\* (\w+)/);
    const severityMatch = l.content.match(/\*\*Severity:\*\* (\w+)/);
    // First line, with any legacy `## Lesson:` prefix stripped — new lessons
    // are stored topic-first without the prefix (memory_type carries the type).
    const title = l.content.replace(/^##\s*Lesson:\s*/i, "").split("\n")[0].slice(0, 150);
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

  const { index } = data;
  if (moduleIndex && moduleIndex.domains.length > 0) {
    parts.push("", "### Memory Index");
    for (const domain of moduleIndex.domains) {
      const kwStr = domain.keywords.length > 0 ? `: ${domain.keywords.join(", ")}` : "";
      parts.push(`${domain.name} (${domain.memoryCount} memories, ${domain.lessonCount} Learnings)${kwStr}`);
      if (domain.projects.length > 0) parts.push(`  ${domain.projects.join(" | ")}`);
    }
    parts.push(`${index.total} memories, ${index.lessonCount} Learnings, ${index.sourceCount} agents. Search with \`hicortex_search\`.`);
  } else if (index.projects.length > 0) {
    parts.push("", "### Memory Index");
    parts.push(index.projects.map(p => `${p.name}: ${p.count}`).join(" | "));
    parts.push(`${index.total} memories, ${index.lessonCount} Learnings, ${index.sourceCount} agents. Search with \`hicortex_search\`.`);
  }

  return parts.join("\n");
}

/**
 * Title-case a section name for its heading: split on `-`/`_`, capitalize each
 * word ("user" → "User", "my_notes" → "My Notes").
 * Exported so the OC plugin (index.ts) renders the `## Identity` block
 * identically to the CC hook rather than duplicating the logic.
 */
export function titleCaseSection(name: string): string {
  return name
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Stable section ordering for the rendered `## Identity` block: the #313
 * precedence contract — `agent_identity` (the agent's own self + role
 * conduct) first, then `user` (the principal), then `rules` (fleet-wide house
 * rules), then every other section alphabetically. The list is imported from
 * identity-store (SECTION_PRECEDENCE) so the server's SERVED order and every
 * client's RENDERED order are the same definition — they cannot drift.
 * Server-side enumeration order (readdirSync) is FS-dependent, so we sort
 * here for a deterministic injection block. Exported for reuse by the OC
 * plugin; the Python Hermes plugin mirrors this helper — keep them in sync.
 */
export function orderSectionNames(names: string[]): string[] {
  const primaries = SECTION_PRECEDENCE.filter((p) => names.includes(p));
  const rest = names.filter((n) => !(SECTION_PRECEDENCE as readonly string[]).includes(n)).sort();
  return [...primaries, ...rest];
}

/**
 * Render the `## Identity` block from a resolved section map, or null when there
 * is nothing to inject (no sections, or every section blank after trimming).
 * Pure — no gating, no I/O. Shared verbatim by the CC hook and the OC plugin so
 * both harnesses emit an identical block. Sections are ordered (agent_identity,
 * user, rules, then alphabetical) and rendered under `###` headings labeled by
 * the #313 scope map (SECTION_LABELS: "Agent identity" / "User" / "Global
 * rules"); unknown section names fall back to title-case.
 */
export function renderIdentityBlock(sections: Record<string, string>): string | null {
  if (!sections || typeof sections !== "object" || Array.isArray(sections)) return null;
  const names = orderSectionNames(Object.keys(sections));
  const bodyParts: string[] = [];
  for (const name of names) {
    const body = sections[name];
    if (typeof body !== "string" || body.trim() === "") continue;
    // Own-property lookup (CR-A): "constructor" is allowlist-VALID, and a
    // plain SECTION_LABELS[name] would resolve through the Object.prototype
    // chain and render the inherited function's source as the heading.
    const label = Object.hasOwn(SECTION_LABELS, name) ? SECTION_LABELS[name] : titleCaseSection(name);
    bodyParts.push(`### ${label}`, "", body.trim());
  }
  if (bodyParts.length === 0) return null;
  return ["## Identity", "", ...bodyParts].join("\n");
}

/**
 * Gate a GET /identity response and render the `## Identity` block, or null when
 * nothing should be injected: `harness` not in the server-resolved `clients`,
 * an empty/blank section set, or — when `requireAgentEcho` — a response that
 * does not echo `agent`. The SINGLE gate used by both CC and OC so the two can
 * never drift (the Python Hermes plugin `provider.py::_context_block` mirrors
 * this logic — keep them in sync).
 *
 * `requireAgentEcho` is the old-server guard, and it is the CALLER's decision:
 *   - OC passes `agentId !== null` — when it actually sent an id, a 0.12 server
 *     that ignores `?agent=` (200 global, no echo) must NOT leak global identity
 *     into every persona; on a bare fetch (no id) the guard is off (amendment
 *     A2).
 *   - CC passes `false` ALWAYS and deliberately (see the call site): a thin CC
 *     client auto-upgrades via npx BEFORE the server does, so during the upgrade
 *     window it talks to a 0.12 server that cannot hold ANY per-agent config —
 *     global IS the operator's intended state there, and a guard would instead
 *     blank ALL identity for every CC session in that window.
 */
/**
 * Result of `buildIdentityToolResult` — the MCP tool handler maps this to its
 * `{content:[{type:"text",text}],isError?}` shape. Pure value: no MCP SDK
 * types leak here so the function is unit-testable with no harness.
 */
export interface IdentityToolResult {
  text: string;
  isError?: boolean;
}

/**
 * Build the `hicortex_identity` MCP tool result from the SAME pure pipeline the
 * REST `GET /identity` route and the SessionStart hook use (#264 CRITICAL fix:
 * previously the tool was a closure inside `createMcpServer()` that tests
 * re-implemented locally, so the production path was never exercised).
 *
 * Pipeline (kept identical to REST + hook by CONSTRUCTION, not by mirroring):
 *  1. `handleIdentityGet` — the real GET /identity handler, with the optional
 *     `agent` param forwarded so per-agent installs resolve the right scope
 *     (WARNING-2: previously the tool always passed `{}` → global, so an agent
 *     with an override saw the wrong identity).
 *  2. `serveIdentityBody` — the ONE composition helper (REST uses it too):
 *     injects the synthetic product-owned `memory` section (WARNING-1: the
 *     REST route + SessionStart hook inject it; the tool did not,
 *     contradicting its "same data" docs) and applies the SECTION_PRECEDENCE
 *     wire order.
 *  3. optional `name` filter, then `renderIdentityBlock` for the `### <Label>`
 *     markdown the hook injects.
 *
 * Pure: no I/O of its own (the only I/O is `handleIdentityGet` reading the
 * identity dir, which is the same I/O the REST route does). Takes the resolved
 * `identityClients` / `identityAgents` the daemon already holds at boot.
 */
export function buildIdentityToolResult(
  identityDir: string,
  identityClients: string[],
  identityAgents: Record<string, AgentMode>,
  opts: { name?: string; agent?: string; memoryInstructionsEnabled: boolean },
): IdentityToolResult {
  // WARNING-2: forward `agent` so per-agent installs resolve the right scope.
  // An invalid id makes handleIdentityGet return a 400 → surfaced as isError.
  const query: Record<string, unknown> = opts.agent ? { agent: opts.agent } : {};
  // WARNING-1: inject the synthetic `memory` section exactly like REST + the
  // SessionStart hook — via the ONE composition helper (serveIdentityBody,
  // #313 CR3) so the tool's served order is the routes' served order.
  const r = serveIdentityBody(
    handleIdentityGet(identityDir, identityClients, query, identityAgents),
    opts.memoryInstructionsEnabled,
  );
  if (r.status !== 200) {
    const errBody = r.body as { error?: string };
    return {
      text: `Identity fetch failed: ${JSON.stringify(errBody.error ?? r.body)}`,
      isError: true,
    };
  }

  const sections = (r.body as { sections?: Record<string, string> }).sections ?? {};
  const filtered = opts.name
    ? (sections[opts.name] !== undefined ? { [opts.name]: sections[opts.name] } : {})
    : sections;
  const block = renderIdentityBlock(filtered);
  if (block === null) {
    const text = opts.name
      ? `No identity section named '${opts.name}'.`
      : "No identity sections configured.";
    return { text };
  }
  return { text: block };
}

export function gateAndRenderIdentity(
  data: IdentityResponse,
  harness: string,
  opts: { requireAgentEcho: boolean },
): string | null {
  if (!data || typeof data !== "object") return null;
  const clients = Array.isArray(data.clients) ? data.clients : [];
  if (!clients.includes(harness)) return null;
  if (opts.requireAgentEcho && typeof data.agent !== "string") return null;
  return renderIdentityBlock(data.sections ?? {});
}

/**
 * Fetch /identity and build the `## Identity` block, or null when nothing should
 * be injected: non-2xx, this harness not in `clients`, no sections, or all
 * sections empty. Throws propagate to the caller's fail-soft catch.
 */
async function fetchIdentityBlock(cfg: ResolvedConfig): Promise<string | null> {
  // Send ?agent= only when we have a valid id; the server does the merge and
  // returns the resolved sections, so the hook stays dumb (no client-side mode
  // logic). A null id (CC's default: no configured agentName, or a configured
  // value that sanitizes to nothing) → bare /identity → the shared global set.
  const url = cfg.agentName
    ? `${cfg.serverUrl}/identity?agent=${encodeURIComponent(cfg.agentName)}`
    : `${cfg.serverUrl}/identity`;
  const resp = await fetch(url, {
    headers: authHeaders(cfg.authToken),
    signal: AbortSignal.timeout(3000),
  });
  if (!resp.ok) return null;
  const data = await resp.json() as IdentityResponse;

  // CC deliberately passes requireAgentEcho: false (NOT the OC/Hermes old-server
  // guard). A thin CC client auto-upgrades via npx BEFORE the server does, so
  // mid-upgrade it may hit a 0.12 server that returns global identity with no
  // `agent` echo — and a 0.12 server cannot hold per-agent config, so global is
  // the intended state. Guarding here would blank ALL CC identity in that window.
  return gateAndRenderIdentity(data, THIS_HARNESS, { requireAgentEcho: false });
}

/**
 * Fetch identity + lessons concurrently and return the combined Markdown block,
 * or null when neither yields anything (nothing to inject; caller prints
 * nothing and exits 0). The `## Identity` block is prepended before the existing
 * `## Hicortex Memory` block.
 */
export async function fetchLessonsIdentity(): Promise<string | null> {
  const cfg = resolveConfig();
  if (!cfg) return null;

  // Independent fail-soft: each branch degrades to null without affecting the
  // other. Promise.all runs them concurrently — each carries its own 3 s
  // timeout, so worst-case latency stays ~3 s, not ~6 s (spec §7).
  const [identityBlock, lessonsBlock] = await Promise.all([
    fetchIdentityBlock(cfg).catch(() => null),
    fetchLessonsBlock(cfg).catch(() => null),
  ]);

  const blocks = [identityBlock, lessonsBlock].filter((b): b is string => b !== null && b !== "");
  if (blocks.length === 0) return null;
  return blocks.join("\n\n");
}

/** Backcompat alias (#264). */
export const fetchLessonsContext = fetchLessonsIdentity;
/** Backcompat aliases (#264) for the renamed symbols. */
export const renderContextBlock = renderIdentityBlock;
export const gateAndRenderContext = gateAndRenderIdentity;
export type ContextResponse = IdentityResponse;
