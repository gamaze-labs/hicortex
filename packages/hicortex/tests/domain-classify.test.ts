/**
 * Tests for content-based MULTI-TAG classification (graded-schema spec
 * 2026-07-07: the LLM emits ONLY ordered discrete tags — no primary, no
 * weights; the primary is derived downstream from prototype weights).
 *
 * Covers the pure helpers (matchDomain, parseConfigDomains, domainSetHash,
 * buildClassifyPrompt, parseTagReply) and classifyMemoryTags against a mock
 * LlmClient: ordered multi-tag return, legacy {primary,tags} tolerance
 * (primary ignored), project-hint in the prompt, invalid-name retry,
 * infra-error→null, and genuine-no-fit→{tags: []} (owner amendment 07.07:
 * "Unsorted" is a non-tag — no fallback category is ever auto-assigned).
 */

import { describe, it, expect } from "vitest";
import {
  classifyMemoryTags,
  parseTagReply,
  matchDomain,
  parseConfigDomains,
  domainSetHash,
  buildClassifyPrompt,
  CLASSIFY_CONTENT_MAX_CHARS,
  type DomainDef,
} from "../src/domain-classify.js";
import type { LlmClient } from "../src/llm.js";

// NOTE: no "Unsorted" entry — a config WITHOUT any fallback bucket is the norm.
const DOMAINS: DomainDef[] = [
  { name: "Work", description: "Employer, day job, workstreams" },
  { name: "Ventures", description: "Side businesses like Gamaze" },
  { name: "Hardware", description: "Servers, agents, infra, machines" },
  { name: "Boating", description: "Boat maintenance, trips, marina" },
];

/** A mock LlmClient whose completeClassify returns queued replies in order. */
function mockLlm(replies: Array<string | Error>): LlmClient {
  let i = 0;
  return {
    completeClassify: async () => {
      const r = replies[Math.min(i, replies.length - 1)];
      i++;
      if (r instanceof Error) throw r;
      return r;
    },
  } as unknown as LlmClient;
}

// ---------------------------------------------------------------------------
// Pure helpers (unchanged from single-domain — still reusable/tested)
// ---------------------------------------------------------------------------

describe("matchDomain", () => {
  it("matches exact and case-insensitive", () => {
    expect(matchDomain("Work", DOMAINS)).toBe("Work");
    expect(matchDomain("work", DOMAINS)).toBe("Work");
    expect(matchDomain("BOATING", DOMAINS)).toBe("Boating");
  });
  it("strips decorations (quotes, label, punctuation, emphasis)", () => {
    expect(matchDomain('"Ventures"', DOMAINS)).toBe("Ventures");
    expect(matchDomain("Domain: Work", DOMAINS)).toBe("Work");
    expect(matchDomain("**Boating**.", DOMAINS)).toBe("Boating");
  });
  it("returns null on no match", () => {
    expect(matchDomain("Finances", DOMAINS)).toBeNull();
    expect(matchDomain("", DOMAINS)).toBeNull();
  });
});

describe("parseConfigDomains", () => {
  it("returns clean list from valid config", () => {
    const parsed = parseConfigDomains({ domains: DOMAINS });
    expect(parsed).toHaveLength(4);
    expect(parsed![0].name).toBe("Work");
  });
  it("passes the compartment flag through (true only)", () => {
    const parsed = parseConfigDomains({
      domains: [
        { name: "Work", description: "job", compartment: true },
        { name: "Ventures", description: "biz", compartment: "yes" },
        { name: "Boating", description: "boats" },
      ],
    });
    expect(parsed![0].compartment).toBe(true);
    expect(parsed![1].compartment).toBeUndefined(); // non-boolean dropped
    expect(parsed![2].compartment).toBeUndefined();
  });
  it("returns null when absent, empty, or malformed", () => {
    expect(parseConfigDomains(null)).toBeNull();
    expect(parseConfigDomains({})).toBeNull();
    expect(parseConfigDomains({ domains: [] })).toBeNull();
    expect(parseConfigDomains({ domains: "nope" })).toBeNull();
    expect(parseConfigDomains({ domains: [{ description: "no name" }] })).toBeNull();
  });
});

