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
 *     --home-agents-Agents-raider--/
 *       2026-04-10T18-37-44-615Z_<uuid>.jsonl
 *       2026-04-11T07-51-28-282Z_<uuid>.jsonl
 *     --home-agents-Development-MAIC--/
 *       ...
 *
 * The encoded-cwd uses double-dash separators: /home/agents/Agents/raider
 * becomes --home-agents-Agents-raider--. The session header's `cwd` field
 * is the canonical path; the directory name is a filesystem-safe encoding.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

export interface TranscriptBatch {
  sessionId: string;
  projectName: string;
  date: string;
  entries: unknown[];
}

const DEFAULT_PI_SESSIONS_DIR = join(homedir(), ".pi", "agent", "sessions");

/**
 * Read Pi session transcripts modified after `since`.
 *
 * Scans the Pi sessions directory for .jsonl files, filters by mtime,
 * parses each into a TranscriptBatch.
 *
 * @param since Only return sessions with mtime > this date
 * @param sessionsDir Override the session directory (default: ~/.pi/agent/sessions/)
 */
export function readPiTranscripts(
  since: Date,
  sessionsDir: string = DEFAULT_PI_SESSIONS_DIR,
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
        let sessionId = "";
        let sessionCwd = "";
        let sessionDate = "";

        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            entries.push(entry);

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

        if (entries.length > 0) {
          batches.push({
            sessionId,
            projectName,
            date: sessionDate,
            entries,
          });
        }
      } catch {
        // File read or parse failed — skip
      }
    }
  }

  return batches;
}

/**
 * Extract the last path segment from a cwd as the project name.
 * /home/agents/Agents/raider → "raider"
 * Falls back to decoding the directory name if cwd is empty.
 */
function deriveProjectName(cwd: string, encodedDir: string): string {
  if (cwd) {
    const segments = cwd.split("/").filter(Boolean);
    return segments[segments.length - 1] ?? "unknown";
  }

  // Decode the Pi directory encoding: --home-agents-Agents-raider-- → raider
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
