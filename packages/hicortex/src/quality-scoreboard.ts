/**
 * Quality scoreboard (#578) — the Memory Precision card as a standing quality
 * instrument. Everything here is OFF the request path by construction:
 *
 *   - Tier-1 deterministic metrics (block size, cross-project share +
 *     attribution coverage, sub-bar share, distinct-memory recycling) are
 *     computed from the #476 event store at RENDER time (handleDashboardData)
 *     and stamped into the nightly snapshot by the snapshot writer.
 *   - The corpus-health trio (near-duplicate cluster count, scope-anchor
 *     rate, canonical-label integrity) is computed by the NIGHTLY snapshot
 *     writer ONLY — the dup-cluster count re-runs the dedup clustering over
 *     every vector, far too heavy per dashboard load — and renders from the
 *     snapshot series, never per-request.
 *   - The weekly auto-grading pass runs inside the nightly, gated by a
 *     state.json week cursor, on its own call lane. NO grading code is
 *     reachable from any HTTP handler.
 *
 * Layering (the recall-precision.ts law): pure functions over the db handle
 * + injectable seams (fetch, clock, cap, logger) so tests exercise every
 * failure mode without HTTP, keys, or live calls; dashboard.ts holds only the
 * express adapters; mcp-server.ts only the routes.
 *
 * Threshold-free storage (the #476 law): verdict rows carry RAW score +
 * confidence; "useful" and "contested" derive at render from
 * QUALITY_USEFUL_SCORE / QUALITY_CONTESTED_CONFIDENCE, so recalibration never
 * rewrites history.
 */

import type Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  CROSS_PROJECT_MIN_SIMILARITY,
  DEDUP_AUTO_MERGE_THRESHOLD,
  MEMORY_PRECISION_WINDOW_DAYS,
  QUALITY_CHANGES,
  QUALITY_CONTESTED_CONFIDENCE,
  QUALITY_GRADE_WEEKLY_CALL_CAP,
  QUALITY_USEFUL_SCORE,
  RECALL_TITLE_CHARS,
} from "./calibration.js";
import { readStrictBoolean, readStringConfig } from "./config-read.js";
import { planDedup } from "./dedup.js";
import { canonicalizeProject } from "./project-canonicalize.js";
import { redact } from "./redact.js";
import { formatIndexLine } from "./recall-index.js";
import type { RunDeadline } from "./run-deadline.js";

const DAY_MS = 86_400_000;
const round4 = (v: number): number => Math.round(v * 10000) / 10000;

/** Inclusive window start (UTC YYYY-MM-DD) for an N-day window: today counts
 *  as day 1 — the readMemoryPrecision day-bucket convention. */
export function windowStartDay(now: Date, windowDays: number): string {
  return new Date(now.getTime() - (windowDays - 1) * DAY_MS).toISOString().slice(0, 10);
}

/** The day BEFORE `day` (UTC) — the before/after split edge for a change
 *  date: before = window up to this day, after = `day` onward. */
function dayBefore(day: string): string {
  return new Date(new Date(`${day}T00:00:00.000Z`).getTime() - DAY_MS)
    .toISOString()
    .slice(0, 10);
}

// ---------------------------------------------------------------------------
// Tier-1 metrics — deterministic, computed from raw events (no judgments)
// ---------------------------------------------------------------------------

/** The Tier-1 metric set over one day range. Every share is null when its
 *  denominator is empty (undefined, never a guessed 0 — the readMemoryPrecision
 *  honesty convention); the cross-project bar is ECHOED (the page never
 *  hardcodes an edge). */
export interface QualityTier1 {
  /** Non-skipped /recall-index calls in the range (silent turns included). */
  pushes: number;
  /** Pushed index lines (kind='shown' events) in the range. */
  lines: number;
  /** lines ÷ pushes — the pushed-block size the fence was measured with;
   *  null when there were no pushes. */
  block_size: number | null;
  /** Attributed lines whose memory's project differs from the request's ÷
   *  attributed lines; null when nothing attributed. */
  cross_share: number | null;
  /** Attributed lines ÷ all lines — the explicit attribution bound rendered
   *  beside the share (a small gap stays visible, never silent); null when no
   *  lines. */
  attribution_coverage: number | null;
  /** Attributed cross lines with a measured similarity below the effective
   *  bar ÷ attributed cross lines; null when no attributed cross lines. */
  sub_bar_share: number | null;
  /** Average daily COUNT(DISTINCT memory_id) of shown events over the days
   *  that have any shown events; null when none. */
  recycling: number | null;
  /** The effective cross-project bar the sub-bar share is measured against
   *  (calibration CROSS_PROJECT_MIN_SIMILARITY — the fence's own knob). */
  cross_project_bar: number;
}

/** The #-prefix attribution map: push id → the request's project, from the
 *  stored canonicalized label (v26+) when present, ELSE the dominant project
 *  of memories distilled from the push's session. `memories.source_session`
 *  is segment-scoped (`<sessionId>#<segment>`), so the join is the documented
 *  `source_session LIKE sessionId || '#%'` — a BARE equality join matches 0
 *  rows on real data (measured, #578; pinned by test). Multi-project sessions
 *  resolve to the DOMINANT project (max row count, project ASC tiebreak) —
 *  a small minority of joinable sessions in practice, negligible
 *  ambiguity. */
