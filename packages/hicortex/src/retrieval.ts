/**
 * Retrieval layer with composite scoring, RRF fusion, and graph traversal.
 * Ported from hicortex/retrieval.py — same scoring model and weights.
 *
 * Scoring model (weights are RELEASE-MANAGED since #408 — calibration.ts;
 * configureScoring is the eval/test seam only):
 *   score = similarity * 0.50 + effective_strength * 0.20
 *         + connection_score * 0.15 + recency * 0.15
 *         + fresh-memory bonus (≤ 0.15, linear over the first 7 days)
 *         then × 0.50 if the memory was superseded by a later decision
 *
 * Decay model (B+E+D):
 *   base_decay = derived from the calibration half-life (365 → ~1-year
 *                half-life at importance 0.5, importance-scaled either way)
 *   decay_rate = 1 - base_decay * (1 - importance)
 *   decay_rate = 1 - (1 - decay_rate) * 0.7^access_count
 *   decay_rate = 1 - (1 - decay_rate) * 0.7^link_count
 *   floor = base_strength * importance * 0.1
 *   effective = floor + (base - floor) * decay_rate^hours
 */

import type Database from "better-sqlite3";
import type { Memory, MemorySearchResult } from "./types.js";
import * as storage from "./storage.js";
import { l2Normalize, weightedAdd } from "./schema-prototypes.js";
import { labelForType } from "./type-labels.js";
import * as CALIBRATION from "./calibration.js";

/** Default decay half-life (days) at importance 0.5 — release-managed
 *  (#408): the constant lives in calibration.ts with its provenance. */
export const DEFAULT_DECAY_HALF_LIFE_DAYS = CALIBRATION.DECAY_HALF_LIFE_DAYS;

/**
 * Derive the per-hour base decay constant from a half-life target: for the
 * decayable portion, retention^hours = 0.5 at `days`, evaluated at the
 * reference importance 0.5 (the model scales the rate by (1 − importance)).
 * decay_rate = 1 − λ(1 − imp) ⇒ half-life ≈ ln2 / (λ·(1 − imp)), so
 * λ = ln2 / (24·days·0.5).
 */
export function decayConstantForHalfLife(days: number): number {
  return Math.LN2 / (24 * days * 0.5);
}

let BASE_DECAY = decayConstantForHalfLife(DEFAULT_DECAY_HALF_LIFE_DAYS);

/**
 * Configure the decay speed for THIS process (the eval/test seam — #408).
 * Production NEVER passes an argument: every process scores with the
 * calibration half-life (calibration.ts DECAY_HALF_LIFE_DAYS). An
 * invalid/absent value keeps the default. Exported value for tests.
 */
export function configureDecay(halfLifeDays?: number): number {
  const days = Number(halfLifeDays);
  BASE_DECAY = decayConstantForHalfLife(
    Number.isFinite(days) && days > 0 ? days : DEFAULT_DECAY_HALF_LIFE_DAYS
  );
  return BASE_DECAY;
}

// ---------------------------------------------------------------------------
// Recall breadth knobs (#192) — RELEASE-MANAGED since #408 (calibration.ts):
//   searchLimit        8     default k for retrieve()
//   recentLimit        12    default k for searchRecent()
//   recentWindowDays   180   searchRecent() candidate window
//   coldExposureSlots  2     top-k slots reservable for never-accessed hits
// The configure*() seam exists so the eval + tests can sweep values; config
// keys no longer reach here.
// ---------------------------------------------------------------------------

export interface RecallDefaults {
  searchLimit: number;
  recentLimit: number;
  recentWindowDays: number;
  coldExposureSlots: number;
}

const RECALL_DEFAULTS: RecallDefaults = {
  searchLimit: CALIBRATION.SEARCH_LIMIT,
  recentLimit: CALIBRATION.RECENT_LIMIT,
  recentWindowDays: CALIBRATION.RECENT_WINDOW_DAYS,
  coldExposureSlots: CALIBRATION.COLD_EXPOSURE_SLOTS,
};

let recallDefaults: RecallDefaults = { ...RECALL_DEFAULTS };

/**
 * Configure recall breadth from RESOLVED overrides (the eval/test seam —
 * #408). Production calls this with no argument: the calibration defaults
 * (calibration.ts) apply. Invalid/absent values keep the shipped default per
 * key. Returns the resolved values (for logging + tests).
 */
export function configureRecall(overrides?: Partial<RecallDefaults> | null): RecallDefaults {
  const pick = (v: unknown, dflt: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : dflt;
  };
  recallDefaults = {
    searchLimit: Math.max(1, pick(overrides?.searchLimit, RECALL_DEFAULTS.searchLimit)),
    recentLimit: Math.max(1, pick(overrides?.recentLimit, RECALL_DEFAULTS.recentLimit)),
    recentWindowDays: Math.max(1, pick(overrides?.recentWindowDays, RECALL_DEFAULTS.recentWindowDays)),
    coldExposureSlots: pick(overrides?.coldExposureSlots, RECALL_DEFAULTS.coldExposureSlots),
  };
  return { ...recallDefaults };
}
// ---------------------------------------------------------------------------
// Composite-score weights + Phase-B ranking knobs (#191). RELEASE-MANAGED
// since #408 — the values live in calibration.ts (with their provenance);
// configureScoring is the eval/test seam only:
//   similarity              0.50  semantic match (was 0.40 — see below)
//   strength                0.20  effective strength (was 0.30)
//   connections             0.15  graph centrality — LOG-SATURATING in the
//                                row's absolute undirected degree k (#449):
//                                the term is min(1, log1p(k)/log1p(K)) ×
//                                this weight, K = CONNECTIONS_
//                                SATURATION_DEGREE (16, the p99 of the real
//                                degree distribution — the top ~1% of hubs
//                                tie at full credit, k = 0 is exactly +0).
//                                Was a linear share of the candidate-set
//                                max (the set-relative normalization #449
//                                deleted: a row's score used to depend on
//                                which OTHER rows matched)
//   connectionsSaturation    16   the K above (a count, not a weight — the
//                                rrfK seam precedent; validated ≥ 1)
//   recency                 0.15  time curve — slow-region share/blend weight
//                                (was 0.10); 0 disables the WHOLE term
//   recencyHead             0.30  time curve — head amplitude at age 0 (the
//                                merged freshness job). A deliberate overshoot
//                                (max total 1.15 pre-clamp), NOT a fifth blend
//                                weight — the four blend weights above still
//                                sum to 1.0
//   recencyHeadDays           7   time curve — head window / join age in days
//   supersededDemotion      0.50  multiplier for reversed decisions
//   scopeAffinity           0.15  #430 merged scope boost — max() of the
//                                project-match signal (1 on exact match) and
//                                the max overlapping domain-tag weight (the
//                                two #203 boosts at their shared value, never
//                                stacked); 0 disables the WHOLE term
//
//   #205 fusion-retune knobs (RRF side; the BM25F field weights live in
//   storage.ts next to the FTS column declaration they mirror):
//   rrfK                     60   RRF k parameter (1/(k+rank+1))
//   rrfCompositeWeight      0.8   composite-score share of the final blend
//   rrfFtsWeight            0.5   per-list RRF weight for the FTS list
//   rrfVectorWeight         1.0   per-list RRF weight for the vector list
//
// The rebalance is evidence-driven: on the production corpus, effective
// strength (0.30) outweighed what similarity could recover, so old
// high-strength memories beat exact matches — e.g. an unrelated 0.80-strength
// memory outranked the on-topic 0.50-strength one for its own topic.
// Similarity now dominates; strength still breaks ties and rewards real use.
//
// The #430 scope-affinity term (born from #203's two boosts) is ADDITIVE,
// zero-boost neutral, and NEVER a penalty: absent scope ⇒ the term is 0
// (byte-identical to pre-#203); a foreign memory adds 0 (ranks equal, not
// lower — a penalty would re-introduce the soft-exclusion the owner rejected:
// "no hard filters in brains").
//
// #205 RRF retune nudges toward vector (FTS was winning cross-scope collisions
// on raw token overlap — the marine "battery" memory beating the hardware one
// for "battery temperature compensation"). The per-list RRF weight is the
// conservatively-shipped lever: vec stays at 1.0, FTS drops to 0.5 — enough to
// let composite (which already carries the #203 affinity boost) break the tie,
// not enough to starve keyword search. The eval gates the actual values.
// ---------------------------------------------------------------------------

