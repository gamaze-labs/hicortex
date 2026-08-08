/**
 * Anonymous telemetry — sends aggregate stats after each nightly run.
 *
 * What's sent (all aggregate, payload version 2 since 0.15.1):
 *   id       — random UUID, generated once on first run, stored in state.json
 *   v        — package version
 *   pv       — payload schema version
 *   mode     — server or client
 *   agent    — cc, pi, oc, or mixed (detected from session sources); OMITTED
 *              when the agent type is genuinely unknown (pre-flight abort — no
 *              transcripts read yet). The admin summary buckets a missing agent
 *              as "?", distinct from any real type, so an aborting Hermes/OC
 *              client is never miscounted as "cc".
 *   mem      — total memory count
 *   lessons  — total lesson count
 *   lessonsGenerated — lessons created THIS run (server mode only; the per-run
 *              delta, distinct from `lessons` which is the corpus total). Lets a
 *              silent decline in reflection output be seen in the fleet aggregate.
 *   sessions — sessions distilled this run
 *   ok       — nightly succeeded (true/false)
 *   shown    — sum of shown_count (server mode only)
 *   uses     — sum of access_count (server mode only)
 *   cold     — memories never shown and never used (server mode only)
 *   event    — install | nightly | uninstall (which lifecycle moment this is)
 *
 * Every install sends the SAME fields — nothing marks an install as special
 * (a rare label would be a fingerprint, i.e. no longer anonymous). Excluding
 * the maintainer's own installs from adoption stats is an analysis-side
 * concern, done by anonymous id at the admin endpoint.
 *
 * What's NOT sent:
 *   No personal data, no session content, no file paths, no project names,
 *   no hostnames, no tokens. The server stores no IPs.
 *
 * Inspect / control:
 *   `hicortex telemetry` prints the exact payload shape and current state;
 *   `hicortex telemetry off` / `on` flips it.
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

export const TELEMETRY_URL = "https://hicortex.gamaze.com/api/telemetry";

export interface TelemetryPayload {
  id: string;
  v: string;
  mode: string;
  /**
   * Agent type detected from session sources (cc/pi/oc/mixed). OMITTED when
   * unknown — currently only the pre-flight abort path, where no transcripts
   * have been read yet (sending "cc" there mislabelled aborting Hermes/OC
   * clients in the admin aggregate). The admin summary buckets a missing agent
   * as "?", which is the honest signal.
   */
  agent?: string;
  mem: number;
  lessons: number;
  sessions: number;
  ok: boolean;
  /** Payload schema version (2 = adoption fields, 0.15.1). Absent = v1. */
  pv?: number;
  /**
   * Lifecycle event this ping represents (0.15.2). Absent on pre-0.15.2
   * payloads, which were always nightlies. Active-install counts are derived
   * from `nightly` events only, so an install/uninstall ping can never look
   * like activity.
   */
  event?: "install" | "nightly" | "uninstall";
  /**
   * Adoption aggregates (server mode only — a client install has no DB).
   * `shown`/`uses` are corpus-wide sums of shown_count/access_count; their
   * ratio (uses per showing) is the recall-quality signal. `cold` counts
   * memories never shown AND never used. Aggregate counts only — no content,
   * no ids, nothing per-memory.
   */
  shown?: number;
  uses?: number;
  cold?: number;
  /**
   * Lessons generated THIS run (server mode only). The per-run delta —
   * `lessons` above is the corpus total, which drifts slowly via decay/prune
   * and can't reveal a sudden drop in reflection output. 0.16.9+.
   */
  lessonsGenerated?: number;
  /**
   * Consolidation outcome for THIS full nightly (server mode only —
   * capture-only runs send no nightly ping, so the field is absent there).
   * `runConsolidation`'s status: "completed" | "skipped" | "failed", plus
   * "no_llm" when consolidation was skipped because no LLM was configured.
   * "skipped" = the built-in nothing-to-do short-circuit (no new + no unscored
   * memories → zero LLM calls), NOT a failure. Lets the fleet aggregate tell a
   * real consolidation run from a no-op without repurposing `ok` (which is the
   * capture-health signal). 0.17+.
   */
  consolidation?: "completed" | "skipped" | "failed" | "no_llm";
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

/** Payload schema version sent by this release. */
export const TELEMETRY_PAYLOAD_VERSION = 2;

/**
 * Why telemetry is off, or null when it is on. Exposed so `hicortex telemetry`
 * can tell the operator WHICH switch is in effect (config vs env).
 */
export function telemetryDisabledReason(
  config: Record<string, unknown> | null
): "config" | "env" | null {
  const env = process.env.HICORTEX_TELEMETRY?.toLowerCase();
  if (env === "off" || env === "false" || env === "0") return "env";
  if (config?.telemetry === false) return "config";
  return null;
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

/**
 * Send an install/uninstall lifecycle ping (0.15.2). Same anonymous id and
 * transport as the nightly ping, minus the corpus aggregates (there is nothing
 * meaningful to count at install time, and at uninstall the numbers are about
 * to be irrelevant). Fire-and-forget and opt-out-aware like every other ping;
 * exists so the funnel install → first nightly → retained → uninstall is
 * measurable instead of inferred.
 */
export async function sendLifecycleEvent(
  event: "install" | "uninstall",
  stateDir: string,
  config: Record<string, unknown> | null,
  version: string,
  serverUrl?: string,
): Promise<void> {
  if (!isTelemetryEnabled(config)) return;
  try {
    await sendTelemetry(
      {
        id: getTelemetryId(stateDir),
        v: version,
        pv: TELEMETRY_PAYLOAD_VERSION,
        event,
        mode: config?.mode === "client" ? "client" : "server",
        agent: "unknown",
        mem: 0,
        lessons: 0,
        sessions: 0,
        ok: true,
      },
      serverUrl,
    );
  } catch {
    // Never let a lifecycle ping affect install/uninstall success.
  }
}
