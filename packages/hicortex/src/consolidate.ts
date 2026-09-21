/**
 * Nightly consolidation pipeline — importance scoring, reflection,
 * link discovery, decay/prune.
 * Ported from hicortex/consolidate/ (stages.py, __init__.py, budget.py).
 */

import type Database from "better-sqlite3";
import type { Memory, ConsolidationReport, ModuleIndex, ModuleDomain, ResolutionBandStat } from "./types.js";
import type { LlmClient } from "./llm.js";
import type { EmbedFn } from "./retrieval.js";
import { effectiveStrength, l2ToCosine, findDemotedIds } from "./retrieval.js";
import * as storage from "./storage.js";
import { readNonNegativeConfig, readPositiveConfig } from "./config-read.js";
import { importanceScoring, reflection, domainCuration } from "./prompts.js";
import { createHash } from "node:crypto";
import { isPro } from "./features.js";
import { louvainCommunities } from "./graph.js";
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
import { stageReconsolidation, type ReconsolidationOptions } from "./reconsolidation.js";
import {
  runDeterministicMergeZone,
  DEFAULT_DEDUP_MERGE_THRESHOLD,
} from "./dedup.js";
import type { RunDeadline } from "./run-deadline.js";
import * as CALIBRATION from "./calibration.js";

// Default config constants (matching Python config.py)
/**
 * Default ceiling on LLM calls across the WHOLE nightly pipeline (#405; the
 * #241 consolidateMaxLlmCalls mechanism, renamed and widened). A runaway
 * BACKSTOP that bounds money/load INDEPENDENT OF LATENCY — a fast metered or
 * capacity-limited endpoint permits thousands of calls inside the wall-clock
 * budget, so time alone cannot protect it (owner ruling 2026-09-12). Consumed
 * in run order: a stage that exhausts it defers its remainder via its cursor.
 * 5000 clears a one-time classification backlog (a ~2000-memory batch drains
 * in ~1-2 runs) with margin. Config: `nightlyLlmCallBudget` (#405); the old
 * `consolidateMaxLlmCalls` key is a deprecated alias honored one release.
 */
export const DEFAULT_NIGHTLY_LLM_CALL_BUDGET = 5000;

/**
 * Resolve the per-run LLM call budget from config (#405):
 *  - `nightlyLlmCallBudget` present (positive finite) → it wins;
 *  - else `consolidateMaxLlmCalls` present → used as a DEPRECATED ALIAS with
 *    a warn naming the replacement (honored one release);
 *  - absent/invalid → the 5000 default.
 */
export function resolveNightlyLlmCallBudget(
  config: Record<string, unknown> | null | undefined,
): number {
  const c = config ?? {};
  if (c.nightlyLlmCallBudget !== undefined) {
    return readPositiveConfig(c, "nightlyLlmCallBudget", DEFAULT_NIGHTLY_LLM_CALL_BUDGET);
  }
  if (c.consolidateMaxLlmCalls !== undefined) {
    const legacy = readPositiveConfig(c, "consolidateMaxLlmCalls", DEFAULT_NIGHTLY_LLM_CALL_BUDGET);
    console.warn(
      `[hicortex] config key "consolidateMaxLlmCalls" is deprecated — renamed ` +
        `"nightlyLlmCallBudget" (same meaning, now the ONE per-run LLM call ceiling). ` +
        `The old key is honored for one release; rename it to clear this warning.`,
    );
    return legacy;
  }
  return DEFAULT_NIGHTLY_LLM_CALL_BUDGET;
}
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
   * Per-stage count of LLM-call REQUESTS refused because the budget was
   * exhausted (#255). Keys are the same stage labels passed to `use()`; each
   * refused call adds 1 (the dead batch `count` param is gone — #405 —
   * production always passed 1 anyway). Stages break on the first refusal,
   * so a stage's value is the count of requests that crossed the boundary.
   * For item-level skip counts (how many memories or pairs were left
   * unprocessed), see the per-stage reports — e.g.
   * `stages.importance.skipped_budget` — which count MEMORIES, not call
   * requests. Surfaced in summary() and ConsolidationReport as
   * `deferred_by_stage`.
   */
  deferredByStage: Record<string, number> = {};
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

  use(stage: string): boolean {
    if (this.callsUsed >= this.maxCalls) {
      // #255: emit as a STRUCTURED event (not a bare prose warn) so a monitor
      // can grep/parse `event=budget_exhausted` from journald. The line stays
      // human-readable (key=value tokens after the [hicortex] prefix). Deferred
      // counts are accrued BEFORE the log so the line reflects the up-to-date
      // per-stage toll — the refused count is added to this stage's slot.
      this.deferredByStage[stage] = (this.deferredByStage[stage] ?? 0) + 1;
      console.warn(
        `[hicortex] event=budget_exhausted stage=${stage} ` +
          `calls_used=${this.callsUsed} max_calls=${this.maxCalls} ` +
          `deferred_by_stage=${JSON.stringify(this.deferredByStage)}`
      );
      return false;
    }
    this.callsUsed += 1;
    this.callsByStage[stage] = (this.callsByStage[stage] ?? 0) + 1;
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
      // #255: exhaustion + per-stage deferred counts flow into the report →
      // telemetry + dashboard. Always present (post-#255); absent implies a
      // pre-#255 report (treat as false / no deferrals).
      exhausted: this.exhausted,
      deferred_by_stage: { ...this.deferredByStage },
      tokens_by_stage: Object.fromEntries(
        Object.entries(this.tokensByStage).map(([k, v]) => [k, { ...v }]),
      ),
      tokens_total: { ...this.totalTokens },
    };
  }
}

/**
 * #427 observability: warn when a consolidation run made LLM CALLS but
 * metered ZERO tokens — the endpoint returned no usage objects on its
 * completions (recordUsage skips undefined by design, never fabricates a
 * zero). Such a run still spends budget calls but its snapshot carries token
 * nulls, which read as a mystery on the dashboard. The warn is a structured
 * event in the same journald-greppable style as `event=budget_exhausted`
 * (grep `event=tokens_unmetered`), so the blind spot is visible instead of
 * silent. Returns true when it warned (for tests); no fabrication either
 * way — the numbers stay exactly what the endpoint reported.
 */