export interface ScoringWeights {
  similarity: number;
  strength: number;
  connections: number;
  /**
   * #449 log-saturation degree K for the connections term: the credit is
   * min(1, log1p(k)/log1p(K)) — full at k = K, exactly +0 at k = 0. A count,
   * not a weight: validated ≥ 1 (the rrfK non-weight seam precedent); no
   * upper bound (the eval sweep widens K past the planted fixture degrees).
   */
  connectionsSaturation: number;
  recency: number;
  /** #430 merged time curve: head amplitude at age 0 — the merged freshness
   *  job. A deliberate overshoot (max total 1.15 pre-clamp), NOT a fifth
   *  blend weight; the four blend weights still sum to 1.0. */
  recencyHead: number;
  /** #430 merged time curve: head window / join age in days. */
  recencyHeadDays: number;
  supersededDemotion: number;
  /** #430 merged scope affinity: ONE term — max() of the project-match
   *  indicator (1 on exact match) and the max overlapping domain-tag weight,
   *  × this weight (born from #203's two additive boosts at their shared
   *  value). 0 (via the seam) disables the whole term. */
  scopeAffinity: number;
  /** #205 RRF k parameter (1/(k+rank+1)). Larger ⇒ shallower rank curve. */
  rrfK: number;
  /** #205 composite-score share of the final blend (RRF gets the remainder). */
  rrfCompositeWeight: number;
  /** #205 per-list RRF weight for the FTS list (BM25-driven candidates). */
  rrfFtsWeight: number;
  /** #205 per-list RRF weight for the vector list (KNN-driven candidates). */
  rrfVectorWeight: number;
  /** #425 additive boost for both-channel (vector AND FTS) candidates. */
  bothChannelBoost: number;
}

const SCORING_DEFAULTS: ScoringWeights = {
  similarity: CALIBRATION.SCORE_SIMILARITY_WEIGHT,
  strength: CALIBRATION.SCORE_STRENGTH_WEIGHT,
  connections: CALIBRATION.SCORE_CONNECTIONS_WEIGHT,
  // #449: the p99 of the real undirected degree distribution (see
  // calibration.ts provenance) — saturates the top ~1% of linked memories.
  connectionsSaturation: CALIBRATION.CONNECTIONS_SATURATION_DEGREE,
  recency: CALIBRATION.SCORE_RECENCY_WEIGHT,
  recencyHead: CALIBRATION.RECENCY_HEAD_WEIGHT,
  recencyHeadDays: CALIBRATION.RECENCY_HEAD_DAYS,
  supersededDemotion: CALIBRATION.SUPERSEDED_DEMOTION,
  scopeAffinity: CALIBRATION.SCOPE_AFFINITY_WEIGHT,
  // #205 (calibration.ts): rrfK + rrfCompositeWeight match the pre-#205
  // hardcoded values (60 and 0.8); the FTS per-list weight (1.0 → 0.5) is the
  // one deliberate nudge toward vector — the bisection point where BM25F +
  // composite-affinity flip the token-exact marine body match below the
  // same-scope hardware field while pure-keyword queries keep recall@5 = 1.0.
  rrfK: CALIBRATION.RRF_K,
  rrfCompositeWeight: CALIBRATION.RRF_COMPOSITE_WEIGHT,
  rrfFtsWeight: CALIBRATION.RRF_FTS_WEIGHT,
  rrfVectorWeight: CALIBRATION.RRF_VECTOR_WEIGHT,
  // #425 (calibration.ts): the both-channel genuine-match boost. 0.10 is
  // the sweep-chosen size — D3's dominance margin (>= 0.10 x the similarity
  // weight) with the battery stability gates intact.
  bothChannelBoost: CALIBRATION.BOTH_CHANNEL_BOOST,
};

let scoringWeights: ScoringWeights = { ...SCORING_DEFAULTS };

/**
 * Configure scoring weights + ranking knobs from RESOLVED overrides (the
 * eval/test seam — #408). Production calls this with no argument: the
 * calibration defaults (calibration.ts) apply, identically in the daemon and
 * the nightly. Invalid/absent values keep the shipped default per key.
 * Returns the resolved set for logging/tests. (The #205 BM25F field weights
 * are NOT touched here — they live in storage.ts and resolve from the same
 * calibration module via storage.configureBm25Fts.)
 */
export function configureScoring(overrides?: Partial<ScoringWeights> | null): ScoringWeights {
  const num = (v: unknown, dflt: number, min: number, max: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n >= min && n <= max ? n : dflt;
  };
  // #205 BM25F-style weights use a [0, ∞) range (no upper bound; 0 drops the
  // field/list entirely). Invalid ⇒ default.
  const numW = (v: unknown, dflt: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : dflt;
  };
  // #449: the connections saturation degree is a COUNT ≥ 1 (log1p(K) must
  // not divide by zero; K < 1 would saturate every k > 0 instantly). No
  // upper bound — the rrfK non-weight precedent.
  const numMin1 = (v: unknown, dflt: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 1 ? n : dflt;
  };
  scoringWeights = {
    similarity: num(overrides?.similarity, SCORING_DEFAULTS.similarity, 0, 1),
    strength: num(overrides?.strength, SCORING_DEFAULTS.strength, 0, 1),
    connections: num(overrides?.connections, SCORING_DEFAULTS.connections, 0, 1),
    connectionsSaturation: numMin1(overrides?.connectionsSaturation, SCORING_DEFAULTS.connectionsSaturation),
    recency: num(overrides?.recency, SCORING_DEFAULTS.recency, 0, 1),
    recencyHead: num(overrides?.recencyHead, SCORING_DEFAULTS.recencyHead, 0, 1),
    recencyHeadDays: num(overrides?.recencyHeadDays, SCORING_DEFAULTS.recencyHeadDays, 0, 365),
    supersededDemotion: num(overrides?.supersededDemotion, SCORING_DEFAULTS.supersededDemotion, 0, 1),
    scopeAffinity: num(overrides?.scopeAffinity, SCORING_DEFAULTS.scopeAffinity, 0, 1),
    rrfK: numW(overrides?.rrfK, SCORING_DEFAULTS.rrfK),
    rrfCompositeWeight: num(overrides?.rrfCompositeWeight, SCORING_DEFAULTS.rrfCompositeWeight, 0, 1),
    rrfFtsWeight: numW(overrides?.rrfFtsWeight, SCORING_DEFAULTS.rrfFtsWeight),
    rrfVectorWeight: numW(overrides?.rrfVectorWeight, SCORING_DEFAULTS.rrfVectorWeight),
    bothChannelBoost: num(overrides?.bothChannelBoost, SCORING_DEFAULTS.bothChannelBoost, 0, 1),
  };
  // #430: a head weaker than the slow weight it must join is nonsensical (the
  // head curve would dive below the tail inside the window). Floor it at the
  // resolved slow weight, defaulting to the shipped amplitude — the normal
  // invalid case falls back to 0.30 rather than degrading the curve silently.
  if (scoringWeights.recencyHead < scoringWeights.recency) {
    scoringWeights.recencyHead = Math.max(
      SCORING_DEFAULTS.recencyHead,
      scoringWeights.recency
    );
  }
  return { ...scoringWeights };
}

/** Current resolved weights (tests + status output). */
export function getScoringWeights(): ScoringWeights {
  return { ...scoringWeights };
}

