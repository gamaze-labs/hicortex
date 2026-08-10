/**
 * `hicortex classify-types` — deliberate, resumable episode→fact/decision
 * reclassification pass over the memories corpus (#216).
 *
 * WHY THIS EXISTS
 * ---------------
 * Before #216 the distiller NEVER set memory_type — every distilled memory
 * defaulted to "episode" (storage.ts insertMemory `?? "episode"`), so the
 * corpus was ~98% episodes. The distiller now classifies each entry at extract
 * time via the [E]/[F]/[D] tag (distiller.ts), but the EXISTING corpus needs a
 * one-shot backfill. This command is that backfill — modelled on
 * `classify-domains` (resumable cursor, batched, infra-error-safe).
 *
 * WHAT IT DOES
 * ------------
 * Walks memories ordered by rowid in batches (default 200). Default scope =
 * episodes only (`memory_type = 'episode'`); `--all` reclassifies every memory
 * regardless of current type. For each memory, ONE constrained LLM call asks
 * the model to classify the content as episode / fact / decision. The reply is
 * parsed + validated, and `UPDATE memories SET memory_type = ? WHERE id = ?`
 * runs inside a per-batch transaction. The cursor (`typeCursor` in state.json)
 * advances to the last committed rowid after each batch — crash-safe and
 * infra-abort-safe (same discipline as classify-domains).
 *
 * Lessons are NEVER produced here: the reflection stage owns them. A model that
 * replies "lesson" is treated as unparseable (the memory keeps its current type
 * and is retried next run via the cursor).
 *
 * This command does NOT use the consolidation budget — it is a standalone CLI,
 * not a nightly stage.
 */

import { hicortexHome } from "./paths.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { initDb, resolveDbPath } from "./db.js";
import { loadState, updateState } from "./state.js";
import {
  LlmClient,
  resolveSavedLlmConfig,
} from "./llm.js";

const HICORTEX_HOME = hicortexHome();

/** Max chars of memory content fed to the classify prompt. */
const CLASSIFY_CONTENT_MAX_CHARS = 1500;

export interface ClassifyTypesOptions {
  /** Reclassify EVERY memory, not just episodes. */
  all?: boolean;
  /** Memories per batch (default 200). Cursor advances per committed batch. */
  batchSize?: number;
  /** Ignore the saved cursor and restart from rowid 0. */
  reset?: boolean;
  /** DB path override (tests). Defaults to resolveDbPath(). */
  dbPath?: string;
  /** State dir override (tests). Defaults to ~/.hicortex. */
  stateDir?: string;
  /** LLM override (tests). Bypasses config resolution. */
  llm?: LlmClient;
  /** Config override (tests). Defaults to reading stateDir/config.json. */
  config?: Record<string, unknown> | null;
}

export interface ClassifyTypesReport {
  /** Memories examined in this invocation. */
  scanned: number;
  /** Memories whose memory_type was changed. */
  reclassified: number;
  /** Episodes confirmed as episode (no change). */
  unchanged: number;
  /** Memories skipped due to an infra error (LLM threw twice). */
  failed: number;
  /** Batches processed. */
  batches: number;
  /** Cursor after this run. */
  cursor: number;
  /** Whether the run aborted early on an infra error. */
  aborted: boolean;
  /** Final per-type counts (whole corpus, post-run). */
  byType: Record<string, number>;
}

/** Valid distillation-time memory types (NO lesson — reflection owns that). */
const VALID_TYPES = new Set(["episode", "fact", "decision"]);

