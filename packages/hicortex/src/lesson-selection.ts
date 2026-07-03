/**
 * Domain-aware lesson selection engine — the DEFAULT selector for all installs.
 *
 * History: originally shipped as a Pro feature (src/pro/selection.ts), deleted
 * with the Pro loader in #122, restored into core in #123. Free personal
 * self-host = the full product; there is no gated variant of this selector.
 *
 * Behaviour: score each lesson by four axes, pick the top N, dedup
 * semantically-adjacent entries by normalized-prefix matching.
 *
 * Scoring formula:
 *   score = w_project * project_match
 *         + w_recency * recency_score
 *         + w_strength * base_strength
 *         + w_access * access_affinity
 *
 * where:
 *   project_match:
 *     1.0 if lesson.project === ctx.project
 *     0.5 if lesson.project is in the same knowledge domain (via ctx.moduleIndex)
 *     0.3 if lesson.project === "global"
 *     0.0 otherwise
 *
 *   recency_score:
 *     exp(-age_days / half_life_days) in [0, 1]
 *     half_life_days = 30 — lessons fade to half weight after 30 days
 *
 *   base_strength:
 *     lesson.base_strength from the DB (already in [0, 1])
 *     represents the importance score from the nightly reflection stage
 *
 *   access_affinity:
 *     min(access_count / 5, 1.0)  — capped at 5 accesses
 *     lessons that have been retrieved before get a small boost
 *
 * Default weights:
 *   w_project = 0.40  (in-project relevance matters most)
 *   w_recency = 0.25  (newer lessons preferred)
 *   w_strength = 0.25 (important lessons preferred)
 *   w_access = 0.10   (proven-useful lessons preferred)
 *
 * After scoring, lessons are sorted high-to-low, then deduplicated via
 * prefix matching: a lesson is considered a duplicate of an already-selected
 * lesson if its normalized content is a prefix of the other (or vice versa),
 * with at least 30 characters in common. This catches lessons that were
 * rewritten slightly across nightly runs — e.g. "Always validate input" vs
 * "Always validate input before processing any data". The 30-char floor
 * prevents false positives on genuinely short, distinct lessons.
 *
 * When all lessons score identically (no project/date/strength metadata),
 * the sort is stable, so input order is preserved — equivalent to the old
 * slice(0, N) behaviour for metadata-free candidate pools.
 *
 * Generic over T so the same function handles:
 *   - Memory[] from local DB queries (server mode)
 *   - {content, created_at, base_strength, access_count} HTTP shape (client mode)
 */

import type { LessonSelector, SelectableLesson, LessonSelectorContext } from "./extensions.js";
import type { ModuleIndex } from "./types.js";

const W_PROJECT = 0.40;
const W_RECENCY = 0.25;
const W_STRENGTH = 0.25;
const W_ACCESS = 0.10;

const RECENCY_HALF_LIFE_DAYS = 30;

function parseDate(ts: string | undefined): Date | null {
  if (!ts) return null;
  const d = new Date(ts);
  return isNaN(d.getTime()) ? null : d;
}

function projectMatch(
  lesson: SelectableLesson,
  targetProject: string | null | undefined,
  moduleIndex?: ModuleIndex,
): number {
  if (!lesson.project) return 0.0;
  if (targetProject && lesson.project === targetProject) return 1.0;
  if (lesson.project === "global") return 0.3;

  // Domain-aware: same domain = 0.5
  if (targetProject && moduleIndex) {
    const targetDomain = moduleIndex.domains.find((d) =>
      d.projects.includes(targetProject)
    );
    if (targetDomain && targetDomain.projects.includes(lesson.project)) {
      return 0.5;
    }
  }

  return 0.0;
}

function recencyScore(lesson: SelectableLesson, now: Date): number {
  const created = parseDate(lesson.created_at);
  if (!created) return 0.5; // unknown date → neutral score
  const ageMs = now.getTime() - created.getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  if (ageDays < 0) return 1.0; // future-dated, treat as very recent
  return Math.exp(-ageDays / RECENCY_HALF_LIFE_DAYS);
}

function accessAffinity(lesson: SelectableLesson): number {
  const count = lesson.access_count ?? 0;
  return Math.min(count / 5, 1.0);
}

/**
 * Normalize a lesson's content to its canonical form for prefix comparison.
 * Lowercase, collapse whitespace, trim. Full content is preserved so prefix
 * matching below can handle lessons of different lengths.
 */
function dedupKey(lesson: SelectableLesson): string {
  return lesson.content.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Minimum shared-prefix length for two lessons to be considered duplicates.
 * Shorter values cause false positives on genuinely distinct short lessons;
 * longer values miss legitimate duplicates that happen to differ in the
 * first few dozen characters.
 */
const DEDUP_MIN_SHARED_PREFIX = 30;

function isPrefixDuplicate(candidate: string, existing: string): boolean {
  const shorter = candidate.length < existing.length ? candidate : existing;
  const longer = candidate.length < existing.length ? existing : candidate;
  return shorter.length >= DEDUP_MIN_SHARED_PREFIX && longer.startsWith(shorter);
}

/**
 * The domain-aware lesson selector. Registered as the default in extensions.ts.
 */
export const domainAwareLessonSelector: LessonSelector = {
  select<T extends SelectableLesson>(lessons: T[], ctx: LessonSelectorContext): T[] {
    if (lessons.length === 0) return [];

    const now = new Date();

    // Score every lesson
    const scored = lessons.map((lesson) => {
      const pMatch = projectMatch(lesson, ctx.project, ctx.moduleIndex);
      const rScore = recencyScore(lesson, now);
      const sScore = lesson.base_strength ?? 0.5;
      const aScore = accessAffinity(lesson);
      const score =
        W_PROJECT * pMatch +
        W_RECENCY * rScore +
        W_STRENGTH * sScore +
        W_ACCESS * aScore;
      return { lesson, score };
    });

    // Sort high → low (Array.prototype.sort is stable — equal scores keep input order)
    scored.sort((a, b) => b.score - a.score);

    // Select top N with prefix-based dedup
    const selected: T[] = [];
    const selectedKeys: string[] = [];
    for (const { lesson } of scored) {
      if (selected.length >= ctx.maxLessons) break;
      const key = dedupKey(lesson);
      const isDup = selectedKeys.some((existing) => isPrefixDuplicate(key, existing));
      if (isDup) continue;
      selectedKeys.push(key);
      selected.push(lesson);
    }

    return selected;
  },
};
