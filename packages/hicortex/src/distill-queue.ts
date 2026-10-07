/**
 * The durable distill inbox + its drain (#529).
 *
 * Delivery and compute are separated: `POST /distill` in queue mode stores the
 * REDACTED segment in the `distill_queue` table (migration v24) and answers
 * 201 immediately — no LLM call, no probe, no chunk-size detection, no token
 * gate (all of those move to the drain). The nightly's drain stage then
 * distills queued items oldest-first, round-robin per client, before
 * consolidation, so all distill LLM traffic happens inside the owner's
 * scheduled runs instead of on the clients' drifting capture grids.
 *
 * This module holds BOTH halves as pure units:
 *  - the inbox STORE (enqueue, dedup mirrors, depth/age stats, delete) — real
 *    functions the /distill handler calls directly;
 *  - the DRAIN — dependency-injected (LlmClient-like object, embed fn,
 *    yield-probe, token-budget gate, run deadline, sleep) so the whole stage
 *    is unit-testable with no HTTP and no real LLM. Every LLM call goes
 *    through `distillSession` (distiller.ts) on the injected client — never a
 *    bespoke fetch — so the drain inherits the #337 undici dispatcher, #355
 *    single-flight, the retry ladder, and the circuit breaker by construction.
 *
 * Ordering contract (spec #529): oldest-first (rowid = arrival order),
 * round-robin per client key (`source_machine` + `source_agent`) so one
 * client's giant backlog cannot starve the others, and a session's segments
 * in arrival order (natural — a client POSTs its segments sequentially, so
 * ascending rowid within a client is per-session ascending).
 *
 * Checkpointing contract: per item, ALL memory inserts and the inbox-row
 * delete commit in ONE transaction. An interrupted run (crash, deadline,
 * endpoint outage) leaves processed items done and the rest queued — the
 * segment-exact dedup keys (`<sid>#<segment_id>#<i>`) make the retry
 * idempotent, dup-over-loss.
 */

import type Database from "better-sqlite3";
import { distillSession, detectChunkSize, type DistilledEntry } from "./distiller.js";
import type { LlmClient, LlmUsage, LlmConfig } from "./llm.js";
import {
  DRAIN_YIELD_POLL_MS,
  DRAIN_YIELD_WAIT_CAP_MS,
} from "./calibration.js";
import * as storage from "./storage.js";
import { countExistingSegment, countExistingSession } from "./dedup.js";
import type { RunDeadline } from "./run-deadline.js";

// ---------------------------------------------------------------------------
// Inbox store — called directly by the /distill handler (queue mode)
// ---------------------------------------------------------------------------

/** One queued delivery, as stored in `distill_queue`. */
export interface DistillQueueRow {
  id: number;
  session_id: string | null;
  segment_id: string;
  source_agent: string | null;
  source_agent_id: string | null;
  source_domain: string | null;
  source_machine: string | null;
  project: string | null;
  session_date: string | null;
  privacy: string | null;
  text: string;
  arrived_at: string;
}

/**
 * The wire fields of one /distill POST, as the queue-mode handler resolved
 * them (post-redaction). `session_date` defaults to today AT ENQUEUE TIME —
 * the sync path stamps `new Date()` at delivery, and the queue must not let a
 * segment that waited ~12 h in the inbox drift to the drain-day's date.
 */
export interface EnqueueDistillInput {
  /** REDACTED conversation text (the handler redacts before enqueueing). */
  text: string;
  source_agent?: unknown;
  source_agent_id?: unknown;
  source_domain?: unknown;
  source_machine?: unknown;
  project?: unknown;
  session_id?: unknown;
  segment_id?: unknown;
  session_date?: unknown;
  privacy?: unknown;
}

/** Normalize an unknown wire value into a nullable string column. */
function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Insert one delivery into the inbox. Idempotent on the UNIQUE(session_id,
 * segment_id) index — a re-POST of the SAME key (only reachable through a
 * race: the handler's prechecks already answered the sequential re-POST with
 * a 200 skip) reports `{ duplicate: true }` and inserts nothing. Posts with
 * no session_id have no dedup key by construction and always insert (SQLite
 * unique indexes treat NULLs as distinct).
 */
