/**
 * Nightly consolidation pipeline — importance scoring, reflection,
 * link discovery, decay/prune.
 * Ported from hicortex/consolidate/ (stages.py, __init__.py, budget.py).
 */

import type Database from "better-sqlite3";
import type { Memory, ConsolidationReport, ModuleIndex, ModuleDomain } from "./types.js";
import type { LlmClient } from "./llm.js";
import type { EmbedFn } from "./retrieval.js";
import { effectiveStrength, l2ToCosine } from "./retrieval.js";
import * as storage from "./storage.js";
import { importanceScoring, reflection, domainCuration } from "./prompts.js";
import { createHash } from "node:crypto";
import { isPro } from "./features.js";
import { louvainCommunities, detectHubs } from "./graph.js";
import { loadState, updateState } from "./state.js";
import {
  classifyMemoryTags,
  domainSetHash,
  type DomainDef,
} from "./domain-classify.js";
import {
  computeDomainPrototypes,
  computeTagWeights,
  recomputeAllTagWeights,
  refreshPrimaries,
} from "./schema-prototypes.js";
import {
  DEFAULT_WEAK_PRIMARY_FLOOR,
  applyNoAssociationDecay,
  applyWeakPrimary,
  resolveNoFit,
} from "./nofit.js";

// Default config constants (matching Python config.py)
/**
 * Default ceiling on total LLM calls across all classify-tier consolidation
 * stages (content-domain, link discovery, supersession) per run. This is a
 * runaway BACKSTOP, not a throughput throttle — on a free local model there is
 * no per-call cost to defend against; the binding constraint is the nightly
 * unit's wall-clock timeout (TimeoutStartSec), not call count. 5000 clears a
 * one-time classification backlog (a ~2000-memory batch drains in ~1-2 runs
 * instead of ~11 nights at the old 200) with margin for link/supersession, and
 * ~5000 calls x ~1-3s/call ≈ 1.4-4.2h fits the 6h consolidation backstop.
 * Config-overridable as `consolidateMaxLlmCalls` (#241).
 */
export const CONSOLIDATE_MAX_LLM_CALLS = 5000;
const CONSOLIDATE_PRUNE_MIN_AGE_DAYS = 90;
/**
 * Minimum COSINE similarity for a link candidate.
 *
 * Calibration (2026-07): measured top-10 neighbor cosine histogram on the
 * ~3000-memory production corpus. Typical top-1 neighbor cosine:
 * median 0.823, p10 0.743, p90 0.902. Threshold 0.75 combined with the
 * top-3 cap yields ≈ 2.2 candidate links/memory. The previous value (0.55)
 * lived on an accidental 1−L2 scale where it required cosine > 0.90 — a
 * near-duplicate detector that linked only 12% of memories.
 */
export const CONSOLIDATE_LINK_THRESHOLD = 0.75;
/** Max link candidates kept per memory (highest-cosine neighbors first). */
export const CONSOLIDATE_LINK_TOP_K = 3;
/**
 * Minimum COSINE similarity for a CROSS-PROJECT link candidate.
 *
 * A 672-link audit (17 LLM judges, 2026-07) found cross-project links were 65%
 * wrong-link vs 6% for same-project, and that strength (cosine) predicts quality
 * (wrong-link 42% → 6% across strength quartiles). Cross-project pairs must clear
 * a much higher bar than the same-project 0.75 to survive discovery. Same-project
 * links keep CONSOLIDATE_LINK_THRESHOLD (0.75).
 */
export const CROSS_PROJECT_LINK_THRESHOLD = 0.8;

/**
 * l2ToCosine moved to retrieval.ts (#145) — consolidate.ts already imports
 * from retrieval, so retrieval is the circular-dependency-safe home.
 * Re-exported here so pre-#145 importers and tests keep working unchanged.
 */
export { l2ToCosine } from "./retrieval.js";

/**
 * Minimum TRUE cosine similarity between a new lesson and an existing one
 * for the existing lesson to count as a contradiction-check candidate
 * (stageReflection). 0.80 = "strongly similar lesson" — the original intent.
 * Before #145 the check was `1 − L2 > 0.80`, which required cosine > 0.98,
 * so lesson-contradiction suppression effectively never fired.
 */
export const REFLECTION_CONTRADICTION_MIN_COSINE = 0.8;

/** True when an L2 neighbor distance clears the contradiction-check bar. */
export function isContradictionCandidate(distance: number): boolean {
  return l2ToCosine(distance) > REFLECTION_CONTRADICTION_MIN_COSINE;
}

// ---------------------------------------------------------------------------
// BudgetTracker
// ---------------------------------------------------------------------------

export class BudgetTracker {
  maxCalls: number;
  callsUsed = 0;
  callsByStage: Record<string, number> = {};
  /**
   * Token usage per stage (#246). Keys are the same stage labels passed to
   * `use()`. A stage that made no metered calls (no usage returned — never the
   * path on a healthy openai/ollama endpoint) is absent, NOT zero, so the
   * dashboard can distinguish "nothing spent" from "no signal".
   */
  tokensByStage: Record<string, { prompt: number; completion: number; total: number }> = {};
  /** Run-wide totals — the sum of every recordUsage() call this run. */
  totalTokens: { prompt: number; completion: number; total: number } = {
    prompt: 0,
    completion: 0,
    total: 0,
  };

  constructor(maxCalls: number) {
    this.maxCalls = maxCalls;
  }

  get exhausted(): boolean {
    return this.callsUsed >= this.maxCalls;
  }

  get remaining(): number {
    return Math.max(0, this.maxCalls - this.callsUsed);
  }

  use(stage: string, count = 1): boolean {
    if (this.callsUsed + count > this.maxCalls) {
      console.warn(
        `[hicortex] Budget exhausted: ${this.callsUsed}/${this.maxCalls} used, ` +
          `requested ${count} more (stage: ${stage})`
      );
      return false;
    }
    this.callsUsed += count;
    this.callsByStage[stage] = (this.callsByStage[stage] ?? 0) + count;
    return true;
  }

  /**
   * Record token usage from one LLM call (#246). Called by the consolidation
   * stages after each metered completion. `undefined` usage (claude-cli path,
   * or a non-conforming endpoint that returned no usage object) is a no-op —
   * never recorded as zero, which would silently undercount real spend.
   */
  recordUsage(stage: string, usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined): void {
    if (!usage) return;
    const cur = this.tokensByStage[stage] ?? { prompt: 0, completion: 0, total: 0 };
    cur.prompt += usage.prompt_tokens;
    cur.completion += usage.completion_tokens;
    cur.total += usage.total_tokens;
    this.tokensByStage[stage] = cur;
    this.totalTokens.prompt += usage.prompt_tokens;
    this.totalTokens.completion += usage.completion_tokens;
    this.totalTokens.total += usage.total_tokens;
  }

  summary(): NonNullable<ConsolidationReport["budget"]> {
    return {
      max_calls: this.maxCalls,
      calls_used: this.callsUsed,
      calls_remaining: this.remaining,
      calls_by_stage: { ...this.callsByStage },
      tokens_by_stage: Object.fromEntries(
        Object.entries(this.tokensByStage).map(([k, v]) => [k, { ...v }]),
      ),
      tokens_total: { ...this.totalTokens },
    };
  }
}

// ---------------------------------------------------------------------------
// Token fair-use throttle decision (#246)
// ---------------------------------------------------------------------------

/**
 * Decide whether consolidation should be throttled this run based on the
 * `llmTokensPerMonth` fair-use cap. Pure (no I/O) so it can be unit-tested
 * independently of the nightly wiring.
 *
 * Returns `{ throttle: true, used, cap }` when the projected post-run total
 * would exceed the cap; `{ throttle: false }` otherwise. The estimate is the
 * previous run's actual usage (`llmTokensLastRun`, 0/absent on the first
 * metered run = never throttle the first run — no baseline yet).
 *
 * `cap = 0` (the self-hosted default) → never throttle (unlimited).
 * `periodStart` in a previous calendar month → period resets to 0 first
 * (mirrors the reset logic in nightly.ts; both sides agree because both read
 * the same state + clock).
 */
export function shouldThrottleTokens(
  cap: number,
  period: { total: number; periodStart: string } | undefined,
  lastRunTokens: number,
  now: Date = new Date(),
): { throttle: boolean; used?: number; cap?: number } {
  if (cap <= 0) return { throttle: false };
  let periodTotal = period?.total ?? 0;
  const periodStart = period?.periodStart;
  if (periodStart) {
    const start = new Date(periodStart);
    if (start.getUTCFullYear() !== now.getUTCFullYear() ||
        start.getUTCMonth() !== now.getUTCMonth()) {
      // Stale period → reset accrual to 0 before the check.
      periodTotal = 0;
    }
  }
  if (periodTotal + lastRunTokens > cap) {
    return { throttle: true, used: periodTotal, cap };
  }
  return { throttle: false };
}