function resolveRequestProjects(
  db: Database.Database,
  fromDay: string,
  toDay: string | null,
): Map<number, string> {
  const pushRows = (
    toDay
      ? db
          .prepare("SELECT id, session_id, project FROM recall_pushes WHERE day >= ? AND day <= ?")
          .all(fromDay, toDay)
      : db.prepare("SELECT id, session_id, project FROM recall_pushes WHERE day >= ?").all(fromDay)
  ) as Array<{ id: number; session_id: string | null; project: string | null }>;

  const resolved = new Map<number, string>();
  const needJoin: Array<{ id: number; session_id: string }> = [];
  for (const p of pushRows) {
    if (typeof p.project === "string" && p.project) resolved.set(p.id, p.project);
    else if (p.session_id) needJoin.push({ id: p.id, session_id: p.session_id });
  }
  if (needJoin.length > 0) {
    // Dominant project per session over segment-scoped rows: substr before
    // the FIRST '#' IS the LIKE '<sid>#%' prefix — identical join semantics.
    const rows = db
      .prepare(
        `SELECT substr(source_session, 1, instr(source_session, '#') - 1) AS sid,
                project, COUNT(*) AS c
           FROM memories
          WHERE source_session LIKE '%#%'
          GROUP BY sid, project`,
      )
      .all() as Array<{ sid: string; project: string | null; c: number }>;
    const dominant = new Map<string, { project: string | null; c: number }>();
    for (const r of rows) {
      const cur = dominant.get(r.sid);
      if (
        !cur ||
        r.c > cur.c ||
        (r.c === cur.c && (r.project ?? "") < (cur.project ?? ""))
      ) {
        dominant.set(r.sid, { project: r.project, c: r.c });
      }
    }
    for (const p of needJoin) {
      const d = dominant.get(p.session_id);
      // A session whose rows are all project-NULL does not attribute — the
      // coverage % carries that honestly.
      if (d && d.project !== null) resolved.set(p.id, d.project);
    }
  }
  return resolved;
}

/**
 * The Tier-1 metric set over one inclusive day range [fromDay, toDay]
 * (toDay null = open-ended, the rolling-window shape). Pure SQL-shaped math
 * over raw event rows — every value equals the hand-computed query of its
 * formula; the tests pin exactly that (the readMemoryPrecision Level-1
 * convention). Cross determination matches the #566 fence's own comparison:
 * case-insensitive, a NULL memory project counts as foreign; a memory row
 * that no longer exists reads as a NULL project (the LEFT JOIN's honest
 * output — the fence could not have matched it either).
 */
export function computeTier1Metrics(
  db: Database.Database,
  fromDay: string,
  toDay: string | null,
  opts?: { crossBar?: number },
): QualityTier1 {
  const bar = opts?.crossBar ?? CROSS_PROJECT_MIN_SIMILARITY;
  const requestProject = resolveRequestProjects(db, fromDay, toDay);

  const lineRows = (
    toDay
      ? db
          .prepare(
            `SELECT e.push_id AS push_id, e.memory_id AS memory_id, e.similarity AS similarity,
                    m.project AS mem_project
               FROM recall_events e LEFT JOIN memories m ON m.id = e.memory_id
              WHERE e.day >= ? AND e.day <= ? AND e.kind = 'shown'`,
          )
          .all(fromDay, toDay)
      : db
          .prepare(
            `SELECT e.push_id AS push_id, e.memory_id AS memory_id, e.similarity AS similarity,
                    m.project AS mem_project
               FROM recall_events e LEFT JOIN memories m ON m.id = e.memory_id
              WHERE e.day >= ? AND e.kind = 'shown'`,
          )
          .all(fromDay)
  ) as Array<{
    push_id: number | null;
    memory_id: string;
    similarity: number | null;
    mem_project: string | null;
  }>;

  let attributed = 0;
  let cross = 0;
  let subBar = 0;
  for (const l of lineRows) {
    if (l.push_id === null) continue;
    const req = requestProject.get(l.push_id);
    if (req === undefined) continue;
    attributed++;
    const isCross =
      l.mem_project === null || l.mem_project.toLowerCase() !== req.toLowerCase();
    if (!isCross) continue;
    cross++;
    if (typeof l.similarity === "number" && l.similarity < bar) subBar++;
  }

  const perDay = (
    toDay
      ? db
          .prepare(
            `SELECT day, COUNT(DISTINCT memory_id) AS d
               FROM recall_events
              WHERE day >= ? AND day <= ? AND kind = 'shown'
              GROUP BY day`,
          )
          .all(fromDay, toDay)
      : db
          .prepare(
            `SELECT day, COUNT(DISTINCT memory_id) AS d
               FROM recall_events
              WHERE day >= ? AND kind = 'shown'
              GROUP BY day`,
          )
          .all(fromDay)
  ) as Array<{ day: string; d: number }>;
  const recycling =
    perDay.length > 0
      ? round4(perDay.reduce((sum, r) => sum + r.d, 0) / perDay.length)
      : null;

  const pushes = (
    toDay
      ? db
          .prepare("SELECT COUNT(*) AS c FROM recall_pushes WHERE day >= ? AND day <= ?")
          .get(fromDay, toDay)
      : db.prepare("SELECT COUNT(*) AS c FROM recall_pushes WHERE day >= ?").get(fromDay)
  ) as { c: number };

  return {
    pushes: pushes.c,
    lines: lineRows.length,
    block_size: pushes.c > 0 ? round4(lineRows.length / pushes.c) : null,
    cross_share: attributed > 0 ? round4(cross / attributed) : null,
    attribution_coverage: lineRows.length > 0 ? round4(attributed / lineRows.length) : null,
    sub_bar_share: cross > 0 ? round4(subBar / cross) : null,
    recycling,
    cross_project_bar: bar,
  };
}

/**
 * The Tier-1 set over the rolling N-day window (inclusive day buckets, the
 * readMemoryPrecision convention) — what handleDashboardData spreads into
 * the memory_precision block and the snapshot writer stamps.
 */
export function readQualityTier1(
  db: Database.Database,
  windowDays: number,
  opts?: { now?: Date; crossBar?: number },
): QualityTier1 {
  const now = opts?.now ?? new Date();
  return computeTier1Metrics(db, windowStartDay(now, windowDays), null, opts);
}

// ---------------------------------------------------------------------------
// Change-registry deltas — pinned dates in calibration, numbers computed at
// render from raw events (no frozen values under an evolving metric set)
// ---------------------------------------------------------------------------

/** One registry entry's before/after over the raw event window — the FOUR
 *  metrics the card renders per change (block size, cross share, sub-bar
 *  share, recycling). Nulls when a side has no data (honest undefined, never
 *  zero). Deliberately compact: the memory_precision block's ≤ 2 KB budget
 *  is the gate, and the full bar/coverage echoes ride the tier1 side. */