export function enqueueDistill(
  db: Database.Database,
  input: EnqueueDistillInput,
): { duplicate: boolean } {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO distill_queue
         (session_id, segment_id, source_agent, source_agent_id, source_domain,
          source_machine, project, session_date, privacy, text, arrived_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      str(input.session_id),
      typeof input.segment_id === "string" ? input.segment_id : "",
      str(input.source_agent),
      str(input.source_agent_id),
      str(input.source_domain),
      str(input.source_machine),
      str(input.project),
      // Resolve the date ONCE at delivery (mirrors the sync handler): absent
      // or non-string becomes today, and the drain reuses the stored value so
      // a queued segment keeps its session date.
      str(input.session_date) ?? new Date().toISOString().slice(0, 10),
      str(input.privacy),
      input.text,
      new Date().toISOString(),
    );
  return { duplicate: result.changes === 0 };
}

/**
 * Inbox mirror of the segment-exact delivery precheck: how many QUEUED rows
 * match this exact `session_id` + `segment_id`. The handler adds this to
 * `countExistingSegment` so a queued-but-undistilled segment's re-POST
 * answers 200 skipped — the client's cursor advances and the segment is
 * never queued twice.
 */
export function countQueuedSegment(
  db: Database.Database,
  sessionId: string,
  segmentId: string,
): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS c FROM distill_queue WHERE session_id = ? AND segment_id = ?")
      .get(sessionId, segmentId) as { c: number }
  ).c;
}

/**
 * Inbox mirror of the legacy session-level precheck: how many QUEUED rows
 * belong to this session (whole-session OR any segment) — a legacy
 * whole-session re-POST while any part of the session sits queued skips.
 */
export function countQueuedSession(db: Database.Database, sessionId: string): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS c FROM distill_queue WHERE session_id = ?")
      .get(sessionId) as { c: number }
  ).c;
}

/** Queue depth (rows pending distillation). */
export function queueDepth(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM distill_queue").get() as { c: number }).c;
}

/** Age (ms) of the oldest queued item; null when the inbox is empty. */
export function oldestQueueAgeMs(db: Database.Database, now: number = Date.now()): number | null {
  const row = db
    .prepare("SELECT MIN(arrived_at) AS a FROM distill_queue")
    .get() as { a: string | null };
  if (!row.a) return null;
  const t = new Date(row.a).getTime();
  // Unparseable stamp (clock corruption at write time) reads as age 0 — the
  // honest floor — rather than NaN leaking into status/dashboard output.
  return Number.isFinite(t) ? Math.max(0, now - t) : 0;
}

/** The visibility shape shared by `hicortex status`, /health/detail, and the
 *  dashboard payload: depth + oldest-item age in hours (null = empty). */
export interface QueueStats {
  depth: number;
  oldest_age_hours: number | null;
}

export function readQueueStats(db: Database.Database, now: number = Date.now()): QueueStats {
  const age = oldestQueueAgeMs(db, now);
  return {
    depth: queueDepth(db),
    oldest_age_hours: age === null ? null : Math.round((age / 3_600_000) * 10) / 10,
  };
}

/** Delete one inbox row (its id from `distill_queue`). */
function deleteQueuedRow(db: Database.Database, id: number): void {
  db.prepare("DELETE FROM distill_queue WHERE id = ?").run(id);
}

// ---------------------------------------------------------------------------
// Queue-mode decision — shared by the /distill handler and its mirror tests
// ---------------------------------------------------------------------------

/**
 * #529 bootstrap carve-out: a FRESH brain (empty memories table AND empty
 * inbox) distills synchronously, exactly as pre-#529 — the first-ever
 * delivery must not wait ~12 h for the next scheduled run. Anything else
 * (memories exist OR rows are already queued) is ordinary queue mode.
 */
