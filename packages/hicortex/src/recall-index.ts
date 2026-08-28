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
 *
 * Novelty floor (#324): the session-intent blend (#192 session-intent keying)
 * can dilute a topic-switching prompt below the relevance floor — the live
 * failure was a technically-primed session asking about "my Sargo" and getting
 * ZERO relevant memories while a fresh session with the identical prompt got
 * the perfect top hit. So a second, PURE-prompt search (no centroid blend,
 * SAME candidate window as the blended search) runs alongside the blended
 * one, and its top hit(s) that pass the floor are GUARANTEED slots in the
 * index (dedup by id against the blended picks, capped by
 * `noveltyFloorSlots`; rendered first). When the pure top hits are already
 * among the blended picks — the common continuing-intent case — the output is
 * unchanged. Turn suppression still wins: a recently shown novelty pick is
 * suppressed like any other (the guarantee is about candidate inclusion, not
 * forcing re-shows).
 *
 * #329 item 3 — the pure search is SKIPPED when it would be byte-identical
 * to the blended one: turn 1 (no centroid yet — nothing to blend) or
 * sessionIntentWeight 0 (blend disabled). The blended result IS the pure
 * result there, so the floor is trivially satisfied by the blended picks and
 * the second search (embeds aside, its whole DB + FTS half) is pure waste.
 *
 * #329 item 4 — novelty backfill: when the blended picks are empty/short,
 * unclaimed maxItems slots are filled from the remaining filtered
 * pure-prompt tail (gate + suppression already applied). Without it the
 * topic-switch turn — the one the floor exists for — got the MOST truncated
 * menu: novelty slots + a diluted remainder, while further pure candidates
 * that had already passed every gate sat unused.
 */

import type Database from "better-sqlite3";
import type { MemorySearchResult, Memory } from "./types.js";
import * as storage from "./storage.js";
import { SessionRecallRegistry } from "./recall-registry.js";
import { labelForType } from "./type-labels.js";
import {
  retrieve,
  getSessionIntent,
  recallQueryVector,
} from "./retrieval.js";

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
  /** Slots of `maxItems` guaranteed to the pure-prompt (unblended) search's
   *  top passing hit(s) — the #324 novelty floor. Config `noveltyFloorSlots`,
   *  default 2 (mirrors coldExposureSlots sizing: small, a floor not a
   *  takeover). 0 disables the pure-prompt search entirely (the kill-switch).
   *  Clamped to [0, maxItems]. */
  noveltyFloorSlots?: number;
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
/** Default #324 novelty-floor slots (config `noveltyFloorSlots`). 2 mirrors
 *  coldExposureSlots sizing — enough to guarantee the pure-prompt top hit
 *  plus a runner-up, never a takeover of the index. The floor only SPENDS
 *  slots when a pure-prompt hit differs from the blended picks (topic
 *  switch); continuing-intent sessions pay nothing. Exported for the boot
 *  log's knob line (mcp-server resolves config-vs-default here, once). */
export const DEFAULT_NOVELTY_FLOOR_SLOTS = 2;
/** Resolve the EFFECTIVE novelty floor (raw ?? default, clamped to
 *  [0, maxItems]) — one definition shared by the handler and the boot knob
 *  line so the logged value is what handleRecallIndex actually uses.
 *  maxItems may be the handler's already-resolved number OR raw config
 *  (boot-log site) — raw is resolved with the handler's exact constants. */
export function resolveNoveltyFloorSlots(rawSlots: unknown, rawMaxItems: unknown): number {
  const maxItems =
    typeof rawMaxItems === "number"
      ? rawMaxItems
      : clampInt(rawMaxItems, DEFAULT_MAX_ITEMS, 1, 20);
  return clampInt(rawSlots, DEFAULT_NOVELTY_FLOOR_SLOTS, 0, maxItems);
}
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

/**
 * Hard cap on `session_id` length (#328 item 2a). The id is retained as a Map
 * key by SessionRecallRegistry for the process lifetime (maxSessions=500 LRU
 * + a per-session shown-set + intent centroid), so an unbounded id is an OOM
 * vector: ~4.9MB ids × 500 sessions ≈ 2.4GB of retained keys from an
 * authenticated-but-hostile tenant. Real session ids (CC UUIDs, plugin
 * session keys) are ≤64 chars — 128 is generous headroom. Longer → 400 with
 * a clear error; the client treats it like any bad request.
 */
export const MAX_SESSION_ID_CHARS = 128;

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
    labelForType(r.memory_type),
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

/** The search-closure contract handleRecallIndex consumes (see
 *  RecallIndexDeps.retrieveFn). Named so the production factory
 *  (createRecallRetrieveFn) and test doubles share one type. */
export type RecallRetrieveFn = (
  query: string,
  limit: number,
  filters: RecallFilters | undefined,
  sessionId: string,
  purePrompt?: boolean
) => Promise<MemorySearchResult[]>;

export interface RecallIndexDeps {
  db: Database.Database;
  registry: SessionRecallRegistry;
  /** Search closure. `sessionId` is forwarded so the closure resolves/updates
   *  the session-intent centroid and passes a blended query vector into
   *  retrieve() — see #192 session-intent keying (0.15.3).
   *
   *  `purePrompt` (#324 novelty floor): request the PURE-prompt search — the
   *  closure must search with the prompt embedding UNBLENDED (no session
   *  centroid) and must NOT fold the prompt into the centroid a second time
   *  (the blended call owns this turn's EMA update). Older closures that
   *  ignore the flag degrade to blended-only recall — no novelty floor, but
   *  no breakage. */
  retrieveFn: RecallRetrieveFn;
  options?: RecallIndexOptions;
}

/**
 * The PRODUCTION /recall-index retrieveFn (what mcp-server wires into
 * handleRecallIndex), extracted from the route handler so the #324 path is
 * testable without HTTP — same precedent as blendQueryVector/recallQueryVector
 * ("extracted from the /recall-index closure so the exact decision is
 * unit-testable").
 *
 * Per call:
 *   - embed the prompt ONCE per request — a single-entry promise memo keyed
 *     on the query text. The blended and pure-prompt searches of one request
 *     carry the same prompt, so they share one embed; the factory is built
 *     per request, so the memo never outlives it.
 *   - resolve the search vector via retrieval.recallQueryVector (blend + EMA
 *     fold, or the pure prompt with NO centroid state for #324);
 *   - retrieve() with noStrengthen (exposure is recorded by
 *     handleRecallIndex via touchMemoriesShown, never here).
 *
 * #329 CR finding 1b: the FTS candidate list is ALSO computed once per
 * request (ftsOnce, keyed on query + candidate window) and threaded into both
 * retrieve() calls via the ftsCandidates provider — the blended and pure
 * searches of one request carry identical query text and window, so their FTS
 * halves were byte-identical SQL executed twice. `ftsFn` is the DI seam for
 * tests (production: storage.searchFts); a throwing FTS computation memoizes
 * to an empty shared list — the same vector-only degradation retrieve()'s
 * catch always produced, never an error.
 */
export function createRecallRetrieveFn(deps: {
  db: Database.Database;
  registry: SessionRecallRegistry;
  embedFn: (text: string) => Promise<Float32Array>;
  /** FTS resolution override (tests). Defaults to storage.searchFts. */
  ftsFn?: typeof storage.searchFts;
}): RecallRetrieveFn {
  let embMemo: { query: string; p: Promise<Float32Array> } | null = null;
  const embedOnce = (query: string): Promise<Float32Array> => {
    if (!embMemo || embMemo.query !== query) {
      embMemo = { query, p: deps.embedFn(query) };
    }
    return embMemo.p;
  };
  const ftsResolve = deps.ftsFn ?? storage.searchFts;
  let ftsMemo: {
    query: string;
    limit: number;
    rows: Array<Memory & { rank: number }>;
  } | null = null;
  const ftsOnce = (
    query: string,
    limit: number
  ): Array<Memory & { rank: number }> => {
    if (!ftsMemo || ftsMemo.query !== query || ftsMemo.limit !== limit) {
      try {
        ftsMemo = { query, limit, rows: ftsResolve(deps.db, query, limit) };
      } catch {
        // Same degradation retrieve()'s own catch always produced — the FTS
        // list is dropped and the search proceeds vector-only.
        ftsMemo = { query, limit, rows: [] };
      }
    }
    return ftsMemo.rows;
  };
  return async (query, limit, filters, sessionId, purePrompt) => {
    const { weight, alpha } = getSessionIntent();
    const promptEmb = await embedOnce(query);
    const queryVec = recallQueryVector(deps.registry, sessionId, promptEmb, {
      weight,
      alpha,
      purePrompt,
    });
    return retrieve(deps.db, deps.embedFn, query, {
      limit,
      noStrengthen: true,
      // #203: project + mission_domains are SOFT affinity (zero-boost
      // neutral), threaded into computeScore.
      project: filters?.project,
      missionDomains: filters?.mission_domains,
      queryEmbedding: queryVec,
      // #329: shared per-request FTS list. The recall path never passes
      // sourceAgent, so the memo is keyed on (query, fetchLimit) only —
      // exactly the two things retrieve() would pass to searchFts.
      ftsCandidates: (fetchLimit) => ftsOnce(query, fetchLimit),
    });
  };
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
  // Length cap (#328 item 2a) — BEFORE the reset branch so an oversized id
  // never reaches ANY registry call (reset() itself only deletes, but the
  // next non-reset call with the same id would beginTurn it into a retained
  // Map key). Clear error so a misbehaving client can self-diagnose.
  if (sessionId.length > MAX_SESSION_ID_CHARS) {
    return {
      status: 400,
      body: { error: `'session_id' too long (max ${MAX_SESSION_ID_CHARS} chars, got ${sessionId.length})` },
    };
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
  // #324: clamped to [0, maxItems] — the floor is a reservation inside the
  // item cap, never an expansion of it.
  const noveltySlots = resolveNoveltyFloorSlots(deps.options?.noveltyFloorSlots, maxItems);

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

  // #324 + #329 item 3: when the floor is armed AND would differ from the
  // blended search, TWO searches run per recall — the blended (session-intent)
  // query that has always run, and a PURE-prompt query with no centroid blend.
  // Issued together so the second adds no wall-clock latency beyond its own DB
  // work (the prompt is embedded once — the closure memoizes). Same failure
  // domain (same db + embedder): either failing fails the request explicitly;
  // no silent blended-only degradation.
  //
  // The SKIP (#329 item 3): on turn 1 the registry has no centroid yet (the
  // blended call reads-before-fold — recallQueryVector), and at
  // sessionIntentWeight 0 the centroid is never read at all. In both cases
  // the blended query vector IS the pure prompt vector, so the second search
  // would return byte-identical candidates — skip it (the floor is trivially
  // satisfied: every pure hit is by construction among the blended picks).
  // The decision is made BEFORE any retrieveFn call, i.e. on the centroid
  // state of the PREVIOUS turns — exactly the turn-1/turn-2 distinction.
  const runPureSearch =
    noveltySlots > 0 &&
    getSessionIntent().weight > 0 &&
    deps.registry.getCentroid(sessionId) !== undefined;

  let results: MemorySearchResult[];
  let pureResults: MemorySearchResult[];
  try {
    const blended = deps.retrieveFn(
      prompt,
      maxItems * CANDIDATE_MULTIPLIER,
      filters,
      sessionId
    );
    const pure = runPureSearch
      ? deps.retrieveFn(
          prompt,
          maxItems * CANDIDATE_MULTIPLIER,
          filters,
          sessionId,
          true
        )
      : Promise.resolve([] as MemorySearchResult[]);
    [results, pureResults] = await Promise.all([blended, pure]);
  } catch (err) {
    return {
      status: 500,
      body: { error: err instanceof Error ? err.message : String(err) },
    };
  }

  // Blended (session-intent) picks: relevance gate + turn-based suppression,
  // top maxItems — exactly what the index would show with no novelty floor.
  const blendedPicks = results
    .filter((r) => passesRelevanceGate(r, minSimilarity))
    .filter((r) => deps.registry.isShowable(sessionId, r.id))
    .slice(0, maxItems);

  // #324 novelty floor: the best match(es) for the CURRENT PROMPT ALONE are
  // guaranteed a place in the index. The blend exists to follow session
  // intent, not to veto the prompt — so pure-prompt hits that pass the floor
  // enter even when the blended query diluted them out of `results`
  // entirely. Dedup is against the blended PICKS (the no-floor outcome): when
  // the pure top hit is already shown by the blended path — the common
  // continuing-intent case — the floor costs nothing and the output is
  // unchanged. Suppression applies BEFORE the guarantee (suppression wins:
  // the floor is about candidate inclusion, not forcing re-shows). FTS-sourced
  // pure hits pass the gate unconditionally, same as the blended path.
  //
  // The gate + suppression are applied ONCE to the pure list: the head feeds
  // the novelty floor, the tail feeds the #329 backfill below.
  const pureFiltered = pureResults
    .filter((r) => passesRelevanceGate(r, minSimilarity))
    .filter((r) => deps.registry.isShowable(sessionId, r.id));
  const blendedIds = new Set(blendedPicks.map((r) => r.id));
  const noveltyPicks = pureFiltered
    .filter((r) => !blendedIds.has(r.id))
    .slice(0, noveltySlots);

  // The floor takes precedence (#324 vs #192 cold slots): novelty picks hold
  // their slots; blended picks keep the remainder, evicted from the TAIL
  // (lowest rank first) so the session-intent head survives. Cold-exposure
  // slots continue to apply inside each retrieve()'s own top-k. Total never
  // exceeds maxItems. Render order: novelty picks FIRST — on a topic switch
  // they are the most relevant lines to the CURRENT turn, and the head of the
  // block carries the most weight for a reader scanning the menu.
  let picked = [
    ...noveltyPicks,
    ...blendedPicks.slice(0, Math.max(0, maxItems - noveltyPicks.length)),
  ];

  // #329 item 4 — backfill: a topic-switch turn dilutes the blended picks, so
  // picked can land below maxItems even though FURTHER pure candidates have
  // already passed the gate + suppression + dedup (they sit in the pure tail
  // beyond the first noveltyFloorSlots). Fill the unclaimed slots from that
  // tail — without it, the turn the floor exists for got the most truncated
  // menu. Continuing-intent sessions are untouched: blended picks full →
  // nothing to backfill (zero-delta output preserved).
  if (picked.length < maxItems) {
    const pickedIds = new Set(picked.map((r) => r.id));
    const backfill = pureFiltered
      .filter((r) => !pickedIds.has(r.id))
      .slice(0, maxItems - picked.length);
    picked = [...picked, ...backfill];
  }

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
  // Shallow-copy and apply the human-term label to memory_type so the REST
  // response surfaces the user-facing vocabulary, not the raw DB enum. The
  // underlying DB row (`mem`) is NOT mutated — the DB IS the raw-enum source
  // of truth; the label is a presentation concern applied at the boundary.
  const memory = { ...mem, memory_type: labelForType(mem.memory_type) };
  return {
    status: 200,
    body: {
      memory,
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
  // #264 WS2: render the human-term label (Knowledge/Experience/...), not the
  // internal enum, in the citation header shown to the agent/user.
  const header =
    `[memory ${mem.id} | ${labelForType(mem.memory_type ?? "experience")} | ${mem.project ?? "-"} | from ${mem.source_agent ?? "unknown"} | ${date}]\n` +
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
