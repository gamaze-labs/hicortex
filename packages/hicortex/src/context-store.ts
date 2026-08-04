/**
 * Context layer (L2) — file-backed storage (0.12.0, spec 2026-07-12).
 *
 * The context layer is hand-edited Markdown ("who you are + how to work") stored
 * as plain files in `<hicortex-home>/context/*.md` — one file per section, one
 * Web UI tab. It lives OUTSIDE the memories table: never distilled, scored,
 * decayed, or pruned. As plain files this guarantee is structural — no code in
 * consolidate.ts / distiller.ts references this directory.
 *
 * This module is pure file-layer logic (no express) so it is unit-testable and
 * reusable by the CLI. The daemon resolves `<hicortex-home>` exactly as it
 * resolves the DB dir (dirname of the resolved DB path) and passes the context
 * dir in — nothing here hardcodes `~`.
 *
 * Security contract (spec §1): client-supplied section names are NEVER joined
 * into a filesystem path except after passing the strict allowlist; the server
 * itself appends `.md`. Reads skip symlinks (lstat, not stat). Writes validate
 * ALL names before touching the disk (atomic request semantics), go via
 * temp-file-then-rename, and keep a one-generation `<name>.md.bak` undo.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Section-name allowlist (security contract)
// ---------------------------------------------------------------------------

/** A valid section name: lowercase alnum start, then alnum / `_` / `-`. */
export const SECTION_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;

/** Max section-name length (excludes the server-appended `.md`). */
export const SECTION_NAME_MAX = 64;

/**
 * True when `name` is a valid section name — matches the allowlist and is
 * 1..64 chars. Rejects traversal (`../x`, `a/b`), uppercase, leading `_`/`-`,
 * empty, and over-long names. The server appends `.md`; the name is never
 * otherwise joined into a path.
 */
export function isValidSectionName(name: string): boolean {
  return typeof name === "string" && name.length >= 1 && name.length <= SECTION_NAME_MAX && SECTION_NAME_RE.test(name);
}

/** Thrown by writeSections when any supplied name fails the allowlist. */
export class InvalidSectionNameError extends Error {
  constructor(public readonly names: string[]) {
    super(`Invalid section name(s): ${names.join(", ")}`);
    this.name = "InvalidSectionNameError";
  }
}

// ---------------------------------------------------------------------------
// Per-agent context (0.13, spec 2026-07-18)
// ---------------------------------------------------------------------------

/** Resolution mode for a given agent id (spec §3). */
export type AgentMode = "override" | "global" | "off";

/** Reserved subdir under <context>/ holding per-agent sections. NOT a section. */
export const AGENTS_DIR = "agents";

/**
 * Agent ids share the section-name allowlist: they are joined into a filesystem
 * path (`context/agents/<id>`), so this is the same security contract, not just
 * hygiene.
 */
export const isValidAgentId = isValidSectionName;

/**
 * Sanitize a raw identity string (hostname, configured name) into a valid agent
 * id, or null when nothing valid remains. Lowercase → collapse invalid runs to
 * `-` → strip leading `-`/`_` → truncate to the max length, then require the
 * result to pass the allowlist. "MacBook-Pro.local" → "macbook-pro-local"; a
 * string of only symbols/non-ASCII → null (caller then omits `?agent=` entirely
 * rather than sending an id that would 400).
 */
export function sanitizeAgentId(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+/, "")
    .slice(0, SECTION_NAME_MAX);
  return isValidSectionName(cleaned) ? cleaned : null;
}

/** The identity a client sends as `?agent=`, and where it came from. */
export interface AgentIdentity {
  /** The id the client sends as `?agent=`, or null → no param (bare fetch). */
  agentId: string | null;
  source: "configured" | "unset" | "invalid-config";
  /** The raw config value, for the configured / invalid-config cases. */
  rawConfigured?: string;
}

/**
 * Resolve an install's per-agent identity from its config (the SINGLE source of
 * truth shared by the CC hook and `hicortex status`, so the id an install
 * actually sends can never diverge from the id status reports):
 *  - `config.agentName` a non-empty string that sanitizes → that id
 *    ("configured");
 *  - a non-empty string that sanitizes to null → null id, "invalid-config" (the
 *    hook sends NO `?agent=`; status must say so);
 *  - absent, or empty/whitespace-only → null id, "unset". Empty string == unset
 *    everywhere (this is the value `init --agent-name ""` writes-then-clears to
 *    opt back out): CC's default is NO `?agent=`, so all CC boxes for one user
 *    share the global context — one user = one identity across machines.
 * There is NO hostname fallback: a hostname-derived default would silently give
 * every machine its own context, the opposite of the shared-identity default.
 */
