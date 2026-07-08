/**
 * Multi-provider LLM client for consolidation and distillation.
 *
 * Resolution (resolveExplicitLlmConfig):
 *   1. Explicit config-file overrides (llmBaseUrl + llmApiKey + llmModel)
 *   2. Hicortex-specific env vars (HICORTEX_LLM_BASE_URL + HICORTEX_LLM_API_KEY + HICORTEX_LLM_MODEL)
 *   Returns null when nothing explicit is set — no silent defaults.
 *
 * Explicit backends (handled by call sites before resolveExplicitLlmConfig):
 *   - llmBackend: "claude-cli" → claudeCliConfig()
 *   - llmBackend: "ollama"     → explicit ollama LlmConfig
 *
 * Supports any OpenAI-compatible endpoint plus first-class support for
 * OpenAI, Anthropic, Google, Ollama, OpenRouter, and Claude CLI.
 */

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  reflectModel: string;
  provider: string;
  /** Optional separate model for distillation (defaults to model if unset). */
  distillModel?: string;
  /** Optional separate endpoint for distillation (e.g. remote Ollama with larger/faster model). */
  distillBaseUrl?: string;
  distillApiKey?: string;
  distillProvider?: string;
  /** Optional separate endpoint for reflect-tier LLM (e.g. remote Ollama with larger model). */
  reflectBaseUrl?: string;
  reflectApiKey?: string;
  reflectProvider?: string;
  /**
   * Optional separate model for memory tag classification (defaults to the
   * reflect tier when unset — zero behavior change for existing installs).
   * Chosen after an A/B benchmark where a dedicated classifier model
   * materially outperformed the reflect model on this task.
   */
  classifyModel?: string;
  /**
   * Optional separate endpoint for classification. When only classifyModel is
   * set, the classify model runs on the reflect endpoint (or the base endpoint
   * when no reflect endpoint is configured).
   */
  classifyBaseUrl?: string;
  classifyApiKey?: string;
  classifyProvider?: string;
}

/**
 * Resolve LLM configuration from explicit config-file overrides or
 * Hicortex-specific env vars only. Returns null when nothing explicit is set.
 *
 * Call sites (mcp-server, nightly) handle the named backends (claude-cli,
 * ollama) before reaching this function. Only call this for the "other
 * provider" / API-key case where no named backend is in config.json.
 *
 * NO implicit fallbacks: ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY
 * alone in the environment do NOT configure an LLM — the user must have
 * chosen a provider via `npx @gamaze/hicortex init`.
 */
export function resolveExplicitLlmConfig(overrides?: {
  llmBaseUrl?: string;
  llmApiKey?: string;
  llmModel?: string;
  reflectModel?: string;
}): LlmConfig | null {
  // 1. Explicit config-file overrides (both baseUrl and apiKey required)
  if (overrides?.llmBaseUrl && overrides?.llmApiKey) {
    const provider = detectProvider(overrides.llmBaseUrl);
    return {
      baseUrl: overrides.llmBaseUrl,
      apiKey: overrides.llmApiKey,
      model: overrides.llmModel ?? "claude-haiku-4-5-20251001",
      reflectModel: overrides.reflectModel ?? overrides.llmModel ?? "claude-sonnet-4-6",
      provider,
    };
  }

  // 2. Hicortex-specific env vars (both base URL and API key required)
  const hcBaseUrl = process.env.HICORTEX_LLM_BASE_URL;
  const hcApiKey = process.env.HICORTEX_LLM_API_KEY;
  const hcModel = process.env.HICORTEX_LLM_MODEL;
  if (hcBaseUrl && hcApiKey) {
    const provider = detectProvider(hcBaseUrl);
    return {
      baseUrl: hcBaseUrl,
      apiKey: hcApiKey,
      model: hcModel ?? "claude-haiku-4-5-20251001",
      reflectModel: process.env.HICORTEX_REFLECT_MODEL ?? hcModel ?? "claude-sonnet-4-6",
      provider,
    };
  }

  // Nothing explicit — caller decides what to do (recall-only mode, loud warning, etc.)
  return null;
}

/**
 * @deprecated Use resolveExplicitLlmConfig. This alias exists only to ease
 * the transition for any lingering call sites — remove after 0.10.0 ships.
 */
export const resolveLlmConfigForCC = resolveExplicitLlmConfig;

