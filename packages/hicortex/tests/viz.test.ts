/**
 * Tests for #124 — /viz knowledge-graph visualization + GET /graph?op=export.
 *
 * Three layers:
 *   1. exportGraph() unit tests against a seeded temp DB (real function).
 *   2. HTTP tests: a minimal express app mounting the REAL pieces —
 *      createAuthMiddleware() and vizHandler() from src/viz.ts, plus the
 *      /graph route logic mirrored from mcp-server.ts (same convention as
 *      rest-endpoints.test.ts). Source-string assertions on mcp-server.ts
 *      guard against drift between the mirror and the real route.
 *   3. Auth middleware: remote requests are simulated with
 *      `app.set("trust proxy", true)` + X-Forwarded-For, so the real
 *      middleware's req.ip localhost check sees a non-localhost address.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import express from "express";

import { initDb } from "../src/db.js";
import * as storage from "../src/storage.js";
import {
  exportGraph,
  detectHubs,
  EXPORT_DEFAULT_LIMIT,
  EXPORT_MAX_LIMIT,
  type VizGraph,
} from "../src/graph.js";
import {
  createAuthMiddleware,
  vizHandler,
  readVizHtml,
  vizVendorHandler,
  resolveVizVendorPath,
  VIZ_VENDOR_FILES,
} from "../src/viz.js";
import type Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Test setup — isolated DB
// ---------------------------------------------------------------------------

const TEST_DIR = join(tmpdir(), `hicortex-viz-test-${randomUUID().slice(0, 8)}`);
const DB_PATH = join(TEST_DIR, "viz-test.db");

let db: Database.Database;

function fakeEmbed(seed = 0): Float32Array {
  const arr = new Float32Array(384);
  for (let i = 0; i < 384; i++) arr[i] = 0.01 * ((i + seed) % 100);
  return arr;
}

/** Insert a memory and force base_strength / access_count / domain directly. */
function seedMemory(
  content: string,
  opts: {
    seed?: number;
    project?: string;
    memoryType?: string;
    domain?: string | null;
    baseStrength?: number;
    accessCount?: number;
  } = {},
): string {
  const id = storage.insertMemory(db, content, fakeEmbed(opts.seed ?? 0), {
    sourceAgent: "test-viz",
    project: opts.project,
    memoryType: opts.memoryType ?? "episode",
  });
  // last_accessed = now so decay ≈ 0 and effective strength ≈ base_strength —
  // makes ordering assertions deterministic.
  db.prepare(
    "UPDATE memories SET base_strength = ?, access_count = ?, domain = ?, last_accessed = ? WHERE id = ?"
  ).run(
    opts.baseStrength ?? 0.5,
    opts.accessCount ?? 0,
    opts.domain ?? null,
    new Date().toISOString(),
    id,
  );
  return id;
}

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  db = initDb(DB_PATH);
});

