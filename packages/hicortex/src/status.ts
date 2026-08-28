/**
 * Hicortex status — show current configuration and stats.
 */

import { hicortexHome } from "./paths.js";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { execSync } from "node:child_process";
import { resolveDbPath } from "./db.js";
import { getValidatedLicense } from "./features.js";
import { describeLastNightly } from "./state.js";
import { resolveAgentIdentity } from "./identity-store.js";
import { labelForType } from "./type-labels.js";

const HICORTEX_HOME = hicortexHome();
const CC_SETTINGS = join(homedir(), ".claude", "settings.json");
const OC_CONFIG = join(homedir(), ".openclaw", "openclaw.json");

/**
 * The value shown after "Agent name:" in `hicortex status` (#179, A3). Reports
 * EXACTLY what the CC hook resolves (shared `resolveAgentIdentity`), so the
 * operator never keys `identityAgents`/`agents/<id>/` on an id the install does
 * not actually send. Unset → the install sends no `?agent=` and shares the
 * global identity (CC default). A configured-but-unsanitizable value is called
 * out as invalid (the hook sends none) rather than silently accepted.
 */
export function statusAgentLine(config: Record<string, unknown>): string {
  const id = resolveAgentIdentity(config);
  switch (id.source) {
    case "configured":
      return id.agentId as string;
    case "invalid-config":
      return `(invalid configured value "${id.rawConfigured}" — fix config.agentName; hook sends none)`;
    default: // unset
      return "(not set — global identity)";
  }
}

/**
 * Format the memory-type breakdown for `hicortex status`. Each raw DB enum key
 * is rendered through {@link labelForType} so the printed line uses the human
 * vocabulary (Knowledge/Experience/Decisions/Learnings), not the raw enum.
 * Extracted from `runStatus` so the labeling is unit-testable without booting
 * the full status printer. Unknown keys pass through verbatim (forward-compat).
 */
export function formatTypeBreakdown(byType: Record<string, number>): string {
  return Object.entries(byType)
    .map(([k, v]) => `${labelForType(k)}=${v}`)
    .join(", ");
}

