/**
 * #642 AC-11 — the observed-agents store: read-side agent names, persisted
 * for the first time.
 *
 * Before this store, the only agent names the server ever saw were
 * capture-time `source_agent` stamps — a workspace that had PROMPTED but not
 * yet been captured (its first nightly is hours away) was invisible to the
 * dashboard, so the operator could not assign it to a space exactly when the
 * "what is this new folder?" question first arises. First-prompt discovery
 * closes that gap: the ONE seam every gated read already calls
 * (requesterVisibleSpaces in mcp-server.ts) records the sanitized `agent`
 * param, and the dashboard's spaces block (AC-10/AC-12) lists every observed
 * agent that is in no space's members as UNASSIGNED.
 *
 * Storage-style module (the db.ts/storage.ts layout): recordObservedAgent is
 * the raw upsert (throws on store errors like any storage fn);
 * recordObservedAgentSighting is the fail-soft READ-seam wrapper — a store
 * hiccup must never break the read itself (the sighting is advisory metadata,
 * not a gate input), so it sanitizes, swallows store errors with ONE
 * lifetime warn, and hands back the sanitized id so the caller resolves
 * membership from the SAME value it recorded.
 */

import type Database from "better-sqlite3";
import { sanitizeAgentId } from "./identity-store.js";

/** One observed workspace/agent: firstSeen is its discovery time (never
 *  rewritten), lastSeen its most recent gated read (the dashboard's
 *  "newest first" ordering). */
export interface ObservedAgent {
  agent: string;
  first_seen: string;
  last_seen: string;
}

/**
 * Upsert one observed agent: first_seen is PRESERVED on conflict (discovery
 * is a fact about the past), last_seen always advances to now. One
 * INSERT ... ON CONFLICT statement — no read-modify-write race window between
 * two concurrent reads of the same agent.
 */
export function recordObservedAgent(db: Database.Database, agent: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO observed_agents (agent, first_seen, last_seen) VALUES (?, ?, ?)
     ON CONFLICT(agent) DO UPDATE SET last_seen = excluded.last_seen`,
  ).run(agent, now, now);
}

/**
 * Every observed agent, newest activity first (last_seen DESC, agent ASC as
 * the deterministic tiebreak — ISO timestamps share ms, not everybody sleeps
 * between prompts). The GET /spaces adapter feeds this straight into the
 * unassigned computation.
 */
export function listObservedAgents(db: Database.Database): ObservedAgent[] {
  return db
    .prepare(
      `SELECT agent, first_seen, last_seen FROM observed_agents
       ORDER BY last_seen DESC, agent ASC`,
    )
    .all() as ObservedAgent[];
}

/** Once-per-process warn flag: a broken store errors on EVERY read, and the
 *  read must keep working — one warn line, then silence. */
let warnedStoreFailure = false;

/**
 * The read-seam wrapper requesterVisibleSpaces calls on every gated read:
 * sanitize the raw `agent` (the ?agent=/body agent namespace — invalid or
 * absent records nothing), upsert it, and return the sanitized id for the
 * caller's membership resolution. Fail-soft by design: the observed-agents
 * store is advisory (first-prompt discovery), so a store hiccup logs ONE
 * lifetime warn and never breaks the read that triggered it.
 */
export function recordObservedAgentSighting(
  db: Database.Database,
  rawAgent: unknown,
): string | null {
  const id = typeof rawAgent === "string" && rawAgent ? sanitizeAgentId(rawAgent) : null;
  if (!id) return null;
  try {
    recordObservedAgent(db, id);
  } catch (err) {
    if (!warnedStoreFailure) {
      warnedStoreFailure = true;
      console.warn(
        `[hicortex] observed-agents store unavailable — first-prompt discovery paused ` +
          `(reads are unaffected). Cause: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return id;
}
