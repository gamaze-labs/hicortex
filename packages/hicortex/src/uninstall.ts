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

/**
 * Matches a CC SessionStart hook `command` that runs the Hicortex
 * identity/learnings hook — the canonical `learnings-identity` (#264) OR the
 * legacy `lessons-context` alias. Exported so the uninstall behavior (which
 * name variants get cleaned up) is unit-testable without spinning up CC.
 * Word-boundary guard so "learnings-identity" never matches a hypothetical
 * "learnings-identity-foo", the two names stay distinct from each other, and
 * neither collides with the sibling `recall-hook` SessionStart hook.
 */
export const SESSION_START_HOOK_COMMAND_RE = /(^|\s)(?:learnings-identity|lessons-context)(\s|$)/;

/** True when a CC hook `command` string runs the Hicortex SessionStart hook. */
export function isHicortexSessionStartHook(command: string): boolean {
  return typeof command === "string" && SESSION_START_HOOK_COMMAND_RE.test(command);
}

/**
 * Matches a CC hook `command` that runs the Hicortex recall hook — the
 * `recall-hook` subcommand (#192). Same word-boundary discipline as the
 * learnings matcher: an unrelated command that merely CONTAINS the substring
 * ("my-recall-hook", "recall-hooks-old") is never swept up. Used for BOTH
 * event arrays the installer writes (UserPromptSubmit + SessionStart).
 */
export const RECALL_HOOK_COMMAND_RE = /(^|\s)recall-hook(\s|$)/;

/** True when a CC hook `command` string runs the Hicortex recall hook. */
export function isHicortexRecallHook(command: string): boolean {
  return typeof command === "string" && RECALL_HOOK_COMMAND_RE.test(command);
}

/** One hook group removed from settings.json (for per-group logging). */
export interface RemovedHookGroup {
  /** CC event array the entries were removed from ("SessionStart", "UserPromptSubmit"). */
  event: string;
  /** Which Hicortex hook set: "learnings" (learnings-identity/lessons-context) or "recall". */
  kind: "learnings" | "recall";
  /** Number of matcher entries removed. */
  count: number;
}

/**
 * Remove every Hicortex hook entry from a PARSED ~/.claude/settings.json
 * (#327): the SessionStart learnings hook (canonical + legacy alias) AND the
 * recall-hook pair (UserPromptSubmit + SessionStart, installed together by
 * installRecallHooks — leaving either behind is a silent npx spawn per prompt
 * forever). Mutates `settings` in place; returns what was removed (empty when
 * nothing matched — a clean no-op). Exact-match discipline throughout: only
 * entries whose `hooks[].command` matches a Hicortex subcommand are removed;
 * foreign hooks (and prefix-colliding names) stay untouched.
 *
 * Pure on the parsed object so the uninstall behavior is unit-testable
 * without spinning up CC; runUninstall owns the file I/O.
 */
