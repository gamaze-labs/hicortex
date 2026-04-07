# Hicortex Changelog

All notable changes to this project are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/).

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
- **`src/pro/` IP boundary** — `tsconfig.json` excludes `src/pro/**` from build
  so commercial code can never compile into `dist/` and reach npm.
- **31 new vitest tests** for features, extensions, and schema versioning
  (81 total, all passing).

### Fixed
- **License validation race** — Pro users could see free-tier features during
  the async validation window because `getFeatures()` was sync but
  `validateLicense` was async with a module-global cache. Now `initFeatures()`
  reads a persisted tier from `~/.hicortex/tier.json` synchronously at boot,
  awaits validation only on first run, and re-validates in background on
  subsequent boots.
- **Dynamic-import-in-loop bug** at `consolidate.ts:308` — was added to dodge
  a circular import. Now resolved via the centralized `features.ts`.

### Changed
- `injectLessons()` is now async (callers updated).
- `LessonSelector` is generic over `T extends SelectableLesson` so the same
  interface works for `Memory[]` (server mode) and HTTP-shape lessons
  (client mode).

### Removed
- Python backend (`hicortex/`, `tests/`, `pyproject.toml`, `uv.lock`,
  `deploy/*.service`, root `Dockerfile`, `.env.example`) — bedrock now runs
  the TypeScript MCP server, the Python files were stale leftovers.

## [0.4.3] - 2026-04-06

### Fixed
- **Client mode lesson injection** — clients now fetch lessons + memory index from server and inject into CLAUDE.md on every nightly run. Previously, client mode never updated CLAUDE.md (no local DB), so agents on client machines saw zero lessons. The core delivery mechanism was broken.
  - New `GET /lessons` REST endpoint on server returns lessons + memory index payload
  - Client `nightly` calls server `/lessons` after distill/ingest, formats block, writes `~/.claude/CLAUDE.md`
  - Same format as server-mode injection (lessons, memory index, getting-started tips when empty)

## [0.4.0] - 2026-03-28

### Added
- **Multi-client architecture** — connect multiple clients to one shared memory server
  - Client mode: `npx @gamaze/hicortex init --server <url>` (no local DB, no daemon)
  - `POST /ingest` REST endpoint for remote memory ingestion with dedup
  - Clients distill sessions locally (privacy), POST extracted memories to central server
  - Default auth token on all endpoints (baseline security)
- **Auto-detect LLM** — init detects Ollama models (ranked by size), Claude CLI, API keys, OC config
  - Recommends largest local model (9b+), shows all options in one prompt
  - Ollama streaming mode for large prompts (fixes Node.js headers timeout)
  - 3 retries with exponential backoff (30s, 60s, 120s) for transient failures
- **Split LLM configuration** — separate models for scoring, distillation, and reflection
  - `distillModel`, `reflectModel`, `reflectBaseUrl`, `reflectProvider` in config.json
  - Supports different Ollama instances on different machines (e.g. local 9b + remote 27b)
- **6 MCP tools** — added `hicortex_update` and `hicortex_delete`
  - Update with re-embedding on content change, returns before/after diff
  - Delete with cascade (memory + vector + links), returns deleted content for audit
  - Short ID prefix resolution (8+ chars, must be unambiguous)
- **Balanced reflection prompt v2** — extracts lessons from both successes AND failures
  - Lesson types: reinforce, correct, principle
  - Feeds recent 7-day lessons to prevent duplicates and enable escalation
  - Focus areas: omissions, near-misses, contradictions, cross-agent patterns, process feedback
  - Privacy guard: no personal data in lesson text
- **Named relationship types** — link classification during consolidation
  - `updates` (same type, high similarity, newer), `derives` (lesson↔episode), `extends` (same project), `relates_to` (fallback)
  - Zero extra LLM cost — heuristic classification inline during link discovery
- **`updated_at` timestamp** on memories for audit trail (auto-set on update)
- **License tier enforcement** — Free (250 mems, multi-client trial), Pro (unlimited, single client), Team (unlimited, multi-client)
  - `remoteIngest` feature flag: Pro blocks remote `/ingest`, Free and Team allow it

### Changed
- MCP tool permissions auto-added to CC settings.json during init (`mcp__hicortex__*`)
- MCP fallback writes to `~/.claude.json` (correct file for MCP servers), not `settings.json`
- Ollama config path in mcp-server.ts handles `llmBackend=ollama` without API key
- Nightly CLI reads full config (ollama, distillModel, reflectBaseUrl) from config.json
- CORS middleware before auth (fixes preflight 401 for remote browser clients)
- `stateDir` uses `path.dirname()` instead of regex (fixes custom DB paths)
- Anthropic URL construction has `hasVersion` guard (no more double `/v1/v1/messages`)

