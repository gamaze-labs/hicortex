/**
 * Hermes transcript reader — the nightly capture path for Nous Research Hermes.
 *
 * Hermes stores conversation in a SQLite state DB, one per profile:
 *   ~/.hermes/profiles/<profile>/state.db   (per-profile agents: alice, bob, carol)
 *   ~/.hermes/state.db                       (global, non-profile setups)
 *
 * Schema (relevant columns):
 *   sessions(id TEXT PK, started_at REAL, ended_at REAL, ...)
 *   messages(session_id TEXT, role TEXT, content TEXT, tool_name TEXT, timestamp REAL, active INT, ...)
 *
 * Compaction is NON-DESTRUCTIVE (compacted-out turns kept with active=0) and
 * sessions are retained ~90 days — so the full history of any ended session is
 * readable here nightly. No runtime plugin capture is needed; the Hermes plugin
 * is recall-only.
 *
 * We process ENDED sessions (ended_at set) that ended since the last run PLUS
 * OPEN sessions (ended_at NULL) that have messages — a Discord conversation is
 * one long-lived thread that stays open and accrues content, so gating only on
 * ended_at would drop the whole interactive corpus (#240). Open sessions are
 * delta-sliced by the per-session cursor; per-session dedup stays clean
 * (chunks are stored as `<sessionId>#<chunkIndex>`; see nightly.ts).
 */

import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import Database from "better-sqlite3";
import type { TranscriptBatch, CursorMap } from "./transcript-reader.js";

const HERMES_HOME = process.env.HERMES_HOME || join(homedir(), ".hermes");

/**
 * Session `source` values that are NOT primary conversations and must not be
 * captured — capturing them would pollute long-term memory with automated,
 * non-conversational runs. `cron` is Hermes' scheduled-task source (garmin
 * syncs, daily scans, self-reflection loops). This mirrors the MemoryProvider
 * contract's own guidance to skip non-primary `agent_context` (e.g. "cron").
 * Everything else (cli, discord, telegram, slack, …) is a real conversation.
 */
const NON_PRIMARY_SOURCES = new Set(["cron"]);

/**
 * Message roles that are metadata/noise, not conversation — mapped so the
 * distiller's extractConversationText drops them (it skips "tool_result").
 */
const NOISE_ROLES = new Set(["tool", "session_meta"]);

interface HermesSessionRow {
  id: string;
  ended_at: number | null;
  source: string;
}

interface HermesMessageRow {
  id: number;
  role: string;
  content: string | null;
  tool_name: string | null;
  timestamp: number;
}

/**
 * Read Hermes sessions across all profiles: ended sessions newer than `since`
 * (the bulk watermark) PLUS open sessions (`ended_at IS NULL`) that have any
 * message. Returns one batch per session, parallel to readCcTranscripts().
 *
 * Why open sessions are included (#240): in Hermes' Discord model a
 * conversation is one long-lived thread = one session that stays open for
 * days/weeks and accumulates the interactive content. The per-session cursor
 * slices each such thread to its unseen delta across runs (same discover-
 * broadly / delta-narrowly model as CC readers).
 *
 * @param cursors Per-session capture cursors (#189), keyed `hermes:<profile>:<sid>`.
 *   The cursor value is the max `messages.id` already captured; a resumed +
 *   re-ended session yields only the new rows (`id > cursor`).
 */
