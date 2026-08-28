# Hicortex memory extension for Pi

> **Install:** `npx @gamaze/hicortex init` auto-detects `~/.pi/agent/` and copies this file to `~/.pi/agent/extensions/hicortex.ts`. Manual: copy `pi-extension/hicortex/index.ts` there yourself. Requires a running [Hicortex](https://hicortex.gamaze.com/) server (local or remote); configure it with `npx @gamaze/hicortex init` on that machine.

Gives [Pi](https://pi.dev) agents self-learning memory backed by a Hicortex server — the same experience as the Claude Code / OpenClaw clients: **pushed recall on every prompt**, the identity layer + distilled Learnings in the system prompt at session start, and the nine memory tools. It is **dependency-free** (Node built-ins only, no npm packages, no imports from the Hicortex package) and **recall-only** — capture of Pi sessions is handled by the server machine's nightly job, which distills `~/.pi/agent/sessions/`.

**Fail-soft everywhere.** Any failure — no config, server down, timeout, non-2xx, parse error — injects nothing and never blocks or crashes a session. Every injection-path fetch has a 1-second timeout (tool fetches: 10 s). There are no terminal-UI calls, so non-interactive `pi -p` runs are safe by construction.

## How it works

| Pi hook | What it does | Hicortex call |
|---|---|---|
| `before_agent_start` | pushed **recall index** each turn — injected as a custom message alongside the user prompt; the agent lazy-loads full content with `hicortex_get` | `POST /recall-index` |
| `before_agent_start` | identity + Learnings appended to the system prompt (re-applied every turn from a per-session cache — Pi resets a system-prompt override to base whenever no extension returns one) | `GET /identity`, `GET /learnings` |
| `session_start` | reset the session's server-side recall dedup (fresh context window); drop cached blocks | `POST /recall-index` `{reset: true}` |
| `session_compact` | same reset + cache drop — the rebuilt window may have lost the injected blocks | `POST /recall-index` `{reset: true}` |
| `pi.registerTool` × 9 | the unified tools as direct REST proxies | see tool table below |

### Pushed recall index

Each user prompt is POSTed to the server's `/recall-index`; the returned **index block** (one line per relevant memory: id, title, date) is injected into the turn. All gating and dedup knobs (`recallMaxItems`, `recallMinSimilarity`, `recallReshowTurns`, …) live in the **server** config — the extension carries none. A dedup reset fired at session start is awaited by the first turn's recall POST, so it can never land after it and wipe the turn state.

### Identity layer

The hand-edited identity layer ("who you are + how to work") is injected as a `## Identity` block **only when the server's `identityClients` list includes `"pi"`** (it does under `"all"`; default is `["cc"]`). Global identity only — no per-agent scoping (`?agent=`), matching Claude Code's default.

### Tools (unified 9)

| Tool | REST call | Description |
|---|---|---|
| `hicortex_search` | `GET /search` | Semantic search over long-term memory |
| `hicortex_get` | `GET /memory` | Fetch one memory's full content by id (lazy-load counterpart of the recall index; marks the memory as used) |
| `hicortex_recent` | `GET /recent` | Recent memories by project (queryless recall) |
| `hicortex_ingest` | `POST /ingest` | Store a memory |
| `hicortex_lessons` | `GET /learnings` | Get distilled Learnings |
| `hicortex_index` | `GET /index` | Knowledge domain index |
| `hicortex_graph` | `GET /graph` | Graph queries (neighbors/hubs/path) |
| `hicortex_update` | `POST /update` | Update a memory (re-embeds on content change) |
| `hicortex_delete` | `POST /delete` | Permanently delete a memory and its links |

## Configuration

The extension self-resolves its server from `~/.hicortex/config.json` — the same file every Hicortex client uses (client mode → `serverUrl`, server mode → `localhost:8787`; `authToken` from the config, `HICORTEX_AUTH_TOKEN` env as fallback). No separate config, nothing to edit:

```bash
npx @gamaze/hicortex init                      # server / co-located machine
npx @gamaze/hicortex init --server <url>       # thin client pointing at a remote server
```

`lessonsLimit` in the same config caps the injected Learnings block (default 10).

## Notes

- Localhost requests skip auth; remote requests need the bearer token (set at init).
- Requires a Hicortex server ≥ 0.14 for the pushed recall index and `hicortex_get`; against an older server recall injects nothing (fail-soft) and the remaining tools still work where the endpoints exist.
- Capture is not this extension's job: the nightly job on the server machine reads `~/.pi/agent/sessions/` and distills centrally. Raw sessions never leave the machine.
