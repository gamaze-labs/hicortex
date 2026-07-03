# @gamaze/hicortex — Self-Learning Memory for AI Agents

Your agents learn from every session — successes and mistakes. Hicortex captures experiences, distills lessons, and applies them automatically. Connect multiple agents to shared memory and they improve together, overnight.

Works with **Claude Code**, **Hermes**, **OpenClaw**, **Pi**, and any MCP-compatible agent.

**Website:** [hicortex.gamaze.com](https://hicortex.gamaze.com) · **Docs:** [hicortex.gamaze.com/docs](https://hicortex.gamaze.com/docs/)

## Install — Server Mode (single machine)

```bash
npx @gamaze/hicortex init
```

Detects available LLM candidates (Ollama models, Claude CLI, API keys from env/Hermes/.env/Claude Code settings/OpenClaw), presents a numbered list, and asks you to choose. Installs a persistent MCP server daemon and registers with Claude Code. One command.

## Install — Client Mode (multi-client)

```bash
npx @gamaze/hicortex init --server https://your-server.example.com
```

Connects to a remote Hicortex server. No local database or local LLM needed. The nightly job denoises sessions locally (no LLM — just strips tool noise), then POSTs the denoised text to the server. The server distills, embeds, and stores. Raw session content never leaves the machine.

## Install — OpenClaw

The OC plugin is a recall-only adapter (lessons + memory tools): it requires a Hicortex server. Run the server once on the same machine (or point the plugin at a remote server via `serverUrl` config). Capture happens automatically — the machine's Hicortex nightly reads OpenClaw's session files (`~/.openclaw/agents/*/sessions/`) alongside Claude Code and Hermes sessions.

```bash
# 1. Start the Hicortex server (once, on the machine running OC)
npx @gamaze/hicortex init

# 2. Install the plugin
openclaw plugins install @gamaze/hicortex
openclaw gateway restart
```

The plugin connects to `http://127.0.0.1:8787` by default. For a remote server, add `serverUrl` and `authToken` (find the token via `hicortex status` on the server) to the plugin config in `~/.openclaw/openclaw.json`.

## Requirements

- Node.js 18+
- **Server mode:** LLM required — Ollama 9b+ (recommended), Claude CLI, or API key (Anthropic, OpenAI, etc.). ~500MB disk for database + embedding model.
- **Client mode:** No local LLM needed. Node.js 18+ and network access to the server are sufficient.
- **OC plugin:** Requires a running Hicortex server. No local LLM, database, or embedder in the plugin itself.

## What Happens Automatically

| When | What | How |
|------|------|-----|
| Agent start | Recent lessons fetched fresh and injected into context | CC SessionStart hook (calls `hicortex lessons-context`) / Hermes plugin prefetch / OC `before_agent_start` hook |
| Nightly | Denoise sessions → POST /distill → server distills + embeds + stores → consolidate (score, reflect, link, decay) | Automatic pipeline — no manual steps |

## Agent Tools (MCP)

8 tools available via MCP:

- **hicortex_search** — Semantic search across all stored memories
- **hicortex_context** — Get recent decisions and project state
- **hicortex_ingest** — Store a memory directly
- **hicortex_lessons** — Get actionable lessons from reflection
- **hicortex_index** — Get the knowledge domain index (what topics are stored)
- **hicortex_graph** — Graph traversal: neighbors, hubs, shortest paths
- **hicortex_update** — Fix incorrect memories (re-embeds on content change)
- **hicortex_delete** — Remove memories with cascade cleanup

Skills: `/learn` to save explicit learnings.

## CLI Commands

```bash
npx @gamaze/hicortex server                    # Start MCP server (port 8787)
npx @gamaze/hicortex init                      # Set up server mode
npx @gamaze/hicortex init --server <url>       # Set up client mode
npx @gamaze/hicortex nightly                   # Run distill + consolidate (full nightly)
npx @gamaze/hicortex nightly --capture-only    # Capture only, skip consolidation (safe for sub-daily runs)
npx @gamaze/hicortex nightly --dry-run         # Preview without changes
npx @gamaze/hicortex status                    # Show config, DB stats
npx @gamaze/hicortex uninstall                 # Remove CC integration (keeps DB)
```

## Architecture

```
  Client A                  Server                    Client B
  ┌──────────┐              ┌──────────────┐          ┌──────────┐
  │CC sessions│              │   Shared DB   │          │CC sessions│
  │    ↓      │  POST        │              │  POST    │    ↓      │
  │ Denoise   │──/distill──→│Distill+Store  │←/distill─│ Denoise   │
  │ (no LLM)  │              │      ↓       │          │ (no LLM)  │
  │           │  MCP         │ Consolidate  │   MCP    │           │
  │    CC    ←│──(search)───│ (score,link,  │──(search)→│   CC     │
  │           │              │  reflect)    │          │           │
  └──────────┘              └──────────────┘          └──────────┘

Shared core:
  ├── SQLite + sqlite-vec + FTS5
  ├── bge-small-en-v1.5 embeddings (ONNX, local CPU)
  ├── BM25 + vector search with RRF fusion + graph traversal
  └── Multi-provider LLM (Ollama, Claude CLI, 20+ cloud providers)
```

## Configuration

Config at `~/.hicortex/config.json`. Created by `init`. Key options:

| Field | Description |
|-------|-------------|
| `mode` | `"server"` (default) or `"client"` |
| `serverUrl` | Remote server URL (client mode) |
| `llmModel` | Model for importance scoring (server mode) |
| `distillModel` | Model for session distillation — 9b+ recommended (server mode) |
| `distillBaseUrl` | Separate Ollama instance for distillation (server mode) |
| `distillFallback` | `"strict"` (default) — abort on remote distill failure, retry next run; `"local"` — fall back to base model (lower quality, 0.9.0 behaviour) |
| `reflectModel` | Model for nightly reflection — largest available (server mode) |
| `reflectBaseUrl` | Separate Ollama instance for reflection (server mode) |
| `authToken` | Bearer token for endpoint auth. Generated on first `init` in server mode. Find the active token with `hicortex status` or in `~/.hicortex/config.json`. |
| `licenseKey` | Commercial license key (optional; for display in `hicortex status`) |
| `moduleIndexTokenBudget` | Max tokens for domain index in lessons context (default: 500) |
| `nightlyHour` | Local hour (0–23) for the nightly job installed by `init` (defaults: client 2, server 3). Applied on fresh installs; existing schedules are never overwritten |
| `telemetry` | Anonymous usage telemetry, `false` to opt out |

Full docs: [hicortex.gamaze.com/docs/configuration.html](https://hicortex.gamaze.com/docs/configuration.html)

## REST API

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/health` | GET | No | Server status, memory count, version |
| `/distill` | POST | Yes | Canonical capture endpoint (0.9.0+). Accepts denoised session text (`text` string or `messages` array), distills server-side, stores. Used by both server-mode and client-mode nightly jobs. |
| `/search` | GET | Yes | Semantic memory search |
| `/context` | GET | Yes | Recent context memories |
| `/lessons` | GET | Yes | Lessons + memory index (used by CC SessionStart hook) |
| `/ingest` | POST | Yes | Legacy: accept a single pre-distilled memory from older clients |
| `/sse` | GET | Yes | MCP SSE stream for agent connections |
| `/messages` | POST | Yes | MCP message endpoint |

## License

**Personal and noncommercial use is free** under the [PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0). Commercial use (for-profit businesses, client work, revenue-generating products) requires a per-seat license — see [hicortex.gamaze.com](https://hicortex.gamaze.com).

Versions ≤ 0.7.1 published to npm remain MIT-licensed.

## Uninstall

```bash
npx @gamaze/hicortex uninstall    # Claude Code
openclaw plugins uninstall hicortex  # OpenClaw
```

Database preserved by default. Remove all data: `rm -rf ~/.hicortex`

## Configure — OpenClaw

Optional config (add to plugin entry in `~/.openclaw/openclaw.json`):

| Field | Default | Description |
|-------|---------|-------------|
| `serverUrl` | `http://127.0.0.1:8787` | Hicortex server URL. Change for remote servers. |
| `authToken` | _(none)_ | Bearer token. Localhost bypasses auth; required for remote servers. Get the token from `hicortex status` on the server. |
| `licenseKey` | _(none)_ | Commercial license key. Optional; only affects the display in `hicortex status`. |

## LLM Configuration

LLM selection is **user-controlled**: `npx @gamaze/hicortex init` detects candidates and asks you to choose. Nothing is silently auto-applied at runtime.

| Method | Config key | Notes |
|--------|-----------|-------|
| Ollama (local) | `llmBackend: "ollama"` | Set by init; no API key needed |
| Claude CLI | `llmBackend: "claude-cli"` | Uses CC subscription; no API key needed |
| Custom provider | `llmBaseUrl` + `llmApiKey` | Any OpenAI-compatible endpoint |
| Hicortex env vars | `HICORTEX_LLM_BASE_URL` + `HICORTEX_LLM_API_KEY` | Override at runtime |

If no LLM is configured, the server starts in **recall-only mode**: search, lessons, and context work; `/distill` and consolidation are disabled. Run `npx @gamaze/hicortex init` to configure.

## Database

Canonical location: `~/.hicortex/hicortex.db`. The OC plugin no longer owns its own database — it is a thin client to the server. Previously, OC installations at `~/.openclaw/data/hicortex.db` were migrated automatically on upgrade; this migration path remains in the server's `resolveDbPath` for any pre-0.10.0 installations.

## Development

```bash
cd packages/hicortex
npm install
npm run build
npm test
```

## Troubleshooting

**Tools not visible to agent (OC):** The plugin auto-adds tools to `tools.allow` on startup. Restart the gateway after install.

**OC plugin: "Server unreachable":** The plugin requires a running Hicortex server. Run `npx @gamaze/hicortex init` on the same machine, or set `serverUrl` in the plugin config to point at a remote server.

**LLM auto-config failed:** Check logs for `[hicortex] WARNING`. Add `llmBaseUrl` to plugin config or set `HICORTEX_LLM_BASE_URL` env var (applies to server setup, not the OC plugin itself).

**No lessons generated:** Reflection requires an LLM. Check that your provider is accessible and has sufficient quota.

**First startup slow:** The embedding model (~130MB) downloads on first run. Allow up to 2 minutes.

**Server won't start (CC):** Check `~/.hicortex/nightly.log` for errors. Verify port 8787 is free: `lsof -i :8787`.

**Multiple CC sessions:** The HTTP server handles multiple concurrent sessions. Do not use stdio transport — it spawns separate processes per session.

**Ollama timeout on large sessions:** Hicortex uses streaming mode with 3 retries (30s, 60s, 120s backoff). If first call fails (model loading), retry handles it automatically.
