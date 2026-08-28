/**
 * /viz support (#124) — knowledge-graph visualization page.
 *
 * Two concerns live here so they can be unit-tested without booting the full
 * MCP daemon (mcp-server.ts pulls in the embedder + MCP SDK):
 *
 * 1. createAuthMiddleware — the bearer-token auth middleware used by the whole
 *    REST surface. Extracted verbatim from mcp-server.ts, plus ONE change for
 *    /viz: the page SHELL is exempt like /health (it carries no data or
 *    secrets — it ships verbatim in the public npm tarball). Browsers cannot
 *    attach an Authorization header on plain navigation; the page collects
 *    the token client-side and uses it on its /graph data fetch, which stays
 *    bearer-only like every other data route.
 *
 * 2. readVizHtml — loads the self-contained visualization page from
 *    assets/viz.html at request time. The asset sits next to src/ and dist/
 *    (siblings), so `../assets/viz.html` resolves from both the compiled
 *    output (dist/viz.js) and the TypeScript source (tests/tsx).
 *
 * 3. vendorHandler — serves the pinned renderer bundles from assets/vendor/
 *    (#139: three.js / 3d-force-graph / force-graph, see
 *    THIRD_PARTY_NOTICES.md). STRICT allowlist of exact filenames — the
 *    request path is never joined into the filesystem path; the served path
 *    comes from a fixed lookup table, so traversal is impossible by
 *    construction. Public like the /viz shell (static public code, no data).
 */