// ---------------------------------------------------------------------------
// Session-intent keying (#192, 0.15.3). ONE calibration constant (#408):
//   SESSION_INTENT_WEIGHT  0.33  blend weight of the rolling centroid in the
//                                search vector: query = (1-w)·prompt + w·centroid.
//                                configureSessionIntent(0) is the eval-only
//                                kill-switch (pure prompt). Range [0, 1].
//
// The EMA rate α is a shipped constant (SESSION_INTENT_ALPHA, 0.4), not a
// second knob — owner directive 0.15.3: one knob is enough to tune/disable;
// exposing α was speculative generality.
//
// The centroid itself lives on SessionRecallRegistry; retrieval only needs to
// ACCEPT a pre-blended query vector (options.queryEmbedding) so the recall
// closure can do the one-embed-per-recall + blend without retrieve()
// re-embedding. /search and other unblended callers omit queryEmbedding and
// get pure-prompt behavior unchanged.
// ---------------------------------------------------------------------------

/** EMA rate for the session-intent centroid: centroid_new = (1-α)·old + α·prompt. */
export const SESSION_INTENT_ALPHA = 0.4;
const SESSION_INTENT_DEFAULT_WEIGHT = CALIBRATION.SESSION_INTENT_WEIGHT;

let sessionIntentWeight = SESSION_INTENT_DEFAULT_WEIGHT;

/**
 * Configure session-intent keying for THIS process (the eval/test seam —
 * #408). Production calls this with no argument: the calibration weight
 * (calibration.ts SESSION_INTENT_WEIGHT) applies. `weight` is [0,1] (0 =
 * disabled — the eval kill-switch); invalid/out-of-range values keep the
 * shipped default. Returns `{ weight, alpha }` — alpha is the fixed constant,
 * surfaced so the recall closure passes it to the registry in one call.
 */
export function configureSessionIntent(
  weight?: number
): { weight: number; alpha: number } {
  const v = Number(weight);
  sessionIntentWeight =
    Number.isFinite(v) && v >= 0 && v <= 1 ? v : SESSION_INTENT_DEFAULT_WEIGHT;
  return { weight: sessionIntentWeight, alpha: SESSION_INTENT_ALPHA };
}

/** Current resolved session-intent weight + the shipped alpha (closure + tests). */
export function getSessionIntent(): { weight: number; alpha: number } {
  return { weight: sessionIntentWeight, alpha: SESSION_INTENT_ALPHA };
}

/**
 * Blend the prompt embedding with the session-intent centroid for the vector
 * search: `query = l2Normalize((1-w)·prompt + w·centroid)`. Returns the prompt
 * UNCHANGED when `centroid` is undefined (first turn — no behavior change) or
 * `weight` is 0 (the kill-switch — pure prompt). Extracted from the
 * /recall-index closure (mcp-server.ts) so the exact blend decision is
 * unit-testable directly, locking the ternary against a refactor without a
 * closure-integration harness.
 */
export function blendQueryVector(
  promptEmb: Float32Array,
  centroid: Float32Array | undefined,
  weight: number
): Float32Array {
  return centroid && weight > 0
    ? l2Normalize(weightedAdd(promptEmb, 1 - weight, centroid, weight))
    : promptEmb;
}

/**
 * The /recall-index closure's PER-CALL search-vector decision (#199 + #324),
 * extracted next to blendQueryVector (same precedent: the exact decision must
 * be unit-testable without a closure-integration harness).
 *
 *   - purePrompt (#324 novelty floor): return the prompt embedding UNBLENDED
 *     and touch NO centroid state — neither read nor the EMA fold. The folded
 *     turn is owned by the blended call; a second fold here would double-count
 *     the prompt and skew every later turn's blend (the single worst
 *     regression this extraction exists to lock out).
 *   - blended (default): read the prior centroid (weight>0 only), blend, then
 *     fold this turn's prompt ONCE (weight>0 only) — read-before-update so
 *     turn 1 searches pure and seeds the centroid for turn 2.
 *
 * `registry` is the structural surface needed (SessionRecallRegistry
 * satisfies it) — keeps this module decoupled from the registry class.
 */
export interface CentroidStore {
  getCentroid(sessionId: string): Float32Array | undefined;
  updateCentroid(
    sessionId: string,
    promptEmbedding: Float32Array,
    alpha: number
  ): Float32Array;
}

export function recallQueryVector(
  registry: CentroidStore,
  sessionId: string,
  promptEmb: Float32Array,
  opts: { weight: number; alpha: number; purePrompt?: boolean }
): Float32Array {
  if (opts.purePrompt) return promptEmb;
  // weight=0 (kill-switch): the centroid is neither read nor written.
  const centroid = opts.weight > 0 ? registry.getCentroid(sessionId) : undefined;
  const queryVec = blendQueryVector(promptEmb, centroid, opts.weight);
  if (opts.weight > 0) registry.updateCentroid(sessionId, promptEmb, opts.alpha);
  return queryVec;
}

/**
 * Ids among `candidateIds` that have been superseded by a later memory — i.e.
 * they are the SOURCE of a `superseded_by` link (stageSupersession links
 * old → new). One query, not per-candidate.
 */
export function findSupersededIds(
  db: Database.Database,
  candidateIds: string[]
): Set<string> {
  if (candidateIds.length === 0) return new Set();
  const placeholders = candidateIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT DISTINCT source_id FROM memory_links
        WHERE relationship = 'superseded_by' AND source_id IN (${placeholders})`
    )
    .all(...candidateIds) as Array<{ source_id: string }>;
  return new Set(rows.map((r) => r.source_id));
}

/**
 * The full ranking-demotion set among `candidateIds` (#384): the UNION of
 * (a) sources of a `superseded_by` link (legacy + stageSupersession — link
 * driven, works on pre-v14 rows with NULL status) and (b) rows whose
 * `memories.status` is 'superseded' or 'retracted' (reconsolidation marks +
 * explicit ingest marks). `corrected` is deliberately NOT demoting — a
 * rewritten memory carries the CORRECTION, and demoting it would bury the
 * fix (the exact failure reconsolidation exists to repair). `absorbed` needs
 * no entry here: absorbed rows have no vector/FTS row and are filtered at
 * candidacy. One batched query, both call sites (retrieve + searchRecent).
 * Byte-identical behavior for memories with no correction relationship
 * (NULL status, no link) — they never match either arm.
 */
export function findDemotedIds(
  db: Database.Database,
  candidateIds: string[]
): Set<string> {
  if (candidateIds.length === 0) return new Set();
  const placeholders = candidateIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT DISTINCT id FROM (
         SELECT source_id AS id FROM memory_links
          WHERE relationship = 'superseded_by' AND source_id IN (${placeholders})
         UNION
         SELECT id FROM memories
          WHERE status IN ('superseded', 'retracted') AND id IN (${placeholders})
       )`
    )
    .all(...candidateIds, ...candidateIds) as Array<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}

// ---------------------------------------------------------------------------
// Belief walk (#393 increment D)
// ---------------------------------------------------------------------------

/**
 * Hop cap for the belief walk (#393 D). Supersession edges advance
 * created_at monotonically (the stage only links old → new), so chains are
 * acyclic by construction and 10 hops is far beyond any real revision depth;
 * the cap is cheap insurance (see beliefWalkTerminal for why it is needed
 * anyway).
 */
export const BELIEF_WALK_MAX_HOPS = 10;

/**
 * The one outgoing supersession edge to follow from `id` (#393 D): when a
 * memory carries several `superseded_by` edges the NEWEST target by
 * created_at wins (deterministic target_id tie-break), null when there is
 * none. Indexed by idx_links_source; one row read.
 */
function nextSupersedingId(db: Database.Database, id: string): string | null {
  const row = db
    .prepare(
      `SELECT ml.target_id AS target_id
         FROM memory_links ml
         JOIN memories m ON m.id = ml.target_id
        WHERE ml.source_id = ? AND ml.relationship = 'superseded_by'
        ORDER BY m.created_at DESC, ml.target_id ASC
        LIMIT 1`
    )
    .get(id) as { target_id: string } | undefined;
  return row ? row.target_id : null;
}

