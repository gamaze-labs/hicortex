/**
 * License API client.
 *
 * This module is a thin wrapper over the validation HTTP endpoint at
 * https://hicortex.gamaze.com/api/validate. Persistence and feature gating
 * live in features.ts + state.ts; this file does NOT touch disk.
 *
 * Offline grace: when the API is unreachable, we fall back to the cached
 * tier in state.json (written by features.ts on the last successful
 * validation). If the cached tier was validated within OFFLINE_GRACE_DAYS,
 * we treat it as still valid.
 */

import { loadState } from "./state.js";
import type { LicenseInfo } from "./types.js";

const VALIDATE_URL = "https://hicortex.gamaze.com/api/validate";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const OFFLINE_GRACE_DAYS = 7;

// In-memory cache for the current process
let cachedLicense: LicenseInfo | null = null;
let cacheTimestamp = 0;

const FREE_LICENSE: LicenseInfo = {
  valid: false,
  tier: "free",
  features: {
    reflection: true,
    vectorSearch: true,
    maxMemories: 250,
    crossAgent: true,
    remoteIngest: true,
  },
};

/** Validate a license key against the Hicortex API. */
export async function validateLicense(
  key: string | undefined,
  stateDir: string,
): Promise<LicenseInfo> {
  // No key = free tier
  if (!key) return FREE_LICENSE;

  // Check in-memory cache (24h TTL)
  if (cachedLicense && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
    return cachedLicense;
  }

  try {
    const resp = await fetch(VALIDATE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }

    const data = (await resp.json()) as LicenseInfo;
    cachedLicense = data;
    cacheTimestamp = Date.now();
    return data;
  } catch {
    // Network failure — check offline grace period via state.tier
    return offlineFallback(stateDir);
  }
}

/**
 * Offline fallback: if state.tier was validated within the grace period,
 * return its cached features as if validation succeeded. Otherwise, free tier.
 */
function offlineFallback(stateDir: string): LicenseInfo {
  const persisted = loadState(stateDir).tier;
  if (!persisted) return FREE_LICENSE;

  try {
    const lastValidated = new Date(persisted.validatedAt);
    const daysSince =
      (Date.now() - lastValidated.getTime()) / (1000 * 60 * 60 * 24);

    if (daysSince <= OFFLINE_GRACE_DAYS) {
      return {
        valid: true,
        tier: persisted.tier,
        features: persisted.features,
      };
    }
  } catch {
    // Corrupted timestamp — fall through
  }

  return FREE_LICENSE;
}
