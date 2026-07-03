/**
 * Hermes transcript reader — the nightly capture path for Nous Research Hermes.
 *
 * Hermes stores conversation in a SQLite state DB, one per profile:
 *   ~/.hermes/profiles/<profile>/state.db   (per-profile agents: lenny, raider, nano)
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
 * We process only ENDED sessions (ended_at set) that ended since the last run.
 * A live session is distilled after it ends — this avoids partial-session
 * distillation and keeps per-session dedup clean (chunks are stored as
 * `<sessionId>#<chunkIndex>`; see nightly.ts).
 */

import { readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import Database from "better-sqlite3";
import type { TranscriptBatch } from "./transcript-reader.js";

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
  role: string;
  content: string | null;
  tool_name: string | null;
  timestamp: number;
}

/**
 * Read Hermes sessions that ended since `since`, across all profiles.
 * Returns one batch per session, parallel to readCcTranscripts().
 */
export function readHermesSessions(
  since: Date,
  hermesHome = HERMES_HOME
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
      const sessions = db
        .prepare(
          "SELECT id, ended_at, source FROM sessions WHERE ended_at IS NOT NULL AND ended_at > ? ORDER BY ended_at"
        )
        .all(sinceEpoch) as HermesSessionRow[];

      const msgStmt = db.prepare(
        "SELECT role, content, tool_name, timestamp FROM messages WHERE session_id = ? ORDER BY timestamp, id"
      );

      for (const s of sessions) {
        // Skip automated (non-primary) sessions — cron runs are not
        // conversations and would pollute memory. Checked before pulling
        // messages so we don't even read them.
        if (NON_PRIMARY_SOURCES.has(s.source)) continue;

        const rows = msgStmt.all(s.id) as HermesMessageRow[];
        // Skip only genuinely empty sessions. Do NOT gate on message count —
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

        const endTs = s.ended_at ?? rows[rows.length - 1].timestamp;
        batches.push({
          sessionId: s.id,
          projectName: profile,
          sourceAgent: `hermes/${profile}`,
          date: new Date(endTs * 1000).toISOString().slice(0, 10),
          entries,
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
