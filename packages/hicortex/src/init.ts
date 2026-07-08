/**
 * Hicortex init — detect existing setup and configure for CC.
 *
 * Detection:
 *   1. Local HC server running (localhost:8787)
 *   2. Remote HC server (HICORTEX_SERVER_URL — any reachable host:port)
 *   3. OC plugin installed (~/.openclaw/openclaw.json)
 *   4. CC MCP already registered (~/.claude/settings.json)
 *   5. Existing DB (~/.hicortex/ or ~/.openclaw/data/)
 *
 * Actions:
 *   - Install persistent daemon (launchd/systemd)
 *   - Register MCP server in CC settings
 *   - Install CC SessionStart hook for query-time lessons
 *   - Strip old static CLAUDE.md learnings block if present
 *   - Install CC custom commands (/learn, /hicortex-activate)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, statSync, symlinkSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, platform } from "node:os";
import { execSync } from "node:child_process";
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
import { removeLessonsBlock } from "./claude-md.js";
import type { DomainDef } from "./types.js";

const HICORTEX_HOME = join(homedir(), ".hicortex");
const CC_SETTINGS = join(homedir(), ".claude", "settings.json");
const CC_COMMANDS_DIR = join(homedir(), ".claude", "commands");
const OC_CONFIG = join(homedir(), ".openclaw", "openclaw.json");
const HERMES_HOME = process.env.HERMES_HOME || join(homedir(), ".hermes");
const DEFAULT_PORT = 8787;

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

interface DetectionResult {
  localServer: boolean;
  localServerUrl?: string;
  remoteServer: boolean;
  remoteServerUrl?: string;
  ocPlugin: boolean;
  ccMcpRegistered: boolean;
  hermesFound: boolean;
  existingDb: boolean;
  dbPath?: string;
  memoryCount?: number;
}

async function detect(): Promise<DetectionResult> {
  const result: DetectionResult = {
    localServer: false,
    remoteServer: false,
    ocPlugin: false,
    ccMcpRegistered: false,
    hermesFound: false,
    existingDb: false,
  };

  // Check local server
  try {
    const resp = await fetch(`http://127.0.0.1:${DEFAULT_PORT}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (resp.ok) {
      result.localServer = true;
      result.localServerUrl = `http://127.0.0.1:${DEFAULT_PORT}`;
      const data = await resp.json() as { memories?: number };
      result.memoryCount = data.memories;
    }
  } catch { /* not running */ }

  // Check remote server (env var)
  const remoteUrl = process.env.HICORTEX_SERVER_URL;
  if (remoteUrl && !result.localServer) {
    try {
      const resp = await fetch(`${remoteUrl}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (resp.ok) {
        result.remoteServer = true;
        result.remoteServerUrl = remoteUrl;
        const data = await resp.json() as { memories?: number };
        result.memoryCount = data.memories;
      }
    } catch { /* not reachable */ }
  }

  // Check Hermes
  result.hermesFound = existsSync(HERMES_HOME);

  // Check OC plugin
  try {
    const raw = readFileSync(OC_CONFIG, "utf-8");
    const config = JSON.parse(raw);
    const entries = config?.plugins?.entries ?? {};
    const installs = config?.plugins?.installs ?? {};
    result.ocPlugin = "hicortex" in entries || "hicortex" in installs || "hicortex-memory" in entries;
  } catch { /* no OC config */ }

  // Check CC MCP registration (claude mcp add writes to .claude.json, not settings.json)
  for (const configPath of [
    join(homedir(), ".claude.json"),
    CC_SETTINGS,
  ]) {
    try {
      const raw = readFileSync(configPath, "utf-8");
      const settings = JSON.parse(raw);
      if ("hicortex" in (settings?.mcpServers ?? {})) {
        result.ccMcpRegistered = true;
        break;
      }
    } catch { /* file doesn't exist */ }
  }

  // Check existing DB
  const canonicalDb = join(HICORTEX_HOME, "hicortex.db");
  const legacyDb = join(homedir(), ".openclaw", "data", "hicortex.db");
  if (existsSync(canonicalDb)) {
    result.existingDb = true;
    result.dbPath = canonicalDb;
  } else if (existsSync(legacyDb)) {
    result.existingDb = true;
    result.dbPath = legacyDb;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function registerCcMcp(serverUrl: string): void {
  try {
    // Remove existing entry first (idempotent — ignore if not found)
    try { execSync("claude mcp remove hicortex 2>/dev/null", { encoding: "utf-8", stdio: "pipe" }); } catch { /* not found */ }
    // Use claude CLI to register — it knows the correct config format and location
    execSync(
      `claude mcp add hicortex --transport sse ${serverUrl}/sse`,
      { encoding: "utf-8", stdio: "pipe" }
    );
    console.log(`  ✓ Registered MCP server via claude CLI`);
  } catch (err) {
    // Fallback: write directly to ~/.claude.json (where CC reads MCP servers)
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ⚠ claude CLI registration failed (${msg}), writing ~/.claude.json directly`);

    const claudeJsonPath = join(homedir(), ".claude.json");
    let config: Record<string, unknown> = {};
    if (existsSync(claudeJsonPath)) {
      try {
        config = JSON.parse(readFileSync(claudeJsonPath, "utf-8"));
      } catch {
        console.log(`  ⚠ ${claudeJsonPath} exists but is not valid JSON — skipping MCP registration. Fix the file, then re-run init or run: claude mcp add hicortex --transport sse ${serverUrl}/sse`);
        return;
      }
    }

    if (!config.mcpServers) config.mcpServers = {};
    (config.mcpServers as Record<string, unknown>).hicortex = {
      type: "sse",
      url: `${serverUrl}/sse`,
    };

    writeFileSync(claudeJsonPath, JSON.stringify(config, null, 2));
    console.log(`  ✓ Registered MCP server in ${claudeJsonPath}`);
  }

  // Add MCP tool permissions to settings.json so users don't get prompted
  allowHicortexTools();
}

function allowHicortexTools(): void {
  let settings: Record<string, unknown> = {};
  if (existsSync(CC_SETTINGS)) {
    try {
      settings = JSON.parse(readFileSync(CC_SETTINGS, "utf-8"));
    } catch {
      console.log(`  ⚠ ${CC_SETTINGS} exists but is not valid JSON — skipping tool permissions. Fix the file, then re-run init or add "mcp__hicortex__*" to permissions.allow manually.`);
      return;
    }
  }

  if (!settings.permissions) settings.permissions = {};
  const perms = settings.permissions as Record<string, unknown>;
  if (!perms.allow) perms.allow = [];
  const allow = perms.allow as string[];

  const rule = "mcp__hicortex__*";
  if (!allow.includes(rule)) {
    allow.push(rule);
    mkdirSync(dirname(CC_SETTINGS), { recursive: true });
    writeFileSync(CC_SETTINGS, JSON.stringify(settings, null, 2));
    console.log(`  ✓ Added Hicortex tool permissions to ${CC_SETTINGS}`);
  }
}