### Fixed
- Node.js `fetch` headers timeout on large Ollama prompts — switched to streaming mode
- `completeWithOverride` uses temporary `LlmClient` clone (fixes race condition under concurrent calls)
- Express `/sse` and `/messages` handlers wrapped in try/catch (prevents unhandled rejections)
- Dead code removed: `getEnvKeyForZai`, `readAgentModelsBaseUrl`

## [0.3.15] - 2026-03-27

(Previously released as 0.9.2 internally)

## [0.9.2] - 2026-03-26

### Added
- **Claude Code support** — same `@gamaze/hicortex` package now works with both OpenClaw and Claude Code
  - Persistent HTTP/SSE MCP server (`npx @gamaze/hicortex server`) on port 8787
  - 4 MCP tools: `hicortex_search`, `hicortex_context`, `hicortex_ingest`, `hicortex_lessons`
  - `npx @gamaze/hicortex init` — auto-detects environment, installs daemon (launchd/systemd), registers MCP with CC via `claude mcp add`
  - `npx @gamaze/hicortex nightly` — reads CC transcripts, distills, consolidates, injects lessons into CLAUDE.md
  - `npx @gamaze/hicortex status` — shows DB stats, adapter status, server health
  - `npx @gamaze/hicortex uninstall` — clean removal via `claude mcp remove`, preserves DB
  - CC custom commands with proper YAML frontmatter: `/learn`, `/hicortex-activate` (auto-restarts server after activation)
  - CLAUDE.md injection: `<!-- HICORTEX-LEARNINGS -->` block with agent guidance + active lessons
  - Seed lesson ("1% Daily Self-Improvement") injected on CC server startup (was OC-only)
- **Unified DB path** — canonical location at `~/.hicortex/hicortex.db`
  - Auto-migration from legacy `~/.openclaw/data/hicortex.db` with symlink for backward compat
  - Shared across OC, CC, and future adapters (Codex, Gemini)
- **CC LLM resolution** (`resolveLlmConfigForCC`) — env-var-first, defaults to Haiku for distillation (~$0.50/mo)
- **CC transcript reader** — reads `.jsonl` session files from `~/.claude/projects/`, decodes project names
- **Consolidation coordination** — lock file + owner tracking prevents duplicate runs across adapters
- **License key in CC mode** — reads from `~/.hicortex/config.json`, env var, or explicit option
- `last-consolidated.txt` moved to `~/.hicortex/` (shared across adapters)

### Changed
- OC plugin npm package bumped to v0.3.7
- `resolveDbPath()` centralizes DB location logic for all adapters
- Package now includes `bin` field for CLI (`npx @gamaze/hicortex`)
- Added `express` and `@modelcontextprotocol/sdk` as dependencies
- Seed lesson extracted to shared `seed-lesson.ts` module (used by both OC and CC)

### Fixed
- MCP server creates per-connection `McpServer` instances — fixes "Already connected to a transport" error that broke multi-session and `claude mcp list` health checks
- `claude mcp add` used for CC registration instead of manual JSON (CC ignores `settings.json` for MCP)
- Init removes existing MCP entry before re-adding (handles "already exists" gracefully)
- Init detects CC MCP in both `.claude.json` and `settings.json`
- Express body parsing passed to SSE `handlePostMessage` (fixes stream consumed error)
- Zod `z.coerce.number()` for MCP tool params (CC sends numbers as strings)
- EADDRINUSE shows helpful message instead of stack trace
- Daemon plist/systemd uses tag-based version (`@next` or bare) instead of pinned version for automatic upgrades

## [0.9.1] - 2026-03-25

### Added
- **OpenClaw plugin** (`@hicortex/memory`) — pure TypeScript, runs in-process with OC gateway. No Python sidecar.
  - better-sqlite3 + sqlite-vec for storage (same schema as Python, migration compatible)
  - @huggingface/transformers for local embeddings (bge-small-en-v1.5, ONNX)
  - Multi-provider LLM client: 20 providers supported (OpenAI, Anthropic, z.ai, Groq, DeepSeek, Ollama, etc.)
  - Auto-config on first run: detects OC provider, tests connection, persists config. Zero manual setup.
  - Hooks: `before_agent_start` (lesson injection), `agent_end` (session capture), `session_end` (distillation trigger)
  - Tools: `hicortex_search`, `hicortex_context`, `hicortex_ingest`, `hicortex_lessons`
  - Skills: `/learn` (save explicit learnings), memory tool guidance
  - Seed lesson: "1% Daily Self-Improvement Protocol" injected on first install
  - Rate limit handling with 5h01m retry backoff
  - License validation with 24h cache and 7-day offline grace
