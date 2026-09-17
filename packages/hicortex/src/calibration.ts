/**
 * Release-managed calibration constants (#408) — the single home of every
 * tuning value the product ships. One value, one definition, one provenance
 * comment. Nothing in here is read from ~/.hicortex/config.json anymore: the
 * ~35 tuning keys that 0.15–0.20 exposed as config are now CONSTANTS that
 * move only in releases. The user config surface shrinks to the keys that
 * describe an install (mode, model, schedules, identity, budgets), not the
 * ones that tune the brain.
 *
 * EVOLUTION CONTRACT: these values change ONLY in releases, with the
 * eval/band-stats evidence linked in the changelog line that moves them
 * (eval harness = `npm run eval` + the resolution band stats in the nightly
 * report). Never in a patch to quiet one corpus, never behind a new config
 * key. The seams for EXPERIMENTS are the configure*() functions in
 * retrieval.ts / storage.ts (and the stage Options fields) — the eval and
 * the tests sweep values through them; production never passes anything, so
 * every process scores with exactly these constants.
 *
 * Every value below equals the default the code shipped the day this module
 * was introduced (verified by tests/calibration.test.ts) — an install that
 * never set the old config keys sees byte-identical behavior. The old keys
 * are warned as RELEASE-MANAGED at the config boundary (config-read.ts) so
 * the removal is never silent.
 */

// ---------------------------------------------------------------------------
// Recall / decay family (was: decayHalfLifeDays, searchLimit, recentLimit,
// recentWindowDays, coldExposureSlots, sessionIntentWeight, recall*,
// noveltyFloorSlots, recallReshowTurns)
// ---------------------------------------------------------------------------

/**
 * Memory-decay half-life (days) at the reference importance 0.5. #192 recall/
 * decay alignment: was ~115 days — aggressive enough to bury the long tail in
 * ranking. Long-term remembering is the product; time preference stays mild.
 */
export const DECAY_HALF_LIFE_DAYS = 365;

/**
 * Per-use strength promotion rate (#448, the strength model's upward path):
 * one application of `promotion = PROMOTION_RATE × (1 − S / IMPORTANCE_CEILING)
 * × S^(−0.3)` per new use (S = stored base_strength), iterated once per
 * access-count delta by the nightly stagePromotion stage and clamped at the
 * ceiling. Calibrated so the first access on a median-0.35 memory gives ~+0.03
 * (0.35 → 0.3786). Shape grounded in LTP saturation curves (Cao & Harris
 * 2014), the power law of practice (α ≈ 0.3, Newell & Rosenbloom 1981), and
 * spaced-repetition stability multipliers (S^−0.53, SuperMemo SM-17,
 * n > 60,000 real repetitions): bigger boosts for weaker memories,
 * saturating near the ceiling, never fully stopping (asymptotic). The decay
 * side is untouched — a memory's fade RATE no longer depends on its use or
 * link history (the #448 hardening removal); use raises the STORED score
 * instead, and abandonment fades it on the same 365-day clock as everything
 * else. RELEASE-MANAGED per this module's evolution contract — no config key.
 */
export const PROMOTION_RATE = 0.033;

/**
 * Lower bound on the promotion formula's S input (#453 review Minor finding,
 * owner decision 2026-09-16). base_strength 0.0 is a writable value (legacy
 * rows, operator edits), and S^(−0.3) has a zero-singularity: unfloored, one
 * access on a 0.0 row computed delta = 0.033 × (1 − 0/0.95) × 0^−0.3 =
 * Infinity, and the ceiling clamp turned that into a leap straight to 0.95.
 * Floored at 0.01, the same access lands at 0.033 × (1 − 0.01/0.95) ×
 * 0.01^(−0.3) ≈ +0.13 (0.0 → ≈0.14) — the biggest first boost the formula
 * can give, bounded and far from the ceiling. The floor clamps the FORMULA
 * INPUT only: storage keeps a 0.0 row at 0.0 until it is used, and the
 * promoted result is nonzero from then on. RELEASE-MANAGED like PROMOTION_RATE.
 */
export const PROMOTION_STRENGTH_FLOOR = 0.01;

/** Default k for retrieve() (/search without an explicit limit). #192. */
export const SEARCH_LIMIT = 8;

/** Default k for searchRecent() (/recent without an explicit limit). #192. */
export const RECENT_LIMIT = 12;

