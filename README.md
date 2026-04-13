# Hicortex

[![npm](https://img.shields.io/npm/v/@gamaze/hicortex.svg)](https://www.npmjs.com/package/@gamaze/hicortex)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org)

**Self-improving long-term memory for AI agents.** Capture sessions, distill lessons overnight, inject them on the next run. Works with **Claude Code**, **Pi**, **OpenClaw**, and any MCP-compatible agent.

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

The nightly pipeline auto-detects Pi sessions at `~/.pi/agent/sessions/` alongside CC sessions. Set `lessonTarget` in `~/.hicortex/config.json` to inject lessons into your agent's learning file (e.g., `.pi/EXPERIENCE.md`) instead of the default `~/.claude/CLAUDE.md`.

Full docs: [hicortex.gamaze.com/docs](https://hicortex.gamaze.com/docs/)

## What it does

```
INGEST (nightly)             CONSOLIDATE (nightly)        RETRIEVE (instant)
┌──────────────────┐        ┌──────────────────────┐      ┌─────────────────────┐
│ Session transcripts        │ 1. Score importance  │      │ BM25 + vector search│
│ → LLM distillation         │    (local LLM)       │      │ → RRF fusion        │
│ → Local embedding          │ 2. Reflect & learn   │      │ → Graph traversal   │
│ → Store                    │    (cloud LLM)       │      │ → Composite scoring │
└──────────────────┘        │ 3. Auto-link by      │      │ → Strengthen on     │
                             │    vector similarity │      │    access           │
                             │ 4. Decay + prune     │      └─────────────────────┘
                             └──────────────────────┘
                                       ↓
                             Lessons (memory_type="lesson")
                                       ↓
                             Injected into CLAUDE.md / agent context
```

Memories decay slower the more important and frequently used they are, strengthen on retrieval, and are linked automatically to related memories. Retrieval is zero-LLM: BM25 full-text + vector search fused with Reciprocal Rank Fusion, scored by similarity (40%) + strength (30%) + connections (20%) + recency (10%).

## MCP tools

Seven MCP tools your agent can call:

| Tool | Purpose |
|------|---------|
| `hicortex_search`  | Semantic search across all stored memories |
| `hicortex_context` | Recent decisions + project state for the current session |
| `hicortex_ingest`  | Store a memory directly |
| `hicortex_lessons` | Actionable lessons from nightly reflection |
| `hicortex_index`   | Knowledge domain index — what topics are stored |
| `hicortex_update`  | Fix incorrect memories (re-embeds on content change) |
| `hicortex_delete`  | Remove memories with cascade cleanup |

Plus skills: `/learn` to save explicit learnings.

## Stack

- **TypeScript**, Node.js 18+
- **better-sqlite3** + **sqlite-vec** + FTS5 (semantic + full-text search in one DB)
- **@huggingface/transformers** (bge-small-en-v1.5 ONNX, runs on CPU)
- **MCP protocol** over HTTP/SSE (Claude Code, Pi, OpenClaw, any MCP client)
- **Multi-provider LLM** — Ollama, Claude CLI, OpenAI, Anthropic, Google, OpenRouter, or any OpenAI-compatible endpoint
- **Auto-detects** Ollama models, Claude CLI, API keys during setup

## Architecture: Server + Client

```
  Client A                   Server                    Client B
  ┌──────────┐              ┌──────────────┐          ┌──────────┐
  │CC sessions│              │   Shared DB   │          │CC sessions│
  │    ↓      │  POST        │              │  POST    │    ↓      │
  │ Distill   │──/ingest───→│  Embed+Store  │←/ingest──│ Distill   │
  │ (local)   │              │      ↓       │          │ (local)   │
  │           │  MCP         │ Consolidate  │   MCP    │           │
  │    CC    ←│──(search)───│ (score,link, │──(search)→│   CC     │
  │           │              │  reflect)    │          │           │
  └──────────┘              └──────────────┘          └──────────┘
```

**Server mode** — local DB + MCP server + nightly consolidation.
**Client mode** — distill locally for privacy, POST memories to a shared server.

## Open source + commercial Pro

Hicortex is **MIT-licensed** and free forever. The npm package is the complete client: capture, distillation, retrieval, MCP tools, multi-client architecture.

Commercial **Pro** features (lesson selection engine, validation, cross-agent learning, prescriptive distillation, smart context assembly) are sold separately by [Gamaze](https://hicortex.gamaze.com). Pro is server-side intelligence — no separate npm package, no client-side license keys to bypass. You point your client at a Pro server and the same code calls Pro endpoints if available.

This is the open-core model:
- **OSS** (this repo): the memory client. Anyone can self-host, fork, modify, ship in their own product.
- **Pro** (commercial): the intelligence layer. Funds OSS development, runs as a SaaS or licensed self-host.

See [hicortex.gamaze.com](https://hicortex.gamaze.com) for pricing and Pro features.

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
    features.ts              Centralized feature gating
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

## License

MIT — see [LICENSE](LICENSE).

## Links

- **Website:** [hicortex.gamaze.com](https://hicortex.gamaze.com)
- **Docs:** [hicortex.gamaze.com/docs](https://hicortex.gamaze.com/docs/)
- **npm:** [@gamaze/hicortex](https://www.npmjs.com/package/@gamaze/hicortex)
- **Issues:** [github.com/gamaze-labs/hicortex/issues](https://github.com/gamaze-labs/hicortex/issues)
- **Security:** [SECURITY.md](SECURITY.md)
