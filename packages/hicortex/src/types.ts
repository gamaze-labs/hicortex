/**
 * Type definitions for Hicortex OpenClaw plugin.
 * Ported from the Python hicortex codebase.
 */

/** A stored memory record. */
export interface Memory {
  id: string;
  content: string;
  base_strength: number;
  last_accessed: string | null;
  access_count: number;
  created_at: string;
  ingested_at: string;
  source_agent: string;
  source_session: string | null;
  /**
   * Stable attribution id of the capturing client (a per-install UUID from
   * config.json `agentId`). Survives agent/machine renames — unlike
   * `source_agent` (a readable name). Attribution only; nothing filters on it.
   * NULL on memories captured before this column existed. (0.16.x)
   */
  source_agent_id: string | null;
  project: string | null;
  domain: string | null;
  /**
   * Provenance only (0.16.x): the client-declared topic/domain of the
   * capturing agent (config.json `sourceDomain`). NOT used for recall filtering
   * or scoring, and NOT the content-classified primary (that is `domain`
   * above). NULL when the client declares none. Echoed back on /memory GET.
   */
  source_domain: string | null;
  privacy: ("PUBLIC" | "WORK" | "PERSONAL" | "SENSITIVE") | null;
  memory_type: "experience" | "learnings" | "knowledge" | "decisions";
  updated_at: string | null;
  /**
   * Reconsolidation state (#384, migration v14). Code-defined vocabulary,
   * never config: NULL/absent = active (the default, and every pre-v14 row);
   * 'superseded'/'retracted' = marked stale or wrong (demoted in ranking);
   * 'corrected' = rewritten in place (does NOT demote — demoting it would
   * bury the correction); 'absorbed' = invisible to recall (no vector/FTS
   * row, plain row + links kept as evidence and rollback reference). Writers
   * of 'absorbed': the reconsolidation rewrite path (trigger folded into a
   * corrected target), dedup merge losers (#392), and the one-shot
   * `sweep-volatile` demotion (#489 — volatile rows retire through the SAME
   * primitive, so no new status vocabulary exists to thread through read
   * paths; recovery is the pre-sweep backup).
   */
  status?: string | null;
  /**
   * Explicit owner corroboration count (#423 phase 3, migration v17). Each
   * POST /enrich bumps it together with base_strength (+the calibration
   * delta, capped at the importance ceiling) — EVIDENCE ABOUT IMPORTANCE,
   * never access (access_count) nor index exposure (shown_count). Optional
   * because rowToMemory is a cast over SELECT * rows; 0 (the column default)
   * on all pre-v17 rows and until first enriched.
   */
  corroboration_count?: number;
  /**
   * Importance scored-at watermark (#425, migration v19). NULL = never
   * scored (the nightly's unscored pool); a timestamp = this row's
   * base_strength is settled under some rubric and the nightly will not
   * re-roll it. Written by stageImportance, the enrich path (the owner's
   * mark stands in for the first LLM score), and the rescore-importance
   * backfill. Optional because rowToMemory is a cast over SELECT * rows;
   * pre-v19 rows were stamped by the migration backfill (except sentinel
   * rows, which stay NULL for exactly one scoring under the new rubric).
   */
  importance_scored_at?: string | null;
  /**
   * Promotion baseline (#448, migration v20): the access_count the nightly
   * promotion stage (stagePromotion) last consumed — the delta
   * access_count − promotion_last_count drives the per-use strength bump.
   * Written by the stage, the migration backfill, and dedup merges (the
   * baseline moves with the summed counter so a merge never replays the
   * losers' lifetime accesses as fresh promotions). Optional because
   * rowToMemory is a cast over SELECT * rows.
   */
  promotion_last_count?: number | null;
}

/** A link between two memories. */
export interface MemoryLink {
  source_id: string;
  target_id: string;
  relationship: string;
  strength: number;
  created_at: string;
}

/** All valid relationship types for memory links.
 *  lowercase = heuristic (legacy), UPPER_SNAKE_CASE = LLM-classified (v0.7+). */
export const VALID_RELATIONSHIP_TYPES = [
  "derives", "updates", "extends", "relates_to",
  "CONTRADICTS", "SUPERSEDES", "DEPENDS_ON", "CAUSED_BY", "VALIDATES",
] as const;

export type RelationshipType = typeof VALID_RELATIONSHIP_TYPES[number];