// ---------------------------------------------------------------------------
// JSON parsing helper
// ---------------------------------------------------------------------------

/**
 * Parse JSON from LLM output, tolerating markdown fences and indexed formats.
 */
export function parseJsonLenient<T>(text: string, fallback: T): T {
  text = text.trim();

  // Strip markdown code fences
  if (text.startsWith("```")) {
    const lines = text.split("\n");
    const stripped = lines.slice(1);
    if (stripped.length > 0 && stripped[stripped.length - 1].trim() === "```") {
      stripped.pop();
    }
    text = stripped.join("\n").trim();
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    // Ignore
  }

  // Handle "[0] 0.7\n[1] 0.6\n..." format
  const indexed = [...text.matchAll(/\[\d+\]\s*([\d.]+)/g)];
  if (indexed.length > 0) {
    try {
      return indexed.map((m) => parseFloat(m[1])) as unknown as T;
    } catch {
      // Ignore
    }
  }

  console.warn(`[hicortex] Failed to parse LLM output: ${text.slice(0, 200)}`);
  return fallback;
}

// ---------------------------------------------------------------------------
// Stage 1: Pre-check
// ---------------------------------------------------------------------------

function readLastConsolidated(): string {
  return loadState().lastConsolidated ?? "";
}

function stagePrecheck(
  db: Database.Database
): {
  skip: boolean;
  reason: string;
  newMemories: Memory[];
  lastDt: string;
} {
  const lastTs = readLastConsolidated();
  const lastDt = lastTs || "1970-01-01T00:00:00.000Z";
  const newMemories = storage.getMemoriesSince(db, lastDt);

  if (newMemories.length === 0) {
    return {
      skip: true,
      reason: "No new memories since last consolidation",
      newMemories: [],
      lastDt,
    };
  }

  return {
    skip: false,
    reason: `${newMemories.length} new memories found`,
    newMemories,
    lastDt,
  };
}

// ---------------------------------------------------------------------------
// Stage 2: Importance Scoring
// ---------------------------------------------------------------------------

async function stageImportance(
  db: Database.Database,
  memories: Memory[],
  llm: LlmClient,
  budget: BudgetTracker,
  dryRun: boolean
): Promise<{ scored: number; failed: number; skipped_budget: number }> {
  const batchSize = 10;
  let scored = 0;
  let failed = 0;
  let skippedBudget = 0;

  for (let i = 0; i < memories.length; i += batchSize) {
    if (budget.exhausted) {
      skippedBudget += memories.length - i;
      break;
    }

    const batch = memories.slice(i, i + batchSize);
    const lines = batch.map(
      (mem, idx) => `[${idx}] ${mem.content.slice(0, 500)}`
    );
    const memoriesBlock = lines.join("\n\n");
    const prompt = importanceScoring(memoriesBlock);

    if (dryRun) continue;

    if (!budget.use("importance")) {
      skippedBudget += memories.length - i;
      break;
    }

    try {
      const r = await llm.completeFast(prompt, 256);
      budget.recordUsage("importance", r.usage);
      let scores = parseJsonLenient<number[] | null>(r.text, null);

      if (!Array.isArray(scores)) {
        scores = new Array(batch.length).fill(0.5);
      }

      while (scores.length < batch.length) scores.push(0.5);
      scores = scores.slice(0, batch.length);

      for (let j = 0; j < batch.length; j++) {
        let scoreVal = 0.5;
        try {
          scoreVal = Math.max(0, Math.min(1, Number(scores[j])));
          if (isNaN(scoreVal)) scoreVal = 0.5;
        } catch {
          scoreVal = 0.5;
        }

        try {
          storage.updateMemory(db, batch[j].id, { base_strength: scoreVal });
          scored++;
        } catch {
          failed++;
        }
      }
    } catch {
      failed += batch.length;
    }
  }

  return { scored, failed, skipped_budget: skippedBudget };
}

// ---------------------------------------------------------------------------
// Stage 2.5: Reflection
// ---------------------------------------------------------------------------

async function stageReflection(
  db: Database.Database,
  memories: Memory[],
  llm: LlmClient,
  budget: BudgetTracker,
  embedFn: EmbedFn,
  dryRun: boolean
): Promise<{
  lessons_generated: number;
  failed?: boolean;
  skipped?: boolean;
  reason?: string;
}> {
  if (memories.length === 0) {
    return { lessons_generated: 0, skipped: true, reason: "no memories" };
  }

  // Build summary
  const lines = memories.slice(0, 50).map((mem) => {
    const project = mem.project ?? "unknown";
    const agent = mem.source_agent ?? "unknown";
    const content = mem.content.slice(0, 300);
    return `[${project}] [${agent}] ${content}`;
  });
  const memoriesBlock = lines.join("\n\n");

  // Feed recent lessons to prevent duplicates and enable escalation
  const recentLessons = storage.getLessons(db, 7).slice(0, 10);
  const recentBlock = recentLessons.length > 0
    ? recentLessons.map(l => `- ${l.content.slice(0, 150)}`).join("\n")
    : undefined;

  const prompt = reflection(memoriesBlock, recentBlock);

  if (dryRun) {
    return { lessons_generated: 0, skipped: false };
  }

  if (!budget.use("reflection")) {
    return { lessons_generated: 0, skipped: true, reason: "budget_exhausted" };
  }

  try {
    const r = await llm.completeReflect(prompt, 2048);
    budget.recordUsage("reflection", r.usage);
    const lessons = parseJsonLenient<unknown[]>(r.text, []);

    if (!Array.isArray(lessons)) {
      return { lessons_generated: 0, failed: true };
    }

    let generated = 0;
    for (const lessonObj of lessons) {
      if (typeof lessonObj !== "object" || lessonObj === null) continue;
      const lo = lessonObj as Record<string, unknown>;

      const lessonText = String(lo.lesson ?? "");
      if (!lessonText) continue;

      const project = String(lo.project ?? "global");
      const lessonType = String(lo.type ?? "principle");
      const severity = String(lo.severity ?? "important");
      const confidence = String(lo.confidence ?? "medium");
      const sourcePattern = String(lo.source_pattern ?? "");

      // No `## Lesson:` prefix: memory_type='lesson' carries the type, and the
      // text is the topic-first first line (display reads the first line, not a
      // header parse — see lessons-context.ts / index.ts).
      let content = `${lessonText}\n\n`;
      content += `**Type:** ${lessonType}\n`;
      content += `**Severity:** ${severity}\n`;
      content += `**Confidence:** ${confidence}\n`;
      if (sourcePattern) content += `**Pattern:** ${sourcePattern}\n`;
      content += `**Generated:** ${new Date().toISOString().slice(0, 10)}`;

      const baseStrength: Record<string, number> = {
        critical: 0.95,
        important: 0.8,
        minor: 0.6,
      };

      try {
        const embedding = await embedFn(content);

        // Contradiction check: find semantically similar existing lessons.
        // If a very similar lesson exists, ask the LLM whether the new one
        // contradicts it. If yes, suppress the new lesson to prevent the
        // "false coherence" failure mode (wrong lessons reinforcing themselves).
        // TRUE cosine > 0.80 (#145): the old `1 − n.distance > 0.80` sat on
        // the accidental 1−L2 scale and required cosine > 0.98 — the check
        // effectively never fired. See isContradictionCandidate.
        const similarLessons = storage.vectorSearch(db, embedding, 3)
          .filter(
            (n) => isContradictionCandidate(n.distance) && n.memory_type === "lesson"
          );

        let contradicted = false;
        if (similarLessons.length > 0 && budget.use("contradiction_check")) {
          const existingText = similarLessons[0].content.slice(0, 300);
          const newText = content.slice(0, 300);
          try {
            const verdictR = await llm.completeFast(
              `Two lessons from an AI memory system. Do they CONTRADICT each other (opposite advice on the same topic)?\n\n` +
              `EXISTING: ${existingText}\n\nNEW: ${newText}\n\n` +
              `Answer ONLY "yes" or "no". If the new lesson updates/refines the existing one (not contradicts), answer "no".`,
              16,
            );
            // Stage label "contradiction_check" matches the budget.use() call
            // above (separate counter from the reflection call proper). Token
            // accounting follows the same stage partition as the call counter.
            budget.recordUsage("contradiction_check", verdictR.usage);
            const verdict = verdictR.text;
            if (verdict.toLowerCase().trim().startsWith("yes")) {
              contradicted = true;
              console.log(
                `[hicortex] Lesson suppressed (contradicts existing): "${lessonText.slice(0, 80)}"`,
              );
            }
          } catch {
            // LLM call failed — don't suppress, store the lesson
          }
        }

        if (!contradicted) {
          storage.insertMemory(db, content, embedding, {
            sourceAgent: "hicortex/reflection",
            project,
            memoryType: "lesson",
            baseStrength: baseStrength[severity] ?? 0.8,
          });
          generated++;
        }
      } catch {
        // Failed to store lesson
      }
    }

    return { lessons_generated: generated, failed: false };
  } catch {
    return { lessons_generated: 0, failed: true };
  }
}

