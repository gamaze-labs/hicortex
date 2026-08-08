/**
 * /dashboard — view-only memory analytics (#224).
 *
 * STRICTLY view-only: this module computes metrics, reads snapshots, writes
 * ONE snapshot row per full nightly run (the writer is here because the
 * metric SQL lives next to its definition, not in nightly.ts), and exposes
 * the pure data handler mounted at GET /dashboard/data. There are NO mutation
 * endpoints on the dashboard surface — the only write path is the nightly
 * snapshot writer + the one-time backfill, both internal.
 *
 * Layering (mirrors how recall-index.ts holds pure logic and viz.ts holds
 * thin express adapters): all metric SQL + snapshot shape lives HERE so it
 * can be unit-tested without booting express. viz.ts owns only the HTML
 * shell handler + the auth exemption; mcp-server.ts wires both.
 *
 * Headline metric: uses-per-showing = SUM(access_count) / SUM(shown_count)
 * across the corpus — the recall-quality signal (#192 adoption aggregate,
 * promoted to a top-line metric here). Divide-by-zero → null (no showings
 * means undefined, not zero).
 */

import type express from "express";
import type Database from "better-sqlite3";

import { formatIndexLine } from "./recall-index.js";
import { readPositiveConfig } from "./config-read.js";

// ---------------------------------------------------------------------------
// Types — the JSON blob shape documented in the issue (a stable contract the
// HTML page renders against; new keys can be added, existing ones stay).
// ---------------------------------------------------------------------------

/** Corpus-shape snapshot. `adoption` is null in backfilled rows (point-in-time,
 *  can't be reconstructed from created_at). */
export interface DashboardMetrics {
  totals: { mem: number; lesson: number; link: number };
  by_type: Record<string, number>;
  by_domain: Record<string, number>;
  by_source_agent: Record<string, number>;
  /** Per-run deltas; undefined on backfilled rows (created_at can't reconstruct
   *  what a given nightly produced). */
  new_this_run?: {
    added: number;
    lessonsGenerated?: number;
    dedup: number;
    supersession: number;
  };
  /** Recall adoption aggregate. Null in backfilled rows. uses_per_showing is
   *  null when shown_sum = 0 (divide-by-zero guard). */
  adoption?: {
    shown_sum: number;
    used_sum: number;
    cold_count: number;
    uses_per_showing: number | null;
  };
}

/** One row of the snapshot series (run_at + parsed metrics). */
export interface DashboardSnapshot {
  run_at: string;
  metrics: DashboardMetrics;
}

/** The /dashboard/data response — the full payload the page renders. */
export interface DashboardData {
  range: "7d" | "30d" | "90d" | "all";
  headline: {
    total_memories: number;
    uses_per_showing: number | null;
    cold_count: number;
  };
  series: DashboardSnapshot[];
  composition: {
    by_type: Record<string, number>;
    by_domain: Record<string, number>;
    by_source_agent: Record<string, number>;
  };
  digest: {
    date: string | null;
    run_at: string | null;
    sample: { id: string; line: string; created_at: string }[];
    lessons: { id: string; content: string; created_at: string }[];
    stages: { lessonsGenerated?: number; dedup: number; supersession: number; added: number };
    dedup_merges: {
      loser_id: string;
      canonical_id: string;
      content_head: string | null;
      merged_at: string;
    }[];
  };
}

// ---------------------------------------------------------------------------
// Metric computation — one SELECT each, prepared inline. Pure: takes a db,
// returns a value. No side effects, no I/O beyond the open db handle.
// ---------------------------------------------------------------------------

function countBy(db: Database.Database, col: string): Record<string, number> {
  // Column name is from a fixed allowlist at the call site (never user input).
  const rows = db
    .prepare(
      `SELECT COALESCE(${col}, '(unscoped)') AS k, COUNT(*) AS c
         FROM memories
        GROUP BY ${col}`
    )
    .all() as Array<{ k: string; c: number }>;
  const out: Record<string, number> = {};
  for (const r of rows) out[r.k] = r.c;
  return out;
}

/**
 * Compute the full corpus-shape metrics from the live DB. The same function
 * backs both the nightly snapshot writer and the live /dashboard/data
 * composition view — one definition of corpus shape.
 */