- Python backend: `main()` CLI entry point with `--host`/`--port` args, `__main__.py` for `python -m hicortex`
- `.env` now optional — supports `HICORTEX_ENV_PATH` override for sidecar/embedded use
- `num_ctx: 32768` for Ollama calls (prevents context truncation on reflection)
- **Stripe payment integration** — Payment Links, webhook handler, license key generation, email delivery via Resend
- **License API improvements** — rate limiting (60/min validate, 10/min webhook), session-based license lookup, test mode support

### Changed
- Free tier: full features with 100 memory cap (was restricted features with 500 cap)
- Consolidation time moved to 17:00 UTC (20:00 Helsinki) for MBP Ollama availability
- Reflection on bedrock uses MBP qwen3.5:27b via Tailscale (was Ollama Cloud)

### Fixed
- Reflection empty response — increased `max_tokens` from 2048 to 8192 for thinking models
- z.ai uses Anthropic-compatible endpoint (`api.z.ai/api/anthropic`), not OpenAI — OpenAI endpoint returns empty content due to thinking tokens
- z.ai Coding Plan endpoint auto-detection (coding vs pay-as-you-go)
- OC plugin tool `execute()` signature: `(callId, args, context)` — undocumented
- OC `tools.profile: "coding"` filters plugin tools — documented in install instructions
- Tool name conflict with memory-core resolved (`hicortex_*` prefix)
- Plugin kind changed from `"memory"` to `"lifecycle"` — doesn't replace OC working memory

## [0.9.0] - 2026-03-23

### Added
- **Nightly reflection / self-improvement** — new consolidation stage 2.5 analyzes daily memories with a cloud LLM (REFLECT tier, default `qwen3.5:cloud`) and generates actionable lessons stored as `memory_type="lesson"` with severity and confidence ratings
- `memory_lessons` MCP tool — clients pull lessons filtered by days, project, and confidence level for propagation to instruction files (CLAUDE.md, EXPERIENCE.md, agent SOPs)
- REFLECT tier LLM config (`HICORTEX_REFLECT_PROVIDER`, `HICORTEX_REFLECT_MODEL`, `HICORTEX_REFLECT_URL`, `HICORTEX_REFLECTION_ENABLED`)
- Named instance support in deploy — targets like `bedrock-main` create instance-specific systemd units (`hicortex-main.service`, `hicortex-main-distill.timer`, etc.)
- Auto-cleanup of processed session files older than `HICORTEX_SESSION_RETENTION_DAYS` (default 30) after distillation
- Python 3.11 compatibility (`from __future__ import annotations`)
- CLAUDE.md with project instructions, deployment rules, and structure overview

### Changed
- Switch consolidation LLM from phi4-mini to qwen3.5:4b (stronger reasoning benchmarks)
- Disable thinking mode in Ollama generate calls (`think: false`) for structured output compatibility with Qwen3.5
- Consolidation now picks up unscored memories regardless of ingestion date
- Link similarity threshold lowered from 0.75 to 0.55 (configurable via `HICORTEX_CONSOLIDATE_LINK_THRESHOLD`)
- Deploy script fixes all hardcoded paths (WorkingDirectory, ExecStart, Environment=PATH)

### Fixed
- Handle missing staging files in ingestion loop — skip files already archived by concurrent runs
- Explicitly set `ingested_at` on memory insert — SQLite DEFAULT wasn't firing reliably after ALTER TABLE migration
- sqlite-vec bumped to >=0.1.7 — v0.1.6 shipped 32-bit ARM binary on aarch64
- Address 6 critical bugs identified in code review (error handling, race conditions, edge cases)

## [0.5.0] - 2026-03-10

### Changed
- Simplified consolidation pipeline from 6 stages to 4: pre-check, importance scoring, auto-link, decay/prune
- Removed contradiction detection stage (supersession still tracked in schema, just not auto-detected)
- Removed abstraction generation stage
- Link discovery now uses vector similarity only (threshold > 0.75), no LLM calls
- Retrieval rewritten as BM25 + vector dual search with Reciprocal Rank Fusion (RRF)
- Composite scoring now blends 80% traditional score + 20% normalized RRF signal
- Renamed `DECAY_RATE` config to `BASE_DECAY` for clarity

### Added
- FTS5 full-text search index on memory content with automatic triggers (insert/update/delete)
- BM25 keyword search via FTS5, fused with vector search through RRF
- Project clustering to the D3.js graph visualization

### Fixed
- Increased consolidation LLM budget default to 200 calls (was 50)

### Removed
- DEEP tier LLM config (`HICORTEX_DEEP_PROVIDER`, `HICORTEX_DEEP_MODEL`, `HICORTEX_DEEP_URL`, `HICORTEX_DEEP_API_KEY`)
- Contradiction detection stage (was LLM-based, expensive, low accuracy)
- Abstraction generation stage (was LLM-based, produced low-value summaries)

## [0.4.0] - 2026-03-10

