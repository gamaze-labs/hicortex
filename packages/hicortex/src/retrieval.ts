/**
 * Retrieval layer with composite scoring, RRF fusion, and graph traversal.
 * Ported from hicortex/retrieval.py — same scoring model and weights.
 *
 * Scoring model (weights are config-driven since 0.15.2 — see configureScoring):
 *   score = similarity * 0.50 + effective_strength * 0.20
 *         + connection_score * 0.15 + recency * 0.15
 *         + fresh-memory bonus (≤ 0.15, linear over the first 7 days)
 *         then × 0.50 if the memory was superseded by a later decision
 *
 * Decay model (B+E+D):
 *   base_decay = derived from decayHalfLifeDays (config; default 365 → ~1-year
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

/** Default decay half-life (days) at importance 0.5. #192: was 0.0005/h
 *  (~115-day half-life at base 0.5) — aggressive enough to bury the long tail
 *  in ranking. Long-term remembering is the product; time preference stays,
 *  but mild. */
export const DEFAULT_DECAY_HALF_LIFE_DAYS = 365;

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
 * Configure the decay speed from config (`decayHalfLifeDays`). Called at boot
 * by the server and the nightly so both processes score with the same clock.
 * Invalid/absent values keep the default. Exported value for tests.
 */
export function configureDecay(options?: { halfLifeDays?: unknown }): number {
  const days = Number(options?.halfLifeDays);
  BASE_DECAY = decayConstantForHalfLife(
    Number.isFinite(days) && days > 0 ? days : DEFAULT_DECAY_HALF_LIFE_DAYS
  );
  return BASE_DECAY;
}

// ---------------------------------------------------------------------------
// Recall breadth knobs (#192) — all config-tweakable, never hardcoded at call
// sites. Config keys (in ~/.hicortex/config.json) → defaults:
//   searchLimit        → 8    default k for retrieve()
//   recentLimit        → 12   default k for searchRecent()
//   recentWindowDays   → 180  searchRecent() candidate window
//   coldExposureSlots  → 2    top-k slots reservable for never-accessed hits
// ---------------------------------------------------------------------------

interface RecallDefaults {
  searchLimit: number;
  recentLimit: number;
  recentWindowDays: number;
  coldExposureSlots: number;
}

const RECALL_DEFAULTS: RecallDefaults = {
  searchLimit: 8,
  recentLimit: 12,
  recentWindowDays: 180,
  coldExposureSlots: 2,
};

let recallDefaults: RecallDefaults = { ...RECALL_DEFAULTS };

/**
 * Configure recall breadth from config. Called at boot next to
 * configureDecay(); invalid/absent values keep the shipped defaults.
 * Returns the resolved values (for logging + tests).
 */
