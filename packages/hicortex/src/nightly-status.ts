/**
 * Nightly pipeline status — lightweight check without running the pipeline.
 *
 * Shows:
 *   - Last run timestamp + age
 *   - Timer/schedule status (systemd/launchd)
 *   - DB memory count
 *   - Distillation source breakdown
 *   - Staleness warnings
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { execSync } from "node:child_process";
import { resolveDbPath } from "./db.js";
import { describeLastNightly } from "./state.js";

const HICORTEX_HOME = join(homedir(), ".hicortex");
const CONFIG_PATH = join(HICORTEX_HOME, "config.json");

export async function showNightlyStatus(): Promise<void> {
  console.log("Hicortex Nightly Pipeline Status");
  console.log("─".repeat(40));

  // Last run
  const lastRun = describeLastNightly(HICORTEX_HOME);
  if (!lastRun) {
    console.log("Last run:    never");
  } else if (lastRun.invalid) {
    console.log(`Last run:    ${lastRun.timestamp} (invalid)`);
  } else {
    console.log(`Last run:    ${lastRun.timestamp} (${lastRun.ageStr})${lastRun.stale ? " ⚠ STALE" : ""}`);
  }

  // LLM config
  try {
    const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    const backend = config.llmBackend ?? "auto-detect";
    const model = config.llmModel ?? "default";
    const mode = config.mode === "client" ? "client → " + (config.serverUrl ?? "?") : "server (local)";
    console.log(`Mode:        ${mode}`);
    console.log(`LLM backend: ${backend}${backend !== "auto-detect" ? ` (${model})` : ""}`);
  } catch {
    console.log("Config:      not configured (run: hicortex init)");
  }

  // Timer/schedule
  const os = platform();
  let timerActive = false;
  let timerInfo = "not installed";

  if (os === "darwin") {
    try {
      const out = execSync("launchctl list 2>/dev/null | grep hicortex-nightly", {
        encoding: "utf-8",
        timeout: 3000,
      });
      if (out.trim()) {
        timerActive = true;
        timerInfo = "launchd (loaded)";
      }
    } catch { /* not installed */ }
  } else if (os === "linux") {
    try {
      const active = execSync("systemctl --user is-active hicortex-nightly.timer 2>/dev/null", {
        encoding: "utf-8",
        timeout: 3000,
      }).trim();
      if (active === "active" || active === "waiting") {
        timerActive = true;
        try {
          const next = execSync("systemctl --user show hicortex-nightly.timer --property=NextElapseUSecRealtime 2>/dev/null", {
            encoding: "utf-8",
            timeout: 3000,
          }).trim();
          const match = next.match(/=(\d+)/);
          if (match) {
            const nextDate = new Date(Number(match[1]) / 1000);
            timerInfo = `systemd (active, next: ${nextDate.toISOString()})`;
          } else {
            timerInfo = `systemd (${active})`;
          }
        } catch {
          timerInfo = `systemd (${active})`;
        }
      }
    } catch { /* not installed */ }
  }

  console.log(`Timer:       ${timerInfo}${!timerActive ? " ⚠ Pipeline will NOT run automatically" : ""}`);

  // DB stats
  const dbPath = resolveDbPath();
  if (existsSync(dbPath)) {
    try {
      const { initDb } = await import("./db.js");
      const db = initDb(dbPath);
      const count = (db.prepare("SELECT COUNT(*) as c FROM memories").get() as { c: number }).c;
      let linkCount = 0;
      try {
        linkCount = (db.prepare("SELECT COUNT(*) as c FROM memory_links").get() as { c: number }).c;
      } catch {
        // memory_links table may not exist in older DBs
      }

      // Source breakdown (top 5)
      const sources = db.prepare(
        "SELECT source_agent, COUNT(*) as cnt FROM memories GROUP BY source_agent ORDER BY cnt DESC LIMIT 5"
      ).all() as Array<{ source_agent: string; cnt: number }>;

      console.log(`\nMemories:    ${count} (${linkCount} links)`);
      if (sources.length > 0) {
        console.log("Sources:");
        for (const s of sources) {
          console.log(`  ${s.source_agent || "unknown"}: ${s.cnt}`);
        }
      }
      db.close();
    } catch (err) {
      console.log(`\nDB:          error (${err instanceof Error ? err.message : String(err)})`);
    }
  } else {
    console.log(`\nDB:          not found (run: hicortex init)`);
  }

  // Health assessment
  console.log("\n" + "─".repeat(40));
  const issues: string[] = [];
  if (!lastRun) issues.push("Pipeline has never run. Run: hicortex nightly");
  else if (lastRun.stale) {
    issues.push("Pipeline hasn't run in 30+ hours. Check timer.");
  }
  if (!timerActive) issues.push("No timer installed. Nightly pipeline won't run automatically.");
  if (!existsSync(dbPath)) issues.push("No database found. Run: hicortex init");

  if (issues.length === 0) {
    console.log("✓ Nightly pipeline healthy");
  } else {
    console.log("Issues:");
    for (const issue of issues) {
      console.log(`  ⚠ ${issue}`);
    }
  }
}
