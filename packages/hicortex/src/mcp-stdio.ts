/**
 * Hicortex stdio MCP bridge (#375) — the `hicortex mcp` subcommand.
 *
 * Registry/stdio MCP clients (Claude Desktop, Cursor, the MCP Registry's own
 * install flow) launch a stdio command and speak MCP over stdin/stdout. The
 * daemon's MCP surface is HTTP/SSE on :8787, so this module bridges the two:
 * a low-level SDK `Server` over `StdioServerTransport` downstream (the client
 * side) and an SDK `Client` over `SSEClientTransport` upstream (the daemon
 * side), forwarding tools/list + tools/call. The daemon's MCP surface is
 * tools-only (no resources/prompts registered in mcp-server.ts) and ping is
 * auto-answered by the SDK Protocol base, so tools-forwarding loses nothing.
 *
 * WHY proxy instead of in-process stdio with direct DB access (design note,
 * issue #375):
 *   1. db.ts enables WAL but sets no busy_timeout — a second writer process
 *      (the common case: the daemon already running on server-mode installs)
 *      takes immediate SQLITE_BUSY during nightly consolidation's long
 *      transactions → tool-call failures.
 *   2. createMcpServer()'s nine tool handlers close over ~10 module-level
 *      vars initialized by the ~250-line boot inside startServer() —
 *      in-process would mean refactoring the production boot path or
 *      duplicating it (drift).
 *   3. warmEmbedder loads a 150-300 MB ONNX model per process — one per MCP
 *      client (Claude Desktop + CC + Cursor = 3x), vs zero for the bridge.
 *   4. mcp-server.ts's own header states the model: "One process, one DB
 *      connection, one embedder".
 *
 * Target resolution (precedence): HICORTEX_SERVER_URL env → remote bridge,
 * NEVER spawns anything; else config via the SAME semantics as
 * learnings-identity.resolveConfig() (client-mode serverUrl → remote;
 * server-mode → http://127.0.0.1:<port ?? 8787>); no usable config →
 * http://127.0.0.1:8787. Token: HICORTEX_AUTH_TOKEN env → config.authToken.
 * The token rides SSEClientTransport's requestInit headers (verified in the
 * installed SDK 1.28: merged into BOTH the GET /sse and POST /messages).
 *
 * Local autostart: when the target is loopback and /health is
 * connection-refused, spawn a DETACHED `cli.js server --port <n>` (unref,
 * stdio ignored) and poll /health (~250 ms interval, 30 s cap). Concurrent
 * bridges racing EADDRINUSE self-heal — the loser's child dies, the winner's
 * daemon answers the poll, so the loop keeps polling regardless of child
 * state. /health answering but not ok = a foreign or broken service on the
 * port: explicit error, never a spawn. A remote target that is down is
 * likewise an explicit error — we never spawn for remote URLs.
 *
 * STDIO DISCIPLINE: stdout carries ONLY the MCP protocol. Every diagnostic
 * goes to stderr; fatal errors are a one-liner on stderr + non-zero exit
 * (thrown to cli.ts's catch). Cancellation downstream→upstream rides the
 * SDK-native path: the Protocol base aborts the handler's extra.signal on
 * notifications/cancelled, and passing that signal into client.callTool makes
 * the upstream Client emit its own notifications/cancelled with the CORRECT
 * upstream request id (a verbatim forward would carry the downstream id,
 * which means nothing to the daemon) — and reject the in-flight bridge call.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join as pathJoin } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type ListToolsResult,
  type CallToolResult,
  type ServerNotification,
} from "@modelcontextprotocol/sdk/types.js";

import { resolveConfig } from "./learnings-identity.js";

// Version for the downstream Server declaration — read from package.json
// relative to __dirname exactly like mcp-server.ts does (both compile into
// dist/, so ".." lands on the package root). The bridge reports the SAME
// identity as the daemon's own McpServer so every surface agrees.
let VERSION = "0.0.0";
try {
  const pkg = JSON.parse(readFileSync(pathJoin(__dirname, "..", "package.json"), "utf-8"));
  VERSION = pkg.version;
} catch { /* fallback — matches mcp-server.ts */ }

