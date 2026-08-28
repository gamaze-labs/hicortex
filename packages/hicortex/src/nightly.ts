/**
 * Nightly pipeline — manual trigger or called by the persistent server.
 *
 * Steps (0.9.0+):
 *   1. Read new harness transcripts since last run
 *   2. Denoise + POST each session to /distill (server captures for itself via localhost)
 *   3. Run consolidation (scoring, reflection, linking, decay) — server mode only
 *   4. Update last-run timestamp
 *
 * Every machine (server + clients) uses the same capture path: denoise locally,
 * POST to /distill. No local LLM required for capture; distillation is server-side.
 */

import { hicortexHome } from "./paths.js";
import { readFileSync, statSync, copyFileSync, truncateSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type Database from "better-sqlite3";

let VERSION = "0.0.0";
try { VERSION = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8")).version; } catch {}

import { initDb, resolveDbPath } from "./db.js";
import { readPositiveConfig, readNonNegativeConfig, warnIgnoredConfigKeys } from "./config-read.js";
import { resolveSavedLlmConfig, LlmClient, type LlmConfig } from "./llm.js";
import { embed } from "./embedder.js";
import * as storage from "./storage.js";
import { runConsolidation, CONSOLIDATE_MAX_LLM_CALLS, resolveMemorySoftCap, stageMemoryCapEviction, shouldThrottleTokens } from "./consolidate.js";
import { parseConfigDomains } from "./domain-classify.js";
import { resolveWeakPrimaryFloor } from "./nofit.js";
import { readCcTranscripts, type TranscriptBatch } from "./transcript-reader.js";
import { readHermesSessions } from "./hermes-transcript-reader.js";
import { readPiTranscripts } from "./pi-transcript-reader.js";
import { readOcTranscripts } from "./oc-transcript-reader.js";
import { readOpencodeSessions } from "./opencode-transcript-reader.js";
import { initFeatures } from "./features.js";
import { configureDecay, configureRecall, configureScoring } from "./retrieval.js";
import { loadState, updateState, migrateLegacyState } from "./state.js";
import { migrateIdentityDir } from "./identity-store.js";
import { openCursorStore, pruneCursors } from "./capture-cursors.js";
import { captureBatches, acquireCaptureLock, type PostFn, type PostResult, type DistillBody } from "./capture.js";
import { writeSnapshot, backfillSnapshots } from "./dashboard.js";
import { isTelemetryEnabled, getTelemetryId, sendTelemetry, TELEMETRY_PAYLOAD_VERSION } from "./telemetry.js";
import { ensureAndPersistAgentId, loadConfigStrict } from "./init.js";
import { createBackup, runBackupHook, newestBackupArtifactMs, DEFAULT_BACKUP_RETENTION } from "./backup.js";

const HICORTEX_HOME = hicortexHome();

/**
 * Consolidate-only backup gate (#327 CR blocker). Hosted tenants run ONLY
 * `nightly --consolidate-only` several times a day (hicortex-consolidate@.timer)
 * and the provisioner has no backup job of its own, so those runs DO run the
 * backup stage — but at most once per day, keyed on the newest existing
 * artifact's age (the artifact IS the marker; no extra state file). 20h is
 * slightly under a day so a timer firing at a drifting clock hour still gets
 * exactly one backup per day; with `backupRetention` (default 7) the artifact
 * count stays bounded.
 */
const CONSOLIDATE_ONLY_BACKUP_MIN_AGE_MS = 20 * 60 * 60 * 1000;

function readNightlyConfig(stateDir: string): Record<string, unknown> | null {
  const configPath = join(stateDir, "config.json");
  let loaded: { config: Record<string, unknown>; hadFile: boolean };
  try {
    loaded = loadConfigStrict(configPath);
  } catch (e) {
    // Malformed existing config (bad JSON / non-object / unreadable): visible
    // WARN so the operator fixes it, then fail-soft to null. The strict load
    // also protects the agentId self-heal below — its throw is now reachable
    // here (without this routing, a swallowed parse → null → the `if
    // (savedConfig)` guard would skip the self-heal entirely).
    console.warn(
      `[hicortex] ${configPath} exists but could not be parsed — running degraded ` +
      `(agentId self-heal and config-driven knobs will not apply this run). ` +
      `Fix the JSON and re-run. Cause: ${e instanceof Error ? e.message : String(e)}`
    );
    return null;
  }
  // ENOENT → hadFile=false → null (install not set up yet; silent, matches the
  // old catch→null behavior).
  return loaded.hadFile ? loaded.config : null;
}

function readConfigLicenseKey(stateDir: string): string | undefined {
  try {
    const configPath = join(stateDir, "config.json");
    const raw = readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw);
    return config.licenseKey || undefined;
  } catch {
    return undefined;
  }
}

function readLastRun(stateDir: string = HICORTEX_HOME): Date {
  const ts = loadState(stateDir).lastNightly;
  if (!ts) return new Date(0); // First run — process everything
  const d = new Date(ts);
  return isNaN(d.getTime()) ? new Date(0) : d;
}

/**
 * Discovery watermark. Normally the last-nightly timestamp; with
 * `--recapture-window <days>` (#189 Tier-2 recovery) the window may only
 * WIDEN — since = min(lastNightly, now−N days). Taking the earlier of the two
 * means a machine that was offline longer than N days still re-discovers every
 * session it missed; using now−N unconditionally would NARROW the window and
 * skip (then, via writeLastRun, permanently lose) the 8-to-N-day-old sessions
 * (#189 review, fix 3). Per-session cursors keep the wide re-scan cheap: an
 * already-captured session yields an empty delta.
 *
 * Clock-jump clamp (#327): a FUTURE-dated lastNightly (client clock error —
 * NTP not yet synced at write time) would, once the clock corrects, sit ahead
 * of every session mtime and permanently skip quiet sessions (their mtimes
 * never re-cross a future watermark). Clamped to `now` with a warn; the warn
 * fires once per affected run (this function runs once per nightly).
 * `now` is injectable for tests.
 */
export function computeSince(
  stateDir: string,
  recaptureWindowDays?: number,
  now: Date = new Date(),
): Date {
  const lastRun = readLastRun(stateDir);
  let effective = lastRun;
  if (lastRun.getTime() > now.getTime()) {
    console.warn(
      `[hicortex] state lastNightly (${lastRun.toISOString()}) is ahead of the clock ` +
      `(${now.toISOString()}) — clamping discovery to now. A future watermark permanently ` +
      `skips quiet sessions once the clock corrects; check the machine's clock/NTP. ` +
      `Run \`hicortex nightly --recapture-window <days>\` to recover sessions missed ` +
      `while the clock was wrong.`,
    );
    effective = now;
  }
  if (recaptureWindowDays && recaptureWindowDays > 0) {
    const windowStart = new Date(now.getTime() - recaptureWindowDays * 24 * 60 * 60 * 1000);
    return windowStart < effective ? windowStart : effective;
  }
  return effective;
}

/** POST /distill transport for server mode — localhost. Sends authToken so
 *  self-capture works regardless of the localhost-bypass marker (#271 root-cause fix). */
function makeLocalPost(port: number, authToken?: string): PostFn {
  return async (body: DistillBody): Promise<PostResult> => {
    const resp = await fetch(`http://127.0.0.1:${port}/distill`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
      body: JSON.stringify(body),
      // Synchronous 35B distillation of a large segment can take minutes.
      signal: AbortSignal.timeout(20 * 60 * 1000),
    });
    return normalizePostResult(resp);
  };
}

/** POST /distill transport for client mode — remote URL + optional bearer token. */
function makeRemotePost(serverUrl: string, authToken?: string): PostFn {
  return async (body: DistillBody): Promise<PostResult> => {
    const resp = await fetch(`${serverUrl}/distill`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20 * 60 * 1000),
    });
    return normalizePostResult(resp);
  };
}

