/**
 * Tests for the dedicated classify LLM tier (classifyModel/classifyBaseUrl).
 *
 * Covers:
 *   1. LlmClient.completeClassify routing — delegates to the reflect tier when
 *      no classify keys are set (zero behavior change), uses the classify
 *      endpoint/model when configured, and runs classifyModel on the reflect
 *      endpoint when only the model is set. Verified against a stubbed fetch
 *      (Ollama /api/generate), including think:false.
 *   2. resolveClassifyProbeTarget — the pure probe-target resolution shared by
 *      the nightly contentDomainsReady gate and the classify-domains preflight:
 *      classify tier when configured, else the reflect tier, null when no
 *      separate-Ollama probe applies.
 *   3. resolveSavedLlmConfig — carries classifyModel/classifyBaseUrl (and the
 *      apiKey/provider defaults) through from a saved config.json object.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  LlmClient,
  resolveClassifyProbeTarget,
  resolveSavedLlmConfig,
  type LlmConfig,
} from "../src/llm.js";

// ---------------------------------------------------------------------------
// Fetch stub: records every Ollama /api/generate call (url + parsed body) and
// returns a minimal streamed response, matching completeOllama's reader loop.
// ---------------------------------------------------------------------------

interface GenerateCall {
  url: string;
  body: { model: string; think?: boolean; prompt: string };
}

function stubOllamaFetch(reply: string): GenerateCall[] {
  const calls: GenerateCall[] = [];
  const encoder = new TextEncoder();
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    let sent = false;
    return {
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () => {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return {
              done: false,
              value: encoder.encode(JSON.stringify({ response: reply }) + "\n"),
            };
          },
        }),
      },
    } as unknown as Response;
  }));
  return calls;
}

const baseCfg = (extra: Partial<LlmConfig> = {}): LlmConfig => ({
  baseUrl: "http://local:11434",
  apiKey: "",
  model: "small-4b",
  reflectModel: "qwen-35b",
  provider: "ollama",
  reflectBaseUrl: "http://mac:11434",
  reflectProvider: "ollama",
  ...extra,
});

afterEach(() => vi.unstubAllGlobals());

// ---------------------------------------------------------------------------
// 1. completeClassify routing
// ---------------------------------------------------------------------------

describe("LlmClient.completeClassify", () => {
  it("falls back to the reflect tier when no classify keys are set", async () => {
    const calls = stubOllamaFetch("ok");
    const client = new LlmClient(baseCfg());
    expect(await client.completeClassify("p", 64)).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://mac:11434/api/generate");
    expect(calls[0].body.model).toBe("qwen-35b");
    expect(calls[0].body.think).toBe(false);
  });

  it("uses classifyModel@classifyBaseUrl when both are configured", async () => {
    const calls = stubOllamaFetch("ok");
    const client = new LlmClient(baseCfg({
      classifyModel: "gemma4-31b",
      classifyBaseUrl: "http://mlx-box:11434",
      classifyProvider: "ollama",
    }));
    await client.completeClassify("p", 64);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://mlx-box:11434/api/generate");
    expect(calls[0].body.model).toBe("gemma4-31b");
    expect(calls[0].body.think).toBe(false);
  });

  it("runs classifyModel on the reflect endpoint when only the model is set", async () => {
    const calls = stubOllamaFetch("ok");
    const client = new LlmClient(baseCfg({ classifyModel: "gemma4-31b" }));
    await client.completeClassify("p", 64);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://mac:11434/api/generate");
    expect(calls[0].body.model).toBe("gemma4-31b");
  });

  it("runs classifyModel on the base endpoint when no reflect endpoint exists", async () => {
    const calls = stubOllamaFetch("ok");
    const client = new LlmClient(baseCfg({
      reflectBaseUrl: undefined,
      reflectProvider: undefined,
      classifyModel: "gemma4-31b",
    }));
    await client.completeClassify("p", 64);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://local:11434/api/generate");
    expect(calls[0].body.model).toBe("gemma4-31b");
  });

  it("classifyBaseUrl without classifyModel uses the reflect model there", async () => {
    const calls = stubOllamaFetch("ok");
    const client = new LlmClient(baseCfg({
      classifyBaseUrl: "http://mlx-box:11434",
      classifyProvider: "ollama",
    }));
    await client.completeClassify("p", 64);
    expect(calls[0].url).toBe("http://mlx-box:11434/api/generate");
    expect(calls[0].body.model).toBe("qwen-35b");
  });
});

// ---------------------------------------------------------------------------
// 2. resolveClassifyProbeTarget (pure preflight target resolution — the seam
//    used by both the nightly gate and `hicortex classify-domains`)
// ---------------------------------------------------------------------------

describe("resolveClassifyProbeTarget", () => {
  it("targets the reflect tier when no classify keys are set", () => {
    expect(resolveClassifyProbeTarget(baseCfg())).toEqual({
      tier: "reflect",
      baseUrl: "http://mac:11434",
      model: "qwen-35b",
    });
  });

  it("returns null when classify is unset and there is no separate reflect endpoint", () => {
    expect(
      resolveClassifyProbeTarget(baseCfg({ reflectBaseUrl: undefined, reflectProvider: undefined })),
    ).toBeNull();
  });

  it("targets the classify endpoint when classifyModel+classifyBaseUrl are set", () => {
    const target = resolveClassifyProbeTarget(baseCfg({
      classifyModel: "gemma4-31b",
      classifyBaseUrl: "http://mlx-box:11434",
      classifyProvider: "ollama",
    }));
    expect(target).toEqual({
      tier: "classify",
      baseUrl: "http://mlx-box:11434",
      model: "gemma4-31b",
    });
  });

  it("targets the reflect endpoint with the classify model when only classifyModel is set", () => {
    const target = resolveClassifyProbeTarget(baseCfg({ classifyModel: "gemma4-31b" }));
    expect(target).toEqual({
      tier: "classify",
      baseUrl: "http://mac:11434",
      model: "gemma4-31b",
    });
  });

  it("returns null when classifyModel runs on the base endpoint (no separate endpoint to probe)", () => {
    expect(
      resolveClassifyProbeTarget(baseCfg({
        reflectBaseUrl: undefined,
        reflectProvider: undefined,
        classifyModel: "gemma4-31b",
      })),
    ).toBeNull();
  });

  it("returns null for a non-Ollama classify provider (cloud-reachable, no probe)", () => {
    expect(
      resolveClassifyProbeTarget(baseCfg({
        classifyModel: "gpt-thing",
        classifyBaseUrl: "https://api.example.com",
        classifyProvider: "openai",
      })),
    ).toBeNull();
  });

  it("matches completeClassify's routing for the reflect-fallback probe (reflect provider wins)", () => {
    // reflectProvider non-ollama → completeReflect hits an API provider; no probe.
    expect(
      resolveClassifyProbeTarget(baseCfg({ reflectProvider: "anthropic" })),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. resolveSavedLlmConfig carries the classify keys through
// ---------------------------------------------------------------------------

describe("resolveSavedLlmConfig — classify tier overlay", () => {
  it("carries classifyModel and classifyBaseUrl from saved config (ollama backend)", () => {
    const { config } = resolveSavedLlmConfig({
      llmBackend: "ollama",
      llmModel: "small-4b",
      reflectModel: "qwen-35b",
      reflectBaseUrl: "http://mac:11434",
      classifyModel: "gemma4-31b",
      classifyBaseUrl: "http://mlx-box:11434",
    });
    expect(config).not.toBeNull();
    expect(config!.classifyModel).toBe("gemma4-31b");
    expect(config!.classifyBaseUrl).toBe("http://mlx-box:11434");
    // Defaults mirror the distill/reflect overlays: apiKey/provider from base.
    expect(config!.classifyApiKey).toBe("");
    expect(config!.classifyProvider).toBe("ollama");
  });

  it("leaves the classify tier unset when the saved config has no classify keys", () => {
    const { config } = resolveSavedLlmConfig({
      llmBackend: "ollama",
      llmModel: "small-4b",
      reflectModel: "qwen-35b",
    });
    expect(config).not.toBeNull();
    expect(config!.classifyModel).toBeUndefined();
    expect(config!.classifyBaseUrl).toBeUndefined();
    expect(config!.classifyProvider).toBeUndefined();
  });

  it("honors an explicit classifyProvider override", () => {
    const { config } = resolveSavedLlmConfig({
      llmBackend: "ollama",
      llmModel: "small-4b",
      classifyModel: "gpt-thing",
      classifyBaseUrl: "https://api.example.com",
      classifyProvider: "openai",
      classifyApiKey: "sk-test",
    });
    expect(config!.classifyProvider).toBe("openai");
    expect(config!.classifyApiKey).toBe("sk-test");
  });
});