const DEFAULT_BRIDGE_PORT = 8787;
const HEALTH_PROBE_TIMEOUT_MS = 2000;
const AUTOSTART_POLL_INTERVAL_MS = 250;
const AUTOSTART_POLL_TOTAL_MS = 30_000;

// ---------------------------------------------------------------------------
// Target + token resolution (pure helpers, exported for unit tests)
// ---------------------------------------------------------------------------

/** Where the bridge target came from — surfaces in the startup diagnostic. */
export type BridgeTargetSource = "option" | "env" | "config" | "default";

export interface BridgeTarget {
  /** Base URL, trailing slashes stripped (endpoints append /sse, /health). */
  url: string;
  /** Loopback target → eligible for local autostart. */
  local: boolean;
  /** Port of the resolved URL — what an autospawned daemon must listen on. */
  port: number;
  source: BridgeTargetSource;
}

/** Loopback check for URL hostnames (Node's URL keeps the brackets on [::1]). */
export function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

function parseTargetUrl(raw: string, source: BridgeTargetSource): BridgeTarget {
  const url = raw.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // A user-editable env value / config value that is not a URL must fail
    // with a message naming the input — not a bare "Invalid URL".
    const origin =
      source === "option" ? "the given server URL"
      : source === "env" ? "HICORTEX_SERVER_URL"
      : source === "config" ? "the config serverUrl"
      : "the default server URL";
    throw new Error(`Cannot bridge to ${origin}: "${url}" is not a valid URL.`);
  }
  return {
    url,
    local: isLoopbackHost(parsed.hostname),
    port: parseInt(parsed.port, 10) || DEFAULT_BRIDGE_PORT,
    source,
  };
}

/**
 * Resolve the daemon/server the bridge should talk to. Precedence: explicit
 * option (the runMcpStdio test seam) → HICORTEX_SERVER_URL env → config file
 * (client-mode serverUrl = remote; server-mode = localhost, the
 * resolveConfig() semantics already shared by both CC hooks) → default local
 * 8787. Blank/whitespace env values are ignored, not mistaken for targets.
 */
export function resolveBridgeTarget(explicitUrl?: string): BridgeTarget {
  if (typeof explicitUrl === "string" && explicitUrl.trim() !== "") {
    return parseTargetUrl(explicitUrl, "option");
  }
  const envUrl = process.env.HICORTEX_SERVER_URL;
  if (typeof envUrl === "string" && envUrl.trim() !== "") {
    return parseTargetUrl(envUrl, "env");
  }
  // resolveConfig() already encodes both config shapes (client → remote
  // serverUrl; server → http://127.0.0.1:<port ?? 8787>) and returns null
  // when there is no usable config.
  const config = resolveConfig();
  if (config) return parseTargetUrl(config.serverUrl, "config");
  return parseTargetUrl(`http://127.0.0.1:${DEFAULT_BRIDGE_PORT}`, "default");
}

/**
 * Resolve the bearer token for the upstream connection: explicit option →
 * HICORTEX_AUTH_TOKEN env → config.authToken. Undefined = no token (a local
 * daemon needs none — loopback bypasses auth).
 */
export function resolveBridgeToken(explicitToken?: string): string | undefined {
  if (typeof explicitToken === "string" && explicitToken.trim() !== "") return explicitToken.trim();
  const envToken = process.env.HICORTEX_AUTH_TOKEN;
  if (typeof envToken === "string" && envToken.trim() !== "") return envToken.trim();
  return resolveConfig()?.authToken;
}

// ---------------------------------------------------------------------------
// Health probe + autostart decision (pure/injectable for unit tests)
// ---------------------------------------------------------------------------

export interface HealthProbe {
  /** Any HTTP response arrived (even a non-200 one). */
  reachable: boolean;
  /** The endpoint answered ok — a healthy Hicortex /health. */
  ok: boolean;
}

/**
 * One GET /health probe. Connection refused / timeout / DNS failure →
 * { reachable: false }; a response that is not ok → { reachable: true, ok:
 * false } — the two carry different autostart decisions, so a boolean alone
 * cannot express them.
 */
