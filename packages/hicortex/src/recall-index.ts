/**
 * POST /recall-index — pushed recall index (#192).
 *
 * One recall logic for every harness: CC calls it from a UserPromptSubmit
 * hook, the Hermes/OC plugins can call it per turn. The server searches the
 * corpus with the prompt text and returns a COMPACT INDEX (one line per
 * memory — a menu, not the meal); the agent lazy-loads full content with
 * `hicortex_get(id)` only when a line is actually relevant.
 *
 * Strengthening semantics (the recall/decay alignment):
 *   - Appearing in the index = exposure: shown_count + last_accessed refresh
 *     (mild, temporary strengthen — the decay clock resets) via
 *     storage.touchMemoriesShown. NO access_count bump: hardening, the prune
 *     shield, and the adoption metric stay driven by real use.
 *   - hicortex_get = use: full strengthen (access_count + 1).
 *
 * Anti-bloat gates: relevance floor (measured cosine, or a real BM25 match),
 * per-session TURN-based dedup (SessionRecallRegistry), short-prompt skip,
 * and a hard item cap. On a prompt with no relevant memories the block is
 * null and the hook prints nothing.
 */

import type Database from "better-sqlite3";
import type { MemorySearchResult, Memory } from "./types.js";
import * as storage from "./storage.js";
import { SessionRecallRegistry } from "./recall-registry.js";

export interface RecallIndexOptions {
  /** Minimum measured cosine for vector-only candidates (config
   *  `recallMinSimilarity`). FTS-matched candidates pass regardless — a BM25
   *  text match is direct evidence of relevance. Default 0.62 (raised from 0.55
   *  on 2026-08-03 per a 0.01-step floor sweep on the rewritten corpus): steady
   *  ~3:1 noise:signal removal with no knee; 0.62 = +2.2pts precision, 10/98
   *  prompts silent, sits below the 0.63 local pessimum. The floor is a noise
   *  dial, NOT a silence mechanism — at 0.62 each correctly-silenced empty prompt
   *  comes with ~1.5 wrongly-silenced (real signal); a non-cosine gate is the
   *  real silence fix (eval #3 §4). */
  minSimilarity?: number;
  /** Max index lines per response (config `recallMaxItems`). Default 5
   *  (lowered from 6 on 2026-08-03). Per-slot decomposition at floor 0.62:
   *  slot 6 gives NO prompt its first relevant memory — "6 is wrong" is the
   *  robust, prompt-set-independent finding, and 5 captures it. The K-sweep
   *  is monotone (precision@4 33.7% > @6 30.6% > @8 28.3%), so 4 is
   *  lower-noise — but the 4-vs-5 distinction rests on 5 of 98 prompts and is
   *  overfitting-fragile (K and the floor were tuned on the same set); 5 hedges
   *  with coverage at modest cost. Lower to 4 if a fresh-prompt eval replicates. */
  maxItems?: number;
  /** Prompts shorter than this are skipped (continuations, "yes", "do it"). */
  minPromptLength?: number;
  /** Max chars of the memory's first line shown in an index entry (config
   *  `recallTitleChars`). Default 100 (reverted from 150 on 2026-08-03): the
   *  full-corpus relevance eval (#3, §5) found 100 vs 150 statistically
   *  identical (0.6pts apart, N=40, full CI overlap); 100 saves ~13% tokens
   *  per block. */
  titleChars?: number;
}

/** Relevance-gate floor for vector-only candidates (config `recallMinSimilarity`).
 *  0.62 (was 0.55; raised 2026-08-03 on the fine-grain floor sweep — see the
 *  minSimilarity doc above). */
const DEFAULT_MIN_SIMILARITY = 0.62;
/** Max index lines per pushed recall block (config `recallMaxItems`).
 *  5 (was 6; lowered 2026-08-03 — slot 6 is pure padding at floor 0.62). */
const DEFAULT_MAX_ITEMS = 5;
const DEFAULT_MIN_PROMPT_LENGTH = 20;
/** Default index-line title length. 100 (reverted from 150 on 2026-08-03:
 *  eval #3 §5 showed 100 vs 150 statistically identical; 100 saves ~13% tokens). */
