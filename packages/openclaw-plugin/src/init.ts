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
 *   - Inject CLAUDE.md learnings block
 *   - Install CC custom commands (/learn, /hicortex-activate)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, platform } from "node:os";
import { execSync } from "node:child_process";
import { createInterface } from "node:readline";

const HICORTEX_HOME = join(homedir(), ".hicortex");
const CC_SETTINGS = join(homedir(), ".claude", "settings.json");
const CC_COMMANDS_DIR = join(homedir(), ".claude", "commands");
const OC_CONFIG = join(homedir(), ".openclaw", "openclaw.json");
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
    try {
      config = JSON.parse(readFileSync(claudeJsonPath, "utf-8"));
    } catch { /* create new */ }

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
  try {
    settings = JSON.parse(readFileSync(CC_SETTINGS, "utf-8"));
  } catch { /* create new */ }

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

  // /hicortex-activate command
  const activateContent = `---
name: hicortex-activate
description: Activate a Hicortex license key for unlimited memory. Use after purchasing at hicortex.gamaze.com.
argument-hint: <license-key>
allowed-tools: Bash(mkdir:*), Bash(echo:*), Bash(launchctl:*), Bash(systemctl:*), Bash(curl:*), mcp__hicortex__hicortex_ingest, mcp__hicortex__hicortex_search, mcp__hicortex__hicortex_context, mcp__hicortex__hicortex_lessons
---

# Activate Hicortex License

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

3. Verify the server is back:
\`\`\`bash
curl -s http://127.0.0.1:8787/health
\`\`\`

4. Tell the user: "License activated! Hicortex now has unlimited memory."

## If no key provided

Tell them: "Get a license key at https://hicortex.gamaze.com/ — after purchase, you'll receive your key by email. Then tell me the key and I'll activate it."
`;
  writeFileSync(join(CC_COMMANDS_DIR, "hicortex-activate.md"), activateContent);

  console.log(`  ✓ Installed /learn and /hicortex-activate commands in ${CC_COMMANDS_DIR}`);
}