export function isFreshBrain(db: Database.Database): boolean {
  const mem = db
    .prepare("SELECT EXISTS(SELECT 1 FROM memories LIMIT 1) AS e")
    .get() as { e: number };
  if (mem.e === 1) return false;
  const queued = db
    .prepare("SELECT EXISTS(SELECT 1 FROM distill_queue LIMIT 1) AS e")
    .get() as { e: number };
  return queued.e === 0;
}

/**
 * The ONE branch condition into the sync flow (owner ruling #529: kill
 * switch and bootstrap carve-out share it — no third path):
 *
 *   queueMode = distillQueue enabled && NOT a fresh brain
 *
 * `distillQueueEnabled` is the already-strict-boolean-resolved kill switch
 * (`readStrictBoolean(config, "distillQueue") !== false`, default ON); false
 * lands here always → today's synchronous distill byte-for-byte.
 */
export function resolveQueueMode(db: Database.Database, distillQueueEnabled: boolean): boolean {
  return distillQueueEnabled && !isFreshBrain(db);
}

// ---------------------------------------------------------------------------
// Drain — the nightly stage
// ---------------------------------------------------------------------------

/**
 * The structural minimum the drain needs from an LLM client: `complete()` is
 * the ONE surface (#405). Real `LlmClient` satisfies it; tests inject a stub.
 * (LlmClient has private fields, so it cannot be the parameter type itself —
 * distillSession only ever calls `complete()` on the value we pass.)
 */
export interface DrainLlm {
  complete(prompt: string): Promise<{ text: string; usage?: LlmUsage }>;
}

/** One yield-probe outcome (the HTTP shape is the caller's concern — nightly). */
export type YieldStatus = "busy" | "idle" | "unreachable";

export interface DrainOptions {
  /** The LLM client all distill calls go through (null = no LLM configured). */
  llm: DrainLlm | null;
  /** Its config — drives the cached chunk-size detection, like the handler. */
  llmConfig: LlmConfig | null;
  /** Embed fn for the distilled entries (the nightly's embedder). */
  embed: (text: string) => Promise<Float32Array>;
  /**
   * #5 token-budget gate, checked BETWEEN items (and once before the first
   * item — zero LLM calls when already over the monthly cap). Injected so the
   * drain unit never touches state.json; the nightly passes
   * `() => isTokenBudgetExceeded(stateDir)`.
   */
  budgetExceeded?: () => boolean;
  /** The ONE run deadline (#405) — `hit("drain")` between items. */
  deadline?: RunDeadline;
  /**
   * #529 yield signal: the configured `drainYieldUrl`. Absent/unset ⇒ never
   * wait. Provided with `probeBusy`, the drain waits out "busy" answers
   * between items (bounded by the deadline + the wait cap).
   */
  yieldUrl?: string;
  /** The probe itself (HTTP lives in nightly.ts; tests inject a fake). */
  probeBusy?: (url: string) => Promise<YieldStatus>;
  /** Injectable clock-wait so tests exercise busy-loops instantly. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Injectable chunk-size detector (tests pin it; production defaults to the
   * real detectChunkSize, cached per endpoint like the /distill handler).
   */
  detectChunkSize?: typeof detectChunkSize;
}

export interface DrainReport {
  /**
   * "empty" (nothing queued — the common case right after a clean run),
   * "completed" (every item done), "deferred" (run deadline fired; the rest
   * stays queued for the next scheduled run), "budget" (monthly token cap;
   * zero LLM calls past the refusal), "no_llm" (no LLM configured — items
   * stay queued, consolidation reports its own no_llm), or "endpoint_down"
   * (the first item's distillation threw after the ladder/breaker — never a
   * tight retry loop; processed items stay done).
   */
  outcome: "empty" | "completed" | "deferred" | "budget" | "no_llm" | "endpoint_down";
  /** Items fully processed (distilled or duplicate-skipped) this run. */
  processed: number;
  /** Of those, items that were already stored and only had their row deleted. */
  duplicates: number;
  /** Memories inserted this run. */
  memories: number;
  /** Items still queued after this run. */
  remaining: number;
  /** Tokens metered this drain (incl. a failed item's partial usage). */
  usage: { prompt: number; completion: number; total: number };
}