function installCcCommands(): void {
  mkdirSync(CC_COMMANDS_DIR, { recursive: true });

  // /learn command
  const learnContent = `---
name: learn
description: Save an explicit learning/insight to Hicortex long-term memory. Immediate storage, no nightly wait. Use when you discover something worth remembering across sessions.
argument-hint: <learning to save>
allowed-tools: mcp__hicortex__hicortex_ingest, mcp__hicortex__hicortex_search, mcp__hicortex__hicortex_context, mcp__hicortex__hicortex_lessons
---

# Save Learning to Hicortex

When invoked with \`/learn <text>\`, store the learning in long-term memory via the Hicortex MCP tool.

## Steps

1. Parse the text after \`/learn\`
2. Clean it up into a clear, self-contained statement that will make sense months from now
3. Include the "why" when relevant
4. Add today's date for temporal context
5. Call the \`hicortex_ingest\` tool with:
   - \`content\`: The learning text prefixed with "LEARNING: " and suffixed with the date
   - \`project\`: "global" (unless clearly project-specific)
   - \`memory_type\`: "lesson"
6. Confirm what was saved (brief, one line)

## Example

\`/learn always check provider docs before assuming an API uses the same auth scheme as OpenAI\`

Becomes a call to hicortex_ingest with:
- content: "LEARNING: always check provider docs before assuming an API uses the same auth scheme as OpenAI — header names and token formats vary widely (Bearer vs x-api-key vs custom)."
- memory_type: "lesson"
`;
  const learnPath = join(CC_COMMANDS_DIR, "learn.md");
  if (existsSync(learnPath)) {
    // Check if it's ours (contains hicortex_ingest)
    const existing = readFileSync(learnPath, "utf-8");
    if (!existing.includes("hicortex_ingest") && !existing.includes("hicortex")) {
      console.log(`  ⚠ Skipping /learn — existing command found (not Hicortex). Won't overwrite.`);
    } else {
      writeFileSync(learnPath, learnContent);
    }
  } else {
    writeFileSync(learnPath, learnContent);
  }

  // /hicortex-activate command — registers a commercial license key for display in status
  const activateContent = `---
name: hicortex-activate
description: Register a Hicortex commercial license key. Personal and noncommercial use is free; commercial use requires a per-seat license from hicortex.gamaze.com.
argument-hint: <license-key>
allowed-tools: Bash(mkdir:*), Bash(echo:*), Bash(launchctl:*), Bash(systemctl:*), Bash(curl:*), mcp__hicortex__hicortex_ingest, mcp__hicortex__hicortex_search, mcp__hicortex__hicortex_context, mcp__hicortex__hicortex_lessons
---

# Register Hicortex Commercial License

## If key provided (e.g. /hicortex-activate hctx-abc123)

1. Write the key to the config file:

\`\`\`bash
mkdir -p ~/.hicortex
echo '{ "licenseKey": "THE_KEY_HERE" }' > ~/.hicortex/config.json
\`\`\`

2. Restart the server to apply:

On macOS:
\`\`\`bash
launchctl kickstart -k gui/$(id -u)/com.gamaze.hicortex
\`\`\`

On Linux:
\`\`\`bash
systemctl --user restart hicortex
\`\`\`

3. Verify the key is recognised:
\`\`\`bash
hicortex status
\`\`\`

4. Tell the user: "Commercial license registered. The license tier will appear in \`hicortex status\`."

## If no key provided

Tell them: "Hicortex is free for personal and noncommercial use. Commercial use requires a per-seat license — see https://hicortex.gamaze.com/. After purchase you will receive a key; pass it here and I'll register it."
`;
  writeFileSync(join(CC_COMMANDS_DIR, "hicortex-activate.md"), activateContent);

  console.log(`  ✓ Installed /learn and /hicortex-activate commands in ${CC_COMMANDS_DIR}`);
}

// ---------------------------------------------------------------------------
// Hermes setup
// ---------------------------------------------------------------------------

function setupHermes(serverUrl: string, authToken: string): void {
  const pluginSource = join(__dirname, "..", "hermes-plugin", "hicortex");

  if (!existsSync(pluginSource)) {
    console.log("  ⚠ Hermes plugin not found in package — skipping Hermes setup");
    return;
  }

  const pluginsDir = join(HERMES_HOME, "plugins", "hicortex");
  mkdirSync(pluginsDir, { recursive: true });

  // Copy plugin files
  const pluginFiles = readdirSync(pluginSource);
  for (const f of pluginFiles) {
    const src = join(pluginSource, f);
    if (statSync(src).isFile()) {
      copyFileSync(src, join(pluginsDir, f));
    }
  }
  console.log(`  ✓ Copied Hermes plugin to ${pluginsDir}`);

  // Write plugin config.json (server URL only). The auth token is a SECRET and
  // is deliberately NOT written here — `hermes memory setup` routes it to
  // $HERMES_HOME/.env, and localhost bypasses auth entirely. Capture threshold
  // omitted → the plugin's own default applies.
  const config: Record<string, unknown> = { hicortex_url: serverUrl };
  const configPath = join(pluginsDir, "config.json");
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log(`  ✓ Plugin config → ${serverUrl}`);

  // For profile-based setups, symlink the shared plugin into each profile's
  // plugin dir (non-destructive). Discovery scans $HERMES_HOME/plugins/, so
  // this is belt-and-suspenders for profile-scoped installs.
  const profilesDir = join(HERMES_HOME, "profiles");
  if (existsSync(profilesDir)) {
    let profiles: string[] = [];
    try {
      profiles = readdirSync(profilesDir).filter((d: string) => {
        try { return statSync(join(profilesDir, d)).isDirectory() && !d.startsWith("_") && !d.startsWith("."); } catch { return false; }
      });
    } catch { /* no profiles dir readable */ }

    for (const profile of profiles) {
      const profPluginsDir = join(profilesDir, profile, "plugins");
      const symlinkPath = join(profPluginsDir, "hicortex");
      mkdirSync(profPluginsDir, { recursive: true });
      try { rmSync(symlinkPath, { recursive: true, force: true }); } catch { /* not present */ }
      try {
        symlinkSync(pluginsDir, symlinkPath);
      } catch (e) {
        console.log(`  ⚠ Symlink failed for ${profile} (${e instanceof Error ? e.message : e}) — copy manually if needed`);
      }
    }
  }

  // Activation is left to Hermes' own tooling. We NEVER edit config.yaml —
  // Hermes' `memory setup` discovers this plugin automatically and writes the
  // config with its own YAML-aware writer (routing the token to .env).
  const isRemote = !(serverUrl.includes("127.0.0.1") || serverUrl.includes("localhost"));
  console.log("  → Activate with:  hermes memory setup   (select 'hicortex')");
  if (existsSync(profilesDir)) {
    console.log("    Run once per profile if you use Hermes profiles.");
  }
  if (isRemote) {
    console.log("    Remote server: enter the auth token when prompted (stored in $HERMES_HOME/.env).");
  }
}

