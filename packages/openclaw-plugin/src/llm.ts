/**
 * Multi-provider LLM client for consolidation and distillation.
 * Ported from hicortex/consolidate/llm.py.
 *
 * Resolution for OC adapter (resolveLlmConfig):
 *   1. Plugin config (llmBaseUrl, llmApiKey, llmModel)
 *   2. ~/.openclaw/openclaw.json agents.defaults.model.primary
 *   3. Environment vars: OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_API_KEY
 *   4. Fallback: Ollama at http://localhost:11434
 *
 * Resolution for CC adapter (resolveLlmConfigForCC):
 *   1. Explicit env vars (HICORTEX_LLM_BASE_URL + HICORTEX_LLM_API_KEY + HICORTEX_LLM_MODEL)
 *   2. ANTHROPIC_API_KEY → Haiku (cheap, CC users always have this)
 *   3. OPENAI_API_KEY → gpt-4o-mini
 *   4. GOOGLE_API_KEY → gemini-2.0-flash
 *   5. Fallback: Ollama at http://localhost:11434
 *
 * Supports: OpenAI, Anthropic, Google, OpenRouter, Ollama, z.ai, and 15+ more
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

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
}

/**
 * Resolve LLM configuration from plugin config, OpenClaw config, env vars, or Ollama fallback.
 */
export function resolveLlmConfig(pluginConfig?: {
  llmBaseUrl?: string;
  llmApiKey?: string;
  llmModel?: string;
  reflectModel?: string;
}): LlmConfig {
  // 1. Plugin config
  if (pluginConfig?.llmBaseUrl && pluginConfig?.llmApiKey) {
    const provider = detectProvider(pluginConfig.llmBaseUrl);
    return {
      baseUrl: pluginConfig.llmBaseUrl,
      apiKey: pluginConfig.llmApiKey,
      model: pluginConfig.llmModel ?? "qwen3.5:4b",
      reflectModel: pluginConfig.reflectModel ?? pluginConfig.llmModel ?? "qwen3.5:cloud",
      provider,
    };
  }

  // 2. OpenClaw config file
  const ocConfig = readOpenClawConfig();
  if (ocConfig) {
    return ocConfig;
  }

  // 3. Environment variables
  const envConfig = resolveFromEnv();
  if (envConfig) {
    return envConfig;
  }

  // 4. Fallback: Ollama
  return {
    baseUrl: "http://localhost:11434",
    apiKey: "",
    model: "qwen3.5:4b",
    reflectModel: "qwen3.5:cloud",
    provider: "ollama",
  };
}

/**
 * Resolve LLM configuration for Claude Code (no OC config file).
 * Uses env vars only — CC users always have ANTHROPIC_API_KEY.
 * Defaults to Haiku for distillation/scoring (~$0.50/mo).
 */
export function resolveLlmConfigForCC(overrides?: {
  llmBaseUrl?: string;
  llmApiKey?: string;
  llmModel?: string;
  reflectModel?: string;
}): LlmConfig {
  // 1. Explicit overrides (from config file or CLI args)
  if (overrides?.llmBaseUrl && overrides?.llmApiKey) {
    const provider = detectProvider(overrides.llmBaseUrl);
    return {
      baseUrl: overrides.llmBaseUrl,
      apiKey: overrides.llmApiKey,
      model: overrides.llmModel ?? "claude-haiku-4-5-20251001",
      reflectModel: overrides.reflectModel ?? overrides.llmModel ?? "claude-sonnet-4-5-20250514",
      provider,
    };
  }

  // 2. Hicortex-specific env vars
  const hcBaseUrl = process.env.HICORTEX_LLM_BASE_URL;
  const hcApiKey = process.env.HICORTEX_LLM_API_KEY;
  const hcModel = process.env.HICORTEX_LLM_MODEL;
  if (hcBaseUrl && hcApiKey) {
    const provider = detectProvider(hcBaseUrl);
    return {
      baseUrl: hcBaseUrl,
      apiKey: hcApiKey,
      model: hcModel ?? "claude-haiku-4-5-20251001",
      reflectModel: process.env.HICORTEX_REFLECT_MODEL ?? hcModel ?? "claude-sonnet-4-5-20250514",
      provider,
    };
  }

  // 3. Standard API key env vars (CC users almost always have ANTHROPIC_API_KEY)
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    return {
      baseUrl: process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com",
      apiKey: anthropicKey,
      model: "claude-haiku-4-5-20251001",
      reflectModel: "claude-sonnet-4-5-20250514",
      provider: "anthropic",
    };
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    const baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com";
    return {
      baseUrl,
      apiKey: openaiKey,
      model: "gpt-4o-mini",
      reflectModel: "gpt-4o-mini",
      provider: detectProvider(baseUrl),
    };
  }

  const googleKey = process.env.GOOGLE_API_KEY;
  if (googleKey) {
    return {
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: googleKey,
      model: "gemini-2.0-flash",
      reflectModel: "gemini-2.0-flash",
      provider: "google",
    };
  }

  // 4. Claude CLI fallback (subscription users)
  const claudePath = findClaudeBinary();
  if (claudePath) {
    return claudeCliConfig(claudePath);
  }

  // 5. Ollama fallback (truly last resort)
  return {
    baseUrl: "http://localhost:11434",
    apiKey: "",
    model: "qwen3.5:4b",
    reflectModel: "qwen3.5:4b",
    provider: "ollama",
  };
}

