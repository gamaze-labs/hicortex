/**
 * lessons-context — query-time context injection for the CC SessionStart hook.
 *
 * Replaces file-based injection (injectLessons / injectLessonsFromServer).
 * Reads ~/.hicortex/config.json to find the server URL, then fetches TWO
 * endpoints concurrently and prints a compact Markdown block to stdout so CC
 * picks it up as session context:
 *
 *   GET /context  → the standing context layer (user info + rules; 0.12).
 *                   Injected as a `## Context` block ONLY when this harness
 *                   ("cc") is in the server-resolved `clients` list (self-gate).
 *   GET /lessons  → episodic memory lessons + memory index, rendered as the
 *                   existing `## Hicortex Memory` block.
 *
 * The two fetches run in Promise.all, each with its OWN 3 s timeout and
 * INDEPENDENT fail-soft: a /context failure must never cost the lessons block,
 * and vice versa. Sequential fetches would double worst-case SessionStart
 * latency (~6 s) — see spec §7.
 *
 * Fail-soft by design: ANY failure (missing config, network error, non-2xx,
 * parse error) results in silent exit-0. A broken hook must never block a
 * CC session, and a broken /context fetch must never blank the whole output.
 */

import { readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { resolveAgentIdentity } from "./context-store.js";
import { lessonsLimit } from "./features.js";
import { getLessonSelector } from "./extensions.js";
import { loadState } from "./state.js";
import { hicortexHome } from "./paths.js";
import type { ModuleIndex } from "./types.js";

const DEFAULT_PORT = 8787;

/** Harness name this hook injects for — used to self-gate on GET /context `clients`. */
const THIS_HARNESS = "cc";

interface LessonsResponse {
  lessons: Array<{ content: string; created_at: string; base_strength: number; access_count: number }>;
  index: { total: number; lessonCount: number; sourceCount: number; projects: Array<{ name: string; count: number }> };
  moduleIndex?: ModuleIndex;
}

/**
 * The GET /context response shape, shared by the CC hook and the OC plugin so
 * their gating cannot drift. `agent`/`mode` are echoed by a 0.13 server whenever
 * `?agent=` was sent (in EVERY mode); a pre-0.13 server omits them.
 */
export interface ContextResponse {
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
  /** Per-agent context id sent as ?agent= (0.13); null → global (no param). */
  agentName: string | null;
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

  // Per-agent context id (0.13) via the shared resolver, so the id sent here
  // always matches what `hicortex status` reports. No configured agentName →
  // agentId null → NO ?agent= (bare fetch): CC's default is the shared global
  // context. A configured agentName that sanitizes to null → agentId null too
  // (NO ?agent=), never a 400 that the fail-soft hook would silently swallow.
  const agentName = resolveAgentIdentity(config).agentId;

  return { serverUrl, authToken: config.authToken as string | undefined, home, agentName };
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

  const maxLessons = lessonsLimit();
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
    parts.push("", "### Lessons (updated nightly)");
    parts.push(...lessonLines);
  }

  const { index } = data;
  if (moduleIndex && moduleIndex.domains.length > 0) {
    parts.push("", "### Memory Index");
    for (const domain of moduleIndex.domains) {
      const kwStr = domain.keywords.length > 0 ? `: ${domain.keywords.join(", ")}` : "";
      parts.push(`${domain.name} (${domain.memoryCount} memories, ${domain.lessonCount} lessons)${kwStr}`);
      if (domain.projects.length > 0) parts.push(`  ${domain.projects.join(" | ")}`);
    }
    parts.push(`${index.total} memories, ${index.lessonCount} lessons, ${index.sourceCount} agents. Search with \`hicortex_search\`.`);
  } else if (index.projects.length > 0) {
    parts.push("", "### Memory Index");
    parts.push(index.projects.map(p => `${p.name}: ${p.count}`).join(" | "));
    parts.push(`${index.total} memories, ${index.lessonCount} lessons, ${index.sourceCount} agents. Search with \`hicortex_search\`.`);
  }

  return parts.join("\n");
}

/**
 * Title-case a section name for its heading: split on `-`/`_`, capitalize each
 * word ("user" → "User", "my_notes" → "My Notes").
 * Exported so the OC plugin (index.ts) renders the `## Context` block
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
 * Stable section ordering: `user` first, then `rules` (the seeded primary
 * sections, spec §8), then every other section alphabetically. Server-side
 * enumeration order (readdirSync) is FS-dependent, so we sort here for a
 * deterministic injection block. Exported for reuse by the OC plugin.
 */
export function orderSectionNames(names: string[]): string[] {
  const primaries = ["user", "rules"].filter((p) => names.includes(p));
  const rest = names.filter((n) => n !== "user" && n !== "rules").sort();
  return [...primaries, ...rest];
}

