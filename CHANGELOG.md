# Hicortex Changelog

All notable changes to this project are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/).

## [0.16.3] - 2026-08-04

### Fixed
- **Pre-flight health-check retry.** The client nightly's `GET /health` pre-flight (5 s, single try) aborted the whole run whenever the server wasn't reachable within 5 s — e.g. a client that has just woken and whose network link hasn't re-established yet. Now retries 3× at 60 s apart (15 s per-attempt timeout), so a momentary unreachable-at-start no longer silently skips capture. On exhaustion the run still aborts and retries next run, but it now exits non-zero and sends an `ok: false` telemetry ping — so a persistent failure is visible in unit status and in the activity aggregate instead of looking like a clean run.

## [0.16.2] - 2026-08-03

Privacy simplification (#197). Application-level privacy filtering was rejected as structurally fragile — every query path had to remember to enforce it, and each review found new leak paths (`/search`, `/recent`, `/graph`, `/lessons`, `/index`, MCP mutations). **Isolation is now operational**: sensitive agents point at their own Hicortex server (a separate database, zero filtering code) via `init --server <url>`; shared agents stay on the team server. This release ships the cleanup + provenance that came out of that decision. Spec: `specs/2026-08-03-privacy-separate-servers.md`.

### Removed
- **Distiller privacy classification.** The distiller emitted a `PUBLIC / WORK / PERSONAL / SENSITIVE` tag per memory. Dead — the parser skips `##` headers, so the tag was never read, and the distiller cannot know private-vs-work anyway. Prompt line + rules block removed.
- **`compartment` domain-primary override.** A domain flagged `compartment: true` was forced to be the memory's primary domain whenever tagged, regardless of association weights. Removed across 7 files (`types`, `schema-prototypes`, `storage`, `classify-domains`, `consolidate`, `nofit`, `domain-classify`). Primary is now pure argmax-weight (ties → LLM tag order). A `domains` config that still sets `compartment: true` on a domain (e.g. Work, for a work/life boundary) is now silently ignored — the flag is gone (optional config cleanup, not required).

### Added
- **Agent UUID (`source_agent_id`).** `init` generates a stable `agentId` (`crypto.randomUUID()`, idempotent — never rotated); the nightly sends it; stored on the memory. Attribution that survives agent/machine renames. **Not used for filtering** — pure provenance.
- **`source_domain` (provenance).** A client may declare its topic (`config.sourceDomain` — distinct from the plural `domains` vocabulary); the nightly stamps `source_domain` on capture. Separate from the content-classified `domain` column (which stays for intra-agent topic routing). Storage + `/memory` echo only — **not** used in recall filtering or scoring.

### Notes
- **Schema migration v11** (`add_source_attribution`): adds `source_agent_id TEXT` + `source_domain TEXT` to `memories` (both `hasColumn`-guarded/idempotent, NULL on legacy rows).
- **Privacy filter AND privacy writes removed (server-side).** The `privacy` filter on `/search`, `/memory`, `/recent`, and recall-index is gone, and so are the hardcoded `privacy: "WORK"` writes — the distiller no longer classifies, so **new memories are written `NULL`**. The column is fully vestigial: still accepted on `/ingest` and `/distill` bodies for backward compat, stored, never read. Fixes a silent-empty-recall footgun where a non-WORK filter (e.g. a Hermes profile's `privacy_filter: "PERSONAL"`) matched nothing. Isolation is via separate servers, not filtering.
  - **Mixed population after upgrade:** rows written before 0.16.2 keep `privacy = 'WORK'`; everything after is `NULL`, with a hard cutover at the upgrade. Nothing reads the column, so this is inert — but any future code that compares it must handle both. The `dedup` privacy-mismatch cluster gate was removed for exactly this reason (it treated a WORK row and its NULL duplicate as a conflict and skipped the merge).
  - `?privacy=` on `/search`, `/memory`, `/recent` is accepted and **ignored**, with a one-time-per-process deprecation WARN. The Hermes plugin's `privacy_filter` is deprecated in plugin **0.7.2** (one-time warn only when explicitly set in the config file, so the default never trips it).
- **Config-wipe guard.** All `config.json` writers in `init` (LLM config, auth token, agent id, domain scaffold, agent name, client config) now load through a shared strict loader: ENOENT seeds `{}`, but a file that **exists and does not parse** throws instead of being overwritten. This closes a path where re-running `init` on a hand-edited config with a syntax slip wiped `authToken` (a 401 on every client), `licenseKey`, `distillApiKey`, `domains`, and `weakPrimaryFloor`, then re-seeded the generic domain vocabulary on top.
  - **Behaviour change:** `init` now **fails and exits 1** on a malformed `config.json` instead of "succeeding" destructively. The error names the file and the parse error.
  - **Recovery:** `hicortex init --repair-config` moves a malformed config to `config.json.corrupt-<timestamp>` and rebuilds. Nothing is deleted, and it reports the top-level key names found in the old file (names only — never secret values) so you know what to restore. Opt-in by design: rebuilding mints a fresh `authToken`, which 401s every thin client until they are updated.
  - Nightly and server boot route through the same loader but **fail soft with a visible WARN** rather than refusing to start — a broken config degrades the run, it does not take the server down.
- **No filtering code ships.** `source_agent_id`/`source_domain` never appear in a WHERE/ORDER BY/scoring clause. The vestigial `privacy` column remains (nothing reads it; dropping it is a separate, low-priority cleanup).

## [0.16.1] - 2026-08-03

Recall-quality tuning driven by the full-corpus relevance eval #3 (`research/2026-08-03-eval3-full-rewrite-analysis.md`): the topic-first rewrite fixed rendering but not selection, so this closes the format loop and applies the config levers the eval supported.

### Changed
- **Topic-first distillation (format fix).** The distiller parser no longer prepends `[Section]` to each memory — the prompt already enforced topic-first bullets; the prepend was the category-first root cause the 2026-08-02 corpus rewrite had to fix. Nightly capture now arrives topic-first. Completes the earlier prompt-only fix. A nightly log line counts actor/bracket-led entries as a format-regression smoke alarm.
- **Lessons stored without the `## Lesson:` prefix.** Selection is by `memory_type='lesson'`; the prefix was redundant and defeated topic-first findability. Existing lessons still render (the prefix is stripped at display).
- **`recallTitleChars` 150→100.** Eval §5: 0.6pts apart, full CI overlap (N=40) — no measurable difference, ~13% fewer tokens per recall block.
- **`recallMinSimilarity` 0.55→0.62.** Fine 0.01 floor sweep: steady ~3:1 noise:signal removal, no knee; +2.2pts precision, 10/98 prompts silent. The floor is a noise dial, not a silence mechanism — a non-cosine relevance gate is the real fix, pursued separately.
- **`recallMaxItems` 6→5.** Per-slot decomposition: slot 6 gives no prompt its first relevant memory ("6 is wrong" is the robust finding). 4 is lower-noise but the 4-vs-5 distinction is overfitting-fragile; 5 hedges with coverage.

### Notes
- Net (eval #3, scope OFF): precision up, noise/prompt down, ~halved recall tokens. Cost: more prompts silent (the floor's doing) — the trade the owner accepted ("noise is worse than silence").

## [0.16.0] - 2026-08-01

The retrieval-precision release: recall respects scope, keyword matching is field-aware, and citations are honest. Plus fixes to the 0.15.x citation/provenance work that each missed a parallel surface.

### Added
- **Recall scoping — soft project + domain affinity (#203).** Project and domain are now graded affinity boosts in the ranking, not hard filters — a hardware session stops surfacing boat-electrics on "battery" without excluding anything. CC and OC derive `project` from the working dir; Hermes agents declare `mission_domains` per profile (a health agent gets its domain ranked up). Config: `projectAffinityWeight`, `domainAffinityWeight` (0.15). No-scope ⇒ byte-identical to 0.15.3.
- **Fielded BM25 + fusion retune (#205).** The FTS index is rebuilt multi-column (`content, project, domain`) so keyword matches in scope fields outrank body-only hits — the exact-token case affinity alone couldn't fix. Config: `bm25WeightBody/Project/Domain` (1.0/2.0/2.0), `rrfFtsWeight` (0.5), `rrfVectorWeight` (1.0); `rrfK` (60) and the composite/RRF blend (0.8) are config-ized but preserved. Eval: cross-scope contamination 0.40 → 0.00 with no recall loss.

### Changed
- **Citation confidence (#204).** Memories cite as `FETCHED` (read in full via `hicortex_get`) or `SNIPPET` (one-line index entry, unread) — so "cited" can no longer pass as "read", and the adoption metric is honest.
- **Provenance in the recall index (#202).** Every one-line entry carries the origin agent + project, so an agent can calibrate trust before fetching.
- **Removed legacy `/learn` + `/hicortex-activate` commands (#209).** `init` now removes stale copies (capture is automatic/nightly since 0.9; the auth token is the credential now).
- **Supersession covers plain facts, not just decisions (#212, = #206).** The nightly supersession stage now links stale `[Facts Learned]` / `[Project State Changes]` memories to their replacements (demoted in recall, never deleted) — previously only decision/correction shapes qualified. A reversed fact stops competing with its current value.

### Fixed
- **(#207, high)** The `FETCHED` marker reached the REST `/memory` path but not the MCP `hicortex_get` tool Claude Code actually uses — collapsed both to one shared handler (`formatMemoryGetText`), with a regression test on the MCP output.
- **(#209, high)** `openclaw.plugin.json` still listed the two deleted skill paths, breaking OC plugin load on install — removed.
- **(#200, medium)** The Hermes plugin's `hicortex_get` description still had the old cost-biased fetch wording — softened to match CC/OC.
- **(#211, critical) CORS exfil closed.** The server no longer reflects arbitrary browser origins with `Allow-Credentials`; only `config.corsAllowedOrigins` (empty by default). A visited web page could previously read/mutate the store tokenlessly via the localhost bypass — it can't now.
- **(#211, high) LLM rate-limit backoff persists across override tiers.** distill/reflect/classify built a throwaway client per call, so a 429 was re-hit immediately by the rest of the nightly batch — now backed off via a shared per-endpoint map.
- **(#211, high) Legacy-command removal is ownership-safe.** `init`/`uninstall` only delete the retired `/learn` + `/hicortex-activate` files when they're Hicortex's own (marker check) — a user's own `learn.md` is no longer destroyed.

### Notes
- **Schema migration v10** (`fts_fielded`): rebuilds `memories_fts` multi-column in one transaction (a crash rolls back to the old index). Runs once on first 0.16 startup. `rrfFtsWeight=0.5` halves the keyword contribution to fusion globally — worth a soak before promoting.

## [0.15.3] - 2026-07-31

### Added
- **Session-intent keying (#192).** Recall blends the prompt embedding with a per-session EMA centroid before the vector search, so recall follows the session's intent instead of being query-literal. EMA centroid in `SessionRecallRegistry` (α=0.4); `blendQueryVector()`; one config knob `sessionIntentWeight` (default 0.33, 0 = kill-switch). Validated by a recall@k sweep eval (focused + topic-shift): density +19%, no regressions, shift-recovery by turn-4.

### Changed
- **Softened fetch-instruction wording.** Recall header / memory instructions / `hicortex_get` tool description now say "fetch when an entry could change your action" instead of "only when relevant" — less cost-biased, per the 0.14 field-test adoption finding.

## [0.15.2] - 2026-07-30

### Changed
- **Ranking rebalanced toward relevance.** The composite score's weights are now config keys, with new defaults: similarity 0.40 -> **0.50**, effective strength 0.30 -> **0.20**, connections 0.20 -> 0.15, recency 0.10 -> 0.15. Measured on the production corpus: the margin favouring an on-topic memory over a hardened-but-irrelevant one widens ~6x, so semantic relevance decides rankings instead of merely nudging them.
- **Supersession no longer weakens memories.** A decision reversed by a later one keeps its content and strength; retrieval demotes it via an explicit score multiplier (`supersededDemotion`, default 0.50) resolved from its `superseded_by` link. The previous base_strength penalty fought the now-tunable strength weight and leaked into prune eligibility - a reversed decision should rank lower, not drift toward deletion.

### Added
- **Fresh-memory window.** A memory is born highly available and settles into normal ranking over `freshnessBoostDays` (default 7) via an additive bonus (`freshnessBoostWeight`, default 0.15) that decays linearly to zero at the window edge - so the last week's context stays sharp (a session is captured by that night's nightly and dated from when it happened, so yesterday's work ranks high today). The old slow recency term (~58-day half-life at weight 0.10) could never lift a day-old memory past a hardened old one. Set the weight to 0 to disable.

## [0.15.1] - 2026-07-30

### Added
- **Telemetry you can actually see.** `hicortex telemetry` prints the current state (and which switch set it), the anonymous install id, the endpoint, and the literal payload that would be sent. Read-only by design: telemetry is on by default, the `telemetry` key is not written into `config.json` by `init`, and opting out is a deliberate edit — add `"telemetry": false` to the config or set `HICORTEX_TELEMETRY=off`. Both routes stay fully documented; `init` now discloses telemetry at setup time instead of leaving it to the docs.
- **Adoption signal in the payload (v2):** server-mode pings add `shown`, `uses`, and `cold` — corpus-wide sums of exposure vs use plus the never-touched count, so "is memory actually helping" is measurable, not guessed. Aggregate counts only; no content, no per-memory data. Client-mode pings omit them (no local DB).
- **Every install stays on the same line:** no field marks an install as internal/dev (a rare label would be a fingerprint — i.e. no longer anonymous). Filtering the maintainer's own installs out of adoption stats is done analysis-side by anonymous id, never on the wire.
- **Admin activity endpoint** (`GET /api/admin/telemetry/activity`): active installs (day/week/month), weekly retention cohorts by first-seen week, and uses-per-showing — all derived from telemetry rows already collected, no extra client-side data.

## [0.15.0] - 2026-07-30

### Added
- **`hicortex dedup` (#100):** clusters near-duplicate memories (top-10 KNN cosine >= `dedupMergeThreshold`, default 0.92, union-find — same math as the #191 mechanical audit) and merges each cluster onto a canonical row: highest `access_count` wins (tie: oldest), losers' links are re-pointed onto the canonical (self-links and already-present links skipped), counters are summed/maxed, tags are unioned, and losers are deleted (cascading links/tags/vectors/FTS). Dry run by default — `--apply` executes, after taking a full DB backup (`~/.hicortex/backups/pre-dedup-<ISO>.db`) and holding the existing single-flight capture lock so a concurrent nightly can't race the merge. A cluster whose members disagree on project, privacy, or source_agent is skipped and listed for manual review — no `--force` in this release. New sidecar table `dedup_log` (migration v9) records each merged-away loser (including its `source_session`) as an audit trail; `/distill`'s dedup prechecks now also consult it, so a deleted loser's session marker still blocks a re-ingest (e.g. from `--recapture-window`).
- **Supersession detection (#191 Phase B):** a new nightly consolidation stage links a decision/correction that reverses, replaces, or invalidates an earlier one (`superseded_by`) and accelerates the older memory's decay (`base_strength × supersessionPenalty`, default 0.5, floored at 0.1) — without deleting it (a judgment call about content, not a duplicate merge). Scope is decision/correction-shaped memories (`memory_type='decision'` or `[Decisions Made]`/`[Corrections & Rejections]` content) scanned via a resumable cursor, gradually back-processing the whole corpus a few nights at a time (`supersessionMaxCalls`, default 30, LLM calls per run). Each candidate's KNN top-5 older same-shape neighbors (`supersessionMinSimilarity`, default 0.80) get ONE constrained classify-tier LLM call each; a parse/infra error skips just that pair (retried naturally, never mis-links).

### Changed
- `getStoredEmbedding` moved from `relink.ts` to `storage.ts` (re-exported for compatibility) so the new supersession stage can reuse it without a circular import.

## [0.14.4] - 2026-07-28

### Added
- **Product-owned memory instructions:** the "how to use your memory" norms now ship with the product instead of living in per-agent persona files or user-edited rules. The server injects a synthetic read-only `memory` section into every `GET /context` response (rendered by all harnesses through the existing shared section renderer — zero client changes, works with older plugins too): the recall index is a menu (`hicortex_get` fetches), recall before assuming, cite what you use, capture is automatic (no manual ingestion of routine content), and never inspect/modify memory infrastructure — report and stop. The section name `memory` is reserved (PUT /context rejects it); disable via config `memoryInstructions: false`. Harness personas can now carry zero memory-system content — instructions upgrade with the server, drift-free.

## [0.14.3] - 2026-07-28

### Added
- **Hermes + OC plugins adopt the unified pushed recall (#193):** both plugins now use the same server-side recall logic as Claude Code — one logic for all harnesses, tuned in one place (server config), no plugin-side constants.
  - **Hermes plugin 0.7.0:** `prefetch` now POSTs the user's message to `/recall-index` and injects the returned compact index block verbatim (null block → nothing), carrying the profile's configured `privacy_filter` and `default_project` so 0.6.x scoping survives the switch. The per-session dedup is reset synchronously at `initialize` (the Hermes `MemoryProvider` interface exposes no compaction signal; the server's turn-based re-show window covers mid-session context rebuilds). New `hicortex_get` tool (9 tools total) lazy-loads one memory behind the server-rendered citation — that fetch is what strengthens the memory (exposure ≠ use) — with the same privacy scoping. The sha1 prefetch cache is kept out of the new path (the server dedups; a client cache would double-suppress). Old-server guard: a 404 (pre-0.14 server) falls back to the 0.6.x `/search` full-content prefetch, fail-soft, re-probed every 10 minutes so a client-first rollout heals without a gateway restart. Per-turn calls use a dedicated 1.5 s timeout, and persistent non-404 errors (e.g. a bad auth token) log one WARNING per status instead of hiding at debug level.
  - **OC plugin:** the `before_agent_start` hook (which fires per inbound message in OpenClaw — it is the per-turn surface) now also POSTs `/recall-index` and appends the index block after context + lessons; new `after_compaction`/`before_reset` hooks reset the session's dedup (fire-and-forget) when the context window is rebuilt. New `hicortex_get` tool proxy to `GET /memory` with the same citation rendering. On 404 the per-turn POST is skipped (OC had no pre-0.14 per-turn recall to fall back to) and re-probed every 10 minutes; a gateway that doesn't pass `sessionId` to plugin hooks logs one warning instead of running silently dead.
  - **Server:** `POST /recall-index` accepts optional `project` and `privacy` (array or CSV) and pushes them into retrieval; `GET /memory` accepts an optional `privacy` filter (an out-of-scope memory reads as 404 — existence is never revealed) and resolves the 8-char prefix ids that citations teach, like `/update` and `/delete` (the MCP `hicortex_get` too).

## [0.14.2] - 2026-07-28

### Changed
- **Memory ids (and dates) in MCP search/recent output:** `hicortex_search` and `hicortex_recent` results now lead with the memory id and creation date, so every recall surface feeds the rest of the toolset — cite-on-use (id + date), `hicortex_get` lazy-load of truncated content, `hicortex_graph` entry points, and `hicortex_update`/`hicortex_delete` self-correction. Previously only the pushed recall index carried ids.

## [0.14.1] - 2026-07-27

### Added
- **Built-in memory provenance (cite-on-use), split by function:** transparency is now part of the mechanism, never the user's responsibility. The recall-index header carries the selection-time rules — "dates matter, newer supersedes older" and "cite any memory you rely on (id, date)", which covers agents using index snippets without fetching (the common case observed in field testing). The fetch surface carries the full use-time provenance: `hicortex_get` responses open with id, type, project, **origin agent** (shared brain — the memory may come from another agent's session), and date, plus the citation format; `GET /memory` gains a server-rendered `citation` field so plugins inherit the same norm with zero client work.

## [0.14.0] - 2026-07-27

### Added
- **Pushed recall index (#192):** new `POST /recall-index` returns a compact, per-prompt index of relevant memories (one line each — a menu, not the meal); agents lazy-load full content with the new `hicortex_get` MCP tool / `GET /memory?id=`. One recall logic for every harness: Claude Code consumes it via new `recall-hook` hooks that `init` installs (UserPromptSubmit → index injection; SessionStart → per-session dedup reset, incl. after compaction). Dedup is TURN-based server-side (`recallReshowTurns`, default 30) — suppressed ids rotate in next-ranked memories instead of silencing. Relevance gates: measured-cosine floor (`recallMinSimilarity` 0.55), BM25 matches always pass, graph-only hits excluded, short prompts skipped (`recallMinPromptChars` 20), `recallMaxItems` cap (6). Client fetch timeout 1000 ms, fail-soft.
- **Exposure ≠ use (migration v8):** appearing in the pushed index bumps the new `memories.shown_count` and refreshes `last_accessed` (mild, temporary strengthen — the decay clock resets) but never `access_count`; fetching via `hicortex_get`/`GET /memory` is real use (access_count + hardening + prune shield). Uses-per-showing becomes an honest adoption metric.
- **Config-driven recall breadth:** `searchLimit` (8), `recentLimit` (12), `recentWindowDays` (180, was 30), `coldExposureSlots` (2 top-k slots reservable for never-accessed candidates) — calibration is a config edit + restart, never a release.

### Changed
- **Decay is ~6× gentler:** half-life at importance 0.5 is now ~1 year (was ~115 days), configurable via `decayHalfLifeDays`. Long-term remembering is the product; time preference stays, but mild. Server and nightly share one decay clock.
- **Filtered search no longer starves:** project filter is pushed into the FTS SQL, and the vector leg over-fetches when filters are active (was a flat limit×3 that intersected a global top-15 with a ~1% project slice).
- MCP tool descriptions rewritten as behavioral guidance (search before assuming; recent at start of project work; get = deliberate use).

## [0.13.3] - 2026-07-27

### Changed
- **Privacy scrub of all shipped surfaces:** internal hostnames, agent names, and owner-specific examples removed from source comments, CLI messages, the OpenClaw plugin manifest, the mirrored Hermes plugin, and the shipped domains example — everything now uses generic placeholders. No functional changes.

## [0.13.2] - 2026-07-25

### Fixed
- **Multi-day sessions lose content after the first capture (#189):** a long-running session was captured whole on the first nightly, then session-level dedup skipped it on every later night — so everything added after night 1 was silently dropped (and anything past the 80K distill cap was lost even on night 1). Capture is now **incremental**: each reader (Claude Code, Pi, OpenClaw, Hermes) slices a discovered session down to its unseen delta using a **per-session cursor**, the delta is packed into ordered ≤60K segments (below the server's 80K cap — no more silent truncation), and each segment POSTs with a deterministic `segment_id`. The cursor advances only on server-confirmed success, so a failed segment is retried (dup-over-loss) and nothing is lost.
  - Cursors are stored per session in `~/.hicortex/capture-cursors.json` (atomic write, 90-day prune). JSONL readers cursor on parsed-entry count; Hermes cursors on `messages.id`, so a resumed-and-re-ended session yields only its new turns.
  - **Server** — `/distill` gains a segment-exact dedup (skip iff this exact `<sid>#<segment_id>` is already stored). The legacy whole-session dedup is unchanged, so a ≤0.13.1 client behaves exactly as before. Per-night `session_date` now dates each segment from its own delta, not night 1.
  - **Concurrency** — a single-flight lock (`~/.hicortex/capture.lock`) makes `nightly` and `nightly --capture-only` safe to overlap.
  - **Recovery** — `hicortex nightly --recapture-window <days>` re-discovers sessions that went quiet before the upgrade (widens the discovery window only — never narrows it). **This fix activates when the CAPTURING machine upgrades** (it is client-led). See the developer changelog / PR for the recovery framing and mixed-version matrix.
  - **Hardening (post-review):** watermark held on a 429/401 stop and on a cursor-write failure (fail-explicit); `/distill` inserts a segment's chunks in one all-or-nothing transaction; capture lock has a 24h TTL + reclaim re-race and is acquired before the cursor store is read; a full nightly waits out an overlapping `--capture-only` run and still runs consolidation if it can't; shrink-guard resets tag a generation into the segment id so post-reset ids can't collide; Hermes cursors on `messages.id` ordered by id.

## [0.13.1] - 2026-07-24

### Fixed
- **Distiller substance gate (#156):** content-free distillation artifacts (empty section fragments like `[Specific AI Content:]`, template-placeholder echoes, metadata-only lines) are dropped at distill time instead of entering the memory store and riding the decay path. Precision-first structural rules only — no word-count threshold, so genuine short memories (bracketed payloads, deadline facts, non-Latin scripts) are never discarded; a kept borderline artifact is pruned by no-fit decay, while the gate rejects only structurally-empty shapes. Every dropped fragment is logged server-side AND returned in the `/distill` response (`dropped: string[]`, additive), which the nightly writes to its file-persisted log — a durable audit trail for an irreversible discard.

### Added
- **Nested `models` config block (#154):** configure per-stage LLM overrides as one block — `"models": { "distill": {"model", "baseUrl", "apiKey", "provider"}, "reflect": {...}, "classify": {...}, "score": {...} }` — instead of 12+ flat keys. The happy path stays ONE model for everything; flat legacy keys (`distillModel`, `reflectBaseUrl`, …) keep working with precedence nested > flat > base. Fail-explicit validation: invalid shapes, non-string fields, and fields that cannot take effect (tier `apiKey`/`provider` without `baseUrl`; `score.apiKey` under an ollama base) warn instead of silently degrading. `init` now recognizes nested-only configs as configured. Resolver unification deferred to #188.

## [0.13.0] - 2026-07-18

### Added — per-agent context (#179)
- **Each agent can have its own standing context**, resolved server-side into one of three modes: `override` (the agent's sections win per section name, falling back to the global set for anything it doesn't define), `global` (the shared set — 0.12 behavior), or `off` (inject nothing). One server serves many distinct-persona agents without forcing one identity on all of them. Spec: `specs/2026-07-18-per-agent-context.md`.
- **REST** — `GET`/`PUT /context?agent=<id>` selects a per-agent scope. The server does the merge and returns `{ sections, updated_at, clients, agent, mode }` (plus `origins` per section in override mode); the bare `GET /context` gains an additive `agents` map for the UI. The agent id is on the same strict allowlist as section names (it is joined into a path); an invalid id → `400` (never a silent fall-through to global). Per-agent sections live at `<home>/context/agents/<id>/*.md`; the global reader skips the reserved `agents/` subdir. Symlinked or non-directory `agents/<id>` paths are refused on read and write.
- **Resolution** — config `contextAgents` (`{ "<id>": "override" | "global" | "off" }`, boot-time — restart to apply) wins; otherwise a dropped-in `agents/<id>/` directory alone means `override` (immediate, per-request); otherwise `global`. `updated_at` reflects only the files that won the merge.
- **Per-agent scoping by harness** — Hermes and OC scope context per profile/agent automatically (each profile/agent is a distinct identity on one box). **CC is global by default**: all CC installs for one user share the global context (one user = one identity across machines), so the SessionStart hook sends **no** `?agent=`. `agentName` is an explicit opt-in only — `hicortex init --agent-name <name>` sets it (written only when the flag is passed; re-init overwrites only with an explicit flag), and only then does the hook send `?agent=<config.agentName>`. `hicortex init --agent-name ""` clears it back to global; an empty/whitespace value equals unset everywhere. `hicortex status` prints the agent name, or `(not set — global context)` when unset.
- **Web editor** — an agent scope selector (`Global` | `<agent>`, plus add-agent), inherited-from-global sections shown dimmed; editing an inherited section saves it to the agent scope (becomes an override).
- **CLI** — `hicortex context show|edit --agent <id>` targets a per-agent scope (omit → global).
- **Config** — `contextAgents` (per-agent modes) and `agentName` (this install's id).

### Added — Hermes + OC context consumption (#181)
- **Hermes plugin 0.6.0** — `system_prompt_block()` now fetches the standing context layer (`GET /context?agent=<profile>`) and injects a `## Context` block **above** the lessons block. The profile id is resolved from config `agent_name` → `HERMES_PROFILE` env → a `HERMES_HOME` ending in `profiles/<name>` → none (bare fetch → global). New optional `agent_name` config field (leave blank to auto-derive). Injection gates: `"hermes"` in the server-resolved `clients`, a non-empty resolved section set, and — when an agent id was sent — an `agent` echo in the response (old-server guard). Context and lessons fail soft independently. Merging this release syncs the plugin to its public mirror.
- **OC plugin** — `before_agent_start` now fetches `/context?agent=<agentId>` and `/lessons` concurrently, injecting the same `## Context` block before the lessons block, with the identical gates (`"oc"` in `clients`, non-empty sections, echo guard when an agent id was sent) and independent fail-soft.

### Backward compatibility
- Purely additive: no `?agent=` and no `contextAgents`/`agents/` dir → every agent gets the global set (0.12 behavior). No migration.
- The server echoes `agent`+`mode` in **every** mode (including `global`/`off`) so upcoming Hermes/OC plugins can guard on the echo when talking to an older server that ignores `?agent=`.

## [0.12.1] - 2026-07-18

### Fixed
- **Client installs no longer wire to the ephemeral npx cache (#176).** When `hicortex init --server <url>` was run via `npx -y @gamaze/hicortex init` (the standard thin-client path), the SessionStart hook and nightly `ExecStart` (+ its `PATH`) were pointed at `~/.npm/_npx/<hash>/…`, which npm garbage-collects — silently breaking recall injection and capture later. `resolveBinaryArgs` now rejects an `_npx` path and emits the durable `npx -y @gamaze/hicortex <cmd>` form.

### Internal
- Single `hicortexHome()` resolver in `src/paths.ts` — all commands now honor `HICORTEX_HOME` consistently (#174).
- Rename internal `retrieval.searchContext` → `searchRecent`, aligning with the 0.12 public `context`→`recent` rename (#175).

## [0.12.0] - 2026-07-15

### Breaking — recall renamed `context` → `recent`
- REST `GET /context` → `GET /recent` (same behavior, same response shape).
- MCP tool `hicortex_context` → `hicortex_recent` (CC + OC).
- Hermes plugin: `hicortex_recall_recent` alias removed — its function merges into `hicortex_recent`; tool surface 9 → 8. Plugin version bumped (breaking).
- **No compatibility alias.** Upgrade the server first, then all clients — a 0.12 plugin against a pre-0.12 server (or vice versa) loses queryless recall until both sides match. The `context` name is reassigned to the new hand-edited context layer (`specs/2026-07-12-context-layer.md` §Naming); the new `GET /context` (landing in this release) returns an explanatory 400 to old recall-style callers.

### Added — context layer (L2)
- **Hand-edited standing context** — a new layer distinct from episodic memory (auto-distilled, decays) and lessons: Markdown files at `<hicortex-home>/context/*.md` (one file = one section; recommended starter sections are `user.md` and `rules.md`, which you create — nothing is auto-populated, a fresh install starts empty), injected verbatim into every CC session at start. It lives OUTSIDE the `memories` table and is **never read or written by `consolidate.ts`/`distiller.ts`** — never scored, decayed, or pruned. Spec: `specs/2026-07-12-context-layer.md`.
- **REST** — `GET /context` returns `{ sections, updated_at, clients }`; `PUT /context` is a partial upsert of the named sections (`{ sections: { "<name>": "<md>" } }`) — omitted sections are left untouched, deletion is filesystem-only. Section names are allowlisted (`^[a-z0-9][a-z0-9_-]*$`, max 64; the server appends `.md`); reads skip symlinks (`lstat`), writes go temp-file-then-rename and keep a one-generation `<name>.md.bak` undo. Missing dir → fail-soft `{ sections: {} }`. Total size > 16 KB logs a warning (no rejection). Stale-recall tripwire: recall-style query params (`project`/`limit`/`privacy`) on `GET /context` return `400` pointing at `/recent`.
- **Web editor** — `GET /context/ui`, a self-contained page (one tab per section, Save → `PUT /context`), same shell-served-without-auth pattern as `/viz`.
- **CLI** — `hicortex context show [name]` (print sections) and `hicortex context edit <name>` (edit a section in `$EDITOR`, PUT only if changed), round-tripping to the configured server.
- **Config** — `contextClients` (default `["cc"]`; accepts `"all"` or any subset of `cc`/`hermes`/`oc`). The server normalizes the raw value, logs a warning for dropped unknown names, and echoes the resolved list in `GET /context` so each harness self-gates.
- **Delivery** — the CC SessionStart hook (`lessons-context.ts`) fetches `/context` concurrently with `/lessons` (each with its own timeout and independent fail-soft) and, when `"cc"` is in the resolved `clients`, prepends a `## Context` block before the lessons block. Hermes/OC delivery is a tracked fast-follow (zero server change — same endpoint).

### Naming
- One word per concept, no overlap: **`context`** is the standing context layer (hand-edited, non-decaying, injected every session — "who you are + how to work"), and **`recent`** is queryless recall of the latest memories by project (importance-ranked, distinct from `/search`). The pre-existing recall endpoint/tool that was called `context` returned *recent memories* — that is recall, not context — so it was renamed to `recent` to free the name for this layer. Rationale in `specs/2026-07-12-context-layer.md` §Naming.

### Fixed
- **/viz requested at most 2000 nodes no matter what the Node-limit control said (#162).** A leftover client-side `Math.min(lim, 2000)` from the v1 limits silently capped every export request; the input field and the server both already supported 10000. The client cap is removed entirely — the server's `EXPORT_MAX_LIMIT` clamp is the single authority, so the two can never drift apart again.
- **`GET /graph` neighbors/hubs `limit` param is validated** (floored, minimum 1). Negative values previously meant "unlimited" in the SQL `LIMIT`; fractional values threw a binding error surfacing as a 500.

## [0.11.0] - 2026-07-08

### Changed
- **No-fit = EMPTY tag set — the "Unsorted" fallback category is gone (owner amendment 07.07 to the graded-schema spec).** The classifier prompt now instructs `{"tags": []}` when no configured domain genuinely fits, and `parseTagReply` returns the distinct result `{tags: []}` for an explicit empty array (null stays reserved for infra errors → memory skipped untouched and retried later; the #150 discipline is unchanged). `resolveFallbackDomain`/`DEFAULT_UNSORTED` are removed: no configured domain is ever auto-assigned on a no-fit, and a config WITHOUT any "Unsorted" domain is the norm (one that still has it is just a normal domain). What happens to a no-fit memory instead (owner-approved lifecycle: tagged → lives, weak association → lives humbly, no association → forgotten; implemented in the new `src/nofit.ts`, shared by the nightly stage and `hicortex classify-domains`):
  - **Weak-primary floor** — the memory earns a WEAK primary from pure embedding association: argmax cosine across ALL domain prototypes, when the best cosine ≥ the new optional `weakPrimaryFloor` config key (default 0.45 — tune it from the corpus weight distribution, e.g. the lower tail of the memory_tags.weight histogram of LLM-tagged rows). Tagged with that single domain (the primary derives naturally), logged distinctly (`weak-primary <domain> w=0.52`).
  - **No-association decay** — below the floor the memory is NOT tagged: its base_strength is HALVED (floored at 0.05) and its domain stays NULL, so every subsequent run re-attempts it as prototypes evolve and re-halves only while it is still a below-floor no-fit (exactly one halving per run). This is what makes the existing prune stage reachable at all: at base_strength 0.5 a memory can NEVER prune (effectiveStrength's asymptotic floor 0.5²×0.1 = 0.025 sits above the 0.01 prune threshold); four halvings reach the 0.05 strength floor, where prune fires once the memory is ~143 days unaccessed (and past the 90-day minimum age). Rescue paths: a single access permanently shields it from pruning (prune only considers access_count = 0 memories), and a later classification or weak primary stops the halving (strength is not restored — only access does that).
  - New counters: `weak_primary` / `no_association_decayed` in the nightly stage report, `weakPrimary` / `noAssociationDecayed` in the classify-domains report.
- **Graded schema memory tags — prototype-derived per-tag weights, DERIVED primary; the LLM now emits discrete tags only** (spec: `specs/2026-07-07-graded-schema-memory-tags.md`; supersedes the LLM-picked primary from the multi-tag change below). Domains now behave like human memory schemas with graded membership: each configured domain gets a **prototype** — the L2-normalized centroid of its member embeddings, seeded from the embedded config description ("Name: description") while a domain has fewer than 5 members — stored in the new `domain_prototypes` table, and every tag assignment gets an association **weight** = cosine(memory embedding, domain prototype) in the new `memory_tags.weight` column (**migration v7**). The **primary** (`memories.domain` — viz colour, `/index` counts, lesson affinity) is now fully mechanical: the argmax-weight tag, overridden by any tagged domain flagged `compartment: true` in config (deliberate compartmentalization — the work/life firewall), with the LLM's most-relevant-first order breaking exact-weight ties. The classifier prompt asks for ONLY `{"tags": [...]}` (1–4 domains, most relevant first, with a generic multi-tag emphasis: things the owner builds usually carry BOTH the venture/project domain AND the life topic they touch); no LLM-emitted primary, weights, or ranks — audits showed LLM primaries were a coin-flip on overlapping spheres and LLM-invented numbers were noise. Legacy `{primary, tags}` replies are still parsed for tolerance, but the primary is ignored. Prototypes, ALL weights, and ALL primaries are **recomputed every nightly** (and after `hicortex classify-domains`) so categories drift with the data — reconsolidation without re-classification runs. Query surface: `GET /graph?op=export` node payloads order `tags` by weight descending and add a parallel `tagWeights: number[]` (rounded 4dp), and op=export gains a `tag=` filter ("everything touching X" — tag match at any weight, unlike `domain=` which matches only the derived primary).
- **Memories now carry MULTIPLE tags (a primary + additional) from the config vocabulary — supersedes the single-domain classification.** The single-domain approach (added earlier this cycle; see below) forced each memory into exactly one life-sphere, which mis-modelled memories that genuinely span spheres (a "set up the home server" memory is both Hardware and Ventures) and produced a ~14% Unsorted pile of misfiled technical memories. Classification now returns a `primary` tag plus every additional tag that genuinely applies, all drawn from the same `config.domains` controlled vocabulary. **Low-churn design:** the existing `memories.domain` column keeps its meaning as the PRIMARY tag (so viz colour, `/index`, and lesson-selection are unchanged); a new `memory_tags(memory_id, tag)` sidecar table (migration v6) holds the full multi-label set including the primary. The classifier is one constrained reflect-model call per memory; the memory's `project` name is now passed as a **classification hint** ("content wins, project only breaks ties"), which rescues terse technical memories from terse project codenames that the single-label path punted to Unsorted. Multi-label makes the Unsorted fallback rare. New `classifyMemoryTags` replaces `classifyMemoryDomain`; the nightly stage and `hicortex classify-domains` both write via `storage.setMemoryTags`. The nightly re-files rows that are NULL, out-of-vocabulary, OR have no `memory_tags` rows yet (so single-domain memories from the earlier approach are backfilled). `GET /graph?op=export` nodes gain a `tags: string[]` field (primary stays the colour); `/index` gains an optional `tagCounts` map. Config key unchanged (`domains`).
- **Linking is now heuristic-only (`extends` / `relates_to`); LLM/uppercase edge classification retired.** A 672-link audit (17 LLM judges) of the current linking output found only **31% of typed links overall** were correct/defensible. The LLM-classified UPPERCASE types were near-useless (**CONTRADICTS 4%** acceptable, SUPERSEDES 29%, DEPENDS_ON 26%, CAUSED_BY 24%, VALIDATES 44%), and the lowercase heuristics `updates`/`derives` were also weak (~31%); only `extends` (57%) and `relates_to` (53%) held up. In response: (1) `classifyLinkCandidates` no longer calls the LLM — it assigns each candidate its heuristic type (the `llm`/`budget` params are retained but ignored for call-site stability); (2) `classifyRelationship` collapses to exactly two labels — same-project + cosine above `CONSOLIDATE_LINK_THRESHOLD` → `extends`, otherwise → `relates_to` (`updates`/`derives` no longer emitted); (3) new **cross-project strength floor** — a candidate whose source/target are in different projects is rejected unless cosine ≥ `CROSS_PROJECT_LINK_THRESHOLD` (0.80), since cross-project links audited 65% wrong-link vs 6% same-project and strength predicts quality (wrong-link 42%→6% across strength quartiles); same-project keeps the 0.75 floor. The five UPPERCASE types stay in `VALID_RELATIONSHIP_TYPES` so pre-existing rows still validate — they are **retired, not deleted**, and may return only when a future classifier passes the audit harness at ≥ 70% acceptable. LLM edge classification is not re-enabled by this change. `relink` is heuristic-only too — its `--no-llm`, `--max-llm-calls`, `--llm-base-url`/`--llm-model` flags are gone (the LLM setup/preflight is removed).

### Fixed
- **`hicortex status` / `hicortex nightly --status` no longer report "Last run: never" on migrated installs (#161).** Both printers still read the legacy `nightly-last-run.txt`, which the state migration deletes after moving its value into `state.json.lastNightly`. A new shared `describeLastNightly()` in `state.ts` reads state.json and falls back to the legacy file for installs that haven't run the migration yet; both commands use it (duplicated age/staleness logic removed).
- **Retrieval relevance scoring recalibrated — semantic similarity is now computed correctly (true cosine) across the full range; lesson-contradiction detection now fires as intended (fixes #145).** The last two `1 − L2` "similarity" instances from the #143/#144 bug class are gone: (1) `computeScore` in `retrieval.ts` used `max(0, 1 − distance)`, which compressed real cosines (cos 0.8 scored 0.37) and flattened everything below cos 0.5 to exactly 0 — the composite score's similarity component now uses the shared `l2ToCosine` (`cos = 1 − d²/2`, valid for our L2-normalized embeddings), with the 0-clamp kept at the correct scale (negative cosine = truly unrelated). Blend weights (0.4/0.3/0.2/0.1) are deliberately unchanged in this pass — similarity values roughly double for related content, and rebalancing is a data-driven follow-up after a measured before/after comparison. (2) The `stageReflection` contradiction check (`1 − n.distance > 0.80`) effectively required cosine > 0.98 and almost never fired; it now triggers at TRUE cosine 0.80 (new `isContradictionCandidate` / `REFLECTION_CONTRADICTION_MIN_COSINE`), the original intent. Also scale-coupled: the placeholder distance for FTS-only/graph-discovered candidates (`DEFAULT_GRAPH_DISTANCE`) moves 0.5 → 1.0 so those candidates keep their neutral similarity of 0.5 instead of jumping to 0.875. `l2ToCosine` now lives in `retrieval.ts` (dependency root) and is re-exported by `consolidate.ts` for existing importers.
- **Infra errors during classification no longer mis-file memories as Unsorted (closes the #150 robustness item).** `classifyMemoryTags` distinguishes a genuine no-fit (a valid model reply that matched no vocabulary tag → `primary = Unsorted`) from an infrastructure error (the reflect endpoint throws after the one retry → returns `null`). On `null` the nightly SKIPS that memory (leaves it unclassified for a later run) and `hicortex classify-domains` ABORTS cleanly after committing the last full batch — the cursor sits at the last successfully-classified row and nothing is written as Unsorted. Previously an endpoint that died mid-run would file good technical memories into Unsorted.
- **Link similarity was computed as 1−L2, not cosine — linking was effectively a near-duplicate detector.** `discoverLinkCandidates` treated sqlite-vec's L2 `distance` as a similarity (`1 − distance`); with the 0.55 threshold that silently required cosine > 0.90, so only 12% of memories on the 2945-memory production corpus got links and the /viz graph was nearly disconnected. Embeddings are L2-normalized, so the honest conversion is `cos = 1 − d²/2` (new `l2ToCosine`). The threshold is recalibrated to **0.75 in true cosine space** (measured top-10 neighbor cosine histogram on the production corpus: top-1 median 0.823) with a new **top-3 cap per memory** (`CONSOLIDATE_LINK_TOP_K`) — together ≈ 2.2 candidate links/memory. **Migration v5** rescales existing `memory_links.strength` values (stored on the old 1−L2 scale; LLM-classified links also stored candidate similarity as strength, so all rows are rewritten) to cosine via `1 − (1−s)²/2`. The nightly linking stage and `hicortex relink` share this code and change behavior identically. (Note: `classifyRelationship`'s cosine boundaries were subsequently simplified to two labels — see the linking audit under Changed.)

### Added
- **`init` scaffolds generic default memory domains (issue #150 — packaging/docs pass).** Server-mode `init` now writes an editable 5-domain starting set to `~/.hicortex/config.json` when the config has no `domains` key: **Work, Personal, People, Health, Finance** (`GENERIC_DEFAULT_DOMAINS` in `init.ts`), with a printed hint that the list is user-owned and can be life areas OR project/topic areas. Non-clobber, same philosophy as the auth token: an existing `domains` key — even an empty array — is never touched. Upgrading installs get the scaffold when they re-run init; installs that never re-run init keep the legacy project-grouping. There is deliberately NO fallback category in the defaults (no "Unsorted" — the no-fit weak-primary/decay lifecycle handles unclassifiable memories automatically), and no interactive per-domain wizard — edit the JSON to taste. Classification activates automatically once an LLM is configured (strict-skip until then).
- **`domains.example.json` shipped in the npm package.** The 5 generic defaults as a copy-paste config snippet, plus a power-user example showing a narrower life-sphere set with `compartment: true` on Work (work/life firewall) and a custom `weakPrimaryFloor`.
- **Domains documented for release:** npm README gains a "Memory Domains & Tags" section (what domains are, editing config, the graded weight/derived-primary model, `hicortex classify-domains` backfill with flags, `weakPrimaryFloor`), install section notes the init scaffold, CLI help lists the scaffold under `init`, and the repo CLAUDE.md MODULE_INDEX section now describes the content-based multi-tag model vs the legacy project-grouping fallback.
- **Optional dedicated LLM tier for memory tag classification (`classifyModel`/`classifyBaseUrl`).** New optional config keys in `~/.hicortex/config.json`: when set, `classifyMemoryTags` (nightly content-domain stage + `hicortex classify-domains`) runs on `classifyModel@classifyBaseUrl` via the new `LlmClient.completeClassify`; when absent, classification falls back to the reflect tier exactly as before (zero behavior change for existing installs). If only `classifyModel` is set, it runs on the reflect endpoint (else the base endpoint). Pre-flight (the nightly `contentDomainsReady` gate and the classify-domains preflight) now probes the endpoint classification will ACTUALLY use, resolved by the shared pure `resolveClassifyProbeTarget`. Chosen after an A/B benchmark: gemma4:31b-mlx scored 83.7% vs qwen3.6:35b-a3b 65.4% primary accuracy on a 104-memory judged sample — while reflection/lesson extraction stays on the reflect model.
- **Content-based per-memory domain classification (config-owned domain list).** _(Superseded within this same 0.11.0 cycle by multi-tag classification — see Changed above. Retained here for history.)_ The nightly previously set each memory's `domain` by grouping PROJECTS into LLM-invented domains and assigning every memory its project's domain — wrong when "projects" are agent names and one agent produces memories spanning many life areas. When `~/.hicortex/config.json` carries a `domains` array (`[{ name, description }, …]` — e.g. Work, Ventures, Hardware, Finances, Property, Vehicles, Boating, Health, Family, People, Travel, Unsorted), the nightly instead classifies **each memory into one life-sphere by its CONTENT** via one constrained reflect-model (35B) call, replacing the project-grouping path. Only NULL or stale-domain rows are (re)classified, so re-runs are cheap and editing the list re-files affected rows. Strict, quality-first: if the reflect endpoint fails pre-flight, domain classification is **skipped** for the run (no fall-back to a weak model or to project grouping). No-match/low-confidence memories fall to the `Unsorted` bucket. `moduleIndex` becomes the configured domains + live per-domain counts, so `/index` and lesson selection keep working. **When `domains` is absent, the legacy project-grouping behaviour is unchanged** (backward compatible for other installs). Sub-labels within a sphere (e.g. Ventures→Work/Personal, Work→employer/workstream) are a **future phase** — this ships sphere-level `domain` only.
- **`hicortex classify-domains` — resumable content-domain backfill command.** Server-mode-only backfill over the corpus (needs `config.domains`), same discipline as `relink`: rowid-ordered batches (default 200), a `domainCursor` in state.json persisted per committed batch (interrupt-safe), reflect-endpoint pre-flight with clean abort, and a per-domain summary. Default scope classifies only NULL/stale-domain rows; `--all` reclassifies every memory; `--reset` restarts from the beginning; `--batch <n>` sets batch size.
- **`hicortex relink` — resumable link-discovery pass over the ENTIRE corpus (closes #143).** The nightly's linking stage only processes memories that are new since the last consolidation, so everything ingested before it existed (e.g. a migrated corpus where most memories had no links) never went through link discovery, leaving the knowledge graph and /viz artificially sparse. `relink` back-fills the graph by reusing the exact nightly machinery (extracted from `stageLinks` into shared `discoverLinkCandidates`/`classifyLinkCandidates`): all memories are processed in rowid-ordered batches (default 200) using their STORED embeddings (no re-embedding), with the same candidate rules as the nightly (top-10 neighbors, cosine above `CONSOLIDATE_LINK_THRESHOLD` — `CROSS_PROJECT_LINK_THRESHOLD` for cross-project pairs — top-3 cap; see the linking fix under Fixed and the audit under Changed) and the same heuristic-only classification. A `relinkCursor` in state.json is persisted after every committed batch, so the run is safe to interrupt and resumes where it stopped; pairs already linked in either direction are never duplicated, making re-runs idempotent. Flags: `--dry-run` (counts only, zero writes), `--batch <n>`, `--reset`. Server-mode only; run manually, not part of the nightly.
- **Memory visualization: `GET /viz` knowledge-graph page (closes #124).** The server now serves a self-contained HTML page (inline CSS/JS, zero external requests — no CDN, works offline) that renders the memory knowledge graph on a hand-rolled canvas force-directed layout. Nodes are colored by knowledge domain, sized by effective (decayed) strength, hubs get a halo; edges are styled by relationship type (similarity, CONTRADICTS, SUPERSEDES, DEPENDS_ON, CAUSED_BY, VALIDATES). Pan/zoom/drag, hover tooltips, click-to-read detail panel, server-side filters (domain, memory type, min strength, node limit) and client-side search-to-highlight.
- **`GET /graph?op=export`** — the JSON surface feeding /viz: `{nodes, edges, domains, types, meta}`. Nodes ranked by effective strength, capped at 500 by default (hard max 2000); edges included only when both endpoints made the cut. Implemented as `exportGraph()` in `graph.ts`.
- **Browser auth for /viz.** The page shell is served without auth (like `/health` — it contains no data or secrets; all memory content comes from the bearer-only `/graph` endpoint). Remote browsers authenticate client-side: paste the token once into the in-page prompt (persisted in localStorage), or open `/viz?token=<authToken>` (the page strips the token from the URL on load). Localhost needs no token, as before. All data routes remain header-only.
- **/viz v2: 3D graph by default + 2D toggle, always-visible labels, redesigned controls (closes #139).** Follow-up on owner feedback that the hand-rolled 2D canvas was not intuitive (anonymous dots, unclear controls).
  - **3D default view** rendered with `3d-force-graph`; one-click toggle to a 2D view (`force-graph`). Same data (`/graph?op=export`) and same encodings in both: node color = knowledge domain, size = effective strength, halo = hub, edge color = relationship type (dashed CONTRADICTS in 2D; color-only in 3D).
  - **Vendored renderers, still zero external requests.** Pinned standalone bundles of three.js 0.183.0, 3d-force-graph 1.80.0, and force-graph 1.51.4 (all MIT) ship inside the package under `assets/vendor/` and are served same-origin by the daemon — no CDN, works offline. Versions, copyrights, and full license texts in the new `THIRD_PARTY_NOTICES.md`.
  - **`GET /viz/vendor/:file`** — new public asset route with a strict four-filename allowlist (anything else 404s; the served path is never built from request input). Auth exemption is as narrow as the /viz shell's: GET-only, exact allowlisted paths; all data routes stay bearer-only.
  - **Always-visible labels.** Hubs and the strongest memories are labeled permanently (canvas-texture sprites in 3D, canvas text in 2D, ~40 chars); the remaining labels fade in as you move the camera closer (3D) or zoom in (2D). Label density is adjustable.
  - **Controls redo.** Grouped left panel — Filters (domain, type, min strength, node limit, Apply), View (3D/2D toggle, similarity-edge threshold, label density), Search (matches highlighted, everything else dimmed) — plus a collapsible "How to read this" hint. Weak similarity edges are hidden by default (threshold slider reveals them). Click a node for the full memory; Esc closes.

## [0.10.1] - 2026-07-03

### Fixed
- npm README: added the missing "Install — Hermes" section (mirror-repo install + `hermes memory setup hicortex`); harness ordering. Identical code to 0.10.0.

## [0.10.0] - 2026-07-03

### Added
- **Domain-aware lesson selection restored into core (closes #123).** PR #122 deleted `src/pro/selection.ts` with the Pro loader instead of promoting it into core; free personal self-host = the full product, so the scoring selector is now THE default for every install. Recovered from git history to `src/lesson-selection.ts` (`domainAwareLessonSelector`) and registered as `defaultLessonSelector` in `extensions.ts` (the `setExtensions` override hook is unchanged). Scores lessons by project match (1.0 exact / 0.5 same-domain via `moduleIndex` / 0.3 global) + recency (30-day half-life) + base_strength + access affinity, then dedups near-identical lessons by normalized prefix. Metadata-free lesson pools keep their input order (stable sort), matching the old slice behaviour. Both selection call sites (CC SessionStart `lessons-context`, OC plugin `before_agent_start`) already pass `moduleIndex`.
- **Unified tool surface (closes #125).** All three clients now expose the same 8 memory tools: `hicortex_search`, `hicortex_context`, `hicortex_ingest`, `hicortex_lessons`, `hicortex_index`, `hicortex_graph`, `hicortex_update`, `hicortex_delete`. Previously: MCP had all 8; OC plugin had 4; Hermes plugin had 2.
  - REST: `POST /update` (re-embeds on content change, 404 on unknown id), `POST /delete` (cascade via `storage.deleteMemory`), `GET /index` (module/domain index), `GET /graph?op=neighbors|hubs|path` (graph queries). All endpoints use the same bearer-auth/localhost-bypass as existing routes. The `/graph` JSON shape (`{results}`, `{hubs}`, `{path}`) is designed for future reuse by the `/viz` feature (#124).
  - OC plugin: `hicortex_index` → `GET /index`, `hicortex_graph` → `GET /graph`, `hicortex_update` → `POST /update`, `hicortex_delete` → `POST /delete`. Added to `ensureToolsAllowed` list.
  - Hermes plugin (`hermes-plugin/hicortex/`): adds `hicortex_context`, `hicortex_ingest`, `hicortex_lessons`, `hicortex_index`, `hicortex_graph`, `hicortex_update`, `hicortex_delete` (7 new tools). `client.py` gains `_post()` for the write operations plus `index()`, `graph()`, `ingest()`, `update()`, `delete()` methods. Plugin bumped to v0.4.0.
  - `hicortex_recall_recent` (Hermes-specific alias for context recall) is retained as a 9th tool in the Hermes plugin.


### License
- **License changed from MIT to PolyForm Noncommercial 1.0.0.** Personal and noncommercial use remains fully free. Commercial use (for-profit businesses, client work, revenue-generating products) requires a per-seat license. Versions ≤ 0.7.1 published to npm remain MIT-licensed and are not affected. Copyright holder: Aironic Ventures Ltd.
- **All feature gates removed.** The 250-memory cap, remote-ingest restriction, and 10/20 lessons split are gone. The product is fully featured for all self-hosted users. The `licenseKey` config key is still accepted and now controls only the "licensed to" display line in `hicortex status`.
- **Pro loader retired.** `src/pro-loader.ts`, `src/pro/`, and `tsconfig.pro.json` have been deleted. The `ProActivationContext` / `ProPackage` interfaces and `createProActivationContext` factory in `extensions.ts` are removed. The OSS `defaultLessonSelector` and `defaultPromptStrategy` remain and are the only active implementations.

### Changed
- **Server-mode `init` generates a random auth token** (`hctx-<32 hex chars>`) on first run and stores it in `~/.hicortex/config.json`. The token is printed once with its storage location. Re-running `init` never overwrites an existing token. `hicortex status` displays the active token in server mode so clients can retrieve it without manual file inspection. The hardcoded default `hctx-default-token` has been removed — servers without an explicit `authToken` in config and without `HICORTEX_AUTH_TOKEN` set now start unauthenticated with a prominent warning.
- **LLM selection is now user-controlled.** `init` detects candidates from all harnesses on the machine (Ollama, Claude CLI, env vars, Hermes `.env`, Claude Code settings, OpenClaw auth-profiles) and presents a numbered list. The user picks one. Nothing is auto-applied — not even when exactly one candidate is detected.
- **Explicit-only LLM resolution at runtime.** The server resolves LLM config only from explicit config-file backends (`llmBackend: "claude-cli"`, `llmBackend: "ollama"`) or explicit config/env overrides (`llmBaseUrl + llmApiKey`, `HICORTEX_LLM_BASE_URL + HICORTEX_LLM_API_KEY`). Ambient env keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`) are detection signals at init time, not silent runtime defaults.
- **Recall-only degradation when no LLM is configured.** The server now starts successfully even without an LLM. An unmissable startup warning explains the state. Search, lessons, and context continue to work; `/distill` and consolidation are disabled until `npx @gamaze/hicortex init` is run. `/health` reports `llm: "not configured"` in this state.
- **OpenClaw plugin migrated to the recall-only adapter model** (refs #113), exactly like the Hermes plugin. The plugin requires a Hicortex server (`npx @gamaze/hicortex init`). No local database, embedder, LLM, or capture code runs inside the OC process.
- **Capture: new `oc-transcript-reader.ts` in the nightly.** OpenClaw persists sessions at `~/.openclaw/agents/<agentId>/sessions/*.jsonl` in the Pi v3 event format, so the existing Pi parser reads them — canonical nightly-from-logs, identical to CC JSONL and Hermes `state.db`. The harness store is the retry queue (watermark semantics unchanged); provenance is `openclaw/<agentId>`. Wired into both server- and client-mode nightly runs. Known limitation: rotated `*.jsonl.reset.*` files are not read.
- **Lessons: `before_agent_start` hook** fetches `GET /lessons` at agent start (3s timeout). Fail-soft: any error or timeout returns `{}` — the agent starts unblocked. Replaces the in-process `storage.getLessons()` call.
- **Tools become HTTP proxies.** `hicortex_search` → `GET /search`, `hicortex_context` → `GET /context`, `hicortex_ingest` → `POST /ingest`, `hicortex_lessons` → `GET /lessons`. Auth header included when `authToken` is configured. `hicortex_update` and `hicortex_delete` are removed (no REST equivalent on the server).
- **Config keys** `serverUrl` (default `http://127.0.0.1:8787`) and `authToken` replace `llmBaseUrl`, `llmApiKey`, `llmModel`, `reflectModel`, `consolidateHour`, and `dbPath` in `openclaw.plugin.json`.
- **`scheduleConsolidation` removed** from the OC plugin. Consolidation is owned exclusively by the server nightly.
- `openclaw.plugin.json` version bumped to `0.10.0`.

### Removed
- `resolveLlmConfig` (OpenClaw-config auto-pull) and its private helpers (`readOpenClawConfig`, `readOcProviderBaseUrl`, `readOcAuthKey`, `resolveFromEnv`, `getEnvKeyForProvider`) from `llm.ts`.
- `preferOllamaForBatch` — dead export, no callers since 0.9.0.
- Implicit env-key fallbacks (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`) from runtime LLM resolution; Claude CLI and Ollama silent fallbacks removed.
- In-process `initDb`, `embed`, `distillSession`, `runConsolidation`, `scheduleConsolidation`, `LlmClient`, `autoConfigureLlm`, `persistProviderConfig` from `index.ts`.
- `session_end` hook (opportunistic consolidation logic).
- `hicortex_update` and `hicortex_delete` tools (no server REST equivalent).

### Capture-path decision record
An initial implementation captured via the `agent_end` hook with a local pending-payload queue, on the assumption that OC's session store was unreadable. Inspection of real OC session files disproved this: they are plain JSONL in the **Pi v3 event format** (`session`/`model_change`/`message`/`custom` — OpenClaw is Pi-runtime based), which `pi-transcript-reader.ts` already parses. The hook capture and pending queue were removed in favor of the nightly reader — one capture model for every harness.

### Fixed
- **Server-mode `init` now installs the nightly job** (refs #116). Previously only client installs got a scheduled nightly; a fresh server-mode install never captured or consolidated (masked pre-0.9.2 by the daemon's internal scheduler, which was removed). Defaults are staggered — client 02:00, server 03:00 local — so clients push sessions before the server's capture + consolidation run. Override with `nightlyHour` (0–23) in `~/.hicortex/config.json`. Existing schedule files are never overwritten on re-init.

## [0.9.2] - 2026-07-02

### Added
- **`nightly --capture-only` flag.** In server mode: runs the full capture pipeline (read → denoise → POST /distill) but skips consolidation and the telemetry ping. Designed for sub-daily capture schedules on machines that host Hermes agents, where the "dream" (consolidation) should still run exactly once per day via the regular nightly timer. Watermark semantics are identical to a full run: `lastNightly` is only advanced on a clean capture. In client mode the flag is accepted and has no effect (client nightly is already capture-only).

## [0.9.1] - 2026-07-02

### Changed
- **Strict distill fallback by default.** When a separate `distillBaseUrl` is configured and the remote probe fails, distillation now aborts immediately without falling back to the weak base model. The nightly watermark is not advanced, so the session is re-shipped on the next run (harness stores retain raw sessions for 30–90 days — the retry is the queue). Produces no memories rather than low-quality ones.
- `resolveDistillFallback` gains a `mode` parameter: `"strict"` (default) or `"local"` (restores 0.9.0 fall-back-to-base behaviour). Configure via `distillFallback: "local"` in `~/.hicortex/config.json`.
- `/distill` 503 response text now explicitly mentions retry: `"Distill endpoint unavailable — session will be retried next run"`.

### Fixed
- **Embedding model cache moved to `~/.hicortex/models`.** It previously defaulted to a cache inside the installed package directory — root-owned for global installs (every `/distill` failed with EACCES) and wiped on every upgrade (~130 MB re-download). The cache now survives upgrades and works under `npm install -g`.

## [0.9.0] - 2026-07-02

### Changed
- **Unified capture via POST /distill.** Every machine — including the server's own nightly — now captures by denoising locally and POSTing to `/distill`. No local LLM required for capture on any machine; all distillation happens on the server. Removes the two-path architecture that caused duplication and quality variance.
- **Clients no longer need a local LLM.** `runClientNightly` strips all LLM machinery (distillation, chunk detection, fallback probing). Client = read → denoise → POST.
- **Query-time lessons via CC SessionStart hook.** A new `hicortex lessons-context` command fetches `/lessons` at session start and prints a compact Markdown block to stdout (CC context). Replaces file-based `injectLessons`/`injectLessonsFromServer`. Fail-soft: any error = silent exit 0.
- **`/distill` is now the canonical capture endpoint.** Extended to accept `text` (string) in addition to `messages` (array); `session_date` sets `created_at`; session-level dedup (LIKE-escaped prefix); `resolveDistillFallback` per request; cached `detectChunkSize` per endpoint. Body limit raised to 25 MB.
- **Single consolidation owner.** Removed `scheduleConsolidation` from the MCP server daemon. Consolidation runs exclusively via the nightly timer. The OC in-process plugin keeps its own scheduler (unchanged).

### Removed
- `injectLessons` (claude-md.ts) and `injectLessonsFromServer` (nightly.ts) — replaced by `lessons-context` SessionStart hook.
- `lessonTarget` config key — no longer used; lessons are query-time, not written to files.
- `consolidateHour` option on `startServer` — consolidation is now nightly-only.
- Client-mode LLM config, `preferOllamaForBatch`, `distillSession`, `detectChunkSize` from `runClientNightly`.

### Added
- `src/lessons-context.ts` — new module + CLI command for CC SessionStart lesson injection.
- `init` installs the SessionStart hook and strips old static CLAUDE.md blocks on upgrade.
- `uninstall` removes the SessionStart hook entry.

## [0.8.0] - 2026-07-02

### Added
- **Hermes support** — a recall-only `MemoryProvider` plugin (`hermes-plugin/hicortex/`) plus a nightly `state.db` reader (`readHermesSessions`) so Nous Hermes agent sessions are captured and recalled like Claude Code.
- Graceful distill fallback: if the remote distill endpoint is unreachable, the nightly falls back to the local model instead of stalling capture.

### Changed
- **Capture model confirmed: nightly-from-logs.** A per-machine nightly reads each harness's own durable store (Claude Code JSONL, Hermes `state.db`, Pi sessions), distills server-side, and discards raw. The event-driven "capture at compaction" direction was evaluated and rejected — both CC and Hermes persist full history on disk.
- The Hermes plugin is **recall-only** (search + lesson injection); capture is the nightly reader's job, not the plugin's.
- Per-chunk `source_session` dedup so a multi-chunk session isn't collapsed to a single memory.

### Fixed
- Hermes `init` no longer edits `config.yaml` with regex (which had corrupted live agent setups) — it installs plugin files and defers activation to `hermes memory setup`.

## [0.7.1] - 2026-04-21

### Added
- **LLM-assisted edge classification** (#92) — new semantic relationship types
  (CONTRADICTS, SUPERSEDES, DEPENDS_ON, CAUSED_BY, VALIDATES) alongside existing
  heuristic types. Batched LLM classification (8 pairs/call) with per-pair
  heuristic fallback on failure or budget exhaustion.
- **Relationship filter** on `hicortex_graph` MCP tool — filter neighbors by
  edge type (e.g., `relationship: "CONTRADICTS"`).

## [0.7.0] - 2026-04-21

### Added
- **Graph-based community detection** (#88) — Louvain algorithm discovers
  knowledge domains from the memory link graph. Zero LLM cost, runs during
  consolidation. OSS users now get meaningful domain clustering instead of
  the flat project=domain fallback.
- **Hub node detection + strength boost** (#89) — memories with link count
  above 2x median (minimum 3) get a +0.1 base_strength boost during
  consolidation. Foundational insights surface higher in lesson selection.
- **`hicortex_graph` MCP tool** (#91) — three graph traversal operations:
  `neighbors` (connected memories), `hubs` (most connected nodes, filterable
  by domain), `path` (shortest path between two memories via BFS).
- New `graph.ts` module: pure-JS Louvain community detection, hub detection,
  neighbor query, shortest path. No external dependencies.

## [0.6.0] - 2026-04-12

### Added
- **Knowledge domain routing (MODULE_INDEX)** — memories are automatically
  grouped into knowledge domains during nightly consolidation. Pro users get
  LLM-curated domains (one cheap batch call per nightly, only when projects
  change); OSS users get project-based grouping.
- **Domain-aware lesson injection** — the Memory Index section in CLAUDE.md /
  EXPERIENCE.md is now structured by domain with memory counts, lesson counts,
  and keywords. Replaces the flat `project: count` format.
- **Domain-aware Pro selector** — lessons from the same knowledge domain as the
  current project score 0.5 (previously 0.0 for non-exact matches). Exact
  project match remains 1.0, global 0.3.
- **`hicortex_index` MCP tool** — agents can query the knowledge domain index
  to understand what topics are stored in memory before searching.
- **Configurable injection token budget** — `moduleIndexTokenBudget` in
  config.json controls how many tokens the domain index occupies in the
  injection block. Default: 500.
- Schema migration v3: `domain` column on memories table with index.

### Changed
- `/lessons` REST endpoint now includes `moduleIndex` in the response for
  client-mode domain-aware injection.
- `runConsolidation()` accepts optional `stateDir` parameter for consistent
  state management across all stages.

## [0.5.3] - 2026-04-12

### Added
- **Pre-ingestion redaction** (#78) — scrubs API keys, tokens, paths, and
  generic secrets from transcripts BEFORE they reach the distillation LLM or
  storage. 12 default patterns (Anthropic, OpenAI, Stripe, GitHub, Google,
  AWS, Bearer, Hicortex, generic key=value, macOS paths, Linux paths).
  Configurable via `redaction` in config.json. Opt-out: `redaction.enabled: false`.
- **Contradiction detection** (#73) — during nightly reflection, each new
  lesson candidate is checked against existing lessons via vector similarity.
  If a semantically similar lesson exists (>0.80 cosine) and the LLM judges
  them contradictory, the new lesson is suppressed. Prevents the "false
  coherence" failure mode where wrong lessons reinforce themselves. Fully
  autonomous, logged for audit.

## [0.5.0] - 2026-04-11

### Added
- **Pi agent support** — first-class support for the Pi coding agent framework.
  - New Pi transcript reader (`pi-transcript-reader.ts`) reads session JSONL from
    `~/.pi/agent/sessions/` in Pi's v3 format (session, model_change, message
    with role: user/assistant/toolResult, custom events).
  - Nightly pipeline auto-detects Pi sessions alongside CC sessions — both are
    processed in the same run, stored in the same DB, share the same lessons.
  - MCP tools work via `pi-mcp-adapter` connecting to `http://localhost:8787/sse`.
  - Pi agents receive lessons via a configurable injection target (see below).
- **Configurable lesson injection target** — new `lessonTarget` field in
  `~/.hicortex/config.json`. Set it to your agent's learning file path
  (e.g., `.pi/EXPERIENCE.md` for Pi agents) instead of the default
  `~/.claude/CLAUDE.md`. The injection uses the same managed block pattern
  (`<!-- HICORTEX-LEARNINGS:START -->`) and is idempotent.
- **Pro extension infrastructure** — the OSS client can now download, verify,
  and dynamically load commercial Pro extension packages at runtime.
  - `ProActivationContext` interface in `extensions.ts` — narrow API that Pro
    packages receive at boot to register their extensions.
  - `pro-loader.ts` — downloads Pro tarball from the license API, verifies
    sha256, extracts to `~/.hicortex/pro/`, dynamic-imports and activates.
  - Fails soft — if Pro download/load/activation fails, OSS defaults apply
    and the host keeps running without a crash.
- **Pro tarball distribution endpoints** on the license API (`web/api/app.py`):
  - `GET /api/pro/meta` — returns `{ version, sha256, url }` for the latest
    Pro release. Requires a valid paid license key.
  - `GET /api/pro/download?v=<version>` — streams the tarball with Bearer auth
    and rate limiting (10/min per IP).
  - Path-traversal protection on version string + resolved-path containment check.
- **Release tooling** — `scripts/release-pro.sh` builds, packs, and (optionally)
  deploys Pro tarballs to the VPS.

### Changed
- Package directory renamed: `packages/openclaw-plugin/` → `packages/hicortex/`.
  The npm package name (`@gamaze/hicortex`) is unchanged.
- `extractConversationText` now correctly detects user/assistant roles from
  Pi's `message.role` field (previously only checked CC's `entry.type`).
- `toolResult` / `tool_result` entries are now skipped during distillation —
  tool output (file listings, JSON state, command output) is noisy bulk that
  adds nothing to knowledge extraction.
- Copyright updated to Aironic Ventures Ltd. (the legal entity behind Gamaze)
  in both the MIT LICENSE and package.json.

## [0.4.6] - 2026-04-07

### Fixed
- **Nightly data-loss bug** — when the distillation LLM was unreachable or
  the required model was missing, the nightly pipeline would silently log
  "0 memories extracted" for every session and then advance the `lastRun`
  watermark anyway. Those sessions were permanently lost — they'd be older
  than the new watermark next run and never retried.
  - Root cause: `distillChunk` caught all LLM errors and returned an empty
    array, making transient failures indistinguishable from legitimate
    "nothing to extract" outcomes.
  - Fix (5 parts):
    1. `distillChunk` now throws on transient LLM errors; returns `[]` only
       for legitimate empty results (NO_EXTRACT, empty response).
    2. `distillSession` rethrows if ALL chunks fail; returns partial
       results with a warning if some chunks succeed.
    3. Nightly pipeline (both server + client mode) tracks `hadTransientFailure`
       and only advances `lastRun` if every session was processed cleanly.
    4. Server-mode adds per-session dedup (`source_session` check) before
       distilling — makes retries idempotent, matches client-mode behaviour
       which already had this via the server's `/ingest` endpoint.
    5. Pre-flight health check on remote Ollama distill endpoints via a new
       `probeOllamaModel` helper — verifies both reachability AND that the
       required model is present in `/api/tags`. Aborts early with a clear
       message if unreachable or model missing, avoiding minutes of timeouts.
  - Added 7 regression tests for the new error-propagation contract.

## [0.4.5] - 2026-04-07

### Changed
- Pre-public OSS hardening: scrubbed internal references (hostnames, internal
  framework names, personal config), removed first-class support for personal
  base-URL overrides, updated outdated LLM model versions to current releases.
  License remains MIT, repository remains `gamaze-labs/hicortex`.

### Fixed
- `openclaw.plugin.json` version field updated to match `package.json`
- `openclaw.plugin.json` free tier description corrected (was "100", actual is 250)

## [0.4.4] - 2026-04-06

### Added
- **Centralized feature gating** (`src/features.ts`) — single source of truth
  for tier-dependent values. Replaces 8+ scattered `getFeatures()` call sites.
- **Extension interfaces** (`src/extensions.ts`) — `LessonSelector` and
  `PromptStrategy` define the seam for future commercial Pro features.
  The OSS client ships default implementations preserving current behaviour;
  Pro features plug in at runtime via `setExtensions()`.
- **Versioned schema migrations** — `schema_version` table + migration runner
  with transactional application. Replaces ad-hoc `ALTER TABLE` on every boot.
- **Consolidated state file** — single `~/.hicortex/state.json` replaces four
  separate state files. One-time legacy migration on first boot.
- **`src/pro/` IP boundary** — `tsconfig.json` excludes `src/pro/**` from build
  so commercial code can never compile into `dist/` and reach npm.
- **96 vitest tests** for features, extensions, schema versioning, and state
  migration (all passing in <1s).

### Fixed
- **License validation race** — Pro users could see free-tier features during
  the async validation window because `getFeatures()` was sync but
  `validateLicense` was async with a module-global cache. Now `initFeatures()`
  reads a persisted tier from `~/.hicortex/state.json` synchronously at boot,
  awaits validation only on first run, and re-validates in background on
  subsequent boots.
- **Dynamic-import-in-loop bug** in `consolidate.ts` reflection stage — was
  added to dodge a circular import. Now resolved via the centralized
  `features.ts`.

### Changed
- `injectLessons()` is now async (callers updated).
- `LessonSelector` is generic over `T extends SelectableLesson` so the same
  interface works for `Memory[]` (server mode) and HTTP-shape lessons
  (client mode).
- License is now **MIT**. Repository moved to `gamaze-labs/hicortex`.

### Removed
- Python backend prototype (no longer maintained or deployed).

## [0.4.3] - 2026-04-06

### Fixed
- **Client mode lesson injection** — clients now fetch lessons + memory index
  from server and inject into CLAUDE.md on every nightly run. Previously,
  client mode never updated CLAUDE.md (no local DB), so agents on client
  machines saw zero lessons.
  - New `GET /lessons` REST endpoint on server returns lessons + memory index
  - Client `nightly` calls server `/lessons` after distill/ingest, formats
    block, writes `~/.claude/CLAUDE.md`
  - Same format as server-mode injection (lessons, memory index, getting-
    started tips when empty)

## [0.4.0] - 2026-03-28

### Added
- **Multi-client architecture** — connect multiple clients to one shared
  memory server.
  - Client mode: `npx @gamaze/hicortex init --server <url>` (no local DB,
    no daemon)
  - `POST /ingest` REST endpoint for remote memory ingestion with dedup
  - Clients distill sessions locally (privacy), POST extracted memories to
    a central server
  - Default auth token on all endpoints (baseline security)
- **Auto-detect LLM** — init detects Ollama models (ranked by size), Claude
  CLI, API keys, and OpenClaw config.
  - Recommends largest local model (9b+), shows all options in one prompt
  - Ollama streaming mode for large prompts (fixes Node.js headers timeout)
  - 3 retries with exponential backoff (30s, 60s, 120s) for transient failures
- **Split LLM configuration** — separate models for scoring, distillation,
  and reflection (`distillModel`, `reflectModel`, `reflectBaseUrl`,
  `reflectProvider` in config.json). Supports different Ollama instances on
  different machines (e.g. local 9b + remote 27b).
- **6 MCP tools** — added `hicortex_update` and `hicortex_delete`.
  - Update with re-embedding on content change, returns before/after diff
  - Delete with cascade (memory + vector + links), returns deleted content
  - Short ID prefix resolution (8+ chars, must be unambiguous)
- **Balanced reflection prompt** — extracts lessons from both successes AND
  failures.
  - Lesson types: reinforce, correct, principle
  - Feeds recent 7-day lessons to prevent duplicates and enable escalation
  - Privacy guard: no personal data in lesson text
- **Named relationship types** — link classification during consolidation
  (`updates`, `derives`, `extends`, `relates_to`). Heuristic, zero extra
  LLM cost.
- **`updated_at` timestamp** on memories for audit trail.
- **License tier enforcement** — Free (250 mems, multi-client trial), Pro
  (unlimited, single client), Team (unlimited, multi-client).

### Changed
- MCP tool permissions auto-added to CC settings during init
- CORS middleware before auth (fixes preflight 401 for remote browser clients)
- Anthropic URL construction handles both `/v1`-suffixed and bare base URLs

### Fixed
- Node.js `fetch` headers timeout on large Ollama prompts — switched to
  streaming mode
- Race condition in concurrent LLM calls with overridden base URLs
- Express SSE/messages handlers wrapped in try/catch (no unhandled rejections)

## Earlier releases

The 0.1.x – 0.3.x series was an internal Python prototype. Hicortex was
re-implemented in TypeScript starting with 0.4.0 (the first npm release)
and the Python prototype is no longer maintained.
