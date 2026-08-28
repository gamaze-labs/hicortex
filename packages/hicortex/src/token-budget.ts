/**
 * Per-tenant monthly token-budget enforcement (#110 Phase 0B item #5).
 *
 * Limits LLM token consumption over /distill (the cost-generating path the
 * nightly consolidation throttle did NOT cover). Mode-agnostic — gates on
 * `cap > 0`, never on `hostedMode`:
 *   - Self-hosted: the cap is the operator's own `llmTokensPerMonth` config
 *     (default 0 = unlimited → never throttles). Protects the operator's wallet
 *     from a runaway nightly on an expensive model.
 *   - Hosted: the cap is provider-set via the `HICORTEX_TOKEN_CAP` env, which
 *     takes PRECEDENCE over config. The tenant process cannot mutate boot-time
 *     env, so a hosted tenant cannot raise its own cap (the config.json
 *     self-edit loophole is closed). Protects the provider's wallet.
 *
 * Reuses the existing machinery: `shouldThrottleTokens` (consolidate.ts) for the
 * decision (incl. monthly reset), and `llmTokensThisPeriod` + `updateState`
 * (state.ts) for the counter + atomic persistence.
 *
 * Concurrency: state.json is read fresh for each check and written via
 * `updateState` (a synchronous read-modify-write; Node's single thread
 * serializes concurrent /distill calls within the server process, so no
 * in-process tally is needed). The nightly consolidation is a SEPARATE process
 * that also writes state.json; a rare cross-process write collision can lose a
 * small increment — negligible on a multi-million-token monthly budget. A
 * DB-backed counter (WAL transactions serialize across processes) is the future
 * hardening if it ever matters.
 */
import { loadState, updateState } from "./state.js";
import { shouldThrottleTokens } from "./consolidate.js";

/** Env override (hosted: provider-set, tenant-immutable at runtime). */
const TOKEN_CAP_ENV = "HICORTEX_TOKEN_CAP";

let cap = 0;
/** periodStart we last emitted the 80% warning at, to dedup within a period. */
let warnedPeriod: string | null = null;

/**
 * Resolve the effective cap: env (HICORTEX_TOKEN_CAP) takes precedence over the
 * config key. A positive, finite env wins; otherwise the config value (0/absent
 * = unlimited). Pure — exported for tests.
 */
export function resolveTokenCap(configCap: unknown): number {
  const envCap = Number(process.env[TOKEN_CAP_ENV]);
  if (Number.isFinite(envCap) && envCap > 0) return envCap;
  const cfg = Number(configCap);
  return Number.isFinite(cfg) && cfg > 0 ? cfg : 0;
}

/**
 * Initialise at server boot (after stateDir is known). Resolves + caches the cap
 * and seeds the 80%-warn dedup so a restart mid-period doesn't re-warn.
 */
export function initTokenBudget(stateDir: string, configCap: unknown): void {
  cap = resolveTokenCap(configCap);
  if (cap > 0) {
    const p = loadState(stateDir).llmTokensThisPeriod;
    warnedPeriod = p && p.total >= cap * 0.8 ? (p.periodStart ?? null) : null;
    // Label the source truthfully: only claim env if the env value was actually
    // used (a malformed env falls back to config, so the label must not lie).
    const fromEnv = Number(process.env[TOKEN_CAP_ENV]) === cap;
    console.log(`[hicortex] Token budget: ${cap.toLocaleString()}/month${fromEnv ? " (HICORTEX_TOKEN_CAP)" : ""}`);
  }
}

/** The resolved monthly cap (0 = unlimited / enforcement off). */
export function getTokenCap(): number {
  return cap;
}

/**
 * Pre-call check for /distill: refuse (429) when the tenant is already at/over
 * the monthly cap. Reuses `shouldThrottleTokens(cap, period, 0)` — lastRunTokens
 * is 0 because we cannot predict a call's cost before making it, so this refuses
 * only when already over (a tenant exactly at the cap is refused on the next
 * call). Reads state.json fresh so the nightly process's writes are reflected.
 */
export function isTokenBudgetExceeded(stateDir: string): boolean {
  if (cap <= 0) return false;
  const period = loadState(stateDir).llmTokensThisPeriod;
  return shouldThrottleTokens(cap, period, 0).throttle;
}

/**
 * After a successful distill, add the consumed tokens to the monthly counter and
 * emit the 80% warning once per period. Synchronous read-modify-write via
 * `updateState` (serializes concurrent in-process /distill; picks up the nightly
 * process's writes via the fresh read). Accumulates the full breakdown
 * (prompt/completion/total) so the dashboard's prompt+completion stays
 * consistent with total (distill + consolidation).
 */
export function recordDistillUsage(
  stateDir: string,
  usage: { prompt: number; completion: number; total: number },
): void {
  // Record ALWAYS; the cap only governs ENFORCEMENT (isTokenBudgetExceeded)
  // and the 80% warning below. Without this, an uncapped install (self-hosted
  // default) never accrues distill tokens into the period meter, so the
  // dashboard's monthly headline read consolidation-only while the per-run
  // chart next to it showed true (distill-inclusive) totals — numbers on the
  // same card telling different stories (#287 CR). Always-recording makes the
  // meter the honest "what did this install spend" number everywhere.
  if (usage.total <= 0) return;
  let newTotal = 0;
  let periodStart = "";
  updateState((s) => {
    const prev = s.llmTokensThisPeriod;
    // Monthly reset (year+month) — matches shouldThrottleTokens's staleness check.
    const stale =
      !prev?.periodStart ||
      new Date(prev.periodStart).getUTCFullYear() !== new Date().getUTCFullYear() ||
      new Date(prev.periodStart).getUTCMonth() !== new Date().getUTCMonth();
    if (stale) {
      s.llmTokensThisPeriod = {
        prompt: usage.prompt,
        completion: usage.completion,
        total: usage.total,
        periodStart: new Date().toISOString(),
      };
    } else {
      const base = prev as NonNullable<typeof prev>;
      s.llmTokensThisPeriod = {
        prompt: (base.prompt ?? 0) + usage.prompt,
        completion: (base.completion ?? 0) + usage.completion,
        total: (base.total ?? 0) + usage.total,
        periodStart: base.periodStart,
      };
    }
    newTotal = s.llmTokensThisPeriod.total;
    periodStart = s.llmTokensThisPeriod.periodStart;
  }, stateDir);
  // 80% warning — dedup per period (once per month per threshold crossing).
  // Cap-gated by design: no cap → no percentage to warn about.
  if (cap > 0 && periodStart && warnedPeriod !== periodStart && newTotal >= cap * 0.8) {
    warnedPeriod = periodStart;
    const pct = Math.round((newTotal / cap) * 100);
    console.warn(`[hicortex] Token usage at ${pct}% of monthly cap (${newTotal.toLocaleString()}/${cap.toLocaleString()}).`);
  }
}
