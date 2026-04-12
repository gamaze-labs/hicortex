/**
 * Pro extension loader.
 *
 * Called from features.ts at boot when a valid paid license is detected.
 * Responsibilities:
 *   1. Check ~/.hicortex/pro/installed.json for the currently-installed
 *      Pro version (if any).
 *   2. Fetch GET /api/pro/meta from hicortex.gamaze.com to discover the
 *      latest available version for the caller's license tier.
 *   3. If the installed version is older (or missing), download the
 *      tarball, verify the sha256 sidecar, and extract to ~/.hicortex/pro/.
 *   4. Dynamic-import ~/.hicortex/pro/package/index.js and call activate()
 *      on its default export with a ProActivationContext.
 *
 * Failure modes (all soft — OSS host keeps running with defaults):
 *   - Network to /api/pro/meta fails → use whatever is already installed
 *   - No cached Pro and network fails → Pro not activated, OSS defaults apply
 *   - Downloaded tarball fails sha256 → abort download, keep old version
 *   - import() of activated module throws → log warning, keep defaults
 *
 * The loader is strictly best-effort. It must NEVER crash the OSS host.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  createWriteStream,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createProActivationContext, type ProPackage } from "./extensions.js";

const VALIDATE_URL = "https://hicortex.gamaze.com";

interface ProMeta {
  version: string;
  sha256: string | null;
  size_bytes: number;
  url: string;
}

interface InstalledProState {
  version: string;
  installedAt: string;
  sha256: string | null;
}

/**
 * Entry point called from features.ts at boot.
 *
 * @param licenseKey   The Pro license key (hctx-...) from config
 * @param stateDir     Usually ~/.hicortex/
 * @param hostVersion  The version of the OSS host (from package.json) — passed
 *                     to the Pro activate() for compatibility gating
 * @param serverUrl    Override for the Pro meta/download endpoint (defaults
 *                     to https://hicortex.gamaze.com). Useful for testing.
 */
export async function loadPro(
  licenseKey: string,
  stateDir: string,
  hostVersion: string,
  serverUrl: string = VALIDATE_URL,
): Promise<void> {
  const proRoot = join(stateDir, "pro");
  try {
    mkdirSync(proRoot, { recursive: true });
  } catch {
    // If we can't even create the dir, there's nothing to load
    return;
  }

  // Step 1: read installed state (if any)
  const installedStatePath = join(proRoot, "installed.json");
  const installed = readInstalledState(installedStatePath);

  // Step 2: try to fetch the latest meta. Network failure is soft.
  let meta: ProMeta | null = null;
  try {
    meta = await fetchProMeta(serverUrl, licenseKey);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[hicortex][pro] Could not fetch Pro metadata (${msg}) — using cached version if present`);
  }

  // Step 3: if meta is newer than installed, download and extract
  if (meta && (!installed || installed.version !== meta.version)) {
    try {
      await downloadAndExtract(serverUrl, licenseKey, meta, proRoot);
      writeInstalledState(installedStatePath, {
        version: meta.version,
        installedAt: new Date().toISOString(),
        sha256: meta.sha256,
      });
      console.log(`[hicortex][pro] Installed Pro v${meta.version}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[hicortex][pro] Pro download failed: ${msg}`);
    }
  }

  // Step 4: activate whatever is installed (if anything)
  const indexPath = join(proRoot, "package", "index.js");
  if (!existsSync(indexPath)) {
    // No Pro installed and meta fetch couldn't install one
    return;
  }

  try {
    const mod = await import(pathToFileURL(indexPath).href);
    const pkg = (mod.default ?? mod) as ProPackage;
    if (typeof pkg?.activate !== "function") {
      console.warn(`[hicortex][pro] Pro package has no activate() function`);
      return;
    }
    const ctx = createProActivationContext(hostVersion);
    await pkg.activate(ctx);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[hicortex][pro] Pro activation failed: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Implementation helpers
// ---------------------------------------------------------------------------

function readInstalledState(path: string): InstalledProState | null {
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as InstalledProState;
  } catch {
    return null;
  }
}

function writeInstalledState(path: string, state: InstalledProState): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state, null, 2));
  } catch {
    // Non-fatal — we'll just re-download next boot
  }
}

async function fetchProMeta(serverUrl: string, licenseKey: string): Promise<ProMeta> {
  const url = `${serverUrl.replace(/\/$/, "")}/api/pro/meta`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${licenseKey}` },
    signal: AbortSignal.timeout(10_000),
  });

  if (resp.status === 401 || resp.status === 403) {
    throw new Error(`Pro access denied (HTTP ${resp.status}) — check license key`);
  }
  if (resp.status === 404) {
    throw new Error("No Pro release available yet");
  }
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}`);
  }

  const data = (await resp.json()) as ProMeta;
  if (!data.version || !data.url) {
    throw new Error("Malformed /api/pro/meta response");
  }
  return data;
}

async function downloadAndExtract(
  serverUrl: string,
  licenseKey: string,
  meta: ProMeta,
  proRoot: string,
): Promise<void> {
  const downloadUrl = `${serverUrl.replace(/\/$/, "")}${meta.url.startsWith("/") ? "" : "/"}${meta.url}`;

  const resp = await fetch(downloadUrl, {
    headers: { Authorization: `Bearer ${licenseKey}` },
    signal: AbortSignal.timeout(60_000),
  });

  if (!resp.ok) {
    throw new Error(`Download failed with HTTP ${resp.status}`);
  }

  // Stream to a temp file so we can verify the hash before extracting
  const tmpPath = join(proRoot, `.pro-download-${Date.now()}.tgz`);
  const buf = Buffer.from(await resp.arrayBuffer());
  writeFileSync(tmpPath, buf);

  // Verify sha256 if the server provided one
  if (meta.sha256) {
    const hash = createHash("sha256").update(buf).digest("hex");
    if (hash !== meta.sha256) {
      try { rmSync(tmpPath); } catch { /* non-fatal */ }
      throw new Error(`sha256 mismatch: expected ${meta.sha256}, got ${hash}`);
    }
  }

  // Extract to proRoot (overwrites existing package/ directory)
  const existingPackageDir = join(proRoot, "package");
  if (existsSync(existingPackageDir)) {
    try { rmSync(existingPackageDir, { recursive: true, force: true }); } catch { /* non-fatal */ }
  }

  // Use the system tar to extract (cross-platform, no new dependency)
  const result = spawnSync("tar", ["-xzf", tmpPath, "-C", proRoot], {
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    throw new Error(`tar extraction failed: ${result.stderr || "unknown error"}`);
  }

  // Clean up the temp tarball
  try { rmSync(tmpPath); } catch { /* non-fatal */ }
}
