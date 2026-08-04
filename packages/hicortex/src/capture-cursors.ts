/**
 * Per-session capture cursors (#189).
 *
 * The client is the source of truth for "how much of each session has already
 * been captured". A cursor is advanced ONLY after the server confirms the
 * corresponding segment(s) were ingested, so a crash between POST and cursor
 * write can at worst cause a bounded, idempotent re-send — never silent loss.
 *
 * Storage: a SEPARATE small file `<hicortex-home>/capture-cursors.json`
 * (NOT state.json — that file carries the large moduleIndex, and per-session
 * whole-file rewrites there would be an avoidable corruption/IO surface). Same
 * temp+rename atomic write discipline as state.ts.
 *
 * Cursor unit is reader-defined:
 *   - JSONL readers (CC/Pi/OC): count of successfully-PARSED entries consumed.
 *   - Hermes: max `messages.id` consumed (INTEGER PRIMARY KEY AUTOINCREMENT —
 *     never reused, strictly increasing).
 *
 * `gen` (generation) is bumped by a reader's shrink-guard when a source file is
 * truncated/rotated below the stored cursor. It is woven into the segment id
 * (`g<gen>.<start>-<end>`) so post-reset segments can NEVER collide with a
 * pre-reset id on the server's content-blind segment-exact dedup — a collision
 * there would be silent LOSS, not the intended dup-over-loss (#189 review, fix 8).
 *
 * Keys are `<prefix>:<sessionId>`:
 *   cc:<sid>  pi:<sid>  oc:<agentId>:<sid>  hermes:<profile>:<sid>
 */

import { hicortexHome } from "./paths.js";
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";

const HICORTEX_HOME = hicortexHome();
const CURSORS_FILE = "capture-cursors.json";

export interface CursorEntry {
  /** Reader-defined cursor value (entry count for JSONL, max id for Hermes). */
  cursor: number;
  /** Shrink-guard generation — woven into segment ids to avoid post-reset id collisions. */
  gen: number;
  /** ISO timestamp of the last advance — used for 90-day pruning. */
  updated: string;
}

export type CursorFile = Record<string, CursorEntry>;

/** Snapshot of a session's captured position, passed to the readers. */
export interface CursorPosition {
  cursor: number;
  gen: number;
}

/** Map of cursor key → captured position. */
export type CursorMap = Record<string, CursorPosition>;

/** Coerce a stored cursor value to a valid non-negative integer (fix 13). */
function sanitizeCursor(raw: unknown, key: string): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    return Math.floor(raw);
  }
  console.warn(
    `[hicortex] capture-cursors: ignoring invalid cursor for ${key} (${JSON.stringify(raw)}) — treating as 0`,
  );
  return 0;
}

function sanitizeGen(raw: unknown): number {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
}

/** Load the cursor file. Missing/corrupt → empty (every key defaults to 0). */
export function loadCursors(stateDir: string = HICORTEX_HOME): CursorFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(stateDir, CURSORS_FILE), "utf-8"));
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};
  const out: CursorFile = {};
  for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
    if (!val || typeof val !== "object") continue;
    const v = val as Record<string, unknown>;
    out[key] = {
      cursor: sanitizeCursor(v.cursor, key),
      gen: sanitizeGen(v.gen),
      updated: typeof v.updated === "string" ? v.updated : new Date().toISOString(),
    };
  }
  return out;
}

/**
 * Atomically persist the cursor file (write-temp + rename). THROWS on failure —
 * a persistent inability to record cursors must surface as a transient failure
 * (hold the watermark), never a silent warn-and-continue that re-captures the
 * same content every night (#189 review, fix 7).
 */
export function saveCursors(
  file: CursorFile,
  stateDir: string = HICORTEX_HOME,
): void {
  mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, CURSORS_FILE);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2));
  renameSync(tmp, path);
}

/**
 * A read-once, write-on-advance cursor store. Single-flight (see
 * acquireCaptureLock in capture.ts) guarantees no concurrent writer, so an
 * in-memory copy flushed atomically on each advance is safe.
 */
export interface CursorStore {
  /** Current position for `key` ({cursor:0, gen:0} when never captured). */
  get(key: string): CursorPosition;
  /** Advance `key` to `cursor` at `gen` and persist. Throws if the write fails. */
  advance(key: string, cursor: number, gen: number): void;
  /** Snapshot of key → position for passing to readers. */
  map(): CursorMap;
}

/** Open a file-backed cursor store for `stateDir`. */
export function openCursorStore(stateDir: string = HICORTEX_HOME): CursorStore {
  const file = loadCursors(stateDir);
  return {
    get(key: string): CursorPosition {
      const e = file[key];
      return { cursor: e?.cursor ?? 0, gen: e?.gen ?? 0 };
    },
    advance(key: string, cursor: number, gen: number): void {
      file[key] = { cursor, gen, updated: new Date().toISOString() };
      saveCursors(file, stateDir); // throws on failure — caller holds the watermark
    },
    map(): CursorMap {
      const out: CursorMap = {};
      for (const [k, v] of Object.entries(file)) out[k] = { cursor: v.cursor, gen: v.gen };
      return out;
    },
  };
}

/**
 * Drop cursor entries older than `days` (default 90). Best-effort: a prune-write
 * failure is logged, not thrown (prune runs only after a clean nightly and must
 * not fail the run). Returns the number pruned.
 */
export function pruneCursors(
  stateDir: string = HICORTEX_HOME,
  days = 90,
): number {
  const file = loadCursors(stateDir);
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let pruned = 0;
  for (const [key, entry] of Object.entries(file)) {
    const t = Date.parse(entry.updated);
    if (!Number.isNaN(t) && t < cutoff) {
      delete file[key];
      pruned++;
    }
  }
  if (pruned > 0) {
    try {
      saveCursors(file, stateDir);
    } catch (err) {
      console.warn(`[hicortex] capture-cursors prune write failed: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }
  return pruned;
}