// ---------------------------------------------------------------------------
// Stage 2.7a: Content-based Domain Classification (config-owned domains)
// ---------------------------------------------------------------------------
//
// Active ONLY when config.json carries a `domains` list. Each memory is filed
// into one configured life-sphere by its CONTENT (via the reflect model),
// replacing the project-grouping path. Only NULL or stale-domain rows are
// (re)classified, so re-runs are cheap and a config change re-files affected
// rows. moduleIndex becomes {configured domains + live per-domain counts} so
// /index and the lesson selector keep working.

/**
 * Rebuild moduleIndex from the configured domain set + live DB counts, and
 * persist it. Shared by the nightly stage and `hicortex classify-domains`.
 * `projects` is left empty (content domains don't map to projects); the lesson
 * selector's same-domain boost instead keys off memory.domain directly (it
 * still reads the field). Descriptions are carried through for /index.
 */
export function rebuildContentModuleIndex(
  db: Database.Database,
  domains: DomainDef[],
  stateDir?: string,
): { domains: number } {
  const memRows = db
    .prepare(
      `SELECT domain, COUNT(*) AS cnt FROM memories WHERE domain IS NOT NULL GROUP BY domain`,
    )
    .all() as Array<{ domain: string; cnt: number }>;
  const lessonRows = db
    .prepare(
      `SELECT domain, COUNT(*) AS cnt FROM memories
       WHERE domain IS NOT NULL AND memory_type = 'lesson' GROUP BY domain`,
    )
    .all() as Array<{ domain: string; cnt: number }>;
  const memByDomain = new Map(memRows.map((r) => [r.domain, r.cnt]));
  const lessonByDomain = new Map(lessonRows.map((r) => [r.domain, r.cnt]));

  const moduleDomains: ModuleDomain[] = domains.map((d) => ({
    name: d.name,
    projects: [],
    memoryCount: memByDomain.get(d.name) ?? 0,
    lessonCount: lessonByDomain.get(d.name) ?? 0,
    keywords: [],
    description: d.description,
  }));

  const totalMemories = moduleDomains.reduce((s, d) => s + d.memoryCount, 0);
  const totalLessons = moduleDomains.reduce((s, d) => s + d.lessonCount, 0);

  const moduleIndex: ModuleIndex = {
    domains: moduleDomains,
    projectSetHash: domainSetHash(domains),
    curatedAt: new Date().toISOString(),
    totalMemories,
    totalLessons,
    mode: "content",
  };
  updateState((s) => { s.moduleIndex = moduleIndex; }, stateDir);
  return { domains: moduleDomains.length };
}