/**
 * Read LLM config from OC's openclaw.json + auth-profiles.json.
 * Used as fallback when no env vars are set (e.g. Claude Max subscription users).
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

/**
 * Detect or ask for LLM config and persist to ~/.hicortex/config.json.
 * The daemon can't inherit shell env vars, so we persist here.
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

  // Auto-detect all available LLM options
  const options: Array<{ label: string; save: () => void; recommended?: boolean }> = [];

  // 1. Check Ollama (local models — best for privacy and quality)
  const ollamaModels = detectOllamaModels();
  if (ollamaModels.length > 0) {
    // Pick the largest model — only recommend if >= 7GB (~7b+ parameter models)
    const best = ollamaModels[0]; // already sorted by size desc
    const goodEnough = best.sizeGb >= 7;
    options.push({
      label: `Ollama ${best.name} (local${best.sizeGb ? `, ${best.sizeGb}GB` : ""}${goodEnough ? "" : ", small model"})`,
      recommended: goodEnough,
      save: () => {
        config.llmBackend = "ollama";
        config.llmBaseUrl = "http://localhost:11434";
        config.llmModel = best.name;
        saveConfig(configPath, config);
      },
    });
    // Add other models if available
    for (const m of ollamaModels.slice(1, 3)) {
      options.push({
        label: `Ollama ${m.name} (local${m.sizeGb ? `, ${m.sizeGb}GB` : ""})`,
        save: () => {
          config.llmBackend = "ollama";
          config.llmBaseUrl = "http://localhost:11434";
          config.llmModel = m.name;
          saveConfig(configPath, config);
        },
      });
    }
  }

  // 2. Check Claude CLI
  const { findClaudeBinary } = await import("./llm.js");
  const claudePath = findClaudeBinary();
  if (claudePath) {
    options.push({
      label: "Claude CLI (subscription, Haiku model)",
      recommended: ollamaModels.length === 0,
      save: () => {
        config.llmBackend = "claude-cli";
        saveConfig(configPath, config);
      },
    });
  }

  // 3. Check env vars
  if (process.env.ANTHROPIC_API_KEY) {
    options.push({
      label: "Anthropic API (from ANTHROPIC_API_KEY)",
      save: () => {
        config.llmApiKey = process.env.ANTHROPIC_API_KEY;
        config.llmBaseUrl = process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com";
        config.llmProvider = "anthropic";
        saveConfig(configPath, config);
      },
    });
  }
  if (process.env.OPENAI_API_KEY) {
    options.push({
      label: "OpenAI API (from OPENAI_API_KEY)",
      save: () => {
        config.llmApiKey = process.env.OPENAI_API_KEY;
        config.llmBaseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com";
        config.llmProvider = "openai";
        saveConfig(configPath, config);
      },
    });
  }

  // 4. Check OC auth-profiles
  const ocLlm = readOcLlmConfig();
  if (ocLlm) {
    options.push({
      label: `OpenClaw (${ocLlm.provider}/${ocLlm.model ?? "default"})`,
      save: () => {
        config.llmApiKey = ocLlm.apiKey;
        config.llmBaseUrl = ocLlm.baseUrl;
        config.llmProvider = ocLlm.provider;
        if (ocLlm.model) config.llmModel = ocLlm.model;
        saveConfig(configPath, config);
      },
    });
  }

  // 5. Always offer manual entry and cancel
  options.push({
    label: "Other provider (requires API key)",
    save: async () => {
      console.log("\n  Providers: Anthropic, OpenAI, Google, OpenRouter, or any OpenAI-compatible endpoint");
      const baseUrl = await ask("  Provider base URL: ");
      if (!baseUrl) { console.log("  ⚠ Cancelled."); process.exit(0); }
      const apiKey = await ask("  API key: ");
      if (!apiKey) { console.log("  ⚠ Cancelled."); process.exit(0); }
      const model = await ask("  Model name (optional): ");
      config.llmApiKey = apiKey;
      config.llmBaseUrl = baseUrl;
      if (model) config.llmModel = model;
      saveConfig(configPath, config);
    },
  });
  options.push({
    label: "Cancel installation",
    save: () => {
      console.log("\n  Hicortex requires an LLM to function. Installation cancelled.");
      process.exit(0);
    },
  });

  // Find recommended index
  const recommendedIdx = options.findIndex(o => o.recommended);
  const defaultIdx = recommendedIdx >= 0 ? recommendedIdx : 0;

  // Display
  console.log("\n  LLM for nightly distillation:\n");
  for (let i = 0; i < options.length; i++) {
    const marker = i === defaultIdx ? " (recommended)" : "";
    console.log(`    ${i + 1}. ${options[i].label}${marker}`);
  }

  const choice = await ask(`\n  Choice [${defaultIdx + 1}]: `);
  const selected = choice ? parseInt(choice, 10) - 1 : defaultIdx;

  if (selected < 0 || selected >= options.length) {
    console.log("  Invalid choice.");
    process.exit(1);
  }

  await options[selected].save();
  console.log(`  ✓ LLM configured: ${options[selected].label}`);
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
  const npxPath = findNpxPath();
  const packageSpec = getPackageSpec();

  if (os === "darwin") {
    return installLaunchd(npxPath, packageSpec);
  } else if (os === "linux") {
    return installSystemd(npxPath, packageSpec);
  } else {
    console.log(`  ⚠ Unsupported platform: ${os}. Start the server manually: npx ${packageSpec} server`);
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

function installLaunchd(npxPath: string, packageSpec: string): boolean {
  const plistDir = join(homedir(), "Library", "LaunchAgents");
  const plistPath = join(plistDir, "com.gamaze.hicortex.plist");
  const logPath = join(HICORTEX_HOME, "server.log");
  const errLogPath = join(HICORTEX_HOME, "server-err.log");

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.gamaze.hicortex</string>
  <key>ProgramArguments</key>
  <array>
    <string>${npxPath}</string>
    <string>-y</string>
    <string>${packageSpec}</string>
    <string>server</string>
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
    <string>${dirname(npxPath)}:/usr/local/bin:/usr/bin:/bin</string>
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

function installSystemd(npxPath: string, packageSpec: string): boolean {
  const unitDir = join(homedir(), ".config", "systemd", "user");
  const servicePath = join(unitDir, "hicortex.service");

  const service = `[Unit]
Description=Hicortex MCP server — long-term memory for AI agents

[Service]
Type=simple
ExecStart=${npxPath} -y ${packageSpec} server
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
Environment=PATH=${dirname(npxPath)}:/usr/local/bin:/usr/bin:/bin

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
  actions.push("Install /learn and /hicortex-activate commands");
  actions.push("Add Hicortex Learnings block to CLAUDE.md");

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

  // Inject CLAUDE.md (only if server has a DB we can read)
  // For now, just create the block with agent guidance and no lessons
  // Lessons will populate on first nightly run
  const claudeMdPath = join(homedir(), ".claude", "CLAUDE.md");
  if (!existsSync(claudeMdPath) || !readFileSync(claudeMdPath, "utf-8").includes("HICORTEX-LEARNINGS")) {
    mkdirSync(dirname(claudeMdPath), { recursive: true });
    let content = "";
    try { content = readFileSync(claudeMdPath, "utf-8"); } catch { /* new file */ }

    const block = [
      "<!-- HICORTEX-LEARNINGS:START -->",
      "## Hicortex Memory",
      "",
      "You have access to long-term memory via Hicortex MCP tools. Use `hicortex_search` when you need context from past sessions, decisions, or prior work. Use `hicortex_context` at session start to recall recent project state. Use `hicortex_ingest` to save important decisions or learnings. Sessions are auto-captured nightly.",
      "<!-- HICORTEX-LEARNINGS:END -->",
    ].join("\n");

    if (content.length > 0 && !content.endsWith("\n")) content += "\n";
    if (content.length > 0) content += "\n";
    content += block + "\n";

    writeFileSync(claudeMdPath, content);
    console.log(`  ✓ Added Hicortex Learnings block to ${claudeMdPath}`);
  } else {
    console.log(`  ✓ CLAUDE.md already has Hicortex Learnings block`);
  }

  console.log("\n✓ Hicortex setup complete!\n");
  console.log("Next steps:");
  console.log("  1. Restart Claude Code to pick up the new MCP server");
  console.log("  2. Ask your agent: 'What Hicortex tools do you have?'");
  console.log("  3. Try /learn to save something to long-term memory");
  console.log(`  4. Check server: curl ${serverUrl}/health`);
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

  // Step 2: Auth — try default token first, prompt only if rejected
  const DEFAULT_AUTH_TOKEN = "hctx-default-token";
  let authToken: string = DEFAULT_AUTH_TOKEN;

  try {
    const probe = await fetch(`${serverUrl}/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${DEFAULT_AUTH_TOKEN}`,
      },
      body: JSON.stringify({ content: "" }),
      signal: AbortSignal.timeout(5000),
    });
    if (probe.status === 401) {
      // Server uses a custom token — ask the user
      const tokenAnswer = await ask("\nServer uses a custom auth token. Enter token: ");
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
      console.log("  ✓ Custom auth token verified");
    } else {
      console.log("  ✓ Server connected (default auth)");
    }
  } catch {
    // Probe failed but health passed — continue with default token
  }

  // Step 3: Configure LLM for local distillation
  console.log("\nConfigure LLM for local session distillation:");
  await persistLlmConfig();

  // Step 4: Save client config
  mkdirSync(HICORTEX_HOME, { recursive: true });
  const configPath = join(HICORTEX_HOME, "config.json");
  let config: Record<string, unknown> = {};
  try { config = JSON.parse(readFileSync(configPath, "utf-8")); } catch {}

  config.mode = "client";
  config.serverUrl = serverUrl;
  if (authToken) config.authToken = authToken;

  saveConfig(configPath, config);
  console.log(`  ✓ Client config saved to ${configPath}`);

  // Step 5: Register CC MCP pointing to remote server
  if (authToken) {
    // Write directly with auth header
    const claudeJsonPath = join(homedir(), ".claude.json");
    let claudeConfig: Record<string, unknown> = {};
    try { claudeConfig = JSON.parse(readFileSync(claudeJsonPath, "utf-8")); } catch {}
    if (!claudeConfig.mcpServers) claudeConfig.mcpServers = {};
    (claudeConfig.mcpServers as Record<string, unknown>).hicortex = {
      type: "sse",
      url: `${serverUrl}/sse`,
      headers: { "Authorization": `Bearer ${authToken}` },
    };
    writeFileSync(claudeJsonPath, JSON.stringify(claudeConfig, null, 2));
    console.log(`  ✓ Registered MCP server with auth`);
  } else {
    registerCcMcp(serverUrl);
  }
  allowHicortexTools();

  // Step 6: Install CC commands
  installCcCommands();

  // Step 7: Inject CLAUDE.md learnings block
  const claudeMdPath = join(homedir(), ".claude", "CLAUDE.md");
  if (!existsSync(claudeMdPath) || !readFileSync(claudeMdPath, "utf-8").includes("HICORTEX-LEARNINGS")) {
    mkdirSync(dirname(claudeMdPath), { recursive: true });
    let content = "";
    try { content = readFileSync(claudeMdPath, "utf-8"); } catch {}
    const block = [
      "<!-- HICORTEX-LEARNINGS:START -->",
      "## Hicortex Memory",
      "",
      "You have access to long-term memory via Hicortex MCP tools. Use `hicortex_search` when you need context from past sessions, decisions, or prior work. Use `hicortex_context` at session start to recall recent project state. Use `hicortex_ingest` to save important decisions or learnings. Sessions are auto-captured nightly.",
      "<!-- HICORTEX-LEARNINGS:END -->",
    ].join("\n");
    if (content.length > 0 && !content.endsWith("\n")) content += "\n";
    if (content.length > 0) content += "\n";
    content += block + "\n";
    writeFileSync(claudeMdPath, content);
    console.log(`  ✓ Added Hicortex Learnings block`);
  }

  // Step 8: Install nightly cron (distill locally, POST to server)
  installNightlyCron();

  console.log("\n✓ Hicortex client setup complete!\n");
  console.log("How it works:");
  console.log("  • MCP tools (search, context, ingest) talk to the remote server");
  console.log("  • Nightly pipeline distills CC transcripts locally, POSTs memories to server");
  console.log("  • No local database — all memories stored on the server");
  console.log(`\nServer: ${serverUrl}`);
  console.log("Restart Claude Code to activate.");
}

