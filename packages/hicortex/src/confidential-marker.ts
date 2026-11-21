/**
 * `hicortex confidential [path] [--key <value>|--off]` (#609/#614/#616) —
 * mark or unmark a workspace folder confidential via the local marker file
 * `.hicortex-confidential`.
 *
 * A marker in a PARENT directory covers child workspaces (the capture walk
 * reads every ancestor up to /), and the marker rides folder renames/moves
 * with the directory itself.
 *
 * #614: the marker CARRIES THE KEY. Its single-line content is the server's
 * `confidentialMarkerKey`, validated SERVER-side at intake (an empty or
 * mismatched marker stamps standard — the empty #609 marker was a
 * client-writable classification channel anybody could replicate).
 *
 * #616: getting that key is ONE COMMAND. When this machine holds no key, the
 * command contacts the server it already reports to (server URL + authToken
 * from the local config, the SAME credential every other client call uses —
 * resolveConfig): fetch the key (a second machine reuses the existing one,
 * no second key), or generate `cmark-<32 hex>` and REGISTER it when the
 * server has none, then persist it into `<hicortex-home>/config.json` for
 * offline reuse. Explicit `--key <value>` is ROTATION: it PUTs the chosen
 * value to the server (GET/PUT /confidential/marker-key, #616) before
 * writing, so a deliberate key change propagates from ANY machine. The env
 * (`HICORTEX_CONFIDENTIAL_MARKER_KEY`) and local-config layers stay pure
 * offline fast paths — no server contact. Without any key AND without a
 * reachable server the command REFUSES with instructions — a keyless marker
 * would be inert server-side, and silently writing one would be a no-op
 * disguised as success. `--off` needs no key and makes no network calls
 * (removal is unconditional and never demotes already-captured memories).
 *
 * Future (#613): the content evolves to space-id + key; this writer and the
 * capture reader (readConfidentialMarker) stay content-agnostic — first
 * line, trimmed, relayed verbatim for the server to interpret.
 */

