/**
 * Nightly pipeline — manual trigger or called by the persistent server.
 *
 * Steps:
 *   1. Read new CC transcripts since last run
 *   2. Distill each session into memories via LLM
 *   3. Run consolidation (scoring, reflection, linking, decay)
 *   4. Inject lessons into CLAUDE.md
 *   5. Update last-run timestamp
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type Database from "better-sqlite3";

let VERSION = "0.0.0";
try { VERSION = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8")).version; } catch {}

import { initDb, resolveDbPath } from "./db.js";
import { resolveLlmConfigForCC, LlmClient, findClaudeBinary, claudeCliConfig, preferOllamaForBatch, probeOllamaModel, type LlmConfig } from "./llm.js";
import { embed } from "./embedder.js";
import * as storage from "./storage.js";
import { extractConversationText, distillSession, detectChunkSize } from "./distiller.js";
import { runConsolidation } from "./consolidate.js";
import { readCcTranscripts } from "./transcript-reader.js";
import { readPiTranscripts } from "./pi-transcript-reader.js";
import { injectLessons } from "./claude-md.js";
import { initFeatures, lessonsLimit, memoryCapReached, maxMemoriesAllowed } from "./features.js";
import { getLessonSelector } from "./extensions.js";
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
  dbPath?: string;
  stateDir?: string;
} = {}): Promise<void> {
  const dryRun = options.dryRun ?? false;
  const stateDir = options.stateDir ?? HICORTEX_HOME;

  // One-time migration of legacy state files (no-op if state.json exists)
  migrateLegacyState(stateDir);

  // Check mode: client or server
  const savedConfig = readNightlyConfig(stateDir);
  if (savedConfig?.mode === "client") {
    await runClientNightly(savedConfig, dryRun);
    return;
  }

  const dbPath = resolveDbPath(options.dbPath);
  console.log(`[hicortex] Nightly pipeline starting${dryRun ? " (dry run)" : ""}`);
  console.log(`[hicortex] DB: ${dbPath}`);

  // Init DB
  const db = initDb(dbPath);

  try {
    // License: read from config file or env var, init feature cache
    const licenseKey = readConfigLicenseKey(stateDir) ?? process.env.HICORTEX_LICENSE_KEY;
    await initFeatures(licenseKey, stateDir);

    // Init LLM: check config.json first, then auto-detect
    let llmConfig;
    const savedConfig = readNightlyConfig(stateDir);
    if (savedConfig?.llmBackend === "claude-cli") {
      const claudePath = findClaudeBinary();
      if (claudePath) {
        llmConfig = claudeCliConfig(claudePath);
      } else {
        console.warn("[hicortex] claude-cli configured but binary not found, falling back");
        llmConfig = resolveLlmConfigForCC({
          llmBaseUrl: savedConfig?.llmBaseUrl as string | undefined,
          llmApiKey: savedConfig?.llmApiKey as string | undefined,
          llmModel: savedConfig?.llmModel as string | undefined,
          reflectModel: savedConfig?.reflectModel as string | undefined,
        });
      }
    } else if (savedConfig?.llmBackend === "ollama") {
      llmConfig = {
        baseUrl: (savedConfig.llmBaseUrl as string | undefined) ?? "http://localhost:11434",
        apiKey: "",
        model: (savedConfig.llmModel as string) ?? "qwen3.5:4b",
        reflectModel: (savedConfig.reflectModel as string) ?? (savedConfig.llmModel as string) ?? "qwen3.5:4b",
        provider: "ollama",
      };
    } else {
      llmConfig = resolveLlmConfigForCC({
        llmBaseUrl: savedConfig?.llmBaseUrl as string | undefined,
        llmApiKey: savedConfig?.llmApiKey as string | undefined,
        llmModel: savedConfig?.llmModel as string | undefined,
        reflectModel: savedConfig?.reflectModel as string | undefined,
      });
    }
    // Apply distill and reflect overrides from config
    if (savedConfig?.distillModel) {
      llmConfig.distillModel = savedConfig.distillModel as string;
    }
    if (savedConfig?.distillBaseUrl) {
      llmConfig.distillBaseUrl = savedConfig.distillBaseUrl as string;
      llmConfig.distillApiKey = (savedConfig.distillApiKey as string | undefined) ?? llmConfig.apiKey;
      llmConfig.distillProvider = (savedConfig.distillProvider as string | undefined) ?? llmConfig.provider;
    }
    if (savedConfig?.reflectBaseUrl) {
      llmConfig.reflectBaseUrl = savedConfig.reflectBaseUrl as string;
      llmConfig.reflectApiKey = (savedConfig.reflectApiKey as string | undefined) ?? llmConfig.apiKey;
      llmConfig.reflectProvider = (savedConfig.reflectProvider as string | undefined) ?? llmConfig.provider;
    }
    // Auto-detect Ollama for batch distillation (claude-cli has rate limits)
    llmConfig = await preferOllamaForBatch(llmConfig);
    if (llmConfig.provider === "ollama") {
      console.log(`[hicortex] Auto-detected local Ollama (${llmConfig.model}) — using for batch distillation`);
    }
    const llm = new LlmClient(llmConfig);
    const distillInfo = llmConfig.distillBaseUrl
      ? `${llmConfig.distillProvider}/${llmConfig.distillModel}@${llmConfig.distillBaseUrl}`
      : llmConfig.distillModel ?? "";
    console.log(`[hicortex] LLM: ${llmConfig.provider}/${llmConfig.model}${distillInfo ? `, distill: ${distillInfo}` : ""}`);

    // Step 1: Read new transcripts (CC + Pi)
    const since = readLastRun();
    console.log(`[hicortex] Reading transcripts since ${since.toISOString()}`);

    const ccBatches = readCcTranscripts(since);
    const piBatches = readPiTranscripts(since);
    const batches = [...ccBatches, ...piBatches];
    if (ccBatches.length > 0) console.log(`[hicortex] Found ${ccBatches.length} CC session(s)`);
    if (piBatches.length > 0) console.log(`[hicortex] Found ${piBatches.length} Pi session(s)`);
    console.log(`[hicortex] Total: ${batches.length} new session(s)`);

    if (batches.length === 0 && !dryRun) {
      // Still run consolidation — there may be unscored memories from OC
      console.log(`[hicortex] No new transcripts. Running consolidation only.`);
    }

    // Step 2: Distill each session
    let memoriesIngested = 0;
    let hadTransientFailure = false;

    // Pre-flight health check for a remote distill endpoint.
    // If the distill provider is Ollama on a remote host and that host (or the
    // required model) is unreachable, abort BEFORE touching any sessions —
    // prevents the data-loss bug where lastRun advances past sessions that
    // were never actually processed.
    if (batches.length > 0 && llmConfig.distillBaseUrl && (llmConfig.distillProvider ?? llmConfig.provider) === "ollama") {
      const distillModel = llmConfig.distillModel ?? llmConfig.model;
      const health = await probeOllamaModel(llmConfig.distillBaseUrl, distillModel);
      if (!health.ok) {
        const reason = health.reason === "unreachable"
          ? `distill endpoint unreachable (${llmConfig.distillBaseUrl})`
          : `distill model not loaded (${distillModel} missing on ${llmConfig.distillBaseUrl})`;
        console.error(`[hicortex] ABORT: ${reason} — will retry next run, lastRun unchanged`);
        hadTransientFailure = true;
        batches.length = 0; // Skip the distillation loop entirely
      }
    }

    // Detect safe chunk size based on model context window
    const chunkSize = await detectChunkSize(llmConfig.provider, llmConfig.distillModel ?? llmConfig.model, llmConfig.baseUrl);

    for (const batch of batches) {
      const transcript = extractConversationText(batch.entries);
      if (transcript.length < 200) {
        console.log(`[hicortex]   Skip ${batch.sessionId.slice(0, 8)} (${batch.projectName}): too short`);
        continue;
      }

      // Server-mode per-session dedup: skip sessions already in the DB.
      // Client mode gets this for free via the server's /ingest endpoint;
      // server mode writes directly via storage.insertMemory and needs
      // an explicit check. This makes retries of previously-failed runs
      // idempotent.
      if (!dryRun) {
        const existing = db
          .prepare("SELECT COUNT(*) as c FROM memories WHERE source_session = ?")
          .get(batch.sessionId) as { c: number };
        if (existing.c > 0) {
          console.log(`[hicortex]   Skip ${batch.sessionId.slice(0, 8)} (${batch.projectName}): already ingested`);
          continue;
        }
      }

      console.log(
        `[hicortex]   Distilling ${batch.sessionId.slice(0, 8)} (${batch.projectName}, ${batch.date})`
      );

      if (dryRun) {
        console.log(`[hicortex]     [dry-run] Would distill ${transcript.length} chars`);
        continue;
      }

      // Check cap before distilling
      if (memoryCapReached(storage.countMemories(db))) {
        console.log(
          `[hicortex]   Free tier limit (${maxMemoriesAllowed()} memories). Skipping new ingestion. ` +
          `Upgrade: https://hicortex.gamaze.com/`
        );
        break;
      }

      try {
        const entries = await distillSession(llm, transcript, batch.projectName, batch.date, chunkSize);

        for (const entry of entries) {
          try {
            const embedding = await embed(entry);
            storage.insertMemory(db, entry, embedding, {
              sourceAgent: `claude-code/${batch.projectName}`,
              sourceSession: batch.sessionId,
              project: batch.projectName,
              privacy: "WORK",
              memoryType: "episode",
            });
            memoriesIngested++;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[hicortex]     Failed to ingest entry: ${msg}`);
          }
        }

        console.log(`[hicortex]     → ${entries.length} memories extracted`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[hicortex]     Distillation failed: ${msg} — will retry next run`);
        hadTransientFailure = true;
      }
    }

    console.log(`[hicortex] Distillation complete: ${memoriesIngested} new memories`);

    // Step 3: Consolidation
    if (!dryRun) {
      // Pre-flight health check for the reflect endpoint.
      // If reflectBaseUrl points to a remote Ollama and it's down (MBP offline),
      // skip reflection entirely instead of waiting through 3 retries (~3.5 min).
      // Scoring + linking + decay still run (they use the local model or don't need LLM).
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

      console.log(`[hicortex] Running consolidation...`);
      const report = await runConsolidation(db, llm, embed, dryRun, skipReflection);
      console.log(
        `[hicortex] Consolidation ${report.status} in ${report.elapsed_seconds}s` +
        (report.stages.reflection ? ` (${report.stages.reflection.lessons_generated} lessons)` : "")
      );
    }

    // Step 4: Inject lessons into the target file (CLAUDE.md or EXPERIENCE.md
    // or custom path — configurable via lessonTarget in config.json)
    if (!dryRun) {
      const lessonTarget = savedConfig?.lessonTarget as string | undefined;
      const injection = await injectLessons(db, {
        claudeMdPath: lessonTarget,
        stateDir,
      });
      console.log(`[hicortex] Lessons updated: ${injection.lessonsCount} lessons at ${injection.path}`);
    }

    // Step 5: Update last-run timestamp
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

    // Step 6: Anonymous telemetry (fire-and-forget, opt-out via config)
    if (!dryRun && isTelemetryEnabled(savedConfig)) {
      const agentType = piBatches.length > 0 && ccBatches.length > 0 ? "mixed"
        : piBatches.length > 0 ? "pi"
        : "cc";
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
// Client Mode Nightly — distill locally, POST to remote server
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

  // Init LLM for local distillation
  let llmConfig: LlmConfig;
  if (config.llmBackend === "claude-cli") {
    const claudePath = findClaudeBinary();
    if (claudePath) {
      llmConfig = claudeCliConfig(claudePath);
    } else {
      llmConfig = resolveLlmConfigForCC();
    }
  } else if (config.llmBackend === "ollama") {
    llmConfig = {
      baseUrl: (config.llmBaseUrl as string) ?? "http://localhost:11434",
      apiKey: "",
      model: (config.llmModel as string) ?? "qwen3.5:4b",
      reflectModel: (config.reflectModel as string) ?? (config.llmModel as string) ?? "qwen3.5:4b",
      provider: "ollama",
    };
  } else {
    llmConfig = resolveLlmConfigForCC({
      llmBaseUrl: config.llmBaseUrl as string | undefined,
      llmApiKey: config.llmApiKey as string | undefined,
      llmModel: config.llmModel as string | undefined,
    });
  }
  if (config.distillModel) {
    llmConfig.distillModel = config.distillModel as string;
  }
  if (config.distillBaseUrl) {
    llmConfig.distillBaseUrl = config.distillBaseUrl as string;
    llmConfig.distillApiKey = (config.distillApiKey as string | undefined) ?? llmConfig.apiKey;
    llmConfig.distillProvider = (config.distillProvider as string | undefined) ?? llmConfig.provider;
  }
  // Auto-detect Ollama for batch distillation when claude-cli was resolved (fallback)
  llmConfig = await preferOllamaForBatch(llmConfig);
  if (llmConfig.provider === "ollama" && !config.distillBaseUrl) {
    console.log(`[hicortex] Auto-detected local Ollama (${llmConfig.model}) — using for batch distillation`);
  }
  const llm = new LlmClient(llmConfig);
  const distillInfo = llmConfig.distillBaseUrl
    ? `${llmConfig.distillProvider}/${llmConfig.distillModel}@${llmConfig.distillBaseUrl}`
    : llmConfig.distillModel ?? "";
  console.log(`[hicortex] LLM: ${llmConfig.provider}/${llmConfig.model}${distillInfo ? `, distill: ${distillInfo}` : ""}`);

  // Detect safe chunk size based on model context window
  const chunkSize = await detectChunkSize(llmConfig.provider, llmConfig.distillModel ?? llmConfig.model, llmConfig.baseUrl);

  // Read new CC transcripts
  const since = readLastRun();
  console.log(`[hicortex] Reading CC transcripts since ${since.toISOString()}`);

  const batches = readCcTranscripts(since);
  console.log(`[hicortex] Found ${batches.length} new session(s)`);

  if (batches.length === 0) {
    console.log(`[hicortex] Nothing to distill.`);
    if (!dryRun) writeLastRun();
    return;
  }

  // Pre-flight health check for a remote distill endpoint (client mode).
  // If the distill provider is Ollama on a remote host and the required model
  // isn't loaded, abort BEFORE touching any sessions — same data-loss fix
  // as server mode.
  let hadTransientFailure = false;
  if (llmConfig.distillBaseUrl && (llmConfig.distillProvider ?? llmConfig.provider) === "ollama") {
    const distillModel = llmConfig.distillModel ?? llmConfig.model;
    const health = await probeOllamaModel(llmConfig.distillBaseUrl, distillModel);
    if (!health.ok) {
      const reason = health.reason === "unreachable"
        ? `distill endpoint unreachable (${llmConfig.distillBaseUrl})`
        : `distill model not loaded (${distillModel} missing on ${llmConfig.distillBaseUrl})`;
      console.error(`[hicortex] ABORT: ${reason} — will retry next run, lastRun unchanged`);
      return; // Don't touch lastRun; next trigger retries the same sessions
    }
  }

  // Distill each session and POST to server
  let memoriesIngested = 0;
  let sessionsSent = 0;

  for (const batch of batches) {
    const transcript = extractConversationText(batch.entries);
    if (transcript.length < 200) {
      console.log(`[hicortex]   Skip ${batch.sessionId.slice(0, 8)} (${batch.projectName}): too short`);
      continue;
    }

    console.log(`[hicortex]   Distilling ${batch.sessionId.slice(0, 8)} (${batch.projectName}, ${batch.date})`);

    if (dryRun) {
      console.log(`[hicortex]     [dry-run] Would distill ${transcript.length} chars`);
      continue;
    }

    try {
      const entries = await distillSession(llm, transcript, batch.projectName, batch.date, chunkSize);
      if (entries.length === 0) {
        console.log(`[hicortex]     → No memories extracted`);
        continue;
      }

      // POST each extracted memory to the server
      let sessionCount = 0;
      for (const entry of entries) {
        const resp = await fetch(`${serverUrl}/ingest`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(authToken ? { "Authorization": `Bearer ${authToken}` } : {}),
          },
          body: JSON.stringify({
            content: entry,
            source_agent: `claude-code/${batch.projectName}`,
            project: batch.projectName,
            memory_type: "episode",
            privacy: "WORK",
            source_session: batch.sessionId,
            session_date: batch.date,
          }),
          signal: AbortSignal.timeout(30_000),
        });

        const result = await resp.json() as Record<string, unknown>;

        if (resp.status === 201) {
          sessionCount++;
          memoriesIngested++;
        } else if (result.skipped) {
          console.log(`[hicortex]     → Already ingested (${result.existing_count} existing)`);
          break;
        } else if (resp.status === 401) {
          console.error(`[hicortex]     Auth failed. Check authToken in ~/.hicortex/config.json`);
          return;
        } else if (resp.status === 429) {
          console.log(`[hicortex]     Server memory limit reached.`);
          return;
        } else {
          console.error(`[hicortex]     Ingest failed (${resp.status}): ${result.error}`);
          hadTransientFailure = true;
        }
      }
      if (sessionCount > 0) {
        sessionsSent++;
        console.log(`[hicortex]     → ${sessionCount} memories sent to server`);
      }
    } catch (err) {
      console.error(`[hicortex]     Distillation failed: ${err instanceof Error ? err.message : String(err)} — will retry next run`);
      hadTransientFailure = true;
    }
  }

  // Inject lessons from server into CLAUDE.md
  if (!dryRun) {
    try {
      await injectLessonsFromServer(serverUrl, authToken);
    } catch (err) {
      console.error(`[hicortex] CLAUDE.md injection failed: ${err instanceof Error ? err.message : String(err)}`);
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
    await sendTelemetry({
      id: getTelemetryId(HICORTEX_HOME),
      v: VERSION,
      mode: "client",
      agent: "cc", // client mode is always CC-originated currently
      mem: memoriesIngested,
      lessons: 0, // client doesn't know lesson count
      sessions: batches.length,
      ok: !hadTransientFailure,
    });
  }
}

/**
 * Fetch lessons + memory index from server and inject into CLAUDE.md.
 * Client mode equivalent of the server's injectLessons(db, ...).
 */