/** searchRecent() candidate window, days. #192. */
export const RECENT_WINDOW_DAYS = 180;

/** Top-k slots reservable for never-accessed memories (cold exposure). #192:
 *  recall was too passive (88% of memories never accessed) — the long tail
 *  gets guaranteed slots instead of waiting for the strength clock. */
export const COLD_EXPOSURE_SLOTS = 2;

/** Blend weight of the session-intent centroid in the recall search vector
 *  (#192, 0.15.3): query = (1-w)·prompt + w·centroid. The kill-switch is the
 *  configureSessionIntent(0) seam (eval-only); production always ships 0.33. */
export const SESSION_INTENT_WEIGHT = 0.33;

/** Relevance-gate floor for vector-only /recall-index candidates. 0.62
 *  (raised from 0.55 on 2026-08-03 per a 0.01-step floor sweep on the
 *  rewritten corpus): steady ~3:1 noise:signal removal with no knee; sits
 *  below the 0.63 local pessimum. FTS-matched candidates pass regardless. */
export const RECALL_MIN_SIMILARITY = 0.62;

/** Max lines in the pushed recall index. 5 (lowered from 6 on 2026-08-03):
 *  per-slot decomposition at floor 0.62 showed slot 6 gives NO prompt its
 *  first relevant memory. The K-sweep is monotone toward 4, but the 4-vs-5
 *  distinction rests on 5 of 98 prompts — 5 hedges with coverage. */
export const RECALL_MAX_ITEMS = 5;

/** Prompts shorter than this skip the recall index (continuations, "yes"). */
export const RECALL_MIN_PROMPT_CHARS = 20;

/** Chars of a memory's first line shown in an index entry. 100 (reverted
 *  from 150 on 2026-08-03): the full-corpus relevance eval found 100 vs 150
 *  statistically identical (full CI overlap at N=40); 100 saves ~13% tokens. */
export const RECALL_TITLE_CHARS = 100;

/** Slots of RECALL_MAX_ITEMS guaranteed to the pure-prompt (unblended)
 *  search's top passing hit(s) — the #324 novelty floor. 2 mirrors
 *  COLD_EXPOSURE_SLOTS sizing: a floor, never a takeover. */
export const NOVELTY_FLOOR_SLOTS = 2;

/** Turns an already-shown memory stays suppressed in the same session before
 *  it may reappear in the pushed index (#192 turn-based dedup). */
export const RECALL_RESHOW_TURNS = 30;

// Recall-uses band (console) — PROVISIONAL zone edges. Owner anchor
// 2026-09-13 (#426 final ruling): the console renders uses-per-showing on a
// red→green→red band with three zones (Low / Normal / Overfetching; owner
// confirmed "3 bands is fine"). The owner's calibration state is explicit —
// "we have no clue on how to calibrate yet" — so these edges are provisional
// anchors from #426's owner-anchor record, NOT measured boundaries; fleet
// telemetry is expected to move them (the console marks the band
// "provisional" and renders no edge numerics). They position zone boundaries
// on the console's gradient and classify the marker's zone word; they gate
// nothing server-side.

/** uses_per_showing below this reads Low on the console band.
 *  PROVISIONAL (owner anchor 2026-09-13, #426). */
export const RECALL_USES_LOW_MAX = 0.05;

/** uses_per_showing below this (and ≥ RECALL_USES_LOW_MAX) reads Normal.
 *  PROVISIONAL (owner anchor 2026-09-13, #426). */
export const RECALL_USES_NORMAL_MAX = 0.25;

/** Display-axis maximum for the console band (the marker clamps here).
 *  PROVISIONAL (owner anchor 2026-09-13, #426) — chosen so Overfetching
 *  keeps a visible span, not a measured bound. */
export const RECALL_USES_AXIS_MAX = 0.30;

// ---------------------------------------------------------------------------
// Composite ranking weights (was: score*Weight, freshnessBoost*,
// supersededDemotion, *AffinityWeight, rrf*)
// ---------------------------------------------------------------------------

/** Semantic-similarity share of the composite score. 0.50 (raised from 0.40
 *  in the 0.15.2 rebalance, #191 Phase B): on the production corpus effective
 *  strength (0.30) outweighed what similarity could recover — hardened old
 *  memories beat exact matches for their own topic. Similarity now leads;
 *  strength breaks ties and rewards real use. */