export function warnUnmeteredTokensRun(
  budget: NonNullable<ConsolidationReport["budget"]>,
): boolean {
  const calls = budget.calls_used ?? 0;
  const tokens = budget.tokens_total?.total ?? 0;
  if (calls <= 0 || tokens > 0) return false;
  console.warn(
    `[hicortex] event=tokens_unmetered calls_used=${calls} — the LLM endpoint ` +
      `returned no usage objects on its completions; this run's snapshot carries ` +
      `no token metering (budget calls were still counted).`,
  );
  return true;
}

// ---------------------------------------------------------------------------
// Token fair-use throttle decision (#246)
// ---------------------------------------------------------------------------

/**
 * True when a token-period start stamp is ABSENT or sits in a previous UTC
 * calendar month than `now` — the monthly-reset staleness check. #405: ONE
 * shared helper — the check was triplicated (the nightly's throttle branch,
 * the nightly's accrual write, token-budget.ts recordDistillUsage) and each
 * copy re-derived the year+month comparison by hand.
 */
export function isStaleTokenPeriod(
  periodStart: string | undefined,
  now: Date = new Date(),
): boolean {
  if (!periodStart) return true;
  const start = new Date(periodStart);
  return start.getUTCFullYear() !== now.getUTCFullYear() ||
    start.getUTCMonth() !== now.getUTCMonth();
}

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
 * (isStaleTokenPeriod — the same helper every monthly-reset site uses, so
 * the sides agree because they read the same state + clock).
 */