export function resolveAgentIdentity(config: Record<string, unknown>): AgentIdentity {
  const value = config.agentName;
  // Empty / whitespace-only is treated as absent, not as an invalid id.
  const raw = typeof value === "string" && value.trim() !== "" ? value : null;
  if (raw !== null) {
    const s = sanitizeAgentId(raw);
    return s ? { agentId: s, source: "configured", rawConfigured: raw }
             : { agentId: null, source: "invalid-config", rawConfigured: raw };
  }
  return { agentId: null, source: "unset" };
}

/**
 * Normalize the raw `contextAgents` config value into a map of valid agent id →
 * mode. An entry is kept only when its key passes isValidAgentId AND its value
 * is one of the three modes; everything else is dropped and its key collected
 * for a one-time boot warning (mirrors resolveContextClients).
 */
export function resolveContextAgents(raw: unknown): { agents: Record<string, AgentMode>; dropped: string[] } {
  const agents: Record<string, AgentMode> = {};
  const dropped: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { agents, dropped };
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isValidAgentId(key) && (value === "override" || value === "global" || value === "off")) {
      agents[key] = value;
    } else {
      dropped.push(key);
    }
  }
  return { agents, dropped };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export interface ReadResult {
  sections: Record<string, string>;
  /** ISO timestamp of the latest included file's mtime, or null when none. */
  updatedAt: string | null;
  /** Per-section file mtimeMs — needed to compute updatedAt across a merge. */
  mtimes: Record<string, number>;
}

/**
 * Enumerate the context dir and return the served sections. Only regular files
 * whose basename (sans `.md`) passes the allowlist are included; symlinks are
 * skipped (lstat). `<name>.md.bak` and temp files never match the `*.md` filter.
 *
 * Fail-soft: a missing dir (fresh install) returns `{ sections: {}, updatedAt:
 * null }` and NEVER creates the dir or throws.
 */
export function readSections(dir: string): ReadResult {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    // ENOENT = fresh install (dir not created yet) → fail-soft empty. Any other
    // error (EACCES, EIO, ENOTDIR) is a real fault: surface it (the route turns
    // it into a 500) rather than masquerading a permissions problem as "empty".
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { sections: {}, updatedAt: null, mtimes: {} };
    throw err;
  }

  const sections: Record<string, string> = {};
  const mtimes: Record<string, number> = {};
  let latestMtimeMs = 0;

  for (const file of entries) {
    // Full-suffix check: only ".md" — excludes "<name>.md.bak" and temp files.
    // A directory (e.g. the reserved `agents/` subdir) also never matches the
    // `.md` filter, and even a dir literally named `x.md` fails the isFile()
    // check below — so the per-agent store is skipped by the global read.
    if (!file.endsWith(".md")) continue;
    const name = file.slice(0, -".md".length);
    if (!isValidSectionName(name)) continue;

    const full = join(dir, file);
    let st;
    try {
      // lstat (not stat): a symlink must be skipped, not followed.
      st = lstatSync(full);
    } catch {
      continue;
    }
    if (st.isSymbolicLink() || !st.isFile()) continue;

    try {
      sections[name] = readFileSync(full, "utf-8");
    } catch {
      continue;
    }
    mtimes[name] = st.mtimeMs;
    if (st.mtimeMs > latestMtimeMs) latestMtimeMs = st.mtimeMs;
  }

  const updatedAt = Object.keys(sections).length > 0 ? new Date(latestMtimeMs).toISOString() : null;
  return { sections, updatedAt, mtimes };
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Partial upsert of the named sections. Contract (spec §1):
 *  - Validate ALL names first; any invalid → throw InvalidSectionNameError and
 *    write NOTHING (atomic request semantics).
 *  - Only the named sections are touched; omitted sections stay untouched
 *    (omission is not deletion — deletion is filesystem-only).
 *  - Each write goes temp-file-then-rename in the same dir (no half-applied
 *    reads on GET-during-PUT).
 *  - After committing a write over an EXISTING file, the prior content is kept
 *    as `<name>.md.bak` (one-generation undo; `.bak` never matches the read
 *    `*.md` filter).
 *  - Empty-string content is allowed (clears the file).
 * Creates the dir (recursive) on first write.
 *
 * Failure semantics:
 *  - Invalid names → nothing written (validated up front).
 *  - All new content is written to temp files FIRST (phase A); if any temp
 *    write fails (disk full / EIO), nothing is committed and temps are cleaned
 *    up. This makes the common failure atomic. A rename failure during the
 *    commit loop (phase B) — rare for a same-dir rename — can still leave
 *    earlier sections of a MULTI-section write committed; single-section PUT
 *    (the norm from the UI/CLI) is fully all-or-nothing.
 *  - The `.bak` is written via its own temp+rename and only AFTER the main
 *    rename commits, so (a) a failed write never destroys the existing undo
 *    generation and (b) a symlink planted at the `.bak` path is replaced, never
 *    written THROUGH (never-follow-symlinks-on-write).
 */