export const SCORE_SIMILARITY_WEIGHT = 0.50;

/** Effective-strength share of the composite score (was 0.30; see above). */
export const SCORE_STRENGTH_WEIGHT = 0.20;

/** Graph-centrality share of the composite score (was 0.20; see above). */
export const SCORE_CONNECTIONS_WEIGHT = 0.15;

/** Slow recency curve share of the composite score (was 0.10; see above). */
export const SCORE_RECENCY_WEIGHT = 0.15;

/** Fresh-memory window: the additive bonus fades linearly to 0 over this
 *  many days. 7 — nightly capture means 1 day is the floor of "fresh"
 *  (#191 Phase B). */
export const FRESHNESS_BOOST_DAYS = 7;

/** Fresh-memory bonus size at age 0 (#191 Phase B; 0 = disabled via seam). */
export const FRESHNESS_BOOST_WEIGHT = 0.15;

/** Score multiplier for a memory a later decision superseded (0.15.2; the
 *  belief walk (#393 D) is the primary mechanism — this is the safety net
 *  for rows the walk does not reach). */
export const SUPERSEDED_DEMOTION = 0.50;

/** #203 soft boost on exact project match. ADDITIVE, zero-boost neutral,
 *  never a penalty — a foreign memory ranks equal, not lower. */
export const PROJECT_AFFINITY_WEIGHT = 0.15;

/** #203 soft boost multiplier on max overlapping domain-tag weight. */
export const DOMAIN_AFFINITY_WEIGHT = 0.15;

/** #205 RRF k parameter (1/(k+rank+1)) — matches the pre-#205 hardcoded 60
 *  so the no-config path was byte-identical to 0.15.3. */
export const RRF_K = 60;

/** #205 composite-score share of the final blend (RRF gets the remainder);
 *  pre-#205 hardcoded value carried forward. */
export const RRF_COMPOSITE_WEIGHT = 0.8;

/** #205 per-list RRF weight for the FTS list. 0.5 is the bisection point
 *  where BM25F + composite-affinity flip the token-exact marine body match
 *  below the same-scope hardware field (Q4 contamination 0.20 → 0.00) while
 *  pure-keyword queries keep recall@5 = 1.0. 0.7 was measured too timid. */
export const RRF_FTS_WEIGHT = 0.5;

/** #205 per-list RRF weight for the vector list (vec stays at 1.0 — the
 *  conservative nudge is on the FTS side only). */
export const RRF_VECTOR_WEIGHT = 1.0;

/**
 * Additive boost for candidates the TWO retrieval channels AGREE on
 * (vector KNN AND BM25 FTS both matched — computeScore option
 * `bothChannel`). #425 (owner decision D3, 2026-09-13): the two-channel
 * signal is the genuine-match signature and is immune to FTS-only token
 * collisions, which is why the boost lives in the composite score, not in
 * the RRF FTS weight (raising that re-opens the #205 cross-scope collision
 * it fixed). D3's dominance property: a both-channel match outranks a
 * single-channel rival unless the rival is >0.10 more similar — at the
 * shipped simWeight 0.50, 0.10 gives that property 2x headroom (a rival
 * needs >0.20 more similarity).
 *
 * SIZING (the #425 sweep, 2026-09-13, production snapshot copy: case-1
 * planted fixture + a 30-query real battery vs the boost-0 baseline): every
 * value in {0.05, 0.10, 0.15} passed the hard gates (exact-match rank-1,
 * no-match byte-stability, zero both-channel exact-match losses, the
 * Sirnäs flip) with IDENTICAL battery stability (96.7% top-1 ex-promotions
 * — every raw change was a both-channel exact match displacing a
 * single-channel row, the property firing); they differed only in case-1
 * margin (0.021 / 0.061 / 0.101) and per-id top-3 churn. 0.10 chosen:
 * 0.05's margin is within one embedder revision of flipping, 0.15 churns
 * more for no gate benefit. Weight rebalances measured WORSE (sim .55/str
 * .15 → 93.3%; sim .60/str .10 → 86.7%, fails the 90% gate) — the
 * SCORE_*_WEIGHT values stay as shipped. ZERO-boost neutral (never a
 * penalty): graph-only and single-channel candidates add nothing.
 */
export const BOTH_CHANNEL_BOOST = 0.10;