import { writeFileSync, unlinkSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { hicortexHome } from "./paths.js";
import { loadConfigStrict, persistConfigUpdates } from "./init.js";
import { readStringConfig } from "./config-read.js";
import { resolveConfig } from "./learnings-identity.js";

/**
 * The workspace confidentiality marker's filename (#609): a one-line file at
 * the workspace root, written/removed by this command and read by the
 * nightly's marker walk (readConfidentialMarker in capture.ts — the ONE
 * definition lives here so the writer and the reader can never drift).
 */
export const CONFIDENTIAL_MARKER_FILENAME = ".hicortex-confidential";

/**
 * #616: the server transport the provisioning flow needs — GET the server's
 * current key (null = none registered yet), PUT a new one (first provisioning
 * or rotation). Injected by tests (the capture.ts `post` seam precedent);
 * production builds it from resolveConfig() + fetch. PUT throws on ANY
 * non-OK answer — a refused registration must never leave a local key or
 * marker behind.
 */
export interface MarkerKeyTransport {
  get(): Promise<{ key: string | null }>;
  put(key: string): Promise<void>;
}

export interface ConfidentialMarkerOptions {
  /**
   * Target folder. Default: the process cwd (the natural "mark the folder I
   * am in" invocation). Relative paths resolve against the cwd; the command
   * always reports and acts on the ABSOLUTE path.
   */
  path?: string;
  /** Remove the marker instead of writing it. Succeeds when absent. No key, no network. */
  off?: boolean;
  /**
   * Explicit marker key (#616 ROTATION, the CLI `--key` flag): PUT the chosen
   * value to the server, persist it locally, then write the marker. Checked
   * BEFORE env and config — an operator rotating deliberately pushes the new
   * value, not the locally-cached old one.
   */
  key?: string;
  /**
   * #616 test seam: the server transport for the fetch-or-generate flow.
   * Absent → the default transport from resolveConfig() (null when this
   * machine reports to no server → the refusal error).
   */
  transport?: MarkerKeyTransport;
}

export interface ConfidentialMarkerResult {
  /** The resolved absolute folder path the command acted on. */
  folder: string;
  /** The marker file's absolute path. */
  markerPath: string;
  /** True when the marker exists after the command ran. */
  marked: boolean;
}

/**
 * The common refusal (#614/#616): no key is obtainable on this machine. The
 * message names the two fixes — make the server reachable (so the one-command
 * flow works), or set the key manually (env / config) — because either one
 * unblocks the write. Never writes a marker alongside this error.
 */
function markerKeyRefusal(detail: string): Error {
  return new Error(
    `[hicortex] confidential: ${detail}\n` +
    `  The marker must carry the server's confidentialMarkerKey or the server ignores it (#614).\n` +
    `  Fix: start the Hicortex server this machine reports to (or re-run init so its URL + token\n` +
    `  are in ~/.hicortex/config.json), or set the key manually — export HICORTEX_CONFIDENTIAL_MARKER_KEY\n` +
    `  or add confidentialMarkerKey to ~/.hicortex/config.json — then re-run this command.`
  );
}

/** One timeout for both provisioning calls — a foreground CLI command waits, but not forever. */
const MARKER_KEY_TIMEOUT_MS = 10000;

/**
 * The production transport (#616): resolveConfig() — the SAME resolution every
 * other client-side fetch uses (client mode → config.serverUrl, else
 * localhost:port, + authToken) — so the provisioning call and the nightly's
 * capture POST can never disagree about which server owns the key. null when
 * there is no usable config (fresh machine, no init): the caller refuses.
 *
 * Errors carry the DETAIL (URL, status, cause); the fetch-or-generate ladder
 * in resolveMarkerKey wraps GET failures into the refusal that names the fix.
 * PUT failures surface as their own explicit errors (a refused rotation is
 * not a "no key" refusal — the operator chose a key and the server said no).
 */
function defaultMarkerKeyTransport(): MarkerKeyTransport | null {
  const cfg = resolveConfig();
  if (!cfg) return null;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.authToken) headers["Authorization"] = `Bearer ${cfg.authToken}`;
  const url = `${cfg.serverUrl}/confidential/marker-key`;

  return {
    async get() {
      let resp: Response;
      try {
        resp = await fetch(url, { headers, signal: AbortSignal.timeout(MARKER_KEY_TIMEOUT_MS) });
      } catch (e) {
        throw new Error(`could not reach ${cfg.serverUrl} (${e instanceof Error ? e.message : String(e)})`);
      }
      if (!resp.ok) {
        throw new Error(
          `the server at ${cfg.serverUrl} answered ${resp.status} for /confidential/marker-key ` +
          `(check the auth token, or the server version — the endpoint needs #616+)`
        );
      }
      let body: unknown;
      try {
        body = await resp.json();
      } catch {
        body = null;
      }
      // Shape-check the one field we consume — anything else is a version
      // mismatch and must not masquerade as "no key" (which would mint a
      // second key and orphan the first machine's markers).
      if (
        body === null || typeof body !== "object" ||
        !("key" in (body as Record<string, unknown>)) ||
        ((body as Record<string, unknown>).key !== null && typeof (body as Record<string, unknown>).key !== "string")
      ) {
        throw new Error(`unexpected response shape from ${url} — is the server up to date (#616+)?`);
      }
      const key = (body as { key: string | null }).key;
      return { key: key === null ? null : key.trim() || null };
    },
    async put(key: string) {
      let resp: Response;
      try {
        resp = await fetch(url, {
          method: "PUT",
          headers,
          body: JSON.stringify({ key }),
          signal: AbortSignal.timeout(MARKER_KEY_TIMEOUT_MS),
        });
      } catch (e) {
        throw new Error(
          `[hicortex] confidential: could not reach ${cfg.serverUrl} to set the marker key ` +
          `(${e instanceof Error ? e.message : String(e)}) — nothing was written`
        );
      }
      if (!resp.ok) {
        // Surface the server's refusal VERBATIM (409 env-shadow, 400 shape)
        // — the operator needs the reason, and nothing was written.
        let reason = resp.statusText;
        try {
          const errBody = await resp.json() as { error?: unknown };
          if (errBody && typeof errBody.error === "string") reason = errBody.error;
        } catch {
          // non-JSON error body — keep statusText
        }
        throw new Error(
          `[hicortex] confidential: the server refused the marker key (HTTP ${resp.status}): ${reason} — nothing was written`
        );
      }
    },
  };
}

