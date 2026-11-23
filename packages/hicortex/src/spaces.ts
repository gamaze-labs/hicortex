/**
 * Spaces (#642) — the confidential circle (#332) generalized to N private
 * pools, on the groups model (owner ruling 2026-11-22): a workspace (agent)
 * joins zero or more spaces; a memory ROW belongs to exactly ONE space,
 * carried by the widened `memories.privacy` vocabulary
 * ('standard' | <configured space id> — see MemoryPrivacy in types.ts; no
 * migration, values are data).
 *
 * The model in one paragraph: an operator configures a `spaces` map (space id
 * → { members, paths, optional per-space llm, optional privacyLine }). Space
 * ids run through the SAME allowlist as agent ids (isValidAgentId — one
 * namespace, the identityAgents precedent). The legacy confidential keys
 * (`confidentialAgents` + `confidentialPaths`) MATERIALIZE a pre-configured
 * space named `confidential` when no explicit `spaces.confidential` entry
 * exists — an existing confidential-only install is the N=1 case of the same
 * machinery, byte-for-byte. 'standard' (and NULL) is the FIXED shared pool —
 * never a space id, never configurable. The marker key (#614) stays
 * confidential-only (owner ruling: no keys in the MVP; the reserved
 * 'confidential' id is always known so the marker arm can stamp it even on
 * installs where no confidential space materialized). Assignment = a name in
 * a list; the shared bearer token is the trust boundary (self-asserted names
 * accepted for MVP, #631 accepted risk; keys are v2).
 *
 * This module is the pure resolution core (no HTTP, no fs — the
 * identity-store.ts / marker-key-api.ts layout; the ONE db-taking function
 * is unknownStoredSpaceIds, the AC-7 boot-report helper, which takes a handle
 * like the storage fns): resolveSpaces parses config ONCE at the boot seam in
 * mcp-server.ts (restart to apply, like the confidential roster), and the
 * small predicates below are the shared vocabulary every later stage (read
 * gates, consolidation, dashboard, CLI) consumes. Intake precedence lives in
 * classification.ts deriveIntakeSpace (#642 AC-4: per-space paths first,
 * then member lists, then the confidential marker arm — the more specific
 * birthplace wins).
 *
 * Zero-change default (AC-1): an install that configures nothing resolves to
 * an empty result with NO warnings — stamps, gates, prompts, and boot output
 * are byte-identical to the #332 release.
 */

import type Database from "better-sqlite3";
import { isValidAgentId, sanitizeAgentId } from "./identity-store.js";
import {
  resolveConfidentialAgents,
  resolveConfidentialPaths,
  resolveConfidentialLlmConfig,
  compilePathPattern,
  type ConfidentialPathPattern,
} from "./classification.js";
import {
  REFLECTION_PRIVACY_LINE_CONFIDENTIAL,
  REFLECTION_PRIVACY_LINE_SPACE,
} from "./prompts.js";

// ---------------------------------------------------------------------------
// The resolved shape
// ---------------------------------------------------------------------------

/**
 * One RESOLVED space — everything the intake stamp, the read gate, and the
 * consolidation split need. `privacyLine` is always CONCRETE by the time a
 * SpaceDef exists (explicit config wins; the `confidential` space seeds the
 * SHIPPED confidential line byte-identically so its prompts never change;
 * every other space defaults to REFLECTION_PRIVACY_LINE_SPACE) — prompt
 * building never branches on `id === "confidential"`.
 */
export interface SpaceDef {
  /** The config key, validated by isValidAgentId (never 'standard'). */
  id: string;
  /** Sanitized agent ids (the ?agent= / roster namespace), deduped. */
  members: string[];
  /** Compiled path patterns (the compilePathPattern forms), deduped on raw. */
  paths: ConfidentialPathPattern[];
  /**
   * Per-space LLM endpoint (llmBaseUrl + llmApiKey required as a pair, the
   * resolveConfidentialLlmConfig contract; llmModel/llmProvider optional).
   * null = not configured — the space inherits the `llmConfidential*`
   * endpoint at consolidation and HOLDS without one (never the main model).
   */
  llm: { baseUrl: string; apiKey: string; model?: string; provider?: string } | null;
  /** The reflection privacy line for this pool (always concrete — see above). */
  privacyLine: string;
}

