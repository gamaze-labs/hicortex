# Hicortex

[![npm](https://img.shields.io/npm/v/@gamaze/hicortex.svg)](https://www.npmjs.com/package/@gamaze/hicortex)
[![License: PolyForm NC](https://img.shields.io/badge/License-PolyForm_NC_1.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)

**Self-improving long-term memory for AI agents.** Capture sessions, distill lessons overnight, inject them on the next run. Works with **Claude Code**, **Hermes**, **OpenClaw**, **Pi**, and any MCP-compatible agent.

Named after the **hippo**campus (fast encoding) and neo**cortex** (slow consolidation) — the two brain systems that turn fleeting experiences into lasting knowledge.

## Install

```bash
npx @gamaze/hicortex init
```

That's it. Auto-detects your environment, picks an LLM (Ollama / Claude CLI / API key), installs a local daemon (launchd on macOS, systemd on Linux), and registers MCP tools with Claude Code.

For multi-machine setups, point clients at a shared server:

```bash
npx @gamaze/hicortex init --server https://your-server.example.com
```

### Pi agents

Pi agents connect via [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter). Add to `~/.pi/agent/mcp.json`:

```json
{
  "mcpServers": {
    "hicortex": {
      "url": "http://localhost:8787/sse",
      "auth": "bearer",
      "bearerTokenEnv": "HICORTEX_TOKEN",
      "lifecycle": "keep-alive"
    }
  }
}
```

The nightly pipeline auto-detects Pi sessions at `~/.pi/agent/sessions/` alongside CC sessions. Lessons are fetched at session start via the Hermes plugin or the CC SessionStart hook — no file-based injection or `lessonTarget` config needed.

Full docs: [hicortex.gamaze.com/docs](https://hicortex.gamaze.com/docs/)

## What it does

```
CAPTURE (nightly)            CONSOLIDATE (nightly)        RETRIEVE (instant)
┌──────────────────┐        ┌──────────────────────┐      ┌─────────────────────┐
│ Session transcripts        │ 1. Score importance  │      │ BM25 + vector search│
│ → Denoise (no LLM)         │    (local LLM)       │      │ → RRF fusion        │
│ → POST /distill            │ 2. Reflect & learn   │      │ → Graph traversal   │
│ → Server distills          │    (cloud LLM)       │      │ → Composite scoring │
│ → Embed + store            │ 3. Auto-link by      │      │ → Strengthen on     │
└──────────────────┘        │    vector similarity │      │    access           │
                             │ 4. Decay + prune     │      └─────────────────────┘
                             └──────────────────────┘
                                       ↓
                             Lessons (memory_type="lesson")
                                       ↓
                             Fetched at session start via CC hook / Hermes plugin
```

Memories decay slower the more important and frequently used they are, strengthen on retrieval, and are linked automatically to related memories. Retrieval is zero-LLM: BM25 full-text + vector search fused with Reciprocal Rank Fusion, scored by similarity (40%) + strength (30%) + connections (20%) + recency (10%).

Alongside those auto-distilled memories and lessons, Hicortex holds a hand-edited **context layer** (0.12) — standing "who you are + how to work" Markdown at `~/.hicortex/context/*.md`, injected into every session at start and **never decayed**. Edit it in the web editor at `/context/ui` or with `hicortex context show|edit`; choose which harnesses receive it with `contextClients` (default `["cc"]`). Each agent can also have its **own** context (0.13) — resolved server-side as `override`/`global`/`off` per agent id, so one server serves a fleet of distinct personas. See the [package README](packages/hicortex/README.md#context-layer).

## MCP tools

Eight MCP tools your agent can call:

| Tool | Purpose |
|------|---------|
| `hicortex_search`  | Semantic search across all stored memories |
| `hicortex_recent`  | Recent decisions + project state for the current session |
| `hicortex_ingest`  | Store a memory directly |
| `hicortex_lessons` | Actionable lessons from nightly reflection |
| `hicortex_index`   | Knowledge domain index — what topics are stored |
| `hicortex_graph`   | Graph traversal: neighbors, hubs, shortest paths |
| `hicortex_update`  | Fix incorrect memories (re-embeds on content change) |
| `hicortex_delete`  | Remove memories with cascade cleanup |

Plus skills: `/learn` to save explicit learnings.

## Stack

- **TypeScript**, Node.js 20+
- **better-sqlite3** + **sqlite-vec** + FTS5 (semantic + full-text search in one DB)
- **@huggingface/transformers** (bge-small-en-v1.5 ONNX, runs on CPU)
- **MCP protocol** over HTTP/SSE (Claude Code, Hermes, OpenClaw, Pi, any MCP client)
- **Multi-provider LLM** — Ollama, Claude CLI, OpenAI, Anthropic, Google, OpenRouter, or any OpenAI-compatible endpoint
- **Auto-detects** Ollama models, Claude CLI, API keys during setup

## Architecture: Server + Client

```
  Client A                   Server                    Client B
  ┌──────────┐              ┌──────────────┐          ┌──────────┐
  │CC sessions│              │   Shared DB   │          │CC sessions│
  │    ↓      │  POST        │              │  POST    │    ↓      │
  │ Denoise   │──/distill──→│ Distill+Store │←/distill─│ Denoise   │
  │ (no LLM)  │              │      ↓       │          │ (no LLM)  │
  │           │  MCP         │ Consolidate  │   MCP    │           │
  │    CC    ←│──(search)───│ (score,link, │──(search)→│   CC     │
  │           │              │  reflect)    │          │           │
  └──────────┘              └──────────────┘          └──────────┘
```

**Server mode** — owns the DB. MCP server on port 8787. Nightly pipeline reads local harness sessions, POSTs to `/distill` (localhost), distills, consolidates.
**Client mode** — no local DB, no local LLM required. Nightly denoises sessions locally (no LLM — just strips tool noise), POSTs denoised text to the server's `/distill`. Server does the distillation.

## License

**Personal and noncommercial use is free** under the [PolyForm Noncommercial License 1.0.0](LICENSE). Commercial use (for-profit businesses, client work, revenue-generating products) requires a per-seat license — see [hicortex.gamaze.com](https://hicortex.gamaze.com).

Versions ≤ 0.7.1 published to npm remain MIT-licensed. See [COMMERCIAL.md](COMMERCIAL.md) for details.

## Project layout

```
packages/hicortex/    The npm package (@gamaze/hicortex)
  src/                       TypeScript source
    cli.ts                   CLI entry: server, init, nightly, status, uninstall
    init.ts                  Interactive setup wizard
    mcp-server.ts            HTTP/SSE MCP server (persistent daemon)
    nightly.ts               Nightly pipeline: distill + consolidate + inject
    consolidate.ts           Importance scoring, reflection, linking, decay
    distiller.ts             Transcript → LLM → memories
    storage.ts, db.ts        SQLite + sqlite-vec + FTS5
    retrieval.ts             BM25 + vector search with RRF fusion
    embedder.ts              Local ONNX embeddings
    llm.ts                   Multi-provider LLM client
    features.ts              Feature stubs (all gates removed; license key display only)
    claude-md.ts             CLAUDE.md lesson injection
    prompts.ts               LLM prompt templates
    license.ts               License validation
    transcript-reader.ts     Claude Code .jsonl reader
    index.ts                 OpenClaw plugin entry
  skills/                    Bundled OpenClaw skills (/learn, etc.)
  openclaw.plugin.json       OpenClaw plugin manifest
```

## Development

```bash
git clone https://github.com/gamaze-labs/hicortex.git
cd hicortex/packages/hicortex
npm install
npm run build
npm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution guide.

See [LICENSE](LICENSE) and [COMMERCIAL.md](COMMERCIAL.md).

## Links

- **Website:** [hicortex.gamaze.com](https://hicortex.gamaze.com)
- **Docs:** [hicortex.gamaze.com/docs](https://hicortex.gamaze.com/docs/)
- **npm:** [@gamaze/hicortex](https://www.npmjs.com/package/@gamaze/hicortex)
- **Issues:** [github.com/gamaze-labs/hicortex/issues](https://github.com/gamaze-labs/hicortex/issues)
- **Security:** [SECURITY.md](SECURITY.md)
