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
 * Bearer token auth — ALWAYS installed, fail-closed. /health, the /viz page
 * shell, and localhost bypass (OPTIONS is short-circuited by the CORS
 * middleware before this runs). With no token configured, remote requests are
 * REJECTED (not open): the default bind is 0.0.0.0, so "no token = no auth"
 * would expose the whole memory store to the network.
 */
export function createAuthMiddleware(
  authToken: string | undefined,
): express.RequestHandler {
  return (req, res, next) => {
    if (req.path === "/health") return next();
    // The /viz page SHELL is public like /health — it contains no data and no
    // secrets (it ships verbatim in the npm tarball). All memory content comes
    // from /graph, which stays bearer-only; the page collects the token
    // client-side (URL ?token= handoff or in-page prompt) and sends it as a
    // normal Authorization header on its data fetches.
    if (req.method === "GET" && req.path === "/viz") return next();
    // The /context/ui page SHELL is public for the same reason as /viz: a
    // self-contained static editor page, no data and no secrets (it ships
    // verbatim in the npm tarball). The standing-context DATA it edits comes
    // from GET/PUT /context, which stay bearer-only (localhost bypass) like
    // every other data route; the page collects the token client-side and
    // sends it as a normal Authorization header on its /context fetches.
    if (req.method === "GET" && req.path === "/context/ui") return next();
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
    if (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1") return next();
    if (authToken && req.headers.authorization === `Bearer ${authToken}`) return next();
    res.status(401).json({
      error: authToken
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
      res.status(503).json({ error: err instanceof Error ? err.message : String(err) });
    }
  };
}

// ---------------------------------------------------------------------------
// Context layer editor page (/context/ui, 0.12 — spec 2026-07-12 §5)
// ---------------------------------------------------------------------------

/**
 * Resolve the on-disk path of the context-layer editor page. Throws (fail
 * explicitly) when the asset is missing — same contract as resolveVizHtmlPath.
 * assets/ sits next to both dist/ (dist/viz.js → ../assets/) and src/
 * (src/viz.ts → ../assets/ under tsx), so one sibling candidate covers both.
 */
export function resolveContextHtmlPath(): string {
  const candidates = [join(__dirname, "..", "assets", "context.html")];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `context.html asset not found — looked in: ${candidates.join(", ")}. ` +
    `The package install is incomplete (assets/ missing).`
  );
}

/** Read the context editor page. Read at request time so a reinstall is live. */
export function readContextHtml(): string {
  return readFileSync(resolveContextHtmlPath(), "utf-8");
}

/**
 * Express handler for GET /context/ui — the PRIMARY edit surface for the
 * standing context layer. 503 with the usual {error} shape when the asset
 * cannot be read, exactly like vizHandler.
 */
export function contextUiHandler(): express.RequestHandler {
  return (_req, res) => {
    try {
      res.type("html").send(readContextHtml());
    } catch (err) {
      res.status(503).json({ error: err instanceof Error ? err.message : String(err) });
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
      res.status(503).json({
        error:
          `Vendor asset ${file} is missing — the package install is incomplete ` +
          `(assets/vendor/ missing): ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };
}
