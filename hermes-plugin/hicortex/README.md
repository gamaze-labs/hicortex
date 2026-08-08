# Hicortex memory plugin for Hermes

> **Install:** `hermes plugins install gamaze-labs/hicortex-hermes-plugin` → `hermes memory setup hicortex` → restart your gateway.
>
> The [gamaze-labs/hicortex-hermes-plugin](https://github.com/gamaze-labs/hicortex-hermes-plugin) repo is a **generated read-only mirror** of `hermes-plugin/hicortex/` in the main Hicortex repo — do not open PRs there. Requires a running [Hicortex server](https://hicortex.gamaze.com/docs/installation.html) (local or remote) for recall; capture of Hermes sessions is handled by the server machine's nightly job.

Gives [Hermes](https://github.com/nousresearch/hermes-agent) agents self-learning memory backed by a [Hicortex](https://hicortex.gamaze.com/) server: their experience is distilled into lessons overnight, and they wake up wiser. **Recall-only:** the plugin retrieves relevant memories on every turn and injects distilled lessons into the system prompt. It has **no local LLM, no capture, no cron** — it is a thin recall shim.

**Capture happens centrally.** A nightly reader on the Hicortex server distills each agent's own session store (Hermes keeps full history in `~/.hermes/profiles/<agent>/state.db`), so nothing needs to be captured in real time. See `specs/2026-07-01-memory-capture-architecture.md` in the main repo.

## How it works

| Hermes hook | What it does | Hicortex call |
|---|---|---|
| `prefetch(query)` | pushed **recall index** each turn — a compact one-line-per-memory menu; the agent lazy-loads full content with `hicortex_get` | `POST /recall-index` (falls back to `GET /search` full-content injection on a pre-0.14 server) |
| `queue_prefetch(query)` | no-op on the recall-index path (the server dedups per turn; a client cache would double-suppress). Background `GET /search` only on the pre-0.14 fallback path | — / `GET /search` |
| `initialize(session_id)` | reset the session's server-side recall dedup (new session = fresh context) | `POST /recall-index` `{reset: true}` |
| `system_prompt_block()` | inject per-agent standing context + distilled lessons + memory index | `GET /context`, `GET /lessons` |
| `get_tool_schemas()` | exposes the 9 unified tools | see tool table below |

That's the whole surface. No `sync_turn`, no compaction/session-end capture — those are intentionally absent.

### Pushed recall index (0.7.0, server ≥ 0.14)

Instead of injecting full memory content every turn, `prefetch` sends the user's message to the server's `POST /recall-index` and injects the returned **index block** verbatim — one line per memory (id, title, date), capped and relevance-gated server-side. The agent fetches full content with `hicortex_get(id)` only when a line is actually relevant; that fetch is what strengthens the memory (exposure ≠ use). All tuning knobs (`recallMaxItems`, `recallMinSimilarity`, `recallReshowTurns`, `recallMinPromptChars`, …) live in the **server** config — the plugin carries none. Dedup is turn-based and server-side per session; the plugin resets it at `initialize` (the Hermes `MemoryProvider` interface exposes no compaction signal, so a mid-session context rebuild cannot trigger a reset — the server's turn-based re-show window covers that gap). Against a pre-0.14 server (404) the plugin falls back to the 0.6.x `GET /search` full-content prefetch, fail-soft, re-probing the endpoint every 10 minutes so a later server upgrade is picked up without a gateway restart. The recall calls carry the profile's configured `default_project` (and `mission_domains`) and use a short dedicated timeout (1.5 s) so a slow server can never stall a turn. (`privacy_filter` is deprecated since 0.7.2 — the server ignores privacy; see [Configuration](#configuration).)

### Per-agent standing context (0.13)

`system_prompt_block()` also injects the hand-edited **standing context layer** (`## Context`, above the lessons block) — "who you are + how to work", distinct from episodic memory. The server resolves it **per agent**: this profile's own sections override the global set (`override`), or it can be `global` or `off`. See the main repo's `/context` layer docs.

The plugin sends its **profile name** as `?agent=`, resolved in this order:

1. `agent_name` in the plugin config (explicit override);
2. the `HERMES_PROFILE` environment variable;
3. a `HERMES_HOME` ending in `profiles/<name>` (the per-profile install path);
4. none → the global context (backward compatible).

Leave `agent_name` blank to auto-derive (2–4). Context injection needs a Hicortex server **≥ 0.13**; against an older server the plugin detects the missing per-agent support and injects no context (lessons are unaffected). Context and lessons fail soft independently — a context failure never costs the lessons block.

### Tools (unified 9)

| Tool | REST call | Description |
|---|---|---|
| `hicortex_search` | `GET /search` | Semantic search over long-term memory |
| `hicortex_get` | `GET /memory` | Fetch one memory's full content by id (lazy-load counterpart of the recall index; marks the memory as used) |
| `hicortex_recent` | `GET /recent` | Recent memories by project (queryless recall; was `hicortex_context`/`hicortex_recall_recent` before 0.12) |
| `hicortex_ingest` | `POST /ingest` | Store a new memory |
| `hicortex_lessons` | `GET /lessons` | Get distilled lessons |
| `hicortex_index` | `GET /index` | Knowledge domain index |
| `hicortex_graph` | `GET /graph` | Graph queries (neighbors/hubs/path) |
| `hicortex_update` | `POST /update` | Update a memory (re-embeds on content change) |
| `hicortex_delete` | `POST /delete` | Permanently delete a memory and its links |

## Prerequisites

- A reachable Hicortex server (default `http://localhost:8787`). Stand one up with `npx @gamaze/hicortex init`.
- Hicortex ≥ **0.14** for the pushed recall index and `hicortex_get` (`POST /recall-index`, `GET /memory`). Against a 0.12/0.13 server the plugin falls back to the 0.6.x `/search` prefetch; servers < 0.12 are not supported — upgrade the server first.

## Install

Hermes discovers user-installed providers from `$HERMES_HOME/plugins/<name>/`:

```bash
cp -r hermes-plugin/hicortex "$HERMES_HOME/plugins/hicortex"
```

(No `pip install` — the plugin is stdlib-only.)

## Configure & activate

Use Hermes' own tooling — it discovers this plugin automatically and writes `config.yaml` correctly (**never hand-edit `config.yaml` with scripts/regex**):

```bash
hermes memory setup   # select "hicortex", enter the server URL/token when prompted
```

Run it once per profile if you use Hermes profiles. Hermes allows **one** external memory provider at a time, so disable Honcho (or any other) first, then restart the gateway.

Config fields (`hicortex_url`, `default_project`, `recall_limit`, `privacy_filter`, `agent_name`) can also be written to `$HERMES_HOME/plugins/hicortex/config.json` directly. `agent_name` pins the per-agent context id for this profile (leave blank to auto-derive — see [Per-agent standing context](#per-agent-standing-context-013)). The auth token is a **secret** — set it via env, not the JSON file:

```bash
export HICORTEX_AUTH_TOKEN=hctx-default-token   # or your custom token
```

Env overrides: `HICORTEX_URL`, `HICORTEX_AUTH_TOKEN`.

> **`privacy_filter` is DEPRECATED** (plugin 0.7.2 / server 0.16.2). The server no longer filters on privacy — the `privacy` column is vestigial (stored, never filtered). The setting is still accepted for backward compatibility but is now a harmless no-op; setting it emits a one-time-per-process warning in the gateway log. For work/personal isolation, run a **separate Hicortex server** per scope rather than relying on in-server privacy filtering.

## Topology

- **Server host:** runs Hicortex. Set `hicortex_url: http://localhost:8787` (localhost bypasses auth).
- **Other Hermes boxes:** set `hicortex_url` to the server's hostname (e.g. `http://memory-server:8787`) and `HICORTEX_AUTH_TOKEN` to the server's token. Each box recalls from the same shared brain.

## Notes

- Localhost requests skip auth; remote requests require the bearer token.
- Recall failures are non-fatal — the plugin returns empty context and the turn proceeds.
