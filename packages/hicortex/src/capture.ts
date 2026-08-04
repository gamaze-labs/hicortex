/**
 * Incremental, cursor-aware capture loop (#189).
 *
 * Extracted from the two near-identical loops that lived in nightly.ts (server
 * and client mode). Both now share this logic: pack each session's delta into
 * ordered segments below the server's distill cap, POST them in order with a
 * deterministic `segment_id`, and advance the per-session cursor ONLY after
 * server-confirmed success — so a multi-day session grows across nights with no
 * loss and no silent truncation.
 *
 * The POST transport is injected (`post`) so the mode-specific bits (localhost
 * vs remote URL, Authorization header, timeout) stay in nightly.ts and the
 * multi-night simulation can run as a pure unit test with no HTTP listener.
 */

import {
  openSync,
  writeSync,
  closeSync,
  readFileSync,
  unlinkSync,
  mkdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { extractConversationText } from "./distiller.js";
import type { TranscriptBatch } from "./transcript-reader.js";
import type { CursorStore } from "./capture-cursors.js";

/**
 * Max denoised chars per segment. Kept below the server's 80K distill cap
 * (distiller.ts MAX_TRANSCRIPT_CHARS) with ~20K headroom so NO capture path can
 * hit the silent truncation. LOAD-BEARING for #189 recovery: a re-ingested
 * week-long session is re-sliced into ≤60K segments here instead of being
 * truncated at 80K server-side. (Judgment constant — tunable later.)
 */
export const SEGMENT_MAX_CHARS = 60_000;

/**
 * Minimum denoised chars for a FRESH whole session (startCursor 0) to be worth
 * capturing — mirrors the long-standing pre-#189 200-char degenerate-session
 * gate. It is applied ONLY to a whole-session capture that denoises to a single
 * sub-200 segment. A delta beyond cursor 0 is always sent, however small: a
 * session's concluding tail must never be held back, because once the session
 * stops growing its mtime never re-crosses the watermark and the tail would be
 * lost forever (#189 review, fix 5).
 */
export const MIN_SEGMENT_CHARS = 200;

/** Chars added by the "\n\n" joiner extractConversationText places between entries. */
const JOINER_CHARS = 2;

/** One packed, ready-to-POST segment of a session's delta. */
export interface Segment {
  /** Denoised text body of the POST. */
  text: string;
  /** Cursor value the segment starts at. */
  segStart: number;
  /** Cursor value the segment ends at. */
  segEnd: number;
  /**
   * Disambiguator for hard-split pieces of a single oversized entry (A2). Empty
   * for normal segments; ".p0", ".p1", … when one entry is split mid-text.
   * Keeps the server's `<sid>#<segment_id>#<i>` keys distinct so no piece's
   * memories collide on the UNIQUE index.
   */
  idSuffix: string;
}

/** The wire body for POST /distill. */
export interface DistillBody {
  text: string;
  source_agent: string;
  /** Stable client UUID (config.json `agentId`). Attribution only. */
  source_agent_id?: string | null;
  /** Client-declared topic/domain of the capturing agent. Provenance only. */
  source_domain?: string | null;
  project: string;
  session_id: string;
  segment_id: string;
  session_date: string;
  /** 0.16.x: optional/vestigial. The distiller no longer sets it; a legacy
   *  client may. Honored if present, else the memory stores NULL. */
  privacy?: string;
}

/** Normalized POST result the caller's transport returns. */
export interface PostResult {
  status: number;
  distilled?: number;
  dropped?: string[];
  skipped?: boolean;
  error?: string;
}

export type PostFn = (body: DistillBody) => Promise<PostResult>;

export interface CaptureOptions {
  post: PostFn;
  cursorStore: CursorStore;
  dryRun?: boolean;
  /** Segment size cap; defaults to SEGMENT_MAX_CHARS. Lowered in tests. */
  segmentMaxChars?: number;
  /**
   * Per-client attribution UUID (config.json `agentId`). Sent on every
   * segment as `source_agent_id`. Null when the client has no `agentId`
   * (e.g. a pre-0.16.x config that has not re-run init).
   */
  sourceAgentId?: string | null;
  /**
   * Per-client declared topic/domain (config.json `sourceDomain`). Sent as
   * `source_domain` provenance. Null when undeclared.
   */
  sourceDomain?: string | null;
}

export interface CaptureResult {
  memoriesIngested: number;
  sessionsSent: number;
  hadTransientFailure: boolean;
  /**
   * Set when the loop stopped early on a terminal server response: "limit"
   * (429 memory cap) or "auth" (401). The caller decides watermark handling.
   */
  stopped?: "limit" | "auth";
}

/**
 * Split an already-denoised string into ≤maxChars pieces (A2 hard-split).
 * Prefers paragraph, then line, then hard boundaries — mirrors the distiller's
 * own splitIntoChunks, but WITHOUT its <200-char drop (every piece must survive,
 * dup-over-loss).
 */
export function hardSplitText(text: string, maxChars = SEGMENT_MAX_CHARS): string[] {
  if (text.length <= maxChars) return [text];
  const pieces: string[] = [];
  let remaining = text;
  while (remaining.length > maxChars) {
    let splitAt = remaining.lastIndexOf("\n\n", maxChars);
    if (splitAt < maxChars * 0.5) splitAt = remaining.lastIndexOf("\n", maxChars);
    if (splitAt < maxChars * 0.3) splitAt = maxChars;
    pieces.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining.length > 0) pieces.push(remaining);
  return pieces;
}

/**
 * Pack a session's delta entries into ordered ≤maxChars segments.
 *
 * Sizing uses per-entry denoise lengths plus the "\n\n" joiners (A8) so the
 * estimate matches what the server receives; the actual body is a re-denoise of
 * the grouped entries (extractConversationText) so cleaning/redaction stay
 * coherent. A single entry larger than maxChars is emitted as its own run of
 * hard-split pieces (A2).
 */
export function packSegments(
  entries: unknown[],
  startCursor: number,
  entryCursors: number[],
  maxChars = SEGMENT_MAX_CHARS,
): Segment[] {
  const segments: Segment[] = [];
  // Boundary cursor before entry i (startCursor for i=0, else entryCursors[i-1]).
  const boundaryBefore = (i: number) => (i === 0 ? startCursor : entryCursors[i - 1]);

  let groupStartIdx = -1;
  let groupSize = 0;

  const flushGroup = (endIdxExclusive: number) => {
    if (groupStartIdx < 0) return;
    const groupEntries = entries.slice(groupStartIdx, endIdxExclusive);
    segments.push({
      text: extractConversationText(groupEntries),
      segStart: boundaryBefore(groupStartIdx),
      segEnd: entryCursors[endIdxExclusive - 1],
      idSuffix: "",
    });
    groupStartIdx = -1;
    groupSize = 0;
  };

  for (let i = 0; i < entries.length; i++) {
    const entryText = extractConversationText([entries[i]]);
    const entryLen = entryText.length;

    if (entryLen > maxChars) {
      // Oversized single entry — flush the pending group, then hard-split it
      // into its own segments so no piece can reach the server's 80K cap.
      // Defensive: extractTextFromContent currently caps a single message at
      // ~20K denoised chars, so this branch does not fire at the 60K default —
      // it guarantees the ≤maxChars invariant regardless of the denoiser (A2).
      flushGroup(i);
      const pieces = hardSplitText(entryText, maxChars);
      pieces.forEach((piece, p) => {
        segments.push({
          text: piece,
          segStart: boundaryBefore(i),
          segEnd: entryCursors[i],
          idSuffix: `.p${p}`,
        });
      });
      continue;
    }

    // Would adding this entry (plus its joiner) overflow the current group?
    const addition = (groupSize > 0 ? JOINER_CHARS : 0) + entryLen;
    if (groupSize > 0 && groupSize + addition > maxChars) {
      flushGroup(i);
    }
    if (groupStartIdx < 0) groupStartIdx = i;
    groupSize += addition;
  }
  flushGroup(entries.length);

  return segments;
}

/**
 * Capture a list of session delta batches: pack, POST in order, advance
 * per-session cursors on success. Segments of one session POST in order; the
 * first hard failure stops THAT session (cursor holds at the last confirmed
 * boundary) while other sessions continue. A 429/401 stops the whole loop.
 */
export async function captureBatches(
  batches: TranscriptBatch[],
  opts: CaptureOptions,
): Promise<CaptureResult> {
  const { post, cursorStore, dryRun = false, segmentMaxChars = SEGMENT_MAX_CHARS, sourceAgentId, sourceDomain } = opts;
  let memoriesIngested = 0;
  let sessionsSent = 0;
  let hadTransientFailure = false;
  let stopped: "limit" | "auth" | undefined;

  for (const batch of batches) {
    const short = batch.sessionId.slice(0, 8);
    const segments = packSegments(batch.entries, batch.startCursor, batch.entryCursors, segmentMaxChars);

    if (segments.length === 0) continue;

    // Fresh whole-session degenerate floor (fix 5): only a startCursor-0 capture
    // that collapses to a single sub-200 segment is dropped (pre-#189 behaviour
    // for degenerate sessions). Any real delta — including a small concluding
    // tail — is sent below.
    if (batch.startCursor === 0 && segments.length === 1 && segments[0].text.length < MIN_SEGMENT_CHARS) {
      if (!dryRun) console.log(`[hicortex]   Skip ${short} (${batch.projectName}): too short`);
      continue;
    }

    if (dryRun) {
      const total = segments.reduce((n, s) => n + s.text.length, 0);
      console.log(
        `[hicortex]   [dry-run] ${short} (${batch.projectName}): ${segments.length} segment(s), ${total} chars`
      );
      continue;
    }

    console.log(`[hicortex]   Capturing ${short} (${batch.projectName}, ${batch.date})`);

    // Segment ids carry the shrink generation so post-reset ids can't collide
    // with pre-reset ones on the server's content-blind dedup (fix 8). gen 0
    // has no prefix — keeps ids byte-identical to first-cut and to any already
    // stored on an older server.
    const genPrefix = batch.generation > 0 ? `g${batch.generation}.` : "";

    // Cursor value the last confirmed boundary reached — advanced once, at
    // session end (A4), so per-session file writes stay bounded.
    let lastConfirmedEnd = batch.startCursor;
    let sessionPosted = false;

    for (let s = 0; s < segments.length; s++) {
      const seg = segments[s];
      // A segment advances the cursor to its segEnd only when it is the LAST
      // segment ending at that boundary. Hard-split pieces (.p0,.p1,…) of one
      // entry share the same segEnd; confirming an earlier piece must NOT move
      // the cursor past the entry while a later piece is still unsent (fix 11).
      const advancesBoundary = s === segments.length - 1 || segments[s + 1].segStart >= seg.segEnd;

      // Pure-noise slice (all entries filtered to nothing) — nothing to store
      // and the server rejects an empty body. Advance past it (content is gone
      // either way) rather than POST.
      if (seg.text.length === 0) {
        if (advancesBoundary) lastConfirmedEnd = seg.segEnd;
        continue;
      }

      const body: DistillBody = {
        text: seg.text,
        source_agent: batch.sourceAgent ?? `claude-code/${batch.projectName}`,
        source_agent_id: sourceAgentId ?? null,
        source_domain: sourceDomain ?? null,
        project: batch.projectName,
        session_id: batch.sessionId,
        segment_id: `${genPrefix}${seg.segStart}-${seg.segEnd}${seg.idSuffix}`,
        session_date: batch.date,
      };

      let result: PostResult;
      try {
        result = await post(body);
      } catch (err) {
        console.error(`[hicortex]     Capture failed: ${err instanceof Error ? err.message : String(err)} — will retry next run`);
        hadTransientFailure = true;
        break;
      }

      if (result.status === 201) {
        memoriesIngested += result.distilled ?? 0;
        sessionPosted = true;
        if (advancesBoundary) lastConfirmedEnd = seg.segEnd;
        console.log(`[hicortex]     → ${result.distilled ?? 0} memories (segment ${body.segment_id})`);
        for (const d of result.dropped ?? []) {
          console.log(`[hicortex]     Substance gate: dropped "${d}"`);
        }
      } else if (result.status === 200) {
        // Already ingested (segment-exact or legacy session dedup) — treat as
        // confirmed and advance past it (only at a boundary, per fix 11).
        if (advancesBoundary) lastConfirmedEnd = seg.segEnd;
        if (result.skipped) console.log(`[hicortex]     Segment ${body.segment_id} already ingested`);
      } else if (result.status === 429) {
        console.log(`[hicortex]   Memory limit reached: ${result.error}. Stopping capture.`);
        stopped = "limit";
        break;
      } else if (result.status === 401) {
        console.error(`[hicortex]     Auth failed. Check authToken in ~/.hicortex/config.json`);
        stopped = "auth";
        break;
      } else {
        console.error(`[hicortex]     /distill returned ${result.status}: ${result.error ?? "unknown error"} — will retry next run`);
        hadTransientFailure = true;
        break;
      }
    }

    if (sessionPosted) sessionsSent++;

    // Advance the session cursor once, to the last confirmed boundary. Holds at
    // startCursor when nothing was confirmed (whole delta failed or noise-only).
    // A mid-session failure only breaks the segment loop above — this still
    // records the boundaries that DID confirm, and other sessions continue.
    if (lastConfirmedEnd > batch.startCursor) {
      try {
        cursorStore.advance(batch.cursorKey, lastConfirmedEnd, batch.generation);
      } catch (err) {
        // Persisting the cursor failed (disk full / perms). Surface it as a
        // transient failure so the watermark holds and we retry — never a
        // silent warn-and-continue that re-captures forever (fix 7).
        console.error(`[hicortex] Failed to persist capture cursor for ${batch.cursorKey}: ${err instanceof Error ? err.message : String(err)} — holding watermark`);
        hadTransientFailure = true;
        break;
      }
    }

    if (stopped) break;
  }

  return { memoriesIngested, sessionsSent, hadTransientFailure, stopped };
}

// ---------------------------------------------------------------------------
// Single-flight guard (A5)
// ---------------------------------------------------------------------------

const LOCK_FILE = "capture.lock";

/**
 * A lock older than this is considered stale REGARDLESS of the recorded pid.
 * Guards the EPERM case: a recycled pid owned by a long-lived root/other-user
 * process would otherwise read as "alive forever" and wedge capture silently
 * (#189 review, fix 2). 24h > the longest plausible distill run (20-min POST
 * timeout × sessions).
 */
const LOCK_TTL_MS = 24 * 60 * 60 * 1000;
const LOCK_POLL_MS = 2000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Acquire an exclusive capture lock for `stateDir`. Returns a release function,
 * or null if another LIVE, non-stale run holds it after waiting up to `waitMs`.
 *
 * Staleness = dead pid OR lockfile mtime older than LOCK_TTL_MS. A stale lock is
 * reclaimed (with a re-verify + O_EXCL re-race to narrow the TOCTOU window,
 * fix 12). `waitMs` lets the full nightly wait out a transient `--capture-only`
 * overlap instead of dropping the night's capture (fix 10); pass 0 to fail fast.
 *
 * This stops a `nightly` and a `nightly --capture-only` (an encouraged workflow)
 * from running the capture loop concurrently, which would race cursor writes and
 * emit divergent segment boundaries → real duplication.
 */
export async function acquireCaptureLock(
  stateDir: string,
  waitMs = 0,
): Promise<(() => void) | null> {
  const lockPath = join(stateDir, LOCK_FILE);
  try {
    mkdirSync(stateDir, { recursive: true });
  } catch {
    /* best effort */
  }
  const deadline = Date.now() + waitMs;
  for (;;) {
    const release = tryAcquireOnce(lockPath);
    if (release) return release;
    if (Date.now() >= deadline) return null;
    await sleep(Math.max(1, Math.min(LOCK_POLL_MS, deadline - Date.now())));
  }
}

/** One acquire attempt: create-if-free, else reclaim-if-stale. */
function tryAcquireOnce(lockPath: string): (() => void) | null {
  const release = () => {
    try {
      unlinkSync(lockPath);
    } catch {
      /* already gone */
    }
  };

  const create = (): boolean => {
    try {
      const fd = openSync(lockPath, "wx"); // O_CREAT | O_EXCL
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    }
  };

  try {
    if (create()) return release;

    // Lock exists — read the holder pid and decide staleness.
    const holderPid = readLockPid(lockPath);
    if (!isLockStale(lockPath, holderPid)) return null; // live, recent → held

    // Stale. Re-verify the file still carries the SAME pid we judged (another
    // reclaimer may have taken it since), then unlink and re-race the O_EXCL
    // create. A fresh holder → our create loses (EEXIST) → null (fix 12).
    if (readLockPid(lockPath) !== holderPid) return null;
    try {
      unlinkSync(lockPath);
    } catch {
      /* raced with another reclaimer */
    }
    return create() ? release : null;
  } catch {
    // Filesystem refused the lock op entirely — don't wedge capture; proceed
    // without the guard (behaviour before A5).
    return release;
  }
}

/** Read the recorded pid, or 0 if unreadable/absent. */
function readLockPid(lockPath: string): number {
  try {
    const pid = parseInt(readFileSync(lockPath, "utf-8").trim(), 10);
    return Number.isFinite(pid) ? pid : 0;
  } catch {
    return 0;
  }
}

/** Stale = no/dead pid, OR the lockfile is older than the TTL (fix 2). */
function isLockStale(lockPath: string, holderPid: number): boolean {
  if (!holderPid || !isProcessAlive(holderPid)) return true;
  try {
    return Date.now() - statSync(lockPath).mtimeMs > LOCK_TTL_MS;
  } catch {
    return true; // can't stat → treat as stale so we don't wedge forever
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process; EPERM = exists but not ours (still alive).
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
