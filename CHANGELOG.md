# Hicortex Changelog

All notable changes to this project are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/).

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
- **Unified capture via POST /distill.** Every machine — including the server's own nightly — now captures by denoising locally and POSTing to `/distill`. No local LLM required for capture on any machine; all distillation happens on the server (bedrock). Removes the two-path architecture that caused duplication and quality variance.
- **Clients no longer need a local LLM.** `runClientNightly` strips all LLM machinery (distillation, chunk detection, fallback probing). Client = read → denoise → POST.
- **Query-time lessons via CC SessionStart hook.** A new `hicortex lessons-context` command fetches `/lessons` at session start and prints a compact Markdown block to stdout (CC context). Replaces file-based `injectLessons`/`injectLessonsFromServer`. Fail-soft: any error = silent exit 0.
- **`/distill` is now the canonical capture endpoint.** Extended to accept `text` (string) in addition to `messages` (array); `session_date` sets `created_at`; session-level dedup (LIKE-escaped prefix); `resolveDistillFallback` per request; cached `detectChunkSize` per endpoint. Body limit raised to 25 MB.
- **Single consolidation owner.** Removed `scheduleConsolidation` from the MCP server daemon. Consolidation runs exclusively via the nightly timer (bedrock: systemd 17:17 UTC). The OC in-process plugin keeps its own scheduler (unchanged).

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
