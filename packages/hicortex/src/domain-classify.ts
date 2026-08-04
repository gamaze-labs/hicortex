/**
 * Content-based memory MULTI-TAG classification (feat/memory-tags).
 *
 * WHY THIS EXISTS
 * ---------------
 * The nightly's legacy `stageDomainCuration` groups PROJECTS into domains and
 * assigns every memory its project's domain. For an owner whose "projects" are
 * often AGENT names (alice, bob, ...), one agent produces memories spanning
 * many life areas, so life-memories get smeared under the agent. This module
 * classifies a single memory into life-spheres by its CONTENT, drawn from a
 * user-curated vocabulary in ~/.hicortex/config.json (`domains`).
 *
 * GRADED SCHEMA TAGS (spec 2026-07-07, supersedes the LLM-picked primary from
 * PR #152/#153): a memory genuinely spans spheres — "set up the server for the
 * agent fleet" is both Hardware AND Ventures. The classifier now returns ONLY
 * the discrete part:
 *   - `tags`: 0..N vocabulary names that genuinely apply, MOST-RELEVANT FIRST
 *     (the order is used solely as an exact-weight tiebreak downstream).
 * The PRIMARY (memories.domain) is NO LONGER requested from the LLM — audits
 * proved LLM primaries a coin-flip on overlapping spheres. It is DERIVED
 * deterministically (argmax association weight, LLM tag order breaking ties) in
 * schema-prototypes.ts / storage.setMemoryTags.
 *
 * NO-FIT = EMPTY TAG SET (owner amendment 07.07): "Unsorted" is a non-tag —
 * there is NO fallback category in the vocabulary and no configured domain is
 * ever auto-assigned on a no-fit. A genuine no-fit is the distinct result
 * `{tags: []}`; the CALLER then derives a weak primary from prototype cosines
 * (>= the weakPrimaryFloor) or, below the floor, applies accelerated decay
 * (see nofit.ts). If a user still configures a domain named "Unsorted", it is
 * just a normal domain with no special semantics.
 *
 * The `project` name is passed to the classifier as a HINT (content wins;
 * project only breaks ties). This rescues terse technical memories from
 * projects whose content alone reads as ambiguous.
 *
 * The classifier makes ONE constrained LLM call per memory (via the classify
 * tier — classifyModel/classifyBaseUrl when configured, else the reflect
 * tier), validates every returned name against the configured vocabulary
 * (case-insensitive), and retries once on an invalid/unparseable reply.
 *
 * ROBUSTNESS (folds in issue #150):
 *   - Successful classification with no genuine fit → {tags: []} (no-fit).
 *   - LLM/endpoint ERROR (throws after the retry) → returns NULL. The caller
 *     leaves the memory unclassified and retries it on a later run. Infra
 *     errors must NOT be filed anywhere (that mis-labels good memories).
 *
 * SCOPE: sphere-level tags only. Sub-labels within a sphere are a future phase.
 *
 * Example owner vocabulary (documented, NOT hardcoded — lives in config.json):
 *   Work, Ventures, Hardware, Finances, Property, Vehicles, Boating, Health,
 *   Family, People, Travel
 */

import { createHash } from "node:crypto";
import type { LlmClient } from "./llm.js";
import type { DomainDef } from "./types.js";

export type { DomainDef };

/** Max characters of memory content fed to the classifier prompt. */
export const CLASSIFY_CONTENT_MAX_CHARS = 1500;

/**
 * Parse and validate the `domains` field from a raw config.json object.
 * Returns a clean DomainDef[] (name + description both non-empty strings) or
 * null when the field is absent or malformed — null means "content
 * classification is NOT active; keep the legacy project-grouping path".
 *
 * A present-but-empty array is treated as null (nothing to classify into).
 */
export function parseConfigDomains(config: Record<string, unknown> | null | undefined): DomainDef[] | null {
  const raw = config?.domains;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: DomainDef[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const d = item as Record<string, unknown>;
    const name = typeof d.name === "string" ? d.name.trim() : "";
    const description = typeof d.description === "string" ? d.description.trim() : "";
    if (!name) continue;
    const def: DomainDef = { name, description };
    out.push(def);
  }
  return out.length > 0 ? out : null;
}

/**
 * Stable cache-invalidation key for a configured domain set: sha256 of the
 * sorted, lowercased domain names. Changing the list (add/remove/rename)
 * changes the hash and triggers a re-file of affected rows.
 */
export function domainSetHash(domains: DomainDef[]): string {
  const names = domains.map((d) => d.name.trim().toLowerCase()).sort();
  return createHash("sha256").update(JSON.stringify(names)).digest("hex");
}