async function stageContentDomains(
  db: Database.Database,
  domains: DomainDef[],
  llm: LlmClient,
  budget: BudgetTracker,
  embedFn: EmbedFn,
  dryRun: boolean,
  stateDir?: string,
  weakPrimaryFloor: number = DEFAULT_WEAK_PRIMARY_FLOOR,
): Promise<{
  curated: boolean;
  domains: number;
  classified?: number;
  prototypes?: number;
  weights_recomputed?: number;
  primaries_updated?: number;
  weak_primary?: number;
  no_association_decayed?: number;
  reason?: string;
}> {
  // Rows needing (re)classification:
  //   - domain IS NULL (never classified), OR
  //   - domain NOT IN the current vocabulary (a rename/removal re-files), OR
  //   - no memory_tags rows yet (single-domain memories from feat/content-domains
  //     that have a primary but no tag set — backfill them to multi-tag).
  const placeholders = domains.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT id, content, project FROM memories
       WHERE domain IS NULL
          OR domain NOT IN (${placeholders})
          OR id NOT IN (SELECT DISTINCT memory_id FROM memory_tags)`,
    )
    .all(...domains.map((d) => d.name)) as Array<{
      id: string;
      content: string;
      project: string | null;
    }>;

  if (dryRun) {
    return { curated: false, domains: domains.length, classified: 0, reason: `dry_run (${rows.length} would classify)` };
  }

  const getEmbedFn = async () => embedFn;
  let classified = 0;
  let weakPrimary = 0;
  let noAssociationDecayed = 0;

  if (rows.length > 0) {
    // Prototypes at run start — newly classified memories get their weights
    // from the CURRENT prototypes (the post-classification recompute below
    // refreshes everything from the updated tag sets anyway).
    const { prototypes: startPrototypes } = await computeDomainPrototypes(db, domains, getEmbedFn);

    for (const row of rows) {
      if (budget.exhausted || !budget.use("content_domain")) {
        console.warn(`[hicortex] content-domain: budget exhausted after ${classified} classified`);
        break;
      }
      // classifyMemoryTags returns null ONLY on infra error (throws after retry) —
      // skip that memory, leaving domain/tags/strength untouched so a later
      // run retries it (issue #150: never file or decay on infra errors).
      // The onUsage callback (#246) wires the metered call's token accounting
      // into this stage's BudgetTracker slot — same stage label the budget.use
      // call above uses, so call count + tokens stay aligned.
      const result = await classifyMemoryTags(
        row.content, row.project, domains, llm,
        (u) => budget.recordUsage("content_domain", u),
      );
      if (result === null) {
        console.warn(`[hicortex] content-domain: infra error classifying ${row.id} — skipped (will retry)`);
        continue;
      }
      if (result.tags.length === 0) {
        // Genuine no-fit (owner amendment 07.07): weak primary from the
        // prototype argmax when it clears the floor, else accelerated decay.
        // Each row appears exactly once in `rows`, so a run never
        // double-halves.
        const resolution = resolveNoFit(db, row.id, domains, startPrototypes, weakPrimaryFloor);
        if (resolution.kind === "weak_primary") {
          applyWeakPrimary(db, row.id, resolution.domain, resolution.weight);
          weakPrimary++;
        } else {
          applyNoAssociationDecay(db, row.id);
          noAssociationDecayed++;
        }
        continue;
      }
      const weights = computeTagWeights(db, row.id, result.tags, startPrototypes);
      storage.setMemoryTags(db, row.id, result.tags, { weights });
      classified++;
    }
  }

  // Graded-schema reconsolidation pass — runs EVERY nightly, including when
  // nothing new was classified: prototypes drift with the data, so weights and
  // derived primaries must follow (spec: "recomputed for ALL memory_tags rows
  // each nightly"). Order: prototypes (from the post-classification tag sets)
  // → all weights → derived primaries → moduleIndex counts from the refreshed
  // primaries. No LLM calls — embeddings only.
  const { prototypes, stats } = await computeDomainPrototypes(db, domains, getEmbedFn);
  const { updated: weightsRecomputed } = recomputeAllTagWeights(db, prototypes);
  const { updated: primariesUpdated } = refreshPrimaries(db, domains);
  const seeded = stats.filter((s) => s.seeded).length;

  const { domains: domainCount } = rebuildContentModuleIndex(db, domains, stateDir);
  console.log(
    `[hicortex] Graded tags: ${classified} classified, ${weakPrimary} weak-primary, ` +
      `${noAssociationDecayed} no-association decayed, ${prototypes.size} prototypes ` +
      `(${seeded} description-seeded), ${weightsRecomputed} weights recomputed, ` +
      `${primariesUpdated} primaries updated, ${domainCount} domains indexed`,
  );
  return {
    curated: rows.length > 0,
    domains: domainCount,
    classified,
    prototypes: prototypes.size,
    weights_recomputed: weightsRecomputed,
    primaries_updated: primariesUpdated,
    weak_primary: weakPrimary,
    no_association_decayed: noAssociationDecayed,
    ...(rows.length === 0 ? { reason: "nothing_stale" } : {}),
  };
}

// ---------------------------------------------------------------------------
// Stage 2.7b: Domain Curation (MODULE_INDEX) — project grouping (legacy path)
// ---------------------------------------------------------------------------

async function stageDomainCuration(
  db: Database.Database,
  llm: LlmClient,
  budget: BudgetTracker,
  dryRun: boolean,
  stateDir?: string,
): Promise<{ curated: boolean; domains: number; reason?: string }> {
  // Gather all projects with memory and lesson counts
  const projectRows = db
    .prepare(
      `SELECT project, COUNT(*) as cnt FROM memories
       WHERE project IS NOT NULL GROUP BY project ORDER BY cnt DESC`
    )
    .all() as Array<{ project: string; cnt: number }>;

  if (projectRows.length === 0) {
    return { curated: false, domains: 0, reason: "no_projects" };
  }

  const lessonRows = db
    .prepare(
      `SELECT project, COUNT(*) as cnt FROM memories
       WHERE project IS NOT NULL AND memory_type = 'lesson'
       GROUP BY project`
    )
    .all() as Array<{ project: string; cnt: number }>;
  const lessonsByProject = new Map(lessonRows.map((r) => [r.project, r.cnt]));

  // Cache check: skip if project set unchanged
  const sortedNames = projectRows.map((r) => r.project).sort();
  const projectSetHash = createHash("sha256")
    .update(JSON.stringify(sortedNames))
    .digest("hex");

  const state = loadState(stateDir);
  if (state.moduleIndex?.projectSetHash === projectSetHash) {
    return { curated: false, domains: state.moduleIndex.domains.length, reason: "project_set_unchanged" };
  }

  const totalMemories = projectRows.reduce((s, r) => s + r.cnt, 0);
  const totalLessons = lessonRows.reduce((s, r) => s + r.cnt, 0);

  let domains: ModuleDomain[];

  if (!isPro()) {
    // OSS: Louvain community detection on the memory_links graph (zero LLM cost)
    const graph = louvainCommunities(db);
    if (graph.communities.length > 1 && graph.edgeCount >= 5) {
      // Map communities to domains by finding the dominant project in each
      // Pre-load all memory→project mappings in one query (avoids N+1)
      const allProjectRows = db
        .prepare("SELECT id, project FROM memories WHERE project IS NOT NULL")
        .all() as Array<{ id: string; project: string }>;
      const memProject = new Map(allProjectRows.map((r) => [r.id, r.project]));

      domains = [];
      for (const comm of graph.communities) {
        const projectCounts = new Map<string, number>();
        for (const memId of comm.members) {
          const proj = memProject.get(memId);
          if (proj) {
            projectCounts.set(proj, (projectCounts.get(proj) ?? 0) + 1);
          }
        }
        const projects = [...projectCounts.keys()];
        if (projects.length === 0) continue;
        // Name domain after the dominant project or combine top 2
        const sorted = [...projectCounts.entries()].sort((a, b) => b[1] - a[1]);
        const name = sorted.length >= 2 && sorted[1][1] > sorted[0][1] * 0.3
          ? `${sorted[0][0]} + ${sorted[1][0]}`
          : sorted[0][0];
        const memoryCount = projects.reduce(
          (s, p) => s + (projectRows.find((r) => r.project === p)?.cnt ?? 0), 0
        );
        const lessonCount = projects.reduce(
          (s, p) => s + (lessonsByProject.get(p) ?? 0), 0
        );
        domains.push({ name, projects, memoryCount, lessonCount, keywords: [] });
      }
      domains.sort((a, b) => b.memoryCount - a.memoryCount);
      console.log(`[hicortex] Louvain clustering: ${graph.communities.length} communities, modularity ${graph.modularity.toFixed(3)}`);
    } else {
      // Not enough edges for meaningful clustering — fall back to project=domain
      domains = projectRows.map((r) => ({
        name: r.project,
        projects: [r.project],
        memoryCount: r.cnt,
        lessonCount: lessonsByProject.get(r.project) ?? 0,
        keywords: [],
      }));
    }
  } else {
    // Pro: LLM-curated domains
    if (!budget.use("domain_curation")) {
      return { curated: false, domains: 0, reason: "budget_exhausted" };
    }

    const projectLines = projectRows
      .map((r) => `${r.project}: ${r.cnt} / ${lessonsByProject.get(r.project) ?? 0}`)
      .join("\n");

    try {
      const r = await llm.completeFast(domainCuration(projectLines), 1024);
      budget.recordUsage("domain_curation", r.usage);
      const parsed = parseJsonLenient<unknown[]>(r.text, []);
      if (!Array.isArray(parsed) || parsed.length === 0) {
        console.warn("[hicortex] Domain curation: LLM returned empty/invalid response, using fallback");
        domains = projectRows.map((r) => ({
          name: r.project,
          projects: [r.project],
          memoryCount: r.cnt,
          lessonCount: lessonsByProject.get(r.project) ?? 0,
          keywords: [],
        }));
      } else {
        domains = [];
        const assigned = new Set<string>();
        const knownProjects = new Set(sortedNames);
        for (const item of parsed) {
          if (typeof item !== "object" || item === null) continue;
          const d = item as Record<string, unknown>;
          const name = String(d.name ?? "");
          const projects = Array.isArray(d.projects)
            ? (d.projects as unknown[]).map(String).filter((p) => !assigned.has(p) && knownProjects.has(p))
            : [];
          const keywords = Array.isArray(d.keywords)
            ? (d.keywords as unknown[]).map(String).slice(0, 5)
            : [];
          if (!name || projects.length === 0) continue;
          for (const p of projects) assigned.add(p);
          const memoryCount = projects.reduce(
            (s, p) => s + (projectRows.find((r) => r.project === p)?.cnt ?? 0), 0
          );
          const lessonCount = projects.reduce(
            (s, p) => s + (lessonsByProject.get(p) ?? 0), 0
          );
          domains.push({ name, projects, memoryCount, lessonCount, keywords });
        }
        // Catch unassigned projects
        const unassigned = sortedNames.filter((p) => !assigned.has(p));
        if (unassigned.length > 0) {
          const memoryCount = unassigned.reduce(
            (s, p) => s + (projectRows.find((r) => r.project === p)?.cnt ?? 0), 0
          );
          const lessonCount = unassigned.reduce(
            (s, p) => s + (lessonsByProject.get(p) ?? 0), 0
          );
          domains.push({ name: "Miscellaneous", projects: unassigned, memoryCount, lessonCount, keywords: [] });
        }
        // Sort by memoryCount desc
        domains.sort((a, b) => b.memoryCount - a.memoryCount);
      }
    } catch (err) {
      console.warn(`[hicortex] Domain curation LLM failed: ${err instanceof Error ? err.message : String(err)}`);
      domains = projectRows.map((r) => ({
        name: r.project,
        projects: [r.project],
        memoryCount: r.cnt,
        lessonCount: lessonsByProject.get(r.project) ?? 0,
        keywords: [],
      }));
    }
  }

  const moduleIndex: ModuleIndex = {
    domains,
    projectSetHash,
    curatedAt: new Date().toISOString(),
    totalMemories,
    totalLessons,
  };

  if (!dryRun) {
    // Persist MODULE_INDEX to state.json
    updateState((s) => { s.moduleIndex = moduleIndex; }, stateDir);

    // Batch-update domain column on memories
    const updateStmt = db.prepare("UPDATE memories SET domain = ? WHERE project = ?");
    const tx = db.transaction(() => {
      for (const domain of domains) {
        for (const project of domain.projects) {
          updateStmt.run(domain.name, project);
        }
      }
    });
    tx();
  }

  console.log(`[hicortex] Domain curation: ${domains.length} domains from ${projectRows.length} projects`);
  return { curated: true, domains: domains.length };
}

// ---------------------------------------------------------------------------
// Stage 3: Link Discovery (vector similarity auto-link + heuristic typing)
// ---------------------------------------------------------------------------
//
// LLM edge classification is RETIRED (2026-07). A 672-link audit (17 LLM
// judges) found only 31% of typed links overall were correct/defensible, and
// the LLM-classified UPPERCASE types were near-useless: CONTRADICTS 4%,
// SUPERSEDES 29%, DEPENDS_ON 26%, CAUSED_BY 24%, VALIDATES 44%. The lowercase
// heuristics `updates`/`derives` were also weak (~31%). Only `extends` (57%)
// and `relates_to` (53%) held up, so the pipeline now emits ONLY those two.
//
// The UPPERCASE types remain in VALID_RELATIONSHIP_TYPES (types.ts) so old data
// still validates — they are RETIRED, not deleted. Classification via an LLM
// may return only once a future classifier passes the audit harness at >= 70%
// acceptable. Do NOT re-enable LLM classification without that evidence.

/** A candidate link discovered by vector similarity, pending classification. */
export interface LinkCandidate {
  source: Memory;
  target: Memory & { distance: number };
  similarity: number;
  heuristicType: string;
}

/**
 * Discovery: find link candidates for one memory given its embedding.
 * Top-10 vector neighbors (excluding self), keep the CONSOLIDATE_LINK_TOP_K
 * highest-cosine neighbors above CONSOLIDATE_LINK_THRESHOLD, pre-compute the
 * heuristic relationship type.
 *
 * Shared between the nightly `stageLinks` (which embeds via embedFn) and
 * `hicortex relink` (which reuses stored embeddings from memory_vectors).
 */
export function discoverLinkCandidates(
  db: Database.Database,
  mem: Memory,
  embedding: Float32Array,
): LinkCandidate[] {
  const neighbors = storage.vectorSearch(db, embedding, 10, [mem.id]);
  const candidates: LinkCandidate[] = [];

  // vectorSearch orders by L2 distance ascending (`ORDER BY distance` in
  // storage.ts), and cosine is monotonically decreasing in L2 distance for
  // normalized vectors — so iterating in order and stopping at TOP_K keeps
  // exactly the highest-cosine neighbors.
  for (const neighbor of neighbors) {
    if (candidates.length >= CONSOLIDATE_LINK_TOP_K) break;
    // sqlite-vec vec0 `distance` is L2, not a similarity. Embeddings are
    // L2-normalized (embedder.ts, normalize: true), so cos = 1 − d²/2.
    // The old `1 − distance` formula silently required cosine > 0.90.
    const similarity = l2ToCosine(neighbor.distance);

    // Cross-project guard (2026-07 audit): cross-project links were 65%
    // wrong-link vs 6% same-project. A candidate whose source/target belong to
    // DIFFERENT projects must clear the higher CROSS_PROJECT_LINK_THRESHOLD;
    // same-project keeps CONSOLIDATE_LINK_THRESHOLD. A memory with no project
    // (null) is treated as same-project — the guard only fires on two distinct
    // non-null project names.
    const crossProject =
      mem.project != null &&
      neighbor.project != null &&
      mem.project !== neighbor.project;
    const threshold = crossProject
      ? CROSS_PROJECT_LINK_THRESHOLD
      : CONSOLIDATE_LINK_THRESHOLD;

    if (similarity > threshold) {
      const heuristicType = classifyRelationship(mem, neighbor, similarity);
      candidates.push({ source: mem, target: neighbor, similarity, heuristicType });
    }
  }

  return candidates;
}

/**
 * Classification: assign a relationship type to each candidate link.
 *
 * HEURISTIC-ONLY (2026-07). LLM edge classification was retired after the
 * 672-link audit (see the Stage 3 header) found the LLM-classified UPPERCASE
 * types near-useless (CONTRADICTS 4% acceptable). Every candidate now takes its
 * pre-computed `heuristicType` (only `extends` or `relates_to` — see
 * classifyRelationship). No LLM call is made.
 *
 * Signature stability: `llm` and `budget` are RETAINED but intentionally
 * ignored so the callers (nightly `stageLinks`, `hicortex relink`) and the
 * tests that import this need no change to their call sites. The return shape
 * is unchanged; `llmClassified` is always 0 now and `heuristicFallback` counts
 * every candidate. Do NOT re-add an LLM path here without a classifier that
 * passes the audit harness at >= 70% acceptable.
 *
 * Shared between the nightly `stageLinks` and `hicortex relink`.
 * Returns one relationship type per candidate (same order as input).
 */
export async function classifyLinkCandidates(
  candidates: LinkCandidate[],
  _llm: LlmClient | null,
  _budget: BudgetTracker,
): Promise<{ types: string[]; llmClassified: number; heuristicFallback: number }> {
  const types = candidates.map((c) => c.heuristicType);
  return { types, llmClassified: 0, heuristicFallback: candidates.length };
}

async function stageLinks(
  db: Database.Database,
  memories: Memory[],
  embedFn: EmbedFn,
  dryRun: boolean,
  llm: LlmClient,
  budget: BudgetTracker,
): Promise<{ auto_linked: number; llm_classified?: number; heuristic_fallback?: number; failed: number }> {
  let autoLinked = 0;
  let failed = 0;

  // Phase A: Discovery — collect candidates via vector similarity
  const candidates: LinkCandidate[] = [];

  for (const mem of memories) {
    try {
      const embedding = await embedFn(mem.content);
      candidates.push(...discoverLinkCandidates(db, mem, embedding));
    } catch {
      failed++;
    }
  }

  if (candidates.length === 0) {
    return { auto_linked: 0, llm_classified: 0, heuristic_fallback: 0, failed };
  }

  // Phase B: LLM batch classification (heuristic fallback inside)
  const { types: classifiedTypes, llmClassified, heuristicFallback } =
    await classifyLinkCandidates(candidates, llm, budget);

  // Phase C: Store all classified links
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const relationship = classifiedTypes[i];
    if (!dryRun) {
      try {
        storage.addLink(db, c.source.id, c.target.id, relationship, c.similarity);
        autoLinked++;
      } catch {
        failed++;
      }
    } else {
      autoLinked++;
    }
  }

  return { auto_linked: autoLinked, llm_classified: llmClassified, heuristic_fallback: heuristicFallback, failed };
}

/**
 * Classify the relationship between two memories.
 *
 * TWO-LABEL heuristic (2026-07). The 672-link audit (see the Stage 3 header)
 * showed only `extends` (57% acceptable) and `relates_to` (53%) held up; the
 * emitted vocabulary is collapsed to exactly those two. The retired labels
 * `updates` and `derives` (~31% acceptable) and all UPPERCASE LLM types are no
 * longer produced. They remain in VALID_RELATIONSHIP_TYPES so pre-existing rows
 * still validate.
 *
 * Rule: same-project (both projects non-null and equal) AND higher cosine
 * (> CONSOLIDATE_LINK_THRESHOLD) → `extends`; everything else → `relates_to`.
 *
 * `similarity` is COSINE similarity (see l2ToCosine); the CONSOLIDATE_LINK_THRESHOLD
 * boundary from the l2ToCosine calibration is preserved.
 */
export function classifyRelationship(
  source: Memory,
  target: Memory,
  similarity: number
): string {
  // Same project + above the link threshold → extends
  if (
    source.project && target.project &&
    source.project === target.project &&
    similarity > CONSOLIDATE_LINK_THRESHOLD
  ) {
    return "extends";
  }

  return "relates_to";
}

// ---------------------------------------------------------------------------
// Stage 3.5: Hub Detection & Strength Boost
// ---------------------------------------------------------------------------

const HUB_BOOST = 0.1;
const HUB_STRENGTH_CAP = 1.0;

function stageHubBoost(
  db: Database.Database,
  dryRun: boolean,
): { hubs_found: number; boosted: number } {
  const hubs = detectHubs(db);
  if (hubs.length === 0) return { hubs_found: 0, boosted: 0 };

  let boosted = 0;
  if (!dryRun) {
    const stmt = db.prepare(
      "UPDATE memories SET base_strength = MIN(?, base_strength + ?) WHERE id = ? AND base_strength < ?"
    );
    const tx = db.transaction(() => {
      for (const hub of hubs) {
        const result = stmt.run(HUB_STRENGTH_CAP, HUB_BOOST, hub.id, HUB_STRENGTH_CAP);
        if (result.changes > 0) boosted++;
      }
    });
    tx();
  } else {
    boosted = hubs.length;
  }

  if (hubs.length > 0) {
    console.log(`[hicortex] Hub detection: ${hubs.length} hubs found, ${boosted} boosted (+${HUB_BOOST})`);
  }
  return { hubs_found: hubs.length, boosted };
}

// ---------------------------------------------------------------------------
// Stage 3.7: Supersession Detection (#191 Phase B)
// ---------------------------------------------------------------------------
//
// A later decision/correction can reverse, replace, or invalidate an earlier
// one — e.g. "chose Ollama for distillation" superseded a month later by
// "switched distillation to a local 35B model over a mesh VPN". Left
// unlinked, retrieval and lesson selection can surface the stale one. This
// stage links OLD → NEW with relationship `superseded_by` and accelerates the
// old memory's decay, WITHOUT deleting it (unlike `hicortex dedup`'s merge —
// this is a judgment call about content, not a duplicate).
//
// Scope: memories with `rowid > supersessionCursor` (state.json; starts 0 —
// the corpus is back-processed gradually, config `supersessionMaxCalls` LLM
// calls per night) whose shape suggests a decision/correction. For each,
// KNN top-5 OLDER same-shape neighbors at/above `supersessionMinSimilarity`;
// one constrained classify-tier LLM call per pair decides `superseded: true|
// false`. A parse/infra error skips just that PAIR (retried naturally next
// night since the cursor still advances past the memory — see the cursor
// note below); it never mis-links.

/** Default minimum COSINE similarity for a supersession candidate pair. */
export const DEFAULT_SUPERSESSION_MIN_SIMILARITY = 0.8;
/**
 * Default max classify-tier LLM calls (pairs evaluated) spent per nightly run.
 * 0 = no separate cap — supersession shares the consolidation budget
 * (CONSOLIDATE_MAX_LLM_CALLS, default 5000) like every other stage. The old
 * default of 30 was set when the corpus had 14 decisions; with the distiller
 * now classifying types correctly (#216), decisions are common and the cap
 * was throttling supersession to a crawl. On a local free model there is no
 * per-call cost to defend against — the binding constraint is the wall-clock
 * timeout (TimeoutStartSec), not call count.
 */
export const DEFAULT_SUPERSESSION_MAX_CALLS = 0;
/** Default multiplier applied to a superseded memory's base_strength. */
/** Floor under which a superseded memory's base_strength never drops. */
/** Neighbor pool size before shape/older/similarity filtering narrows to top 5. */
const SUPERSESSION_NEIGHBOR_POOL = 15;
/** Older-neighbor pairs kept per candidate after filtering. */
const SUPERSESSION_NEIGHBOR_TOP_K = 5;
/** Candidate rows read per SQL page (call budget stops the loop well before this in practice). */
const SUPERSESSION_BATCH_SIZE = 500;

export interface SupersessionOptions {
  minSimilarity?: number;
  maxCalls?: number;
}

export interface SupersessionStageResult {
  scanned: number;
  evaluated: number;
  superseded: number;
  skipped_infra: number;
  skipped_idempotent: number;
  cursor: number;
}

/**
 * A memory whose content/type marks it as a SUPERSEDABLE claim — one a newer
 * memory about the same subject can replace. Decisions and corrections were the
 * original scope; plain facts and project-state updates were added because an
 * updated fact ("scoring model is X" → later "is Y") otherwise never gets a
 * superseded_by link and both versions compete in recall forever. Ordinary
 * episodic chatter and problem/solution history stay excluded: they record
 * events, not mutable state, so there is nothing to supersede.
 */
function isSupersedableShape(mem: { memory_type: string; content: string }): boolean {
  return (
    mem.memory_type === "decision" ||
    mem.content.includes("[Decisions Made]") ||
    mem.content.includes("[Corrections & Rejections]") ||
    mem.content.includes("[Facts Learned]") ||
    mem.content.includes("[Project State Changes]")
  );
}

/** True when a `superseded_by` link already exists between the pair, either direction. */
function alreadySupersedeLinked(db: Database.Database, oldId: string, newId: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM memory_links WHERE relationship = 'superseded_by'
       AND ((source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?))`,
    )
    .get(oldId, newId, newId, oldId);
  return !!row;
}

/**
 * Build the constrained supersession-check prompt. Content is truncated the
 * same width as domain-classify.ts's classifier (1500 chars) — this is a
 * classify-tier call with the same cost profile.
 */
export function buildSupersessionPrompt(oldContent: string, newContent: string): string {
  const trunc = (s: string) => (s.length > 1500 ? `${s.slice(0, 1500)}…` : s);
  return (
    `You are checking whether a NEWER memory supersedes an OLDER one in an AI agent's long-term memory.\n\n` +
    `OLDER MEMORY:\n${trunc(oldContent)}\n\n` +
    `NEWER MEMORY:\n${trunc(newContent)}\n\n` +
    `Does the NEWER memory reverse, replace, update, or invalidate the OLDER one — e.g. a later decision ` +
    `overturns an earlier one, a correction retracts a prior claim, or a later fact updates the SAME subject's ` +
    `value/status that has since changed (e.g. "model is X" → "model is Y")? Reply true ONLY for a genuine ` +
    `replacement of the same fact/decision. Two memories that are merely related, or that can both still be ` +
    `true — even about the same project or entity (different facts, an addition, an elaboration) — are NOT a ` +
    `supersession.\n` +
    `Reply with ONLY a JSON object, no prose: {"superseded": true} or {"superseded": false}.`
  );
}

