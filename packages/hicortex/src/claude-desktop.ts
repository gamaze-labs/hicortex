/**
 * Claude Desktop auto-configuration (#381) — the init-side writer for the
 * `claude_desktop_config.json` MCP entry.
 *
 * Claude Desktop's ONLY stdio MCP route is this hand-edited file (no CLI, no
 * plugin discovery), which is why Desktop never had an init step while CC
 * (`claude mcp add`), Pi, and opencode (dropped extension files) did. The
 * 0.20.4 `hicortex mcp` stdio bridge makes such an entry meaningful, so init
 * now offers to write it — the same auto-detect pattern as the other
 * harnesses, gated on the Claude Desktop config DIRECTORY existing (the
 * config FILE may not exist yet; creating it fresh is in scope).
 *
 * Two properties dominate the design:
 *
 *   1. IT IS ANOTHER APP'S FILE. `claude_desktop_config.json` is owned by
 *      Claude Desktop and carries the user's other servers and app settings.
 *      The write is therefore merge-safe (preserve EVERY top-level key and
 *      every other server; touch only `mcpServers.hicortex`), takes a
 *      timestamped `.bak` copy of the existing file first, lands via
 *      tmp-write + JSON-validate + rename in the same directory (atomic),
 *      and REFUSES — touching nothing, not even a backup — when the existing
 *      file is not valid JSON. Unlike our own config.json there is no repair
 *      flow here (quarantening another app's config would break IT); the
 *      user fixes the file by hand with the snippet init prints.
 *
 *   2. THE COMMAND MUST BE AN ABSOLUTE NPX PATH. Desktop is a GUI app and
 *      does not inherit the shell PATH — a bare "npx" command is the #1
 *      Desktop MCP failure mode. Resolution walks PATH plus the common
 *      install locations and rejects npm's ephemeral `/_npx/` cache (#176: a
 *      path that dies on the next cache GC — the entry would break silently
 *      weeks later). Unresolvable → manual instructions, nothing written.
 *      Windows .cmd shims cannot be spawned by Electron without a shell, so
 *      they are wrapped in `cmd /c`.
 *
 * Every helper is pure/parametrised (platform/env/home/exists injected) so
 * the suite covers darwin/win32/linux without touching a real machine. This
 * module deliberately imports NOTHING from init.ts (init imports this — no
 * cycle); the package spec is passed in from init's getPackageSpec().
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  copyFileSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { join, dirname, basename } from "node:path";
import { homedir, platform as osPlatform } from "node:os";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Config-dir detection
// ---------------------------------------------------------------------------

/**
 * The Claude Desktop config directory for this platform, or null where no
 * Desktop build exists (Linux → silent skip). Parametrised so tests cover
 * the platform matrix without a real machine. Detection in init is
 * `desktopConfigDir() !== null && existsSync(dir)` — the config FILE itself
 * may legitimately not exist yet.
 */
export function desktopConfigDir(
  platform: NodeJS.Platform = osPlatform(),
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string | null {
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "Claude");
  }
  if (platform === "win32") {
    // %APPDATA% is the documented location; the AppData\Roaming fallback
    // covers shells/services where the env var is not exported.
    return join(env.APPDATA ?? join(home, "AppData", "Roaming"), "Claude");
  }
  return null;
}

// ---------------------------------------------------------------------------
// npx resolution
// -----------------------------------------------------------------

export interface DesktopNpxResolveOptions {
  /** The PATH string to search (default: process.env.PATH). */
  pathEnv?: string;
  /** Platform under test (default: the real one). */
  platform?: NodeJS.Platform;
  /** Home dir for the ~-relative common locations (default: homedir()). */
  home?: string;
  /** Env for APPDATA on win32 (default: process.env). */
  env?: Record<string, string | undefined>;
  /** Existence seam (default: existsSync) — unit tests pass fixture sets. */
  exists?: (candidatePath: string) => boolean;
}

/**
 * Candidate npx paths in resolution order: every PATH dir first, then the
 * common install locations. On win32 each dir contributes `npx.cmd` before
 * `npx.exe` (the cmd shim is what npm actually installs there).
 */
