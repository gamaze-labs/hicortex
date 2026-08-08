/**
 * Hicortex uninstall — clean removal of CC integration.
 * Preserves the database (user data).
 */

import { hicortexHome } from "./paths.js";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { sendLifecycleEvent } from "./telemetry.js";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { execSync } from "node:child_process";
import { createInterface } from "node:readline";
import { removeLessonsBlock } from "./claude-md.js";

const HICORTEX_HOME = hicortexHome();
const CC_SETTINGS = join(homedir(), ".claude", "settings.json");
const CC_COMMANDS_DIR = join(homedir(), ".claude", "commands");
const CLAUDE_MD = join(homedir(), ".claude", "CLAUDE.md");

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function runUninstall(): Promise<void> {
  // Churn signal (0.15.2): ping BEFORE removing anything, while state.json
  // still holds the anonymous id. Opt-out aware; failures are swallowed.
  try {
    const home = hicortexHome();
    const config = JSON.parse(readFileSync(join(home, "config.json"), "utf-8")) as Record<string, unknown>;
    const version = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8")).version as string;
    await sendLifecycleEvent("uninstall", home, config, version);
  } catch { /* no config/state or unreadable — nothing to report */ }

  console.log("Hicortex — Uninstall CC Integration\n");

  const answer = await ask("This will remove Hicortex from Claude Code. Your memory database is preserved. Continue? [y/N] ");
  if (answer.toLowerCase() !== "y") {
    console.log("Cancelled.");
    return;
  }

  console.log();

  // 1. Stop and remove daemon + capture/nightly timers (all units, or a timer
  //    keeps firing against a half-removed install). Since 0.17 there are two
  //    scheduled jobs: the capture timer (hicortex-capture) and the
  //    consolidation timer (hicortex-nightly); remove both either way (a client
  //    install has no consolidation timer, a server install has both).
  const os = platform();
  if (os === "darwin") {
    for (const name of ["com.gamaze.hicortex.plist", "com.gamaze.hicortex-nightly.plist", "com.gamaze.hicortex-capture.plist"]) {
      const plistPath = join(homedir(), "Library", "LaunchAgents", name);
      if (existsSync(plistPath)) {
        try {
          execSync(`launchctl unload ${plistPath} 2>/dev/null`);
        } catch { /* not loaded */ }
        unlinkSync(plistPath);
        console.log(`  ✓ Removed ${name}`);
      }
    }
  } else if (os === "linux") {
    try { execSync("systemctl --user disable --now hicortex.service 2>/dev/null"); } catch { /* not installed */ }
    try { execSync("systemctl --user disable --now hicortex-nightly.timer 2>/dev/null"); } catch { /* not installed */ }
    try { execSync("systemctl --user disable --now hicortex-capture.timer 2>/dev/null"); } catch { /* not installed */ }
    const unitDir = join(homedir(), ".config", "systemd", "user");
    for (const name of ["hicortex.service", "hicortex-nightly.timer", "hicortex-nightly.service", "hicortex-capture.timer", "hicortex-capture.service"]) {
      const unitPath = join(unitDir, name);
      try { if (existsSync(unitPath)) unlinkSync(unitPath); } catch { /* leave it */ }
    }
    try { execSync("systemctl --user daemon-reload 2>/dev/null"); } catch { /* fine */ }
    console.log("  ✓ Removed systemd service + capture/nightly timers");
  }

  // 2. Remove MCP from CC
  try {
    execSync("claude mcp remove hicortex 2>/dev/null", { encoding: "utf-8", stdio: "pipe" });
    console.log("  ✓ Removed MCP server via claude CLI");
  } catch {
    // Fallback: remove from settings.json directly
    try {
      const raw = readFileSync(CC_SETTINGS, "utf-8");
      const settings = JSON.parse(raw);
      if (settings?.mcpServers?.hicortex) {
        delete settings.mcpServers.hicortex;
        writeFileSync(CC_SETTINGS, JSON.stringify(settings, null, 2));
        console.log("  ✓ Removed MCP server from CC settings");
      }
    } catch { /* no settings */ }
  }

  // 3. Remove CC custom commands — only files we actually wrote. `learn.md` is
  // a generic name a user may own; guard on the "hicortex" marker the installer
  // always embedded, so uninstall never deletes an unrelated user command.
  let removedCmds = 0;
  for (const cmd of ["learn.md", "hicortex-activate.md"]) {
    const cmdPath = join(CC_COMMANDS_DIR, cmd);
    if (!existsSync(cmdPath)) continue;
    try {
      if (!readFileSync(cmdPath, "utf-8").toLowerCase().includes("hicortex")) {
        console.log(`  ⚠ Skipping ${cmd} — not a Hicortex file, left untouched`);
        continue;
      }
    } catch { continue; }
    unlinkSync(cmdPath);
    removedCmds++;
  }
  if (removedCmds > 0) console.log(`  ✓ Removed ${removedCmds} legacy CC command${removedCmds > 1 ? "s" : ""} (/learn, /hicortex-activate)`);

  // 4. Remove SessionStart hook (JSON merge — filter out entries containing "lessons-context")
  try {
    const raw = readFileSync(CC_SETTINGS, "utf-8");
    const settings = JSON.parse(raw) as Record<string, unknown>;
    const hooks = settings.hooks as Record<string, unknown> | undefined;
    const sessionStart = hooks && Array.isArray(hooks.SessionStart) ? hooks.SessionStart as Array<unknown> : null;
    if (hooks && sessionStart) {
      const before = sessionStart.length;
      const filtered = sessionStart.filter((entry) => {
        if (typeof entry !== "object" || entry === null) return true;
        const e = entry as Record<string, unknown>;
        if (Array.isArray(e.hooks)) {
          return !e.hooks.some((h: unknown) => {
            if (typeof h !== "object" || h === null) return false;
            const hook = h as Record<string, unknown>;
            return typeof hook.command === "string" && hook.command.includes("lessons-context");
          });
        }
        return true;
      });
      if (filtered.length < before) {
        hooks.SessionStart = filtered;
        writeFileSync(CC_SETTINGS, JSON.stringify(settings, null, 2));
        console.log("  ✓ Removed SessionStart lessons-context hook");
      }
    }
  } catch { /* no settings file or parse error — nothing to remove */ }

  // 5. Remove CLAUDE.md block (old static block from pre-0.9.0; may still exist on upgrades)
  if (removeLessonsBlock(CLAUDE_MD)) {
    console.log("  ✓ Removed Hicortex Learnings block from CLAUDE.md");
  }

  console.log(`\n✓ Uninstalled. Database preserved at ${HICORTEX_HOME}/hicortex.db`);
  console.log("  To remove all data: rm -rf ~/.hicortex");
}
