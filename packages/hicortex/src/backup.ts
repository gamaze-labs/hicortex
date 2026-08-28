/**
 * Backup mechanism — a transactionally-consistent snapshot of the irreplaceable
 * data (#6, Phase 0B).
 *
 * For a product whose value is accumulated memory, silent backup loss is
 * existential (spec §8). The live DB runs with WAL on, so a plain `cp`/`tar` of
 * `hicortex.db` is torn (the `-wal` file holds uncommitted pages → a copy that
 * looks fine until you restore it). This module uses better-sqlite3's native
 * `db.backup(path)` — the SQLite online-backup API, already proven in `dedup.ts`
 * — which folds the WAL into a single self-contained, consistent snapshot, then
 * packages it with the hand-edited identity layer + capture state into one
 * `tar.gz` artifact the operator ships offsite.
 *
 * Backup set (the irreplaceable data under HICORTEX_HOME):
 *   - `hicortex.db`            — via db.backup() to a temp snapshot (WAL-safe)
 *   - `identity/` (whole tree) — global `*.md` AND per-agent `agents/<id>/*.md`
 *   - `context/` (legacy)      — additive fallback (identity-store.ts migrate)
 *   - `state.json`             — cursors/tier/timestamps (state.ts)
 *   - `capture-cursors.json`   — per-session capture positions (capture-cursors.ts)
 *
 * Excluded by design:
 *   - `config.json`            — secrets (authToken/llmApiKey); re-creatable via init
 *   - `backups/`               — output dir (never back up the backups)
 *   - logs (`nightly.log`, `server*.log`) — re-creatable, noisy, not data
 *   - `models/`                — embedder cache (re-downloadable)
 *   - `capture.lock`           — a transient single-flight lock, not state
 *   - `.allow-localhost-bypass` — a hosted fail-closed marker, not data
 *
 * Vectors: `db.backup()` copies the vec0 shadow tables (they're real tables).
 * If a restore ever finds them missing, vectors regenerate from
 * `memories.content` via the embedder — non-destructive either way.
 */

import { execFile, type ExecFileException } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  type ReadStream,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createGzip } from "node:zlib";
import { pack as tarPack } from "tar-stream";
import type Database from "better-sqlite3";

import { hicortexHome } from "./paths.js";
import { initDb, resolveDbPath } from "./db.js";
import { loadConfigStrict } from "./init.js";
import { readNonNegativeConfig } from "./config-read.js";

/**
 * Hook timeout — a stuck offsite upload (rclone/aws/B2 hung on a dead network)
 * must NOT hang the nightly. 5 min is generous for typical tarball uploads; the
 * operator's wrapper can re-queue on timeout. Mirrors the capture-lock "don't
 * block forever" discipline.
 */
