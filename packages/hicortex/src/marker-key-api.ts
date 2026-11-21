/**
 * Pure handlers for GET/PUT `/confidential/marker-key` (#616) — the narrow
 * authenticated pair behind ONE-COMMAND marker-key provisioning.
 *
 * The problem (#616): `hicortex confidential` (#614) requires the server's
 * `confidentialMarkerKey` on the machine it runs on, and distributing it by
 * hand (mirror into each client's config.json, or export its env mirror) is
 * ceremony the operator repeats once per machine. The fix keeps the client's ONE
 * existing credential: the machine already holds the server URL + authToken,
 * so the command can FETCH the key (second machine: no new key generated) or
 * GENERATE one and REGISTER it with the server (first machine ever) — one
 * command on the client, key on the server, done.
 *
 * Scope discipline (AC-4): this is NOT a general config-read/config-write
 * API. GET answers the EFFECTIVE key and NOTHING else; PUT accepts the key
 * and NOTHING else. Anything richer would turn the bearer token into a
 * config exfiltration/write surface it deliberately is not today.
 *
 * Accepted trade-off (settled design decision — do not re-litigate): the key
 * is fetchable by token, which collapses the marker key's barrier to the
 * token itself. That is acceptable: the marker key's real protection is
 * against workspace processes WITHOUT the token/config access (a shell
 * script or agent reading the marker file cannot forge one); a token holder
 * can already POST arbitrary content.
 *
 * Layout follows the identity-store.ts precedent: pure, side-effect-free
 * handlers HERE (validation + response shaping), thin adapters in
 * mcp-server.ts that own the I/O — fresh-config read, persistConfigUpdates,
 * and the live-assign of the boot-resolved module-level key so a rotation
 * bites at the NEXT /distill intake with NO restart (the PUT /identity/mode
 * single-writer pattern: boot and this route are the only writers, never
 * both at once).
 */

/**
 * GET's result: the EFFECTIVE marker key — the value the daemon validates
 * relays against (the boot-resolved module var in mcp-server.ts, i.e.
 * env-resolved-first like resolveConfidentialMarkerKey, because that is the
 * value markers must carry). null = no key configured = client markers are
 * INERT (the #614 fail-closed default; a caller may then provision one).
 * The body is exactly `{key}` — no other config ever rides along.
 */
export function handleMarkerKeyGet(effectiveKey: string | null): {
  status: 200;
  body: { key: string | null };
} {
  return { status: 200, body: { key: effectiveKey } };
}

export interface MarkerKeyPutResult {
  status: number;
  body: Record<string, unknown>;
  /**
   * Present ONLY on 200: the validated, trimmed key the adapter persists
   * (config `confidentialMarkerKey`) and live-applies. Never echoed in
   * `body` — the response is `{ok:true}` and nothing else.
   */
  key?: string;
}

/**
 * PUT's validation, in order (each failure answers before any write):
 *
 * 400 — the body is not `{key: string}` with a non-blank, single-line value.
 *   The marker file is ONE line (readConfidentialMarker takes the trimmed
 *   first line), so a key containing `\n`/`\r` can never round-trip; a blank
 *   key would arm nothing (blank never validates — resolveConfidentialMarkerKey
 *   reads blank as unset, so the daemon would stay keyless = inert).
 *
 * 409 — the server runs under the `HICORTEX_CONFIDENTIAL_MARKER_KEY` env
 *   override. The env SHADOWS config on every boot, so a PUT here would
 *   persist a key that is never read — a no-op disguised as success. Blank
 *   env = unset (the same rule resolveConfidentialMarkerKey applies). The
 *   operator unsets the env and restarts to manage the key through this
 *   endpoint/config; hand-edited config still needs a restart either way.
 *
 * 200 — `{ok:true}` + the key for the adapter. The response never echoes
 * the key value (log/response discipline shared with the CLI output).
 */
export function handleMarkerKeyPut(
  body: unknown,
  /** The live env override (the adapter passes process.env…; set-and-non-blank ⇒ 409). */
  envOverride: string | undefined,
): MarkerKeyPutResult {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { status: 400, body: { error: 'Body must be a JSON object: {"key": "<single-line value>"}' } };
  }
  const raw = (body as Record<string, unknown>).key;
  if (typeof raw !== "string") {
    return { status: 400, body: { error: "'key' must be a string" } };
  }
  if (/[\r\n]/.test(raw)) {
    return { status: 400, body: { error: "'key' must be single-line — the marker file is one line" } };
  }
  const key = raw.trim();
  if (!key) {
    return { status: 400, body: { error: "'key' must not be blank — a blank key never validates" } };
  }
  if (typeof envOverride === "string" && envOverride.trim()) {
    return {
      status: 409,
      body: {
        error:
          "HICORTEX_CONFIDENTIAL_MARKER_KEY is set on this server and overrides config — " +
          "a key written here would be shadowed on every boot. Unset the env (and restart) " +
          "to manage the key through this endpoint or config.json.",
      },
    };
  }
  return { status: 200, body: { ok: true }, key };
}