async function injectLessonsFromServer(serverUrl: string, authToken?: string): Promise<void> {
  const resp = await fetch(`${serverUrl}/lessons`, {
    headers: authToken ? { "Authorization": `Bearer ${authToken}` } : {},
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) {
    console.log(`[hicortex] Could not fetch lessons from server (${resp.status})`);
    return;
  }

  const data = await resp.json() as {
    lessons: Array<{ content: string; created_at: string; base_strength: number; access_count: number }>;
    index: { total: number; lessonCount: number; sourceCount: number; projects: Array<{ name: string; count: number }> };
  };

  const maxLessons = lessonsLimit();
  const selected = await getLessonSelector().select(data.lessons, { maxLessons });

  // Format lessons
  const lessonLines = selected.map((l) => {
    const titleMatch = l.content.match(/## Lesson: (.+)/);
    const typeMatch = l.content.match(/\*\*Type:\*\* (\w+)/);
    const severityMatch = l.content.match(/\*\*Severity:\*\* (\w+)/);
    const title = titleMatch ? titleMatch[1] : l.content.slice(0, 150);
    const meta = [severityMatch?.[1], typeMatch?.[1]].filter(Boolean).join(", ");
    return `- ${title}${meta ? ` (${meta})` : ""}`;
  });

  // Format project index
  const projectIndex = data.index.projects.map(p => `${p.name}: ${p.count}`);

  // Build block
  const START_MARKER = "<!-- HICORTEX-LEARNINGS:START -->";
  const END_MARKER = "<!-- HICORTEX-LEARNINGS:END -->";

  const blockParts = [START_MARKER, "## Hicortex Memory"];
  blockParts.push(
    "",
    "You have access to shared long-term memory across all agents and sessions.",
    "BEFORE making decisions, search memory: `hicortex_search` for prior decisions on the same topic.",
    "Use `hicortex_context` at session start for recent project state."
  );

  if (lessonLines.length > 0) {
    blockParts.push("", "### Lessons (updated nightly)");
    blockParts.push(...lessonLines);
  } else {
    blockParts.push("", "### Getting Started");
    blockParts.push("- Search past decisions with `hicortex_search` before starting work");
    blockParts.push("- Save important decisions with `hicortex_ingest`");
    blockParts.push("- Lessons will appear here after the first nightly run");
  }

  if (projectIndex.length > 0) {
    blockParts.push("", "### Memory Index");
    blockParts.push(projectIndex.join(" | "));
    blockParts.push(
      `${data.index.total} memories, ${data.index.lessonCount} lessons, ${data.index.sourceCount} agents. Search with \`hicortex_search\`.`
    );
  }

  blockParts.push(END_MARKER);
  const block = blockParts.join("\n");

  // Write to CLAUDE.md (uses fs/path/os already imported at top of file)
  const claudeMdPath = join(homedir(), ".claude", "CLAUDE.md");

  let content = "";
  try { content = readFileSync(claudeMdPath, "utf-8"); } catch {}

  const startIdx = content.indexOf(START_MARKER);
  const endIdx = content.indexOf(END_MARKER);

  if (startIdx !== -1 && endIdx !== -1) {
    content = content.slice(0, startIdx) + block + content.slice(endIdx + END_MARKER.length);
  } else {
    if (content.length > 0 && !content.endsWith("\n")) content += "\n";
    if (content.length > 0) content += "\n";
    content += block + "\n";
  }

  mkdirSync(dirname(claudeMdPath), { recursive: true });
  writeFileSync(claudeMdPath, content);
  console.log(`[hicortex] CLAUDE.md updated: ${lessonLines.length} lessons, ${data.index.total} memories indexed`);
}