/**
 * Terminal of the supersession chain starting at `id` (#393 D): follow
 * superseded_by edges transitively until a memory with no outgoing edge and
 * return it — `id` itself when there is nothing to walk, or whichever node
 * the walk stopped on when it aborts. Shared by retrieval (the belief-walk
 * splice in retrieve()/searchRecent()) and the eval harness (the
 * planted-pairs version_chain class probe), so both agree on what "the
 * chain's current truth" is.
 *
 * Edges advance created_at monotonically (acyclic by construction), BUT
 * applyExplicitMark does no age check and created_at is backdatable from
 * session_date — so a cycle or an absurdly long chain is not impossible.
 * The visited set (seeded with `id`) and the BELIEF_WALK_MAX_HOPS cap are
 * cheap insurance against exactly that; the supersededDemotion multiplier
 * in computeScore remains the safety net for rows the walk does not fully
 * resolve (no edge, cycle, cap abort, absorbed terminal).
 */
export function beliefWalkTerminal(
  db: Database.Database,
  id: string,
  maxHops = BELIEF_WALK_MAX_HOPS
): string {
  const visited = new Set([id]);
  let current = id;
  for (let hop = 0; hop < maxHops; hop++) {
    const next = nextSupersedingId(db, current);
    if (next === null || visited.has(next)) return current;
    visited.add(next);
    current = next;
  }
  return current;
}

/**
 * The belief-walk splice (#393 D) — the retrieval-side half of "newest wins
 * by construction". Applied to the FINAL top-k of retrieve()/searchRecent(),
 * after the sort and after the cold-exposure splice: a superseded candidate
 * is replaced IN ITS SLOT by its chain's terminal (beliefWalkTerminal), so a
 * strong stale record can never outrank — or appear alongside — the truth
 * that replaced it. The ancestor stays fetchable by id (evidence) but never
 * surfaces as a competing truth in recall.
 *
 * Per entry of `top`, in order:
 *   - not superseded            → kept untouched (fast path, zero queries)
 *   - terminal === entry        → kept (no outgoing edge — the entry is its
 *                                 own terminal; a self-loop aborts here too.
 *                                 A hop-cap or non-self-cycle abort stops the
 *                                 walk on a DIFFERENT node, so the entry
 *                                 falls through to the bullets below — e.g.
 *                                 a 2-cycle with both members in top drops
 *                                 both, conservative but nothing stale
 *                                 surfaces (corrupt-data corner only; edges
 *                                 advance created_at, acyclic by
 *                                 construction). supersededDemotion in
 *                                 computeScore stays the safety net for rows
 *                                 the walk does not resolve)
 *   - terminal already surfaced → the entry is DROPPED (its truth is present)
 *   - otherwise                 → buildReplacement(terminal); null (terminal
 *                                 unfetchable or absorbed — absorbed rows
 *                                 are invisible to recall by contract) keeps
 *                                 the ancestor in-slot, fail-soft
 *
 * The replacement takes the ancestor's SLOT (position), not its score — no
 * re-sort after the splice; ranking remains the sort's verdict. Idempotent
 * by construction: walk-stable and unsuperseded entries are returned as-is.
 */
function applyBeliefWalk<T extends { mem: Memory }>(
  db: Database.Database,
  top: T[],
  supersededIds: Set<string>,
  buildReplacement: (terminalId: string) => T | null
): T[] {
  const present = new Set(top.map((t) => t.mem.id));
  const out: T[] = [];
  for (const entry of top) {
    if (!supersededIds.has(entry.mem.id)) {
      out.push(entry);
      continue;
    }
    const terminal = beliefWalkTerminal(db, entry.mem.id);
    if (terminal === entry.mem.id) {
      out.push(entry);
      continue;
    }
    if (present.has(terminal)) {
      // The chain's truth is already surfaced — drop the ancestor.
      continue;
    }
    const replacement = buildReplacement(terminal);
    if (replacement === null) {
      out.push(entry);
      continue;
    }
    out.push(replacement);
    present.add(terminal);
  }
  return out;
}

/**
 * Placeholder L2 distance for candidates that have no measured vector
 * distance (FTS-only hits and graph-discovered neighbors). Chosen so that
 * l2ToCosine(1.0) = 0.5 — a neutral mid-scale similarity. Before the #145
 * fix the value was 0.5 on the accidental 1−L2 scale, which also yielded
 * similarity 0.5; keeping 0.5 under the corrected formula would have jumped
 * these candidates to cosine 0.875, outranking most true vector matches.
 */
const DEFAULT_GRAPH_DISTANCE = 1.0;
// RRF_K is no longer a module constant (#205): it lives in scoringWeights.rrfK
// (default 60, the pre-#205 hardcoded value) and is read at every retrieve()
// call so config changes apply without a restart. The DEFAULT_RRF_K here is a
// fallback for reciprocalRankFusion's optional k argument (tests + the rare
// non-retrieve caller), NOT the production path.
const DEFAULT_RRF_K = 60;

/**
 * Convert an L2 distance (as returned by sqlite-vec's vec0 `distance`) to
 * cosine similarity. Valid because our embeddings are L2-normalized
 * (embedder.ts, `normalize: true`): for unit vectors, d² = 2 − 2·cos,
 * hence cos = 1 − d²/2. Exact anchors: d=0 → 1, d=√2 → 0, d=2 → −1.
 *
 * Lives here (the dependency-root of the scoring code) and is re-exported
 * by consolidate.ts so pre-#145 importers keep working.
 */
export function l2ToCosine(distance: number): number {
  return 1 - (distance * distance) / 2;
}

/**
 * Cosine similarity between two stored embeddings (#393 increment B). The
 * similarity source measures cosines transitively via vec0 L2 distances; the
 * scout source finds its candidates through FTS (no vec0 query), so it
 * measures the pair cosine directly from the stored vectors instead —
 * valid because every embedding we store is L2-normalized (embedder.ts).
 * Used as link strength / a ranker, never as a gate (the scout has no
 * similarity floor — that is the point of the increment).
 */