/** A search result with scoring metadata. */
export interface MemorySearchResult {
  id: string;
  content: string;
  score: number;
  effective_strength: number;
  access_count: number;
  memory_type: string;
  project: string | null;
  /** Origin agent (e.g. "hermes/profile-name", "cc/machine-name") — surfaced in the recall
   *  one-liner so agents can calibrate trust (#202 provenance). Optional on the
   *  result type (matches how `domain` is threaded) to avoid breaking fixtures. */
  source_agent?: string | null;
  created_at: string;
  connections: number;
  /** True cosine similarity to the query for vector-matched candidates; null
   *  for FTS-only and graph-discovered hits (no measured distance). */
  similarity?: number | null;
  /** Which retrieval channel produced the candidate (vector KNN, BM25 FTS,
   *  both, or graph traversal). Used by the /recall-index relevance gate. */
  source?: "vector" | "fts" | "both" | "graph";
}

/**
 * Per-cosine-band verdict statistics for the unified resolution pass (#392).
 * Bands are labeled from the live floor/ceiling ("0.75-0.8", …, ">=0.92").
 * The stage report carries the per-run snapshot; state.json
 * `resolutionBandStats` carries the cumulative series — calibration evidence
 * for moving the floor/ceiling boundaries later, with data.
 */
export interface ResolutionBandStat {
  /** Candidate pairs judged (or deterministically merged) in this band. */
  pairs: number;
  /** Verdict/action counts. `merge` counts gated merges (applied or applicable). */
  merge: number;
  corrects: number;
  supersedes: number;
  /** #393 guard-C: verdicts that flagged a genuine conflict (link, both kept). */
  conflicts: number;
  none: number;
  /** Merge verdicts below the confidence gate — both memories kept. */
  merge_below_gate: number;
  /** Sum of verdict confidences (divide by `pairs` for the mean). Deterministic merges count 1.0 each. */
  conf_sum: number;
  /**
   * Deterministic band only: clusters refused by the project rail. #206
   * decision 2 renamed this from `metadata_skipped` when the source_agent
   * rail was removed — pre-rename cumulative values stay on disk unread
   * (their semantics conflated both rails).
   */
  project_skipped?: number;
}

/**
 * Report of the deterministic merge zone (#392) — the band at/above the merge
 * ceiling (release-managed since #408; was the dedupAutoMergeThreshold config
 * key), merged by the dedup core's union-find clustering with ZERO LLM calls.
 * Computed in dedup.ts (runDeterministicMergeZone); surfaced verbatim as
 * `stages.reconsolidation.merges`.
 */
export interface DeterministicMergeZoneReport {
  /** The cosine ceiling in force (release-managed calibration; default 0.92). */
  threshold: number;
  /** Every cluster found at the threshold (mergeable + mismatch-skipped). */
  clusters_found: number;
  /** Clusters that passed the metadata rails (would merge). */
  mergeable_clusters: number;
  /** Clusters actually merged this run (apply only; 0 on dry-run). */
  merged_clusters: number;
  /** Loser rows absorbed (hidden from recall, kept as evidence) this run. */
  losers_merged: number;
  /** Loser links re-pointed onto canonicals this run. */
  links_repointed: number;
  /** Clusters skipped — members disagree on project (#206 decision 2: the source_agent rail is removed). */
  skipped_project_mismatch: number;
  /**
   * #393 guard-C: clusters skipped because a member pair holds a `conflicts`
   * link — a judge-flagged genuine conflict is never blended, both records
   * stay live.
   */
  skipped_conflict: number;
  /**
   * Mergeable clusters NOT attempted (pacing cap retired, #405): the run
   * deadline fired before them. Deferred clusters drain on the next run.
   */
  capped: number;
  /** #405: clusters in `capped` that stopped specifically on the deadline. */
  deadline_deferred?: number;
  /** Clusters whose merge transaction failed (rolled back; retried next run). */
  failed: number;
  /** Apply only: the capture lock was busy — zero merges, fail-soft. */
  lock_busy?: boolean;
  /** Apply only: the pre-merge backup failed — zero merges, fail-soft. */
  backup_failed?: boolean;
  /** Apply only: path of the pre-merge DB backup. */
  backup_path?: string;
  /** Dry-run only: bounded preview of the first 10 mergeable clusters. */
  preview?: Array<{ size: number; canonical_id: string; loser_ids: string[] }>;
}

