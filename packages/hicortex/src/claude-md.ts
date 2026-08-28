/**
 * CLAUDE.md block management — removeLessonsBlock only (0.9.0+).
 *
 * Lesson injection was removed in 0.9.0: lessons are now fetched at query time
 * via the CC SessionStart hook (`hicortex learnings-identity`, aliased as the
 * legacy `lessons-context`) and by the Hermes
 * plugin's prefetch/system_prompt_block. File-based injection caused EPERM
 * errors on macOS, stale blocks, and unwinnable multi-file bookkeeping.
 *
 * removeLessonsBlock is kept so init/uninstall can strip the old static block
 * from machines upgrading from 0.8.0 and earlier.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const START_MARKER = "<!-- HICORTEX-LEARNINGS:START -->";
const END_MARKER = "<!-- HICORTEX-LEARNINGS:END -->";

const DEFAULT_CLAUDE_MD = join(homedir(), ".claude", "CLAUDE.md");

/**
 * Remove the Hicortex Learnings block from CLAUDE.md.
 * Used by init (migration from 0.8.0) and uninstall.
 * Returns true if a block was found and removed.
 */
export function removeLessonsBlock(claudeMdPath = DEFAULT_CLAUDE_MD): boolean {
  let content: string;
  try {
    content = readFileSync(claudeMdPath, "utf-8");
  } catch {
    return false;
  }

  const startIdx = content.indexOf(START_MARKER);
  const endIdx = content.indexOf(END_MARKER);

  if (startIdx === -1 || endIdx === -1) return false;

  let newContent =
    content.slice(0, startIdx) +
    content.slice(endIdx + END_MARKER.length);

  newContent = newContent.replace(/\n{3,}/g, "\n\n").trim();
  if (newContent.length > 0) newContent += "\n";

  writeFileSync(claudeMdPath, newContent);
  return true;
}