/**
 * Parse a KEY=VALUE env file (e.g. ~/.hermes/.env or ~/.claude/settings.json env block).
 * Handles: comments (#), quoted values, empty lines.
 * Exported for testability.
 */
export function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    if (!key) continue;
    let value = line.slice(eqIdx + 1).trim();
    // Strip matching surrounding quotes (single or double)
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

/**
 * Read LLM config from OC's openclaw.json + auth-profiles.json.
 */
function readOcLlmConfig(): { apiKey: string; baseUrl: string; provider: string; model?: string } | null {
  try {
    // Read primary model from openclaw.json
    const ocRaw = readFileSync(OC_CONFIG, "utf-8");
    const oc = JSON.parse(ocRaw);
    const primary = oc?.agents?.defaults?.model?.primary;
    if (!primary || typeof primary !== "string") return null;

    const [providerHint, ...rest] = primary.includes("/") ? primary.split("/") : primary.split(":");
    const model = rest.join("/") || undefined;

    // Read base URL from providers config
    const baseUrl = oc?.models?.providers?.[providerHint]?.baseUrl;

    // Read API key from auth-profiles
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const agentsDir = join(homedir(), ".openclaw", "agents");
    let apiKey: string | undefined;
    try {
      for (const agentId of readdirSync(agentsDir)) {
        try {
          const authPath = join(agentsDir, agentId, "agent", "auth-profiles.json");
          const auth = JSON.parse(readFileSync(authPath, "utf-8"));
          for (const [profileId, profile] of Object.entries(auth?.profiles ?? {})) {
            const p = profile as Record<string, unknown>;
            if (p?.provider === providerHint || profileId.startsWith(`${providerHint}:`)) {
              if (p?.key) { apiKey = p.key as string; break; }
            }
          }
          if (apiKey) break;
        } catch { /* skip */ }
      }
    } catch { /* no agents dir */ }

    if (!apiKey || !baseUrl) return null;

    return { apiKey, baseUrl, provider: providerHint, model };
  } catch {
    return null;
  }
}

/** Detected API key candidate: value + source labels (for dedup). */
interface ApiKeyCandidate {
  key: string;
  baseUrl: string;
  provider: string;
  sources: string[];
  /** Optional model name parsed from the source. */
  model?: string;
}

/** Merge candidates by (key, provider) — concatenate source labels. */
function mergeByKey(candidates: ApiKeyCandidate[]): ApiKeyCandidate[] {
  const seen = new Map<string, ApiKeyCandidate>();
  for (const c of candidates) {
    const dedupeKey = `${c.provider}::${c.key}`;
    const existing = seen.get(dedupeKey);
    if (existing) {
      for (const s of c.sources) {
        if (!existing.sources.includes(s)) existing.sources.push(s);
      }
    } else {
      seen.set(dedupeKey, { ...c, sources: [...c.sources] });
    }
  }
  return [...seen.values()];
}

/**
 * Detect or ask for LLM config and persist to ~/.hicortex/config.json.
 * The daemon can't inherit shell env vars, so we persist here.
 * LLM choice is always user-controlled: candidates are detected and presented
 * as a numbered list; the user picks one. Nothing is auto-applied.
 * If the user cancels, the server runs recall-only (no LLM).
 */
