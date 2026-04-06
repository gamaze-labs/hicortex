/**
 * CC transcript reader — reads Claude Code .jsonl session files.
 *
 * CC stores transcripts at ~/.claude/projects/<project-hash>/<session-uuid>.jsonl.
 * Each line is a JSON object with type, message, timestamp, etc.
 *
 * The reader scans for new sessions since the last nightly run
 * and feeds them to the existing distiller pipeline.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

export interface TranscriptBatch {
  sessionId: string;
  projectName: string;
  date: string; // ISO date of last entry
  entries: unknown[]; // Raw JSONL entries — fed to extractConversationText()
}

const CC_PROJECTS_DIR = join(homedir(), ".claude", "projects");

/**
 * Read all CC transcripts modified since `since`.
 * Returns one batch per session file.
 */
export function readCcTranscripts(
  since: Date,
  projectsDir = CC_PROJECTS_DIR
): TranscriptBatch[] {
  const batches: TranscriptBatch[] = [];

  let projectDirs: string[];
  try {
    projectDirs = readdirSync(projectsDir);
  } catch {
    return []; // No CC projects directory
  }

  for (const projectDir of projectDirs) {
    const projectPath = join(projectsDir, projectDir);

    let stat;
    try {
      stat = statSync(projectPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    const projectName = decodeProjectDirName(projectDir);

    let files: string[];
    try {
      files = readdirSync(projectPath);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;

      const filePath = join(projectPath, file);
      let fileStat;
      try {
        fileStat = statSync(filePath);
      } catch {
        continue;
      }

      // Skip files not modified since last run
      if (fileStat.mtime <= since) continue;

      const batch = parseTranscriptFile(filePath, projectName);
      if (batch) {
        batches.push(batch);
      }
    }
  }

  return batches;
}

/**
 * Parse a single .jsonl transcript file into a batch.
 * Returns null if the file has too few meaningful entries.
 */
function parseTranscriptFile(
  filePath: string,
  projectName: string
): TranscriptBatch | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  const lines = raw.split("\n").filter((l) => l.trim());
  if (lines.length < 4) return null; // Too short to be meaningful

  const entries: unknown[] = [];
  let lastTimestamp = "";

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      entries.push(entry);
      if (entry.timestamp) {
        lastTimestamp = entry.timestamp;
      }
    } catch {
      // Skip malformed lines
    }
  }

  if (entries.length < 4) return null;

  // Extract session ID from filename (UUID.jsonl)
  const sessionId = basename(filePath, ".jsonl");

  return {
    sessionId,
    projectName,
    date: lastTimestamp
      ? lastTimestamp.slice(0, 10)
      : new Date().toISOString().slice(0, 10),
    entries,
  };
}

/**
 * Decode CC project directory name to a human-readable project name.
 * CC uses path-based hashing: "-Users-mattias-Development-Tools-hicortex"
 * becomes "hicortex" (last path component).
 */
function decodeProjectDirName(dirName: string): string {
  // CC encodes paths by replacing / with -
  // e.g. "-Users-mattias-Development-Tools-hicortex"
  const parts = dirName.split("-").filter(Boolean);
  if (parts.length === 0) return dirName;

  // Use the last meaningful path component as project name
  return parts[parts.length - 1];
}
