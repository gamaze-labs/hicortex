/**
 * `hicortex classify-domains` — deliberate, resumable content-based domain
 * classification pass over the memories corpus (feat/content-domains).
 *
 * The nightly's content-domain stage only files NULL/stale rows incrementally.
 * This command back-fills the whole corpus on demand, with the same discipline
 * as `hicortex relink`:
 *   - Scope: memories ordered by rowid, processed in batches (default 200).
 *     Default scope = rows whose domain is NULL or not in the configured set.
 *     `--all` reclassifies EVERY memory.
 *   - Resumable: `domainCursor` (last fully-committed rowid) persisted in
 *     state.json after each batch. Interruption never loses more than the
 *     current batch. `--reset` restarts from rowid 0.
 *   - Classification: one constrained MULTI-TAG LLM call per memory via the
 *     CLASSIFY tier (classifyBaseUrl/classifyModel when configured, else the
 *     reflect tier), same as the nightly. The LLM emits ONLY the ordered tag
 *     set; per-tag weights come from the domain prototypes (computed once at
 *     run start) and the PRIMARY (memories.domain) is derived (argmax weight,
 *     compartment override, LLM order breaking ties) inside
 *     storage.setMemoryTags. After a completed (non-aborted) run the
 *     prototypes, all weights, and all primaries are recomputed from the
 *     final tag sets — same reconsolidation pass as the nightly.
 *   - No-fit (owner amendment 07.07): an LLM reply of {"tags": []} means no
 *     configured domain fits — there is NO fallback category. The memory gets
 *     a WEAK primary (argmax prototype cosine, when >= weakPrimaryFloor) or,
 *     below the floor, accelerated decay (base_strength halved, domain left
 *     NULL so later runs re-attempt it). See nofit.ts.
 *   - LLM pre-flight: the endpoint classification will actually use (when a
 *     separate Ollama) is probed before any work. If unreachable, abort
 *     cleanly (nothing written, cursor untouched) — strict, like distill.
 *   - Infra-error abort (issue #150): if the classifier returns null mid-run
 *     (endpoint died AFTER preflight), the run aborts after committing
 *     the last full batch. The failing memory is left completely untouched; the
 *     cursor sits at the last committed batch so a re-run resumes cleanly.
 *   - Server-mode only: needs the local DB.
 *
 * Requires a `domains` list in ~/.hicortex/config.json — without it there is
 * nothing to classify into and the command exits with a clear message.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { initDb, resolveDbPath } from "./db.js";
import { loadState, updateState } from "./state.js";
import * as storage from "./storage.js";
import {
  LlmClient,
  resolveSavedLlmConfig,
  resolveClassifyProbeTarget,
  probeOllamaModel,
  type LlmConfig,
} from "./llm.js";
import {
  classifyMemoryTags,
  parseConfigDomains,
  domainSetHash,
  type DomainDef,
} from "./domain-classify.js";
import { rebuildContentModuleIndex } from "./consolidate.js";
import {
  compartmentSet,
  computeDomainPrototypes,
  computeTagWeights,
  derivePrimary,
  recomputeAllTagWeights,
  refreshPrimaries,
} from "./schema-prototypes.js";
import {
  applyNoAssociationDecay,
  applyWeakPrimary,
  resolveNoFit,
  resolveWeakPrimaryFloor,
  type NoFitResolution,
} from "./nofit.js";
import type { EmbedFn } from "./retrieval.js";

const HICORTEX_HOME = join(homedir(), ".hicortex");

export interface ClassifyDomainsOptions {
  /** Reclassify EVERY memory, not just NULL/stale-domain rows. */
  all?: boolean;
  /** Memories per batch (default 200). Cursor advances per committed batch. */
  batchSize?: number;
  /** Ignore the saved cursor and restart from rowid 0. */
  reset?: boolean;
  /** DB path override (tests). Defaults to resolveDbPath(). */
  dbPath?: string;
  /** State dir override (tests). Defaults to ~/.hicortex. */
  stateDir?: string;
  /** LLM override (tests). Bypasses config resolution + preflight. */
  llm?: LlmClient;
  /** Config override (tests). Defaults to reading stateDir/config.json. */
  config?: Record<string, unknown> | null;
  /**
   * Embedder override (tests). Used only for domain-description prototype
   * seeds; defaults to the local ONNX embedder, loaded lazily on first need
   * (same pattern as relink).
   */
  embedFn?: EmbedFn;
}

