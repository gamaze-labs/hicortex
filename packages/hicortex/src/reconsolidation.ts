/**
 * Reconsolidation (#384, #392) — the store resolves its own corrections, and
 * THE unified resolution stage.
 *
 * Nightly consolidation stage (runs as Stage 3.8, after supersession, before
 * decay/prune) that detects memories which correct, retract, supersede, or
 * DUPLICATE older ones; REWRITES corrected facts in place (absorbing
 * transition-only trigger memories), MERGES confirmed duplicates via the
 * dedup core (absorbing the loser), and marks everything else. Companions to
 * the stage:
 *  - explicit write-time marking (`corrects`/`supersedes` at /ingest +
 *    `hicortex_ingest`) — deterministic link + status, zero LLM;
 *  - `memory_history` audit + the `hicortex history` CLI (listing + rollback).
 *
 * #392 — one zone system, ONE verdict per pair: below `correctionMinSimilarity`
 * (floor, 0.75) pairs are not candidates; in [floor, `dedupAutoMergeThreshold`)
 * (ceiling, 0.92) each unlinked pair gets ONE verdict call whose action is
 * `merge` | `corrects` | `supersedes` | `conflicts` | `none`; at/above the
 * ceiling the deterministic merge zone (dedup.ts runDeterministicMergeZone —
 * LLM-free, budget-free) owns the pair. The merge disposition reuses the
 * dedup core's execution (canonical pick, link re-point, dedup_log, metadata
 * rails); a merge verdict below `correctionRewriteMinConfidence` keeps both
 * memories.
 *
 * #393 increment B — the SCOUT, a second detection source with the SAME
 * judge: the similarity floor is structurally blind to corrections riding
 * inside topically unrelated memories (the field failure — cosine ~0.5-0.6 to
 * their target, zero `corrects` verdicts in the whole corpus baseline), so
 * per NEW memory ONE classify-tier shape call asks whether it corrects/
 * retracts/supersedes/CONTRADICTS something previously recorded (guard-C
 * extended the question); correction-shaped
 * memories FTS the corpus with the referenced claim's distinctive terms (the
 * correction CONTAINS the words of what it corrects) and the hits become
 * candidate pairs in the SAME verdict loop — no similarity gate for this
 * source: cosine is a ranker/link strength, never a blocker. Per-source
 * counters (scout_scanned / scout_correction_shaped / scout_candidates_found)
 * ride the stage report; cosine band stats stay similarity-source-only.
 *
 * #393 guard-C — the conflicts flag + the zone-runs-last order: judgment
 * OUTRANKS the deterministic sweep. A `conflicts` verdict writes a symmetric
 * `conflicts` link (the pair genuinely disagrees — cannot both be true) and
 * NOTHING else: no status change, no rewrite, no merge queue; both records
 * stay live so the consumer sees both truths. Both merge paths (the zone's
 * planDedup and the judged mergeMemoryIds) refuse to blend a conflicts-linked
 * pair, counted as conflict_skipped. The zone therefore runs AFTER the scan —
 * with the zone first, a >=0.92 conflict pair was blended
 * before the judge ever saw it (the planted-eval harm: canonical=older, the
 * newer truth erased); running it last means verdicts/marks/binds land first
 * and the zone merges only what no verdict claimed — a conflicts bind set by
 * this run's scan guards the SAME run's zone.
 *
 * #439 apply-on-confirm — confirmed merges and rewrite groups apply at the
 * candidate BOUNDARY (the end of the scan iteration that confirmed them), not
 * in post-scan phases. The old end-of-run batch was a completion assumption
 * written when nightlies finished in an hour; under #405 budget pressure it
 * became a days-long queue where confirmed work never landed and every night
 * re-paid the judgment cost (cursor held below un-applied groups, pairs
 * re-detected, re-judged). Now each judged-merge pair applies via
 * mergeMemoryIds in its OWN transaction at confirmation time, each rewrite
 * group via its own rewrite call + applyRewriteGroup transaction; the cursor
 * advances per APPLIED candidate, so a deferral holds it below exactly ONE
 * candidate's pairs. One pre-merge backup per run (lazy, before the first
 * application); the capture lock is taken per boundary batch with a same-run
 * retry list + a final drain. A shared trigger IS the current candidate, so
 * the multi-target keep rule resolves across the boundary's groups (any keep
 * keeps). A target corrected by two different candidates takes two sequential
 * rewrites — the second composes the already-corrected story — instead of one
 * grouped call (the ONE-call grouping was a cost optimization, not a
 * correctness invariant; accepted semantics change).
 *
 * Status vocabulary (code-defined, extensible — deliberately NOT config):
 *   NULL/'active' default | 'superseded' + 'retracted' demote in ranking |
 *   'corrected' = rewritten, never demotes (demoting it would bury the
 *   correction — the exact failure this stage fixes) | 'absorbed' = invisible
 *   to recall (no vector row, no FTS row; plain row + link kept as evidence,
 *   session lineage, rollback reference). Merge losers share 'absorbed'
 *   (storage.absorbMemory is the one primitive) — the only difference is the
 *   audit trail: rewrites roll back via memory_history; merges recover via
 *   dedup_log + the retained loser row (NOT history-rollback-able).
 *
 * This module deliberately does NOT import consolidate.ts (which imports this
 * module to wire the stage) — the budget is consumed through the structural
 * StageBudget interface below, which BudgetTracker satisfies. dedup.ts is
 * imported (never the reverse) for the merge core.
 */

import type Database from "better-sqlite3";
import type { LlmClient, LlmUsage } from "./llm.js";
import type { Memory, ConsolidationReport, ResolutionBandStat } from "./types.js";
import type { EmbedFn } from "./retrieval.js";
import { l2ToCosine, cosineBetweenVectors } from "./retrieval.js";
import * as storage from "./storage.js";
import { loadState, updateState } from "./state.js";
import { resolveDbPath, initDb } from "./db.js";
import { acquireCaptureLock } from "./capture.js";
import * as CALIBRATION from "./calibration.js";
import { hicortexHome } from "./paths.js";
import {
  runDeterministicMergeZone,
  mergeMemoryIds,
  takePreDedupBackup,
  DEFAULT_DEDUP_MERGE_THRESHOLD,
} from "./dedup.js";
import type { RunDeadline } from "./run-deadline.js";

// ---------------------------------------------------------------------------
// Constants + status vocabulary
// ---------------------------------------------------------------------------

/** Stage label used for every budget.use()/recordUsage() call (#384). */
export const RECONSOLIDATION_STAGE_LABEL = "reconsolidation";

/**
 * Default minimum COSINE similarity for a correction candidate pair —
 * RELEASE-MANAGED since #408 (calibration.ts CORRECTION_MIN_SIMILARITY;
 * provenance there). Lower than the supersession stage's 0.80 on purpose: a
 * retraction often rides inside an otherwise unrelated memory (the field
 * failure that opened this issue), so the neighborhood gate must be a touch
 * wider while the LLM verdict + confidence gate carry the precision load.
 */
export const DEFAULT_CORRECTION_MIN_SIMILARITY = CALIBRATION.CORRECTION_MIN_SIMILARITY;

/**
 * Default minimum verdict confidence for the REWRITE fork — release-managed
 * (calibration.ts CORRECTION_REWRITE_MIN_CONFIDENCE). Below this a
 * `corrects` verdict degrades to mark-only — a weak mark is recoverable, a
 * weak rewrite is corruption.
 */
export const DEFAULT_CORRECTION_REWRITE_MIN_CONFIDENCE = CALIBRATION.CORRECTION_REWRITE_MIN_CONFIDENCE;

/** Neighbor pool size before older/similarity filtering narrows to top 5 (supersession mirror). */
const CORRECTION_NEIGHBOR_POOL = 15;
/** Older-neighbor pairs kept per candidate after filtering (supersession mirror). */
const CORRECTION_NEIGHBOR_TOP_K = 5;
/** Content truncation for prompts (classify-tier cost profile; supersession precedent). */
const PROMPT_TRUNCATE_CHARS = 1500;
/** Head of the old content quoted in the provenance footer. */
export const FOOTER_HEAD_MAX_CHARS = 160;
/** Base slack allowed on a rewrite beyond the old content length (AC4). */
const REWRITE_BASE_SLACK_CHARS = 2000;
/** Additional slack per trigger beyond the first (AC4). */
const REWRITE_PER_TRIGGER_SLACK_CHARS = 500;

/** The code-defined status vocabulary (see module doc). Not user-configurable. */
export type MemoryStatus = "superseded" | "retracted" | "corrected" | "absorbed";

/**
 * Statuses that demote a memory's ranking score (retrieval.ts findDemotedIds).
 * 'corrected' is deliberately absent — see module doc.
 */
export const DEMOTED_STATUSES: readonly [MemoryStatus, MemoryStatus] = ["superseded", "retracted"];

/** structural subset of consolidate.BudgetTracker (avoids an import cycle). */
export interface StageBudget {
  readonly exhausted: boolean;
  use(stage: string): boolean;
  recordUsage(stage: string, usage: LlmUsage | undefined): void;
}

export interface ReconsolidationOptions {
  /** Correction-pair cosine floor. Release-managed default (calibration.ts
   *  CORRECTION_MIN_SIMILARITY, 0.75); this field is the eval/test seam.
   *  Invalid → default. */
  minSimilarity?: number;
  /** Rewrite-fork confidence floor. Release-managed default (calibration.ts
   *  CORRECTION_REWRITE_MIN_CONFIDENCE, 0.80); seam only. Invalid → default. */
  rewriteMinConfidence?: number;
  /**
   * The deterministic/LLM boundary of the unified resolution pass (#392):
   * pairs at/above it merge via the LLM-free zone, pairs in [floor, ceiling)
   * get the verdict. Release-managed default (calibration.ts
   * DEDUP_AUTO_MERGE_THRESHOLD, 0.92); seam only. Invalid → default.
   */
  autoMergeThreshold?: number;
  /**
   * The run-wide pipeline deadline (#405 — successor of the stage-local
   * reconsolidationMaxMinutes clock, #401): created at nightly start, shared
   * with capture and every other stage, threaded here by runConsolidation.
   * Checked at the top of the candidate scan loop and before each rewrite
   * contract call; on expiry the scan breaks cleanly — the cursor already
   * points at the last fully-considered candidate, so the run ends
   * consistent and the next nightly resumes from it.
   */
  deadline?: RunDeadline;
  /**
   * Capture-lock acquirer override (tests) — the deterministic zone and each
   * #439 boundary's judged-merge batch hold a short lock window. Defaults to
   * the real capture.ts lock. DedupOptions.acquireLock pattern.
   */
  acquireLock?: typeof acquireCaptureLock;
}

/** The stage report (typed once, in ConsolidationReport — field list there). */
export type ReconsolidationStageResult = NonNullable<
  ConsolidationReport["stages"]["reconsolidation"]
>;

// ---------------------------------------------------------------------------
// Shape + link helpers
// ---------------------------------------------------------------------------

/**
 * True when a memory is REWRITE-ELIGIBLE — a fact-shaped target. The fork is
 * keyed on the existing taxonomy the code already trusts (facts are
 * rewritten; decisions/plans/experiences are history, marked only).
 */
export function isFactShapedTarget(mem: { memory_type: string; content: string }): boolean {
  return mem.memory_type === "knowledge" || mem.content.includes("[Facts Learned]");
}