export function writeSections(dir: string, sections: Record<string, string>): void {
  const invalid = Object.keys(sections).filter((n) => !isValidSectionName(n));
  if (invalid.length > 0) throw new InvalidSectionNameError(invalid);

  mkdirSync(dir, { recursive: true });

  const suffix = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const staged: Array<{ name: string; tmp: string; target: string }> = [];

  try {
    // Phase A — write every section to a temp file. The temp name never ends
    // in exactly ".md", so a leftover temp is invisible to readSections. If any
    // write throws, the finally block cleans up and NOTHING is committed.
    for (const [name, content] of Object.entries(sections)) {
      const target = join(dir, `${name}.md`);
      const tmp = join(dir, `.${name}.md.tmp-${suffix}`);
      writeFileSync(tmp, content, "utf-8");
      staged.push({ name, tmp, target });
    }

    // Phase B — commit. Capture prior content BEFORE the rename, back it up
    // only AFTER the rename succeeds.
    for (const { name, tmp, target } of staged) {
      let prior: Buffer | null = null;
      try {
        const st = lstatSync(target);
        // Real file → keep its content for the undo. A symlink is neither
        // followed nor read through: renameSync below atomically replaces the
        // symlink itself with our regular file, neutralizing a planted link.
        if (st.isFile() && !st.isSymbolicLink()) prior = readFileSync(target);
      } catch {
        // no prior file
      }

      renameSync(tmp, target); // commit (atomic; replaces a symlink, never follows it)

      if (prior !== null) {
        // Update the one-generation undo via temp+rename so we never write
        // through a planted symlink at the .bak path. Best-effort: a backup
        // failure must not fail the (already committed) write.
        const bak = join(dir, `${name}.md.bak`);
        const bakTmp = join(dir, `.${name}.md.bak.tmp-${suffix}`);
        try {
          writeFileSync(bakTmp, prior);
          renameSync(bakTmp, bak);
        } catch {
          try { if (existsSync(bakTmp)) unlinkSync(bakTmp); } catch { /* ignore */ }
        }
      }
    }
  } finally {
    // Remove any temp that never got renamed into place (phase-A/B failure).
    for (const { tmp } of staged) {
      try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* ignore */ }
    }
  }
}

/** Total UTF-8 byte size of all sections (used for the >16 KB warn). */
export function totalBytes(sections: Record<string, string>): number {
  let total = 0;
  for (const content of Object.values(sections)) total += Buffer.byteLength(content, "utf-8");
  return total;
}

/** Warn threshold: this layer bypasses token budgeting and injects every session. */
export const CONTEXT_SIZE_WARN_BYTES = 16_384;

// ---------------------------------------------------------------------------
// Config — contextClients normalization
// ---------------------------------------------------------------------------

/** Harness names that may inject the context layer. */
export const KNOWN_CONTEXT_CLIENTS = ["cc", "hermes", "oc"] as const;

export interface ResolvedContextClients {
  /** The resolved, de-duped list of known client names. */
  clients: string[];
  /** Unknown names dropped from an array value (for a one-time boot warning). */
  dropped: string[];
}

/**
 * Normalize the raw `contextClients` config value (spec §2):
 *  - `"all"` (any case)      → ["cc","hermes","oc"]
 *  - array                   → lowercase, keep known names (de-duped), collect dropped unknowns
 *  - missing / non-array-non-"all" → default ["cc"]
 * The resolved list is echoed by GET /context as `clients` so each harness's
 * hook can self-gate without its own config.
 */
