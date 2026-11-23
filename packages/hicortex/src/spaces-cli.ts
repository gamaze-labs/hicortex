/**
 * spaces-cli — `hicortex space …` (#642 AC-13): the CLI consumer of the AC-10
 * admin API (GET /spaces, PUT /spaces/assign + /spaces/unassign). The
 * dashboard's space management card is the other consumer — one API, two
 * interfaces (the owner's ruling); this module speaks to the SAME endpoints
 * the page does.
 *
 *   hicortex space list                      every configured space (members,
 *                                            counts, llm posture) + the unassigned
 *                                            observed agents
 *   hicortex space assign <agent> <space>    add an agent to a space
 *   hicortex space unassign <agent> <space>  remove an agent (it drops to shared-only)
 *   hicortex space <name>                    the ONE-COMMAND form, run INSIDE a
 *                                            workspace: derives the local agent id
 *                                            (workspaceAgentId — the #600 sanitized
 *                                            basename grammar) and assigns it to <name>
 *
 * There is no `space create` / `space remove`: a space EXISTS BY CONFIG
 * PRESENCE (the `domains` precedent — config-owned vocabulary, never a
 * command). Add a spaces.<id> entry to config.json on the server, restart,
 * then assign. Unassign never deletes the entry (an empty members list is a
 * valid state).
 *
 * identity-cli.ts layout: pure URL/token resolution + formatters (unit-tested
 * without a server), authed fetch with a 5 s timeout, SpacesCliError for every
 * expected user-facing failure (cli.ts prints .message + exits 1), and a
 * describeSpacesFailure that distinguishes a down server from an HTTP error —
 * 404 names the "server predates spaces" case, 401 points at the config token
 * (`hicortex status`), unreachable points at the daemon. The server's own
 * 400/404 error text (e.g. the config-presence law) surfaces VERBATIM.
 */

import { workspaceAgentId } from "./learnings-identity.js";
import { loadConfig } from "./identity-cli.js";
import { basename } from "node:path";

const DEFAULT_PORT = 8787;
const REQUEST_TIMEOUT_MS = 5000;

/** Thrown for any expected, user-facing failure. cli.ts prints .message + exits 1. */
export class SpacesCliError extends Error {}

export interface SpacesServerTarget {
  baseUrl: string;
  authToken?: string;
}

/**
 * Resolve the server URL + token from a parsed config object. Pure + exported
 * so it is unit-testable without a live config. Mirrors identity-cli.ts
 * resolveIdentityTarget (client mode → serverUrl; server mode →
 * http://127.0.0.1:<port>; token from authToken) — the same rules every CLI
 * consumer of the daemon follows.
 */
export function resolveSpacesTarget(config: Record<string, unknown>): SpacesServerTarget {
  const baseUrl =
    config.mode === "client" && typeof config.serverUrl === "string"
      ? (config.serverUrl as string).replace(/\/+$/, "")
      : `http://127.0.0.1:${(config.port as number | undefined) ?? DEFAULT_PORT}`;
  const authToken = typeof config.authToken === "string" ? (config.authToken as string) : undefined;
  return { baseUrl, authToken };
}

/** The GET /spaces response (handleSpacesGet's body, AC-10). */
export interface SpacesListResponse {
  spaces: Array<{
    id: string;
    members: string[];
    paths: string[];
    memoryCount: number;
    queuedCount: number;
    llmConfigured: boolean;
  }>;
  unassigned: string[];
}