/**
 * Match an LLM reply against the configured domain set (case-insensitive).
 * Returns the CANONICAL name from the config (preserving its casing) or null.
 *
 * Tolerates common LLM decorations: surrounding quotes, a trailing period,
 * a leading "Domain:" label, and markdown emphasis. The match is exact on the
 * normalized token — we do NOT substring-match, to avoid "People" matching
 * inside "Peoples' court" style noise.
 */
export function matchDomain(reply: string, domains: DomainDef[]): string | null {
  if (!reply) return null;
  let cleaned = reply.trim();

  // Take the first non-empty line — models sometimes add a justification below.
  const firstLine = cleaned.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  if (firstLine) cleaned = firstLine;

  // Strip a leading label like "Domain:" / "Answer:".
  cleaned = cleaned.replace(/^(domain|answer|category|sphere)\s*[:\-]\s*/i, "");
  // Strip markdown emphasis, surrounding quotes/backticks, trailing punctuation.
  cleaned = cleaned
    .replace(/^[*_`"'\s]+/, "")
    .replace(/[*_`"'.\s]+$/, "")
    .trim();

  const norm = cleaned.toLowerCase();
  for (const d of domains) {
    if (d.name.trim().toLowerCase() === norm) return d.name;
  }
  return null;
}

/**
 * Result of a successful multi-tag classification.
 *   - `tags`: 0..N vocabulary names that genuinely apply, MOST-RELEVANT FIRST
 *     (LLM order — used downstream only as an exact-weight tiebreak), deduped,
 *     all members of the configured vocabulary.
 *   - An EMPTY array is a distinct, VALID result: genuine no-fit (owner
 *     amendment 07.07 — no fallback category). Callers route it through the
 *     weak-primary / no-association-decay path (nofit.ts). It is NOT the same
 *     as null (null = infra error → skip and retry later).
 *
 * There is deliberately NO `primary` field (graded-schema spec 2026-07-07):
 * the primary is derived from association weights, never from the LLM.
 */
export interface TagResult {
  tags: string[];
}

/**
 * Build the constrained multi-tag classification prompt.
 *
 * Includes: the vocabulary (names + descriptions), the (truncated) memory
 * content, and the source `project` name as a HINT. The model is instructed to
 * apply EVERY genuinely-applicable tag (with an explicit multi-tag emphasis —
 * things the owner builds usually carry both the venture/project domain AND
 * the life topic they touch) and reply with ONLY a `{"tags": [...]}` object,
 * most-relevant first. No primary, no weights, no ranks — the LLM decides
 * only DISCRETE membership; all gradation is derived from embeddings.
 *
 * The emphasis sentence is GENERIC by design: concrete pairings (which venture
 * touches which topic) must come from the configured domain DESCRIPTIONS, not
 * from hardcoded examples in the product prompt.
 *
 * The project hint is deliberately weak ("content wins, project only breaks
 * ties") — it rescues terse technical memories whose content alone reads as
 * ambiguous, without letting the project name override clear content signals.
 */
export function buildClassifyPrompt(
  content: string,
  project: string | null | undefined,
  domains: DomainDef[],
): string {
  const list = domains.map((d) => `- ${d.name}: ${d.description}`).join("\n");
  const truncated = content.length > CLASSIFY_CONTENT_MAX_CHARS
    ? content.slice(0, CLASSIFY_CONTENT_MAX_CHARS) + "…"
    : content;
  const projectHint = project && project.trim()
    ? `Source project: ${project.trim()} — a useful signal, but classify by ` +
      `content; content wins, the project only breaks ties.\n\n`
    : "";
  return (
    `You are tagging a single memory with life-sphere domains.\n\n` +
    `DOMAINS (name: description):\n${list}\n\n` +
    projectHint +
    `MEMORY:\n${truncated}\n\n` +
    `Apply EVERY domain that genuinely applies — memories often span several. ` +
    `Memories about things the owner builds or runs usually carry BOTH the ` +
    `venture/project domain AND the life topic they touch. ` +
    `List 1-4 domains, most relevant first. ` +
    `If none genuinely fits, reply {"tags": []}.\n` +
    `Reply with ONLY a JSON object, no prose:\n` +
    `{"tags": ["<most relevant domain>", "<next domain>", ...]}\n` +
    `Every name MUST come from the list above.`
  );
}

/**
 * Parse the model reply into a validated, ORDERED {tags} against the
 * vocabulary.
 *
 * Return values (three distinct outcomes):
 *   - {tags: [...]} — >= 1 valid vocabulary tag (canonical-cased, ordered).
 *   - {tags: []}    — the model EXPLICITLY replied with an empty tags array:
 *     genuine no-fit (owner amendment 07.07). NOT retried by the caller.
 *   - null          — unparseable reply, missing/non-array `tags`, or a
 *     NON-EMPTY tags array in which no name matched the vocabulary (invalid
 *     names are dropped — an all-invalid reply is a bad reply, not a no-fit).
 *     The caller retries once.
 *
 * Accepts a JSON object with `tags`, tolerating code-fence wrapping and
 * surrounding prose. The legacy `{"primary": ..., "tags": [...]}` shape is
 * ACCEPTED for tolerance (older models / cached prompts may still emit it) but
 * `primary` is IGNORED — nothing is derived from it (graded-schema spec: the
 * primary comes from weights, never the LLM). Every tag name is matched
 * case-insensitively via matchDomain; invalid names are dropped; duplicates
 * are removed keeping the first (most-relevant) occurrence.
 */
export function parseTagReply(reply: string, domains: DomainDef[]): TagResult | null {
  if (!reply) return null;

  // Extract the first {...} block (tolerates ```json fences and stray prose).
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;

  let obj: unknown;
  try {
    obj = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;

  // `tags` must be an ARRAY — a missing or malformed field is an invalid
  // reply (null → retry), NOT a no-fit.
  if (!Array.isArray(o.tags)) return null;
  const rawTags: unknown[] = o.tags;

  // Explicit empty array = genuine no-fit — a distinct, valid result.
  if (rawTags.length === 0) return { tags: [] };

  // Collect valid tags (canonical-cased, deduped, ORDER-PRESERVING — the LLM's
  // most-relevant-first order is the downstream exact-weight tiebreak).
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const t of rawTags) {
    if (typeof t !== "string") continue;
    const matched = matchDomain(t, domains);
    if (matched && !seen.has(matched)) {
      seen.add(matched);
      tags.push(matched);
    }
  }

  // Legacy `primary` field: tolerated in the shape, derives NOTHING.
  // A non-empty raw array with ZERO vocabulary matches is an invalid reply.
  if (tags.length === 0) return null;

  return { tags };
}

/**
 * Multi-tag classify one memory's content against the configured vocabulary.
 *
 * Uses the classify tier (`completeClassify` → classifyBaseUrl/classifyModel
 * when configured, else the reflect tier) — the caller is responsible for
 * having pre-flighted that endpoint via resolveClassifyProbeTarget (strict:
 * skip classification entirely if it is unreachable).
 *
 * Behaviour:
 *   - Valid JSON reply with ≥1 vocabulary tag → {tags} (ordered,
 *     most-relevant first).
 *   - Valid reply with an EXPLICIT empty tags array → {tags: []} (genuine
 *     no-fit — owner amendment 07.07: no fallback category is ever assigned;
 *     the caller routes empty tag sets through nofit.ts).
 *   - Unparseable / no-valid-tag reply → retry ONCE, then treat as a genuine
 *     no-fit: {tags: []} (the model responded twice but produced nothing
 *     usable — the embedding-side weak-primary/decay path takes over).
 *   - LLM THROWS after the retry → return NULL (infra error; caller aborts this
 *     memory for a later retry — never filed anywhere, closes #150).
 *
 * @returns {tags} on success (all members of the vocabulary; empty = no-fit),
 *          or null on infra error.
 */
export async function classifyMemoryTags(
  content: string,
  project: string | null | undefined,
  domains: DomainDef[],
  llm: LlmClient,
): Promise<TagResult | null> {
  if (domains.length === 0) return { tags: [] };

  const prompt = buildClassifyPrompt(content, project, domains);
  let threw = false;

  // Two attempts: one call, one retry on a throw OR an unparseable reply.
  for (let attempt = 0; attempt < 2; attempt++) {
    let raw: string;
    try {
      // ~64 tokens covers a short JSON object with a handful of tags.
      raw = await llm.completeClassify(prompt, 64);
      threw = false;
    } catch (err) {
      threw = true;
      if (attempt === 0) continue; // retry once
      console.warn(
        `[hicortex] tag classify LLM error: ${err instanceof Error ? err.message : String(err)} — aborting this memory (will retry)`,
      );
      return null; // infra error → abort untouched (never filed, never decayed)
    }

    const parsed = parseTagReply(raw, domains);
    if (parsed) return parsed;

    if (attempt === 0) {
      console.warn(
        `[hicortex] tag classify: unparseable reply "${raw.slice(0, 60)}" — retrying once`,
      );
    }
  }

  // Two successful calls, neither parseable → treated as a genuine no-fit
  // (empty tag set). (If the second attempt THREW we returned null above;
  // reaching here means the model responded but produced no valid vocabulary
  // tag.) The weak-primary floor guards against mis-decaying a good memory:
  // if it genuinely associates with a domain, the embedding argmax tags it.
  if (threw) return null;
  return { tags: [] };
}
