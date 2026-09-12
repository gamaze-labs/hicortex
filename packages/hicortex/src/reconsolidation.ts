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
 * `merge` | `corrects` | `supersedes` | `none`; at/above the ceiling the
 * deterministic merge zone (dedup.ts runDeterministicMergeZone — LLM-free,
 * budget-free) owns the pair. The merge disposition reuses the dedup core's
 * execution (canonical pick, link re-point, dedup_log, metadata rails); a
 * merge verdict below `correctionRewriteMinConfidence` keeps both memories.
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
import { l2ToCosine } from "./retrieval.js";
import * as storage from "./storage.js";
import { loadState, updateState } from "./state.js";
import { resolveDbPath, initDb } from "./db.js";
import { acquireCaptureLock } from "./capture.js";
import { hicortexHome } from "./paths.js";
import {
  runDeterministicMergeZone,
  mergeMemoryIds,
  takePreDedupBackup,
  DEFAULT_DEDUP_MERGE_THRESHOLD,
  DEFAULT_DEDUP_NIGHTLY_MAX_MERGES,
} from "./dedup.js";

// ---------------------------------------------------------------------------
// Constants + status vocabulary
// ---------------------------------------------------------------------------

/** Stage label used for every budget.use()/recordUsage() call (#384). */
export const RECONSOLIDATION_STAGE_LABEL = "reconsolidation";

/**
 * Default minimum COSINE similarity for a correction candidate pair. Lower
 * than the supersession stage's 0.80 on purpose: a retraction often rides
 * inside an otherwise unrelated memory (the field failure that opened this
 * issue), so the neighborhood gate must be a touch wider while the LLM
 * verdict + confidence gate carry the precision load.
 */
export const DEFAULT_CORRECTION_MIN_SIMILARITY = 0.75;

/**
 * Default minimum verdict confidence for the REWRITE fork. Below this a
 * `corrects` verdict degrades to mark-only — a weak mark is recoverable, a
 * weak rewrite is corruption.
 */
export const DEFAULT_CORRECTION_REWRITE_MIN_CONFIDENCE = 0.8;

/**
 * Default wall-clock bound for the stage, in minutes (#401). Checked at the
 * top of the candidate scan loop (and before each rewrite contract call); on
 * expiry the scan breaks cleanly at the last fully-considered candidate and
 * the next run resumes from the persisted cursor. 120 sits safely under any
 * sane process-level nightly timeout. 0 disables the bound. Invalid →
 * default.
 */
export const DEFAULT_RECONSOLIDATION_MAX_MINUTES = 120;

/**
 * Default per-run classify-call ceiling for the stage (#401) — the
 * supersessionMaxCalls pattern with a NON-ZERO default ON PURPOSE: that
 * knob's 0=unlimited default is what let the first full-corpus pass grow
 * unbounded. Counts EVERY classify-tier call the stage makes (mark
 * verifications, pair verdicts, rewrite contracts). 0 disables the cap.
 * Invalid → default.
 */
export const DEFAULT_RECONSOLIDATION_MAX_CALLS = 600;

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
  use(stage: string, count?: number): boolean;
  recordUsage(stage: string, usage: LlmUsage | undefined): void;
}