// ---------------------------------------------------------------------------
// BM25F field weights (was: bm25WeightBody/Project/Domain) — #205. Body is
// down-weighted relative to the scope fields so a project/domain token match
// outranks a token-exact body collision from a foreign scope.
// ---------------------------------------------------------------------------

export const BM25_WEIGHT_BODY = 1.0;
export const BM25_WEIGHT_PROJECT = 2.0;
export const BM25_WEIGHT_DOMAIN = 2.0;

// ---------------------------------------------------------------------------
// Resolution / dedup family (was: dedupAutoMergeThreshold [legacy
// dedupMergeThreshold], supersessionMinSimilarity, correctionMinSimilarity,
// correctionRewriteMinConfidence, weakPrimaryFloor)
// ---------------------------------------------------------------------------

/**
 * Write cap on base_strength / importance (#425, owner decision D2
 * 2026-09-13: cap 0.95). The decay model's rate is `1 − BASE_DECAY·(1 −
 * importance)` — at importance exactly 1.0 the rate is exactly 1.0 and the
 * row NEVER decays (measured on the production snapshot: ~14% of live rows
 * pegged at ≥0.999, 1838/17399 at exactly 1.0). The cap kills the
 * immortality cliff at every write site (stageImportance, enrich, hub
 * boost) while keeping a multi-year half-life for the top band (0.95 →
 * ~13 years). effectiveStrength ALSO clamps the read side, so legacy
 * base-1.0 rows decay again.
 */
export const IMPORTANCE_CEILING = 0.95;

/** Deterministic merge ceiling of the unified resolution pass (#392): pairs
 *  at/above this cosine merge LLM-free; [CORRECTION_MIN_SIMILARITY, this)
 *  get the one verdict call. 0.92 — measured on the #191 mechanical audit
 *  corpus (89 clusters / 110 excess rows; data/audit-20260729). */
export const DEDUP_AUTO_MERGE_THRESHOLD = 0.92;

/** Minimum cosine for a nightly supersession candidate pair (#100 stage,
 *  0.15.0): one classify-tier call per pair above the bar. */
export const SUPERSESSION_MIN_SIMILARITY = 0.80;

/** Minimum cosine for a reconsolidation correction pair (#384). Deliberately
 *  wider than supersession's 0.80: a retraction often rides inside an
 *  otherwise unrelated memory; the verdict + confidence gate carry the
 *  precision. */
export const CORRECTION_MIN_SIMILARITY = 0.75;

/** Minimum verdict confidence for the REWRITE (and #392 merge-apply) fork
 *  (#384): below it a `corrects` degrades to mark-only — a weak mark is
 *  recoverable, a weak rewrite is corruption. */
export const CORRECTION_REWRITE_MIN_CONFIDENCE = 0.80;

/** Minimum cosine(memory embedding, best domain prototype) for a no-fit
 *  memory to earn a WEAK primary instead of decaying (owner amendment
 *  07.07). Starting point for bge-small-en-v1.5. */
export const WEAK_PRIMARY_FLOOR = 0.45;

// ---------------------------------------------------------------------------
// Console presentation family (#409/#421) — stage thresholds for the
// /dashboard console. The STAGE BANDS are calibrated per release against the
// MEASURED distribution (2026-09-13 against the inflated store; this release
// re-derived against the post-#425 backfilled store — see the block JSDoc
// immediately below). The recall-grade zones that used to
// live here are REMOVED per the owner semantics ruling 2026-09-13 (#426):
// recall depends only on the conversation — "if the index is good enough for
// the context needed, it does not have to be fetched" — so a graded
// Low/Medium/Good/Excellent scale is the wrong instrument (higher is not a
// target that exists). The console shows the raw uses-per-showing ratio + a
// trend; the reference expectations for reading that number live on #426,
// not in shipped bands. The evolution contract still applies to the stage
// bands: they move only in releases, with the eval / band-stats evidence
// linked in the changelog line that moves them.
// ---------------------------------------------------------------------------

