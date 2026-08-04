/**
 * No-fit lifecycle — weak-primary floor + no-association decay
 * (owner amendment 07.07 to specs/2026-07-07-graded-schema-memory-tags.md).
 *
 * THE MODEL
 * ---------
 * "Unsorted" is a non-tag: the vocabulary carries NO fallback category, and a
 * genuine LLM no-fit is an EMPTY tag set (domain-classify.ts returns
 * {tags: []}). Every stored memory should still end up with a primary if it
 * reasonably can, so on a no-fit the pipeline derives:
 *
 *   1. WEAK PRIMARY — argmax cosine of the memory embedding across ALL domain
 *      prototypes (schema-prototypes.bestPrototypeMatch). If the best cosine
 *      >= `weakPrimaryFloor`, the memory is tagged with that single domain
 *      (the primary derives naturally via storage.setMemoryTags). It lives —
 *      humbly, with one weak association.
 *
 *   2. NO ASSOCIATION — best cosine below the floor means the memory
 *      associates with nothing the owner cares about. It is NOT tagged;
 *      instead its base_strength is HALVED (floored at
 *      NO_ASSOCIATION_MIN_STRENGTH) so the existing decay/prune stage
 *      eventually removes it. domain stays NULL, which keeps the memory in
 *      the nightly staleness scope: every subsequent run re-classifies it
 *      (prototypes evolve — it may fit later) and re-halves ONLY when it is
 *      still a no-fit below the floor.
 *
 * COLD-START SAFETY: prototypes are ALWAYS available before any no-fit
 * evaluation — computeDomainPrototypes seeds every configured domain from its
 * description embedding when it has <5 members, so a fresh install cannot
 * produce a null prototype for a configured domain and therefore cannot
 * mass-decay a new corpus. A missing MEMORY embedding routes to null (decay
 * candidate), never to a false weak-primary.
 *
 * RESCUE PATHS (survivability):
 *   - Access: storage.strengthenMemory bumps access_count — and
 *     stageDecayPrune only ever considers access_count = 0 memories
 *     (storage.getPruneCandidates), so a single recall permanently shields a
 *     memory from pruning. Halving does not touch last_accessed/access_count.
 *   - Re-classification: a later run whose LLM tags it, or whose evolved
 *     prototypes clear the floor, gives it a (weak) primary — halving stops.
 *     Its strength is NOT restored; only access does that job.
 *
 * PRUNE INTERACTION (verified against stageDecayPrune + effectiveStrength):
 * prune fires when effectiveStrength < 0.01 for a >90-day-old, never-accessed
 * memory. effectiveStrength has an asymptotic floor of base_strength² × 0.1,
 * so at the default 0.5 a memory can NEVER prune (floor 0.025 > 0.01) —
 * halving is what makes pruning reachable at all. From 0.5: four nightly
 * halvings reach the 0.05 strength floor (0.25 → 0.125 → 0.0625 → 0.05); at
 * 0.05 the decay curve crosses 0.01 roughly 143 days after last access.
 */

import type Database from "better-sqlite3";
import type { DomainDef } from "./types.js";
import * as storage from "./storage.js";
import { bestPrototypeMatch } from "./schema-prototypes.js";

/**
 * Default weak-primary floor: minimum cosine(memory embedding, best domain
 * prototype) for a no-fit memory to earn a weak primary.
 *
 * TUNING: 0.45 is a starting point for bge-small-en-v1.5 embeddings — it
 * should be tuned from the actual corpus weight distribution (e.g. inspect
 * the memory_tags.weight histogram of LLM-tagged rows and set the floor
 * near its lower tail). Override per install via `weakPrimaryFloor` in
 * ~/.hicortex/config.json.
 */
export const DEFAULT_WEAK_PRIMARY_FLOOR = 0.45;

/** Halving never takes base_strength below this (survivable, not zeroed). */
export const NO_ASSOCIATION_MIN_STRENGTH = 0.05;

