/**
 * `hicortex recall-hook` — CC-side client for pushed recall (#192).
 *
 * Installed by init under TWO Claude Code hook events (one command, the CLI
 * dispatches on the payload):
 *   - UserPromptSubmit: POST the prompt to the server's /recall-index; print
 *     the returned index block to stdout (CC injects hook stdout as context).
 *   - SessionStart (startup/resume/clear/compact): POST a reset so the
 *     server's per-session shown-set matches the fresh context window.
 *
 * Fail-soft like learnings-identity: ANY failure (no config, timeout, non-2xx,
 * parse error) prints nothing and exits 0 — a broken hook must never block or
 * slow a CC session beyond the fetch timeout (1000 ms, owner-set).
 */

import { resolveConfig } from "./learnings-identity.js";
import { basename } from "node:path";

const FETCH_TIMEOUT_MS = 1000;

/** Read all of stdin (CC pipes the hook payload JSON). */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

interface HookPayload {
  session_id?: string;
  hook_event_name?: string;
  prompt?: string;
  source?: string;
}

/**
 * Build the /recall-index request body from a CC hook payload, or null when
 * there is nothing to send (no session id, or an unhandled event). Exported
 * for tests.
 */
export function buildHookRequest(
  payload: HookPayload,
  cwd: string = process.cwd()
): Record<string, unknown> | null {
  const sessionId =
    typeof payload.session_id === "string" && payload.session_id
      ? payload.session_id
      : null;
  if (!sessionId) return null;

  if (payload.hook_event_name === "SessionStart") {
    return { session_id: sessionId, reset: true };
  }

  const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
  if (!prompt) return null;
  // #203 scope: derive project from the session cwd so retrieval can apply a
  // soft project-affinity boost. basename(cwd) matches capture's
  // decodeProjectDirName for non-hyphenated dirs (the common case); a hyphen
  // edge case is a pre-existing capture bug, filed separately.
  return { session_id: sessionId, prompt, project: basename(cwd) };
}

export async function runRecallHook(): Promise<void> {
  const cfg = resolveConfig();
  if (!cfg) return;

  let payload: HookPayload;
  try {
    payload = JSON.parse(await readStdin()) as HookPayload;
  } catch {
    return;
  }

  const body = buildHookRequest(payload);
  if (!body) return;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.authToken) headers["Authorization"] = `Bearer ${cfg.authToken}`;

  const resp = await fetch(`${cfg.serverUrl}/recall-index`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) return;

  const data = (await resp.json()) as { block?: string | null };
  if (typeof data.block === "string" && data.block.trim() !== "") {
    process.stdout.write(data.block + "\n");
  }
}