export function configureRecall(config?: Record<string, unknown> | null): RecallDefaults {
  const pick = (key: keyof RecallDefaults): number => {
    const v = Number(config?.[key]);
    return Number.isFinite(v) && v >= 0 ? Math.floor(v) : RECALL_DEFAULTS[key];
  };
  recallDefaults = {
    searchLimit: Math.max(1, pick("searchLimit")),
    recentLimit: Math.max(1, pick("recentLimit")),
    recentWindowDays: Math.max(1, pick("recentWindowDays")),
    coldExposureSlots: pick("coldExposureSlots"),
  };
  return { ...recallDefaults };
}
// ---------------------------------------------------------------------------
// Composite-score weights + Phase-B ranking knobs (#191). ALL config-driven.
//   scoreSimilarityWeight   0.50  semantic match (was 0.40 — see below)
//   scoreStrengthWeight     0.20  effective strength (was 0.30)
//   scoreConnectionsWeight  0.15  graph centrality (was 0.20)
//   scoreRecencyWeight      0.15  slow recency curve (was 0.10)
//   freshnessBoostDays        7   fresh-memory window length
//   freshnessBoostWeight    0.15  additive bonus at age 0, linear to 0 at edge
//   supersededDemotion      0.50  multiplier for reversed decisions
//   projectAffinityWeight   0.15  #203 soft boost on exact project match
//   domainAffinityWeight    0.15  #203 soft boost on domain-tag overlap
//
//   #205 BM25F + fusion-retune knobs (FTS-side scope):
//   bm25WeightBody          1.0   content-field BM25 weight
//   bm25WeightProject       2.0   project-field BM25 weight (down-weight body,
//   bm25WeightDomain        2.0   domain-field BM25 weight  up-weight scope)
//   rrfK                     60   RRF k parameter (1/(k+rank+1))
//   rrfCompositeWeight      0.8   composite-score share of the final blend
//   rrfFtsWeight            0.5   per-list RRF weight for the FTS list
//   rrfVectorWeight         1.0   per-list RRF weight for the vector list
//
// The rebalance is evidence-driven: on the production corpus, effective
// strength (0.30) outweighed what similarity could recover, so hardened old
// memories beat exact matches — e.g. an unrelated 0.80-strength memory
// outranked the on-topic 0.50-strength one for its own topic. Similarity now
// dominates; strength still breaks ties and rewards real use.
//
// #203 affinity weights are ADDITIVE, zero-boost neutral, and NEVER a penalty:
// absent scope ⇒ both terms are 0 (byte-identical to pre-#203); a foreign
// memory adds 0 (ranks equal, not lower — a penalty would re-introduce the
// soft-exclusion the owner rejected: "no hard filters in brains").
//
// #205 RRF retune nudges toward vector (FTS was winning cross-scope collisions
// on raw token overlap — the marine "battery" memory beating the hardware one
// for "battery temperature compensation"). The per-list RRF weight is the
// conservatively-shipped lever: vec stays at 1.0, FTS drops to 0.5 — enough to
// let composite (which already carries the #203 affinity boost) break the tie,
// not enough to starve keyword search. The eval gates the actual values.
// ---------------------------------------------------------------------------

interface ScoringWeights {
  similarity: number;
  strength: number;
  connections: number;
  recency: number;
  freshnessBoostDays: number;
  freshnessBoostWeight: number;
  supersededDemotion: number;
  /** #203 soft affinity boost on exact project match. */
  projectAffinity: number;
  /** #203 soft affinity boost multiplier on max overlapping domain-tag weight. */
  domainAffinity: number;
  /** #205 RRF k parameter (1/(k+rank+1)). Larger ⇒ shallower rank curve. */
  rrfK: number;
  /** #205 composite-score share of the final blend (RRF gets the remainder). */
  rrfCompositeWeight: number;
  /** #205 per-list RRF weight for the FTS list (BM25-driven candidates). */
  rrfFtsWeight: number;
  /** #205 per-list RRF weight for the vector list (KNN-driven candidates). */
  rrfVectorWeight: number;
}

const SCORING_DEFAULTS: ScoringWeights = {
  similarity: 0.5,
  strength: 0.2,
  connections: 0.15,
  recency: 0.15,
  freshnessBoostDays: 7,
  freshnessBoostWeight: 0.15,
  supersededDemotion: 0.5,
  projectAffinity: 0.15,
  domainAffinity: 0.15,
  // #205 defaults: rrfK + rrfCompositeWeight match the pre-#205 hardcoded
  // values (60 and 0.8) so the no-config path is byte-identical to 0.15.3
  // except for the FTS per-list weight (1.0 → 0.5) — the one deliberate
  // nudge toward vector that the recall-sweep eval gates. The eval showed
  // 0.7 was too timid (Q4 marine contamination persisted) and 0.5 is the
  // bisection point where BM25F + composite-affinity finally flip the
  // token-exact marine body match below the same-scope hardware field
  // (Q4 ON contamination 0.20 → 0.00). 0.5 is still "conservative" — FTS
  // contributes half its RRF share, enough that pure-keyword queries (the
  // focused-family "login/CORS/webhook" turns) keep recall@5 = 1.0.
  rrfK: 60,
  rrfCompositeWeight: 0.8,
  rrfFtsWeight: 0.5,
  rrfVectorWeight: 1.0,
};

let scoringWeights: ScoringWeights = { ...SCORING_DEFAULTS };