/**
 * Resolve an LlmConfig from a saved ~/.hicortex/config.json object.
 *
 * This is the SINGLE config path used by pipeline runs (nightly consolidation
 * and `hicortex relink`): named backends (claude-cli, ollama) first, then the
 * explicit-config/env fallthrough via resolveExplicitLlmConfig, then the
 * reflect endpoint overlay. Extracted verbatim from nightly.ts — behavior
 * is identical to the pre-0.11 inline block.
 *
 * Returns `reason: "claude_binary_missing"` when claude-cli is configured but
 * the binary can't be found, so callers can log a context-specific message.
 */
export function resolveSavedLlmConfig(
  savedConfig: Record<string, unknown> | null,
): { config: LlmConfig | null; reason?: "claude_binary_missing" } {
  let llmConfig: LlmConfig | null = null;

  if (savedConfig?.llmBackend === "claude-cli") {
    const claudePath = findClaudeBinary();
    if (claudePath) {
      llmConfig = claudeCliConfig(claudePath);
    } else {
      return { config: null, reason: "claude_binary_missing" };
    }
  } else if (savedConfig?.llmBackend === "ollama") {
    llmConfig = {
      baseUrl: (savedConfig.llmBaseUrl as string | undefined) ?? "http://localhost:11434",
      apiKey: "",
      model: (savedConfig.llmModel as string) ?? "qwen3.5:4b",
      reflectModel: (savedConfig.reflectModel as string) ?? (savedConfig.llmModel as string) ?? "qwen3.5:4b",
      provider: "ollama",
    };
  } else {
    llmConfig = resolveExplicitLlmConfig({
      llmBaseUrl: savedConfig?.llmBaseUrl as string | undefined,
      llmApiKey: savedConfig?.llmApiKey as string | undefined,
      llmModel: savedConfig?.llmModel as string | undefined,
      reflectModel: savedConfig?.reflectModel as string | undefined,
    });
  }

  if (llmConfig && savedConfig?.reflectBaseUrl) {
    llmConfig.reflectBaseUrl = savedConfig.reflectBaseUrl as string;
    llmConfig.reflectApiKey = (savedConfig.reflectApiKey as string | undefined) ?? llmConfig.apiKey;
    llmConfig.reflectProvider = (savedConfig.reflectProvider as string | undefined) ?? llmConfig.provider;
  }

  // Optional classify tier (memory tag classification). Same overlay pattern
  // as distillModel/distillBaseUrl: when absent, completeClassify falls back
  // to the reflect tier — zero behavior change for existing installs.
  if (llmConfig && savedConfig?.classifyModel) {
    llmConfig.classifyModel = savedConfig.classifyModel as string;
  }
  if (llmConfig && savedConfig?.classifyBaseUrl) {
    llmConfig.classifyBaseUrl = savedConfig.classifyBaseUrl as string;
    llmConfig.classifyApiKey = (savedConfig.classifyApiKey as string | undefined) ?? llmConfig.apiKey;
    llmConfig.classifyProvider = (savedConfig.classifyProvider as string | undefined) ?? llmConfig.provider;
  }

  return { config: llmConfig };
}

/**
 * Endpoint + model that memory tag classification will ACTUALLY use, for
 * pre-flight probing. Pure function — the single source of truth shared by
 * the nightly's contentDomainsReady gate and `hicortex classify-domains`.
 *
 * Mirrors LlmClient.completeClassify's routing:
 *   - classify tier configured (classifyModel and/or classifyBaseUrl) →
 *     classifyBaseUrl ?? reflectBaseUrl, classifyModel ?? reflectModel
 *   - classify tier absent → the reflect tier (reflectBaseUrl/reflectModel),
 *     exactly what completeReflect uses
 *
 * Returns null when no probe applies: only a SEPARATE Ollama endpoint can go
 * unreachable mid-run (API providers are cloud-reachable; the base endpoint
 * is not pre-flighted anywhere, matching distill/reflect behavior).
 *
 * `tier` tells callers which configuration produced the target — "reflect"
 * means the classification probe is identical to the reflect-stage probe and
 * its result can be reused.
 */
