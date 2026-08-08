# @gamaze/hicortex — Self-Learning Memory for AI Agents

Your agents learn from every session — successes and mistakes. Hicortex captures experiences, distills lessons, and applies them automatically. Connect multiple agents to shared memory and they improve together, overnight.

Works with **Hermes**, **OpenClaw**, **Claude Code**, **Pi**, and any MCP-compatible agent.

**Website:** [hicortex.gamaze.com](https://hicortex.gamaze.com) · **Docs:** [hicortex.gamaze.com/docs](https://hicortex.gamaze.com/docs/)

## Install — Server Mode (single machine)

```bash
npx @gamaze/hicortex init
```

Detects available LLM candidates (Ollama models, Claude CLI, API keys from env/Hermes/.env/Claude Code settings/OpenClaw), presents a numbered list, and asks you to choose. Installs a persistent MCP server daemon and registers with Claude Code. One command.

Init also scaffolds five editable default [memory domains](#memory-domains--tags) (Work, Personal, People, Health, Finance) in `~/.hicortex/config.json`. Domain classification activates automatically once an LLM is configured — no extra setup.

## Install — Client Mode (multi-client)

```bash
npx @gamaze/hicortex init --server https://your-server.example.com
```

Connects to a remote Hicortex server. No local database or local LLM needed. The nightly job denoises sessions locally (no LLM — just strips tool noise), then POSTs the denoised text to the server. The server distills, embeds, and stores. Raw session content never leaves the machine.

## Install — Hermes

The Hermes plugin is a recall-only adapter: it pushes a compact recall index every turn (lazy-loaded with `hicortex_get`), injects fresh lessons, and exposes the full 9-tool memory surface, backed by a Hicortex server (local or remote). Capture happens automatically — the server machine's nightly job reads each Hermes profile's `state.db`.

```bash
# 1. Install the plugin (prompts for server URL + auth token; leave empty for a local server)
hermes plugins install gamaze-labs/hicortex-hermes-plugin

# 2. Activate it as the memory provider, then restart your gateway
hermes memory setup hicortex
hermes gateway restart
```

Find the server's auth token with `hicortex status` on the server machine.

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

- Node.js 20+
- **Server mode:** LLM required — Ollama 9b+ (recommended), Claude CLI, or API key (Anthropic, OpenAI, etc.). ~500MB disk for database + embedding model.
- **Client mode:** No local LLM needed. Node.js 20+ and network access to the server are sufficient.
- **OC plugin:** Requires a running Hicortex server. No local LLM, database, or embedder in the plugin itself.

## What Happens Automatically

| When | What | How |
|------|------|-----|
| Agent start | Standing context (`## Context`) + recent lessons fetched fresh and injected | CC SessionStart hook (calls `hicortex lessons-context`) / Hermes plugin `system_prompt_block` / OC `before_agent_start` hook |
| Every prompt (0.14) | A compact **recall index** of relevant memories is injected — one line per memory; the agent lazy-loads full content with `hicortex_get` only when needed | All three harnesses call server `POST /recall-index` per turn: CC UserPromptSubmit hook (`hicortex recall-hook`), Hermes plugin `prefetch` (0.7.0; falls back to `/search` injection against a pre-0.14 server), OC `before_agent_start` hook (fires per inbound message). Turn-based dedup per session; resets on new session/compaction. Fail-soft |
| Nightly | Denoise sessions → POST /distill → server distills + embeds + stores → consolidate (score, reflect, link, decay) | Automatic pipeline — no manual steps |

**Exposure vs use (0.14):** appearing in the recall index only marks a memory as *shown* (it stops decaying while topically active); fetching it with `hicortex_get` marks it as *used* (durable strengthening). Memory importance is driven by what agents actually use, not by what was pushed at them.

## Memory Domains & Tags

Domains are your top-level memory spheres — the handful of areas your life or work actually splits into. Every memory gets **multiple weighted tags** from your domain list plus one **primary** domain, so a memory that spans areas (a work project that touches your finances) lives in both instead of being forced into one bin. Domains drive the knowledge index, graph coloring, and lesson selection.

`hicortex init` scaffolds five generic defaults: **Work, Personal, People, Health, Finance**. They are a starting point, not a taxonomy — edit them to match how *you* think. Life areas or project/topic areas both work. Your existing list is never overwritten by init.

Edit `~/.hicortex/config.json` on the server machine:

```json
{
  "domains": [
    { "name": "Work", "description": "Your job and professional life — employer, clients, workstreams" },
    { "name": "Personal", "description": "Private life — home, hobbies, everyday matters" },
    { "name": "People", "description": "Relationships — family, friends, social life, network" },
    { "name": "Health", "description": "Fitness, wellbeing, medical" },
    { "name": "Finance", "description": "Money — budgeting, spending, investing" }
  ]
}
```

A richer example — including a `compartment: true` work/life firewall and a custom `weakPrimaryFloor` — ships as `domains.example.json` in the package.

**How classification works:** the LLM decides only *which* of your domains apply to a memory — never weights or rankings. The weight of each tag is derived from your own data: each domain builds a prototype from the memories already in it, and a tag's weight is how strongly the memory's embedding matches that prototype. The primary domain is picked deterministically from those weights, and everything is recomputed each nightly, so your categories drift with your data instead of going stale. Memories that genuinely fit nothing get a weak association when they are close enough to some domain — and otherwise fade away over time. No junk drawer, no "Unsorted" pile.

`weakPrimaryFloor` (config, default 0.45) sets how close a no-fit memory must be to its nearest domain to earn that weak association instead of fading.

**Backfill an existing corpus** (server mode, needs `domains` in config):

```bash
npx @gamaze/hicortex classify-domains              # classify unfiled/stale memories
npx @gamaze/hicortex classify-domains --all        # reclassify every memory
npx @gamaze/hicortex classify-domains --batch 100  # memories per batch (default: 200)
npx @gamaze/hicortex classify-domains --reset      # restart from the beginning (ignore saved cursor)
```

The run is resumable — interrupt it any time and it continues where it stopped. New memories are classified automatically by the nightly; the backfill is only needed once for a pre-existing corpus or after you reshape your domain list.

## Agent Tools (MCP)

9 tools available via MCP:

- **hicortex_search** — Semantic search across all stored memories
- **hicortex_get** — Fetch one memory's full content by id (0.14) — the lazy-load counterpart of the recall index; fetching marks the memory as used
- **hicortex_recent** — Get recent decisions and project state (queryless recall; renamed in 0.12)
- **hicortex_ingest** — Store a memory directly
- **hicortex_lessons** — Get actionable lessons from reflection
- **hicortex_index** — Get the knowledge domain index (what topics are stored)
- **hicortex_graph** — Graph traversal: neighbors, hubs, shortest paths
- **hicortex_update** — Fix incorrect memories (re-embeds on content change)
- **hicortex_delete** — Remove memories with cascade cleanup

Explicit learnings: call `hicortex_ingest` directly (capture is otherwise automatic, nightly).

## Context Layer

Beyond auto-distilled memories and lessons, Hicortex holds a **hand-edited context layer** — standing "who you are + how to work" Markdown injected into every session at start. Unlike memories, it is **never distilled, scored, or decayed**: what you write stays verbatim until you change it.

- **Storage:** plain files on the server at `~/.hicortex/context/*.md` — one file per section (recommended starter sections `user.md` + `rules.md`, which you create — nothing is pre-populated; add more by dropping in a file). It lives outside the memories table; consolidation never touches it.
- **Edit:** the web editor at `http://localhost:8787/context/ui` (one tab per section, Save), or the CLI `hicortex context show [name]` / `hicortex context edit <name>`.
- **Delivery:** injected into the harnesses listed in `contextClients` (default `["cc"]`; `"all"` or any subset of `cc`/`hermes`/`oc` — all three are supported since 0.13).
- **Deletion** is filesystem-only — remove the file on the server (as the daemon user).

### Per-agent context (0.13)

One server serves a fleet of distinct-persona agents. Each agent can have its **own** context, resolved server-side into one of three modes:

- **`override`** (default when an `agents/<id>/` dir exists) — the agent's sections win **per section name**, falling back to the global set for any section it doesn't define.
- **`global`** — the shared global set (the 0.12 behavior).
- **`off`** — inject nothing for that agent.

- **Agent id:** Hermes and OC scope per profile/agent automatically. **CC is global by default** — it sends no `?agent=`, so all your CC machines share one global context (one user = one identity across machines). `agentName` is an explicit opt-in: set it with `init --agent-name <name>` and CC will send `?agent=<config.agentName>`; clear it with `init --agent-name ""` to return to global. The id is on the same strict allowlist as section names (it becomes a path). Shown by `hicortex status` (or `(not set — global context)` when unset).
- **Storage:** per-agent sections live at `~/.hicortex/context/agents/<id>/*.md`; the global reader never descends into `agents/`.
- **Config:** `contextAgents` maps agent id → mode; a dropped-in `agents/<id>/` dir alone means `override` with no config. Editing `contextAgents` needs a daemon restart; dropping in a dir takes effect immediately.
- **Edit:** the web editor's scope selector (`Global` | `<agent>`; inherited sections shown dimmed), or `hicortex context show|edit --agent <id>`.
- **Backward compatible:** no `?agent=` and no `contextAgents`/`agents/` dir → every agent gets the global set.

## CLI Commands

```bash
npx @gamaze/hicortex server                    # Start MCP server (port 8787)
npx @gamaze/hicortex init                      # Set up server mode
npx @gamaze/hicortex init --server <url>       # Set up client mode
npx @gamaze/hicortex nightly                   # Run distill + consolidate (full nightly)
npx @gamaze/hicortex nightly --capture-only    # Capture only, skip consolidation (safe for sub-daily runs)
npx @gamaze/hicortex nightly --dry-run         # Preview without changes
npx @gamaze/hicortex classify-domains          # Backfill domain tags over the corpus (see Memory Domains & Tags)
npx @gamaze/hicortex dedup                     # Preview near-duplicate memory clusters (dry run, no changes)
npx @gamaze/hicortex dedup --apply             # Merge near-duplicate clusters (backs up the DB first)
npx @gamaze/hicortex context show [name]       # Print the standing context layer (see Context Layer)
npx @gamaze/hicortex context edit <name>       # Edit a context section in $EDITOR
npx @gamaze/hicortex context show --agent <id> # Show a specific agent's resolved context (0.13)
npx @gamaze/hicortex init --agent-name <name>  # Opt in to a per-agent context id (default: unset — shared global context)
npx @gamaze/hicortex init --agent-name ""      # Clear it back to global context
npx @gamaze/hicortex init --repair-config      # Recover from a malformed config.json (see below)
npx @gamaze/hicortex telemetry                 # Show exactly what anonymous telemetry sends
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
| `llmModel` | The one model used by all phases (distill, score, classify, reflect). Set via `init`. |
| `numCtx` | Context window for ollama (default 8192, one value for all phases). Scoring uses ~850 tokens, so 2048 is ample; distill/reflect/classify need more for `detectChunkSize`'s chunk sizing. |
| `enableThinking` | Toggle the model's internal reasoning ("thinking") stream for OpenAI-compatible endpoints (default false). Only meaningful for local chat-template-aware servers (ollama, mlx-lm); leave unset for cloud OpenAI/OpenRouter/Groq endpoints (they 400 on the unknown `chat_template_kwargs` field). |
| `maxTokens` | Max output tokens for all phases (default 8192). A ceiling, not a target — the model stops early when done. |
| `ollamaFlushEvery` | Flush ollama's accumulated memory every N scoring calls. **Off by default (0)** — opt-in only for an **ollama** install whose runner RSS growth (~171 MB/call) swap-thrashes long consolidations on a RAM-constrained box; N=15 caps a cycle at ~2.5 GB. Gated on the provider being ollama (local **or** remote) — no effect for non-ollama providers. Only you can judge whether your ollama endpoint actually suffers the growth (a managed/cloud ollama host may not), so it stays off until you set it. |
| `ollamaFlushWaitMs` | Milliseconds to wait after an ollama flush for the runner to exit + release memory (default 180000 = 3 min). |
| `authToken` | Bearer token for endpoint auth. Generated on first `init` in server mode. Find the active token with `hicortex status` or in `~/.hicortex/config.json`. |
| `corsAllowedOrigins` | Browser origins allowed to read cross-origin responses, e.g. `["https://ui.example.com"]`. **Empty by default** — the server sends no `Access-Control-Allow-Origin` and never `Allow-Credentials`, so no external web page can read its data. The bundled `/viz` and `/context/ui` pages are same-origin and need no entry. |
| `licenseKey` | Commercial license key (optional; for display in `hicortex status`) |
| `domains` | Your memory domain list (`[{name, description}]`). Scaffolded by `init`; edit freely — see [Memory Domains & Tags](#memory-domains--tags) |
| `weakPrimaryFloor` | Minimum similarity for a no-fit memory to keep a weak domain association (default: 0.45) |
| `moduleIndexTokenBudget` | Max tokens for domain index in lessons context (default: 500) |
| `lessonsLimit` | Max lessons injected into an agent's session-start context (default: 10). Lessons are ranked per session by project/domain affinity + recency + strength + access, so each session sees its most-relevant slice. Lower = leaner system prompts. |
| `contextClients` | Which harnesses inject the [context layer](#context-layer) at session start (default `["cc"]`; `"all"` or any subset of `cc`/`hermes`/`oc`) |
| `contextAgents` | Per-agent context modes (0.13): `{ "<id>": "override" \| "global" \| "off" }`. Absent + no `agents/<id>/` dir → every agent gets the global set. Boot-time (restart to apply) — see [Per-agent context](#per-agent-context-013) |
| `agentName` | This install's per-agent context id sent as `?agent=`. **Unset by default** (CC shares the global context — no `?agent=` sent). Explicit opt-in via `init --agent-name <name>`; `init --agent-name ""` clears it. An empty/whitespace value equals unset |
| `captureCooldownHours` | Success-cooldown (hours) for the **capture watchdog** (0.17). The capture timer polls every ~20 min; the watchdog captures only if more than this has elapsed since the last *successful* capture (`state.lastNightly`). Default `6` (≈4 captures/day). A failed preflight retries on the next poll (~20 min) — so a transient fire-instant network miss costs minutes, not a day (#239) |
| `consolidationHours` | Hours (0–23, local) for the **consolidation** timer — the full nightly (capture + distill + score + reflect + link). Installed for **server/co-located only** (clients have no local DB). Default `[10, 22]`: the 22:00 evening slot runs after the day's capture waves (same-day results); the 10:00 morning slot runs *after* the morning capture so wake-up pushes are caught. Omitted on clients |
| `consolidateMaxLlmCalls` | Ceiling on total LLM calls across all classify-tier consolidation stages (content-domain, link discovery, supersession) per run. A runaway **backstop**, not a throughput throttle — on a free local model the binding constraint is the nightly unit's wall-clock timeout, not call count. Default `5000` (was a hard-coded 200 that starved link/supersession during a classification backlog) |
| `updateChannel` | Release channel pinned into the generated daemon/timer ExecStart for **npx-thin** installs (global-binary installs use the absolute binary and are unaffected). A dist-tag (`"rc"`, `"next"`) or an exact version (`"0.17.1"`). E.g. `"rc"` → the timer runs `npx -y @gamaze/hicortex@rc nightly`, so the host tracks the rc dist-tag (an internal fleet can ride rc through a pre-promotion soak). Validated as `[\w.\-]+` (rejects anything that'd break the unit/plist templates). Absent → auto-detect (bare on `latest`, else `@next`). (0.17.1) |
| `nightlyHour` | **Deprecated (0.17) single-slot fallback.** Local hour (0–23) honoured only when `consolidationHours` is absent — yields one daily consolidation slot at that hour (preserves the pre-0.17 "one daily job" intent). New installs should use `consolidationHours` |
| `preflightTimeoutMs` | **Client mode only.** Per-attempt timeout for the nightly's server-reachability check before it starts capturing (default: 20000 ms, bumped from 15000 in 0.17 to absorb a slow link re-establishing after the client wakes) |
| `preflightAttempts` | **Client mode only.** Reachability-check retries before the nightly aborts (default: 3; floored at 1). `1` = single try, no retry |
| `preflightRetryGapMs` | **Client mode only.** Delay between reachability retries (default: 60000 ms). Note: timers don't advance while the machine is asleep, so on a sleeping laptop this gap counts awake-time, not wall-clock |
| `scoreSimilarityWeight` | Weight of semantic similarity in the ranking score (default: 0.50) |
| `scoreStrengthWeight` | Weight of effective strength — importance/use/recency of access (default: 0.20) |
| `scoreConnectionsWeight` | Weight of graph centrality (default: 0.15) |
| `scoreRecencyWeight` | Weight of the slow recency curve (default: 0.15) |
| `freshnessBoostDays` | Fresh-memory window: new memories rank higher for this many days (default: 7) |
| `freshnessBoostWeight` | Size of the fresh-memory bonus at age 0, fading linearly to 0 at the window edge (default: 0.15; set 0 to disable) |
| `supersededDemotion` | Score multiplier for a memory a later decision reversed (default: 0.50) |
| `decayHalfLifeDays` | Memory decay half-life in days at reference importance (default: 365). Larger = slower forgetting; importance, access, and links slow it further |
| `searchLimit` / `recentLimit` | Default result counts for search (8) and recent (12) |
| `recentWindowDays` | Candidate window for recent recall (default: 180) |
| `coldExposureSlots` | Top-k slots reservable for never-accessed memories so the long tail gets exposure (default: 2) |
| `recallMaxItems` | Max lines in the pushed recall index (default: 6) |
| `recallMinSimilarity` | Relevance floor for index entries (default: 0.55; text-search matches always pass) |
| `recallReshowTurns` | Turns before an already-shown memory may reappear in the same session (default: 30) |
| `recallMinPromptChars` | Prompts shorter than this skip the recall index (default: 20) |
| `recallTitleChars` | Chars of each memory's first line shown in an index entry (default: 150, range 40–400). Raised from 100 on 2026-08-02: with topic-first memory titles, 150 chars carries the subject *and* its claim, where 100 cut the claim mid-sentence. Costs roughly +74 tokens per 6-line block |
| `sessionIntentWeight` | Blend weight of the session-intent rolling centroid in the recall search vector: `query = (1-w)·prompt + w·centroid` (default: 0.33; set 0 to disable — pure-prompt recall, the kill-switch). The first turn of a session searches with pure prompt and seeds the centroid; subsequent turns blend so recall follows the session's intent instead of being query-literal. The EMA rate (0.4) is a shipped constant, not configurable |
| `dedupMergeThreshold` | Minimum cosine similarity for `hicortex dedup` to cluster memories as near-duplicates (default: 0.92) |
| `supersessionMinSimilarity` | Minimum cosine similarity for a nightly supersession candidate pair (default: 0.80) |
| `supersessionMaxCalls` | Max classify-tier LLM calls the nightly's supersession stage spends per run (default: 30) |
| `supersessionPenalty` | Multiplier applied to a superseded memory's `base_strength` (default: 0.5) |
| `telemetry` | Anonymous usage telemetry. **On by default and not written into config by `init`** — add `"telemetry": false` yourself (or set `HICORTEX_TELEMETRY=off`) to opt out. Inspect exactly what is sent with `hicortex telemetry` |

Full docs: [hicortex.gamaze.com/docs/configuration.html](https://hicortex.gamaze.com/docs/configuration.html)

## REST API

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/health` | GET | No | Server status, memory count, version |
| `/distill` | POST | Yes | Canonical capture endpoint (0.9.0+). Accepts denoised session text (`text` string or `messages` array), distills server-side, stores. Used by both server-mode and client-mode nightly jobs. |
| `/search` | GET | Yes | Semantic memory search |
| `/recall-index` | POST | Yes | Pushed recall index (0.14): `{session_id, prompt}` → compact one-line-per-memory block (or `null`); `{session_id, reset: true}` clears the session's dedup state. Appearing in the index marks memories *shown*, never *used* |
| `/memory` | GET | Yes | Fetch one memory by `?id=` (0.14). Marks it as used (strengthens) — the lazy-load counterpart of `/recall-index`. Response includes a server-rendered `citation` (id, date, origin agent) — agents are instructed to cite memories that shape their answers, so memory influence is always visible to the user (0.14.1) |
| `/recent` | GET | Yes | Recent memories, queryless recall (renamed from `/context` in 0.12) |
| `/context` | GET / PUT | Yes | Standing [context layer](#context-layer): read all sections / partial-upsert named sections. `?agent=<id>` selects a [per-agent scope](#per-agent-context-013) (server resolves override/global/off + merge); invalid id → 400. Recall-style query params on GET → 400 (use `/recent`) |
| `/context/ui` | GET | No* | Web editor for the context layer (shell served without auth, like `/viz`; data via `/context`) |
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

**`init` fails with "Refusing to write ~/.hicortex/config.json":** the file exists but is not valid JSON — usually a hand-edit slip (a trailing comma, a truncated write). `init` refuses rather than overwriting it, because overwriting would lose `authToken`, `licenseKey`, and your `domains` list. Two ways out:

1. **Preferred — fix the JSON.** The error names the parse failure and its position. Correct it and re-run `init`. Nothing is lost.
2. **`npx @gamaze/hicortex init --repair-config`.** Moves the broken file to `config.json.corrupt-<timestamp>` and rebuilds from scratch. Nothing is deleted, and it prints the top-level key names it found (names only — never secret values) so you know what to copy back. **This mints a new `authToken`**, so every thin client pointing at this server must be updated or its recall will silently 401 (recall is fail-soft — you will see no error, just no memories).

The nightly and the server behave differently on purpose: a malformed config makes them log a warning and run degraded rather than refuse to start, so a broken config never takes recall offline.

**Tools not visible to agent (OC):** The plugin auto-adds tools to `tools.allow` on startup. Restart the gateway after install.

**OC plugin: "Server unreachable":** The plugin requires a running Hicortex server. Run `npx @gamaze/hicortex init` on the same machine, or set `serverUrl` in the plugin config to point at a remote server.

**LLM auto-config failed:** Check logs for `[hicortex] WARNING`. Add `llmBaseUrl` to plugin config or set `HICORTEX_LLM_BASE_URL` env var (applies to server setup, not the OC plugin itself).

**No lessons generated:** Reflection requires an LLM. Check that your provider is accessible and has sufficient quota.

**First startup slow:** The embedding model (~130MB) downloads on first run. Allow up to 2 minutes.

**Server won't start (CC):** Check `~/.hicortex/nightly.log` for errors. Verify port 8787 is free: `lsof -i :8787`.

**Multiple CC sessions:** The HTTP server handles multiple concurrent sessions. Do not use stdio transport — it spawns separate processes per session.

**Ollama timeout on large sessions:** Hicortex uses streaming mode with 3 retries (30s, 60s, 120s backoff). If first call fails (model loading), retry handles it automatically.
