# Hicortex Changelog

All notable changes to this project are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/).

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