/**
 * Save the key into `<hicortex-home>/config.json` (#616): after a fetch or a
 * generate-and-register, the NEXT run takes the offline fast path (no server
 * needed). persistConfigUpdates is load-strict → merge → save: unrelated keys
 * (authToken, serverUrl, …) survive, and a malformed existing config THROWS
 * instead of being stubbed. On a server box this is the same file the
 * endpoint's PUT just wrote — idempotent.
 */
function persistLocalMarkerKey(key: string): void {
  persistConfigUpdates(join(hicortexHome(), "config.json"), { confidentialMarkerKey: key });
}

/**
 * Write (or remove) the confidential marker. Fails EXPLICITLY when the
 * target folder does not exist — a typo'd path must not silently mark the
 * wrong directory (or nothing). `--off` is deliberately lenient: removing an
 * absent marker is a no-op success (convergent, like the uninstall paths).
 *
 * ASYNC since #616: the key may need a server round-trip (fetch or
 * generate-and-register) when no local layer holds it. The only callers are
 * the cli.ts `confidential` case and tests.
 *
 * Note the classification asymmetry, mirrored in the output: marking takes
 * effect from the NEXT capture (the nightly reads the marker then), and
 * unmarking never demotes — already-captured memories keep their stamp (the
 * #332 never-demotes rule; history heals via `hicortex backfill-privacy`
 * only toward confidential).
 */
export async function runConfidentialCommand(
  opts: ConfidentialMarkerOptions = {},
): Promise<ConfidentialMarkerResult> {
  const folder = resolve(opts.path ?? process.cwd());
  let isDir = false;
  try {
    isDir = statSync(folder).isDirectory();
  } catch {
    // fall through to the explicit error below
  }
  if (!isDir) {
    throw new Error(
      `[hicortex] confidential: no such directory: ${folder} — pass the workspace folder's path`,
    );
  }
  const markerPath = join(folder, CONFIDENTIAL_MARKER_FILENAME);

  if (opts.off) {
    try {
      unlinkSync(markerPath);
      console.log(`[hicortex] Removed the confidential marker: ${markerPath}`);
      console.log(
        "[hicortex]   Already-captured memories keep their classification (nothing is ever demoted).",
      );
    } catch {
      console.log(`[hicortex] No confidential marker at ${markerPath} — nothing to remove.`);
    }
    return { folder, markerPath, marked: false };
  }

  // #616 key resolution ladder (each layer documented at its check):
  const key = await resolveMarkerKey(opts);

  // Single line, newline-terminated — exactly the shape the capture walk
  // relays (readConfidentialMarker takes the trimmed first line). The key
  // value is deliberately NOT echoed in the output lines below.
  writeFileSync(markerPath, key + "\n");
  console.log(`[hicortex] Marked confidential: ${folder}`);
  console.log(
    "[hicortex]   The marker carries this machine's confidentialMarkerKey; the next nightly capture in this",
  );
  console.log(
    "[hicortex]   folder (or any child folder) stamps its memories confidential when the server's key matches.",
  );
  console.log(
    "[hicortex]   To backfill HISTORY, add the folder to confidentialPaths on the server and run: hicortex backfill-privacy",
  );
  return { folder, markerPath, marked: true };
}