/** Report returned by the consolidation pipeline. */
export interface ConsolidationReport {
  started_at: string;
  completed_at?: string;
  dry_run: boolean;
  /**
   * "deferred" (#405): the run-wide wall-clock deadline
   * (nightlyTimeBudgetMinutes) fired — at least one stage stopped at a safe
   * boundary and its remaining work drains on the next run (cursors hold
   * below it). Like "endpoint_down" it must NOT advance lastConsolidated,
   * so the pending-set queries re-find the deferred work.
   */
  status: "completed" | "skipped" | "failed" | "deferred";
  elapsed_seconds?: number;
  stages: {
    precheck?: {
      skip: boolean;
      reason: string;
      new_memory_count: number;
      unscored_count: number;
    };
    importance?: {
      scored: number;
      failed: number;
      skipped_budget: number;
      /**
       * #478: pool candidates dropped by the paid-gain guard at the stage
       * boundary — already-scored rows whose promotion baseline advanced or
       * that carry an owner corroboration. Their base_strength keeps the
       * paid gain; the nightly re-settle leaves them alone.
       */
      guard_skipped?: number;
    };
    reflection?: {
      lessons_generated: number;
      contradictions_suppressed?: number;
      failed?: boolean;
      skipped?: boolean;
      reason?: string;
    };
    domain_curation?: {
      curated: boolean;
      domains: number;
      /** Content-based path only: memories (re)filed this run. */
      classified?: number;
      /** Graded-schema pass: domains with a stored prototype after the run. */
      prototypes?: number;
      /** Graded-schema pass: memory_tags rows whose weight was recomputed. */
      weights_recomputed?: number;
      /** Graded-schema pass: memories whose derived primary changed. */
      primaries_updated?: number;
      /**
       * No-fit path: memories that earned a WEAK primary (argmax prototype
       * cosine >= the weak-primary floor — release-managed since #408) after
       * the LLM found no fitting domain.
       */
      weak_primary?: number;
      /**
       * No-fit path: memories below the weak-primary floor — untagged,
       * base_strength halved (accelerated decay toward prune).
       */
      no_association_decayed?: number;
      reason?: string;
    };
    links?: {
      auto_linked: number;
      llm_classified?: number;
      heuristic_fallback?: number;
      failed: number;
    };
    /**
     * Reconsolidation (#384) — runs after linking, before decay/prune.
     * Since #392 this is THE unified resolution stage: its verdict also carries
     * a `merge` disposition, and the deterministic merge zone (pairs at/above
     * the merge ceiling — release-managed since #408) runs inside it,
     * LLM-free, before the scan. Since #206-B (owner decision 6) it is also
     * the ONLY true-update detector — the standalone supersession stage
     * (3.7, #191 Phase B) is retired into its `supersedes` verdict action,
     * and its former `supersession` report slot no longer exists.
     */
    reconsolidation?: {
      /** Candidates examined this run (rowid > cursor; no shape filter). */
      scanned: number;
      /** Pairs actually sent to the verdict LLM (detection + explicit-mark verification). */
      pairs_evaluated: number;
      /**
       * #394: pairs the detection sources discovered this run, counted before
       * any skip or judgment — the only sizing number a dry-run can show,
       * where pairs_evaluated is always 0. #393 B: BOTH sources join this
       * total (KNN neighbors at/above the correction floor + the scout's
       * FTS hits on correction-shaped memories; see scout_candidates_found
       * for the scout's share).
       */
      pairs_discovered: number;
      /** #394: discovered pairs with no resolution link yet — the actionable
       * candidates (deterministic-zone work + would-be verdict calls). #393 B:
       * covers both detection sources. */
      pairs_discovered_unlinked: number;
      /** Targets rewritten in place this run (one history row each). */
      rewritten: number;
      /** Triggers absorbed (invisible to recall: vector + FTS dropped). */
      absorbed: number;
      /** Triggers kept live by their disposition (standalone substance). */
      kept_linked: number;
      /** Memories marked status 'superseded' (mark-only path). */
      marked_superseded: number;
      /** Memories marked status 'retracted' (mark-only: below gate / non-fact / failed contract). */
      marked_retracted: number;
      /** Verdicts that were `corrects` but below the rewrite confidence gate. */
      below_gate: number;
      /** Rewrite groups degraded to mark-only on a failed rewrite contract. */
      contract_failed: number;
      /** Verdict/rewrite calls skipped on a parse/infra error (retried naturally). */
      skipped_infra: number;
      /** Pairs skipped because a resolution link already existed (either direction). */
      skipped_idempotent: number;
      /** Explicit ingest marks verified and upgraded into a rewrite group. */
      explicit_verified: number;
      /** Explicit marks whose verification diverged (mark retained untouched). */
      explicit_divergent: number;
      /** reconsolidationCursor after this run (unchanged in dry-run). */
      cursor: number;
      /**
       * #439: verdict calls on pairs whose candidate rowid was at/below the
       * run-start scan high-water (state.reconsolidationScannedRowid) —
       * re-judgments of work a prior run already judged but could not apply
       * (the cursor held below it). Convergence evidence: this number must
       * fall to 0 once the backlog drains. pairs_evaluated =
       * pairs_reevaluated + pairs_new.
       */
      pairs_reevaluated: number;
      /** #439: verdict calls on candidates ABOVE the high-water — first-time judgments. */
      pairs_new: number;
      /**
       * #439: snapshot candidates skipped because a mid-scan absorb (a merge
       * loser or rewrite trigger absorbed at an earlier candidate's boundary)
       * had already absorbed them — the scan-stability guard.
       */
      skipped_absorbed: number;
      /**
       * #439: confirmed merge pairs still un-applied at run end — deadline
       * deferrals at a boundary, a failed pre-merge backup, and lock-busy
       * survivors of the final drain. Each holds the cursor below its
       * candidate and re-detects next run.
       */
      merge_pairs_deferred: number;
      /**
       * #392: the deterministic merge zone's own report (pairs >= the
       * ceiling, union-find merged, zero LLM). Present on every run —
       * including quiet-night skips (a stock install with a pre-upgrade
       * backlog still drains it, LLM-free).
       */
      merges: DeterministicMergeZoneReport;
      /** #392: judged-zone pair merges applied this run (merge verdicts at/above the confidence gate). */
      merge_pairs_applied: number;
      /** #392: merge verdicts below the rewrite confidence gate — both memories kept. */
      merge_below_gate: number;
      /**
       * #392: pairs the scan saw at/above the ceiling — owned by the
       * deterministic zone (or waiting for its cap), never LLM-judged.
       * #393 B: similarity-source pairs only; the scout's FTS pairs are
       * exempt (no similarity gate — cosine never blocks that source).
       */
      skipped_above_ceiling: number;
      /**
       * #392: judged merge pairs refused by the project rail (project
       * disagreement — the only metadata rail, #206 decision 2). Both
       * memories kept; the cursor advances — the verdict was rendered, this
       * is not an infra failure.
       */
      skipped_project_mismatch: number;
      /**
       * #393 guard-C: verdicts that flagged a genuine conflict — a `conflicts`
       * link was written, both memories stay live (no status change, no
       * rewrite, no merge queue).
       */
      conflict_flagged: number;
      /**
       * #393 guard-C: merges refused because the pair (deterministic-zone
       * cluster or judged merge) holds a `conflicts` link — aggregates the
       * judged-path refusals plus the zone's `skipped_conflict`. Both records
       * kept live in every case.
       */
      conflict_skipped: number;
      /**
       * #393 B: memories given the scout's correction-shape call this run
       * (ONE classify-tier call per scanned candidate; always 0 on dry-run —
       * the shape call is LLM work, and dry-runs make zero LLM calls).
       */
      scout_scanned: number;
      /** #393 B: shape verdicts that flagged a correction/retraction/supersession. */
      scout_correction_shaped: number;
      /**
       * #393 B: FTS hits that became candidate pairs — the scout's share of
       * pairs_discovered (after older-only/self filtering and dedup against
       * the KNN neighbors; a pair found by both sources counts as
       * similarity). Counted before the idempotency skip, the #394 discipline.
       */
      scout_candidates_found: number;
      /**
       * #392: per-run verdict statistics by cosine band ("0.75-0.8" …
       * ">=0.92"; labels derive from the live floor/ceiling). Calibration
       * evidence for moving the boundaries later; the cumulative series lives
       * in state.json `resolutionBandStats`.
       */
      band_stats: Record<string, ResolutionBandStat>;
    };
    decay_prune?: {
      candidates: number;
      pruned: number;
      failed: number;
    };
    /**
     * Strength promotion (#448) — runs PRE-SKIP (quiet nights still promote
     * the day's uses), BEFORE memory_cap eviction (a promoted row survives a
     * cap it would otherwise lose). Zero LLM: it sits in the deterministic
     * zone, before the BudgetTracker exists.
     */
    promotion?: {
      /** Memories whose base_strength was bumped this run (delta iterations). */
      promoted: number;
      /**
       * Demotion-set rows (superseded/retracted/absorbed + superseded_by-link
       * sources) with a use delta — no bump, baseline advanced only.
       */
      demoted_skipped: number;
    };
    /** Capacity eviction (#245) — runs after decay_prune. When the corpus
     *  exceeds `memorySoftCap`, the lowest-effectiveStrength memories are
     *  evicted until under the cap. `cap = 0` (disabled) → evicted = 0. */
    memory_cap?: {
      /** The configured cap (always reported, including 0 = disabled). */
      cap: number;
      /** Memories deleted this run (0 when under cap, dry-run, or disabled). */
      evicted: number;
    };
  };
  budget?: {
    max_calls: number;
    calls_used: number;
    calls_remaining: number;
    calls_by_stage: Record<string, number>;
    /**
     * True when `calls_used >= max_calls` at run end (#255). The run continued
     * to completion (no abort) but LLM-bound stages past the boundary deferred
     * their remaining work — a quality-degradation signal, not a failure.
     * Absent on pre-#255 reports; treat as false.
     */
    exhausted?: boolean;
    /**
     * Per-stage count of LLM-call REQUESTS refused because the budget was
     * exhausted (#255). Keys are the same stage labels passed to
     * `BudgetTracker.use()`. The value is the SUM of the `count` args passed
     * to each refused `use()` call in that stage — in production every `use()`
     * call passes count=1, so a stage present here with count N hit the
     * boundary and had N further single-call requests denied (stages break on
     * first refusal, so N is small per stage). For item-level "how many
     * memories/pairs were skipped" see the per-stage reports (e.g.
     * stages.importance.skipped_budget), which count MEMORIES not call
     * requests. Absent on pre-#255 reports.
     */
    deferred_by_stage?: Record<string, number>;
    /**
     * Token usage per stage (#246). Each value sums prompt + completion +
     * total across every metered LLM call in that stage this run. A stage with
     * no metered calls (claude-cli path, or stage didn't run) is absent — the
     * dashboard treats absent as "no signal", distinct from zero.
     */
    tokens_by_stage?: Record<string, { prompt: number; completion: number; total: number }>;
    /** Run-wide token totals (#246) — sum of every recordUsage call this run. */
    tokens_total?: { prompt: number; completion: number; total: number };
  };
}