// ---------------------------------------------------------------------------
// Boot resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the `spaces` config map (plus the legacy confidential
 * materialization, AC-2) into the ordered SpaceDef list. Pure — parse once at
 * boot (mcp-server.ts, the confidential seam); restart to apply.
 *
 * Entry fields (all optional): `members?: string[]` (sanitized like ?agent=,
 * invalid entries dropped and named, deduped), `paths?: string[]` (compiled
 * with compilePathPattern, dropped entries named, deduped on raw),
 * `llmBaseUrl`/`llmApiKey`/`llmModel`/`llmProvider?: string` (baseUrl+apiKey
 * required as a PAIR — a half-pair drops the llm field with a warning while
 * the space survives), `privacyLine?: string` (trimmed non-empty, else the
 * field drops with a warning and the pool default applies).
 *
 * Drop/warning discipline (the resolveIdentityAgents pattern): an invalid id
 * key or a non-object entry drops the WHOLE space, named in `dropped`; a
 * wrong-typed or half-configured FIELD drops just the field, named in
 * `warnings` — a typo must surface at boot, never silently match nothing.
 * `dropped` also carries invalid member entries and non-compiling path
 * patterns by raw value. The legacy resolvers' own dropped arrays are NOT
 * re-reported here — mcp-server.ts already prints them at its confidential
 * seam (one boot warning per problem, never two).
 *
 * `spaces` preserves CONFIG KEY ORDER — deriveIntakeSpace's
 * first-matching-space precedence depends on it. The legacy-materialized
 * `confidential` space appends LAST (explicit spaces outrank it in the
 * paths/members arms; on a pure-legacy install there is nothing to outrank).
 *
 * 'standard' is a RESERVED non-id (the fixed shared pool): an explicit entry
 * under it drops with the rule named. 'confidential' IS a valid space id —
 * an explicit entry wins entirely over the legacy keys, with ONE conflict
 * warning ("explicit wins; legacy ignored"); an explicit-but-DROPPED entry
 * (broken shape) falls back to legacy materialization so a typo can never
 * silently disable the circle (the drop is already named in `dropped`).
 *
 * Zero-config (no `spaces` key, no active legacy keys): empty everything —
 * the AC-1 byte-identical boot.
 */
