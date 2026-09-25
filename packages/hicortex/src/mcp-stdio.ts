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
 * Startup retry (#501): a REMOTE target that is unreachable at launch is
 * TRANSIENT, not fatal — the product case is a client (e.g. Claude Desktop
 * auto-launched at login) starting before the VPN/DNS that carries the
 * server URL is up (ENOTFOUND/EAI_AGAIN/ECONNREFUSED/timeouts). The bridge
 * then keeps the stdio side ALIVE and answers `initialize` IMMEDIATELY
 * (design B), retrying the upstream connect with backoff (1s→2s→4s… capped
 * 10s) for a 60s window. Why answer immediately: MCP clients cancel a
 * pending `initialize` at ~60s (TS SDK DEFAULT_REQUEST_TIMEOUT_MSEC;
 * Claude Desktop observed cancelling at ~60s in the wild) — a delayed
 * initialize would lose the session the retry window is meant to save, and
 * the first tools/list request carries the same ~60s client budget, so the
 * window deliberately stays at the BOTTOM of the 60–90s range the issue
 * proposed (evidence + decision: issue #501 design-note comment). The
 * daemon's initialize-result `instructions` are unknowable while it is down
 * and are therefore omitted on this path (the pre-#383 shape); tools
 * handlers await upstream readiness. NEVER retried: 401/403 (auth is not
 * transient — existing HICORTEX_AUTH_TOKEN hint) and a reachable-but-not-
 * healthy endpoint (foreign service). Local targets keep the autostart poll
 * (which already waits 30s). Mid-session SSE reconnect after an established
 * connection drops is OUT OF SCOPE (#501 follow-up).
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
// #501 startup-retry window. 60s — the bottom of the issue's 60–90s proposal,
// deliberately: the client's own request timeout (TS SDK default, and Claude
// Desktop's observed initialize cancel) is 60s, and under design B the FIRST
// tools/list inherits that same budget, so a longer window would only answer
// requests the client has already abandoned.
const REMOTE_RETRY_WINDOW_MS = 60_000;
const REMOTE_RETRY_BASE_DELAY_MS = 1_000;
const REMOTE_RETRY_MAX_DELAY_MS = 10_000;

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

/** The clear unreachable message — shared by the fail-fast path and the #501
 *  retry-window expiry, so both ends of the window say the same thing. */
function remoteUnreachableMessage(target: BridgeTarget): string {
  return (
    `Cannot reach the Hicortex server at ${target.url}. Start it on the server machine ` +
    `(check with \`hicortex status\`, start with \`npx @gamaze/hicortex server\`) or fix HICORTEX_SERVER_URL. ` +
    `If it answers 401 once up, set HICORTEX_AUTH_TOKEN to the server's auth token.`
  );
}

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
  if (!target.local) return { action: "fail", reason: remoteUnreachableMessage(target) };
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
// Startup-failure classification + retry pacing (#501, pure, unit-tested)
// ---------------------------------------------------------------------------

export type StartupFailureKind = "auth" | "foreign" | "transient" | "fatal";

/** Node/undici errno codes a "network not up yet" boot race produces. */
const TRANSIENT_ERRNO_RE =
  /\b(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|UND_ERR_CONNECT_TIMEOUT)\b/;

/** SseError carries the HTTP status on .code (SDK client/sse.js). */
function isAuthRejection(err: unknown): boolean {
  const code = (err as { code?: unknown } | undefined)?.code;
  return code === 401 || code === 403 || code === "401" || code === "403";
}

/**
 * A network-level failure that a retry window can plausibly outlive: walk the
 * error + its cause chain for a transient errno, a fetch/undici timeout name,
 * or errno text embedded in the message (SseError has no `cause` — the SDK
 * puts the underlying text straight into `SSE error: getaddrinfo ENOTFOUND …`).
 */
function isTransientNetworkError(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    const code = (current as NodeJS.ErrnoException).code;
    if (typeof code === "string" && TRANSIENT_ERRNO_RE.test(code)) return true;
    if (current.name === "TimeoutError" || current.name === "AbortError") return true;
    if (TRANSIENT_ERRNO_RE.test(current.message)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Classify a startup failure of the upstream connect sequence. Only a REMOTE
 * target's network-level failure is transient (#501); auth rejections and a
 * reachable-but-unhealthy endpoint are fatal immediately, and local targets
 * keep their own autostart-poll semantics.
 */
export function classifyStartupFailure(err: unknown, target: BridgeTarget): StartupFailureKind {
  if (isAuthRejection(err)) return "auth";
  const message = err instanceof Error ? err.message : String(err);
  if (/not a healthy Hicortex/i.test(message)) return "foreign";
  if (target.local) return "fatal";
  // decideAutostart's remote-unreachable reason is the probe-level shape of
  // every refused/DNS-failed/timeout probe (probeHealthOnce collapses them).
  if (message.startsWith("Cannot reach the Hicortex server")) return "transient";
  return isTransientNetworkError(err) ? "transient" : "fatal";
}

/** Backoff step N (0-based): base·2^N, capped — 1s, 2s, 4s, 8s, then the cap. */
export function nextRetryDelayMs(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(baseMs * 2 ** attempt, maxMs);
}

/** One-line reason for the stderr retry log — never the full fail message. */
function summarizeStartupFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const errno = TRANSIENT_ERRNO_RE.exec(message)?.[0];
  if (errno) return errno;
  if (message.startsWith("Cannot reach the Hicortex server")) return "unreachable";
  return message.length > 80 ? `${message.slice(0, 77)}…` : message;
}

/** The friendly fatal form: auth rejections get the token hint, the rest pass
 *  through unchanged (their messages are already the actionable ones). */
function toStartupError(err: unknown, target: BridgeTarget): Error {
  if (isAuthRejection(err)) {
    const status = (err as { code?: unknown }).code;
    return new Error(
      `The Hicortex server at ${target.url} rejected the connection (${status}). ` +
      `Set HICORTEX_AUTH_TOKEN to the server's auth token — it is printed by \`hicortex status\` on the server box.`,
    );
  }
  return err instanceof Error ? err : new Error(String(err));
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
  /** Injectable upstream connect (test seam; default: real SSE transport). */
  connectUpstream?: (target: BridgeTarget, token: string | undefined) => Promise<Client>;
  /** Retry pacing for the #501 transient-unreachable window (test seams). */
  retryWindowMs?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
}

/**
 * Connect the upstream Client to the daemon's SSE MCP endpoint. requestInit
 * headers ride BOTH the GET /sse and the POST /messages (SDK 1.28
 * _commonHeaders/send). Raw errors propagate — classification happens at the
 * call site. Exported for the ghost-reconnect unit test.
 *
 * On failure the transport is closed EXPLICITLY: the SDK's Client.connect
 * closes only when the initialize REQUEST fails after a successful start —
 * a failed transport.start() (refused/DNS) propagates out of Protocol.connect
 * with no cleanup, and the still-open EventSource keeps eventsource's ~3s
 * reconnect loop alive. Every retry attempt would leak one ghost that, once
 * the server appears, opens a REAL authed SSE session on the daemon and is
 * never closed (proven empirically on SDK 1.28.0 / eventsource 3.0.7, PR
 * review round 1 — pinned by the ghost-reconnect unit test).
 */
export async function defaultConnectUpstream(target: BridgeTarget, token: string | undefined): Promise<Client> {
  const upstream = new SSEClientTransport(
    new URL(`${target.url}/sse`),
    token !== undefined ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : {},
  );
  const client = new Client({ name: "hicortex-mcp-bridge", version: VERSION });
  try {
    await client.connect(upstream);
  } catch (err) {
    await client.close().catch(() => {});
    throw err;
  }
  return client;
}

/**
 * The downstream Server: a low-level Server over stdio advertising exactly
 * what the daemon offers (tools). Ping is auto-answered by the Protocol
 * base. #383: `instructions` is the DAEMON's initialize-result text,
 * forwarded verbatim — undefined (pre-#383 daemon, memoryInstructions off,
 * or the #501 slow path where the daemon has not answered yet) omits the
 * field. `awaitClient` yields the upstream Client a tools request should
 * use — already-resolved on the fast path, a readiness promise on the slow
 * path, so tools requests queue until the server exists.
 */
function createBridgeServer(instructions: string | undefined, awaitClient: () => Promise<Client>): Server {
  const server = new Server(
    { name: "hicortex", version: VERSION },
    instructions !== undefined ? { capabilities: { tools: {} }, instructions } : { capabilities: { tools: {} } },
  );
  // The proxy core — the SDK's documented proxy pattern. Forward the two
  // tools requests and pass extra.signal through so a downstream
  // notifications/cancelled aborts the upstream call (which emits the
  // correctly-id'd cancellation to the daemon). Nothing else is forwarded
  // request-wise: the daemon is tools-only and the base class answers ping.
  server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
    const client = await awaitClient();
    return (await client.listTools(undefined, { signal: extra.signal })) as unknown as ListToolsResult;
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const client = await awaitClient();
    return (await client.callTool(request.params, undefined, { signal: extra.signal })) as unknown as CallToolResult;
  });
  return server;
}

/** Upstream → downstream notifications, best-effort: the daemon's tool-list
 *  changes or log messages reach the client; a closed far end must not kill
 *  the bridge from inside a notification handler. */
function forwardNotifications(client: Client, server: Server): void {
  client.fallbackNotificationHandler = async (notification) => {
    try {
      await server.notification(notification as unknown as ServerNotification);
    } catch {
      // Best-effort by design.
    }
  };
}

/**
 * Lifecycle: whichever side ends first tears down the other. The `exiting`
 * guard keeps our OWN client.close() (graceful path) from being read as an
 * upstream loss. The upstream attaches late on the #501 slow path, hence
 * attachUpstream() instead of a constructor argument.
 */
function wireBridgeLifecycle(server: Server): { shutdown: (code: number) => void; attachUpstream: (client: Client) => void } {
  let exiting = false;
  let upstream: Client | undefined;
  const shutdown = (code: number) => {
    if (exiting) return;
    exiting = true;
    const closing = [server.close()];
    if (upstream) closing.push(upstream.close());
    void Promise.allSettled(closing).then(() => process.exit(code));
  };
  // Downstream closed (the MCP client went away) → close upstream → exit 0.
  server.onclose = () => shutdown(0);
  process.once("SIGINT", () => shutdown(0));
  process.once("SIGTERM", () => shutdown(0));
  return {
    shutdown,
    attachUpstream(client: Client) {
      upstream = client;
      // Upstream transport died → the bridge cannot serve anything → exit 1.
      client.onclose = () => {
        if (exiting) return;
        console.error("[hicortex] mcp: lost the connection to the Hicortex server");
        shutdown(1);
      };
    },
  };
}

/**
 * Run the stdio MCP bridge. Fast path (daemon reachable now): connect
 * upstream first, then serve stdio with the daemon's forwarded instructions
 * — exactly the pre-#501 sequence. Slow path (REMOTE target, transient
 * network failure — the boot race): serve stdio IMMEDIATELY (design B,
 * initialize answered at once) and retry the upstream connect with backoff
 * for the retry window. Resolves once bridging is established; every setup
 * failure throws for cli.ts to report on stderr and exit 1.
 */
export async function runMcpStdio(options: McpStdioOptions = {}): Promise<void> {
  const target = resolveBridgeTarget(options.serverUrl);
  const token = resolveBridgeToken(options.authToken);
  const connect = options.connectUpstream ?? defaultConnectUpstream;

  // ---- Fast path: the daemon answers now. ----
  let firstFailure: unknown;
  let upstream: Client | undefined;
  try {
    await ensureDaemonReady(target, options);
    upstream = await connect(target, token);
  } catch (err) {
    if (classifyStartupFailure(err, target) !== "transient") throw toStartupError(err, target);
    firstFailure = err;
  }

  if (upstream) {
    const server = createBridgeServer(upstream.getInstructions(), async () => upstream!);
    const lifecycle = wireBridgeLifecycle(server);
    lifecycle.attachUpstream(upstream);
    forwardNotifications(upstream, server);
    await server.connect(options.downstream ?? new StdioServerTransport());
    // Diagnostics NEVER touch stdout (the MCP wire) — stderr only.
    console.error(`[hicortex] mcp: bridging stdio <-> ${target.url}/sse (target: ${target.source})`);
    return;
  }

  // ---- Slow path (#501): remote + transient — answer initialize now,
  // retry the upstream in the background, keep stdio alive throughout. ----
  const windowMs = options.retryWindowMs ?? REMOTE_RETRY_WINDOW_MS;
  const baseDelayMs = options.retryBaseDelayMs ?? REMOTE_RETRY_BASE_DELAY_MS;
  const maxDelayMs = options.retryMaxDelayMs ?? REMOTE_RETRY_MAX_DELAY_MS;

  let resolveReady!: (client: Client) => void;
  let rejectReady!: (err: Error) => void;
  const upstreamReady = new Promise<Client>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // Mark handled: if the window expires before any tools request arrived,
  // rejecting an un-awaited promise would crash the process as an unhandled
  // rejection.
  upstreamReady.catch(() => {});

  const server = createBridgeServer(undefined, () => upstreamReady);
  const lifecycle = wireBridgeLifecycle(server);
  await server.connect(options.downstream ?? new StdioServerTransport());

  console.error(`[hicortex] mcp: bridging stdio <-> ${target.url}/sse (target: ${target.source})`);
  console.error(
    `[hicortex] mcp: Hicortex server at ${target.url} unreachable at startup ` +
    `(${summarizeStartupFailure(firstFailure)}) — retrying for up to ${Math.round(windowMs / 1000)}s ` +
    `while the network comes up; the connection stays open and tools wait for the server`,
  );

  const deadline = Date.now() + windowMs;
  let attempt = 0;
  let lastFailure = firstFailure;
  for (;;) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      rejectReady(new Error(remoteUnreachableMessage(target)));
      throw new Error(remoteUnreachableMessage(target));
    }
    const delayMs = Math.min(nextRetryDelayMs(attempt, baseDelayMs, maxDelayMs), remainingMs);
    console.error(
      `[hicortex] mcp: retrying ${target.url} in ${delayMs}ms ` +
      `(attempt ${attempt + 1}, ${Math.ceil(remainingMs / 1000)}s of window left) after: ${summarizeStartupFailure(lastFailure)}`,
    );
    await sleep(delayMs);
    attempt += 1;
    try {
      await ensureDaemonReady(target, { probeHealth: options.probeHealth });
      const client = await connect(target, token);
      // Established — from here the lifecycle is exactly the fast path's.
      lifecycle.attachUpstream(client);
      forwardNotifications(client, server);
      resolveReady(client);
      console.error(`[hicortex] mcp: server reachable after ${attempt} retry${attempt === 1 ? "" : "ies"} — serving tools`);
      return;
    } catch (err) {
      const kind = classifyStartupFailure(err, target);
      if (kind === "auth") throw toStartupError(err, target);
      if (kind !== "transient") throw err;
      lastFailure = err;
    }
  }
}