### Added
- Adaptive memory decay model (B+E+D): importance-scaled decay, access/link hardening, asymptotic floor
- `HICORTEX_BASE_DECAY` config option (default 0.0005, ~60-day half-life at importance 0.5)

### Changed
- Decay rate now adapts per-memory based on importance, access count, and link count
- Each retrieval hardens a memory against future decay (0.7x decay reduction per access)
- Each link to other memories hardens against decay (0.7x per link)
- Important memories have an asymptotic floor they never decay below

## [0.3.0] - 2026-03-09

### Added
- Consolidation pipeline with 6 stages: pre-check, importance scoring, link discovery, contradiction detection, abstraction generation, decay/prune
- Tiered LLM config: FAST tier (Ollama/local, routine tasks) and DEEP tier (cloud API, complex reasoning)
- Budget tracker to cap LLM calls per consolidation run
- D3.js force-directed graph visualization at `/viz` endpoint
- Re-ingest CLI for bulk loading markdown knowledge files
- Configurable distiller server URL (`HICORTEX_SERVER_URL`)
- macOS launchd plist for nightly distillation schedule
- Systemd timers for nightly distillation (02:00) and consolidation (02:30)
- Ollama timeout increased to 300s for consolidation tasks

### Changed
- Deploy scripts renamed from `maic-memory` to `hicortex`
- Cleaned up old Graphiti/Kuzu references in deploy paths

## [0.2.0] - 2026-03-09

### Changed
- Complete rewrite: replaced Graphiti/Kuzu graph database with SQLite + sqlite-vec
- Embeddings downsized from bge-large-en-v1.5 (1024-dim) to bge-small-en-v1.5 (384-dim, 33MB)
- MCP server rewritten for Starlette + streamable HTTP (was stdio)
- Storage layer is now pure async Python over SQLite (no graph DB driver)
- Memory schema: memories table + memory_links table + vec0 virtual table
- All memory operations (CRUD, vector search, link management) in storage.py

### Added
- sqlite-vec for vector similarity search
- Composite retrieval scoring: similarity (40%) + strength (30%) + connections (20%) + recency (10%)
- Graph traversal (1-2 hops) via memory_links for connected context
- Access-based strengthening: retrieved memories get access_count bumped
- Bearer token auth middleware (bypassed for localhost and read-only endpoints)
- `/health`, `/stats`, `/viz`, `/distill` HTTP endpoints
- `memory_ingest` MCP tool for direct memory storage
- `memory_distill` MCP tool to trigger distillation from within a session

### Removed
- Graphiti-core dependency
- Kuzu graph database dependency
- Neo4j driver dependency
- All Graphiti-specific code (episodes, entity extraction, temporal facts)

## [0.1.1] - 2026-02-12

### Changed
- Migrated knowledge graph engine from Cognee 0.5.2 to Graphiti-core
- Replaced fastembed with sentence-transformers for embeddings
- Replaced LanceDB vector store with Kuzu-native embeddings via Graphiti
- Search now uses Graphiti hybrid retrieval (semantic + BM25 + graph traversal)
- Native bi-temporal model for facts (valid_at / invalid_at)

### Fixed
- Kuzu FTS indexes now created during initialization
- Rate limit handling with max_retries=10 for z.ai API
- Singleton pattern prevents Kuzu file lock conflicts
- Ledger saves use file locking to prevent race conditions
- Regex backtracking risk eliminated in distiller

### Removed
- Cognee dependency and all Cognee-specific code
- LanceDB vector store dependency
- fastembed dependency

## [0.1.0] - 2026-02-11

### Changed
- Renamed project: `cognee-memory` -> `maic-memory`
- Renamed package: `src/` -> `maic_memory/`
- Migrated from manual venv + pip to `uv` (pyproject.toml managed)
- MCP server now runs via `uv run python -m maic_memory.mcp_server`
- Pinned Python to >=3.12,<3.14 (onnxruntime compatibility)
- Distillation prompt: added dates to all extracted items for temporal awareness

### Added
- Private GitHub repo (`mha33/maic-memory`)
- This changelog

### Removed
- Manual `.venv/` management (replaced by uv)
- PYTHONPATH requirement in MCP config

## [0.0.1] - 2026-02-10

### Added
- Initial implementation as `cognee-memory`
- MCP server with `memory_search`, `memory_context`, `memory_recent` tools
- Daily distiller: scans CC session transcripts, LLM-extracts knowledge
- Cognee 0.5.2 integration (Kuzu graph + LanceDB vectors)
- z.ai GLM-4.7 via Anthropic endpoint for distillation
- fastembed (BAAI/bge-large-en-v1.5) for local embeddings
- Session ledger for incremental processing
- Pre-filtering: strips code blocks, system tags, tool output from transcripts
- 4-tier privacy classification (PUBLIC/WORK/PERSONAL/SENSITIVE)
