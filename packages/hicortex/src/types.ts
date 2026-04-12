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
    links?: {
      auto_linked: number;
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
  llmBaseUrl?: string;
  llmApiKey?: string;
  llmModel?: string;
  reflectModel?: string;
  consolidateHour?: number;
  dbPath?: string;
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