/**
 * Parse the model's supersession verdict. Returns the boolean on a valid
 * reply, or null on anything unparseable (caller skips the pair — no retry,
 * unlike domain-classify's tag classifier; a missed pair is retried naturally
 * when this stage revisits the corpus).
 */
export function parseSupersessionReply(reply: string): boolean | null {
  if (!reply) return null;
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(reply.slice(start, end + 1)) as Record<string, unknown>;
    return typeof obj.superseded === "boolean" ? obj.superseded : null;
  } catch {
    return null;
  }
}

/**
 * ONE classify-tier LLM call judging whether `newContent` supersedes
 * `oldContent`. Returns `{verdict, usage}` — verdict is null on any infra error
 * or unparseable reply (the caller treats null as "skip this pair", never
 * mis-links on ambiguity). `usage` is the call's token accounting (#246),
 * surfaced even on a null verdict so the BudgetTracker still meters a
 * network-round-tripped attempt (the cost is real even if the parse failed).
 */
async function classifySupersession(
  llm: LlmClient,
  oldContent: string,
  newContent: string,
): Promise<{ verdict: boolean | null; usage: import("./llm.js").LlmUsage | undefined }> {
  try {
    const r = await llm.completeClassify(buildSupersessionPrompt(oldContent, newContent), 32);
    return { verdict: parseSupersessionReply(r.text), usage: r.usage };
  } catch {
    return { verdict: null, usage: undefined };
  }
}

