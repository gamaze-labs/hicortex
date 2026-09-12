/**
 * Strict config readers for primitive values. Pure functions — no LlmConfig
 * dependency — shared by the nightly preflight knobs, the distill-tier
 * overlay (llm.ts / mcp-server.ts), and the dashboard account identity
 * (dashboard.ts).
 *
 * The point is to reject wrong-typed config values AT THE BOUNDARY (disk →
 * runtime) with a warn, rather than casting them straight through. The trap
 * these guard: a JSON slip like `"enableThinking": "false"` (string,
 * not boolean) casts to a truthy value downstream — for the Qwen chat template
 * a non-empty string flips thinking ON, which is precisely the failure the key
 * exists to prevent, with no error anywhere. Same class as the #225
 * preflight-knob validation.
 */

/**
 * Read a positive finite number from a config object. Returns `def` when the
 * key is absent OR present-but-invalid (with a warn in the latter case).
 */
export function readPositiveConfig(
  config: Record<string, unknown>,
  key: string,
  def: number,
): number {
  const v = config[key];
  if (v === undefined) return def;
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  console.warn(
    `[hicortex] config "${key}" = ${String(v)} is not a positive finite number — using default ${def}.`,
  );
  return def;
}

/**
 * Read a strict boolean from a config object. Returns the boolean when valid,
 * `undefined` when the key is absent OR present-but-not-a-boolean (with a warn
 * in the latter case). Never coerces — `"false"` (string) is rejected, not
 * treated as truthy.
 */
export function readStrictBoolean(
  config: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const v = config[key];
  if (v === undefined) return undefined;
  if (typeof v === "boolean") return v;
  console.warn(
    `[hicortex] config "${key}" = ${String(v)} is not a boolean — ignored.`,
  );
  return undefined;
}

/**
 * Read a non-negative finite number (allows 0, unlike readPositiveConfig).
 * Returns `def` when absent OR invalid. Used for keys where 0 is a valid "off"
 * value (e.g. ollamaFlushEvery).
 */
export function readNonNegativeConfig(
  config: Record<string, unknown>,
  key: string,
  def: number,
): number {
  const v = config[key];
  if (v === undefined) return def;
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  console.warn(
    `[hicortex] config "${key}" = ${String(v)} is not a non-negative finite number — using default ${def}.`,
  );
  return def;
}

/**
 * Read + validate an array of scheduling hours (integers 0–23, local time) for
 * the capture/consolidation timers (0.17). Returns the validated, de-duped,
 * ASC-sorted array; `null` when the key is absent (caller applies the role
 * default) OR present-but-invalid (with a warn in the latter case).
 *
 * One invalid element rejects the WHOLE list (→ null → default) rather than
 * silently dropping a slot: a `25` is a typo the user should notice, and a
 * partial schedule like [9, 25→drop, 21] = [9, 21] would quietly change
 * cadence. Matches the readPositiveConfig "reject invalid → default" boundary
 * posture, and the parseConfigDomains leniency contract for the absent case.
 */
export function parseHours(
  config: Record<string, unknown> | null | undefined,
  key: string,
): number[] | null {
  if (!config) return null;
  const v = config[key];
  if (v === undefined) return null;
  if (!Array.isArray(v)) {
    console.warn(`[hicortex] config "${key}" is not an array — ignored.`);
    return null;
  }
  const seen = new Set<number>();
  const out: number[] = [];
  for (const el of v) {
    if (typeof el !== "number" || !Number.isInteger(el) || el < 0 || el > 23) {
      console.warn(
        `[hicortex] config "${key}" has an invalid hour (${String(el)}; must be an integer 0–23) — ignoring the list, using the default.`,
      );
      return null;
    }
    if (!seen.has(el)) {
      seen.add(el);
      out.push(el);
    }
  }
  return out.length > 0 ? out.sort((a, b) => a - b) : null;
}

/**
 * Read an optional non-empty string from a config object. Returns the trimmed
 * string when valid, `null` when the key is absent, blank, OR present-but-not-
 * a-string (with a warn in the latter case). Used for display-only keys (e.g.
 * dashboard account identity) where "not set" and "invalid" mean the same
 * thing: render nothing.
 */
export function readStringConfig(
  config: Record<string, unknown>,
  key: string,
): string | null {
  const v = config[key];
  if (v === undefined) return null;
  if (typeof v === "string") {
    const t = v.trim();
    return t.length > 0 ? t : null;
  }
  console.warn(`[hicortex] config "${key}" = ${String(v)} is not a string — ignored.`);
  return null;
}

/**
 * Account identity shown in the console nav (name + plan pill). The display
 * keys are operator-set config (hosted installs); each field is null when
 * absent, blank, or wrong-typed (readStringConfig) — the page renders nothing
 * for an all-null account (the self-hosted default), never the string "null".
 *
 * ONE construction shared by the /dashboard/data payload and GET /account so
 * the nav element cannot drift between them (same reason the digest reuses
 * formatIndexLine).
 */
export interface AccountIdentity {
  name: string | null;
  org: string | null;
  plan: string | null;
}