export function removeHicortexCcHooks(settings: Record<string, unknown>): RemovedHookGroup[] {
  const hooks = settings.hooks as Record<string, unknown> | undefined;
  if (!hooks || typeof hooks !== "object") return [];

  const groups: Array<{
    event: string;
    kind: "learnings" | "recall";
    match: (command: string) => boolean;
  }> = [
    { event: "SessionStart", kind: "learnings", match: isHicortexSessionStartHook },
    { event: "SessionStart", kind: "recall", match: isHicortexRecallHook },
    { event: "UserPromptSubmit", kind: "recall", match: isHicortexRecallHook },
  ];

  const removed: RemovedHookGroup[] = [];
  for (const g of groups) {
    const arr = hooks[g.event];
    if (!Array.isArray(arr)) continue;
    const filtered = arr.filter((entry) => {
      if (typeof entry !== "object" || entry === null) return true;
      const e = entry as Record<string, unknown>;
      if (Array.isArray(e.hooks)) {
        return !e.hooks.some(
          (h: unknown) =>
            typeof h === "object" &&
            h !== null &&
            typeof (h as Record<string, unknown>).command === "string" &&
            g.match((h as Record<string, unknown>).command as string),
        );
      }
      return true;
    });
    if (filtered.length < arr.length) {
      // Drop the event key entirely when the filter emptied it — no
      // `"UserPromptSubmit": []` husk left in the settings file.
      if (filtered.length > 0) hooks[g.event] = filtered;
      else delete hooks[g.event];
      removed.push({ event: g.event, kind: g.kind, count: arr.length - filtered.length });
    }
  }
  return removed;
}

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

  // 4. Remove ALL Hicortex CC hooks (#327): the SessionStart learnings hook
  //    (canonical `learnings-identity` OR the legacy `lessons-context` alias,
  //    #264 backcompat) AND BOTH `recall-hook` entries (UserPromptSubmit +
  //    SessionStart — installed as a pair by installRecallHooks; leaving
  //    either behind keeps a silent npx spawn per prompt forever).
  //    Fail-soft when absent; word-boundary matchers never touch foreign hooks.
  try {
    const raw = readFileSync(CC_SETTINGS, "utf-8");
    const settings = JSON.parse(raw) as Record<string, unknown>;
    const removed = removeHicortexCcHooks(settings);
    if (removed.length > 0) {
      writeFileSync(CC_SETTINGS, JSON.stringify(settings, null, 2));
      for (const r of removed) {
        const name = r.kind === "learnings" ? "learnings-identity" : "recall-hook";
        console.log(`  ✓ Removed ${r.event} ${name} hook${r.count > 1 ? "s" : ""}`);
      }
    }
  } catch { /* no settings file or parse error — nothing to remove */ }

  // 5. Remove CLAUDE.md block (old static block from pre-0.9.0; may still exist on upgrades)
  if (removeLessonsBlock(CLAUDE_MD)) {
    console.log("  ✓ Removed Hicortex Learnings block from CLAUDE.md");
  }

  // 6. Remove the Pi extension (#348). Guarded on the "hicortex" marker the
  //    installer always ships — "hicortex.ts" is a plausible user filename,
  //    and uninstall never deletes a file we did not write. Fail-soft when
  //    absent (no Pi on the machine) or unreadable.
  const piExtension = join(homedir(), ".pi", "agent", "extensions", "hicortex.ts");
  if (existsSync(piExtension)) {
    try {
      if (readFileSync(piExtension, "utf-8").toLowerCase().includes("hicortex")) {
        unlinkSync(piExtension);
        console.log("  ✓ Removed Pi extension (~/.pi/agent/extensions/hicortex.ts)");
      } else {
        console.log("  ⚠ Skipping ~/.pi/agent/extensions/hicortex.ts — not a Hicortex file, left untouched");
      }
    } catch { /* unreadable — leave it */ }
  }

  // 7. Remove the opencode plugin (#347). Same marker guard — the plugins
  //    directory is shared (third-party files live there too), and uninstall
  //    never deletes a file we did not write. Fail-soft when absent (no
  //    opencode on the machine) or unreadable.
  const openCodePlugin = join(homedir(), ".config", "opencode", "plugins", "hicortex.ts");
  if (existsSync(openCodePlugin)) {
    try {
      if (readFileSync(openCodePlugin, "utf-8").toLowerCase().includes("hicortex")) {
        unlinkSync(openCodePlugin);
        console.log("  ✓ Removed opencode plugin (~/.config/opencode/plugins/hicortex.ts)");
      } else {
        console.log("  ⚠ Skipping ~/.config/opencode/plugins/hicortex.ts — not a Hicortex file, left untouched");
      }
    } catch { /* unreadable — leave it */ }
  }

  console.log(`\n✓ Uninstalled. Database preserved at ${HICORTEX_HOME}/hicortex.db`);
  console.log("  To remove all data: rm -rf ~/.hicortex");
}