/**
 * The #616 key ladder, in order:
 *
 * 1. `opts.key` (CLI `--key`) → ROTATION: PUT the chosen value to the server
 *    first (a refused PUT — e.g. 409 under the server's env override —
 *    surfaces verbatim and writes nothing), then persist locally.
 * 2. env `HICORTEX_CONFIDENTIAL_MARKER_KEY` → the operator's manual layer:
 *    write, no network, no config persist (mirroring it under an explicit
 *    override would create drift).
 * 3. local config `confidentialMarkerKey` → the offline fast path (yesterday's
 *    provisioning result): write, no network.
 * 4. none of the above → the server: GET /confidential/marker-key. A key →
 *    reuse it (AC-2: the second machine never mints a second key). null →
 *    generate `cmark-` + 32 hex and PUT it (AC-1: first machine ever). Both
 *    branches persist locally for the next run's fast path.
 *
 * A set-but-blank layer is no key at every layer (blank never validates
 * server-side) and the ladder falls through. No transport obtainable (no
 * config at all) or an unreachable server → the refusal error naming the
 * fixes — never an inert marker.
 */
async function resolveMarkerKey(opts: ConfidentialMarkerOptions): Promise<string> {
  // 1. Explicit --key = rotation (push to the server, then keep locally).
  const explicit = typeof opts.key === "string" && opts.key.trim() ? opts.key.trim() : null;
  if (explicit) {
    const transport = opts.transport ?? defaultMarkerKeyTransport();
    if (!transport) {
      throw markerKeyRefusal(
        "rotating with --key needs the server (the new value is registered there first) — " +
        "no Hicortex server is configured on this machine"
      );
    }
    await transport.put(explicit); // refusal surfaces verbatim; nothing written
    persistLocalMarkerKey(explicit);
    console.log(
      "[hicortex] Registered the new confidentialMarkerKey with the server — markers carrying a previous",
    );
    console.log(
      "[hicortex]   key now stamp standard (re-run this command on machines that marked folders before).",
    );
    return explicit;
  }

  // 2. The env layer — operator-managed, offline, never mirrored into config.
  const env = process.env.HICORTEX_CONFIDENTIAL_MARKER_KEY;
  if (typeof env === "string" && env.trim()) return env.trim();

  // 3. The local config layer — yesterday's provisioning result, offline.
  //    (loadConfigStrict THROWS on a broken config rather than reading "no
  //    key" off a file it could not parse — surfaced by the caller.)
  const { config } = loadConfigStrict(join(hicortexHome(), "config.json"));
  const local = readStringConfig(config, "confidentialMarkerKey");
  if (local) return local;

  // 4. The server: fetch, or generate-and-register.
  const transport = opts.transport ?? defaultMarkerKeyTransport();
  if (!transport) {
    throw markerKeyRefusal(
      "no confidentialMarkerKey on this machine and no Hicortex server configured to fetch one from"
    );
  }
  let got: { key: string | null };
  try {
    got = await transport.get();
  } catch (e) {
    // Unreachable / refused / bad shape — one refined refusal naming the fix
    // (never an inert marker, and never a raw network error without one).
    throw markerKeyRefusal(e instanceof Error ? e.message : String(e));
  }
  if (got.key) {
    persistLocalMarkerKey(got.key);
    console.log(
      "[hicortex] Using the server's existing confidentialMarkerKey (saved to this machine's config for offline use).",
    );
    return got.key;
  }
  const generated = `cmark-${randomBytes(16).toString("hex")}`; // single line, 32 hex
  await transport.put(generated); // refusal surfaces; nothing written
  persistLocalMarkerKey(generated);
  console.log(
    "[hicortex] Generated a new confidentialMarkerKey and registered it with the server (saved locally).",
  );
  console.log(
    "[hicortex]   Other machines running this command now fetch this key instead of generating their own.",
  );
  return generated;
}
