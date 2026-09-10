/**
 * Single-flight guard for LLM endpoint calls (#355).
 *
 * Local single-user model servers (one big-context model on a personal
 * machine) have a standing failure mode: TWO concurrent large-context
 * requests stall or OOM the server — and take the whole machine with it.
 * One Hicortex server is several LLM callers at once: the daemon distills
 * every inbound /distill concurrently, and the nightly's consolidation is a
 * separate OS process on its own timers. This guard makes "never two
 * in-flight requests to the same endpoint" STRUCTURAL instead of a hope
 * that timers do not overlap.
 *
 * Same idiom as capture.ts's capture.lock (A5): O_EXCL create, dead-pid or
 * TTL staleness with a TOCTOU re-race, and FAIL-OPEN — a filesystem refusal
 * logs a loud warning and lets the call proceed unserialized. The guard must
 * never be the reason recall or distillation stops on a healthy endpoint.
 *
 * The lock file lives in the hicortex home, one file per endpoint
 * (sha1 of `provider@baseUrl`), so an install with multiple endpoints
 * serializes within each endpoint, not across them.
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

export type LlmFlightGuard =
  | { kind: "acquired"; release: () => void }
  /** Waited past `waitMs` for the holder — the caller treats this as a
   * total-failure-class error (its message contains "timeout" so the retry
   * ladder and the #337 breaker classify it as endpoint-down). */
  | { kind: "timeout" }
  /** Filesystem refused the lock — proceed unserialized (fail-open). */
  | { kind: "open" };

type TryResult = LlmFlightGuard | { kind: "busy" };

/**
 * Default staleness floor: a lock older than this is stale REGARDLESS of the
 * recorded pid (guards the recycled-pid case, capture A5 fix 2). The caller
 * passes `staleMs = max(this default, 2× llmTimeoutMs)` so an operator who
 * raises the timeout ceiling can never have a LIVE call's lock reclaimed
 * mid-flight (CR #355 finding 3 — a reclaim-while-running is exactly the
 * two-concurrent-calls crash class this guard exists to prevent).
 */
export const DEFAULT_STALE_MS = 30 * 60 * 1000;

/**
 * A lock file younger than this whose holder is unreadable (empty/invalid
 * JSON) is treated as LIVE: its creator is between the O_EXCL create and the
 * writeSync — stealing in that window is the same crash class. Only an
 * unreadable file OLDER than the grace period is junk to reclaim
 * (CR #355 finding 4).
 */
const GRACE_MS = 2_000;

/** LLM-scale polling: waits are seconds-to-minutes, not capture-scale. */
const POLL_MS = 100;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Warn at most once per process that the guard failed open (#355 fail-open). */
let warnedOpen = false;

/** Lock path for an endpoint key — exported for tests and diagnostics. */
export function llmFlightLockPath(homeDir: string, endpointKey: string): string {
  const hash = createHash("sha1").update(endpointKey).digest("hex").slice(0, 16);
  return join(homeDir, `llm-flight-${hash}.lock`);
}

/**
 * Acquire the single-flight lock for `endpointKey`, waiting up to `waitMs`.
 * Never throws: every filesystem surprise degrades to `{ kind: "open" }`.
 */
export async function acquireLlmFlight(
  homeDir: string,
  endpointKey: string,
  waitMs: number,
  staleMs: number = DEFAULT_STALE_MS,
): Promise<LlmFlightGuard> {
  const lockPath = llmFlightLockPath(homeDir, endpointKey);
  try {
    mkdirSync(homeDir, { recursive: true });
  } catch {
    /* best effort — the create below surfaces real problems */
  }
  const deadline = Date.now() + waitMs;
  for (;;) {
    const attempt = tryAcquireOnce(lockPath, endpointKey, staleMs);
    if (attempt.kind !== "busy") return attempt;
    if (Date.now() >= deadline) return { kind: "timeout" };
    await sleep(Math.max(1, Math.min(POLL_MS, deadline - Date.now())));
  }
}

/** One acquire attempt: create-if-free, else reclaim-if-stale. */
function tryAcquireOnce(lockPath: string, endpointKey: string, staleMs: number): TryResult {
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
      // The lease records how long THIS holder may legitimately run
      // (now + staleMs) — a waiter with a smaller budget judges staleness
      // by the recorded lease, never by its own parameter (2nd-review
      // finding 3: a short-timeout waiter must not TTL-reclaim a live
      // long-timeout holder's lock).
      writeSync(
        fd,
        JSON.stringify({
          pid: process.pid,
          endpoint: endpointKey,
          leaseUntil: Date.now() + staleMs,
        }),
      );
      closeSync(fd);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    }
  };

  try {
    if (create()) return { kind: "acquired", release };

    const holder = readHolder(lockPath);
    if (!isStale(lockPath, holder, staleMs)) return { kind: "busy" };

    // Stale. Re-verify the holder has not changed (another reclaimer may
    // have taken it), unlink, re-race the O_EXCL create (capture fix 12).
    // Compare by VALUE (pid/endpoint) — readHolder returns a fresh object
    // per call, so reference equality would always differ.
    const recheck = readHolder(lockPath);
    if (
      recheck?.pid !== holder?.pid ||
      recheck?.endpoint !== holder?.endpoint
    ) {
      return { kind: "busy" };
    }
    try {
      unlinkSync(lockPath);
    } catch {
      /* raced with another reclaimer */
    }
    return create() ? { kind: "acquired", release } : { kind: "busy" };
  } catch {
    // Filesystem refused the lock op entirely — do not wedge LLM traffic on
    // the guard; proceed unserialized (the behaviour before #355).
    if (!warnedOpen) {
      warnedOpen = true;
      console.warn(
        `[hicortex] LLM single-flight lock unavailable (${lockPath}) — ` +
          `proceeding WITHOUT serialization. This is safe for recall but ` +
          `concurrent LLM calls can stall a single-user local model server.`,
      );
    }
    return { kind: "open" };
  }
}

interface LockHolder {
  pid: number;
  endpoint: string;
  /** Written by the holder: epoch-ms after which this lock is stale,
   *  REGARDLESS of any waiter's own staleMs. Absent in lock files written
   *  before the lease existed — the mtime+waiter-staleMs backstop applies. */
  leaseUntil?: number;
}

function readHolder(lockPath: string): LockHolder | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf-8")) as LockHolder;
    if (typeof parsed.pid === "number" && Number.isFinite(parsed.pid)) return parsed;
    return null;
  } catch {
    return null;
  }
}

/** Stale = dead pid, OR past the HOLDER's recorded lease, OR (lease-less
 *  lock files) older than the waiter's `staleMs`. An unreadable holder
 *  (mid-write or corrupt) is live within the grace period, junk after it. */
function isStale(
  lockPath: string,
  holder: LockHolder | null,
  staleMs: number,
): boolean {
  if (!holder) {
    try {
      return Date.now() - statSync(lockPath).mtimeMs > GRACE_MS;
    } catch {
      return true;
    }
  }
  if (!isProcessAlive(holder.pid)) return true;
  if (typeof holder.leaseUntil === "number" && Number.isFinite(holder.leaseUntil)) {
    return Date.now() > holder.leaseUntil;
  }
  try {
    return Date.now() - statSync(lockPath).mtimeMs > staleMs;
  } catch {
    return true;
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
