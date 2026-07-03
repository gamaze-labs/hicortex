/**
 * OC plugin (recall-only) + OC transcript reader tests (0.10.0)
 *
 * The plugin is a recall-only adapter (lessons + tool proxies) — capture is
 * the nightly's job via oc-transcript-reader.ts (OC persists sessions in the
 * Pi v3 JSONL format at ~/.openclaw/agents/<agentId>/sessions/).
 * Covers:
 *   - readOcTranscripts: parses the OC directory layout + Pi v3 format,
 *     provenance openclaw/<agentId>, mtime watermark, no-op without OC
 *   - Lessons fetch fail-soft (timeout → silent skip)
 *   - Tools proxy correctly including auth header
 *   - scheduleConsolidation / DB / LLM absent from the plugin
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { loadState } from "../src/state.js";

// ---------------------------------------------------------------------------
// Shared test state
// ---------------------------------------------------------------------------

const TEST_DIR = join(tmpdir(), `hicortex-oc-test-${randomUUID().slice(0, 8)}`);

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  // Redirect state writes to the test dir so they don't touch ~/.hicortex
  process.env.HICORTEX_HOME = TEST_DIR;
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  delete process.env.HICORTEX_HOME;
});

// ---------------------------------------------------------------------------
// HTTP stub server factory
// ---------------------------------------------------------------------------

interface StubRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

interface StubServerHandle {
  port: number;
  requests: StubRequest[];
  setHandler(fn: (req: IncomingMessage, res: ServerResponse) => void): void;
  close(): Promise<void>;
}

function makeStubServer(): Promise<StubServerHandle> {
  return new Promise((resolve, reject) => {
    const requests: StubRequest[] = [];
    let handler: ((req: IncomingMessage, res: ServerResponse) => void) | null = null;

    const server: Server = createServer(async (req, res) => {
      // Accumulate body
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString("utf-8");
      let body: unknown = null;
      try { body = JSON.parse(raw); } catch { body = raw || null; }

      requests.push({
        method: req.method ?? "GET",
        url: req.url ?? "/",
        headers: req.headers as Record<string, string | string[] | undefined>,
        body,
      });

      if (handler) {
        handler(req, res);
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Could not get server address"));
        return;
      }
      resolve({
        port: addr.port,
        requests,
        setHandler(fn) { handler = fn; },
        close() {
          return new Promise<void>((res, rej) => server.close((e) => e ? rej(e) : res()));
        },
      });
    });

    server.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Plugin loader helper
// ---------------------------------------------------------------------------

// We import the plugin module and simulate the OC api surface.
// Because the plugin module-level variables (serverUrl, authToken) are set in
// start(), we reconstruct the plugin for each test suite via a mock api object.

type ToolExecutor = (callId: unknown, args: unknown, ctx: unknown) => unknown;
type HookHandler = (event: unknown, ctx: unknown) => unknown;

interface MockApi {
  services: Array<{ id: string; start: (ctx: unknown) => Promise<void>; stop: () => Promise<void> }>;
  hooks: Map<string, HookHandler>;
  tools: Map<string, ToolExecutor>;
  on(event: string, handler: HookHandler): void;
  registerService(def: { id: string; start: (ctx: unknown) => Promise<void>; stop: () => Promise<void> }): void;
  registerTool(factory: (ctx: unknown) => { name: string; execute: ToolExecutor; [k: string]: unknown }, opts: unknown): void;
}

function makeMockApi(): MockApi {
  const api: MockApi = {
    services: [],
    hooks: new Map(),
    tools: new Map(),
    on(event, handler) { api.hooks.set(event, handler); },
    registerService(def) { api.services.push(def); },
    registerTool(factory) {
      const spec = factory(null);
      api.tools.set(spec.name, spec.execute);
    },
  };
  return api;
}

async function startPlugin(api: MockApi, config: Record<string, unknown>, stateDir = TEST_DIR) {
  const mod = await import("../src/index.js");
  const plugin = (mod as unknown as { default: { register: (api: MockApi) => void } }).default;
  plugin.register(api);
  const svc = api.services[0];
  if (svc) {
    await svc.start({
      config,
      stateDir,
      logger: null, // use console.log
    });
  }
}

// ---------------------------------------------------------------------------
// Minimal conversation messages (must survive extractConversationText)
// ---------------------------------------------------------------------------

function makeMessages(count = 5) {
  const msgs = [];
  for (let i = 0; i < count; i++) {
    msgs.push({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Message ${i}: This is a realistic message body with enough content to pass the 20-char gate.`,
    });
  }
  return msgs;
}

// ---------------------------------------------------------------------------
// 1. scheduleConsolidation is absent from the plugin
// ---------------------------------------------------------------------------

describe("scheduleConsolidation absent (0.10.0)", () => {
  it("index.ts does not import or call scheduleConsolidation", async () => {
    // Verify at the source level that the export is not referenced.
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf-8");
    expect(source).not.toContain("scheduleConsolidation");
    expect(source).not.toContain("cancelConsolidation");
    expect(source).not.toContain("runConsolidation");
  });

  it("index.ts does not open a local database", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf-8");
    expect(source).not.toContain("initDb");
    expect(source).not.toContain("better-sqlite3");
    expect(source).not.toContain("./db.js");
    expect(source).not.toContain("./storage.js");
  });

  it("index.ts does not import distillSession or embedder", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf-8");
    expect(source).not.toContain("distillSession");
    expect(source).not.toContain("./embedder.js");
    expect(source).not.toContain("embed(");
  });
});

// ---------------------------------------------------------------------------
// 2. OC transcript reader — nightly capture source
// ---------------------------------------------------------------------------

describe("readOcTranscripts (0.10.0)", () => {
  const OC_DIR = join(TEST_DIR, "openclaw-agents");

  function writeOcSession(agentId: string, sessionUuid: string, cwd: string) {
    const dir = join(OC_DIR, agentId, "sessions");
    mkdirSync(dir, { recursive: true });
    const lines = [
      { type: "session", version: "3", id: sessionUuid, timestamp: "2026-07-01T08:00:00.000Z", cwd },
      { type: "model_change", id: "m1", parentId: null, timestamp: "2026-07-01T08:00:01.000Z", provider: "zai", modelId: "glm-5" },
      { type: "message", id: "u1", parentId: "m1", timestamp: "2026-07-01T08:00:02.000Z", message: { role: "user", content: "We decided to use PostgreSQL with jsonb for the event store because of the flexible payloads." } },
      { type: "message", id: "a1", parentId: "u1", timestamp: "2026-07-01T08:00:03.000Z", message: { role: "assistant", content: "Agreed — I will add a GIN index on the payload column and set the retention policy to 90 days." } },
    ];
    writeFileSync(join(dir, `${sessionUuid}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  }

  it("reads sessions from agents/<agentId>/sessions/ with OC provenance", async () => {
    const { readOcTranscripts } = await import("../src/oc-transcript-reader.js");
    writeOcSession("a9", "11111111-1111-4111-8111-111111111111", "/home/agents/.openclaw/workspace-a9");

    const batches = readOcTranscripts(new Date(0), OC_DIR);
    expect(batches.length).toBe(1);
    expect(batches[0].sessionId).toBe("11111111-1111-4111-8111-111111111111");
    expect(batches[0].sourceAgent).toBe("openclaw/a9");
    expect(batches[0].date).toBe("2026-07-01");
    expect(batches[0].entries.length).toBe(4);
    // Project derived from the session cwd, not the "sessions" dir name
    expect(batches[0].projectName).not.toBe("sessions");
  });

  it("respects the mtime watermark", async () => {
    const { readOcTranscripts } = await import("../src/oc-transcript-reader.js");
    const batches = readOcTranscripts(new Date(Date.now() + 60_000), OC_DIR);
    expect(batches.length).toBe(0);
  });

  it("no-ops when the OC directory does not exist", async () => {
    const { readOcTranscripts } = await import("../src/oc-transcript-reader.js");
    expect(readOcTranscripts(new Date(0), join(TEST_DIR, "no-such-dir"))).toEqual([]);
  });
});

describe("before_agent_start lessons fail-soft", () => {
  it("returns empty object when server is unreachable", async () => {
    // Port 1 is reserved and always connection-refused
    const api = makeMockApi();
    const subDir = join(TEST_DIR, "lessons-fail-test");
    mkdirSync(subDir, { recursive: true });

    // A stub that immediately closes to trigger ECONNREFUSED faster
    const stub = await makeStubServer();
    const port = stub.port;
    await stub.close();

    await startPlugin(api, { serverUrl: `http://127.0.0.1:${port}` }, subDir);

    const handler = api.hooks.get("before_agent_start");
    expect(handler).toBeDefined();

    const result = await handler!(
      { prompt: "hello" },
      { agentId: "a", project: "p" },
    );

    // Must return {} or { appendSystemContext: ... } — not throw
    expect(result).toBeDefined();
    // Since server is down, no appendSystemContext
    expect((result as Record<string, unknown>).appendSystemContext).toBeUndefined();
  });

  it("returns empty object when /lessons times out", async () => {
    const stub = await makeStubServer();

    // Never respond — triggers timeout
    stub.setHandler((_req, _res) => { /* no response */ });

    const api = makeMockApi();
    const subDir = join(TEST_DIR, "lessons-timeout-test");
    mkdirSync(subDir, { recursive: true });

    // Health check OK
    const healthDone = new Promise<void>((resolve) => {
      stub.setHandler((req, res) => {
        if (req.url === "/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ version: "0.10.0", memories: 0 }));
          // After health check, never respond again
          stub.setHandler((_r, _rs) => { /* timeout */ });
          resolve();
        }
      });
    });

    await startPlugin(api, { serverUrl: `http://127.0.0.1:${stub.port}` }, subDir);
    await healthDone;
    stub.requests.length = 0;

    const handler = api.hooks.get("before_agent_start");

    // Must complete within a reasonable time (> LESSONS_TIMEOUT + buffer)
    const t0 = Date.now();
    const result = await handler!(
      { prompt: "hello" },
      { agentId: "a", project: "p" },
    );
    const elapsed = Date.now() - t0;

    expect(result).toBeDefined();
    expect((result as Record<string, unknown>).appendSystemContext).toBeUndefined();
    // Should have respected the 3s timeout + not hung forever
    expect(elapsed).toBeLessThan(10000);

    await stub.close();
  });

  it("injects lessons context when server responds normally", async () => {
    const stub = await makeStubServer();

    stub.setHandler((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url === "/health") {
        res.end(JSON.stringify({ version: "0.10.0", memories: 10 }));
      } else {
        res.end(JSON.stringify({
          lessons: [
            { content: "## Lesson: Always validate inputs\n**Type:** technical\n**Severity:** high", created_at: "2026-07-01", base_strength: 0.9, access_count: 3 },
          ],
          index: { total: 10, lessonCount: 1, sourceCount: 2, projects: [{ name: "proj", count: 10 }] },
          moduleIndex: null,
        }));
      }
    });

    const api = makeMockApi();
    const subDir = join(TEST_DIR, "lessons-ok-test");
    mkdirSync(subDir, { recursive: true });

    await startPlugin(api, { serverUrl: `http://127.0.0.1:${stub.port}` }, subDir);

    const handler = api.hooks.get("before_agent_start");
    const result = await handler!(
      { prompt: "hello" },
      { agentId: "a", project: "proj" },
    ) as Record<string, unknown>;

    expect(result.appendSystemContext).toBeTypeOf("string");
    expect(result.appendSystemContext as string).toContain("Hicortex Lessons");
    expect(result.appendSystemContext as string).toContain("Always validate inputs");

    await stub.close();
  });
});

