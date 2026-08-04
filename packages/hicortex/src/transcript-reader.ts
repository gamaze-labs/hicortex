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
import type { CursorMap } from "./capture-cursors.js";

export type { CursorMap };

export interface TranscriptBatch {
  sessionId: string;
  projectName: string;
  date: string; // ISO date of last entry IN THE DELTA
  entries: unknown[]; // Raw JSONL entries (the delta) — fed to extractConversationText()
  /**
   * Optional source-agent label (e.g. "hermes/alice"). When set, the nightly
   * pipeline uses it verbatim for provenance instead of the default
   * `claude-code/<project>`. Lets per-harness readers stamp their own origin.
   */
  sourceAgent?: string;
  /**
   * Per-session cursor key (`<prefix>:<sessionId>`) — the capture-cursors.json
   * key whose value gates and advances this session's incremental capture (#189).
   */
  cursorKey: string;
  /** Cursor value the delta starts from (entries already captured before this run). */
  startCursor: number;
  /**
   * Shrink-guard generation for this session — woven into segment ids so
   * post-reset segments can't collide with pre-reset ids on the content-blind
   * server dedup. Advanced back to the store with the cursor.
   */
  generation: number;
  /**
   * End-cursor value for each delta entry (length === entries.length). The
   * packer uses these to land segment boundaries on exact entry boundaries.
   * JSONL: startCursor + i + 1. Hermes: the row's messages.id.
   */
  entryCursors: number[];
}

/**
 * Cheap pre-filter: skip CC session FILES with fewer than this many raw JSONL
 * lines/entries — they're degenerate (aborted/empty) and not worth parsing.
 *
 * This is deliberately NOT the "is there meaningful content" gate. That is the
 * post-denoise `transcript.length < MIN_CONVERSATION_CHARS` (200) check in
 * nightly.ts, which measures actual conversation after tool/system noise is
 * stripped. Raw entry count is a lossy proxy — a dense 2-message exchange can
 * be very meaningful — so it's used only as a degenerate-file floor here, and
 * intentionally NOT applied to the Hermes reader (which lets the 200-char
 * content gate decide, so short dense sessions aren't dropped on count).
 */
export const MIN_TRANSCRIPT_ENTRIES = 4;

const CC_PROJECTS_DIR = join(homedir(), ".claude", "projects");

/**
 * Read all CC transcripts modified since `since`.
 * Returns one batch per session file.
 */
export function readCcTranscripts(
  since: Date,
  projectsDir = CC_PROJECTS_DIR,
  cursors: CursorMap = {}
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

      const sessionId = basename(filePath, ".jsonl");
      const key = `cc:${sessionId}`;
      const pos = cursors[key] ?? { cursor: 0, gen: 0 };
      const batch = parseTranscriptFile(filePath, projectName, key, pos.cursor, pos.gen);
      if (batch) {
        batches.push(batch);
      }
    }
  }

  return batches;
}

/**
 * Parse a single .jsonl transcript file into a delta batch.
 *
 * Returns null if the file has too few meaningful entries (whole-file gate) or
 * the cursor already covers everything (nothing new since last capture, #189).
 *
 * @param cursorKey capture-cursors.json key for this session
 * @param startCursor entries already captured (delta = entries.slice(startCursor))
 */
function parseTranscriptFile(
  filePath: string,
  projectName: string,
  cursorKey: string,
  startCursor: number,
  generation: number
): TranscriptBatch | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  const lines = raw.split("\n").filter((l) => l.trim());
  if (lines.length < MIN_TRANSCRIPT_ENTRIES) return null; // degenerate/empty file

  const entries: unknown[] = [];
  const timestamps: string[] = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      entries.push(entry);
      timestamps.push(typeof entry.timestamp === "string" ? entry.timestamp : "");
    } catch {
      // Skip malformed lines — a permanently-malformed line is skipped
      // identically every run, and a partial trailing write fails JSON.parse
      // now and parses (at the same index) once fully flushed.
    }
  }

  // Whole-file degeneracy gate stays on the full parse, not the delta.
  if (entries.length < MIN_TRANSCRIPT_ENTRIES) return null;

  // Shrink guard: a truncated/rotated file with fewer entries than the stored
  // cursor → reset to 0 AND bump the generation. The generation is woven into
  // the segment id downstream so the fresh file's segments can never collide
  // with the pre-reset ids on the server's content-blind dedup (fix 8).
  let start = startCursor;
  let gen = generation;
  if (start > entries.length) {
    start = 0;
    gen = generation + 1;
  }

  const delta = entries.slice(start);
  if (delta.length === 0) return null; // cursor already covers the whole file

  // Per-entry end cursors: entry i (0-based in the delta) ends at start+i+1.
  const entryCursors = delta.map((_, i) => start + i + 1);

  // Date from the LAST timestamped entry in the delta (per-night created_at for
  // multi-day sessions), falling back to today.
  let lastTimestamp = "";
  for (let i = start; i < entries.length; i++) {
    if (timestamps[i]) lastTimestamp = timestamps[i];
  }

  return {
    sessionId: basename(filePath, ".jsonl"),
    projectName,
    date: lastTimestamp
      ? lastTimestamp.slice(0, 10)
      : new Date().toISOString().slice(0, 10),
    entries: delta,
    cursorKey,
    startCursor: start,
    generation: gen,
    entryCursors,
  };
}

/**
 * Decode CC project directory name to a human-readable project name.
 * CC uses path-based hashing: "-Users-alice-Development-Tools-hicortex"
 * becomes "hicortex" (last path component).
 */
function decodeProjectDirName(dirName: string): string {
  // CC encodes paths by replacing / with -
  // e.g. "-Users-alice-Development-Tools-hicortex"
  const parts = dirName.split("-").filter(Boolean);
  if (parts.length === 0) return dirName;

  // Use the last meaningful path component as project name
  return parts[parts.length - 1];
}