/** True when a superseded_by / corrected_by / conflicts link already exists between the pair, either direction. */
function alreadyResolutionLinked(db: Database.Database, oldId: string, newId: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM memory_links WHERE relationship IN ('superseded_by', 'corrected_by', 'conflicts')
       AND ((source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?))`,
    )
    .get(oldId, newId, newId, oldId);
  return !!row;
}

/** True when a link with exactly this relationship exists on the ordered pair. */
function hasLink(db: Database.Database, sourceId: string, targetId: string, relationship: string): boolean {
  return !!db
    .prepare("SELECT 1 FROM memory_links WHERE source_id = ? AND target_id = ? AND relationship = ?")
    .get(sourceId, targetId, relationship);
}

function nowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Verdict contract (per pair) — {"action","confidence"} (#392: four actions)
// ---------------------------------------------------------------------------

/**
 * The unified resolution verdict (#392, #393 guard-C): ONE call per unlinked
 * pair decides how the newer memory relates to the older — merge (same
 * underlying fact/verdict, differing in wording/qualifiers), corrects,
 * supersedes, conflicts (genuine disagreement — cannot both be true; flag,
 * keep both, never blend), or none (related but distinct).
 */
export type ResolutionAction = "merge" | "corrects" | "supersedes" | "conflicts" | "none";

// ---------------------------------------------------------------------------
// Scout shape contract (per NEW memory) — {"correction","references","confidence"}
// (#393 increment B — the reference-extraction detection source)
// ---------------------------------------------------------------------------

/**
 * The scout's correction-shape answer (#393 B, guard-C): does this NEW memory
 * correct, retract, supersede, or CONTRADICT something previously recorded —
 * and if so, which distinctive terms does the referenced (old) claim carry?
 * `correction: true` means "resolution-shaped": corrects/retracts/supersedes/
 * contradicts an earlier claim. `references` feeds an FTS query against the
 * corpus; the shape call is the ONLY LLM work the scout adds per memory
 * (non-corrections stop there), and it rides the same `complete()` surface +
 * stage budget as every other call (#405 — there is no separate classify-tier
 * ceiling to configure).
 */
export interface ScoutShape {
  correction: boolean;
  /** Distinctive terms of the referenced old claim ("" when not resolution-shaped). */
  references: string;
  /** Informational only — never gates behavior (no uncalibrated parameters). */
  confidence: number;
}

/**
 * Build the constrained correction-shape prompt (classify-tier cost profile:
 * 1500-char truncation, supersession/verdict precedent). The wording asks for
 * the OLD claim's distinctive terms — the field-failure mechanism is that a
 * correction CONTAINS the words of what it corrects, even when the surrounding
 * topics (and therefore the embedding cosine) are unrelated. Guard-C extends
 * the question to contradictions: two records that disagree on the same
 * quantity share even MORE wording than a cross-topic correction does.
 */
export function buildScoutShapePrompt(content: string): string {
  const trunc = (s: string) => (s.length > PROMPT_TRUNCATE_CHARS ? `${s.slice(0, PROMPT_TRUNCATE_CHARS)}…` : s);
  return (
    `You are scanning a memory that was just added to an AI agent's long-term memory store.\n\n` +
    `MEMORY:\n${trunc(content)}\n\n` +
    `Does this memory correct, retract, supersede, or contradict a claim, decision, or state that was ` +
    `previously recorded elsewhere in the store? A mere duplicate, elaboration, independent ` +
    `fact, or new information that invalidates nothing is NOT a correction.\n` +
    `If it is a correction/retraction/supersession/contradiction, list the most distinctive terms of the ` +
    `OLD claim it references — words likely to appear verbatim in the older record.\n\n` +
    `Reply with ONLY a JSON object, no prose: ` +
    `{"correction": true | false, "references": "<distinctive terms of the referenced old claim, or empty string>", ` +
    `"confidence": <number between 0 and 1>}`
  );
}

/**
 * Parse the scout shape reply. Null on unparseable JSON, a missing/non-boolean
 * `correction`, or a missing/out-of-range `confidence` — the caller counts
 * skipped_infra and moves on (parseSupersessionReply discipline: never
 * mis-detect on ambiguity). `references` is lenient (missing/non-string → "")
 * because an empty string simply yields no FTS hits — a harmless miss, not a
 * mis-judgment.
 */
