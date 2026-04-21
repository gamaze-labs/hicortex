# @gamaze/hicortex — Self-Learning Memory for AI Agents

Your agents learn from every session — successes and mistakes. Hicortex captures experiences, distills lessons, and applies them automatically. Connect multiple agents to shared memory and they improve together, overnight.

Works with **Claude Code**, **Pi**, **OpenClaw**, and any MCP-compatible agent.

**Website:** [hicortex.gamaze.com](https://hicortex.gamaze.com) · **Docs:** [hicortex.gamaze.com/docs](https://hicortex.gamaze.com/docs/)

## Install — Server Mode (single machine)

```bash
npx @gamaze/hicortex init
```

Detects your environment, installs a persistent MCP server daemon, auto-detects Ollama/Claude CLI/API keys, and registers with Claude Code. One command.

## Install — Client Mode (multi-client)

```bash
npx @gamaze/hicortex init --server https://your-server.example.com
```

Connects to a remote Hicortex server. Sessions are distilled locally (privacy), memories are sent to the shared server. No local database needed.

## Install — OpenClaw

```bash
openclaw plugins install @gamaze/hicortex
openclaw gateway restart
```

## Requirements

- Node.js 18+
- LLM: Ollama 9b+ (recommended), Claude CLI, or API key (Anthropic, OpenAI, etc.)
- ~500MB disk for database + embedding model

## What Happens Automatically

| When | What | How |
|------|------|-----|
| Agent start | Recent lessons injected into context | CLAUDE.md / EXPERIENCE.md / OC hook |
| Agent end | Conversation captured | CC + Pi: nightly transcript scan / OC: hook |
| Nightly | Distill → score → reflect → link → inject | Automatic pipeline |

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
npx @gamaze/hicortex nightly                   # Run distill + consolidate
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
  │ Distill   │──/ingest───→│  Embed+Store  │←/ingest──│ Distill   │
  │ (local)   │              │      ↓       │          │ (local)   │
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
| `llmModel` | Model for importance scoring |
| `distillModel` | Model for session distillation (9b+ recommended) |
| `distillBaseUrl` | Separate Ollama instance for distillation |
| `reflectModel` | Model for nightly reflection (largest available) |
| `reflectBaseUrl` | Separate Ollama instance for reflection |
| `authToken` | Bearer token for endpoint auth |
| `licenseKey` | License key for higher tiers |
| `lessonTarget` | Injection target file (default: `~/.claude/CLAUDE.md`) |
| `moduleIndexTokenBudget` | Max tokens for domain index in injection (default: 500) |
| `telemetry` | Anonymous usage telemetry, `false` to opt out |

Full docs: [hicortex.gamaze.com/docs/configuration.html](https://hicortex.gamaze.com/docs/configuration.html)

## REST API

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/health` | GET | No | Server status, memory count, version |
| `/ingest` | POST | Yes | Accept pre-distilled memories from clients |
| `/sse` | GET | Yes | MCP SSE stream for agent connections |
| `/messages` | POST | Yes | MCP message endpoint |

## Pricing

| Tier | Price | Memories | Clients |
|------|-------|----------|---------|
| Free | $0 | 250 | Unlimited (trial) |
| Pro | $9/month | Unlimited | Single |
| Team | $29/month | Unlimited | Unlimited |
| Lifetime | $149 | Unlimited | Single |

[hicortex.gamaze.com](https://hicortex.gamaze.com)

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
| `licenseKey` | _(none)_ | License key. Free tier (250 memories) without key. |
| `llmBaseUrl` | _(auto)_ | Override LLM base URL |
| `llmApiKey` | _(auto)_ | Override LLM API key |
| `llmModel` | _(auto)_ | Override model for scoring and distillation |
| `reflectModel` | _(auto)_ | Override model for nightly reflection |
| `consolidateHour` | `2` | Hour (0-23, local time) for nightly consolidation |
| `dbPath` | _(auto)_ | Custom database path |

For CC, set environment variables: `ANTHROPIC_API_KEY` (auto-detected), or `HICORTEX_LLM_BASE_URL` + `HICORTEX_LLM_API_KEY` + `HICORTEX_LLM_MODEL` for custom providers.

## Database

Canonical location: `~/.hicortex/hicortex.db`. Existing OC installations at `~/.openclaw/data/hicortex.db` are automatically migrated on upgrade.

## Development

```bash
cd packages/hicortex
npm install
npm run build
npm test
```

## Troubleshooting

**Tools not visible to agent (OC):** The plugin auto-adds tools to `tools.allow` on startup. Restart the gateway after install.

**LLM auto-config failed:** Check logs for `[hicortex] WARNING`. Add `llmBaseUrl` to plugin config or set `HICORTEX_LLM_BASE_URL` env var.

**No lessons generated:** Reflection requires an LLM. Check that your provider is accessible and has sufficient quota.

**First startup slow:** The embedding model (~130MB) downloads on first run. Allow up to 2 minutes.

**Server won't start (CC):** Check `~/.hicortex/nightly.log` for errors. Verify port 8787 is free: `lsof -i :8787`.

**Multiple CC sessions:** The HTTP server handles multiple concurrent sessions. Do not use stdio transport — it spawns separate processes per session.

**Ollama timeout on large sessions:** Hicortex uses streaming mode with 3 retries (30s, 60s, 120s backoff). If first call fails (model loading), retry handles it automatically.
