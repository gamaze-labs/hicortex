/**
 * Pure handlers for the #642 AC-10 admin API: GET /spaces (spaces, members,
 * per-space counts, observed unassigned agents) and PUT /spaces/assign +
 * PUT /spaces/unassign (`{agent, space}`). The marker-key-api.ts layout:
 * validation + response shaping HERE, side-effect-free; the thin adapters in
 * mcp-server.ts own the I/O (fresh config read, persistConfigUpdates, the
 * LIVE re-resolution of the boot module vars, the SQL count assembly).
 *
 * The model rules these handlers enforce (the #642 rulings):
 *   - a space EXISTS BY CONFIG PRESENCE (the `domains` precedent — there is
 *     no create/remove API; assign to an unconfigured id is a 404 naming
 *     that law, never a silent create);
 *   - the shared pool ('standard'/NULL) is a FIXED concept, never listed and
 *     never assignable — it is not a space;
 *   - assignment is a NAME IN A LIST: the patch edits ONLY the target
 *     entry's `members` array. The raw `spaces` map returned as the patch
 *     preserves every OTHER entry by reference (persistConfigUpdates
 *     replaces just the `spaces` key, so unrelated config keys are untouched
 *     by construction);
 *   - the reserved 'confidential' space is assignable like any other — when
 *     it exists only MATERIALIZED (legacy confidentialAgents/confidentialPaths,
 *     no explicit spaces.confidential entry), the write SEEDS a raw entry
 *     from the resolved SpaceDef first: members + raw path strings ONLY, never
 *     llm/privacyLine (resolution re-derives both — llmConfidential*
 *     inheritance and the seeded confidential line must keep flowing). From
 *     that boot on the explicit entry wins entirely, which is exactly the
 *     migration path the boot conflict-warning names.
 *
 * Auth/scope: the adapters mount bearer-only (the standard auth middleware;
 * page-shell exemptions do not apply to data routes) and exist only on the
 * daemon — server mode only by construction. Writable by any token holder
 * is inherent to the single-token model (#642 accepted risk).
 */

import { resolveSpaces, type SpaceDef } from "./spaces.js";
import { sanitizeAgentId } from "./identity-store.js";

// ---------------------------------------------------------------------------
// GET /spaces
// ---------------------------------------------------------------------------

/** The counts the adapter folds out of SQL GROUP BY (spaceOf-normalized:
 *  NULL/''/'standard' count under 'standard'; the Record carries the raw
 *  space ids as its other keys). */
export interface SpacesGetDeps {
  /** The boot-resolved (or live-re-resolved) space list. */
  spaces: SpaceDef[];
  counts: {
    memory: Record<string, number>;
    queued: Record<string, number>;
  };
  /** listObservedAgents output — ALREADY ordered last_seen DESC (newest
   *  activity first); the unassigned computation keeps that order. */
  observed: Array<{ agent: string; first_seen: string; last_seen: string }>;
  /** Space ids with an EFFECTIVE model (explicit per-space llm or the
   *  inherited llmConfidential* endpoint — the adapter resolves this from the
   *  boot spaceClients map / the confidential fields, so llmConfigured means
   *  "this space's work runs", not "spaces.<id>.llm* is set"). */
  llmConfigured: ReadonlySet<string>;
}

/**
 * GET's shaping: every configured space with its members, RAW path pattern
 * strings, memory + queued counts, and whether its work has a model; plus
 * the UNASSIGNED observed agents (first-prompt discovery, AC-11) — ids that
 * appear in NO space's members, newest activity first. The shared pool is
 * deliberately not listed (fixed concept, never a space).
 */
export function handleSpacesGet(deps: SpacesGetDeps): {
  status: 200;
  body: {
    spaces: Array<{
      id: string;
      members: string[];
      paths: string[];
      memoryCount: number;
      queuedCount: number;
      llmConfigured: boolean;
    }>;
    unassigned: string[];
  };
} {
  const assignedTo = new Map<string, void>();
  const spaces = deps.spaces.map((s) => {
    for (const m of s.members) assignedTo.set(m);
    return {
      id: s.id,
      members: s.members,
      paths: s.paths.map((p) => p.raw),
      memoryCount: deps.counts.memory[s.id] ?? 0,
      queuedCount: deps.counts.queued[s.id] ?? 0,
      llmConfigured: deps.llmConfigured.has(s.id),
    };
  });
  // deps.observed is last_seen DESC already; filter keeps that order (the
  // operator sees the freshest unknown workspace first).
  const unassigned = deps.observed
    .filter((o) => !assignedTo.has(o.agent))
    .map((o) => o.agent);
  return { status: 200, body: { spaces, unassigned } };
}

// ---------------------------------------------------------------------------
// PUT /spaces/assign + /spaces/unassign
// ---------------------------------------------------------------------------

export interface SpacesMutationResult {
  status: number;
  body: Record<string, unknown>;
  /**
   * Present ONLY on a 200 that changed something: the NEW raw `spaces` map
   * for persistConfigUpdates (replaces ONLY the `spaces` key). Absent on the
   * idempotent no-ops — an already-member assign / not-a-member unassign
   * answers `{ok:true, idempotent:true}` and writes NOTHING.
   */
  patch?: { spaces: Record<string, unknown> };
  /** Present iff patch is: the applied pair, for the adapter's one log line. */
  applied?: { agent: string; space: string };
}

