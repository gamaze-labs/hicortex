/**
 * identity-cli — `hicortex identity show|edit`, the secondary/headless edit
 * surface for the standing identity layer (spec 2026-07-12 §6; renamed 0.18
 * #264 from `context`). The Web UI (`/identity/ui`) is primary; this exists
 * for boxes without a browser.
 *
 *   hicortex identity show [name]   GET /identity → print all sections, or one
 *   hicortex identity edit <name>   GET section → $EDITOR → PUT if changed
 *
 * The legacy `hicortex context ...` command remains as a hidden alias so old
 * scripts and muscle memory keep working (#264 backcompat).
 *
 * URL/token resolution mirrors learnings-identity.ts:44-49 (client mode →
 * config.serverUrl; server mode → http://127.0.0.1:<port>; token from
 * config.authToken) — explicitly NOT the hardcoded 127.0.0.1:8787 of
 * status.ts. Fails soft with a clear message + non-zero exit on any server
 * error, distinguishing a down server from an HTTP error (esp. 404 = server
 * too old / wrong endpoint), like the OC plugin's describeGetFailure.
 *
 * The CLI targets the new `/identity` endpoint. A 0.18+ server (this package)
 * also keeps `/context` as an alias, so a new CLI against a not-yet-upgraded
 * server falls back through that alias via describeFailure's 404 hint.
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { isValidSectionName, isValidAgentId, SECTION_NAME_MAX } from "./identity-store.js";
import { hicortexHome } from "./paths.js";

const DEFAULT_PORT = 8787;
const REQUEST_TIMEOUT_MS = 5000;

/** Thrown for any expected, user-facing failure. cli.ts prints .message + exits 1. */
export class IdentityCliError extends Error {}

/** Backcompat alias (#264). */
export const ContextCliError = IdentityCliError;

export interface IdentityServerTarget {
  baseUrl: string;
  authToken?: string;
}

/**
 * Resolve the server URL + token from a parsed config object. Pure + exported
 * so it is unit-testable without a live config. Follows learnings-identity.ts.
 */
export function resolveIdentityTarget(config: Record<string, unknown>): IdentityServerTarget {
  const baseUrl =
    config.mode === "client" && typeof config.serverUrl === "string"
      ? (config.serverUrl as string).replace(/\/+$/, "")
      : `http://127.0.0.1:${(config.port as number | undefined) ?? DEFAULT_PORT}`;
  const authToken = typeof config.authToken === "string" ? (config.authToken as string) : undefined;
  return { baseUrl, authToken };
}

/** Backcompat alias (#264). */
export const resolveContextTarget = resolveIdentityTarget;
/** Backcompat alias (#264). */
export type ContextServerTarget = IdentityServerTarget;

/** Read ~/.hicortex/config.json (or $HICORTEX_HOME/config.json). Missing → {}. */
export function loadConfig(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(join(hicortexHome(), "config.json"), "utf-8"));
  } catch {
    return {};
  }
}

/** The Save decision: PUT only when the edited content differs. Pure + tested. */
export function sectionChanged(before: string, after: string): boolean {
  return before !== after;
}

export interface IdentityGetResponse {
  sections: Record<string, string>;
  updated_at: string | null;
  clients: string[];
  /** Present only for an agent-scoped read (0.13). */
  agent?: string;
  mode?: string;
}

/** Backcompat alias (#264). */
export type ContextGetResponse = IdentityGetResponse;

/** Append `?agent=<id>` to a /identity URL when an agent scope is targeted. */
function identityUrl(baseUrl: string, agent?: string): string {
  return `${baseUrl}/identity${agent ? `?agent=${encodeURIComponent(agent)}` : ""}`;
}

