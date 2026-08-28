/**
 * Canonical Hicortex home resolution — the single source of truth (#174).
 *
 * Honors the HICORTEX_HOME env override (a headless/test seam, mirroring the
 * HICORTEX_DB_PATH convention in db.ts); otherwise defaults to ~/.hicortex.
 * Every module that needs the home dir routes through here, so the override
 * behaves consistently across all commands instead of being honored by some
 * (identity-cli, learnings-identity) and hardcoded away by others.
 */
import { homedir } from "node:os";
import { join } from "node:path";

export function hicortexHome(): string {
  return process.env.HICORTEX_HOME ?? join(homedir(), ".hicortex");
}