async function persistLlmConfig(): Promise<void> {
  const configPath = join(HICORTEX_HOME, "config.json");

  // Read existing config (may have licenseKey)
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch { /* new file */ }

  // Don't overwrite if LLM config already persisted
  if (config.llmBackend || (config.llmApiKey && config.llmBaseUrl)) {
    console.log(`  ✓ LLM config already configured`);
    return;
  }

  // -------------------------------------------------------------------------
  // Detect candidates from all harnesses on this machine
  // -------------------------------------------------------------------------
  const { findClaudeBinary } = await import("./llm.js");

  type Option = { label: string; save: () => Promise<void> | void; recommended?: boolean };
  const options: Option[] = [];

  // 1. Ollama local models (LOCAL)
  const ollamaModels = detectOllamaModels();
  if (ollamaModels.length > 0) {
    const best = ollamaModels[0]; // already sorted by size desc
    const goodEnough = best.sizeGb >= 7;
    options.push({
      label: `Ollama ${best.name} (local${best.sizeGb ? `, ${best.sizeGb}GB` : ""}${goodEnough ? "" : ", small model"}) [LOCAL]`,
      recommended: goodEnough,
      save: () => {
        config.llmBackend = "ollama";
        config.llmBaseUrl = "http://localhost:11434";
        config.llmModel = best.name;
        saveConfig(configPath, config);
      },
    });
    for (const m of ollamaModels.slice(1, 3)) {
      options.push({
        label: `Ollama ${m.name} (local${m.sizeGb ? `, ${m.sizeGb}GB` : ""}) [LOCAL]`,
        save: () => {
          config.llmBackend = "ollama";
          config.llmBaseUrl = "http://localhost:11434";
          config.llmModel = m.name;
          saveConfig(configPath, config);
        },
      });
    }
  }

  // 2. Claude CLI binary (CLOUD — subscription)
  const claudePath = findClaudeBinary();
  if (claudePath) {
    options.push({
      label: `Claude CLI — ${claudePath} (subscription, cloud)`,
      recommended: ollamaModels.length === 0,
      save: () => {
        config.llmBackend = "claude-cli";
        saveConfig(configPath, config);
      },
    });
  }

  // 3. API key candidates: collect from all harness sources, then dedup.
  const apiKeyCandidates: ApiKeyCandidate[] = [];

  // Helper: note a detected key from a given source
  function noteKey(
    key: string | undefined,
    provider: string,
    baseUrl: string,
    sourceLabel: string,
    model?: string
  ): void {
    if (!key) return;
    apiKeyCandidates.push({ key, provider, baseUrl, sources: [sourceLabel], model });
  }

  // Process env vars (detection only — not silent defaults)
  const envProviders: Array<{
    envKey: string; provider: string; baseUrlEnv?: string; defaultBaseUrl: string
  }> = [
    { envKey: "ANTHROPIC_API_KEY", provider: "anthropic", baseUrlEnv: "ANTHROPIC_BASE_URL", defaultBaseUrl: "https://api.anthropic.com" },
    { envKey: "OPENAI_API_KEY",    provider: "openai",    baseUrlEnv: "OPENAI_BASE_URL",    defaultBaseUrl: "https://api.openai.com" },
    { envKey: "GOOGLE_API_KEY",    provider: "google",    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta" },
  ];
  for (const ep of envProviders) {
    const val = process.env[ep.envKey];
    if (val) {
      const baseUrl = (ep.baseUrlEnv ? process.env[ep.baseUrlEnv] : undefined) ?? ep.defaultBaseUrl;
      noteKey(val, ep.provider, baseUrl, "from environment, cloud");
    }
  }

  // Hermes .env file (read-only parsing, no editing)
  try {
    const hermesEnvPath = join(HERMES_HOME, ".env");
    const hermesEnvContent = readFileSync(hermesEnvPath, "utf-8");
    const hermesEnv = parseEnvFile(hermesEnvContent);
    const openaiBase = hermesEnv["OPENAI_BASE_URL"];
    for (const ep of envProviders) {
      const val = hermesEnv[ep.envKey];
      if (val) {
        const baseUrl = (ep.baseUrlEnv && hermesEnv[ep.baseUrlEnv])
          ? hermesEnv[ep.baseUrlEnv]
          : (openaiBase && ep.provider === "openai" ? openaiBase : ep.defaultBaseUrl);
        noteKey(val, ep.provider, baseUrl, "detected in Hermes .env, cloud");
      }
    }
  } catch { /* no Hermes .env or unreadable — skip */ }

  // Claude Code settings.json env block (read-only parsing)
  try {
    const ccSettings = JSON.parse(readFileSync(CC_SETTINGS, "utf-8"));
    const ccEnv = ccSettings?.env ?? {};
    for (const ep of envProviders) {
      const val = ccEnv[ep.envKey];
      if (typeof val === "string" && val) {
        const baseUrl = (ep.baseUrlEnv && typeof ccEnv[ep.baseUrlEnv] === "string")
          ? ccEnv[ep.baseUrlEnv]
          : ep.defaultBaseUrl;
        noteKey(val, ep.provider, baseUrl, "detected in Claude Code settings, cloud");
      }
    }
  } catch { /* no CC settings or unreadable — skip */ }

  // OpenClaw auth-profiles (existing helper)
  const ocLlm = readOcLlmConfig();
  if (ocLlm) {
    noteKey(ocLlm.apiKey, ocLlm.provider, ocLlm.baseUrl, "detected in OpenClaw config, cloud", ocLlm.model);
  }

  // Deduplicate by (provider, key) and build options
  for (const candidate of mergeByKey(apiKeyCandidates)) {
    const sourceStr = candidate.sources.join(", ");
    const modelStr = candidate.model ? ` — ${candidate.model}` : "";
    options.push({
      label: `${candidate.provider}${modelStr} (${sourceStr})`,
      save: () => {
        config.llmApiKey = candidate.key;
        config.llmBaseUrl = candidate.baseUrl;
        config.llmProvider = candidate.provider;
        if (candidate.model) config.llmModel = candidate.model;
        saveConfig(configPath, config);
      },
    });
  }

  // 4. Manual entry (always available)
  options.push({
    label: "Enter provider manually (API key required)",
    save: async () => {
      console.log("\n  Providers: Anthropic, OpenAI, Google, OpenRouter, or any OpenAI-compatible endpoint");
      const baseUrl = await ask("  Provider base URL: ");
      if (!baseUrl) {
        console.log("  Cancelled — server will run recall-only until you re-run init.");
        return;
      }
      const apiKey = await ask("  API key: ");
      if (!apiKey) {
        console.log("  Cancelled — server will run recall-only until you re-run init.");
        return;
      }
      const model = await ask("  Model name (optional): ");
      config.llmApiKey = apiKey;
      config.llmBaseUrl = baseUrl;
      if (model) config.llmModel = model;
      saveConfig(configPath, config);
    },
  });

  // 5. Skip / recall-only (always available)
  options.push({
    label: "Skip — run recall-only for now (configure later with: npx @gamaze/hicortex init)",
    save: () => {
      // Intentionally leave no LLM config — server starts recall-only.
    },
  });

  // -------------------------------------------------------------------------
  // Always prompt — never auto-apply even if exactly one candidate detected
  // -------------------------------------------------------------------------

  // Non-interactive stdin (piped/scripted init): a readline EOF resolves as ""
  // and would silently select the recommended default — an auto-apply. LLM
  // choice is user-controlled by design: skip instead.
  if (!process.stdin.isTTY) {
    console.log(
      "  ⚠ Non-interactive stdin — skipping LLM selection (user-controlled by design).\n" +
      "    The server runs recall-only until you configure an LLM: re-run `hicortex init`\n" +
      "    interactively, or set llmBackend/llmBaseUrl/llmApiKey in ~/.hicortex/config.json.",
    );
    return;
  }

  const recommendedIdx = options.findIndex(o => o.recommended);
  const defaultIdx = recommendedIdx >= 0 ? recommendedIdx : 0;

  console.log("\n  LLM for nightly distillation and consolidation:\n");
  if (options.length === 2) {
    // Only "manual" and "skip" — nothing detected
    console.log("  No LLM detected automatically on this machine.");
  }
  for (let i = 0; i < options.length; i++) {
    const marker = i === defaultIdx ? " (recommended)" : "";
    console.log(`    ${i + 1}. ${options[i].label}${marker}`);
  }

  const choice = await ask(`\n  Choice [${defaultIdx + 1}]: `);
  const selectedIdx = choice.trim() ? parseInt(choice.trim(), 10) - 1 : defaultIdx;

  if (isNaN(selectedIdx) || selectedIdx < 0 || selectedIdx >= options.length) {
    console.log("  Invalid choice — server will run recall-only until you re-run init.");
    return;
  }

  await options[selectedIdx].save();

  const selectedLabel = options[selectedIdx].label;
  if (selectedLabel.startsWith("Skip")) {
    console.log(
      "  No LLM configured — server will run recall-only (search/lessons/context work).\n" +
      "  To enable capture and consolidation later, run: npx @gamaze/hicortex init"
    );
  } else {
    console.log(`  ✓ LLM configured: ${selectedLabel}`);
  }
}

function detectOllamaModels(): Array<{ name: string; sizeGb: number }> {
  try {
    const resp = execSync("curl -s --max-time 2 http://localhost:11434/api/tags", {
      encoding: "utf-8",
      timeout: 3000,
    });
    const data = JSON.parse(resp);
    const models = (data.models ?? [])
      .filter((m: any) => !m.name.includes("embed")) // skip embedding models
      .map((m: any) => ({
        name: m.name as string,
        sizeGb: Math.round((m.size ?? 0) / 1e9 * 10) / 10,
      }))
      .sort((a: any, b: any) => b.sizeGb - a.sizeGb); // largest first
    return models;
  } catch {
    return [];
  }
}

function saveConfig(configPath: string, config: Record<string, unknown>): void {
  mkdirSync(HICORTEX_HOME, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2));
}