afterAll(() => {
  if (db) db.close();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// exportGraph() — unit tests
// ---------------------------------------------------------------------------

describe("exportGraph()", () => {
  let strong: string;
  let weak: string;
  let lessonNode: string;
  let otherDomain: string;
  let hub: string;
  const seeded: string[] = [];

  beforeAll(() => {
    strong = seedMemory("Strong memory in alpha domain\nSecond line of content", {
      seed: 1, domain: "alpha", baseStrength: 0.95, project: "proj-a",
    });
    weak = seedMemory("Weak memory in alpha domain", {
      seed: 2, domain: "alpha", baseStrength: 0.1,
    });
    lessonNode = seedMemory("A lesson memory in beta domain", {
      seed: 3, domain: "beta", memoryType: "lesson", baseStrength: 0.7,
    });
    otherDomain = seedMemory("Fact memory in beta domain", {
      seed: 4, domain: "beta", memoryType: "fact", baseStrength: 0.6,
    });
    // Hub: 3+ links (detectHubs minLinks default = 3)
    hub = seedMemory("Hub memory with many links", {
      seed: 5, domain: "alpha", baseStrength: 0.8,
    });
    seeded.push(strong, weak, lessonNode, otherDomain, hub);

    storage.addLink(db, hub, strong, "similarity", 0.8);
    storage.addLink(db, hub, weak, "DEPENDS_ON", 0.6);
    storage.addLink(db, hub, lessonNode, "VALIDATES", 0.7);
    storage.addLink(db, strong, otherDomain, "CONTRADICTS", 0.5);
  });

  afterAll(() => {
    seeded.forEach((id) => { try { storage.deleteMemory(db, id); } catch { /* gone */ } });
  });

  it("returns all nodes with the documented shape", () => {
    const g = exportGraph(db);
    expect(g.meta.total).toBe(5);
    expect(g.meta.shown).toBe(5);
    expect(g.nodes.length).toBe(5);
    const n = g.nodes.find((x) => x.id === strong)!;
    expect(n).toBeDefined();
    expect(n).toMatchObject({
      memory_type: "episode",
      domain: "alpha",
      project: "proj-a",
    });
    expect(typeof n.strength).toBe("number");
    expect(typeof n.linkCount).toBe("number");
    expect(typeof n.isHub).toBe("boolean");
    expect(n.created_at).toBeTruthy();
  });

  it("includes tags[] ordered by weight desc + parallel tagWeights (graded schema)", () => {
    // Give the strong node a weighted multi-tag set. alpha carries the higher
    // weight → it is both first in tags[] and the derived primary (colour).
    storage.setMemoryTags(db, strong, ["beta", "alpha"], {
      weights: { beta: 0.31337, alpha: 0.91239 },
    });
    try {
      const g = exportGraph(db);
      const n = g.nodes.find((x) => x.id === strong)!;
      expect(n.tags).toEqual(["alpha", "beta"]); // weight desc, not LLM order
      expect(n.tagWeights).toEqual([0.9124, 0.3134]); // parallel, rounded 4dp
      expect(n.domain).toBe("alpha"); // derived primary = colour
      // A node with no memory_tags rows falls back to [domain] with weight 0.
      const w = g.nodes.find((x) => x.id === weak)!;
      expect(w.tags).toEqual(["alpha"]);
      expect(w.tagWeights).toEqual([0]);
    } finally {
      // Restore single-tag state so later ordering tests are unaffected.
      db.prepare("DELETE FROM memory_tags WHERE memory_id = ?").run(strong);
      db.prepare("UPDATE memories SET domain = 'alpha' WHERE id = ?").run(strong);
    }
  });

  it("NULL weights serialize as 0 and sort after weighted tags", () => {
    storage.setMemoryTags(db, strong, ["beta", "alpha"], { weights: { alpha: 0.5 } });
    try {
      const g = exportGraph(db);
      const n = g.nodes.find((x) => x.id === strong)!;
      expect(n.tags).toEqual(["alpha", "beta"]); // weighted first, NULL last
      expect(n.tagWeights).toEqual([0.5, 0]);
    } finally {
      db.prepare("DELETE FROM memory_tags WHERE memory_id = ?").run(strong);
      db.prepare("UPDATE memories SET domain = 'alpha' WHERE id = ?").run(strong);
    }
  });

  it("filters by tag= — any weight, including the domain fallback for untagged rows", () => {
    // strong carries beta as a secondary tag; lessonNode/otherDomain have NO
    // memory_tags rows but domain=beta (fallback counts as carrying the tag).
    storage.setMemoryTags(db, strong, ["alpha", "beta"], {
      weights: { alpha: 0.9, beta: 0.1 },
    });
    try {
      const g = exportGraph(db, { tag: "beta" });
      const ids = g.nodes.map((n) => n.id).sort();
      expect(ids).toEqual([lessonNode, otherDomain, strong].sort());
      // Unlike domain=beta, which matches only the derived primary:
      const byDomain = exportGraph(db, { domain: "beta" });
      expect(byDomain.nodes.some((n) => n.id === strong)).toBe(false);
    } finally {
      db.prepare("DELETE FROM memory_tags WHERE memory_id = ?").run(strong);
      db.prepare("UPDATE memories SET domain = 'alpha' WHERE id = ?").run(strong);
    }
  });

  it("label is the first line, capped at 80 chars; content capped at 4000", () => {
    const g = exportGraph(db);
    const n = g.nodes.find((x) => x.id === strong)!;
    expect(n.label).toBe("Strong memory in alpha domain"); // first line only
    expect(n.label.length).toBeLessThanOrEqual(80);
    expect(n.content.length).toBeLessThanOrEqual(4000);
  });

  it("truncates long labels and content", () => {
    const longLine = "x".repeat(300);
    const longContent = "y".repeat(6000);
    const id = seedMemory(`${longLine}\n${longContent}`, { seed: 9, baseStrength: 0.5 });
    try {
      const g = exportGraph(db);
      const n = g.nodes.find((x) => x.id === id)!;
      expect(n.label.length).toBe(80);
      expect(n.content.length).toBe(4000);
    } finally {
      storage.deleteMemory(db, id);
    }
  });

  it("sorts by effective strength descending", () => {
    const g = exportGraph(db);
    const strengths = g.nodes.map((n) => n.strength);
    expect([...strengths].sort((a, b) => b - a)).toEqual(strengths);
    // strong (0.95 base, fresh) must outrank weak (0.1 base)
    const iStrong = g.nodes.findIndex((n) => n.id === strong);
    const iWeak = g.nodes.findIndex((n) => n.id === weak);
    expect(iStrong).toBeLessThan(iWeak);
  });

  it("caps at limit and keeps the strongest nodes", () => {
    const g = exportGraph(db, { limit: 2 });
    expect(g.nodes.length).toBe(2);
    expect(g.meta.shown).toBe(2);
    expect(g.meta.total).toBe(5); // total is the whole DB, not the shown subset
    // strongest node survives the cap
    expect(g.nodes.some((n) => n.id === strong)).toBe(true);
  });

  it("clamps limit to the hard max", () => {
    const g = exportGraph(db, { limit: 999999 });
    expect(g.nodes.length).toBeLessThanOrEqual(EXPORT_MAX_LIMIT);
    // default constant sanity
    expect(EXPORT_DEFAULT_LIMIT).toBe(5000);
    expect(EXPORT_MAX_LIMIT).toBe(10000);
  });

  it("filters by domain", () => {
    const g = exportGraph(db, { domain: "beta" });
    expect(g.nodes.length).toBe(2);
    expect(g.nodes.every((n) => n.domain === "beta")).toBe(true);
  });

  it("filters by memory_type", () => {
    const g = exportGraph(db, { type: "lesson" });
    expect(g.nodes.length).toBe(1);
    expect(g.nodes[0].id).toBe(lessonNode);
  });

  it("filters by minStrength on EFFECTIVE strength", () => {
    const g = exportGraph(db, { minStrength: 0.5 });
    expect(g.nodes.every((n) => n.strength >= 0.5)).toBe(true);
    expect(g.nodes.some((n) => n.id === weak)).toBe(false);
    expect(g.nodes.some((n) => n.id === strong)).toBe(true);
  });

  it("includes only edges where BOTH endpoints are shown", () => {
    // beta domain excludes hub/strong/weak → the hub links and the
    // strong→otherDomain CONTRADICTS link must all disappear
    const g = exportGraph(db, { domain: "beta" });
    expect(g.edges.length).toBe(0);

    const full = exportGraph(db);
    expect(full.edges.length).toBe(4);
    expect(full.meta.edgeCount).toBe(4);
    const shownIds = new Set(full.nodes.map((n) => n.id));
    for (const e of full.edges) {
      expect(shownIds.has(e.source)).toBe(true);
      expect(shownIds.has(e.target)).toBe(true);
      expect(typeof e.relationship).toBe("string");
      expect(typeof e.strength).toBe("number");
    }
  });

  it("marks hub nodes with isHub", () => {
    const hubs = detectHubs(db);
    expect(hubs.some((h) => h.id === hub)).toBe(true); // sanity: seeding produced a hub
    const g = exportGraph(db);
    const hubNode = g.nodes.find((n) => n.id === hub)!;
    expect(hubNode.isHub).toBe(true);
    const nonHub = g.nodes.find((n) => n.id === otherDomain)!;
    expect(nonHub.isHub).toBe(false);
  });

  it("computes linkCount per node from memory_links", () => {
    const g = exportGraph(db);
    expect(g.nodes.find((n) => n.id === hub)!.linkCount).toBe(3);
    expect(g.nodes.find((n) => n.id === strong)!.linkCount).toBe(2);
    expect(g.nodes.find((n) => n.id === lessonNode)!.linkCount).toBe(1);
  });

  it("returns distinct domains/types across the WHOLE DB regardless of filters", () => {
    const g = exportGraph(db, { domain: "beta" });
    expect(g.domains).toEqual(["alpha", "beta"]);
    expect(g.types).toContain("episode");
    expect(g.types).toContain("lesson");
    expect(g.types).toContain("fact");
  });

  it("handles an empty DB gracefully", () => {
    const emptyDb = initDb(join(TEST_DIR, "empty.db"));
    try {
      const g = exportGraph(emptyDb);
      expect(g.nodes).toEqual([]);
      expect(g.edges).toEqual([]);
      expect(g.meta).toEqual({ total: 0, shown: 0, edgeCount: 0 });
    } finally {
      emptyDb.close();
    }
  });
});

// ---------------------------------------------------------------------------
// HTTP surface — real auth middleware + real viz handler + mirrored /graph
// ---------------------------------------------------------------------------

const AUTH_TOKEN = "hctx-viz-test-token";
let serverPort: number;
let testServer: Server;

function buildApp(): express.Express {
  const app = express();
  // Lets tests present a non-localhost req.ip via X-Forwarded-For, so the
  // REAL middleware's localhost bypass can be exercised both ways.
  app.set("trust proxy", true);
  app.use(express.json());
  app.use(createAuthMiddleware(AUTH_TOKEN));

  // Mirror of the mcp-server.ts /graph export branch (convention: see
  // rest-endpoints.test.ts). Guarded by source assertions below.
  app.get("/graph", (req, res) => {
    const op = typeof req.query.op === "string" ? req.query.op : "";
    const VALID_OPS = ["neighbors", "hubs", "path", "export"];
    if (!VALID_OPS.includes(op)) {
      res.status(400).json({ error: `Invalid op: must be one of ${VALID_OPS.join(", ")}` });
      return;
    }
    const rawLimit = req.query.limit ? Number(req.query.limit) : undefined;
    const filterDomain = typeof req.query.domain === "string" && req.query.domain ? req.query.domain : undefined;
    try {
      if (op === "export") {
        const filterType = typeof req.query.type === "string" && req.query.type ? req.query.type : undefined;
        const filterTag = typeof req.query.tag === "string" && req.query.tag ? req.query.tag : undefined;
        let minStrength: number | undefined;
        if (req.query.minStrength !== undefined) {
          const v = Number(req.query.minStrength);
          if (!Number.isFinite(v) || v < 0 || v > 1) {
            res.status(400).json({ error: "minStrength must be a number between 0 and 1" });
            return;
          }
          minStrength = v;
        }
        const exportLimit = rawLimit && Number.isFinite(rawLimit) ? rawLimit : EXPORT_DEFAULT_LIMIT;
        res.json(exportGraph(db, { domain: filterDomain, type: filterType, tag: filterTag, minStrength, limit: exportLimit }));
        return;
      }
      // Other ops are covered by rest-endpoints.test.ts; not mounted here.
      res.status(400).json({ error: `op not mounted in viz test app: ${op}` });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // /search stand-in — proves query tokens do NOT unlock non-/viz routes
  app.get("/search", (_req, res) => { res.json({ results: [] }); });

  app.get("/viz", vizHandler());
  app.get("/viz/vendor/:file", vizVendorHandler());
  return app;
}

async function request(
  path: string,
  opts: { headers?: Record<string, string>; forwardedFor?: string } = {},
): Promise<{ status: number; contentType: string; text: string }> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.forwardedFor) headers["X-Forwarded-For"] = opts.forwardedFor;
  const resp = await fetch(`http://127.0.0.1:${serverPort}${path}`, { headers });
  return {
    status: resp.status,
    contentType: resp.headers.get("content-type") ?? "",
    text: await resp.text(),
  };
}

describe("HTTP: /graph?op=export, /viz, auth middleware", () => {
  let memX: string;
  let memY: string;

  beforeAll(async () => {
    memX = seedMemory("HTTP export node X", { seed: 40, domain: "alpha", baseStrength: 0.8 });
    memY = seedMemory("HTTP export node Y", { seed: 41, domain: "alpha", baseStrength: 0.6 });
    storage.addLink(db, memX, memY, "similarity", 0.9);

    const app = buildApp();
    await new Promise<void>((resolve, reject) => {
      testServer = app.listen(0, "127.0.0.1", () => resolve());
      testServer.on("error", reject);
    });
    const addr = testServer.address();
    if (!addr || typeof addr === "string") throw new Error("Failed to get server address");
    serverPort = addr.port;
  }, 30000);

  afterAll(async () => {
    [memX, memY].forEach((id) => { try { storage.deleteMemory(db, id); } catch { /* gone */ } });
    await new Promise<void>((resolve) => testServer.close(() => resolve()));
  });

  describe("GET /graph?op=export", () => {
    it("returns the documented payload shape (localhost, no auth)", async () => {
      const { status, text } = await request("/graph?op=export");
      expect(status).toBe(200);
      const g = JSON.parse(text) as VizGraph;
      expect(Array.isArray(g.nodes)).toBe(true);
      expect(Array.isArray(g.edges)).toBe(true);
      expect(Array.isArray(g.domains)).toBe(true);
      expect(Array.isArray(g.types)).toBe(true);
      expect(g.meta).toMatchObject({
        total: expect.any(Number),
        shown: expect.any(Number),
        edgeCount: expect.any(Number),
      });
      expect(g.nodes.some((n) => n.id === memX)).toBe(true);
      expect(g.edges.some((e) => e.source === memX && e.target === memY)).toBe(true);
    });

    it("still returns 400 for an invalid op", async () => {
      const { status, text } = await request("/graph?op=bogus");
      expect(status).toBe(400);
      expect(JSON.parse(text).error).toContain("Invalid op");
    });

    it("returns 400 for out-of-range minStrength", async () => {
      const { status, text } = await request("/graph?op=export&minStrength=1.5");
      expect(status).toBe(400);
      expect(JSON.parse(text).error).toContain("minStrength");
    });

    it("returns 400 for non-numeric minStrength", async () => {
      const { status } = await request("/graph?op=export&minStrength=abc");
      expect(status).toBe(400);
    });

    it("respects limit", async () => {
      const { status, text } = await request("/graph?op=export&limit=1");
      expect(status).toBe(200);
      const g = JSON.parse(text) as VizGraph;
      expect(g.nodes.length).toBe(1);
      expect(g.meta.shown).toBe(1);
    });

    it("respects the tag= filter over HTTP", async () => {
      storage.setMemoryTags(db, memX, ["gamma", "delta"], {
        weights: { gamma: 0.8, delta: 0.2 },
      });
      try {
        const { status, text } = await request("/graph?op=export&tag=delta");
        expect(status).toBe(200);
        const g = JSON.parse(text) as VizGraph;
        expect(g.nodes.map((n) => n.id)).toEqual([memX]);
        expect(g.nodes[0].tags).toEqual(["gamma", "delta"]);
        expect(g.nodes[0].tagWeights).toEqual([0.8, 0.2]);
      } finally {
        db.prepare("DELETE FROM memory_tags WHERE memory_id = ?").run(memX);
        db.prepare("UPDATE memories SET domain = 'alpha' WHERE id = ?").run(memX);
      }
    });
  });

  describe("GET /viz", () => {
    it("returns 200 text/html from localhost", async () => {
      const { status, contentType, text } = await request("/viz");
      expect(status).toBe(200);
      expect(contentType).toContain("text/html");
      expect(text).toContain("Hicortex — knowledge graph");
      expect(text).toContain("/graph?"); // fetches its own origin
    });

    it("contains ZERO EXTERNAL resource references (same-origin absolute paths allowed)", async () => {
      const { text } = await request("/viz");
      // No src=/href=/import pointing off-origin, no external CSS/fonts.
      // Same-origin absolute paths (e.g. /viz/vendor/…) are fine — the page
      // loads its vendored renderer bundles from this daemon (#139).
      expect(text).not.toMatch(/(?:src|href)\s*=\s*["']https?:\/\//i);
      expect(text).not.toMatch(/(?:src|href)\s*=\s*["']\/\//i); // protocol-relative
      expect(text).not.toMatch(/@import\s+/i);
      expect(text).not.toMatch(/url\(\s*["']?https?:/i);
      expect(text).not.toMatch(/fetch\(\s*["']https?:/i);
      expect(text).not.toMatch(/import\s*\(\s*["']https?:/i); // dynamic import
      expect(text).not.toMatch(/from\s*["']https?:/i); // static module import
    });

    it("references ONLY allowlisted /viz/vendor/ paths (src= and module imports)", async () => {
      const { text } = await request("/viz");
      const refs: string[] = [];
      for (const m of text.matchAll(/src\s*=\s*["']([^"']+)["']/gi)) refs.push(m[1]);
      for (const m of text.matchAll(/from\s+["']([^"']+)["']/g)) refs.push(m[1]);
      expect(refs.length).toBeGreaterThan(0); // the page DOES load vendor bundles
      for (const ref of refs) {
        expect(ref.startsWith("/viz/vendor/")).toBe(true);
        expect(VIZ_VENDOR_FILES.has(ref.slice("/viz/vendor/".length))).toBe(true);
      }
    });

    it("readVizHtml() serves the actual assets/viz.html file", () => {
      const direct = readFileSync(
        new URL("../assets/viz.html", import.meta.url),
        "utf-8",
      );
      expect(readVizHtml()).toBe(direct);
    });
  });

  describe("GET /viz/vendor/:file (#139)", () => {
    it("serves every allowlisted bundle with JS content type + immutable cache", async () => {
      for (const file of VIZ_VENDOR_FILES) {
        const resp = await fetch(`http://127.0.0.1:${serverPort}/viz/vendor/${file}`);
        expect(resp.status).toBe(200);
        expect(resp.headers.get("content-type")).toContain("application/javascript");
        expect(resp.headers.get("cache-control")).toContain("immutable");
        const body = await resp.text();
        const direct = readFileSync(
          new URL(`../assets/vendor/${file}`, import.meta.url),
          "utf-8",
        );
        expect(body).toBe(direct); // byte-identical to the vendored file
      }
    });

    it("allowlist covers exactly the four vendored bundles", () => {
      expect([...VIZ_VENDOR_FILES].sort()).toEqual([
        "3d-force-graph.min.js",
        "force-graph.min.js",
        "three.core.min.js",
        "three.module.min.js",
      ]);
    });

    it("non-allowlisted filename → 404", async () => {
      const { status } = await request("/viz/vendor/evil.js");
      expect(status).toBe(404);
    });

    it("percent-encoded traversal (..%2F, %2e%2e%2f) → 404", async () => {
      for (const path of [
        "/viz/vendor/..%2Fviz.html",
        "/viz/vendor/%2e%2e%2fviz.html",
        "/viz/vendor/..%2f..%2fpackage.json",
        "/viz/vendor/three.module.min.js%2f..%2f..%2fviz.html",
      ]) {
        const { status } = await request(path);
        expect(status).toBe(404);
      }
    });

    it("literal ../ traversal in the raw request path never reaches the handler", async () => {
      // fetch() normalizes dot segments per the URL spec, so send the raw
      // path over a plain socket to prove the server side rejects it too.
      const http = await import("node:http");
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          { host: "127.0.0.1", port: serverPort, path: "/viz/vendor/../viz.html", method: "GET" },
          (res) => { res.resume(); resolve(res.statusCode ?? 0); },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(404); // route miss — :file never matches multi-segment paths
    });

    it("percent-encoded form of an ALLOWLISTED filename → 200 (auth check and handler agree on the decoded name)", async () => {
      const { status, contentType } = await request("/viz/vendor/force%2Dgraph.min.js");
      expect(status).toBe(200);
      expect(contentType).toContain("application/javascript");
    });

    it("malformed percent-encoding → 400 from Express's own param decoding, middleware never throws", async () => {
      // The middleware's decodeURIComponent try/catch falls through cleanly;
      // Express's router then rejects the malformed URI itself with 400.
      const { status } = await request("/viz/vendor/%zz.js");
      expect(status).toBe(400);
    });

    it("resolveVizVendorPath: allowlist-only, never built from request input", () => {
      expect(resolveVizVendorPath("evil.js")).toBeNull();
      expect(resolveVizVendorPath("../viz.html")).toBeNull();
      expect(resolveVizVendorPath("")).toBeNull();
      const p = resolveVizVendorPath("force-graph.min.js");
      expect(p).toBeTruthy();
      expect(p).toContain(join("assets", "vendor", "force-graph.min.js"));
    });
  });

  describe("auth middleware (remote simulated via X-Forwarded-For)", () => {
    const REMOTE = "203.0.113.7";

    it("localhost bypasses auth", async () => {
      const { status } = await request("/graph?op=export&limit=1");
      expect(status).toBe(200);
    });

    it("remote without token → 401", async () => {
      const { status, text } = await request("/graph?op=export", { forwardedFor: REMOTE });
      expect(status).toBe(401);
      expect(JSON.parse(text).error).toBe("Unauthorized");
    });

    it("remote with correct bearer header → 200", async () => {
      const { status } = await request("/graph?op=export&limit=1", {
        forwardedFor: REMOTE,
        headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
      });
      expect(status).toBe(200);
    });

    it("remote GET /viz → 200 (page shell is public like /health — no data in it)", async () => {
      const { status, contentType } = await request("/viz", { forwardedFor: REMOTE });
      expect(status).toBe(200);
      expect(contentType).toContain("text/html");
    });

    it("remote GET /viz with a ?token= (bookmarked URL) → 200; the token is consumed client-side", async () => {
      const { status, contentType } = await request(`/viz?token=${AUTH_TOKEN}`, {
        forwardedFor: REMOTE,
      });
      expect(status).toBe(200);
      expect(contentType).toContain("text/html");
    });

    it("public shell does NOT leak data: remote /graph stays 401 regardless of /viz", async () => {
      const { status } = await request("/graph?op=export", { forwardedFor: REMOTE });
      expect(status).toBe(401);
    });

    it("query token on another route (/search?token=) → still 401", async () => {
      const { status } = await request(`/search?token=${AUTH_TOKEN}&query=x`, {
        forwardedFor: REMOTE,
      });
      expect(status).toBe(401);
    });

    it("query token on /graph → still 401", async () => {
      const { status } = await request(`/graph?op=export&token=${AUTH_TOKEN}`, {
        forwardedFor: REMOTE,
      });
      expect(status).toBe(401);
    });

    it("remote GET of an allowlisted vendor bundle → 200 (public static code, like the shell)", async () => {
      const { status, contentType } = await request("/viz/vendor/force-graph.min.js", {
        forwardedFor: REMOTE,
      });
      expect(status).toBe(200);
      expect(contentType).toContain("application/javascript");
    });

    it("remote GET of a NON-allowlisted vendor path → 401 (no exemption outside the allowlist)", async () => {
      const { status } = await request("/viz/vendor/evil.js", { forwardedFor: REMOTE });
      expect(status).toBe(401);
    });

    it("remote encoded-traversal vendor path → 401 (decodes to a name with '/', never allowlisted)", async () => {
      const { status } = await request("/viz/vendor/..%2Fviz.html", { forwardedFor: REMOTE });
      expect(status).toBe(401);
    });

    it("remote percent-encoded ALLOWLISTED filename → 200 (exemption works on the decoded name)", async () => {
      const { status, contentType } = await request("/viz/vendor/force%2Dgraph.min.js", {
        forwardedFor: REMOTE,
      });
      expect(status).toBe(200);
      expect(contentType).toContain("application/javascript");
    });

    it("/health stays open for remote without token", async () => {
      // The middleware exempts /health; the test app has no /health route, so
      // passing the middleware means 404 (route miss), NOT 401 (auth block).
      const { status } = await request("/health", { forwardedFor: REMOTE });
      expect(status).toBe(404);
    });
  });
});

// ---------------------------------------------------------------------------
// Source-level guards — the mirrored /graph logic above must match the real
// route in mcp-server.ts (same convention as rest-endpoints.test.ts).
// ---------------------------------------------------------------------------

describe("mcp-server.ts source — /viz + op=export wired", () => {
  const source = readFileSync(new URL("../src/mcp-server.ts", import.meta.url), "utf-8");

  it("VALID_OPS includes export", () => {
    expect(source).toContain('["neighbors", "hubs", "path", "export"]');
  });

  it("export branch calls exportGraph with all five filters", () => {
    expect(source).toContain('if (op === "export")');
    expect(source).toContain("exportGraph(db,");
    expect(source).toContain("minStrength");
    expect(source).toContain("EXPORT_DEFAULT_LIMIT");
    // tag= filter (graded-schema spec) parsed and passed through.
    expect(source).toContain('typeof req.query.tag === "string"');
    expect(source).toContain("tag: filterTag");
  });

  it("GET /viz is mounted with the shared vizHandler", () => {
    expect(source).toContain('app.get("/viz", vizHandler())');
  });

  it("GET /viz/vendor/:file is mounted with the shared vizVendorHandler (#139)", () => {
    expect(source).toContain('app.get("/viz/vendor/:file", vizVendorHandler())');
  });

  it("auth middleware is the shared createAuthMiddleware (public /viz shell exemption lives there)", () => {
    expect(source).toContain("app.use(createAuthMiddleware(authToken))");
  });
});