export function readHermesSessions(
  since: Date,
  hermesHome = HERMES_HOME,
  cursors: CursorMap = {}
): TranscriptBatch[] {
  const batches: TranscriptBatch[] = [];
  const sinceEpoch = since.getTime() / 1000; // Hermes timestamps are unix seconds (REAL)

  for (const { profile, dbPath } of discoverProfileDbs(hermesHome)) {
    let db: Database.Database;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
    } catch {
      continue; // locked / unreadable / wrong owner — skip, retry next run
    }

    try {
      // Discovery (#240): ended sessions past the watermark (bulk) PLUS open
      // sessions (ended_at IS NULL) that have any message. In Hermes' Discord
      // model a conversation is ONE long-lived thread = one session that stays
      // open for days/weeks and accumulates essentially all the interactive
      // content. Gating discovery only on `ended_at IS NOT NULL` meant those
      // open threads were NEVER discovered → distilled — the entire interactive
      // corpus was silently dropped. The per-session cursor below slices each
      // open session to its unseen delta across runs (same model as CC: discover
      // broadly, delta narrowly), and `rows.length === 0` skips an open session
      // that is already current. The EXISTS probe is one cheap check per open
      // session (typically one open thread per agent).
      const sessions = db
        .prepare(
          `SELECT id, ended_at, source FROM sessions
            WHERE (ended_at IS NOT NULL AND ended_at > ?)
               OR (ended_at IS NULL AND EXISTS (
                     SELECT 1 FROM messages WHERE messages.session_id = sessions.id
                   ))
            ORDER BY (ended_at IS NULL), ended_at`
        )
        .all(sinceEpoch) as HermesSessionRow[];

      // Cursor is a message id (INTEGER PRIMARY KEY AUTOINCREMENT — strictly
      // increasing, never reused), so `id > ?` returns exactly the rows added
      // since last capture. ORDER BY id (NOT timestamp): id is the capture
      // boundary, so ordering rows by id makes entryCursors monotonic and the
      // last row's id the true max consumed — the segment boundary the packer
      // advances to is then genuinely the largest id, never skipping a
      // lower-id-but-later-timestamp row. Verified safe: id order == timestamp
      // order in production (A1: 0 divergences / 4413 rows), so text ordering is
      // unchanged in practice.
      const msgStmt = db.prepare(
        "SELECT id, role, content, tool_name, timestamp FROM messages WHERE session_id = ? AND id > ? ORDER BY id"
      );
      // Highest id in the session — used only for the shrink guard below.
      const maxIdStmt = db.prepare(
        "SELECT MAX(id) as m FROM messages WHERE session_id = ?"
      );

      for (const s of sessions) {
        // Skip automated (non-primary) sessions — cron runs are not
        // conversations and would pollute memory. Checked before pulling
        // messages so we don't even read them.
        if (NON_PRIMARY_SOURCES.has(s.source)) continue;

        const cursorKey = `hermes:${profile}:${s.id}`;
        const pos = cursors[cursorKey] ?? { cursor: 0, gen: 0 };
        let startCursor = pos.cursor;
        let gen = pos.gen;

        // Shrink guard: if the stored cursor exceeds the session's max id (DB
        // reset/restore), re-read from 0 and bump the generation (fix 8). Cheap
        // MAX(id) probe; the common path (cursor <= max) leaves it untouched.
        if (startCursor > 0) {
          const maxId = (maxIdStmt.get(s.id) as { m: number | null }).m ?? 0;
          if (startCursor > maxId) {
            startCursor = 0;
            gen = pos.gen + 1;
          }
        }

        const rows = msgStmt.all(s.id, startCursor) as HermesMessageRow[];
        // Skip only genuinely empty deltas. Do NOT gate on message count —
        // a short 2-message exchange can carry a real decision. Meaningful-
        // content is gated downstream by the post-denoise 200-char check in
        // nightly.ts, so short-but-dense sessions aren't dropped here.
        if (rows.length === 0) continue;

        // Map Hermes rows to the shape extractConversationText() understands
        // (it reads m.role + m.content). Metadata/noise roles (tool results,
        // session_meta) are relabelled "tool_result" so the distiller drops them.
        const entries = rows.map((r) => ({
          role: NOISE_ROLES.has(r.role) ? "tool_result" : r.role,
          content: r.content ?? "",
        }));
        // entryCursors are the row ids, monotonic under ORDER BY id — the last
        // is the max consumed id, so segment boundaries and the final advance
        // land exactly on it.
        const entryCursors = rows.map((r) => r.id);

        const endTs = s.ended_at ?? rows[rows.length - 1].timestamp;
        batches.push({
          sessionId: s.id,
          projectName: profile,
          sourceAgent: `hermes/${profile}`,
          date: new Date(endTs * 1000).toISOString().slice(0, 10),
          entries,
          cursorKey,
          startCursor,
          generation: gen,
          entryCursors,
        });
      }
    } catch {
      // Query failed (schema drift on a Hermes upgrade) — skip this DB, don't crash the run.
    } finally {
      db.close();
    }
  }

  return batches;
}

/**
 * Find every Hermes state DB: one per profile, plus the global DB for
 * non-profile installs. The profile name becomes the provenance label.
 */
function discoverProfileDbs(
  hermesHome: string
): Array<{ profile: string; dbPath: string }> {
  const out: Array<{ profile: string; dbPath: string }> = [];

  const profilesDir = join(hermesHome, "profiles");
  try {
    for (const entry of readdirSync(profilesDir)) {
      if (entry.startsWith(".") || entry.startsWith("_")) continue;
      const dbPath = join(profilesDir, entry, "state.db");
      try {
        if (statSync(dbPath).isFile()) out.push({ profile: entry, dbPath });
      } catch {
        // no state.db for this profile
      }
    }
  } catch {
    // no profiles dir
  }

  const globalDb = join(hermesHome, "state.db");
  if (existsSync(globalDb)) out.push({ profile: "default", dbPath: globalDb });

  return out;
}