function detectProvider(
  url: string
): LlmConfig["provider"] {
  const u = url.toLowerCase();
  if (u.includes("ollama") || u.includes(":11434")) return "ollama";
  if (u.includes("anthropic")) return "anthropic";
  if (u.includes("openrouter")) return "openrouter";
  if (u.includes("googleapis") || u.includes("generativelanguage")) return "google";
  if (u.includes("z.ai") || u.includes("zai")) return "zai";
  return "openai";
}

function readOpenClawConfig(): LlmConfig | null {
  try {
    const configPath = join(homedir(), ".openclaw", "openclaw.json");
    const raw = readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw);
    const primary = config?.agents?.defaults?.model?.primary;
    if (!primary) return null;

    // primary format is "provider/model" (e.g. "zai/glm-5-turbo", "openai/gpt-4o")
    if (typeof primary === "string" && (primary.includes("/") || primary.includes(":"))) {
      const sep = primary.includes("/") ? "/" : ":";
      const [providerHint, ...rest] = primary.split(sep);
      const model = rest.join(sep);
      // Accept any provider name — if it's in our URL map, we know it
      const hint = providerHint.toLowerCase();
      const provider = (hint in PROVIDER_BASE_URLS ? hint : "openai") as LlmConfig["provider"];

      // Resolve base URL: OC config → per-agent models.json → built-in defaults
      const baseUrl =
        readOcProviderBaseUrl(config, providerHint) ??
        getDefaultUrlForProvider(provider);

      // Resolve API key: OC auth-profiles.json → env vars
      const apiKey =
        readOcAuthKey(providerHint) ??
        getEnvKeyForProvider(provider);

      if (!apiKey && provider !== "ollama") return null;

      return {
        baseUrl,
        apiKey: apiKey ?? "",
        model,
        reflectModel: model,
        provider,
      };
    }
  } catch {
    // Config file doesn't exist or is invalid
  }
  return null;
}

/**
 * Read provider base URL from openclaw.json → models.providers.<name>.baseUrl
 */
function readOcProviderBaseUrl(config: any, provider: string): string | undefined {
  const providerConfig = config?.models?.providers?.[provider];
  if (providerConfig?.baseUrl) return providerConfig.baseUrl;
  return undefined;
}


/**
 * Read API key from OC's per-agent auth-profiles.json.
 * Scans all agent dirs for a matching provider profile.
 */
function readOcAuthKey(provider: string): string | undefined {
  try {
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const agentsDir = join(homedir(), ".openclaw", "agents");
    const agents = readdirSync(agentsDir);

    for (const agentId of agents) {
      try {
        const authPath = join(agentsDir, agentId, "agent", "auth-profiles.json");
        const raw = readFileSync(authPath, "utf-8");
        const auth = JSON.parse(raw);
        const profiles = auth?.profiles ?? {};

        // Look for a profile matching the provider (e.g. "zai:default")
        for (const [profileId, profile] of Object.entries(profiles)) {
          const p = profile as any;
          if (
            p?.provider === provider ||
            profileId.startsWith(`${provider}:`)
          ) {
            if (p?.key) return p.key as string;
          }
        }
      } catch {
        // Skip agents without auth
      }
    }
  } catch {
    // No agents dir
  }
  return undefined;
}

