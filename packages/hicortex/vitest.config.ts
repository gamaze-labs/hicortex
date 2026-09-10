import { defineConfig } from "vitest/config";

// The only configuration is the suite-wide HICORTEX_HOME pin — see
// tests/setup-home.ts (#355 CR finding 2). Everything else stays vitest
// defaults, exactly as the bare `vitest run` in the AGENTS.md chain ran.
export default defineConfig({
  test: {
    setupFiles: ["tests/setup-home.ts"],
  },
});
