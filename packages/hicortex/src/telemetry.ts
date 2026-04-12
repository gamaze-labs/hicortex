/**
 * Anonymous telemetry — sends aggregate stats after each nightly run.
 *
 * What's sent (8 fields, all aggregate):
 *   id       — random UUID, generated once on first run, stored in state.json
 *   v        — package version
 *   mode     — server or client
 *   agent    — cc, pi, oc, or mixed (detected from session sources)
 *   mem      — total memory count
 *   lessons  — total lesson count
 *   sessions — sessions distilled this run
 *   ok       — nightly succeeded (true/false)
 *
 * What's NOT sent:
 *   No personal data, no session content, no file paths, no IPs stored.
 *
 * Opt-out:
 *   Set "telemetry": false in ~/.hicortex/config.json
 *   OR set HICORTEX_TELEMETRY=off in the environment
 *
 * The ping is fire-and-forget with a 5s timeout. If it fails, nothing
 * happens — the nightly result is unaffected.
 */

import { randomUUID } from "node:crypto";
import { loadState, updateState } from "./state.js";

const TELEMETRY_URL = "https://hicortex.gamaze.com/api/telemetry";

export interface TelemetryPayload {
  id: string;
  v: string;
  mode: string;
  agent: string;
  mem: number;
  lessons: number;
  sessions: number;
  ok: boolean;
}

/**
 * Check if telemetry is enabled. Disabled by:
 *   - config.telemetry === false
 *   - HICORTEX_TELEMETRY env var set to "off", "false", or "0"
 */
export function isTelemetryEnabled(config: Record<string, unknown> | null): boolean {
  // Config override
  if (config?.telemetry === false) return false;

  // Env var override
  const env = process.env.HICORTEX_TELEMETRY?.toLowerCase();
  if (env === "off" || env === "false" || env === "0") return false;

  return true;
}

/**
 * Get or create the anonymous telemetry ID.
 * Generated once, stored in state.json, never linked to any personal info.
 */
export function getTelemetryId(stateDir: string): string {
  const state = loadState(stateDir);
  if (state.telemetryId) return state.telemetryId;

  const id = randomUUID();
  updateState((s) => {
    s.telemetryId = id;
    return s;
  }, stateDir);
  return id;
}

/**
 * Send anonymous telemetry. Fire-and-forget — failures are silently ignored.
 */
export async function sendTelemetry(
  payload: TelemetryPayload,
  serverUrl: string = TELEMETRY_URL,
): Promise<void> {
  try {
    await fetch(serverUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // Silently ignore — telemetry must never affect the nightly result
  }
}