function resolveFromEnv(): LlmConfig | null {
  const openaiKey = process.env.OPENAI_API_KEY;
  const openaiBaseUrl = process.env.OPENAI_BASE_URL;
  if (openaiKey) {
    const baseUrl = openaiBaseUrl ?? "https://api.openai.com";
    const provider = detectProvider(baseUrl);
    return {
      baseUrl,
      apiKey: openaiKey,
      model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
      reflectModel: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
      provider,
    };
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    return {
      baseUrl: process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com",
      apiKey: anthropicKey,
      model: "claude-sonnet-4-20250514",
      reflectModel: "claude-sonnet-4-20250514",
      provider: "anthropic",
    };
  }

  const googleKey = process.env.GOOGLE_API_KEY;
  if (googleKey) {
    return {
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: googleKey,
      model: "gemini-2.0-flash",
      reflectModel: "gemini-2.0-flash",
      provider: "google",
    };
  }

  return null;
}

function getEnvKeyForProvider(provider: string): string | undefined {
  switch (provider) {
    case "openai":
      return process.env.OPENAI_API_KEY;
    case "anthropic":
      return process.env.ANTHROPIC_API_KEY;
    case "google":
      return process.env.GOOGLE_API_KEY;
    case "zai":
      return process.env.ZAI_API_KEY ?? process.env.LLM_API_KEY;
    default:
      return undefined;
  }
}

/** Default base URLs for all OC-supported providers (from OC gateway binary). */
const PROVIDER_BASE_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  google: "https://generativelanguage.googleapis.com/v1beta",
  ollama: "http://localhost:11434",
  openrouter: "https://openrouter.ai/api",
  zai: "https://api.z.ai/api/anthropic",
  groq: "https://api.groq.com/openai/v1",
  deepseek: "https://api.deepseek.com",
  mistral: "https://api.mistral.ai/v1",
  together: "https://api.together.xyz/v1",
  perplexity: "https://api.perplexity.ai",
  nvidia: "https://integrate.api.nvidia.com/v1",
  xai: "https://api.x.ai/v1",
  venice: "https://api.venice.ai/api/v1",
  minimax: "https://api.minimaxi.com/v1",
  moonshot: "https://api.moonshot.ai/v1",
  kimi: "https://api.kimi.com/coding",
  chutes: "https://api.chutes.ai",
  kilo: "https://api.kilo.ai/api/gateway",
};

function getDefaultUrlForProvider(provider: string): string {
  return PROVIDER_BASE_URLS[provider.toLowerCase()] ?? "https://api.openai.com/v1";
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
 * For batch operations (nightly pipeline), prefer Ollama when available.
 * Claude CLI has strict rate limits that kill batch distillation.
 * Falls back to the provided config if Ollama is unreachable.
 */
export async function preferOllamaForBatch(
  resolved: LlmConfig,
  ollamaBaseUrl = "http://localhost:11434"
): Promise<LlmConfig> {
  // Only override claude-cli (which has rate limits)
  if (resolved.provider !== "claude-cli") return resolved;

  const model = await probeOllama(ollamaBaseUrl);
  if (!model) return resolved;

  return {
    ...resolved,
    baseUrl: ollamaBaseUrl,
    apiKey: "",
    model,
    reflectModel: resolved.reflectModel ?? model,
    provider: "ollama",
  };
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
    if (this.config.provider === "anthropic" || this.config.provider === "zai") {
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
   * Anthropic Messages API (/v1/messages). Used for Anthropic and z.ai.
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
    // Some providers (z.ai) include version in base URL already
    const hasVersion = /\/v\d+\/?$/.test(baseUrl) || baseUrl.includes("/paas/v");
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
      // z.ai: "Insufficient balance" likely means wrong endpoint (coding vs paas)
      if (text.includes("1113") || text.includes("Insufficient balance")) {
        console.log(`[hicortex] LLM billing error. Check that llmBaseUrl matches your plan. Current: ${baseUrl}`);
      }
      throw new Error(`LLM API error ${resp.status}: ${text}`);
    }

    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return (data.choices?.[0]?.message?.content ?? "").trim();
  }
}