/**
 * Find up to SUPERSESSION_NEIGHBOR_TOP_K OLDER, same-shape neighbors for a
 * candidate, at/above minSimilarity, highest cosine first. Reuses the
 * candidate's stored embedding when available (relink-style fallback to
 * embedFn otherwise).
 */
async function findOlderNeighbors(
  db: Database.Database,
  candidate: Memory,
  embedFn: EmbedFn,
  minSimilarity: number,
): Promise<Array<Memory & { distance: number }>> {
  const embedding = storage.getStoredEmbedding(db, candidate.id) ?? (await embedFn(candidate.content));
  return storage
    .vectorSearch(db, embedding, SUPERSESSION_NEIGHBOR_POOL, [candidate.id])
    .filter(
      (n) =>
        n.created_at < candidate.created_at &&
        isSupersedableShape(n) &&
        l2ToCosine(n.distance) >= minSimilarity,
    )
    .sort((a, b) => l2ToCosine(b.distance) - l2ToCosine(a.distance))
    .slice(0, SUPERSESSION_NEIGHBOR_TOP_K);
}

/**
 * Nightly supersession-detection stage. Scans memories/rowid > cursor whose
 * shape is supersedable (decision/correction/fact/state — isSupersedableShape),
 * checks each against its older same-shape neighbors, and links confirmed
 * supersessions. Dry-run performs discovery + the free idempotency check only —
 * no LLM calls, no writes, no
 * cursor persistence (mirrors stageImportance/stageContentDomains's dry-run
 * convention of never spending budget on a preview).
 *
 * Cursor discipline is DELIBERATELY simple (owner amendment): the cursor
 * advances past a candidate once its neighbor set has been considered,
 * REGARDLESS of whether every pair got an LLM call (call budget) or a clean
 * verdict (infra skip) — missing one pair is acceptable and self-heals next
 * time this memory's neighborhood is re-examined via a NEWER memory's own
 * candidacy. It only stops SHORT of a candidate when the budget is already
 * exhausted before that candidate starts, so the cursor never skips a
 * candidate that was never looked at.
 */