function authHeaders(token?: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Human-readable failure. status === null ⇒ the fetch itself threw (server
 * unreachable — actionable: config, status, daemon). 404 = the server
 * predates the /spaces API; 401 = token trouble. Mirrors identity-cli
 * describeFailure's discipline.
 */
function describeSpacesFailure(status: number | null, bodyError?: string): string {
  const suffix = bodyError ? `: ${bodyError}` : "";
  if (status === null) {
    return (
      "server unreachable (connection refused or timed out) — check the config " +
      "(hicortex status shows the server URL), is the daemon running?" + suffix
    );
  }
  if (status === 404) {
    return `HTTP 404 — /spaces not found; the server predates spaces (needs the #642 release)${suffix}`;
  }
  if (status === 401) {
    return `HTTP 401 — unauthorized; check authToken in the config (hicortex status shows the current token)${suffix}`;
  }
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

/** GET /spaces. Throws SpacesCliError with a clear message on any failure. */
export async function getSpaces(target: SpacesServerTarget): Promise<SpacesListResponse> {
  let resp: Response;
  try {
    resp = await fetch(`${target.baseUrl}/spaces`, {
      headers: authHeaders(target.authToken),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new SpacesCliError(`GET /spaces failed — ${describeSpacesFailure(null)}`);
  }
  if (!resp.ok) {
    throw new SpacesCliError(`GET /spaces failed — ${describeSpacesFailure(resp.status, await readBodyError(resp))}`);
  }
  const data = (await resp.json()) as SpacesListResponse;
  if (!data || typeof data !== "object" || !Array.isArray(data.spaces)) {
    throw new SpacesCliError("GET /spaces returned an unexpected body (no spaces array) — server version mismatch?");
  }
  return data;
}

/**
 * PUT /spaces/assign or /spaces/unassign. Returns the parsed body
 * ({ok:true} or {ok:true, idempotent:true}); throws SpacesCliError carrying
 * the SERVER's error text verbatim (the 404 config-presence law, the 400
 * validation rules) so the operator reads exactly what the server rejected.
 */
export async function putSpacesMutation(
  target: SpacesServerTarget,
  verb: "assign" | "unassign",
  agent: string,
  space: string,
): Promise<{ ok: boolean; idempotent?: boolean }> {
  let resp: Response;
  try {
    resp = await fetch(`${target.baseUrl}/spaces/${verb}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...authHeaders(target.authToken) },
      body: JSON.stringify({ agent, space }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new SpacesCliError(`PUT /spaces/${verb} failed — ${describeSpacesFailure(null)}`);
  }
  if (!resp.ok) {
    throw new SpacesCliError(
      `PUT /spaces/${verb} failed — ${describeSpacesFailure(resp.status, await readBodyError(resp))}`,
    );
  }
  return (await resp.json().catch(() => ({}))) as { ok: boolean; idempotent?: boolean };
}

// ---------------------------------------------------------------------------
// Pure formatters (tested directly; no I/O)
// ---------------------------------------------------------------------------

/** Render GET /spaces for the terminal: one block per space + the unassigned
 *  list. Pure — the exact bytes `space list` prints. */
export function formatSpacesList(body: SpacesListResponse): string {
  const parts: string[] = [];
  if (body.spaces.length === 0) {
    parts.push(
      "no spaces configured — a space exists by config presence: add a spaces.<id> entry",
      "(members, paths, optional llm) to config.json on the server, restart, then assign",
    );
  } else {
    parts.push(`spaces (${body.spaces.length}):`);
    for (const s of body.spaces) {
      const members = s.members.length > 0 ? s.members.join(", ") : "no members";
      const counts = `${s.memoryCount} memor${s.memoryCount === 1 ? "y" : "ies"}` +
        (s.queuedCount > 0 ? `, ${s.queuedCount} queued` : "");
      const llm = s.llmConfigured ? "llm ready" : "llm NOT configured (work holds — never the main model)";
      parts.push(`  ${s.id} — ${s.members.length} member(s): ${members} · ${counts} · ${llm}`);
      if (s.paths.length > 0) parts.push(`    paths: ${s.paths.join(", ")}`);
    }
  }
  if (body.unassigned.length > 0) {
    parts.push(`unassigned observed agents (${body.unassigned.length}): ${body.unassigned.join(", ")}`);
  } else {
    parts.push("unassigned observed agents: none (a workspace appears here within seconds of its first prompt)");
  }
  return parts.join("\n");
}

/** `hicortex space` with no subcommand: the usage block listing all four
 *  forms + the config-presence law. Pure — printed verbatim. */
export const SPACES_USAGE = `Usage: hicortex space <list | assign <agent> <space> | unassign <agent> <space> | <space>>

  space list                       every configured space (members, counts) + the unassigned agents
  space assign <agent> <space>     add an agent to a space (writes the server's config, applies live)
  space unassign <agent> <space>   remove an agent from a space (it drops to shared-only)
  space <name>                     run INSIDE a workspace: assigns THIS workspace — its folder name,
                                   the #600 sanitized-basename agent grammar — to space <name>

There is no space create/remove: a space EXISTS BY CONFIG PRESENCE (the domains
precedent) — add a spaces.<id> entry (members, paths, optional llm) to
config.json on the server and restart, then assign. 'list', 'assign' and
'unassign' are reserved words — a space named so is only addressable via
'hicortex space assign <agent> <space>'.`;

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export interface SpacesCliOptions {
  /** The working directory for the one-command form's agent derivation.
   *  Default process.cwd() (the test seam, mirroring buildHookRequest). */
  cwd?: string;
  /** Config override (tests). Defaults to loadConfig() (~/.hicortex/config.json). */
  config?: Record<string, unknown> | null;
}

/** `hicortex space assign <agent> <space>` — prints the outcome incl. the
 *  idempotent no-op case. Throws SpacesCliError on any failure. */
async function runAssign(target: SpacesServerTarget, agent: string, space: string): Promise<void> {
  const body = await putSpacesMutation(target, "assign", agent, space);
  process.stdout.write(
    body.idempotent
      ? `'${agent}' is already a member of '${space}' — nothing to do.\n`
      : `Assigned '${agent}' to space '${space}' — applies live (the agent sees the space from its next read).\n`,
  );
}

/** `hicortex space unassign <agent> <space>` — same shape as runAssign. */
async function runUnassign(target: SpacesServerTarget, agent: string, space: string): Promise<void> {
  const body = await putSpacesMutation(target, "unassign", agent, space);
  process.stdout.write(
    body.idempotent
      ? `'${agent}' is not a member of '${space}' — nothing to do.\n`
      : `Removed '${agent}' from space '${space}' — it sees shared-only from its next read (already-captured memories stay stamped).\n`,
  );
}

/**
 * Dispatch for `hicortex space <sub>` (cli.ts's `space` case). argv[3] ∈
 * {list, assign, unassign} routes to those; ANY OTHER VALUE is a SPACE NAME —
 * the one-command form (argv[3] required: bare `space` is usage help). Throws
 * SpacesCliError on bad usage/failure; cli.ts prints .message + exits 1.
 */
export async function runSpacesCommand(args: string[], opts: SpacesCliOptions = {}): Promise<void> {
  const sub = args[0];
  if (sub === undefined || sub === "") throw new SpacesCliError(SPACES_USAGE);

  // opts.config null/undefined both mean "read the real config" — the
  // identity-cli loadConfig seam.
  const target = resolveSpacesTarget(opts.config ?? loadConfig());

  if (sub === "list") {
    const body = await getSpaces(target);
    process.stdout.write(formatSpacesList(body) + "\n");
    return;
  }
  if (sub === "assign" || sub === "unassign") {
    const agent = args[1];
    const space = args[2];
    if (!agent || !space) {
      throw new SpacesCliError(`Usage: hicortex space ${sub} <agent> <space>`);
    }
    if (sub === "assign") await runAssign(target, agent, space);
    else await runUnassign(target, agent, space);
    return;
  }

  // The ONE-COMMAND form: argv[3] is a space name, run from the workspace to
  // assign. The local agent id is the #600 sanitized basename grammar — the
  // same id the workspace's reads carry as ?agent=.
  const name = sub;
  const cwd = opts.cwd ?? process.cwd();
  const agent = workspaceAgentId(cwd);
  if (!agent) {
    throw new SpacesCliError(
      `This folder's name cannot be an agent id: '${basename(cwd)}' sanitizes to nothing ` +
        `(ids are lowercase alphanumerics with - or _ separators — the #600 workspace grammar). ` +
        `Run from the workspace folder, or assign explicitly: hicortex space assign <agent> ${name}`,
    );
  }
  const body = await putSpacesMutation(target, "assign", agent, name);
  process.stdout.write(
    body.idempotent
      ? `'${agent}' (this workspace) is already a member of '${name}' — nothing to do.\n`
      : `Assigned '${agent}' (this workspace) to space '${name}' — this workspace sees the space from its next read.\n`,
  );
}
