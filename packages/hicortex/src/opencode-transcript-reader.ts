/**
 * opencode transcript reader — the nightly capture path for the opencode
 * coding agent (#347).
 *
 * opencode persists every session in ONE SQLite store:
 *   ~/.local/share/opencode/opencode.db
 *
 * Schema (relevant columns, verified live on opencode 1.18.20/1.18.23):
 *   session(id TEXT PK, directory TEXT, parent_id TEXT NULL,
 *           time_created INTEGER, time_updated INTEGER)  — epoch MILLISECONDS
 *   message(id TEXT PK, session_id TEXT, time_created INTEGER,
 *           time_updated INTEGER, data TEXT)             — data = {"role",…}
 *   part(id TEXT PK, message_id TEXT, time_created INTEGER, data TEXT)
 *                                                         — data = {"type","text",…}
 *
 * The message row holds METADATA ONLY (role, model, cost — no text); the
 * conversation text lives in the message's part rows as
 * {"type":"text","text":…}. part types tool/reasoning/step-start/step-finish
 * are plumbing, not conversation, and are excluded by the `$.type`='text'
 * filter. A message left with no text yields no entry.
 *
 * Cursor: message.time_created (epoch ms) — deliberately NOT rowid. message
 * has a TEXT primary key, so rowid is implicit, reusable after the
 * session-delete cascade and renumbered by VACUUM — a stored rowid cursor can
 * silently skip rows (loss, breaking the dup-over-loss invariant). Unlike the
 * Hermes cursor column (INTEGER PRIMARY KEY AUTOINCREMENT — strictly
 * increasing, never reused), time_created is never rewritten. The delta is
 * EXCLUSIVE (`time_created > cursor`, ORDER BY time_created, id — the id
 * tie-break makes the order total) so a rediscovered session with no new
 * messages produces an empty delta and posts nothing; segment ids stay
 * byte-stable for the server's segment-exact dedup. Residual gap: two
 * messages written in the same millisecond with the capture boundary inside
 * that group — bounded by that group's size, not observed on real data
 * (smallest observed inter-message gap 13 ms).
 *
 * Sub-agent sessions (session.parent_id set) are skipped, mirroring the CC
 * reader's isSidechain drop. Written defensively: parent_id was NULL for
 * every session on the verified installs, so whether opencode populates it
 * is unconfirmed — the skip costs nothing if the column stays empty.
 *
 * Marker-fenced text parts (Hicortex injection echo) are skipped so memory
 * never re-enters itself — defense in depth: the recall channel the opencode
 * plugin uses (experimental.chat.messages.transform) is verified NOT to
 * persist its output, but the reader guards regardless.
 *
 * No-ops (returns []) when the database, a table, or a column is absent —
 * the schema is young (migration tables present), so the reader
 * shape-guards and never crashes the nightly run.
 */

import { existsSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import Database from "better-sqlite3";
import type { TranscriptBatch, CursorMap } from "./transcript-reader.js";

const OPENCODE_DATA_HOME = join(homedir(), ".local", "share", "opencode");

/**
 * Fence around every block the opencode plugin injects (opencode-plugin/
 * hicortex/index.ts CONTEXT_START/END). Duplicated here because the plugin
 * is dependency-free and outside the package — keep the strings in sync.
 */
const FENCE_START = "<!-- hicortex-context-start -->";
const FENCE_END = "<!-- hicortex-context-end -->";

interface OpencodeSessionRow {
  id: string;
  directory: string | null;
  parent_id: string | null;
}

interface OpencodeMessageRow {
  id: string;
  time_created: number;
  role: string | null;
}

/**
 * Read opencode sessions updated since `since` (the bulk watermark; opencode
 * times are epoch milliseconds, so `since.getTime()` compares directly —
 * NO *1000, unlike the Hermes reader's unix-seconds store). Returns one
 * batch per session, parallel to readHermesSessions().
 *
 * @param opencodeHome opencode's data dir (default
 *   ~/.local/share/opencode); injectable for tests.
 * @param cursors Per-session capture cursors (#189), keyed
 *   `opencode:<sessionId>`. The cursor value is the highest captured
 *   message.time_created; the delta is exclusive (`time_created > cursor`).
 */
export function readOpencodeSessions(
  since: Date,
  opencodeHome = OPENCODE_DATA_HOME,
  cursors: CursorMap = {},
): TranscriptBatch[] {
  const dbPath = join(opencodeHome, "opencode.db");
  if (!existsSync(dbPath)) return []; // no opencode on this machine

  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return []; // locked / unreadable — skip, retry next run
  }

  const batches: TranscriptBatch[] = [];
  try {
    // Discovery: sessions touched since the watermark. parent_id IS NULL
    // drops sub-agent sessions (the CC isSidechain equivalent).
    const sessions = db
      .prepare(
        `SELECT id, directory, parent_id FROM session
          WHERE time_updated > ? AND parent_id IS NULL
          ORDER BY time_created`
      )
      .all(since.getTime()) as OpencodeSessionRow[];

    // Delta rows for one session. EXCLUSIVE on time_created; the id
    // tie-break makes the read order total when two messages share a
    // millisecond. json_extract pulls the role out of the JSON data column.
    const msgStmt = db.prepare(
      `SELECT id, time_created, json_extract(data, '$.role') AS role
         FROM message
        WHERE session_id = ? AND time_created > ?
        ORDER BY time_created, id`
    );
    // The message's text parts in part.time_created order (distinct within a
    // message on real data, so the join order is deterministic). Non-text
    // part types (tool/reasoning/step-start/step-finish) are excluded here.
    const partStmt = db.prepare(
      `SELECT json_extract(data, '$.text') AS text
         FROM part
        WHERE message_id = ? AND json_extract(data, '$.type') = 'text'
        ORDER BY time_created`
    );
    // Highest time_created in the session — used only for the shrink guard.
    const maxStmt = db.prepare(
      "SELECT MAX(time_created) AS m FROM message WHERE session_id = ?"
    );

    for (const s of sessions) {
      const cursorKey = `opencode:${s.id}`;
      const pos = cursors[cursorKey] ?? { cursor: 0, gen: 0 };
      let startCursor = pos.cursor;
      let gen = pos.gen;

      // Shrink guard (the Hermes fix-8 pattern): a stored cursor above the
      // session's max time_created means the DB was reset/restored — re-read
      // from 0 and bump the generation so post-reset segment ids can't
      // collide with pre-reset ones on the server's content-blind dedup.
      if (startCursor > 0) {
        const max = (maxStmt.get(s.id) as { m: number | null }).m ?? 0;
        if (startCursor > max) {
          startCursor = 0;
          gen = pos.gen + 1;
        }
      }

      const rows = msgStmt.all(s.id, startCursor) as OpencodeMessageRow[];
      if (rows.length === 0) continue; // empty delta — nothing to post

      const entries: Array<{ role: string; content: string }> = [];
      const entryCursors: number[] = [];
      for (const r of rows) {
        const parts = partStmt.all(r.id) as Array<{ text: string | null }>;
        const content = parts
          .map((p) => (typeof p.text === "string" ? p.text : ""))
          // Fenced parts are Hicortex injection echo, not conversation.
          .filter((t) => t !== "" && !t.includes(FENCE_START) && !t.includes(FENCE_END))
          .join("\n");
        // A message with no surviving text (tool-only / fenced-only) yields
        // no entry. It also stays unconsumed (the cursor advances only to the
        // last ENTRY), so it is re-scanned next run — dup-over-loss, and the
        // entryless tail costs one no-op query until a text message lands.
        if (content.trim() === "") continue;
        // A NULL role passes through as "" — extractConversationText renders
        // anything not "user" as ASSISTANT, so no turn is fabricated.
        entries.push({ role: r.role ?? "", content });
        entryCursors.push(r.time_created); // one end-cursor per entry
      }
      if (entries.length === 0) continue; // entryless delta posts nothing

      // date = the delta's LAST message time — already milliseconds, so
      // unlike the Hermes reader there is no *1000 (copying that line would
      // put the date ~57,000 years out).
      batches.push({
        sessionId: s.id,
        projectName: basename(s.directory ?? "") || "opencode",
        sourceAgent: "opencode",
        date: new Date(rows[rows.length - 1].time_created).toISOString().slice(0, 10),
        entries,
        cursorKey,
        startCursor,
        generation: gen,
        entryCursors,
      });
    }
  } catch {
    // Query failed (schema drift on an opencode upgrade) — no-op, don't crash the run.
    return [];
  } finally {
    db.close();
  }

  return batches;
}
