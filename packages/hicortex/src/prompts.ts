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
Every lesson MUST be a generalizable operating principle that transfers across contexts, agents, and projects. It is NOT: an incident report, a changelog entry, a one-event fact, a tool-specific recipe, or a note about a named entity. If a memory is only interesting as "what happened today", it is an EXPERIENCE — do not emit a lesson for it. Abstract away specific tool names, hostnames, and incident details from the lesson text; state the transferable rule.

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
 *
 * LAYOUT (REVERTED 2026-08-24): transcript BEFORE the static instruction
 * block — the pre-0.19.4 order. The #329 item-6 reorder (static-first, for
 * provider prefix caching) was REVERTED after a deterministic A/B on real
 * segments: with instructions first, the model over-fires NO_EXTRACT on
 * summary-led and long mixed sessions (a real coding segment: 15 memories →
 * 0; a real Hermes session: rich → 0; isolation proved the LAYOUT caused it,
 * not the item-5 sentence, which is KEPT). Silent shape-dependent segment
 * loss beats any caching win. Re-attempting instructions-first requires a
 * gate fix that passes the A/B matrix harness first.
 *
 * #339 gate hardening (same day): the NO_EXTRACT rule now carries an explicit
 * whole-transcript guard + counter-example (a summary-led session that
 * contains later decisions MUST be extracted) — the over-firing mechanism was
 * the model pattern-matching a bookkeeping-heavy OPENING to the ephemera gate
 * and abandoning the whole segment. Companion visibility net (warning on
 * large empty results) lives in distiller.ts; the release-gate harness is
 * scripts/distill-ab-check/.
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
- [D] [SUBJECT]: [decision] — [reasoning] (${date})
  (ONLY decisions the user explicitly made or confirmed — never an AI proposal)

### Knowledge Learned
- [K] [SUBJECT]: [knowledge] — [context/source] (${date})

### Problems & Solutions
- [E] [SUBJECT]: [problem] → [solution that worked] (${date})

### Project State Changes
- [D] [SUBJECT]: [what changed], [from → to] (${date})
  (Durable shifts only — the model/tool/approach the project now uses. A
   status flip or counter change is NEVER-RECORD ephemera, not a state change)

### Key Entities & Relationships
- [K] [entity A] → [relationship] → [entity B] (${date})

### Corrections & Rejections
- [E] [SUBJECT]: [what AI proposed] → [why rejected/corrected] → [what user wanted instead] (${date})
  (Include: tool use denials, "no/wrong/redo", style feedback, approach rejections,
   user corrections of AI assumptions, quality complaints like "too verbose")

TYPE TAG (critical — prefix EVERY bullet with exactly one letter + space):
- [E] EXPERIENCE — a specific event, interaction, or narrative: "tried X, failed
  because Y", a correction, a debugging session, a one-time occurrence. The
  DEFAULT when in doubt.
- [K] KNOWLEDGE — a durable truth that will hold across sessions: "the API is at
  :8787", "uv is used for packages", "config lives in ~/.hicortex/". Not tied
  to a single moment.
- [D] DECISIONS — a choice the USER explicitly made or confirmed in the
  transcript: they said "do X / agreed / ok / go ahead", approved the plan, or
  the transcript shows the change actually being carried out. It must be a
  choice future work builds on and that a later decision can SUPERSEDE:
  "switched from gemma4 to qwen3.5", "adopted the graded-schema tag model".
  Not knowledge (it can change) and not experience (it persists and constrains).
