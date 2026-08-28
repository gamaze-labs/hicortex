/**
 * Hicortex init — detect existing setup and configure for CC.
 *
 * Detection:
 *   1. Local HC server running (localhost:8787)
 *   2. Remote HC server (HICORTEX_SERVER_URL — any reachable host:port)
 *   3. OC plugin installed (~/.openclaw/openclaw.json)
 *   4. CC MCP already registered (~/.claude/settings.json)
 *   5. Hermes present (~/.hermes) / Pi present (~/.pi/agent) /
 *      opencode present (~/.config/opencode or ~/.local/share/opencode)
 *   6. Existing DB (~/.hicortex/ or ~/.openclaw/data/)
 *
 * Actions:
 *   - Install persistent daemon (launchd/systemd)
 *   - Register MCP server in CC settings
 *   - Install CC SessionStart hook for query-time lessons
 *   - Strip old static CLAUDE.md learnings block if present
 *   - Remove legacy pre-0.10 CC commands (/learn, /hicortex-activate) if present
 */

import { hicortexHome } from "./paths.js";
import { writeLocalhostBypassMarker } from "./localhost-bypass.js";
import { sendLifecycleEvent } from "./telemetry.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, statSync, symlinkSync, rmSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, platform } from "node:os";
import { execSync } from "node:child_process";
import { createInterface } from "node:readline";
import { randomBytes, randomUUID } from "node:crypto";
import { removeLessonsBlock } from "./claude-md.js";
import { parseHours, readNonNegativeConfig } from "./config-read.js";
import { sanitizeAgentId } from "./identity-store.js";
import type { DomainDef } from "./types.js";

const HICORTEX_HOME = hicortexHome();

/** This package's version, for the install lifecycle ping (0.15.2). */
function pkgVersion(): string {
  try {
    return JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8")).version as string;
  } catch {
    return "0.0.0";
  }
}

