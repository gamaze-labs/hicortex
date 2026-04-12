/**
 * Hicortex status — show current configuration and stats.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { execSync } from "node:child_process";
import { resolveDbPath } from "./db.js";

const HICORTEX_HOME = join(homedir(), ".hicortex");
const CC_SETTINGS = join(homedir(), ".claude", "settings.json");
const OC_CONFIG = join(homedir(), ".openclaw", "openclaw.json");

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
      const typeStr = Object.entries(stats.by_type).map(([k, v]) => `${k}=${v}`).join(", ");
      console.log(`Memories:     ${stats.memories} (${typeStr || "none"})`);
      console.log(`Links:        ${stats.links}`);
      console.log(`DB size:      ${(stats.db_size_bytes / 1024).toFixed(1)} KB`);
      db.close();
    } catch (err) {
      console.log(`DB error:     ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // License
  const configPath = join(HICORTEX_HOME, "config.json");
  let licenseKey = "";
  try {
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    licenseKey = config.licenseKey ?? "";
  } catch { /* no config */ }
  console.log(`License:      ${licenseKey ? "configured" : "free tier (250 memories)"}`);

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

  console.log();

  // Server status
  console.log("Server:");
  let serverRunning = false;
  try {
    const resp = await fetch("http://127.0.0.1:8787/health", {
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
  const lastRunPath = join(HICORTEX_HOME, "nightly-last-run.txt");
  try {
    const ts = readFileSync(lastRunPath, "utf-8").trim();
    const lastRun = new Date(ts);
    if (isNaN(lastRun.getTime())) {
      console.log(`  Last run:   ${ts} (invalid timestamp)`);
    } else {
      const STALE_THRESHOLD_HOURS = 30;
      const ageHours = Math.round((Date.now() - lastRun.getTime()) / (60 * 60 * 1000));
      const ageStr = ageHours < 1 ? "just now" : ageHours < 24 ? `${ageHours}h ago` : `${Math.round(ageHours / 24)}d ago`;
      console.log(`  Last run:   ${ts} (${ageStr})`);

      // Show staleness warning if missed a night
      if (ageHours > STALE_THRESHOLD_HOURS) {
        console.log(`  ⚠ Nightly pipeline hasn't run in ${ageHours}h. Check: hicortex nightly --dry-run`);
      }
    }
  } catch {
    console.log("  Last run:   never (run: hicortex nightly)");
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