/** Read the account identity (displayName/orgName/planLabel) from config. */
export function readAccount(
  config: Record<string, unknown> | null | undefined,
): AccountIdentity {
  const c = config ?? {};
  return {
    name: readStringConfig(c, "displayName"),
    org: readStringConfig(c, "orgName"),
    plan: readStringConfig(c, "planLabel"),
  };
}

/**
 * Config keys that ≤0.16.7 accepted and 0.16.8+ IGNORES. Two groups:
 *  - per-stage model keys + the nested `models` block (#231): one model now
 *    serves all phases, so distillation/reflection/classification silently run
 *    on `llmModel` — a quality downgrade if a larger model was on a distill/
 *    reflect tier.
 *  - `distillFallback` (#232): removed; strict mode is default. A `"local"`
 *    value no longer falls back — failures retry next run.
 * Both were public (documented in the README config table). Warn loudly at the
 * config boundary so neither change is silent.
 *
 * NOTE: this list is deliberately WIDER than the `HicortexConfig` type. In
 * ≤0.16.7 most of these keys (the flat `distill*`/`reflect*` set and
 * `distillFallback`) were NEVER declared in the interface — they were
 * accepted-but-untyped, read loosely off the config object, with the README
 * config table as their only public contract. So deriving this list from the
 * type would miss them. The list is the README's documented keys; don't trim it
 * to match the interface (a future audit that did so would silently re-introduce
 * the ignored-key gap this warning exists to close).
 */
const IGNORED_CONFIG_KEYS = [
  "distillModel", "distillBaseUrl", "distillApiKey", "distillProvider",
  "reflectModel", "reflectBaseUrl", "reflectApiKey", "reflectProvider",
  "classifyModel", "classifyBaseUrl", "classifyApiKey", "classifyProvider",
  "distillFallback",
] as const;

/**
 * Config keys REMOVED by the #405 budget simplification, each mapped to its
 * replacement (or "removed" when there is none). The old single 0.16.8-style
 * message does not fit — every key here needs to name where its job went.
 * Warned at the config boundary alongside the 0.16.8 keys above.
 */
const REMOVED_CONFIG_KEYS: Record<string, string> = {
  reconsolidationMaxMinutes: "removed — the ONE run deadline (nightlyTimeBudgetMinutes) bounds the stage",
  reconsolidationMaxCalls: "removed — the ONE call budget (nightlyLlmCallBudget) caps all stages",
  supersessionMaxCalls: "removed — the ONE call budget (nightlyLlmCallBudget) caps all stages",
  dedupNightlyMaxMerges: "removed — the run deadline (nightlyTimeBudgetMinutes) bounds nightly merges",
  classifyMaxTokens: "removed — maxTokens is the single output ceiling for every call",
  llmBreakerThreshold: "removed — the breaker threshold is a constant (3)",
  llmBreakerCooldownMs: "removed — the breaker cooldown is a constant (10 min)",
  llmSingleFlightWaitMs: "removed — the wait derives from llmTimeoutMs",
  preflightTimeoutMs: "removed — a constant (20 s per attempt)",
  preflightAttempts: "removed — a constant (3 attempts)",
  preflightRetryGapMs: "removed — a constant (60 s gap)",
  moduleIndexTokenBudget: "removed — was documentation-only",
};

/**
 * Warn if the saved config carries keys that 0.16.8+ ignores. Call at every
 * config read (daemon boot + nightly). The warning clears once the keys are
 * removed and (for the model keys) the model is consolidated into
 * llmModel/llmBaseUrl/llmProvider.
 */
export function warnIgnoredConfigKeys(
  savedConfig: Record<string, unknown> | null | undefined,
): void {
  if (!savedConfig) return;
  const present = IGNORED_CONFIG_KEYS.filter((k) => savedConfig[k] !== undefined);
  const hasModelsBlock = savedConfig.models !== undefined;
  if (present.length > 0 || hasModelsBlock) {
    const detail = [...present, ...(hasModelsBlock ? ["models"] : [])].join(", ");
    console.warn(
      `[hicortex] config has keys IGNORED since 0.16.8 (${detail}). They have no effect now. ` +
      `Per-stage model keys / the \`models\` block: one model serves all phases — set ` +
      `llmModel/llmBaseUrl/llmProvider (+ llmApiKey) to your intended model. ` +
      `distillFallback: removed (strict mode is default — a failed distill retries next run). ` +
      `Remove these keys to clear this warning. See the 0.16.8 changelog.`,
    );
  }
  // #405: keys removed by the budget simplification — one line naming each
  // present key and its replacement (or "removed").
  const removed = Object.entries(REMOVED_CONFIG_KEYS)
    .filter(([k]) => savedConfig[k] !== undefined);
  if (removed.length > 0) {
    const detail = removed.map(([k, v]) => `${k} (${v})`).join(", ");
    console.warn(
      `[hicortex] config has keys REMOVED by the budget simplification (#405): ${detail}. ` +
      `They have no effect. Remove them to clear this warning.`,
    );
  }
}