export function resolveSpaces(
  config: Record<string, unknown> | null | undefined,
): { spaces: SpaceDef[]; byId: Map<string, SpaceDef>; dropped: string[]; warnings: string[] } {
  const spaces: SpaceDef[] = [];
  const byId = new Map<string, SpaceDef>();
  const dropped: string[] = [];
  const warnings: string[] = [];

  const rawMap = config?.spaces;
  const hasMap =
    rawMap !== null && rawMap !== undefined && typeof rawMap === "object" && !Array.isArray(rawMap);
  if (config?.spaces !== undefined && !hasMap) {
    warnings.push(
      "config `spaces` must be a map of space id → entry object — ignoring the value",
    );
  }

  if (hasMap) {
    for (const [key, entry] of Object.entries(rawMap as Record<string, unknown>)) {
      // One id namespace with agent ids (isValidAgentId); 'standard' is the
      // fixed shared pool, never a space id.
      if (!isValidAgentId(key)) {
        dropped.push(key);
        continue;
      }
      if (key === "standard") {
        dropped.push(key);
        warnings.push(
          "'standard' is the fixed shared pool, never a space id — drop the spaces.standard entry",
        );
        continue;
      }
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        dropped.push(key);
        continue;
      }
      const e = entry as Record<string, unknown>;

      // members — sanitize each entry like ?agent=; invalid entries are
      // dropped and named by raw value; duplicates collapse.
      const members: string[] = [];
      if (e.members !== undefined) {
        if (Array.isArray(e.members)) {
          for (const m of e.members) {
            if (typeof m !== "string") {
              dropped.push(String(m));
              continue;
            }
            const id = sanitizeAgentId(m);
            if (id && !members.includes(id)) members.push(id);
            else if (!id) dropped.push(m);
          }
        } else {
          warnings.push(
            `spaces.${key}: members must be an array of agent ids — ignoring the field`,
          );
        }
      }

      // paths — the SAME three pattern forms as confidentialPaths
      // (compilePathPattern), deduped on the raw entry.
      const paths: ConfidentialPathPattern[] = [];
      if (e.paths !== undefined) {
        if (Array.isArray(e.paths)) {
          for (const p of e.paths) {
            if (typeof p !== "string") {
              dropped.push(String(p));
              continue;
            }
            const compiled = compilePathPattern(p);
            if (!compiled) dropped.push(p);
            else if (!paths.some((x) => x.raw === compiled.raw)) paths.push(compiled);
          }
        } else {
          warnings.push(
            `spaces.${key}: paths must be an array of path patterns — ignoring the field`,
          );
        }
      }

      // llm — baseUrl+apiKey required as a pair (the
      // resolveConfidentialLlmConfig contract): only one set drops the llm
      // FIELD with a warning; the space survives without it (it inherits the
      // confidential endpoint at consolidation, or holds).
      const str = (v: unknown): string | undefined =>
        typeof v === "string" && v ? v : undefined;
      const baseUrl = str(e.llmBaseUrl);
      const apiKey = str(e.llmApiKey);
      let llm: SpaceDef["llm"] = null;
      if (baseUrl && apiKey) {
        llm = { baseUrl, apiKey, model: str(e.llmModel), provider: str(e.llmProvider) };
      } else if (baseUrl || apiKey) {
        warnings.push(
          `spaces.${key}: llmBaseUrl + llmApiKey are required as a pair — the space's llm config is ignored (it inherits the llmConfidential* endpoint, or holds)`,
        );
      }

      // privacyLine — explicit trimmed non-empty wins; a blank/non-string
      // field drops with a warning and the pool default applies below.
      let privacyLine: string | undefined;
      if (e.privacyLine !== undefined) {
        if (typeof e.privacyLine === "string" && e.privacyLine.trim()) {
          privacyLine = e.privacyLine.trim();
        } else {
          warnings.push(
            `spaces.${key}: privacyLine must be a non-blank string — ignoring the field (the pool default applies)`,
          );
        }
      }

      const def: SpaceDef = {
        id: key,
        members,
        paths,
        llm,
        // The confidential seeding lives HERE in resolution — never as an
        // `if (id === 'confidential')` in prompt-building code (#602: the
        // confidential pool's prompt stays byte-identical).
        privacyLine:
          privacyLine ??
          (key === "confidential"
            ? REFLECTION_PRIVACY_LINE_CONFIDENTIAL
            : REFLECTION_PRIVACY_LINE_SPACE),
      };
      spaces.push(def);
      byId.set(key, def);
    }
  }

  // LEGACY MATERIALIZATION (AC-2): no RESOLVED explicit confidential space →
  // the legacy keys seed one when they are ACTIVE (a roster or patterns —
  // the marker key alone does not materialize; it is a birthplace ARM, not a
  // space definition). An explicit-but-dropped entry also lands here (a
  // broken spaces.confidential must not silently disable the circle — the
  // drop is already named above).
  if (!byId.has("confidential")) {
    const roster = resolveConfidentialAgents(config).roster;
    const patterns = resolveConfidentialPaths(config).patterns;
    if (roster.length > 0 || patterns.length > 0) {
      const llmConfig = resolveConfidentialLlmConfig(config);
      const def: SpaceDef = {
        id: "confidential",
        members: roster,
        paths: patterns,
        llm: llmConfig
          ? {
              baseUrl: llmConfig.baseUrl,
              apiKey: llmConfig.apiKey,
              model: llmConfig.model,
              provider: llmConfig.provider,
            }
          : null,
        privacyLine: REFLECTION_PRIVACY_LINE_CONFIDENTIAL,
      };
      spaces.push(def);
      byId.set("confidential", def);
    }
  } else if (
    resolveConfidentialAgents(config).roster.length > 0 ||
    resolveConfidentialPaths(config).patterns.length > 0
  ) {
    // Both an explicit spaces.confidential AND active legacy keys: ONE
    // warning, the explicit entry wins ENTIRELY (no merge — members, paths,
    // and llm come from the entry alone).
    warnings.push(
      "explicit spaces.confidential wins; legacy confidentialAgents/confidentialPaths ignored for it — " +
        "move the circle's members/paths into spaces.confidential and delete the legacy keys",
    );
  }

  return { spaces, byId, dropped, warnings };
}

// ---------------------------------------------------------------------------
// Predicates — the shared vocabulary of the later #642 stages
// ---------------------------------------------------------------------------

/**
 * Every id a delivery may legally stamp: the CONFIGURED ids plus the reserved
 * 'confidential' ALWAYS — the marker arm stamps 'confidential' even on
 * marker-key-only installs where no confidential space materialized, so the
 * write boundary's known set must include it unconditionally. Callers:
 * normalizeStoredPrivacy's known argument at the enqueue site (AC-7) and the
 * read gate's visible-set resolution.
 */
export function knownSpaceIds(res: { byId: Map<string, SpaceDef> }): Set<string> {
  const ids = new Set(res.byId.keys());
  ids.add("confidential");
  return ids;
}

/**
 * The `privacy`/`spaceOf` column normalizer every predicate will use:
 * NULL/undefined/''/'standard' → 'standard' (the fixed shared pool — NULL-safe
 * predicates everywhere already treat pre-v27 NULLs as shared); anything else
 * passes through as-is (lowercase-trust: the column is server-written, and
 * server-written space ids are validated ids by construction). This is a READ
 * predicate, not a write gate — writes go through normalizeStoredPrivacy,
 * which REFUSES unknown ids (#642 AC-7).
 */