/** Chunk-size cache, keyed per endpoint exactly like the handler's. */
const chunkSizeCache = new Map<string, number>();

async function resolveDrainChunkSize(opts: DrainOptions): Promise<number> {
  const cfg = opts.llmConfig!;
  const detect = opts.detectChunkSize ?? detectChunkSize;
  const cacheKey = `${cfg.provider}/${cfg.model}@${cfg.baseUrl}`;
  if (!chunkSizeCache.has(cacheKey)) {
    chunkSizeCache.set(cacheKey, await detect(cfg.provider, cfg.model, cfg.baseUrl, cfg.numCtx));
  }
  return chunkSizeCache.get(cacheKey)!;
}

/** Client key for round-robin: machine + agent (the spec's fairness unit). */
function clientKey(row: DistillQueueRow): string {
  return `${row.source_machine ?? ""}|${row.source_agent ?? ""}`;
}

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Wait out a busy yield signal between items. Returns true to proceed with
 * the item, false when the run deadline fired mid-wait (the caller stops the
 * drain — never starts a fresh LLM call past the deadline). Fail-open by
 * design: unset URL, absent probe, or an unreachable signal all proceed
 * (unreachable logs ONE warn per run). The per-item wait is bounded by
 * DRAIN_YIELD_WAIT_CAP_MS so a stuck "busy" answer cannot pin the run.
 */
async function waitForYield(
  opts: DrainOptions,
  warned: { unreachable: boolean },
): Promise<boolean> {
  if (!opts.yieldUrl || !opts.probeBusy) return true;
  const sleep = opts.sleep ?? sleepMs;
  let waited = 0;
  for (;;) {
    let status: YieldStatus;
    try {
      status = await opts.probeBusy(opts.yieldUrl);
    } catch {
      status = "unreachable"; // a throwing probe is the same fail-open class
    }
    if (status === "busy") {
      if (opts.deadline?.expired()) return false;
      if (waited >= DRAIN_YIELD_WAIT_CAP_MS) {
        console.warn(
          `[hicortex] drain: yield signal busy for ${Math.round(waited / 60_000)} min ` +
            `(cap ${Math.round(DRAIN_YIELD_WAIT_CAP_MS / 60_000)} min) — proceeding fail-open`,
        );
        return true;
      }
      await sleep(DRAIN_YIELD_POLL_MS);
      waited += DRAIN_YIELD_POLL_MS;
      continue;
    }
    if (status === "unreachable" && !warned.unreachable) {
      warned.unreachable = true; // ONE warn per run, not per item
      console.warn(
        `[hicortex] drain: yield signal at ${opts.yieldUrl} unreachable — proceeding (fail-open)`,
      );
    }
    return true;
  }
}

/**
 * Resolve the memories' `created_at` — TOTAL (never throws) and computed
 * BEFORE distillation starts. An unparseable `session_date` (enqueue stores
 * any non-empty string verbatim) made `new Date(...).toISOString()` throw
 * AFTER the LLM calls had already run: the catch mislabeled it endpoint_down,
 * the row stayed queued, and every scheduled run stopped at it again — a
 * poison row (#530 follow-up). Unparseable → ONE warn naming the session and
 * the bad value, then the row's delivery timestamp (`arrived_at`, always a
 * full ISO written by enqueueDistill). The sync path (mcp-server.ts) has the
 * same latent throw — pre-existing parity; this fix is drain-only by review
 * scope.
 */
function resolveDrainCreatedAt(item: DistillQueueRow): string {
  const stamp = item.session_date ?? new Date().toISOString().slice(0, 10);
  const t = new Date(stamp).getTime();
  if (Number.isFinite(t)) return new Date(stamp).toISOString();
  console.warn(
    `[hicortex] drain: unparseable session_date ${JSON.stringify(item.session_date)} on ` +
      `session ${item.session_id ?? "(no session id)"} — using the delivery timestamp instead`,
  );
  return item.arrived_at;
}

