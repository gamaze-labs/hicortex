/**
 * Memory maturity stages — the console's derived presentation layer
 * (#409/#421 Phase 1).
 *
 * The E-reframe (standing ruling in the #409 thread): stages are DERIVED
 * presentation of the one numeric strength signal, never stored state. This
 * module holds the pure derivation only — thresholds live in calibration.ts
 * (the #408 single home, release-managed with the evolution contract); no
 * db, no I/O, no config reads.
 *
 * Wire keys are forming/belief/truth/fading (lifecycle order). The console
 * renders human labels over these keys; nothing else consumes them.
 */

import {
  STAGE_FADING_DAYS,
  STAGE_FADING_STRENGTH,
  STAGE_BELIEF_STRENGTH,
  STAGE_TRUTH_STRENGTH,
} from "./calibration.js";

/** A memory's derived maturity stage (lifecycle order). */
export type Stage = "forming" | "belief" | "truth" | "fading";

/** The four stages in lifecycle order: forming → belief → truth → fading. */
export const STAGE_KEYS: readonly Stage[] = ["forming", "belief", "truth", "fading"];

/**
 * Derive a memory's stage from its effective strength and recency.
 *
 * The recency gate runs FIRST: a memory untouched for
 * STAGE_FADING_DAYS days is Fading no matter how strong it is — decay is a
 * function of access in this system (effectiveStrength already folds
 * last_accessed in, but the gate makes long silence legible on its own).
 * Then the strength bands (calibrated against the measured production
 * distribution — see calibration.ts): < FADING → fading (the weak cluster),
 * ≥ TRUTH → truth, ≥ BELIEF → belief, else forming.
 *
 * `daysSinceAccess` is whole days (UTC day diff is fine — capture is
 * night-resolution) since the memory was last touched. The DASHBOARD handler
 * passes days since `last_accessed`, falling back to days since `created_at`
 * when last_accessed is NULL (never accessed since ingest — creation is the
 * last real signal). `null` means "recency unknown" and skips the gate
 * (strength-only derivation) — the handler never sends it; it exists so the
 * function is total over caller data quality.
 */
export function deriveStage(
  effectiveStrength: number,
  daysSinceAccess: number | null,
): Stage {
  if (daysSinceAccess !== null && daysSinceAccess >= STAGE_FADING_DAYS) {
    return "fading";
  }
  if (effectiveStrength < STAGE_FADING_STRENGTH) return "fading";
  if (effectiveStrength >= STAGE_TRUTH_STRENGTH) return "truth";
  if (effectiveStrength >= STAGE_BELIEF_STRENGTH) return "belief";
  return "forming";
}
