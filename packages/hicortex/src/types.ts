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
  };
  budget?: {
    max_calls: number;
    calls_used: number;
    calls_remaining: number;
    calls_by_stage: Record<string, number>;
  };
}

/**
 * A single per-stage override inside the nested `models` server-config block.
 * Consumed by `applyModelsBlock` (llm.ts), which re-exports this type.
 */
export interface ModelTierOverride {
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  provider?: string;
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
  /** @deprecated Use the Hicortex server for distillation and consolidation. */
  reflectModel?: string;
  /**
   * Optional dedicated model for memory tag classification (server-side
   * nightly + `hicortex classify-domains`). When unset, classification uses
   * the reflect tier exactly as before.
   */
  classifyModel?: string;
  /**
   * Optional dedicated endpoint for classification. When only classifyModel
   * is set, it runs on the reflect endpoint (else the base endpoint).
   */
  classifyBaseUrl?: string;
  /** Optional API key for the classify endpoint (defaults to the base apiKey). */
  classifyApiKey?: string;
  /** Optional provider for the classify endpoint (defaults to the base provider). */
  classifyProvider?: string;
  /**
   * Server config (NOT an OC-plugin key): nested per-stage model overrides.
   * `{ score|distill|reflect|classify: { model?, baseUrl?, apiKey?, provider? } }`.
   * Normalized onto the flat `llm*` / `distill*` / `reflect*` / `classify*`
   * keys at read time (see applyModelsBlock in llm.ts); nested wins, and the
   * flat keys remain supported at lower precedence. Happy path is a single model via
   * `llmModel`; use this block only for per-stage routing. `score.provider` is
   * ignored (base provider comes from llmBackend).
   */
  models?: Record<string, ModelTierOverride>;
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