const HOOK_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Default number of backup artifacts kept in the backup dir (#327). The
 * nightly backup stage writes one `hicortex-<ISO>.tar.gz` per run with no
 * pruning — unbounded growth (per hosted tenant too). Configurable via
 * `backupRetention`; 0 keeps everything.
 */
export const DEFAULT_BACKUP_RETENTION = 7;

export interface CreateBackupOptions {
  /** Open live DB handle (caller manages lifetime). Backed up via db.backup(). */
  db: Database.Database;
  /** HICORTEX_HOME — the dir whose irreplaceable files are packaged. */
  home: string;
  /**
   * Explicit output file path (a tar.gz). Overrides `outDir`/default. Mutually
   * exclusive with `stdout`.
   */
  outFile?: string;
  /**
   * Output directory. Defaults to `<home>/backups`. Ignored when `outFile` is
   * set. Configurable via `config.backupDir`.
   */
  outDir?: string;
  /**
   * Directory for the transient DB snapshot (defaults to the OS tmpdir).
   * Injectable so tests observe a PRIVATE dir — vitest runs files in parallel,
   * and a sibling test's in-flight snapshot in the shared tmpdir reads as a
   * "leak" to a before/after diff (final consolidation CR finding 1).
   */
  snapshotDir?: string;
  /**
   * Stream the tar.gz to `process.stdout` instead of writing a file (the
   * offsite pattern: `hicortex backup --stdout | rclone rcat ...`). Mutually
   * exclusive with `outFile`/`outDir`.
   */
  stdout?: boolean;
  /**
   * Retention (#327): how many of the newest `hicortex-*.tar.gz` artifacts to
   * keep in the (dir-managed) output dir after a successful write. 0 keeps
   * all. Defaults to DEFAULT_BACKUP_RETENTION; callers resolve the
   * `backupRetention` config key. Only consulted when the artifact goes to
   * `outDir`/the default dir — an explicit `outFile` is caller-owned.
   */
  retention?: number;
}

export interface CreateBackupResult {
  /** Absolute path of the written artifact; undefined when `stdout:true`. */
  path?: string;
  /** Compressed artifact size in bytes (gzip output). */
  bytes: number;
  /** Number of files packaged (DB snapshot + identity tree + state files). */
  files: number;
  /**
   * Old artifacts removed by the retention pass (#327). Undefined when no
   * retention pass ran (stdout / explicit outFile); 0 = nothing to prune.
   */
  pruned?: number;
}

export interface BackupHookResult {
  ok: boolean;
  /** Process exit code when the hook ran and exited (0 on success); undefined
   *  when the command was missing, couldn't spawn (ENOENT), or timed out. */
  exitCode?: number;
}

/** A file to add to the tarball: `name` is the in-tar path, `file` the source. */
interface TarEntry {
  name: string;
  file: string;
}

/**
 * Create a backup artifact. Snapshots the live DB via the online-backup API,
 * packages it with the identity tree + state into a single `tar.gz`, and writes
 * it to `outFile` (default `<home>/backups/hicortex-<ISO>.tar.gz`) or streams
 * to stdout. Returns `{ path?, bytes, files }`.
 *
 * Never partially writes a file artifact on failure: if the tar pipeline errors
 * mid-stream the (likely-truncated) file is removed before the error propagates,
 * so a stale half-backup is never left on disk to masquerade as a good one.
 */
export async function createBackup(opts: CreateBackupOptions): Promise<CreateBackupResult> {
  if (opts.stdout && (opts.outFile || opts.outDir)) {
    throw new Error("[hicortex] backup: --stdout is mutually exclusive with --out / backupDir");
  }

  // 1. Snapshot the live DB via the WAL-safe online-backup API (proven at
  //    dedup.ts:499). Runs concurrently with the live DB — no writer blocking,
  //    no torn copy. The temp file is cleaned up in `finally` below.
  const snapshotPath = join(opts.snapshotDir ?? tmpdir(), `hicortex-backup-${randomBytes(6).toString("hex")}.db`);
  await opts.db.backup(snapshotPath);

  let totalBytes = 0;
  let fileCount = 0;

  // Resolve the output target (file path or stdout). The ISO stamp is filename-
  // safe (colons/dots → dashes) so it survives every filesystem.
  const iso = new Date().toISOString().replace(/[:.]/g, "-");
  const outFile = opts.stdout
    ? undefined
    : opts.outFile ?? join(opts.outDir ?? join(opts.home, "backups"), `hicortex-${iso}.tar.gz`);

  // Prepare the output dir up front so a later mkdirSync failure (permissions,
  // read-only mount) surfaces BEFORE we spend time tarring — fail loud, early.
  if (outFile) mkdirSync(dirname(outFile), { recursive: true });

  // 2. Build the entry list (deterministic order for diffable tarballs).
  const entries: TarEntry[] = [{ name: "hicortex.db", file: snapshotPath }];
  appendTree(entries, join(opts.home, "identity"), "identity");
  appendTree(entries, join(opts.home, "context"), "context");
  pushIfExists(entries, join(opts.home, "state.json"), "state.json");
  pushIfExists(entries, join(opts.home, "capture-cursors.json"), "capture-cursors.json");

  // 3. Pack → gzip → sink (file or stdout). Entries are added SEQUENTIALLY:
  //    tar-stream writes headers in call order, and concurrent entry() calls
  //    would interleave headers into a corrupt tar. Each entry streams from disk
  //    so the DB snapshot (potentially large) is never fully in memory.
  const packStream = tarPack();
  const gzip = createGzip();
  packStream.pipe(gzip);
  const sink = opts.stdout ? process.stdout : createWriteStream(outFile!);
  gzip.pipe(sink);
  gzip.on("data", (chunk: Buffer) => {
    totalBytes += chunk.length;
  });

  // Completion signal — DIFFERENT per sink type:
  //   - File: await the file stream's 'finish' (all bytes flushed to disk) so
  //     the offsite hook reads a complete, closed file.
  //   - stdout: process.stdout is a special non-closable stream that NEVER
  //     emits 'finish', so awaiting it deadlocks. Instead await gzip's 'end'
  //     (the last compressed byte has been emitted and handed to stdout); the
  //     OS drains process.stdout asynchronously and Node won't exit while it
  //     has pending buffered bytes.
  const sinkFinished = opts.stdout
    ? new Promise<void>((resolve, reject) => {
        gzip.on("end", resolve);
        gzip.on("error", reject);
        packStream.on("error", reject);
        // A downstream pipe closing early (--stdout | head, or rclone dying)
        // emits 'error' (EPIPE) on process.stdout — listen so it rejects cleanly
        // instead of becoming an uncaughtException (and so we never hang waiting
        // for gzip 'end' that will never come once the sink has errored).
        sink.on("error", reject);
      })
    : new Promise<void>((resolve, reject) => {
        sink.on("finish", resolve);
        sink.on("error", reject);
        gzip.on("error", reject);
        packStream.on("error", reject);
      });

  try {
    for (const entry of entries) {
      const size = statSync(entry.file).size;
      await new Promise<void>((resolve, reject) => {
        const writable = packStream.entry({ name: entry.name, size }, (err) => {
          if (err) reject(err);
          else resolve();
        });
        const rs: ReadStream = createReadStream(entry.file);
        rs.on("error", reject);
        rs.pipe(writable);
      });
      fileCount++;
    }

    packStream.finalize();
    await sinkFinished;

    // Retention (#327) — only after a SUCCESSFUL write (a failed one removed
    // its own partial artifact above), and only for dir-managed targets: an
    // explicit outFile is caller-owned, and --stdout writes nothing to prune.
    let pruned: number | undefined;
    if (!opts.stdout && opts.outFile === undefined) {
      pruned = pruneBackupArtifacts(dirname(outFile!), opts.retention ?? DEFAULT_BACKUP_RETENTION);
    }

    return { path: outFile, bytes: totalBytes, files: fileCount, pruned };
  } catch (err) {
    // Never leave a truncated/half-written artifact on disk masquerading as a
    // good backup — a restore drill against it would fail at the worst time.
    if (!opts.stdout && outFile) {
      try {
        rmSync(outFile, { force: true });
      } catch {
        // Best-effort cleanup; the real error is the one we re-throw.
      }
    }
    throw err;
  } finally {
    // Always remove the temp DB snapshot (best-effort, never masks a real error).
    try {
      rmSync(snapshotPath, { force: true });
    } catch {
      // ignore
    }
  }
}

/**
 * Run the operator's post-backup offsite hook. The configured `command` is split
 * on whitespace and the artifact path appended as the LAST arg (e.g.
 * `rclone copyto <path> remote:hicortex/` → `["rclone","copyto",path,...]`).
 * Cloud creds + active alerting stay in the operator's wrapper, out of the
 * product. NEVER throws — a hook failure is reported as `{ ok:false }` so the
 * nightly continues (capture/consolidation already succeeded; the backup itself
 * is on disk). 5 min timeout so a hung upload can't hang the nightly.
 *
 * Whitespace-split caveat: commands with quoted args containing spaces should
 * be a wrapper script (`/etc/hicortex/offsite.sh`), not a one-liner — the split
 * here is deliberately dumb to avoid re-implementing a shell parser.
 */
export async function runBackupHook(
  artifactPath: string,
  command: string | undefined,
): Promise<BackupHookResult> {
  // Missing/empty command = nothing configured. Not an error (the nightly only
  // calls this when a command IS set), but the defensive contract is { ok:false }
  // so a caller that forgets the guard still gets an honest "no hook ran".
  if (!command || !command.trim()) {
    return { ok: false };
  }

  const parts = command.trim().split(/\s+/);
  const [cmd, ...baseArgs] = parts;
  const args = [...baseArgs, artifactPath];

  return new Promise((resolve) => {
    try {
      execFile(
        cmd,
        args,
        { timeout: HOOK_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            const execErr = err as ExecFileException;
            // err.code: number = process exit code; "ENOENT" = binary not found.
            // err.signal: set when killed (timeout → SIGTERM). Extract a numeric
            // exit code only (the alerting signal); spawn/timeout failures are
            // reported with undefined exitCode.
            const exitCode =
              typeof execErr.code === "number" ? execErr.code : undefined;
            const reason =
              execErr.signal != null
                ? `killed by signal ${execErr.signal} (timeout?)`
                : execErr.code === "ENOENT"
                  ? `command not found: ${cmd}`
                  : execErr.message;
            console.error(`[hicortex] backup hook failed: ${reason}`);
            if (stderr) {
              console.error(
                `[hicortex]   hook stderr: ${stderr.toString().trim().slice(0, 2000)}`,
              );
            }
            resolve({ ok: false, exitCode });
            return;
          }
          if (stdout) {
            console.log(
              `[hicortex] backup hook stdout: ${stdout.toString().trim().slice(0, 2000)}`,
            );
          }
          resolve({ ok: true, exitCode: 0 });
        },
      );
    } catch (err) {
      // Synchronous spawn failure (shouldn't happen with execFile, but defensive
      // — the contract is "never throws").
      console.error(
        `[hicortex] backup hook could not run: ${err instanceof Error ? err.message : String(err)}`,
      );
      resolve({ ok: false });
    }
  });
}