export function shouldThrottleTokens(
  cap: number,
  period: { total: number; periodStart: string } | undefined,
  lastRunTokens: number,
  now: Date = new Date(),
): { throttle: boolean; used?: number; cap?: number } {
  if (cap <= 0) return { throttle: false };
  // Stale period → reset accrual to 0 before the check.
  const periodTotal = isStaleTokenPeriod(period?.periodStart, now) ? 0 : (period?.total ?? 0);
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

function readLastConsolidated(stateDir?: string): string {
  // stateDir-optional for backcompat; runConsolidation threads its own
  // stateDir so the skip decision reads the SAME state the run writes
  // (previously this read the ambient home — a split-brain where a test or
  // CLI caller with an isolated stateDir decided "skip" from the operator's
  // real ~/.hicortex watermark).
  return loadState(stateDir).lastConsolidated ?? "";
}

function stagePrecheck(
  db: Database.Database,
  stateDir?: string
): {
  skip: boolean;
  reason: string;
  newMemories: Memory[];
  lastDt: string;
} {
  const lastTs = readLastConsolidated(stateDir);
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

/**
 * The shared importance-scoring loop (#425 extraction): one LLM call per
 * 10-memory batch through the production `importanceScoring` prompt, each
 * written score clamped at IMPORTANCE_CEILING and stamped with the
 * importance_scored_at watermark. Used by the nightly's stageImportance AND
 * `hicortex rescore-importance` — there is exactly one scoring code path
 * (no forked backfill logic; cap + watermark write identically everywhere).
 *
 * Failure semantics: a batch whose LLM call THROWS writes nothing (counted
 * in `failed` — retried naturally later); a batch whose reply parses to a
 * non-array falls back to 0.5 per memory (written + watermarked — the
 * endpoint answered, the answer was unusable).
 */
export async function scoreMemoriesImportance(
  db: Database.Database,
  memories: Memory[],
  llm: LlmClient,
  opts: {
    budget?: BudgetTracker;
    deadline?: RunDeadline;
    dryRun?: boolean;
    onBatch?: (written: number, failed: number) => void;
  } = {}
): Promise<{ scored: number; failed: number; skipped_budget: number }> {
  const batchSize = 10;
  const budget = opts.budget;
  const deadline = opts.deadline;
  const dryRun = opts.dryRun ?? false;
  let scored = 0;
  let failed = 0;
  let skippedBudget = 0;

  for (let i = 0; i < memories.length; i += batchSize) {
    if (budget?.exhausted) {
      skippedBudget += memories.length - i;
      break;
    }
    // #405: the run deadline bounds the batch loop too — a large unscored
    // backlog must not blow the whole run's wall-clock inside one stage.
    // Same stage label as the boundary check, so the defer log fires once.
    if (deadline?.hit("importance")) break;

    const batch = memories.slice(i, i + batchSize);
    const lines = batch.map(
      (mem, idx) => `[${idx}] ${mem.content.slice(0, 500)}`
    );
    const memoriesBlock = lines.join("\n\n");
    const prompt = importanceScoring(memoriesBlock);

    if (dryRun) continue;

    if (budget && !budget.use("importance")) {
      skippedBudget += memories.length - i;
      break;
    }

    try {
      const r = await llm.complete(prompt);
      budget?.recordUsage("importance", r.usage);
      let scores = parseJsonLenient<number[] | null>(r.text, null);

      if (!Array.isArray(scores)) {
        scores = new Array(batch.length).fill(0.5);
      }

      while (scores.length < batch.length) scores.push(0.5);
      scores = scores.slice(0, batch.length);

      let batchWritten = 0;
      let batchFailed = 0;
      for (let j = 0; j < batch.length; j++) {
        let scoreVal = 0.5;
        try {
          scoreVal = Math.max(0, Math.min(1, Number(scores[j])));
          if (isNaN(scoreVal)) scoreVal = 0.5;
        } catch {
          scoreVal = 0.5;
        }

        // #425: the write cap — importance exactly 1.0 has decay rate exactly
        // 1.0 and never decays, so no row is ever born immortal. The scored-at
        // watermark lands in the SAME update, taking the row out of the
        // nightly's unscored pool however it scored (the pre-#425 0.5-sentinel
        // re-rolled genuinely-0.5 rows every night).
        scoreVal = Math.min(scoreVal, CALIBRATION.IMPORTANCE_CEILING);
        try {
          storage.updateMemory(db, batch[j].id, {
            base_strength: scoreVal,
            importance_scored_at: new Date().toISOString(),
          });
          scored++;
          batchWritten++;
        } catch {
          failed++;
          batchFailed++;
        }
      }
      opts.onBatch?.(batchWritten, batchFailed);
    } catch {
      failed += batch.length;
      opts.onBatch?.(0, batch.length);
    }
  }

  return { scored, failed, skipped_budget: skippedBudget };
}

async function stageImportance(
  db: Database.Database,
  memories: Memory[],
  llm: LlmClient,
  budget: BudgetTracker,
  dryRun: boolean,
  deadline?: RunDeadline,
  /** #478: pool candidates the paid-gain guard dropped at the stage
   *  boundary — reported, not scored, so the run's evidence shows the
   *  promotion/enrichment gains that survived the nightly. */
  guardSkipped = 0,
): Promise<{ scored: number; failed: number; skipped_budget: number; guard_skipped: number }> {
  const r = await scoreMemoriesImportance(db, memories, llm, { budget, deadline, dryRun });
  return { ...r, guard_skipped: guardSkipped };
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
    const r = await llm.complete(prompt);
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

      // No `## Lesson:` prefix: memory_type='learnings' carries the type, and the
      // text is the topic-first first line (display reads the first line, not a
      // header parse — see learnings-identity.ts / index.ts).
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
            (n) => isContradictionCandidate(n.distance) && n.memory_type === "learnings"
          );

        let contradicted = false;
        if (similarLessons.length > 0 && budget.use("contradiction_check")) {
          const existingText = similarLessons[0].content.slice(0, 300);
          const newText = content.slice(0, 300);
          try {
            const verdictR = await llm.complete(
              `Two lessons from an AI memory system. Do they CONTRADICT each other (opposite advice on the same topic)?\n\n` +
              `EXISTING: ${existingText}\n\nNEW: ${newText}\n\n` +
              `Answer ONLY "yes" or "no". If the new lesson updates/refines the existing one (not contradicts), answer "no".`,
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
            memoryType: "learnings",
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
       WHERE domain IS NOT NULL AND memory_type = 'learnings' GROUP BY domain`,
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
  deadline?: RunDeadline,
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
  // #477: absorbed dedup losers are excluded — the merge clears their tags
  // and nulls domain before absorbing, so without the predicate every dead
  // loser re-enters this scope nightly (one classify call + a halving on
  // evidence no recall can ever see). Conjoined OUTSIDE the parenthesized OR
  // group so SQL precedence cannot let an OR arm absorb it.
  const placeholders = domains.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT id, content, project FROM memories
       WHERE COALESCE(status, '') != 'absorbed'
         AND (domain IS NULL
              OR domain NOT IN (${placeholders})
              OR id NOT IN (SELECT DISTINCT memory_id FROM memory_tags))`,
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
      // #405: the run deadline bounds the classification row loop (a large
      // backlog must defer, not blow the wall-clock). Same stage label as the
      // boundary check, so the defer log fires once.
      if (deadline?.hit("domain_curation")) break;
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
       WHERE project IS NOT NULL AND memory_type = 'learnings'
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
      const r = await llm.complete(domainCuration(projectLines));
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
 * classifyRelationship). No LLM call is made. #405: the ignored `llm`/`budget`
 * params are deleted — the signature now tells the truth.
 * The return shape is unchanged; `llmClassified` is always 0 and
 * `heuristicFallback` counts every candidate. Do NOT re-add an LLM path here
 * without a classifier that passes the audit harness at >= 70% acceptable.
 *
 * Shared between the nightly `stageLinks` and `hicortex relink`.
 * Returns one relationship type per candidate (same order as input).
 */
export async function classifyLinkCandidates(
  candidates: LinkCandidate[],
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

  // Phase B: heuristic-only classification (LLM retired; #405 dropped the
  // dead llm/budget params)
  const { types: classifiedTypes, llmClassified, heuristicFallback } =
    await classifyLinkCandidates(candidates);

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
// the corpus is back-processed gradually) whose shape suggests a
// decision/correction. For each, KNN top-5 OLDER same-shape neighbors
// at/above the release-managed similarity floor (calibration.ts); one constrained classify-tier LLM
// call per pair decides `superseded: true| false`. A parse/infra error skips
// just that PAIR (retried naturally next night since the cursor still
// advances past the memory — see the cursor note below); it never mis-links.
// #405: no per-stage call cap — the ONE run budget (nightlyLlmCallBudget)
// and the run deadline are the only bounds, like every other stage.

/** Default minimum COSINE similarity for a supersession candidate pair —
 *  RELEASE-MANAGED since #408 (calibration.ts SUPERSESSION_MIN_SIMILARITY). */
export const DEFAULT_SUPERSESSION_MIN_SIMILARITY = CALIBRATION.SUPERSESSION_MIN_SIMILARITY;
/** Default multiplier applied to a superseded memory's base_strength. */
/** Floor under which a superseded memory's base_strength never drops. */
/** Neighbor pool size before shape/older/similarity filtering narrows to top 5. */
const SUPERSESSION_NEIGHBOR_POOL = 15;
/** Older-neighbor pairs kept per candidate after filtering. */
const SUPERSESSION_NEIGHBOR_TOP_K = 5;
export interface SupersessionOptions {
  /** Candidate-pair cosine floor. Release-managed default (calibration.ts);
   *  this field is the eval/test seam. Invalid → default. */
  minSimilarity?: number;
  /** The run-wide pipeline deadline (#405) — checked at each candidate
   *  boundary; on expiry the scan stops and the cursor holds at the last
   *  fully-considered candidate (resumed next run). */
  deadline?: RunDeadline;
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
    mem.memory_type === "decisions" ||
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
    const r = await llm.complete(buildSupersessionPrompt(oldContent, newContent));
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
 *
 * #405: the cursor persists after EVERY fully-considered candidate (the
 * post-#404 reconsolidation pattern), not at stage end — a run killed or
 * deadline-deferred mid-stage loses at most the candidate in flight. No
 * orphan clamp is needed (unlike reconsolidation): supersession applies each
 * verdict's link immediately, so `cursor = candidate.__rowid` always sits
 * after all of that candidate's writes.
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

  const startCursor = loadState(stateDir).supersessionCursor ?? 0;
  const rows = db
    .prepare(
      // Candidate shape must mirror isSupersedableShape() exactly — keep the two
      // in lockstep (an inline SQL copy, so drift here silently narrows scope).
      `SELECT rowid AS __rowid, * FROM memories
       WHERE rowid > ?
         AND (memory_type = 'decisions'
              OR content LIKE '%[Decisions Made]%'
              OR content LIKE '%[Corrections & Rejections]%'
              OR content LIKE '%[Facts Learned]%'
              OR content LIKE '%[Project State Changes]%')
       ORDER BY rowid ASC`,
    )
    .all(startCursor) as Array<Memory & { __rowid: number }>;

  let scanned = 0;
  let evaluated = 0;
  let superseded = 0;
  let skippedInfra = 0;
  let skippedIdempotent = 0;
  let cursor = startCursor;
  // #405: per-candidate checkpoint — persists the cursor after every fully
  // considered candidate (updateState is an atomic temp-rename of a small
  // file; the loop cadence is seconds per candidate, so the cost is
  // negligible). The end-of-stage write below stays the authoritative final
  // write.
  const persistCursor = (): void => {
    if (dryRun) return;
    updateState((s) => {
      s.supersessionCursor = cursor;
    }, stateDir);
  };

  for (const candidate of rows) {
    // #405: the ONE run budget is the only call cap; the deadline stops the
    // scan at the candidate boundary — the cursor holds at the last
    // fully-considered candidate (persisted below).
    if (!dryRun && budget.exhausted) break;
    if (!dryRun && options.deadline?.hit("supersession")) break;
    scanned++;

    let neighbors: Array<Memory & { distance: number }>;
    try {
      neighbors = await findOlderNeighbors(db, candidate, embedFn, minSimilarity);
    } catch (err) {
      console.warn(
        `[hicortex] supersession: discovery failed for ${candidate.id.slice(0, 8)} — ${err instanceof Error ? err.message : String(err)}`,
      );
      cursor = candidate.__rowid;
      persistCursor(); // #405: every exit path persists
      continue;
    }

    for (const neighbor of neighbors) {
      if (alreadySupersedeLinked(db, neighbor.id, candidate.id)) {
        skippedIdempotent++;
        continue;
      }
      if (dryRun) continue; // preview only — no LLM call, no write

      if (!budget.use("supersession")) break; // #405: the ONE run budget

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
    // #405: checkpoint after every fully-considered candidate (post-#404
    // reconsolidation pattern) — a killed or deadline-deferred run loses at
    // most the candidate in flight.
    persistCursor();
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

  let candidates = 0;
  let pruned = 0;
  let failed = 0;

  for (const mem of oldUnaccessed) {
    const eff = effectiveStrength(mem.base_strength ?? 0.5, mem.last_accessed, now);

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
// Stage: Strength promotion (#448) — the strength model's upward path
// ---------------------------------------------------------------------------
//
// Real use of a memory (a surfaced /search or /recent hit, a hicortex_get)
// bumps access_count (storage.strengthenMemory). This stage converts that use
// signal into STRENGTH: every run, each memory whose access_count exceeds its
// stored baseline (promotion_last_count, migration v20 — backfilled to
// access_count at upgrade so lifetime counts are never replayed) is promoted
// once per new use by the calibration formula, capped at the importance
// ceiling. Decay stays untouched and uniform (#448 removed the hardening
// terms) — promotion is the only way use raises a score.
//
// Deterministic (zero LLM) and idempotent: the baseline advances to
// access_count in the same write, so a delta-less night is a no-op and a
// crashed run replays exactly the unconsumed delta. The demotion set
// (findDemotedIds: superseded/retracted rows + superseded_by-link sources)
// plus status 'absorbed' rows (named explicitly — findDemotedIds excludes
// them by design; they are filtered at candidacy elsewhere, but this stage
// reads the memories table directly) get NO bump — hidden evidence must not
// rise — but their baseline still advances, so a later un-mark never replays
// a stale delta.

/**
 * ONE application of the #448 promotion formula:
 * `S + PROMOTION_RATE × (1 − S / IMPORTANCE_CEILING) × S^(−0.3)`, clamped at
 * the ceiling. Pure + exported for exact-value tests; the stage applies it
 * iterated once per new use — iteration is what makes the ceiling asymptotic
 * (a count-sized single shot would overshoot it).
 *
 * The formula's S input is floored at PROMOTION_STRENGTH_FLOOR (#453 review,
 * owner decision 2026-09-16): S^(−0.3) has a zero-singularity, and a writable
 * base_strength of 0.0 would otherwise leap to the ceiling via Infinity→clamp
 * on a single access. The floor bounds the first boost at ≈+0.13; it clamps
 * the INPUT only — the stored 0.0 row is not rewritten, and the promoted
 * result is nonzero from then on.
 */
export function applyStrengthPromotion(baseStrength: number): number {
  const s = Math.max(baseStrength, CALIBRATION.PROMOTION_STRENGTH_FLOOR);
  return Math.min(
    s +
      CALIBRATION.PROMOTION_RATE *
        (1 - s / CALIBRATION.IMPORTANCE_CEILING) *
        Math.pow(s, -0.3),
    CALIBRATION.IMPORTANCE_CEILING,
  );
}

export function stagePromotion(
  db: Database.Database,
  dryRun: boolean,
): { promoted: number; demoted_skipped: number } {
  // Candidates: rows with at least one use since their stored baseline.
  // COALESCE treats a NULL baseline as 0 — dup-over-loss: an unknown baseline
  // promotes once, a held one never forgets a use.
  const rows = db
    .prepare(
      `SELECT id, base_strength, access_count, status,
              access_count - COALESCE(promotion_last_count, 0) AS delta
         FROM memories
        WHERE access_count > COALESCE(promotion_last_count, 0)`,
    )
    .all() as Array<{
    id: string;
    base_strength: number | null;
    access_count: number | null;
    status: string | null;
    delta: number;
  }>;

  if (rows.length === 0) return { promoted: 0, demoted_skipped: 0 };

  const demoted = findDemotedIds(db, rows.map((r) => r.id));

  let promoted = 0;
  let demotedSkipped = 0;
  let totalGain = 0;
  const writes: Array<{ id: string; fields: Record<string, unknown> }> = [];

  for (const row of rows) {
    const accessCount = row.access_count ?? 0;
    // Absorbed rows are invisible to recall but sit in the memories table —
    // they are demotion-set members this query CAN see (findDemotedIds
    // deliberately excludes them), so name them here.
    if (demoted.has(row.id) || row.status === "absorbed") {
      demotedSkipped++;
      writes.push({ id: row.id, fields: { promotion_last_count: accessCount } });
      continue;
    }
    // base_strength is NOT NULL after scoring; the `?? 0.5` mirrors
    // stageDecayPrune's defensive default for unscored rows (inserts at 0.5).
    const startStrength = row.base_strength ?? 0.5;
    let strength = startStrength;
    for (let i = 0; i < row.delta; i++) strength = applyStrengthPromotion(strength);
    totalGain += strength - startStrength;
    promoted++;
    writes.push({
      id: row.id,
      fields: { base_strength: strength, promotion_last_count: accessCount },
    });
  }

  // #459: the stage's one-line summary in the shared stage idiom (rows
  // examined / promoted / total gain, like the supersession summary) — the
  // stage writes its report in-memory only, so the log line is the soak-time
  // health signal. Zero examined rows stay silent (the supersession gate).
  if (dryRun) {
    console.log(
      `[hicortex] Strength promotion (dry-run): ${rows.length} examined, would promote ` +
        `${promoted} (+${totalGain.toFixed(3)} total strength, ` +
        `${demotedSkipped} demotion-set rows advance their baseline only).`,
    );
    return { promoted, demoted_skipped: demotedSkipped };
  }

  // One transaction for the whole stage (the stageMemoryCapEviction pattern):
  // strength + baseline move together or not at all — a baseline that
  // advanced without its bump (or vice versa) would lose or replay a use.
  const tx = db.transaction(() => {
    for (const w of writes) storage.updateMemory(db, w.id, w.fields);
  });
  tx();

  console.log(
    `[hicortex] Strength promotion: ${rows.length} examined, promoted ${promoted} ` +
      `(+${totalGain.toFixed(3)} total strength, ` +
      `${demotedSkipped} demotion-set rows advance their baseline only).`,
  );

  return { promoted, demoted_skipped: demotedSkipped };
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
// surfaces in the top-k. #448: the ordering is base + recency ONLY (the
// access/link hardening terms are gone), and a row used since the last run
// was promoted by stagePromotion earlier in the SAME run — a promoted row
// survives a cap it would otherwise have lost. The evicted tail is, by
// construction, the tail that was not surfacing anyway (cold, decayed). Ties
// are broken by oldest COALESCE(last_accessed, created_at) — i.e. the
// memories that have gone longest without anyone looking at them.
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

/** Env override for the soft cap (#317). Hosted: provider-set via the tenant
 *  .env, tenant-immutable at runtime (same posture as HICORTEX_TOKEN_CAP).
 *  Self-hosted: an operator knob — mode-agnostic, never branches on
 *  hostedMode. */
const MEMORY_CAP_ENV = "HICORTEX_MEMORY_CAP";

/**
 * Resolve the effective soft cap (#317): a positive finite HICORTEX_MEMORY_CAP
 * env wins over the `memorySoftCap` config key, which wins over
 * DEFAULT_MEMORY_SOFT_CAP. The env is the PRICING boundary — in the hosted
 * stack the cap is a per-plan parameter the provider pins into the tenant .env
 * (docker exec inherits container env, so the eviction path sees it), and the
 * tenant's config.json is bind-mounted writable at /data, so config-only
 * resolution would let a tenant raise or disable its own cap. Same
 * env-wins-precedence pattern as resolveTokenCap (token-budget.ts) and
 * resolveBodyLimitMb (mcp-server.ts).
 *
 * Deliberate asymmetry with resolveTokenCap: a MALFORMED/0/negative env falls
 * through (an env can pin a cap but never disable one), while config 0 is
 * still honored as the #245 opt-out (indefinite growth) when the env is unset
 * — env unset → config → default is exactly the pre-#317 behavior, so a
 * self-hosted install that never hears about the env sees no change. Pure —
 * exported for tests; every consumer (nightly eviction + snapshot stamp,
 * dashboard live headline) must route through this ONE function so the
 * enforced cap and the displayed cap cannot disagree.
 */
export function resolveMemorySoftCap(configVal: unknown): number {
  const envCap = Number(process.env[MEMORY_CAP_ENV]);
  if (Number.isFinite(envCap) && envCap > 0) return envCap;
  // Reuse the disk→runtime boundary validator (warn-on-rejected-value) so the
  // config half behaves byte-for-byte like the pre-#317 readNonNegativeConfig
  // call sites: absent → default, valid non-negative (incl. 0 = disabled)
  // passes through, invalid → warn + default.
  return readNonNegativeConfig(
    { memorySoftCap: configVal },
    "memorySoftCap",
    DEFAULT_MEMORY_SOFT_CAP,
  );
}

export function stageMemoryCapEviction(
  db: Database.Database,
  dryRun: boolean,
  cap: number,
): { cap: number; evicted: number } {
  // `0` = explicitly disabled (current/legacy behaviour). The guard is on `<=`
  // not `===` to also absorb a stray negative (readNonNegativeConfig already
  // rejects negatives at the boundary, but this stage is callable directly).
  if (cap <= 0) return { cap, evicted: 0 };

  // #422 (#317 discipline): the cap keys off LIVE (non-absorbed) rows on BOTH
  // the count and the victim SELECT — absorbed rows are invisible evidence
  // (no vector, no FTS, recall never serves them); they must neither consume
  // cap headroom nor be picked as eviction victims. The DISPLAYED headroom
  // (dashboard.ts headline live_memories vs memory_soft_cap) reads the same
  // predicate, so the enforced and displayed caps cannot disagree.
  const count = (
    db
      .prepare("SELECT COUNT(*) AS c FROM memories WHERE COALESCE(status, '') != 'absorbed'")
      .get() as { c: number }
  ).c;
  if (count <= cap) return { cap, evicted: 0 };

  const surplus = count - cap;

  // Load the fields effectiveStrength needs + the tiebreak. base_strength is
  // NOT NULL after scoring; the `?? 0.5` mirrors stageDecayPrune's defensive
  // default for unscored rows (inserts at 0.5). last_accessed is NULL until
  // first /recall-index exposure — COALESCE to created_at for the tiebreak so
  // never-shown memories sort by when they entered the corpus. Same
  // non-absorbed predicate as the count above.
  const rows = db
    .prepare(
      `SELECT id, base_strength, last_accessed, created_at
         FROM memories
        WHERE COALESCE(status, '') != 'absorbed'`,
    )
    .all() as Array<{
    id: string;
    base_strength: number | null;
    last_accessed: string | null;
    created_at: string;
  }>;

  const now = new Date();

  // Decorate + sort: lowest effectiveStrength first; ties broken by oldest
  // COALESCE(last_accessed, created_at). The victims are the first `surplus`.
  const decorated = rows.map((r) => {
    const eff = effectiveStrength(r.base_strength ?? 0.5, r.last_accessed, now);
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
 * internally (one 60 s retry, #405) and the phase fails soft on persistence —
 * the nightly retries on the next run. No pre-flight health checks; the
 * phase either answers or is skipped until the next scheduled run. When
 * `domains` is absent/empty, the legacy project-grouping curation runs
 * unchanged.
 */
export interface DomainStageOptions {
  domains?: DomainDef[] | null;
  contentDomainsReady?: boolean;
  /**
   * Weak-primary floor for the no-fit path (see nofit.ts). Release-managed
   * default (#408 — calibration.ts WEAK_PRIMARY_FLOOR via nofit's
   * DEFAULT_WEAK_PRIMARY_FLOOR); this field stays as the eval/test seam.
   */
  weakPrimaryFloor?: number;
}

/**
 * Minimal resolution-stage report for a SKIPPED (quiet-night) consolidation
 * run (#392): every stage field zero except `merges` — the deterministic
 * zone's own report — and its derived deterministic band snapshot. Keeps the
 * one-report surface intact (the zone is the only resolution work a quiet
 * night does) while telemetry's "skipped = zero LLM work" stays true. Knob
 * validation mirrors the stage's own (invalid → defaults).
 */
async function skippedRunResolutionReport(
  db: Database.Database,
  dryRun: boolean,
  stateDir: string | undefined,
  options: ReconsolidationOptions = {},
): Promise<NonNullable<ConsolidationReport["stages"]["reconsolidation"]>> {
  const validNumber = (v: unknown, fallback: number, ok: (n: number) => boolean): number => {
    const n = Number(v);
    return Number.isFinite(n) && ok(n) ? n : fallback;
  };
  const autoMergeThreshold = validNumber(
    options.autoMergeThreshold,
    DEFAULT_DEDUP_MERGE_THRESHOLD,
    (n) => n > 0 && n <= 1,
  );

  const merges = await runDeterministicMergeZone(db, {
    stateDir,
    threshold: autoMergeThreshold,
    dryRun,
    acquireLock: options.acquireLock,
    deadline: options.deadline,
  });

  const bandStats: Record<string, ResolutionBandStat> = {};
  {
    // #405: recorded whenever the zone ran (the old max_merges>0 gate was a
    // 0=disabled switch — the switch is gone).
    bandStats[`>=${autoMergeThreshold}`] = {
      pairs: merges.losers_merged,
      merge: merges.losers_merged,
      corrects: 0,
      supersedes: 0,
      conflicts: 0,
      none: 0,
      merge_below_gate: 0,
      conf_sum: merges.losers_merged,
      ...(merges.skipped_metadata_mismatch > 0
        ? { metadata_skipped: merges.skipped_metadata_mismatch }
        : {}),
    };
  }

  return {
    scanned: 0,
    pairs_evaluated: 0,
    pairs_discovered: 0, // #394: the scan doesn't run on a quiet night — nothing discovered
    pairs_discovered_unlinked: 0,
    rewritten: 0,
    absorbed: 0,
    kept_linked: 0,
    marked_superseded: 0,
    marked_retracted: 0,
    below_gate: 0,
    contract_failed: 0,
    skipped_infra: 0,
    skipped_idempotent: 0,
    explicit_verified: 0,
    explicit_divergent: 0,
    cursor: loadState(stateDir).reconsolidationCursor ?? 0,
    // #439 fields: zeros on a quiet night (no scan ran — nothing re-judged,
    // new, skipped, or deferred; the type carries them so the report surface
    // stays uniform).
    pairs_reevaluated: 0,
    pairs_new: 0,
    skipped_absorbed: 0,
    merge_pairs_deferred: 0,
    merges,
    merge_pairs_applied: 0,
    merge_below_gate: 0,
    skipped_above_ceiling: 0,
    skipped_metadata_mismatch: 0,
    conflict_flagged: 0, // guard-C: no scan on a quiet night — nothing flagged
    conflict_skipped: merges.skipped_conflict, // guard-C: the zone's guard still counts
    scout_scanned: 0, // #393 B: the scan (and its shape calls) doesn't run on a quiet night
    scout_correction_shaped: 0,
    scout_candidates_found: 0,
    band_stats: bandStats,
  };
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
  /** The ONE per-run LLM-call ceiling (#405/#241). The caller resolves
   *  `nightlyLlmCallBudget` from config (consolidateMaxLlmCalls is a
   *  deprecated alias — resolveNightlyLlmCallBudget) and passes it; unset →
   *  the exported DEFAULT_NIGHTLY_LLM_CALL_BUDGET (5000). */
  budgetMaxCalls?: number,
  /** Soft cap on the corpus (#245). Nightly.ts reads `memorySoftCap` from
   *  config and passes it; unset → `DEFAULT_MEMORY_SOFT_CAP` (10000). `0`
   *  disables eviction (indefinite growth). */
  memorySoftCap?: number,
  /** Reconsolidation-stage knobs (#384) — eval/test seams since #408 (the
   *  values are release-managed calibration constants; nightly.ts threads
   *  NOTHING), exactly like supersessionOptions above; unset fields → the
   *  stage's calibration defaults. Appended AFTER the pre-#384 params so
   *  every existing positional caller (tests, hosted nightly) keeps its
   *  argument meaning. */
  reconsolidationOptions?: ReconsolidationOptions,
  /**
   * The run-wide pipeline deadline (#405), created at nightly start and
   * shared by capture + every consolidation stage. Absent = no deadline
   * (tests, evict-only paths, pre-#405 callers). When it fires, every
   * not-yet-run stage defers (logs event=deadline_deferred stage=<name>) and
   * the report status becomes "deferred" — which keeps lastConsolidated
   * un-advanced so the next run re-finds the pending work.
   */
  deadline?: RunDeadline,
): Promise<ConsolidationReport> {
  const start = new Date();
  const report: ConsolidationReport = {
    started_at: start.toISOString(),
    dry_run: dryRun,
    status: "completed",
    stages: {},
  };

  // Stage 1: Pre-check
  const precheck = stagePrecheck(db, stateDir);

  // #478: the importance pool is ROW-AGE bound — young (ingested within
  // IMPORTANCE_SETTLE_WINDOW_DAYS) ∪ never-scored. The lastConsolidated
  // watermark no longer defines any part of it: a deferred run's stuck
  // watermark used to re-settle a growing cohort nightly, and every
  // re-settle overwrites base_strength outright (erasing gains
  // stagePromotion had already paid — 5/5 observed erasures). The watermark
  // cohort (precheck.newMemories) STILL feeds reflection + links below —
  // their work is batch retry by design; only importance's per-row settling
  // was mis-bound to the batch marker.
  const settleCutoff = new Date(
    Date.now() - CALIBRATION.IMPORTANCE_SETTLE_WINDOW_DAYS * 86_400_000,
  ).toISOString();
  // getMemoriesSince keys on ingested_at only — absorbed rows (invisible to
  // recall) are filtered here in the same vocabulary getUnscoredMemories
  // uses in SQL: no LLM call on dead evidence.
  const young = storage
    .getMemoriesSince(db, settleCutoff)
    .filter((m) => m.status !== "absorbed");
  const youngIds = new Set(young.map((m) => m.id));

  // Also check for unscored memories (#425 watermark pool) — first settle is
  // age-independent, so a row used before its first score is never stranded.
  const unscored = storage.getUnscoredMemories(db);
  const scoreMemories = [
    ...young,
    ...unscored.filter((m) => !youngIds.has(m.id)),
  ];

  // #194 no-fit scope: untagged rows (domain IS NULL) stay in the
  // re-evaluation scope — the decay/re-attempt contract ("re-halves once per
  // run while still below the floor") is work even on a quiet night with
  // nothing new. The skip below gated on new+unscored only, which the tests
  // never caught because stagePrecheck used to read the AMBIENT (always
  // empty in the suite) state instead of the run's own watermark — threading
  // stateDir (#357) exposed the divergence between test and production.
  // #477: absorbed dedup losers (tags cleared, domain NULLed by the merge)
  // are dead evidence — they must not keep the no-fit scope (and the run)
  // alive every night. Same predicate spelling as getUnscoredMemories.
  const nofitInScope = (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM memories WHERE domain IS NULL AND COALESCE(status, '') != 'absorbed'",
      )
      .get() as {
      n: number;
    }
  ).n;

  // #478: the quiet-night gate is the UNION — watermark cohort OR young OR
  // unscored OR no-fit scope. A stuck watermark alone must never silence
  // reflection/links (their pool is the watermark cohort, and their retry
  // semantics are the reason a deferred run holds the watermark at all).
  const skip =
    scoreMemories.length === 0 &&
    precheck.newMemories.length === 0 &&
    nofitInScope === 0;

  report.stages.precheck = {
    skip,
    reason: skip
      ? precheck.reason
      : `${precheck.newMemories.length} new (watermark) + ${young.length} young + ${scoreMemories.length - young.length} unscored memories`,
    new_memory_count: precheck.newMemories.length,
    unscored_count: unscored.length,
  };

  // Strength promotion (#448) — runs in the pre-skip deterministic zone, in
  // the same placement discipline as memory_cap BELOW it: accesses happen on
  // quiet nights too (no new memories must still promote the day's uses),
  // and a used row must be promoted BEFORE eviction victims are chosen (a
  // promoted row survives a cap it would otherwise lose). Zero LLM — it sits
  // before the BudgetTracker exists, ungated by budget and deadline.
  report.stages.promotion = stagePromotion(db, dryRun);

  // Memory cap eviction (#245) — runs BEFORE the precheck skip so the corpus
  // is bounded even on quiet nights (no new memories → precheck would skip,
  // but the cap stage is pure DB: cheap, idempotent when under cap).
  report.stages.memory_cap = stageMemoryCapEviction(
    db,
    dryRun,
    memorySoftCap ?? DEFAULT_MEMORY_SOFT_CAP,
  );

  if (skip) {
    // #392: the deterministic merge zone is LLM-free, so a quiet night (zero
    // new memories → this skip) still drains a pre-existing duplicate
    // backlog — the memory_cap precedent. Results ride the ONE resolution
    // stage report (telemetry's "skipped = zero LLM work" stays true), and
    // the zone never runs twice: the main path runs it INSIDE the stage, this
    // skip path returns before that.
    report.stages.reconsolidation = await skippedRunResolutionReport(db, dryRun, stateDir, { ...reconsolidationOptions, deadline });
    report.status = "skipped";
    report.completed_at = new Date().toISOString();
    return report;
  }

  // #405: the ONE per-run LLM-call ceiling (default 5000). The caller
  // resolves `nightlyLlmCallBudget` from config (consolidateMaxLlmCalls is a
  // deprecated alias — see resolveNightlyLlmCallBudget) and passes it here.
  const budget = new BudgetTracker(budgetMaxCalls ?? DEFAULT_NIGHTLY_LLM_CALL_BUDGET);
  console.log(`[hicortex] Consolidation LLM call budget: ${budget.maxCalls} calls`);

  try {
    // #405 stage gating: each boundary checks the run deadline; a hit defers
    // that stage (absent from the report — it did not run) and logs
    // event=deadline_deferred stage=<name> once. Later boundaries check
    // independently, so a mid-run deadline reports every remaining stage as
    // deferred. Deferred stages drain next run (cursors hold below them).

    // Stage 2: Importance Scoring
    if (!deadline?.hit("importance")) {
      // #478 paid-gain guard — evaluated HERE, at the stage boundary, not at
      // pool-build time: the pool above was built before this run's
      // stagePromotion payment, so a row whose FIRST use lands this run
      // passes a pool-build check and its just-paid gain is overwritten at
      // the first re-settle. This read sits after promotion by construction
      // and sees the advanced baseline. Already-scored rows carrying a paid
      // gain (promotion baseline advanced OR owner corroboration) keep it —
      // re-settling would stomp base_strength; `hicortex rescore-importance`
      // remains the wholesale operator re-judge. Never-scored rows
      // (importance_scored_at IS NULL) are NEVER skipped: first settle
      // always happens, whatever their use history.
      const paidGainIds = scoreMemories.length
        ? new Set(
            (db.prepare(
              `SELECT id FROM memories
                WHERE importance_scored_at IS NOT NULL
                  AND (COALESCE(promotion_last_count, 0) > 0
                       OR COALESCE(corroboration_count, 0) > 0)
                  AND id IN (${scoreMemories.map(() => "?").join(", ")})`,
            ).all(...scoreMemories.map((m) => m.id)) as Array<{ id: string }>)
              .map((r) => r.id),
          )
        : new Set<string>();
      const settleCandidates = scoreMemories.filter((m) => !paidGainIds.has(m.id));
      report.stages.importance = await stageImportance(
        db,
        settleCandidates,
        llm,
        budget,
        dryRun,
        deadline,
        scoreMemories.length - settleCandidates.length,
      );
    }

    // Stage 2.5: Reflection
    if (deadline?.hit("reflection")) {
      // deferred — stage absent from the report
    } else if (skipReflection) {
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
    if (!deadline?.hit("domain_curation")) {
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
            deadline,
          );
        }
      } else {
        report.stages.domain_curation = await stageDomainCuration(db, llm, budget, dryRun, stateDir);
      }
    }

    // Stage 3: Link Discovery (heuristic edge classification — local work,
    // but bounded by the same deadline as every other stage).
    if (!deadline?.hit("links")) {
      report.stages.links = await stageLinks(
        db,
        precheck.newMemories,
        embedFn,
        dryRun,
        llm,
        budget,
      );
    }

    // Stage 3.7: Supersession Detection (#191 Phase B)
    if (!deadline?.hit("supersession")) {
      report.stages.supersession = await stageSupersession(
        db, llm, budget, embedFn, dryRun, stateDir,
        { ...supersessionOptions, deadline },
      );
    }

    // Stage 3.8: Reconsolidation (#384) — resolve corrections: rewrite
    // fact-shaped targets in place (absorbing transition-only triggers),
    // mark everything else. Rides the same shared budget under its own stage
    // label + cursor (supersession-stage pattern).
    if (!deadline?.hit("reconsolidation")) {
      report.stages.reconsolidation = await stageReconsolidation(
        db, llm, budget, embedFn, dryRun, stateDir,
        { ...reconsolidationOptions, deadline },
      );
    }

    // Stage 4: Decay & Prune
    if (!deadline?.hit("decay_prune")) {
      report.stages.decay_prune = stageDecayPrune(db, dryRun);
    }

    // (Memory cap eviction moved before the precheck skip — see above.)
  } catch (err) {
    report.status = "failed";
    console.error("[hicortex] Consolidation pipeline error:", err);
  }

  // #405: any deferred stage ⇒ the run is "deferred", not "completed" — the
  // lastConsolidated gate below then holds the watermark so the next run's
  // pending-set queries re-find the deferred work (mirrors endpoint_down).
  // A thrown error still wins ("failed" is the more specific outcome).
  if (report.status === "completed" && deadline && deadline.deferredStages().length > 0) {
    report.status = "deferred";
  }

  // Update last-consolidated timestamp. #357: the stages fail SOFT, so a run
  // against an endpoint that died mid-way still reports status "completed"
  // here — advancing the timestamp made state.json disagree with the
  // nightly's breaker-open override to endpoint_down (observed 0.20.0 soak:
  // endpoint_down reported, lastConsolidated advanced anyway). Gate on the
  // SAME signal the nightly's override reads (llm.breakerOpen) so the two
  // sites agree for the breaker case — keep this condition and the override
  // in nightly.ts in sync if either ever grows. (Sibling soft-fail paths —
  // e.g. a sustained-429 run, which never accrues to the breaker because a
  // 429 proves the endpoint answers — still advance; that is the #337
  // taxonomy working as designed.)
  if (!dryRun && report.status === "completed" && !llm.breakerOpen) {
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