export async function runStatus(): Promise<void> {
  console.log("Hicortex Status");
  console.log("─".repeat(40));

  // DB
  const dbPath = resolveDbPath();
  const dbExists = existsSync(dbPath);
  console.log(`DB:           ${dbPath} ${dbExists ? "" : "(not found)"}`);

  if (dbExists) {
    try {
      const { initDb, getStats } = await import("./db.js");
      const db = initDb(dbPath);
      const stats = getStats(db, dbPath);
      const typeStr = formatTypeBreakdown(stats.by_type);
      console.log(`Memories:     ${stats.memories} (${typeStr || "none"})`);
      console.log(`Links:        ${stats.links}`);
      console.log(`DB size:      ${(stats.db_size_bytes / 1024).toFixed(1)} KB`);
      db.close();
    } catch (err) {
      console.log(`DB error:     ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Config: license key + auth token
  const configPath = join(HICORTEX_HOME, "config.json");
  let licenseKey = "";
  let savedAuthToken = "";
  let isClientMode = false;
  let parsedConfig: Record<string, unknown> = {};
  try {
    parsedConfig = JSON.parse(readFileSync(configPath, "utf-8"));
    licenseKey = (parsedConfig.licenseKey as string | undefined) ?? "";
    savedAuthToken = (parsedConfig.authToken as string | undefined) ?? "";
    isClientMode = parsedConfig.mode === "client";
  } catch { /* no config */ }
  const validated = getValidatedLicense();
  if (validated?.valid && validated.tier) {
    console.log(`License:      ${validated.tier} (licensed)`);
  } else if (licenseKey) {
    console.log(`License:      key configured (not yet validated)`);
  } else {
    console.log(`License:      noncommercial (no key)`);
  }
  if (!isClientMode && savedAuthToken) {
    console.log(`Auth token:   ${savedAuthToken}  (clients connect with this token)`);
  } else if (!isClientMode && !savedAuthToken) {
    console.log(`Auth token:   not configured (run: npx @gamaze/hicortex init)`);
  }

  // Per-agent identity id (#179) — the id this install sends as ?agent= and the
  // key operators use for identityAgents / agents/<id>/ dirs.
  console.log(`Agent name:   ${statusAgentLine(parsedConfig)}`);

  console.log();

  // Adapters
  console.log("Adapters:");

  // OC
  let ocInstalled = false;
  try {
    const raw = readFileSync(OC_CONFIG, "utf-8");
    const config = JSON.parse(raw);
    const entries = config?.plugins?.entries ?? {};
    const installs = config?.plugins?.installs ?? {};
    ocInstalled = "hicortex" in entries || "hicortex" in installs;
  } catch { /* no OC */ }
  console.log(`  OC plugin:  ${ocInstalled ? "installed" : "not found"}`);

  // CC
  let ccRegistered = false;
  let ccUrl = "";
  try {
    const raw = readFileSync(CC_SETTINGS, "utf-8");
    const settings = JSON.parse(raw);
    const hc = settings?.mcpServers?.hicortex;
    if (hc) {
      ccRegistered = true;
      ccUrl = hc.url ?? "";
    }
  } catch { /* no CC settings */ }
  console.log(`  CC MCP:     ${ccRegistered ? `registered → ${ccUrl}` : "not registered"}`);

  // Pi (#348): the bundled extension at ~/.pi/agent/extensions/hicortex.ts.
  // "not found" = no Pi on this machine; "not installed" = Pi present, run
  // init to place the extension.
  const piAgentDir = join(homedir(), ".pi", "agent");
  if (existsSync(piAgentDir)) {
    const piInstalled = existsSync(join(piAgentDir, "extensions", "hicortex.ts"));
    console.log(`  Pi plugin:  ${piInstalled ? "installed" : "not installed (run: npx @gamaze/hicortex init)"}`);
  } else {
    console.log("  Pi plugin:  not found");
  }

  // opencode (#347): the bundled plugin at ~/.config/opencode/plugins/hicortex.ts.
  // "not found" = no opencode on this machine; "not installed" = opencode
  // present, run init to place the plugin.
  const opencodeConfigDir = join(homedir(), ".config", "opencode");
  const opencodeDataDir = join(homedir(), ".local", "share", "opencode");
  if (existsSync(opencodeConfigDir) || existsSync(opencodeDataDir)) {
    const openCodeInstalled = existsSync(join(opencodeConfigDir, "plugins", "hicortex.ts"));
    console.log(`  opencode:   ${openCodeInstalled ? "installed" : "not installed (run: npx @gamaze/hicortex init)"}`);
  } else {
    console.log("  opencode:   not found");
  }

  console.log();

  // Server status. /health/detail carries the diagnostics (version, memories,
  // llm) — /health itself is the public minimal {status:"ok"} probe (#253).
  // localhost bypasses auth, so on-box `hicortex status` gets the fields.
  console.log("Server:");
  let serverRunning = false;
  try {
    const resp = await fetch("http://127.0.0.1:8787/health/detail", {
      signal: AbortSignal.timeout(2000),
    });
    if (resp.ok) {
      const data = await resp.json() as Record<string, unknown>;
      serverRunning = true;
      console.log(`  Status:     running (${data.llm})`);
    }
  } catch { /* not running */ }
  if (!serverRunning) console.log("  Status:     not running");

  // Daemon
  const os = platform();
  if (os === "darwin") {
    try {
      const out = execSync("launchctl list 2>/dev/null | grep hicortex", { encoding: "utf-8" });
      console.log(`  Daemon:     launchd (${out.trim() ? "loaded" : "not loaded"})`);
    } catch {
      console.log("  Daemon:     launchd (not installed)");
    }
  } else if (os === "linux") {
    try {
      const out = execSync("systemctl --user is-active hicortex.service 2>/dev/null", { encoding: "utf-8" }).trim();
      console.log(`  Daemon:     systemd (${out})`);
    } catch {
      console.log("  Daemon:     systemd (not installed)");
    }
  }

  // Last nightly run
  const lastRun = describeLastNightly();
  if (!lastRun) {
    console.log("  Last run:   never (run: hicortex nightly)");
  } else if (lastRun.invalid) {
    console.log(`  Last run:   ${lastRun.timestamp} (invalid timestamp)`);
  } else {
    console.log(`  Last run:   ${lastRun.timestamp} (${lastRun.ageStr})`);
    if (lastRun.stale) {
      console.log(`  ⚠ Nightly pipeline hasn't run in ${lastRun.ageHours}h. Check: hicortex nightly --dry-run`);
    }
  }

  // Distillation stats (if DB exists)
  if (dbExists) {
    const TOP_SOURCES_LIMIT = 5;
    try {
      const { initDb } = await import("./db.js");
      const db2 = initDb(dbPath);
      // Count memories by source
      const rows = db2.prepare(
        `SELECT source_agent, COUNT(*) as cnt FROM memories GROUP BY source_agent ORDER BY cnt DESC LIMIT ${TOP_SOURCES_LIMIT}`
      ).all() as Array<{ source_agent: string; cnt: number }>;
      if (rows.length > 0) {
        console.log("  Sources:");
        for (const r of rows) {
          const agent = r.source_agent || "unknown";
          console.log(`    ${agent}: ${r.cnt}`);
        }
      }
      db2.close();
    } catch (err) {
      console.log(`  Sources:    (error: ${err instanceof Error ? err.message : String(err)})`);
    }
  }
}