const DEFAULT_TITLE_CHARS = 100;
/** Over-fetch multiplier: retrieve `maxItems × 3` candidates so gating + dedup
 *  still leave a full menu. Kept at 3 after maxItems 6→5 and the higher floor —
 *  permit-short is intended (returning fewer than maxItems when fewer clear the
 *  gate is correct, not a defect); raise only if blocks are persistently
 *  under-filled in production. */
const CANDIDATE_MULTIPLIER = 3;

export interface RecallIndexResult {
  status: number;
  body: Record<string, unknown>;
}

/** First content line, de-markdowned and truncated — the index line title. */
export function memoryTitle(content: string, maxLen = DEFAULT_TITLE_CHARS): string {
  const firstLine =
    content
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  const title = firstLine
    .replace(/^#+\s*/, "")
    .replace(/^Session Memory:\s*/i, "")
    .replace(/^Lesson:\s*/i, "")
    .trim();
  return title.length > maxLen ? `${title.slice(0, maxLen - 1)}…` : title;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}.${mm}.${d.getFullYear()}`;
}

/**
 * Render one production index line. Exported (2026-08-02, relevance eval #v2)
 * so the eval can measure the REAL rendered surface instead of reimplementing
 * it — `maxLen` threads through to `memoryTitle` unchanged (default
 * DEFAULT_TITLE_CHARS = 100, config `recallTitleChars`) so the eval's snippet-length
 * sweep (spec §4.2) can call this SAME function at 100/150/title1sent without
 * duplicating the date/scope/agent/type meta-line logic.
 */
export function formatIndexLine(
  r: MemorySearchResult & { domain?: string | null },
  maxLen = DEFAULT_TITLE_CHARS
): string {
  // Provenance (#202): date, scope (domain else project), ORIGIN AGENT, type.
  // The origin agent lets a reader calibrate trust — "from my session" vs
  // another agent/project — before fetching or acting on an entry.
  const meta = [
    formatDate(r.created_at),
    r.domain ?? r.project ?? undefined,
    r.source_agent ?? undefined,
    r.memory_type,
  ]
    .filter(Boolean)
    .join(", ");
  return `- [${r.id}] ${memoryTitle(r.content, maxLen)}${meta ? ` (${meta})` : ""}`;
}

/**
 * Relevance gate: a real BM25 text match (FTS) passes unconditionally; a
 * vector-only candidate must clear `minSimilarity`.
 *
 * NOTE: FTS hits BYPASS the similarity floor, so raising the floor shifts
 * weight toward FTS-sourced entries. In practice FTS is currently inert on
 * real prompts — eval #3 had 0 FTS rows / 2,208 (2,203 vector + 5 graph), and
 * a relevance sample returned 96/96 vector — so the floor change is safe as
 * measured. But FTS quality is unmeasured; if FTS starts firing
 * (e.g. as #205's fielded-BM25 retune beds in), give it its own eval.
 */
export function passesRelevanceGate(
  r: MemorySearchResult,
  minSimilarity: number
): boolean {
  if (r.source === "fts" || r.source === "both") return true;
  return typeof r.similarity === "number" && r.similarity >= minSimilarity;
}

/** Recall filters a client may push per request (#193 review F1): a scoped
 *  plugin (Hermes default_project / mission_domains) must be able to narrow
 *  recall exactly like the legacy /search prefetch did — dropping them
 *  silently would leak out-of-scope memory titles into the injected index.
 *
 *  #203: `project` and `mission_domains` are SOFT affinity signals in
 *  retrieval (zero-boost neutral, never a filter / penalty). 0.16.x: `privacy`
 *  is gone from this shape entirely — the column is vestigial, never filtered,
 *  so a plugin's `privacy_filter` is a harmless no-op the server no longer
 *  threads through. The body field is still ACCEPTED (backward compat) but
 *  ignored. */
export interface RecallFilters {
  project?: string;
  /** #203: Hermes mission domains (declared in plugin config). Soft domain
   *  affinity in computeScore via max overlapping memory_tags.weight. */
  mission_domains?: string[];
}

export interface RecallIndexDeps {
  db: Database.Database;
  registry: SessionRecallRegistry;
  /** Search closure. `sessionId` is forwarded so the closure (in mcp-server)
   *  can resolve/update the session-intent centroid and pass a blended query
   *  vector into retrieve() — see #192 session-intent keying (0.15.3). */
  retrieveFn: (
    query: string,
    limit: number,
    filters: RecallFilters | undefined,
    sessionId: string
  ) => Promise<MemorySearchResult[]>;
  options?: RecallIndexOptions;
}

/** Normalize a request-supplied string-list param: array of strings or a CSV
 *  string → string[] | undefined. Anything else (or an empty result) means
 *  "absent" — never a partial guess. Used by `mission_domains` (#203) so it
 *  accepts `["A","B"]` and `"A, B"` alike. */
export function parseStringListParam(v: unknown): string[] | undefined {
  const items = Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string")
    : typeof v === "string"
      ? v.split(",")
      : [];
  const cleaned = items.map((s) => s.trim()).filter(Boolean);
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Handle a /recall-index request body. Thin Express adapter in mcp-server.ts;
 * all behavior lives here so tests exercise it directly.
 */
export async function handleRecallIndex(
  deps: RecallIndexDeps,
  body: unknown
): Promise<RecallIndexResult> {
  const req = (body ?? {}) as Record<string, unknown>;
  const sessionId = typeof req.session_id === "string" && req.session_id ? req.session_id : null;
  if (!sessionId) {
    return { status: 400, body: { error: "Missing 'session_id'" } };
  }

  // Reset: SessionStart (startup/resume/clear/compact) — fresh context, so the
  // shown-set is stale by definition.
  if (req.reset === true) {
    deps.registry.reset(sessionId);
    return { status: 200, body: { ok: true, reset: true } };
  }

  const prompt = typeof req.prompt === "string" ? req.prompt.trim() : "";
  const minPromptLength = deps.options?.minPromptLength ?? DEFAULT_MIN_PROMPT_LENGTH;
  if (prompt.length < minPromptLength) {
    return { status: 200, body: { block: null, skipped: "short-prompt" } };
  }

  const maxItems = clampInt(deps.options?.maxItems, DEFAULT_MAX_ITEMS, 1, 20);
  const titleChars = clampInt(deps.options?.titleChars, DEFAULT_TITLE_CHARS, 40, 400);
  const minSimilarity = clampNumber(
    deps.options?.minSimilarity,
    DEFAULT_MIN_SIMILARITY,
    0,
    1
  );

  const turn = deps.registry.beginTurn(sessionId);

  // Optional client-side scoping (F1 + #203): project + mission_domains (soft
  // affinity) ride the body and are pushed into retrieval. project is cwd-
  // derived (CC/OC) or gateway-supplied; mission_domains is Hermes-declared
  // (plugin config). Neither excludes anything — both are zero-boost-neutral
  // score terms in computeScore. (0.16.x: `privacy` is no longer threaded —
  // vestigial column, never filtered; a plugin's privacy_filter is a no-op.)
  const filters: RecallFilters = {
    project: typeof req.project === "string" && req.project ? req.project : undefined,
    mission_domains: parseStringListParam(req.mission_domains),
  };

  let results: MemorySearchResult[];
  try {
    results = await deps.retrieveFn(prompt, maxItems * CANDIDATE_MULTIPLIER, filters, sessionId);
  } catch (err) {
    return {
      status: 500,
      body: { error: err instanceof Error ? err.message : String(err) },
    };
  }

  const picked = results
    .filter((r) => passesRelevanceGate(r, minSimilarity))
    .filter((r) => deps.registry.isShowable(sessionId, r.id))
    .slice(0, maxItems);

  if (picked.length === 0) {
    return { status: 200, body: { block: null, shown: [], turn } };
  }

  const ids = picked.map((r) => r.id);
  deps.registry.markShown(sessionId, ids);
  // Exposure signal: shown_count + last_accessed refresh, NOT access_count.
  storage.touchMemoriesShown(deps.db, ids, new Date().toISOString());

  const lines = picked.map((r) => formatIndexLine(r, titleChars));
  const block = [
    "## Memory recall (auto)",
    // Provenance is BUILT IN (owner decision 27.07, option D; extended #202/#204):
    //   - #202: origin agent in each one-liner (formatIndexLine) — trust calibration.
    //   - #204: confidence levels — FETCHED (read in full) vs SNIPPET (one-line entry only),
    //     so "the agent cited a memory" can no longer pass as "the agent read it".
    // This header carries the SELECTION-time rules: supersession (the one moment
    // competing dates are visible side by side) and cite-with-confidence. The
    // full citation format rides on the hicortex_get response / GET /memory
    // `citation` field (use-time, marked FETCHED).
    "Possibly relevant memories — dates matter, newer supersedes older. Fetch with `hicortex_get(id)` when an entry could change your action. Cite what you rely on by id + date, and mark it `FETCHED` if you read the full memory or `SNIPPET` if you're citing the one-line entry unread — don't pass a SNIPPET citation off as established fact.",
    ...lines,
  ].join("\n");

  return { status: 200, body: { block, shown: ids, turn } };
}

/**
 * Handle a GET /memory request (lazy-load counterpart of the recall index for
 * REST clients). Thin Express adapter in mcp-server.ts; behavior lives here so
 * tests exercise it directly.
 *
 *   - Short/prefix ids resolve via storage.resolveMemoryId (F6) — the 8-char
 *     citation ids agents are taught must work here like on /update, /delete.
 *   - A successful fetch is real use: access_count + 1 (strengthen).
 *
 * 0.16.x: the `privacy` filter gate was removed — the column is vestigial and
 * never filtered. Callers may still send a `privacy` field (backward compat)
 * but it is ignored.
 */
export function handleMemoryGet(
  db: Database.Database,
  query: { id?: unknown }
): RecallIndexResult {
  const id = typeof query.id === "string" ? query.id : "";
  if (!id) return { status: 400, body: { error: "Missing 'id'" } };

  const notFound: RecallIndexResult = {
    status: 404,
    body: { error: `No memory with id ${id}` },
  };
  const fullId = storage.resolveMemoryId(db, id);
  if (!fullId) return notFound;
  const mem = storage.getMemory(db, fullId);
  if (!mem) return notFound;

  storage.strengthenMemory(db, fullId, new Date().toISOString());
  // `citation` is server-rendered so every plugin surfaces the same built-in
  // provenance norm (owner directive 27.07) — see #193.
  const date = (mem.created_at ?? "").slice(0, 10);
  return {
    status: 200,
    body: {
      memory: mem,
      citation: `(memory ${String(mem.id).slice(0, 8)}, ${date}, from ${mem.source_agent ?? "unknown"}, FETCHED)`,
    },
  };
}

/**
 * MCP `hicortex_get` presentation: handleMemoryGet's result framed as the
 * text block the MCP tool returns (provenance header + the SHARED citation +
 * content). Extracted from the MCP tool handler so its output — incl. the
 * #204 FETCHED marker, which rides on handleMemoryGet's citation — is unit-
 * testable. The citation string is built ONCE (handleMemoryGet); this only
 * frames it, mirroring how /recall-index is shared across harnesses. The
 * extraction closes the #207 gap (CC's MCP path had a marker-less citation
 * built inline, while the REST path used handleMemoryGet — same contract, two
 * implementations, one updated).
 */
export function formatMemoryGetText(
  db: Database.Database,
  query: { id?: unknown }
): { status: number; text: string } {
  const r = handleMemoryGet(db, query);
  if (r.status !== 200) {
    return { status: r.status, text: String(r.body.error ?? `No memory with id ${query.id ?? ""}`) };
  }
  const mem = r.body.memory as Memory;
  const citation = r.body.citation as string; // carries FETCHED (#204)
  const date = (mem.created_at ?? "").slice(0, 10);
  const header =
    `[memory ${mem.id} | ${mem.memory_type ?? "episode"} | ${mem.project ?? "-"} | from ${mem.source_agent ?? "unknown"} | ${date}]\n` +
    `Cite as ${citation} where this shapes your answer; it may be stale — newer memories supersede older.`;
  return { status: 200, text: `${header}\n\n${mem.content ?? ""}` };
}

function clampInt(v: unknown, dflt: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function clampNumber(v: unknown, dflt: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}