export function cosineBetweenVectors(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

// ---------------------------------------------------------------------------
// Timestamp parsing
// ---------------------------------------------------------------------------

function parseTimestamp(ts: string | null): Date {
  if (!ts) return new Date();
  try {
    const dt = new Date(ts);
    if (isNaN(dt.getTime())) return new Date();
    return dt;
  } catch {
    return new Date();
  }
}

// ---------------------------------------------------------------------------
// Scoring helpers
// ---------------------------------------------------------------------------

/**
 * Compute decayed strength with adaptive decay (B+D model).
 * Exported for use by consolidation decay/prune stage.
 *
 * #425 read-side law: the decay-relevant importance is CLAMPED at the
 * release-managed ceiling (calibration.ts IMPORTANCE_CEILING) — at importance
 * exactly 1.0 the decay rate is exactly 1.0 and the row never decays, so
 * legacy base-1.0 rows (and any write site that predates the cap) decay
 * again. The clamp applies to explicit importance passes too.
 *
 * #448: the access/connectivity HARDENING terms are REMOVED — the fade rate
 * no longer depends on access or link history (a briefly-used memory was
 * near-immortal: 10 accesses cut the decay rate to 3% of normal). Real use
 * now raises the STORED score via the nightly promotion stage
 * (consolidate.ts stagePromotion) instead of slowing future decay, so a
 * promoted-then-abandoned memory fades on the same 365-day clock as any
 * other, from a higher anchor.
 */
export function effectiveStrength(
  baseStrength: number,
  lastAccessed: string | null,
  now: Date,
  options?: {
    importance?: number;
  }
): number {
  const rawImportance = options?.importance ?? baseStrength;
  const importance = Math.min(rawImportance, CALIBRATION.IMPORTANCE_CEILING);

  const hours = Math.max(
    (now.getTime() - parseTimestamp(lastAccessed).getTime()) / 3_600_000,
    0
  );

  // B: Importance slows decay
  const decayRate = 1.0 - BASE_DECAY * (1.0 - importance);

  // D: Asymptotic floor
  const floor = baseStrength * importance * 0.1;

  return floor + (baseStrength - floor) * Math.pow(decayRate, hours);
}

/**
 * #430 merged time curve — ONE additive score term, two timescales. The
 * pre-#430 pair (slow recency blend + linear fresh-memory bonus) is now a
 * single piecewise exponential: a steep head with amplitude `recencyHead` at
 * age 0, joined value-continuously onto the unchanged slow curve at
 * `recencyHeadDays`. The head rate is DERIVED from value-continuity at the
 * join (never a free constant), so the join cannot be mis-tuned and the eval
 * seam retunes it automatically.
 *
 * A memory is born highly available and settles into the normal ranking over
 * the head window. Age is measured from created_at, which the nightly sets
 * from the session's own date — so a session captured last night ranks as
 * ~1 day old (not 0), and backfilled older content correctly gets no head.
 * The slow tail alone (≈58-day half-life at weight 0.15) could never lift a
 * day-old memory past an old high-strength one — measured case: an
 * exact-match 1-day-old memory (strength 0.50) lost to an unrelated memory
 * at strength 0.80. That job is now the head's, so ranking among memories
 * that are all old (at or beyond the join) is untouched.
 */
function timeScore(hoursSinceCreated: number, hasCreatedAt: boolean): number {
  const w = scoringWeights;
  // Zero slow weight disables the WHOLE term (the term-isolation semantics
  // the tests rely on). Also the NaN guard: with w.recency = 0 the derived
  // head rate is ln(0)/join = −Inf and exp(−Inf · 0) = NaN at age 0.
  if (w.recency === 0) return 0;
  // Absent created_at keeps the pre-#430 behavior exactly: the slow term at
  // its age-0 value, no head. The guard is TRUTHINESS (the pre-#430 freshness
  // guard was `memory.created_at && …`), so an empty string counts as absent
  // too — and parseTimestamp("") falls back to now just like null (hours 0 →
  // pow(·, 0) = 1 → exactly the slow weight).
  if (!hasCreatedAt) return w.recency;
  const joinHours = w.recencyHeadDays * 24;
  // The boundary belongs to the slow branch — at and beyond the join the
  // expression is bit-identical to the pre-#430 slow term (IEEE754
  // multiplication is commutative, so the operand order vs the old
  // `recency * w.recency` is float-identical).
  if (joinHours <= 0 || hoursSinceCreated >= joinHours) {
    return w.recency * Math.pow(CALIBRATION.RECENCY_HOURLY_DECAY, hoursSinceCreated);
  }
  // Head branch (created_at present, 0 ≤ hours < joinHours): amplitude
  // w.recencyHead decaying at the continuity-derived rate (≈ −0.004626/h —
  // head half-life ≈ 6.24 d at the shipped constants).
  const headRate =
    Math.log(
      (w.recency * Math.pow(CALIBRATION.RECENCY_HOURLY_DECAY, joinHours)) / w.recencyHead
    ) / joinHours;
  return w.recencyHead * Math.exp(headRate * hoursSinceCreated);
}

/**
 * Return a composite relevance score in [0, 1] for a candidate memory.
 * Exported for exact-value tests of the similarity component (#145).
 *
 * Scope affinity (options.scope + options.tagWeights; #203, merged #430):
 * ONE additive, graded, zero-boost-neutral term — max() of the project-match
 * indicator (exact match ⇒ 1) and the max overlapping memory_tags.weight,
 * × the scopeAffinity weight. It is 0 when the scope is absent
 * (byte-identical to pre-#203) and NEVER negative (a foreign memory adds 0,
 * never a penalty — penalties re-introduce soft-exclusion). See
 * `AffinityScope`.
 */
export interface AffinityScope {
  /** Exact-match project from the client (CC/OC cwd-derived; /search project). */
  project?: string | null;
  /** Hermes mission domains declared in plugin config. Drawn from the same
   *  vocabulary as memory_tags (config `domains`). */
  missionDomains?: string[];
}

export function computeScore(
  memory: Memory,
  distance: number,
  connectionCount: number,
  now: Date,
  options?: {
    superseded?: boolean;
    /** #203/#430: when present, the scope-affinity boost is applied. */
    scope?: AffinityScope;
    /** Candidate's graded domain tags (memory_tags rows). Loaded batched for
     *  the whole candidate set in retrieve(); used for the scope-affinity
     *  term's domain signal. */
    tagWeights?: Array<{ tag: string; weight: number | null }>;
    /** #425: the candidate was matched by BOTH retrieval channels (vector
     *  KNN AND BM25 FTS) — the genuine-match signature. Adds the
     *  release-managed bothChannelBoost (zero-boost neutral). */
    bothChannel?: boolean;
  }
): number {
  // TRUE cosine similarity (#145). The old `1 − distance` compressed real
  // cosines (cos 0.8 scored 0.37) and the 0-clamp at that scale flattened
  // everything below cos 0.5 to exactly 0, killing mid-relevance
  // discrimination. The clamp stays at 0 — a negative cosine means truly
  // unrelated — but now at the correct scale. NOTE: the similarity values
  // roughly DOUBLE for related content on the new scale; the blend weights
  // below are deliberately unchanged in this pass so the before/after
  // retrieval comparison is measured, not guessed. Rebalancing the weights
  // is a data-driven follow-up if the eval shows it is needed.
  const similarity = Math.max(0, l2ToCosine(distance));
  const effStrength = effectiveStrength(
    memory.base_strength ?? 0.5,
    memory.last_accessed,
    now,
    {
      // #425: importance passed EXPLICITLY (the same default value
      // effectiveStrength would apply — base strength IS importance at read
      // time — now stated at the call site so the triple-win coupling
      // (score share, decay rate, floor) is visible and single-sourced).
      importance: memory.base_strength ?? 0.5,
    }
  );
  const hoursSinceCreated = Math.max(
    (now.getTime() - parseTimestamp(memory.created_at).getTime()) / 3_600_000,
    0
  );

  const w = scoringWeights;
  // #449 (PR E, items 1+3): LOG-SATURATING connection credit on the
  // ABSOLUTE degree scale — min(1, log1p(k)/log1p(K)), K = the resolved
  // connectionsSaturation (default 16, the p99 of the real undirected
  // degree distribution; calibration.ts carries the provenance). Shape per
  // the #449 research base: ACT-R fan saturation (Anderson & Reder 1999 —
  // activation falls with the LOG of fan, not linearly), SAM's saturating
  // returns, cue overload (Watkins & Watkins 1975) — returns per
  // additional link compress, and the top ~1% of hubs tie at full credit.
  // This REPLACED the pre-#449 candidate-set normalization
  // (connectionCount / maxConnections), which is deleted from this
  // signature and every call site: a row's score no longer depends on
  // which OTHER rows happened to match (set-relative scores were not
  // reproducible, and the ~40-degree global hubs sat in nearly every
  // 2-hop neighborhood — per-query max p50 = 36 — so the median linked
  // candidate earned only k/36 of the term). k = 0 contributes exactly +0
  // (log1p(0) = 0): unlinked rows score bit-identically to pre-#449.
  const connScore = Math.min(
    1,
    Math.log1p(connectionCount) / Math.log1p(w.connectionsSaturation)
  );
  let score =
    similarity * w.similarity +
    effStrength * w.strength +
    connScore * w.connections +
    timeScore(hoursSinceCreated, Boolean(memory.created_at));

  // #430 scope affinity (retrieval scoping; born from #203's two boosts).
  // ONE graded, additive term — max() of the strongest single scope signal:
  // the project-match indicator (exact project match ⇒ 1) and the max
  // overlapping domain-tag weight. ZERO when the scope is absent
  // (byte-identical ranking) and ZERO for a non-matching memory (never a
  // penalty). The signals are never stacked — they are largely the same
  // evidence and the domain one is the weaker, so the strongest counts once
  // (single-signal scopes reproduce #203's exact floats). NULL tag weights
  // (not yet computed by the nightly reconsolidation) count as 0 — we never
  // invent a boost from missing association strength. Affinity rides the 0.8
  // composite side only (the RRF 0.2 side is #205 territory and untouched
  // here).
  const scope = options?.scope;
  if (scope) {
    const projectMatch = scope.project && memory.project === scope.project;
    let maxOverlapTagWeight = 0;
    const domains = scope.missionDomains;
    if (domains && domains.length > 0 && options.tagWeights && options.tagWeights.length > 0) {
      const domainSet = domains.length === 1 ? null : new Set(domains);
      for (const tw of options.tagWeights) {
        const overlaps = domainSet ? domainSet.has(tw.tag) : tw.tag === domains[0];
        if (overlaps) {
          const w = tw.weight ?? 0;
          if (w > maxOverlapTagWeight) maxOverlapTagWeight = w;
        }
      }
    }
    score += Math.max(projectMatch ? 1 : 0, maxOverlapTagWeight) * scoringWeights.scopeAffinity;
  }

  // #425 both-channel boost: vector KNN and BM25 FTS AGREEING on a candidate
  // is the genuine-match signature (a distinctive proper noun the user knows
  // exists — the field failure this fixes: 0.90/0.95-strength domain-adjacent
  // memories outranked the best-similarity exact-token match). ADDITIVE,
  // zero-boost neutral, never a penalty; rides the composite side only (like
  // scopeAffinity — the RRF side is #205 territory); applied BEFORE the
  // superseded multiplier so a superseded both-channel row still demotes.
  if (options?.bothChannel) score += scoringWeights.bothChannelBoost;

  // Superseded demotion (#191 Phase B): a memory whose decision was reversed by
  // a later one keeps its content and strength but must not outrank the
  // decision that replaced it. Applied as an explicit multiplier here rather
  // than by penalizing base_strength, so ranking weights stay independently
  // tunable and supersession never nudges a memory toward prune eligibility.
  if (options?.superseded) score *= scoringWeights.supersededDemotion;

  return Math.max(0, Math.min(1, score));
}

// ---------------------------------------------------------------------------
// Graph traversal
// ---------------------------------------------------------------------------

/**
 * #466 — truth-management relationships that never pay connection credit.
 * A superseded/corrected memory remains part of its knowledge neighborhood
 * as EVIDENCE, but the administrative edge itself is not a semantic
 * connection: "this memory was replaced" must not add ranking credit to the
 * memory it replaced. Scoped to exactly the #463 audit's administrative set
 * (`superseded_by`, `corrected_by`); every semantic edge — `extends`,
 * `relates_to`, and the legacy vocabulary — still counts. Graph traversal
 * (frontier expansion below, the belief walk, /graph queries) is untouched:
 * those are discovery mechanisms, and only the credit stops.
 */
const ADMIN_RELATIONSHIPS = new Set(["superseded_by", "corrected_by"]);

function collectLinks(
  db: Database.Database,
  seedIds: string[],
  maxHops = 2
): Map<string, number> {
  const visited = new Set(seedIds);
  const connectionCounts = new Map<string, number>();
  let frontier = new Set(seedIds);

  for (let hop = 0; hop < maxHops; hop++) {
    const nextFrontier = new Set<string>();
    for (const mid of frontier) {
      const links = storage.getLinks(db, mid, "both");
      // #466: the degree feeding computeScore's connections term counts
      // semantic edges only — administrative edges do not pay credit.
      const count = links.filter(
        (l) => !ADMIN_RELATIONSHIPS.has(l.relationship)
      ).length;
      connectionCounts.set(
        mid,
        (connectionCounts.get(mid) ?? 0) + count
      );
      for (const link of links) {
        const linkedId =
          link.source_id === mid ? link.target_id : link.source_id;
        if (linkedId && !visited.has(linkedId)) {
          visited.add(linkedId);
          nextFrontier.add(linkedId);
        }
      }
    }
    frontier = nextFrontier;
    if (frontier.size === 0) break;
  }

  // Ensure newly discovered nodes also have a connection count
  for (const mid of visited) {
    if (!connectionCounts.has(mid)) {
      const links = storage.getLinks(db, mid, "both");
      connectionCounts.set(mid, links.filter(
        (l) => !ADMIN_RELATIONSHIPS.has(l.relationship)
      ).length);
    }
  }

  return connectionCounts;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatResult(
  memory: Memory,
  score: number,
  effStr: number,
  connections: number,
  provenance?: { similarity: number | null; source: MemorySearchResult["source"] }
): MemorySearchResult {
  return {
    id: memory.id,
    content: memory.content ?? "",
    score: Math.round(score * 1e6) / 1e6,
    effective_strength: Math.round(effStr * 1e6) / 1e6,
    access_count: memory.access_count ?? 0,
    memory_type: labelForType(memory.memory_type ?? "experience"),
    project: memory.project ?? null,
    source_agent: memory.source_agent ?? null,
    created_at: memory.created_at ?? "",
    connections,
    similarity: provenance ? provenance.similarity : undefined,
    source: provenance ? provenance.source : undefined,
  };
}

// ---------------------------------------------------------------------------
// Strengthening
// ---------------------------------------------------------------------------

function strengthen(
  db: Database.Database,
  memories: Memory[],
  now: Date
): void {
  const nowIso = now.toISOString();
  for (const mem of memories) {
    if (!mem.id) continue;
    try {
      storage.strengthenMemory(db, mem.id, nowIso);
    } catch {
      // Non-fatal — log would be ideal but we keep going
    }
  }
}

// ---------------------------------------------------------------------------
// Reciprocal Rank Fusion
// ---------------------------------------------------------------------------

/**
 * Reciprocal Rank Fusion (#205 per-list weights).
 *
 * Each list contributes `weight / (k + rank + 1)` per item. The pre-#205 form
 * (symmetric 1.0 weight on every list) is recovered by omitting `weight`:
 * `{ ids }` defaults to weight 1.0 — so callers that don't care about per-list
 * rebalancing (tests, alternative uses) keep working unchanged.
 *
 * Per-list weights are the #205 lever for "nudging toward vector": FTS was
 * winning cross-scope collisions on raw token overlap (marine "battery" beat
 * hardware "battery" because the marine row had a tighter token match), so the
 * shipped default drops FTS to 0.5 while vector stays at 1.0 (0.7 was too
 * timid — Q4 marine contamination persisted; see SCORING_DEFAULTS). The composite
 * score (which carries the #203 affinity boost) then breaks the tie in scope.
 */
function reciprocalRankFusion(
  rankedLists: Array<{ ids: string[]; weight?: number }>,
  k = DEFAULT_RRF_K
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of rankedLists) {
    const w = list.weight ?? 1.0;
    for (let rank = 0; rank < list.ids.length; rank++) {
      const mid = list.ids[rank];
      scores.set(mid, (scores.get(mid) ?? 0) + w / (k + rank + 1));
    }
  }
  return scores;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface EmbedFn {
  (text: string): Promise<Float32Array>;
}

/**
 * Main retrieval: BM25 + vector search with RRF fusion, graph traversal,
 * and composite scoring. Strengthens accessed memories.
 *
 * #203 retrieval scoping: `project` and `missionDomains` are SOFT affinity
 * terms in computeScore (zero-boost neutral, never a penalty), NOT filters.
 * `privacy` is NOT a filter (0.16.x: the column is fully vestigial — stored,
 * never filtered; the distiller no longer sets it and retrieval ignores it
 * entirely). `sourceAgent` remains a hard filter (kept for completeness; no
 * production caller currently passes it). When neither project nor
 * missionDomains is sent, scoring is byte-identical to pre-#203 — the
 * kill-switch / no-op guarantee.
 */
export async function retrieve(
  db: Database.Database,
  embedFn: EmbedFn,
  query: string,
  options?: {
    limit?: number;
    /** #203: soft project affinity (exact match boost in computeScore).
     *  Formerly a hard WHERE filter (#192); softening removes cross-scope
     *  starvation without excluding anything. */
    project?: string | null;
    sourceAgent?: string;
    /** #203: Hermes mission domains (declared in plugin config). Soft domain
     *  affinity in computeScore via max overlapping memory_tags.weight. */
    missionDomains?: string[];
    /** #192: skip access strengthening — for pushed recall (/recall-index),
     *  where appearing in results must not count as use. */
    noStrengthen?: boolean;
    /** #192 session-intent keying (0.15.3): a pre-computed query embedding
     *  (e.g. the session-centroid blend from the /recall-index closure). When
     *  provided, the internal embed() call is SKIPPED — the caller owns the
     *  one embed per recall. /search and other unblended callers omit this
     *  and get pure-prompt behavior (the query string is embedded here). The
     *  FTS path still uses the raw `query` text regardless. */
    queryEmbedding?: Float32Array;
    /** #329 CR finding 1b: caller-provided FTS candidate resolution, called
     *  INSTEAD of running storage.searchFts here. The /recall-index closure
     *  passes a per-request memoized provider so the blended and pure
     *  searches of ONE request — same query text, same candidate window —
     *  execute the FTS half exactly once and share the list. The provider
     *  receives the fetchLimit/sourceAgent THIS call would have used, so the
     *  shared list is always computed with the right window. Callers that
     *  omit it get the previous behavior (retrieve runs searchFts itself). */
    ftsCandidates?: (
      fetchLimit: number,
      sourceAgent?: string
    ) => Array<Memory & { rank: number }>;
    /** #458 eval clock pin — the instant the decay/recency terms score
     *  against. Eval-only: no production caller passes it, and unset means
     *  the live clock (byte-identical to pre-#458). Mirrors the
     *  injectable-clock idiom of run-deadline.ts; see eval/eval-clock.ts. */
    now?: Date;
  }
): Promise<MemorySearchResult[]> {
  const limit = options?.limit ?? recallDefaults.searchLimit;
  const project = options?.project;
  const sourceAgent = options?.sourceAgent;
  const missionDomains = options?.missionDomains;
  const now = options?.now ?? new Date();

  // #203 affinity scope — passed to computeScore for every candidate. Built
  // once; absent fields yield no boost (zero-boost neutral).
  const scope: AffinityScope | undefined =
    project || (missionDomains && missionDomains.length > 0)
      ? { project: project ?? undefined, missionDomains }
      : undefined;

  // 1. Embed — or reuse the caller-provided vector (session-intent blend).
  const queryEmbedding = options?.queryEmbedding ?? (await embedFn(query));

  // 2. Dual retrieval — vector + BM25.
  // #192: sqlite-vec can't push filters into the KNN, so filtered queries must
  // over-fetch — the old flat limit*3 intersected a global top-15 with (for the
  // median project) ~1% of the corpus, starving every filtered query.
  // #203: project is NO LONGER a filter (soft affinity now), so it does not
  // trigger over-fetch; only sourceAgent still does (it remains a hard filter).
  // 0.16.x: privacy is no longer a filter either (column is vestigial).
  const filtered = Boolean(sourceAgent);
  const fetchLimit = filtered ? Math.min(limit * 20, 200) : limit * 3;
  let vecCandidates = storage.vectorSearch(db, queryEmbedding, fetchLimit, []);

  let ftsCandidates: Array<Memory & { rank: number }> = [];
  try {
    // sourceAgent is pushed into the FTS SQL (hard filter). project is NOT (it
    // is a soft affinity boost in computeScore as of #203). privacy is NOT
    // (0.16.x: vestigial column, never filtered). With a caller-provided
    // provider (#329 request-level memo) the same list is shared across the
    // retrieves of one recall request instead of re-executed.
    ftsCandidates = options?.ftsCandidates
      ? options.ftsCandidates(fetchLimit, sourceAgent)
      : storage.searchFts(db, query, fetchLimit, sourceAgent);
  } catch {
    // FTS5 search can fail on special characters; fall back to vector-only
  }

  if (vecCandidates.length === 0 && ftsCandidates.length === 0) {
    return [];
  }

  // Post-filter vector candidates (sqlite-vec can't filter). sourceAgent stays
  // a hard filter (see options doc); project is scored not filtered (#203);
  // privacy is no longer filtered (0.16.x — vestigial).
  if (sourceAgent) {
    vecCandidates = vecCandidates.filter(
      (c) => c.source_agent === sourceAgent
    );
  }

  // 3. RRF fusion (#205: per-list weights + config-driven k). The vector list
  // carries the composite-side affinity in the next step, so we let it dominate
  // RRF too — the FTS list is down-weighted to break token-collision ties that
  // the affinity alone cannot reach (marine "battery" vs hardware "battery").
  const vecRanked = vecCandidates.map((c) => c.id);
  const ftsRanked = ftsCandidates.map((c) => c.id);
  const rrfScores = reciprocalRankFusion(
    [
      { ids: vecRanked, weight: scoringWeights.rrfVectorWeight },
      { ids: ftsRanked, weight: scoringWeights.rrfFtsWeight },
    ],
    scoringWeights.rrfK
  );

  // Build unified candidate map (with retrieval-channel provenance, #192)
  const candidateMap = new Map<
    string,
    { mem: Memory; distance: number; source: MemorySearchResult["source"] }
  >();
  for (const c of vecCandidates) {
    candidateMap.set(c.id, { mem: c, distance: c.distance, source: "vector" });
  }
  for (const c of ftsCandidates) {
    const existing = candidateMap.get(c.id);
    if (existing) {
      existing.source = "both";
    } else {
      candidateMap.set(c.id, { mem: c, distance: DEFAULT_GRAPH_DISTANCE, source: "fts" });
    }
  }

  // 4. Graph traversal
  const seedIds = [...candidateMap.keys()];
  const connectionCounts = collectLinks(db, seedIds, 2);

  // Pull in graph-discovered memories not in the candidate set
  const graphIds = [...connectionCounts.keys()].filter(
    (mid) => !candidateMap.has(mid)
  );
  for (const gid of graphIds) {
    const mem = storage.getMemory(db, gid);
    if (!mem) continue;
    // #384: absorbed memories never enter via the graph either — they keep
    // their link rows (evidence + rollback reference), so graph traversal can
    // reach them, but they are invisible to recall by contract.
    if (mem.status === "absorbed") continue;
    // #203: project check removed — project is a soft affinity in computeScore,
    // not a filter. 0.16.x: privacy check removed — the column is vestigial,
    // never filtered. sourceAgent stays a hard filter.
    if (sourceAgent && mem.source_agent !== sourceAgent) continue;
    candidateMap.set(gid, { mem, distance: DEFAULT_GRAPH_DISTANCE, source: "graph" });
  }

  // 5. Compute composite scores (the connections term reads each row's own
  // degree only — #449 deleted the candidate-set-max normalization: a
  // row's score no longer depends on which other rows matched).
  const scored: Array<{
    mem: Memory;
    finalScore: number;
    effStr: number;
    connCount: number;
    similarity: number | null;
    source: MemorySearchResult["source"];
  }> = [];

  const maxRrf = Math.max(
    ...([...rrfScores.values()].length > 0 ? [...rrfScores.values()] : [1])
  );

  // One query for the whole candidate set (#191 Phase B): superseded memories
  // are demoted in computeScore rather than strength-penalized. #384: the set
  // is the full demotion set — link-driven supersessions UNION status-marked
  // superseded/retracted rows (see findDemotedIds).
  const supersededIds = findDemotedIds(db, [...candidateMap.keys()]);

  // #203: ONE batched load of every candidate's graded domain tags — fed to
  // computeScore for domain affinity. Only needed when the scope carries
  // missionDomains; absent otherwise (skips the query entirely on /search and
  // other unscoped callers — byte-identical to pre-#203).
  const tagWeightsByMemory =
    scope?.missionDomains && scope.missionDomains.length > 0
      ? storage.getMemoryTagsWeightedBatched(db, [...candidateMap.keys()])
      : undefined;

  for (const [mid, { mem, distance, source }] of candidateMap) {
    const connCount = connectionCounts.get(mid) ?? 0;
    const composite = computeScore(mem, distance, connCount, now, {
      superseded: supersededIds.has(mid),
      scope,
      tagWeights: tagWeightsByMemory?.get(mid),
      // #425: the two retrieval channels agreeing is the genuine-match
      // signature — graph-only and single-channel candidates add nothing.
      bothChannel: source === "both",
    });
    const effStr = effectiveStrength(mem.base_strength ?? 0.5, mem.last_accessed, now);

    const rrf = rrfScores.get(mid) ?? 0;
    const normalizedRrf = maxRrf > 0 ? rrf / maxRrf : 0;
    // #205: composite/RRF blend is now config-driven (rrfCompositeWeight, 0.8
    // default = pre-#205 behavior). The RRF share is the complement so the two
    // always sum to 1.0 — the knob tunes the BALANCE, not the total.
    const compositeWeight = scoringWeights.rrfCompositeWeight;
    const finalScore = composite * compositeWeight + normalizedRrf * (1 - compositeWeight);

    // Measured cosine only for vector-matched candidates; FTS/graph hits carry
    // the neutral placeholder distance, which is not a real similarity.
    const similarity =
      source === "vector" || source === "both"
        ? Math.round(l2ToCosine(distance) * 1e6) / 1e6
        : null;

    scored.push({ mem, finalScore, effStr, connCount, similarity, source });
  }

  // 6. Sort and take top N — with cold-exposure slots (#192).
  // Effective strength + the promotion stage (#448) make past winners
  // self-reinforcing:
  // 88% of the production corpus had never been returned by any query. Reserve
  // up to 2 of k for the best-scoring never-accessed candidates so the long
  // tail gets nonzero exposure whenever it is semantically in range. Slots are
  // only "reserved" when cold candidates exist; otherwise the top-k is the
  // plain score order.
  scored.sort((a, b) => b.finalScore - a.finalScore);
  const coldSlots = limit >= 4 ? recallDefaults.coldExposureSlots : 0;
  let top = scored.slice(0, limit);
  if (coldSlots > 0 && scored.length > limit) {
    const coldInTop = top.filter((t) => (t.mem.access_count ?? 0) === 0).length;
    const wanted = coldSlots - coldInTop;
    if (wanted > 0) {
      const coldExtras = scored
        .slice(limit)
        .filter((t) => (t.mem.access_count ?? 0) === 0)
        .slice(0, wanted);
      if (coldExtras.length > 0) {
        top = [...top.slice(0, limit - coldExtras.length), ...coldExtras];
      }
    }
  }

  // 6b. Belief walk (#393 D) — a superseded top-k member is replaced in-slot
  // by its chain's terminal. A terminal already in `scored` reuses its honest
  // entry (similarity/RRF/score); one outside the candidate set is computed
  // fresh with source "graph" and RRF share 0 (it entered by LINK, not by any
  // retrieval channel — finalScore = composite × rrfCompositeWeight only).
  // The strengthen() below then fires on the SURFACED set: the terminal
  // accrues the use signal, the dropped ancestor does not. supersededDemotion
  // in computeScore stays as the safety net for rows the walk does not reach.
  const scoredById = new Map(scored.map((s) => [s.mem.id, s]));
  top = applyBeliefWalk(db, top, supersededIds, (terminalId) => {
    const existing = scoredById.get(terminalId);
    if (existing) return existing;
    const mem = storage.getMemory(db, terminalId);
    if (!mem || mem.status === "absorbed") return null; // fail-soft
    // Hard-filter invariant (#393 D): sourceAgent is the one hard filter left
    // in retrieve(), and the walk must not bypass it — a terminal authored by
    // a different agent never slips into recall through its link entry
    // (mirrors the graph pull-in guard above; fail-soft: the ancestor keeps
    // its slot, demoted).
    if (sourceAgent && mem.source_agent !== sourceAgent) return null;
    const connCount = storage.getLinks(db, terminalId, "both").length;
    const composite = computeScore(
      mem,
      DEFAULT_GRAPH_DISTANCE,
      connCount,
      now,
      { superseded: supersededIds.has(terminalId) }
    );
    const finalScore = composite * scoringWeights.rrfCompositeWeight;
    const effStr = effectiveStrength(mem.base_strength ?? 0.5, mem.last_accessed, now);
    return { mem, finalScore, effStr, connCount, similarity: null, source: "graph" as const };
  });

  const results = top.map((t) =>
    formatResult(t.mem, t.finalScore, t.effStr, t.connCount, {
      similarity: t.similarity,
      source: t.source,
    })
  );

  // 7. Strengthen — skipped for pushed recall (#192): appearing in a pushed
  // index is exposure, not use; the /recall-index path records shown_count +
  // last_accessed via storage.touchMemoriesShown instead.
  if (!options?.noStrengthen) {
    strengthen(db, top.map((t) => t.mem), now);
  }

  return results;
}

/**
 * Get recent context, optionally filtered by project.
 */
export function searchRecent(
  db: Database.Database,
  options?: {
    project?: string | null;
    limit?: number;
  }
): MemorySearchResult[] {
  const limit = options?.limit ?? recallDefaults.recentLimit;
  const project = options?.project;
  const now = new Date();

  // #192 breadth: 30 → 180-day default window (config recentWindowDays).
  // "Recent" for a long-lived corpus is a season, not a month; the narrow
  // window kept queryless recall re-serving the same few weeks.
  let candidates = storage.getRecentMemories(db, recallDefaults.recentWindowDays, limit * 3);

  if (project) {
    candidates = candidates.filter((c) => c.project === project);
  }
  // 0.16.x: privacy filter removed — the column is vestigial, never filtered.
  if (candidates.length === 0) return [];

  const allIds = candidates.map((c) => c.id);
  const connectionCounts = collectLinks(db, allIds, 1);

  const scored: Array<{
    mem: Memory;
    score: number;
    effStr: number;
    connCount: number;
  }> = [];

  // #384: same full demotion set as retrieve() — link-driven supersessions
  // UNION status-marked superseded/retracted rows (findDemotedIds).
  const supersededRecent = findDemotedIds(db, candidates.map((c) => c.id));

  for (const mem of candidates) {
    const connCount = connectionCounts.get(mem.id) ?? 0;
    const score = computeScore(mem, DEFAULT_GRAPH_DISTANCE, connCount, now, {
      superseded: supersededRecent.has(mem.id),
    });
    const effStr = effectiveStrength(mem.base_strength ?? 0.5, mem.last_accessed, now);
    scored.push({ mem, score, effStr, connCount });
  }

  scored.sort((a, b) => b.score - a.score);
  let top = scored.slice(0, limit);

  // Belief walk (#393 D) — same contract as retrieve(): a superseded recent
  // memory is replaced in-slot by its chain terminal (this path has no
  // similarity/RRF channels, so a fresh replacement carries the composite
  // score only). The trailing strengthen() runs over the WALKED list — the
  // terminal accrues the use signal, the dropped ancestor does not.
  // supersededDemotion in computeScore stays as the safety net for rows the
  // walk does not reach (no edge, absorbed terminal, cycles/caps).
  top = applyBeliefWalk(db, top, supersededRecent, (terminalId) => {
    const mem = storage.getMemory(db, terminalId);
    if (!mem || mem.status === "absorbed") return null; // fail-soft
    // Hard-filter invariant (#393 D, review fix): project is the one hard
    // filter in searchRecent(), and the walk must not bypass it — supersession
    // edges are discovered corpus-wide (no project predicate), so a terminal
    // in a different project never slips into project-scoped recall through
    // its link entry (mirrors retrieve()'s sourceAgent guard; fail-soft: the
    // ancestor keeps its slot, demoted).
    if (project && mem.project !== project) return null;
    const connCount = storage.getLinks(db, terminalId, "both").length;
    const score = computeScore(
      mem,
      DEFAULT_GRAPH_DISTANCE,
      connCount,
      now,
      { superseded: supersededRecent.has(terminalId) }
    );
    const effStr = effectiveStrength(mem.base_strength ?? 0.5, mem.last_accessed, now);
    return { mem, score, effStr, connCount };
  });

  const results = top.map((t) =>
    formatResult(t.mem, t.score, t.effStr, t.connCount)
  );
  strengthen(db, top.map((t) => t.mem), now);
  return results;
}
