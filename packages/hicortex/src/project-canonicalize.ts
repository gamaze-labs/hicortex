/**
 * Project-identity canonicalization (#567).
 *
 * The SAME project arrives under different labels: `hicortex` vs `Hicortex`
 * (case comes from the session-root dir name) split one project across two,
 * and junk labels (`default`, version-suffix numerics like `3`) carry no
 * project identity at all. Measured on the 22,691-memory corpus audit (#565
 * WS1): 5,544 rows split on case alone, 14% of the corpus under junk labels,
 * and project mismatch blocking 59 of 69 near-duplicate clusters in
 * `hicortex dedup` (423 excess rows). Every comparison that keys on project
 * (recall affinity, lesson selection, the dedup project rail) is exact
 * `===` — so variants break affinity that should exist.
 *
 * The fix is ONE pure normalization applied at every project-string entry
 * point (server) plus the client-side comparison site (the CC SessionStart
 * hook): trim → lowercase → ONE explicit alias hop. Nothing else:
 *
 *   - NO separator folding, NO edit distance, NO embedding similarity — two
 *     genuinely different labels never collapse without an explicit
 *     `projectAliases` entry (the #567 anti-goal: a rename must never merge
 *     two real projects).
 *   - The alias map is owner-curated config (`projectAliases` in
 *     config.json), folded at read, never scaffolded by init (an alias map
 *     has no sane generic default — the telemetry-key precedent).
 *
 * `hicortex reconcile-projects` (reconcile-projects.ts) applies the same
 * function to EXISTING rows so the corpus heals without silent rewrites.
 */

/**
 * The mechanical fold: trim + lowercase. Labels are dir-name derived and
 * display-lowercase was accepted by the owner (no case-preservation
 * machinery — Option 3 stayed rejected), so this is the whole canonical
 * alphabet.
 */
export function foldProjectLabel(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Canonicalize one project label: fold, then ONE alias hop
 * (`aliases[folded] ?? folded`). Absent/blank input (or a non-string) →
 * null — callers store/compare SQL NULL, never a whitespace label.
 *
 * Exactly ONE hop: an alias-of-alias (`a → b`, `b → c`) is NOT followed —
 * canonicalize(a) is `b`, not `c`. The map is a flat renaming table, not a
 * chain; parseProjectAliases rejects hop CYCLES loudly at load, but chains
 * are legal (and single-hop by design) — curate the map to point every
 * synonym directly at its canonical label.
 *
 * Prototype-safe: the hop uses an own-property lookup, so a label like
 * `"constructor"` can never resolve through the Object prototype chain.
 */
export function canonicalizeProject(
  raw: string | null | undefined,
  aliases?: Readonly<Record<string, string>> | null,
): string | null {
  if (typeof raw !== "string") return null;
  const folded = foldProjectLabel(raw);
  if (folded === "") return null;
  if (aliases && Object.hasOwn(aliases, folded)) return aliases[folded];
  return folded;
}

/**
 * Read + validate the `projectAliases` config key (`{ "raw": "canonical" }`).
 * Boundary posture per config-read.ts (the parseHours whole-list precedent):
 *
 *   - key absent → null (no aliases — mechanical fold only);
 *   - not a plain object → warn + null;
 *   - every key AND target folded through foldProjectLabel, so
 *     `{"Hicortex ": " Work "}` behaves as `{"hicortex": "work"}`;
 *   - a non-string target, or a key/target that folds to an empty label →
 *     warn naming the key, drop just that entry (an alias to/from nothing
 *     is a config slip);
 *   - a NON-TRIVIAL cycle (following hops from a key returns to it in ≥2
 *     hops — e.g. `a→b, b→a`) → warn naming the cycle and reject the WHOLE
 *     map (→ null). A cyclic map contradicts itself under the one-hop
 *     lookup (fold(a)=b while fold(b)=a — the labels can never converge),
 *     so it is an operator error to notice, not half-apply. A self-map
 *     `a→a` returns to its key in 1 hop — a harmless no-op, kept folded.
 *
 * A map whose every entry was dropped resolves to null (nothing to alias).
 */
export function parseProjectAliases(
  config: Record<string, unknown> | null | undefined,
): Readonly<Record<string, string>> | null {
  if (!config) return null;
  const v = config.projectAliases;
  if (v === undefined) return null;
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    console.warn('[hicortex] config "projectAliases" is not an object — ignored.');
    return null;
  }
  const out: Record<string, string> = {};
  for (const [rawKey, rawTarget] of Object.entries(v)) {
    if (typeof rawTarget !== "string") {
      console.warn(
        `[hicortex] config "projectAliases"."${rawKey}" target is not a string — entry dropped.`,
      );
      continue;
    }
    const key = foldProjectLabel(rawKey);
    const target = foldProjectLabel(rawTarget);
    if (key === "" || target === "") {
      console.warn(
        `[hicortex] config "projectAliases"."${rawKey}" folds to an empty label — entry dropped.`,
      );
      continue;
    }
    out[key] = target;
  }
  const keys = Object.keys(out);
  // Cycle rejection: walk hops from every key, bounded by the map size (a
  // longer walk must revisit a node — either the start, found here, or a
  // member of a cycle the walk from THAT member will find).
  for (const key of keys) {
    let cur: string | undefined = key;
    for (let hops = 0; hops < keys.length; hops++) {
      cur = Object.hasOwn(out, cur!) ? out[cur!] : undefined;
      if (cur === undefined) break;
      if (cur === key) {
        if (hops + 1 >= 2) {
          console.warn(
            `[hicortex] config "projectAliases" contains a cycle through "${key}" ` +
              `(single-hop lookup: "${key}" → "${out[key]}" but they can never converge) — ` +
              `the whole alias map is ignored. Point every synonym directly at its canonical label.`,
          );
          return null;
        }
        break; // self-map at hop 1 — harmless no-op
      }
    }
  }
  return keys.length > 0 ? out : null;
}