export function resolveClassifyProbeTarget(
  config: LlmConfig,
): { tier: "classify" | "reflect"; baseUrl: string; model: string } | null {
  const classifyConfigured = Boolean(config.classifyModel || config.classifyBaseUrl);

  if (classifyConfigured) {
    const baseUrl = config.classifyBaseUrl ?? config.reflectBaseUrl;
    const model = config.classifyModel ?? config.reflectModel;
    const provider = config.classifyBaseUrl
      ? (config.classifyProvider ?? config.provider)
      : (config.reflectProvider ?? config.provider); // riding the reflect endpoint
    if (baseUrl && provider === "ollama") {
      return { tier: "classify", baseUrl, model };
    }
    return null; // base endpoint or API provider — no probe
  }

  // Classify tier absent — classification delegates to completeReflect.
  if (config.reflectBaseUrl && (config.reflectProvider ?? config.provider) === "ollama") {
    return { tier: "reflect", baseUrl: config.reflectBaseUrl, model: config.reflectModel ?? config.model };
  }
  return null;
}

function detectProvider(
  url: string
): LlmConfig["provider"] {
  const u = url.toLowerCase();
  if (u.includes("ollama") || u.includes(":11434")) return "ollama";
  if (u.includes("anthropic")) return "anthropic";
  if (u.includes("openrouter")) return "openrouter";
  if (u.includes("googleapis") || u.includes("generativelanguage")) return "google";
  return "openai";
}


/**
 * Find the claude CLI binary. Returns the full path or null.
 */
