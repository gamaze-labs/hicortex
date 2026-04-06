import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { LicenseInfo } from "./types.js";

const VALIDATE_URL = "https://hicortex.gamaze.com/api/validate";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const OFFLINE_GRACE_DAYS = 7;

// In-memory cache
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

/** Validate a license key against the Hicortex API */
export async function validateLicense(
  key: string | undefined,
  stateDir: string
): Promise<LicenseInfo> {
  // No key = free tier
  if (!key) return FREE_LICENSE;

  // Check in-memory cache
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

    // Cache result
    cachedLicense = data;
    cacheTimestamp = Date.now();

    // Persist last successful validation timestamp for offline grace
    if (data.valid) {
      persistValidationTimestamp(stateDir);
    }

    return data;
  } catch {
    // Network failure — check offline grace period
    return offlineFallback(key, stateDir);
  }
}

function persistValidationTimestamp(stateDir: string): void {
  try {
    writeFileSync(
      join(stateDir, "license-validated.txt"),
      new Date().toISOString()
    );
  } catch {
    // Non-critical
  }
}

function offlineFallback(key: string, stateDir: string): LicenseInfo {
  const tsPath = join(stateDir, "license-validated.txt");
  if (!existsSync(tsPath)) return FREE_LICENSE;

  try {
    const lastValidated = new Date(readFileSync(tsPath, "utf-8").trim());
    const daysSince =
      (Date.now() - lastValidated.getTime()) / (1000 * 60 * 60 * 24);

    if (daysSince <= OFFLINE_GRACE_DAYS) {
      // Within grace period — assume last known state was valid
      return cachedLicense ?? {
        valid: true,
        tier: "pro",
        features: {
          reflection: true,
          vectorSearch: true,
          maxMemories: -1,
          crossAgent: true,
        },
      };
    }
  } catch {
    // Corrupted file
  }

  return FREE_LICENSE;
}
