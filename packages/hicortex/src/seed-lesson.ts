/**
 * Seed lesson — injected on first run, teaches agents to self-improve.
 * Shared between OC plugin and CC MCP server.
 */

import type Database from "better-sqlite3";
import { embed } from "./embedder.js";
import * as storage from "./storage.js";

export const SEED_LESSON = `## Lesson: 1% Daily Self-Improvement

Self-improvement protocol: Review your sessions daily. Scan for mistakes, gaps, user corrections, and friction. Identify 1-2 issues maximum. Apply one targeted fix to your instruction files (AGENT.md, IDENTITY.md, TOOLS.md, SOUL.md, or CLAUDE.md). Never overcorrect — feedback is guidance, not emergency. One fix per issue. Never rewrite entire systems. Before changing something, ask: is this a real pattern or am I reacting to noise?

The flywheel: Sessions → Hicortex captures → Nightly consolidation → Lessons generated → Lessons injected into your context → You apply one fix → Better sessions tomorrow.

Use hicortex_lessons to check for new insights. If a lesson has high confidence, apply it. If medium, observe for one more day. If nothing needs fixing today, skip — that's fine.

**Severity:** critical
**Confidence:** high
**Generated:** seed-lesson`;

export async function injectSeedLesson(
  database: Database.Database,
  log: (msg: string) => void = console.log
): Promise<void> {
  try {
    const existing = storage.getLessons(database, 365);
    const hasSeed = existing.some(
      (l) => l.content.includes("1% Daily Self-Improvement") ||
             l.source_agent === "hicortex/seed"
    );
    if (hasSeed) return;

    const embedding = await embed(SEED_LESSON);
    storage.insertMemory(database, SEED_LESSON, embedding, {
      sourceAgent: "hicortex/seed",
      project: "global",
      memoryType: "lesson",
      baseStrength: 0.95,
      privacy: "WORK",
    });
    log("[hicortex] Seed lesson injected: Daily Self-Improvement Protocol");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[hicortex] Warning: could not inject seed lesson: ${msg}`);
  }
}