// ---------------------------------------------------------------------------
// 5. Tools proxy: auth header included, correct endpoint called
// ---------------------------------------------------------------------------

describe("tools proxy — HTTP with auth", () => {
  let stub: StubServerHandle;
  let api: MockApi;
  const AUTH_TOKEN = "hctx-test-token-123";
  const subDir = join(TEST_DIR, "tools-test");

  beforeAll(async () => {
    mkdirSync(subDir, { recursive: true });
    stub = await makeStubServer();

    stub.setHandler((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ version: "0.10.0", memories: 5 }));
    });

    api = makeMockApi();
    await startPlugin(api, {
      serverUrl: `http://127.0.0.1:${stub.port}`,
      authToken: AUTH_TOKEN,
    }, subDir);
    stub.requests.length = 0;
  });

  afterAll(async () => { await stub.close(); });

  beforeEach(() => { stub.requests.length = 0; });

  it("hicortex_search calls GET /search with query param and auth header", async () => {
    stub.setHandler((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ results: [] }));
    });

    const exec = api.tools.get("hicortex_search");
    expect(exec).toBeDefined();
    await exec!(null, { query: "test query", limit: 3 }, null);
    await new Promise((r) => setTimeout(r, 50));

    const req = stub.requests.find((r) => r.url?.startsWith("/search"));
    expect(req).toBeDefined();
    expect(req!.url).toContain("query=test+query");
    expect(req!.url).toContain("limit=3");
    expect(req!.method).toBe("GET");
    expect(req!.headers["authorization"]).toBe(`Bearer ${AUTH_TOKEN}`);
  });

  it("hicortex_context calls GET /context with auth header", async () => {
    stub.setHandler((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ results: [] }));
    });

    const exec = api.tools.get("hicortex_context");
    expect(exec).toBeDefined();
    await exec!(null, { project: "my-proj", limit: 5 }, null);
    await new Promise((r) => setTimeout(r, 50));

    const req = stub.requests.find((r) => r.url?.startsWith("/context"));
    expect(req).toBeDefined();
    expect(req!.url).toContain("project=my-proj");
    expect(req!.headers["authorization"]).toBe(`Bearer ${AUTH_TOKEN}`);
  });

  it("hicortex_ingest calls POST /ingest with auth header", async () => {
    stub.setHandler((_req, res) => {
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "abc12345-0000-0000-0000-000000000000", message: "Memory ingested" }));
    });

    const exec = api.tools.get("hicortex_ingest");
    expect(exec).toBeDefined();
    await exec!(null, { content: "Important decision made", project: "proj", memory_type: "decision" }, { agentId: "oc-1" });
    await new Promise((r) => setTimeout(r, 50));

    const req = stub.requests.find((r) => r.url === "/ingest" && r.method === "POST");
    expect(req).toBeDefined();
    expect(req!.headers["authorization"]).toBe(`Bearer ${AUTH_TOKEN}`);
    const body = req!.body as Record<string, unknown>;
    expect(body.content).toBe("Important decision made");
    expect(body.memory_type).toBe("decision");
    expect(body.source_agent).toContain("openclaw/oc-1");
  });

  it("hicortex_lessons calls GET /lessons with auth header", async () => {
    stub.setHandler((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ lessons: [], index: { total: 0, lessonCount: 0, sourceCount: 0, projects: [] } }));
    });

    const exec = api.tools.get("hicortex_lessons");
    expect(exec).toBeDefined();
    await exec!(null, {}, null);
    await new Promise((r) => setTimeout(r, 50));

    const req = stub.requests.find((r) => r.url?.startsWith("/lessons"));
    expect(req).toBeDefined();
    expect(req!.headers["authorization"]).toBe(`Bearer ${AUTH_TOKEN}`);
  });

  it("tools return error message when server is unreachable", async () => {
    // Point the plugin at a port that has nothing listening.
    // We do this by temporarily overwriting the module-level serverUrl via a
    // dedicated plugin instance rather than mutating shared state.
    const badApi = makeMockApi();
    const badDir = join(TEST_DIR, "tools-bad-test");
    mkdirSync(badDir, { recursive: true });
    // Port 2 is unlikely to ever be in use
    await startPlugin(badApi, { serverUrl: "http://127.0.0.1:2" }, badDir).catch(() => {});

    const exec = badApi.tools.get("hicortex_search");
    expect(exec).toBeDefined();
    const result = await exec!(null, { query: "something" }, null) as Record<string, unknown>;
    expect(result.error).toBeTypeOf("string");
    expect(result.error).toContain("Search failed");
  });
});

// ---------------------------------------------------------------------------
// 6. No auth header when authToken is absent (localhost bypass semantics)
// ---------------------------------------------------------------------------

describe("tools proxy — no auth header for localhost without authToken", () => {
  let stub: StubServerHandle;
  let api: MockApi;
  const subDir = join(TEST_DIR, "no-auth-test");

  beforeAll(async () => {
    mkdirSync(subDir, { recursive: true });
    stub = await makeStubServer();

    stub.setHandler((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ version: "0.10.0", memories: 0 }));
    });

    api = makeMockApi();
    // No authToken — localhost bypass
    await startPlugin(api, { serverUrl: `http://127.0.0.1:${stub.port}` }, subDir);
    stub.requests.length = 0;
  });

  afterAll(async () => { await stub.close(); });

  it("omits Authorization header when authToken is not configured", async () => {
    stub.setHandler((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ results: [] }));
    });

    const exec = api.tools.get("hicortex_search");
    await exec!(null, { query: "hello" }, null);
    await new Promise((r) => setTimeout(r, 50));

    const req = stub.requests.find((r) => r.url?.startsWith("/search"));
    expect(req).toBeDefined();
    expect(req!.headers["authorization"]).toBeUndefined();
  });
});