export interface ReconsolidationOptions {
  /** correctionMinSimilarity (config; default 0.75). Invalid → default. */
  minSimilarity?: number;
  /** correctionRewriteMinConfidence (config; default 0.80). Invalid → default. */
  rewriteMinConfidence?: number;
  /**
   * dedupAutoMergeThreshold (config; default 0.92; legacy dedupMergeThreshold
   * honored by nightly.ts when the new key is absent). The deterministic/LLM
   * boundary of the unified resolution pass (#392): pairs at/above it merge
   * via the LLM-free zone, pairs in [floor, ceiling) get the verdict.
   * Invalid → default.
   */
  autoMergeThreshold?: number;
  /**
   * dedupNightlyMaxMerges (config; default 250; 0 disables the merge
   * machinery). Counts merge OPERATIONS per run — zone clusters + judged
   * pair merges against ONE cap. Invalid → default.
   */
  maxMerges?: number;
  /**
   * reconsolidationMaxMinutes (config; default 120; 0 disables) — wall-clock
   * deadline for the stage (#401), measured from stage start. Checked at the
   * top of the candidate scan loop and before each rewrite contract call; on
   * expiry the scan breaks cleanly — the cursor already points at the last
   * fully-considered candidate, so the run ends consistent and the next
   * nightly resumes from it. Invalid → default.
   */
  maxMinutes?: number;
  /**
   * reconsolidationMaxCalls (config; default 600; 0 disables) — per-run
   * ceiling on classify-tier calls for the stage (#401), the
   * supersessionMaxCalls pattern with a NON-ZERO default (the 0=unlimited
   * default there is what removed the last per-stage bound). Exhaustion
   * mid-neighbor-loop or mid-rewrite-phase stops/defers cleanly at the
   * current candidate boundary. Invalid → default.
   */
  maxCalls?: number;
  /**
   * Capture-lock acquirer override (tests) — the deterministic zone and the
   * judged-merge phase each hold a short lock window. Defaults to the real
   * capture.ts lock. DedupOptions.acquireLock pattern.
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

/** True when a superseded_by OR corrected_by link already exists between the pair, either direction. */
function alreadyResolutionLinked(db: Database.Database, oldId: string, newId: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM memory_links WHERE relationship IN ('superseded_by', 'corrected_by')
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
 * The unified resolution verdict (#392): ONE call per unlinked pair decides
 * how the newer memory relates to the older — merge (same underlying
 * fact/verdict, differing in wording/qualifiers), corrects, supersedes, or
 * none (related but distinct).
 */
export type ResolutionAction = "merge" | "corrects" | "supersedes" | "none";

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
    `- "none": unrelated, merely similar, or both can still be true (an addition or elaboration).\n\n` +
    `Reply with ONLY a JSON object, no prose: ` +
    `{"action": "merge" | "corrects" | "supersedes" | "none", "confidence": <number between 0 and 1>}`
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
  if (action !== "merge" && action !== "corrects" && action !== "supersedes" && action !== "none") return null;
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
  return { pairs: 0, merge: 0, corrects: 0, supersedes: 0, none: 0, merge_below_gate: 0, conf_sum: 0 };
}

/** Add a run's per-band counts into a cumulative record (in place). */
function accumulateBandStat(cumulative: ResolutionBandStat, run: ResolutionBandStat): void {
  cumulative.pairs += run.pairs;
  cumulative.merge += run.merge;
  cumulative.corrects += run.corrects;
  cumulative.supersedes += run.supersedes;
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

async function classifyPair(
  llm: LlmClient,
  oldContent: string,
  newContent: string,
): Promise<{ verdict: CorrectionVerdict | null; usage: LlmUsage | undefined }> {
  try {
    const r = await llm.completeClassify(buildCorrectionVerdictPrompt(oldContent, newContent));
    return { verdict: parseCorrectionVerdict(r.text), usage: r.usage };
  } catch {
    return { verdict: null, usage: undefined };
  }
}

/**
 * Nightly reconsolidation stage (#384, #392 — THE unified resolution stage).
 *
 * Phase 0 (#392): the deterministic merge zone (pairs >= the ceiling) runs
 * first — LLM-free, budget-free, own lock/backup/cap.
 *
 * Scan: every memory with rowid > reconsolidationCursor (no shape filter;
 * absorbed candidates are skipped — invisible memories are not re-judged).
 * Each candidate's pairs: incoming explicit marks (verified once, AC7) then
 * up-to-5 older KNN neighbors in [floor, ceiling) (verdict call per unlinked
 * pair, AC2 — pairs at/above the ceiling are counted, never judged). Confirmed
 * `corrects` pairs above the confidence gate on fact-shaped targets group by
 * target into ONE rewrite call each (AC3); confirmed `merge` pairs queue for
 * the merge phase; everything else is mark-only.
 *
 * Merge phase (#392): queued pairs merge through the dedup core under one
 * lock/backup window, capped with the zone by dedupNightlyMaxMerges. A pair
 * that cannot apply keeps both memories and holds the cursor.
 *
 * Cursor discipline mirrors stageSupersession: the cursor advances past a
 * candidate once its neighbor set has been considered, regardless of infra
 * skips — EXCEPT when rewrite groups or confirmed merges could not be applied
 * (budget exhausted / rewrite-call infra error / merge cap or lock): the
 * cursor then holds BELOW the earliest candidate contributing to the
 * un-applied work, so those pairs are re-detected next run (dup-over-loss —
 * an un-marked, un-rewritten, un-merged confirmed resolution must never be
 * silently dropped by the cursor passing it).
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
  const maxMerges = validNumber(
    options.maxMerges,
    DEFAULT_DEDUP_NIGHTLY_MAX_MERGES,
    (n) => n >= 0,
  );
  const maxMinutes = validNumber(
    options.maxMinutes,
    DEFAULT_RECONSOLIDATION_MAX_MINUTES,
    (n) => n >= 0,
  );
  const maxCalls = validNumber(
    options.maxCalls,
    DEFAULT_RECONSOLIDATION_MAX_CALLS,
    (n) => n >= 0,
  );

  // ---- #401 runtime bounds. The wall-clock deadline is measured from stage
  // start (the deterministic zone's runtime counts against it — the binding
  // constraint must be THIS knob, never the process-level backstop).
  const deadlineAt = maxMinutes > 0 ? Date.now() + Math.round(maxMinutes * 60_000) : Infinity;
  const deadlineHit = (): boolean => Date.now() >= deadlineAt;

  // ---- #392 phase 0: the deterministic merge zone (pairs >= the ceiling),
  // LLM-free and budget-free — an LLM-less night still drains duplicates. Its
  // own short lock window, pre-merge backup, and pacing cap; fail-soft, never
  // a throw. Runs FIRST so the scan below never sees the pairs it owns.
  const merges = await runDeterministicMergeZone(db, {
    stateDir: stateDir ?? hicortexHome(),
    threshold: autoMergeThreshold,
    maxMerges,
    dryRun,
    acquireLock: options.acquireLock,
  });

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
  let cursor = startCursor;

  // #392: confirmed merge verdicts queued for the merge phase (applied AFTER
  // the scan, under one lock/backup window). candidateRowid = the NEWER
  // memory's rowid — the cursor-hold anchor when a queued merge cannot apply.
  interface QueuedMerge {
    oldId: string;
    newId: string;
    candidateRowid: number;
  }
  const queuedMerges: QueuedMerge[] = [];

  // #392 cursor-hold anchor, shared by the merge phase and the rewrite phase:
  // un-applied work holds the cursor BELOW the earliest contributing
  // candidate so the pairs are re-detected next run (dup-over-loss).
  let pendingMinRowid: number | null = null;

  // Links created by THIS stage in THIS run — lets the explicit-mark pass
  // distinguish operator marks (pre-existing) from stage output.
  const linksCreatedThisRun = new Set<string>();
  const markLink = (oldId: string, newId: string, relationship: string, strength: number): void => {
    storage.addLink(db, oldId, newId, relationship, strength);
    linksCreatedThisRun.add(`${oldId}|${newId}`);
  };

  // ---- #401: mid-scan cursor persistence. Called at EVERY scan-loop exit
  // path (deadline, call/budget cap, mark-verify budget stop, discovery
  // failure) AND after every fully-considered candidate, so a killed run
  // loses at most the candidate in flight. The end-of-stage updateState
  // below stays the authoritative final write (it also applies the
  // pendingMinRowid hold — that variable is only ever set AFTER the scan
  // loop, so it is null at every call site here). updateState is
  // load→mutate→temp-rename atomic.
  let callsUsed = 0;
  let deadlineStopped = false;
  let callCapStopped = false;
  // #402 follow-up (reviewer note 1): the hard-kill orphan floor. Queued
  // merges and open rewrite groups are applied only in the POST-scan
  // phases — until then their verdicts exist only in memory, and a
  // SIGKILL/OOM between two persists would strand them BEHIND the persisted
  // cursor (the next run would skip them forever). This tracks the smallest
  // candidate rowid contributing to queued-but-unapplied work;
  // persistCursor clamps every checkpoint below it so a resumed run
  // re-detects the pairs (dup-over-loss). Deliberately SEPARATE from the
  // post-loop pendingMinRowid hold above — different lifetime, different
  // writers.
  let scanPendingMinRowid: number | null = null;
  const notePendingRowid = (rowid: number): void => {
    scanPendingMinRowid =
      scanPendingMinRowid === null ? rowid : Math.min(scanPendingMinRowid, rowid);
  };
  const persistCursor = (): void => {
    if (dryRun) return;
    const checkpoint =
      scanPendingMinRowid !== null ? Math.min(cursor, scanPendingMinRowid - 1) : cursor;
    updateState((s) => {
      s.reconsolidationCursor = checkpoint;
    }, stateDir);
  };

  const groups = new Map<string, RewriteGroup>();
  const addTrigger = (target: Memory, trigger: Memory & { __rowid: number }, confidence: number, cosine: number | null, explicit: boolean): void => {
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
      notePendingRowid(trigger.__rowid); // orphan floor — group unapplied until the rewrite phase
    }
  };

  for (const candidate of rows) {
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
    // #401: the per-stage call cap stops the scan at the candidate boundary
    // (the in-loop check below is the mid-candidate backstop — supersession
    // mirrors both).
    if (!dryRun && maxCalls > 0 && callsUsed >= maxCalls) {
      callCapStopped = true;
      persistCursor();
      break;
    }
    scanned++;

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
        callsUsed++; // #401
        pairsEvaluated++;
        if (!verdict) {
          skippedInfra++; // mark retained; the neighborhood is revisited via newer candidacies
          continue;
        }
        if (verdict.action === "corrects" && verdict.confidence >= rewriteMinConfidence && isFactShapedTarget(target)) {
          addTrigger(target, candidate, verdict.confidence, null, true);
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
        persistCursor(); // #401: this candidate's remaining marks re-verify next run
        break;
      }
    }

    // ---- AC2: detection pairs against older KNN neighbors.
    let neighbors: Array<Memory & { distance: number }>;
    try {
      neighbors = await findOlderCorrectionNeighbors(db, candidate, embedFn, minSimilarity);
    } catch (err) {
      console.warn(
        `[hicortex] reconsolidation: discovery failed for ${candidate.id.slice(0, 8)} — ${err instanceof Error ? err.message : String(err)}`,
      );
      cursor = candidate.__rowid;
      persistCursor(); // #401: every exit path persists
      continue;
    }

    for (const neighbor of neighbors) {
      pairsDiscovered++; // every neighbor passed the floor gate
      if (alreadyResolutionLinked(db, neighbor.id, candidate.id)) {
        skippedIdempotent++;
        continue;
      }
      pairsDiscoveredUnlinked++; // still unlinked — the actionable candidate
      // #392: pairs at/above the ceiling belong to the deterministic zone —
      // counted here, never LLM-judged (the zone merges them or holds them
      // for its cap; re-detection is structural, not cursor-based).
      const pairCosine = l2ToCosine(neighbor.distance);
      if (pairCosine >= autoMergeThreshold) {
        skippedAboveCeiling++;
        continue;
      }
      if (dryRun) continue; // preview only — no LLM call, no write

      // #401: the per-stage call cap rides the same boundary as the budget —
      // supersession-stage pattern (consolidate.ts stageSupersession).
      if ((maxCalls > 0 && callsUsed >= maxCalls) || !budget.use(RECONSOLIDATION_STAGE_LABEL)) {
        callCapStopped = maxCalls > 0 && callsUsed >= maxCalls;
        persistCursor(); // cursor still points at the last fully-considered candidate
        break;
      }
      const { verdict, usage } = await classifyPair(llm, neighbor.content, candidate.content);
      budget.recordUsage(RECONSOLIDATION_STAGE_LABEL, usage);
      callsUsed++; // #401
      pairsEvaluated++;
      if (!verdict) {
        skippedInfra++;
        continue;
      }
      recordBand(pairCosine, verdict.action, verdict.confidence);

      // #392: a merge verdict is queued for the merge phase (below) — no
      // link, no write here. Below the confidence gate BOTH memories stay
      // live: a weak mark is recoverable, and there is nothing to mark for a
      // duplicate — keeping both is the recoverable outcome.
      if (verdict.action === "merge") {
        if (verdict.confidence < rewriteMinConfidence) {
          mergeBelowGate++;
          const band = bandForCosine(bands, pairCosine);
          if (band) {
            const stat = runBands.get(band.label) ?? emptyBandStat();
            stat.merge_below_gate++;
            runBands.set(band.label, stat);
          }
        } else {
          queuedMerges.push({ oldId: neighbor.id, newId: candidate.id, candidateRowid: candidate.__rowid });
          notePendingRowid(candidate.__rowid); // orphan floor — merge unapplied until the merge phase
        }
        continue;
      }

      if (verdict.action === "supersedes") {
        markLink(neighbor.id, candidate.id, "superseded_by", l2ToCosine(neighbor.distance));
        storage.updateMemory(db, neighbor.id, { status: "superseded" });
        markedSuperseded++;
        console.log(
          `[hicortex] Reconsolidation: ${neighbor.id.slice(0, 8)} superseded_by ${candidate.id.slice(0, 8)} (mark-only)`,
        );
        continue;
      }

      if (verdict.action === "corrects") {
        const cosine = pairCosine;
        if (verdict.confidence < rewriteMinConfidence) {
          // Below the gate: mark-only, never rewrite. The
          // trigger stays live — it is the only carrier of the correction.
          belowGate++;
          markLink(neighbor.id, candidate.id, "corrected_by", cosine);
          storage.updateMemory(db, neighbor.id, { status: "retracted" });
          markedRetracted++;
          continue;
        }
        if (!isFactShapedTarget(neighbor)) {
          // Decisions/plans/experiences are history, not error — mark only.
          markLink(neighbor.id, candidate.id, "corrected_by", cosine);
          storage.updateMemory(db, neighbor.id, { status: "retracted" });
          markedRetracted++;
          continue;
        }
        addTrigger(neighbor, candidate, verdict.confidence, cosine, false);
      }
      // verdict "none" → nothing to do
    }

    cursor = candidate.__rowid;

    // #402 follow-up (reviewer note 1): persist after EVERY fully-considered
    // candidate — the 50-candidate batch left a kill window that could
    // strand several candidates of scan progress. updateState is an atomic
    // temp-rename of a small file and the loop cadence is seconds per
    // candidate; the cost is negligible.
    persistCursor();
  }

  if (deadlineStopped) {
    console.log(
      `[hicortex] Reconsolidation: wall-clock deadline reached (reconsolidationMaxMinutes) — ` +
        `scan stopped at cursor ${cursor}; the next run resumes from there`,
    );
  } else if (callCapStopped) {
    console.log(
      `[hicortex] Reconsolidation: per-run call cap reached (reconsolidationMaxCalls) — ` +
        `scan stopped at cursor ${cursor}; the next run resumes from there`,
    );
  }

  // ---- #392 judged-merge phase: apply the queued pair merges through the
  // dedup core (mergeMemoryIds — same canonical pick, link re-points,
  // dedup_log, absorb). One short lock/backup window for the whole batch, one
  // transaction per pair. Zone merge operations count against the SAME
  // dedupNightlyMaxMerges cap. A pair that cannot apply (cap exhausted, busy
  // lock, failed backup) keeps BOTH memories live and holds the cursor below
  // its candidate — a confirmed merge is never silently dropped by the cursor
  // passing it (dup-over-loss). A metadata-rail refusal is different: the
  // verdict WAS rendered, both memories stay live, the cursor advances.
  const zoneOpsUsed = merges.merged_clusters + merges.failed;
  let mergeOpsRemaining = maxMerges > 0 ? Math.max(0, maxMerges - zoneOpsUsed) : 0;
  let mergePairsDeferred = 0;
  if (!dryRun && queuedMerges.length > 0) {
    const holdQueued = (from: number): void => {
      for (let i = from; i < queuedMerges.length; i++) {
        pendingMinRowid =
          pendingMinRowid === null
            ? queuedMerges[i].candidateRowid
            : Math.min(pendingMinRowid, queuedMerges[i].candidateRowid);
      }
    };

    if (maxMerges === 0) {
      // Machinery disabled by config: keep both (counted in band_stats as
      // merge verdicts) and ADVANCE — holding the cursor would re-judge the
      // same pairs into the same disabled state forever.
      console.log(
        `[hicortex] Reconsolidation: ${queuedMerges.length} confirmed merge(s) kept — ` +
          `dedupNightlyMaxMerges is 0 (merge machinery disabled)`,
      );
    } else if (mergeOpsRemaining <= 0) {
      mergePairsDeferred = queuedMerges.length;
      holdQueued(0); // zone consumed the whole cap — retry next run
      console.log(
        `[hicortex] Reconsolidation: ${mergePairsDeferred} confirmed merge(s) deferred — ` +
          `dedupNightlyMaxMerges exhausted by the deterministic zone`,
      );
    } else {
      const acquire = options.acquireLock ?? acquireCaptureLock;
      const release = await acquire(stateDir ?? hicortexHome(), 0);
      if (!release) {
        mergePairsDeferred = queuedMerges.length;
        holdQueued(0); // a busy capture run defers the batch — fail-soft
        console.warn(
          `[hicortex] Reconsolidation: capture lock busy — ${mergePairsDeferred} confirmed merge(s) deferred to next run`,
        );
      } else {
        try {
          let backupOk = true;
          try {
            await takePreDedupBackup(db, stateDir ?? hicortexHome());
          } catch (err) {
            backupOk = false;
            console.error(
              `[hicortex] Reconsolidation: pre-merge backup failed ` +
                `(${err instanceof Error ? err.message : String(err)}) — ${queuedMerges.length} merge(s) deferred`,
            );
          }
          if (backupOk) {
            for (let i = 0; i < queuedMerges.length; i++) {
              const pair = queuedMerges[i];
              if (mergeOpsRemaining <= 0) {
                mergePairsDeferred = queuedMerges.length - i;
                holdQueued(i); // cap exhausted mid-batch — the rest retry next run
                console.log(
                  `[hicortex] Reconsolidation: ${mergePairsDeferred} confirmed merge(s) deferred — dedupNightlyMaxMerges exhausted`,
                );
                break;
              }
              const result = mergeMemoryIds(db, [pair.oldId, pair.newId]);
              if (result.ok) {
                mergePairsApplied++;
                mergeOpsRemaining--;
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
              }
              // "no_members": a member vanished/was absorbed since the
              // verdict — nothing to merge, nothing to hold; the cursor
              // advances past it.
            }
          } else {
            mergePairsDeferred = queuedMerges.length;
            holdQueued(0);
          }
        } finally {
          release();
        }
      }
    }
  }

  // ---- Rewrite phase (AC3/AC4/AC5). Three sub-phases so the multi-target
  // keep rule can be honored: (R1) collect contracts, (R2) resolve every
  // trigger's FINAL disposition across all groups, (R3) apply one transaction
  // per group. A group whose rewrite call was never made (budget/infra) is
  // left untouched and holds the cursor — never partially applied.
  const contracts = new Map<string, RewriteContract | null>(); // null = contract failed
  // pendingMinRowid (min candidate rowid among un-applied work) is declared
  // above — shared with the merge phase's holdQueued.
  const deferFrom = (fromTargetId: string): void => {
    let seen = false;
    for (const group of groups.values()) {
      if (!seen && group.targetId !== fromTargetId) continue;
      seen = true;
      for (const t of group.triggers) {
        pendingMinRowid = pendingMinRowid === null ? t.candidateRowid : Math.min(pendingMinRowid, t.candidateRowid);
      }
    }
  };

  if (!dryRun && groups.size > 0) {
    for (const group of groups.values()) {
      // #401: the bounds stop the rewrite phase too — a group whose rewrite
      // call was never made is left untouched and holds the cursor (never
      // partially applied), exactly like the budget-exhausted path below.
      if (deadlineHit()) {
        deadlineStopped = true;
        deferFrom(group.targetId);
        break;
      }
      if (maxCalls > 0 && callsUsed >= maxCalls) {
        callCapStopped = true;
        deferFrom(group.targetId);
        break;
      }
      if (!budget.use(RECONSOLIDATION_STAGE_LABEL)) {
        deferFrom(group.targetId);
        break;
      }
      const triggersArg = group.triggers.map((t) => ({ id: t.id, content: t.memory.content }));
      let contract: RewriteContract | null = null;
      let infraError = false;
      try {
        const r = await llm.completeClassify(buildRewritePrompt(group.target.content, triggersArg));
        contract = parseRewriteReply(r.text, group.triggers.map((t) => t.id), group.target.content);
        budget.recordUsage(RECONSOLIDATION_STAGE_LABEL, r.usage);
        callsUsed++; // #401: rewrite contracts count toward the stage call cap
      } catch {
        infraError = true;
      }
      if (infraError) {
        skippedInfra++;
        deferFrom(group.targetId); // group NOT marked, NOT rewritten — retried next run
        break;
      }
      contracts.set(group.targetId, contract);
      if (!contract) contractFailed++;
    }

    // R2: final per-trigger disposition — a trigger in multiple groups is
    // absorbed only if EVERY disposition says absorb (any keep keeps it).
    const finalOutcome = new Map<string, "absorb" | "keep">();
    for (const contract of contracts.values()) {
      if (!contract) continue;
      for (const t of contract.triggers) {
        if (t.disposition === "keep" || finalOutcome.get(t.id) === "keep") finalOutcome.set(t.id, "keep");
        else finalOutcome.set(t.id, "absorb");
      }
    }

    // R3: apply (one transaction per group). An apply that fails mid-flight
    // (embed error, DB error) writes NOTHING (the transaction never ran) —
    // the group is deferred like a pending one so it retries next run.
    const appliedOutcome = new Map<string, "absorb" | "keep">();
    const deferGroup = (group: RewriteGroup): void => {
      for (const t of group.triggers) {
        pendingMinRowid = pendingMinRowid === null ? t.candidateRowid : Math.min(pendingMinRowid, t.candidateRowid);
      }
    };
    for (const group of groups.values()) {
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
          deferGroup(group);
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
        deferGroup(group);
        continue;
      }
      rewritten++;
      // Counted from APPLIED groups only (a deferred group's dispositions
      // never took effect); a trigger in several applied groups counts once.
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

  // Cursor hold: un-applied work (rewrite groups, confirmed merges) holds the
  // cursor BELOW its earliest contributing candidate so the pairs are
  // re-detected next run.
  if (pendingMinRowid !== null) {
    cursor = Math.min(cursor, pendingMinRowid - 1);
  }

  // Report snapshot: the deterministic band (from the zone's own numbers —
  // losers are merge verdicts at confidence 1.0; the zone persists the
  // cumulative copy itself) plus this run's judged bands.
  const bandStats: Record<string, ResolutionBandStat> = {};
  if (merges.max_merges > 0) {
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
    // #401: the authoritative FINAL cursor write — the mid-scan persists
    // above are checkpoints; this one also applies the pendingMinRowid hold.
    updateState((s) => {
      s.reconsolidationCursor = cursor;
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

  if (rows.length > 0 || groups.size > 0 || mergePairsApplied > 0 || mergeBelowGate > 0) {
    console.log(
      `[hicortex] Reconsolidation: ${scanned} scanned, ${pairsEvaluated} pairs evaluated, ` +
        `${rewritten} rewritten (${absorbed} triggers absorbed, ${keptLinked} kept), ` +
        `${mergePairsApplied} pair(s) merged, ${markedSuperseded} superseded, ` +
        `${markedRetracted} retracted (${belowGate} below gate, ${mergeBelowGate} merge below gate, ` +
        `${contractFailed} contract failed), ${skippedInfra} infra-skipped, ${skippedIdempotent} ` +
        `already-linked, ${skippedAboveCeiling} above ceiling, ${explicitVerified} explicit verified, ` +
        `${explicitDivergent} explicit divergent (cursor ${cursor})`,
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
    merges,
    merge_pairs_applied: mergePairsApplied,
    merge_below_gate: mergeBelowGate,
    skipped_above_ceiling: skippedAboveCeiling,
    skipped_metadata_mismatch: skippedMetadataMismatch,
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
