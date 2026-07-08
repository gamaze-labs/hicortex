/**
 * lessons-context — query-time lessons fetch for the CC SessionStart hook.
 *
 * Replaces file-based injection (injectLessons / injectLessonsFromServer).
 * Reads ~/.hicortex/config.json to find the server URL, GETs /lessons,
 * and prints a compact Markdown block to stdout so CC picks it up as
 * session context.
 *
 * Fail-soft by design: ANY failure (missing config, network error, non-2xx,
 * parse error) results in silent exit-0. A broken hook must never block a
 * CC session.
 */

import { readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { lessonsLimit } from "./features.js";
import { getLessonSelector } from "./extensions.js";
import { loadState } from "./state.js";
import type { ModuleIndex } from "./types.js";

const HICORTEX_HOME = join(homedir(), ".hicortex");
const DEFAULT_PORT = 8787;

interface LessonsResponse {
  lessons: Array<{ content: string; created_at: string; base_strength: number; access_count: number }>;
  index: { total: number; lessonCount: number; sourceCount: number; projects: Array<{ name: string; count: number }> };
  moduleIndex?: ModuleIndex;
}

/**
 * Fetch lessons from the configured server and return a formatted Markdown
 * block, or null on any failure (caller should print nothing and exit 0).
 */
export async function fetchLessonsContext(): Promise<string | null> {
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(readFileSync(join(HICORTEX_HOME, "config.json"), "utf-8"));
  } catch {
    // No config file — server not set up yet. Fail soft.
    return null;
  }

  // Determine server URL: client mode uses serverUrl; server mode uses localhost.
  const serverUrl = config.mode === "client" && typeof config.serverUrl === "string"
    ? (config.serverUrl as string).replace(/\/+$/, "")
    : `http://127.0.0.1:${(config.port as number | undefined) ?? DEFAULT_PORT}`;

  const authToken = config.authToken as string | undefined;

  let data: LessonsResponse;
  try {
    const resp = await fetch(`${serverUrl}/lessons`, {
      headers: authToken ? { "Authorization": `Bearer ${authToken}` } : {},
      signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok) return null;
    data = await resp.json() as LessonsResponse;
  } catch {
    return null;
  }

  const maxLessons = lessonsLimit();
  const moduleIndex = data.moduleIndex ?? loadState(HICORTEX_HOME).moduleIndex;
  // The SessionStart hook runs in the session's working directory, whose last
  // path component matches the capture-side CC project name convention
  // (transcript-reader's decodeProjectDirName also takes the last component).
  // This enables in-project + same-domain lesson boosting on the CC path.
  const project = basename(process.cwd()) || null;
  const selected = await getLessonSelector().select(data.lessons, { maxLessons, moduleIndex, project });

  const lessonLines = selected.map((l) => {
    const titleMatch = l.content.match(/## Lesson: (.+)/);
    const typeMatch = l.content.match(/\*\*Type:\*\* (\w+)/);
    const severityMatch = l.content.match(/\*\*Severity:\*\* (\w+)/);
    const title = titleMatch ? titleMatch[1] : l.content.slice(0, 150);
    const meta = [severityMatch?.[1], typeMatch?.[1]].filter(Boolean).join(", ");
    return `- ${title}${meta ? ` (${meta})` : ""}`;
  });

  const parts: string[] = ["## Hicortex Memory", ""];
  parts.push("You have access to shared long-term memory across all agents and sessions.");
  parts.push("BEFORE making decisions, search memory: `hicortex_search` for prior decisions on the same topic.");
  parts.push("Use `hicortex_context` at session start for recent project state.");

  if (lessonLines.length > 0) {
    parts.push("", "### Lessons (updated nightly)");
    parts.push(...lessonLines);
  }

  // Memory index
  const { index } = data;
  if (moduleIndex && moduleIndex.domains.length > 0) {
    parts.push("", "### Memory Index");
    for (const domain of moduleIndex.domains) {
      const kwStr = domain.keywords.length > 0 ? `: ${domain.keywords.join(", ")}` : "";
      parts.push(`${domain.name} (${domain.memoryCount} memories, ${domain.lessonCount} lessons)${kwStr}`);
      if (domain.projects.length > 0) parts.push(`  ${domain.projects.join(" | ")}`);
    }
    parts.push(`${index.total} memories, ${index.lessonCount} lessons, ${index.sourceCount} agents. Search with \`hicortex_search\`.`);
  } else if (index.projects.length > 0) {
    parts.push("", "### Memory Index");
    parts.push(index.projects.map(p => `${p.name}: ${p.count}`).join(" | "));
    parts.push(`${index.total} memories, ${index.lessonCount} lessons, ${index.sourceCount} agents. Search with \`hicortex_search\`.`);
  }

  return parts.join("\n");
}