/** Plugin configuration from openclaw.plugin.json configSchema. */
export interface HicortexConfig {
  licenseKey?: string;
  /** Hicortex server URL. Defaults to http://127.0.0.1:8787 (co-located server). */
  serverUrl?: string;
  /** Bearer token for the Hicortex server. Localhost bypasses auth by default. */
  authToken?: string;
  /**
   * Optional PRIOR bearer token kept around during rotation (#254). When set,
   * BOTH `authToken` and `authTokenPrevious` are accepted (constant-time,
   * zero-downtime rotation). Absent/empty → single-token behaviour. Rotate by
   * writing the new value to `authToken` and the old value here, then later
   * clearing this key once all clients have switched.
   */
  authTokenPrevious?: string;
  /**
   * Stable per-install UUID generated by `init` (see ensureAgentId in init.ts;
   * never rotated). Attribution identity of the capturing client — stored on
   * each captured memory as `source_agent_id` (see Memory.source_agent_id) and
   * sent on every /distill segment. Survives agent/machine renames, unlike the
   * readable `source_agent` name. Pure attribution; nothing filters or scopes
   * on it. (0.16.x)
   */
  agentId?: string;
  /** @deprecated Use the Hicortex server for distillation and consolidation. */
  llmBaseUrl?: string;
  /** @deprecated Use the Hicortex server for distillation and consolidation. */
  llmApiKey?: string;
  /** @deprecated Use the Hicortex server for distillation and consolidation. */
  llmModel?: string;
  /** @deprecated Consolidation is owned by the server nightly. */
  consolidateHour?: number;
  /** @deprecated The OC plugin no longer opens its own database. */
  dbPath?: string;
  /**
   * Client-declared topic/domain of THIS capturing agent (provenance only,
   * 0.16.x). Sent on captured memories as `source_domain` (see
   * Memory.source_domain) — NOT used for recall filtering or scoring, and NOT
   * the content-classified primary (which is the server-derived `domain`
   * column on each memory, classified against `domains` below).
   *
   * DISTINCT from `domains` (plural) directly below: `domains` is the
   * config-owned VOCABULARY — the server's life-sphere list that memories are
   * content-classified against; this singular `sourceDomain` is the client
   * declaring "I am an agent that works on topic X", recorded as provenance on
   * what it captures. Do not conflate the two. (Renamed from `domain` in
   * 0.16.x — one char from `domains`, meant something unrelated.)
   */
  sourceDomain?: string;
  /**
   * Optional config-owned domain list — the user's top-level memory spheres
   * (life areas OR project/topic areas). When present, the nightly multi-tag
   * classifies each memory by CONTENT against this vocabulary (classify tier,
   * falling back to the reflect tier) instead of grouping projects into
   * LLM-invented domains. When ABSENT, the legacy project-grouping
   * moduleIndex behaviour is unchanged.
   *
   * Server-mode `init` scaffolds a generic 5-domain default (Work, Personal,
   * People, Health, Finance — see GENERIC_DEFAULT_DOMAINS in init.ts) when
   * this key is absent, and NEVER touches an existing list. A power-user
   * example (a wider life-sphere set) ships as
   * domains.example.json in the package root.
   *
   * NO fallback bucket is needed or special-cased (owner amendment 07.07):
   * a genuine no-fit memory gets a WEAK primary from prototype cosines when
   * possible, else it decays toward pruning (see nofit.ts). A domain named
   * "Unsorted" — if configured — is just a normal domain.
   */
  domains?: DomainDef[];
  /**
   * Success-cooldown (hours) for the CAPTURE watchdog (0.17). The capture
   * timer fires `nightly --watchdog` on a short interval (~20 min); the
   * watchdog captures only if MORE than this many hours have passed since the
   * last SUCCESSFUL capture (state `lastNightly`). A failed preflight retries
   * on the next tick (~20 min) — so a transient fire-instant network miss
   * costs minutes, not a day (#239). Default 6 (≈4 captures/day). Read at
   * runtime by the watchdog, not by `init`.
   */
  captureCooldownHours?: number;
  /**
   * Hours (0–23, local time) for the CONSOLIDATION timer — the full nightly
   * (capture + distill + score + reflect + link), installed by `init` for
   * server/co-located mode ONLY (0.17). Default [10, 22]: the 22:00 evening
   * slot runs after the day's capture waves (same-day results); the 10:00
   * morning slot runs AFTER the morning's wake-up capture so it catches those
   * pushes. Omitted on client installs (no local DB → no timer). Validated by
   * parseHours.
   */
  consolidationHours?: number[];
  /**
   * The ONE wall-clock budget (minutes) for a nightly run (#405): capture +
   * every consolidation stage share one cooperative deadline, checked at safe
   * boundaries (capture segments, stage boundaries, item loops, the merge
   * zone). A run whose deadline fires reports consolidation status
   * "deferred" and resumes from its cursors next run — no work is lost or
   * redone. Default 240; 0 or invalid → default (a deadline ALWAYS exists —
   * unlike the retired reconsolidationMaxMinutes, 0 is not "off"). The
   * systemd unit's TimeoutStartSec is derived from this (budget + 60 min
   * slack) at init.
   */
  nightlyTimeBudgetMinutes?: number;
  /**
   * The ONE per-run ceiling on LLM calls across the whole nightly pipeline
   * (#405; successor of consolidateMaxLlmCalls, #241). Consumed in run
   * order — run order IS the fair share; a stage that exhausts the budget
   * defers its remainder to the next run via its cursor. Bounds money/load
   * independent of latency: a fast metered or capacity-limited endpoint
   * permits thousands of calls inside the wall-clock budget. Default 5000;
   * 0 or invalid → default. The legacy `consolidateMaxLlmCalls` key is
   * honored as a deprecated alias for one release.
   */
  nightlyLlmCallBudget?: number;
  /**
   * Release channel pinned into the generated daemon/timer ExecStart for
   * **npx-thin** installs (global-binary installs use the absolute binary path
   * and are unaffected). E.g. `"rc"` → the timer runs
   * `npx -y @gamaze/hicortex@rc nightly`, so the host tracks the rc dist-tag
   * (the internal fleet uses this to ride rc through a pre-promotion soak).
   * Absent → auto-detect (bare on `latest`, else `@next`). (0.17.1)
   */
  updateChannel?: string;
  /**
   * Max output tokens for the ONE LLM model used by all phases — distillation,
   * reflection, classification, and scoring. Default 8192. An explicit value
   * overrides the default. A ceiling, not a target: generation stops at the
   * model's natural end (finish_reason stop), so a higher cap costs no latency
   * when it finishes early. Read in llm.ts; see #220.
   */
  maxTokens?: number;
  /**
   * Toggle the model's internal reasoning ("thinking") stream on the openai-compat
   * path — applies to ALL phases (distill / reflect / classify / scoring) since one
   * model serves all of them. Default false. A thinking model with thinking ON can
   * burn the entire token budget on an unclosed <think> block and emit nothing
   * (probed 2026-08-04). When set (true or false), completeOpenAiCompat sends
   * chat_template_kwargs:{enable_thinking}. LOCAL-ENDPOINT ONLY: this is meaningful
   * only for a chat-template-aware server (ollama, mlx-lm). If the one model is a
   * cloud OpenAI-compatible endpoint (OpenAI / OpenRouter / Groq / z.ai), LEAVE THIS
   * UNSET — the non-standard chat_template_kwargs field rides every call and can 400
   * the whole pipeline (provider cannot distinguish MLX-gateway-as-openai from real
   * cloud openai, so the gate must be operator-set, not detected). No effect on the
   * anthropic or claude-cli paths. See #220, #231.
   */
  enableThinking?: boolean;
  /**
   * ONE per-attempt timeout ceiling (ms) for every LLM phase — distill,
   * reflect, classify, and scoring alike (#337). Default 900000 (15 min). The
   * openai-compat and anthropic requests fetch through an undici dispatcher
   * with undici's hidden 5-minute header/body timers disabled, so this knob is
   * the ONLY ceiling: a legitimate long generation is no longer abandoned
   * client-side at 5 min while the server keeps generating for the dead
   * client (the 2026-08-23/24 incident's amplification mechanism). Before
   * #337, scoring used a 600 s ceiling and the other phases 900 s; one knob
   * now covers all four. No effect on the ollama path (already streams) or
   * claude-cli (subprocess timeout).
   */
  llmTimeoutMs?: number;
  /**
   * Timeout (ms) for the readiness probe's single 1-token generation attempt
   * (#337). Default 60000. The probe asks "can this endpoint GENERATE", which
   * /health-style liveness checks cannot answer (a wedged gateway keeps
   * answering /v1/models). Read by the nightly before consolidation and by the
   * daemon before distilling.
   */
  llmProbeTimeoutMs?: number;
  /**
   * How long (ms) the daemon caches a /distill probe outcome before probing
   * again (#337). Default 300000 — a healthy capture cadence pays at most one
   * probe per window. Nightly runs are single-shot and never cache.
   */
  llmProbeTtlMs?: number;
  /**
   * Max lessons injected into an agent's session-start context (default 10).
   * Lessons are ranked per-session by project/domain affinity + recency +
   * strength + access, so each session sees its most-relevant slice. Lower =
   * leaner system prompts.
   */
  lessonsLimit?: number;
  /**
   * Default project name for the OpenClaw plugin (#316, Hermes `default_project`
   * parity): sent as the `project` fallback on /recall-index, the pre-0.14
   * /search fallback, and the search/recent/ingest tools whenever the gateway
   * supplies no project. Absent ⇒ no scope sent.
   */
  defaultProject?: string;
  /**
   * Max memories per recall on the OpenClaw plugin's legacy /search fallback
   * (pre-0.14 servers, #316). Default 8. Does NOT size the pushed
   * /recall-index — that is sized by the server's release-managed calibration
   * (#408); the server accepts no client limit.
   */
  recallLimit?: number;
  /**
   * OC plugin (#326): auto-scaffold the dead-man guard line into the agent
   * workspace bootstrap file (BOOTSTRAP.md) at service start — the #313
   * SECONDARY layer under the injected IDENTITY UNAVAILABLE banner (which is
   * the primary, plugin-side mechanism). Idempotent: a bootstrap already
   * carrying the line is never rewritten. Default true; `false` disables both
   * the write and any file creation entirely.
   */
  scaffoldDeadMan?: boolean;
  /**
   * Soft cap on the memory corpus (default 10000). When the corpus exceeds this,
   * the nightly's capacity-eviction stage (#245) removes the lowest-
   * `effectiveStrength` memories (ties broken by oldest access) until under the
   * cap. `0` = disabled (indefinite growth — the pre-#245 behaviour). This is
   * the active forgetting mechanism that replaces the inert time-based prune
   * (`effectiveStrength < 0.01` in stageDecayPrune, which essentially never
   * fires given the strength floor + 365-day half-life). At 10K memories the
   * load + JS sort is <100 ms. The evicted tail is cold by construction
   * (effectiveStrength is the same decay-weighted score used in recall ranking,
   * so these were not surfacing in the top-k anyway).
   */
  memorySoftCap?: number;
  /**
   * Hosted-service mode (issue #110, #271 — spec 2026-07-27 §1-§2). When true,
   * the server enforces hosted-tenant constraints at boot: it refuses to start
   * if `HICORTEX_DB_PATH` is set (path-override attacks) or if the localhost
   * auth-bypass marker file is present (hosted must be fail-closed — no bypass).
   * Absent/false (the self-hosted default) → the assertions never fire and
   * behaviour is unchanged. Read at server boot via readStrictBoolean.
   */
  hostedMode?: boolean;
  /**
   * Monthly fair-use ceiling on consolidation LLM token consumption (#246).
   * Default `0` = unlimited (the self-hosted default — no cap, never throttled).
   * When > 0: before each consolidation run, the nightly checks
   * `llmTokensThisPeriod.total + llmTokensLastRun > llmTokensPerMonth`; if so,
   * consolidation is skipped and telemetry reports `consolidation: "throttled"`.
   * The estimate uses the previous run's actual usage as a proxy — conservative
   * (over-throttle vs over-spend) since a throttled night just defers work to
   * the next period. The hosted service sets this per-tenant to defend against
   * noisy neighbors; a self-hosted user on a free local model has no reason to
   * set it. Period resets monthly (state.json `llmTokensThisPeriod.periodStart`).
   */
  llmTokensPerMonth?: number;
  /**
   * Max request body size in MB accepted by the REST/MCP server (#7). The body
   * is fully JSON-parsed into memory before the distiller truncates content to
   * 80K chars, so an unbounded body is an OOM vector — a tenant (hosted) or a
   * misbehaving client could POST a huge payload to exhaust RAM. Default: 25 MB
   * self-hosted (unchanged), 5 MB hosted (the spec §6.3 figure — ~25× the 200KB
   * segment max, so legitimate capture never approaches it; it's a pure
   * abuse/OOM backstop). Oversized bodies get HTTP 413.
   */
  distillBodyLimitMb?: number;
  /**
   * Output directory for backup artifacts (#6). Default `<HICORTEX_HOME>/backups`.
   * Both the CLI (`hicortex backup`) and the nightly backup stage resolve this
   * before calling createBackup; an unset value falls back to the home dir.
   * Operator-owned: point at a mounted backup volume, a tmpfs, etc.
   */
  backupDir?: string;
  /**
   * Backup retention (#327): how many of the newest `hicortex-*.tar.gz`
   * artifacts the backup dir keeps after each successful write. Default 7;
   * 0 keeps everything. Without it every full nightly (and `hicortex backup`)
   * adds an artifact forever — unbounded growth, per hosted tenant too. Only
   * artifacts matching the product's own name pattern are ever pruned.
   */
  backupRetention?: number;
  /**
   * Post-backup offsite hook (#6). When set, `hicortex backup` and the nightly
   * backup stage invoke this command with the artifact path appended as the LAST
   * arg (e.g. `"rclone copyto"` → `rclone copyto <path> remote:bucket/`). Cloud
   * credentials + active alerting (email/Discord) stay in the operator's wrapper
   * script, out of the product. The hook is split on whitespace (no shell); a
   * command with quoted args containing spaces should be a wrapper script. A
   * failing/missing/timed-out hook reports `{ok:false}` and never throws —
   * capture/consolidation have already succeeded, so a backup-hook failure must
   * not fail the nightly. 5 min timeout.
   */
  backupCommand?: string;
  /**
   * Account identity shown in the dashboard header (hosted). When ALL three
   * are absent the header renders no account element (self-hosted default —
   * nothing changes). Strings only; read via readStringConfig, null when
   * absent/not a string. Set per-tenant by provision-tenant.sh.
   */
  displayName?: string;
  /** Organization name — rendered alongside displayName as "Name · Org". */
  orgName?: string;
  /** Plan/tier label rendered as a small badge (e.g. "Cloud · Early bird"). */
  planLabel?: string;
}