export function resolveContextClients(raw: unknown): ResolvedContextClients {
  if (typeof raw === "string" && raw.toLowerCase() === "all") {
    return { clients: [...KNOWN_CONTEXT_CLIENTS], dropped: [] };
  }
  if (Array.isArray(raw)) {
    const known = new Set<string>(KNOWN_CONTEXT_CLIENTS);
    const clients: string[] = [];
    const dropped: string[] = [];
    for (const item of raw) {
      if (typeof item !== "string") {
        dropped.push(String(item));
        continue;
      }
      const lower = item.toLowerCase();
      // "all" as an array member expands to every known client — the array is
      // the natural form of the documented "all" value, so ["all"] must mean
      // all, not an empty list.
      if (lower === "all") {
        for (const k of KNOWN_CONTEXT_CLIENTS) if (!clients.includes(k)) clients.push(k);
        continue;
      }
      if (known.has(lower)) {
        if (!clients.includes(lower)) clients.push(lower);
      } else {
        dropped.push(item);
      }
    }
    return { clients, dropped };
  }
  return { clients: ["cc"], dropped: [] };
}

// ---------------------------------------------------------------------------
// Per-agent resolution (0.13)
// ---------------------------------------------------------------------------

/**
 * Classify the on-disk state of `context/agents/<id>`, hardened against a
 * symlink planted at EITHER the `agents` ROOT or the `<id>` leaf — lstat/readdir
 * follow a symlinked intermediate path component, so checking only the leaf
 * would let a symlinked root escape the context root entirely. BOTH must be
 * real, non-symlink directories.
 *  - "absent" — the root or the leaf does not exist (fresh install / no dir for
 *    this agent). A normal, safe "no agent sections" case.
 *  - "real"   — both are real directories → safe to read/write.
 *  - "unsafe" — the root or leaf exists but is a symlink or non-directory →
 *    never read/write through it (treat as no agent sections).
 * Fail-explicit: ENOENT is the ONLY swallowed error; EACCES/EIO/ENOTDIR etc.
 * rethrow (a permissions fault must never masquerade as "empty", matching
 * readSections). The single source of truth for the four call sites below.
 */
