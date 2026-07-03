/**
 * Feature gating — all gates removed as of 0.10.0.
 *
 * Personal and noncommercial use is fully featured under the
 * PolyForm Noncommercial License. Commercial use requires a per-seat
 * license (see COMMERCIAL.md). There is no technical feature gating;
 * the license key's only remaining role is the "licensed to <org>"
 * display in `hicortex status`.
 *
 * The functions below are kept as trivial wrappers so call sites
 * compile without churn. They will be removed entirely in a future
 * cleanup pass once callers have been audited.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { validateLicense } from "./license.js";
import { loadState, updateState } from "./state.js";
import type { LicenseInfo } from "./types.js";

const DEFAULT_STATE_DIR = join(homedir(), ".hicortex");

// A single canonical "full" feature set — no tiers.
const FULL_FEATURES: LicenseInfo["features"] = {
  reflection: true,
  vectorSearch: true,
  maxMemories: -1,
  crossAgent: true,
  remoteIngest: true,
};

let currentFeatures: LicenseInfo["features"] = FULL_FEATURES;
let initialized = false;
// Validated license info for display purposes only (no feature gating).
let validatedLicenseInfo: LicenseInfo | null = null;

function persistTier(stateDir: string, info: LicenseInfo): void {
  updateState((s) => {
    s.tier = {
      tier: info.tier,
      validatedAt: new Date().toISOString(),
      features: FULL_FEATURES,
    };
    return s;
  }, stateDir);
}

/**
 * Initialize license display. Call ONCE at process boot.
 * No feature gates are applied regardless of the validation result.
 */
export async function initFeatures(
  licenseKey: string | undefined,
  stateDir: string = DEFAULT_STATE_DIR,
  _hostVersion: string = "0.0.0",
): Promise<void> {
  if (initialized) return;
  initialized = true;

  currentFeatures = FULL_FEATURES;

  if (!licenseKey) return;

  // Validate the key for display purposes only — a failure keeps the server
  // fully functional.
  try {
    const info = await validateLicense(licenseKey, stateDir);
    validatedLicenseInfo = info;
    if (info.valid) {
      persistTier(stateDir, info);
    }
  } catch {
    // Non-fatal — continue fully functional without a validated display tier
  }
}

/** Returns the validated license info if a key was supplied and validated. */
export function getValidatedLicense(): LicenseInfo | null {
  return validatedLicenseInfo;
}

// ---------------------------------------------------------------------------
// Public API — kept for call-site compatibility; all return "fully unlocked"
// ---------------------------------------------------------------------------

/** Always false — no memory cap. */
export function isPro(): boolean {
  return true;
}

/** Always -1 (unlimited). */
export function maxMemoriesAllowed(): number {
  return -1;
}

/** Always false — no cap is ever reached. */
export function memoryCapReached(_currentCount: number): boolean {
  return false;
}

/** Always 20. */
export function lessonsLimit(): number {
  return 20;
}

/** Always true — remote ingest is always allowed. */
export function remoteIngestAllowed(): boolean {
  return true;
}

/** Direct read of the underlying features record. */
export function getCurrentFeatures(): LicenseInfo["features"] {
  return currentFeatures;
}