/** Read the just-written config so the install ping honours an opt-out. */
function readHomeConfig(home: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(join(home, "config.json"), "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}
const CC_SETTINGS = join(homedir(), ".claude", "settings.json");
const CC_COMMANDS_DIR = join(homedir(), ".claude", "commands");
const OC_CONFIG = join(homedir(), ".openclaw", "openclaw.json");
const HERMES_HOME = process.env.HERMES_HOME || join(homedir(), ".hermes");
/** Pi's agent dir — its presence means Pi is installed and will load extensions. */
const PI_AGENT_DIR = join(homedir(), ".pi", "agent");
/** opencode's config/data dirs — either present means opencode is installed. */
const OPENCODE_CONFIG_DIR = join(homedir(), ".config", "opencode");
const OPENCODE_DATA_DIR = join(homedir(), ".local", "share", "opencode");
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
  piFound: boolean;
  opencodeFound: boolean;
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
    piFound: false,
    opencodeFound: false,
    existingDb: false,
  };

  // Check local server. /health/detail carries the diagnostics (memories,
  // version, llm) — /health itself is the public minimal {status:"ok"} probe
  // (#253). localhost bypasses auth, so co-located detect gets the fields.
  try {
    const resp = await fetch(`http://127.0.0.1:${DEFAULT_PORT}/health/detail`, {
      signal: AbortSignal.timeout(2000),
    });
    if (resp.ok) {
      result.localServer = true;
      result.localServerUrl = `http://127.0.0.1:${DEFAULT_PORT}`;
      const data = await resp.json() as { memories?: number };
      result.memoryCount = data.memories;
    }
  } catch { /* not running */ }

  // Check remote server (env var). detect() runs BEFORE any config/token
  // exists, so this MUST use the PUBLIC /health probe (liveness only) —
  // /health/detail sits behind the auth middleware and would 401 on any
  // authed remote server, making a healthy remote look "unreachable" and
  // silently mis-routing the install branch (#253 CR fix). The memory count
  // is not available on the public probe; the local-server path above still
  // gets it via localhost-bypassed /health/detail.
  const remoteUrl = process.env.HICORTEX_SERVER_URL;
  if (remoteUrl && !result.localServer) {
    try {
      const resp = await fetch(`${remoteUrl}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (resp.ok) {
        result.remoteServer = true;
        result.remoteServerUrl = remoteUrl;
      }
    } catch { /* not reachable */ }
  }

  // Check Hermes
  result.hermesFound = existsSync(HERMES_HOME);

  // Check Pi (~/.pi/agent — the dir Pi loads extensions from)
  result.piFound = existsSync(PI_AGENT_DIR);

  // Check opencode (~/.config/opencode or ~/.local/share/opencode — its
  // global plugins dir / session store; it auto-loads ~/.config/opencode/plugins/)
  result.opencodeFound = existsSync(OPENCODE_CONFIG_DIR) || existsSync(OPENCODE_DATA_DIR);

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

  // Post-install verification (finding #5): a registration that wrote files
  // but didn't actually take can still look "done". Best-effort confirm and,
  // either way, tell the user exactly how to check.
  verifyCcMcp();
}

/**
 * Classify `claude mcp list` output for the hicortex entry. Pure (testable):
 *   - "missing"    — hicortex not listed → registration didn't take
 *   - "connected"  — listed AND reachable (✓/✔/Connected shown)
 *   - "registered" — listed but connection not confirmed (server down / not restarted)
 */
export function parseMcpListStatus(mcpListOutput: string): "connected" | "registered" | "missing" {
  // `claude mcp list` prints one line per server: "hicortex: <url> (SSE) - <status>".
  // Anchor on the "hicortex:" line prefix (not a bare word match) so a
  // differently-named MCP like "hicortex-foo" can't be mistaken for our entry,
  // and read status from THAT line only.
  const line = mcpListOutput.split(/\r?\n/).find((l) => /^\s*hicortex:/.test(l));
  if (!line) return "missing";
  return /(✓|✔|connected)/i.test(line) ? "connected" : "registered";
}

/**
 * Best-effort post-install check that the hicortex MCP is actually registered
 * (and, when reachable, connected). NEVER fails init — if the claude CLI is
 * absent (e.g. registration went via the ~/.claude.json fallback), we can't
 * query it, so we just tell the user how to confirm. Closes the "looks
 * configured but isn't, with no verification" gap.
 */
function verifyCcMcp(): void {
  let out: string;
  try {
    out = execSync("claude mcp list", { encoding: "utf-8", stdio: "pipe" });
  } catch {
    console.log("  ℹ After restarting Claude Code, confirm with `claude mcp list` (hicortex should show ✓ Connected).");
    return;
  }
  switch (parseMcpListStatus(out)) {
    case "connected":
      console.log("  ✓ Verified: hicortex MCP registered and connected");
      break;
    case "registered":
      console.log("  ✓ Verified: hicortex MCP registered — restart Claude Code, then `claude mcp list` should show it Connected");
      break;
    case "missing":
      console.log("  ⚠ Could NOT confirm the hicortex MCP registration — run `claude mcp list`; if it's absent, re-run init.");
      break;
  }
}

function allowHicortexTools(): void {
  // Only EDIT an existing CC settings file — never invent one. On a host with
  // no CC client (a server, or a Hermes-only box) ~/.claude/settings.json is
  // absent; creating a stub there is wrong, and the earlier mkdir+write was the
  // ENOENT throw on a host with no CC client. Without this entry CC just PROMPTS before
  // tool use instead of auto-allowing — the MCP still works either way.
  if (!existsSync(CC_SETTINGS)) {
    console.log(
      `  ℹ ${CC_SETTINGS} not found — skipping CC tool permissions (no CC client here; ` +
      `the MCP works, CC will ask before tool use).`
    );
    return;
  }
  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(readFileSync(CC_SETTINGS, "utf-8"));
  } catch {
    console.log(`  ⚠ ${CC_SETTINGS} exists but is not valid JSON — skipping tool permissions. Fix the file, then re-run init or add "mcp__hicortex__*" to permissions.allow manually.`);
    return;
  }

  if (!settings.permissions) settings.permissions = {};
  const perms = settings.permissions as Record<string, unknown>;
  if (!perms.allow) perms.allow = [];
  const allow = perms.allow as string[];

  const rule = "mcp__hicortex__*";
  if (!allow.includes(rule)) {
    allow.push(rule);
    writeFileSync(CC_SETTINGS, JSON.stringify(settings, null, 2));
    console.log(`  ✓ Added Hicortex tool permissions to ${CC_SETTINGS}`);
  }
}

function cleanupLegacyCcCommands(): void {
  // Pre-0.10 installs wrote two CC slash commands that are now RETIRED:
  //   - /learn            : manual immediate ingest. Capture has been automatic
  //                         (nightly-from-logs) since 0.9; hicortex_ingest
  //                         remains for *explicitly requested* learnings, but
  //                         no longer warrants a slash command.
  //   - /hicortex-activate : registered a commercial license key. licenseKey
  //                         gates nothing now (the per-install auth TOKEN is
  //                         the credential, auto-generated at init), so the
  //                         command is dead.
  // Remove stale copies so upgraders don't keep dead commands. Idempotent —
  // a best-effort cleanup of our own files; never throws.
  for (const name of ["learn.md", "hicortex-activate.md"]) {
    const p = join(CC_COMMANDS_DIR, name);
    if (!existsSync(p)) continue;
    // Ownership guard: only remove a file we actually wrote. `learn.md` is a
    // generic command name a user may own independently — deleting by filename
    // alone would silently destroy their file. The retired writer always
    // embedded "hicortex" (the ingest tool + prose); mirror the same marker the
    // old installer used before overwriting. Skip + warn on anything else.
    try {
      if (!readFileSync(p, "utf-8").toLowerCase().includes("hicortex")) {
        console.log(`  ⚠ Skipping ${name} in ${CC_COMMANDS_DIR} — not a Hicortex file, left untouched`);
        continue;
      }
    } catch {
      // Unreadable — do not delete blind; leave it and move on.
      continue;
    }
    try {
      rmSync(p);
      console.log(`  ✓ Removed legacy command ${name} from ${CC_COMMANDS_DIR} (retired pre-0.10)`);
    } catch (err) {
      // ENOENT = already gone (fine, idempotent). Anything else (EACCES, EBUSY)
      // is worth a line so a stuck stale file is diagnosable — but never fatal
      // to init (best-effort cleanup of our own file).
      if ((err as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
        console.log(`  ⚠ Could not remove legacy command ${name}: ${(err as Error | undefined)?.message ?? err}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Pi setup
// ---------------------------------------------------------------------------

/**
 * Install the bundled Pi extension (#348): one dependency-free .ts file Pi
 * loads from ~/.pi/agent/extensions/. Deliberately NO config write — the
 * extension self-resolves the server from ~/.hicortex/config.json (the file
 * init has already written by this point), so there is nothing to keep in
 * sync and no secret to route elsewhere. Overwrites on re-init so upgrades
 * land; skips gracefully when the bundled source is absent (e.g. a dev
 * checkout without the packaged copy).
 */
function setupPi(): void {
  const extensionSource = join(__dirname, "..", "pi-extension", "hicortex", "index.ts");

  if (!existsSync(extensionSource)) {
    console.log("  ⚠ Pi extension not found in package — skipping Pi setup");
    return;
  }

  const extensionsDir = join(PI_AGENT_DIR, "extensions");
  mkdirSync(extensionsDir, { recursive: true });
  const target = join(extensionsDir, "hicortex.ts");
  copyFileSync(extensionSource, target);
  console.log(`  ✓ Copied Pi extension to ${target}`);

  console.log("  → Restart Pi sessions to load the extension (recall, identity, lessons, 9 tools)");
}

// ---------------------------------------------------------------------------
// opencode setup
// ---------------------------------------------------------------------------

/**
 * Install the bundled opencode plugin (#347): one dependency-free .ts file
 * opencode auto-loads from ~/.config/opencode/plugins/. Deliberately NO
 * write into opencode's own configuration — the plugin self-resolves the
 * server from ~/.hicortex/config.json (the file init has already written by
 * this point), so there is nothing to keep in sync and no secret to route
 * elsewhere. Overwrites on re-init so upgrades land; skips gracefully when
 * the bundled source is absent (e.g. a dev checkout without the packaged
 * copy). The plugins directory may hold third-party files — the copy only
 * ever touches our own hicortex.ts name.
 */
function setupOpencode(): void {
  const pluginSource = join(__dirname, "..", "opencode-plugin", "hicortex", "index.ts");

  if (!existsSync(pluginSource)) {
    console.log("  ⚠ opencode plugin not found in package — skipping opencode setup");
    return;
  }

  const pluginsDir = join(OPENCODE_CONFIG_DIR, "plugins");
  mkdirSync(pluginsDir, { recursive: true });
  const target = join(pluginsDir, "hicortex.ts");
  copyFileSync(pluginSource, target);
  console.log(`  ✓ Copied opencode plugin to ${target}`);

  console.log("  → Restart opencode sessions to load the plugin (recall, identity, lessons, 9 tools)");
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
 * True when an LLM is already persisted and `init` must NOT re-run provider
 * selection: a named backend (llmBackend) or a flat baseUrl+apiKey pair.
 * (The nested `models` per-tier block was removed in #231 — one model serves
 * all phases, configured via the flat `llm*` keys only.)
 */
export function isLlmConfigured(config: Record<string, unknown>): boolean {
  return Boolean(config.llmBackend || (config.llmApiKey && config.llmBaseUrl));
}

/**
 * Detect or ask for LLM config and persist to ~/.hicortex/config.json.
 * The daemon can't inherit shell env vars, so we persist here.
 * LLM choice is always user-controlled: candidates are detected and presented
 * as a numbered list; the user picks one. Nothing is auto-applied.
 * If the user cancels, the server runs recall-only (no LLM).
 */
export async function persistLlmConfig(configPath: string = join(HICORTEX_HOME, "config.json")): Promise<void> {
  // Strict load: a malformed existing config throws here — NEVER wiped to a
  // stub (the 0.16.x BLOCKER). ENOENT seeds {} (fresh install).
  const { config } = loadConfigStrict(configPath);

  // Don't overwrite if LLM config already persisted (incl. a nested-only config).
  if (isLlmConfigured(config)) {
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
      "  No LLM configured — server will run recall-only (search/lessons/recent work).\n" +
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
 * Strict config loader — the SINGLE source of truth for "read config.json or
 * fail loudly". Every config writer in init (persistLlmConfig, persistAuthToken,
 * ensureAndPersistAgentId, scaffoldDefaultDomains) loads through this, and the
 * runtime readers (nightly, server boot) route through it too (catching the
 * throw to fail-soft with a visible WARN).
 *
 * The 0.16.x BLOCKER this closes: the bare `try { JSON.parse(readFileSync) }
 * catch { /* new file *\/ }` pattern, on a config.json that EXISTS but won't
 * parse (a hand-edit syntax slip, truncation, corruption), silently seeded `{}`
 * and the writer then OVERWROTE the file — `persistAuthToken` minted a fresh
 * token (fleet-wide 401), `scaffoldDefaultDomains` re-seeded the generic
 * vocabulary over the owner list, etc. `authToken` / `licenseKey` /
 * `llmApiKey` / `domains` / `weakPrimaryFloor` / `identityClients` (was
 * `contextClients`) all gone.
 * The early-return guards (existing-key checks) did NOT save them: those only
 * fire on a VALID parse that reads the key, not on a corrupted file.
 *
 * Contract:
 *   - ENOENT (genuinely no file) → `{ config: {}, hadFile: false }` (a new
 *     install; the caller decides whether to persist).
 *   - Any OTHER read failure on an existing file (EACCES, etc.) → THROW.
 *   - A parse failure (bad JSON) on an existing file → THROW.
 *   - A non-object JSON value (null / array / true / 5 / "x") → THROW. Such a
 *     value is not a valid config and must not be silently replaced with {}.
 *
 * Refusing is the right DEFAULT, but it dead-ends the operator: `init` is
 * exactly what you would run to repair a broken install, and it now won't run.
 * `init --repair-config` is the explicit escape hatch — see
 * quarantineMalformedConfig below. Never quarantine implicitly: that path mints
 * a fresh authToken (fleet-wide 401), so it must be a deliberate choice.
 *
 * Exported so nightly.ts / mcp-server.ts readers can route through it.
 */
export function loadConfigStrict(configPath: string): { config: Record<string, unknown>; hadFile: boolean } {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch (e) {
    // Only a genuinely-absent file (ENOENT) may safely seed {}.
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { config: {}, hadFile: false };
    }
    // EACCES / EIO / … — the file is there but unreadable. Do not swallow.
    throw new Error(
      `Refusing to read ${configPath}: the file exists but is not readable ` +
      `(fix the permissions and re-run). Cause: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `Refusing to write ${configPath}: the file exists but could not be parsed ` +
      `(swallowing this would overwrite it with a stub and lose authToken / licenseKey / ` +
      `domains). Fix the JSON and re-run, or run \`hicortex init --repair-config\` to move ` +
      `the broken file aside and rebuild. ` +
      `Cause: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  // Non-object JSON (null / array / boolean / number / string) is not a valid
  // config object and must never be silently replaced with {}.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    const kind = parsed === null ? "null" : Array.isArray(parsed) ? "an array" : typeof parsed;
    throw new Error(
      `Refusing to write ${configPath}: the file parses to ${kind}, not a JSON object ` +
      `(swallowing this would overwrite it with a stub). Fix the JSON and re-run, or run ` +
      `\`hicortex init --repair-config\` to move the broken file aside and rebuild.`
    );
  }

  return { config: parsed as Record<string, unknown>, hadFile: true };
}

/**
 * `init --repair-config` escape hatch: move a malformed config.json aside so
 * init can rebuild, instead of dead-ending on loadConfigStrict's throw.
 *
 * Why this exists: refusing to overwrite a corrupt config is right (it closed
 * the 0.16.x wipe BLOCKER), but it leaves the operator stuck — `init` is the
 * natural repair action and it now refuses to run. Deleting the file by hand
 * works but silently loses `licenseKey` / `authToken` / `llmApiKey`.
 *
 * Why it is OPT-IN and never automatic: rebuilding mints a fresh `authToken`,
 * which 401s every thin client on the fleet until they are re-pointed. That is
 * a deliberate operator decision, not a fallback.
 *
 * Behaviour:
 *   - Config absent or valid → no-op (`{ quarantined: false }`).
 *   - Malformed → rename to `config.json.corrupt-<ISO>` (colons stripped for
 *     Windows), and report the TOP-LEVEL KEY NAMES recovered from the raw text
 *     so the operator knows what to restore.
 *
 * SECURITY: key NAMES only, never values. `authToken`, `licenseKey`, and
 * `llmApiKey` are secrets — printing them would leak into terminal scrollback,
 * CI logs, and screen shares. The operator reads the values out of the backup
 * file themselves.
 *
 * Exported for testability.
 */
export function quarantineMalformedConfig(
  configPath: string
): { quarantined: false } | { quarantined: true; backupPath: string; keys: string[] } {
  try {
    loadConfigStrict(configPath);
    return { quarantined: false }; // absent (ENOENT) or valid — nothing to do.
  } catch { /* malformed — fall through and quarantine */ }

  // Best-effort key-name recovery from the RAW text. The file does not parse,
  // so this is a regex over top-level-looking `"key":` occurrences — advisory
  // only (it may over- or under-report on deeply nested or truncated files).
  let keys: string[] = [];
  try {
    const raw = readFileSync(configPath, "utf-8");
    keys = [...new Set([...raw.matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"\s*:/g)].map((m) => m[1]))];
  } catch { /* unreadable — report no keys rather than fail the repair */ }

  const backupPath = `${configPath}.corrupt-${new Date().toISOString().replace(/:/g, "-")}`;
  renameSync(configPath, backupPath);

  console.log(`  ⚠ ${configPath} was malformed — moved to ${backupPath}`);
  console.log(`    init will rebuild a fresh config. NOTHING was deleted.`);
  if (keys.length > 0) {
    console.log(`    Keys found in the old file: ${keys.join(", ")}`);
  }
  console.log(`    ACTION REQUIRED: copy any of licenseKey / llmApiKey /`);
  console.log(`    domains / weakPrimaryFloor back from the backup by hand.`);
  console.log(`    A NEW authToken will be generated — every thin client pointing at this`);
  console.log(`    server must be updated, or their recall will 401 (silently, fail-soft).`);

  return { quarantined: true, backupPath, keys };
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
  // Strict load: a malformed existing config throws here — NEVER mint a fresh
  // token over a wiped stub (the 0.16.x BLOCKER: this writer was the worst — a
  // fleet-wide 401 on a hand-edit slip). ENOENT seeds {} (fresh install).
  const { config } = loadConfigStrict(configPath);

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
 * Ensure a stable per-install `agentId` UUID is set on a config object.
 *
 * The id is the client's attribution identity (stored on each captured
 * memory as `source_agent_id`) — it survives agent/machine renames, unlike
 * the readable `source_agent` name. Generated once, never rotated (idempotent:
 * an existing valid `agentId` is always kept). Pure: mutates `config` in place
 * and does NO file IO — BOTH server and client init call this on their
 * in-memory config object before saving (the server path loads/saves
 * config.json around it; the client builds in-memory and saves once).
 * Exported for testability.
 */
export function ensureAgentId(config: Record<string, unknown>): { agentId: string; generated: boolean } {
  if (typeof config.agentId === "string" && config.agentId) {
    return { agentId: config.agentId, generated: false };
  }
  const agentId = randomUUID();
  config.agentId = agentId;
  return { agentId, generated: true };
}

/**
 * Load → ensure → persist wrapper for the `agentId` provenance field. This is
 * the runtime activation path: `ensureAgentId` was historically called ONLY
 * inside `init`, so pre-0.16.2 installs that already ran init never get an
 * `agentId` written → nightly + server boot capture sent `source_agent_id:
 * null` forever (the feature was inert for the entire existing fleet). Both
 * nightly and server boot call THIS on startup so the field self-heals on the
 * first run after upgrade — one read, one conditional write, idempotent.
 *
 * Built on the pure `ensureAgentId` (which init's client path and the unit
 * test still call directly); this wrapper adds the disk IO.
 *
 * Hardening (0.16.x CR BLOCKER): the naive "try { read } catch { seed {} }"
 * + unconditional save WIPES config.json when the file exists but is
 * unparseable (a hand-edit syntax slip) — the catch swallows the parse error,
 * {} is seeded, and the save overwrites the file with just {"agentId": ...},
 * destroying authToken / licenseKey / domains / weakPrimaryFloor, then
 * cascades into scaffoldDefaultDomains re-seeding the generic vocabulary.
 * This wrapper refuses that path:
 *   - ENOENT (file genuinely absent) → seed {} is correct (new install).
 *   - Any OTHER read/parse failure on a file that EXISTS (corruption,
 *     truncation, bad JSON) → THROW. Swallowing would overwrite the file; the
 *     operator must fix the JSON instead of silently losing it.
 * Save happens ONLY when a new id was generated AND the file already existed
 * — a missing config.json means init was never run (a separate problem), so we
 * do not create a stub file just to hold an agentId. The returned id is still
 * usable in-memory for the run either way.
 *
 * Exported for use by init's server path, nightly.ts, and mcp-server.ts boot.
 */
export function ensureAndPersistAgentId(configPath: string): { agentId: string; generated: boolean } {
  // One source of truth: loadConfigStrict throws on a malformed existing file
  // (never wipe) and returns hadFile=false on ENOENT (do not create a stub).
  const { config, hadFile } = loadConfigStrict(configPath);

  const result = ensureAgentId(config);
  if (result.generated && hadFile) {
    saveConfig(configPath, config);
  }
  return result;
}

/**
 * Decide the per-agent identity id to persist at init (#179; CC default = global,
 * owner decision 20.07.2026). `agentName` is an explicit opt-in only — there is
 * NO hostname default, so an install with no `--agent-name` sends no `?agent=`
 * and shares the global identity (one user = one identity across machines).
 *
 * Empty string == unset everywhere: `--agent-name ""` (or whitespace-only) is
 * the explicit way to opt BACK OUT — it CLEARS any existing `agentName` key and
 * returns to global, rather than erroring as an invalid id.
 *  - explicit `--agent-name <non-empty>` → the sanitized flag (error if it
 *    sanitizes to null, so a bad flag is loud rather than silently ignored);
 *  - explicit `--agent-name ""` / whitespace-only → `clear` (remove the key);
 *  - no flag but an existing non-empty `agentName` → keep it untouched
 *    (non-clobber like persistAuthToken / scaffoldDefaultDomains);
 *  - no flag, no (non-empty) existing value → do not write (global by default).
 * Pure + exported for testability; never touches disk.
 */
export function decideAgentName(
  existing: unknown,
  flag: string | undefined,
): { write: boolean; value: string | null; clear?: boolean; error?: string } {
  if (flag !== undefined) {
    // Explicit empty / whitespace-only value → clear back to global (unset).
    if (flag.trim() === "") return { write: false, value: null, clear: true };
    const s = sanitizeAgentId(flag);
    if (s === null) {
      return {
        write: false,
        value: null,
        error: `Invalid --agent-name '${flag}'. Must contain letters or digits and sanitize to ^[a-z0-9][a-z0-9_-]*$ (max 64 chars). Pass --agent-name "" to clear it (global identity).`,
      };
    }
    return { write: true, value: s };
  }
  if (typeof existing === "string" && existing.trim().length > 0) return { write: false, value: existing };
  return { write: false, value: null };
}

/** Read config.json, set agentName, write it back. Used by the server path.
 *  Routes through loadConfigStrict — a malformed existing config throws rather
 *  than being wiped to a `{agentName: …}` stub (0.16.x BLOCKER; same pattern as
 *  the other four writers). Exported for wipe-protection coverage. */
export function writeAgentNameConfig(configPath: string, value: string): void {
  const { config } = loadConfigStrict(configPath);
  config.agentName = value;
  mkdirSync(HICORTEX_HOME, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2));
}

/** Read config.json, delete any `agentName` key, write it back (server path).
 *  Routes through loadConfigStrict — a malformed existing config throws (never
 *  silently no-op). ENOENT is still a silent no-op (hadFile=false → empty
 *  config has no `agentName` key → return without writing). */
function clearAgentNameConfig(configPath: string): void {
  const { config } = loadConfigStrict(configPath);
  if (!("agentName" in config)) return;
  delete config.agentName;
  mkdirSync(HICORTEX_HOME, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2));
}

/**
 * Client-init config write: strict-load → apply the client overrides → save.
 * This is the testable seam for the client path's config build (the rest of
 * runClientInit is interactive / mutates ~/.claude / installs the daemon, so it
 * is not unit-testable; this helper is).
 *
 * Strict load closes the 0.16.x BLOCKER for the client path: the old bare
 * `try { parse } catch { warn }` seeded `{}` on a malformed existing config,
 * then proceeded to set mode/serverUrl/authToken/agentId and `saveConfig` —
 * OVERWRITING the file and losing the client's existing `authToken` (→ 401 on
 * the next /search) and `licenseKey`, the same class as the server-side wipe.
 * Now a malformed existing config THROWS (the user is interactive at `init`;
 * they can fix the JSON and re-run, same as the server path). ENOENT → `{}`
 * → a genuinely new client config is built fresh and saved.
 *
 * `agentNameDecision` is resolved by the caller via decideAgentName (which owns
 * the process.exit on an invalid --agent-name flag). A no-flag run passes a
 * {write:false} decision → this helper does not touch `agentName`, preserving
 * whatever the loaded config already carries. Exported for wipe-protection
 * coverage.
 */
export function writeClientConfig(
  configPath: string,
  overrides: { serverUrl: string; authToken?: string },
  agentNameDecision?: { write: boolean; value: string | null; clear?: boolean },
): { config: Record<string, unknown> } {
  const { config } = loadConfigStrict(configPath);

  config.mode = "client";
  config.serverUrl = overrides.serverUrl;
  if (overrides.authToken) config.authToken = overrides.authToken;

  if (agentNameDecision) {
    if (agentNameDecision.clear) {
      delete config.agentName;
    } else if (agentNameDecision.write && agentNameDecision.value) {
      config.agentName = agentNameDecision.value;
    }
    // write:false (no --agent-name flag) → leave the existing agentName as-is.
  }

  // Stable per-install agent id (attribution). Generated once, kept across
  // re-runs (never rotated). An existing id from a prior init is preserved.
  ensureAgentId(config);

  saveConfig(configPath, config);
  return { config };
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
  // Strict load: a malformed existing config throws here — NEVER re-seed the
  // generic defaults over the owner vocabulary (the 0.16.x BLOCKER). ENOENT
  // seeds {} (fresh install → scaffold is the point).
  const { config } = loadConfigStrict(configPath);

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
 * Determine the npm package specifier used in the generated daemon/timer
 * ExecStart (for npx-thin installs — global-binary installs use the absolute
 * binary path and never call this). Tag-based so restarts pick up new versions.
 *
 * Priority:
 *   1. `updateChannel` config key (e.g. "rc") → `@gamaze/hicortex@<channel>`.
 *      Lets an install pin a release channel — the internal fleet sets "rc" so
 *      its npx-thin hosts track the rc dist-tag through a pre-promotion soak
 *      (otherwise the auto-detect below pins @next, which lags rc).
 *   2. Auto-detect: bare `@gamaze/hicortex` if the running version matches the
 *      npm `latest` tag, else `@gamaze/hicortex@next` (legacy pre-0.10 cron
 *      installs follow @next).
 *
 * Exported + `configDir`-parametrised so the channel override is unit-testable.
 */
export function getPackageSpec(configDir: string = HICORTEX_HOME): string {
  try {
    const { config } = loadConfigStrict(join(configDir, "config.json"));
    const ch = config.updateChannel;
    if (typeof ch === "string") {
      const trimmed = ch.trim();
      // A dist-tag (rc/next/latest) or an exact version — alphanumerics, dot,
      // dash, underscore only. Reject anything else: a newline would break the
      // systemd `ExecStart=` one-liner and `<`/`&` would break the launchd plist
      // XML the timer writes. Fall through to auto-detect + warn.
      if (/^[\w.\-]+$/.test(trimmed)) return `@gamaze/hicortex@${trimmed}`;
      console.warn(
        `[hicortex] config "updateChannel" = ${JSON.stringify(ch)} is not a valid dist-tag/version ` +
        `(use e.g. "rc", "next", or "0.17.1") — ignored.`
      );
    }
  } catch { /* no config yet, or malformed — fall through to auto-detect */ }
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
  // #276: verify the supervisor can actually run (node resolvable on the
  // generated PATH) before writing the plist/unit — turns a silent DOA into a
  // loud install-time warning.
  verifySupervisorRuntime(binaryArgs);

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
 * True if a resolved binary path lives in npm's ephemeral npx cache
 * (`~/.npm/_npx/<hash>/node_modules/.bin/…`). When `hicortex init` is itself
 * run via `npx -y @gamaze/hicortex init`, npx prepends that cache dir to PATH,
 * so `which hicortex` resolves there. npm garbage-collects `_npx`, so any
 * SessionStart hook or nightly timer wired to such a path breaks silently
 * later — the "looks configured but isn't" trap (#176). Never persist it.
 */
export function isEphemeralNpxPath(binPath: string): boolean {
  return binPath.includes("/_npx/");
}

/**
 * Resolve the absolute path of the hicortex binary.
 * For global npm installs (e.g. /usr/bin/hicortex) this is the binary itself.
 * For dev/npx installs, falls back to `npx <packageSpec> <command>` form.
 * Returns an array: [binaryPath] for global, or [npxPath, "-y", packageSpec] for npx.
 *
 * A `which hicortex` hit inside the npx cache (#176) is REJECTED — it is
 * ephemeral, so we emit the durable `npx -y <spec>` form instead. This is the
 * standard client path (`npx … init`), where the fix matters most.
 */
function resolveBinaryArgs(): string[] {
  try {
    const bin = execSync("which hicortex", { encoding: "utf-8" }).trim();
    if (bin && !isEphemeralNpxPath(bin)) return [bin];
  } catch { /* not in PATH as a global binary */ }
  const npxPath = findNpxPath();
  const packageSpec = getPackageSpec();
  return [npxPath, "-y", packageSpec];
}

/**
 * Build the PATH the launchd/systemd supervisors receive (#276). Order:
 *   1. the binary's own dir — so a SIBLING node wins for nvm/volta/npm-global
 *      installs (the version the global was installed under);
 *   2. the dir of the node the supervisor should run under — resolved via
 *      `which node` (the symlink path, stable across upgrades); see
 *      resolveNodeDir(). This is the generic rescue: for bun/pnpm/yarn globals
 *      the bin dir has NO node sibling, and on Apple Silicon node lives in
 *      /opt/homebrew/bin. Baking the resolved node dir in fixes every package
 *      manager without enumerating them;
 *   3. the standard locations — including /opt/homebrew/bin (Apple Silicon
 *      homebrew) as a belt-and-suspenders fallback for the no-sibling case.
 * Deduped (preserving first-seen order); empties dropped.
 */
export function buildSupervisorPath(binaryArgs: string[]): string {
  const binDir = dirname(binaryArgs[0]);
  const nodeDir = resolveNodeDir();
  return [binDir, nodeDir, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
    .filter((d, i, a) => d && a.indexOf(d) === i)
    .join(":");
}

/**
 * Resolve the dir of the node the supervisor should use (#276). Prefers
 * `which node` — the SYMLINK path, stable across version upgrades (homebrew
 * rotates the Cellar target but keeps /opt/homebrew/bin/node) — over
 * process.execPath, which on macOS is the resolved realpath (the versioned
 * Cellar dir, e.g. /opt/homebrew/Cellar/node/X.Y.Z/bin) and STALES on a
 * `brew upgrade node`, re-introducing the silent-death the fix targets. Falls
 * back to process.execPath's dir only if `which node` is unavailable.
 */
function resolveNodeDir(): string {
  try {
    const which = execSync("which node", { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] }).trim();
    if (which) return dirname(which);
  } catch { /* node not on PATH — fall through to execPath */ }
  return dirname(process.execPath);
}

/** Dedup flag so the supervisor-runtime warning prints once per `init` run. */
let supervisorRuntimeWarned = false;

/**
 * Install-time smoke test (#276): spawn the resolved binary with the SAME PATH
 * the supervisor will use and confirm it can run (`--version`). Turns the
 * silent-dead-on-arrival case (node unresolvable under launchd's empty PATH →
 * the agent dies at the `#!/usr/bin/env node` shebang with exit 127, capture
 * stops silently, no signal in `status` because the shell PATH masks it) into a
 * LOUD install-time warning. Does NOT block install — the plist/unit is still
 * written so a PATH fix + reload recovers it without re-init.
 */
function verifySupervisorRuntime(binaryArgs: string[]): void {
  if (supervisorRuntimeWarned) return;
  const supervisorEnv = { ...process.env, PATH: buildSupervisorPath(binaryArgs) };
  try {
    execSync([...binaryArgs, "--version"].join(" "), { stdio: "pipe", env: supervisorEnv });
  } catch {
    supervisorRuntimeWarned = true;
    console.error(
      "  ⚠ WARNING: the scheduled daemon/nightly could not run with the generated PATH — " +
      "`node` was not found, so the supervisor will fail silently at runtime (capture stops). " +
      "Reinstall via `npm install -g @gamaze/hicortex` (recommended) or ensure node is at a " +
      "standard location, then re-run `npx @gamaze/hicortex init`.",
    );
  }
}

/**
 * Install (or verify) the CC SessionStart hook that runs the canonical command
 * `hicortex learnings-identity` (aliased as the legacy `lessons-context`,
 * #264). The hook fetches the identity layer + lessons from the configured
 * server at session start and injects them as a Markdown block — replacing the
 * old static CLAUDE.md block.
 *
 * Idempotent: skips if a SessionStart hook containing EITHER `learnings-identity`
 * OR the legacy `lessons-context` already exists (so re-init never duplicates,
 * whether the existing hook was written by a pre- or post-#264 install). It does
 * NOT rewrite an existing legacy `lessons-context` hook — the alias keeps old
 * installs working as-is.
 *
 * Uses JSON.parse/JSON.stringify to safely merge into ~/.claude/settings.json.
 *
 * @param settingsPath Override for the settings.json path (used in tests; defaults to CC_SETTINGS).
 */
export function installSessionStartHook(settingsPath?: string): void {
  installCcHook("SessionStart", "learnings-identity", 10, settingsPath, ["lessons-context"]);
}

/**
 * Install (or verify) the #192 pushed-recall hooks: `hicortex recall-hook`
 * under UserPromptSubmit (per-prompt recall index) AND under SessionStart
 * (per-session dedup reset — the CLI dispatches on the payload's
 * hook_event_name, so one command serves both events).
 */
export function installRecallHooks(settingsPath?: string): void {
  installCcHook("UserPromptSubmit", "recall-hook", 3, settingsPath);
  installCcHook("SessionStart", "recall-hook", 3, settingsPath);
}

/**
 * Shared CC-hook installer: add `hicortex <subcommand>` under the given hook
 * event in ~/.claude/settings.json. Idempotent per (event, subcommand): skips
 * if any existing entry for that event already runs the subcommand — or, when
 * `aliases` is passed, ANY of the alias names. The alias match is what lets a
 * post-#264 install recognize a pre-#264 `lessons-context` hook as "already
 * installed" without rewriting it (the legacy name keeps working via
 * resolveCommandAlias). `timeout` is CC's hook-process kill timeout in SECONDS
 * (the network timeout inside the command is separate and shorter).
 */
function installCcHook(
  eventName: string,
  subcommand: string,
  timeout: number,
  settingsPath?: string,
  aliases: string[] = [],
): void {
  const targetPath = settingsPath ?? CC_SETTINGS;
  const binaryArgs = resolveBinaryArgs();
  // e.g. "/path/to/hicortex learnings-identity" or "npx -y @gamaze/hicortex recall-hook"
  const command = [...binaryArgs, subcommand].join(" ");

  let settings: Record<string, unknown> = {};
  if (existsSync(targetPath)) {
    try {
      settings = JSON.parse(readFileSync(targetPath, "utf-8"));
    } catch {
      // File exists but is malformed — do NOT overwrite (would destroy the user's entire CC config).
      console.log(`  ⚠ ${targetPath} exists but is not valid JSON — skipping ${eventName} hook.`);
      console.log(`    Fix the file, then re-run init, or add the hook manually:`);
      console.log(`    command: "${command}"`);
      return;
    }
  }

  // Ensure hooks object and the event array exist
  if (!settings.hooks || typeof settings.hooks !== "object") {
    settings.hooks = {};
  }
  const hooks = settings.hooks as Record<string, unknown>;
  if (!Array.isArray(hooks[eventName])) {
    hooks[eventName] = [];
  }
  const entries = hooks[eventName] as Array<unknown>;

  // Idempotent: skip if any existing entry's command runs this subcommand OR
  // one of its aliases (e.g. a pre-#264 `lessons-context` hook when installing
  // the canonical `learnings-identity`). Word-boundary guard so "recall-hook"
  // never matches a hypothetical "recall-hook-foo" command, and so the
  // `learnings-identity`/`lessons-context` pair are distinct (no prefix clash).
  const names = [subcommand, ...aliases];
  const subcommandRe = new RegExp(`(^|\\s)(?:${names.map(escapeRegex).join("|")})(\\s|$)`);
  const alreadyInstalled = entries.some((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    const e = entry as Record<string, unknown>;
    // CC hook format: { hooks: [{ type: "command", command: "..." }] }
    if (Array.isArray(e.hooks)) {
      return e.hooks.some((h: unknown) => {
        if (typeof h !== "object" || h === null) return false;
        const hook = h as Record<string, unknown>;
        return typeof hook.command === "string" && subcommandRe.test(hook.command);
      });
    }
    return false;
  });

  if (alreadyInstalled) {
    console.log(`  ✓ ${eventName} hook (${subcommand}) already installed`);
    return;
  }

  entries.push({
    hooks: [{ type: "command", command, timeout }],
  });

  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, JSON.stringify(settings, null, 2));
  console.log(`  ✓ Installed ${eventName} hook: ${command}`);
}

/**
 * Escape a literal string for safe embedding in a RegExp (alias names like
 * `lessons-context` happen to be regex-safe, but escape anyway so the
 * idempotency check can never break if a future alias contains a metachar).
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  const supervisorPath = buildSupervisorPath(binaryArgs);

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
    <string>${supervisorPath}</string>
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
  const supervisorPath = buildSupervisorPath(binaryArgs);

  const service = `[Unit]
Description=Hicortex MCP server — long-term memory for AI agents

[Service]
Type=simple
ExecStart=${execStart}
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
Environment=PATH=${supervisorPath}

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

export async function runInit(
  options: { serverUrl?: string; agentName?: string; repairConfig?: boolean } = {}
): Promise<void> {
  // --repair-config: quarantine a malformed config.json BEFORE any writer runs,
  // so the strict loaders see ENOENT and rebuild instead of throwing. Must come
  // first — every writer downstream loads through loadConfigStrict.
  if (options.repairConfig) {
    quarantineMalformedConfig(join(HICORTEX_HOME, "config.json"));
    // CR warning 2 (#271): repair-config is a plausible post-upgrade recovery
    // action, so it MUST (re)write the localhost-bypass marker itself — defensive
    // against a future early-return in this block. The full-init path writes it
    // again at line ~1615 (idempotent: same content, returns false the second
    // time). Never written in hosted mode (the boot assertion refuses to start
    // with the marker present).
    writeLocalhostBypassMarker(HICORTEX_HOME);
  }

  if (options.serverUrl) {
    await runClientInit(options.serverUrl, options.agentName);
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
  if (d.piFound) console.log(`  • Pi found at ${PI_AGENT_DIR}`);
  if (d.opencodeFound) console.log(`  • opencode found at ${OPENCODE_CONFIG_DIR}`);
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
  if (d.piFound) actions.push("Install Pi extension");
  if (d.opencodeFound) actions.push("Install opencode plugin");
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

  // Stable per-install agent id (attribution on captured memories; survives
  // renames). Generated once, never rotated — same non-clobber philosophy as
  // the auth token. Goes through ensureAndPersistAgentId (hardened wrapper:
  // throws on a malformed existing config instead of swallowing + wiping, and
  // saves ONLY when a new id was generated). persistAuthToken above already
  // ensured config.json exists by this point. The client path shares the SAME
  // loadConfigStrict discipline via writeClientConfig — it throws on a malformed
  // existing config too (ENOENT builds a fresh client config), so no path in
  // init silently wipes config.json anymore.
  const agentIdResult = ensureAndPersistAgentId(configPath);
  if (agentIdResult.generated) {
    console.log(`  ✓ Agent id: ${agentIdResult.agentId}`);
  }

  // Scaffold the generic default memory domains (server mode only — domains
  // live in the server's config; a client's memories are classified by the
  // server). Non-clobber: an existing `domains` key is never touched.
  // Classification activates automatically once an LLM is configured; until
  // then domains sit inert (strict-skip path).
  scaffoldDefaultDomains(configPath);

  // Write the localhost auth-bypass marker (#110 §2, #271 — Phase 0B). The
  // bypass is marker-gated from 0.18: self-hosted init writes the marker so
  // existing installs keep the bypass after upgrade + re-init; a hosted tenant
  // dir is fail-closed by default. Idempotent (overwrites an existing marker,
  // refreshing the note). Never written in hosted mode (the boot assertion
  // would refuse to start with the marker present).
  const markerCreated = writeLocalhostBypassMarker(HICORTEX_HOME);
  if (markerCreated) {
    console.log("  ✓ Localhost auth-bypass marker written");
  }

  // Per-agent identity id (#179): server mode writes it ONLY when the operator
  // passes --agent-name. Without the flag no agentName is written and the
  // co-located CC shares the global identity (global by default). Explicit flag
  // overwrites on re-init; `--agent-name ""` clears it back to global.
  if (options.agentName !== undefined) {
    const decision = decideAgentName(undefined, options.agentName);
    if (decision.error) {
      console.error(`  ✗ ${decision.error}`);
      process.exit(1);
    }
    if (decision.clear) {
      clearAgentNameConfig(configPath);
      console.log("  ✓ Agent name cleared — global identity");
    } else if (decision.write && decision.value) {
      writeAgentNameConfig(configPath, decision.value);
      console.log(`  ✓ Agent name set to '${decision.value}'`);
    }
  }

  // Install the scheduling timers (0.17): a CAPTURE WATCHDOG (short-interval
  // poll, success-cooldown-throttled — uniform with clients) + a CONSOLIDATION
  // timer (the full nightly, fixed slots). Re-init rewrites both; customize the
  // consolidation slots via consolidationHours in config.json (capture cadence
  // via captureCooldownHours).
  installCaptureWatchdogTimer();
  installConsolidationTimer(resolveConsolidationHours("server") ?? DEFAULT_CONSOLIDATION_HOURS);

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

  // Remove legacy pre-0.10 CC commands (/learn, /hicortex-activate) if present
  cleanupLegacyCcCommands();

  // Setup Hermes if detected
  if (d.hermesFound) {
    // localhost bypass makes the token optional for co-located installs;
    // pass it for remote setups so setupHermes can include it in its instructions.
    const isLocal = serverUrl.includes("127.0.0.1") || serverUrl.includes("localhost");
    setupHermes(serverUrl, isLocal ? "" : authToken);
  }

  // Setup the Pi extension if detected (self-resolving — no config write)
  if (d.piFound) {
    setupPi();
  }

  // Setup the opencode plugin if detected (self-resolving — no config write)
  if (d.opencodeFound) {
    setupOpencode();
  }

  // Install CC SessionStart hook for query-time lesson injection.
  // Lessons are now fetched live at session start — no static CLAUDE.md block needed.
  installSessionStartHook();
  // #192: per-prompt pushed recall index + session dedup reset.
  installRecallHooks();

  // Strip the old static lessons block from CLAUDE.md (0.9.0 migration).
  // Lessons are now delivered via the SessionStart hook instead.
  const claudeMdPath = join(homedir(), ".claude", "CLAUDE.md");
  if (removeLessonsBlock(claudeMdPath)) {
    console.log(`  ✓ Removed old static lessons block from ${claudeMdPath} — lessons now injected at session start`);
  }

  console.log("\n✓ Hicortex setup complete!\n");
  // Telemetry disclosure at install time (informed consent, best practice):
  // opt-out telemetry is only acceptable if the user is TOLD about it.
  console.log("Anonymous usage telemetry (aggregate counts only, no content) is on by default —");
  console.log("see exactly what is sent with `hicortex telemetry`; to opt out, add");
  console.log('"telemetry": false to ~/.hicortex/config.json or set HICORTEX_TELEMETRY=off.\n');
  // Install ping (0.15.2) — sent AFTER the disclosure above, opt-out aware, so
  // the install → first-nightly → retained funnel is measurable. Never blocks:
  // failures are swallowed inside sendLifecycleEvent.
  await sendLifecycleEvent("install", HICORTEX_HOME, readHomeConfig(HICORTEX_HOME), pkgVersion());
  console.log("Next steps:");
  // Counter-based so the list stays contiguous (1,2,3,4) whether or not Hermes
  // was detected — a conditional middle step used to leave a "1, 3, 4" gap.
  let step = 1;
  console.log(`  ${step++}. Restart Claude Code to pick up the new MCP server and SessionStart hook`);
  if (d.hermesFound) {
    console.log(`  ${step++}. Activate the Hermes plugin: run \`hermes memory setup\`, select 'hicortex', then restart the gateway(s)`);
  }
  console.log(`  ${step++}. Ask your agent: 'What Hicortex tools do you have?'`);
  console.log(`  ${step++}. Check server: curl ${serverUrl}/health`);
}

// ---------------------------------------------------------------------------
// Client Mode Init
// ---------------------------------------------------------------------------

async function runClientInit(serverUrl: string, agentName?: string): Promise<void> {
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

  // Per-agent identity id (#179): explicit opt-in only. resolve the flag via
  // decideAgentName (it owns the process.exit on an invalid --agent-name). A
  // no-flag run yields a {write:false} decision → writeClientConfig leaves any
  // existing agentName untouched (preserving what the loaded config carries).
  const nameDecision = decideAgentName(undefined, agentName);
  if (nameDecision.error) {
    console.error(`  ✗ ${nameDecision.error}`);
    process.exit(1);
  }
  if (nameDecision.clear) {
    console.log("  ✓ Agent name cleared — global identity");
  } else if (nameDecision.write && nameDecision.value && agentName && nameDecision.value !== agentName) {
    console.log(`  ℹ Agent name sanitized to '${nameDecision.value}'`);
  }

  // writeClientConfig: strict-load → apply overrides → save. Throws on a
  // malformed existing config (0.16.x BLOCKER — never wipe the client's
  // authToken/licenseKey). ENOENT → fresh client config.
  const { config } = writeClientConfig(configPath, { serverUrl, authToken }, nameDecision);

  console.log(`  ✓ Client config saved to ${configPath}`);
  if (typeof config.agentName === "string") {
    console.log(`  ✓ Agent name: ${config.agentName}`);
  }

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

  // Step 5: Remove legacy pre-0.10 CC commands if present
  cleanupLegacyCcCommands();

  // Step 6: Install SessionStart hook for query-time lessons + the #192
  // per-prompt pushed-recall hooks.
  installSessionStartHook();
  installRecallHooks();

  // Strip the old static CLAUDE.md lessons block if present (0.9.0 migration).
  const claudeMdPath = join(homedir(), ".claude", "CLAUDE.md");
  if (removeLessonsBlock(claudeMdPath)) {
    console.log(`  ✓ Removed old static lessons block from CLAUDE.md — lessons now injected at session start`);
  }

  // Step 7: Install the CAPTURE WATCHDOG (denoise locally, POST to server
  // /distill, throttled + preflight-gated) — the same capture mechanism every
  // install gets. Clients have no local DB → no consolidation timer; also
  // remove any legacy full-nightly timer a pre-0.17 install left behind.
  installCaptureWatchdogTimer();
  removeConsolidationTimer();

  // Step 8: Setup Hermes if detected
  if (existsSync(HERMES_HOME)) {
    console.log("\nHermes detected — installing plugin...");
    setupHermes(serverUrl, authToken);
  }

  // Step 8b: Setup the Pi extension if detected (self-resolving — no config write)
  if (existsSync(PI_AGENT_DIR)) {
    console.log("\nPi detected — installing extension...");
    setupPi();
  }

  // Step 8c: Setup the opencode plugin if detected (self-resolving — no config write)
  if (existsSync(OPENCODE_CONFIG_DIR) || existsSync(OPENCODE_DATA_DIR)) {
    console.log("\nopencode detected — installing plugin...");
    setupOpencode();
  }

  console.log("\n✓ Hicortex client setup complete!\n");
  // Telemetry disclosure at install time (informed consent, best practice):
  // opt-out telemetry is only acceptable if the user is TOLD about it.
  console.log("Anonymous usage telemetry (aggregate counts only, no content) is on by default —");
  console.log("see exactly what is sent with `hicortex telemetry`; to opt out, add");
  console.log('"telemetry": false to ~/.hicortex/config.json or set HICORTEX_TELEMETRY=off.\n');
  // Install ping (0.15.2) — sent AFTER the disclosure above, opt-out aware, so
  // the install → first-nightly → retained funnel is measurable. Never blocks:
  // failures are swallowed inside sendLifecycleEvent.
  await sendLifecycleEvent("install", HICORTEX_HOME, readHomeConfig(HICORTEX_HOME), pkgVersion());
  console.log("How it works:");
  console.log("  • MCP tools (search, identity, ingest) talk to the remote server");
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
 * Scheduling (0.17): one UNIFORM capture mechanism + one role-specific
 * consolidation timer, replacing the old single daily full-nightly.
 *
 *   - CAPTURE WATCHDOG (`hicortex-capture`): a short-interval timer fires
 *     `nightly --capture-only --watchdog`. The watchdog throttles by a
 *     success-cooldown (`captureCooldownHours`, default 6 ≈ 4 captures/day) and
 *     preflights before capturing, so a transient fire-instant network miss
 *     retries in minutes, not at the next daily slot (#239: a once-daily client
 *     fire that caught a slow/flaky link lost ~24h of capture). Installed
 *     UNIFORMLY for client AND server/co-located — one capture code path, no
 *     per-topology branch. A failed preflight retries on the next tick; a
 *     successful capture waits the cooldown (success-based cooldown — the
 *     better semantics; the custom server watchdog used trigger-based).
 *   - CONSOLIDATION timer (`hicortex-nightly`): full `nightly` (capture +
 *     distill + score + reflect + link). Server/co-located ONLY — clients have
 *     no local DB, so no consolidation timer is installed (and a legacy one
 *     left by a pre-0.17 install is removed). Fixed slots (default [10, 22]).
 *
 * Customize: `consolidationHours` (the consolidation slots) and
 * `captureCooldownHours` (the watchdog throttle) in config.json. Re-init
 * rewrites the timers to the resolved standard (the pre-0.17 "never overwrite"
 * contract is intentionally relaxed so the fleet adopts the standard). The
 * legacy single `nightlyHour` is honoured as a one-slot consolidation fallback
 * only when `consolidationHours` is absent (preserves "one daily job at H").
 */
const DEFAULT_CONSOLIDATION_HOURS = [10, 22];

/**
 * #256 — timer jitter default (seconds). Applied to newly-generated timers so a
 * fleet of installs on the same default schedule doesn't all hit the LLM
 * backend at the same minute (thundering-herd avoidance). systemd emits this as
 * `RandomizedDelaySec`; launchd has no native equivalent so the launchd path
 * bakes a per-install randomized `Minute` offset into each
 * `StartCalendarInterval` dict (generated once at init, stable across reboots).
 *
 * 3600s = 1h spread on a 2-slot/day consolidation cadence = up to ±30 min around
 * each slot — enough to flatten the peak without stretching into the next slot
 * window. Tunable via `timerJitterSeconds` (0 disables). NOTE: only affects
 * NEWLY generated timers; re-init rewrites the unit files (the 0.17 migration
 * decision), so an explicit re-init is how an existing install adopts jitter.
 */
const DEFAULT_TIMER_JITTER_SEC = 3600;

/**
 * Resolve the timer-jitter spread (seconds) from config. 0 = disabled. Uses
 * readNonNegativeConfig (0 is a valid "off", mirroring ollamaFlushEvery).
 */
export function resolveTimerJitterSeconds(configDir = HICORTEX_HOME): number {
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(readFileSync(join(configDir, "config.json"), "utf-8"));
  } catch { /* no config yet — use the default */ }
  // Floor to an integer for a clean contract (systemd accepts fractional
  // seconds, but a whole-second value is unambiguous across systemd + launchd).
  return Math.floor(readNonNegativeConfig(config, "timerJitterSeconds", DEFAULT_TIMER_JITTER_SEC));
}

/**
 * #256 — per-install randomized Minute offset for the launchd consolidation
 * plist. launchd has no native `RandomizedDelaySec`; the idiomatic equivalent
 * is a per-job `Minute` shift baked into each `StartCalendarInterval` dict.
 * The value is generated ONCE at init time so the plist is stable across
 * reboots (no flapping), and the SAME offset applies to every slot so the
 * relative spacing between slots is preserved.
 *
 * `jitterSec` < 60 → 0 (cannot span a minute). Inject `rand` for deterministic
 * tests; defaults to Math.random (init-time generation, not the hot path).
 */
export function randomMinuteOffset(jitterSec: number, rand: () => number = Math.random): number {
  if (!Number.isFinite(jitterSec) || jitterSec < 60) return 0;
  const max = Math.min(59, Math.floor(jitterSec / 60));
  if (max <= 0) return 0;
  return Math.floor(rand() * (max + 1));
}

/**
 * Capture-watchdog poll interval (minutes). The capture timer fires
 * `nightly --capture-only --watchdog` this often; the watchdog itself throttles
 * by the success-cooldown (`captureCooldownHours`, read at runtime). Short so a
 * transient fire-instant network miss retries in minutes, not at the next daily
 * slot (#239). Cheap: a tick against a down server is one 5s preflight.
 */
const CAPTURE_WATCHDOG_INTERVAL_MIN = 20;

/**
 * Resolve the CONSOLIDATION hours (the only slot-based timer in 0.17). The
 * CAPTURE mechanism is the watchdog (an interval timer, not slots) — uniform
 * across client + server/co-located — so this function no longer returns a
 * capture schedule. Returns null in client mode (no local DB → no
 * consolidation timer).
 *
 * Priority: `consolidationHours` array → legacy `nightlyHour` (single int, only
 * when the array key is absent → one consolidation slot at H, preserving the
 * pre-0.17 "one daily job" intent) → role default ([10, 22] server / null client).
 */
export function resolveConsolidationHours(mode: "server" | "client", configDir = HICORTEX_HOME): number[] | null {
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(readFileSync(join(configDir, "config.json"), "utf-8"));
  } catch { /* no config yet — use the standard default */ }

  if (mode === "client") return null; // clients have no local DB → no consolidation timer

  const arr = parseHours(config, "consolidationHours");
  if (arr) return arr;

  const legacy = readLegacyNightlyHour(config);
  if (legacy !== null) return [legacy];

  return DEFAULT_CONSOLIDATION_HOURS;
}

/** Read the legacy `nightlyHour` (single int 0–23) if validly set, else null. */
function readLegacyNightlyHour(config: Record<string, unknown>): number | null {
  const h = config.nightlyHour;
  if (typeof h === "number" && Number.isInteger(h) && h >= 0 && h <= 23) return h;
  return null;
}

/**
 * Legacy single-hour resolver (pre-0.17). Kept for backward compat + the
 * existing tests; new scheduling goes through `resolveConsolidationHours`.
 */
export function resolveNightlyHour(mode: "server" | "client", configDir = HICORTEX_HOME): number {
  try {
    const config = JSON.parse(readFileSync(join(configDir, "config.json"), "utf-8"));
    const legacy = readLegacyNightlyHour(config);
    if (legacy !== null) return legacy;
  } catch { /* no config yet — use the default */ }
  return mode === "server" ? 3 : 2;
}

interface ScheduleUnitOpts {
  /** systemd unit base, e.g. "hicortex-capture" → .service/.timer. */
  unitBase: string;
  /** launchd Label, e.g. "com.gamaze.hicortex-capture". */
  plistLabel: string;
  serviceDesc: string;
  timerDesc: string;
  /** Args after the binary: ["nightly"], ["nightly","--capture-only"], etc. */
  nightlyArgs: string[];
  /**
   * Fixed calendar hours (OnCalendar / StartCalendarInterval array) — used for
   * the consolidation timer. Exactly one of `hours` / `intervalSec` is set.
   */
  hours?: number[];
  /**
   * Poll interval in seconds (OnUnitActiveSec / StartInterval) — used for the
   * capture watchdog timer. Exactly one of `hours` / `intervalSec` is set.
   */
  intervalSec?: number;
  /**
   * Runaway BACKSTOP in minutes (systemd `TimeoutStartSec`). NOT an operating
   * limit — set well above the longest legitimate run so it only kills a true
   * hang. The budget cap governs throughput; this only catches a stuck process.
   * Linux only (launchd has no native run-time cap on a oneshot).
   */
  timeoutMin?: number;
  /**
   * #256 — timer jitter spread in seconds. systemd: emitted as
   * `RandomizedDelaySec=<jitterSec>` (one line, applies to all OnCalendar /
   * OnUnitActiveSec entries). launchd: a per-install randomized `Minute` offset
   * baked into each `StartCalendarInterval` dict (interval/watchdog plists keep
   * their StartInterval untouched — no clean jitter knob, and interval timers
   * don't thundering-herd the way fixed-slot timers do). 0 = disabled. Defaults
   * to `resolveTimerJitterSeconds(HICORTEX_HOME)` when omitted.
   */
  jitterSec?: number;
}

/**
 * One `OnCalendar=*-*-* HH:00:00` line per hour, newline-joined — systemd fires
 * a timer at EACH OnCalendar entry (multi-slot in a single timer). Hours are
 * sorted so the generated file is stable/diffable. Exported for testing.
 */
export function formatOnCalendarLines(hours: number[]): string {
  return [...hours]
    .sort((a, b) => a - b)
    .map((h) => `OnCalendar=*-*-* ${String(h).padStart(2, "0")}:00:00`)
    .join("\n");
}

/**
 * The launchd `StartCalendarInterval` ARRAY body — one `<dict>` per hour.
 * launchd fires the job at each dict; a single dict is the 1-slot special case
 * but the array form is uniform across 1..N. Exported for testing.
 *
 * `minuteOffset` (#256): a per-install randomized Minute applied uniformly to
 * every slot (0 = no offset = pre-#256 behaviour). See `randomMinuteOffset`.
 */
export function formatLaunchdIntervals(hours: number[], minuteOffset = 0): string {
  const minute = Math.max(0, Math.min(59, Math.floor(minuteOffset)));
  return [...hours]
    .sort((a, b) => a - b)
    .map(
      (h) => `    <dict>
      <key>Hour</key>
      <integer>${h}</integer>
      <key>Minute</key>
      <integer>${minute}</integer>
    </dict>`,
    )
    .join("\n");
}

/**
 * The systemd `[Timer]` body (everything between `[Timer]` and the next stanza).
 * Exported for testing the #256 jitter line. `isInterval` selects the watchdog
 * poll form (OnBootSec + OnUnitActiveSec); otherwise one `OnCalendar` line per
 * hour. When `jitterSec > 0` a single `RandomizedDelaySec=<n>` is appended — it
 * applies to every OnCalendar entry AND to OnUnitActiveSec (systemd semantics).
 */
export function formatSystemdTimerBody(
  isInterval: boolean,
  intervalSec: number,
  hours: number[],
  jitterSec: number,
): string {
  const base = isInterval
    ? `OnBootSec=2min\nOnUnitActiveSec=${Math.round(intervalSec / 60)}min`
    : formatOnCalendarLines(hours);
  const jitter = jitterSec > 0 ? `\nRandomizedDelaySec=${jitterSec}` : "";
  return base + jitter;
}

/**
 * Write + enable one schedule unit (timer + service on Linux, plist on macOS),
 * multi-slot. Shared by the capture and consolidation installers. Always
 * rewrites both files (the 0.17 migration decision: re-init brings an install
 * up to the resolved standard; customization is via config keys, not hand-
 * edited unit files). Logs the resolved slots.
 */
function writeScheduleUnit(opts: ScheduleUnitOpts): void {
  const binaryArgs = resolveBinaryArgs();
  // #276: verify the scheduled nightly/capture can run before writing its unit.
  verifySupervisorRuntime(binaryArgs);
  const os = platform();
  // PATH the supervisor receives — includes the dir of the node running init
  // (process.execPath) so bun/pnpm/yarn globals resolve node under launchd (#276).
  const supervisorPath = buildSupervisorPath(binaryArgs);
  // One canonical nightly log path across platforms — status output, docs,
  // and support instructions all reference this single location.
  const logPath = join(HICORTEX_HOME, "nightly.log");
  const isInterval = typeof opts.intervalSec === "number";
  if (!isInterval && (!opts.hours || opts.hours.length === 0)) {
    throw new Error("writeScheduleUnit: provide either hours or intervalSec");
  }
  // Human-readable schedule label for the log line.
  const slotLabel = isInterval
    ? `every ${Math.round((opts.intervalSec as number) / 60)} min`
    : [...(opts.hours as number[])].sort((a, b) => a - b).map((h) => `${String(h).padStart(2, "0")}:00`).join(", ");

  if (os === "darwin") {
    const plistDir = join(homedir(), "Library", "LaunchAgents");
    const plistPath = join(plistDir, `${opts.plistLabel}.plist`);

    const programArgs = [...binaryArgs, ...opts.nightlyArgs]
      .map((a) => `    <string>${a}</string>`)
      .join("\n");
    // Schedule block: StartInterval (seconds) for the watchdog poll, or
    // StartCalendarInterval as an ARRAY of dicts (one per hour) for slots.
    // RunAtLoad ONLY on the interval (watchdog) plist — so a Mac that reboots
    // gets a first capture tick on load (~parity with systemd's OnBootSec=2min),
    // not 20 min later. The cooldown gate makes a load-time fire a cheap no-op
    // if a capture ran recently.
    //
    // #256 — jitter: launchd has no native RandomizedDelaySec, so the slot
    // plist bakes a per-install randomized Minute offset into every dict
    // (generated here, stable across reboots). The interval/watchdog plist
    // keeps its StartInterval untouched — interval timers drift naturally and
    // don't share the fixed-slot thundering-herd risk.
    const jitterSec = opts.jitterSec ?? resolveTimerJitterSeconds();
    const minuteOffset = !isInterval ? randomMinuteOffset(jitterSec) : 0;
    const scheduleBlock = isInterval
      ? `  <key>StartInterval</key>\n  <integer>${opts.intervalSec}</integer>\n  <key>RunAtLoad</key>\n  <true/>`
      : `  <key>StartCalendarInterval</key>\n  <array>\n${formatLaunchdIntervals(opts.hours as number[], minuteOffset)}\n  </array>`;

    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${opts.plistLabel}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs}
  </array>
${scheduleBlock}
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${supervisorPath}</string>
  </dict>
</dict>
</plist>`;

    mkdirSync(plistDir, { recursive: true });
    writeFileSync(plistPath, plist);
    try {
      try { execSync(`launchctl unload ${plistPath} 2>/dev/null`, { stdio: "pipe" }); } catch { /* not loaded */ }
      execSync(`launchctl load ${plistPath}`, { stdio: "pipe" });
      console.log(`  ✓ Installed ${opts.timerDesc} (${slotLabel})`);
    } catch {
      console.log(`  ⚠ Could not load plist. Load manually: launchctl load ${plistPath}`);
    }
  } else if (os === "linux") {
    const configDir = join(homedir(), ".config", "systemd", "user");
    const servicePath = join(configDir, `${opts.unitBase}.service`);
    const timerPath = join(configDir, `${opts.unitBase}.timer`);

    const execStart = [...binaryArgs, ...opts.nightlyArgs].join(" ");
    // File logging, not journal: oneshot runs on machines with a volatile
    // journal (e.g. Raspberry Pi defaults) otherwise fail without a trace.
    // Same log path as the macOS plist. append: needs systemd ≥ 240 (2018).
    const service = `[Unit]
Description=${opts.serviceDesc}

[Service]
Type=oneshot
ExecStart=${execStart}
${opts.timeoutMin ? `TimeoutStartSec=${opts.timeoutMin}min\n` : ""}StandardOutput=append:${logPath}
StandardError=append:${logPath}
Environment=PATH=${supervisorPath}
Environment=HOME=${homedir()}
WorkingDirectory=${homedir()}`;

    // Timer body: OnUnitActiveSec (interval, watchdog) or one OnCalendar line
    // per hour (multi-slot). systemd ORs multiple OnCalendar entries.
    // #256 — a single RandomizedDelaySec=<jitterSec> applies to all entries.
    const jitterSec = opts.jitterSec ?? resolveTimerJitterSeconds();
    const timerBody = formatSystemdTimerBody(
      isInterval,
      (opts.intervalSec as number) ?? 0,
      (opts.hours as number[]) ?? [],
      jitterSec,
    );
    const timer = `[Unit]
Description=${opts.timerDesc}

[Timer]
${timerBody}
Persistent=true

[Install]
WantedBy=timers.target`;

    mkdirSync(configDir, { recursive: true });
    // Always rewrite both .service and .timer (0.17 migration: re-init adopts
    // the resolved standard schedule; the config keys are the tuning surface).
    writeFileSync(servicePath, service);
    writeFileSync(timerPath, timer);
    try {
      execSync("systemctl --user daemon-reload", { stdio: "pipe" });
      execSync(`systemctl --user enable --now ${opts.unitBase}.timer`, { stdio: "pipe" });
      console.log(`  ✓ Installed ${opts.unitBase}.timer (${slotLabel})`);
    } catch {
      console.log(
        `  ⚠ Could not enable ${opts.unitBase}.timer. Enable manually: ` +
        `systemctl --user enable --now ${opts.unitBase}.timer`,
      );
    }
  }
}

/**
 * Install the CAPTURE WATCHDOG timer — a short-interval poll that fires
 * `nightly --capture-only --watchdog`. The watchdog itself throttles by the
 * success-cooldown (`captureCooldownHours`) and preflights, so a transient
 * fire-instant network miss retries in minutes, not at the next daily slot
 * (#239). Installed UNIFORMLY for client + server/co-located (one capture
 * mechanism everywhere — no per-topology branch).
 */
function installCaptureWatchdogTimer(): void {
  writeScheduleUnit({
    unitBase: "hicortex-capture",
    plistLabel: "com.gamaze.hicortex-capture",
    serviceDesc: "Hicortex Capture Watchdog (denoise + POST /distill, throttled)",
    timerDesc: "Hicortex Capture Watchdog",
    nightlyArgs: ["nightly", "--capture-only", "--watchdog"],
    intervalSec: CAPTURE_WATCHDOG_INTERVAL_MIN * 60,
    timeoutMin: 30, // backstop only — capture is no-LLM, bounded; 30min catches a stuck POST
  });
}

/**
 * Install the CONSOLIDATION timer (full `nightly`). Reuses the existing
 * `hicortex-nightly` unit name (repurposed from the pre-0.17 single full-nightly).
 */
function installConsolidationTimer(hours: number[]): void {
  writeScheduleUnit({
    unitBase: "hicortex-nightly",
    plistLabel: "com.gamaze.hicortex-nightly",
    serviceDesc: "Hicortex Nightly (capture + consolidate)",
    timerDesc: "Hicortex Consolidation Timer",
    nightlyArgs: ["nightly"],
    hours,
    // Backstop only (NOT an operating limit) — set well above the longest
    // legitimate run so it catches a true hang, never a slow-but-progressing
    // one. ~5000 LLM calls × ~1–3s/call ≈ 1.4–4.2h → 6h clears it with margin.
    // Coupled to the consolidateMaxLlmCalls budget (#241): raise together.
    timeoutMin: 360,
  });
}

/**
 * Remove the consolidation timer + service (and the macOS plist). Used on
 * CLIENT installs: clients have no local DB, so a pre-0.17 `hicortex-nightly`
 * timer (which auto-capture-onlys on clients) is redundant with the new capture
 * timer — remove it so it doesn't double-fire.
 */
function removeConsolidationTimer(): void {
  const os = platform();
  if (os === "darwin") {
    const plistPath = join(homedir(), "Library", "LaunchAgents", "com.gamaze.hicortex-nightly.plist");
    if (existsSync(plistPath)) {
      try { execSync(`launchctl unload ${plistPath} 2>/dev/null`, { stdio: "pipe" }); } catch { /* not loaded */ }
      try { rmSync(plistPath); console.log("  ✓ Removed legacy nightly timer (client mode — capture-only)"); } catch { /* leave it */ }
    }
  } else if (os === "linux") {
    try { execSync("systemctl --user disable --now hicortex-nightly.timer 2>/dev/null", { stdio: "pipe" }); } catch { /* not installed */ }
    const unitDir = join(homedir(), ".config", "systemd", "user");
    let removed = false;
    for (const name of ["hicortex-nightly.timer", "hicortex-nightly.service"]) {
      const p = join(unitDir, name);
      if (existsSync(p)) {
        try { rmSync(p); removed = true; } catch { /* leave it */ }
      }
    }
    if (removed) {
      try { execSync("systemctl --user daemon-reload 2>/dev/null", { stdio: "pipe" }); } catch { /* fine */ }
      console.log("  ✓ Removed legacy nightly timer (client mode — capture-only)");
    }
  }
}