export function computeDashboardMetrics(db: Database.Database): DashboardMetrics {
  const mem = (
    db.prepare("SELECT COUNT(*) AS c FROM memories").get() as { c: number }
  ).c;
  const lesson = (
    db
      .prepare("SELECT COUNT(*) AS c FROM memories WHERE memory_type = 'lesson'")
      .get() as { c: number }
  ).c;
  const link = (
    db.prepare("SELECT COUNT(*) AS c FROM memory_links").get() as { c: number }
  ).c;

  const adoptionRow = db
    .prepare(
      `SELECT
         COALESCE(SUM(shown_count), 0) AS shown,
         COALESCE(SUM(access_count), 0) AS uses,
         SUM(CASE WHEN COALESCE(shown_count, 0) = 0
                   AND COALESCE(access_count, 0) = 0 THEN 1 ELSE 0 END) AS cold
         FROM memories`
    )
    .get() as { shown: number; uses: number; cold: number };

  return {
    totals: { mem, lesson, link },
    by_type: countBy(db, "memory_type"),
    by_domain: countBy(db, "domain"),
    by_source_agent: countBy(db, "source_agent"),
    adoption: {
      shown_sum: adoptionRow.shown,
      used_sum: adoptionRow.uses,
      cold_count: adoptionRow.cold,
      // Divide-by-zero guard: no showings → undefined adoption, not 0.
      uses_per_showing:
        adoptionRow.shown > 0
          ? Number((adoptionRow.uses / adoptionRow.shown).toFixed(4))
          : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Snapshot writer — runs at the end of each FULL nightly only (never
// capture-only). The `new_this_run` deltas are passed in by nightly.ts (it
// already has the report + dedup/supersession counts in scope); adoption +
// corpus shape are recomputed here from the live DB (one source of truth).
// ---------------------------------------------------------------------------

export interface NightlyDelta {
  added: number;
  lessonsGenerated?: number;
  dedup: number;
  supersession: number;
}

/**
 * Write one snapshot row for `runAt` (an ISO timestamp the caller chooses —
 * nightly.ts passes `now`). OR-replace on the PRIMARY KEY is intentional: a
 * manual re-run for the same instant overwrites, the nightly never produces
 * two rows for the same instant. Returns the row that was written.
 */
export function writeSnapshot(
  db: Database.Database,
  runAt: string,
  delta: NightlyDelta,
): DashboardSnapshot {
  const metrics = computeDashboardMetrics(db);
  metrics.new_this_run = {
    added: delta.added,
    lessonsGenerated: delta.lessonsGenerated,
    dedup: delta.dedup,
    supersession: delta.supersession,
  };
  db.prepare(
    "INSERT OR REPLACE INTO dashboard_snapshots (run_at, metrics) VALUES (?, ?)",
  ).run(runAt, JSON.stringify(metrics));
  return { run_at: runAt, metrics };
}

// ---------------------------------------------------------------------------
// Backfill — synthesize one snapshot per day from memories.created_at so the
// growth/composition charts have history on day one. Adoption is point-in-time
// and CANNOT be reconstructed from created_at, so backfilled rows OMIT it
// (the page treats undefined as "no data for this day"). See backfillSnapshots
// for the full derivation.
// ---------------------------------------------------------------------------

function utcDay(iso: string): string {
  // created_at is ISO; slice the YYYY-MM-DD prefix. Best-effort — malformed
  // rows fall to the '(unknown)' bucket (rare; created_at is NOT NULL by the
  // insert contract, but legacy imports can carry odd shapes).
  const d = iso.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : "(unknown)";
}

/**
 * When the dashboard_snapshots table is empty, synthesize one row per day from
 * existing memories. Idempotent (only runs when the table is empty — the
 * caller gates on that). Returns the number of rows written.
 *
 * Rows are keyed with a SYNTHETIC ISO timestamp `<YYYY-MM-DD>T00:00:00.000Z`
 * (start of the UTC day), NOT a `backfill-` string prefix. The column is a
 * timestamp sort key everywhere it is read (nightly delta floor, series ASC,
 * digest-day picker), so the value MUST sort like a real ISO timestamp. A
 * `backfill-` prefix would sort AFTER every `2xxx-...` ISO value (`'b' 0x62 >
 * '2' 0x32`), silently breaking the delta floor and the chart ordering. Using
 * midnight-of-day means a real nightly for the same day (which runs later,
 * e.g. 03:00) sorts AFTER its day's backfill row — correct chronological
 * intent, and every `ORDER BY run_at` query is uniform with no special-casing.
 *
 * Derivation:
 *   - For each day D (UTC date of created_at), the row carries cumulative
 *     counts up to and including D (memories whose created_at <= end of D).
 *   - by_type / by_domain / by_source_agent are likewise cumulative slices.
 *   - new_this_run.added/dedup/supersession are derivable (row counts +
 *     timestamp aggregations); lessonsGenerated is NOT (a stage outcome) and
 *     stays undefined.
 *   - adoption is point-in-time and CANNOT be reconstructed from created_at,
 *     so backfilled rows OMIT it (the page treats undefined as "no data").
 */
export function backfillSnapshots(db: Database.Database): number {
  const existing = (
    db.prepare("SELECT COUNT(*) AS c FROM dashboard_snapshots").get() as {
      c: number;
    }
  ).c;
  if (existing > 0) return 0; // never overwrite real history

  // Build cumulative per-day counts in JS — a single query per dimension, then
  // accumulate. Cheaper than N window functions and the corpus is small enough
  // (the snapshot series is bounded by #days since first memory).
  type Row = { created_at: string; memory_type: string; domain: string | null; source_agent: string };
  const rows = db
    .prepare(
      "SELECT created_at, memory_type, domain, source_agent FROM memories ORDER BY created_at ASC",
    )
    .all() as Row[];

  // Daily dedup merges + supersession links (timestamp-derived → aggregable).
  const dedupByDay = new Map<string, number>();
  const dedupRows = db
    .prepare("SELECT merged_at FROM dedup_log")
    .all() as Array<{ merged_at: string }>;
  for (const r of dedupRows) {
    const d = utcDay(r.merged_at);
    dedupByDay.set(d, (dedupByDay.get(d) ?? 0) + 1);
  }

  const superByDay = new Map<string, number>();
  const superRows = db
    .prepare(
      "SELECT created_at FROM memory_links WHERE relationship = 'superseded_by'",
    )
    .all() as Array<{ created_at: string }>;
  for (const r of superRows) {
    const d = utcDay(r.created_at);
    superByDay.set(d, (superByDay.get(d) ?? 0) + 1);
  }

  // Accumulate.
  let mem = 0;
  let lesson = 0;
  let link = 0;
  const byType: Record<string, number> = {};
  const byDomain: Record<string, number> = {};
  const byAgent: Record<string, number> = {};
  // Cumulative link count — memory_links has no created_at? It DOES (schema
  // line 122). Aggregate the same way as memories.
  const linkRows = db
    .prepare("SELECT created_at FROM memory_links ORDER BY created_at ASC")
    .all() as Array<{ created_at: string }>;
  const linkDays = new Map<string, number>();
  for (const r of linkRows) {
    const d = utcDay(r.created_at);
    linkDays.set(d, (linkDays.get(d) ?? 0) + 1);
  }

  // Group memory rows by day, preserve ascending order.
  const byDay = new Map<string, Row[]>();
  for (const r of rows) {
    const d = utcDay(r.created_at);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d)!.push(r);
  }

  const allDays = Array.from(byDay.keys()).sort();
  if (allDays.length === 0) return 0; // nothing to backfill

  const insert = db.prepare(
    "INSERT OR REPLACE INTO dashboard_snapshots (run_at, metrics) VALUES (?, ?)",
  );

  // Walk days in order; each day's snapshot is cumulative THROUGH that day.
  // We include every memory's day — a backfill row only exists for a day with
  // at least one memory (the chart interpolates visually between sparse days).
  const tx = db.transaction(() => {
    for (const d of allDays) {
      const dayRows = byDay.get(d)!;
      for (const r of dayRows) {
        mem++;
        if (r.memory_type === "lesson") lesson++;
        byType[r.memory_type] = (byType[r.memory_type] ?? 0) + 1;
        const domKey = r.domain ?? "(unscoped)";
        byDomain[domKey] = (byDomain[domKey] ?? 0) + 1;
        byAgent[r.source_agent] = (byAgent[r.source_agent] ?? 0) + 1;
      }
      link += linkDays.get(d) ?? 0;
      const metrics: DashboardMetrics = {
        totals: { mem, lesson, link },
        by_type: { ...byType },
        by_domain: { ...byDomain },
        by_source_agent: { ...byAgent },
        // new_this_run on a backfill row = the deltas DERIVED for that day
        // (added/lesson/dedup/supersession); lessonsGenerated is undefined
        // (it's a stage-outcome, not a row count — can't be reconstructed).
        new_this_run: {
          added: dayRows.length,
          dedup: dedupByDay.get(d) ?? 0,
          supersession: superByDay.get(d) ?? 0,
        },
        // adoption intentionally omitted — point-in-time, not derivable.
      };
      insert.run(`${d}T00:00:00.000Z`, JSON.stringify(metrics));
    }
  });
  tx();

  return allDays.length;
}

// ---------------------------------------------------------------------------
// Data query — reads the snapshot series for the selected range, computes the
// LIVE composition (so day-one, before any snapshot is written, still shows
// the current corpus shape), and builds the digest for the selected day.
// ---------------------------------------------------------------------------

const VALID_RANGES = new Set(["7d", "30d", "90d", "all"]);
const DEFAULT_RANGE = "30d";
const DEFAULT_DIGEST_LIMIT = 10;

function rangeToCutoff(range: string): string | null {
  if (range === "all") return null;
  const days = parseInt(range, 10);
  if (!Number.isFinite(days)) return null;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return cutoff.toISOString();
}

/**
 * Render a memory row the SAME way the recall index does — imported directly
 * from recall-index.ts, never reimplemented. This is an acceptance criterion:
 * the dashboard cannot drift from what agents see. Returns the rendered line
 * plus the row's bare fields (the page links the id to /memory?id= and /viz).
 */
function renderIndexLine(
  row: {
    id: string;
    content: string;
    created_at: string;
    domain: string | null;
    project: string | null;
    source_agent: string | null;
    memory_type: string;
  },
  maxLen: number,
): { id: string; line: string; created_at: string } {
  // Shape matches MemorySearchResult & { domain } — formatIndexLine reads only
  // these fields. access_count / connections / score are not used by the
  // renderer (only provenance + title), so stubbing them is safe.
  const line = formatIndexLine(
    {
      id: row.id,
      content: row.content,
      score: 0,
      effective_strength: 0,
      access_count: 0,
      memory_type: row.memory_type,
      project: row.project,
      domain: row.domain,
      source_agent: row.source_agent,
      created_at: row.created_at,
      connections: 0,
    },
    maxLen,
  );
  return { id: row.id, line, created_at: row.created_at };
}

/**
 * The pure data handler for GET /dashboard/data. Reads query params
 * (`range`, `date`, `digestLimit`) off the request, returns the DashboardData
 * payload. Never throws on empty/missing data — returns a valid empty shape.
 *
 * `config` is the saved config object (for `dashboardDigestLimit`); it is read
 * DEFENSIVELY via readPositiveConfig (invalid → default + warn, never crash).
 */
export function handleDashboardData(
  db: Database.Database,
  query: { range?: unknown; date?: unknown },
  config: Record<string, unknown> | null | undefined,
): { status: number; body: DashboardData } {
  const rangeParam =
    typeof query.range === "string" && VALID_RANGES.has(query.range)
      ? (query.range as "7d" | "30d" | "90d" | "all")
      : DEFAULT_RANGE;
  const digestLimit = readPositiveConfig(
    config ?? {},
    "dashboardDigestLimit",
    DEFAULT_DIGEST_LIMIT,
  );

  // Series: snapshots within the range window.
  const cutoff = rangeToCutoff(rangeParam);
  const seriesRows = cutoff
    ? (db
        .prepare(
          "SELECT run_at, metrics FROM dashboard_snapshots WHERE run_at >= ? ORDER BY run_at ASC",
        )
        .all(cutoff) as Array<{ run_at: string; metrics: string }>)
    : (db
        .prepare("SELECT run_at, metrics FROM dashboard_snapshots ORDER BY run_at ASC")
        .all() as Array<{ run_at: string; metrics: string }>);
  const series: DashboardSnapshot[] = seriesRows.map((r) => ({
    run_at: r.run_at,
    metrics: JSON.parse(r.metrics) as DashboardMetrics,
  }));

  // Live composition (so day-one with no snapshots still shows the corpus).
  const live = computeDashboardMetrics(db);

  // Headline = live corpus (the chart shows history; the headline shows now).
  const headline = {
    total_memories: live.totals.mem,
    uses_per_showing: live.adoption?.uses_per_showing ?? null,
    cold_count: live.adoption?.cold_count ?? 0,
  };

  // Digest: pick the day to summarize. `date` (YYYY-MM-DD) wins; else the most
  // recent snapshot's day (real nightly OR backfill — both carry valid ISO
  // run_at since backfill rows use a synthetic midnight timestamp); else today.
  let dateStr: string | null = null;
  if (typeof query.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(query.date)) {
    dateStr = query.date;
  } else {
    const last = db
      .prepare("SELECT run_at FROM dashboard_snapshots ORDER BY run_at DESC LIMIT 1")
      .get() as { run_at: string } | undefined;
    dateStr = last ? last.run_at.slice(0, 10) : new Date().toISOString().slice(0, 10);
  }

  const dayStart = `${dateStr}T00:00:00.000Z`;
  const dayEnd = `${dateStr}T23:59:59.999Z`;

  // Sample of memories created that day, rendered via the production index
  // line renderer. Ordered by created_at so the page is stable across reloads.
  const sampleRows = db
    .prepare(
      `SELECT id, content, created_at, domain, project, source_agent, memory_type
         FROM memories
        WHERE created_at BETWEEN ? AND ?
        ORDER BY created_at ASC
        LIMIT ?`,
    )
    .all(dayStart, dayEnd, digestLimit) as Array<{
    id: string;
    content: string;
    created_at: string;
    domain: string | null;
    project: string | null;
    source_agent: string | null;
    memory_type: string;
  }>;
  // Render each sample through the production index line at its DEFAULT title
  // length (100) — the issue spec: the digest matches what agents see, so the
  // title truncation is identical, not dashboard-specific.
  const sample = sampleRows.map((r) => renderIndexLine(r, 100));

  // Lessons created that day — full content (the issue says "full text").
  const lessonRows = db
    .prepare(
      `SELECT id, content, created_at
         FROM memories
        WHERE memory_type = 'lesson' AND created_at BETWEEN ? AND ?
        ORDER BY created_at ASC`,
    )
    .all(dayStart, dayEnd) as Array<{
    id: string;
    content: string;
    created_at: string;
  }>;

  // Stage outcomes for the day: dedup merges + supersession links that day.
  const dedupRows = db
    .prepare(
      `SELECT loser_id, canonical_id, content_head, merged_at
         FROM dedup_log
        WHERE merged_at BETWEEN ? AND ?
        ORDER BY merged_at ASC`,
    )
    .all(dayStart, dayEnd) as Array<{
    loser_id: string;
    canonical_id: string;
    content_head: string | null;
    merged_at: string;
  }>;

  const supersessionCount = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM memory_links
          WHERE relationship = 'superseded_by'
            AND created_at BETWEEN ? AND ?`,
      )
      .get(dayStart, dayEnd) as { c: number }
  ).c;

  // Try to find the night's snapshot for lessonsGenerated + the real added
  // count (new_this_run.added reflects the distill count for that run, a more
  // faithful signal than created_at when the snapshot exists). One query for
  // both run_at and metrics.
  const daySnap = db
    .prepare(
      `SELECT run_at, metrics FROM dashboard_snapshots
        WHERE run_at BETWEEN ? AND ?
        ORDER BY run_at DESC LIMIT 1`,
    )
    .get(dayStart, dayEnd) as { run_at: string; metrics: string } | undefined;
  const dayMetrics = daySnap
    ? (JSON.parse(daySnap.metrics) as DashboardMetrics)
    : undefined;

  const digest: DashboardData["digest"] = {
    date: dateStr,
    run_at: daySnap ? daySnap.run_at : null,
    sample,
    lessons: lessonRows,
    stages: {
      lessonsGenerated: dayMetrics?.new_this_run?.lessonsGenerated,
      dedup: dayMetrics?.new_this_run?.dedup ?? dedupRows.length,
      supersession: dayMetrics?.new_this_run?.supersession ?? supersessionCount,
      added: dayMetrics?.new_this_run?.added ?? sampleRows.length,
    },
    dedup_merges: dedupRows.map((r) => ({
      loser_id: r.loser_id,
      canonical_id: r.canonical_id,
      content_head: r.content_head,
      merged_at: r.merged_at,
    })),
  };

  return {
    status: 200,
    body: {
      range: rangeParam,
      headline,
      series,
      composition: {
        by_type: live.by_type,
        by_domain: live.by_domain,
        by_source_agent: live.by_source_agent,
      },
      digest,
    },
  };
}

/**
 * Express adapter for GET /dashboard/data. Wraps the pure handler so the
 * route stays thin (same convention as context-store handlers in viz.ts).
 * Failures surface as a 500 with the usual {error} shape — no silent degrade.
 */
export function dashboardDataHandler(
  getDb: () => Database.Database,
  getConfig: () => Record<string, unknown> | null | undefined,
): express.RequestHandler {
  return (req, res) => {
    try {
      const { status, body } = handleDashboardData(
        getDb(),
        req.query as Record<string, unknown>,
        getConfig(),
      );
      res.status(status).json(body);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  };
}