export interface ClassifyDomainsReport {
  /** Memories examined in this invocation. */
  scanned: number;
  /** Memories whose tags were written (primary changed or first-set). */
  classified: number;
  /** Memories whose primary was already the classified value (no rewrite). */
  unchanged: number;
  /** Memories skipped due to an infra error (classifier returned null). */
  failed: number;
  /** No-fit memories that earned a WEAK primary (prototype argmax >= floor). */
  weakPrimary: number;
  /** No-fit memories below the floor — untagged, base_strength halved. */
  noAssociationDecayed: number;
  /** Batches processed. */
  batches: number;
  /** Cursor after this run. */
  cursor: number;
  /** Whether the run aborted early on an infra error (classifier null). */
  aborted: boolean;
  /** Final per-PRIMARY memory counts (whole corpus, post-run). */
  byDomain: Record<string, number>;
  /** Total tag assignments across memory_tags (whole corpus, post-run). */
  totalTags: number;
  /** Post-run reconsolidation: memory_tags rows whose weight was recomputed. */
  weightsRecomputed: number;
  /** Post-run reconsolidation: memories whose derived primary changed. */
  primariesUpdated: number;
}

function readConfig(stateDir: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(join(stateDir, "config.json"), "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Pre-flight the endpoint classification will ACTUALLY use — the classify
 * tier (classifyModel/classifyBaseUrl) when configured, else the reflect tier.
 * Target resolution is the pure resolveClassifyProbeTarget (llm.ts), the same
 * source of truth as the nightly's contentDomainsReady gate.
 *
 * Returns null when ready, or a reason string when it is unreachable (caller
 * aborts clean). Only a separate Ollama endpoint can go unreachable mid-run;
 * API providers are cloud-reachable.
 */
async function preflightClassify(config: LlmConfig): Promise<string | null> {
  const target = resolveClassifyProbeTarget(config);
  if (!target) return null;
  const health = await probeOllamaModel(target.baseUrl, target.model);
  if (!health.ok) {
    return health.reason === "unreachable"
      ? `${target.tier} endpoint unreachable (${target.baseUrl})`
      : `${target.tier} model not loaded (${target.model} missing on ${target.baseUrl})`;
  }
  return null;
}

/**
 * Run the classify-domains pass. Returns a structured report.
 * Throws on unrecoverable setup errors (client mode, no domains, no LLM,
 * classification endpoint down) — the cursor always reflects the last
 * committed batch.
 */
export async function runClassifyDomains(
  options: ClassifyDomainsOptions = {},
): Promise<ClassifyDomainsReport> {
  const batchSize = options.batchSize ?? 200;
  const stateDir = options.stateDir ?? HICORTEX_HOME;
  const all = options.all ?? false;

  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error(`[hicortex] classify-domains: invalid --batch value: ${options.batchSize}`);
  }

  const config = options.config !== undefined ? options.config : readConfig(stateDir);

  // Server-mode only — client installs have no local DB.
  if (config?.mode === "client") {
    throw new Error(
      "[hicortex] classify-domains is server-mode only (it needs the local DB). " +
        `This machine is a client of ${config.serverUrl ?? "a remote server"} — run it on the server.`,
    );
  }

  const domains: DomainDef[] | null = parseConfigDomains(config);
  if (!domains) {
    throw new Error(
      "[hicortex] classify-domains needs a `domains` list in ~/.hicortex/config.json. " +
        'Add e.g. { "domains": [{ "name": "Work", "description": "..." }, ' +
        '{ "name": "Boating", "description": "..." }] } and re-run. ' +
        "No fallback bucket is needed — no-fit memories are handled automatically.",
    );
  }
  const weakPrimaryFloor = resolveWeakPrimaryFloor(config);

  // Resolve the LLM (classify tier does the classifying; falls back to reflect).
  let llm: LlmClient;
  if (options.llm) {
    llm = options.llm;
  } else {
    const resolved = resolveSavedLlmConfig(config);
    if (!resolved.config) {
      throw new Error(
        "[hicortex] classify-domains: no LLM configured — run `npx @gamaze/hicortex init`.",
      );
    }
    const classifyDown = await preflightClassify(resolved.config);
    if (classifyDown) {
      throw new Error(
        `[hicortex] classify-domains aborted: ${classifyDown}. ` +
          "Nothing written, cursor untouched — retry when the endpoint is up.",
      );
    }
    llm = new LlmClient(resolved.config);
  }

  const dbPath = resolveDbPath(options.dbPath);
  const db = initDb(dbPath);

  const report: ClassifyDomainsReport = {
    scanned: 0,
    classified: 0,
    unchanged: 0,
    failed: 0,
    weakPrimary: 0,
    noAssociationDecayed: 0,
    batches: 0,
    cursor: 0,
    aborted: false,
    byDomain: {},
    totalTags: 0,
    weightsRecomputed: 0,
    primariesUpdated: 0,
  };

  try {
    let cursor = options.reset ? 0 : (loadState(stateDir).domainCursor ?? 0);
    report.cursor = cursor;

    console.log(
      `[hicortex] classify-domains starting: ${domains.length} domains, ` +
        `scope ${all ? "ALL" : "null/stale"}, batch ${batchSize}, cursor ${cursor}` +
        `${options.reset ? " (reset)" : ""}`,
    );

    // Lazy embedder — only loaded if a domain needs a description seed
    // (member_count < 5). Same pattern as relink's fallback embedder.
    let embedFn: EmbedFn | null = options.embedFn ?? null;
    const getEmbedFn = async (): Promise<EmbedFn> => {
      if (!embedFn) {
        const { embed } = await import("./embedder.js");
        embedFn = embed;
      }
      return embedFn;
    };

    // Prototypes once at run start — newly classified memories get their
    // weights from these; the post-run reconsolidation pass refreshes
    // everything from the final tag sets.
    const compartments = compartmentSet(domains);
    const { prototypes } = await computeDomainPrototypes(db, domains, getEmbedFn);

    // Scope filter: default = NULL / not-in-set / no tags yet; --all = everything.
    const placeholders = domains.map(() => "?").join(", ");
    const scopeSql = all
      ? "rowid > ?"
      : `rowid > ? AND (domain IS NULL OR domain NOT IN (${placeholders}) ` +
        `OR id NOT IN (SELECT DISTINCT memory_id FROM memory_tags))`;
    const batchStmt = db.prepare(
      `SELECT rowid AS __rowid, id, content, project, domain FROM memories
       WHERE ${scopeSql} ORDER BY rowid ASC LIMIT ?`,
    );

    // Set true when the classifier returns null (infra error): finish the
    // current batch's already-classified writes, commit, advance cursor to the
    // last SUCCESSFULLY-classified row, then stop (the failing row is untouched).
    let infraAbort = false;

    for (;;) {
      const params = all ? [cursor, batchSize] : [cursor, ...domains.map((d) => d.name), batchSize];
      const rows = batchStmt.all(...params) as Array<{
        __rowid: number;
        id: string;
        content: string;
        project: string | null;
        domain: string | null;
      }>;
      if (rows.length === 0) break;

      let batchClassified = 0;
      let batchUnchanged = 0;
      let batchWeakPrimary = 0;
      let batchNoAssociation = 0;
      let scannedInBatch = 0;
      // Highest rowid we can safely advance the cursor to (last row we fully
      // resolved — classified or unchanged — before any infra abort).
      let committedRowid = cursor;

      // Classify (network) OUTSIDE the write transaction; collect results.
      // No-fit resolution (resolveNoFit) is read-only, so it also happens in
      // the scan phase; only the writes are deferred to the transaction.
      const writes: Array<
        | { kind: "tags"; id: string; tags: string[]; weights: Record<string, number | null> }
        | { kind: "nofit"; id: string; resolution: NoFitResolution }
      > = [];
      for (const row of rows) {
        const result = await classifyMemoryTags(row.content, row.project, domains, llm);
        if (result === null) {
          // Infra error — stop scanning; leave this row untouched for retry.
          infraAbort = true;
          break;
        }
        scannedInBatch++;
        if (result.tags.length === 0) {
          // Genuine no-fit (owner amendment 07.07): weak primary from the
          // prototype argmax when it clears the floor, else accelerated
          // decay. Each rowid is visited at most once per run (cursor is
          // strictly increasing), so a run never double-halves.
          const resolution = resolveNoFit(db, row.id, domains, prototypes, weakPrimaryFloor);
          if (resolution.kind === "weak_primary") {
            batchWeakPrimary++;
            if (resolution.domain === row.domain) batchUnchanged++;
            else batchClassified++;
          } else {
            batchNoAssociation++;
          }
          writes.push({ kind: "nofit", id: row.id, resolution });
          committedRowid = row.__rowid;
          continue;
        }
        // Derived primary (argmax weight from the run-start prototypes,
        // compartment override, LLM order breaking ties) — the same value
        // setMemoryTags will write below.
        const weights = computeTagWeights(db, row.id, result.tags, prototypes);
        const derived = derivePrimary(
          result.tags.map((tag) => ({ tag, weight: weights[tag] ?? null })),
          compartments,
        );
        if (derived === row.domain) {
          batchUnchanged++;
        } else {
          batchClassified++;
        }
        writes.push({ kind: "tags", id: row.id, tags: result.tags, weights });
        committedRowid = row.__rowid;
      }

      // Commit the resolved writes, then persist the cursor at the last fully
      // resolved rowid (crash-safe + infra-abort-safe: a re-run resumes there).
      const tx = db.transaction(() => {
        for (const w of writes) {
          if (w.kind === "tags") {
            storage.setMemoryTags(db, w.id, w.tags, { weights: w.weights, compartments });
          } else if (w.resolution.kind === "weak_primary") {
            applyWeakPrimary(db, w.id, w.resolution.domain, w.resolution.weight, compartments);
          } else {
            applyNoAssociationDecay(db, w.id);
          }
        }
      });
      tx();
      updateState((s) => { s.domainCursor = committedRowid; }, stateDir);

      report.scanned += scannedInBatch;
      report.classified += batchClassified;
      report.unchanged += batchUnchanged;
      report.weakPrimary += batchWeakPrimary;
      report.noAssociationDecayed += batchNoAssociation;
      report.batches++;
      report.cursor = committedRowid;
      cursor = committedRowid;

      console.log(
        `[hicortex]   batch ${report.batches}: resolved ${scannedInBatch}, ` +
          `classified ${batchClassified}, unchanged ${batchUnchanged}, ` +
          `weak-primary ${batchWeakPrimary}, no-association ${batchNoAssociation} ` +
          `(cursor ${committedRowid})${infraAbort ? " [infra abort]" : ""}`,
      );

      if (infraAbort) {
        report.aborted = true;
        report.failed++;
        console.warn(
          "[hicortex] classify-domains ABORTED on a classify-endpoint error. " +
            "The failing memory is untouched; cursor at last committed batch — re-run when the endpoint is back up.",
        );
        break;
      }
    }

    // Post-run reconsolidation (same pass as the nightly, skipped on infra
    // abort — the corpus is partially classified; the next full run or nightly
    // repairs it): recompute prototypes from the FINAL tag sets, refresh every
    // weight and derived primary, then rebuild the moduleIndex counts from the
    // refreshed primaries.
    if (!report.aborted) {
      const { prototypes: finalPrototypes } = await computeDomainPrototypes(db, domains, getEmbedFn);
      report.weightsRecomputed = recomputeAllTagWeights(db, finalPrototypes).updated;
      report.primariesUpdated = refreshPrimaries(db, domains).updated;
      rebuildContentModuleIndex(db, domains, stateDir);
    }

    // Final per-PRIMARY counts across the whole corpus.
    const counts = db
      .prepare(
        `SELECT domain, COUNT(*) AS cnt FROM memories WHERE domain IS NOT NULL GROUP BY domain ORDER BY cnt DESC`,
      )
      .all() as Array<{ domain: string; cnt: number }>;
    for (const c of counts) report.byDomain[c.domain] = c.cnt;

    // Total tag assignments across memory_tags (multi-label breadth).
    report.totalTags = (
      db.prepare("SELECT COUNT(*) AS cnt FROM memory_tags").get() as { cnt: number }
    ).cnt;

    const breakdown =
      counts.map((c) => `${c.domain}=${c.cnt}`).join(", ") || "none";
    console.log(
      `[hicortex] classify-domains ${report.aborted ? "ABORTED" : "complete"}: ` +
        `${report.scanned} resolved, ${report.classified} (re)filed, ` +
        `${report.unchanged} unchanged, ${report.weakPrimary} weak-primary, ` +
        `${report.noAssociationDecayed} no-association decayed, ${report.failed} infra-skipped, ` +
        `${report.totalTags} total tags, ${report.weightsRecomputed} weights recomputed, ` +
        `${report.primariesUpdated} primaries updated (hash ${domainSetHash(domains).slice(0, 8)})`,
    );
    console.log(`[hicortex]   by primary: ${breakdown}`);

    return report;
  } finally {
    db.close();
  }
}