export function parseScoutShape(reply: string): ScoutShape | null {
  if (!reply) return null;
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(reply.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof obj.correction !== "boolean") return null;
  const confidence = Number(obj.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
  const references = typeof obj.references === "string" ? obj.references : "";
  return { correction: obj.correction, references: references.trim(), confidence };
}

/** Build the constrained pair-verdict prompt (1500-char truncation, supersession precedent). */
export function buildCorrectionVerdictPrompt(oldContent: string, newContent: string): string {
  const trunc = (s: string) => (s.length > PROMPT_TRUNCATE_CHARS ? `${s.slice(0, PROMPT_TRUNCATE_CHARS)}…` : s);
  return (
    `You are checking how a NEWER memory relates to an OLDER one in an AI agent's long-term memory.\n\n` +
    `OLDER MEMORY:\n${trunc(oldContent)}\n\n` +
    `NEWER MEMORY:\n${trunc(newContent)}\n\n` +
    `How does the NEWER memory relate to the OLDER one?\n` +
    `- "merge": the two memories carry the SAME underlying fact, verdict, or decision, differing only in ` +
    `wording, detail, or qualifiers — neither invalidates the other; they are two statements of one claim.\n` +
    `- "corrects": the newer memory fixes a factual error or retraction in the older one — the older claim is ` +
    `wrong, no longer true, or was retracted, and the newer memory carries the corrected fact.\n` +
    `- "supersedes": the newer memory replaces a decision, plan, or state that was valid at the time but is ` +
    `now outdated — a replacement, not a factual correction.\n` +
    `- "conflicts": the two memories make claims that cannot both be true — they disagree on a fact, value, ` +
    `or state, and neither one corrects, supersedes, or restates the other (for example two sources report ` +
    `different values for the same quantity). Keep both; flag the conflict.\n` +
    `- "none": unrelated, merely similar, or both can still be true (an addition or elaboration).\n\n` +
    `Reply with ONLY a JSON object, no prose: ` +
    `{"action": "merge" | "corrects" | "supersedes" | "conflicts" | "none", "confidence": <number between 0 and 1>}`
  );
}

export interface CorrectionVerdict {
  action: ResolutionAction;
  confidence: number;
}

/**
 * Parse the pair verdict. Null on anything unparseable, unknown action, or an
 * out-of-range/missing confidence — the caller counts skipped_infra and moves
 * on (same discipline as parseSupersessionReply: never mis-judge on ambiguity).
 */
export function parseCorrectionVerdict(reply: string): CorrectionVerdict | null {
  if (!reply) return null;
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(reply.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const action = obj.action;
  if (
    action !== "merge" &&
    action !== "corrects" &&
    action !== "supersedes" &&
    action !== "conflicts" &&
    action !== "none"
  ) {
    return null;
  }
  const confidence = Number(obj.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
  return { action, confidence };
}

// ---------------------------------------------------------------------------
// Rewrite contract (per target) — {"rewritten","triggers":[{id,disposition}]}
// ---------------------------------------------------------------------------

export interface RewriteTriggerDisposition {
  id: string;
  disposition: "absorb" | "keep";
}

export interface RewriteContract {
  rewritten: string;
  triggers: RewriteTriggerDisposition[];
}

/** Build the constrained rewrite prompt: old content + N trigger contents, nothing else. */
export function buildRewritePrompt(
  oldContent: string,
  triggers: Array<{ id: string; content: string }>,
): string {
  const trunc = (s: string) => (s.length > PROMPT_TRUNCATE_CHARS ? `${s.slice(0, PROMPT_TRUNCATE_CHARS)}…` : s);
  const triggerBlocks = triggers
    .map((t) => `[${t.id}] ${trunc(t.content)}`)
    .join("\n\n");
  return (
    `You are rewriting a memory in an AI agent's long-term memory so it carries the corrected story.\n\n` +
    `OLDER MEMORY (currently stored; contains the outdated or incorrect claim):\n${trunc(oldContent)}\n\n` +
    `CORRECTING MEMORIES (newer; together they supply the correction):\n${triggerBlocks}\n\n` +
    `Compose the corrected memory using ONLY the older memory and the correcting memories — no outside ` +
    `knowledge, no speculation. Keep the older memory's subject and scope; replace the wrong claim with the ` +
    `corrected fact. Write plain prose for long-term recall (no meta commentary, no JSON inside the text).\n` +
    `Then judge each correcting memory: "absorb" if it mostly restates what the corrected memory now says ` +
    `(transition-only — safe to hide from recall); "keep" if it carries standalone substance beyond the ` +
    `correction.\n\n` +
    `Reply with ONLY a JSON object, no prose:\n` +
    `{"rewritten": "<the corrected memory text>", "triggers": [{"id": "<trigger id verbatim>", ` +
    `"disposition": "absorb" | "keep"}, ...]} — one triggers entry per correcting memory above, ids verbatim.`
  );
}

/**
 * Parse + validate the rewrite contract (AC4). Null on ANY failure:
 *  - unparseable JSON / wrong shape;
 *  - rewritten empty, identical to the old content, or longer than
 *    old + 2000 + 500 per additional trigger;
 *  - the triggers array not covering every input trigger id exactly once
 *    (missing, unknown, or duplicated) or carrying an invalid disposition.
 * A null return degrades the WHOLE group to mark-only (never a partial apply).
 */
export function parseRewriteReply(
  reply: string,
  expectedTriggerIds: string[],
  oldContent: string,
): RewriteContract | null {
  if (!reply) return null;
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(reply.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const rewritten = obj.rewritten;
  if (typeof rewritten !== "string" || rewritten.trim().length === 0) return null;
  if (rewritten.trim() === oldContent.trim()) return null;
  const maxLen =
    oldContent.length + REWRITE_BASE_SLACK_CHARS + REWRITE_PER_TRIGGER_SLACK_CHARS * Math.max(0, expectedTriggerIds.length - 1);
  if (rewritten.length > maxLen) return null;

  const triggersRaw = obj.triggers;
  if (!Array.isArray(triggersRaw) || triggersRaw.length !== expectedTriggerIds.length) return null;
  const seen = new Set<string>();
  const triggers: RewriteTriggerDisposition[] = [];
  for (const t of triggersRaw) {
    if (!t || typeof t !== "object") return null;
    const rec = t as Record<string, unknown>;
    if (typeof rec.id !== "string" || !expectedTriggerIds.includes(rec.id)) return null;
    if (seen.has(rec.id)) return null;
    if (rec.disposition !== "absorb" && rec.disposition !== "keep") return null;
    seen.add(rec.id);
    triggers.push({ id: rec.id, disposition: rec.disposition });
  }
  return { rewritten: rewritten.trim(), triggers };
}

// ---------------------------------------------------------------------------
// Provenance footer (template-controlled — uniform audit)
// ---------------------------------------------------------------------------

/**
 * The provenance footer appended to every rewritten memory:
 * `previously believed "<≤160-char head of old content>" until <date>`.
 * date = the ISO DATE (YYYY-MM-DD) derived from the latest trigger's
 * created_at — the same trigger recorded as the history row's evidence_id.
 */
export function buildCorrectionFooter(oldContent: string, dateISO: string): string {
  const head = oldContent.slice(0, FOOTER_HEAD_MAX_CHARS);
  return `previously believed "${head}" until ${dateISO}`;
}

// ---------------------------------------------------------------------------
// Explicit write-time marking (AC1) — deterministic, zero LLM
// ---------------------------------------------------------------------------

export type ExplicitMarkKind = "corrects" | "supersedes";

export interface ExplicitMarkInput {
  kind: ExplicitMarkKind;
  /** Raw id reference (8-char prefix or full UUID) as the client sent it. */
  target: string;
}

export type ExplicitMarkCheck =
  | { ok: true; targetId: string }
  | { ok: false; httpStatus: number; error: string };

/**
 * Validate an explicit mark target BEFORE anything is written (AC1: on an
 * unknown/ambiguous id the WHOLE request fails and nothing is stored).
 * httpStatus is the REST code; the MCP tool reuses the message verbatim.
 */
export function checkExplicitMarkTarget(
  db: Database.Database,
  input: ExplicitMarkInput,
): ExplicitMarkCheck {
  const targetId = storage.resolveMemoryId(db, input.target);
  if (!targetId) {
    return {
      ok: false,
      httpStatus: 404,
      error: `${input.kind} target not found or ambiguous: ${input.target}`,
    };
  }
  const target = storage.getMemory(db, targetId);
  if (!target) {
    return { ok: false, httpStatus: 404, error: `${input.kind} target not found: ${input.target}` };
  }
  if (target.status === "absorbed") {
    return {
      ok: false,
      httpStatus: 409,
      error: `${input.kind} target ${targetId.slice(0, 8)} is absorbed (invisible to recall) — roll back the absorbing rewrite first (hicortex history --rollback)`,
    };
  }
  return { ok: true, targetId };
}

/**
 * Apply a validated explicit mark: link old → new + status on the old memory.
 * Deterministic — no LLM. Link strength 1.0: an operator-declared mark, not a
 * measured cosine. `corrects` → `corrected_by` + status `retracted`;
 * `supersedes` → `superseded_by` + status `superseded` (AC1).
 */
export function applyExplicitMark(
  db: Database.Database,
  newMemoryId: string,
  input: ExplicitMarkInput,
): void {
  const check = checkExplicitMarkTarget(db, input);
  if (!check.ok) {
    throw new Error(`applyExplicitMark: unvalidated mark refused — ${check.error}`);
  }
  const relationship = input.kind === "corrects" ? "corrected_by" : "superseded_by";
  storage.addLink(db, check.targetId, newMemoryId, relationship, 1.0);
  storage.updateMemory(db, check.targetId, {
    status: input.kind === "corrects" ? "retracted" : "superseded",
  });
}

// ---------------------------------------------------------------------------
// Absorb / un-absorb + vector-replace primitives (shared by stage + rollback)
// ---------------------------------------------------------------------------

/**
 * Drop a trigger's retrieval candidacy: status `absorbed`, vector row deleted,
 * FTS row deleted (direct DELETE — the AFTER UPDATE trigger's `UPDATE … WHERE
 * rowid` is a silent no-op on the missing row, so later column edits cannot
 * resurrect it). Row + links are KEPT (evidence, session lineage, rollback).
 * Must run inside a transaction. Tags/domain deliberately untouched (only the
 * rewritten TARGET gets its tags cleared).
 *
 * #392: the implementation moved to storage.ts (`absorbMemory`) so the dedup
 * merge core shares the ONE primitive without an import cycle; re-exported
 * here under its historical name for the rewrite/rollback paths (nothing
 * external imports it today, but it is the module's documented surface).
 */
export const absorbTrigger: (db: Database.Database, triggerId: string) => void = storage.absorbMemory;

/**
 * Replace a memory's vector (delete + insert) — the /update re-embed pattern.
 * Must run inside a transaction (the caller pre-computes the embedding
 * asynchronously, outside the sync transaction).
 */
export function replaceMemoryVector(
  db: Database.Database,
  memoryId: string,
  embedding: Float32Array,
): void {
  db.prepare("DELETE FROM memory_vectors WHERE id = ?").run(memoryId);
  db.prepare("INSERT INTO memory_vectors (id, embedding) VALUES (?, ?)").run(
    memoryId,
    storage.embedToBlob(embedding),
  );
}

/**
 * Reverse an absorb: status back to active (NULL), vector re-embedded from the
 * (untouched) content, FTS row re-inserted explicitly (migration v10's rebuild
 * pattern — the AFTER UPDATE trigger cannot recreate a deleted FTS row).
 * Must run inside a transaction; no-op on a memory that is not currently
 * absorbed (never resurrects an already-live row, never duplicates an FTS row).
 */
export function unabsorbTrigger(db: Database.Database, triggerId: string, embedding: Float32Array): void {
  const mem = storage.getMemory(db, triggerId);
  if (!mem || mem.status !== "absorbed") return;
  const rid = storage.memoryRowid(db, triggerId);
  storage.updateMemory(db, triggerId, { status: null });
  replaceMemoryVector(db, triggerId, embedding);
  if (rid !== null) {
    db.prepare(
      `INSERT INTO memories_fts (rowid, content, project, domain)
       SELECT rowid, content, COALESCE(project, ''), COALESCE(domain, '') FROM memories
       WHERE id = ? AND NOT EXISTS (SELECT 1 FROM memories_fts WHERE rowid = ?)`,
    ).run(triggerId, rid);
  }
}

// ---------------------------------------------------------------------------
// memory_history (audit + rollback input)
// ---------------------------------------------------------------------------

export interface MemoryHistoryRow {
  id: number;
  memory_id: string;
  old_content: string;
  new_content: string;
  prev_status: string | null;
  new_status: string | null;
  triggers_json: string | null;
  evidence_id: string | null;
  confidence: number | null;
  cause: string;
  created_at: string;
}

/** History rows for one memory, oldest first. */
export function getMemoryHistory(db: Database.Database, memoryId: string): MemoryHistoryRow[] {
  return db
    .prepare("SELECT * FROM memory_history WHERE memory_id = ? ORDER BY id ASC")
    .all(memoryId) as MemoryHistoryRow[];
}

export function getHistoryRow(db: Database.Database, historyRowId: number): MemoryHistoryRow | null {
  return (db
    .prepare("SELECT * FROM memory_history WHERE id = ?")
    .get(historyRowId) as MemoryHistoryRow | undefined) ?? null;
}

// ---------------------------------------------------------------------------
// Cosine-band statistics (#392) — self-calibration evidence
// ---------------------------------------------------------------------------

/** Fixed intermediate band edges — only the floor and ceiling are config. */
const BAND_INTERMEDIATE_EDGES = [0.8, 0.85, 0.9] as const;

export interface ResolutionBand {
  /** Band label, e.g. "0.75-0.8" or ">=0.92". */
  label: string;
  /** Inclusive lower edge. */
  lo: number;
  /** Exclusive upper edge (Infinity for the deterministic >= band). */
  hi: number;
}

/**
 * Build the verdict-statistic bands from the LIVE floor/ceiling (#392): edges
 * = sorted unique [floor, 0.80, 0.85, 0.90, ceiling]; bands are [e0,e1) …
 * [e(n-1),en) plus the deterministic ">=en" band. Intermediate edges outside
 * (floor, ceiling) are dropped — a band below the floor can never receive a
 * verdict (candidates are >= floor), so a raised floor collapses the lower
 * bands away instead of seeding dead labels. Labels use the numbers as
 * configured ("0.75-0.8" … "0.9-0.92", ">=0.92").
 */
export function buildResolutionBands(floor: number, ceiling: number): ResolutionBand[] {
  const edges = [
    floor,
    ...BAND_INTERMEDIATE_EDGES.filter((e) => e > floor && e < ceiling),
    ceiling,
  ]
    .filter((e) => Number.isFinite(e))
    .filter((e, i, arr) => arr.indexOf(e) === i)
    .sort((a, b) => a - b);
  const bands: ResolutionBand[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    bands.push({ label: `${edges[i]}-${edges[i + 1]}`, lo: edges[i], hi: edges[i + 1] });
  }
  if (edges.length > 0) {
    bands.push({ label: `>=${edges[edges.length - 1]}`, lo: edges[edges.length - 1], hi: Infinity });
  }
  return bands;
}

/**
 * The band a pair's cosine falls into: the [lo, hi) band that contains it,
 * falling through to the final >= band for cosines at/above the last edge.
 * Null only for a cosine below the floor (never a candidate).
 */
export function bandForCosine(bands: ResolutionBand[], cosine: number): ResolutionBand | null {
  for (const b of bands) {
    if (cosine >= b.lo && cosine < b.hi) return b;
  }
  return null;
}

/** An empty band-stat record (fresh accumulation starts from zeroes). */
function emptyBandStat(): ResolutionBandStat {
  return { pairs: 0, merge: 0, corrects: 0, supersedes: 0, conflicts: 0, none: 0, merge_below_gate: 0, conf_sum: 0 };
}

/** Add a run's per-band counts into a cumulative record (in place). */
function accumulateBandStat(cumulative: ResolutionBandStat, run: ResolutionBandStat): void {
  cumulative.pairs += run.pairs;
  cumulative.merge += run.merge;
  cumulative.corrects += run.corrects;
  cumulative.supersedes += run.supersedes;
  cumulative.conflicts += run.conflicts;
  cumulative.none += run.none;
  cumulative.merge_below_gate += run.merge_below_gate;
  cumulative.conf_sum += run.conf_sum;
  if (run.metadata_skipped !== undefined) {
    cumulative.metadata_skipped = (cumulative.metadata_skipped ?? 0) + run.metadata_skipped;
  }
}

// ---------------------------------------------------------------------------
// The stage
// ---------------------------------------------------------------------------

interface TriggerRecord {
  /** The trigger (NEW memory that corrects the target). */
  id: string;
  memory: Memory;
  /** Verdict confidence that confirmed the pair. */
  confidence: number;
  /** Pair cosine (detection pairs) or null (explicit marks, no measurement). */
  cosine: number | null;
  /** The trigger's own memories.rowid at scan time — cursor-hold bookkeeping. */
  candidateRowid: number;
  /** True when the pair entered via a verified explicit ingest mark. */
  explicit: boolean;
}

interface RewriteGroup {
  targetId: string;
  /** Target snapshot from detection time (pre-rewrite content + status). */
  target: Memory;
  triggers: TriggerRecord[];
}

/**
 * Find up to CORRECTION_NEIGHBOR_TOP_K OLDER neighbors for a candidate at/above
 * minSimilarity, highest cosine first. NO shape filter on either side — a
 * retraction riding inside an unrelated memory is exactly the pair this stage
 * exists to catch. Absorbed neighbors are structurally absent (no vector row).
 */
async function findOlderCorrectionNeighbors(
  db: Database.Database,
  candidate: Memory,
  embedFn: EmbedFn,
  minSimilarity: number,
): Promise<Array<Memory & { distance: number }>> {
  const embedding = storage.getStoredEmbedding(db, candidate.id) ?? (await embedFn(candidate.content));
  return storage
    .vectorSearch(db, embedding, CORRECTION_NEIGHBOR_POOL, [candidate.id])
    .filter((n) => n.created_at < candidate.created_at && l2ToCosine(n.distance) >= minSimilarity)
    .sort((a, b) => l2ToCosine(b.distance) - l2ToCosine(a.distance))
    .slice(0, CORRECTION_NEIGHBOR_TOP_K);
}

/**
 * A detection pair entering the verdict loop, tagged by its SOURCE (#393 B):
 * "similarity" — the KNN/cosine-floor source (the pre-B baseline; pairs enter
 * bands, ceiling-skip applies); "scout" — the FTS/reference-extraction source
 * (no similarity gate: cosine is a ranker and link strength, never a blocker;
 * never recorded in the cosine bands, per the refine addendum's Q2 ruling).
 */
interface CandidateNeighbor {
  mem: Memory;
  /** Measured pair cosine (KNN distance → cosine, or stored-vector cosine for scout hits). */
  cosine: number;
  source: "similarity" | "scout";
}

/**
 * The scout source (#393 increment B): for a correction-shaped NEW memory, FTS
 * the corpus with the referenced claim's distinctive terms and return the OLDER
 * hits as candidate pairs. This is the reference-extraction half — it finds the
 * old claim even when the overall topics differ (and therefore the cosine sits
 * below the similarity floor) because the correction CONTAINS the words of
 * what it corrects. Deterministic: ONE FTS query, zero LLM. Filters: self,
 * non-older (detection only pairs older → newer, the KNN mirror), and
 * defensively non-absorbed hits. Pool/top-K reuse the KNN constants; FTS rank
 * (BM25, best first) is the order. Dedup against the KNN neighbor ids is the
 * caller's job (a pair found by both sources is judged once, as similarity).
 */
function findScoutNeighbors(
  db: Database.Database,
  candidate: Memory,
  references: string,
  candidateEmbedding: Float32Array | null,
): Array<CandidateNeighbor> {
  if (!references) return [];
  try {
    const hits = storage.searchFts(db, references, CORRECTION_NEIGHBOR_POOL);
    return hits
      .filter(
        (m) =>
          m.id !== candidate.id &&
          m.created_at < candidate.created_at &&
          m.status !== "absorbed",
      )
      .slice(0, CORRECTION_NEIGHBOR_TOP_K)
      .map((m) => {
        const hitVec = storage.getStoredEmbedding(db, m.id);
        const cosine =
          candidateEmbedding && hitVec ? cosineBetweenVectors(candidateEmbedding, hitVec) : 0;
        return { mem: m, cosine, source: "scout" as const };
      });
  } catch {
    // FTS is deterministic infrastructure — a throw here is a bug or a corrupt
    // index, never a judgment question. Fail soft: no scout pairs this memory.
    return [];
  }
}

async function classifyPair(
  llm: LlmClient,
  oldContent: string,
  newContent: string,
): Promise<{ verdict: CorrectionVerdict | null; usage: LlmUsage | undefined }> {
  try {
    const r = await llm.complete(buildCorrectionVerdictPrompt(oldContent, newContent));
    return { verdict: parseCorrectionVerdict(r.text), usage: r.usage };
  } catch {
    return { verdict: null, usage: undefined };
  }
}

/**
 * Nightly reconsolidation stage (#384, #392 — THE unified resolution stage;
 * #439 apply-on-confirm).
 *
 * Phase order (#393 guard-C): the deterministic merge zone (pairs >= the
 * ceiling) runs LAST — after the scan (which now includes every judged-merge
 * application and rewrite, #439). Judgment outranks the deterministic sweep:
 * verdicts, marks, and binds land first and the zone merges only what no
 * verdict claimed. With the zone first, a >=0.92 genuine-conflict pair was
 * blended before the judge ever saw it (the planted-eval harm); running it
 * last means a `conflicts` bind set by this run's scan guards the SAME run's
 * zone. Zone internals (lock, backup, deadline, persistBand, fail-soft) are
 * unchanged.
 *
 * Scan: every memory with rowid > reconsolidationCursor (no shape filter;
 * absorbed candidates are skipped — invisible memories are not re-judged).
 * Each candidate's pairs: incoming explicit marks (verified once, AC7), then
 * ONE scout shape call (#393 B — flags correction shape; non-corrections stop
 * there), then up-to-5 older KNN neighbors in [floor, ceiling) (verdict call
 * per unlinked pair, AC2 — pairs at/above the ceiling are counted, never
 * judged) plus the scout's FTS hits for correction-shaped memories (same
 * verdict loop, NO similarity gate; guard-C: a scout hit whose KNN twin sits
 * at/above the ceiling is re-tagged scout so the pair IS judged instead of
 * being left for the zone to blend). Confirmed `corrects` pairs above the
 * confidence gate on fact-shaped targets group by target; a `conflicts`
 * verdict writes the conflicts link and nothing else (both live); everything
 * else is mark-only.
 *
 * #439 BOUNDARY apply: at the END of each candidate iteration everything it
 * confirmed applies IMMEDIATELY — merges first (each judged-merge pair via
 * mergeMemoryIds in its own transaction, under the boundary's short lock
 * window; ONE lazy pre-merge backup per run), then the iteration's rewrite
 * groups (one rewrite LLM call + one applyRewriteGroup transaction each;
 * dispositions resolved ACROSS the boundary's groups — the multi-target keep
 * rule: a trigger absorbed only if every group's contract says absorb). A
 * busy capture lock pushes the boundary's merges onto a same-run retry list
 * (retried at the next boundary and once in a final drain after the scan);
 * a deadline, a backup failure, or a rewrite-call refusal/infra error defers
 * the remaining work and holds the cursor.
 *
 * Cursor discipline: the cursor advances past a candidate only when its
 * iteration's confirmed work has LANDED (or was refused-with-verdict-rendered:
 * metadata mismatch, conflict-linked, mark-only fallback). A deferral holds
 * the cursor BELOW the current candidate — bounded to ONE candidate's pairs,
 * re-detected and re-judged next run (dup-over-loss — a confirmed resolution
 * must never be silently dropped by the cursor passing it). The separate
 * scan high-water (state.reconsolidationScannedRowid) records the max
 * candidate rowid ENTERED and is never held back, so the report can split
 * verdict calls into pairs_reevaluated (at/below the prior high-water) vs
 * pairs_new — the convergence measurement.
 *
 * Dry-run: the zone's discovery + the free idempotency check only — zero LLM
 * calls, zero writes, no cursor or band-stats persistence. Gate discovery is
 * reported on every run (pairs_discovered / pairs_discovered_unlinked, #394) —
 * on a dry-run they are the sizing numbers (pairs_evaluated stays 0: no calls
 * are ever made).
 */
export async function stageReconsolidation(
  db: Database.Database,
  llm: LlmClient,
  budget: StageBudget,
  embedFn: EmbedFn,
  dryRun: boolean,
  stateDir: string | undefined,
  options: ReconsolidationOptions = {},
): Promise<ReconsolidationStageResult> {
  // Config values pass through `unknown`-typed JSON — validate, never trust.
  const validNumber = (v: unknown, fallback: number, ok: (n: number) => boolean): number => {
    const n = Number(v);
    return Number.isFinite(n) && ok(n) ? n : fallback;
  };
  const minSimilarity = validNumber(
    options.minSimilarity,
    DEFAULT_CORRECTION_MIN_SIMILARITY,
    (n) => n > 0 && n <= 1,
  );
  const rewriteMinConfidence = validNumber(
    options.rewriteMinConfidence,
    DEFAULT_CORRECTION_REWRITE_MIN_CONFIDENCE,
    (n) => n > 0 && n <= 1,
  );
  const autoMergeThreshold = validNumber(
    options.autoMergeThreshold,
    DEFAULT_DEDUP_MERGE_THRESHOLD,
    (n) => n > 0 && n <= 1,
  );

  // ---- #405 runtime bound. The stage-local reconsolidationMaxMinutes clock
  // (#401) is gone — the run-wide pipeline deadline (nightly.ts, config
  // nightlyTimeBudgetMinutes) is the only wall-clock. The deterministic
  // zone's runtime counts against it via the zone's own stop-check below.
  // hit() logs event=deadline_deferred once per stage name.
  const deadline = options.deadline;
  const deadlineHit = (stageLabel = RECONSOLIDATION_STAGE_LABEL): boolean =>
    deadline?.hit(stageLabel) ?? false;

  // Per-run verdict statistics by cosine band (#392) — report snapshot here,
  // cumulative series in state.json at stage end (never on dry-run).
  const bands = buildResolutionBands(minSimilarity, autoMergeThreshold);
  const runBands = new Map<string, ResolutionBandStat>();
  const recordBand = (cosine: number, action: ResolutionAction, confidence: number): void => {
    const band = bandForCosine(bands, cosine);
    if (!band) return; // below the floor — never a candidate (defensive)
    const stat = runBands.get(band.label) ?? emptyBandStat();
    stat.pairs++;
    stat[action]++;
    stat.conf_sum += confidence;
    runBands.set(band.label, stat);
  };

  const startCursor = loadState(stateDir).reconsolidationCursor ?? 0;
  // #439 convergence measurement: the scan high-water is the max candidate
  // rowid any run has ENTERED — never held back by un-applied work. This
  // run's re-judged/new split keys on the PREVIOUS run's persisted value: a
  // verdict on a candidate at/below it re-judges pairs a prior run already
  // judged but could not apply (the cursor held below them, so they
  // re-detect). Once the backlog drains, pairs_reevaluated reads 0.
  const prevScannedRowid = loadState(stateDir).reconsolidationScannedRowid ?? startCursor;
  let scannedRowidHighwater = startCursor;
  // NO shape filter (AC2) — unlike stageSupersession. Absorbed rows are
  // excluded: they are invisible to recall and must not re-enter judgment.
  const rows = db
    .prepare(
      `SELECT rowid AS __rowid, * FROM memories
       WHERE rowid > ? AND COALESCE(status, '') != 'absorbed'
       ORDER BY rowid ASC`,
    )
    .all(startCursor) as Array<Memory & { __rowid: number }>;

  let scanned = 0;
  let pairsEvaluated = 0;
  let pairsDiscovered = 0; // #394: gate discovery — counted before any skip/judgment
  let pairsDiscoveredUnlinked = 0;
  let rewritten = 0;
  let absorbed = 0;
  let keptLinked = 0;
  let markedSuperseded = 0;
  let markedRetracted = 0;
  let belowGate = 0;
  let contractFailed = 0;
  let skippedInfra = 0;
  let skippedIdempotent = 0;
  let explicitVerified = 0;
  let explicitDivergent = 0;
  let mergeBelowGate = 0;
  let skippedAboveCeiling = 0;
  let skippedMetadataMismatch = 0;
  let mergePairsApplied = 0;
  // #393 guard-C: conflicts verdicts rendered (link written, both live) and
  // judged-path merge refusals on a conflicts-linked pair.
  let conflictFlagged = 0;
  let conflictSkippedJudged = 0;
  // #393 B scout counters (per-source observability, the #394 discipline):
  // shape calls made / correction-shaped verdicts / FTS hits that became
  // candidate pairs. 0 on dry-run (the shape call is LLM work).
  let scoutScanned = 0;
  let scoutCorrectionShaped = 0;
  let scoutCandidatesFound = 0;
  // #439 observability: the re-judged/new verdict split (keyed on the prior
  // run's scan high-water) + the scan-stability guard's skip count + the
  // confirmed-merge deferral count (still un-applied at run end).
  let pairsReevaluated = 0;
  let pairsNew = 0;
  let skippedAbsorbed = 0;
  let mergePairsDeferred = 0;
  let cursor = startCursor;

  // #439: a confirmed judged-merge pair awaiting its boundary apply.
  // candidateRowid = the NEWER memory's rowid — the cursor-hold anchor when
  // the pair cannot apply.
  interface QueuedMerge {
    oldId: string;
    newId: string;
    candidateRowid: number;
  }
  // Lock-busy survivors: boundary merges that could not take the capture
  // lock, plus (fix round, #440 review finding 1) deadline/backup-dropped
  // tails re-queued at their boundary instead of discarded. Same-run only —
  // retried (in full) at the next boundary and once in the final drain after
  // the scan. While the list is non-empty, every persisted checkpoint clamps
  // below the earliest contributing candidate (pendingRetryFloor — the kill
  // window cannot strand them); still un-applied at run end, the drain holds
  // the cursor below that same floor (dup-over-loss).
  const retryMerges: QueuedMerge[] = [];
  // ONE pre-merge backup per run (#439): takePreDedupBackup is a full SQLite
  // copy, so a per-boundary backup would be hundreds of full-DB copies on a
  // backlog night. Taken LAZILY, immediately before the first judged-merge
  // application; remembered for the rest of the run (the zone takes its own,
  // independent backup, as before).
  let mergeWindowBackedUp = false;

  // Links created by THIS stage in THIS run — lets the explicit-mark pass
  // distinguish operator marks (pre-existing) from stage output.
  const linksCreatedThisRun = new Set<string>();
  const markLink = (oldId: string, newId: string, relationship: string, strength: number): void => {
    storage.addLink(db, oldId, newId, relationship, strength);
    linksCreatedThisRun.add(`${oldId}|${newId}`);
  };

  // ---- #401/#439 mid-scan cursor persistence. Called at EVERY scan-loop
  // exit path AND at the end of every candidate iteration — AFTER that
  // iteration's boundary apply, so the persisted cursor only ever advances
  // past candidates whose confirmed work has landed; a killed run loses at
  // most the candidate in flight. The ONE exception is lock-busy retry
  // survivors: they intentionally ride the retry list while the scan
  // continues (the lock may clear this run), so while any are pending every
  // persisted checkpoint CLAMPS below their earliest contributor — a SIGKILL
  // in the window between a busy boundary and the pair landing must never
  // strand a confirmed merge behind the cursor (the #402 orphan-floor
  // discipline, re-scoped to the retry list; the clamp lifts automatically
  // once a later boundary or the final drain applies them). Also persists
  // the scan high-water (never held back). updateState is load→mutate→
  // temp-rename atomic.
  let deadlineStopped = false;
  // #439: once an iteration's confirmed work deferred (deadline at the
  // boundary, backup failure, rewrite refusal/infra error), the cursor never
  // advances again this run — a later iteration must not push it past the
  // held candidate's rowid.
  let cursorHold = false;
  // Fix round (#440 review, finding 1): the floor below the earliest
  // candidate contributing to a still-un-applied retry merge. Applied at
  // every persist so the kill-with-pending-retry window cannot strand them.
  const pendingRetryFloor = (): number | null =>
    retryMerges.length > 0
      ? Math.min(...retryMerges.map((p) => p.candidateRowid)) - 1
      : null;
  const clampedCursor = (): number => {
    const floor = pendingRetryFloor();
    return floor !== null ? Math.min(cursor, floor) : cursor;
  };
  const persistCursor = (): void => {
    if (dryRun) return;
    updateState((s) => {
      s.reconsolidationCursor = clampedCursor();
      s.reconsolidationScannedRowid = Math.max(scannedRowidHighwater, s.reconsolidationScannedRowid ?? 0);
    }, stateDir);
  };

  // #439: rewrite groups live ONLY inside the candidate iteration that
  // formed them (its boundary applies or degrades them, then they are
  // discarded). Every trigger is the current candidate — a target corrected
  // by two different candidates takes two sequential rewrites instead of
  // the old one grouped call.
  const addTrigger = (
    groups: Map<string, RewriteGroup>,
    target: Memory,
    trigger: Memory & { __rowid: number },
    confidence: number,
    cosine: number | null,
    explicit: boolean,
  ): void => {
    let group = groups.get(target.id);
    if (!group) {
      group = { targetId: target.id, target, triggers: [] };
      groups.set(target.id, group);
    }
    if (!group.triggers.some((t) => t.id === trigger.id)) {
      group.triggers.push({
        id: trigger.id,
        memory: trigger,
        confidence,
        cosine,
        candidateRowid: trigger.__rowid,
        explicit,
      });
    }
  };

  for (const snapshotted of rows) {
    // #401: runtime bounds first — exit cleanly at the last fully-considered
    // candidate boundary (cursor = the previous candidate's rowid here).
    if (!dryRun && deadlineHit()) {
      deadlineStopped = true;
      persistCursor();
      break;
    }
    if (!dryRun && budget.exhausted) {
      persistCursor();
      break;
    }

    // ---- #439 scan-stability guard: `rows` is ONE snapshot fetched at stage
    // start with status != 'absorbed'; boundary applies (merge losers,
    // rewrite triggers absorbed) can mark FUTURE rows of that snapshot
    // absorbed after the filter ran. Without this re-read such a candidate
    // would be scouted/judged on stale content and its KNN would silently
    // re-embed it (its vector row is gone). Absorbed → skip (counted,
    // cursor passes it); otherwise the LIVE row's content/status drives the
    // rest of the iteration (refreshes content rewritten by an earlier
    // boundary when created_at and rowid order diverge).
    const live = db
      .prepare(`SELECT rowid AS __rowid, * FROM memories WHERE rowid = ?`)
      .get(snapshotted.__rowid) as (Memory & { __rowid: number }) | undefined;
    if (!live) {
      // Vanished entirely (deleted out from under the scan) — defensive;
      // nothing to judge, the cursor passes it (never past an active hold).
      scannedRowidHighwater = Math.max(scannedRowidHighwater, snapshotted.__rowid);
      if (!cursorHold) cursor = snapshotted.__rowid;
      persistCursor();
      continue;
    }
    if (live.status === "absorbed") {
      skippedAbsorbed++;
      scannedRowidHighwater = Math.max(scannedRowidHighwater, live.__rowid);
      if (!cursorHold) cursor = live.__rowid;
      persistCursor();
      continue;
    }
    const candidate = live;
    scanned++;
    // The high-water advances as candidates are ENTERED — even when the
    // iteration's work later defers (it is the SCAN mark, never held back).
    scannedRowidHighwater = Math.max(scannedRowidHighwater, candidate.__rowid);

    // #439 per-iteration confirmed work, applied at the boundary below.
    const iterMerges: QueuedMerge[] = [];
    const iterGroups = new Map<string, RewriteGroup>();
    // This iteration's confirmed work could not land (deadline at the
    // boundary, backup failure, rewrite refusal/infra error): the cursor
    // holds below this candidate.
    let boundaryHold = false;
    // Stop the scan AFTER the boundary (budget stop / rewrite-infra
    // deferral / backup failure): further verdicts could not land anyway.
    let stopScan = false;

    // ---- AC7: verify incoming explicit marks (corrected_by/superseded_by
    // links targeting this candidate) before they can join a rewrite group.
    // #401: only OPERATOR marks are verified — applyExplicitMark writes
    // strength 1.0, while every stage-created link carries a measured cosine
    // strength < 1 (markLink sites + supersession). Without the filter, every
    // prior night's stage output re-entered verification: a self-sustaining
    // backlog that re-litigated settled verdicts forever.
    if (!dryRun) {
      const incoming = db
        .prepare(
          `SELECT source_id, relationship FROM memory_links
           WHERE target_id = ? AND source_id != ?
             AND relationship IN ('corrected_by', 'superseded_by')
             AND strength >= 1.0`,
        )
        .all(candidate.id, candidate.id) as Array<{ source_id: string; relationship: string }>;
      let markBudgetStop = false;
      for (const mark of incoming) {
        if (linksCreatedThisRun.has(`${mark.source_id}|${candidate.id}`)) continue; // stage output, not a mark
        if (!budget.use(RECONSOLIDATION_STAGE_LABEL)) {
          markBudgetStop = true;
          break;
        }
        const target = storage.getMemory(db, mark.source_id);
        if (!target || target.status === "absorbed") {
          explicitDivergent++; // mark's target is gone/invisible — retain link, nothing to upgrade
          continue;
        }
        const { verdict, usage } = await classifyPair(llm, target.content, candidate.content);
        budget.recordUsage(RECONSOLIDATION_STAGE_LABEL, usage);
        pairsEvaluated++;
        if (candidate.__rowid <= prevScannedRowid) pairsReevaluated++;
        else pairsNew++;
        if (!verdict) {
          skippedInfra++; // mark retained; the neighborhood is revisited via newer candidacies
          continue;
        }
        if (verdict.action === "corrects" && verdict.confidence >= rewriteMinConfidence && isFactShapedTarget(target)) {
          addTrigger(iterGroups, target, candidate, verdict.confidence, null, true);
          explicitVerified++;
        } else {
          // Divergent: the nightly verdict did not confirm a rewrite. The mark
          // is RETAINED untouched — explicit input is deliberate (owner
          // decision 1), and marks are cheap to reverse via CLI.
          explicitDivergent++;
          console.log(
            `[hicortex] Reconsolidation: explicit mark on ${candidate.id.slice(0, 8)} diverged ` +
              `(verdict ${verdict.action}, confidence ${verdict.confidence.toFixed(2)}) — mark retained`,
          );
        }
      }
      if (markBudgetStop) {
        // #401: this candidate's remaining marks re-verify next run — the
        // cursor HOLDS below it (boundaryHold), and #439 still runs the
        // boundary: marks confirmed before the stop apply, exactly as they
        // did when the rewrite phase was post-scan.
        stopScan = true;
        boundaryHold = true;
      }
    }

    // ---- #393 B: scout shape call — ONE classify-tier call per candidate,
    // budget-metered under the same stage label as verdicts. Flags whether
    // this memory corrects/retracts/supersedes something previously recorded;
    // non-corrections stop here (zero follow-up). A parse/infra failure skips
    // the scout source for this memory only (fail-soft — the similarity
    // source below still runs) and counts skipped_infra, the verdict-skip
    // discipline. Dry-run skips the call entirely: it is LLM work, and
    // dry-runs make zero LLM calls (the scout counters read 0 there).
    let scoutReferences: string | null = null;
    if (!dryRun && !stopScan) {
      if (!budget.use(RECONSOLIDATION_STAGE_LABEL)) {
        // Shape call refused — this candidate re-scouts next run: the cursor
        // HOLDS below it (the candidate was entered but not considered).
        stopScan = true;
        boundaryHold = true;
      } else {
        scoutScanned++;
        try {
          const r = await llm.complete(buildScoutShapePrompt(candidate.content));
          budget.recordUsage(RECONSOLIDATION_STAGE_LABEL, r.usage);
          const shape = parseScoutShape(r.text);
          if (!shape) {
            skippedInfra++;
          } else if (shape.correction) {
            scoutCorrectionShaped++;
            scoutReferences = shape.references;
          }
        } catch {
          skippedInfra++;
        }
      }
    }

    // ---- AC2: detection pairs against older neighbors — TWO sources (#393 B):
    // the KNN similarity source (floor-gated, the pre-B baseline) and, for
    // correction-shaped candidates, the scout's FTS source (the referenced
    // claim's terms → corpus search; NO similarity gate — cosine is a ranker,
    // never a blocker). Merged + deduped by neighbor id: a pair found by both
    // sources is judged ONCE, as similarity (with band attribution).
    let discoveryFailed = false;
    let neighbors: Array<Memory & { distance: number }> = [];
    if (!stopScan) {
      try {
        neighbors = await findOlderCorrectionNeighbors(db, candidate, embedFn, minSimilarity);
      } catch (err) {
        console.warn(
          `[hicortex] reconsolidation: discovery failed for ${candidate.id.slice(0, 8)} — ${err instanceof Error ? err.message : String(err)}`,
        );
        // #439: skip this candidate's neighbor judgments but still run the
        // boundary below — marks confirmed earlier this iteration apply
        // (they did when the phases were post-scan).
        discoveryFailed = true;
      }
    }
    const neighborEntries: CandidateNeighbor[] = neighbors.map((n) => ({
      mem: n,
      cosine: l2ToCosine(n.distance),
      source: "similarity" as const,
    }));
    if (!discoveryFailed && scoutReferences !== null) {
      const candidateVec = storage.getStoredEmbedding(db, candidate.id);
      const knnById = new Map(neighborEntries.map((e) => [e.mem.id, e]));
      for (const entry of findScoutNeighbors(db, candidate, scoutReferences, candidateVec)) {
        const knn = knnById.get(entry.mem.id);
        if (knn) {
          // Both sources found the pair. Below the ceiling the KNN entry
          // would be judged anyway — similarity keeps it (band attribution,
          // judged once). At/above the ceiling the similarity entry would be
          // ceiling-skipped (zone territory, never judged) — yet the zone now
          // runs AFTER the scan, and a genuine conflict at >=0.92 is exactly
          // the pair it would blend with no judge in the loop (guard-C's
          // harm). Re-tag the entry to the scout source so the pair IS
          // judged: the scout's no-gate exemption applies, a `conflicts`
          // verdict can plant the guard link, and the zone's own guard then
          // refuses the cluster in this same run.
          if (knn.cosine >= autoMergeThreshold) knn.source = "scout";
          continue;
        }
        neighborEntries.push(entry);
      }
    }

    for (const entry of neighborEntries) {
      pairsDiscovered++; // gate discovery (#394), both sources, before any skip/judgment
      if (entry.source === "scout") scoutCandidatesFound++;
      if (alreadyResolutionLinked(db, entry.mem.id, candidate.id)) {
        skippedIdempotent++;
        continue;
      }
      pairsDiscoveredUnlinked++; // still unlinked — the actionable candidate
      const pairCosine = entry.cosine;
      // #392: SIMILARITY-source pairs at/above the ceiling belong to the
      // deterministic zone — counted here, never LLM-judged (the zone merges
      // them at stage end or defers them to a later run; re-detection is
      // structural, not cursor-based). Scout pairs are exempt (#393 B):
      // cosine never blocks this source — guard-C's re-tag above relies on
      // it, and a judged merge re-passes the same metadata/conflict rails
      // the zone enforces.
      if (entry.source === "similarity" && pairCosine >= autoMergeThreshold) {
        skippedAboveCeiling++;
        continue;
      }
      if (dryRun) continue; // preview only — no LLM call, no write

      // #405: the ONE run budget's refusal is the only call cap.
      if (!budget.use(RECONSOLIDATION_STAGE_LABEL)) {
        stopScan = true; // the boundary below still applies what this candidate already confirmed
        break;
      }
      const { verdict, usage } = await classifyPair(llm, entry.mem.content, candidate.content);
      budget.recordUsage(RECONSOLIDATION_STAGE_LABEL, usage);
      pairsEvaluated++;
      if (candidate.__rowid <= prevScannedRowid) pairsReevaluated++;
      else pairsNew++;
      if (!verdict) {
        skippedInfra++;
        continue;
      }
      // Bands stay similarity-source-only (refine Q2 ruling): they are the
      // calibration evidence for the floor/ceiling boundaries, and scout
      // pairs reach them through a different, cosine-blind door.
      if (entry.source === "similarity") recordBand(pairCosine, verdict.action, verdict.confidence);

      // #392/#439: a merge verdict queues for THIS iteration's boundary —
      // no link, no write here. Below the confidence gate BOTH memories stay
      // live: a weak mark is recoverable, and there is nothing to mark for a
      // duplicate — keeping both is the recoverable outcome.
      if (verdict.action === "merge") {
        if (verdict.confidence < rewriteMinConfidence) {
          mergeBelowGate++;
          if (entry.source === "similarity") {
            const band = bandForCosine(bands, pairCosine);
            if (band) {
              const stat = runBands.get(band.label) ?? emptyBandStat();
              stat.merge_below_gate++;
              runBands.set(band.label, stat);
            }
          }
        } else {
          iterMerges.push({ oldId: entry.mem.id, newId: candidate.id, candidateRowid: candidate.__rowid });
        }
        continue;
      }

      if (verdict.action === "supersedes") {
        markLink(entry.mem.id, candidate.id, "superseded_by", pairCosine);
        storage.updateMemory(db, entry.mem.id, { status: "superseded" });
        markedSuperseded++;
        console.log(
          `[hicortex] Reconsolidation: ${entry.mem.id.slice(0, 8)} superseded_by ${candidate.id.slice(0, 8)} (mark-only)`,
        );
        continue;
      }

      // #393 guard-C: a genuine conflict — link ONLY. No status change on
      // either memory (both stay live so the consumer sees both truths), no
      // rewrite, no merge queue; the link is the guard both merge paths
      // consult. Ungated like the other mark actions (a weak flag is
      // recoverable; a weak merge is not).
      if (verdict.action === "conflicts") {
        markLink(entry.mem.id, candidate.id, "conflicts", pairCosine);
        conflictFlagged++;
        console.log(
          `[hicortex] Reconsolidation: ${entry.mem.id.slice(0, 8)} conflicts ${candidate.id.slice(0, 8)} ` +
            `(flag-only) — both kept live, never merged`,
        );
        continue;
      }

      if (verdict.action === "corrects") {
        const cosine = pairCosine;
        if (verdict.confidence < rewriteMinConfidence) {
          // Below the gate: mark-only, never rewrite. The
          // trigger stays live — it is the only carrier of the correction.
          belowGate++;
          markLink(entry.mem.id, candidate.id, "corrected_by", cosine);
          storage.updateMemory(db, entry.mem.id, { status: "retracted" });
          markedRetracted++;
          continue;
        }
        if (!isFactShapedTarget(entry.mem)) {
          // Decisions/plans/experiences are history, not error — mark only.
          markLink(entry.mem.id, candidate.id, "corrected_by", cosine);
          storage.updateMemory(db, entry.mem.id, { status: "retracted" });
          markedRetracted++;
          continue;
        }
        addTrigger(iterGroups, entry.mem, candidate, verdict.confidence, cosine, false);
      }
      // verdict "none" → nothing to do
    }

    // ---- #439 BOUNDARY: apply everything this candidate confirmed, NOW —
    // merges first, then rewrite groups (the order the old post-scan phases
    // used; preserves the existing tolerance where a merge loser that is
    // also a rewrite trigger stays absorbed while the rewrite still composes
    // its content). Each application is its own transaction
    // (mergeMemoryIds / applyRewriteGroup — group-internal atomicity
    // preserved); a busy capture lock defers merges to the same-run retry
    // list, everything else defers by holding the cursor below this
    // candidate (bounded to ONE candidate's pairs).
    if (!dryRun) {
      // Earlier lock-busy survivors retry FIRST (oldest verdicts land
      // first), ahead of this candidate's fresh confirmations.
      const mergeBatch = [...retryMerges.splice(0, retryMerges.length), ...iterMerges];
      if (mergeBatch.length > 0) {
        if (deadlineHit()) {
          deadlineStopped = true;
          // Fix round (#440 review, finding 1): never DROP the batch — it can
          // begin with lock-busy survivors contributed by EARLIER candidates
          // that the cursor has already passed. Re-queue for the final drain;
          // its hold-below-earliest-contributor (and the persist clamp) keeps
          // every un-applied pair re-detectable next run.
          retryMerges.push(...mergeBatch);
          boundaryHold = true;
          console.log(
            `[hicortex] Reconsolidation: ${mergeBatch.length} confirmed merge(s) re-queued for the final drain — run deadline reached`,
          );
        } else {
          const acquire = options.acquireLock ?? acquireCaptureLock;
          const release = await acquire(stateDir ?? hicortexHome(), 0);
          if (!release) {
            // Busy capture run — the batch rides the same-run retry list:
            // retried at the next boundary and once in the final drain. Not
            // a cursor hold yet (the lock may clear this run).
            retryMerges.push(...mergeBatch);
            console.warn(
              `[hicortex] Reconsolidation: capture lock busy — ${mergeBatch.length} confirmed merge(s) deferred to a retry this run`,
            );
          } else {
            try {
              let backupOk = true;
              if (!mergeWindowBackedUp) {
                try {
                  await takePreDedupBackup(db, stateDir ?? hicortexHome());
                  mergeWindowBackedUp = true;
                } catch (err) {
                  backupOk = false;
                  console.error(
                    `[hicortex] Reconsolidation: pre-merge backup failed ` +
                      `(${err instanceof Error ? err.message : String(err)}) — ${mergeBatch.length} merge(s) deferred`,
                  );
                }
              }
              if (!backupOk) {
                // Verdicts that cannot land must not keep being paid: stop
                // the scan. The batch re-queues for the final drain — a
                // TRANSIENT backup failure can still recover there; a
                // persistent one ends with the drain holding the cursor
                // below the earliest contributor (never just this candidate,
                // when retry survivors ride the batch).
                retryMerges.push(...mergeBatch);
                boundaryHold = true;
                stopScan = true;
              } else {
                for (let i = 0; i < mergeBatch.length; i++) {
                  const pair = mergeBatch[i];
                  // #405: the deadline stop-check between local merge
                  // transactions — a safe boundary; deferred pairs hold the
                  // cursor below this candidate and retry next run.
                  if (deadlineHit()) {
                    deadlineStopped = true;
                    // Fix round (#440 review, finding 1): the un-applied tail
                    // re-queues (it can contain earlier candidates' retry
                    // survivors) — the final drain applies or holds it.
                    retryMerges.push(...mergeBatch.slice(i));
                    boundaryHold = true;
                    console.log(
                      `[hicortex] Reconsolidation: ${mergeBatch.length - i} confirmed merge(s) re-queued for the final drain — run deadline reached`,
                    );
                    break;
                  }
                  const result = mergeMemoryIds(db, [pair.oldId, pair.newId]);
                  if (result.ok) {
                    mergePairsApplied++;
                    console.log(
                      `[hicortex] Reconsolidation: merged ${pair.oldId.slice(0, 8)} + ${pair.newId.slice(0, 8)} ` +
                        `into canonical ${result.canonicalId.slice(0, 8)} (${result.linksRepointed} link(s) re-pointed)`,
                    );
                  } else if (result.reason === "metadata_mismatch") {
                    skippedMetadataMismatch++;
                    console.log(
                      `[hicortex] Reconsolidation: merge of ${pair.oldId.slice(0, 8)} + ${pair.newId.slice(0, 8)} ` +
                        `skipped (metadata mismatch) — both kept`,
                    );
                  } else if (result.reason === "conflict_linked") {
                    // #393 guard-C: the pair is conflicts-linked (operator-planted
                    // or a prior verdict) — never blended; the cursor advances,
                    // this verdict was rendered.
                    conflictSkippedJudged++;
                    console.log(
                      `[hicortex] Reconsolidation: merge of ${pair.oldId.slice(0, 8)} + ${pair.newId.slice(0, 8)} ` +
                        `skipped (conflict-flagged) — both kept`,
                    );
                  }
                  // "no_members": a member vanished/was absorbed since the
                  // verdict — nothing to merge, nothing to hold; the cursor
                  // advances past it.
                }
              }
            } finally {
              release();
            }
          }
        }
      }

      if (iterGroups.size > 0) {
        // One rewrite call per group — the group's triggers are all THIS
        // candidate (#439: a target corrected by two different candidates
        // takes two sequential rewrites, one per boundary; the second call
        // composes the already-corrected story). A call that was never made
        // (budget/infra/deadline) defers the group — untouched, never
        // partially applied — and holds the cursor below this candidate.
        const contracts = new Map<string, RewriteContract | null>(); // null = contract failed
        let rewritesDeferred = false;
        for (const group of iterGroups.values()) {
          if (deadlineHit()) {
            deadlineStopped = true;
            rewritesDeferred = true;
            break;
          }
          if (!budget.use(RECONSOLIDATION_STAGE_LABEL)) {
            rewritesDeferred = true;
            stopScan = true;
            break;
          }
          const triggersArg = group.triggers.map((t) => ({ id: t.id, content: t.memory.content }));
          let contract: RewriteContract | null = null;
          let infraError = false;
          try {
            const r = await llm.complete(buildRewritePrompt(group.target.content, triggersArg));
            contract = parseRewriteReply(r.text, group.triggers.map((t) => t.id), group.target.content);
            budget.recordUsage(RECONSOLIDATION_STAGE_LABEL, r.usage);
          } catch {
            infraError = true;
          }
          if (infraError) {
            skippedInfra++;
            rewritesDeferred = true; // group NOT marked, NOT rewritten — retried next run
            stopScan = true; // verdicts past this hold could not advance the cursor anyway
            break;
          }
          contracts.set(group.targetId, contract);
          if (!contract) contractFailed++;
        }

        if (rewritesDeferred) {
          boundaryHold = true;
        } else {
          // Multi-target keep rule WITHIN the boundary: the shared trigger is
          // the current candidate, so every group it touches resolves here —
          // absorbed only if EVERY contract says absorb (any keep keeps).
          const finalOutcome = new Map<string, "absorb" | "keep">();
          for (const contract of contracts.values()) {
            if (!contract) continue;
            for (const t of contract.triggers) {
              if (t.disposition === "keep" || finalOutcome.get(t.id) === "keep") finalOutcome.set(t.id, "keep");
              else finalOutcome.set(t.id, "absorb");
            }
          }
          // Counted from APPLIED groups only (a deferred group's dispositions
          // never took effect); a trigger in several applied groups counts once.
          const appliedOutcome = new Map<string, "absorb" | "keep">();
          for (const group of iterGroups.values()) {
            const contract = contracts.get(group.targetId);
            if (contract === undefined) continue; // pending group — untouched this run
            if (contract === null) {
              // Failed rewrite contract → whole group mark-only, never a partial
              // apply. Content untouched, NO trigger absorbed.
              try {
                applyMarkOnlyGroup(db, group);
              } catch (err) {
                console.warn(
                  `[hicortex] reconsolidation: mark-only fallback failed for ${group.targetId.slice(0, 8)} — ${err instanceof Error ? err.message : String(err)}`,
                );
                skippedInfra++;
                boundaryHold = true; // retried next run
                continue;
              }
              markedRetracted++;
              console.log(
                `[hicortex] Reconsolidation: rewrite contract failed for ${group.targetId.slice(0, 8)} — group degraded to mark-only`,
              );
              continue;
            }
            let applied = false;
            try {
              applied = await applyRewriteGroup(db, group, contract, finalOutcome, embedFn);
            } catch (err) {
              console.warn(
                `[hicortex] reconsolidation: rewrite apply failed for ${group.targetId.slice(0, 8)} — ${err instanceof Error ? err.message : String(err)}`,
              );
            }
            if (!applied) {
              skippedInfra++; // defensive absorbed-target guard, or an apply error — retry next run
              boundaryHold = true;
              continue;
            }
            rewritten++;
            for (const t of contract.triggers) {
              const outcome = finalOutcome.get(t.id) ?? "keep";
              if (outcome === "keep" || appliedOutcome.get(t.id) === "keep") appliedOutcome.set(t.id, "keep");
              else appliedOutcome.set(t.id, "absorb");
            }
          }
          for (const outcome of appliedOutcome.values()) {
            if (outcome === "absorb") absorbed++;
            else keptLinked++;
          }
        }
      }
    }

    // #439 cursor advance: past this candidate ONLY when its confirmed work
    // landed (or was refused-with-verdict-rendered). Once anything deferred,
    // the latch holds the cursor below that candidate for the rest of the
    // run — a later iteration must never advance past an earlier hold.
    if (boundaryHold) cursorHold = true;
    if (!cursorHold) cursor = candidate.__rowid;

    // #402/#439: persist after EVERY candidate — AFTER the boundary apply,
    // so the checkpoint only ever crosses candidates whose work landed. A
    // SIGKILL between persists re-detects at most the in-flight candidate.
    persistCursor();
    if (stopScan || deadlineStopped) break;
  }

  if (deadlineStopped) {
    console.log(
      `[hicortex] Reconsolidation: run deadline reached (nightlyTimeBudgetMinutes) — ` +
        `scan stopped at cursor ${cursor}; the next run resumes from there`,
    );
  }

  // ---- #439 final drain: lock-busy merge survivors get ONE more attempt
  // right after the scan (the retry list is same-run only — everything else
  // applied at its boundary). Still busy (or the deadline/backup refuses) →
  // the pairs stay un-applied, counted, and the cursor holds below the
  // earliest contributing candidate (dup-over-loss; logged).
  if (!dryRun && retryMerges.length > 0) {
    const batch = retryMerges.splice(0, retryMerges.length);
    // Hold below the earliest contributor of the UN-APPLIED tail only (fix
    // round, minor review note: the old whole-batch min over-held past pairs
    // that had just applied in the same loop).
    const holdBelow = (fromIndex: number): void => {
      cursor = Math.min(cursor, Math.min(...batch.slice(fromIndex).map((p) => p.candidateRowid)) - 1);
    };
    if (deadlineHit()) {
      deadlineStopped = true;
      mergePairsDeferred += batch.length;
      holdBelow(0);
      console.log(
        `[hicortex] Reconsolidation: ${batch.length} confirmed merge(s) deferred — run deadline reached`,
      );
    } else {
      const acquire = options.acquireLock ?? acquireCaptureLock;
      const release = await acquire(stateDir ?? hicortexHome(), 0);
      if (!release) {
        mergePairsDeferred += batch.length;
        holdBelow(0);
        console.warn(
          `[hicortex] Reconsolidation: capture lock busy at the final drain — ` +
            `${batch.length} confirmed merge(s) deferred to next run`,
        );
      } else {
        try {
          let backupOk = true;
          if (!mergeWindowBackedUp) {
            try {
              await takePreDedupBackup(db, stateDir ?? hicortexHome());
              mergeWindowBackedUp = true;
            } catch (err) {
              backupOk = false;
              console.error(
                `[hicortex] Reconsolidation: pre-merge backup failed ` +
                  `(${err instanceof Error ? err.message : String(err)}) — ${batch.length} merge(s) deferred`,
              );
            }
          }
          if (!backupOk) {
            mergePairsDeferred += batch.length;
            holdBelow(0);
          } else {
            for (let i = 0; i < batch.length; i++) {
              const pair = batch[i];
              if (deadlineHit()) {
                deadlineStopped = true;
                mergePairsDeferred += batch.length - i;
                holdBelow(i);
                console.log(
                  `[hicortex] Reconsolidation: ${batch.length - i} confirmed merge(s) deferred — run deadline reached`,
                );
                break;
              }
              const result = mergeMemoryIds(db, [pair.oldId, pair.newId]);
              if (result.ok) {
                mergePairsApplied++;
                console.log(
                  `[hicortex] Reconsolidation: merged ${pair.oldId.slice(0, 8)} + ${pair.newId.slice(0, 8)} ` +
                    `into canonical ${result.canonicalId.slice(0, 8)} (${result.linksRepointed} link(s) re-pointed)`,
                );
              } else if (result.reason === "metadata_mismatch") {
                skippedMetadataMismatch++;
                console.log(
                  `[hicortex] Reconsolidation: merge of ${pair.oldId.slice(0, 8)} + ${pair.newId.slice(0, 8)} ` +
                    `skipped (metadata mismatch) — both kept`,
                );
              } else if (result.reason === "conflict_linked") {
                conflictSkippedJudged++;
                console.log(
                  `[hicortex] Reconsolidation: merge of ${pair.oldId.slice(0, 8)} + ${pair.newId.slice(0, 8)} ` +
                    `skipped (conflict-flagged) — both kept`,
                );
              }
              // "no_members": a member vanished/was absorbed since the
              // verdict — nothing to merge, nothing to hold.
            }
          }
        } finally {
          release();
        }
      }
    }
  }

  // ---- #393 guard-C zone reorder: the deterministic merge zone (pairs >=
  // the ceiling) runs LAST — after the scan (which includes every #439
  // boundary apply: judged merges + rewrites). Judgment outranks the
  // deterministic sweep: verdicts, marks, and binds land first, and the zone
  // merges only what no verdict claimed. With the zone first, a >=0.92
  // genuine-conflict pair was blended before the judge ever saw it
  // (canonical = oldest, the newer truth erased — the planted-eval harm);
  // running it last means a `conflicts` bind set by THIS run's scan guards
  // the SAME run's zone. LLM-free and budget-free — an LLM-less night still
  // drains duplicates (a deadline-deferred cluster re-detects next run at
  // zero token cost — content-based discovery, no cursor involvement). Its
  // own short lock window, pre-merge backup, and #405 deadline stop-check;
  // fail-soft, never a throw.
  const merges = await runDeterministicMergeZone(db, {
    stateDir: stateDir ?? hicortexHome(),
    threshold: autoMergeThreshold,
    dryRun,
    acquireLock: options.acquireLock,
    deadline,
  });

  // Report snapshot: the deterministic band (from the zone's own numbers —
  // losers are merge verdicts at confidence 1.0; the zone persists the
  // cumulative copy itself) plus this run's judged bands.
  const bandStats: Record<string, ResolutionBandStat> = {};
  {
    // #405: recorded whenever the zone ran (the old max_merges>0 gate was a
    // 0=disabled switch — the switch is gone; a clean corpus records zeros,
    // same as the old default-config behavior).
    const det = emptyBandStat();
    det.pairs = merges.losers_merged;
    det.merge = merges.losers_merged;
    det.conf_sum = merges.losers_merged;
    if (merges.skipped_metadata_mismatch > 0) {
      det.metadata_skipped = merges.skipped_metadata_mismatch;
    }
    bandStats[`>=${autoMergeThreshold}`] = det;
  }
  for (const [label, stat] of runBands) bandStats[label] = stat;

  if (!dryRun) {
    // #401/#439: the authoritative FINAL write — the mid-scan persists above
    // are checkpoints; this one applies the final-drain cursor hold (already
    // folded into `cursor`) and the scan high-water. The retry floor is
    // applied defensively too: the drain splices retryMerges empty on every
    // path, but a non-empty list here would mean a confirmed merge stranded
    // behind the cursor — clamp, never write past un-applied work.
    updateState((s) => {
      s.reconsolidationCursor = clampedCursor();
      s.reconsolidationScannedRowid = Math.max(scannedRowidHighwater, s.reconsolidationScannedRowid ?? 0);
      // Cumulative judged-band accumulation (#392) — the zone already
      // persisted the deterministic band under its own label.
      if (runBands.size > 0) {
        const cumulative = s.resolutionBandStats ?? {};
        for (const [label, run] of runBands) {
          const b = cumulative[label] ?? emptyBandStat();
          accumulateBandStat(b, run);
          cumulative[label] = b;
        }
        s.resolutionBandStats = cumulative;
      }
    }, stateDir);
  }

  if (rows.length > 0 || mergePairsApplied > 0 || mergeBelowGate > 0) {
    console.log(
      `[hicortex] Reconsolidation: ${scanned} scanned, ${pairsEvaluated} pairs evaluated ` +
        `(${pairsReevaluated} re-judged / ${pairsNew} new), ` +
        `${rewritten} rewritten (${absorbed} triggers absorbed, ${keptLinked} kept), ` +
        `${mergePairsApplied} pair(s) merged (${mergePairsDeferred} deferred), ` +
        `${markedSuperseded} superseded, ` +
        `${markedRetracted} retracted (${belowGate} below gate, ${mergeBelowGate} merge below gate, ` +
        `${contractFailed} contract failed), ${skippedInfra} infra-skipped, ${skippedIdempotent} ` +
        `already-linked, ${skippedAbsorbed} absorbed-skip, ${skippedAboveCeiling} above ceiling, ` +
        `${explicitVerified} explicit verified, ` +
        `${explicitDivergent} explicit divergent, scout ${scoutScanned} scanned / ` +
        `${scoutCorrectionShaped} correction-shaped / ${scoutCandidatesFound} candidate pair(s), ` +
        `${conflictFlagged} conflict-flagged, ${conflictSkippedJudged + merges.skipped_conflict} conflict-skipped ` +
        `(cursor ${cursor})`,
    );
  }

  return {
    scanned,
    pairs_evaluated: pairsEvaluated,
    pairs_discovered: pairsDiscovered,
    pairs_discovered_unlinked: pairsDiscoveredUnlinked,
    rewritten,
    absorbed,
    kept_linked: keptLinked,
    marked_superseded: markedSuperseded,
    marked_retracted: markedRetracted,
    below_gate: belowGate,
    contract_failed: contractFailed,
    skipped_infra: skippedInfra,
    skipped_idempotent: skippedIdempotent,
    explicit_verified: explicitVerified,
    explicit_divergent: explicitDivergent,
    cursor,
    pairs_reevaluated: pairsReevaluated,
    pairs_new: pairsNew,
    skipped_absorbed: skippedAbsorbed,
    merge_pairs_deferred: mergePairsDeferred,
    merges,
    merge_pairs_applied: mergePairsApplied,
    merge_below_gate: mergeBelowGate,
    skipped_above_ceiling: skippedAboveCeiling,
    skipped_metadata_mismatch: skippedMetadataMismatch,
    conflict_flagged: conflictFlagged,
    conflict_skipped: conflictSkippedJudged + merges.skipped_conflict,
    scout_scanned: scoutScanned,
    scout_correction_shaped: scoutCorrectionShaped,
    scout_candidates_found: scoutCandidatesFound,
    band_stats: bandStats,
  };
}

/** Mark-only fallback for a group: links + retracted status, content + triggers untouched. */
function applyMarkOnlyGroup(db: Database.Database, group: RewriteGroup): void {
  const tx = db.transaction(() => {
    for (const t of group.triggers) {
      if (!hasLink(db, group.targetId, t.id, "corrected_by")) {
        storage.addLink(db, group.targetId, t.id, "corrected_by", t.cosine ?? 1.0);
      }
    }
    storage.updateMemory(db, group.targetId, { status: "retracted" });
  });
  tx();
}

/**
 * Apply one rewrite group in ONE transaction (AC3): memory_history row, target
 * content + status `corrected`, vector replaced, tags cleared + domain NULL
 * (re-classified next nightly), corrected_by link per trigger, per-trigger
 * disposition (absorb → status + vector + FTS dropped; keep → untouched).
 */
async function applyRewriteGroup(
  db: Database.Database,
  group: RewriteGroup,
  contract: RewriteContract,
  finalOutcome: Map<string, "absorb" | "keep">,
  embedFn: EmbedFn,
): Promise<boolean> {
  // Defensive (#384): never rewrite an absorbed row (it has no vector/FTS
  // row — a rewrite would resurrect dead evidence). Unreachable via the
  // normal paths (absorbed targets are neither neighbors — no vector — nor
  // explicit-mark targets — rejected at ingest); counted skipped_infra by
  // the caller when hit.
  const currentTarget = storage.getMemory(db, group.targetId);
  if (!currentTarget || currentTarget.status === "absorbed") return false;
  const target = group.target; // content snapshot the verdicts judged
  // evidence_id = the latest-created trigger of the group — the same trigger
  // the footer date derives from (documented semantics, #384).
  const latest = [...group.triggers].sort((a, b) =>
    a.memory.created_at === b.memory.created_at
      ? a.id.localeCompare(b.id)
      : a.memory.created_at.localeCompare(b.memory.created_at),
  )[group.triggers.length - 1];
  const dateISO = latest.memory.created_at.slice(0, 10);
  const footer = buildCorrectionFooter(target.content, dateISO);
  const newContent = `${contract.rewritten}\n\n${footer}`;
  // Embeddings are async — computed BEFORE the sync transaction.
  const newEmbedding = await embedFn(newContent);
  const triggersJson = JSON.stringify(
    group.triggers.map((t) => ({
      id: t.id,
      disposition: finalOutcome.get(t.id) ?? "keep",
      confidence: t.confidence,
    })),
  );
  // History confidence: the group's MINIMUM trigger confidence — the weakest
  // verdict that gated this rewrite (conservative audit).
  const minConfidence = Math.min(...group.triggers.map((t) => t.confidence));

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO memory_history
       (memory_id, old_content, new_content, prev_status, new_status, triggers_json,
        evidence_id, confidence, cause, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      target.id,
      target.content,
      newContent,
      // prev_status from the LIVE row, not the detection snapshot — a
      // below-gate mark earlier in this same run may have retracted it.
      currentTarget.status ?? null,
      "corrected",
      triggersJson,
      latest.id,
      minConfidence,
      "reconsolidation",
      nowIso(),
    );
    // Content + status + domain NULL in one UPDATE (fires the FTS update
    // trigger — the target still HAS an FTS row).
    storage.updateMemory(db, target.id, { content: newContent, status: "corrected", domain: null });
    db.prepare("DELETE FROM memory_tags WHERE memory_id = ?").run(target.id);
    replaceMemoryVector(db, target.id, newEmbedding);
    for (const t of group.triggers) {
      if (!hasLink(db, target.id, t.id, "corrected_by")) {
        storage.addLink(db, target.id, t.id, "corrected_by", t.cosine ?? 1.0);
      }
    }
    for (const t of group.triggers) {
      if (finalOutcome.get(t.id) === "absorb") absorbTrigger(db, t.id);
    }
  });
  tx();
  console.log(
    `[hicortex] Reconsolidation: rewrote ${target.id.slice(0, 8)} (corrected; ` +
      `${group.triggers.length} trigger(s), evidence ${latest.id.slice(0, 8)})`,
  );
  return true;
}

// ---------------------------------------------------------------------------
// Rollback (AC8) — reuses the rewrite mechanics, never a reimplementation
// ---------------------------------------------------------------------------

export interface RollbackResult {
  historyRowId: number;
  memoryId: string;
  restoredStatus: string | null;
  unabsorbed: string[];
  newHistoryRowId: number;
}

/**
 * Roll back ONE rewrite history row: restore the recorded prior content and
 * prior status via the same mechanics as the rewrite (re-embed, clear tags +
 * domain NULL), reverse every absorb recorded in triggers_json (status
 * restored, vector re-embedded, FTS row re-inserted), and write the rollback's
 * own history row (cause `rollback`).
 *
 * Newest-first discipline: the row must be the NEWEST history entry for its
 * memory (rolling back an older entry under a newer one would clobber — undo
 * the newest first). The rollback row itself can be rolled back (undo the
 * undo), which is what makes the chain navigable.
 */
export async function rollbackHistoryRow(
  db: Database.Database,
  historyRowId: number,
  embedFn: EmbedFn,
): Promise<RollbackResult> {
  const row = getHistoryRow(db, historyRowId);
  if (!row) {
    throw new Error(`history row not found: ${historyRowId}`);
  }
  const newer = (
    db
      .prepare("SELECT COUNT(*) AS n FROM memory_history WHERE memory_id = ? AND id > ?")
      .get(row.memory_id, historyRowId) as { n: number }
  ).n;
  if (newer > 0) {
    throw new Error(
      `history row ${historyRowId} is not the newest entry for memory ${row.memory_id.slice(0, 8)} — ` +
      `roll back the newest entry first (history rows are undone newest-first)`,
    );
  }
  const mem = storage.getMemory(db, row.memory_id);
  if (!mem) {
    throw new Error(`memory ${row.memory_id} no longer exists — nothing to roll back`);
  }

  let triggers: Array<{ id: string; disposition: string }> = [];
  if (row.triggers_json) {
    try {
      triggers = JSON.parse(row.triggers_json) as Array<{ id: string; disposition: string }>;
    } catch {
      triggers = []; // unreadable trigger record — un-absorb impossible, content restore still proceeds
    }
  }

  // Async embedding work BEFORE the sync transaction: the restored target
  // content + every currently-absorbed trigger's (untouched) content.
  const restoredEmbedding = await embedFn(row.old_content);
  const unabsorbEmbeddings = new Map<string, Float32Array>();
  for (const t of triggers) {
    // Disposition values are "absorb"/"keep" (the rewrite contract's
    // vocabulary) — distinct from the STATUS "absorbed" written on the row.
    if (t.disposition !== "absorb") continue;
    const triggerMem = storage.getMemory(db, t.id);
    if (triggerMem && triggerMem.status === "absorbed") {
      unabsorbEmbeddings.set(t.id, await embedFn(triggerMem.content));
    }
  }

  const tx = db.transaction(() => {
    const result = db
      .prepare(
        `INSERT INTO memory_history
         (memory_id, old_content, new_content, prev_status, new_status, triggers_json,
          evidence_id, confidence, cause, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.memory_id,
        mem.content,
        row.old_content,
        mem.status ?? null,
        row.prev_status,
        row.triggers_json,
        row.evidence_id,
        row.confidence,
        "rollback",
        nowIso(),
      );
    storage.updateMemory(db, row.memory_id, {
      content: row.old_content,
      status: row.prev_status ?? null,
      domain: null,
    });
    db.prepare("DELETE FROM memory_tags WHERE memory_id = ?").run(row.memory_id);
    replaceMemoryVector(db, row.memory_id, restoredEmbedding);
    for (const [triggerId, embedding] of unabsorbEmbeddings) {
      unabsorbTrigger(db, triggerId, embedding);
    }
    return result.lastInsertRowid as number;
  });
  const newHistoryRowId = tx();

  console.log(
    `[hicortex] history: rolled back row ${historyRowId} — memory ${row.memory_id.slice(0, 8)} restored ` +
      `to its prior content/status, ${unabsorbEmbeddings.size} trigger(s) un-absorbed ` +
      `(new history row ${newHistoryRowId})`,
  );
  return {
    historyRowId,
    memoryId: row.memory_id,
    restoredStatus: row.prev_status ?? null,
    unabsorbed: [...unabsorbEmbeddings.keys()],
    newHistoryRowId,
  };
}

// ---------------------------------------------------------------------------
// `hicortex history` CLI runner (dedup command pattern: flags in cli.ts,
// runner here; listing is read-only, mutation only with --rollback)
// ---------------------------------------------------------------------------

export interface HistoryCliOptions {
  /** DB path override (tests / snapshot verification). Defaults to resolveDbPath(). */
  dbPath?: string;
  /** Memory id (8-char prefix or full UUID) whose history to list. */
  memoryId?: string;
  /** memory_history.id to roll back. */
  rollbackId?: number;
  /** Embed fn injection for tests; production lazy-loads the ONNX embedder. */
  embedFn?: EmbedFn;
}

function head(text: string, max = 100): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max)}…` : single;
}

/** List one memory's rewrite events (dates, before/after heads, dispositions, confidence). */
function printHistory(rows: MemoryHistoryRow[], memoryId: string): void {
  if (rows.length === 0) {
    console.log(`[hicortex] No history recorded for memory ${memoryId.slice(0, 8)}.`);
    return;
  }
  console.log(`[hicortex] History for memory ${memoryId.slice(0, 8)} (${rows.length} event(s), oldest first):`);
  for (const r of rows) {
    console.log(`  #${r.id}  ${r.created_at}  cause=${r.cause}  ${r.prev_status ?? "active"} → ${r.new_status ?? "active"}`);
    console.log(`     before: ${head(r.old_content)}`);
    console.log(`      after: ${head(r.new_content)}`);
    if (r.confidence !== null && r.confidence !== undefined) {
      console.log(`     confidence: ${r.confidence}`);
    }
    if (r.triggers_json) {
      try {
        const triggers = JSON.parse(r.triggers_json) as Array<{ id: string; disposition: string }>;
        for (const t of triggers) {
          console.log(`     trigger ${t.id.slice(0, 8)}: ${t.disposition}`);
        }
      } catch {
        console.log(`     triggers: (unreadable record)`);
      }
    }
    if (r.evidence_id) console.log(`     evidence: ${r.evidence_id.slice(0, 8)}`);
  }
}

/**
 * Runner for `hicortex history <id>` / `hicortex history --rollback <n>`.
 * Returns a process exit code (0 success, 1 failure); throws only on
 * unexpected infra errors (cli.ts prints those).
 */
export async function runHistoryCommand(options: HistoryCliOptions): Promise<number> {
  if (options.rollbackId === undefined && !options.memoryId) {
    console.error(
      "[hicortex] history: pass a memory id to list its history, or --rollback <history-row-id>.",
    );
    return 1;
  }
  const db = initDb(resolveDbPath(options.dbPath));
  try {
    if (options.rollbackId !== undefined) {
      // Lazy-load the ONNX embedder ONLY when a rollback actually needs to
      // re-embed (listing never loads it).
      const embedFn = options.embedFn ?? (await import("./embedder.js")).embed;
      await rollbackHistoryRow(db, options.rollbackId, embedFn);
      return 0;
    }
    const resolved = storage.resolveMemoryId(db, options.memoryId as string);
    if (!resolved) {
      console.error(`[hicortex] history: memory not found or ambiguous: ${options.memoryId}`);
      return 1;
    }
    printHistory(getMemoryHistory(db, resolved), resolved);
    return 0;
  } finally {
    db.close();
  }
}