function installNightlyCron(): void {
  const npxPath = findNpxPath();
  const packageSpec = getPackageSpec();
  const os = platform();

  if (os === "darwin") {
    const plistDir = join(homedir(), "Library", "LaunchAgents");
    const plistPath = join(plistDir, "com.gamaze.hicortex-nightly.plist");
    const logPath = join(HICORTEX_HOME, "nightly.log");

    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.gamaze.hicortex-nightly</string>
  <key>ProgramArguments</key>
  <array>
    <string>${npxPath}</string>
    <string>-y</string>
    <string>${packageSpec}</string>
    <string>nightly</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>2</integer>
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
    <string>${dirname(npxPath)}:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>`;

    mkdirSync(plistDir, { recursive: true });
    writeFileSync(plistPath, plist);
    try {
      try { execSync(`launchctl unload ${plistPath} 2>/dev/null`, { stdio: "pipe" }); } catch {}
      execSync(`launchctl load ${plistPath}`, { stdio: "pipe" });
      console.log(`  ✓ Installed nightly cron (runs daily at 02:00)`);
    } catch {
      console.log(`  ⚠ Could not load nightly plist. Load manually: launchctl load ${plistPath}`);
    }
  } else if (os === "linux") {
    const configDir = join(homedir(), ".config", "systemd", "user");
    const servicePath = join(configDir, "hicortex-nightly.service");
    const timerPath = join(configDir, "hicortex-nightly.timer");

    const service = `[Unit]
Description=Hicortex Nightly (distill + POST)

[Service]
Type=oneshot
ExecStart=${npxPath} -y ${packageSpec} nightly
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Environment=HOME=${homedir()}
WorkingDirectory=${homedir()}`;

    const timer = `[Unit]
Description=Hicortex Nightly Timer

[Timer]
OnCalendar=*-*-* 02:00:00
Persistent=true

[Install]
WantedBy=timers.target`;

    mkdirSync(configDir, { recursive: true });
    writeFileSync(servicePath, service);
    writeFileSync(timerPath, timer);
    try {
      execSync("systemctl --user daemon-reload", { stdio: "pipe" });
      execSync("systemctl --user enable --now hicortex-nightly.timer", { stdio: "pipe" });
      console.log(`  ✓ Installed nightly timer (runs daily at 02:00)`);
    } catch {
      console.log(`  ⚠ Could not enable nightly timer. Enable manually: systemctl --user enable --now hicortex-nightly.timer`);
    }
  }
}