/**
 * Console stage bands (#409/#421) — TWO #408-contract calibrations:
 *
 * (1) 2026-09-13 (PR #424 fix round) against the INFLATED distribution:
 *     effectiveStrength p25 = 0.599, p50 = 0.788, p86 = 0.900, ~14%
 *     saturated at exactly 1.000 → edges 0.40/0.60/0.90 targeting a rendered
 *     split ≈ 10/15/61/14 (fading/forming/belief/truth).
 *
 * (2) This release (#425) against the POST-FIX distribution: the importance
 *     recalibration (re-anchored prompt + 0.95 cap) plus the
 *     rescore-importance backfill re-spread the same 17,399-row store to
 *     base_strength median 0.40 / p90 0.60 / max 0.90 (zero rows ≥ 0.999);
 *     measured effectiveStrength on the backfilled copy: p25 ≈ 0.296,
 *     p50 ≈ 0.397, p75 ≈ 0.497, p86 ≈ 0.585, max ≈ 0.900. The stale 2026-09-13
 *     edges rendered that store as 58.5/37.2/4.2/0 — no Truth left. These
 *     edges (0.20/0.30/0.58) re-derive the same ≈ 10/15/61/14 split intent
 *     against the honest distribution and render 11.8/25.6/47.7/14.9 (the
 *     scorer emits one-decimal scores, so the mass clusters at exact atoms —
 *     0.20/0.30/0.60 — and the 0.60 atom alone holds ~12% of the store; the
 *     truth edge therefore sits at 0.58, just under the atom, rather than on
 *     the round number that would strand it). Evidence: the #425
 *     post-backfill band-stats photo (backfilled copy, deriveStage math via
 *     the production effectiveStrength).
 */

/**
 * Days without access after which a memory's derived stage is Fading
 * (regardless of strength — the recency gate runs FIRST in deriveStage).
 * 120 ≈ a season: long enough that a working memory is never mislabeled,
 * short enough that the rim of the field turns over within a year.
 */
export const STAGE_FADING_DAYS = 120;

/**
 * Effective-strength ceiling of the living bands: below this the memory is
 * Fading (the measured weak cluster + the recency-gated rim, together ~12% of
 * the post-#425 store) even when recently touched.
 */
export const STAGE_FADING_STRENGTH = 0.20;

/** The Forming/Belief edge: [FADING, this) → forming, ≥ this → belief. */
export const STAGE_BELIEF_STRENGTH = 0.30;

/** The Belief/Truth edge: ≥ this → truth — the hardened core (~15% post-#425;
 *  just under the 0.60 score atom, see the block JSDoc above). */
export const STAGE_TRUTH_STRENGTH = 0.58;

/**
 * One owner corroboration's bump to base_strength (#423 phase 3, POST
 * /enrich — evidence about importance). Post-#425 the forming band
 * [0.20,0.30) is 0.10 wide; +0.10 = a full band — one enrich visibly crosses
 * an edge for a mid-band Forming memory. Repeated enriches cap at the
 * IMPORTANCE_CEILING (0.95, the SQL MIN); for a young memory effStr ≈ base so
 * the bump lands ~1:1 (the phase-3 verify "enrich a Forming memory → stage
 * change" holds for a mid-band memory ≥0.25).
 */
export const ENRICH_STRENGTH_DELTA = 0.10;

// ---------------------------------------------------------------------------
// Capture / first-run cost family (#436)
// ---------------------------------------------------------------------------

/**
 * Days of session history a FIRST nightly run discovers (the first-run
 * watermark is now − this many days, not the epoch).
 *
 * Owner ruling (2026-09-14, #436): full-history first-run ingestion is not
 * feasible — "if everybody signing up ingests their full history, we will
 * pay millions in tokens during the trial period before customers pay us
 * anything." Cloud needs a very short window; the local/installable version
 * uses the SAME default.
 *
 * Unlike every other constant in this module, this one KEEPS a config
 * override (`firstRunLookbackDays`, read at the capture call sites): it
 * describes an install's cost posture — the same family as
 * `llmTokensPerMonth` / `captureCooldownHours`, which stayed config through
 * #408 — not brain tuning. More history is a deliberate act:
 * `hicortex nightly --recapture-window <days>`.
 */
export const DEFAULT_FIRST_RUN_LOOKBACK_DAYS = 7;

// ---------------------------------------------------------------------------
// Diagnostic tier (env-overridable — #408). The ollama-operational family is
// NOT user tuning: it exists so an operator of a constrained box can pin the
// three values into a service unit's environment without a config-file
// round-trip. Precedence: env > the constant below. An invalid env value
// warns and falls back to the constant (the resolveMemorySoftCap boundary
// posture, applied to the env half).
// ---------------------------------------------------------------------------