describe("domainSetHash", () => {
  it("is stable regardless of order and case", () => {
    const a = domainSetHash([{ name: "Work", description: "" }, { name: "Boating", description: "" }]);
    const b = domainSetHash([{ name: "boating", description: "diff" }, { name: "WORK", description: "" }]);
    expect(a).toBe(b);
  });
  it("changes when a domain is added/removed", () => {
    const a = domainSetHash(DOMAINS);
    const b = domainSetHash(DOMAINS.slice(0, 3));
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// buildClassifyPrompt — now includes the project hint
// ---------------------------------------------------------------------------

describe("buildClassifyPrompt", () => {
  it("lists names + descriptions and truncates long content", () => {
    const long = "x".repeat(CLASSIFY_CONTENT_MAX_CHARS + 500);
    const prompt = buildClassifyPrompt(long, "nano", DOMAINS);
    expect(prompt).toContain("Work: Employer");
    expect(prompt).toContain("…");
    expect(prompt.length).toBeLessThan(long.length + 500);
  });
  it("instructs an EMPTY tags array on no-fit — never a fallback category", () => {
    const prompt = buildClassifyPrompt("x", "p", DOMAINS);
    expect(prompt).toContain('reply {"tags": []}');
    expect(prompt).not.toContain("Unsorted");
  });
  it("includes the source project as a HINT when present", () => {
    const prompt = buildClassifyPrompt("Set up bedrock server", "raider", DOMAINS);
    expect(prompt).toContain("Source project: raider");
    expect(prompt.toLowerCase()).toContain("content wins");
  });
  it("omits the project hint when project is null/empty", () => {
    expect(buildClassifyPrompt("x", null, DOMAINS)).not.toContain("Source project");
    expect(buildClassifyPrompt("x", "   ", DOMAINS)).not.toContain("Source project");
  });
  it("asks for a tags-only JSON object — NO primary requested from the LLM", () => {
    const prompt = buildClassifyPrompt("x", "p", DOMAINS);
    expect(prompt).toContain('"tags"');
    expect(prompt).not.toContain('"primary"');
    expect(prompt).toContain("most relevant first");
  });
  it("carries the generic multi-tag emphasis without hardcoded examples", () => {
    const prompt = buildClassifyPrompt("x", "p", DOMAINS);
    expect(prompt).toContain("BOTH the venture/project domain AND the life topic");
    // Concrete pairings must come from the config descriptions, never the prompt.
    expect(prompt).not.toContain("nano");
    expect(prompt).not.toContain("Aironic");
  });
});

// ---------------------------------------------------------------------------
// parseTagReply — JSON parsing + validation
// ---------------------------------------------------------------------------

describe("parseTagReply", () => {
  it("parses a clean tags-only JSON object, preserving LLM order", () => {
    const r = parseTagReply('{"tags":["Hardware","Ventures"]}', DOMAINS);
    expect(r).toEqual({ tags: ["Hardware", "Ventures"] });
  });
  it("tolerates code fences and surrounding prose", () => {
    const raw = 'Here you go:\n```json\n{"tags":["Work"]}\n```';
    expect(parseTagReply(raw, DOMAINS)).toEqual({ tags: ["Work"] });
  });
  it("matches names case-insensitively and dedupes keeping first occurrence", () => {
    const r = parseTagReply('{"tags":["VENTURES","ventures","hardware"]}', DOMAINS);
    expect(r).toEqual({ tags: ["Ventures", "Hardware"] });
  });
  it("drops invalid names but keeps valid ones", () => {
    const r = parseTagReply('{"tags":["Work","Nonsense"]}', DOMAINS);
    expect(r).toEqual({ tags: ["Work"] });
  });
  it("ACCEPTS the legacy {primary, tags} shape but derives NOTHING from primary", () => {
    // Legacy shape parses; primary is ignored even when valid and absent from tags.
    const r = parseTagReply('{"primary":"Boating","tags":["Work","Ventures"]}', DOMAINS);
    expect(r).toEqual({ tags: ["Work", "Ventures"] });
    expect(r!.tags).not.toContain("Boating");
  });
  it("legacy primary alone (missing tags array) does NOT rescue the reply", () => {
    expect(parseTagReply('{"primary":"Work"}', DOMAINS)).toBeNull();
  });
  it("returns the distinct no-fit result {tags: []} on an EXPLICIT empty array", () => {
    expect(parseTagReply('{"tags":[]}', DOMAINS)).toEqual({ tags: [] });
    // Legacy shape with an explicit empty array is still an explicit no-fit
    // (primary derives NOTHING).
    expect(parseTagReply('{"primary":"Work","tags":[]}', DOMAINS)).toEqual({ tags: [] });
    // Fenced/prose-wrapped empty arrays parse too.
    expect(parseTagReply('```json\n{"tags": []}\n```', DOMAINS)).toEqual({ tags: [] });
  });
  it("returns null (NOT no-fit) on unparseable / missing tags / all-invalid names", () => {
    expect(parseTagReply("not json at all", DOMAINS)).toBeNull();
    expect(parseTagReply('{"tags":["AlsoNonsense"]}', DOMAINS)).toBeNull();
    expect(parseTagReply('{"tags":"Work"}', DOMAINS)).toBeNull(); // non-array
    expect(parseTagReply("{}", DOMAINS)).toBeNull(); // missing tags key
    expect(parseTagReply("", DOMAINS)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// classifyMemoryTags
// ---------------------------------------------------------------------------

describe("classifyMemoryTags", () => {
  it("returns the ordered tag set — no primary field", async () => {
    const llm = mockLlm(['{"tags":["Hardware","Ventures"]}']);
    const r = await classifyMemoryTags("Set up bedrock for the agent fleet", "raider", DOMAINS, llm);
    expect(r).not.toBeNull();
    expect(r!.tags).toEqual(["Hardware", "Ventures"]); // LLM order preserved
    expect(r).not.toHaveProperty("primary");
  });

  it("tolerates a legacy {primary, tags} reply — tags kept, primary ignored", async () => {
    const llm = mockLlm(['{"primary":"Ventures","tags":["Hardware","Ventures"]}']);
    const r = await classifyMemoryTags("Set up bedrock for the agent fleet", "raider", DOMAINS, llm);
    expect(r).toEqual({ tags: ["Hardware", "Ventures"] });
  });

  it("passes the project hint into the prompt", async () => {
    let seenPrompt = "";
    const llm = {
      completeClassify: async (prompt: string) => {
        seenPrompt = prompt;
        return '{"tags":["Work"]}';
      },
    } as unknown as LlmClient;
    await classifyMemoryTags("Terse technical note", "catalyst", DOMAINS, llm);
    expect(seenPrompt).toContain("Source project: catalyst");
  });

  it("retries once on an invalid/unparseable reply, then succeeds", async () => {
    const llm = mockLlm(["garbage", '{"tags":["Work"]}']);
    const r = await classifyMemoryTags("Quarterly review with manager", "lenny", DOMAINS, llm);
    expect(r).toEqual({ tags: ["Work"] });
  });

  it("returns the no-fit result {tags: []} on an explicit empty reply — no retry", async () => {
    let calls = 0;
    const counting = {
      completeClassify: async () => {
        calls++;
        return '{"tags": []}';
      },
    } as unknown as LlmClient;
    const r = await classifyMemoryTags("Ambiguous note", "misc", DOMAINS, counting);
    expect(r).toEqual({ tags: [] });
    expect(calls).toBe(1); // an explicit no-fit is a VALID reply — not retried
  });

  it("treats two all-invalid replies as a no-fit (empty tags), never a fallback tag", async () => {
    const llm = mockLlm([
      '{"tags":["Nonsense"]}',
      '{"tags":["StillNope"]}',
    ]);
    const r = await classifyMemoryTags("Ambiguous note", "misc", DOMAINS, llm);
    expect(r).toEqual({ tags: [] });
  });

  it("returns NULL (infra error, NOT no-fit) — LLM throws on both attempts", async () => {
    const llm = mockLlm([new Error("ECONNREFUSED"), new Error("ECONNREFUSED")]);
    const r = await classifyMemoryTags("anything", "p", DOMAINS, llm);
    expect(r).toBeNull();
  });

  it("recovers when the LLM throws once then returns a valid reply", async () => {
    const llm = mockLlm([new Error("timeout"), '{"tags":["Work"]}']);
    const r = await classifyMemoryTags("day job task", "lenny", DOMAINS, llm);
    expect(r).toEqual({ tags: ["Work"] });
  });

  it("a configured domain literally named Unsorted is just a normal domain", async () => {
    const withUnsorted: DomainDef[] = [
      { name: "Work", description: "x" },
      { name: "Unsorted", description: "a normal domain, no special semantics" },
    ];
    // The model can tag it like any other vocabulary name…
    const llm = mockLlm(['{"tags":["Unsorted"]}']);
    expect(await classifyMemoryTags("something", "p", withUnsorted, llm)).toEqual({
      tags: ["Unsorted"],
    });
    // …but a no-fit never falls back to it.
    const llm2 = mockLlm(['{"tags":[]}']);
    expect(await classifyMemoryTags("something", "p", withUnsorted, llm2)).toEqual({
      tags: [],
    });
  });
});