export function spaceOf(privacy: string | null | undefined): string {
  if (privacy === null || privacy === undefined || privacy === "" || privacy === "standard") {
    return "standard";
  }
  return privacy;
}

/**
 * The read-side membership resolution: the ids of every space whose members
 * list contains the sanitized `agent`. Null/blank/unknown agent → EMPTY set
 * (fail-closed — an unknown id can never widen visibility, exactly like
 * isCircleMember). Note the read side matches BARE ids only: sanitizeAgentId
 * collapses separators, so a harness-qualified `hermes/nova` reads as
 * `hermes-nova` and matches nothing (plugins send their resolved profile
 * name, not their capture-side qualified stamp).
 */
export function spacesForMember(
  agent: string | null | undefined,
  spaces: SpaceDef[],
): Set<string> {
  const id = agent ? sanitizeAgentId(agent) : null;
  if (!id) return new Set();
  const out = new Set<string>();
  for (const s of spaces) {
    if (s.members.includes(id)) out.add(s.id);
  }
  return out;
}

/**
 * Compose ONE visible-space set from the two option forms every read gate
 * accepts (#642 AC-5): the legacy boolean (`includeConfidential` — TRUE adds
 * the reserved 'confidential' id, the exact pre-#642 member behavior) and the
 * generalized `visibleSpaces` (the requester's resolved membership set).
 * Union: `(includeConfidential ? {'confidential'} : ∅) ∪ (visibleSpaces ?? ∅)`.
 *
 * A caller that passes NEITHER gets the EMPTY set = shared-only — the
 * fail-closed default every un-gated surface (MCP tools, internal passes that
 * want the whole store must say so explicitly) already had as boolean-false.
 * Byte-identical to the old predicate on standard/confidential data for every
 * boolean-only call: false → ∅ (confidential hidden), true → {'confidential'}
 * (confidential visible).
 */
export function resolveVisibleSet(
  includeConfidential?: boolean,
  visibleSpaces?: ReadonlySet<string>,
): Set<string> {
  const out = new Set<string>();
  if (includeConfidential === true) out.add("confidential");
  if (visibleSpaces) for (const id of visibleSpaces) out.add(id);
  return out;
}

/**
 * THE visibility predicate — one rule every read gate consults (#642 AC-5):
 * shared rows ('standard', i.e. spaceOf of NULL/''/'standard') are visible to
 * EVERYONE; every other row is visible iff its space id is in the viewer's
 * set. A stored id outside {'standard'} ∪ visible is INVISIBLE to that viewer
 * — which makes an unknown or retired space id (no configured space claims
 * it, so no membership list can ever contain it) invisible to EVERY
 * requester, the AC-7 fail-closed direction: unknown ids are never
 * normalized to shared, they are dropped from view until configured or
 * re-stamped.
 */
export function isVisiblePrivacy(
  privacy: string | null | undefined,
  visible: ReadonlySet<string>,
): boolean {
  const space = spaceOf(privacy);
  return space === "standard" || visible.has(space);
}

/**
 * #642 AC-7: stored space ids NO configured space claims — the boot-warning
 * input. Scans `memories.privacy` AND `distill_queue.privacy` (both carry
 * stamps; a retired space can sit queued as well as stored) for DISTINCT
 * values outside the fixed vocabulary ('standard' — NULL never reaches here —
 * and 'confidential', which is RESERVED: always known, never unknown, even on
 * installs where no confidential space materialized) and drops every id the
 * `known` set (knownSpaceIds at the calling seam) contains. Sorted for a
 * deterministic one-line-per-boot warning; empty = nothing to report.
 *
 * Such rows are stored-but-invisible: no members list can contain an
 * unconfigured id, so isVisiblePrivacy excludes them for EVERY requester —
 * the fail-closed direction (never normalized to shared). The operator
 * resolves them by configuring the space or re-stamping (backfill).
 */
export function unknownStoredSpaceIds(
  db: Database.Database,
  known: ReadonlySet<string>,
): string[] {
  const ids = new Set<string>();
  // Literal table names (no interpolation of caller input into SQL).
  for (const table of ["memories", "distill_queue"] as const) {
    const rows = db
      .prepare(
        `SELECT DISTINCT privacy FROM ${table} ` +
          `WHERE privacy IS NOT NULL AND privacy NOT IN ('standard', 'confidential')`,
      )
      .all() as Array<{ privacy: string | null }>;
    for (const r of rows) {
      if (r.privacy !== null && !known.has(r.privacy)) ids.add(r.privacy);
    }
  }
  return [...ids].sort();
}
