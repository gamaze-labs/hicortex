/**
 * The ONE cooperative wall-clock deadline for a nightly run (#405).
 *
 * Generalizes the #401/#402/#404 reconsolidation pattern (a deadline checked
 * at safe boundaries + resumable cursors) from one stage to the whole
 * pipeline: capture segments, every consolidation stage boundary, the
 * item loops, and the deterministic merge zone all check the SAME deadline,
 * created once at nightly start. On expiry each check site stops cleanly at
 * its last safe boundary — cursors (capture per-session, supersession,
 * reconsolidation) hold below unconfirmed work, so the next run resumes
 * without redoing confirmed work or losing deferred work.
 *
 * Deferral is a REPORTED outcome, not an error: a run whose deadline fired
 * reports consolidation status "deferred" and does NOT advance
 * `lastConsolidated` (the same gate as endpoint_down — otherwise the
 * pending-set queries would silently lose the deferred work).
 *
 * One structured log line per deferred stage (`event=deadline_deferred`,
 * the same key=value style as `event=budget_exhausted` /
 * `event=circuit_open`) so `grep event=deadline_deferred` is one of the two
 * nightly health greps.
 */

import { readPositiveConfig } from "./config-read.js";

/** Default wall-clock budget for a full nightly run, in minutes (#405).
 *  240 sits between the old stage-local reconsolidation clock (120) and the
 *  old systemd backstop (360) — the deadline is now the operating bound and
 *  the unit backstop (budget + 60 min slack) only catches a true hang. */
export const DEFAULT_NIGHTLY_TIME_BUDGET_MINUTES = 240;

/**
 * Cooperative deadline handle. Injectable clock (`now`) so tests can pin or
 * advance time deterministically (the reconsolidation.test.ts 0.000001-minute
 * pattern). All methods are safe to call after expiry — they keep answering.
 */
export interface RunDeadline {
  /** Absolute epoch-ms timestamp the run must finish by. */
  readonly deadlineAt: number;
  /** Milliseconds left until the deadline (never negative). */
  remainingMs(): number;
  /** True once the clock has passed the deadline. */
  expired(): boolean;
  /**
   * Check + record in one call: returns true when the deadline has fired,
   * logging `event=deadline_deferred stage=<name>` ONCE per stage name (a
   * boundary check and in-loop checks for the same stage log once). Use the
   * same stage name at a stage's boundary and inside its loops.
   */
  hit(stage: string): boolean;
  /** Stage names that deferred so far this run (insertion order). */
  deferredStages(): readonly string[];
}

/**
 * Create a run deadline of `minutes` (already-resolved value; see
 * resolveNightlyTimeBudgetMinutes for the config boundary).
 */
export function createRunDeadline(
  minutes: number,
  now: () => number = Date.now,
): RunDeadline {
  const start = now();
  const deadlineAt = start + Math.max(0, Math.round(minutes * 60_000));
  const logged = new Set<string>();
  const deferred: string[] = [];
  return {
    deadlineAt,
    remainingMs: () => Math.max(0, deadlineAt - now()),
    expired: () => now() >= deadlineAt,
    hit(stage: string): boolean {
      if (now() < deadlineAt) return false;
      if (!logged.has(stage)) {
        logged.add(stage);
        deferred.push(stage);
        // Structured (grep-able) + human-readable — same contract as
        // event=budget_exhausted (consolidate.ts) and event=circuit_open
        // (llm.ts). remaining_ms=0 states the reason plainly.
        console.warn(
          `[hicortex] event=deadline_deferred stage=${stage} ` +
            `deadline_minutes=${(deadlineAt - start) / 60_000} remaining_ms=0`,
        );
      }
      return true;
    },
    deferredStages: () => deferred,
  };
}

/**
 * Resolve `nightlyTimeBudgetMinutes` from the saved config (#405): positive
 * finite number wins; absent/0/invalid → the 240 default. Unlike the old
 * `reconsolidationMaxMinutes`, 0 does NOT disable — there is ALWAYS a
 * deadline (readPositiveConfig rejects 0 with a warn, which is the loud
 * migration signal for an operator who used 0 as "off").
 */
export function resolveNightlyTimeBudgetMinutes(
  config: Record<string, unknown> | null | undefined,
): number {
  return readPositiveConfig(
    config ?? {},
    "nightlyTimeBudgetMinutes",
    DEFAULT_NIGHTLY_TIME_BUDGET_MINUTES,
  );
}
