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

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type Database from "better-sqlite3";

let VERSION = "0.0.0";
try { VERSION = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8")).version; } catch {}

import { initDb, resolveDbPath } from "./db.js";
import { resolveSavedLlmConfig, resolveClassifyProbeTarget, LlmClient, probeOllamaModel, type LlmConfig } from "./llm.js";
import { embed } from "./embedder.js";
import * as storage from "./storage.js";
import { extractConversationText } from "./distiller.js";
import { runConsolidation } from "./consolidate.js";
import { parseConfigDomains } from "./domain-classify.js";
import { resolveWeakPrimaryFloor } from "./nofit.js";
import { readCcTranscripts } from "./transcript-reader.js";
import { readHermesSessions } from "./hermes-transcript-reader.js";
import { readPiTranscripts } from "./pi-transcript-reader.js";
import { readOcTranscripts } from "./oc-transcript-reader.js";
import { initFeatures } from "./features.js";
import { loadState, updateState, migrateLegacyState } from "./state.js";
import { isTelemetryEnabled, getTelemetryId, sendTelemetry } from "./telemetry.js";

const HICORTEX_HOME = join(homedir(), ".hicortex");

function readNightlyConfig(stateDir: string): Record<string, unknown> | null {
  try {
    const configPath = join(stateDir, "config.json");
    return JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    return null;
  }
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

function writeLastRun(stateDir: string = HICORTEX_HOME): void {
  updateState((s) => {
    s.lastNightly = new Date().toISOString();
    return s;
  }, stateDir);
}

export async function runNightly(options: {
  dryRun?: boolean;
  captureOnly?: boolean;
  dbPath?: string;
  stateDir?: string;
} = {}): Promise<void> {
  const dryRun = options.dryRun ?? false;
  const captureOnly = options.captureOnly ?? false;
  const stateDir = options.stateDir ?? HICORTEX_HOME;

  // One-time migration of legacy state files (no-op if state.json exists)
  migrateLegacyState(stateDir);

  // Check mode: client or server
  const savedConfig = readNightlyConfig(stateDir);
  if (savedConfig?.mode === "client") {
    // --capture-only is accepted in client mode but irrelevant: client nightly
    // is already capture-only (no consolidation step).
    await runClientNightly(savedConfig, dryRun);
    return;
  }

  const dbPath = resolveDbPath(options.dbPath);
  const port = (savedConfig?.port as number | undefined) ?? 8787;
  const modeLabel = captureOnly ? " (capture-only)" : dryRun ? " (dry run)" : "";
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

    // Step 1: Read new transcripts (CC + Hermes + Pi + OpenClaw)
    const since = readLastRun();
    console.log(`[hicortex] Reading transcripts since ${since.toISOString()}`);

    const ccBatches = readCcTranscripts(since);
    const hermesBatches = readHermesSessions(since);
    // Pi is a supported harness in the product (readPiTranscripts no-ops when
    // ~/.pi/agent/sessions is absent). Retired only on specific deployments by
    // simply having no Pi session files — not removed from the pipeline.
    const piBatches = readPiTranscripts(since);
    // OpenClaw persists sessions in the Pi v3 format at ~/.openclaw/agents/;
    // no-ops when OC isn't installed.
    const ocBatches = readOcTranscripts(since);
    const batches = [...ccBatches, ...hermesBatches, ...piBatches, ...ocBatches];
    if (ccBatches.length > 0) console.log(`[hicortex] Found ${ccBatches.length} CC session(s)`);
    if (hermesBatches.length > 0) console.log(`[hicortex] Found ${hermesBatches.length} Hermes session(s)`);
    if (piBatches.length > 0) console.log(`[hicortex] Found ${piBatches.length} Pi session(s)`);
    if (ocBatches.length > 0) console.log(`[hicortex] Found ${ocBatches.length} OpenClaw session(s)`);
    console.log(`[hicortex] Total: ${batches.length} new session(s)`);

    if (batches.length === 0 && !dryRun) {
      // Still run consolidation (unless capture-only) — there may be unscored memories from OC.
      console.log(
        captureOnly
          ? `[hicortex] No new transcripts. Nothing to capture.`
          : `[hicortex] No new transcripts. Running consolidation only.`
      );
    }

    // Step 2: Denoise and POST each session to the local daemon via /distill.
    // The dedup check and distillation quality (35B) are the server's concern.
    let memoriesIngested = 0;
    let hadTransientFailure = false;

    for (const batch of batches) {
      const transcript = extractConversationText(batch.entries);
      if (transcript.length < 200) {
        console.log(`[hicortex]   Skip ${batch.sessionId.slice(0, 8)} (${batch.projectName}): too short`);
        continue;
      }

      console.log(`[hicortex]   Capturing ${batch.sessionId.slice(0, 8)} (${batch.projectName}, ${batch.date})`);

      if (dryRun) {
        console.log(`[hicortex]     [dry-run] Would POST ${transcript.length} chars to /distill`);
        continue;
      }

      try {
        const resp = await fetch(`http://127.0.0.1:${port}/distill`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: transcript,
            source_agent: batch.sourceAgent ?? `claude-code/${batch.projectName}`,
            project: batch.projectName,
            session_id: batch.sessionId,
            session_date: batch.date,
            privacy: "WORK",
          }),
          // Synchronous 35B distillation of a large session can take minutes.
          signal: AbortSignal.timeout(20 * 60 * 1000),
        });

        if (resp.status === 200) {
          const data = await resp.json() as Record<string, unknown>;
          if (data.skipped) {
            console.log(`[hicortex]   Skip ${batch.sessionId.slice(0, 8)} (${batch.projectName}): already ingested`);
          }
        } else if (resp.status === 201) {
          const data = await resp.json() as { distilled?: number };
          memoriesIngested += data.distilled ?? 0;
          console.log(`[hicortex]     → ${data.distilled ?? 0} memories extracted`);
        } else if (resp.status === 429) {
          const data = await resp.json() as Record<string, unknown>;
          console.log(`[hicortex]   Memory limit reached: ${data.error}. Stopping capture.`);
          break;
        } else {
          const data = await resp.json().catch(() => ({})) as Record<string, unknown>;
          console.error(`[hicortex]     /distill returned ${resp.status}: ${data.error ?? "unknown error"} — will retry next run`);
          hadTransientFailure = true;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[hicortex]     Capture failed: ${msg} — will retry next run`);
        hadTransientFailure = true;
      }
    }

    console.log(`[hicortex] Capture complete: ${memoriesIngested} new memories`);

    // Step 3: Consolidation — skipped in capture-only mode, dry-run, or no LLM.
    // Runs even if capture had transient failures (opens DB directly, independent
    // of the HTTP capture path). Full nightly only — capture-only runs are
    // intended to run more frequently than once daily.
    if (!dryRun && !captureOnly) {
      if (!llm || !llmConfig) {
        console.error(
          "[hicortex] consolidation skipped: no LLM configured — run npx @gamaze/hicortex init"
        );
      } else {
        // Pre-flight health check for the reflect endpoint.
        // If reflectBaseUrl points to a remote Ollama and it's down (MBP offline),
        // skip reflection entirely instead of waiting through 3 retries (~3.5 min).
        // Scoring + linking + decay still run.
        let skipReflection = false;
        if (llmConfig.reflectBaseUrl && (llmConfig.reflectProvider ?? llmConfig.provider) === "ollama") {
          const reflectModel = llmConfig.reflectModel ?? llmConfig.model;
          const health = await probeOllamaModel(llmConfig.reflectBaseUrl, reflectModel);
          if (!health.ok) {
            const reason = health.reason === "unreachable"
              ? `reflect endpoint unreachable (${llmConfig.reflectBaseUrl})`
              : `reflect model not loaded (${reflectModel} missing on ${llmConfig.reflectBaseUrl})`;
            console.warn(`[hicortex] ${reason} — skipping reflection, scoring + linking will still run`);
            skipReflection = true;
          }
        }

        // Content-based domain classification (config-owned `domains`) uses
        // the classify tier (classifyModel/classifyBaseUrl) when configured,
        // else the reflect tier. Pre-flight the endpoint classification will
        // ACTUALLY use (resolveClassifyProbeTarget is the shared source of
        // truth with `hicortex classify-domains`). If it is down, content
        // classification is NOT ready this run (strict — skip, don't fall
        // back). When no `domains` list is configured, this is inert and the
        // legacy project-grouping path runs.
        const cfgDomains = parseConfigDomains(savedConfig);
        let contentDomainsReady = true;
        if (cfgDomains) {
          const classifyTarget = resolveClassifyProbeTarget(llmConfig);
          if (classifyTarget?.tier === "reflect") {
            // Classification rides the reflect endpoint — reuse the probe above.
            contentDomainsReady = !skipReflection;
          } else if (classifyTarget) {
            const health = await probeOllamaModel(classifyTarget.baseUrl, classifyTarget.model);
            if (!health.ok) {
              const reason = health.reason === "unreachable"
                ? `classify endpoint unreachable (${classifyTarget.baseUrl})`
                : `classify model not loaded (${classifyTarget.model} missing on ${classifyTarget.baseUrl})`;
              console.warn(`[hicortex] ${reason}`);
              contentDomainsReady = false;
            }
          }
          // classifyTarget === null → base endpoint or API provider, no probe.
          if (!contentDomainsReady) {
            console.warn(
              "[hicortex] content-domain classification skipped — classification endpoint offline (strict)",
            );
          }
        }

        console.log(`[hicortex] Running consolidation...`);
        const report = await runConsolidation(db, llm, embed, dryRun, skipReflection, undefined, {
          domains: cfgDomains,
          contentDomainsReady,
          weakPrimaryFloor: resolveWeakPrimaryFloor(savedConfig),
        });
        console.log(
          `[hicortex] Consolidation ${report.status} in ${report.elapsed_seconds}s` +
          (report.stages.reflection ? ` (${report.stages.reflection.lessons_generated} lessons)` : "")
        );
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
        writeLastRun();
      }
    }

    console.log(`[hicortex] Nightly pipeline complete.`);

    // Anonymous telemetry (fire-and-forget, full nightly only).
    // Capture-only runs are excluded to avoid inflating install pings.
    if (!dryRun && !captureOnly && isTelemetryEnabled(savedConfig)) {
      const kinds = [
        ccBatches.length > 0 && "cc",
        hermesBatches.length > 0 && "hermes",
        piBatches.length > 0 && "pi",
        ocBatches.length > 0 && "oc",
      ].filter(Boolean) as string[];
      const agentType = kinds.length > 1 ? "mixed" : (kinds[0] ?? "cc");
      await sendTelemetry({
        id: getTelemetryId(stateDir),
        v: VERSION,
        mode: "server",
        agent: agentType,
        mem: storage.countMemories(db),
        lessons: storage.getLessons(db, 365).length,
        sessions: batches.length,
        ok: !hadTransientFailure,
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
  dryRun: boolean
): Promise<void> {
  const serverUrl = (config.serverUrl as string).replace(/\/+$/, "");
  const authToken = config.authToken as string | undefined;

  console.log(`[hicortex] Client nightly starting${dryRun ? " (dry run)" : ""}`);
  console.log(`[hicortex] Server: ${serverUrl}`);

  // Verify server is reachable
  try {
    const resp = await fetch(`${serverUrl}/health`, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json() as Record<string, unknown>;
    console.log(`[hicortex] Server OK: v${data.version}, ${data.memories} memories`);
  } catch (err) {
    console.error(`[hicortex] Server unreachable at ${serverUrl}: ${err instanceof Error ? err.message : String(err)}`);
    console.error(`[hicortex] Aborting. Will retry next run.`);
    return; // Don't update last-run so we retry
  }

  // No local LLM needed — distillation happens on the server.

  // Read new transcripts (CC + Hermes + Pi + OpenClaw). Client reads local
  // logs, denoises, and POSTs the denoised text to the server's /distill
  // endpoint. All readers no-op when their harness isn't installed.
  const since = readLastRun();
  console.log(`[hicortex] Reading transcripts since ${since.toISOString()}`);

  const ccBatches = readCcTranscripts(since);
  const hermesBatches = readHermesSessions(since);
  const piBatches = readPiTranscripts(since);
  const ocBatches = readOcTranscripts(since);
  const batches = [...ccBatches, ...hermesBatches, ...piBatches, ...ocBatches];
  if (ccBatches.length > 0) console.log(`[hicortex] Found ${ccBatches.length} CC session(s)`);
  if (hermesBatches.length > 0) console.log(`[hicortex] Found ${hermesBatches.length} Hermes session(s)`);
  if (piBatches.length > 0) console.log(`[hicortex] Found ${piBatches.length} Pi session(s)`);
  if (ocBatches.length > 0) console.log(`[hicortex] Found ${ocBatches.length} OpenClaw session(s)`);
  console.log(`[hicortex] Total: ${batches.length} new session(s)`);

  if (batches.length === 0) {
    console.log(`[hicortex] Nothing to capture.`);
    if (!dryRun) writeLastRun();
    return;
  }

  let hadTransientFailure = false;
  let memoriesIngested = 0;
  let sessionsSent = 0;

  for (const batch of batches) {
    const transcript = extractConversationText(batch.entries);
    if (transcript.length < 200) {
      console.log(`[hicortex]   Skip ${batch.sessionId.slice(0, 8)} (${batch.projectName}): too short`);
      continue;
    }

    console.log(`[hicortex]   Capturing ${batch.sessionId.slice(0, 8)} (${batch.projectName}, ${batch.date})`);

    if (dryRun) {
      console.log(`[hicortex]     [dry-run] Would POST ${transcript.length} chars to ${serverUrl}/distill`);
      continue;
    }

    try {
      const resp = await fetch(`${serverUrl}/distill`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(authToken ? { "Authorization": `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify({
          text: transcript,
          source_agent: batch.sourceAgent ?? `claude-code/${batch.projectName}`,
          project: batch.projectName,
          session_id: batch.sessionId,
          session_date: batch.date,
          privacy: "WORK",
        }),
        // Synchronous 35B distillation of a large session can take minutes.
        signal: AbortSignal.timeout(20 * 60 * 1000),
      });

      if (resp.status === 200) {
        const data = await resp.json() as Record<string, unknown>;
        if (data.skipped) {
          console.log(`[hicortex]   Skip ${batch.sessionId.slice(0, 8)}: already ingested on server`);
        }
      } else if (resp.status === 201) {
        const data = await resp.json() as { distilled?: number };
        const count = data.distilled ?? 0;
        memoriesIngested += count;
        sessionsSent++;
        console.log(`[hicortex]     → ${count} memories sent to server`);
      } else if (resp.status === 401) {
        console.error(`[hicortex]     Auth failed. Check authToken in ~/.hicortex/config.json`);
        return; // No point retrying with wrong credentials
      } else if (resp.status === 429) {
        const data = await resp.json().catch(() => ({})) as Record<string, unknown>;
        console.log(`[hicortex]   Server memory limit reached: ${data.error}`);
        return;
      } else {
        const data = await resp.json().catch(() => ({})) as Record<string, unknown>;
        console.error(`[hicortex]     /distill returned ${resp.status}: ${data.error ?? "unknown error"} — will retry next run`);
        hadTransientFailure = true;
      }
    } catch (err) {
      console.error(`[hicortex]     Capture failed: ${err instanceof Error ? err.message : String(err)} — will retry next run`);
      hadTransientFailure = true;
    }
  }

  // Only advance lastRun if every session was processed without a transient
  // failure. Otherwise failed sessions would be permanently lost.
  if (!dryRun) {
    if (hadTransientFailure) {
      console.warn(
        `[hicortex] Not advancing lastRun — one or more sessions failed. ` +
        `They will be retried on the next run.`
      );
    } else {
      writeLastRun();
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
    ].filter(Boolean) as string[];
    const agentType = kinds.length > 1 ? "mixed" : (kinds[0] ?? "cc");
    await sendTelemetry({
      id: getTelemetryId(HICORTEX_HOME),
      v: VERSION,
      mode: "client",
      agent: agentType,
      mem: memoriesIngested,
      lessons: 0, // client doesn't have direct DB access
      sessions: batches.length,
      ok: !hadTransientFailure,
    });
  }
}
