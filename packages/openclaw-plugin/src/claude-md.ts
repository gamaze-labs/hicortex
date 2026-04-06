/**
 * CLAUDE.md lesson injection — manages the Hicortex Learnings block.
 *
 * Injects a dynamic, nightly-updated block into ~/.claude/CLAUDE.md:
 * - Top lessons (from reflection, high-confidence)
 * - Memory index (projects + counts, primes the agent to search)
 * - Current project context (recent decisions for this project)
 *
 * Idempotent: calling twice with the same data produces the same file.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type Database from "better-sqlite3";
import * as storage from "./storage.js";
import { lessonsLimit } from "./features.js";

const START_MARKER = "<!-- HICORTEX-LEARNINGS:START -->";
const END_MARKER = "<!-- HICORTEX-LEARNINGS:END -->";

const DEFAULT_CLAUDE_MD = join(homedir(), ".claude", "CLAUDE.md");

/**
 * Inject lessons, memory index, and project context into CLAUDE.md.
 * Creates the file if it doesn't exist.
 * Replaces existing block if present, appends if not.
 */
export function injectLessons(
  db: Database.Database,
  options: {
    claudeMdPath?: string;
    stateDir?: string;
    project?: string;
  } = {}
): { lessonsCount: number; path: string } {
  const claudeMdPath = options.claudeMdPath ?? DEFAULT_CLAUDE_MD;

  // Determine limits based on license
  const maxLessons = lessonsLimit();

  // --- Lessons ---
  const lessons = storage.getLessons(db, 30, options.project);
  const selected = lessons.slice(0, maxLessons);

  const lessonLines = selected.map((l) => {
    const titleMatch = l.content.match(/## Lesson: (.+)/);
    const typeMatch = l.content.match(/\*\*Type:\*\* (\w+)/);
    const severityMatch = l.content.match(/\*\*Severity:\*\* (\w+)/);
    const title = titleMatch ? titleMatch[1] : l.content.slice(0, 150);
    const meta = [severityMatch?.[1], typeMatch?.[1]].filter(Boolean).join(", ");
    return `- ${title}${meta ? ` (${meta})` : ""}`;
  });

  // --- Memory Index ---
  const projectIndex = buildProjectIndex(db);
  const totalCount = storage.countMemories(db);
  const lessonCount = lessons.length;
  const sourceCount = countSources(db);

  // --- Current Project Context ---
  const currentProject = detectCurrentProject(claudeMdPath);
  const projectContext = currentProject
    ? buildProjectContext(db, currentProject)
    : [];

  // --- Build Block ---
  const blockParts = [START_MARKER, "## Hicortex Memory"];

  // Mandatory instruction
  blockParts.push(
    "",
    "You have access to shared long-term memory across all agents and sessions.",
    "BEFORE making decisions, search memory: `hicortex_search` for prior decisions on the same topic.",
    "Use `hicortex_context` at session start for recent project state."
  );

  // Lessons
  if (lessonLines.length > 0) {
    blockParts.push("", "### Lessons (updated nightly)");
    blockParts.push(...lessonLines);
  }

  // Project context
  if (projectContext.length > 0) {
    blockParts.push("", `### This Project (${currentProject})`);
    blockParts.push(...projectContext);
  }

  // Memory index
  if (projectIndex.length > 0) {
    blockParts.push("", "### Memory Index");
    blockParts.push(projectIndex.join(" | "));
    blockParts.push(
      `${totalCount} memories, ${lessonCount} lessons, ${sourceCount} agents. Search with \`hicortex_search\`.`
    );
  }

  blockParts.push(END_MARKER);
  const block = blockParts.join("\n");

  // --- Write ---
  let content = "";
  try {
    content = readFileSync(claudeMdPath, "utf-8");
  } catch {
    // File doesn't exist — will create it
  }

  const startIdx = content.indexOf(START_MARKER);
  const endIdx = content.indexOf(END_MARKER);

  if (startIdx !== -1 && endIdx !== -1) {
    content =
      content.slice(0, startIdx) +
      block +
      content.slice(endIdx + END_MARKER.length);
  } else {
    if (content.length > 0 && !content.endsWith("\n")) content += "\n";
    if (content.length > 0) content += "\n";
    content += block + "\n";
  }

  mkdirSync(dirname(claudeMdPath), { recursive: true });
  writeFileSync(claudeMdPath, content);

  return { lessonsCount: selected.length, path: claudeMdPath };
}

/**
 * Build compact project index: "hicortex: 18 | boat: 24 | health: 45"
 */
function buildProjectIndex(db: Database.Database): string[] {
  try {
    const rows = db
      .prepare(
        `SELECT project, COUNT(*) as cnt FROM memories
         WHERE project IS NOT NULL
         GROUP BY project ORDER BY cnt DESC LIMIT 10`
      )
      .all() as Array<{ project: string; cnt: number }>;
    return rows.map((r) => `${r.project}: ${r.cnt}`);
  } catch {
    return [];
  }
}

/**
 * Count distinct source agents.
 */
function countSources(db: Database.Database): number {
  try {
    return (
      db
        .prepare("SELECT COUNT(DISTINCT source_agent) as cnt FROM memories")
        .get() as { cnt: number }
    ).cnt;
  } catch {
    return 0;
  }
}

/**
 * Detect current project from the CLAUDE.md path.
 * CC puts project-specific CLAUDE.md files in ~/.claude/projects/<encoded-path>/
 * The global ~/.claude/CLAUDE.md has no project context.
 */
function detectCurrentProject(claudeMdPath: string): string | null {
  // Global CLAUDE.md — no project
  if (claudeMdPath === DEFAULT_CLAUDE_MD) return null;

  // Project CLAUDE.md: ~/.claude/projects/-Users-foo-myproject/CLAUDE.md
  // Extract the last segment of the encoded path
  const match = claudeMdPath.match(/projects\/[^/]*-([^/]+)\//);
  if (match) return match[1];

  return null;
}

/**
 * Build recent decisions/facts for a specific project.
 * Returns formatted lines like: "- Shipped v0.4.1 with multi-client (2026-03-28)"
 */
function buildProjectContext(
  db: Database.Database,
  project: string
): string[] {
  try {
    const rows = db
      .prepare(
        `SELECT content, created_at FROM memories
         WHERE project = ? AND memory_type IN ('decision', 'episode')
         ORDER BY created_at DESC LIMIT 5`
      )
      .all(project) as Array<{ content: string; created_at: string }>;

    return rows.map((r) => {
      const date = r.created_at?.slice(0, 10) ?? "";
      // Extract first meaningful line from content
      const lines = r.content.split("\n").filter((l) => l.trim().length > 10);
      const summary =
        lines.find((l) => l.startsWith("- ") || l.startsWith("### "))?.replace(/^[-#\s]+/, "").slice(0, 120) ??
        r.content.slice(0, 120);
      return `- ${summary} (${date})`;
    });
  } catch {
    return [];
  }
}

/**
 * Remove the Hicortex Learnings block from CLAUDE.md.
 * Used by the uninstall command.
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
