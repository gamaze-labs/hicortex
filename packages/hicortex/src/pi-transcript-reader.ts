/**
 * Pi agent transcript reader.
 *
 * Reads session .jsonl files from ~/.pi/agent/sessions/ in the Pi coding
 * agent's format. Returns the same TranscriptBatch shape as the CC reader
 * (transcript-reader.ts) so the downstream distillation pipeline is
 * format-agnostic.
 *
 * Pi JSONL format (version 3):
 *   session              — session header: {id, cwd, timestamp, version}
 *   model_change         — provider + model switch (skip for distillation)
 *   thinking_level_change — thinking mode (skip)
 *   message              — user/assistant/toolResult conversation entries
 *   custom               — extension events (skip)
 *   custom_message       — extension messages (skip)
 *
 * Directory layout:
 *   ~/.pi/agent/sessions/
 *     --home-alice-projects-myagent--/
 *       2026-04-10T18-37-44-615Z_<uuid>.jsonl
 *       2026-04-11T07-51-28-282Z_<uuid>.jsonl
 *     --home-user-projects-ExampleApp--/
 *       ...
 *
 * The encoded-cwd uses double-dash separators: /home/alice/projects/myagent
 * becomes --home-alice-projects-myagent--. The session header's `cwd` field
 * is the canonical path; the directory name is a filesystem-safe encoding.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import type { TranscriptBatch, CursorMap } from "./transcript-reader.js";

export type { TranscriptBatch, CursorMap };

const DEFAULT_PI_SESSIONS_DIR = join(homedir(), ".pi", "agent", "sessions");

/**
 * Read Pi session transcripts modified after `since`.
 *
 * Scans the Pi sessions directory for .jsonl files, filters by mtime,
 * parses each into a TranscriptBatch.
 *
 * @param since Only return sessions with mtime > this date
 * @param sessionsDir Override the session directory (default: ~/.pi/agent/sessions/)
 * @param cursors Per-session capture cursors (#189); default empty = whole file
 * @param keyPrefix Cursor-key namespace ("pi" here; OC passes "oc:<agentId>")
 */
export function readPiTranscripts(
  since: Date,
  sessionsDir: string = DEFAULT_PI_SESSIONS_DIR,
  cursors: CursorMap = {},
  keyPrefix = "pi",
): TranscriptBatch[] {
  const batches: TranscriptBatch[] = [];

  let projectDirs: string[];
  try {
    projectDirs = readdirSync(sessionsDir);
  } catch {
    // Directory doesn't exist — no Pi sessions. Not an error.
    return [];
  }

  for (const projectDir of projectDirs) {
    const projectPath = join(sessionsDir, projectDir);
    let files: string[];
    try {
      const stat = statSync(projectPath);
      if (!stat.isDirectory()) continue;
      files = readdirSync(projectPath).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }

    for (const file of files) {
      const filePath = join(projectPath, file);

      // Filter by modification time
      try {
        const stat = statSync(filePath);
        if (stat.mtime <= since) continue;
      } catch {
        continue;
      }

      // Parse the JSONL file
      try {
        const raw = readFileSync(filePath, "utf-8");
        const lines = raw.split("\n").filter((l) => l.trim());
        const entries: unknown[] = [];
        const timestamps: string[] = [];
        let sessionId = "";
        let sessionCwd = "";
        let sessionDate = "";

        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            entries.push(entry);
            timestamps.push(typeof entry.timestamp === "string" ? entry.timestamp : "");

            // Extract metadata from the session header
            if (entry.type === "session") {
              sessionId = entry.id ?? "";
              sessionCwd = entry.cwd ?? "";
              // Date from the session timestamp or filename
              sessionDate =
                entry.timestamp?.slice(0, 10) ??
                extractDateFromFilename(file) ??
                "";
            }
          } catch {
            // Skip malformed lines
          }
        }

        // Derive project name from the cwd or directory name
        const projectName = deriveProjectName(sessionCwd, projectDir);

        // Use filename UUID as fallback session ID
        if (!sessionId) {
          sessionId = extractUuidFromFilename(file) ?? file;
        }

        if (!sessionDate) {
          sessionDate = extractDateFromFilename(file) ?? "";
        }

        if (entries.length === 0) continue;

        // Incremental slice (#189): append-only JSONL v3, same discipline as CC.
        const cursorKey = `${keyPrefix}:${sessionId}`;
        const pos = cursors[cursorKey] ?? { cursor: 0, gen: 0 };
        let start = pos.cursor;
        let gen = pos.gen;
        if (start > entries.length) {
          // shrink guard (truncation/rotation) — reset + bump generation (fix 8)
          start = 0;
          gen = pos.gen + 1;
        }
        const delta = entries.slice(start);
        if (delta.length === 0) continue; // cursor already covers the file

        const entryCursors = delta.map((_, i) => start + i + 1);

        // Prefer the last timestamped entry in the delta for per-night dating.
        let deltaDate = "";
        for (let i = start; i < entries.length; i++) {
          if (timestamps[i]) deltaDate = timestamps[i].slice(0, 10);
        }

        batches.push({
          sessionId,
          projectName,
          date: deltaDate || sessionDate || new Date().toISOString().slice(0, 10),
          entries: delta,
          cursorKey,
          startCursor: start,
          generation: gen,
          entryCursors,
        });
      } catch {
        // File read or parse failed — skip
      }
    }
  }

  return batches;
}

/**
 * Extract the last path segment from a cwd as the project name.
 * /home/alice/projects/myagent → "myagent"
 * Falls back to decoding the directory name if cwd is empty.
 */
function deriveProjectName(cwd: string, encodedDir: string): string {
  if (cwd) {
    const segments = cwd.split("/").filter(Boolean);
    return segments[segments.length - 1] ?? "unknown";
  }

  // Decode the Pi directory encoding: --home-alice-projects-myagent-- → myagent
  const decoded = encodedDir.replace(/^--/, "").replace(/--$/, "").split("-");
  return decoded[decoded.length - 1] ?? "unknown";
}

/**
 * Extract the date (YYYY-MM-DD) from a Pi session filename.
 * Format: 2026-04-10T18-37-44-615Z_<uuid>.jsonl → "2026-04-10"
 */
function extractDateFromFilename(filename: string): string | null {
  const match = filename.match(/^(\d{4}-\d{2}-\d{2})T/);
  return match ? match[1] : null;
}

/**
 * Extract the UUID from a Pi session filename.
 * Format: 2026-04-10T18-37-44-615Z_f4227d47-e54f-4977-a50c-4de7f6d1fa21.jsonl
 */
function extractUuidFromFilename(filename: string): string | null {
  const match = filename.match(
    /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/,
  );
  return match ? match[1] : null;
}