export async function probeHealthOnce(url: string, timeoutMs = HEALTH_PROBE_TIMEOUT_MS): Promise<HealthProbe> {
  try {
    const resp = await fetch(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return { reachable: true, ok: resp.ok };
  } catch {
    return { reachable: false, ok: false };
  }
}

export type AutostartDecision =
  | { action: "bridge" }
  | { action: "spawn" }
  | { action: "fail"; reason: string };

/**
 * Pure decision from one health probe: healthy → bridge; refused + loopback
 * → spawn a local daemon; refused + remote → fail with an actionable message
 * (never spawn for remote URLs); answering-but-not-ok → fail explicitly (a
 * foreign or broken service owns the port — spawning next to it cannot help).
 */
export function decideAutostart(probe: HealthProbe, target: BridgeTarget): AutostartDecision {
  if (probe.ok) return { action: "bridge" };
  if (probe.reachable) {
    return {
      action: "fail",
      reason:
        `Something is answering at ${target.url}/health but it is not a healthy Hicortex server. ` +
        `A foreign or broken service owns that port — inspect it (e.g. lsof -i :${target.port}), ` +
        `then either free the port or point HICORTEX_SERVER_URL at the real Hicortex server.`,
    };
  }
  if (!target.local) {
    return {
      action: "fail",
      reason:
        `Cannot reach the Hicortex server at ${target.url}. Start it on the server machine ` +
        `(check with \`hicortex status\`, start with \`npx @gamaze/hicortex server\`) or fix HICORTEX_SERVER_URL. ` +
        `If it answers 401 once up, set HICORTEX_AUTH_TOKEN to the server's auth token.`,
    };
  }
  return { action: "spawn" };
}

export interface EnsureDaemonOptions {
  /** Local autostart toggle (default true). Remote targets never spawn. */
  autostart?: boolean;
  probeHealth?: (url: string) => Promise<HealthProbe>;
  spawnDaemon?: (port: number) => Promise<void> | void;
  /** Poll pacing overrides — small values keep the timeout test fast. */
  pollIntervalMs?: number;
  pollTotalMs?: number;
}

/**
 * Spawn a detached daemon: `node cli.js server --port <n>`. Detached + unref
 * + ignored stdio — the daemon OUTLIVES this bridge (the product model; init
 * installs it as a persistent daemon for exactly this) and never touches the
 * bridge's stdio MCP wire. The spawned child's exit is not monitored on
 * purpose: in the EADDRINUSE race (two bridges started the same missing
 * daemon), the loser's child dies and the winner's daemon answers the
 * /health poll — monitoring would teach us nothing actionable.
 */
function defaultSpawnDaemon(port: number): void {
  const child = spawn(
    process.execPath,
    [pathJoin(__dirname, "cli.js"), "server", "--port", String(port)],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Ensure something healthy answers at the target before bridging: probe once,
 * decide, and if spawning — poll until healthy (or the deadline). Throws on
 * every fail-path (explicit error, never silent degradation).
 */
export async function ensureDaemonReady(target: BridgeTarget, options: EnsureDaemonOptions = {}): Promise<void> {
  const probe = options.probeHealth ?? ((url: string) => probeHealthOnce(url));
  const autostart = options.autostart ?? true;
  const intervalMs = options.pollIntervalMs ?? AUTOSTART_POLL_INTERVAL_MS;
  const totalMs = options.pollTotalMs ?? AUTOSTART_POLL_TOTAL_MS;

  const initial = await probe(target.url);
  const decision = decideAutostart(initial, target);
  if (decision.action === "bridge") return;
  if (decision.action === "fail") throw new Error(decision.reason);
  if (!autostart) {
    throw new Error(`No Hicortex server is running at ${target.url} (autostart disabled).`);
  }

  await (options.spawnDaemon ?? defaultSpawnDaemon)(target.port);

  const deadline = Date.now() + totalMs;
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    // A mid-boot non-ok answer (daemon warming up) is NOT a foreign service —
    // only the INITIAL probe's reachable-non-ok fails. Keep polling.
    const current = await probe(target.url);
    if (current.ok) return;
  }
  throw new Error(
    `The Hicortex server did not become healthy at ${target.url}/health within ` +
    `${Math.round(totalMs / 1000)}s of autostart. Try \`npx @gamaze/hicortex server\` in a terminal ` +
    `to see the daemon's startup error, then re-run this command.`,
  );
}

// ---------------------------------------------------------------------------
// The bridge itself
// ---------------------------------------------------------------------------

export interface McpStdioOptions extends EnsureDaemonOptions {
  /** Explicit target URL (test seam; normally resolved from env/config). */
  serverUrl?: string;
  /** Explicit bearer token (test seam; normally env → config). */
  authToken?: string;
  /** Injectable downstream transport (test seam; default: real stdio). */
  downstream?: Transport;
}

/**
 * Run the stdio MCP bridge. Resolves only after the downstream transport
 * closes (the lifecycle handlers then exit the process); every setup failure
 * throws for cli.ts to report on stderr and exit 1.
 */
export async function runMcpStdio(options: McpStdioOptions = {}): Promise<void> {
  const target = resolveBridgeTarget(options.serverUrl);
  const token = resolveBridgeToken(options.authToken);

  await ensureDaemonReady(target, options);

  // Upstream: the daemon's SSE MCP endpoint. requestInit headers ride BOTH
  // the GET /sse and the POST /messages (SDK 1.28 _commonHeaders/send).
  const upstream = new SSEClientTransport(
    new URL(`${target.url}/sse`),
    token !== undefined ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : {},
  );
  const client = new Client({ name: "hicortex-mcp-bridge", version: VERSION });
  try {
    await client.connect(upstream);
  } catch (err) {
    // 401 from the daemon's auth middleware (remote connections; loopback is
    // exempt). SseError carries the HTTP status as .code.
    if ((err as { code?: unknown }).code === 401) {
      throw new Error(
        `The Hicortex server at ${target.url} rejected the connection (401). ` +
        `Set HICORTEX_AUTH_TOKEN to the server's auth token — it is printed by \`hicortex status\` on the server box.`,
      );
    }
    throw err instanceof Error ? err : new Error(String(err));
  }

  // Downstream: a low-level Server over stdio advertising exactly what the
  // daemon offers (tools). Ping is auto-answered by the Protocol base.
  // #383: forward the DAEMON's initialize-result instructions verbatim — the
  // daemon owns the text and the memoryInstructions gate, so the two surfaces
  // cannot diverge and no config read is duplicated in the bridge (a
  // pre-#383 remote daemon simply has none to forward; undefined omits the
  // field from the bridge's own initialize result).
  const server = new Server(
    { name: "hicortex", version: VERSION },
    { capabilities: { tools: {} }, instructions: client.getInstructions() },
  );

  // The proxy core — the SDK's documented proxy pattern. Forward the two
  // tools requests and pass extra.signal through so a downstream
  // notifications/cancelled aborts the upstream call (which emits the
  // correctly-id'd cancellation to the daemon). Nothing else is forwarded
  // request-wise: the daemon is tools-only and the base class answers ping.
  server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) =>
    (await client.listTools(undefined, { signal: extra.signal })) as unknown as ListToolsResult,
  );
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) =>
    (await client.callTool(request.params, undefined, { signal: extra.signal })) as unknown as CallToolResult,
  );

  // Upstream → downstream notifications, best-effort: the daemon's tool-list
  // changes or log messages reach the client; a closed far end must not kill
  // the bridge from inside a notification handler.
  client.fallbackNotificationHandler = async (notification) => {
    try {
      await server.notification(notification as unknown as ServerNotification);
    } catch {
      // Best-effort by design.
    }
  };

  // Lifecycle: whichever side ends first tears down the other. The `exiting`
  // guard keeps our OWN client.close() (graceful path) from being read as an
  // upstream loss.
  let exiting = false;
  const shutdown = (code: number) => {
    if (exiting) return;
    exiting = true;
    void Promise.allSettled([server.close(), client.close()]).then(() => process.exit(code));
  };

  // Downstream closed (the MCP client went away) → close upstream → exit 0.
  server.onclose = () => shutdown(0);
  // Upstream transport died → the bridge cannot serve anything → exit 1.
  client.onclose = () => {
    if (exiting) return;
    console.error("[hicortex] mcp: lost the connection to the Hicortex server");
    shutdown(1);
  };
  process.once("SIGINT", () => shutdown(0));
  process.once("SIGTERM", () => shutdown(0));

  const downstream = options.downstream ?? new StdioServerTransport();
  await server.connect(downstream);

  // Diagnostics NEVER touch stdout (the MCP wire) — stderr only.
  console.error(`[hicortex] mcp: bridging stdio <-> ${target.url}/sse (target: ${target.source})`);
}
