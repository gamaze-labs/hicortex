/**
 * Product-owned memory instructions (#192, owner decision 28.07.2026).
 *
 * The instructions for HOW agents use Hicortex are shipped BY the product,
 * versioned with the server, and injected as a synthetic read-only `memory`
 * section in the GET /identity response. Rationale ("enforced, built-in"):
 *   - Harness personas (SOUL.md etc.) carry ZERO hicortex content — mechanics
 *     described there rot silently when the product changes (field evidence:
 *     stale "captured via hooks" sentences; an agent shell-spelunking its own
 *     plugin infrastructure when told "the plugin was updated").
 *   - User identity files (user.md / rules.md) stay purely personal — norms the
 *     product depends on must not live in user-editable files (same principle
 *     as the built-in citation norm, 0.14.1).
 *   - Because every harness already renders `## Identity` sections through the
 *     shared gate/render path, a synthetic section ships fleet-wide with zero
 *     client changes — including plugins that predate this feature.
 *
 * The section name is RESERVED: PUT /identity rejects it, and the synthetic
 * text overrides any user file of the same name (enforced means enforced).
 * Off-switch: config `memoryInstructions: false`.
 *
 * Since #383 the file is also the source for the MCP standing instructions
 * (the initialize-result `instructions` field) — the same policy, shaped for
 * passive MCP clients, behind the same off-switch.
 */

export const MEMORY_SECTION_NAME = "memory";

/** Capture policy, shared by BOTH instruction surfaces (identity section +
 *  MCP initialize result) so they can never disagree. Sentence only — each
 *  renderer prefixes its own bullet marker. */
const CAPTURE_POLICY =
  "Capture is automatic (nightly). Do not manually ingest routine content — `hicortex_ingest` is for explicitly requested learnings only.";

/** Infrastructure policy, shared by BOTH instruction surfaces (same rule). */
const INFRA_POLICY =
  "Never inspect, test, or modify memory/plugin/gateway infrastructure (configs, services, tokens). If a memory tool seems missing or broken, say so and stop.";

/** The product-authored instruction text. Keep compact (~120 tokens): it is
 *  injected once per session into every agent on the fleet. */
export function renderMemoryInstructions(): string {
  return [
    "Hicortex is your persistent identity and long-term memory: what you learn, decide, and correct survives every session, compaction, and model switch — one memory shared by all your agents.",
    "- A `## Memory recall (auto)` index may arrive with prompts: it is a MENU, not content. Fetch a full memory with `hicortex_get(id)` when the entry could change how you handle the current task.",
    "- Recall before assuming: `hicortex_search` for prior decisions/facts/preferences, `hicortex_recent` to catch up on a project.",
    "- Cite any memory you rely on by id + date, and mark it `FETCHED` (you read the full memory via `hicortex_get`) or `SNIPPET` (the one-line entry only). Don't present a SNIPPET citation as established. On conflicts, newer memories supersede older.",
    `- ${CAPTURE_POLICY}`,
    `- ${INFRA_POLICY}`,
  ].join("\n");
}

/** The MCP-client-shaped sibling (#383): standing instructions for the MCP
 *  `instructions` field in the initialize result — the MCP-native
 *  SessionStart. Passive MCP clients (Claude Desktop etc.) run no hooks and
 *  see no injected sections, so this field is the ONLY product-owned
 *  guidance their model ever receives; the 2026-09-10 field test showed the
 *  memory going entirely unused without it. Compact by construction (same
 *  ~120-token budget as the identity sibling) and shares the two policy
 *  sentences verbatim — one source, two surfaces. Drops the hook-only
 *  surfaces (the `## Memory recall (auto)` index) those clients never see. */
export function renderMcpInstructions(): string {
  return [
    "This server is the user's persistent long-term memory, shared by all their agents and sessions: what was learned, decided, or corrected survives.",
    "CALL `hicortex_search` BEFORE answering questions about the user's history, projects, or preferences — before assuming, guessing, or asking the user something that may already be known.",
    "Call `hicortex_recent` at the start of substantive work on a project to catch up on its latest state.",
    "Search results are one-line summaries — fetch the full memory with `hicortex_get` when it could change how you handle the task, and cite what you rely on (id + date). On conflicts, newer memories supersede older.",
    `- ${CAPTURE_POLICY}`,
    `- ${INFRA_POLICY}`,
  ].join("\n");
}

/** The config gate as a pure function (#383): enabled → the rendered text,
 *  disabled → undefined (the SDK omits the field from the initialize result,
 *  so `memoryInstructions: false` silences BOTH surfaces with one switch). */
export function resolveMcpInstructions(enabled: boolean): string | undefined {
  return enabled ? renderMcpInstructions() : undefined;
}

/** True for the reserved product section name (case-insensitive guard —
 *  section names are lowercase by allowlist, but be safe). */
export function isReservedSectionName(name: unknown): boolean {
  return typeof name === "string" && name.trim().toLowerCase() === MEMORY_SECTION_NAME;
}

/**
 * Inject the synthetic section into a successful GET /identity body.
 * Pure: returns the same body object with sections.memory set. Skips agent
 * mode "off" (operator explicitly silenced identity for that agent) and
 * non-object bodies (error shapes). Overrides a user file named memory.md.
 */
export function injectMemorySection<T extends { sections?: Record<string, string>; mode?: string }>(
  body: T,
  enabled: boolean
): T {
  if (!enabled) return body;
  if (!body || typeof body !== "object") return body;
  if (body.mode === "off") return body;
  if (!body.sections || typeof body.sections !== "object") return body;
  body.sections[MEMORY_SECTION_NAME] = renderMemoryInstructions();
  return body;
}
