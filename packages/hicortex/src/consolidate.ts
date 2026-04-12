/**
 * Nightly consolidation pipeline — importance scoring, reflection,
 * link discovery, decay/prune.
 * Ported from hicortex/consolidate/ (stages.py, __init__.py, budget.py).
 */

import type Database from "better-sqlite3";
import type { Memory, ConsolidationReport } from "./types.js";
import type { LlmClient } from "./llm.js";
import type { EmbedFn } from "./retrieval.js";
import { effectiveStrength } from "./retrieval.js";
import * as storage from "./storage.js";
import { importanceScoring, reflection } from "./prompts.js";
import { memoryCapReached, maxMemoriesAllowed } from "./features.js";
import { loadState, updateState } from "./state.js";

// Default config constants (matching Python config.py)
const CONSOLIDATE_MAX_LLM_CALLS = 200;
const CONSOLIDATE_PRUNE_MIN_AGE_DAYS = 90;
const CONSOLIDATE_LINK_THRESHOLD = 0.55;

// ---------------------------------------------------------------------------
// BudgetTracker
// ---------------------------------------------------------------------------

export class BudgetTracker {
  maxCalls: number;
  callsUsed = 0;
  callsByStage: Record<string, number> = {};

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

  summary(): NonNullable<ConsolidationReport["budget"]> {
    return {
      max_calls: this.maxCalls,
      calls_used: this.callsUsed,
      calls_remaining: this.remaining,
      calls_by_stage: { ...this.callsByStage },
    };
  }
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
      const raw = await llm.completeFast(prompt, 256);
      let scores = parseJsonLenient<number[] | null>(raw, null);

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
    const raw = await llm.completeReflect(prompt, 2048);
    const lessons = parseJsonLenient<unknown[]>(raw, []);

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

      let content = `## Lesson: ${lessonText}\n\n`;
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
        // Check memory cap before storing lesson
        if (memoryCapReached(storage.countMemories(db))) {
          console.log(
            `[hicortex] Free tier limit (${maxMemoriesAllowed()} memories). ` +
            `Existing memories and lessons still work. New lessons won't be saved. ` +
            `Upgrade for unlimited usage: https://hicortex.gamaze.com/`
          );
          break;
        }
        const embedding = await embedFn(content);
        storage.insertMemory(db, content, embedding, {
          sourceAgent: "hicortex/reflection",
          project,
          memoryType: "lesson",
          baseStrength: baseStrength[severity] ?? 0.8,
          privacy: "WORK",
        });
        generated++;
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
// Stage 3: Link Discovery (vector similarity auto-link)
// ---------------------------------------------------------------------------

async function stageLinks(
  db: Database.Database,
  memories: Memory[],
  embedFn: EmbedFn,
  dryRun: boolean
): Promise<{ auto_linked: number; failed: number }> {
  let autoLinked = 0;
  let failed = 0;

  for (const mem of memories) {
    try {
      const embedding = await embedFn(mem.content);
      const neighbors = storage.vectorSearch(db, embedding, 10, [mem.id]);

      for (const neighbor of neighbors) {
        const similarity = 1.0 - neighbor.distance;
        if (similarity > CONSOLIDATE_LINK_THRESHOLD) {
          const relationship = classifyRelationship(mem, neighbor, similarity);
          if (!dryRun) {
            try {
              storage.addLink(db, mem.id, neighbor.id, relationship, similarity);
              autoLinked++;
            } catch {
              failed++;
            }
          } else {
            autoLinked++;
          }
        }
      }
    } catch {
      failed++;
    }
  }

  return { auto_linked: autoLinked, failed };
}

/**
 * Classify the relationship between two memories based on type, temporal ordering, and similarity.
 */
function classifyRelationship(
  source: Memory,
  target: Memory,
  similarity: number
): string {
  // Lesson derived from episode(s)
  if (source.memory_type === "lesson" && target.memory_type === "episode") return "derives";
  if (target.memory_type === "lesson" && source.memory_type === "episode") return "derives";

  // Same type + very high similarity + different timestamps → newer updates older
  if (
    source.memory_type === target.memory_type &&
    similarity > 0.8 &&
    source.created_at !== target.created_at
  ) {
    return "updates";
  }

  // Same project, moderate similarity → extends
  if (
    source.project && target.project &&
    source.project === target.project &&
    similarity > 0.55 && similarity <= 0.8
  ) {
    return "extends";
  }

  return "relates_to";
}

// ---------------------------------------------------------------------------
// Stage 4: Decay & Prune
// ---------------------------------------------------------------------------

function stageDecayPrune(
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
// Full pipeline
// ---------------------------------------------------------------------------

/**
 * Run the full consolidation pipeline. Returns a structured report.
 */
export async function runConsolidation(
  db: Database.Database,
  llm: LlmClient,
  embedFn: EmbedFn,
  dryRun = false,
  skipReflection = false,
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

  if (skip) {
    report.status = "skipped";
    report.completed_at = new Date().toISOString();
    return report;
  }

  const budget = new BudgetTracker(CONSOLIDATE_MAX_LLM_CALLS);

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

    // Stage 3: Link Discovery
    report.stages.links = await stageLinks(
      db,
      precheck.newMemories,
      embedFn,
      dryRun
    );

    // Stage 4: Decay & Prune
    report.stages.decay_prune = stageDecayPrune(db, dryRun);
  } catch (err) {
    report.status = "failed";
    console.error("[hicortex] Consolidation pipeline error:", err);
  }

  // Update last-consolidated timestamp
  if (!dryRun && report.status === "completed") {
    updateState((s) => {
      s.lastConsolidated = new Date().toISOString();
      return s;
    });
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
