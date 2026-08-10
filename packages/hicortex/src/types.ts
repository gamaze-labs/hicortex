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
  memory_type: "episode" | "lesson" | "fact" | "decision";
  updated_at: string | null;
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

/** Report returned by the consolidation pipeline. */
export interface ConsolidationReport {
  started_at: string;
  completed_at?: string;
  dry_run: boolean;
  status: "completed" | "skipped" | "failed";
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
       * cosine >= weakPrimaryFloor) after the LLM found no fitting domain.
       */
      weak_primary?: number;
      /**
       * No-fit path: memories below the weak-primary floor — untagged,
       * base_strength halved (accelerated decay toward prune).
       */
      no_association_decayed?: number;
      reason?: string;
    };
    hub_boost?: {
      hubs_found: number;
      boosted: number;
    };
    links?: {
      auto_linked: number;
      llm_classified?: number;
      heuristic_fallback?: number;
      failed: number;
    };
    /** Supersession detection (#191 Phase B) — runs after linking, before decay/prune. */
    supersession?: {
      /** Decision/correction-shaped candidates examined this run. */
      scanned: number;
      /** Older-neighbor pairs actually sent to the classify-tier LLM. */
      evaluated: number;
      /** Pairs the LLM judged superseded — a `superseded_by` link was created. */
      superseded: number;
      /** Pairs skipped on a parse/infra error (retried naturally next night). */
      skipped_infra: number;
      /** Pairs skipped because a superseded_by link already existed (either direction). */
      skipped_idempotent: number;
      /** supersessionCursor after this run (unchanged in dry-run). */
      cursor: number;
    };
    decay_prune?: {
      candidates: number;
      pruned: number;
      failed: number;
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
   * example (custom weakPrimaryFloor) ships as
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
   * Ceiling on total LLM calls across all classify-tier consolidation stages
   * (content-domain, link discovery, supersession) per nightly run (0.17, #241).
   * A runaway backstop, not a throughput throttle — on a free local model the
   * binding constraint is the nightly unit's wall-clock timeout, not call count.
   * Default `5000` (was a hard-coded 200 that starved link/supersession during a
   * classification backlog and drained large backlogs at ~cap/night).
   */
  consolidateMaxLlmCalls?: number;
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
   * Minimum cosine(memory embedding, best domain prototype) for a no-fit
   * memory to earn a WEAK primary instead of decaying (see nofit.ts).
   * Number in (0, 1); default 0.45. Tune from the corpus weight distribution
   * (the memory_tags.weight histogram of LLM-tagged rows — set the floor
   * near its lower tail). See domains.example.json for a worked example.
   */
  weakPrimaryFloor?: number;
  /**
   * Per-attempt timeout (ms) for the CLIENT nightly's pre-flight GET /health
   * check before capturing (#163). Default 15000. Overridable per machine —
   * a wired Pi vs a sleeping laptop want different values. See runClientNightly
   * in nightly.ts. No effect in server mode (server capture is localhost).
   */
  preflightTimeoutMs?: number;
  /**
   * Max attempts for the client nightly's pre-flight /health retry loop (#163).
   * Default 3. Attempts are spaced preflightRetryGapMs apart; on exhaustion the
   * run aborts with a non-zero exit code and an ok=false telemetry ping so the
   * failure is visible to systemd/launchd and the activity aggregate.
   */
  preflightAttempts?: number;
  /**
   * Gap (ms) between pre-flight /health attempts in the client nightly (#163).
   * Default 60000. Wall-clock-optimistic on a sleeping laptop — setTimeout does
   * NOT advance while macOS is asleep, so real elapsed time can exceed the
   * nominal worst case. Not a defect (capture lock isn't held; cursor design is
   * dup-over-loss); just don't treat the nominal sum as a hard bound.
   */
  preflightRetryGapMs?: number;
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
   * Context window for ollama (the one model, all phases). Default 8192 — the point
   * where context stops being the binding constraint for a sub-8B model on ollama
   * (above it the SMALL_MODEL_MAX_CHUNK_CHARS speed cap binds instead, so extra
   * context buys nothing). Also drives `detectChunkSize`'s chunk sizing
   * (chunkChars ≤ numCtx × 0.6 × 4 chars), so numCtx is the single dial and the
   * chunker/request agreement is enforced by construction (#228). For an ≥8B model
   * on ollama the speed cap is 60,000 chars, needing numCtx ≈ 25000 to reach — raise
   * it if running 8B+ locally. No effect for non-ollama providers.
   */
  numCtx?: number;
  /**
   * Flush ollama's accumulated memory every N scoring calls — workaround for
   * ollama's per-request memory growth (the runner's RSS climbs ~171 MB/call and
   * isn't freed between requests), which swap-thrashes RAM-constrained boxes
   * during long consolidations. Default 0 (off). When >0, every Nth scoring call
   * (`completeFast`) triggers a `keep_alive:0` unload + an `ollamaFlushWaitMs`
   * pause for the runner to exit + release, then the next call reloads fresh.
   * N=15 caps a cycle at ~2.5 GB. Scoped to the fast tier (scoring) only. Note:
   * N counts **logical** scoring calls, not raw HTTP requests — `complete()`
   * retries up to 4× on timeout, so under retry pressure the actual accumulation
   * may be up to 4×N calls' worth. In practice the flush prevents the thrash that
   * causes retries, keeping the count accurate.
   */
  ollamaFlushEvery?: number;
  /**
   * Milliseconds to wait after an ollama flush (`keep_alive:0`) for the runner
   * to exit + release its accumulated memory before the next call reloads.
   * Default 180000 (3 min — the runner takes >90 s to exit after keep_alive:0;
   * doubled for margin). Only relevant when `ollamaFlushEvery` > 0.
   */
  ollamaFlushWaitMs?: number;
  /**
   * Max lessons injected into an agent's session-start context (default 10).
   * Lessons are ranked per-session by project/domain affinity + recency +
   * strength + access, so each session sees its most-relevant slice. Lower =
   * leaner system prompts.
   */
  lessonsLimit?: number;
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

