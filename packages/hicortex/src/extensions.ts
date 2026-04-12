/**
 * Extension interfaces for the OSS/Pro split.
 *
 * The OSS client defines these interfaces and ships default implementations
 * (the current behaviour). Pro features (in src/pro/, never published) provide
 * alternative implementations that are loaded at runtime via dynamic import,
 * gated by the license check in features.ts.
 *
 * Why these specific interfaces:
 *
 *   LessonSelector — there are exactly 3 lesson selection sites in the OSS
 *     code (claude-md.ts:injectLessons, index.ts:before_agent_start,
 *     nightly.ts:injectLessonsFromServer). All three currently do
 *     `lessons.slice(0, maxLessons)` after a DB or HTTP fetch. The Pro
 *     selector ranks lessons against project context, recency, and
 *     effectiveness scores instead of dumb-truncating.
 *
 *   PromptStrategy — the current prompts.ts exports three pure functions
 *     (distillation, reflection, importanceScoring). The Pro variant has
 *     prescriptive prompts (`when X do Y` format) and re-trained reflection
 *     that produces a richer schema. The strategy bundles the prompt WITH
 *     its parser so a Pro prompt with a different output schema cannot
 *     silently fail when the OSS consumer parses it with the wrong shape.
 *
 * NOT in this file (deliberately deferred):
 *   - ContextAssembler — over-abstracted; the real seam is buildProjectContext
 *     in claude-md.ts, not the whole assembler. Will add when needed.
 *   - LessonValidator — speculative; no validation exists today. Will add
 *     when the first Pro use case demands it.
 */

// ---------------------------------------------------------------------------
// LessonSelector — picks which lessons to inject into agent context
// ---------------------------------------------------------------------------

/**
 * Minimum fields a lesson must have for the selector to work.
 *
 * The default selector only needs `content`. Pro selectors may need more
 * (project for in-project weighting, base_strength for ranking, etc.).
 *
 * Memory satisfies this interface (it's a structural subset), and the
 * client-mode HTTP shape `{content, created_at, base_strength, access_count}`
 * also satisfies it. The selector is generic over T so call sites get back
 * the same shape they passed in.
 */
export interface SelectableLesson {
  content: string;
  project?: string | null;
  created_at?: string;
  base_strength?: number;
  access_count?: number;
  id?: string;
  memory_type?: string;
}

export interface LessonSelectorContext {
  /** Maximum number of lessons to return. Caller decides this from features.lessonsLimit(). */
  maxLessons: number;
  /** Current project, if known. Pro selectors weight in-project lessons higher. */
  project?: string | null;
  /** Optional: agent id, for cross-agent learning context (Pro). */
  agentId?: string;
  /** Optional: current task description, for relevance scoring (Pro). */
  currentTask?: string;
}

export interface LessonSelector {
  /**
   * Pick `ctx.maxLessons` lessons from the candidate pool.
   * Default impl: take the first N (caller passes them in priority order).
   * Pro impl: rank by relevance to ctx.project / ctx.currentTask / effectiveness.
   *
   * Generic so the output type matches the input type — Memory[] in returns
   * Memory[] out, partial-shape in returns partial-shape out.
   */
  select<T extends SelectableLesson>(lessons: T[], ctx: LessonSelectorContext): T[] | Promise<T[]>;
}

/**
 * Default LessonSelector — preserves current OSS behaviour exactly.
 * `slice(0, maxLessons)` over the candidate pool, no re-ranking.
 */
export const defaultLessonSelector: LessonSelector = {
  select<T extends SelectableLesson>(lessons: T[], ctx: LessonSelectorContext): T[] {
    return lessons.slice(0, ctx.maxLessons);
  },
};

// ---------------------------------------------------------------------------
// PromptStrategy — bundles prompts with their parsers
// ---------------------------------------------------------------------------

/** Output schema produced by the reflection prompt and consumed by consolidate.ts. */
export interface ReflectionLesson {
  lesson: string;
  type: "reinforce" | "correct" | "principle" | string;
  project: string;
  severity: "critical" | "important" | "minor" | string;
  confidence: "high" | "medium" | "low" | string;
  source_pattern?: string;
}

export interface PromptStrategy {
  /** Build the distillation prompt (transcript → memories). */
  distillation(project: string, date: string, transcript: string): string;

  /** Build the reflection prompt (recent memories → lessons). */
  reflection(memoriesBlock: string, recentLessons?: string): string;

  /** Build the importance scoring prompt (batch of memories → scores). */
  importanceScoring(memoriesBlock: string): string;

  /**
   * Parse the LLM's reflection output. Bundled with the prompt so a Pro prompt
   * with a different output schema cannot silently fail downstream.
   */
  parseReflection(raw: string): ReflectionLesson[];

  /**
   * Parse the LLM's importance scoring output.
   * @param raw The LLM response
   * @param expectedCount The number of memories scored — used to pad/trim
   * @returns Array of scores (length === expectedCount), each in [0, 1]
   */
  parseImportanceScores(raw: string, expectedCount: number): number[];
}

// ---------------------------------------------------------------------------
// Default PromptStrategy — wraps the current prompts.ts and the lenient JSON
// parser from consolidate.ts. Preserves current OSS behaviour exactly.
// ---------------------------------------------------------------------------

import { distillation as distillationPrompt, reflection as reflectionPrompt, importanceScoring as importanceScoringPrompt } from "./prompts.js";

/**
 * Lenient JSON parser — tolerates markdown fences and indexed list formats.
 * Extracted from consolidate.ts to keep prompt+parser together.
 */