function candidateNpxPaths(
  platform: NodeJS.Platform,
  pathEnv: string,
  home: string,
  env: Record<string, string | undefined>,
): string[] {
  const names = platform === "win32" ? ["npx.cmd", "npx.exe"] : ["npx"];
  const delimiter = platform === "win32" ? ";" : ":";
  const pathDirs = pathEnv.split(delimiter).filter(Boolean);

  const commonDirs =
    platform === "win32"
      ? [
          // The npm global bin dir (%APPDATA%\npm) and the Node installer's
          // dir — where a GUI-launched Desktop is most likely to find npx
          // even when PATH (a shell concept) carries nothing useful.
          join(env.APPDATA ?? join(home, "AppData", "Roaming"), "npm"),
          "C:\\Program Files\\nodejs",
        ]
      : [
          "/opt/homebrew/bin",
          "/usr/local/bin",
          join(home, ".npm-global", "bin"),
          join(home, ".volta", "bin"),
        ];

  return [...pathDirs, ...commonDirs].flatMap((dir) => names.map((name) => join(dir, name)));
}

/**
 * Resolve an ABSOLUTE npx path for the Desktop entry, or null when nothing
 * durable exists (init then prints manual instructions and writes nothing).
 * Rejects npm's ephemeral npx cache in BOTH separator spellings — unix
 * `/_npx/` and Windows `\_npx\` — a bare includes("/_npx/") would let the
 * win32 form through (#176: the path dies on the next cache GC).
 */
