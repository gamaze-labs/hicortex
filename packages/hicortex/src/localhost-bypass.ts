/**
 * Localhost auth-bypass marker file (#110 §2, #271 — Phase 0B).
 *
 * The localhost auth bypass in createAuthMiddleware (viz.ts) is marker-GATED
 * from 0.18: it applies ONLY when this marker file exists in the Hicortex
 * home dir. Self-hosted `init` writes the marker, so existing installs keep
 * working after upgrade + re-init; a hosted tenant dir provisioned by any
 * means (script, hand, restored tar) is fail-closed by default — no marker,
 * no bypass, every connection (localhost included) needs the bearer token.
 *
 * Rationale (spec 2026-07-27 §2): with the bypass unconditional, a future
 * `trust proxy` enablement would make `req.ip` header-spoofable and the
 * bypass remotely triggerable. Inverting the default to "off unless marked"
 * makes the bypass opt-in via a filesystem side-effect of self-hosted init,
 * so a tenant home built from a bare config + DB restore cannot accidentally
 * ship with the bypass active. The hosted-mode boot assertion (mcp-server.ts)
 * refuses to start if BOTH hostedMode=true AND the marker is present, so even
 * a stray marker cannot open a hosted tenant.
 *
 * Marker file name: `.allow-localhost-bypass` (dot-prefixed; not a secret —
 * its mere presence is the signal; no contents needed).
 */
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { hicortexHome } from "./paths.js";

/** Marker filename inside the Hicortex home dir. */
export const LOCALHOST_BYPASS_MARKER = ".allow-localhost-bypass";

/** Marker contents — a one-line note. Its mere PRESENCE is the signal. */
export const LOCALHOST_BYPASS_MARKER_CONTENT =
  "# Written by `hicortex init` (self-hosted). Opt-in to the localhost auth\n" +
  "# bypass. DELETE this file to require the bearer token on localhost too\n" +
  "# (fail-closed). Hosted-mode (hostedMode:true) refuses to start with this\n" +
  "# marker present — see specs/2026-07-27-hosted-service.md §2.\n";

/**
 * Resolve the marker file path for a given home dir. Defaults to the canonical
 * Hicortex home (honors HICORTEX_HOME), so callers in tests can point the env
 * override at a temp dir.
 */
export function localhostBypassMarkerPath(home: string = hicortexHome()): string {
  return join(home, LOCALHOST_BYPASS_MARKER);
}

/**
 * Does the localhost auth-bypass marker exist? Pure filesystem check — no
 * logging, no side-effects. Used by both createAuthMiddleware (gates the
 * bypass per-request via a boot-time capture in mcp-server.ts) and the
 * hosted-mode boot assertion.
 */
export function localhostBypassEnabled(home: string = hicortexHome()): boolean {
  return existsSync(localhostBypassMarkerPath(home));
}

/**
 * Write the localhost auth-bypass marker file (self-hosted init only — never
 * in hosted mode). Idempotent: overwrites an existing marker so a re-init
 * refreshes the explanatory note. Ensures the parent dir exists. Does NOT
 * touch auth or any other config — just the one marker file.
 *
 * Returns true when a NEW marker was created (for init's "✓" reporting), false
 * when one already existed (refreshed in place).
 */
export function writeLocalhostBypassMarker(home: string = hicortexHome()): boolean {
  const markerPath = localhostBypassMarkerPath(home);
  const existed = existsSync(markerPath);
  mkdirSync(dirname(markerPath), { recursive: true });
  writeFileSync(markerPath, LOCALHOST_BYPASS_MARKER_CONTENT, { mode: 0o644 });
  return !existed;
}
