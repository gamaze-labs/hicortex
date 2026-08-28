/**
 * Human-term labels + normalization for the `memory_type` enum (#264 final).
 *
 * The DB column `memories.memory_type` stores the four CANONICAL human terms:
 *   knowledge / experience / decisions / learnings
 * These replaced the older raw internal enum (fact/episode/decision/lesson)
 * via migration v13. Every SQL query, the distiller's type tag mapping, the
 * type-classify prompt, and the CREATE TABLE default all use the new terms.
 *
 * Backward-compat window: the OLD raw values are still accepted on the
 * request/agent wire (REST `/ingest` + `/update`, MCP tools, OC + Hermes
 * plugin schemas) and normalized to the new canonical value before any DB
 * write via {@link normalizeMemoryType}. The label map also still carries
 * the old keys so a briefly-stale reader (e.g. a snapshot taken mid-migrate)
 * renders correctly.
 *
 * Mapping (decided 2026-08-11, research/2026-08-11-identity-reframe-brainstorm.md):
 *   fact     → knowledge
 *   episode  → experience
 *   decision → decisions
 *   lesson   → learnings
 *
 * Unknown / future types fall back to the raw value (never silently remapped).
 */

/**
 * The four canonical memory types mapped to their human-term labels, PLUS the
 * legacy raw keys kept during the backward-compat window (old values may appear
 * briefly in snapshots taken before migration v13, or in-flight requests from
 * older clients). Kept as a plain record so it can be iterated for coverage
 * assertions.
 */
export const MEMORY_TYPE_LABELS: Record<string, string> = {
  // Canonical (post-v13) values.
  knowledge: "Knowledge",
  experience: "Experience",
  decisions: "Decisions",
  learnings: "Learnings",
  // Legacy raw enum (kept so stale readers render correctly during the
  // migration window). Same labels — these are the SAME types, renamed.
  fact: "Knowledge",
  episode: "Experience",
  decision: "Decisions",
  lesson: "Learnings",
};

/**
 * Return the human-term label for a `memory_type` value (canonical OR legacy).
 * Unknown or future types (including null/undefined) fall back to the raw
 * input so new types are visible rather than silently mislabeled.
 */
export function labelForType(t: string | null | undefined): string {
  if (!t) return "—";
  return MEMORY_TYPE_LABELS[t] ?? t;
}

/**
 * Map BOTH legacy raw enum values AND canonical human terms TO the canonical
 * value stored in the DB (post-v13). Used to normalize request input
 * (`/ingest`, `/update`, MCP tools) so the wire/agent surface accepts the old
 * vocabulary while the storage layer always sees the canonical term.
 * Unknown inputs pass through untouched so the caller's own validation can
 * reject them with a precise error (this helper never silently remaps).
 *
 * Lookup is case-insensitive on the input (the human terms are documented in
 * Titlecase but agents/users send any casing); the four canonical values and
 * the four legacy raw values are all lowercase in the DB.
 */
const TO_CANONICAL: Record<string, string> = {
  // Legacy raw → canonical.
  fact: "knowledge",
  episode: "experience",
  decision: "decisions",
  lesson: "learnings",
  // Canonical passthrough (also covered case-insensitively).
  knowledge: "knowledge",
  experience: "experience",
  decisions: "decisions",
  learnings: "learnings",
};

/**
 * Normalize a `memory_type` input (from a request body, MCP tool arg, etc.)
 * to the canonical value the DB stores (post-v13). Accepts the four legacy
 * raw enum values (fact/episode/decision/lesson, mapped to the new terms) AND
 * the four canonical human terms (passthrough). Unknown values pass through
 * verbatim — the caller validates.
 */
export function normalizeMemoryType(input: string): string {
  return TO_CANONICAL[input.toLowerCase()] ?? input;
}

/**
 * The full accept-set for input validation: the four canonical values plus the
 * four legacy raw values (kept for backward compat of older clients). Exposed
 * so every validating surface (REST `/ingest`, `/update`, MCP zod enums, OC
 * JSON-schema enums, the Hermes plugin) lists the SAME accepted values — no
 * drift. Compare membership case-insensitively (caller normalizes via
 * {@link normalizeMemoryType} before the DB write).
 */
export const ACCEPTED_MEMORY_TYPES: readonly string[] = Object.freeze([
  "knowledge", "experience", "decisions", "learnings",
  "fact", "episode", "decision", "lesson",
]);

/**
 * True if `input` is one of the accepted memory_type values (canonical OR
 * legacy raw, any casing). Use this as the validation gate; follow with
 * {@link normalizeMemoryType} to map the accepted value to the canonical term.
 */
export function isAcceptedMemoryType(input: string): boolean {
  return ACCEPTED_MEMORY_TYPES.includes(input.toLowerCase());
}