/**
 * Configure scoring weights + ranking knobs from config. Called at boot by the
 * server and the nightly (alongside configureDecay/configureRecall) so
 * retrieval and consolidation rank identically. Invalid/absent values keep the
 * shipped default per key. Returns the resolved set for logging/tests. Also
 * pushes the #205 BM25F field weights into storage (storage.configureBm25Fts)
 * so searchFts ranks with the same config — BM25F weights live in storage.ts
 * (next to the FTS column declaration they mirror) but are read here from the
 * SAME config object for one-place tuning.
 */
export function configureScoring(config?: Record<string, unknown> | null): ScoringWeights {
  const num = (key: string, dflt: number, min: number, max: number): number => {
    const v = Number(config?.[key]);
    return Number.isFinite(v) && v >= min && v <= max ? v : dflt;
  };
  // #205 BM25F weights use a [0, ∞) range (no upper bound — a field can dominate
  // if the operator wills it; 0 drops the field entirely). Invalid ⇒ default.
  const numW = (key: string, dflt: number): number => {
    const v = Number(config?.[key]);
    return Number.isFinite(v) && v >= 0 ? v : dflt;
  };
  scoringWeights = {
    similarity: num("scoreSimilarityWeight", SCORING_DEFAULTS.similarity, 0, 1),
    strength: num("scoreStrengthWeight", SCORING_DEFAULTS.strength, 0, 1),
    connections: num("scoreConnectionsWeight", SCORING_DEFAULTS.connections, 0, 1),
    recency: num("scoreRecencyWeight", SCORING_DEFAULTS.recency, 0, 1),
    freshnessBoostDays: num("freshnessBoostDays", SCORING_DEFAULTS.freshnessBoostDays, 0, 365),
    freshnessBoostWeight: num("freshnessBoostWeight", SCORING_DEFAULTS.freshnessBoostWeight, 0, 1),
    supersededDemotion: num("supersededDemotion", SCORING_DEFAULTS.supersededDemotion, 0, 1),
    projectAffinity: num("projectAffinityWeight", SCORING_DEFAULTS.projectAffinity, 0, 1),
    domainAffinity: num("domainAffinityWeight", SCORING_DEFAULTS.domainAffinity, 0, 1),
    rrfK: numW("rrfK", SCORING_DEFAULTS.rrfK),
    rrfCompositeWeight: num("rrfCompositeWeight", SCORING_DEFAULTS.rrfCompositeWeight, 0, 1),
    rrfFtsWeight: numW("rrfFtsWeight", SCORING_DEFAULTS.rrfFtsWeight),
    rrfVectorWeight: numW("rrfVectorWeight", SCORING_DEFAULTS.rrfVectorWeight),
  };
  // #205: push BM25F field weights into storage so searchFts uses them. Same
  // config object, one tuning surface; storage owns the module-level mirror
  // next to the FTS column declaration (the positional order matters there).
  storage.configureBm25Fts({
    bm25WeightBody: numW("bm25WeightBody", 1.0),
    bm25WeightProject: numW("bm25WeightProject", 2.0),
    bm25WeightDomain: numW("bm25WeightDomain", 2.0),
  });
  return { ...scoringWeights };
}

/** Current resolved weights (tests + status output). */
export function getScoringWeights(): ScoringWeights {
  return { ...scoringWeights };
}

// ---------------------------------------------------------------------------
// Session-intent keying (#192, 0.15.3). ONE config knob:
//   sessionIntentWeight  0.33  blend weight of the rolling centroid in the
//                              search vector: query = (1-w)·prompt + w·centroid.
//                              0 = DISABLED (pure prompt, the kill-switch —
//                              current behavior). Range [0, 1].
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
const SESSION_INTENT_DEFAULT_WEIGHT = 0.33;

let sessionIntentWeight = SESSION_INTENT_DEFAULT_WEIGHT;

/**
 * Configure session-intent keying from config. Called at server boot next to
 * configureScoring (the nightly does no recall, so it does not need this).
 * Reads only `sessionIntentWeight` ([0,1]; 0 = disabled). Invalid/out-of-range
 * values keep the shipped default. Returns `{ weight, alpha }` — alpha is the
 * fixed constant, surfaced so the recall closure passes it to the registry in
 * one call.
 */