export async function stageSupersession(
  db: Database.Database,
  llm: LlmClient,
  budget: BudgetTracker,
  embedFn: EmbedFn,
  dryRun: boolean,
  stateDir: string | undefined,
  options: SupersessionOptions = {},
): Promise<SupersessionStageResult> {
  // Config values pass through `unknown`-typed JSON — validate rather than
  // trust (same discipline as retrieval.ts's configureRecall).
  const validNumber = (v: unknown, fallback: number, ok: (n: number) => boolean): number => {
    const n = Number(v);
    return Number.isFinite(n) && ok(n) ? n : fallback;
  };
  const minSimilarity = validNumber(options.minSimilarity, DEFAULT_SUPERSESSION_MIN_SIMILARITY, (n) => n > 0 && n <= 1);
  const maxCalls = validNumber(options.maxCalls, DEFAULT_SUPERSESSION_MAX_CALLS, (n) => n >= 0);

  const startCursor = loadState(stateDir).supersessionCursor ?? 0;
  const rows = db
    .prepare(
      // Candidate shape must mirror isSupersedableShape() exactly — keep the two
      // in lockstep (an inline SQL copy, so drift here silently narrows scope).
      `SELECT rowid AS __rowid, * FROM memories
       WHERE rowid > ?
         AND (memory_type = 'decision'
              OR content LIKE '%[Decisions Made]%'
              OR content LIKE '%[Corrections & Rejections]%'
              OR content LIKE '%[Facts Learned]%'
              OR content LIKE '%[Project State Changes]%')
       ORDER BY rowid ASC LIMIT ?`,
    )
    .all(startCursor, SUPERSESSION_BATCH_SIZE) as Array<Memory & { __rowid: number }>;

  let scanned = 0;
  let evaluated = 0;
  let superseded = 0;
  let skippedInfra = 0;
  let skippedIdempotent = 0;
  let callsUsed = 0;
  let cursor = startCursor;

  for (const candidate of rows) {
    if (!dryRun && ((maxCalls > 0 && callsUsed >= maxCalls) || budget.exhausted)) break;
    scanned++;

    let neighbors: Array<Memory & { distance: number }>;
    try {
      neighbors = await findOlderNeighbors(db, candidate, embedFn, minSimilarity);
    } catch (err) {
      console.warn(
        `[hicortex] supersession: discovery failed for ${candidate.id.slice(0, 8)} — ${err instanceof Error ? err.message : String(err)}`,
      );
      cursor = candidate.__rowid;
      continue;
    }

    for (const neighbor of neighbors) {
      if (alreadySupersedeLinked(db, neighbor.id, candidate.id)) {
        skippedIdempotent++;
        continue;
      }
      if (dryRun) continue; // preview only — no LLM call, no write

      if ((maxCalls > 0 && callsUsed >= maxCalls) || !budget.use("supersession")) break;
      callsUsed++;

      const { verdict, usage } = await classifySupersession(llm, neighbor.content, candidate.content);
      // Meter every round-tripped attempt (#246) — even a null verdict spent
      // real tokens. The stage label matches the budget.use() above.
      budget.recordUsage("supersession", usage);
      evaluated++;
      if (verdict === null) {
        skippedInfra++;
        continue;
      }
      if (verdict) {
        const cosine = l2ToCosine(neighbor.distance);
        // The link IS the signal (0.15.2): retrieval demotes superseded
        // memories via an explicit scoring multiplier (supersededDemotion,
        // retrieval.ts). The old base_strength penalty was retired because it
        // (a) fought the config-tunable strength weight and (b) leaked into
        // prune eligibility — a reversed decision must rank lower, not edge
        // toward deletion.
        storage.addLink(db, neighbor.id, candidate.id, "superseded_by", cosine);
        superseded++;
        console.log(
          `[hicortex] Supersession: ${neighbor.id.slice(0, 8)} superseded_by ${candidate.id.slice(0, 8)} (cosine ${cosine.toFixed(3)})`,
        );
      }
    }

    cursor = candidate.__rowid;
  }

  if (!dryRun) {
    updateState((s) => {
      s.supersessionCursor = cursor;
    }, stateDir);
  }

  if (rows.length > 0) {
    console.log(
      `[hicortex] Supersession detection: ${scanned} scanned, ${evaluated} evaluated, ${superseded} superseded, ` +
        `${skippedIdempotent} already-linked, ${skippedInfra} infra-skipped (cursor ${cursor})`,
    );
  }

  return {
    scanned,
    evaluated,
    superseded,
    skipped_infra: skippedInfra,
    skipped_idempotent: skippedIdempotent,
    cursor,
  };
}

// ---------------------------------------------------------------------------
// Stage 4: Decay & Prune
// ---------------------------------------------------------------------------

/**
 * Exported for the #191 eval baseline (src/eval/decay-eval.ts) so the audit
 * runs the REAL production prune predicate against a DB snapshot instead of
 * reimplementing it. `dryRun=true` performs reads only (candidates are
 * counted, nothing is deleted) — safe against a readonly snapshot connection.
 * Not otherwise part of the public API surface.
 */
export function stageDecayPrune(
  db: Database.Database,
  dryRun: boolean
): { candidates: number; pruned: number; failed: number } {
  const now = new Date();
  const cutoff = new Date(
    now.getTime() - CONSOLIDATE_PRUNE_MIN_AGE_DAYS * 24 * 60 * 60 * 1000
  );

  const oldUnaccessed = storage.getPruneCandidates(db, cutoff.toISOString());
  const linkCounts = storage.getAllLinkCounts(db);

  let candidates = 0;
  let pruned = 0;
  let failed = 0;

  for (const mem of oldUnaccessed) {
    const memLinkCount = linkCounts.get(mem.id) ?? 0;

    const eff = effectiveStrength(
      mem.base_strength ?? 0.5,
      mem.last_accessed,
      now,
      {
        accessCount: 0,
        linkCount: memLinkCount,
      }
    );

    if (eff >= 0.01) continue;

    candidates++;

    if (dryRun) continue;

    try {
      storage.deleteMemory(db, mem.id);
      pruned++;
    } catch {
      failed++;
    }
  }

  return { candidates, pruned, failed };
}

// ---------------------------------------------------------------------------
// Stage 4.5: Memory cap eviction (#245)
// ---------------------------------------------------------------------------
//
// The active forgetting mechanism. The pre-#245 prune (stageDecayPrune above)
// is inert by design — the strength floor (~0.3162) + the `< 0.01` threshold +
// the 365-day decay half-life means a never-accessed memory takes ~3 years to
// become eligible, so the corpus grew without bound. This stage bounds it:
// when the count exceeds `memorySoftCap`, the lowest-effectiveStrength
// memories are evicted until under the cap.
//
// Eviction reuses the SAME effectiveStrength() the recall ranker uses — no
// formula duplication, so the eviction criterion cannot drift from what
// surfaces in the top-k. The evicted tail is, by construction, the tail that
// was not surfacing anyway (cold, decayed). Ties are broken by oldest
// COALESCE(last_accessed, created_at) — i.e. the memories that have gone
// longest without anyone looking at them.
//
// `cap = 0` disables the stage (indefinite growth — the pre-#245 default is
// preserved opt-out). The JS-side sort is O(n log n); at 10K memories the
// load + compute is <100 ms, a rounding error against the LLM-bound phases.

/**
 * Default soft cap on the memory corpus (#245). Above this the lowest-value
 * memories are evicted each nightly. 10000 balances headroom for a busy
 * self-hosted install against the noise cost of a bloated vector index
 * (recall top-k competes against the long tail). Override via `memorySoftCap`.
 */
export const DEFAULT_MEMORY_SOFT_CAP = 10000;

export function stageMemoryCapEviction(
  db: Database.Database,
  dryRun: boolean,
  cap: number,
): { cap: number; evicted: number } {
  // `0` = explicitly disabled (current/legacy behaviour). The guard is on `<=`
  // not `===` to also absorb a stray negative (readNonNegativeConfig already
  // rejects negatives at the boundary, but this stage is callable directly).
  if (cap <= 0) return { cap, evicted: 0 };

  const count = storage.countMemories(db);
  if (count <= cap) return { cap, evicted: 0 };

  const surplus = count - cap;

  // Load the fields effectiveStrength needs + the tiebreak. base_strength is
  // NOT NULL after scoring; the `?? 0.5` mirrors stageDecayPrune's defensive
  // default for unscored rows (inserts at 0.5). last_accessed is NULL until
  // first /recall-index exposure — COALESCE to created_at for the tiebreak so
  // never-shown memories sort by when they entered the corpus.
  const rows = db
    .prepare(
      `SELECT id, base_strength, last_accessed, access_count, created_at
         FROM memories`,
    )
    .all() as Array<{
    id: string;
    base_strength: number | null;
    last_accessed: string | null;
    access_count: number | null;
    created_at: string;
  }>;

  const linkCounts = storage.getAllLinkCounts(db);
  const now = new Date();

  // Decorate + sort: lowest effectiveStrength first; ties broken by oldest
  // COALESCE(last_accessed, created_at). The victims are the first `surplus`.
  const decorated = rows.map((r) => {
    const eff = effectiveStrength(
      r.base_strength ?? 0.5,
      r.last_accessed,
      now,
      {
        accessCount: r.access_count ?? 0,
        linkCount: linkCounts.get(r.id) ?? 0,
      },
    );
    return {
      id: r.id,
      eff,
      lastTouch: r.last_accessed ?? r.created_at,
    };
  });
  decorated.sort((a, b) =>
    // ASC by effectiveStrength, then ASC by lastTouch (oldest first = evict).
    a.eff !== b.eff ? a.eff - b.eff
      : a.lastTouch < b.lastTouch ? -1 : a.lastTouch > b.lastTouch ? 1 : 0,
  );

  const victims = decorated.slice(0, surplus);

  if (dryRun) {
    console.log(
      `[hicortex] Memory cap eviction (dry-run): would remove ${victims.length} ` +
      `lowest-value memories (corpus ${count}, cap ${cap}).`,
    );
    return { cap, evicted: victims.length };
  }

  // deleteMemory cascades: memory_links (both directions), memory_tags,
  // memory_vectors, and the FTS index (via the AFTER DELETE trigger on
  // memories, db.ts — no manual FTS cleanup needed). Wrap the batch in a
  // transaction so a failure leaves the corpus consistent (all-or-nothing).
  const tx = db.transaction(() => {
    for (const v of victims) storage.deleteMemory(db, v.id);
  });
  tx();

  console.log(
    `[hicortex] Memory cap eviction: removed ${victims.length} lowest-value ` +
    `memories (corpus was ${count}, cap ${cap}).`,
  );

  return { cap, evicted: victims.length };
}