export function resolveDesktopNpxPath(options: DesktopNpxResolveOptions = {}): string | null {
  const platform = options.platform ?? osPlatform();
  const pathEnv = options.pathEnv ?? process.env.PATH ?? "";
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;

  for (const candidate of candidateNpxPaths(platform, pathEnv, home, env)) {
    if (candidate.includes("/_npx/") || candidate.includes("\\_npx\\")) continue;
    if (exists(candidate)) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Entry construction
// ---------------------------------------------------------------------------

/** The `mcpServers.hicortex` value — a Claude Desktop stdio server entry. */
export interface DesktopServerEntry {
  command: string;
  args: string[];
  /** Only in remote mode; absent (not empty) in local/loopback mode. */
  env?: Record<string, string>;
}

/**
 * Build the stdio entry for the `hicortex mcp` bridge. NO "type" field —
 * stdio is implied for Desktop entries (the CC `.claude.json` writer needs
 * `"type":"sse"`; this is the other shape). A `.cmd`/`.bat` shim is wrapped
 * in `cmd /c` because Electron spawns without a shell and cannot exec a cmd
 * script directly. An empty/absent env omits the key entirely — a local
 * entry must carry no env (the bridge autostarts the daemon; loopback
 * bypasses auth).
 */
export function buildDesktopServerEntry(
  npxPath: string,
  packageSpec: string,
  env?: Record<string, string>,
): DesktopServerEntry {
  const entry: DesktopServerEntry = /\.(cmd|bat)$/i.test(npxPath)
    ? { command: "cmd", args: ["/c", npxPath, "-y", packageSpec, "mcp"] }
    : { command: npxPath, args: ["-y", packageSpec, "mcp"] };
  if (env && Object.keys(env).length > 0) entry.env = { ...env };
  return entry;
}

/**
 * Loopback check for a server URL — decides whether the Desktop entry needs
 * an env block at all (local: none, the bridge resolves + autostarts the
 * daemon; remote: URL + token). Mirrors mcp-stdio's isLoopbackHost (kept
 * local rather than imported to avoid dragging the SDK into init's graph).
 * An unparseable URL is NOT local — fail toward carrying the env, which
 * still works everywhere the URL is real.
 */
export function isLocalServerUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Merge + write
// ---------------------------------------------------------------------------

export type DesktopMergeResult =
  | { ok: true; config: Record<string, unknown> }
  | { ok: false; reason: string };

/**
 * Parse the existing config text and merge our entry in, preserving every
 * top-level key and every other server. `rawText === null` means "no file"
 * (fresh install — a config containing only our entry is created). Malformed
 * JSON, a non-object document, or a non-object `mcpServers` value returns
 * `{ ok: false }` — the caller refuses to write, so the ORIGINAL file and
 * its bytes are what the user keeps.
 */
export function mergeDesktopServerConfig(
  rawText: string | null,
  entry: DesktopServerEntry,
): DesktopMergeResult {
  if (rawText === null) {
    return { ok: true, config: { mcpServers: { hicortex: entry } } };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (e) {
    return {
      ok: false,
      reason:
        `the file is not valid JSON (${e instanceof Error ? e.message : String(e)}) — ` +
        `fix it by hand and re-run init`,
    };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    const kind = parsed === null ? "null" : Array.isArray(parsed) ? "an array" : typeof parsed;
    return { ok: false, reason: `the file parses to ${kind}, not a JSON object — fix it by hand and re-run init` };
  }

  const config: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };
  const existing = config.mcpServers;
  if (existing !== undefined && (typeof existing !== "object" || existing === null || Array.isArray(existing))) {
    const kind = Array.isArray(existing) ? "an array" : typeof existing;
    return { ok: false, reason: `"mcpServers" is ${kind}, not an object — fix it by hand and re-run init` };
  }

  config.mcpServers = { ...(existing as Record<string, unknown> | undefined), hicortex: entry };
  return { ok: true, config };
}

export type DesktopWriteResult =
  | { status: "written"; backupPath?: string }
  | { status: "refused"; reason: string }
  | { status: "failed"; reason: string };

/**
 * Orchestrate the merge-safe, atomic write of our entry into
 * `claude_desktop_config.json`:
 *
 *   1. Read the existing file (ENOENT → fresh-install path).
 *   2. Merge; a malformed/shape-refused file → `{ status: "refused" }` with
 *      NOTHING touched — no backup, no tmp, no bytes changed.
 *   3. Copy the existing file to `<path>.bak-<ISO-colons-stripped>` BEFORE
 *      writing (the quarantineMalformedConfig naming convention).
 *   4. Write the serialized payload to a tmp file in the SAME directory
 *      (same filesystem → the rename is atomic), JSON-parse the exact bytes
 *      that landed on disk, then renameSync over the target.
 *
 * Any unexpected I/O error returns `{ status: "failed" }` after removing the
 * tmp file — a half-written tmp must never masquerade as a config. Never
 * throws; the init wiring turns every non-"written" result into a printed
 * warning and init continues.
 */
export function writeDesktopServerConfig(
  configPath: string,
  entry: DesktopServerEntry,
): DesktopWriteResult {
  // 1. Read — only a genuinely-absent file (ENOENT) is a fresh install.
  let raw: string | null = null;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      return { status: "failed", reason: `could not read ${configPath}: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  // 2. Merge — refusal happens BEFORE any disk mutation (step 3+).
  const merged = mergeDesktopServerConfig(raw, entry);
  if (!merged.ok) {
    return { status: "refused", reason: `Refusing to write ${configPath}: ${merged.reason}` };
  }

  const payload = JSON.stringify(merged.config, null, 2);
  let tmpPath: string | undefined;
  try {
    const dir = dirname(configPath);
    mkdirSync(dir, { recursive: true });

    // 3. Backup the existing file BEFORE any write of ours.
    let backupPath: string | undefined;
    if (raw !== null) {
      backupPath = `${configPath}.bak-${new Date().toISOString().replace(/:/g, "-")}`;
      copyFileSync(configPath, backupPath);
    }

    // 4. tmp write → validate the exact on-disk bytes → atomic rename.
    tmpPath = join(dir, `${basename(configPath)}.tmp-${randomUUID().slice(0, 8)}`);
    writeFileSync(tmpPath, payload);
    JSON.parse(readFileSync(tmpPath, "utf-8"));
    renameSync(tmpPath, configPath);
    tmpPath = undefined; // committed — nothing left to clean up

    return backupPath === undefined ? { status: "written" } : { status: "written", backupPath };
  } catch (e) {
    if (tmpPath !== undefined) {
      try {
        rmSync(tmpPath, { force: true });
      } catch { /* best-effort cleanup — the failure below is the real news */ }
    }
    return { status: "failed", reason: e instanceof Error ? e.message : String(e) };
  }
}