function authHeaders(token?: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Human-readable failure. status === null ⇒ the fetch itself threw (server
 * unreachable). 404 is called out because it means the server predates the
 * /identity rename (it may still serve the legacy /context alias), not a
 * network fault — mirrors index.ts describeGetFailure.
 */
function describeFailure(status: number | null, bodyError?: string): string {
  const suffix = bodyError ? `: ${bodyError}` : "";
  if (status === null) return "server unreachable (connection refused or timed out)";
  if (status === 404) return `HTTP 404 — /identity not found; the server is likely too old (needs 0.18+; pre-0.18 serves /context)${suffix}`;
  if (status === 401) return `HTTP 401 — unauthorized; check authToken in config${suffix}`;
  return `server returned HTTP ${status}${suffix}`;
}

async function readBodyError(resp: Response): Promise<string | undefined> {
  try {
    const j = (await resp.json()) as { error?: unknown };
    return typeof j?.error === "string" ? j.error : undefined;
  } catch {
    return undefined;
  }
}

/** GET /identity. Throws IdentityCliError with a clear message on any failure. */
export async function getIdentity(target: IdentityServerTarget, agent?: string): Promise<IdentityGetResponse> {
  let resp: Response;
  try {
    resp = await fetch(identityUrl(target.baseUrl, agent), {
      headers: authHeaders(target.authToken),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new IdentityCliError(`GET /identity failed — ${describeFailure(null)}`);
  }
  if (!resp.ok) {
    throw new IdentityCliError(`GET /identity failed — ${describeFailure(resp.status, await readBodyError(resp))}`);
  }
  const data = (await resp.json()) as IdentityGetResponse;
  // Old-server echo guard: a pre-0.13 server ignores ?agent= and answers 200
  // with the GLOBAL set. Editing off that (then PUTting) would clobber shared
  // identity. Refuse unless the server echoes the agent it was asked for.
  if (agent && data.agent !== agent) {
    throw new IdentityCliError(
      `server did not echo agent '${agent}' — it likely predates per-agent identity (needs 0.13+)`,
    );
  }
  return data;
}

/** Backcompat alias (#264). */
export const getContext = getIdentity;

/** PUT one section. Throws IdentityCliError with a clear message on any failure. */
export async function putSection(target: IdentityServerTarget, name: string, content: string, agent?: string): Promise<void> {
  let resp: Response;
  try {
    resp = await fetch(identityUrl(target.baseUrl, agent), {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...authHeaders(target.authToken) },
      body: JSON.stringify({ sections: { [name]: content } }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new IdentityCliError(`PUT /identity failed — ${describeFailure(null)}`);
  }
  if (!resp.ok) {
    throw new IdentityCliError(`PUT /identity failed — ${describeFailure(resp.status, await readBodyError(resp))}`);
  }
  // Old-server echo guard on the WRITE too: a pre-0.13 server silently accepts
  // the PUT as a GLOBAL write and returns 200 without echoing `agent`. Treat a
  // missing echo as a failed agent write (the global section may have been
  // clobbered — surface it loudly rather than reporting a false success).
  if (agent) {
    const body = (await resp.json().catch(() => ({}))) as { agent?: string };
    if (body.agent !== agent) {
      throw new IdentityCliError(
        `PUT /identity?agent=${agent} — server did not echo the agent; it likely predates per-agent ` +
        `identity (needs 0.13+). It may have written to the GLOBAL scope — verify the server version.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Pure formatters (tested directly; no I/O)
// ---------------------------------------------------------------------------

/** Readable rendering of every section + the resolved clients line (show, no name). */
export function formatAllSections(data: IdentityGetResponse): string {
  const names = Object.keys(data.sections);
  const parts: string[] = [];
  if (names.length === 0) {
    parts.push("(no identity sections)");
  } else {
    for (const name of names) {
      const body = data.sections[name];
      parts.push(`## ${name}`, "", body.endsWith("\n") ? body.trimEnd() : body, "");
    }
  }
  parts.push(`clients: ${data.clients.join(", ") || "(none)"}`);
  if (data.agent) parts.push(`agent: ${data.agent}${data.mode ? ` (mode: ${data.mode})` : ""}`);
  return parts.join("\n");
}

/** Raw markdown for one section (show <name>), or null if it does not exist. */
export function formatOneSection(data: IdentityGetResponse, name: string): string | null {
  if (!(name in data.sections)) return null;
  return data.sections[name];
}

// ---------------------------------------------------------------------------
// Editor seam
// ---------------------------------------------------------------------------

/** Ordered editor candidates: $EDITOR → nano → vi (spec §6). */
function candidateEditors(): string[] {
  const list: string[] = [];
  const env = process.env.EDITOR?.trim();
  if (env) list.push(env);
  list.push("nano", "vi");
  return list;
}

/**
 * Default editor spawn: opens `file` in the first available editor, blocking
 * until it exits. Returns true if an editor ran, false if none was found.
 * Injectable so tests never actually spawn an editor.
 */
export type EditorSpawn = (file: string) => boolean;

const defaultSpawn: EditorSpawn = (file) => {
  for (const ed of candidateEditors()) {
    const [cmd, ...prefixArgs] = ed.split(/\s+/);
    const r = spawnSync(cmd, [...prefixArgs, file], { stdio: "inherit" });
    if (r.error) {
      if ((r.error as NodeJS.ErrnoException).code === "ENOENT") continue; // not installed → next
      return false; // spawned but failed for another reason
    }
    return true; // editor ran (any exit code — e.g. `:q` in vi)
  }
  return false;
};

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function runShow(name: string | undefined, agent?: string): Promise<void> {
  const data = await getIdentity(resolveIdentityTarget(loadConfig()), agent);
  if (name) {
    const body = formatOneSection(data, name);
    if (body === null) {
      const avail = Object.keys(data.sections).join(", ") || "(none)";
      process.stderr.write(`Section '${name}' not found. Available: ${avail}\n`);
      process.exit(1);
    }
    process.stdout.write(body.endsWith("\n") ? body : body + "\n");
    return;
  }
  process.stdout.write(formatAllSections(data) + "\n");
}

/**
 * `edit <name>`: validate name (fast-fail; the server enforces too) → fetch
 * current content → $EDITOR on a temp file → PUT only if changed. Temp file is
 * always cleaned up. `spawn` is injectable for tests.
 */
export async function runEdit(name: string, spawn: EditorSpawn = defaultSpawn, agent?: string): Promise<void> {
  if (!isValidSectionName(name)) {
    throw new IdentityCliError(
      `Invalid section name '${name}'. Must match ^[a-z0-9][a-z0-9_-]*$ (max ${SECTION_NAME_MAX} chars).`,
    );
  }
  const target = resolveIdentityTarget(loadConfig());
  const data = await getIdentity(target, agent);
  const before = data.sections[name] ?? "";

  const dir = mkdtempSync(join(tmpdir(), "hicortex-id-"));
  const file = join(dir, `${name}.md`);
  try {
    writeFileSync(file, before, "utf-8");
    const ran = spawn(file);
    if (!ran) {
      throw new IdentityCliError("No editor available. Set $EDITOR, or install nano or vi.");
    }
    const after = readFileSync(file, "utf-8");
    if (!sectionChanged(before, after)) {
      process.stdout.write("no changes\n");
      return;
    }
    await putSection(target, name, after, agent);
    // Saving to an agent scope creates/extends that agent's override.
    process.stdout.write(`Saved section '${name}'${agent ? ` for agent '${agent}' (override)` : ""}.\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Split out a `--agent <id>` flag (anywhere in argv) from the positional args.
 * The flag omitted → the global scope.
 */
export function extractAgentFlag(args: string[]): { agent?: string; rest: string[] } {
  const rest: string[] = [];
  let agent: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--agent") {
      const val = args[i + 1];
      // A missing value (end of args) or the next token being another flag is a
      // typo — never let it silently fall through to the global scope.
      if (val === undefined || val.startsWith("-")) {
        throw new IdentityCliError("--agent requires a value, e.g. --agent alice");
      }
      agent = val;
      i++;
      continue;
    }
    rest.push(args[i]);
  }
  return { agent, rest };
}

/** Dispatch for `hicortex identity <sub>` (and the hidden `context` alias).
 *  Throws IdentityCliError on bad usage/failure. */
export async function runIdentityCommand(args: string[]): Promise<void> {
  const { agent, rest } = extractAgentFlag(args);
  // Fast-fail on a bad agent id before any HTTP call (the server enforces too).
  if (agent !== undefined && !isValidAgentId(agent)) {
    throw new IdentityCliError(
      `Invalid agent id '${agent}'. Must match ^[a-z0-9][a-z0-9_-]*$ (max ${SECTION_NAME_MAX} chars).`,
    );
  }
  const sub = rest[0];
  switch (sub) {
    case "show":
      await runShow(rest[1], agent);
      return;
    case "edit":
      if (!rest[1]) throw new IdentityCliError("Usage: hicortex identity edit <name> [--agent <id>]");
      await runEdit(rest[1], undefined, agent);
      return;
    default:
      throw new IdentityCliError("Usage: hicortex identity <show [name] | edit <name>> [--agent <id>]");
  }
}

/** Backcompat alias (#264). */
export const runContextCommand = runIdentityCommand;