- An AI recommendation or proposal is NEVER a decision, however detailed or
  well-reasoned — even if the user seemed receptive. If the user declined,
  deferred ("hold", "later", "wait for X"), or did not answer: record it as
  [E] EXPERIENCE with proposal framing ("AI proposed X → user declined/held
  because Y"), or under Corrections & Rejections.
- SELF-CHECK: if an item's text says "AI recommended/proposed" or the user
  "has not (yet) confirmed" it, that item is NOT [D] — re-tag it [E].
- NEVER use [L] (learnings). Learnings are extracted by a SEPARATE reflection stage,
  not here. If the model emits [L], it is wrong — re-tag as experience/knowledge/decisions.
The type tag goes BEFORE the subject, never as a section/category bracket.

TOPIC-FIRST RULE (critical — read carefully):
Every item MUST begin with its [SUBJECT] (right after the type tag): the
concrete thing it is about — the system, file, component, decision area, or
entity. The subject is what a future reader would search for.
- Write:  "[E] Electrical load calculation: don't bundle unknown loads into one figure — user rejected the estimate"
- NOT:    "[E] User rejected AI's bundling of unknown loads"
- Write:  "[K] Nightly capture (Hermes): cron sessions are excluded — source='cron' is skipped before distillation"
- NOT:    "[K] Discovered that cron sessions are filtered out"
- Write:  "[E] Qwen3.8-27B swap: AI proposed switching → user held on Qwen3.6-35B-A3B until an MoE variant ships"
- NOT:    "[D] Qwen3.8-27B: switch from Qwen3.6-27B — drop-in upgrade"
Reason: each item's first words (after the type tag) become the memory's one-line
index entry AND dominate its search embedding. An item that opens with a category
label, a sentiment ("Strong Negative"), or "User rejected…" is unfindable — it
matches every emotionally-similar prompt and no topically-relevant one. Front-load
the subject; put reaction, intensity and reasoning AFTER it.

NEVER-RECORD — ephemera gate (critical):
Every candidate must pass one test: will it still be TRUE and still MATTER in 3 months?
Content whose entire value is a state that expires is NEVER recorded —
do not score it lower and write it anyway: OMIT it. A closed category of never-record ephemera:
- issue/PR/epic/merge status: "PR #173 merged", "Epic 2 CLOSED — all children merged"
- version/deploy/test-count statistics: "v0.16.0 deployed to rc dist-tag",
  "Test suite grew 616→749", "Main branch updated to <sha>"
- session bookkeeping/outcomes: "Session closure: nothing remains to do",
  todo deferrals ("parked until next week"), sync/replay states
- transient readings/snapshots: "disk usage snapshot: 84% at 14:20",
  "uptime counter passed 40 days"
The durable part of the same event may still qualify — the CHOICE a change
embodies ("standardize on model X", user-confirmed) is [D], a configuration
that holds going forward is [K]; the version bump, merge, or count itself never is.
Override for the [D] "actually carried out" test: even if carried out by the
user, a version bump, merge, or count is NEVER [D] — only the durable
user-confirmed standardization it embodies qualifies.
If EVERY item in the transcript is never-record ephemera, output ONLY:
"NO_EXTRACT" — zero memories is the correct result for a pure-status segment.

NO_EXTRACT guard (a verdict on the WHOLE transcript, never on its opening):
"NO_EXTRACT" requires that NO durable decision, knowledge, or correction
appears ANYWHERE in the transcript — including after long bookkeeping
stretches. The opening is not evidence about the rest: real sessions often
OPEN with bookkeeping (a compaction summary, a task notification, a status
recap) and CONTAIN extractable material later. Read to the END of the
transcript before deciding; NO_EXTRACT on a long, mixed session is almost
always a mistake — when in doubt, extract the durable items.
Counter-example (MUST be extracted, never NO_EXTRACT): a session opens with
"Session summary: continuing the API migration; prior PR merged, tests
green" but later the user confirms "standardize on the queue-based worker —
make it the documented default" and corrects the assistant: "no, don't gate
retries behind a flag — remove the flag entirely". That session yields at
least a [D] standardization and an [E] correction; the summary opening
changes nothing. Emitting NO_EXTRACT there would lose the only record of
both.

RULES:
- Extract MAX 20 items total (quality over quantity)
- Use EXACT names/versions/paths/numbers as they appear in the transcript —
  never substitute what seems current or more standard (writing "Qwen3.6-27B"
  when the transcript says "Qwen3.6-35B-A3B" is a fabrication)
- Each must be useful if recalled in a future session
- Skip: routine code edits, standard tool usage, trivial fixes
- Include: architectural decisions, debugging breakthroughs, user preferences,
  tool configurations, API discoveries, durable project milestones (a status
  flip — shipped/merged/closed — is NEVER-RECORD ephemera, not a milestone)
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
