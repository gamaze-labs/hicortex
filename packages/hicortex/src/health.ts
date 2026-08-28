/**
 * Health-endpoint + REST error-sanitisation helpers (#253).
 *
 * Two concerns live here:
 *
 * 1. The public `GET /health` probe is UNAUTHENTICATED and was previously
 *    echoing tenant/install business-intelligence (memory count, link count,
 *    DB size, version, the full LLM backend string) plus running `COUNT(*)`
 *    on every hit. The public response is now just `{status:"ok"}`. The
 *    diagnostics moved to `GET /health/detail`, which goes through the normal
 *    bearer-token auth middleware (localhost bypasses as usual) so an
 *    operator running `hicortex status` on the server box, or a co-located
 *    nightly preflight, still gets them — but a remote/anonymous caller does
 *    not. Spec: `specs/2026-07-27-hosted-service.md` §6, Phase 0a item 5a/b.
 *
 * 2. REST `res.status(500).json({error: err.message})` sites were echoing
 *    internal detail (LLM upstream URLs, hostnames, stack frames) to the HTTP
 *    caller. `logAndSendInternalError` logs the full detail server-side and
 *    returns a generic `{error:"Internal error"}` body. Validation errors
 *    (400 with a useful, non-leaking message) stay specific at their call
 *    sites — only the catch blocks that could leak infrastructure route
 *    through here.
 */

/**
 * Public, unauthenticated health probe. Carries NO data — just liveness.
 * Anyone hitting `/health` (load balancer, watchdog, anonymous prober) gets
 * this and nothing else.
 */
export function publicHealthResponse(): { status: "ok" } {
  return { status: "ok" };
}

/**
 * Operator-only diagnostics. Returned by `GET /health/detail` behind the
 * standard auth middleware (localhost bypasses auth, so co-located tooling
 * — `hicortex status`, nightly preflight, `init` detect — sees it without a
 * token; a remote caller needs the bearer token).
 */
export function detailedHealthResponse(opts: {
  memories: number;
  links: number;
  dbSizeBytes: number;
  version: string;
  llmLabel: string;
}): {
  status: "ok";
  version: string;
  memories: number;
  links: number;
  db_size_kb: number;
  llm: string;
} {
  return {
    status: "ok",
    version: opts.version,
    memories: opts.memories,
    links: opts.links,
    db_size_kb: Math.round(opts.dbSizeBytes / 1024),
    llm: opts.llmLabel,
  };
}

/**
 * Log the full internal error detail server-side and return a generic
 * client-facing 500 body. Use this in every REST catch block whose
 * `err.message` could leak infrastructure (LLM upstream URLs, hostnames,
 * stack frames, DB paths). Validation errors (400) with a useful,
 * non-leaking message stay inline at the call site — this is for the
 * catch-all 500 paths only.
 *
 * The `route` arg (e.g. "lessons", "distill") scopes the log line so an
 * operator can tell which endpoint failed without the response body
 * carrying that detail to the caller.
 */
export function logAndSendInternalError(
  res: {
    status(code: number): { json(body: unknown): void };
  },
  route: string,
  err: unknown,
): void {
  // Stack when available (most informative), else name+message for Errors,
  // else String(). NEVER echo this to the response body.
  const detail =
    err instanceof Error
      ? (err.stack ?? `${err.name}: ${err.message}`)
      : String(err);
  console.error(`[hicortex] /${route}: ${detail}`);
  res.status(500).json({ error: "Internal error" });
}
