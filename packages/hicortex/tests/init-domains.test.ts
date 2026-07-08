/**
 * Tests for the generic default-domain scaffold (issue #150) and the shipped
 * domains.example.json.
 *
 *   - Server-mode init scaffolds the 5 generic defaults (Work, Personal,
 *     People, Health, Finance) when config.json has NO `domains` key.
 *   - Non-clobber: an existing `domains` key — even an empty array — is
 *     user-owned and never touched (same philosophy as persistAuthToken).
 *   - The printed hint tells the user where the scaffold lives and that the
 *     list is editable (life areas OR project/topic areas).
 *   - domains.example.json is valid JSON, its `domains` list parses via
 *     parseConfigDomains, and the power-user example carries a compartment
 *     flag on Work plus a valid custom weakPrimaryFloor.
 */

import { describe, it, expect, afterEach, beforeAll, afterAll, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { scaffoldDefaultDomains, GENERIC_DEFAULT_DOMAINS } from "../src/init.js";
import { parseConfigDomains } from "../src/domain-classify.js";
import { resolveWeakPrimaryFloor, DEFAULT_WEAK_PRIMARY_FLOOR } from "../src/nofit.js";

const TEST_DIR = join(tmpdir(), `hicortex-init-domains-${randomUUID().slice(0, 8)}`);
const EXAMPLE_PATH = join(__dirname, "..", "domains.example.json");

const DEFAULT_NAMES = ["Work", "Personal", "People", "Health", "Finance"];

function tempConfigPath(label: string): string {
  const dir = join(TEST_DIR, `${label}-${randomUUID().slice(0, 6)}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, "config.json");
}

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GENERIC_DEFAULT_DOMAINS (#150)", () => {
  it("is exactly the 5 generic spheres, in order", () => {
    expect(GENERIC_DEFAULT_DOMAINS.map((d) => d.name)).toEqual(DEFAULT_NAMES);
  });

  it("every default has a non-empty description and no compartment flag", () => {
    for (const d of GENERIC_DEFAULT_DOMAINS) {
      expect(d.description.length).toBeGreaterThan(0);
      expect(d.compartment).toBeUndefined();
    }
  });

  it("contains no fallback category (Unsorted is a non-tag)", () => {
    const names = GENERIC_DEFAULT_DOMAINS.map((d) => d.name.toLowerCase());
    expect(names).not.toContain("unsorted");
  });

  it("is a valid vocabulary for parseConfigDomains", () => {
    const parsed = parseConfigDomains({ domains: GENERIC_DEFAULT_DOMAINS });
    expect(parsed).not.toBeNull();
    expect(parsed!.map((d) => d.name)).toEqual(DEFAULT_NAMES);
  });
});

describe("scaffoldDefaultDomains (#150)", () => {
  it("writes the 5 defaults when config.json does not exist", () => {
    const configPath = tempConfigPath("fresh");
    const result = scaffoldDefaultDomains(configPath);
    expect(result.scaffolded).toBe(true);
    const stored = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(stored.domains).toEqual(GENERIC_DEFAULT_DOMAINS);
  });

  it("writes the 5 defaults when config exists but has no domains key", () => {
    const configPath = tempConfigPath("upgrade");
    writeFileSync(configPath, JSON.stringify({ authToken: "hctx-aabbccdd00112233aabbccdd00112233" }));
    const result = scaffoldDefaultDomains(configPath);
    expect(result.scaffolded).toBe(true);
    const stored = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(stored.domains.map((d: { name: string }) => d.name)).toEqual(DEFAULT_NAMES);
  });

  it("preserves all existing config keys when scaffolding", () => {
    const configPath = tempConfigPath("preserve");
    writeFileSync(
      configPath,
      JSON.stringify({ llmBackend: "ollama", llmModel: "qwen3:4b", authToken: "hctx-00112233445566770011223344556677" }),
    );
    scaffoldDefaultDomains(configPath);
    const stored = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(stored.llmBackend).toBe("ollama");
    expect(stored.llmModel).toBe("qwen3:4b");
    expect(stored.authToken).toBe("hctx-00112233445566770011223344556677");
    expect(stored.domains).toHaveLength(5);
  });

  it("never overwrites an existing domains list", () => {
    const configPath = tempConfigPath("existing");
    const userDomains = [
      { name: "Boating", description: "Boats and harbour life" },
      { name: "Property", description: "House and land" },
    ];
    writeFileSync(configPath, JSON.stringify({ domains: userDomains }));
    const result = scaffoldDefaultDomains(configPath);
    expect(result.scaffolded).toBe(false);
    const stored = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(stored.domains).toEqual(userDomains);
  });

  it("treats even an empty domains array as user-owned (non-clobber)", () => {
    const configPath = tempConfigPath("empty");
    writeFileSync(configPath, JSON.stringify({ domains: [] }));
    const result = scaffoldDefaultDomains(configPath);
    expect(result.scaffolded).toBe(false);
    const stored = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(stored.domains).toEqual([]);
  });

  it("prints the editable-starting-point hint on scaffold", () => {
    const configPath = tempConfigPath("hint");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    scaffoldDefaultDomains(configPath);
    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("Memory domains scaffolded");
    expect(output).toContain(configPath);
    expect(output).toContain("Work, Personal, People, Health, Finance");
    expect(output).toContain("match how YOU think");
    expect(output).toContain("life areas OR project/topic areas");
  });

  it("prints a leave-as-is line when domains already exist", () => {
    const configPath = tempConfigPath("hint-existing");
    writeFileSync(configPath, JSON.stringify({ domains: [{ name: "Work", description: "job" }] }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    scaffoldDefaultDomains(configPath);
    const output = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(output).toContain("already configured");
    expect(output).not.toContain("scaffolded");
  });

  it("is idempotent: a second run leaves the scaffold unchanged", () => {
    const configPath = tempConfigPath("idempotent");
    expect(scaffoldDefaultDomains(configPath).scaffolded).toBe(true);
    const first = readFileSync(configPath, "utf-8");
    expect(scaffoldDefaultDomains(configPath).scaffolded).toBe(false);
    expect(readFileSync(configPath, "utf-8")).toBe(first);
  });
});

describe("domains.example.json (shipped example, #150)", () => {
  it("is valid JSON", () => {
    expect(() => JSON.parse(readFileSync(EXAMPLE_PATH, "utf-8"))).not.toThrow();
  });

  it("its domains list matches the init scaffold and parses via parseConfigDomains", () => {
    const example = JSON.parse(readFileSync(EXAMPLE_PATH, "utf-8"));
    const parsed = parseConfigDomains(example);
    expect(parsed).not.toBeNull();
    expect(parsed!.map((d) => d.name)).toEqual(DEFAULT_NAMES);
    expect(parsed).toEqual(GENERIC_DEFAULT_DOMAINS);
  });

  it("the power-user example parses, flags only Work as compartment, and sets a valid weakPrimaryFloor", () => {
    const example = JSON.parse(readFileSync(EXAMPLE_PATH, "utf-8"));
    const power = example._powerUserExample;
    expect(power).toBeDefined();

    const parsed = parseConfigDomains(power);
    expect(parsed).not.toBeNull();
    expect(parsed!.length).toBeGreaterThan(5);
    const compartments = parsed!.filter((d) => d.compartment === true).map((d) => d.name);
    expect(compartments).toEqual(["Work"]);

    // The custom floor is valid (resolves to itself, not the default).
    const floor = resolveWeakPrimaryFloor(power);
    expect(floor).toBe(power.weakPrimaryFloor);
    expect(floor).not.toBe(DEFAULT_WEAK_PRIMARY_FLOOR);
    expect(floor).toBeGreaterThan(0);
    expect(floor).toBeLessThan(1);
  });

  it("neither example set contains a fallback category", () => {
    const example = JSON.parse(readFileSync(EXAMPLE_PATH, "utf-8"));
    const allNames = [
      ...example.domains.map((d: { name: string }) => d.name.toLowerCase()),
      ...example._powerUserExample.domains.map((d: { name: string }) => d.name.toLowerCase()),
    ];
    expect(allNames).not.toContain("unsorted");
  });
});