/**
 * Generate a random auth token in the format hctx-<32 hex chars>.
 * Exported for testability.
 */
export function generateAuthToken(): string {
  return `hctx-${randomBytes(16).toString("hex")}`;
}

/**
 * Ensure a server-mode auth token exists in config.json.
 * Generates and saves one if absent. Never overwrites an existing token.
 * Returns the token (existing or newly generated).
 * Exported for testability.
 */
export function persistAuthToken(configPath: string): { token: string; generated: boolean } {
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch { /* new file */ }

  if (config.authToken && typeof config.authToken === "string") {
    return { token: config.authToken, generated: false };
  }

  const token = generateAuthToken();
  config.authToken = token;
  mkdirSync(HICORTEX_HOME, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  return { token, generated: true };
}

/**
 * Generic default memory domains scaffolded by server-mode init (issue #150).
 * Deliberately broad, high-level spheres — an editable STARTING POINT, not a
 * taxonomy. Users narrow or replace them to match how THEY think (life areas
 * or project/topic areas both work). There is NO fallback category: a no-fit
 * memory is handled automatically by the weak-primary floor + decay lifecycle
 * (see nofit.ts) — never by a catch-all domain.
 */
export const GENERIC_DEFAULT_DOMAINS: DomainDef[] = [
  { name: "Work", description: "Your job and professional life — employer, clients, workstreams" },
  { name: "Personal", description: "Private life — home, hobbies, everyday matters" },
  { name: "People", description: "Relationships — family, friends, social life, network" },
  { name: "Health", description: "Fitness, wellbeing, medical" },
  { name: "Finance", description: "Money — budgeting, spending, investing" },
];

/**
 * Scaffold the generic default `domains` list into config.json (server mode).
 *
 * Non-clobber (same philosophy as persistAuthToken): only writes when the
 * config has NO `domains` key at all. An existing key — even an empty array —
 * is user-owned and is never touched. Upgrading installs that re-run init get
 * the scaffold too (they have no `domains` key yet); installs that never
 * re-run init keep the legacy project-grouping behaviour.
 *
 * Prints its own hint lines (tested); returns whether it wrote the scaffold.
 * Exported for testability.
 */
export function scaffoldDefaultDomains(configPath: string): { scaffolded: boolean } {
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch { /* new file */ }

  if ("domains" in config) {
    console.log("  ✓ Memory domains already configured — leaving your list as-is");
    return { scaffolded: false };
  }

  config.domains = GENERIC_DEFAULT_DOMAINS;
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  const names = GENERIC_DEFAULT_DOMAINS.map((d) => d.name).join(", ");
  console.log(`  ✓ Memory domains scaffolded in ${configPath}`);
  console.log(`    Defaults: ${names}. Edit the \`domains\` list to match how YOU think —`);
  console.log(`    they can be life areas OR project/topic areas (see domains.example.json in the package).`);
  return { scaffolded: true };
}

/**
 * Determine the npm package specifier for the daemon.
 * Uses tag-based resolution so restarts pick up new versions automatically.
 *
 * Checks if the current version matches the npm `latest` tag.
 * If not (e.g. running from @next), uses @gamaze/hicortex@next.
 * If it does match latest, uses bare @gamaze/hicortex.
 */
function getPackageSpec(): string {
  try {
    const currentVersion = JSON.parse(
      readFileSync(join(__dirname, "..", "package.json"), "utf-8")
    ).version;
    const latestVersion = execSync("npm view @gamaze/hicortex version 2>/dev/null", {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    if (currentVersion !== latestVersion) {
      return "@gamaze/hicortex@next";
    }
  } catch { /* can't check — default to bare */ }
  return "@gamaze/hicortex";
}

function installDaemon(): boolean {
  const os = platform();
  const binaryArgs = resolveBinaryArgs();

  if (os === "darwin") {
    return installLaunchd(binaryArgs);
  } else if (os === "linux") {
    return installSystemd(binaryArgs);
  } else {
    console.log(`  ⚠ Unsupported platform: ${os}. Start the server manually: ${[...binaryArgs, "server"].join(" ")}`);
    return false;
  }
}

function findNpxPath(): string {
  try {
    return execSync("which npx", { encoding: "utf-8" }).trim();
  } catch {
    return "/usr/local/bin/npx";
  }
}

/**
 * Resolve the absolute path of the hicortex binary.
 * For global npm installs (e.g. /usr/bin/hicortex) this is the binary itself.
 * For dev/npx installs, falls back to `npx <packageSpec> <command>` form.
 * Returns an array: [binaryPath] for global, or [npxPath, "-y", packageSpec] for npx.
 */
function resolveBinaryArgs(): string[] {
  try {
    const bin = execSync("which hicortex", { encoding: "utf-8" }).trim();
    if (bin) return [bin];
  } catch { /* not in PATH as a global binary */ }
  const npxPath = findNpxPath();
  const packageSpec = getPackageSpec();
  return [npxPath, "-y", packageSpec];
}

/**
 * Install (or verify) the CC SessionStart hook that runs `hicortex lessons-context`.
 * The hook fetches lessons from the configured server at session start and injects
 * them as context — replacing the old static CLAUDE.md block.
 *
 * Idempotent: skips if a SessionStart hook containing "lessons-context" already exists.
 * Uses JSON.parse/JSON.stringify to safely merge into ~/.claude/settings.json.
 *
 * @param settingsPath Override for the settings.json path (used in tests; defaults to CC_SETTINGS).
 */
export function installSessionStartHook(settingsPath?: string): void {
  const targetPath = settingsPath ?? CC_SETTINGS;
  const binaryArgs = resolveBinaryArgs();
  // Build the command string: "/path/to/hicortex lessons-context" or "npx -y @gamaze/hicortex lessons-context"
  const command = [...binaryArgs, "lessons-context"].join(" ");

  let settings: Record<string, unknown> = {};
  if (existsSync(targetPath)) {
    try {
      settings = JSON.parse(readFileSync(targetPath, "utf-8"));
    } catch {
      // File exists but is malformed — do NOT overwrite (would destroy the user's entire CC config).
      console.log(`  ⚠ ${targetPath} exists but is not valid JSON — skipping SessionStart hook.`);
      console.log(`    Fix the file, then re-run init, or add the hook manually:`);
      console.log(`    command: "${command}"`);
      return;
    }
  }

  // Ensure hooks object and SessionStart array exist
  if (!settings.hooks || typeof settings.hooks !== "object") {
    settings.hooks = {};
  }
  const hooks = settings.hooks as Record<string, unknown>;
  if (!Array.isArray(hooks.SessionStart)) {
    hooks.SessionStart = [];
  }
  const sessionStart = hooks.SessionStart as Array<unknown>;

  // Idempotent: skip if any existing entry's command contains "lessons-context"
  const alreadyInstalled = sessionStart.some((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    const e = entry as Record<string, unknown>;
    // CC hook format: { hooks: [{ type: "command", command: "..." }] }
    if (Array.isArray(e.hooks)) {
      return e.hooks.some((h: unknown) => {
        if (typeof h !== "object" || h === null) return false;
        const hook = h as Record<string, unknown>;
        return typeof hook.command === "string" && hook.command.includes("lessons-context");
      });
    }
    return false;
  });

  if (alreadyInstalled) {
    console.log(`  ✓ SessionStart hook already installed`);
    return;
  }

  sessionStart.push({
    hooks: [{ type: "command", command, timeout: 10 }],
  });

  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, JSON.stringify(settings, null, 2));
  console.log(`  ✓ Installed SessionStart hook: ${command}`);
}

function installLaunchd(binaryArgs: string[]): boolean {
  const plistDir = join(homedir(), "Library", "LaunchAgents");
  const plistPath = join(plistDir, "com.gamaze.hicortex.plist");
  const logPath = join(HICORTEX_HOME, "server.log");
  const errLogPath = join(HICORTEX_HOME, "server-err.log");

  // Build ProgramArguments as individual <string> elements.
  const programArgs = [...binaryArgs, "server"]
    .map((a) => `    <string>${a}</string>`)
    .join("\n");

  // PATH must start with the binary's own directory so the sibling node
  // binary (correct version for nvm installs) is found first.
  // launchd has no PATH by default; without this, node itself won't be found.
  const binDir = dirname(binaryArgs[0]);

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.gamaze.hicortex</string>
  <key>ProgramArguments</key>
  <array>
${programArgs}
  </array>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${errLogPath}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${binDir}:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>`;

  mkdirSync(plistDir, { recursive: true });
  mkdirSync(HICORTEX_HOME, { recursive: true });
  writeFileSync(plistPath, plist);

  try {
    // Unload first if already loaded (idempotent)
    try { execSync(`launchctl unload ${plistPath} 2>/dev/null`); } catch { /* not loaded */ }
    execSync(`launchctl load ${plistPath}`);
    console.log(`  ✓ Installed launchd daemon: ${plistPath}`);
    return true;
  } catch (err) {
    console.error(`  ✗ Failed to load launchd plist: ${err}`);
    return false;
  }
}

function installSystemd(binaryArgs: string[]): boolean {
  const unitDir = join(homedir(), ".config", "systemd", "user");
  const servicePath = join(unitDir, "hicortex.service");

  const execStart = [...binaryArgs, "server"].join(" ");
  // PATH must start with the binary's own directory (see installLaunchd for rationale).
  const binDir = dirname(binaryArgs[0]);

  const service = `[Unit]
Description=Hicortex MCP server — long-term memory for AI agents

[Service]
Type=simple
ExecStart=${execStart}
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
Environment=PATH=${binDir}:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
`;

  mkdirSync(unitDir, { recursive: true });
  writeFileSync(servicePath, service);

  try {
    execSync("systemctl --user daemon-reload");
    execSync("systemctl --user enable --now hicortex.service");
    console.log(`  ✓ Installed systemd service: ${servicePath}`);
    return true;
  } catch (err) {
    console.error(`  ✗ Failed to enable systemd service: ${err}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Interactive prompt
// ---------------------------------------------------------------------------

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runInit(options: { serverUrl?: string } = {}): Promise<void> {
  if (options.serverUrl) {
    await runClientInit(options.serverUrl);
    return;
  }

  console.log("Hicortex — Setup for Claude Code\n");

  // Phase 1: Detect
  console.log("Detecting existing setup...\n");
  const d = await detect();

  // Phase 2: Report
  console.log("Found:");
  if (d.localServer) console.log(`  • Local server running at ${d.localServerUrl} (${d.memoryCount ?? "?"} memories)`);
  if (d.remoteServer) console.log(`  • Remote server at ${d.remoteServerUrl} (${d.memoryCount ?? "?"} memories)`);
  if (d.ocPlugin) console.log("  • OpenClaw plugin installed");
  if (d.hermesFound) console.log(`  • Hermes found at ${HERMES_HOME}`);
  if (d.ccMcpRegistered) console.log("  • CC MCP already registered");
  if (d.existingDb) console.log(`  • Database at ${d.dbPath}`);
  if (!d.localServer && !d.remoteServer && !d.ocPlugin && !d.existingDb) {
    console.log("  • Fresh install (no existing Hicortex found)");
  }
  console.log();

  // Determine server URL
  let serverUrl: string;

  if (d.localServer) {
    serverUrl = d.localServerUrl!;
    console.log(`Using existing local server at ${serverUrl}`);
  } else if (d.remoteServer) {
    serverUrl = d.remoteServerUrl!;
    console.log(`Using remote server at ${serverUrl}`);
  } else {
    serverUrl = `http://127.0.0.1:${DEFAULT_PORT}`;
    console.log("No running server found. Will install a local daemon.");
  }
  console.log();

  // Phase 2.5: Actions summary
  const actions: string[] = [];
  if (!d.localServer && !d.remoteServer) actions.push("Install Hicortex server daemon");
  if (!d.ccMcpRegistered) actions.push("Register MCP server in CC settings");
  if (d.hermesFound) actions.push("Install Hermes plugin + configure");
  actions.push("Install /learn and /hicortex-activate commands");
  actions.push("Install SessionStart hook (query-time lessons)");

  if (actions.length === 0) {
    console.log("Everything is already configured. Nothing to do.");
    return;
  }

  console.log("Actions:");
  actions.forEach((a) => console.log(`  - ${a}`));
  console.log();

  const answer = await ask("Continue? [Y/n] ");
  if (answer.toLowerCase() === "n") {
    console.log("Cancelled.");
    return;
  }

  console.log();

  // Phase 3: Execute
  // Persist LLM config for the daemon
  await persistLlmConfig();

  // Generate and persist auth token (upgrade-safe: never overwrites existing token).
  const configPath = join(HICORTEX_HOME, "config.json");
  const { token: authToken, generated: tokenGenerated } = persistAuthToken(configPath);
  if (tokenGenerated) {
    console.log(`\n  Auth token for clients: ${authToken}`);
    console.log(`  (stored in ~/.hicortex/config.json — also shown by \`hicortex status\`)\n`);
  } else {
    console.log(`  ✓ Auth token already configured`);
  }

  // Scaffold the generic default memory domains (server mode only — domains
  // live in the server's config; a client's memories are classified by the
  // server). Non-clobber: an existing `domains` key is never touched.
  // Classification activates automatically once an LLM is configured; until
  // then domains sit inert (strict-skip path).
  scaffoldDefaultDomains(configPath);

  // Install the nightly job (capture via localhost /distill + consolidation).
  // Without it a server-mode install never captures or consolidates — the
  // daemon only serves recall + /distill. Skips if a schedule already exists.
  installNightlyCron(resolveNightlyHour("server"));

  // Install daemon if needed
  if (!d.localServer && !d.remoteServer) {
    installDaemon();
    // Give daemon a moment to start
    console.log("  ⏳ Waiting for server to start...");
    await new Promise((r) => setTimeout(r, 5000));

    // Verify
    try {
      const resp = await fetch(`${serverUrl}/health`, { signal: AbortSignal.timeout(3000) });
      if (resp.ok) {
        console.log("  ✓ Server is running");
      } else {
        console.log("  ⚠ Server started but health check returned non-200. Check logs at ~/.hicortex/server.log");
      }
    } catch {
      console.log("  ⚠ Server may still be starting. Check: curl http://127.0.0.1:8787/health");
    }
  }

  // Register MCP
  if (!d.ccMcpRegistered) {
    registerCcMcp(serverUrl);
  }

  // Ensure tool permissions are set (also needed for users upgrading from older versions)
  allowHicortexTools();

  // Install CC commands
  installCcCommands();

  // Setup Hermes if detected
  if (d.hermesFound) {
    // localhost bypass makes the token optional for co-located installs;
    // pass it for remote setups so setupHermes can include it in its instructions.
    const isLocal = serverUrl.includes("127.0.0.1") || serverUrl.includes("localhost");
    setupHermes(serverUrl, isLocal ? "" : authToken);
  }

  // Install CC SessionStart hook for query-time lesson injection.
  // Lessons are now fetched live at session start — no static CLAUDE.md block needed.
  installSessionStartHook();

  // Strip the old static lessons block from CLAUDE.md (0.9.0 migration).
  // Lessons are now delivered via the SessionStart hook instead.
  const claudeMdPath = join(homedir(), ".claude", "CLAUDE.md");
  if (removeLessonsBlock(claudeMdPath)) {
    console.log(`  ✓ Removed old static lessons block from ${claudeMdPath} — lessons now injected at session start`);
  }

  console.log("\n✓ Hicortex setup complete!\n");
  console.log("Next steps:");
  console.log("  1. Restart Claude Code to pick up the new MCP server and SessionStart hook");
  if (d.hermesFound) {
    console.log("  2. Activate the Hermes plugin: run `hermes memory setup`, select 'hicortex', then restart the gateway(s)");
  }
  console.log("  3. Ask your agent: 'What Hicortex tools do you have?'");
  console.log("  4. Try /learn to save something to long-term memory");
  console.log(`  5. Check server: curl ${serverUrl}/health`);
}

// ---------------------------------------------------------------------------
// Client Mode Init
// ---------------------------------------------------------------------------

async function runClientInit(serverUrl: string): Promise<void> {
  console.log("Hicortex — Client Mode Setup\n");
  serverUrl = serverUrl.replace(/\/+$/, "");

  // Step 1: Verify server is reachable
  console.log(`Checking server at ${serverUrl}...`);
  try {
    const resp = await fetch(`${serverUrl}/health`, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const info = await resp.json() as Record<string, unknown>;
    console.log(`  ✓ Server: v${info.version}, ${info.memories} memories, LLM: ${info.llm}`);
  } catch (err) {
    console.error(`  ✗ Cannot reach server at ${serverUrl}`);
    console.error(`    ${err instanceof Error ? err.message : String(err)}`);
    console.error(`\n  Make sure the Hicortex server is running and accessible.`);
    process.exit(1);
  }

  // Step 2: Auth — probe with no token; if 401, ask the user.
  // The server's token is shown by `hicortex status` on the server box,
  // or readable from ~/.hicortex/config.json on that machine.
  let authToken = "";

  try {
    const probe = await fetch(`${serverUrl}/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "" }),
      signal: AbortSignal.timeout(5000),
    });
    if (probe.status === 401) {
      // Server requires a token — ask the user where to get it
      console.log("\n  Server requires an auth token.");
      console.log("  Find it on the server: run `hicortex status`, or read ~/.hicortex/config.json");
      const tokenAnswer = await ask("  Enter token: ");
      authToken = tokenAnswer.trim();
      if (!authToken) {
        console.error("  ✗ Auth token required but not provided.");
        process.exit(1);
      }
      // Verify
      const verify = await fetch(`${serverUrl}/ingest`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${authToken}`,
        },
        body: JSON.stringify({ content: "" }),
        signal: AbortSignal.timeout(5000),
      });
      if (verify.status === 401) {
        console.error("  ✗ Auth token rejected by server.");
        process.exit(1);
      }
      console.log("  ✓ Auth token verified");
    } else {
      console.log("  ✓ Server connected (no auth required from localhost)");
    }
  } catch {
    // Probe failed but health passed — continue without token
  }

  // Client mode needs no LLM — capture is denoise-only; the server distills.

  // Step 3: Save client config
  mkdirSync(HICORTEX_HOME, { recursive: true });
  const configPath = join(HICORTEX_HOME, "config.json");
  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch {
      console.log(`  ⚠ ${configPath} exists but is not valid JSON — starting with empty config (licenseKey and LLM settings may need to be re-entered).`);
    }
  }

  config.mode = "client";
  config.serverUrl = serverUrl;
  if (authToken) config.authToken = authToken;

  saveConfig(configPath, config);
  console.log(`  ✓ Client config saved to ${configPath}`);

  // Step 4: Register CC MCP pointing to remote server
  if (authToken) {
    // Write directly with auth header
    const claudeJsonPath = join(homedir(), ".claude.json");
    let claudeConfig: Record<string, unknown> = {};
    let claudeJsonOk = true;
    if (existsSync(claudeJsonPath)) {
      try {
        claudeConfig = JSON.parse(readFileSync(claudeJsonPath, "utf-8"));
      } catch {
        console.log(`  ⚠ ${claudeJsonPath} exists but is not valid JSON — skipping MCP registration. Fix the file, then re-run init or run: claude mcp add hicortex --transport sse ${serverUrl}/sse`);
        claudeJsonOk = false;
      }
    }
    if (claudeJsonOk) {
      if (!claudeConfig.mcpServers) claudeConfig.mcpServers = {};
      (claudeConfig.mcpServers as Record<string, unknown>).hicortex = {
        type: "sse",
        url: `${serverUrl}/sse`,
        headers: { "Authorization": `Bearer ${authToken}` },
      };
      writeFileSync(claudeJsonPath, JSON.stringify(claudeConfig, null, 2));
      console.log(`  ✓ Registered MCP server with auth`);
    }
  } else {
    registerCcMcp(serverUrl);
  }
  allowHicortexTools();

  // Step 5: Install CC commands
  installCcCommands();

  // Step 6: Install SessionStart hook for query-time lessons.
  installSessionStartHook();

  // Strip the old static CLAUDE.md lessons block if present (0.9.0 migration).
  const claudeMdPath = join(homedir(), ".claude", "CLAUDE.md");
  if (removeLessonsBlock(claudeMdPath)) {
    console.log(`  ✓ Removed old static lessons block from CLAUDE.md — lessons now injected at session start`);
  }

  // Step 7: Install nightly cron (denoise locally, POST to server /distill)
  installNightlyCron(resolveNightlyHour("client"));

  // Step 8: Setup Hermes if detected
  if (existsSync(HERMES_HOME)) {
    console.log("\nHermes detected — installing plugin...");
    setupHermes(serverUrl, authToken);
  }

  console.log("\n✓ Hicortex client setup complete!\n");
  console.log("How it works:");
  console.log("  • MCP tools (search, context, ingest) talk to the remote server");
  console.log("  • Nightly pipeline denoises CC transcripts, POSTs to server for distillation");
  console.log("  • Lessons fetched live at each CC session start (SessionStart hook)");
  console.log("  • No local database — all memories stored on the server");
  if (existsSync(HERMES_HOME)) {
    console.log("  • Hermes plugin installed — run `hermes memory setup` (select 'hicortex') + restart gateway(s) to activate");
  }
  console.log(`\nServer: ${serverUrl}`);
  console.log("Restart your agents to activate.");
}

