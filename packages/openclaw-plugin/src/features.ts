/**
 * Centralized feature gating — single source of truth for tier-dependent values.
 *
 * Why this exists:
 *   - getFeatures() in license.ts was sync but validateLicense was async, creating
 *     a race where Pro users got free-tier features during the validation window.
 *   - License checks were scattered across 8+ call sites with subtly different
 *     handling (e.g., consolidate.ts:308 had a dynamic import in a hot loop to
 *     dodge a circular import).
 *
 * All feature decisions now flow through this module. Call initFeatures() once at
 * process boot before serving any requests; sync getters become deterministic.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { validateLicense } from "./license.js";
import type { LicenseInfo } from "./types.js";

const DEFAULT_STATE_DIR = join(homedir(), ".hicortex");
const TIER_PERSIST_FILE = "tier.json";

interface PersistedTier {
  tier: LicenseInfo["tier"];
  validatedAt: string;
  features: LicenseInfo["features"];
}

const FREE_FEATURES: LicenseInfo["features"] = {
  reflection: true,
  vectorSearch: true,
  maxMemories: 250,
  crossAgent: true,
  remoteIngest: true,
};

let currentFeatures: LicenseInfo["features"] = FREE_FEATURES;
let initialized = false;

function readPersistedTier(stateDir: string): PersistedTier | null {
  try {
    const path = join(stateDir, TIER_PERSIST_FILE);
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as PersistedTier;
  } catch {
    return null;
  }
}

function writePersistedTier(stateDir: string, persisted: PersistedTier): void {
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, TIER_PERSIST_FILE),
      JSON.stringify(persisted, null, 2),
    );
  } catch {
    // Non-critical — next boot will re-validate
  }
}

/**
 * Initialize the feature cache. Call ONCE at process boot before any feature
 * gating queries. Race fix:
 *   1. Synchronously load persisted tier from disk (instant, deterministic)
 *   2. If no persisted tier and we have a key, AWAIT first validation
 *   3. If persisted tier exists, kick off background re-validation
 *
 * After this returns, sync getters (isPro, lessonsLimit, etc.) are deterministic
 * and reflect the user's actual tier — no more "free during validation window".
 */
export async function initFeatures(
  licenseKey: string | undefined,
  stateDir: string = DEFAULT_STATE_DIR,
): Promise<void> {
  if (initialized) return;
  initialized = true;

  // Step 1: Load persisted tier (instant)
  const persisted = readPersistedTier(stateDir);
  if (persisted) {
    currentFeatures = persisted.features;
  } else {
    currentFeatures = FREE_FEATURES;
  }

  // Step 2: No key → free tier, done
  if (!licenseKey) return;

  // Step 3: Validate
  if (!persisted) {
    // First-time: AWAIT validation so the very first request sees the right tier
    try {
      const info = await validateLicense(licenseKey, stateDir);
      currentFeatures = info.features;
      if (info.valid) {
        writePersistedTier(stateDir, {
          tier: info.tier,
          validatedAt: new Date().toISOString(),
          features: info.features,
        });
      }
    } catch {
      // Validation failed (network, etc.) — stay on free
    }
  } else {
    // Already have a persisted tier; re-validate in background
    validateLicense(licenseKey, stateDir)
      .then((info) => {
        currentFeatures = info.features;
        if (info.valid) {
          writePersistedTier(stateDir, {
            tier: info.tier,
            validatedAt: new Date().toISOString(),
            features: info.features,
          });
        }
      })
      .catch(() => {
        // Keep persisted features
      });
  }
}

// ---------------------------------------------------------------------------
// Public API — sync getters used everywhere in the codebase
// ---------------------------------------------------------------------------

/** Are we on a paid tier (Pro, Team, Lifetime)? */
export function isPro(): boolean {
  return currentFeatures.maxMemories === -1;
}

/** Memory count cap. -1 = unlimited (paid). */
export function maxMemoriesAllowed(): number {
  return currentFeatures.maxMemories;
}

/** Has the memory cap been hit? Pass current count from caller. */
export function memoryCapReached(currentCount: number): boolean {
  const max = maxMemoriesAllowed();
  return max > 0 && currentCount >= max;
}

/** Number of lessons to inject into CLAUDE.md / before_agent_start. */
export function lessonsLimit(): number {
  return isPro() ? 20 : 10;
}

/** Is remote /ingest allowed? Free + Team yes, Pro (single-machine) no. */
export function remoteIngestAllowed(): boolean {
  return currentFeatures.remoteIngest !== false;
}

/** Direct read of the underlying features (for callers that need the full record). */
export function getCurrentFeatures(): LicenseInfo["features"] {
  return currentFeatures;
}