async function normalizePostResult(resp: Response): Promise<PostResult> {
  if (resp.status === 201) {
    const data = (await resp.json().catch(() => ({}))) as {
      distilled?: number;
      dropped?: string[];
      usage?: unknown;
    };
    // #287: the daemon reports the segment's metered usage. Shape-validated
    // so a partial payload can't NaN the run's totals; a pre-#287 daemon
    // simply omits it → capture sums zero (snapshot stays consolidation-only).
    const usage = parseUsage(data.usage);
    return {
      status: 201,
      distilled: data.distilled ?? 0,
      dropped: data.dropped ?? [],
      ...(usage ? { usage } : {}),
    };
  }
  if (resp.status === 200) {
    const data = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: 200, skipped: Boolean(data.skipped) };
  }
  const data = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  const retryAfterMs = parseRetryAfterMs(resp);
  return {
    status: resp.status,
    error: (data.error as string) ?? "unknown error",
    // #327: surface Retry-After so a rate-limit 429 backs off as the server
    // asked (absent on the tenant's terminal budget-429, which ignores it).
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}

/**
 * Parse a `Retry-After` header into ms (#327). Handles both RFC forms —
 * delay-seconds (`"30"`) and HTTP-date — and returns undefined for anything
 * unparseable (the caller then falls back to its own backoff schedule).
 * Exported for unit tests (pure on the header value).
 */
export function parseRetryAfterMs(resp: Response): number | undefined {
  const v = resp.headers.get("retry-after");
  if (!v) return undefined;
  const secs = Number(v);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const at = new Date(v).getTime();
  if (Number.isFinite(at)) return Math.max(0, at - Date.now());
  return undefined;
}

/** Strict {prompt, completion, total} parser for /distill's usage field (#287);
 *  undefined on anything malformed — the caller then treats it as unmetered. */
function parseUsage(u: unknown): { prompt: number; completion: number; total: number } | undefined {
  if (typeof u !== "object" || u === null) return undefined;
  const { prompt, completion, total } = u as Record<string, unknown>;
  const num = (n: unknown): number | null =>
    typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
  const p = num(prompt), c = num(completion), t = num(total);
  if (p === null || c === null || t === null) return undefined;
  return { prompt: p, completion: c, total: t };
}

function writeLastRun(stateDir: string = HICORTEX_HOME): void {
  updateState((s) => {
    s.lastNightly = new Date().toISOString();
    return s;
  }, stateDir);
}

/**
 * How long a full nightly waits for the capture lock before giving up and
 * running consolidation without capturing (fix 10). Comfortably longer than a
 * typical daytime --capture-only run; short enough not to stall the box.
 * Overridable via HICORTEX_CAPTURE_LOCK_WAIT_MS (tests only).
 */
const CAPTURE_LOCK_WAIT_MS = 30 * 60 * 1000;

function captureLockWaitMs(): number {
  const env = Number(process.env.HICORTEX_CAPTURE_LOCK_WAIT_MS);
  return Number.isFinite(env) && env >= 0 ? env : CAPTURE_LOCK_WAIT_MS;
}

// readPositiveConfig moved to ./config-read.ts (shared with the distill-tier
// overlay in llm.ts / mcp-server.ts). Validates positive-number config knobs
// at the disk→runtime boundary with a warn-on-rejected-value.

const NIGHTLY_LOG_MAX_BYTES = 1024 * 1024; // 1 MB — years of normal runs

/**
 * Keep ~/.hicortex/nightly.log bounded. The launchd plist and systemd unit
 * both append to it forever with no rotation, and the typical volatile-journal
 * target is a Raspberry Pi on a small SD card. Copy-then-truncate (not rename)
 * because the process's own stdout may hold an O_APPEND fd on this very file —
 * truncation keeps that fd valid and subsequent writes land at the new end.
 */
function rotateNightlyLog(stateDir: string = HICORTEX_HOME): void {
  const logPath = join(stateDir, "nightly.log");
  try {
    if (statSync(logPath).size <= NIGHTLY_LOG_MAX_BYTES) return;
    copyFileSync(logPath, `${logPath}.old`);
    truncateSync(logPath);
  } catch { /* no log file, or unreadable — nothing to rotate */ }
}

/**
 * Evict-only nightly (#317) — the exported seam behind `nightly --evict-only`
 * (the CLI path calls it via runNightly's evictOnly option; exporting it lets
 * tests and the hosted evict timer exercise the exact mode on a temp DB
 * without spawning a process).
 *
 * Runs ONLY stageMemoryCapEviction: opens the DB, evicts the lowest-value
 * memories above the cap, closes. No capture, no watchdog, and NEVER an LLM
 * client — the stage is pure database work, and the whole point of the mode
 * is that a hosted trial tenant's corpus stays bounded without any LLM
 * stages (the #298 trial-cost deviation). The cap resolves env-wins
 * (resolveMemorySoftCap), so the hosted HICORTEX_MEMORY_CAP env pin —
 * inherited by docker exec — is what governs here, immune to the
 * tenant-writable config.json.
 *
 * Synchronous by design (better-sqlite3 is sync; there is nothing to await)
 * and returns the stage result so callers (tests, operators scripting around
 * the timer) can log/assert the outcome. The decay/recall/scoring knobs are
 * configured from the same config a FULL nightly would read — the eviction
 * ranker (effectiveStrength) must pick victims by the same clock the recall
 * ranker uses, or an evict-only run would evict a different tail than the
 * nightly would have.
 */
export function runEvictionOnly(options: {
  dbPath?: string;
  stateDir?: string;
  dryRun?: boolean;
} = {}): { cap: number; evicted: number } {
  const stateDir = options.stateDir ?? HICORTEX_HOME;
  const savedConfig = readNightlyConfig(stateDir);
  // Same clock as the full nightly (see runNightly's identical trio) — the
  // eviction ranker reads these module knobs.
  configureDecay({ halfLifeDays: savedConfig?.decayHalfLifeDays });
  configureRecall(savedConfig);
  configureScoring(savedConfig);
  const dbPath = resolveDbPath(options.dbPath);
  console.log(`[hicortex] evict-only run${options.dryRun ? " (dry run)" : ""} — DB: ${dbPath}`);
  const db = initDb(dbPath);
  try {
    const res = stageMemoryCapEviction(
      db,
      options.dryRun ?? false,
      resolveMemorySoftCap(savedConfig?.memorySoftCap),
    );
    console.log(
      `[hicortex] evict-only ${options.dryRun ? "would evict" : "evicted"} ${res.evicted} ` +
        `memor${res.evicted === 1 ? "y" : "ies"} (cap ${res.cap})`,
    );
    return res;
  } finally {
    db.close();
  }
}