/**
 * Shared body validation, in order (each failure answers before any write):
 * 400 — not a JSON object, or `agent`/`space` not non-empty strings. The
 * agent is then SANITIZED into the one id namespace (sanitizeAgentId — the
 * same grammar as ?agent= and space ids); a value that sanitizes to nothing
 * is a 400 naming why, never a silent odd id.
 */
function parseAgentSpaceBody(
  body: unknown,
): { ok: true; agent: string; space: string } | { ok: false; result: SpacesMutationResult } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return {
      ok: false,
      result: {
        status: 400,
        body: { error: 'Body must be a JSON object: {"agent": "<agent id>", "space": "<space id>"}' },
      },
    };
  }
  const e = body as Record<string, unknown>;
  if (typeof e.agent !== "string" || !e.agent.trim()) {
    return { ok: false, result: { status: 400, body: { error: "'agent' must be a non-empty string" } } };
  }
  if (typeof e.space !== "string" || !e.space.trim()) {
    return { ok: false, result: { status: 400, body: { error: "'space' must be a non-empty string" } } };
  }
  const agent = sanitizeAgentId(e.agent);
  if (!agent) {
    return {
      ok: false,
      result: {
        status: 400,
        body: {
          error:
            `'agent' sanitizes to an empty id — ids are lowercase alphanumerics with ` +
            `- or _ separators (the ?agent= namespace); the value carries no id-shaped content`,
        },
      },
    };
  }
  return { ok: true, agent, space: e.space };
}

/** The raw `spaces` map as a SHALLOW copy — every non-target entry keeps its
 *  original object reference (its values are preserved verbatim through the
 *  persist round-trip); a missing/garbage `spaces` key starts from {} (it
 *  matched no space at resolution, so nothing is lost). */
function rawSpacesCopy(config: Record<string, unknown> | null): Record<string, unknown> {
  const raw = config?.spaces;
  if (raw !== null && raw !== undefined && typeof raw === "object" && !Array.isArray(raw)) {
    return { ...(raw as Record<string, unknown>) };
  }
  return {};
}

/**
 * The entry the patch edits: the existing raw entry when there is one, else a
 * SEED from the resolved SpaceDef (members + raw path strings only — never
 * llm/privacyLine: resolution re-derives both, and the seeded confidential
 * line + llmConfidential* inheritance must keep flowing after the write).
 * Reaches the materialized-legacy case (spaces.confidential absent while
 * confidentialAgents/Paths configured) and any raw entry the resolver had to
 * drop for shape (its drop was named at boot).
 */
function editableEntry(
  spaces: Record<string, unknown>,
  spaceId: string,
  def: SpaceDef,
): Record<string, unknown> {
  const existing = spaces[spaceId];
  if (existing !== null && existing !== undefined && typeof existing === "object" && !Array.isArray(existing)) {
    return { ...(existing as Record<string, unknown>) };
  }
  return { members: [...def.members], paths: def.paths.map((p) => p.raw) };
}

/** PUT /spaces/assign — see the module header for the rules. */
export function handleSpacesAssign(
  body: unknown,
  config: Record<string, unknown> | null,
): SpacesMutationResult {
  const parsed = parseAgentSpaceBody(body);
  if (!parsed.ok) return parsed.result;
  const { agent, space } = parsed;

  const resolved = resolveSpaces(config);
  const def = resolved.byId.get(space);
  if (!def) {
    return {
      status: 404,
      body: {
        error:
          `No such space '${space}' — spaces exist by config presence. Add a ` +
          `spaces.${space} entry (members, paths, optional llm) to config.json and restart, then assign.`,
      },
    };
  }
  if (def.members.includes(agent)) {
    return { status: 200, body: { ok: true, idempotent: true } };
  }
  const spaces = rawSpacesCopy(config);
  const entry = editableEntry(spaces, space, def);
  const members = Array.isArray(entry.members) ? [...entry.members] : [];
  if (!members.includes(agent)) members.push(agent);
  spaces[space] = { ...entry, members };
  return { status: 200, body: { ok: true }, patch: { spaces }, applied: { agent, space } };
}

/** PUT /spaces/unassign — same validation; removing the agent from the raw
 *  entry's members (every raw value that sanitizes to it — the roster
 *  namespace is sanitized by construction, this also cleans a hand-edited
 *  entry). The entry itself STAYS, possibly with an empty members list: a
 *  space exists by config presence, an empty roster is fine. */
export function handleSpacesUnassign(
  body: unknown,
  config: Record<string, unknown> | null,
): SpacesMutationResult {
  const parsed = parseAgentSpaceBody(body);
  if (!parsed.ok) return parsed.result;
  const { agent, space } = parsed;

  const resolved = resolveSpaces(config);
  const def = resolved.byId.get(space);
  if (!def) {
    return {
      status: 404,
      body: {
        error:
          `No such space '${space}' — spaces exist by config presence. Add a ` +
          `spaces.${space} entry (members, paths, optional llm) to config.json and restart, then assign.`,
      },
    };
  }
  if (!def.members.includes(agent)) {
    return { status: 200, body: { ok: true, idempotent: true } };
  }
  const spaces = rawSpacesCopy(config);
  const entry = editableEntry(spaces, space, def);
  const rawMembers = Array.isArray(entry.members) ? entry.members : [];
  const members = rawMembers.filter(
    (m) => !(typeof m === "string" && sanitizeAgentId(m) === agent),
  );
  spaces[space] = { ...entry, members };
  return { status: 200, body: { ok: true }, patch: { spaces }, applied: { agent, space } };
}