/**
 * Render the `## Context` block from a resolved section map, or null when there
 * is nothing to inject (no sections, or every section blank after trimming).
 * Pure — no gating, no I/O. Shared verbatim by the CC hook and the OC plugin so
 * both harnesses emit an identical block. Sections are ordered (user, rules,
 * then alphabetical) and rendered under title-cased `###` headings.
 */
export function renderContextBlock(sections: Record<string, string>): string | null {
  if (!sections || typeof sections !== "object" || Array.isArray(sections)) return null;
  const names = orderSectionNames(Object.keys(sections));
  const bodyParts: string[] = [];
  for (const name of names) {
    const body = sections[name];
    if (typeof body !== "string" || body.trim() === "") continue;
    bodyParts.push(`### ${titleCaseSection(name)}`, "", body.trim());
  }
  if (bodyParts.length === 0) return null;
  return ["## Context", "", ...bodyParts].join("\n");
}

/**
 * Gate a GET /context response and render the `## Context` block, or null when
 * nothing should be injected: `harness` not in the server-resolved `clients`,
 * an empty/blank section set, or — when `requireAgentEcho` — a response that
 * does not echo `agent`. The SINGLE gate used by both CC and OC so the two can
 * never drift (the Python Hermes plugin `provider.py::_context_block` mirrors
 * this logic — keep them in sync).
 *
 * `requireAgentEcho` is the old-server guard, and it is the CALLER's decision:
 *   - OC passes `agentId !== null` — when it actually sent an id, a 0.12 server
 *     that ignores `?agent=` (200 global, no echo) must NOT leak global context
 *     into every persona; on a bare fetch (no id) the guard is off (amendment
 *     A2).
 *   - CC passes `false` ALWAYS and deliberately (see the call site): a thin CC
 *     client auto-upgrades via npx BEFORE the server does, so during the upgrade
 *     window it talks to a 0.12 server that cannot hold ANY per-agent config —
 *     global IS the operator's intended state there, and a guard would instead
 *     blank ALL context for every CC session in that window.
 */
export function gateAndRenderContext(
  data: ContextResponse,
  harness: string,
  opts: { requireAgentEcho: boolean },
): string | null {
  if (!data || typeof data !== "object") return null;
  const clients = Array.isArray(data.clients) ? data.clients : [];
  if (!clients.includes(harness)) return null;
  if (opts.requireAgentEcho && typeof data.agent !== "string") return null;
  return renderContextBlock(data.sections ?? {});
}

/**
 * Fetch /context and build the `## Context` block, or null when nothing should
 * be injected: non-2xx, this harness not in `clients`, no sections, or all
 * sections empty. Throws propagate to the caller's fail-soft catch.
 */
async function fetchContextBlock(cfg: ResolvedConfig): Promise<string | null> {
  // Send ?agent= only when we have a valid id; the server does the merge and
  // returns the resolved sections, so the hook stays dumb (no client-side mode
  // logic). A null id (CC's default: no configured agentName, or a configured
  // value that sanitizes to nothing) → bare /context → the shared global set.
  const url = cfg.agentName
    ? `${cfg.serverUrl}/context?agent=${encodeURIComponent(cfg.agentName)}`
    : `${cfg.serverUrl}/context`;
  const resp = await fetch(url, {
    headers: authHeaders(cfg.authToken),
    signal: AbortSignal.timeout(3000),
  });
  if (!resp.ok) return null;
  const data = await resp.json() as ContextResponse;

  // CC deliberately passes requireAgentEcho: false (NOT the OC/Hermes old-server
  // guard). A thin CC client auto-upgrades via npx BEFORE the server does, so
  // mid-upgrade it may hit a 0.12 server that returns global context with no
  // `agent` echo — and a 0.12 server cannot hold per-agent config, so global is
  // the intended state. Guarding here would blank ALL CC context in that window.
  return gateAndRenderContext(data, THIS_HARNESS, { requireAgentEcho: false });
}

/**
 * Fetch context + lessons concurrently and return the combined Markdown block,
 * or null when neither yields anything (nothing to inject; caller prints
 * nothing and exits 0). The `## Context` block is prepended before the existing
 * `## Hicortex Memory` block.
 */
export async function fetchLessonsContext(): Promise<string | null> {
  const cfg = resolveConfig();
  if (!cfg) return null;

  // Independent fail-soft: each branch degrades to null without affecting the
  // other. Promise.all runs them concurrently — each carries its own 3 s
  // timeout, so worst-case latency stays ~3 s, not ~6 s (spec §7).
  const [contextBlock, lessonsBlock] = await Promise.all([
    fetchContextBlock(cfg).catch(() => null),
    fetchLessonsBlock(cfg).catch(() => null),
  ]);

  const blocks = [contextBlock, lessonsBlock].filter((b): b is string => b !== null && b !== "");
  if (blocks.length === 0) return null;
  return blocks.join("\n\n");
}