export function configureSessionIntent(
  config?: Record<string, unknown> | null
): { weight: number; alpha: number } {
  const v = Number(config?.sessionIntentWeight);
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
 * Compute decayed strength with adaptive decay (B+E+D model).
 * Exported for use by consolidation decay/prune stage.
 */
export function effectiveStrength(
  baseStrength: number,
  lastAccessed: string | null,
  now: Date,
  options?: {
    importance?: number;
    accessCount?: number;
    linkCount?: number;
  }
): number {
  const importance = options?.importance ?? baseStrength;
  const accessCount = options?.accessCount ?? 0;
  const linkCount = options?.linkCount ?? 0;

  const hours = Math.max(
    (now.getTime() - parseTimestamp(lastAccessed).getTime()) / 3_600_000,
    0
  );

  // B: Importance slows decay
  let decayRate = 1.0 - BASE_DECAY * (1.0 - importance);

  // E: Access hardening
  const hardening = 0.7;
  decayRate = 1.0 - (1.0 - decayRate) * Math.pow(hardening, accessCount);

  // E: Connectivity hardening
  decayRate = 1.0 - (1.0 - decayRate) * Math.pow(hardening, linkCount);

  // D: Asymptotic floor
  const floor = baseStrength * importance * 0.1;

  return floor + (baseStrength - floor) * Math.pow(decayRate, hours);
}

/**
 * Return a composite relevance score in [0, 1] for a candidate memory.
 * Exported for exact-value tests of the similarity component (#145).
 *
 * #203 soft affinity (options.scope + options.tagWeights): two additive,
 * graded, zero-boost-neutral terms — project affinity (exact project match)
 * and domain affinity (max overlapping memory_tags.weight × scope). Both are
 * 0 when the scope is absent (byte-identical to pre-#203) and NEVER negative
 * (a foreign memory adds 0, never a penalty — penalties re-introduce
 * soft-exclusion). See `AffinityScope`.
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
  maxConnections: number,
  now: Date,
  options?: {
    superseded?: boolean;
    /** #203: when present, project/domain affinity boosts are applied. */
    scope?: AffinityScope;
    /** Candidate's graded domain tags (memory_tags rows). Loaded batched for
     *  the whole candidate set in retrieve(); used for domain affinity. */
    tagWeights?: Array<{ tag: string; weight: number | null }>;
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
      accessCount: memory.access_count ?? 0,
      linkCount: connectionCount,
    }
  );
  const connScore =
    maxConnections > 0 ? connectionCount / maxConnections : 0;
  const hoursSinceCreated = Math.max(
    (now.getTime() - parseTimestamp(memory.created_at).getTime()) / 3_600_000,
    0
  );
  const recency = Math.pow(0.9995, hoursSinceCreated);

  const w = scoringWeights;
  let score =
    similarity * w.similarity +
    effStrength * w.strength +
    connScore * w.connections +
    recency * w.recency;

  // Fresh-memory window (#191 Phase B): a memory is born highly available and
  // settles into the normal ranking over `freshnessBoostDays`. Age is measured
  // from created_at, which the nightly sets from the session's own date — so a
  // session captured last night ranks as ~1 day old (not 0), and backfilled
  // older content correctly gets no boost. The slow
  // `recency` term above (≈58-day half-life at weight 0.15) could never lift a
  // day-old memory past a hardened old one — measured case: an exact-match
  // 1-day-old memory (strength 0.50) lost to an unrelated memory at strength
  // 0.80. This is an ADDITIVE bonus that decays linearly to zero at the window
  // edge, so it cannot distort ranking among memories that are all old.
  const ageDays = hoursSinceCreated / 24;
  if (memory.created_at && ageDays < scoringWeights.freshnessBoostDays) {
    const freshness = 1 - ageDays / scoringWeights.freshnessBoostDays;
    score += freshness * scoringWeights.freshnessBoostWeight;
  }

  // #203 soft affinity (retrieval scoping). Two graded, additive terms — both
  // ZERO when the scope is absent (byte-identical ranking) and ZERO for a
  // non-matching memory (never a penalty). Project affinity is a flat boost on
  // exact project match; domain affinity is max(overlapping tag weight) × the
  // domain weight. NULL tag weights (not yet computed by the nightly
  // reconsolidation) count as 0 — we never invent a boost from missing
  // association strength. Affinity rides the 0.8 composite side only (the RRF
  // 0.2 side is #205 territory and untouched here).
  const scope = options?.scope;
  if (scope) {
    if (scope.project && memory.project === scope.project) {
      score += scoringWeights.projectAffinity;
    }
    const domains = scope.missionDomains;
    if (domains && domains.length > 0 && options.tagWeights && options.tagWeights.length > 0) {
      const domainSet = domains.length === 1 ? null : new Set(domains);
      let maxWeight = 0;
      for (const tw of options.tagWeights) {
        const overlaps = domainSet ? domainSet.has(tw.tag) : tw.tag === domains[0];
        if (overlaps) {
          const w = tw.weight ?? 0;
          if (w > maxWeight) maxWeight = w;
        }
      }
      if (maxWeight > 0) score += maxWeight * scoringWeights.domainAffinity;
    }
  }

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
      const count = links.length;
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
      connectionCounts.set(mid, links.length);
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
    memory_type: memory.memory_type ?? "episode",
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
  }
): Promise<MemorySearchResult[]> {
  const limit = options?.limit ?? recallDefaults.searchLimit;
  const project = options?.project;
  const sourceAgent = options?.sourceAgent;
  const missionDomains = options?.missionDomains;
  const now = new Date();

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
    // (0.16.x: vestigial column, never filtered).
    ftsCandidates = storage.searchFts(db, query, fetchLimit, sourceAgent);
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
    // #203: project check removed — project is a soft affinity in computeScore,
    // not a filter. 0.16.x: privacy check removed — the column is vestigial,
    // never filtered. sourceAgent stays a hard filter.
    if (sourceAgent && mem.source_agent !== sourceAgent) continue;
    candidateMap.set(gid, { mem, distance: DEFAULT_GRAPH_DISTANCE, source: "graph" });
  }

  // 5. Compute composite scores
  const maxConnections = Math.max(
    ...([...connectionCounts.values()].length > 0
      ? [...connectionCounts.values()]
      : [0])
  );

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
  // are demoted in computeScore rather than strength-penalized.
  const supersededIds = findSupersededIds(db, [...candidateMap.keys()]);

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
    const composite = computeScore(mem, distance, connCount, maxConnections, now, {
      superseded: supersededIds.has(mid),
      scope,
      tagWeights: tagWeightsByMemory?.get(mid),
    });
    const effStr = effectiveStrength(
      mem.base_strength ?? 0.5,
      mem.last_accessed,
      now,
      {
        accessCount: mem.access_count ?? 0,
        linkCount: connectionCounts.get(mem.id) ?? 0,
      }
    );

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
  // Access hardening + effective strength make past winners self-reinforcing:
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
  const maxConnections = Math.max(
    ...([...connectionCounts.values()].length > 0
      ? [...connectionCounts.values()]
      : [0])
  );

  const scored: Array<{
    mem: Memory;
    score: number;
    effStr: number;
    connCount: number;
  }> = [];

  const supersededRecent = findSupersededIds(db, candidates.map((c) => c.id));

  for (const mem of candidates) {
    const connCount = connectionCounts.get(mem.id) ?? 0;
    const score = computeScore(mem, DEFAULT_GRAPH_DISTANCE, connCount, maxConnections, now, {
      superseded: supersededRecent.has(mem.id),
    });
    const effStr = effectiveStrength(
      mem.base_strength ?? 0.5,
      mem.last_accessed,
      now,
      {
        accessCount: mem.access_count ?? 0,
        linkCount: connectionCounts.get(mem.id) ?? 0,
      }
    );
    scored.push({ mem, score, effStr, connCount });
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, limit);

  const results = top.map((t) =>
    formatResult(t.mem, t.score, t.effStr, t.connCount)
  );
  strengthen(db, top.map((t) => t.mem), now);
  return results;
}