export function agentDirState(contextDir: string, agentId: string): "absent" | "real" | "unsafe" {
  const root = join(contextDir, AGENTS_DIR);
  let rootSt;
  try {
    rootSt = lstatSync(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw err;
  }
  if (rootSt.isSymbolicLink() || !rootSt.isDirectory()) return "unsafe";

  let leafSt;
  try {
    leafSt = lstatSync(join(root, agentId));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw err;
  }
  if (leafSt.isSymbolicLink() || !leafSt.isDirectory()) return "unsafe";
  return "real";
}

/**
 * Resolve the mode for a request `?agent=<id>` (spec §3):
 *  1. config entry present → that mode;
 *  2. else `context/agents/<id>/` present as a REAL directory (root + leaf both
 *     real, non-symlink) → "override" (dropping in a dir is intent, no config);
 *  3. else → "global".
 * A symlinked/non-dir root or leaf never counts as "present" (agentDirState).
 */
export function resolveAgentMode(
  contextDir: string,
  agentId: string,
  contextAgents: Record<string, AgentMode>,
): AgentMode {
  const configured = contextAgents[agentId];
  if (configured) return configured;
  return agentDirState(contextDir, agentId) === "real" ? "override" : "global";
}

/**
 * Enumerate the agents the UI selector should offer: the union of allowlisted
 * REAL directories under `context/agents/` and every configured `contextAgents`
 * key, each mapped to its resolved mode (config wins over presence). A missing
 * agents dir (fresh install) yields the config keys only; a symlinked/non-dir
 * agents root is treated as "no dirs" (config keys only).
 */
export function listAgents(
  contextDir: string,
  contextAgents: Record<string, AgentMode>,
): Record<string, AgentMode> {
  const result: Record<string, AgentMode> = {};
  const agentsRoot = join(contextDir, AGENTS_DIR);

  // Guard the root itself before readdir would follow a symlinked root.
  let rootReal = false;
  try {
    const st = lstatSync(agentsRoot);
    rootReal = st.isDirectory() && !st.isSymbolicLink();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; // fail-explicit
  }

  if (rootReal) {
    for (const entry of readdirSync(agentsRoot)) {
      if (!isValidAgentId(entry)) continue;
      // Real leaf confirmed by the shared guard → its mode is config-or-override
      // (config wins over presence); no second lstat via resolveAgentMode.
      if (agentDirState(contextDir, entry) === "real") {
        result[entry] = contextAgents[entry] ?? "override";
      }
    }
  }
  for (const id of Object.keys(contextAgents)) {
    if (!(id in result)) result[id] = contextAgents[id];
  }
  return result;
}

export interface ResolvedRead {
  sections: Record<string, string>;
  updatedAt: string | null;
  /** Echoed only when an agent was requested (agentId non-null). */
  agent?: string;
  mode?: AgentMode;
  /** Per-section provenance, present only in override mode (feeds the UI). */
  origins?: Record<string, "global" | "agent">;
}

/**
 * Read the sections that apply to `agentId` (null → a plain global read).
 * off → {}; global → the global set; override → per-section merge of the global
 * set under the agent's own sections, with `updatedAt` taken across only the
 * files that WON the merge. The agent dir is lstat-guarded immediately before
 * reading (A1): a symlinked or non-directory `agents/<id>` contributes NO agent
 * sections regardless of how override was selected (config or presence).
 */
export function readResolvedSections(
  contextDir: string,
  agentId: string | null,
  contextAgents: Record<string, AgentMode>,
): ResolvedRead {
  if (agentId === null) {
    const g = readSections(contextDir);
    return { sections: g.sections, updatedAt: g.updatedAt };
  }

  const mode = resolveAgentMode(contextDir, agentId, contextAgents);
  if (mode === "off") {
    return { sections: {}, updatedAt: null, agent: agentId, mode };
  }

  const global = readSections(contextDir);
  if (mode === "global") {
    return { sections: global.sections, updatedAt: global.updatedAt, agent: agentId, mode };
  }

  // override — read the agent dir, but only if root + leaf are real dirs
  // (agentDirState closes the config-forced-override + symlinked-root holes).
  let agentRead: ReadResult = { sections: {}, updatedAt: null, mtimes: {} };
  if (agentDirState(contextDir, agentId) === "real") {
    agentRead = readSections(join(contextDir, AGENTS_DIR, agentId));
  }

  const sections: Record<string, string> = { ...global.sections, ...agentRead.sections };
  const origins: Record<string, "global" | "agent"> = {};
  let latestMtimeMs = 0;
  for (const name of Object.keys(sections)) {
    const fromAgent = name in agentRead.sections;
    origins[name] = fromAgent ? "agent" : "global";
    const mt = fromAgent ? agentRead.mtimes[name] : global.mtimes[name];
    if (mt && mt > latestMtimeMs) latestMtimeMs = mt;
  }
  const updatedAt = Object.keys(sections).length > 0 ? new Date(latestMtimeMs).toISOString() : null;
  return { sections, updatedAt, agent: agentId, mode, origins };
}

// ---------------------------------------------------------------------------
// HTTP-shape handlers (real logic behind GET/PUT /context)
// ---------------------------------------------------------------------------
//
// These are the actual request handlers, expressed as pure functions over
// plain inputs so they are unit-tested directly (no mirror app that can drift
// from mcp-server.ts). mcp-server.ts wires req/res to them and nothing else.

/** Recall query params whose presence means a stale pre-0.12 recall caller. */
const RECALL_PARAMS = ["project", "limit", "privacy"] as const;

export interface HandlerResult {
  status: number;
  body: unknown;
  /** When set, the adapter should console.warn this (size warning). */
  warn?: string;
}

/**
 * Extract and validate the `?agent=` query param. Absent → global (agentId
 * null, no error). Present but not a plain string (express gives `string[]` for
 * `?agent=a&agent=b`) or failing the allowlist → a 400 error string (never a
 * silent fallback to global — a typo must be loud, spec §1).
 */
function extractAgentParam(query: Record<string, unknown>): { agentId: string | null; error?: string } {
  if (!("agent" in query)) return { agentId: null };
  const raw = query.agent;
  if (typeof raw !== "string" || !isValidAgentId(raw)) {
    return { agentId: null, error: "Invalid 'agent' — must match ^[a-z0-9][a-z0-9_-]*$ (max 64 chars)" };
  }
  return { agentId: raw };
}

/**
 * GET /context. Stale-client tripwire first: recall moved to /recent, so
 * project/limit/privacy on this route mean a legacy recall caller — return a
 * loud 400 rather than silently degrading to an empty context-layer response.
 * (A bare GET /context with no params is the legitimate context-layer read and
 * is served normally — the two are indistinguishable at the wire, so a
 * paramless legacy caller is covered by the migration docs, not this guard.)
 */
export function handleContextGet(
  contextDir: string,
  clients: string[],
  query: Record<string, unknown>,
  contextAgents: Record<string, AgentMode> = {},
): HandlerResult {
  if (RECALL_PARAMS.some((p) => p in query)) {
    return {
      status: 400,
      body: { error: "recall moved to /recent — GET /context now serves the standing context layer (0.12)" },
    };
  }

  const { agentId, error } = extractAgentParam(query);
  if (error) return { status: 400, body: { error } };

  // No agent → the plain global read plus the additive `agents` map the UI
  // selector needs (backward compatible: existing callers ignore unknown keys).
  if (agentId === null) {
    const { sections, updatedAt } = readSections(contextDir);
    return {
      status: 200,
      body: { sections, updated_at: updatedAt, clients, agents: listAgents(contextDir, contextAgents) },
    };
  }

  const resolved = readResolvedSections(contextDir, agentId, contextAgents);
  const body: Record<string, unknown> = {
    sections: resolved.sections,
    updated_at: resolved.updatedAt,
    clients,
    agent: resolved.agent,
    mode: resolved.mode,
  };
  if (resolved.origins) body.origins = resolved.origins;
  return { status: 200, body };
}

/**
 * PUT /context. Validates the body shape and section content types, then
 * delegates to writeSections (which owns the name allowlist + atomicity +
 * symlink safety). Throws are left to the adapter to turn into a 500.
 */
export function handleContextPut(
  contextDir: string,
  body: unknown,
  query: Record<string, unknown> = {},
  contextAgents: Record<string, AgentMode> = {},
): HandlerResult {
  const { agentId, error } = extractAgentParam(query);
  if (error) return { status: 400, body: { error } };

  const sections = (body as { sections?: unknown } | null | undefined)?.sections;
  if (!sections || typeof sections !== "object" || Array.isArray(sections)) {
    return { status: 400, body: { error: "Missing or invalid 'sections' object" } };
  }
  for (const [name, content] of Object.entries(sections)) {
    if (typeof content !== "string") {
      return { status: 400, body: { error: `Section '${name}' content must be a string` } };
    }
  }

  const targetDir = agentId === null ? contextDir : join(contextDir, AGENTS_DIR, agentId);

  if (agentId !== null) {
    // A1 write-path guard: never write through a symlinked/non-dir root or leaf
    // (agentDirState checks both). "absent" is fine — writeSections creates it.
    if (agentDirState(contextDir, agentId) === "unsafe") {
      return { status: 400, body: { error: "agent context path exists but is not a directory" } };
    }
    // Black-hole guard: if config FORCES off/global for this agent, sections
    // written under agents/<id>/ could never be served (resolution ignores the
    // dir). Reject loudly rather than accept a write that silently vanishes.
    // No config entry → writing creates the dir ⇒ override ⇒ served (allowed).
    const configMode = contextAgents[agentId];
    if (configMode === "off" || configMode === "global") {
      return {
        status: 409,
        body: {
          error:
            `config contextAgents['${agentId}']='${configMode}' — sections written here would never be served; ` +
            `set it to 'override' (or remove the entry) first`,
        },
      };
    }
  }

  // Skip the write entirely when nothing is supplied: writeSections would
  // otherwise mkdir the (agent) dir for a no-op PUT, silently flipping an
  // agent to override via presence. Reading the resolved view still reflects
  // current disk state.
  if (Object.keys(sections).length > 0) {
    try {
      writeSections(targetDir, sections as Record<string, string>);
    } catch (err) {
      if (err instanceof InvalidSectionNameError) {
        return { status: 400, body: { error: `Invalid section name(s): ${err.names.join(", ")}` } };
      }
      throw err; // real I/O fault → adapter returns 500
    }
  }

  const resolved = readResolvedSections(contextDir, agentId, contextAgents);
  const bytes = totalBytes(resolved.sections);
  const warn = bytes > CONTEXT_SIZE_WARN_BYTES
    ? `Context layer total size ${bytes} bytes exceeds ${CONTEXT_SIZE_WARN_BYTES} — injected into every session; consider trimming.`
    : undefined;
  const respBody: Record<string, unknown> = { ok: true, updated_at: resolved.updatedAt };
  if (agentId !== null) {
    respBody.agent = resolved.agent;
    respBody.mode = resolved.mode;
  }
  return { status: 200, body: respBody, warn };
}