/**
 * Resolve the weak-primary floor from a raw config object. Accepts a finite
 * number in (0, 1); anything else (absent, wrong type, out of range) falls
 * back to DEFAULT_WEAK_PRIMARY_FLOOR with a warning for invalid values.
 */
export function resolveWeakPrimaryFloor(
  config: Record<string, unknown> | null | undefined,
): number {
  const raw = config?.weakPrimaryFloor;
  if (raw === undefined || raw === null) return DEFAULT_WEAK_PRIMARY_FLOOR;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0 && raw < 1) {
    return raw;
  }
  console.warn(
    `[hicortex] invalid weakPrimaryFloor in config (${JSON.stringify(raw)}) — ` +
      `must be a number in (0, 1); using default ${DEFAULT_WEAK_PRIMARY_FLOOR}`,
  );
  return DEFAULT_WEAK_PRIMARY_FLOOR;
}

/** Outcome of resolving a no-fit memory against the domain prototypes. */
export type NoFitResolution =
  | { kind: "weak_primary"; domain: string; weight: number }
  | { kind: "no_association"; bestWeight: number | null };

/**
 * Decide what happens to a no-fit memory (READ-ONLY — no writes, so callers
 * batching writes into a transaction can decide during the scan phase):
 * best prototype cosine >= floor → weak_primary; below the floor (or no
 * embedding / no prototypes at all) → no_association.
 */
export function resolveNoFit(
  db: Database.Database,
  memoryId: string,
  domains: DomainDef[],
  prototypes: Map<string, Float32Array>,
  floor: number,
): NoFitResolution {
  const best = bestPrototypeMatch(db, memoryId, domains, prototypes);
  if (best && best.weight >= floor) {
    return { kind: "weak_primary", domain: best.domain, weight: best.weight };
  }
  return { kind: "no_association", bestWeight: best?.weight ?? null };
}

/**
 * Apply a weak primary: tag the memory with the single argmax domain (the
 * primary derives naturally inside setMemoryTags). Logged distinctly so
 * weak primaries are auditable apart from LLM-tagged rows.
 */
export function applyWeakPrimary(
  db: Database.Database,
  memoryId: string,
  domain: string,
  weight: number,
): void {
  storage.setMemoryTags(db, memoryId, [domain], {
    weights: { [domain]: weight },
  });
  console.log(
    `[hicortex] weak-primary ${domain} w=${weight.toFixed(2)} for ${memoryId}`,
  );
}

/**
 * Apply no-association decay to a no-fit-below-floor memory:
 *   - clear any leftover memory_tags rows (e.g. a legacy "Unsorted" tag from
 *     a domain since removed from the config) so refreshPrimaries cannot
 *     resurrect a primary from them,
 *   - set domain to NULL (keeps the memory in the nightly staleness scope —
 *     re-attempted every run as prototypes evolve),
 *   - HALVE base_strength, floored at NO_ASSOCIATION_MIN_STRENGTH.
 *
 * Does NOT touch last_accessed / access_count — access-strengthening remains
 * the rescue path (prune only ever considers access_count = 0 memories).
 * Called at most once per memory per run (each pipeline pass visits a memory
 * exactly once), so a single run never double-halves.
 */
export function applyNoAssociationDecay(
  db: Database.Database,
  memoryId: string,
): { previous: number; next: number } {
  const mem = storage.getMemory(db, memoryId);
  if (!mem) {
    throw new Error(`applyNoAssociationDecay: memory not found: ${memoryId}`);
  }
  const previous = mem.base_strength ?? 0.5;
  const next = Math.max(NO_ASSOCIATION_MIN_STRENGTH, previous / 2);

  const tx = db.transaction(() => {
    db.prepare("DELETE FROM memory_tags WHERE memory_id = ?").run(memoryId);
    storage.updateMemory(db, memoryId, { base_strength: next, domain: null });
  });
  tx();

  console.log(
    `[hicortex] no-association decay ${memoryId}: base_strength ` +
      `${previous.toFixed(3)} → ${next.toFixed(3)} (below weak-primary floor)`,
  );
  return { previous, next };
}