/**
 * Context window for ollama (one value, all phases; #220/#228). 8192 is
 * where context stops being the binding constraint for a sub-8B model on
 * ollama. Also drives `detectChunkSize` (chunkChars ≤ numCtx × 0.6 × 4
 * chars) so the chunker and the request agree by construction.
 */
export const NUM_CTX = 8192;

/** Flush ollama's accumulated memory every N LLM calls (0 = off; #220).
 *  Opt-in operational workaround for ollama runner RSS growth — never a
 *  default-on behavior. */
export const OLLAMA_FLUSH_EVERY = 0;

/** Ms to wait after an ollama flush (`keep_alive:0`) for the runner to exit
 *  + release memory. The runner takes >90 s to exit; 3 min allows margin. */
export const OLLAMA_FLUSH_WAIT_MS = 180000;

/** The env-tier table (release surface: names + defaults are frozen —
 *  adding a knob here is a release decision, not a runtime one). */
export const DIAGNOSTIC_ENV_TIER: Readonly<{
  numCtx: Readonly<{ env: string; default: number }>;
  ollamaFlushEvery: Readonly<{ env: string; default: number }>;
  ollamaFlushWaitMs: Readonly<{ env: string; default: number }>;
}> = Object.freeze({
  numCtx: Object.freeze({ env: "HICORTEX_NUM_CTX", default: NUM_CTX }),
  ollamaFlushEvery: Object.freeze({
    env: "HICORTEX_OLLAMA_FLUSH_EVERY",
    default: OLLAMA_FLUSH_EVERY,
  }),
  ollamaFlushWaitMs: Object.freeze({
    env: "HICORTEX_OLLAMA_FLUSH_WAIT_MS",
    default: OLLAMA_FLUSH_WAIT_MS,
  }),
});

/** Resolve the effective ollama context window: a positive finite
 *  HICORTEX_NUM_CTX wins; anything else (absent/blank/invalid) keeps NUM_CTX
 *  with a warn on the invalid case. */
export function resolveNumCtx(): number {
  const raw = process.env[DIAGNOSTIC_ENV_TIER.numCtx.env];
  if (raw === undefined || raw === "") return NUM_CTX;
  const v = Number(raw);
  if (Number.isFinite(v) && v > 0) return v;
  console.warn(
    `[hicortex] env HICORTEX_NUM_CTX=${JSON.stringify(raw)} is not a positive finite number — using default ${NUM_CTX}.`,
  );
  return NUM_CTX;
}

/** Resolve the flush cadence: a non-negative finite
 *  HICORTEX_OLLAMA_FLUSH_EVERY wins (0 = the valid off value); invalid warns
 *  and keeps OLLAMA_FLUSH_EVERY. */
export function resolveOllamaFlushEvery(): number {
  const raw = process.env[DIAGNOSTIC_ENV_TIER.ollamaFlushEvery.env];
  if (raw === undefined || raw === "") return OLLAMA_FLUSH_EVERY;
  const v = Number(raw);
  if (Number.isFinite(v) && v >= 0) return Math.floor(v);
  console.warn(
    `[hicortex] env HICORTEX_OLLAMA_FLUSH_EVERY=${JSON.stringify(raw)} is not a non-negative finite number — using default ${OLLAMA_FLUSH_EVERY}.`,
  );
  return OLLAMA_FLUSH_EVERY;
}

/** Resolve the post-flush wait: a positive finite
 *  HICORTEX_OLLAMA_FLUSH_WAIT_MS wins; invalid warns and keeps
 *  OLLAMA_FLUSH_WAIT_MS. */
export function resolveOllamaFlushWaitMs(): number {
  const raw = process.env[DIAGNOSTIC_ENV_TIER.ollamaFlushWaitMs.env];
  if (raw === undefined || raw === "") return OLLAMA_FLUSH_WAIT_MS;
  const v = Number(raw);
  if (Number.isFinite(v) && v > 0) return v;
  console.warn(
    `[hicortex] env HICORTEX_OLLAMA_FLUSH_WAIT_MS=${JSON.stringify(raw)} is not a positive finite number — using default ${OLLAMA_FLUSH_WAIT_MS}.`,
  );
  return OLLAMA_FLUSH_WAIT_MS;
}