import type express from "express";
import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Vendored renderer assets (#139)
// ---------------------------------------------------------------------------

/**
 * Exact filenames servable from assets/vendor/ — nothing else. Pinned bundles
 * documented in THIRD_PARTY_NOTICES.md. Keep this list in lockstep with the
 * <script src="/viz/vendor/…"> references in assets/viz.html.
 */
export const VIZ_VENDOR_FILES: ReadonlySet<string> = new Set([
  "three.module.min.js",
  "three.core.min.js",
  "3d-force-graph.min.js",
  "force-graph.min.js",
]);

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

/**
 * Constant-time bearer comparison (#254). Compares the FULL `Authorization`
 * header (not just the token portion) against the expected `Bearer <token>`
 * form. This couples the scheme + token into one fixed-length secret, so a
 * caller cannot learn anything about the token by varying the scheme prefix.
 *
 * `crypto.timingSafeEqual` THROWS RangeError on mismatched buffer lengths, so
 * the length check MUST gate the call. The short-circuit on `a.length !==
 * b.length` leaks only the header LENGTH — which is already visible on the
 * wire (HTTP header sizes are not secret); the secret token bytes are never
 * compared byte-by-byte through a timing side channel.
 */
function safeBearerMatch(
  headerValue: string | undefined,
  expectedToken: string,
): boolean {
  if (!headerValue) return false;
  const a = Buffer.from(headerValue);
  const b = Buffer.from(`Bearer ${expectedToken}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Bearer token auth — ALWAYS installed, fail-closed. /health, the /viz page
 * shell, and localhost bypass (OPTIONS is short-circuited by the CORS
 * middleware before this runs). With no token configured, remote requests are
 * REJECTED (not open): the default bind is 0.0.0.0, so "no token = no auth"
 * would expose the whole memory store to the network.
 *
 * `authTokenPrevious` (optional, #254) is the prior token kept around during
 * rotation. Both tokens are accepted; this gives a zero-downtime rotation
 * window — in-flight clients configured with the old token keep working until
 * they pick up the new one. BOTH comparisons are constant-time and both are
 * always evaluated (no short-circuit), so a caller cannot learn WHICH token
 * matched from the response timing. Absent/empty `authTokenPrevious` behaves
 * exactly as the single-token middleware always has.
 *
 * `allowLocalhostBypass` (0.18, #110 §2/#271): when false (or omitted), the
 * localhost bypass is DISABLED — localhost connections need the bearer token
 * like any other (fail-closed). When true, localhost loopback (127.0.0.1,
 * ::1, ::ffff:127.0.0.1) bypasses auth as before. The marker file
 * `~/.hicortex/.allow-localhost-bypass` (written by self-hosted init) gates
 * this — a hosted tenant dir is fail-closed by default. mcp-server.ts captures
 * the marker state once at boot and passes it in (no per-request stat).
 */
export function createAuthMiddleware(
  authToken: string | undefined,
  authTokenPrevious?: string,
  allowLocalhostBypass?: boolean,
  bodyLimitBytes?: number,
): express.RequestHandler {
  const previous = authTokenPrevious && authTokenPrevious.length > 0 ? authTokenPrevious : undefined;
  const bypassEnabled = allowLocalhostBypass === true;
  const contentLengthCap = Number.isFinite(bodyLimitBytes) && (bodyLimitBytes as number) > 0
    ? (bodyLimitBytes as number)
    : null;
  return (req, res, next) => {
    // #328 item 4 (package-server half) — BELT. The PRIMARY gate is
    // makeContentLengthGate (mcp-server.ts), registered BEFORE express.json:
    // this middleware sits AFTER the parser, so by the time it runs the body
    // has already been buffered (up to the parser's limit) — its Content-Length
    // check can only catch what a caller wires WITHOUT the front gate. Kept
    // for standalone/reuse callers of createAuthMiddleware and as
    // defense-in-depth; 413 mirrors express.json's own oversize status.
    //
    // RESIDUAL RISK (unchanged by either check): chunked transfer-encoding
    // sends no Content-Length, so neither gate sees it — those requests still
    // buffer up to the parser limit inside express.json before the 413
    // (bounded per request, no pre-auth rejection), and there is no
    // concurrency cap here. Full pre-auth bounding lives in the hosted
    // router's webhook path (stripe.ts, #328 item 4) — the tenant data plane
    // trusts its bearer (self-hosted threat model) or sits behind the
    // provider's edge (hosted).
    if (contentLengthCap !== null) {
      const declared = req.headers["content-length"];
      const declaredNum = typeof declared === "string" ? Number(declared) : NaN;
      if (Number.isFinite(declaredNum) && declaredNum > contentLengthCap) {
        res.status(413).json({ error: "request body too large" });
        return;
      }
    }
    if (req.path === "/health") return next();
    // The /viz page SHELL is public like /health — it contains no data and no
    // secrets (it ships verbatim in the npm tarball). All memory content comes
    // from /graph, which stays bearer-only; the page collects the token
    // client-side (URL ?token= handoff or in-page prompt) and sends it as a
    // normal Authorization header on its data fetches.
    if (req.method === "GET" && req.path === "/viz") return next();
    // The /identity/ui page SHELL is public for the same reason as /viz: a
    // self-contained static editor page, no data and no secrets (it ships
    // verbatim in the npm tarball). The standing-identity DATA it edits comes
    // from GET/PUT /identity, which stay bearer-only (localhost bypass) like
    // every other data route; the page collects the token client-side and
    // sends it as a normal Authorization header on its /identity fetches.
    // #264 backcompat: the legacy /context/ui URL is also exempted (the alias
    // route serves the same shell).
    if (req.method === "GET" && (req.path === "/identity/ui" || req.path === "/context/ui")) return next();
    // The /dashboard page SHELL is public for the same reason as /viz and
    // /context/ui: a self-contained view-only analytics page, no data and no
    // secrets (it ships verbatim in the npm tarball). All metric data comes
    // from GET /dashboard/data, which stays bearer-only (localhost bypass) like
    // every other data route; the page collects the token client-side and
    // sends it as a normal Authorization header on its /dashboard/data fetch.
    if (req.method === "GET" && req.path === "/dashboard") return next();
    // The pinned renderer bundles the /viz page loads (#139) are public for
    // the same reason as the shell: static third-party code shipped verbatim
    // in the npm tarball, zero data. Kept tight: GET only, and ONLY names on
    // the allowlist. The name is percent-DECODED before the lookup so this
    // check and vizVendorHandler (which sees Express's decoded req.params)
    // agree on one canonical form — traversal sequences decode to strings
    // containing "/" or "..", which are never on the allowlist.
    if (req.method === "GET" && req.path.startsWith("/viz/vendor/")) {
      let file = "";
      try {
        file = decodeURIComponent(req.path.slice("/viz/vendor/".length));
      } catch {
        // malformed percent-encoding — not a vendor file, fall through to auth
      }
      if (VIZ_VENDOR_FILES.has(file)) return next();
    }
    const ip = req.ip ?? req.socket.remoteAddress ?? "";
    if (bypassEnabled && (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1")) return next();
    // Constant-time bearer check (#254). When authTokenPrevious is set, BOTH
    // tokens are compared every request (no short-circuit) so timing cannot
    // reveal which one matched. The OR of the two booleans is the accept
    // signal — evaluated after both comparisons complete.
    const header = req.headers.authorization;
    const matchesCurrent = authToken ? safeBearerMatch(header, authToken) : false;
    const matchesPrevious = previous ? safeBearerMatch(header, previous) : false;
    if (matchesCurrent || matchesPrevious) return next();
    res.status(401).json({
      // Gate on (authToken || previous): in the mixed-config edge case
      // (authToken unset, authTokenPrevious set) the middleware still accepts
      // the previous token — so "No auth token configured" would mislead.
      error: (authToken || previous)
        ? "Unauthorized"
        : "No auth token configured on this server — run `npx @gamaze/hicortex init` on the server, then connect with its token.",
    });
  };
}

// ---------------------------------------------------------------------------
// Asset loading
// ---------------------------------------------------------------------------

/**
 * Resolve the on-disk path of the viz page. Throws (fail explicitly) when the
 * asset is missing — a broken install should surface, not degrade silently.
 */
export function resolveVizHtmlPath(): string {
  // dist/viz.js  → ../assets/viz.html
  // src/viz.ts   → ../assets/viz.html (tests / tsx — same sibling layout)
  const candidates = [join(__dirname, "..", "assets", "viz.html")];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `viz.html asset not found — looked in: ${candidates.join(", ")}. ` +
    `The package install is incomplete (assets/ missing).`
  );
}

/** Read the viz page. Read at request time so a reinstall is picked up live. */
export function readVizHtml(): string {
  return readFileSync(resolveVizHtmlPath(), "utf-8");
}

/**
 * Express handler for GET /viz. 503 with the endpoint's usual {error} shape
 * when the asset cannot be read.
 */
export function vizHandler(): express.RequestHandler {
  return (_req, res) => {
    try {
      res.type("html").send(readVizHtml());
    } catch (err) {
      // /viz is a PUBLIC, UNAUTHENTICATED route — the catch must NOT echo the
      // filesystem path of the failed readFileSync to an anonymous remote
      // caller (#253). Log full detail server-side, return a generic body.
      const detail = err instanceof Error ? (err.stack ?? `${err.name}: ${err.message}`) : String(err);
      console.error(`[hicortex] /viz: ${detail}`);
      res.status(503).json({ error: "Asset unavailable" });
    }
  };
}

// ---------------------------------------------------------------------------
// Identity layer editor page (/identity/ui, 0.12 — spec 2026-07-12 §5; renamed
// from /context/ui in 0.18 #264)
// ---------------------------------------------------------------------------

/**
 * Resolve the on-disk path of the identity-layer editor page. Throws (fail
 * explicitly) when the asset is missing — same contract as resolveVizHtmlPath.
 * assets/ sits next to both dist/ (dist/viz.js → ../assets/) and src/
 * (src/viz.ts → ../assets/ under tsx), so one sibling candidate covers both.
 */
export function resolveIdentityHtmlPath(): string {
  const candidates = [join(__dirname, "..", "assets", "identity.html")];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `identity.html asset not found — looked in: ${candidates.join(", ")}. ` +
    `The package install is incomplete (assets/ missing).`
  );
}

/** Read the identity editor page. Read at request time so a reinstall is live. */
export function readIdentityHtml(): string {
  return readFileSync(resolveIdentityHtmlPath(), "utf-8");
}

/**
 * Express handler for GET /identity/ui — the PRIMARY edit surface for the
 * standing identity layer. 503 with the usual {error} shape when the asset
 * cannot be read, exactly like vizHandler. Also serves the legacy
 * /context/ui URL (#264 backcompat).
 */
export function identityUiHandler(): express.RequestHandler {
  return (_req, res) => {
    try {
      res.type("html").send(readIdentityHtml());
    } catch (err) {
      // /identity/ui is a PUBLIC, UNAUTHENTICATED route (#253) — same
      // sanitisation as vizHandler: log detail server-side only.
      const detail = err instanceof Error ? (err.stack ?? `${err.name}: ${err.message}`) : String(err);
      console.error(`[hicortex] /identity/ui: ${detail}`);
      res.status(503).json({ error: "Asset unavailable" });
    }
  };
}

/** Backcompat aliases (#264). */
export const resolveContextHtmlPath = resolveIdentityHtmlPath;
export const readContextHtml = readIdentityHtml;
export const contextUiHandler = identityUiHandler;

// ---------------------------------------------------------------------------
// Dashboard page (/dashboard, #224 — view-only memory analytics)
// ---------------------------------------------------------------------------

/**
 * Resolve the on-disk path of the dashboard page. Throws (fail explicitly)
 * when the asset is missing — same contract as resolveVizHtmlPath and
 * resolveIdentityHtmlPath. assets/ sits next to both dist/ and src/ (the
 * sibling layout the other resolvers rely on).
 */
export function resolveDashboardHtmlPath(): string {
  const candidates = [join(__dirname, "..", "assets", "dashboard.html")];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `dashboard.html asset not found — looked in: ${candidates.join(", ")}. ` +
    `The package install is incomplete (assets/ missing).`
  );
}

/** Read the dashboard page. Read at request time so a reinstall is picked up live. */
export function readDashboardHtml(): string {
  return readFileSync(resolveDashboardHtmlPath(), "utf-8");
}

/**
 * Express handler for GET /dashboard — the view-only analytics page (#224).
 * 503 with the usual {error} shape when the asset cannot be read, exactly like
 * vizHandler and identityUiHandler. The page SHELL is public (exempted in
 * createAuthMiddleware); all data comes from GET /dashboard/data (bearer-only).
 */
export function dashboardHandler(): express.RequestHandler {
  return (_req, res) => {
    try {
      res.type("html").send(readDashboardHtml());
    } catch (err) {
      // /dashboard is a PUBLIC, UNAUTHENTICATED route (#253) — same
      // sanitisation as vizHandler: log detail server-side only.
      const detail = err instanceof Error ? (err.stack ?? `${err.name}: ${err.message}`) : String(err);
      console.error(`[hicortex] /dashboard: ${detail}`);
      res.status(503).json({ error: "Asset unavailable" });
    }
  };
}

/**
 * Resolve the on-disk path of an allowlisted vendor bundle, or null when the
 * requested name is not on the allowlist. The filesystem path is built ONLY
 * from the allowlist literal (never from request input), so no traversal is
 * possible by construction.
 */
export function resolveVizVendorPath(file: string): string | null {
  if (!VIZ_VENDOR_FILES.has(file)) return null;
  // dist/viz.js → ../assets/vendor/<file>; src/viz.ts → same sibling layout.
  return join(__dirname, "..", "assets", "vendor", file);
}

/**
 * Express handler for GET /viz/vendor/:file (#139).
 *
 * - Not on the allowlist (unknown name, traversal attempts, anything) → 404.
 * - Allowlisted but missing on disk → 503 (broken install — fail explicitly,
 *   same contract as vizHandler).
 * - Long immutable cache: the files only ever change with a package version.
 */
export function vizVendorHandler(): express.RequestHandler {
  return (req, res) => {
    const file = typeof req.params.file === "string" ? req.params.file : "";
    const path = resolveVizVendorPath(file);
    if (!path) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    try {
      const body = readFileSync(path);
      res.setHeader("Content-Type", "application/javascript; charset=utf-8");
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.send(body);
    } catch (err) {
      // /viz/vendor/* is a PUBLIC, UNAUTHENTICATED route (#253) — same
      // sanitisation as the other public asset routes: log detail server-side
      // only, return a generic body. The allowlisted filename is fine to echo
      // (it came from the fixed VIZ_VENDOR_FILES table, not the filesystem).
      const detail = err instanceof Error ? (err.stack ?? `${err.name}: ${err.message}`) : String(err);
      console.error(`[hicortex] /viz/vendor/${file}: ${detail}`);
      res.status(503).json({
        error: `Vendor asset ${file} unavailable — the package install is incomplete (assets/vendor/ missing)`,
      });
    }
  };
}