// ---------------------------------------------------------------------------
// File-set helpers
// ---------------------------------------------------------------------------

/**
 * mtime (ms) of the NEWEST `hicortex-*.tar.gz` in `dir`, or undefined when the
 * dir has none / cannot be read. The nightly consolidate-only artifact-age
 * gate (#327 CR) uses this to bound the hosted backup cadence to ~1/day
 * without a new state file: the newest artifact on disk IS the
 * "last backed up" marker. Same product-owned filename pattern the pruner
 * matches, so the gate and the pruner can never disagree about what counts.
 */
export function newestBackupArtifactMs(dir: string): number | undefined {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    // Missing/unreadable dir — no artifact, no gate (a fresh install backs up).
    return undefined;
  }
  let newest: number | undefined;
  for (const n of names) {
    if (!/^hicortex-.*\.tar\.gz$/.test(n)) continue;
    try {
      const ms = statSync(join(dir, n)).mtimeMs;
      if (newest === undefined || ms > newest) newest = ms;
    } catch {
      // Raced/unreadable — an unknown-age artifact cannot inform the gate.
    }
  }
  return newest;
}

/**
 * Prune a backup dir to the `retention` newest artifacts (#327). Matches ONLY
 * files named `hicortex-*.tar.gz` (the nightly/CLI artifact pattern) — anything
 * else in the dir (operator copies, notes) is never touched. Keeps the newest
 * `retention` by mtime, with the ISO filename (time-ordered by construction)
 * as a DESCENDING tie-break so equal mtimes resolve deterministically (the
 * just-written artifact is the newest and always survives); deletes the rest,
 * oldest first. `retention <= 0` keeps all.
 *
 * Best-effort by design: a per-file unlink failure logs and continues (a
 * stale extra artifact is cheap; failing the nightly AFTER a good backup was
 * written is not). Returns the number actually removed.
 */
