/**
 * Identity layer — file-backed storage (formerly "Context Layer" / L2; 0.12.0,
 * spec 2026-07-12; renamed 0.18 #264).
 *
 * The identity layer is hand-edited Markdown ("who you are + how to work") stored
 * as plain files in `<hicortex-home>/identity/*.md` — one file per section, one
 * Web UI tab. It lives OUTSIDE the memories table: never distilled, scored,
 * decayed, or pruned. As plain files this guarantee is structural — no code in
 * consolidate.ts / distiller.ts references this directory.
 *
 * This module is pure file-layer logic (no express) so it is unit-testable and
 * reusable by the CLI. The daemon resolves `<hicortex-home>` exactly as it
 * resolves the DB dir (dirname of the resolved DB path) and passes the identity
 * dir in — nothing here hardcodes `~`.
 *
 * Security contract (spec §1): client-supplied section names are NEVER joined
 * into a filesystem path except after passing the strict allowlist; the server
 * itself appends `.md`. Reads skip symlinks (lstat, not stat). Writes validate
 * ALL names before touching the disk (atomic request semantics), go via
 * temp-file-then-rename, and keep a one-generation `<name>.md.bak` undo.
 *
 * Backcompat (#264): the pre-rename directory was `<hicortex-home>/context/`.
 * `migrateIdentityDir` renames it to `identity/` on the next init/nightly run
 * when the old dir exists and the new does not. When BOTH exist (partial
 * migration, a disk-full renameSync failure, or an operator re-creating
 * `context/`), reads ADDITIVELY MERGE: per-section `identity/` wins, and
 * legacy-only sections are included so nothing is lost — at both the global
 * and the per-agent (`agents/<id>/`) level.
 *
 * #313 adds the per-agent `agent_identity` section (who THIS agent is + its
 * role conduct; per-agent ONLY, never global) and makes the served section
 * order a defined contract — see SECTION_PRECEDENCE below. `user` remains the
 * PRINCIPAL (global) and `rules` the fleet-wide house rules (never
 * overridden per-agent: section-level replacement would shadow them).
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
import { injectMemorySection } from "./memory-instructions.js";

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

/**
 * A purely-numeric section name (`^\d+$`). Allowlist-VALID (reads must keep
 * serving existing numeric files) but rejected on writes: integer-index
 * object keys serialise before every string key, so a numeric section escapes
 * the SECTION_PRECEDENCE wire contract entirely (see orderSections' documented
 * exception). Enforced in writeSections only — never in isValidSectionName,
 * which gates READS as well.
 */
const NUMERIC_SECTION_RE = /^\d+$/;

// ---------------------------------------------------------------------------
// Per-agent identity (0.13, spec 2026-07-18)
// ---------------------------------------------------------------------------

/** Resolution mode for a given agent id (spec §3). */
export type AgentMode = "override" | "global" | "off";

/** Reserved subdir under <identity>/ holding per-agent sections. NOT a section. */
export const AGENTS_DIR = "agents";

/**
 * Agent ids share the section-name allowlist: they are joined into a filesystem
 * path (`identity/agents/<id>`), so this is the same security contract, not just
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
 *    share the global identity — one user = one identity across machines.
 * There is NO hostname fallback: a hostname-derived default would silently give
 * every machine its own identity, the opposite of the shared-identity default.
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
 * Normalize the raw `identityAgents` config value into a map of valid agent id →
 * mode. An entry is kept only when its key passes isValidAgentId AND its value
 * is one of the three modes; everything else is dropped and its key collected
 * for a one-time boot warning (mirrors resolveIdentityClients).
 *
 * Backcompat (#264): the pre-rename key was `contextAgents`. Callers that want
 * to honour it should pass the already-resolved value here (see
 * `resolveIdentityConfig` in mcp-server.ts which reads new + old).
 */