/**
 * Drain the distill inbox. See the module doc for the ordering + checkpoint
 * contracts. Pure w.r.t. its injected dependencies — no HTTP, no state.json
 * reads (the nightly records the reported usage against the monthly meter).
 */
export async function drainDistillQueue(
  db: Database.Database,
  opts: DrainOptions,
): Promise<DrainReport> {
  const report: DrainReport = {
    outcome: "empty",
    processed: 0,
    duplicates: 0,
    memories: 0,
    remaining: 0,
    usage: { prompt: 0, completion: 0, total: 0 },
  };

  const rows = db
    .prepare("SELECT * FROM distill_queue ORDER BY rowid ASC")
    .all() as unknown as DistillQueueRow[];
  if (rows.length === 0) return report; // the healthy steady state: depth 0

  // No LLM configured: delivery still queued (queue mode needs no LLM), but
  // distillation cannot run. Report + defer — items stay queued; the
  // consolidation block reports its own no_llm right after.
  if (!opts.llm || !opts.llmConfig) {
    console.warn(
      `[hicortex] Distill inbox holds ${rows.length} item(s) but no LLM is configured — ` +
        `deferring (run npx @gamaze/hicortex init)`,
    );
    report.outcome = "no_llm";
    report.remaining = rows.length;
    return report;
  }

  // Fair order: per-client queues in first-arrival order, each preserving
  // rowid order (= arrival order = per-session ascending), cycled strictly —
  // client A's head, client B's head, A's next, B's next, ...
  const byClient = new Map<string, DistillQueueRow[]>();
  for (const row of rows) {
    const key = clientKey(row);
    const list = byClient.get(key);
    if (list) list.push(row);
    else byClient.set(key, [row]);
  }
  const queues = [...byClient.values()];

  console.log(
    `[hicortex] Distill inbox: ${rows.length} item(s) from ${queues.length} client(s) — draining`,
  );

  const chunkSize = await resolveDrainChunkSize(opts);
  const warned = { unreachable: false };
  let stopped: DrainReport["outcome"] | undefined;

  outer: while (queues.some((q) => q.length > 0)) {
    for (const q of queues) {
      if (q.length === 0) continue;
      const item = q.shift()!;

      // #405: the ONE run deadline, BETWEEN items — a safe boundary by
      // construction (each item commits atomically, so a stop here leaves
      // processed items done and the rest queued, dup-over-loss on retry).
      if (opts.deadline?.hit("drain")) {
        stopped = "deferred";
        break outer;
      }
      // #5 token gate, BETWEEN items (and here, before the very first call) —
      // a refusal leaves the rest queued for the next period; consolidation
      // still runs (its own budget accounting is separate).
      if (opts.budgetExceeded?.()) {
        console.warn(
          `[hicortex] drain: token budget exceeded — ${rows.length - report.processed} item(s) stay queued`,
        );
        stopped = "budget";
        break outer;
      }
      // #529 interactive-yield: wait out a busy signal before the next item.
      if (!(await waitForYield(opts, warned))) {
        opts.deadline?.hit("drain"); // record the stage deferral (idempotent)
        stopped = "deferred";
        break outer;
      }

      // Distill-time dedup re-check (the delivery-time checks ran before
      // enqueue, but the world moved since): a now-duplicate segment skips
      // cleanly — its inbox row is deleted and nothing is re-distilled.
      if (item.session_id) {
        const dup =
          item.segment_id !== ""
            ? countExistingSegment(db, item.session_id, item.segment_id) > 0
            : countExistingSession(db, item.session_id) > 0;
        if (dup) {
          db.transaction(() => deleteQueuedRow(db, item.id))();
          report.processed++;
          report.duplicates++;
          continue;
        }
      }

      // Distill → embed → ONE transaction (inserts + row delete). Per-item
      // usage accrues even on throw (some chunks' LLM calls already happened)
      // — the caller records it against the monthly meter, same as the sync
      // path's finally.
      const usage = { prompt: 0, completion: 0, total: 0 };
      const label =
        item.segment_id !== ""
          ? item.segment_id
          : item.session_id ?? undefined;
      // BEFORE distillation — see resolveDrainCreatedAt: a throwing date
      // computation after the LLM calls is the poison row.
      const createdAt = resolveDrainCreatedAt(item);
      try {
        // Cast: DrainLlm is the structural surface distillSession uses.
        const llm = opts.llm as unknown as LlmClient;
        const entries: DistilledEntry[] = await distillSession(
          llm,
          item.text,
          item.project ?? "unknown",
          item.session_date ?? new Date().toISOString().slice(0, 10),
          chunkSize,
          [],
          (u: LlmUsage) => {
            usage.prompt += u.prompt_tokens ?? 0;
            usage.completion += u.completion_tokens ?? 0;
            usage.total += u.total_tokens ?? 0;
          },
          label,
        );

        // Phase 1 — embed every entry up front; ANY failure throws BEFORE the
        // transaction, so nothing is stored and the row stays queued.
        const sourcePrefix = item.session_id
          ? `${item.session_id}${item.segment_id !== "" ? `#${item.segment_id}` : ""}`
          : undefined;
        const toStore: Array<{ content: string; memoryType: string; embedding: Float32Array; i: number }> = [];
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i];
          if (typeof entry !== "object" || !entry.content || !entry.content.trim()) continue;
          toStore.push({
            content: entry.content,
            memoryType: entry.memoryType,
            embedding: await opts.embed(entry.content),
            i,
          });
        }

        // Phase 2 — inserts + the inbox-row delete in ONE transaction: the
        // item is "done" only when both land (per-item checkpointing; a crash
        // between items never sees a half-done item).
        const commit = db.transaction((): void => {
          for (const { content, memoryType, embedding, i } of toStore) {
            storage.insertMemory(db, content, embedding, {
              // Same normalizations the sync handler applies at insert time —
              // the row kept the wire fields verbatim.
              sourceAgent: item.source_agent ?? "unknown",
              sourceAgentId: item.source_agent_id,
              sourceDomain: item.source_domain,
              sourceMachine: storage.sanitizeSourceMachine(item.source_machine),
              sourceSession: sourcePrefix ? `${sourcePrefix}#${i}` : undefined,
              project: item.project ?? undefined,
              memoryType,
              privacy: item.privacy,
              createdAt,
            });
          }
          deleteQueuedRow(db, item.id);
        });
        commit();

        report.processed++;
        report.memories += toStore.length;
        report.usage.prompt += usage.prompt;
        report.usage.completion += usage.completion;
        report.usage.total += usage.total;
        console.log(
          `[hicortex]   Drained ${label ?? "segment"}: ${toStore.length} memories`,
        );
      } catch (err) {
        // Endpoint failure (ladder + breaker exhausted inside LlmClient) or
        // an embed/insert failure: stop the drain CLEANLY — never retry this
        // item in-run, never a tight loop. Processed items stay done; this
        // and the remaining items stay queued for the next scheduled run.
        report.usage.prompt += usage.prompt;
        report.usage.completion += usage.completion;
        report.usage.total += usage.total;
        console.error(
          `[hicortex] drain: distilling ${label ?? "segment"} failed — ` +
            `${err instanceof Error ? (err.stack ?? err.message) : String(err)}. ` +
            `Stopping the drain; remaining items stay queued.`,
        );
        stopped = "endpoint_down";
        break outer;
      }
    }
  }

  report.outcome = stopped ?? "completed";
  report.remaining = queueDepth(db);
  if (report.outcome === "completed") {
    console.log(
      `[hicortex] Distill inbox drained: ${report.processed} item(s), ` +
        `${report.memories} memories, ${report.duplicates} duplicate skip(s)`,
    );
  }
  return report;
}