export function pruneBackupArtifacts(dir: string, retention: number): number {
  if (!Number.isFinite(retention) || retention <= 0) return 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    // Missing/unreadable dir — nothing to prune (e.g. a fresh install).
    return 0;
  }
  const artifacts = names
    .filter((n) => /^hicortex-.*\.tar\.gz$/.test(n))
    .map((n) => {
      const abs = join(dir, n);
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(abs).mtimeMs;
      } catch {
        // Raced/unreadable — sort it oldest so the prune attempt happens
        // anyway (force-unlink below may still succeed).
      }
      return { name: n, abs, mtimeMs };
    })
    // Newest first; the ISO filename (`hicortex-<ISO>.tar.gz`) is time-ordered
    // by construction, so it is the tie-break in DESCENDING order — identical
    // mtimes (same-second writes, or an operator restoring a copy) otherwise
    // leave the retention boundary to readdir order, which is FS-arbitrary
    // and can differ run to run (#327 CR).
    .sort(
      (a, b) =>
        b.mtimeMs - a.mtimeMs ||
        (a.name < b.name ? 1 : a.name > b.name ? -1 : 0),
    );

  const doomed = artifacts.slice(Math.floor(retention));
  let pruned = 0;
  for (const a of doomed) {
    try {
      rmSync(a.abs, { force: true });
      pruned++;
    } catch (err) {
      console.error(
        `[hicortex] backup retention: could not prune ${a.abs}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (pruned > 0) {
    console.log(
      `[hicortex] Backup retention: pruned ${pruned} old artifact(s), ` +
        `keeping ${artifacts.length - pruned}`,
    );
  }
  return pruned;
}

/**
 * Recursively append every regular file under `absDir` to `entries`, with
 * in-tar paths rooted at `relRoot`. Symlinks are SKIPPED (security — a symlink
 * in identity/ could escape home; the identity store already lstat-skips them
 * on read, and we do the same on backup so a restored tree can't point outside
 * itself). Missing dir = no-op (fresh install may have no identity/ yet).
 */
function appendTree(entries: TarEntry[], absDir: string, relRoot: string): void {
  if (!existsSync(absDir)) return;
  const walk = (dir: string, rel: string) => {
    let ents;
    try {
      ents = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
    } catch {
      // EACCES / transient — skip this subtree rather than aborting the backup.
      return;
    }
    for (const ent of ents) {
      // withFileTypes uses the entry's own type (not the target's), so a symlink
      // is correctly identified without an extra lstat — skip symlinks so a
      // link in identity/ can't escape home into the tarball.
      const abs = join(dir, ent.name);
      const relPath = join(rel, ent.name);
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        walk(abs, relPath);
      } else if (ent.isFile()) {
        // Normalize to forward slashes for tar (posix convention), even though
        // join already produces them on mac/linux.
        entries.push({ name: relPath.split("\\").join("/"), file: abs });
      }
    }
  };
  walk(absDir, relRoot);
}

// (Extraction of a backup artifact is intentionally NOT in this module: the
// restore path is manual for Phase 0 (spec §8) and tested directly via
// tar-stream's extract() in tests/backup.test.ts. A future `hicortex restore`
// command would grow its own module; packaging + extraction don't belong
// together — one writes artifacts, the other consumes them.)

/**
 * Push a single regular file onto `entries` if it exists. Skips symlinks and
 * non-files (the state files are plain files; a symlink here would be suspect).
 */
function pushIfExists(entries: TarEntry[], abs: string, name: string): void {
  try {
    const st = lstatSync(abs);
    if (st.isFile()) entries.push({ name, file: abs });
  } catch {
    // ENOENT or unreadable — skip. A fresh install may lack capture-cursors.json.
  }
}

// ---------------------------------------------------------------------------
// CLI runner — `hicortex backup`. Mirrors runDedup: flag-parsed options from
// cli.ts, this owns config load + DB open + createBackup + hook + close.
// ---------------------------------------------------------------------------

export interface BackupCliOptions {
  /** `--out <dir>` — output directory (the artifact is auto-named). Takes precedence over `config.backupDir`. Mutually exclusive with stdout. */
  outDir?: string;
  /** `--stdout` — stream the tar.gz to process.stdout (offsite pipe pattern). */
  stdout?: boolean;
}

/**
 * Run the `hicortex backup` CLI command. Loads config (for `backupDir` /
 * `backupCommand`), opens the DB, writes (or streams) the artifact, runs the
 * offsite hook when configured, prints the artifact path, and exits non-zero on
 * any failure (a failed backup must be visible — `cron`/launchd surfaces it).
 */
export async function runBackupCli(opts: BackupCliOptions): Promise<void> {
  const home = hicortexHome();
  const { config } = loadConfigStrict(join(home, "config.json"));

  const backupDir =
    typeof config.backupDir === "string" && config.backupDir.trim()
      ? config.backupDir
      : undefined;
  const backupCommand =
    typeof config.backupCommand === "string" && config.backupCommand.trim()
      ? config.backupCommand
      : undefined;
  // Same reader + default as the nightly stage (#327) — one knob everywhere.
  const retention = readNonNegativeConfig(config, "backupRetention", DEFAULT_BACKUP_RETENTION);

  const db = initDb(resolveDbPath());
  try {
    const result = await createBackup({
      db,
      home,
      // CLI `--out <dir>` takes precedence over the config `backupDir`. When
      // --stdout is set, don't forward backupDir at all — a configured backupDir
      // (for the nightly) must not block a manual --stdout stream (the mutual-
      // exclusivity check would otherwise reject it).
      outDir: opts.stdout ? undefined : (opts.outDir ?? backupDir),
      stdout: opts.stdout,
      retention,
    });

    if (result.path) {
      console.log(
        `[hicortex] Backup written: ${result.path} ` +
          `(${result.files} files, ${result.bytes.toLocaleString()} bytes)`,
      );
    } else {
      console.error(
        `[hicortex] Backup streamed to stdout (${result.files} files, ${result.bytes.toLocaleString()} bytes compressed)`,
      );
    }

    // Only run the hook when we have an on-disk artifact path to hand it. The
    // --stdout path is already an offsite transport (piped to rclone/aws/B2),
    // so a second hook would double-ship.
    if (result.path && backupCommand) {
      const hook = await runBackupHook(result.path, backupCommand);
      if (!hook.ok) {
        console.error(
          `[hicortex] Backup hook failed (exit ${hook.exitCode ?? "n/a"}). ` +
            `Artifact is on disk; offsite copy did NOT complete.`,
        );
        process.exitCode = 1;
        return;
      }
      console.log(`[hicortex] Backup hook ok (exit 0).`);
    }
  } finally {
    db.close();
  }
}
