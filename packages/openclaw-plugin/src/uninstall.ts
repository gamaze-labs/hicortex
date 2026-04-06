/**
 * Hicortex uninstall — clean removal of CC integration.
 * Preserves the database (user data).
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { execSync } from "node:child_process";
import { createInterface } from "node:readline";
import { removeLessonsBlock } from "./claude-md.js";

const HICORTEX_HOME = join(homedir(), ".hicortex");
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
  console.log("Hicortex — Uninstall CC Integration\n");

  const answer = await ask("This will remove Hicortex from Claude Code. Your memory database is preserved. Continue? [y/N] ");
  if (answer.toLowerCase() !== "y") {
    console.log("Cancelled.");
    return;
  }

  console.log();

  // 1. Stop and remove daemon
  const os = platform();
  if (os === "darwin") {
    const plistPath = join(homedir(), "Library", "LaunchAgents", "com.gamaze.hicortex.plist");
    if (existsSync(plistPath)) {
      try {
        execSync(`launchctl unload ${plistPath} 2>/dev/null`);
      } catch { /* not loaded */ }
      unlinkSync(plistPath);
      console.log("  ✓ Removed launchd daemon");
    }
  } else if (os === "linux") {
    try {
      execSync("systemctl --user disable --now hicortex.service 2>/dev/null");
      const servicePath = join(homedir(), ".config", "systemd", "user", "hicortex.service");
      if (existsSync(servicePath)) unlinkSync(servicePath);
      execSync("systemctl --user daemon-reload 2>/dev/null");
      console.log("  ✓ Removed systemd service");
    } catch { /* not installed */ }
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

  // 3. Remove CC custom commands
  for (const cmd of ["learn.md", "hicortex-activate.md"]) {
    const cmdPath = join(CC_COMMANDS_DIR, cmd);
    if (existsSync(cmdPath)) {
      unlinkSync(cmdPath);
    }
  }
  console.log("  ✓ Removed /learn and /hicortex-activate commands");

  // 4. Remove CLAUDE.md block
  if (removeLessonsBlock(CLAUDE_MD)) {
    console.log("  ✓ Removed Hicortex Learnings block from CLAUDE.md");
  }

  console.log(`\n✓ Uninstalled. Database preserved at ${HICORTEX_HOME}/hicortex.db`);
  console.log("  To remove all data: rm -rf ~/.hicortex");
}
