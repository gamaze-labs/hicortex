/**
 * Hosted-mode boot assertions (#110 §1-§2, #271 — Phase 0B).
 *
 * Pure decision function — the side-effect (console.error + process.exit) is
 * the caller's job (mcp-server.ts at boot), so the assertion logic is unit-
 * testable in-process without spawning a child or intercepting process.exit.
 *
 * INERT unless hostedMode is true (self-hosted default). When true, the server
 * must refuse to start under either condition:
 *   - HICORTEX_DB_PATH set (a tenant must not be redirectable to an attacker-
 *     chosen DB location — path-override attack);
 *   - the localhost auth-bypass marker file present (hosted is fail-closed —
 *     no bypass; a tenant dir provisioned from a restored tar could otherwise
 *     ship with the bypass active).
 *
 * Spec: specs/2026-07-27-hosted-service.md §1-§2 (Phase 0B, issue #271).
 */
export interface HostedBootInput {
  /** Resolved hostedMode flag from config (absent/false → self-hosted). */
  hostedMode: boolean;
  /** Whether HICORTEX_DB_PATH is currently set in the environment. */
  dbPathEnvSet: boolean;
  /** Whether the localhost-bypass marker file exists in the home dir. */
  bypassMarkerPresent: boolean;
}

export type HostedBootDecision =
  | { ok: true; hostedMode: boolean }
  | { ok: false; hostedMode: true; reason: "db-path-override" | "bypass-marker"; message: string };

/**
 * Decide whether the server may boot under hosted-mode constraints. Returns
 * `{ok:true}` for self-hosted (always — assertions never fire) or hosted with
 * a clean environment; returns `{ok:false, message}` when a hosted constraint
 * is violated (caller logs + exits non-zero).
 */
export function checkHostedBoot(input: HostedBootInput): HostedBootDecision {
  // KNOWN ESCAPE HATCH (CR M1, deferred to #110 Phase 0B item #2 — Docker):
  // HICORTEX_HOME is the same class of env-var redirect as HICORTEX_DB_PATH
  // (paths.ts honors it → a tenant who sets it points hostedMode/marker reads
  // at an attacker-chosen dir with no config → hostedMode reads false → every
  // assertion bypassed). It is NOT refused here because the per-tenant Docker
  // template (#2) may legitimately use HICORTEX_HOME to give each tenant its
  // own home dir. Resolution belongs with #2's tenant-home provisioning: either
  // the orchestrator sanitizes HICORTEX_HOME (container sets it, tenant can't
  // override), or this gate refuses it once the Docker design lands. Do NOT
  // ship a hosted tenant before that decision is made.

  const { hostedMode, dbPathEnvSet, bypassMarkerPresent } = input;
  if (!hostedMode) return { ok: true, hostedMode: false };
  if (dbPathEnvSet) {
    return {
      ok: false,
      hostedMode: true,
      reason: "db-path-override",
      message:
        `[hicortex] hostedMode is ON but HICORTEX_DB_PATH is set. ` +
        `Hosted tenants must not allow DB-path overrides — refusing to start. ` +
        `Unset HICORTEX_DB_PATH on hosted tenants.`,
    };
  }
  if (bypassMarkerPresent) {
    return {
      ok: false,
      hostedMode: true,
      reason: "bypass-marker",
      message:
        `[hicortex] hostedMode is ON but the localhost auth-bypass marker file ` +
        `(.allow-localhost-bypass) is present. Hosted must be fail-closed — ` +
        `refusing to start. Remove the marker file.`,
    };
  }
  return { ok: true, hostedMode: true };
}

/**
 * Decide whether to emit the "Localhost auth bypass is disabled" boot warning
 * (#271 — CR warning 4). Pure: the caller owns the console.warn side-effect,
 * so this is unit-testable across the four input combinations without spawning
 * a process or capturing stderr.
 *
 * Emits ONLY in self-hosted mode when the bypass marker is absent — the upgrade
 * path (a user who upgraded without re-running init loses the bypass and sees
 * 401s from localhost). Returns null in every other state:
 *   - self-hosted + marker present: bypass active, nothing to warn about;
 *   - hosted + marker absent: hosted is fail-closed by design, no bypass to warn;
 *   - hosted + marker present: checkHostedBoot already refused (unreachable here
 *     when called after a passed boot decision), and the failure message is the
 *     operator-facing one — a second warning would be noise.
 *
 * The marker is read from the canonical Hicortex home (HICORTEX_HOME), matching
 * where `init` writes it — NOT from stateDir, which can drift when
 * HICORTEX_DB_PATH relocates the DB (#271 CR warning 1).
 */
export function shouldEmitBypassWarning(
  hostedMode: boolean,
  bypassMarkerPresent: boolean,
): string | null {
  if (!hostedMode && !bypassMarkerPresent) {
    return (
      "[hicortex] Localhost auth bypass is disabled — run " +
      "`npx @gamaze/hicortex init` to restore it."
    );
  }
  return null;
}
