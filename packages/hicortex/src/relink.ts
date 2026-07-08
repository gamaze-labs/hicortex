/**
 * `hicortex relink` — deliberate, resumable link-discovery pass over the
 * ENTIRE memories corpus (issue #143).
 *
 * The nightly's stageLinks only processes memories that are new since the
 * last consolidation, so everything ingested before the TS linking stage
 * (e.g. a migrated corpus) has never been through link discovery. This
 * command back-fills the graph by reusing the exact same discovery +
 * classification machinery (discoverLinkCandidates / classifyLinkCandidates
 * from consolidate.ts) — no new linking logic.
 *
 * Classification is HEURISTIC-ONLY (2026-07). LLM edge classification was
 * retired after the 672-link audit (see consolidate.ts Stage 3 header) found
 * the LLM-classified UPPERCASE types near-useless. relink therefore never needs
 * an LLM; the old `--no-llm`, `--max-llm-calls`, and `--llm-base-url/--llm-model`
 * flags are gone. The classifyLinkCandidates call is retained (shared with the
 * nightly) but takes no live LLM.
 *
 * Design:
 *   - Scope: all memories ordered by rowid, processed in batches (default 200).
 *   - Resumable: `relinkCursor` (last fully-committed rowid) is persisted in
 *     state.json after each batch. Interruption never loses more than the
 *     current batch. `--reset` restarts from rowid 0.
 *   - Candidates: reuses the STORED embedding from memory_vectors (no
 *     re-embedding); falls back to embedding the content only when a vector
 *     row is missing. Same rules as the nightly: top-10 neighbors, cosine
 *     above CONSOLIDATE_LINK_THRESHOLD (CROSS_PROJECT_LINK_THRESHOLD for
 *     cross-project pairs), capped at CONSOLIDATE_LINK_TOP_K.
 *   - Pair dedup: a candidate is skipped when a link already exists in EITHER
 *     direction (memory_links PK is directional, so reverse duplicates must
 *     be filtered here). Existing pairs are loaded once at start and the set
 *     is maintained as links are added during the run.
 *   - Classification: heuristic `extends`/`relates_to` only (classifyRelationship).
 *   - `--dry-run`: full discovery, zero writes, cursor untouched. Would-be
 *     links are reported with a breakdown by heuristic type.
 *
 * Server-mode only: relink needs the local DB. Client installs must run it
 * on the server machine.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type Database from "better-sqlite3";
import type { Memory } from "./types.js";
import { initDb, resolveDbPath } from "./db.js";
import * as storage from "./storage.js";
import {
  BudgetTracker,
  discoverLinkCandidates,
  classifyLinkCandidates,
  type LinkCandidate,
} from "./consolidate.js";
import type { EmbedFn } from "./retrieval.js";
import { loadState, updateState } from "./state.js";

const HICORTEX_HOME = join(homedir(), ".hicortex");

export interface RelinkOptions {
  /** Full discovery + would-be counts, zero writes, cursor untouched. */
  dryRun?: boolean;
  /** Memories per batch (default 200). Cursor advances per committed batch. */
  batchSize?: number;
  /** Ignore the saved cursor and restart from rowid 0. */
  reset?: boolean;
  /** DB path override (tests). Defaults to resolveDbPath(). */
  dbPath?: string;
  /** State dir override (tests). Defaults to ~/.hicortex. */
  stateDir?: string;
  /**
   * Fallback embedder for memories missing a memory_vectors row (tests).
   * Defaults to the local ONNX embedder, loaded lazily on first miss.
   */
  embedFn?: EmbedFn;
}

export interface RelinkReport {
  dryRun: boolean;
  /** Memories examined in this invocation. */
  scanned: number;
  /** Candidate pairs above the similarity threshold (before dedup). */
  candidatesFound: number;
  /** Candidates skipped: link existed in either direction BEFORE this run. */
  skippedExisting: number;
  /** Candidates skipped: pair already handled earlier in this run (a pair is
   *  discovered from both sides — the reverse discovery is not a new link). */
  skippedDuplicate: number;
  /** Links created (or, in dry-run, links that would be created). */
  linksCreated: number;
  /** Candidates classified by an LLM. Always 0 — LLM classification retired. */
  llmClassified: number;
  /** Candidates classified by the heuristic (always all of them now). */
  heuristicFallback: number;
  /** Final relationship-type breakdown of created (or would-be) links. */
  byType: Record<string, number>;
  /** Memories whose discovery failed (missing vector AND embed failure). */
  failed: number;
  /** Batches processed. */
  batches: number;
  /** Cursor after this run (unchanged in dry-run). */
  cursor: number;
  /** Why the run ended. Only "complete" now (the LLM budget path is retired). */
  stoppedReason: "complete";
}

