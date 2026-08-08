/**
 * LLM prompt templates for memory consolidation and distillation.
 * Copied EXACTLY from the Python codebase (proven working prompts).
 *
 * SHIPPED SOURCE: this file is compiled into dist/ and published to npm + the
 * public mirror (it is NOT in .publicignore). Any example, name, or detail in
 * these prompts is therefore public. Use generic, anonymous examples — never
 * real internal project/tool/host names or real incident specifics. The
 * infra-name denylist cannot catch conceptual leaks, only known names.
 */

/**
 * Importance scoring prompt. Takes a {memories_block} with indexed memories.
 */
export function importanceScoring(memoriesBlock: string): string {
  return `You are a memory importance scorer. Rate each memory's long-term value.

Score each memory from 0.0 (trivial/ephemeral) to 1.0 (critical/foundational).

Scoring guide:
- 0.0-0.2: Routine actions, transient state, trivial fixes
- 0.3-0.5: Useful context, minor decisions, standard patterns
- 0.6-0.8: Important decisions, debugging breakthroughs, architectural choices
- 0.9-1.0: Foundational principles, critical constraints, core identity facts

MEMORIES:
${memoriesBlock}

Respond with ONLY a JSON array of scores in the same order, e.g.:
[0.3, 0.7, 0.5, 0.9]

No explanations. Just the JSON array.`;
}

/**
 * Reflection prompt. Takes a {memories_block} with today's memories.
 */
export function reflection(memoriesBlock: string, recentLessons?: string): string {
  const recentSection = recentLessons
    ? `\nRECENT LESSONS (already generated — do NOT duplicate, but DO escalate if patterns recur):\n${recentLessons}\n`
    : "";

  return `You are a learning analyst for a multi-agent AI system. Review today's memories and extract actionable lessons from BOTH successes and failures.

Like human learning: we grow fastest when we reinforce what works AND correct what doesn't. A system that only learns from mistakes becomes overly cautious. A system that only learns from successes never improves. The combination multiplies.

GENERALITY BAR (read carefully — the most important rule):
Every lesson MUST be a generalizable operating principle that transfers across contexts, agents, and projects. It is NOT: an incident report, a changelog entry, a one-event fact, a tool-specific recipe, or a note about a named entity. If a memory is only interesting as "what happened today", it is an EPISODE — do not emit a lesson for it. Abstract away specific tool names, hostnames, and incident details from the lesson text; state the transferable rule.

Quality over quantity. 1-3 lessons is typical. An empty array [] is the CORRECT response when memories show routine competent work without noteworthy patterns, surprises, or friction. Do not manufacture lessons from nothing.

LESSON TYPES:
- "reinforce": An approach or strategy that worked well — repeat and spread it
- "correct": A mistake, gap, or near-miss that should be avoided
- "principle": A general insight derived from either success or failure
${recentSection}
TODAY'S MEMORIES:
${memoriesBlock}

EXAMPLES:
Good reinforce: "Bundling related changes into a single PR with clear narrative gets faster approval — apply for all refactors"
Good reinforce: "When presenting multi-scenario analysis, show assumptions side-by-side so stakeholders evaluate trade-offs rather than reacting to isolated worst-cases"
Good correct: "Always verify ALL substitution targets by diffing output — partial fixes cause silent failures"
Good principle: "Gather evidence from logs before forming hypotheses — evidence-first debugging resolved issues 3x faster today"
Good principle: "When a long-running background agent survives a system migration as an orphan, explicitly unregister it before declaring the migration clean — orphans cause silent crash-loops"
Bad lesson: "The deploy script had a bug" (restatement, not actionable)
Bad (incident note / changelog entry): "The graph resolver was fixed by adding a computed-at marker column" — that is a changelog entry, not a lesson
Bad (tool-specific decision): "Tool X is banned because it broke Tool Y's settings" — a one-tool decision, not transferable
Bad (single-event): "The chat client crashed after a system restore because a background agent was left orphaned" — an incident report, not a principle

For each lesson, output a JSON object:
- "lesson": Concise, actionable rule in imperative voice. State the transferable rule — abstract away specific tool names, hostnames, and incident details.
- "type": "reinforce" | "correct" | "principle"
- "project": "global" unless genuinely project-specific (project-specific lessons are still valuable)
- "severity": "critical" | "important" | "minor"
- "confidence": "high" | "medium" | "low"
- "source_pattern": What triggered this (1 sentence, no personal data; may name the specific incident/tool here — but the \`lesson\` field itself stays generic)

Severity guide:
- "critical": Near-misses that could have caused data loss or security breach, even if caught in time. Also: recurring patterns that keep appearing despite prior corrections.
- "important": Clear cause-effect, likely to recur. Worth sharing across agents.
- "minor": Useful optimization, single incident.

Confidence guide:
- "high": Pattern across multiple events, or clear cause-effect. Safe to auto-inject into agent instructions.
- "medium": Single incident but likely to recur. Store but don't auto-propagate.
- "low": Speculative. Store for retrieval only.

Focus on:
- SUCCESSES: effective strategies, approaches the user validated, patterns that saved time, clean solutions
- FAILURES: process gaps, repeated friction, silent failures, user corrections
- OMISSIONS: things that should have been done but weren't (missing tests, unchecked code paths, forgotten follow-ups)
- NEAR-MISSES: problems caught before damage — these deserve critical severity
- CONTRADICTIONS: cases where something appeared to work but didn't, or agents reached opposite conclusions
- CROSS-AGENT PATTERNS: same issue or success across different agents — especially high-value
- PROCESS FEEDBACK: user feedback about the agent's approach/behavior, not just its output

Privacy: Never include personal data (names, health, finances, credentials) in lesson text. Abstract to the process level.

Skip: isolated trivial actions, already-documented rules, incident notes, changelog entries, and tool-specific recipes. However, if multiple small successes form a consistent pattern of quality, extract that pattern as a reinforcement.

Respond with a JSON array. Empty array [] is a valid response.`;
}