export interface QualityChangeDelta {
  id: string;
  label: string;
  date: string;
  before: { block_size: number | null; cross_share: number | null; sub_bar_share: number | null; recycling: number | null } | null;
  after: { block_size: number | null; cross_share: number | null; sub_bar_share: number | null; recycling: number | null } | null;
}

/** The compact four-metric projection of a full Tier-1 set. */
function compactTier1(
  t: QualityTier1,
): { block_size: number | null; cross_share: number | null; sub_bar_share: number | null; recycling: number | null } {
  return {
    block_size: t.block_size,
    cross_share: t.cross_share,
    sub_bar_share: t.sub_bar_share,
    recycling: t.recycling,
  };
}

/**
 * Every QUALITY_CHANGES entry the raw event window still covers, each with
 * its before/after computed from raw events: before = window start up to the
 * day BEFORE the change date, after = the change date onward. Entries older
 * than the window are omitted (their trend lives on in the snapshot series);
 * future-dated entries carry honest nulls on the after side until they
 * deploy. Numbers are never pinned in code — moving a metric definition
 * re-derives every baseline.
 */
export function readQualityChanges(
  db: Database.Database,
  windowDays: number,
  opts?: { now?: Date; crossBar?: number },
): QualityChangeDelta[] {
  const now = opts?.now ?? new Date();
  const fromDay = windowStartDay(now, windowDays);
  const out: QualityChangeDelta[] = [];
  for (const change of QUALITY_CHANGES) {
    // Aged out of the raw window — the entry's before/after is no longer
    // computable from events; omit (the snapshot series carries the trend).
    if (change.date < fromDay) continue;
    const before =
      dayBefore(change.date) >= fromDay
        ? compactTier1(computeTier1Metrics(db, fromDay, dayBefore(change.date), opts))
        : null; // the change predates the window start — no before data
    const after =
      change.date <= now.toISOString().slice(0, 10)
        ? compactTier1(computeTier1Metrics(db, change.date, null, opts))
        : null; // future-dated entry (e.g. a pinned next deploy) — no data yet
    out.push({ id: change.id, label: change.label, date: change.date, before, after });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Corpus health trio — computed by the NIGHTLY snapshot writer only, rendered
// from the snapshot series (never per-request)
// ---------------------------------------------------------------------------

export interface CorpusHealth {
  /** Near-duplicate clusters (size > 1) at the dedup merge threshold — the
   *  SHARED clustering core (planDedup, the same KNN + union-find the
   *  nightly merge zone and `hicortex dedup` run), so the scoreboard's count
   *  can never disagree with what a dedup pass would merge. */
  dup_clusters: number;
  /** Share of live (non-absorbed) memories with a non-null domain — how much
   *  of the corpus is anchored to a knowledge scope. Null on an empty
   *  corpus. */
  scope_anchor_rate: number | null;
  /** Count of live memories whose stored project differs from its
   *  canonicalized form — the #567 drift signal: post-reconcile drift is
   *  NEW non-canonical rows arriving through some un-normalized path. */
  canonical_drift: number;
}

/** The trio. The dup-cluster count re-runs planDedup (read-only) — nightly
 *  cost only, exactly like the merge zone that already runs beside it. The
 *  canonical check uses the MECHANICAL fold (trim + lowercase, no alias
 *  hop): aliases are config-owned and the snapshot writer has no config —
 *  the mechanical fold is the stable definition that still catches every
 *  case/whitespace drift. */
export function computeCorpusHealth(db: Database.Database): CorpusHealth {
  const dupClusters = planDedup(db, DEDUP_AUTO_MERGE_THRESHOLD).clusterCount;
  const live = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN domain IS NOT NULL THEN 1 ELSE 0 END) AS anchored
         FROM memories
        WHERE COALESCE(status, '') != 'absorbed'`,
    )
    .get() as { total: number; anchored: number | null };
  const projectRows = db
    .prepare(
      `SELECT project, COUNT(*) AS c
         FROM memories
        WHERE COALESCE(status, '') != 'absorbed' AND project IS NOT NULL
        GROUP BY project`,
    )
    .all() as Array<{ project: string; c: number }>;
  let drift = 0;
  for (const r of projectRows) {
    if (canonicalizeProject(r.project) !== r.project) drift += r.c;
  }
  return {
    dup_clusters: dupClusters,
    scope_anchor_rate:
      live.total > 0 && live.anchored !== null ? round4(live.anchored / live.total) : null,
    canonical_drift: drift,
  };
}

// ---------------------------------------------------------------------------
// Graded aggregates — the judgment layer's trend (owner + auto-grader rows)
// ---------------------------------------------------------------------------

export interface GradedAggregate {
  /** Auto-grader + owner verdict rows in the retention window. */
  graded: number;
  /** Rows judged useful at render (owner verdict +1, or auto-grader
   *  score ≥ QUALITY_USEFUL_SCORE). */
  useful: number;
  /** useful ÷ graded; null when nothing graded. */
  useful_share: number | null;
  /** Auto-graded rows below QUALITY_CONTESTED_CONFIDENCE that the owner
   *  has not answered — exactly the contested drawer's population. */
  contested: number;
}

/** Graded aggregates over the retention window (verdicts older than the
 *  event horizon are pruned, except owner verdicts, which stay
 *  countable forever... but for TREND comparability the window matches the
 *  event store). */
export function readGradedAggregate(
  db: Database.Database,
  opts?: { now?: Date; usefulScore?: number; contestedBelow?: number },
): GradedAggregate {
  const now = opts?.now ?? new Date();
  const fromDay = windowStartDay(now, MEMORY_PRECISION_WINDOW_DAYS);
  const usefulScore = opts?.usefulScore ?? QUALITY_USEFUL_SCORE;
  const contestedBelow = opts?.contestedBelow ?? QUALITY_CONTESTED_CONFIDENCE;
  const rows = db
    .prepare(
      `SELECT grader, score, confidence, verdict, push_id, memory_id
         FROM recall_verdicts
        WHERE day >= ? AND grader IN ('auto', 'owner')`,
    )
    .all(fromDay) as Array<{
    grader: string;
    score: number | null;
    confidence: number | null;
    verdict: number | null;
    push_id: number | null;
    memory_id: string;
  }>;
  const answered = new Set(
    (
      db
        .prepare("SELECT push_id, memory_id FROM recall_verdicts WHERE grader = 'owner'")
        .all() as Array<{ push_id: number | null; memory_id: string }>
    ).map((r) => `${r.push_id ?? ""}|${r.memory_id}`),
  );
  let useful = 0;
  let contested = 0;
  for (const r of rows) {
    if (
      (r.grader === "owner" && r.verdict === 1) ||
      (r.grader === "auto" && typeof r.score === "number" && r.score >= usefulScore)
    ) {
      useful++;
    }
    if (
      r.grader === "auto" &&
      (r.confidence === null || r.confidence < contestedBelow) &&
      !answered.has(`${r.push_id ?? ""}|${r.memory_id}`)
    ) {
      contested++;
    }
  }
  return {
    graded: rows.length,
    useful,
    useful_share: rows.length > 0 ? round4(useful / rows.length) : null,
    contested,
  };
}

// ---------------------------------------------------------------------------
// Snapshot block — what writeSnapshot stamps (new metrics keys only; the
// metrics blob is a stable contract)
// ---------------------------------------------------------------------------

export interface QualitySnapshotBlock {
  /** Tier-1 over the trailing 7-day window. */
  tier1_7d: QualityTier1;
  /** Tier-1 over the trailing 30-day window. */
  tier1_30d: QualityTier1;
  /** Graded aggregates over the retention window. */
  graded: GradedAggregate;
  /** The corpus-health trio at snapshot time. */
  corpus: CorpusHealth;
}

/** Build the nightly quality block. Nightly-only by construction (only
 *  writeSnapshot calls it — the per-request dashboard path never does; the
 *  dup-cluster KNN alone forbids that). */
export function buildQualitySnapshotBlock(
  db: Database.Database,
  opts?: { now?: Date },
): QualitySnapshotBlock {
  const now = opts?.now ?? new Date();
  return {
    tier1_7d: readQualityTier1(db, 7, { now }),
    tier1_30d: readQualityTier1(db, 30, { now }),
    graded: readGradedAggregate(db, { now }),
    corpus: computeCorpusHealth(db),
  };
}

// ---------------------------------------------------------------------------
// The grading decisions client — one grader, an injectable-fetch seam (the
// codebase's standard test pattern; NO grader abstraction, #578 non-goal)
// ---------------------------------------------------------------------------

/** The decisions API endpoint: a typed-decisions API (POST typed questions,
 *  NOT /v1/chat/completions), sub-second per call at a negligible per-call
 *  cost. The model id is operator config (#582 — `qualityGradeModel`, no
 *  default). Documented failure mode: silent degradation on credit
 *  exhaustion — HTTP 200 with EMPTY answers; the client asserts the
 *  answer is non-null so that mode writes nothing and surfaces as a greppable
 *  health line instead of a silent zero. */
export const QUALITY_GRADE_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";

/** One graded answer: RAW score + confidence, no thresholds applied (the
 *  #476 law — the contested slice derives at render). */
export interface GradeAnswer {
  score: number;
  confidence: number;
}

export interface GradeClient {
  gradeLine(line: string, promptExcerpt: string, signal?: AbortSignal): Promise<GradeAnswer>;
}

/** Thrown when the endpoint answers HTTP 200 but the answer is null/absent —
 *  the documented credit-exhaustion silent-degradation mode. The stage
 *  catches it, writes nothing, logs `event=quality_grade_failed`, and the
 *  items retry next run (dup-over-loss). */
export class GradeEmptyAnswersError extends Error {
  constructor() {
    super("The grading decisions endpoint returned HTTP 200 with no answer (documented credit-exhaustion mode)");
    this.name = "GradeEmptyAnswersError";
  }
}

/**
 * The grading prompt — the grade target is the index line AS PUSHED (what
 * the consuming agent actually saw, not the memory behind it), rendered
 * through the shared formatIndexLine, with the stored prompt excerpt for
 * context. A typed `score` question (0..1) — the decisions API takes
 * structured questions, not free chat.
 */
function gradingQuestion(line: string, promptExcerpt: string): string {
  const excerpt = promptExcerpt && promptExcerpt.trim() ? promptExcerpt.trim() : "(no prompt excerpt recorded)";
  return (
    `An AI agent received this pushed memory-index line alongside a prompt:\n\n` +
    `Prompt excerpt: ${excerpt}\n\n` +
    `Index line: ${line}\n\n` +
    `Score how useful this one line was for that prompt, 0 (noise) to 1 (directly useful).`
  );
}

/**
 * Build the grading client. `model` is the operator-configured model id
 * (#582 — no default; the stage skips without one). `fetchFn` is the
 * INJECTABLE FETCH SEAM — tests inject a fake and count calls / force both
 * documented failure modes; production uses global fetch. No key material
 * is ever logged. EGRESS REDACTION (#582) lives HERE, at the boundary where
 * the request body is built: both payload parts (the line and the prompt
 * excerpt) run through the deterministic redaction pass BEFORE the question
 * is composed, so no caller can ship raw text to the endpoint.
 */
export function createGradeClient(opts: {
  apiKey: string;
  model: string;
  fetchFn?: typeof fetch;
}): GradeClient {
  const doFetch = opts.fetchFn ?? fetch;
  return {
    async gradeLine(line, promptExcerpt, signal) {
      // redact("") is "" — the no-excerpt fallback in gradingQuestion keeps
      // working unchanged.
      const safeLine = redact(line).text;
      const safeExcerpt = redact(promptExcerpt).text;
      const resp = await doFetch(QUALITY_GRADE_DECISIONS_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify({
          model: opts.model,
          questions: [
            {
              type: "score",
              id: "usefulness",
              question: gradingQuestion(safeLine, safeExcerpt),
              min: 0,
              max: 1,
            },
          ],
        }),
        signal,
      });
      if (!resp.ok) {
        throw new Error(`grading decisions endpoint HTTP ${resp.status}`);
      }
      const data = (await resp.json()) as {
        answers?: Array<{ score?: unknown; confidence?: unknown } | null>;
      };
      // THE empty-answers assertion — the documented silent-degradation mode
      // must never read as a graded zero.
      const answer = data?.answers?.[0];
      if (answer === null || answer === undefined) throw new GradeEmptyAnswersError();
      const score = Number(answer.score);
      const confidence = Number(answer.confidence ?? 1);
      if (!Number.isFinite(score) || !Number.isFinite(confidence)) {
        throw new Error("grading decisions answer is not numeric (score/confidence)");
      }
      return { score, confidence };
    },
  };
}

// ---------------------------------------------------------------------------
// The API key — repo-root .env (gitignored), never printed. Tiny reader, no
// dotenv dependency.
// ---------------------------------------------------------------------------

export const OPENROUTER_KEY_NAME = "OPENROUTER_HICORTEX_KEY";

/** Resolve the key: process env wins (the systemd Environment= deployment
 *  path), then the repo-root .env (the development convenience path), then
 *  ./.env. Returns null when absent — the stage skips (fail-soft), never
 *  errors. NEVER logs the value. The repo root is three levels above this
 *  module's directory both compiled (dist/) and under vitest (src/) — the
 *  __dirname convention init.ts uses. */
export function readOpenRouterKey(envPath?: string): string | null {
  const fromEnv = process.env[OPENROUTER_KEY_NAME];
  if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv.trim();
  const candidates = envPath
    ? [envPath]
    : [
        join(__dirname, "..", "..", "..", ".env"), // repo root
        join(process.cwd(), ".env"),
      ];
  for (const path of candidates) {
    let raw: string;
    try {
      raw = readFileSync(path, "utf-8");
    } catch {
      continue; // absent — the next candidate
    }
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m || m[1] !== OPENROUTER_KEY_NAME) continue;
      const value = m[2].trim().replace(/^["']|["']$/g, "");
      return value || null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Verdict writes (shared by the stage and the owner PUT)
// ---------------------------------------------------------------------------

/** One verdict row insert (the single write shape). */
export function insertVerdictRow(
  db: Database.Database,
  row: {
    ts: string;
    day: string;
    push_id: number | null;
    memory_id: string;
    grader: string;
    score: number | null;
    confidence: number | null;
    verdict: number | null;
  },
): number {
  const info = db
    .prepare(
      `INSERT INTO recall_verdicts (ts, day, push_id, memory_id, grader, score, confidence, verdict)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.ts,
      row.day,
      row.push_id,
      row.memory_id,
      row.grader,
      row.score,
      row.confidence,
      row.verdict,
    );
  return Number(info.lastInsertRowid);
}