export function findClaudeBinary(): string | null {
  const { execSync } = require("node:child_process") as typeof import("node:child_process");
  const { existsSync } = require("node:fs") as typeof import("node:fs");
  const { join } = require("node:path") as typeof import("node:path");
  const { homedir } = require("node:os") as typeof import("node:os");

  // Check common paths
  const candidates = [
    join(homedir(), ".local", "bin", "claude"),
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }

  // Fall back to which
  try {
    return execSync("which claude 2>/dev/null", { encoding: "utf-8" }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Create an LlmConfig that uses the claude CLI as backend.
 * baseUrl field stores the path to the claude binary.
 */
export function claudeCliConfig(claudePath: string): LlmConfig {
  return {
    baseUrl: claudePath,
    apiKey: "",
    model: "haiku",
    reflectModel: "haiku",
    provider: "claude-cli",
  };
}

/**
 * Check if a local Ollama instance is reachable and has models loaded.
 * Returns the model name if available, null otherwise.
 */
export async function probeOllama(
  baseUrl = "http://localhost:11434"
): Promise<string | null> {
  try {
    const resp = await fetch(`${baseUrl}/api/ps`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { models?: Array<{ name: string }> };
    if (data.models && data.models.length > 0) {
      return data.models[0].name;
    }
    // No model loaded — check if any are available
    const tagsResp = await fetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!tagsResp.ok) return null;
    const tags = (await tagsResp.json()) as { models?: Array<{ name: string }> };
    return tags.models?.[0]?.name ?? null;
  } catch {
    return null;
  }
}

/**
 * Pre-flight health check for a specific Ollama endpoint + model.
 * Returns { ok, reason } so callers can log a clear abort message.
 *
 *   - `ok: true` — endpoint reachable AND the requested model appears in
 *     `/api/tags`. Safe to proceed with a batch distillation run.
 *   - `ok: false, reason: "unreachable"` — network failure or non-2xx.
 *   - `ok: false, reason: "model_missing"` — endpoint is up but the
 *     model isn't listed (the exact case that caused data loss when
 *     a remote Ollama box didn't have the distill model loaded).
 *
 * Matches on exact name OR name prefix ("qwen3.5:35b" matches "qwen3.5:35b-a3b").
 */
export async function probeOllamaModel(
  baseUrl: string,
  modelName: string,
): Promise<{ ok: true } | { ok: false; reason: "unreachable" | "model_missing" }> {
  try {
    const resp = await fetch(`${baseUrl.replace(/\/$/, "")}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return { ok: false, reason: "unreachable" };
    const data = (await resp.json()) as { models?: Array<{ name: string }> };
    const models = data.models ?? [];
    const found = models.some(
      (m) => m.name === modelName || m.name.startsWith(modelName + ":"),
    );
    return found ? { ok: true } : { ok: false, reason: "model_missing" };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
}

/**
 * Resolve the distillation endpoint before a /distill request.
 *
 * @param config  LlmConfig (mutated in "local" mode when fallback is used)
 * @param mode
 *   "strict" (default) — when a separate distillBaseUrl is configured and its
 *     Ollama probe fails, return "abort" immediately WITHOUT mutating config.
 *     The session is not distilled now; the nightly watermark is not advanced,
 *     so the session is re-shipped on the next run (harness stores retain raw
 *     for 30–90 days — the retry IS the queue). Prefer this to producing
 *     low-quality memories from a weak fallback model.
 *   "local" — legacy 0.9.0 behaviour: fall back to the base endpoint (local
 *     Ollama or API provider) when the remote is down. Mutates config IN PLACE
 *     to repoint distill* at the fallback.
 *
 * Returns:
 *   "ok"       — remote distill endpoint healthy, or no separate endpoint set
 *   "fellback" — ("local" mode only) remote down; distill redirected to base
 *   "abort"    — remote down and fallback not allowed (strict) or both down (local)
 */
export async function resolveDistillFallback(
  config: LlmConfig,
  mode: "strict" | "local" = "strict",
): Promise<"ok" | "fellback" | "abort"> {
  const distillProvider = config.distillProvider ?? config.provider;
  // Only a remote Ollama distill endpoint can go unreachable mid-run; API
  // providers are cloud-reachable and need no fallback.
  if (!config.distillBaseUrl || distillProvider !== "ollama") return "ok";

  const distillModel = config.distillModel ?? config.model;
  const remote = await probeOllamaModel(config.distillBaseUrl, distillModel);
  if (remote.ok) return "ok";

  const reason =
    remote.reason === "unreachable"
      ? `remote distill endpoint unreachable (${config.distillBaseUrl})`
      : `remote distill model not loaded (${distillModel} on ${config.distillBaseUrl})`;

  if (mode === "strict") {
    // Do not mutate config. Log once and let the caller return 503 so the
    // nightly watermark stays put and the session is retried next run.
    console.error(
      `[hicortex] ABORT: ${reason} — session will be retried next run`,
    );
    return "abort";
  }

  // "local" mode: fall back to the base endpoint.
  // If the base is Ollama, verify it is actually up before committing;
  // if the base is an API provider, it is cloud-reachable.
  if (config.provider === "ollama") {
    const local = await probeOllamaModel(config.baseUrl, config.model);
    if (!local.ok) {
      console.error(
        `[hicortex] ABORT: ${reason}, and local fallback (${config.model} on ${config.baseUrl}) also unavailable — retry next run`,
      );
      return "abort";
    }
    config.distillBaseUrl = config.baseUrl;
  } else {
    // Base is an API provider — route distill through it (no separate baseUrl).
    config.distillBaseUrl = undefined;
  }
  config.distillModel = config.model;
  config.distillProvider = config.provider;
  config.distillApiKey = config.apiKey;
  console.warn(
    `[hicortex] ${reason} — falling back to base endpoint for distillation ` +
      `(${config.provider}/${config.model}). Lower quality, but capture continues.`,
  );
  return "fellback";
}

// ---------------------------------------------------------------------------
// LLM Client class
// ---------------------------------------------------------------------------

const DEFAULT_RATE_LIMIT_RETRY_MS = 5 * 60 * 60 * 1000 + 60_000; // 5h01m safety margin

export class RateLimitError extends Error {
  public retryAfterMs: number;
  constructor(retryAfterMs: number) {
    const hours = Math.round(retryAfterMs / (60 * 60 * 1000) * 10) / 10;
    super(`Rate limited — will retry in ${hours}h`);
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

export class LlmClient {
  private config: LlmConfig;
  private rateLimitedUntil = 0;

  constructor(config: LlmConfig) {
    this.config = config;
  }

  /** Check if we're currently rate limited */
  get isRateLimited(): boolean {
    return Date.now() < this.rateLimitedUntil;
  }

  private handleRateLimit(resp: Response): never {
    // Parse Retry-After header if present (seconds)
    const retryAfter = resp.headers.get("retry-after");
    const retryMs = retryAfter
      ? parseInt(retryAfter, 10) * 1000
      : DEFAULT_RATE_LIMIT_RETRY_MS;
    this.rateLimitedUntil = Date.now() + retryMs;
    console.log(
      `[hicortex] Rate limited by LLM provider. ` +
      `Will retry after ${new Date(this.rateLimitedUntil).toISOString()}`
    );
    throw new RateLimitError(retryMs);
  }

  /**
   * Fast-tier completion (importance scoring, simple tasks).
   */
  async completeFast(prompt: string, maxTokens = 2048): Promise<string> {
    return this.complete(this.config.model, prompt, maxTokens, 600_000);
  }

  /**
   * Reflect-tier completion (nightly reflection, needs reasoning).
   * Routes to reflectBaseUrl/reflectProvider if configured (e.g. remote Ollama with larger model).
   */
  async completeReflect(prompt: string, maxTokens = 8192): Promise<string> {
    if (this.config.reflectBaseUrl) {
      return this.completeWithOverride(
        this.config.reflectBaseUrl,
        this.config.reflectApiKey ?? this.config.apiKey,
        this.config.reflectProvider ?? this.config.provider,
        this.config.reflectModel,
        prompt,
        maxTokens,
        900_000,
      );
    }
    return this.complete(this.config.reflectModel, prompt, maxTokens, 900_000);
  }

  /**
   * Distillation-tier completion (session knowledge extraction).
   * Routes to distillBaseUrl/distillProvider if configured (e.g. remote Ollama with faster model).
   */
  async completeDistill(prompt: string, maxTokens = 2048): Promise<string> {
    if (this.config.distillBaseUrl) {
      return this.completeWithOverride(
        this.config.distillBaseUrl,
        this.config.distillApiKey ?? this.config.apiKey,
        this.config.distillProvider ?? this.config.provider,
        this.config.distillModel ?? this.config.model,
        prompt,
        maxTokens,
        900_000,
      );
    }
    return this.complete(this.config.distillModel ?? this.config.model, prompt, maxTokens, 900_000);
  }

  /**
   * Classification-tier completion (memory tag classification).
   *
   * Routing (same "optional dedicated model+baseUrl with fallback" pattern as
   * completeDistill; Ollama calls inherit think:false via completeOllama):
   *   - Neither classifyModel nor classifyBaseUrl set → delegate to
   *     completeReflect (exactly the pre-classify-tier behavior).
   *   - classifyBaseUrl set → that endpoint, model classifyModel ?? reflectModel.
   *   - Only classifyModel set → the classify model on the reflect endpoint
   *     when one is configured, else on the base endpoint.
   */
  async completeClassify(prompt: string, maxTokens = 8192): Promise<string> {
    if (!this.config.classifyModel && !this.config.classifyBaseUrl) {
      return this.completeReflect(prompt, maxTokens);
    }
    const model = this.config.classifyModel ?? this.config.reflectModel;
    if (this.config.classifyBaseUrl) {
      return this.completeWithOverride(
        this.config.classifyBaseUrl,
        this.config.classifyApiKey ?? this.config.apiKey,
        this.config.classifyProvider ?? this.config.provider,
        model,
        prompt,
        maxTokens,
        900_000,
      );
    }
    if (this.config.reflectBaseUrl) {
      return this.completeWithOverride(
        this.config.reflectBaseUrl,
        this.config.reflectApiKey ?? this.config.apiKey,
        this.config.reflectProvider ?? this.config.provider,
        model,
        prompt,
        maxTokens,
        900_000,
      );
    }
    return this.complete(model, prompt, maxTokens, 900_000);
  }

  /**
   * Complete with overridden baseUrl/apiKey/provider (used for reflect tier with separate endpoint).
   * Creates a temporary LlmClient to avoid mutating shared config under concurrent calls.
   */
  private async completeWithOverride(
    baseUrl: string,
    apiKey: string,
    provider: string,
    model: string,
    prompt: string,
    maxTokens: number,
    timeoutMs: number,
  ): Promise<string> {
    const tempClient = new LlmClient({
      ...this.config,
      baseUrl,
      apiKey,
      provider,
    });
    return tempClient.complete(model, prompt, maxTokens, timeoutMs);
  }

  private async complete(
    model: string,
    prompt: string,
    maxTokens: number,
    timeoutMs: number
  ): Promise<string> {
    if (this.isRateLimited) {
      throw new RateLimitError(this.rateLimitedUntil - Date.now());
    }
    const retryDelays = [30_000, 60_000, 120_000]; // 30s, 60s, 120s
    let lastErr: Error | undefined;
    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
      try {
        return await this.completeOnce(model, prompt, maxTokens, timeoutMs);
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        const msg = lastErr.message;
        if (attempt < retryDelays.length && (msg.includes("fetch failed") || msg.includes("ECONNREFUSED") || msg.includes("timeout") || msg.includes("Headers Timeout"))) {
          const delay = retryDelays[attempt];
          console.log(`[hicortex] LLM call failed (${msg.slice(0, 60)}), retry ${attempt + 1}/${retryDelays.length} in ${delay / 1000}s...`);
          await new Promise(r => setTimeout(r, delay));
        } else {
          throw lastErr;
        }
      }
    }
    throw lastErr!;
  }

  private async completeOnce(
    model: string,
    prompt: string,
    maxTokens: number,
    timeoutMs: number
  ): Promise<string> {
    if (this.config.provider === "claude-cli") {
      return this.completeClaude(model, prompt, timeoutMs);
    }
    if (this.config.provider === "ollama") {
      return this.completeOllama(model, prompt, maxTokens, timeoutMs);
    }
    if (this.config.provider === "anthropic") {
      return this.completeAnthropic(model, prompt, maxTokens, timeoutMs);
    }
    return this.completeOpenAiCompat(model, prompt, maxTokens, timeoutMs);
  }

  /**
   * Claude CLI: shell out to `claude -p` for subscription users.
   * No API key needed — uses CC's authenticated session.
   */
  private async completeClaude(
    model: string,
    prompt: string,
    timeoutMs: number
  ): Promise<string> {
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const claudePath = this.config.baseUrl; // baseUrl stores the claude binary path

    try {
      const raw = execSync(
        `${claudePath} -p ${JSON.stringify(prompt)} --model ${model} --max-turns 1 --output-format json --no-session-persistence < /dev/null`,
        { encoding: "utf-8", timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }
      );
      const data = JSON.parse(raw) as { result?: string; is_error?: boolean };
      if (data.is_error) {
        throw new Error(`Claude CLI error: ${data.result}`);
      }
      return (data.result ?? "").trim();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("rate") || msg.includes("429") || msg.includes("overloaded")) {
        this.handleRateLimit({ headers: { get: () => null } } as unknown as Response);
      }
      throw new Error(`Claude CLI failed: ${msg}`);
    }
  }

  /**
   * Ollama: use /api/generate with think:false (important for qwen3.5 models).
   */
  private async completeOllama(
    model: string,
    prompt: string,
    maxTokens: number,
    timeoutMs: number
  ): Promise<string> {
    const url = `${this.config.baseUrl.replace(/\/$/, "")}/api/generate`;
    // Ollama can take minutes to process large contexts — use streaming to avoid
    // Node.js fetch headers timeout (default ~300s kills long Ollama inferences)
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        stream: true,
        think: false,
        options: { num_predict: maxTokens, num_ctx: 32768 },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (resp.status === 429) this.handleRateLimit(resp);
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      if (text.includes("1113") || text.includes("Insufficient balance")) {
        this.handleRateLimit(resp);
      }
      throw new Error(`Ollama error ${resp.status}: ${text}`);
    }

    // Collect streamed response chunks
    let result = "";
    const reader = resp.body?.getReader();
    if (!reader) throw new Error("No response body");
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      for (const line of chunk.split("\n")) {
        if (!line.trim()) continue;
        try {
          const data = JSON.parse(line);
          if (data.response) result += data.response;
        } catch { /* skip malformed lines */ }
      }
    }
    return result.trim();
  }

  /**
   * Anthropic Messages API (/v1/messages).
   * Auth via x-api-key header.
   */
  private async completeAnthropic(
    model: string,
    prompt: string,
    maxTokens: number,
    timeoutMs: number
  ): Promise<string> {
    const baseUrl = this.config.baseUrl.replace(/\/$/, "");
    const hasVersion = /\/v\d+\/?$/.test(baseUrl);
    const url = hasVersion ? `${baseUrl}/messages` : `${baseUrl}/v1/messages`;

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.config.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: maxTokens,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (resp.status === 429) this.handleRateLimit(resp);
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Anthropic API error ${resp.status}: ${text}`);
    }

    const data = (await resp.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const textBlock = data.content?.find((c) => c.type === "text");
    return (textBlock?.text ?? "").trim();
  }

  /**
   * OpenAI-compatible /v1/chat/completions (works for OpenAI, OpenRouter, etc).
   */
  private async completeOpenAiCompat(
    model: string,
    prompt: string,
    maxTokens: number,
    timeoutMs: number
  ): Promise<string> {
    const baseUrl = this.config.baseUrl.replace(/\/$/, "");
    // Some providers include the API version in the base URL already
    const hasVersion = /\/v\d+\/?$/.test(baseUrl);
    const url = hasVersion
      ? `${baseUrl}/chat/completions`
      : `${baseUrl}/v1/chat/completions`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.config.apiKey) {
      headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    }

    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: maxTokens,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (resp.status === 429) this.handleRateLimit(resp);
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`LLM API error ${resp.status}: ${text}`);
    }

    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return (data.choices?.[0]?.message?.content ?? "").trim();
  }
}