/**
 * Resolve the nightly hour (0–23, local time) for the generated schedule.
 * Priority: `nightlyHour` in ~/.hicortex/config.json → mode default.
 * Defaults: client 02:00, server 03:00 — staggered so that in mixed fleets
 * clients push their sessions before the server's capture + consolidation run.
 */
export function resolveNightlyHour(mode: "server" | "client", configDir = HICORTEX_HOME): number {
  try {
    const config = JSON.parse(readFileSync(join(configDir, "config.json"), "utf-8"));
    const h = config.nightlyHour;
    if (typeof h === "number" && Number.isInteger(h) && h >= 0 && h <= 23) return h;
  } catch { /* no config yet — use the default */ }
  return mode === "server" ? 3 : 2;
}

function installNightlyCron(hour: number): void {
  const binaryArgs = resolveBinaryArgs();
  const os = platform();
  const hh = String(hour).padStart(2, "0");

  // PATH must start with the binary's own directory (see installLaunchd for rationale).
  const binDir = dirname(binaryArgs[0]);

  if (os === "darwin") {
    const plistDir = join(homedir(), "Library", "LaunchAgents");
    const plistPath = join(plistDir, "com.gamaze.hicortex-nightly.plist");
    const logPath = join(HICORTEX_HOME, "nightly.log");

    // Never overwrite an existing schedule — users tune these (multi-slot
    // capture windows, quiet hours). Fresh installs only.
    if (existsSync(plistPath)) {
      console.log(`  ✓ Nightly cron already installed — leaving existing schedule as-is`);
      return;
    }

    const programArgs = [...binaryArgs, "nightly"]
      .map((a) => `    <string>${a}</string>`)
      .join("\n");

    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.gamaze.hicortex-nightly</string>
  <key>ProgramArguments</key>
  <array>
${programArgs}
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${hour}</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${binDir}:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>`;

    mkdirSync(plistDir, { recursive: true });
    writeFileSync(plistPath, plist);
    try {
      try { execSync(`launchctl unload ${plistPath} 2>/dev/null`, { stdio: "pipe" }); } catch {}
      execSync(`launchctl load ${plistPath}`, { stdio: "pipe" });
      console.log(`  ✓ Installed nightly cron (runs daily at ${hh}:00)`);
    } catch {
      console.log(`  ⚠ Could not load nightly plist. Load manually: launchctl load ${plistPath}`);
    }
  } else if (os === "linux") {
    const configDir = join(homedir(), ".config", "systemd", "user");
    const servicePath = join(configDir, "hicortex-nightly.service");
    const timerPath = join(configDir, "hicortex-nightly.timer");

    // Never overwrite an existing schedule — users tune these. Fresh installs only.
    if (existsSync(timerPath)) {
      console.log(`  ✓ Nightly timer already installed — leaving existing schedule as-is`);
      return;
    }

    const execStart = [...binaryArgs, "nightly"].join(" ");

    const service = `[Unit]
Description=Hicortex Nightly (distill + POST)

[Service]
Type=oneshot
ExecStart=${execStart}
Environment=PATH=${binDir}:/usr/local/bin:/usr/bin:/bin
Environment=HOME=${homedir()}
WorkingDirectory=${homedir()}`;

    const timer = `[Unit]
Description=Hicortex Nightly Timer

[Timer]
OnCalendar=*-*-* ${hh}:00:00
Persistent=true

[Install]
WantedBy=timers.target`;

    mkdirSync(configDir, { recursive: true });
    writeFileSync(servicePath, service);
    writeFileSync(timerPath, timer);
    try {
      execSync("systemctl --user daemon-reload", { stdio: "pipe" });
      execSync("systemctl --user enable --now hicortex-nightly.timer", { stdio: "pipe" });
      console.log(`  ✓ Installed nightly timer (runs daily at ${hh}:00)`);
    } catch {
      console.log(`  ⚠ Could not enable nightly timer. Enable manually: systemctl --user enable --now hicortex-nightly.timer`);
    }
  }
}
