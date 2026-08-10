/**
 * Multi-provider LLM client for consolidation and distillation.
 *
 * ONE model serves all phases (distill, reflect, classify, scoring) — #231.
 * The 0.16.x per-tier split (distill, reflect, classify + base) is removed.
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

import { readPositiveConfig, readStrictBoolean, readNonNegativeConfig } from "./config-read.js";

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  provider: string;
  /** Max output tokens for all phases (one model). Default 8192. */
  maxTokens?: number;
  /** Toggle thinking on the openai-compat path for all phases. Absent = no kwarg sent.
   *  LOCAL-endpoint only (ollama / mlx-lm gateway); see HicortexConfig.enableThinking. */
  enableThinking?: boolean;
  /** Context window for ollama (the one model, all phases). Default 8192. */
  numCtx?: number;
  /** Flush ollama memory every N ollama calls (0 = off). See HicortexConfig.ollamaFlushEvery. */
  ollamaFlushEvery?: number;
  /** Ms to wait after an ollama flush for the runner to release. */
  ollamaFlushWaitMs?: number;
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
}): LlmConfig | null {
  // 1. Explicit config-file overrides (both baseUrl and apiKey required)
  if (overrides?.llmBaseUrl && overrides?.llmApiKey) {
    const provider = detectProvider(overrides.llmBaseUrl);
    return {
      baseUrl: overrides.llmBaseUrl,
      apiKey: overrides.llmApiKey,
      model: overrides.llmModel ?? "claude-haiku-4-5-20251001",
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
 * Validate + copy the tuning keys (#220: maxTokens + enableThinking + numCtx +
 * ollama flush) from the saved disk config onto a runtime LlmConfig. Called by
 * BOTH LlmConfig construction sites — the daemon in mcp-server.ts (runs
 * distill) AND resolveSavedLlmConfig below (the nightly runs reflect +
 * classify) — so every process honors the keys, and a future site calling this
 * inherits them by construction.
 *
 * All keys are optional; absent = call-site defaults (maxTokens 8192, numCtx
 * 8192, thinking kwarg omitted, flush off). Wrong-typed values warn and are
 * dropped (readPositiveConfig / readStrictBoolean / readNonNegativeConfig) —
 * notably a JSON slip `"enableThinking": "false"` (string) is rejected rather
 * than coerced to truthy thinking-on, which would silently invert the fix this
 * key exists to apply.
 */
export function applyTierTuningOverlay(
  llmConfig: LlmConfig,
  savedConfig: Record<string, unknown> | null | undefined,
): void {
  if (!savedConfig) return;
  if (savedConfig.maxTokens !== undefined) {
    llmConfig.maxTokens = readPositiveConfig(savedConfig, "maxTokens", 8192);
  }
  const thinking = readStrictBoolean(savedConfig, "enableThinking");
  if (thinking !== undefined) {
    llmConfig.enableThinking = thinking;
  }
  if (savedConfig.numCtx !== undefined) {
    llmConfig.numCtx = readPositiveConfig(savedConfig, "numCtx", 8192);
  }
  if (savedConfig.ollamaFlushEvery !== undefined) {
    llmConfig.ollamaFlushEvery = readNonNegativeConfig(savedConfig, "ollamaFlushEvery", 0);
  }
  if (savedConfig.ollamaFlushWaitMs !== undefined) {
    llmConfig.ollamaFlushWaitMs = readPositiveConfig(savedConfig, "ollamaFlushWaitMs", 180000);
  }
}

/**
 * Resolve an LlmConfig from a saved ~/.hicortex/config.json object.
 *
 * This is the SINGLE config path used by pipeline runs (nightly consolidation
 * and `hicortex relink`): named backends (claude-cli, ollama) first, then the
 * explicit-config/env fallthrough via resolveExplicitLlmConfig. One model
 * serves all phases (#231) — there is no per-tier overlay here.
 *
 * Returns `reason: "claude_binary_missing"` when claude-cli is configured but
 * the binary can't be found, so callers can log a context-specific message.
 *
 * `findBinary` is injectable (defaults to the real `findClaudeBinary`) so the
 * claude-cli branch — including the missing-binary passthrough — can be pinned
 * deterministically in tests without depending on the host filesystem.
 */
export function resolveSavedLlmConfig(
  savedConfig: Record<string, unknown> | null,
  findBinary: () => string | null = findClaudeBinary,
): { config: LlmConfig | null; reason?: "claude_binary_missing" } {
  let llmConfig: LlmConfig | null = null;

  if (savedConfig?.llmBackend === "claude-cli") {
    const claudePath = findBinary();
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
      provider: "ollama",
    };
  } else {
    llmConfig = resolveExplicitLlmConfig({
      llmBaseUrl: savedConfig?.llmBaseUrl as string | undefined,
      llmApiKey: savedConfig?.llmApiKey as string | undefined,
      llmModel: savedConfig?.llmModel as string | undefined,
    });
  }

  // Tuning overlay (#220: maxTokens + enableThinking + numCtx + flush). Applied
  // at both construction sites (daemon + nightly) so every phase honors the keys.
  if (llmConfig) {
    applyTierTuningOverlay(llmConfig, savedConfig as Record<string, unknown> | null);
  }

  return { config: llmConfig };
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

/**
 * Token-usage triplet reported by every LLM call (#246). All three fields are
 * populated from real API responses — no estimation, no fallback. `usage` is
 * `undefined` ONLY when a backend genuinely returned no usage object (which
 * should never happen on a healthy path: OpenAI-compat and Ollama both echo
 * usage on every successful completion). Callers that record usage must treat
 * `undefined` as "no signal this call" and skip — never as zero (zero would
 * silently undercount a real cost).
 *
 * Field names mirror the OpenAI spec (`prompt_tokens` / `completion_tokens` /
 * `total_tokens`) so the shape is parseable by anything that already speaks
 * that API. Ollama's `prompt_eval_count` / `eval_count` are mapped at the
 * provider boundary in completeOllama.
 */
export interface LlmUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/**
 * The result of every LLM completion. `text` is the trimmed model output;
 * `usage` is the token accounting from the API response (#246).
 */
export interface LlmResult {
  text: string;
  usage?: LlmUsage;
}

// Rate-limit backoff is keyed by provider@baseUrl at module scope so it is
// shared across any LlmClient instances that target the same endpoint (e.g. a
// daemon client + a future constructed client). One model serves all phases
// (#231), so in practice there is a single client per process today; the
// module-level map keeps the state shared correctly if that ever changes.
const rateLimitedUntilByEndpoint = new Map<string, number>();

export class LlmClient {
  private config: LlmConfig;
  private ollamaCallCount = 0;

  constructor(config: LlmConfig) {
    this.config = config;
  }

  /** Endpoint identity for shared rate-limit state (provider + base URL). */
  private get endpointKey(): string {
    return `${this.config.provider}@${this.config.baseUrl ?? ""}`;
  }

  private get rateLimitedUntil(): number {
    return rateLimitedUntilByEndpoint.get(this.endpointKey) ?? 0;
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
    const until = Date.now() + retryMs;
    rateLimitedUntilByEndpoint.set(this.endpointKey, until);
    console.log(
      `[hicortex] Rate limited by LLM provider (${this.endpointKey}). ` +
      `Will retry after ${new Date(until).toISOString()}`
    );
    throw new RateLimitError(retryMs);
  }

  /**
   * Fast-tier completion (importance scoring, simple tasks). One model serves
   * all phases (#231); numCtx + enableThinking are read from config directly
   * inside completeOnce's per-provider dispatch, not threaded here. The periodic
   * ollama flush stays (provider-gated) — it is a scoring-call-count cadence and
   * scoring is the highest-frequency call, so this is where the flush belongs.
   */
  async completeFast(prompt: string, maxTokens?: number): Promise<LlmResult> {
    const tokens = maxTokens ?? this.config.maxTokens ?? 8192;
    const result = await this.complete(this.config.model, prompt, tokens, 600_000);
    const flushEvery = this.config.ollamaFlushEvery ?? 0;
    if (this.config.provider === "ollama" && flushEvery > 0) {
      this.ollamaCallCount++;
      if (this.ollamaCallCount >= flushEvery) {
        await this.flushOllama(this.config.model);
        this.ollamaCallCount = 0;
      }
    }
    return result;
  }

  /**
   * Reflect-tier completion (nightly reflection). One model serves all phases
   * (#231) — this is a thin wrapper kept for call-site readability.
   */
  async completeReflect(prompt: string, maxTokens?: number): Promise<LlmResult> {
    const tokens = maxTokens ?? this.config.maxTokens ?? 8192;
    return this.complete(this.config.model, prompt, tokens, 900_000);
  }

  /**
   * Distillation-tier completion (session knowledge extraction). One model
   * serves all phases (#231) — thin wrapper kept for call-site readability.
   */
  async completeDistill(prompt: string, maxTokens?: number): Promise<LlmResult> {
    const tokens = maxTokens ?? this.config.maxTokens ?? 8192;
    return this.complete(this.config.model, prompt, tokens, 900_000);
  }

  /**
   * Classification-tier completion (memory tag classification). One model
   * serves all phases (#231) — thin wrapper kept for call-site readability.
   */
  async completeClassify(prompt: string, maxTokens?: number): Promise<LlmResult> {
    const tokens = maxTokens ?? this.config.maxTokens ?? 8192;
    return this.complete(this.config.model, prompt, tokens, 900_000);
  }

  private async complete(
    model: string,
    prompt: string,
    maxTokens: number,
    timeoutMs: number,
  ): Promise<LlmResult> {
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
    timeoutMs: number,
  ): Promise<LlmResult> {
    if (this.config.provider === "claude-cli") {
      return this.completeClaude(model, prompt, timeoutMs);
    }
    if (this.config.provider === "ollama") {
      return this.completeOllama(model, prompt, maxTokens, timeoutMs);
    }
    if (this.config.provider === "anthropic") {
      return this.completeAnthropic(model, prompt, maxTokens, timeoutMs);
    }
    // enableThinking is read from config here (one value, all phases — #231).
    return this.completeOpenAiCompat(model, prompt, maxTokens, timeoutMs);
  }

  /**
   * Claude CLI: shell out to `claude -p` for subscription users.
   * No API key needed — uses CC's authenticated session.
   *
   * Token usage (#246): the claude CLI JSON output does not carry a token
   * usage field, so this path returns `usage: undefined`. The CLI is billed
   * by Claude subscription, not per-token — there is nothing to meter. The
   * fair-use cap therefore never trips on a claude-cli install, which is the
   * correct outcome (no meterable cost to defend against).
   */
  private async completeClaude(
    model: string,
    prompt: string,
    timeoutMs: number
  ): Promise<LlmResult> {
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
      return { text: (data.result ?? "").trim() };
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
   * num_ctx is read from config (one value, all phases — #231; default 8192).
   *
   * Token usage (#246): the FINAL streamed chunk carries the per-request
   * accounting as `prompt_eval_count` (input) + `eval_count` (output). Earlier
   * chunks have null/zero — only the terminal chunk is meaningful, so we keep
   * updating as chunks arrive and the last one wins.
   */
  private async completeOllama(
    model: string,
    prompt: string,
    maxTokens: number,
    timeoutMs: number,
  ): Promise<LlmResult> {
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
        // num_ctx: one value for all phases (#231), default 8192 — the point where
        // context stops being the binding constraint for a sub-8B model on ollama
        // (above it the SMALL_MODEL_MAX_CHUNK_CHARS speed cap binds instead). Also
        // drives detectChunkSize, so the chunker and the request agree by construction.
        options: { num_predict: maxTokens, num_ctx: this.config.numCtx ?? 8192 },
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

    // Collect streamed response chunks. The terminal chunk carries the token
    // accounting (`prompt_eval_count` / `eval_count`); earlier chunks have
    // null. Track the latest values so the final ones win (mirrors the official
    // ollama-js streaming parser).
    let result = "";
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;
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
          // Token accounting — only present on the terminal chunk. Keep the last
          // non-null value; missing on both → usage stays undefined (no signal).
          if (typeof data.prompt_eval_count === "number") {
            promptTokens = data.prompt_eval_count;
          }
          if (typeof data.eval_count === "number") {
            completionTokens = data.eval_count;
          }
        } catch { /* skip malformed lines */ }
      }
    }
    const usage: LlmUsage | undefined =
      promptTokens !== undefined && completionTokens !== undefined
        ? {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
          }
        : undefined;
    return { text: result.trim(), usage };
  }

  /**
   * Flush ollama's accumulated memory: unload the model (keep_alive:0) so the
   * runner exits + releases its per-request RSS growth, then wait for the release
   * before the next call reloads fresh. The runner takes >90 s to exit after
   * keep_alive:0 (measured), so the wait is generous (ollamaFlushWaitMs, default
   * 180 s). Logs the flush so the wait is distinguishable from a hang. If the
   * unload request fails (ollama down), the wait is skipped — no dead time for a
   * release that can't have happened. See #229 review.
   */
  private async flushOllama(model: string): Promise<void> {
    const url = `${this.config.baseUrl.replace(/\/$/, "")}/api/generate`;
    const waitMs = this.config.ollamaFlushWaitMs ?? 180_000;
    console.log(`[hicortex] ollama flush: unloading ${model} after ${this.ollamaCallCount} scoring calls, waiting ${waitMs / 1000}s for memory release…`);
    try {
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, keep_alive: 0 }),
        signal: AbortSignal.timeout(60_000),
      });
      await new Promise((r) => setTimeout(r, waitMs));
      console.log(`[hicortex] ollama flush: complete`);
    } catch {
      console.warn(`[hicortex] ollama flush: unload request failed (ollama unreachable?) — skipping wait`);
    }
  }

  /**
   * Anthropic Messages API (/v1/messages).
   * Auth via x-api-key header.
   *
   * Token usage (#246): Anthropic's response carries `usage.input_tokens` +
   * `usage.output_tokens`. Mapped to the OpenAI-spec field names so downstream
   * accounting is uniform across providers.
   */
  private async completeAnthropic(
    model: string,
    prompt: string,
    maxTokens: number,
    timeoutMs: number
  ): Promise<LlmResult> {
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
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const textBlock = data.content?.find((c) => c.type === "text");
    const inT = data.usage?.input_tokens;
    const outT = data.usage?.output_tokens;
    const usage: LlmUsage | undefined =
      typeof inT === "number" && typeof outT === "number"
        ? {
            prompt_tokens: inT,
            completion_tokens: outT,
            total_tokens: inT + outT,
          }
        : undefined;
    return { text: (textBlock?.text ?? "").trim(), usage };
  }

  /**
   * OpenAI-compatible /v1/chat/completions (works for OpenAI, OpenRouter, etc).
   * enableThinking is read from config here (one value, all phases — #231).
   *
   * Token usage (#246): the OpenAI spec's `usage` object is always present on
   * a successful completion — `prompt_tokens` / `completion_tokens` /
   * `total_tokens`. The MLX gateway emits the same shape (verified v0.31.3).
   * Parsed verbatim; absent only on a non-conforming endpoint, in which case
   * `usage` stays undefined (no signal, never a fabricated zero).
   */
  private async completeOpenAiCompat(
    model: string,
    prompt: string,
    maxTokens: number,
    timeoutMs: number,
  ): Promise<LlmResult> {
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

    // Qwen3 thinking mode: when on, the model can burn the whole token budget on
    // an unclosed <think> block and emit nothing (probed 2026-08-04). One value
    // for all phases (#231): when set (true or false) the chat_template_kwargs
    // kwarg rides every call — so it is LOCAL-endpoint only (ollama, mlx-lm
    // gateway); a cloud OpenAI/OpenRouter/Groq endpoint would 400 on the unknown
    // field. provider cannot gate this (the MLX gateway is also provider:openai),
    // so the operator leaves enableThinking unset for cloud endpoints. See #220.
    const thinking = this.config.enableThinking;
    const body: Record<string, unknown> = {
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: maxTokens,
    };
    if (thinking !== undefined) {
      body.chat_template_kwargs = { enable_thinking: thinking };
    }

    const resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (resp.status === 429) this.handleRateLimit(resp);
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`LLM API error ${resp.status}: ${text}`);
    }

    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
    };
    const u = data.usage;
    const usage: LlmUsage | undefined =
      typeof u?.prompt_tokens === "number" &&
      typeof u?.completion_tokens === "number" &&
      typeof u?.total_tokens === "number"
        ? {
            prompt_tokens: u.prompt_tokens,
            completion_tokens: u.completion_tokens,
            total_tokens: u.total_tokens,
          }
        : undefined;
    return { text: (data.choices?.[0]?.message?.content ?? "").trim(), usage };
  }
}