/**
 * Run the full consolidation pipeline. Returns a structured report.
 */
/**
 * Options controlling how the domain-assignment stage runs.
 *
 * When `domains` is a non-empty list, the pipeline uses content-based
 * classification (config-owned) INSTEAD of project grouping. The single
 * model serves all phases; if it's unavailable, `complete()` retries
 * internally (30s/60s/120s) and the phase fails soft on persistence —
 * the nightly retries on the next run. No pre-flight health checks; the
 * phase either answers or is skipped until the next scheduled run. When
 * `domains` is absent/empty, the legacy project-grouping curation runs
 * unchanged.
 */
export interface DomainStageOptions {
  domains?: DomainDef[] | null;
  contentDomainsReady?: boolean;
  /**
   * Weak-primary floor for the no-fit path (see nofit.ts). Resolved by the
   * caller from config (`weakPrimaryFloor`); defaults to
   * DEFAULT_WEAK_PRIMARY_FLOOR when absent.
   */
  weakPrimaryFloor?: number;
}

export async function runConsolidation(
  db: Database.Database,
  llm: LlmClient,
  embedFn: EmbedFn,
  dryRun = false,
  skipReflection = false,
  stateDir?: string,
  domainOptions?: DomainStageOptions,
  supersessionOptions?: SupersessionOptions,
  /** Total LLM-call ceiling across classify-tier stages (#241). The caller
   *  reads `consolidateMaxLlmCalls` from config and passes it; unset → the
   *  exported `CONSOLIDATE_MAX_LLM_CALLS` default (5000). */
  budgetMaxCalls?: number,
  /** Soft cap on the corpus (#245). Nightly.ts reads `memorySoftCap` from
   *  config and passes it; unset → `DEFAULT_MEMORY_SOFT_CAP` (10000). `0`
   *  disables eviction (indefinite growth). */
  memorySoftCap?: number,
): Promise<ConsolidationReport> {
  const start = new Date();
  const report: ConsolidationReport = {
    started_at: start.toISOString(),
    dry_run: dryRun,
    status: "completed",
    stages: {},
  };

  // Stage 1: Pre-check
  const precheck = stagePrecheck(db);

  // Also check for unscored memories
  const unscored = storage.getUnscoredMemories(db);
  const newIds = new Set(precheck.newMemories.map((m) => m.id));
  const scoreMemories = [
    ...precheck.newMemories,
    ...unscored.filter((m) => !newIds.has(m.id)),
  ];

  const skip = scoreMemories.length === 0;

  report.stages.precheck = {
    skip,
    reason: skip
      ? precheck.reason
      : `${precheck.newMemories.length} new + ${scoreMemories.length - precheck.newMemories.length} unscored memories`,
    new_memory_count: precheck.newMemories.length,
    unscored_count: scoreMemories.length - precheck.newMemories.length,
  };

  // Memory cap eviction (#245) — runs BEFORE the precheck skip so the corpus
  // is bounded even on quiet nights (no new memories → precheck would skip,
  // but the cap stage is pure DB: cheap, idempotent when under cap).
  report.stages.memory_cap = stageMemoryCapEviction(
    db,
    dryRun,
    memorySoftCap ?? DEFAULT_MEMORY_SOFT_CAP,
  );

  if (skip) {
    report.status = "skipped";
    report.completed_at = new Date().toISOString();
    return report;
  }

  // Config-overridable total LLM-call ceiling (#241). Default 5000 (was 200) —
  // see CONSOLIDATE_MAX_LLM_CALLS. The caller reads `consolidateMaxLlmCalls`
  // from config and passes it here.
  const budget = new BudgetTracker(budgetMaxCalls ?? CONSOLIDATE_MAX_LLM_CALLS);

  try {
    // Stage 2: Importance Scoring
    report.stages.importance = await stageImportance(
      db,
      scoreMemories,
      llm,
      budget,
      dryRun
    );

    // Stage 2.5: Reflection
    if (skipReflection) {
      report.stages.reflection = {
        lessons_generated: 0,
        skipped: true,
        reason: "reflect_endpoint_offline",
      };
    } else {
      report.stages.reflection = await stageReflection(
        db,
        precheck.newMemories,
        llm,
        budget,
        embedFn,
        dryRun
      );
    }

    // Stage 2.7: Domain assignment.
    // Content-based (config-owned domains) REPLACES project grouping when a
    // domain list is configured. The single model serves all phases; if it's
    // down, the phase skips and retries on the next nightly run (no fallback).
    const cfgDomains = domainOptions?.domains;
    if (cfgDomains && cfgDomains.length > 0) {
      if (domainOptions?.contentDomainsReady === false) {
        report.stages.domain_curation = {
          curated: false,
          domains: cfgDomains.length,
          reason: "reflect_endpoint_offline",
        };
      } else {
        report.stages.domain_curation = await stageContentDomains(
          db, cfgDomains, llm, budget, embedFn, dryRun, stateDir,
          domainOptions?.weakPrimaryFloor ?? DEFAULT_WEAK_PRIMARY_FLOOR,
        );
      }
    } else {
      report.stages.domain_curation = await stageDomainCuration(db, llm, budget, dryRun, stateDir);
    }

    // Stage 3: Link Discovery (with LLM-assisted edge classification)
    report.stages.links = await stageLinks(
      db,
      precheck.newMemories,
      embedFn,
      dryRun,
      llm,
      budget,
    );

    // Stage 3.5: Hub Detection — boost highly-connected memories
    report.stages.hub_boost = stageHubBoost(db, dryRun);

    // Stage 3.7: Supersession Detection (#191 Phase B)
    report.stages.supersession = await stageSupersession(
      db, llm, budget, embedFn, dryRun, stateDir, supersessionOptions,
    );

    // Stage 4: Decay & Prune
    report.stages.decay_prune = stageDecayPrune(db, dryRun);

    // (Memory cap eviction moved before the precheck skip — see above.)
  } catch (err) {
    report.status = "failed";
    console.error("[hicortex] Consolidation pipeline error:", err);
  }

  // Update last-consolidated timestamp
  if (!dryRun && report.status === "completed") {
    updateState((s) => {
      s.lastConsolidated = new Date().toISOString();
      return s;
    }, stateDir);
  }

  report.budget = budget.summary();
  report.completed_at = new Date().toISOString();
  report.elapsed_seconds =
    Math.round((Date.now() - start.getTime()) / 100) / 10;

  return report;
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

/**
 * Calculate milliseconds until the next occurrence of a given hour (local time).
 */
export function msUntilHour(hour: number): number {
  const now = new Date();
  const target = new Date(now);
  target.setHours(hour, 30, 0, 0); // :30 past the hour

  if (target.getTime() <= now.getTime()) {
    // Already passed today, schedule for tomorrow
    target.setDate(target.getDate() + 1);
  }

  return target.getTime() - now.getTime();
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Schedule the consolidation pipeline to run nightly.
 * Returns a cleanup function to cancel the timer.
 *
 * NOTE: currently unused (nightly.ts drives consolidation directly). Any future
 * caller MUST read config.domains and thread `domainOptions` into runConsolidation
 * when content domains are configured — otherwise it silently falls back to the
 * legacy project-grouping path even when a domain list is set.
 */
export function scheduleConsolidation(
  db: Database.Database,
  llm: LlmClient,
  embedFn: EmbedFn,
  hour = 2
): () => void {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let interval: ReturnType<typeof setInterval> | null = null;

  const runAndScheduleInterval = () => {
    runConsolidation(db, llm, embedFn)
      .then((report) => {
        console.log(
          `[hicortex] Consolidation ${report.status} in ${report.elapsed_seconds}s`
        );
      })
      .catch((err) => {
        console.error("[hicortex] Consolidation failed:", err);
      });

    // Schedule recurring daily runs
    if (!interval) {
      interval = setInterval(() => {
        runConsolidation(db, llm, embedFn).catch((err) => {
          console.error("[hicortex] Consolidation failed:", err);
        });
      }, ONE_DAY_MS);
    }
  };

  const delay = msUntilHour(hour);
  console.log(
    `[hicortex] Consolidation scheduled in ${Math.round(delay / 60_000)} minutes`
  );
  timeout = setTimeout(runAndScheduleInterval, delay);

  return () => {
    if (timeout) clearTimeout(timeout);
    if (interval) clearInterval(interval);
  };
}