export function resolveIdentityAgents(raw: unknown): { agents: Record<string, AgentMode>; dropped: string[] } {
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
// Directory migration (backcompat — pre-rename was <home>/context/, #264)
// ---------------------------------------------------------------------------

/**
 * Rename `<home>/context/` → `<home>/identity/` when the legacy dir exists and
 * the new dir does not. Idempotent + safe: when both exist (a partial
 * migration, or the operator created both) NOTHING is renamed — the caller
 * falls back to a legacy read instead. Returns a description of what happened
 * for a one-time boot log.
 *
 * Called from init and nightly so the migration lands on the next run of either
 * command an existing install hits.
 */
export function migrateIdentityDir(home: string): { renamed: boolean; from: string; to: string; reason?: string } {
  const from = join(home, "context");
  const to = join(home, "identity");
  if (!existsSync(from)) return { renamed: false, from, to, reason: "no legacy context/ dir" };
  if (existsSync(to)) return { renamed: false, from, to, reason: "identity/ already exists — leaving context/ in place (reads additively merge identity/ over legacy context/ per-section)" };
  try {
    renameSync(from, to);
    return { renamed: true, from, to };
  } catch (err) {
    // A failed rename is non-fatal: the legacy dir is still readable via the
    // fallback in readSectionsWithFallback, so log + continue rather than
    // blocking the boot.
    return { renamed: false, from, to, reason: `rename failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ---------------------------------------------------------------------------
// Section precedence — the served ordering contract (#313)
// ---------------------------------------------------------------------------

/**
 * The order sections are SERVED in (#313): `agent_identity` → `user` →
 * `rules`, then every other section alphabetically. Semantics behind the
 * order:
 *  - `agent_identity` — who THIS agent is (name, origin, character, voice,
 *    genuine interests) plus its role conduct; per-agent only, at
 *    `identity/agents/<id>/agent_identity.md`. It leads so the agent reads
 *    its own self before anything else.
 *  - `user` — the PRINCIPAL the whole fleet serves (global, never the agent).
 *  - `rules` — fleet-wide house rules. Global only: section-level replacement
 *    means a per-agent rules.md would SHADOW house rules, so role-specific
 *    conduct lives INSIDE agent_identity.md (additive by construction).
 * Before #313 this ordering rode on file-read order (readdirSync, FS-dependent)
 * where it existed at all — now it is a defined, tested contract. The SAME
 * list is shared by the client renderers (orderSectionNames in
 * learnings-identity.ts imports it; the Hermes plugin mirrors it) so server
 * and clients can never drift: the precedence is defined ONCE, here.
 */
export const SECTION_PRECEDENCE = ["agent_identity", "user", "rules"] as const;

/**
 * Scope display labels (#313): ONE map, consumed by the injected-block
 * renderer (renderIdentityBlock — CC hook + OC plugin + MCP tool), the UI
 * editor (DISPLAY_LABELS mirrors it), and the Hermes plugin (mirror in
 * provider.py). "Global rules" says what the section IS (fleet-wide house
 * rules), distinguishing it from per-agent content. Unknown section names
 * fall back to title-case (titleCaseSection) — no file renames, the API keys
 * stay the section names on disk.
 */
export const SECTION_LABELS: Readonly<Record<string, string>> = {
  agent_identity: "Agent identity",
  user: "User",
  rules: "Global rules",
};

/**
 * Rebuild a sections record with its keys inserted in SECTION_PRECEDENCE
 * order, then the rest alphabetically. Pure: same values, same (string) keys,
 * deterministic order — JSON serialisation preserves insertion order, so this
 * IS the wire contract. Idempotent; a map with no known primaries is just
 * alphabetised.
 *
 * DOCUMENTED EXCEPTION: a canonically-numeric section name (e.g. "42") is an
 * integer-index key in JS and serialises BEFORE every string key regardless
 * of insertion order — it escapes the contract by engine semantics, not by
 * our choice. That is why writeSections rejects purely-numeric names on new
 * writes (reads keep serving existing numeric files).
 */
export function orderSections(sections: Record<string, string>): Record<string, string> {
  const names = Object.keys(sections);
  const primaries = SECTION_PRECEDENCE.filter((p) => names.includes(p));
  const rest = names.filter((n) => !(SECTION_PRECEDENCE as readonly string[]).includes(n)).sort();
  const ordered: Record<string, string> = {};
  for (const name of [...primaries, ...rest]) ordered[name] = sections[name];
  return ordered;
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
 * Enumerate the identity dir and return the served sections. Only regular files
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

/**
 * Merge two ReadResults into an additive union: a section present in BOTH is
 * taken from `primary` (it wins per-section); sections present ONLY in
 * `secondary` are included so nothing is lost. `updatedAt` is recomputed across
 * the files that won the merge. Pure helper.
 */
function mergeSections(primary: ReadResult, secondary: ReadResult): ReadResult {
  const sections: Record<string, string> = { ...secondary.sections, ...primary.sections };
  const mtimes: Record<string, number> = {};
  let latestMtimeMs = 0;
  for (const name of Object.keys(sections)) {
    const mt = name in primary.mtimes ? primary.mtimes[name] : secondary.mtimes[name];
    if (mt !== undefined) mtimes[name] = mt;
    if (mt && mt > latestMtimeMs) latestMtimeMs = mt;
  }
  const updatedAt = Object.keys(sections).length > 0 ? new Date(latestMtimeMs).toISOString() : null;
  return { sections, updatedAt, mtimes };
}

/**
 * Read the identity dir, additively merging the legacy `context/` sibling so
 * nothing is lost when both dirs exist (post-#264 safety net for a partial/no
 * migration: a disk-full renameSync failure, or an operator re-creating
 * `context/`). Per-section, `identity/` wins; legacy-only sections are included
 * (union). Pure function over the two dirs — used by the GET handler.
 */
export function readSectionsWithFallback(identityDir: string): ReadResult {
  const primary = readSections(identityDir);
  const legacy = readSections(join(identityDir, "..", "context"));
  if (Object.keys(legacy.sections).length === 0) return primary;
  if (Object.keys(primary.sections).length === 0) return legacy;
  return mergeSections(primary, legacy);
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Partial upsert of the named sections. Contract (spec §1):
 *  - Validate ALL names first; any invalid → throw InvalidSectionNameError and
 *    write NOTHING (atomic request semantics). Purely-numeric names are
 *    rejected here too (NUMERIC_SECTION_RE): they serialize ahead of the
 *    precedence contract (see orderSections), so no new ones may be created —
 *    existing numeric files remain readable, just no longer writable.
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
  const invalid = Object.keys(sections).filter((n) => !isValidSectionName(n) || NUMERIC_SECTION_RE.test(n));
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
export const IDENTITY_SIZE_WARN_BYTES = 16_384;
/** Backcompat alias for the pre-rename name (#264). */
export const CONTEXT_SIZE_WARN_BYTES = IDENTITY_SIZE_WARN_BYTES;

// ---------------------------------------------------------------------------
// Config — identityClients normalization
// ---------------------------------------------------------------------------

/** Harness names that may inject the identity layer. */
export const KNOWN_IDENTITY_CLIENTS = ["cc", "hermes", "oc", "pi", "opencode"] as const;
/** Backcompat alias for the pre-rename name (#264). */
export const KNOWN_CONTEXT_CLIENTS = KNOWN_IDENTITY_CLIENTS;

export interface ResolvedIdentityClients {
  /** The resolved, de-duped list of known client names. */
  clients: string[];
  /** Unknown names dropped from an array value (for a one-time boot warning). */
  dropped: string[];
}
/** Backcompat alias for the pre-rename name (#264). */
export type ResolvedContextClients = ResolvedIdentityClients;

/**
 * Normalize the raw `identityClients` config value (spec §2):
 *  - `"all"` (any case)      → ["cc","hermes","oc","pi","opencode"]
 *  - array                   → lowercase, keep known names (de-duped), collect dropped unknowns
 *  - missing / non-array-non-"all" → default ["cc"]
 * The resolved list is echoed by GET /identity as `clients` so each harness's
 * hook can self-gate without its own config.
 */
export function resolveIdentityClients(raw: unknown): ResolvedIdentityClients {
  if (typeof raw === "string" && raw.toLowerCase() === "all") {
    return { clients: [...KNOWN_IDENTITY_CLIENTS], dropped: [] };
  }
  if (Array.isArray(raw)) {
    const known = new Set<string>(KNOWN_IDENTITY_CLIENTS);
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
        for (const k of KNOWN_IDENTITY_CLIENTS) if (!clients.includes(k)) clients.push(k);
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

/**
 * Read the identity-clients config value from a raw config object, honouring
 * the new key (`identityClients`) and falling back to the legacy
 * `contextClients` (#264) with a one-time deprecation signal. Returns the
 * resolved clients, dropped unknowns, and whether the value came from the
 * legacy key.
 */
export function resolveIdentityClientsConfig(
  config: Record<string, unknown> | undefined | null,
): ResolvedIdentityClients & { legacy: boolean } {
  if (config && "identityClients" in config) {
    return { ...resolveIdentityClients(config.identityClients), legacy: false };
  }
  if (config && "contextClients" in config) {
    return { ...resolveIdentityClients(config.contextClients), legacy: true };
  }
  return { ...resolveIdentityClients(undefined), legacy: false };
}

/**
 * Read the identity-agents config value from a raw config object, honouring
 * the new key (`identityAgents`) and falling back to the legacy
 * `contextAgents` (#264) with a one-time deprecation signal.
 */
export function resolveIdentityAgentsConfig(
  config: Record<string, unknown> | undefined | null,
): { agents: Record<string, AgentMode>; dropped: string[]; legacy: boolean } {
  if (config && "identityAgents" in config) {
    return { ...resolveIdentityAgents(config.identityAgents), legacy: false };
  }
  if (config && "contextAgents" in config) {
    return { ...resolveIdentityAgents(config.contextAgents), legacy: true };
  }
  return { ...resolveIdentityAgents(undefined), legacy: false };
}

// ---------------------------------------------------------------------------
// Per-agent resolution (0.13)
// ---------------------------------------------------------------------------

/**
 * Classify the on-disk state of `identity/agents/<id>`, hardened against a
 * symlink planted at EITHER the `agents` ROOT or the `<id>` leaf — lstat/readdir
 * follow a symlinked intermediate path component, so checking only the leaf
 * would let a symlinked root escape the identity root entirely. BOTH must be
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
export function agentDirState(identityDir: string, agentId: string): "absent" | "real" | "unsafe" {
  const root = join(identityDir, AGENTS_DIR);
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
 *  2. else `identity/agents/<id>/` present as a REAL directory (root + leaf both
 *     real, non-symlink) → "override" (dropping in a dir is intent, no config);
 *  3. else → "global".
 * A symlinked/non-dir root or leaf never counts as "present" (agentDirState).
 */
export function resolveAgentMode(
  identityDir: string,
  agentId: string,
  identityAgents: Record<string, AgentMode>,
): AgentMode {
  const configured = identityAgents[agentId];
  if (configured) return configured;
  // Presence of EITHER the identity agent dir OR the legacy `context/agents/<id>/`
  // dir counts as intent to override (post-#264 both-dirs edge case: a partial
  // migration must not silently demote a legacy agent to "global" and lose its
  // per-agent sections).
  if (agentDirState(identityDir, agentId) === "real") return "override";
  const legacyDir = join(identityDir, "..", "context");
  if (agentDirState(legacyDir, agentId) === "real") return "override";
  return "global";
}

/**
 * Read one agent's sections from BOTH the identity agent dir and the legacy
 * `context/agents/<id>/` dir, additively merged (identity wins per-section;
 * legacy-only sections are included so nothing is lost in the both-dirs edge
 * case). A symlinked/non-dir leaf contributes nothing (agentDirState guard).
 */
function readAgentSectionsWithFallback(identityDir: string, agentId: string): ReadResult {
  const primaryDir = join(identityDir, AGENTS_DIR, agentId);
  const primary = agentDirState(identityDir, agentId) === "real" ? readSections(primaryDir) : { sections: {}, updatedAt: null, mtimes: {} } as ReadResult;
  const legacyDir = join(identityDir, "..", "context");
  const legacy = agentDirState(legacyDir, agentId) === "real" ? readSections(join(legacyDir, AGENTS_DIR, agentId)) : { sections: {}, updatedAt: null, mtimes: {} } as ReadResult;
  if (Object.keys(legacy.sections).length === 0) return primary;
  if (Object.keys(primary.sections).length === 0) return legacy;
  return mergeSections(primary, legacy);
}

/**
 * Enumerate the agents the UI selector should offer: the union of allowlisted
 * REAL directories under `identity/agents/` and every configured `identityAgents`
 * key, each mapped to its resolved mode (config wins over presence). A missing
 * agents dir (fresh install) yields the config keys only; a symlinked/non-dir
 * agents root is treated as "no dirs" (config keys only).
 */
export function listAgents(
  identityDir: string,
  identityAgents: Record<string, AgentMode>,
): Record<string, AgentMode> {
  const result: Record<string, AgentMode> = {};
  const agentsRoot = join(identityDir, AGENTS_DIR);

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
      if (agentDirState(identityDir, entry) === "real") {
        result[entry] = identityAgents[entry] ?? "override";
      }
    }
  }
  for (const id of Object.keys(identityAgents)) {
    if (!(id in result)) result[id] = identityAgents[id];
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
  identityDir: string,
  agentId: string | null,
  identityAgents: Record<string, AgentMode>,
): ResolvedRead {
  if (agentId === null) {
    const g = readSectionsWithFallback(identityDir);
    // #313: every served read carries the precedence contract — the bare
    // global set is ordered exactly like a resolved per-agent set.
    return { sections: orderSections(g.sections), updatedAt: g.updatedAt };
  }

  const mode = resolveAgentMode(identityDir, agentId, identityAgents);
  if (mode === "off") {
    return { sections: {}, updatedAt: null, agent: agentId, mode };
  }

  const global = readSectionsWithFallback(identityDir);
  if (mode === "global") {
    return { sections: orderSections(global.sections), updatedAt: global.updatedAt, agent: agentId, mode };
  }

  // override — read the agent dir (identity + legacy fallback merged so the
  // both-dirs edge case doesn't lose legacy-only agent sections).
  const agentRead = readAgentSectionsWithFallback(identityDir, agentId);

  // #313: build the merged map, then serve it in precedence order
  // (agent_identity → user → rules → rest alphabetical) — one ordering for
  // every read, so what the client renders is defined server-side.
  const merged: Record<string, string> = { ...global.sections, ...agentRead.sections };
  const sections = orderSections(merged);
  const origins: Record<string, "global" | "agent"> = {};
  let latestMtimeMs = 0;
  for (const name of Object.keys(merged)) {
    const fromAgent = name in agentRead.sections;
    origins[name] = fromAgent ? "agent" : "global";
    const mt = fromAgent ? agentRead.mtimes[name] : global.mtimes[name];
    if (mt && mt > latestMtimeMs) latestMtimeMs = mt;
  }
  const updatedAt = Object.keys(merged).length > 0 ? new Date(latestMtimeMs).toISOString() : null;
  return { sections, updatedAt, agent: agentId, mode, origins };
}

// ---------------------------------------------------------------------------
// HTTP-shape handlers (real logic behind GET/PUT /identity)
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
 * GET /identity. Stale-client tripwire first: recall moved to /recent, so
 * project/limit/privacy on this route mean a legacy recall caller — return a
 * loud 400 rather than silently degrading to an empty identity-layer response.
 * (A bare GET /identity with no params is the legitimate identity-layer read and
 * is served normally — the two are indistinguishable at the wire, so a
 * paramless legacy caller is covered by the migration docs, not this guard.)
 */
export function handleIdentityGet(
  identityDir: string,
  clients: string[],
  query: Record<string, unknown>,
  identityAgents: Record<string, AgentMode> = {},
): HandlerResult {
  if (RECALL_PARAMS.some((p) => p in query)) {
    return {
      status: 400,
      body: { error: "recall moved to /recent — GET /identity now serves the standing identity layer (0.12)" },
    };
  }

  const { agentId, error } = extractAgentParam(query);
  if (error) return { status: 400, body: { error } };

  // No agent → the plain global read plus the additive `agents` map the UI
  // selector needs (backward compatible: existing callers ignore unknown keys).
  if (agentId === null) {
    // #313: route through readResolvedSections so the bare read serves the
    // SAME precedence-ordered sections as a per-agent read (it also drops the
    // duplicated readSectionsWithFallback call this handler used to carry).
    const { sections, updatedAt } = readResolvedSections(identityDir, null, identityAgents);
    return {
      status: 200,
      body: { sections, updated_at: updatedAt, clients, agents: listAgents(identityDir, identityAgents) },
    };
  }

  const resolved = readResolvedSections(identityDir, agentId, identityAgents);
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
 * Compose the served GET /identity (and /context alias) body — the ONE
 * composition site (#313 CR3): take a handleIdentityGet HandlerResult, inject
 * the synthetic product-owned `memory` section (#192, when enabled and mode
 * ≠ off), then apply the SECTION_PRECEDENCE order (injectMemorySection
 * APPENDS the section last, so the order must be re-applied after it). Used
 * by both REST adapters and buildIdentityToolResult so the final wire key
 * order — including memory's alphabetical slot among "rest" — can never drift
 * between them. Non-200 results pass through untouched. Mutates and returns
 * the SAME HandlerResult (the body object is shared with the caller).
 */
export function serveIdentityBody(handlerResult: HandlerResult, memoryEnabled: boolean): HandlerResult {
  if (handlerResult.status !== 200) return handlerResult;
  const body = handlerResult.body as { sections?: Record<string, string>; mode?: string };
  injectMemorySection(body, memoryEnabled);
  if (body.sections) body.sections = orderSections(body.sections);
  return handlerResult;
}

/**
 * PUT /identity. Validates the body shape and section content types, then
 * delegates to writeSections (which owns the name allowlist + atomicity +
 * symlink safety). Throws are left to the adapter to turn into a 500.
 */
export function handleIdentityPut(
  identityDir: string,
  body: unknown,
  query: Record<string, unknown> = {},
  identityAgents: Record<string, AgentMode> = {},
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

  // CR3: numeric names get their OWN 400 message, not the generic
  // invalid-name one. The name passes every other check (it even GETs fine —
  // reads keep serving existing numeric files), so "invalid section name"
  // would read as a bug rather than policy. writeSections enforces the same
  // rejection for direct callers (defense in depth).
  const numeric = Object.keys(sections).filter((n) => NUMERIC_SECTION_RE.test(n));
  if (numeric.length > 0) {
    return {
      status: 400,
      body: {
        error:
          `Section name(s) ${numeric.map((n) => `'${n}'`).join(", ")}: purely-numeric names are read-only via the API ` +
          `(integer-index keys break the served section ordering); existing numeric files stay readable — write a renamed section instead`,
      },
    };
  }

  const targetDir = agentId === null ? identityDir : join(identityDir, AGENTS_DIR, agentId);

  if (agentId !== null) {
    // A1 write-path guard: never write through a symlinked/non-dir root or leaf
    // (agentDirState checks both). "absent" is fine — writeSections creates it.
    if (agentDirState(identityDir, agentId) === "unsafe") {
      return { status: 400, body: { error: "agent identity path exists but is not a directory" } };
    }
    // Black-hole guard: if config FORCES off/global for this agent, sections
    // written under agents/<id>/ could never be served (resolution ignores the
    // dir). Reject loudly rather than accept a write that silently vanishes.
    // No config entry → writing creates the dir ⇒ override ⇒ served (allowed).
    const configMode = identityAgents[agentId];
    if (configMode === "off" || configMode === "global") {
      return {
        status: 409,
        body: {
          error:
            `config identityAgents['${agentId}']='${configMode}' — sections written here would never be served; ` +
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

  const resolved = readResolvedSections(identityDir, agentId, identityAgents);
  const bytes = totalBytes(resolved.sections);
  const warn = bytes > IDENTITY_SIZE_WARN_BYTES
    ? `Identity layer total size ${bytes} bytes exceeds ${IDENTITY_SIZE_WARN_BYTES} — injected into every session; consider trimming.`
    : undefined;
  const respBody: Record<string, unknown> = { ok: true, updated_at: resolved.updatedAt };
  if (agentId !== null) {
    respBody.agent = resolved.agent;
    respBody.mode = resolved.mode;
  }
  return { status: 200, body: respBody, warn };
}