function readConfig(stateDir: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(join(stateDir, "config.json"), "utf-8"));
  } catch {
    return null;
  }
}

/** Canonical unordered key for a memory pair — direction-insensitive dedup. */
function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** Load every existing link as an unordered pair set (both directions collapse). */
function loadExistingPairs(db: Database.Database): Set<string> {
  const rows = db
    .prepare("SELECT source_id, target_id FROM memory_links")
    .all() as Array<{ source_id: string; target_id: string }>;
  const pairs = new Set<string>();
  for (const row of rows) pairs.add(pairKey(row.source_id, row.target_id));
  return pairs;
}

/**
 * Read the stored embedding for a memory from memory_vectors.
 * Returns null when the row is missing (caller falls back to re-embedding).
 */
export function getStoredEmbedding(
  db: Database.Database,
  memoryId: string,
): Float32Array | null {
  const row = db
    .prepare("SELECT embedding FROM memory_vectors WHERE id = ?")
    .get(memoryId) as { embedding: Buffer } | undefined;
  if (!row?.embedding) return null;
  const buf = row.embedding;
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

/**
 * Run the relink pass. Returns a structured report.
 * Throws on unrecoverable errors (client mode, DB write failure) — the cursor
 * always reflects the last committed batch.
 *
 * Classification is heuristic-only (LLM edge classification retired 2026-07),
 * so relink never contacts an LLM.
 */
export async function runRelink(options: RelinkOptions = {}): Promise<RelinkReport> {
  const dryRun = options.dryRun ?? false;
  const batchSize = options.batchSize ?? 200;
  const stateDir = options.stateDir ?? HICORTEX_HOME;

  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error(`[hicortex] relink: invalid --batch value: ${options.batchSize}`);
  }

  // Server-mode only — client installs have no local DB.
  const config = readConfig(stateDir);
  if (config?.mode === "client") {
    throw new Error(
      "[hicortex] relink is server-mode only (it needs the local DB). " +
        `This machine is a client of ${config.serverUrl ?? "a remote server"} — run relink on the server.`,
    );
  }

  // Classification is heuristic-only — no LLM client, no budget cap.
  const budget = new BudgetTracker(Number.MAX_SAFE_INTEGER);

  const dbPath = resolveDbPath(options.dbPath);
  const db = initDb(dbPath);

  const report: RelinkReport = {
    dryRun,
    scanned: 0,
    candidatesFound: 0,
    skippedExisting: 0,
    skippedDuplicate: 0,
    linksCreated: 0,
    llmClassified: 0,
    heuristicFallback: 0,
    byType: {},
    failed: 0,
    batches: 0,
    cursor: 0,
    stoppedReason: "complete",
  };

  try {
    const totalMemories = storage.countMemories(db);
    let cursor = options.reset ? 0 : (loadState(stateDir).relinkCursor ?? 0);
    report.cursor = cursor;

    console.log(
      `[hicortex] relink starting (${dryRun ? "dry-run" : "heuristic"}): ${totalMemories} memories, ` +
        `batch ${batchSize}, cursor ${cursor}${options.reset ? " (reset)" : ""}`,
    );

    // Load all existing links once as an unordered pair set (471 rows on the
    // live corpus — trivial). `seenPairs` additionally accumulates pairs
    // handled during this run so re-runs AND within-run reverse candidates
    // never create duplicate edges.
    const preExistingPairs = loadExistingPairs(db);
    const seenPairs = new Set(preExistingPairs);

    const batchStmt = db.prepare(
      "SELECT rowid AS __rowid, * FROM memories WHERE rowid > ? ORDER BY rowid ASC LIMIT ?",
    );

    // Lazy fallback embedder — only loaded if a memory_vectors row is missing.
    let embedFn: EmbedFn | null = options.embedFn ?? null;
    const getEmbedFn = async (): Promise<EmbedFn> => {
      if (!embedFn) {
        const { embed } = await import("./embedder.js");
        embedFn = embed;
      }
      return embedFn;
    };

    for (;;) {
      const rows = batchStmt.all(cursor, batchSize) as Array<
        Record<string, unknown> & { __rowid: number }
      >;
      if (rows.length === 0) break;

      const lastRowid = rows[rows.length - 1].__rowid;

      // Phase A: discovery — reuse stored embeddings, same candidate rules
      // as the nightly (discoverLinkCandidates).
      const candidates: LinkCandidate[] = [];
      let batchSkippedExisting = 0;
      let batchSkippedDuplicate = 0;

      for (const row of rows) {
        const { __rowid: _ignored, ...memRow } = row;
        const mem = memRow as unknown as Memory;
        try {
          let embedding = getStoredEmbedding(db, mem.id);
          if (!embedding) {
            embedding = await (await getEmbedFn())(mem.content);
          }
          for (const cand of discoverLinkCandidates(db, mem, embedding)) {
            report.candidatesFound++;
            const key = pairKey(cand.source.id, cand.target.id);
            if (seenPairs.has(key)) {
              if (preExistingPairs.has(key)) batchSkippedExisting++;
              else batchSkippedDuplicate++;
              continue;
            }
            // Reserve the pair immediately so the reverse direction later in
            // this run (or this batch) is deduped too.
            seenPairs.add(key);
            candidates.push(cand);
          }
        } catch {
          report.failed++;
        }
      }
      report.skippedExisting += batchSkippedExisting;
      report.skippedDuplicate += batchSkippedDuplicate;

      // Phase B: classification — shared heuristic-only path (LLM retired).
      // classifyLinkCandidates ignores the null LLM/budget and returns each
      // candidate's heuristic type (extends/relates_to).
      const classified = await classifyLinkCandidates(candidates, null, budget);
      const types = classified.types;
      report.llmClassified += classified.llmClassified; // always 0
      report.heuristicFallback += classified.heuristicFallback;

      // Phase C: store — one transaction per batch, then persist the cursor.
      // A crash between commit and cursor save is safe: the re-run re-scans
      // the batch but the pair dedup (loaded from the DB) skips every link.
      if (!dryRun) {
        const tx = db.transaction(() => {
          for (let i = 0; i < candidates.length; i++) {
            const c = candidates[i];
            storage.addLink(db, c.source.id, c.target.id, types[i], c.similarity);
          }
        });
        tx();
        updateState((s) => {
          s.relinkCursor = lastRowid;
        }, stateDir);
        report.cursor = lastRowid;
      }

      for (const t of types) report.byType[t] = (report.byType[t] ?? 0) + 1;
      report.linksCreated += candidates.length;
      report.scanned += rows.length;
      report.batches++;
      cursor = lastRowid;

      console.log(
        `[hicortex]   batch ${report.batches}: scanned ${rows.length}, ` +
          `candidates ${candidates.length + batchSkippedExisting + batchSkippedDuplicate}, ` +
          `skipped ${batchSkippedExisting} already-linked + ${batchSkippedDuplicate} duplicate, ` +
          `${dryRun ? "would create" : "created"} ${candidates.length} ` +
          `(cursor ${lastRowid}, ${report.scanned} scanned this run)`,
      );
    }

    // Final summary
    const typeBreakdown =
      Object.entries(report.byType)
        .sort((a, b) => b[1] - a[1])
        .map(([t, n]) => `${t}=${n}`)
        .join(", ") || "none";
    console.log(
      `[hicortex] relink complete` +
        `${dryRun ? " (dry-run, nothing written)" : ""}: ` +
        `${report.scanned} memories scanned, ${report.candidatesFound} candidates, ` +
        `${report.skippedExisting} already linked, ${report.skippedDuplicate} reverse-duplicates, ` +
        `${report.linksCreated} links ${dryRun ? "would be created" : "created"} ` +
        `(heuristic ${report.heuristicFallback})`,
    );
    console.log(`[hicortex]   by type: ${typeBreakdown}`);
    if (report.failed > 0) {
      console.warn(`[hicortex]   ${report.failed} memories failed discovery (see errors above)`);
    }

    return report;
  } finally {
    db.close();
  }
}
