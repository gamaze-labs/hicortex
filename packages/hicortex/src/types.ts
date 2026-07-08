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
  project: string | null;
  domain: string | null;
  privacy: "PUBLIC" | "WORK" | "PERSONAL" | "SENSITIVE";
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
  created_at: string;
  connections: number;
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

/** Plugin configuration from openclaw.plugin.json configSchema. */
export interface HicortexConfig {
  licenseKey?: string;
  /** Hicortex server URL. Defaults to http://127.0.0.1:8787 (co-located server). */
  serverUrl?: string;
  /** Bearer token for the Hicortex server. Localhost bypasses auth by default. */
  authToken?: string;
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
  /** @deprecated Consolidation is owned by the server nightly. */
  consolidateHour?: number;
  /** @deprecated The OC plugin no longer opens its own database. */
  dbPath?: string;
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
   * example (compartment flag, custom weakPrimaryFloor) ships as
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
}

/** A config-owned life-sphere domain (see HicortexConfig.domains). */
export interface DomainDef {
  name: string;
  description: string;
  /**
   * Deliberate compartmentalization (graded-schema spec, 07.07.2026): when
   * true, this domain becomes the PRIMARY (memories.domain) whenever it is
   * tagged, overriding the argmax-weight rule. The owner's config flags only
   * Work — a work/life firewall. Optional; absent = false.
   */
  compartment?: boolean;
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
  project?: string | null;
  privacy?: string;
  memoryType?: string;
  baseStrength?: number;
  createdAt?: string;
}

/** Options for vector search. */
export interface VectorSearchOptions {
  limit?: number;
  excludeIds?: string[];
}

/** Options for FTS search. */
export interface FtsSearchOptions {
  limit?: number;
  privacy?: string[];
  sourceAgent?: string;
}

/** Options for retrieval. */
export interface RetrievalOptions {
  limit?: number;
  project?: string | null;
  privacy?: string[];
  sourceAgent?: string;
}