export async function runNightly(options: {
  dryRun?: boolean;
  captureOnly?: boolean;
  dbPath?: string;
  stateDir?: string;
  /** #189 Tier-2 recovery: override discovery to now−N days for one run. */
  recaptureWindowDays?: number;
  /**
   * Watchdog mode (0.17, #239): the capture timer fires `nightly --watchdog`
   * on a short interval so a transient fire-instant network miss retries in
   * minutes, not at the next daily slot. The gate throttles (success-cooldown)
   * and preflights BEFORE capture; the watchdog never consolidates (it forces
   * capture-only). Uniform across client + server/co-located.
   */
  watchdog?: boolean;
  /**
   * Consolidate-only mode (hosted service, #110): skip capture entirely, run
   * consolidation only. The hosted consolidation timer uses this so per-tenant
   * nightly runs don't ingest the operator's local sessions into the tenant's
   * DB — the tenant's agents push via /distill; the server only consolidates.
   */
  consolidateOnly?: boolean;
  /**
   * Evict-only mode (#317): run ONLY the memory-cap eviction stage — no
   * watchdog, no capture, and NEVER an LLM client (the stage is pure database
   * work, consolidate.ts stageMemoryCapEviction). This is the trial hard wall:
   * hosted trials get a low HICORTEX_MEMORY_CAP env pin and a per-tenant
   * evict timer that execs this mode, so a trial corpus stays bounded with
   * zero LLM stages (the #298 no-LLM-for-trials cost deviation). Also the
   * lifetime converge tool — idempotent, cheap, safe to run at any cadence.
   */
  evictOnly?: boolean;
} = {}): Promise<void> {
  const dryRun = options.dryRun ?? false;
  let captureOnly = options.captureOnly ?? false;
  const watchdog = options.watchdog ?? false;
  const consolidateOnly = options.consolidateOnly ?? false;
  const evictOnly = options.evictOnly ?? false;
  if (captureOnly && consolidateOnly) {
    throw new Error("runNightly: captureOnly and consolidateOnly are mutually exclusive");
  }
  if (evictOnly && captureOnly) {
    throw new Error("runNightly: evictOnly and captureOnly are mutually exclusive");
  }
  if (evictOnly && consolidateOnly) {
    throw new Error("runNightly: evictOnly and consolidateOnly are mutually exclusive");
  }
  const stateDir = options.stateDir ?? HICORTEX_HOME;
  const recaptureWindowDays = options.recaptureWindowDays;

  rotateNightlyLog(stateDir);

  // One-time migration of legacy state files (no-op if state.json exists)
  migrateLegacyState(stateDir);

  // #264: rename <home>/context/ → identity/ on the next nightly run when only
  // the legacy dir exists. The identity-store fallback read is the safety net
  // for a partial/no migration. No-op when neither dir exists (fresh install).
  const idMig = migrateIdentityDir(stateDir);
  if (idMig.renamed) {
    console.log(`[hicortex] Migrated identity dir: ${idMig.from} → ${idMig.to}`);
  } else if (idMig.reason && idMig.reason !== "no legacy context/ dir" && !idMig.reason.startsWith("identity/ already exists")) {
    console.warn(`[hicortex] Identity dir migration skipped: ${idMig.reason}`);
  }

  // Check mode: client or server
  const savedConfig = readNightlyConfig(stateDir);
  // 0.16.8 upgrade guard: warn if ignored per-stage keys are still present.
  warnIgnoredConfigKeys(savedConfig);

  // Evict-only (#317): the pure-DB maintenance mode. Branches BEFORE the
  // watchdog gate, the agentId self-heal, and every capture/LLM step — the
  // mode must stay strictly "open DB, evict to cap, close" (see
  // runEvictionOnly below). A client-mode machine has no local DB to evict
  // (the corpus lives on the remote server); skipping WITHOUT creating one is
  // the honest answer there.
  if (evictOnly) {
    if (savedConfig?.mode === "client") {
      console.log("[hicortex] evict-only: client mode has no local DB — nothing to evict");
      return;
    }
    runEvictionOnly({ dbPath: options.dbPath, stateDir, dryRun });
    return;
  }

  // 0.16.2 activation gap: pre-0.16.2 installs never re-run init, so their
  // config has no agentId → capture sent source_agent_id: null forever (the
  // provenance feature was inert for the whole existing fleet). Self-heal on
  // the first nightly after upgrade: ensureAndPersistAgentId generates + writes
  // the id once (idempotent thereafter). Mutate the in-memory savedConfig so
  // BOTH capture paths (server line below, client via runClientNightly's param)
  // read the value without re-reading the file.
  if (savedConfig) {
    const { agentId } = ensureAndPersistAgentId(join(stateDir, "config.json"));
    savedConfig.agentId = agentId;
  }
  const port = (savedConfig?.port as number | undefined) ?? 8787;

  // Watchdog gate (before the client/server branch so it is uniform). See the
  // option doc above. On skip it returns early; on proceed it forces
  // capture-only and falls through to the normal capture path (the capture
  // lock with waitMs=0 provides single-flight; writeLastRun advances the
  // cooldown marker on success).
  // consolidateOnly skips the watchdog gate (the watchdog is a capture mechanism;
  // consolidateOnly is the opposite — skip capture, run consolidation only).
  if (watchdog && !dryRun && !consolidateOnly) {
    captureOnly = true; // the watchdog captures only — never consolidates.
    // Success-cooldown: lastNightly is advanced ONLY on a clean capture
    // (writeLastRun is success-gated), so reusing it gives SUCCESS-based
    // cooldown — a FAILED preflight/capture retries on the next tick (minutes),
    // a SUCCESS waits the cooldown. This is the better semantics the custom
    // server watchdog (trigger-based) got wrong.
    // readNonNegativeConfig (not readPositiveConfig) so 0 is honoured: 0 = no
    // cooldown = capture every poll (a valid opt-in for a wired/high-frequency
    // source), not a silent fallback to the default.
    const cooldownH = readNonNegativeConfig(savedConfig ?? {}, "captureCooldownHours", 6);
    const last = loadState(stateDir).lastNightly;
    if (last) {
      // #327 clamp: a FUTURE-dated stamp (clock error at write time) reads as
      // a NEGATIVE age raw, and `negative < cooldownH` is true even at the
      // cooldown-0 opt-in ("capture every poll") — the watchdog would stay
      // silent until real time passed the future stamp, exactly when catch-up
      // ticks are most needed. Clamped, the worst honest reading is "captured
      // just now", which the normal cooldown handles (and discovery applies
      // the same clamp in computeSince).
      const lastMs = Math.min(new Date(last).getTime(), Date.now());
      const ageH = (Date.now() - lastMs) / 3_600_000;
      if (ageH < cooldownH) {
        console.log(
          `[hicortex] watchdog: last capture ${ageH.toFixed(1)}h ago (< ${cooldownH}h cooldown) — skipping`,
        );
        return;
      }
    }
    // Quick reachability preflight (5s) — a cheap gate so a 20-min poll against
    // a down link costs one short fetch, not the full in-run preflight. Client
    // → remote server; server/co-located → localhost daemon.
    const target = (
      savedConfig?.mode === "client"
        ? (savedConfig.serverUrl as string)
        : `http://127.0.0.1:${port}`
    ).replace(/\/+$/, "");
    try {
      const resp = await fetch(`${target}/health`, { signal: AbortSignal.timeout(5_000) });
      if (!resp.ok) {
        console.log(
          `[hicortex] watchdog: ${target}/health not ok (${resp.status}) — skipping (retry next tick)`,
        );
        return;
      }
    } catch (e) {
      console.log(
        `[hicortex] watchdog: ${target} unreachable (` +
        `${e instanceof Error ? e.message : String(e)}) — skipping (retry next tick)`,
      );
      return;
    }
    console.log(`[hicortex] watchdog: cooldown elapsed + ${target} reachable — capturing`);
  }

  if (savedConfig?.mode === "client") {
    // --capture-only and --consolidate-only are both accepted in client mode but
    // irrelevant: client nightly is already capture-only (no consolidation step),
    // and consolidation-only makes no sense without a local DB.
    await runClientNightly(savedConfig, dryRun, stateDir, recaptureWindowDays, watchdog);
    return;
  }

  const dbPath = resolveDbPath(options.dbPath);
  // #192: consolidation's decay/prune stage must score with the same clock as
  // the server's retrieval path (config decayHalfLifeDays, default 365).
  configureDecay({ halfLifeDays: savedConfig?.decayHalfLifeDays });
  configureRecall(savedConfig);
  configureScoring(savedConfig);
  const modeLabel = consolidateOnly ? " (consolidate-only)" : captureOnly ? " (capture-only)" : dryRun ? " (dry run)" : "";
  console.log(`[hicortex] Nightly pipeline starting${modeLabel}`);
  if (captureOnly) {
    console.log(`[hicortex] capture-only run — consolidation skipped`);
  }
  console.log(`[hicortex] DB: ${dbPath}`);

  // Init DB — consolidation reads the DB directly; capture goes via HTTP.
  const db = initDb(dbPath);

  try {
    // License: read from config file or env var, init feature cache
    const licenseKey = readConfigLicenseKey(stateDir) ?? process.env.HICORTEX_LICENSE_KEY;
    await initFeatures(licenseKey, stateDir);

    // Init LLM for consolidation (scoring + reflection). Capture (distillation)
    // is handled by the running daemon over /distill — no local distill LLM needed.
    // No LLM → capture loop still runs (sessions POST to /distill, which will 503
    // transient-fail and hold the watermark), but consolidation is skipped.
    const resolved = resolveSavedLlmConfig(savedConfig);
    if (resolved.reason === "claude_binary_missing") {
      console.warn("[hicortex] claude-cli configured but binary not found — consolidation skipped");
    }
    const llmConfig: LlmConfig | null = resolved.config;
    const llm = llmConfig ? new LlmClient(llmConfig) : null;

    // Steps 1+2: single-flight capture. The lock guards ONLY the capture phase
    // (fix 10). We acquire it BEFORE reading the cursor store so a run that
    // waited out another cannot act on a stale snapshot and clobber its cursor
    // advances (fix 6). Batch-kind counts are hoisted for the telemetry at the
    // end (they stay 0 if capture is skipped).
    let ccBatches: TranscriptBatch[] = [];
    let hermesBatches: TranscriptBatch[] = [];
    let piBatches: TranscriptBatch[] = [];
    let ocBatches: TranscriptBatch[] = [];
    let opencodeBatches: TranscriptBatch[] = [];
    let batches: TranscriptBatch[] = [];
    let memoriesIngested = 0;
    let hadTransientFailure = false;
    // #287: distill tokens metered by the daemon across this run's segment
    // POSTs (summed from the /distill responses by the capture loop).
    // Forwarded to the dashboard snapshot so new_this_run.tokens is the run's
    // TRUE total (distill + consolidation) and the distill share lands in
    // tokens_by_stage. Zero when the daemon predates the usage field — the
    // snapshot writer gates on total > 0, so old servers keep today's shape.
    let distillUsage: { prompt: number; completion: number; total: number } | undefined;

    // consolidateOnly (hosted service): skip capture entirely. The hosted
    // consolidation timer uses this so per-tenant nightly runs don't ingest the
    // operator's local sessions into the tenant's DB.
    if (consolidateOnly) {
      console.log("[hicortex] consolidate-only run — capture skipped");
    } else {
    // Full nightly waits out a transient --capture-only overlap (each segment
    // POST can block up to 20 min); capture-only fails fast. dry-run writes
    // nothing so it needs no lock.
    const lockWaitMs = captureLockWaitMs();
    const releaseLock = dryRun
      ? (() => {})
      : await acquireCaptureLock(stateDir, captureOnly ? 0 : lockWaitMs);

    if (!releaseLock) {
      if (captureOnly) {
        console.warn("[hicortex] Another capture run holds the lock — skipping this capture-only run.");
        return;
      }
      // Full nightly couldn't get the lock even after waiting: skip capture and
      // hold the watermark, but STILL run consolidation + telemetry below so an
      // overlapping capture-only run never silently starves consolidation (fix 10).
      console.warn(
        `[hicortex] Capture lock still held after waiting ${Math.round(lockWaitMs / 60000)} min — ` +
        `skipping capture this run (watermark held), consolidation still runs.`,
      );
      hadTransientFailure = true;
    } else {
      try {
        // Step 1: Read new transcripts (CC + Hermes + Pi + OpenClaw). Discovery
        // is whole-session by mtime/ended_at; per-session cursors slice each
        // discovered session down to its unseen delta (#189).
        const since = computeSince(stateDir, recaptureWindowDays);
        if (recaptureWindowDays) {
          console.log(`[hicortex] --recapture-window ${recaptureWindowDays}d: reading transcripts since ${since.toISOString()}`);
        } else {
          console.log(`[hicortex] Reading transcripts since ${since.toISOString()}`);
        }

        const cursorStore = openCursorStore(stateDir);
        const cursorMap = cursorStore.map();
        ccBatches = readCcTranscripts(since, undefined, cursorMap);
        hermesBatches = readHermesSessions(since, undefined, cursorMap);
        // Pi is a supported harness (readPiTranscripts no-ops when
        // ~/.pi/agent/sessions is absent). Retired only on specific deployments
        // by simply having no Pi session files — not removed from the pipeline.
        piBatches = readPiTranscripts(since, undefined, cursorMap);
        // OpenClaw persists sessions in the Pi v3 format at ~/.openclaw/agents/;
        // no-ops when OC isn't installed.
        ocBatches = readOcTranscripts(since, undefined, cursorMap);
        // opencode persists sessions in one SQLite store
        // (~/.local/share/opencode/opencode.db); no-ops when opencode isn't
        // installed (#347).
        opencodeBatches = readOpencodeSessions(since, undefined, cursorMap);
        batches = [...ccBatches, ...hermesBatches, ...piBatches, ...ocBatches, ...opencodeBatches];
        if (ccBatches.length > 0) console.log(`[hicortex] Found ${ccBatches.length} CC session(s)`);
        if (hermesBatches.length > 0) console.log(`[hicortex] Found ${hermesBatches.length} Hermes session(s)`);
        if (piBatches.length > 0) console.log(`[hicortex] Found ${piBatches.length} Pi session(s)`);
        if (ocBatches.length > 0) console.log(`[hicortex] Found ${ocBatches.length} OpenClaw session(s)`);
        if (opencodeBatches.length > 0) console.log(`[hicortex] Found ${opencodeBatches.length} opencode session(s)`);
        console.log(`[hicortex] Total: ${batches.length} new session(s)`);

        if (batches.length === 0 && !dryRun) {
          console.log(
            captureOnly
              ? `[hicortex] No new transcripts. Nothing to capture.`
              : `[hicortex] No new transcripts. Running consolidation only.`,
          );
        }

        // Step 2: pack each session's delta into ≤60K segments and POST to the
        // local daemon via /distill; cursors advance on confirmed success.
        // source_agent_id / source_domain are per-client provenance from
        // config.json (agentId / sourceDomain) — attribution only, no filtering.
        const result = await captureBatches(batches, {
          post: makeLocalPost(port, savedConfig?.authToken as string | undefined),
          cursorStore,
          dryRun,
          sourceAgentId: savedConfig?.agentId as string | undefined,
          sourceDomain: savedConfig?.sourceDomain as string | undefined,
        });
        memoriesIngested = result.memoriesIngested;
        distillUsage = result.distillUsage;
        // A 429/401 stop must hold the watermark too (fix 1): the loop abandoned
        // the remaining sessions, and mtime discovery would never re-find them.
        hadTransientFailure = result.hadTransientFailure || result.stopped !== undefined;
      } finally {
        releaseLock();
      }

      console.log(
        `[hicortex] Capture complete: ${memoriesIngested} new memories` +
        // #287: distill tokens the daemon metered for those segments (absent
        // when the daemon predates the usage field or nothing distilled).
        (distillUsage && distillUsage.total > 0
          ? ` · ${distillUsage.total.toLocaleString()} distill tokens`
          : "")
      );

      // Prune aged-out cursors (90d) — only on a clean run so a transient
      // failure doesn't drop a still-needed cursor.
      if (!dryRun && !hadTransientFailure) {
        const pruned = pruneCursors(stateDir);
        if (pruned > 0) console.log(`[hicortex] Pruned ${pruned} stale capture cursor(s)`);
      }
    }
    } // end capture block (consolidateOnly else)

    // Step 3: Consolidation — skipped in capture-only mode, dry-run, or no LLM.
    // Runs even if capture had transient failures (opens DB directly, independent
    // of the HTTP capture path). Full nightly only — capture-only runs are
    // intended to run more frequently than once daily.
    let lessonsGenerated: number | undefined; // hoisted for telemetry; undefined when reflection didn't run (skipped) — bucketed apart from a real 0
    // #245: memories evicted by the capacity stage (hoisted for the dashboard
    // snapshot). 0 is a real value (under cap), so this stays undefined only
    // when consolidation didn't run at all (capture-only / no_llm / skipped).
    let evictedCount: number | undefined;
    // Resolved cap (#245) for the dashboard snapshot. Hoisted so the snapshot
    // writer (outside the consolidation block) can stamp `capacity` even when
    // consolidation was skipped (the cap is still "in force" config-wise).
    // #317: resolved through the shared env-wins resolver — a
    // HICORTEX_MEMORY_CAP pin governs the eviction input AND the snapshot
    // stamp from this one value (the dashboard live headline resolves through
    // the same function, so enforced + displayed can never disagree).
    const memorySoftCapResolved = resolveMemorySoftCap(savedConfig?.memorySoftCap);
    // Consolidation outcome for telemetry (0.17). undefined on capture-only runs
    // (which send no nightly ping). "skipped" = runConsolidation's built-in
    // nothing-to-do short-circuit (zero LLM calls), NOT a failure.
    // "throttled" (#246) = the llmTokensPerMonth fair-use cap was projected to
    // be exceeded, so consolidation was skipped before any LLM call.
    // "endpoint_down" (#337) = the pre-consolidation readiness probe failed, or
    // the LLM circuit breaker was open after the run — transient (retried next
    // run), and NEVER "completed": the stages fail soft, so without this
    // override a dead-endpoint run would report clean.
    let consolidationStatus: "completed" | "skipped" | "failed" | "no_llm" | "throttled" | "endpoint_down" | undefined;
    // #246: total consolidation tokens consumed this run (hoisted for telemetry
    // + the dashboard snapshot). Undefined when consolidation didn't run at all
    // (capture-only / no_llm / throttled) so the optional field is omitted.
    let tokensThisRun: number | undefined;
    // #246: per-stage token breakdown (hoisted for the dashboard snapshot).
    let tokensByStage: Record<string, { prompt: number; completion: number; total: number }> | undefined;
    // #255: budget-exhaustion flag + per-stage deferred counts (hoisted for
    // telemetry + the dashboard snapshot). Undefined when consolidation didn't
    // run at all (capture-only / no_llm / throttled) — the optional fields are
    // omitted so the aggregate treats absent as "not measurable".
    let budgetExhausted: boolean | undefined;
    let budgetDeferredByStage: Record<string, number> | undefined;
    // #255 CR: always-on usage metric — hoisted for the dashboard snapshot so
    // the digest renders a continuous used/max bar (consolidation
    // completeness as a health metric), not just an amber pill at exhaustion.
    // Undefined when consolidation didn't run; presence = a run happened.
    let budgetCallsUsed: number | undefined;
    let budgetMaxCalls: number | undefined;
    if (!dryRun && !captureOnly) {
      if (!llm || !llmConfig) {
        console.error(
          "[hicortex] consolidation skipped: no LLM configured — run npx @gamaze/hicortex init"
        );
        consolidationStatus = "no_llm";
      } else {
        // #246: fair-use cap. Default 0 = unlimited (self-hosted default —
        // never throttles). When > 0, project this run's cost against the
        // period running total. The estimate = the PREVIOUS run's actual usage
        // (state.llmTokensLastRun, 0/absent on the first metered run = never
        // throttle the first run, since there's no baseline yet). Conservative:
        // over-throttle vs over-spend, since a throttled night just defers work
        // to the next period (the corpus is not lost — consolidation has
        // resumable cursors and runs 2-4×/day on the 0.17 timer).
        const tokenCap = readNonNegativeConfig(savedConfig ?? {}, "llmTokensPerMonth", 0);
        if (tokenCap > 0) {
          // Pure decision lives in consolidate.ts (shouldThrottleTokens) so it
          // can be unit-tested without spinning up the nightly. Monthly reset
          // + last-run estimate are handled inside the helper.
          const periodState = loadState(stateDir).llmTokensThisPeriod;
          const lastRunTokens = loadState(stateDir).llmTokensLastRun ?? 0;
          const decision = shouldThrottleTokens(tokenCap, periodState, lastRunTokens);
          if (decision.throttle) {
            console.warn(
              `[hicortex] Consolidation throttled: token fair-use cap reached ` +
              `(${decision.used!.toLocaleString()} used + ~${lastRunTokens.toLocaleString()} estimated / ${tokenCap.toLocaleString()} this period).`,
            );
            consolidationStatus = "throttled";
            // Month-boundary reset even when throttled (#246 CR): without this,
            // llmTokensLastRun stays stale from the prior month → soft-locks
            // every subsequent run forever. Reset the period + the last-run
            // estimate so the next month starts clean.
            if (!dryRun) {
              updateState((s) => {
                const now = new Date();
                const cur = s.llmTokensThisPeriod;
                const startD = cur?.periodStart ? new Date(cur.periodStart) : now;
                if (startD.getUTCFullYear() !== now.getUTCFullYear() ||
                    startD.getUTCMonth() !== now.getUTCMonth()) {
                  s.llmTokensThisPeriod = { prompt: 0, completion: 0, total: 0, periodStart: now.toISOString() };
                  s.llmTokensLastRun = 0;
                  console.log("[hicortex] Token fair-use period reset (new month) — throttle cleared.");
                }
              }, stateDir);
            }
          }
        }

        if (consolidationStatus !== "throttled") {
          // #337: readiness probe — ONE minimal generation request before any
          // consolidation phase. This REPLACES the #231 no-preflight decision
          // (its premise "a failed phase costs latency, not data" was falsified
          // by the 2026-08-23/24 incident: the gateway answered /v1/models —
          // liveness — while generation was dead, and the nightly retried into
          // it for ~5 h, making the wedge monotonically worse). A failed probe
          // skips consolidation entirely with the diagnosis "LLM endpoint not
          // generating" (not-generating, not slow) and status endpoint_down —
          // a transient outcome: consolidation has resumable cursors, the
          // nightly re-runs 2-4×/day, and capture is unaffected (the daemon's
          // /distill path has its own probe). Zero LLM phases run when the
          // probe fails — one fast failure is the whole cost.
          const probeOk = await llm.probe();
          if (!probeOk) {
            console.error(
              "[hicortex] LLM endpoint not generating — consolidation skipped " +
              "(endpoint_down, will retry next run). See the ops runbook's " +
              "known failure signatures; llmProbeTimeoutMs tunes the probe's patience."
            );
            consolidationStatus = "endpoint_down";
          } else {
            const cfgDomains = parseConfigDomains(savedConfig);

            console.log(`[hicortex] Running consolidation...`);
            const report = await runConsolidation(db, llm, embed, dryRun, false, undefined, {
              domains: cfgDomains,
              contentDomainsReady: true,
              weakPrimaryFloor: resolveWeakPrimaryFloor(savedConfig),
            }, {
              minSimilarity: savedConfig?.supersessionMinSimilarity as number | undefined,
              maxCalls: savedConfig?.supersessionMaxCalls as number | undefined,
            },
              // #241: config-driven total LLM-call ceiling (default 5000, was 200).
              readPositiveConfig(savedConfig ?? {}, "consolidateMaxLlmCalls", CONSOLIDATE_MAX_LLM_CALLS),
              // #245: soft cap on the corpus (default 10000; 0 disables eviction).
              memorySoftCapResolved,
            );
            console.log(
              `[hicortex] Consolidation ${report.status} in ${report.elapsed_seconds}s` +
              (report.stages.reflection ? ` (${report.stages.reflection.lessons_generated} lessons)` : "")
            );
            consolidationStatus = report.status;
            // #337: the stages fail soft, so a run against an endpoint that died
            // MID-run would otherwise report "completed". An open breaker is the
            // honest signal — override to endpoint_down (lastConsolidated still
            // only advances on a clean "completed", so the work is re-run).
            if (llm.breakerOpen) {
              console.error(
                `[hicortex] LLM circuit breaker OPEN after consolidation — ` +
                `overriding "${report.status}" to endpoint_down (stages failed ` +
                `soft against a down endpoint; will retry next run).`
              );
              consolidationStatus = "endpoint_down";
            }
            // #245: capture the eviction count for the dashboard snapshot. The
            // stage always returns `evicted` (0 when under cap / disabled); report
            // it as 0 (a real value), not undefined, when the stage ran.
            evictedCount = report.stages.memory_cap?.evicted ?? 0;
            // Only set when reflection actually RAN (not skipped). A skipped stage
            // (e.g. endpoint offline, #232 fail-soft) must NOT collapse to 0 — that
            // would make "endpoint down" indistinguishable from "prompt too tight"
            // in the fleet aggregate. Leave undefined so the optional field is
            // omitted and the aggregate buckets skipped runs separately.
            const refl = report.stages.reflection;
            if (refl && !refl.skipped) lessonsGenerated = refl.lessons_generated;
            // #246: surface token totals for telemetry + dashboard snapshot. Both
            // fields stay undefined on a skipped/failed run (no metered calls →
            // nothing to report; the optional fields are omitted from the ping).
            const tokensTotal = report.budget?.tokens_total;
            if (tokensTotal && tokensTotal.total > 0) {
              tokensThisRun = tokensTotal.total;
              tokensByStage = report.budget?.tokens_by_stage;
            }
            // #255: budget exhaustion — always populated when consolidation ran
            // (report.budget.exhausted is a boolean). The dashboard + telemetry
            // treat true as a quality-degradation health signal. The
            // ran-vs-didn't-run distinction is carried by `budgetCallsUsed`/
            // `budgetMaxCalls` (forwarded whenever consolidation ran), NOT by a
            // false `budget_exhausted` flag — the snapshot forwards
            // `budget_exhausted` only on exhaustion (alert state), so the
            // aggregate reads: calls_used present + budget_exhausted undefined
            // = "ran and didn't exhaust"; calls_used undefined = "didn't run".
            budgetExhausted = report.budget?.exhausted;
            budgetDeferredByStage = report.budget?.deferred_by_stage;
            budgetCallsUsed = report.budget?.calls_used;
            budgetMaxCalls = report.budget?.max_calls;
            // #246: accrue to state.json (monthly reset + last-run estimate for
            // the next throttle check). Written even on a failed run — a partial
            // run that made metered calls before the failure still spent tokens,
            // and the next run's estimate should reflect that.
            if (!dryRun) {
              updateState((s) => {
                const now = new Date();
                const cur = s.llmTokensThisPeriod;
                let periodStart = cur?.periodStart ?? now.toISOString();
                let prompt = cur?.prompt ?? 0;
                let completion = cur?.completion ?? 0;
                let total = cur?.total ?? 0;
                // Monthly reset: if periodStart is in a previous calendar month,
                // zero the accrual before adding this run's contribution.
                const startD = new Date(periodStart);
                if (startD.getUTCFullYear() !== now.getUTCFullYear() ||
                    startD.getUTCMonth() !== now.getUTCMonth()) {
                  periodStart = now.toISOString();
                  prompt = 0;
                  completion = 0;
                  total = 0;
                }
                if (tokensTotal) {
                  prompt += tokensTotal.prompt;
                  completion += tokensTotal.completion;
                  total += tokensTotal.total;
                }
                s.llmTokensThisPeriod = {
                  prompt, completion, total, periodStart,
                };
                s.llmTokensLastRun = tokensTotal?.total ?? 0;
              }, stateDir);
            }
          }
        }
      }
    }

    // Step 4: Update last-run timestamp.
    // CRITICAL: only advance lastRun if every session was processed without
    // a transient failure. Otherwise failed sessions would be permanently
    // lost — they'd be older than the new lastRun and never retried.
    if (!dryRun) {
      if (hadTransientFailure) {
        console.warn(
          `[hicortex] Not advancing lastRun — one or more sessions failed. ` +
          `They will be retried on the next run.`
        );
      } else {
        writeLastRun(stateDir);
      }
    }

    console.log(`[hicortex] Nightly pipeline complete.`);

    // Backup stage (#6, Phase 0B) — a transactionally-consistent snapshot of
    // the irreplaceable data (DB + identity + state), packaged as one tar.gz
    // the operator ships offsite via the optional `backupCommand` hook. Runs
    // on every full nightly and on consolidate-only runs (capture-only is
    // frequent + stateless; dry-run writes nothing). Consolidate-only MUST
    // back up (#327 CR blocker): hosted tenants run ONLY --consolidate-only
    // several times a day (hicortex-consolidate@.timer) and the provisioner
    // has no backup job of its own — skipping the stage left them with NO
    // recurring backup. Their cadence is bounded by the artifact-age gate
    // below (~1/day) instead, so `backupRetention` keeps the dir bounded.
    // Backup failure must NOT fail the nightly — capture + consolidation
    // have already succeeded; the snapshot is on disk and the failure
    // surfaces as `backupOk:false` in the dashboard snapshot + telemetry for
    // alerting (the operator's hook owns active alerting; no in-product
    // channel yet — Phase 3).
    let backupPath: string | undefined;
    let backupBytes: number | undefined;
    let backupOk: boolean | undefined;
    // Artifact-age gate for consolidate-only runs: skip only while the newest
    // existing artifact is younger than ~20h. 20h (not 24) so a timer firing
    // at a drifting clock hour still gets exactly one backup per day, and
    // robust to an hour of clock skew either way. Keyed on the artifact, not
    // a state timestamp — no new state file to drift out of sync with the
    // disk it describes.
    const effectiveBackupDir =
      typeof savedConfig?.backupDir === "string" && savedConfig.backupDir.trim()
        ? savedConfig.backupDir
        : join(stateDir, "backups");
    let skipBackup = false;
    let newestArtifactMs: number | undefined;
    if (consolidateOnly) {
      newestArtifactMs = newestBackupArtifactMs(effectiveBackupDir);
      skipBackup =
        newestArtifactMs !== undefined &&
        Date.now() - newestArtifactMs < CONSOLIDATE_ONLY_BACKUP_MIN_AGE_MS;
    }
    if (!dryRun && !captureOnly && !skipBackup) {
      try {
        const bRes = await createBackup({
          db,
          home: stateDir,
          // undefined falls back to <home>/backups inside createBackup — the
          // same resolution effectiveBackupDir above uses for the age gate.
          outDir:
            typeof savedConfig?.backupDir === "string" && savedConfig.backupDir.trim()
              ? savedConfig.backupDir
              : undefined,
          // Same reader + default as the CLI (#327): keep the N newest
          // artifacts, 0 = keep all.
          retention: readNonNegativeConfig(
            savedConfig ?? {},
            "backupRetention",
            DEFAULT_BACKUP_RETENTION,
          ),
        });
        backupPath = bRes.path;
        backupBytes = bRes.bytes;
        backupOk = true;
        console.log(
          `[hicortex] Backup: ${bRes.files} files, ${bRes.bytes.toLocaleString()} bytes -> ${bRes.path}`,
        );
        const cmd =
          typeof savedConfig?.backupCommand === "string" && savedConfig.backupCommand.trim()
            ? savedConfig.backupCommand
            : undefined;
        if (cmd && backupPath) {
          const hook = await runBackupHook(backupPath, cmd);
          if (!hook.ok) {
            // The artifact is on disk; only the offsite copy failed. Keep
            // backupPath/backupBytes (the snapshot records what was produced)
            // but flip backupOk so the aggregate can alert.
            backupOk = false;
            console.error(
              `[hicortex] Backup hook failed (exit ${hook.exitCode ?? "n/a"}). ` +
              `Artifact is on disk; offsite copy did NOT complete.`,
            );
          } else {
            console.log(`[hicortex] Backup hook ok (exit 0).`);
          }
        }
      } catch (err) {
        // The whole backup stage failed (snapshot, tar, or write). Do NOT
        // propagate — capture/consolidation already succeeded. Surface + continue.
        backupOk = false;
        console.error(
          `[hicortex] Backup FAILED: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else if (consolidateOnly && !dryRun) {
      // #327: explicit log line so a hosted consolidation timer's log doesn't
      // read as a silently-missing backup stage — and names WHY (age gate), so
      // an operator reading "skipped" can tell a healthy cadence gate from a
      // dead one.
      const ageH = newestArtifactMs !== undefined ? (Date.now() - newestArtifactMs) / 3_600_000 : -1;
      console.log(
        `[hicortex] Backup stage skipped — consolidate-only run: newest backup is ` +
        `${ageH.toFixed(1)}h old (< ${Math.round(CONSOLIDATE_ONLY_BACKUP_MIN_AGE_MS / 3_600_000)}h gate).`,
      );
    }

    // Dashboard snapshot (#224) — full nightly only. The snapshot reflects
    // corpus state regardless of whether consolidation/LLM ran, so it is
    // ALWAYS written here (the use case is history; an LLM-less install still
    // accrues memories). Capture-only runs SKIP it (above, the block guards
    // on !captureOnly). On the first run after deploy the table is empty →
    // backfill synthesizes one row per day from created_at so the growth/
    // composition charts have real history on day one.
    if (!dryRun && !captureOnly) {
      try {
        const backfilled = backfillSnapshots(db);
        if (backfilled > 0) {
          console.log(`[hicortex] Dashboard backfill: ${backfilled} day(s) synthesized from created_at`);
        }
        // Per-run deltas. `added` = this run's captured memory count (only
        // available on the server path; client mode never reaches here — it
        // POSTs to a remote /distill). dedup/supersession are derived from
        // the dedup_log / superseded_by link tables: count rows created since
        // the last snapshot (real OR backfilled — both carry valid ISO run_at,
        // so a plain ORDER BY run_at DESC LIMIT 1 is the correct floor) so a
        // manual `hicortex dedup` run between nightlies is still reflected,
        // and a first-write after backfill counts only what landed AFTER the
        // last backfilled day.
        const lastSnap = db
          .prepare("SELECT run_at FROM dashboard_snapshots ORDER BY run_at DESC LIMIT 1")
          .get() as { run_at: string } | undefined;
        const sinceTs = lastSnap?.run_at ?? "1970-01-01T00:00:00.000Z";
        const dedup = (
          db
            .prepare("SELECT COUNT(*) AS c FROM dedup_log WHERE merged_at > ?")
            .get(sinceTs) as { c: number }
        ).c;
        const supersession = (
          db
            .prepare(
              `SELECT COUNT(*) AS c FROM memory_links
                WHERE relationship = 'superseded_by' AND created_at > ?`
            )
            .get(sinceTs) as { c: number }
        ).c;
        writeSnapshot(db, new Date().toISOString(), {
          added: memoriesIngested,
          lessonsGenerated,
          dedup,
          supersession,
          evicted: evictedCount,
          // #246: token accounting from this run's consolidation (undefined
          // when consolidation didn't run or made no metered calls).
          tokensThisRun,
          tokensByStage,
          // #287: the capture phase's distill tokens (from the /distill
          // responses). The writer merges them into `tokens` +
          // `tokens_by_stage.distill` so the customer-facing total is the
          // run's TRUE spend; zero (old daemon / nothing distilled) is a no-op
          // and the row keeps its consolidation-only shape.
          distillUsage,
          // #255 CR: always-on budget usage — undefined when consolidation
          // didn't run (capture-only / no_llm / throttled). Forwarded whenever
          // consolidation ran so the digest renders a continuous used/max bar.
          budgetCallsUsed,
          budgetMaxCalls,
          // #255: budget exhaustion — undefined when consolidation didn't run
          // (capture-only / no_llm / throttled) or didn't exhaust.
          budgetExhausted,
          budgetDeferredByStage,
          // #6 backup stage — hoisted from the block above. Present whenever
          // the backup stage ran (full nightly, and consolidate-only runs past
          // the artifact-age gate); undefined on capture-only / dry-run / a
          // gated-skip consolidate-only run. backupOk flips to false on
          // snapshot OR hook failure so the dashboard digest can flag a night
          // the offsite copy didn't complete.
          backupPath,
          backupBytes,
          backupOk,
        }, memorySoftCapResolved);
      } catch (snapErr) {
        // The snapshot is a monitoring side-effect — a failure here must NOT
        // advance to a telemetry gap or move the watermark. Surface + continue.
        console.warn(
          `[hicortex] Dashboard snapshot write failed: ` +
          `${snapErr instanceof Error ? snapErr.message : String(snapErr)}`
        );
      }
    }

    // Anonymous telemetry (fire-and-forget, full nightly only).
    // Capture-only runs are excluded to avoid inflating install pings.
    if (!dryRun && !captureOnly && isTelemetryEnabled(savedConfig)) {
      const kinds = [
        ccBatches.length > 0 && "cc",
        hermesBatches.length > 0 && "hermes",
        piBatches.length > 0 && "pi",
        ocBatches.length > 0 && "oc",
        opencodeBatches.length > 0 && "opencode",
      ].filter(Boolean) as string[];
      const agentType = kinds.length > 1 ? "mixed" : (kinds[0] ?? "cc");
      // Adoption aggregates (0.15.1): corpus-wide exposure vs use. uses/shown
      // is the recall-quality signal; cold is the never-touched share.
      const adoption = db
        .prepare(
          `SELECT COALESCE(SUM(shown_count), 0) AS shown,
                  COALESCE(SUM(access_count), 0) AS uses,
                  SUM(CASE WHEN COALESCE(shown_count, 0) = 0
                            AND COALESCE(access_count, 0) = 0 THEN 1 ELSE 0 END) AS cold
             FROM memories`
        )
        .get() as { shown: number; uses: number; cold: number };
      await sendTelemetry({
        id: getTelemetryId(stateDir),
        v: VERSION,
        pv: TELEMETRY_PAYLOAD_VERSION,
        event: "nightly",
        mode: "server",
        agent: agentType,
        mem: storage.countMemories(db),
        lessons: storage.getLessons(db, 365).length,
        lessonsGenerated,
        consolidation: consolidationStatus,
        // #246: total tokens consumed by this run's consolidation (absent on
        // capture-only / throttled / no_llm / skipped — no metered calls).
        tokens_this_run: tokensThisRun,
        // #255: budget exhaustion — forwarded only when consolidation ran AND
        // exhausted (false is omitted to keep the ping minimal; the aggregate
        // treats absent as "not exhausted / not measurable").
        ...(budgetExhausted ? { budget_exhausted: true } : {}),
        // #6 backup stage outcome — forwarded only when the backup stage ran
        // (full nightly). `ok` is false on snapshot OR hook failure; the fleet
        // aggregate surfaces a sustained drop in backup_ok as a data-loss risk.
        // Absent on capture-only / consolidate-only / dry-run / client runs
        // (no backup ran).
        ...(backupOk !== undefined
          ? { backup: { ok: backupOk === true, bytes: backupBytes ?? 0 } }
          : {}),
        sessions: batches.length,
        ok: !hadTransientFailure,
        shown: adoption.shown,
        uses: adoption.uses,
        cold: adoption.cold,
      });
    }
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Client Mode Nightly — denoise locally, POST to remote server's /distill
// ---------------------------------------------------------------------------

async function runClientNightly(
  config: Record<string, unknown>,
  dryRun: boolean,
  stateDir: string = HICORTEX_HOME,
  recaptureWindowDays?: number,
  watchdog = false,
): Promise<void> {
  const serverUrl = (config.serverUrl as string).replace(/\/+$/, "");
  const authToken = config.authToken as string | undefined;

  console.log(`[hicortex] Client nightly starting${dryRun ? " (dry run)" : ""}`);
  console.log(`[hicortex] Server: ${serverUrl}`);

  // Verify server is reachable. Retry so a client waking from sleep (its
  // network link not yet re-established) or a transient blip doesn't abort
  // the whole run — the pre-flight only needs the link back, which can take
  // ~1 min after wake.
  //
  // Config-overridable (#163): a wired/well-connected client vs one whose link
  // is slow to re-establish after wake want different values. Defaults: 20s
  // per-attempt timeout, 3 attempts, 60s gap. The 20s per-attempt (bumped from
  // 15s in 0.17) absorbs a slow link coming back after the client wakes — a
  // remote server reached over a mesh/VPN link can take several seconds to
  // answer on the first request. For a genuinely DOWN link (`fetch failed`) no
  // timeout length helps — the capture watchdog's frequent retry handles that (#239).
  //
  // WALL-CLOCK NOTE: setTimeout and AbortSignal.timeout do NOT advance while
  // macOS is asleep, so the ~3m worst case (3×20s + 2×60s) is wall-clock-
  // optimistic — a sleeping laptop can straddle sleep cycles and the real
  // elapsed time can exceed it. Not a defect: the capture lock isn't held
  // during the retry and the cursor design is dup-over-loss, so a late success
  // is harmless. Just don't treat 3m as a hard wall-clock bound.
  const PREFLIGHT_TIMEOUT_MS = readPositiveConfig(config, "preflightTimeoutMs", 20_000);
  const PREFLIGHT_ATTEMPTS = Math.max(1, Math.floor(readPositiveConfig(config, "preflightAttempts", 3)));
  const PREFLIGHT_RETRY_GAP_MS = readPositiveConfig(config, "preflightRetryGapMs", 60_000);
  let reachable = false;
  for (let attempt = 1; attempt <= PREFLIGHT_ATTEMPTS; attempt++) {
    try {
      // PUBLIC /health probe — liveness only, no auth required. Client-mode
      // preflight runs against a REMOTE server over Tailscale, and the client
      // has NO bearer token to hand on this path (the auth token is the
      // server's, not the client's; /distill uses the configured authToken
      // but the liveness check must work even before that resolves). The
      // public /health returns only {status:"ok"} (#253), so we log
      // reachability without a version/memory count.
      const resp = await fetch(`${serverUrl}/health`, { signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      console.log(`[hicortex] Server reachable at ${serverUrl}`);
      reachable = true;
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < PREFLIGHT_ATTEMPTS) {
        console.error(`[hicortex] Server unreachable at ${serverUrl} (attempt ${attempt}/${PREFLIGHT_ATTEMPTS}): ${msg} — retrying in ${PREFLIGHT_RETRY_GAP_MS / 1000}s`);
        await new Promise((r) => setTimeout(r, PREFLIGHT_RETRY_GAP_MS));
      } else {
        console.error(`[hicortex] Server unreachable at ${serverUrl} after ${PREFLIGHT_ATTEMPTS} attempts: ${msg}`);
      }
    }
  }
  if (!reachable) {
    // The abort was invisible for weeks once: a plain `return` let the oneshot
    // exit 0, so systemd/launchd recorded success and the capture gap went
    // unnoticed. Exit non-zero so `systemctl --user status` / launchd show the
    // unit failed (safe — this is a timer-driven oneshot with no Restart=, so
    // no loop), and fire the telemetry ping (ok=false) so the abort is
    // distinguishable from "powered off / uninstalled" in the activity aggregate.
    process.exitCode = 1;
    // In watchdog mode, suppress this failed-preflight ping: the watchdog
    // retries every ~20 min, so a flaky link would otherwise emit up to ~72
    // ok:false pings/day and distort the fleet health ratio (#239 CR). A
    // sustained outage is still visible — as the ABSENCE of success pings, and
    // a non-watchdog (manual) run still emits ok:false.
    if (!dryRun && !watchdog && isTelemetryEnabled(config)) {
      await sendTelemetry({
        id: getTelemetryId(stateDir),
        v: VERSION,
        pv: TELEMETRY_PAYLOAD_VERSION,
        event: "nightly",
        mode: "client",
        // `agent` deliberately OMITTED: no transcripts have been read at
        // pre-flight, so the type is genuinely unknown. The admin summary
        // buckets a missing agent as "?" (distinct from cc/pi/oc/mixed) —
        // sending "cc" here would miscount an aborting Hermes/OC-only client
        // as a cc install. The success-path ping sends the real type once
        // session sources are known.
        mem: 0,
        lessons: 0,
        sessions: 0,
        ok: false,
      });
    }
    console.error(`[hicortex] Aborting. Will retry next run.`);
    return; // Don't update last-run so we retry
  }

  // No local LLM needed — distillation happens on the server.

  // Single-flight (A5): acquire the capture lock BEFORE reading the cursor
  // store so a run that waited out another can't act on a stale snapshot and
  // clobber its advances (fix 6). The client is capture-only; on contention we
  // skip and hold the watermark (no writeLastRun → retried next run). dry-run
  // writes nothing so it needs no lock.
  const releaseLock = dryRun ? (() => {}) : await acquireCaptureLock(stateDir);
  if (!releaseLock) {
    console.warn("[hicortex] Another capture run holds the lock — skipping this run (watermark held).");
    return;
  }

  let ccBatches: TranscriptBatch[] = [];
  let hermesBatches: TranscriptBatch[] = [];
  let piBatches: TranscriptBatch[] = [];
  let ocBatches: TranscriptBatch[] = [];
  let opencodeBatches: TranscriptBatch[] = [];
  let batches: TranscriptBatch[] = [];
  let memoriesIngested = 0;
  let sessionsSent = 0;
  let hadTransientFailure = false;

  try {
    // Read new transcripts (CC + Hermes + Pi + OpenClaw). Client reads local
    // logs, denoises, and POSTs the denoised text to the server's /distill
    // endpoint. All readers no-op when their harness isn't installed. Per-session
    // cursors slice each discovered session to its unseen delta (#189).
    const since = computeSince(stateDir, recaptureWindowDays);
    if (recaptureWindowDays) {
      console.log(`[hicortex] --recapture-window ${recaptureWindowDays}d: reading transcripts since ${since.toISOString()}`);
    } else {
      console.log(`[hicortex] Reading transcripts since ${since.toISOString()}`);
    }

    const cursorStore = openCursorStore(stateDir);
    const cursorMap = cursorStore.map();
    ccBatches = readCcTranscripts(since, undefined, cursorMap);
    hermesBatches = readHermesSessions(since, undefined, cursorMap);
    piBatches = readPiTranscripts(since, undefined, cursorMap);
    ocBatches = readOcTranscripts(since, undefined, cursorMap);
    opencodeBatches = readOpencodeSessions(since, undefined, cursorMap);
    batches = [...ccBatches, ...hermesBatches, ...piBatches, ...ocBatches, ...opencodeBatches];
    if (ccBatches.length > 0) console.log(`[hicortex] Found ${ccBatches.length} CC session(s)`);
    if (hermesBatches.length > 0) console.log(`[hicortex] Found ${hermesBatches.length} Hermes session(s)`);
    if (piBatches.length > 0) console.log(`[hicortex] Found ${piBatches.length} Pi session(s)`);
    if (ocBatches.length > 0) console.log(`[hicortex] Found ${ocBatches.length} OpenClaw session(s)`);
    if (opencodeBatches.length > 0) console.log(`[hicortex] Found ${opencodeBatches.length} opencode session(s)`);
    console.log(`[hicortex] Total: ${batches.length} new session(s)`);

    if (batches.length === 0) {
      console.log(`[hicortex] Nothing to capture.`);
    } else {
      const result = await captureBatches(batches, {
        post: makeRemotePost(serverUrl, authToken),
        cursorStore,
        dryRun,
        // Per-client provenance from config.json (agentId / sourceDomain). The
        // server stores these alongside source_agent; nothing filters on them.
        sourceAgentId: config.agentId as string | undefined,
        sourceDomain: config.sourceDomain as string | undefined,
      });
      memoriesIngested = result.memoriesIngested;
      sessionsSent = result.sessionsSent;
      // A 401 (bad credentials) or 429 (server cap) stop must hold the watermark
      // too (fix 1): the loop abandoned the remaining sessions.
      hadTransientFailure = result.hadTransientFailure || result.stopped !== undefined;
    }
  } finally {
    releaseLock();
  }

  // Advance lastRun only on a fully clean run (no transient failure and no
  // terminal stop). An empty scan is clean → advance. Cursors already recorded
  // whatever succeeded regardless.
  if (!dryRun) {
    if (hadTransientFailure) {
      console.warn(
        `[hicortex] Not advancing lastRun — capture failed or was stopped. ` +
        `Will retry on the next run.`
      );
    } else {
      writeLastRun(stateDir);
      const pruned = pruneCursors(stateDir);
      if (pruned > 0) console.log(`[hicortex] Pruned ${pruned} stale capture cursor(s)`);
    }
  }
  console.log(`[hicortex] Client nightly complete: ${memoriesIngested} memories from ${sessionsSent} sessions → ${serverUrl}`);

  // Anonymous telemetry (fire-and-forget, opt-out via config)
  if (!dryRun && isTelemetryEnabled(config)) {
    const kinds = [
      ccBatches.length > 0 && "cc",
      hermesBatches.length > 0 && "hermes",
      piBatches.length > 0 && "pi",
      ocBatches.length > 0 && "oc",
      opencodeBatches.length > 0 && "opencode",
    ].filter(Boolean) as string[];
    const agentType = kinds.length > 1 ? "mixed" : (kinds[0] ?? "cc");
    await sendTelemetry({
      id: getTelemetryId(stateDir),
      v: VERSION,
      pv: TELEMETRY_PAYLOAD_VERSION,
      event: "nightly",
      mode: "client",
      agent: agentType,
      mem: memoriesIngested,
      lessons: 0, // client doesn't have direct DB access
      sessions: batches.length,
      ok: !hadTransientFailure,
      // No adoption fields: a client install has no local DB to aggregate.
    });
  }
}