/** A config-owned life-sphere domain (see HicortexConfig.domains). */
export interface DomainDef {
  name: string;
  description: string;
}

/** Response from license validation API. */
export interface LicenseInfo {
  valid: boolean;
  tier: "free" | "pro" | "lifetime" | "team";
  features: {
    reflection: boolean;
    vectorSearch: boolean;
    maxMemories: number;
    crossAgent: boolean;
    remoteIngest?: boolean;
  };
  email?: string;
  expires_at?: string;
}

/** A knowledge domain grouping related projects. */
export interface ModuleDomain {
  name: string;
  projects: string[];
  memoryCount: number;
  lessonCount: number;
  keywords: string[];
  /**
   * One-line description — only populated for content-based (config-owned)
   * domains. Empty for project-grouping domains.
   */
  description?: string;
}

/** Auto-generated knowledge routing index, cached in state.json. */
export interface ModuleIndex {
  domains: ModuleDomain[];
  /**
   * Cache-invalidation key.
   *   - Project-grouping mode: sha256 of the sorted PROJECT name set.
   *   - Content-based mode: sha256 of the sorted configured DOMAIN name set.
   * A single field keeps the state shape stable; `mode` disambiguates.
   */
  projectSetHash: string;
  curatedAt: string;
  totalMemories: number;
  totalLessons: number;
  /**
   * How this index was built. Absent = legacy project-grouping (backward
   * compatible). "content" = per-memory content classification from the
   * config-owned `domains` list.
   */
  mode?: "project" | "content";
}

/** Options for inserting a memory. */
export interface InsertMemoryOptions {
  sourceAgent?: string;
  sourceSession?: string | null;
  /** Stable client UUID (config.json `agentId`). Attribution only. */
  sourceAgentId?: string | null;
  /** Client-declared topic/domain of the capturing agent. Provenance only. */
  sourceDomain?: string | null;
  /** Machine the capture ran on (#421 machine × harness identity). Provenance
   *  only — stamped by the nightly (config `machineName` ?? os.hostname()),
   *  accepted optionally from /distill + /ingest. Null on pre-v15 rows. */
  sourceMachine?: string | null;
  project?: string | null;
  /** 0.16.x: vestigial — stored but never filtered. null (or absent) when the
   *  caller doesn't declare one; an explicit value is honored as-is. */
  privacy?: string | null;
  memoryType?: string;
  baseStrength?: number;
  createdAt?: string;
}

/** Options for vector search. */
export interface VectorSearchOptions {
  limit?: number;
  excludeIds?: string[];
}