/**
 * Distillation prompt. Extracts knowledge from a session transcript.
 */
export function distillation(
  projectName: string,
  date: string,
  transcript: string
): string {
  return `You are a memory extraction agent. Analyze this AI session transcript and extract
knowledge worth remembering long-term.

SESSION TRANSCRIPT (project: ${projectName}, date: ${date}):
${transcript}

EXTRACT into this markdown format:

# Session Memory: ${date} - ${projectName}

### Decisions Made
- [SUBJECT]: [decision] — [reasoning] (${date})

### Facts Learned
- [SUBJECT]: [fact] — [context/source] (${date})

### Problems & Solutions
- [SUBJECT]: [problem] → [solution that worked] (${date})

### Project State Changes
- [SUBJECT]: [what changed], [from → to] (${date})

### Key Entities & Relationships
- [entity A] → [relationship] → [entity B] (${date})

### Corrections & Rejections
- [SUBJECT]: [what AI proposed] → [why rejected/corrected] → [what user wanted instead] (${date})
  (Include: tool use denials, "no/wrong/redo", style feedback, approach rejections,
   user corrections of AI assumptions, quality complaints like "too verbose")

TOPIC-FIRST RULE (critical — read carefully):
Every item MUST begin with its [SUBJECT]: the concrete thing it is about — the
system, file, component, decision area, or entity. The subject is what a future
reader would search for.
- Write:  "Electrical load calculation: don't bundle unknown loads into one figure — user rejected the estimate"
- NOT:    "User rejected AI's bundling of unknown loads"
- Write:  "Nightly capture (Hermes): cron sessions are excluded — source='cron' is skipped before distillation"
- NOT:    "Discovered that cron sessions are filtered out"
Reason: each item's first words become the memory's one-line index entry AND
dominate its search embedding. An item that opens with a category label, a
sentiment ("Strong Negative"), or "User rejected…" is unfindable — it matches
every emotionally-similar prompt and no topically-relevant one. Front-load the
subject; put reaction, intensity and reasoning AFTER it.

RULES:
- Extract MAX 20 items total (quality over quantity)
- Each must be useful if recalled in a future session
- Skip: routine code edits, standard tool usage, trivial fixes
- Include: architectural decisions, debugging breakthroughs, user preferences,
  tool configurations, API discoveries, project milestones
- PRIORITIZE Corrections & Rejections — these are high-value signals for learning
  what the user does NOT want. Even a single "no" or style correction is worth extracting.
- Strong language or profanity from the user is a high-intensity signal — it indicates
  the correction matters deeply. Note the intensity AFTER the subject, never before it
  (e.g. "Pricing tiers: strongly rejected per-agent billing — …", not
  "[Strong Negative] User rejected per-agent billing"). The subject always comes first.
- Omit any section that has zero items (don't include empty sections)
- If nothing worth extracting, output ONLY: "NO_EXTRACT"
`;
}

/**
 * Domain curation prompt. Groups projects into knowledge domains.
 * Used during consolidation (Pro only, one call per nightly when projects change).
 */
export function domainCuration(projectLines: string): string {
  return `You are a knowledge organizer. Given project names with memory and lesson counts, group them into logical knowledge DOMAINS (3-8 domains).

PROJECTS (name: memories / lessons):
${projectLines}

For each domain, output a JSON object:
- "name": Short domain label (2-4 words, Title Case)
- "projects": Array of project names belonging to this domain
- "keywords": 3-5 representative keywords for this domain

Rules:
- Every project must appear in exactly one domain
- Projects with only 1-2 memories can go in a "Miscellaneous" domain
- Prefer fewer domains over many tiny ones
- Domain names should be descriptive and distinct

Respond with ONLY a JSON array. No explanations.`;
}

// edgeClassification prompt REMOVED (2026-07). LLM edge classification is
// retired: the 672-link audit found the LLM-classified UPPERCASE relationship
// types near-useless (CONTRADICTS 4% acceptable). Linking is now heuristic-only
// (extends/relates_to) in consolidate.ts. A classification prompt may return
// only when a future classifier passes the audit harness at >= 70% acceptable.