function readConfig(stateDir: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(join(stateDir, "config.json"), "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Build the constrained type-classification prompt for one memory. The model
 * must reply with ONLY the type word (episode/fact/decision) — no prose. The
 * distinction mirrors the distiller's [E]/[F]/[D] tag definitions (prompts.ts),
 * so distill-time and backfill-time classification stay consistent.
 */
export function buildTypeClassifyPrompt(content: string): string {
  const truncated = content.length > CLASSIFY_CONTENT_MAX_CHARS
    ? content.slice(0, CLASSIFY_CONTENT_MAX_CHARS) + "…"
    : content;
  return (
    `You are classifying a single memory by its TYPE and IMPORTANCE.\n\n` +
    `TYPES:\n` +
    `- episode: a specific event, interaction, or narrative — a one-time ` +
    `occurrence ("tried X, failed because Y", a correction, a debugging session).\n` +
    `- fact: a durable truth that holds across sessions, not tied to a single ` +
    `moment ("the API is at :8787", "uv is used for packages").\n` +
    `- decision: a choice made that future work builds on and a later decision ` +
    `can supersede ("switched from gemma4 to qwen3.5", "adopted the graded-schema ` +
    `tag model"). Not a fact (it can change) and not an episode (it persists).\n\n` +
    `IMPORTANCE (0.0–1.0):\n` +
    `- 0.8–1.0: load-bearing — a core fact or decision the agent must know.\n` +
    `- 0.5–0.8: useful context — relevant to current and future work.\n` +
    `- 0.2–0.5: marginal — situational, likely to fade.\n` +
    `- 0.0–0.2: noise — low value, safe to forget.\n` +
    `Facts and decisions tend to score higher than episodes (they persist).\n\n` +
    `MEMORY:\n${truncated}\n\n` +
    `Reply with ONLY: type importance (e.g. "fact 0.8"). No prose, no explanation.`
  );
}

/**
 * Parse the model's reply into a validated type. Accepts the bare word
 * (case-insensitive), tolerating surrounding whitespace, a trailing period, a
 * leading "Type:" label, and markdown emphasis. "lesson" is NEVER accepted
 * (the reflection stage owns lessons; a model that emits it is wrong) — returns
 * null so the caller retries.
 *
 * Returns null on anything unparseable or out-of-vocabulary so the caller can
 * retry once (matching classify-domains' two-attempt discipline).
 */
export function parseTypeReply(reply: string): { type: "episode" | "fact" | "decision"; score: number } | null {
  if (!reply) return null;
  let cleaned = reply.trim();

  // Take the first non-empty line — models sometimes add a justification below.
  const firstLine = cleaned.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  if (firstLine) cleaned = firstLine;

  // Strip a leading label like "Type:" / "Answer:".
  cleaned = cleaned.replace(/^(type|answer|classification)\s*[:\-]\s*/i, "");
  // Strip markdown emphasis, surrounding quotes/backticks, trailing punctuation.
  cleaned = cleaned
    .replace(/^[*_`"'\s]+/, "")
    .replace(/[*_`"']+$/, "")
    .trim();

  // Expected format: "type score" (e.g. "fact 0.8"). Parse both.
  const match = cleaned.toLowerCase().match(/^(episode|fact|decision)\s+([0-9]*\.?[0-9]+)/);
  if (match) {
    const type = match[1] as "episode" | "fact" | "decision";
    let score = parseFloat(match[2]);
    if (isNaN(score) || score < 0) score = 0.5;
    if (score > 1) score = 1;
    return { type, score };
  }

  // Backward compat: bare type word with no score (old prompt output).
  const bare = cleaned.toLowerCase().replace(/[.\s]+$/, "");
  if (VALID_TYPES.has(bare)) {
    return { type: bare as "episode" | "fact" | "decision", score: 0.5 };
  }

  return null;
}

/**
 * Classify one memory's type. Two attempts (one call, one retry on a throw OR
 * an unparseable reply). Returns the validated type, or null on infra error
 * (caller leaves the memory untouched and retries via the cursor next run).
 */
export async function classifyMemoryType(
  content: string,
  llm: LlmClient,
): Promise<{ type: "episode" | "fact" | "decision"; score: number } | null> {
  const prompt = buildTypeClassifyPrompt(content);

  for (let attempt = 0; attempt < 2; attempt++) {
    let raw: string;
    try {
      // ~20 tokens covers "type score" + headroom for models that add labels.
      const r = await llm.completeClassify(prompt, 20);
      raw = r.text;
    } catch (err) {
      if (attempt === 0) continue; // retry once
      console.warn(
        `[hicortex] type classify LLM error: ${err instanceof Error ? err.message : String(err)} — aborting this memory (will retry)`,
      );
      return null; // infra error → abort untouched
    }

    const parsed = parseTypeReply(raw);
    if (parsed) return parsed;

    if (attempt === 0) {
      console.warn(
        `[hicortex] type classify: unparseable reply "${raw.slice(0, 60)}" — retrying once`,
      );
    }
  }

  // Two successful calls, neither parseable → leave the memory's type unchanged.
  // We do NOT default to episode here: a model that can't decide should not
  // silently overwrite an existing type. Return null so the caller records a
  // failed classification and the cursor still advances past this row.
  return null;
}

/**
 * Run the classify-types pass. Returns a structured report.
 * Throws on unrecoverable setup errors (client mode, no LLM) — the cursor
 * always reflects the last committed batch.
 */
export async function runClassifyTypes(
  options: ClassifyTypesOptions = {},
): Promise<ClassifyTypesReport> {
  const batchSize = options.batchSize ?? 200;
  const stateDir = options.stateDir ?? HICORTEX_HOME;
  const all = options.all ?? false;

  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error(`[hicortex] classify-types: invalid --batch value: ${options.batchSize}`);
  }

  const config = options.config !== undefined ? options.config : readConfig(stateDir);

  // Server-mode only — client installs have no local DB.
  if (config?.mode === "client") {
    throw new Error(
      "[hicortex] classify-types is server-mode only (it needs the local DB). " +
        `This machine is a client of ${config.serverUrl ?? "a remote server"} — run it on the server.`,
    );
  }

  // Resolve the LLM (one model serves all phases — #231).
  let llm: LlmClient;
  if (options.llm) {
    llm = options.llm;
  } else {
    const resolved = resolveSavedLlmConfig(config);
    if (!resolved.config) {
      throw new Error(
        "[hicortex] classify-types: no LLM configured — run `npx @gamaze/hicortex init`.",
      );
    }
    llm = new LlmClient(resolved.config);
  }

  const dbPath = resolveDbPath(options.dbPath);
  const db = initDb(dbPath);

  const report: ClassifyTypesReport = {
    scanned: 0,
    reclassified: 0,
    unchanged: 0,
    failed: 0,
    batches: 0,
    cursor: 0,
    aborted: false,
    byType: {},
  };

  try {
    let cursor = options.reset ? 0 : (loadState(stateDir).typeCursor ?? 0);
    report.cursor = cursor;

    console.log(
      `[hicortex] classify-types starting: scope ${all ? "ALL" : "episodes only"}, ` +
        `batch ${batchSize}, cursor ${cursor}${options.reset ? " (reset)" : ""}`,
    );

    // Scope filter: default = episodes only; --all = everything.
    const scopeSql = all ? "rowid > ?" : "rowid > ? AND memory_type = 'episode'";
    const batchStmt = db.prepare(
      `SELECT rowid AS __rowid, id, content, memory_type FROM memories
       WHERE ${scopeSql} ORDER BY rowid ASC LIMIT ?`,
    );

    // Set true when the classifier returns null (infra error): finish the
    // current batch's already-classified writes, commit, advance cursor to the
    // last successfully-classified row, then stop.
    let infraAbort = false;

    for (;;) {
      const params = [cursor, batchSize];
      const rows = batchStmt.all(...params) as Array<{
        __rowid: number;
        id: string;
        content: string;
        memory_type: string | null;
      }>;
      if (rows.length === 0) break;

      let batchReclassified = 0;
      let batchUnchanged = 0;
      let scannedInBatch = 0;
      let failedInBatch = 0;
      // Highest rowid we can safely advance the cursor to (last row we fully
      // resolved — reclassified or confirmed — before any infra abort).
      let committedRowid = cursor;

      // Classify (network) OUTSIDE the write transaction; collect results.
      const writes: Array<{ id: string; type: string; score: number }> = [];
      for (const row of rows) {
        const result = await classifyMemoryType(row.content, llm);
        if (result === null) {
          // Infra error OR two unparseable replies — stop scanning; leave this
          // row untouched for retry. (Two unparseable replies is rare; treating
          // it as an abort rather than a skip means the cursor does not advance
          // past a possibly-systematically-broken row. Cheaper to re-run than
          // to silently lose classification for a whole batch.)
          infraAbort = true;
          failedInBatch++;
          break;
        }
        scannedInBatch++;
        if (result.type === row.memory_type) {
          batchUnchanged++;
        } else {
          batchReclassified++;
        }
        writes.push({ id: row.id, type: result.type, score: result.score });
        committedRowid = row.__rowid;
      }

      // Commit the resolved writes, then persist the cursor at the last fully
      // resolved rowid (crash-safe + infra-abort-safe: a re-run resumes there).
      const updateStmt = db.prepare(
        "UPDATE memories SET memory_type = ?, base_strength = ? WHERE id = ?",
      );
      const tx = db.transaction(() => {
        for (const w of writes) updateStmt.run(w.type, w.score, w.id);
      });
      tx();
      updateState((s) => { s.typeCursor = committedRowid; }, stateDir);

      report.scanned += scannedInBatch;
      report.reclassified += batchReclassified;
      report.unchanged += batchUnchanged;
      report.failed += failedInBatch;
      report.batches++;
      report.cursor = committedRowid;
      cursor = committedRowid;

      console.log(
        `[hicortex]   batch ${report.batches}: classified ${scannedInBatch}, ` +
          `reclassified ${batchReclassified}, unchanged ${batchUnchanged}, ` +
          `failed ${failedInBatch} (cursor ${committedRowid})${infraAbort ? " [infra abort]" : ""}`,
      );

      if (infraAbort) {
        report.aborted = true;
        console.warn(
          "[hicortex] classify-types ABORTED on a classify-endpoint error. " +
            "The failing memory is untouched; cursor at last committed batch — re-run when the endpoint is back up.",
        );
        break;
      }
    }

    // Final per-type counts across the whole corpus.
    const counts = db
      .prepare(
        `SELECT memory_type, COUNT(*) AS cnt FROM memories
         WHERE memory_type IS NOT NULL GROUP BY memory_type ORDER BY cnt DESC`,
      )
      .all() as Array<{ memory_type: string; cnt: number }>;
    for (const c of counts) report.byType[c.memory_type] = c.cnt;

    const breakdown =
      counts.map((c) => `${c.memory_type}=${c.cnt}`).join(", ") || "none";
    console.log(
      `[hicortex] classify-types ${report.aborted ? "ABORTED" : "complete"}: ` +
        `${report.scanned} classified, ${report.reclassified} reclassified, ` +
        `${report.unchanged} unchanged, ${report.failed} infra-skipped`,
    );
    console.log(`[hicortex]   by type: ${breakdown}`);

    return report;
  } finally {
    db.close();
  }
}