// ---------------------------------------------------------------------------
// The weekly grading stage — offline, own call lane, deadline-aware,
// fail-soft (nightly-only wiring; never on any request path)
// ---------------------------------------------------------------------------

/** ISO-8601 week key "YYYY-Www" (UTC) — the stage's cadence gate. */
export function isoWeekKey(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon = 0
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // this week's Thursday
  const isoYear = date.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Day = (jan4.getUTCDay() + 6) % 7;
  const week1Mon = Date.UTC(isoYear, 0, 4 - jan4Day);
  const week = 1 + Math.round((date.getTime() - week1Mon) / (7 * DAY_MS));
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/** One sampled grading item — a shown-never-fetched line with everything the
 *  grader and the insert need. */
interface GradeItem {
  push_id: number;
  memory_id: string;
  prompt_excerpt: string | null;
  line: string;
  request_project: string | null;
}

export interface QualityGradeReport {
  /** The week the pass ran for (the caller persists it as the cursor only
   *  when `complete`). */
  week: string;
  /** True when the whole sample was processed — the ONLY condition that
   *  advances the week cursor (dup-over-loss: capped/deadlined/failed passes
   *  hold the cursor and retry the ungraded remainder next nightly). */
  complete: boolean;
  skipped?:
    | "already-graded"
    | "no-api-key"
    | "disabled"
    | "no-model";
  /** Revealed-useful lines marked useful (ZERO grading calls). */
  revealedMarked: number;
  /** Shown-never-fetched lines selected for grading this pass. */
  sampled: number;
  graded: number;
  deferred: number;
}

export interface QualityGradeOptions {
  now?: () => Date;
  /** Injectable client (tests). Default: built from the resolved key + the
   *  config-read model id. */
  client?: GradeClient;
  /** Saved config (#582): the stage is opt-in via `qualityGrading` +
   *  `qualityGradeModel` (readStrictBoolean / readStringConfig — fail-closed:
   *  absent or wrong-typed → skip). */
  config?: Record<string, unknown> | null;
  /** Key resolution seam (tests). Default readOpenRouterKey. */
  readKey?: () => string | null;
  /** The run deadline (#405) — checked between items; a hit defers the
   *  remainder. */
  deadline?: RunDeadline;
  /** Weekly call cap override (tests); default QUALITY_GRADE_WEEKLY_CALL_CAP. */
  callCap?: number;
  /** Log seam (tests); default console.log — the `event=quality_grade_*`
   *  health lines are journald-greppable. */
  log?: (msg: string) => void;
}

/**
 * The weekly grading pass (#578): mark revealed-useful lines (shown then
 * fetched in-window) useful with ZERO grading calls, then grade a sample of
 * shown-never-fetched index lines stratified by request project, each graded
 * AS PUSHED (the shared formatIndexLine render + the stored prompt excerpt).
 *
 * OWN LANE: bounded by `callCap` (default 60/week) — deliberately separate
 * from nightlyLlmCallBudget (different provider, independent
 * starvation risk); the consolidation budget is untouched. Deadline-aware
 * between items (createRunDeadline). Dup-over-loss: the week cursor
 * (state.qualityGradeWeek, the supersessionCursor convention) advances only
 * on `complete`; an item with an existing auto-grade verdict is never
 * re-graded (the sample filter), so a retried pass grades exactly the
 * remainder.
 *
 * GATED + FAIL-SOFT (#582): the pass runs ONLY on explicit opt-in —
 * `qualityGrading: true` + `qualityGradeModel` in config, plus the endpoint
 * key; a missing flag, key, or model → skip with
 * `event=quality_grade_skipped`; a client
 * failure (incl. the documented HTTP-200-empty-answers credit-exhaustion
 * mode, guarded by the non-null answer assertion) stops the pass with
 * `event=quality_grade_failed`, writes nothing further, holds the cursor —
 * neither ever throws to the caller (the nightly wraps its own try/catch
 * anyway, mirroring pruneRecallPrecision).
 */
export function runQualityGradeStage(
  db: Database.Database,
  gradedWeek: string | undefined,
  opts?: QualityGradeOptions,
): Promise<QualityGradeReport> {
  return runQualityGradeStageInner(db, gradedWeek, opts).catch(
    (err: unknown): QualityGradeReport => {
      // Fail-soft at the boundary: an unexpected throw (db, fs) must never
      // fail the nightly run. The week is held; the next run retries.
      (opts?.log ?? console.warn)(
        `[hicortex] event=quality_grade_failed error=` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        week: isoWeekKey(opts?.now ? opts.now() : new Date()),
        complete: false,
        revealedMarked: 0,
        sampled: 0,
        graded: 0,
        deferred: 0,
      };
    },
  );
}

async function runQualityGradeStageInner(
  db: Database.Database,
  gradedWeek: string | undefined,
  opts?: QualityGradeOptions,
): Promise<QualityGradeReport> {
  const now = opts?.now ? opts.now() : new Date();
  const log = opts?.log ?? console.log;
  const week = isoWeekKey(now);
  const base: Omit<QualityGradeReport, "complete" | "skipped"> = {
    week,
    revealedMarked: 0,
    sampled: 0,
    graded: 0,
    deferred: 0,
  };

  if (gradedWeek === week) {
    return { ...base, complete: true, skipped: "already-graded" };
  }

  // #582 — explicit operator opt-in, FAIL-CLOSED. The grading lane sends
  // prompt-derived text to a third-party endpoint, so it runs ONLY when the
  // config turns it on (`qualityGrading: true`, readStrictBoolean — absent
  // or wrong-typed ≠ on). Gate order: week cursor → config gate → api key →
  // model. Greppable skip line, never an error.
  const cfg = opts?.config ?? {};
  if (readStrictBoolean(cfg, "qualityGrading") !== true) {
    log(`[hicortex] event=quality_grade_skipped reason=disabled week=${week}`);
    return { ...base, complete: false, skipped: "disabled" };
  }

  const readKey = opts?.readKey ?? readOpenRouterKey;
  const apiKey = readKey();
  if (!apiKey) {
    // No key on this install — the whole stage (revealed marking included)
    // skips: grading is the stage's purpose, and revealed rows are only
    // useful beside graded ones. Greppable, never an error.
    log(`[hicortex] event=quality_grade_skipped reason=no_api_key week=${week}`);
    return { ...base, complete: false, skipped: "no-api-key" };
  }
  const model = readStringConfig(cfg, "qualityGradeModel");
  if (!model) {
    // #582 — the model id is operator config, no default: an egress path
    // never gets an implicit model choice. Skip + health line.
    log(`[hicortex] event=quality_grade_skipped reason=no_model week=${week}`);
    return { ...base, complete: false, skipped: "no-model" };
  }
  const client = opts?.client ?? createGradeClient({ apiKey, model });
  const cap = opts?.callCap ?? QUALITY_GRADE_WEEKLY_CALL_CAP;
  const fromDay = windowStartDay(now, MEMORY_PRECISION_WINDOW_DAYS);
  const nowIso = now.toISOString();

  // --- Population: every shown (push, memory) pair in the retention window,
  // with the push's prompt excerpt + the memory row for the line render.
  // STANDARD-ONLY by construction (#618): the LEFT JOIN + privacy filter keep
  // confidential rows out of BOTH arms of the lane (revealed-useful marking
  // AND auto-grading) — a confidential line or excerpt must never egress.
  // LEFT JOIN so a standard-class row whose memory row is gone still flows
  // (renderLine already returns null for deleted memories — unchanged). ---
  const shownRows = db
    .prepare(
      `SELECT e.push_id AS push_id, e.memory_id AS memory_id, p.prompt_excerpt AS prompt_excerpt
         FROM recall_events e JOIN recall_pushes p ON p.id = e.push_id
         LEFT JOIN memories m ON m.id = e.memory_id
        WHERE e.day >= ? AND e.kind = 'shown'
          AND (m.privacy IS NULL OR m.privacy != 'confidential')`,
    )
    .all(fromDay) as Array<{
    push_id: number;
    memory_id: string;
    prompt_excerpt: string | null;
  }>;
  const fetchedInWindow = new Set(
    (
      db
        .prepare(
          "SELECT DISTINCT memory_id FROM recall_events WHERE day >= ? AND kind = 'fetch'",
        )
        .all(fromDay) as Array<{ memory_id: string }>
    ).map((r) => r.memory_id),
  );
  const autoGraded = new Set(
    (
      db
        .prepare("SELECT push_id, memory_id FROM recall_verdicts WHERE grader = 'auto'")
        .all() as Array<{ push_id: number | null; memory_id: string }>
    ).map((r) => `${r.push_id ?? ""}|${r.memory_id}`),
  );
  const revealedMarkedKeys = new Set(
    (
      db
        .prepare("SELECT push_id, memory_id FROM recall_verdicts WHERE grader = 'revealed'")
        .all() as Array<{ push_id: number | null; memory_id: string }>
    ).map((r) => `${r.push_id ?? ""}|${r.memory_id}`),
  );

  const requestProject = resolveRequestProjects(db, fromDay, null);
  const memStmt = db.prepare(
    `SELECT id, content, created_at, domain, project, source_agent, memory_type, privacy
       FROM memories WHERE id = ?`,
  );
  const renderLine = (memoryId: string): string | null => {
    const row = memStmt.get(memoryId) as {
      id: string; content: string; created_at: string; domain: string | null;
      project: string | null; source_agent: string | null; memory_type: string;
      privacy: string | null;
    } | undefined;
    if (!row) return null; // memory gone (deleted) — not gradable, skipped
    // #618 belt: the population filter above is the gate; this render-path
    // refusal means confidential content can NEVER reach the egress even if
    // the population query changes shape later.
    if (row.privacy === "confidential") return null;
    return formatIndexLine(
      {
        id: row.id,
        content: row.content,
        score: 0,
        effective_strength: 0,
        access_count: 0,
        memory_type: row.memory_type,
        project: row.project,
        domain: row.domain,
        source_agent: row.source_agent,
        created_at: row.created_at,
        connections: 0,
      },
      RECALL_TITLE_CHARS,
    );
  };

  // --- (a) Revealed-useful: shown then fetched in-window → useful, ZERO
  // grading calls. Idempotent per (push, memory): a pair marked once is
  // never re-marked. ---
  let revealedMarked = 0;
  const candidates: GradeItem[] = [];
  for (const s of shownRows) {
    const key = `${s.push_id}|${s.memory_id}`;
    if (fetchedInWindow.has(s.memory_id)) {
      if (!revealedMarkedKeys.has(key)) {
        insertVerdictRow(db, {
          ts: nowIso,
          day: nowIso.slice(0, 10),
          push_id: s.push_id,
          memory_id: s.memory_id,
          grader: "revealed",
          score: 1,
          confidence: 1,
          verdict: 1,
        });
        revealedMarkedKeys.add(key);
        revealedMarked++;
      }
      continue;
    }
    // (b) the grading middle: shown-never-fetched, not already auto-graded,
    // with a renderable line (the grade target is the line AS PUSHED).
    if (autoGraded.has(key)) continue;
    const line = renderLine(s.memory_id);
    if (line === null) continue;
    candidates.push({
      push_id: s.push_id,
      memory_id: s.memory_id,
      prompt_excerpt: s.prompt_excerpt,
      line,
      request_project: requestProject.get(s.push_id) ?? null,
    });
  }

  // --- Stratify by request project, round-robin across the project groups
  // (deterministic: groups by project name) so no single project's volume
  // starves the others. Unattributed lines group under null and still get
  // their turn. The FULL order is built (the cap bounds CALLS in the loop
  // below, not the sample — the remainder must count as DEFERRED so the
  // week cursor holds and next week retries it). ---
  const groups = new Map<string | null, GradeItem[]>();
  for (const c of candidates) {
    const g = groups.get(c.request_project) ?? [];
    g.push(c);
    groups.set(c.request_project, g);
  }
  const order = [...groups.keys()].sort((a, b) => (a ?? "￿").localeCompare(b ?? "￿"));
  const sample: GradeItem[] = [];
  let exhausted = false;
  while (!exhausted) {
    exhausted = true;
    for (const g of order) {
      const item = groups.get(g)!.shift();
      if (item) {
        sample.push(item);
        exhausted = false;
      }
    }
  }

  // --- The grading pass: deadline + own-cap checked BETWEEN items. ---
  let graded = 0;
  let deferred = 0;
  let failure: string | null = null;
  for (const item of sample) {
    if (graded >= cap) {
      deferred = sample.length - graded;
      log(
        `[hicortex] event=quality_grade_deferred reason=cap graded=${graded} deferred=${deferred} week=${week}`,
      );
      break;
    }
    if (opts?.deadline?.hit("quality_grade")) {
      deferred = sample.length - graded;
      log(
        `[hicortex] event=quality_grade_deferred reason=deadline graded=${graded} deferred=${deferred} week=${week}`,
      );
      break;
    }
    try {
      const answer = await client.gradeLine(item.line, item.prompt_excerpt ?? "");
      insertVerdictRow(db, {
        ts: nowIso,
        day: nowIso.slice(0, 10),
        push_id: item.push_id,
        memory_id: item.memory_id,
        grader: "auto",
        score: answer.score, // RAW — threshold-free (the #476 law)
        confidence: answer.confidence,
        verdict: null, // derived at render, never stored for the 'auto' grader
      });
      graded++;
    } catch (err) {
      // Includes the documented HTTP-200-empty-answers mode: NOTHING from
      // this call was written; already-written items stay (dup-over-loss);
      // the remainder defers to the next run (cursor held).
      deferred = sample.length - graded;
      failure = err instanceof Error ? err.message : String(err);
      log(
        `[hicortex] event=quality_grade_failed error=${failure} graded=${graded} deferred=${deferred} week=${week}`,
      );
      break;
    }
  }

  const complete = deferred === 0 && graded === sample.length;
  if (complete) {
    log(
      `[hicortex] event=quality_grade_done week=${week} graded=${graded} revealed=${revealedMarked}`,
    );
  }
  return { week, complete, revealedMarked, sampled: sample.length, graded, deferred };
}

// ---------------------------------------------------------------------------
// Contested list + owner verdict — the drawer's two pure handlers (the
// dashboardDataHandler convention: logic here, express adapters in
// dashboard.ts, routes in mcp-server.ts)
// ---------------------------------------------------------------------------

/** One contested item — an auto-graded verdict row below the confidence
 * threshold, with the index line re-rendered through the shared
 * formatIndexLine (the same render the grading pass graded). */
export interface ContestedItem {
  id: number;
  ts: string;
  push_id: number | null;
  memory_id: string;
  score: number | null;
  confidence: number | null;
  /** The line as pushed; null when the memory row no longer exists (honest,
   *  never a fabricated title). */
  line: string | null;
  prompt_excerpt: string | null;
}

export interface ContestedList {
  total: number;
  limit: number;
  offset: number;
  items: ContestedItem[];
}

/**
 * GET /dashboard/quality/contested's pure handler: the contested slice —
 * auto-graded rows with confidence below QUALITY_CONTESTED_CONFIDENCE
 * (render edge, echoed in the payload) that the owner has not yet answered
 * — newest first... no: LEAST confident first (they need the thumbs most),
 * then newest. Paginated (`limit` default 20, cap 100; `offset` default 0).
 */
export function listContestedVerdicts(
  db: Database.Database,
  query: { limit?: unknown; offset?: unknown },
  opts?: { contestedBelow?: number },
): ContestedList {
  const contestedBelow = opts?.contestedBelow ?? QUALITY_CONTESTED_CONFIDENCE;
  let limit = 20;
  if (typeof query.limit !== "undefined") {
    const n = Math.floor(Number(query.limit));
    limit = Number.isFinite(n) && n > 0 ? Math.min(n, 100) : 20;
  }
  let offset = 0;
  if (typeof query.offset !== "undefined") {
    const n = Math.floor(Number(query.offset));
    offset = Number.isFinite(n) && n > 0 ? n : 0;
  }

  // The answered filter: once the owner thumbs a (push, memory), it leaves
  // the contested list — the drawer clears as the owner grades. NULL push_id
  // pairs match on IS (the verdict rows carry them verbatim).
  const answeredExists = `EXISTS (
    SELECT 1 FROM recall_verdicts o
     WHERE o.grader = 'owner'
       AND o.memory_id = v.memory_id
       AND (o.push_id = v.push_id OR (o.push_id IS NULL AND v.push_id IS NULL)))`;

  const total = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM recall_verdicts v
          WHERE v.grader = 'auto'
            AND COALESCE(v.confidence, 0) < ?
            AND NOT ${answeredExists}`,
      )
      .get(contestedBelow) as { c: number }
  ).c;

  const rows = db
    .prepare(
      `SELECT v.id, v.ts, v.push_id, v.memory_id, v.score, v.confidence, p.prompt_excerpt
         FROM recall_verdicts v
         LEFT JOIN recall_pushes p ON p.id = v.push_id
        WHERE v.grader = 'auto'
          AND COALESCE(v.confidence, 0) < ?
          AND NOT ${answeredExists}
        ORDER BY v.confidence ASC, v.ts DESC
        LIMIT ? OFFSET ?`,
    )
    .all(contestedBelow, limit, offset) as Array<{
    id: number;
    ts: string;
    push_id: number | null;
    memory_id: string;
    score: number | null;
    confidence: number | null;
    prompt_excerpt: string | null;
  }>;

  const memStmt = db.prepare(
    `SELECT id, content, created_at, domain, project, source_agent, memory_type
       FROM memories WHERE id = ?`,
  );
  const items: ContestedItem[] = rows.map((r) => {
    const mem = memStmt.get(r.memory_id) as {
      id: string; content: string; created_at: string; domain: string | null;
      project: string | null; source_agent: string | null; memory_type: string;
    } | undefined;
    return {
      id: r.id,
      ts: r.ts,
      push_id: r.push_id,
      memory_id: r.memory_id,
      score: r.score,
      confidence: r.confidence,
      line: mem
        ? formatIndexLine(
            {
              id: mem.id,
              content: mem.content,
              score: 0,
              effective_strength: 0,
              access_count: 0,
              memory_type: mem.memory_type,
              project: mem.project,
              domain: mem.domain,
              source_agent: mem.source_agent,
              created_at: mem.created_at,
              connections: 0,
            },
            RECALL_TITLE_CHARS,
          )
        : null,
      prompt_excerpt: r.prompt_excerpt,
    };
  });

  return { total, limit, offset, items };
}

/**
 * PUT /dashboard/quality/verdict's pure handler — the dashboard's THIRD
 * scoped writer (after /dashboard/model and /dashboard/capture-pause; same
 * convention: strict validation, injected effect, 404 on unknown id).
 *
 * Body: `{id: number, verdict: 1 | -1}` — numeric thumbs (1 = useful, -1 =
 * not); no string aliases to mis-parse. `id` is a recall_verdicts row id
 * (the contested item's). The verdict persists as a NEW `grader='owner'`
 * row against the same (push_id, memory_id) — history is append-only, the
 * owner verdicts accumulate, and the auto-graded row it answers stays
 * untouched.
 */
export function recordOwnerVerdict(
  db: Database.Database,
  body: unknown,
  opts?: { now?: () => Date },
): { status: number; body: Record<string, unknown> } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { status: 400, body: { error: "Body must be a JSON object {id, verdict}" } };
  }
  const { id, verdict } = body as Record<string, unknown>;
  if (typeof id !== "number" || !Number.isInteger(id) || id < 1) {
    return { status: 400, body: { error: "Invalid 'id' — expected an integer verdict-row id" } };
  }
  if (verdict !== 1 && verdict !== -1) {
    return { status: 400, body: { error: "Invalid 'verdict' — expected 1 (useful) or -1 (not useful)" } };
  }
  const target = db
    .prepare("SELECT id, push_id, memory_id FROM recall_verdicts WHERE id = ?")
    .get(id) as { id: number; push_id: number | null; memory_id: string } | undefined;
  if (!target) {
    return { status: 404, body: { error: `No verdict row with id ${id}` } };
  }
  const now = opts?.now ? opts.now() : new Date();
  const nowIso = now.toISOString();
  const newId = insertVerdictRow(db, {
    ts: nowIso,
    day: nowIso.slice(0, 10),
    push_id: target.push_id,
    memory_id: target.memory_id,
    grader: "owner",
    score: verdict, // the thumb IS the score for owner rows
    confidence: 1, // owner verdicts are certain by definition
    verdict,
  });
  return { status: 200, body: { ok: true, id: newId, verdict, memory_id: target.memory_id } };
}