function parseJsonLenient<T>(text: string, fallback: T): T {
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
    // Fall through
  }

  // Handle "[0] 0.7\n[1] 0.6\n..." indexed format
  const indexed = [...text.matchAll(/\[\d+\]\s*([\d.]+)/g)];
  if (indexed.length > 0) {
    try {
      return indexed.map((m) => parseFloat(m[1])) as unknown as T;
    } catch {
      // Fall through
    }
  }

  return fallback;
}

export const defaultPromptStrategy: PromptStrategy = {
  distillation: distillationPrompt,
  reflection: reflectionPrompt,
  importanceScoring: importanceScoringPrompt,

  parseReflection(raw) {
    const parsed = parseJsonLenient<unknown[]>(raw, []);
    if (!Array.isArray(parsed)) return [];

    const out: ReflectionLesson[] = [];
    for (const item of parsed) {
      if (typeof item !== "object" || item === null) continue;
      const lo = item as Record<string, unknown>;
      const lessonText = String(lo.lesson ?? "");
      if (!lessonText) continue;

      out.push({
        lesson: lessonText,
        type: String(lo.type ?? "principle"),
        project: String(lo.project ?? "global"),
        severity: String(lo.severity ?? "important"),
        confidence: String(lo.confidence ?? "medium"),
        source_pattern: lo.source_pattern ? String(lo.source_pattern) : undefined,
      });
    }
    return out;
  },

  parseImportanceScores(raw, expectedCount) {
    let scores = parseJsonLenient<number[] | null>(raw, null);
    if (!Array.isArray(scores)) {
      scores = new Array(expectedCount).fill(0.5);
    }
    while (scores.length < expectedCount) scores.push(0.5);
    scores = scores.slice(0, expectedCount);
    return scores.map((s) => {
      const v = Number(s);
      if (isNaN(v)) return 0.5;
      return Math.max(0, Math.min(1, v));
    });
  },
};

// ---------------------------------------------------------------------------
// Loader — used by call sites to get either the OSS default or a Pro override
// ---------------------------------------------------------------------------

/**
 * Holder for the active extension implementations. The OSS client always uses
 * the defaults; Pro features (in src/pro/, loaded via dynamic import) replace
 * these at boot if a valid license is present.
 *
 * Wiring will happen via setExtensions() called from src/pro/ after license
 * validation (not yet implemented in OSS). Until Pro code exists and is loaded,
 * every call site uses the defaults — zero behavioural change for OSS users.
 */
let activeExtensions: { selector: LessonSelector; prompts: PromptStrategy } = {
  selector: defaultLessonSelector,
  prompts: defaultPromptStrategy,
};

/** Replace the active extensions (called from features.ts when Pro loads). */
export function setExtensions(ext: Partial<typeof activeExtensions>): void {
  activeExtensions = { ...activeExtensions, ...ext };
}

/** Get the active LessonSelector (default unless Pro is loaded). */
export function getLessonSelector(): LessonSelector {
  return activeExtensions.selector;
}

/** Get the active PromptStrategy (default unless Pro is loaded). */
export function getPromptStrategy(): PromptStrategy {
  return activeExtensions.prompts;
}

// ---------------------------------------------------------------------------
// Pro package activation contract
// ---------------------------------------------------------------------------

/**
 * The object passed to a Pro package's `activate()` function at boot.
 * Pro packages receive this to register their extensions and access OSS
 * runtime APIs they need.
 *
 * Design rationale: Pro code never STATICALLY imports from the OSS client.
 * All runtime access is through this context object. This has two benefits:
 *   1. Pro bundles are self-contained — they don't have `require("../...")`
 *      calls that would break when the tarball is installed to
 *      ~/.hicortex/pro/ at runtime.
 *   2. Pro code can only access what the OSS client exposes here, so the
 *      blast radius of a malicious/buggy Pro release is contained.
 *
 * Type-only imports of `LessonSelector`, `PromptStrategy` etc. in Pro code
 * are fine — they're erased at compile time and produce no runtime imports.
 */
export interface ProActivationContext {
  /** Register a lesson selector implementation. */
  setSelector(selector: LessonSelector): void;
  /** Register a prompt strategy implementation. */
  setPrompts(prompts: PromptStrategy): void;
  /** The version of the OSS host (from package.json). Pro can use this
   *  to gate features against host compatibility. */
  hostVersion: string;
  /** Log through the OSS logging surface so Pro logs get the [hicortex]
   *  prefix and unified formatting. */
  log(message: string): void;
}

/**
 * The shape Pro packages must export as their default export.
 * See `packages/hicortex/src/pro/index.ts` for the reference impl.
 */
export interface ProPackage {
  /** Called once at OSS boot if a Pro license is valid and the Pro
   *  tarball has been downloaded + extracted. Should register extensions
   *  via the context and return. Errors abort Pro activation but do not
   *  abort the OSS host. */
  activate(ctx: ProActivationContext): void | Promise<void>;
}

/**
 * Build an activation context for a Pro package. Called from the Pro
 * loader in features.ts / pro-loader.ts.
 *
 * Keep this function small — it's the ONLY surface a Pro package gets.
 * Expanding it expands the attack surface, so add fields deliberately.
 */
export function createProActivationContext(hostVersion: string): ProActivationContext {
  return {
    setSelector(selector) {
      activeExtensions = { ...activeExtensions, selector };
    },
    setPrompts(prompts) {
      activeExtensions = { ...activeExtensions, prompts };
    },
    hostVersion,
    log(message) {
      console.log(`[hicortex][pro] ${message}`);
    },
  };
}
