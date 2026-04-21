/**
 * LLM prompt templates for memory consolidation and distillation.
 * Copied EXACTLY from the Python codebase (proven working prompts).
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
Bad lesson: "The deploy script had a bug" (restatement, not actionable)

For each lesson, output a JSON object:
- "lesson": Concise, actionable rule in imperative voice
- "type": "reinforce" | "correct" | "principle"
- "project": "global" unless genuinely project-specific (project-specific lessons are still valuable)
- "severity": "critical" | "important" | "minor"
- "confidence": "high" | "medium" | "low"
- "source_pattern": What triggered this (1 sentence, no personal data)

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

Skip: isolated trivial actions, already-documented rules. However, if multiple small successes form a consistent pattern of quality, extract that pattern as a reinforcement.

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

## Classification: [pick one: PUBLIC / WORK / PERSONAL / SENSITIVE]

### Decisions Made
- [decision]: [reasoning] (${date})

### Facts Learned
- [fact]: [context/source] (${date})

### Problems & Solutions
- [problem] → [solution that worked] (${date})

### Project State Changes
- [what changed]: [from → to] (${date})

### Key Entities & Relationships
- [entity A] → [relationship] → [entity B] (${date})

### Corrections & Rejections
- [what AI proposed] → [why rejected/corrected] → [what user wanted instead] (${date})
  (Include: tool use denials, "no/wrong/redo", style feedback, approach rejections,
   user corrections of AI assumptions, quality complaints like "too verbose")

RULES:
- Extract MAX 20 items total (quality over quantity)
- Each must be useful if recalled in a future session
- Skip: routine code edits, standard tool usage, trivial fixes
- Include: architectural decisions, debugging breakthroughs, user preferences,
  tool configurations, API discoveries, project milestones
- PRIORITIZE Corrections & Rejections — these are high-value signals for learning
  what the user does NOT want. Even a single "no" or style correction is worth extracting.
- Strong language or profanity from the user is a high-intensity signal — it indicates
  the correction matters deeply. Note the intensity in the extraction.
- PRIVACY CLASSIFICATION (one of):
  - PUBLIC: general tech knowledge, open-source patterns, publicly available info
  - WORK: project-specific decisions, architecture choices, client/business context
  - PERSONAL: personal preferences, family, health, lifestyle, private life
  - SENSITIVE: API keys mentioned, credentials, financial account details, medical records
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

/**
 * Edge classification prompt. Presents memory pairs and asks the LLM to
 * choose the most specific relationship type for each.
 */
export function edgeClassification(pairsBlock: string): string {
  return `You are a memory graph analyst. Classify the relationship between each memory pair.

VALID RELATIONSHIP TYPES:
- derives: A lesson or fact was derived from episodes (lesson ← episode)
- updates: A newer memory updates/replaces an older one on the same topic
- extends: Memory adds detail to another within the same project
- relates_to: Generic association (use ONLY when no specific type fits)
- CONTRADICTS: Memories give opposite advice or conflicting information
- SUPERSEDES: One memory fully replaces another (stronger than "updates")
- DEPENDS_ON: One memory's validity requires the other (prerequisite)
- CAUSED_BY: One event/decision directly caused the other
- VALIDATES: One memory confirms or provides evidence for the other

Choose the MOST SPECIFIC type. Prefer specific types over "relates_to".

MEMORY PAIRS:
${pairsBlock}

Respond with ONLY a JSON array of relationship type strings, one per pair, in order.
Example for 3 pairs: ["CAUSED_BY", "extends", "VALIDATES"]

No explanations. Just the JSON array.`;
}
