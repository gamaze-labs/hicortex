# Hicortex Changelog

All notable changes to this project are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/).

## [0.11.1] - 2026-07-08

### Fixed
- **/viz requested at most 2000 nodes no matter what the Node-limit control said (#162).** A leftover client-side `Math.min(lim, 2000)` from the v1 limits silently capped every export request; the input field and the server both already supported 10000. The client cap is removed entirely — the server's `EXPORT_MAX_LIMIT` clamp is the single authority, so the two can never drift apart again.
- **`GET /graph` neighbors/hubs `limit` param is validated** (floored, minimum 1). Negative values previously meant "unlimited" in the SQL `LIMIT`; fractional values threw a binding error surfacing as a 500.

## [0.11.0] - 2026-07-08

### Changed
- **No-fit = EMPTY tag set — the "Unsorted" fallback category is gone (owner amendment 07.07 to the graded-schema spec).** The classifier prompt now instructs `{"tags": []}` when no configured domain genuinely fits, and `parseTagReply` returns the distinct result `{tags: []}` for an explicit empty array (null stays reserved for infra errors → memory skipped untouched and retried later; the #150 discipline is unchanged). `resolveFallbackDomain`/`DEFAULT_UNSORTED` are removed: no configured domain is ever auto-assigned on a no-fit, and a config WITHOUT any "Unsorted" domain is the norm (one that still has it is just a normal domain). What happens to a no-fit memory instead (owner-approved lifecycle: tagged → lives, weak association → lives humbly, no association → forgotten; implemented in the new `src/nofit.ts`, shared by the nightly stage and `hicortex classify-domains`):
  - **Weak-primary floor** — the memory earns a WEAK primary from pure embedding association: argmax cosine across ALL domain prototypes, when the best cosine ≥ the new optional `weakPrimaryFloor` config key (default 0.45 — tune it from the corpus weight distribution, e.g. the lower tail of the memory_tags.weight histogram of LLM-tagged rows). Tagged with that single domain (the primary derives naturally), logged distinctly (`weak-primary <domain> w=0.52`).
  - **No-association decay** — below the floor the memory is NOT tagged: its base_strength is HALVED (floored at 0.05) and its domain stays NULL, so every subsequent run re-attempts it as prototypes evolve and re-halves only while it is still a below-floor no-fit (exactly one halving per run). This is what makes the existing prune stage reachable at all: at base_strength 0.5 a memory can NEVER prune (effectiveStrength's asymptotic floor 0.5²×0.1 = 0.025 sits above the 0.01 prune threshold); four halvings reach the 0.05 strength floor, where prune fires once the memory is ~143 days unaccessed (and past the 90-day minimum age). Rescue paths: a single access permanently shields it from pruning (prune only considers access_count = 0 memories), and a later classification or weak primary stops the halving (strength is not restored — only access does that).
  - New counters: `weak_primary` / `no_association_decayed` in the nightly stage report, `weakPrimary` / `noAssociationDecayed` in the classify-domains report.
- **Graded schema memory tags — prototype-derived per-tag weights, DERIVED primary; the LLM now emits discrete tags only** (spec: `specs/2026-07-07-graded-schema-memory-tags.md`; supersedes the LLM-picked primary from the multi-tag change below). Domains now behave like human memory schemas with graded membership: each configured domain gets a **prototype** — the L2-normalized centroid of its member embeddings, seeded from the embedded config description ("Name: description") while a domain has fewer than 5 members — stored in the new `domain_prototypes` table, and every tag assignment gets an association **weight** = cosine(memory embedding, domain prototype) in the new `memory_tags.weight` column (**migration v7**). The **primary** (`memories.domain` — viz colour, `/index` counts, lesson affinity) is now fully mechanical: the argmax-weight tag, overridden by any tagged domain flagged `compartment: true` in config (deliberate compartmentalization — the work/life firewall), with the LLM's most-relevant-first order breaking exact-weight ties. The classifier prompt asks for ONLY `{"tags": [...]}` (1–4 domains, most relevant first, with a generic multi-tag emphasis: things the owner builds usually carry BOTH the venture/project domain AND the life topic they touch); no LLM-emitted primary, weights, or ranks — audits showed LLM primaries were a coin-flip on overlapping spheres and LLM-invented numbers were noise. Legacy `{primary, tags}` replies are still parsed for tolerance, but the primary is ignored. Prototypes, ALL weights, and ALL primaries are **recomputed every nightly** (and after `hicortex classify-domains`) so categories drift with the data — reconsolidation without re-classification runs. Query surface: `GET /graph?op=export` node payloads order `tags` by weight descending and add a parallel `tagWeights: number[]` (rounded 4dp), and op=export gains a `tag=` filter ("everything touching X" — tag match at any weight, unlike `domain=` which matches only the derived primary).
- **Memories now carry MULTIPLE tags (a primary + additional) from the config vocabulary — supersedes the single-domain classification.** The single-domain approach (added earlier this cycle; see below) forced each memory into exactly one life-sphere, which mis-modelled memories that genuinely span spheres (a "set up bedrock for the agent fleet" memory is both Hardware and Ventures) and produced a ~14% Unsorted pile of misfiled technical memories. Classification now returns a `primary` tag plus every additional tag that genuinely applies, all drawn from the same `config.domains` controlled vocabulary. **Low-churn design:** the existing `memories.domain` column keeps its meaning as the PRIMARY tag (so viz colour, `/index`, and lesson-selection are unchanged); a new `memory_tags(memory_id, tag)` sidecar table (migration v6) holds the full multi-label set including the primary. The classifier is one constrained reflect-model call per memory; the memory's `project` name is now passed as a **classification hint** ("content wins, project only breaks ties"), which rescues terse technical memories from projects like raider/hiops/catalyst that the single-label path punted to Unsorted. Multi-label makes the Unsorted fallback rare. New `classifyMemoryTags` replaces `classifyMemoryDomain`; the nightly stage and `hicortex classify-domains` both write via `storage.setMemoryTags`. The nightly re-files rows that are NULL, out-of-vocabulary, OR have no `memory_tags` rows yet (so single-domain memories from the earlier approach are backfilled). `GET /graph?op=export` nodes gain a `tags: string[]` field (primary stays the colour); `/index` gains an optional `tagCounts` map. Config key unchanged (`domains`).
- **Linking is now heuristic-only (`extends` / `relates_to`); LLM/uppercase edge classification retired.** A 672-link audit (17 LLM judges) of the current linking output found only **31% of typed links overall** were correct/defensible. The LLM-classified UPPERCASE types were near-useless (**CONTRADICTS 4%** acceptable, SUPERSEDES 29%, DEPENDS_ON 26%, CAUSED_BY 24%, VALIDATES 44%), and the lowercase heuristics `updates`/`derives` were also weak (~31%); only `extends` (57%) and `relates_to` (53%) held up. In response: (1) `classifyLinkCandidates` no longer calls the LLM — it assigns each candidate its heuristic type (the `llm`/`budget` params are retained but ignored for call-site stability); (2) `classifyRelationship` collapses to exactly two labels — same-project + cosine above `CONSOLIDATE_LINK_THRESHOLD` → `extends`, otherwise → `relates_to` (`updates`/`derives` no longer emitted); (3) new **cross-project strength floor** — a candidate whose source/target are in different projects is rejected unless cosine ≥ `CROSS_PROJECT_LINK_THRESHOLD` (0.80), since cross-project links audited 65% wrong-link vs 6% same-project and strength predicts quality (wrong-link 42%→6% across strength quartiles); same-project keeps the 0.75 floor. The five UPPERCASE types stay in `VALID_RELATIONSHIP_TYPES` so pre-existing rows still validate — they are **retired, not deleted**, and may return only when a future classifier passes the audit harness at ≥ 70% acceptable. LLM edge classification is not re-enabled by this change. `relink` is heuristic-only too — its `--no-llm`, `--max-llm-calls`, `--llm-base-url`/`--llm-model` flags are gone (the LLM setup/preflight is removed).

### Fixed
- **`hicortex status` / `hicortex nightly --status` no longer report "Last run: never" on migrated installs (#161).** Both printers still read the legacy `nightly-last-run.txt`, which the state migration deletes after moving its value into `state.json.lastNightly`. A new shared `describeLastNightly()` in `state.ts` reads state.json and falls back to the legacy file for installs that haven't run the migration yet; both commands use it (duplicated age/staleness logic removed).
- **Retrieval relevance scoring recalibrated — semantic similarity is now computed correctly (true cosine) across the full range; lesson-contradiction detection now fires as intended (fixes #145).** The last two `1 − L2` "similarity" instances from the #143/#144 bug class are gone: (1) `computeScore` in `retrieval.ts` used `max(0, 1 − distance)`, which compressed real cosines (cos 0.8 scored 0.37) and flattened everything below cos 0.5 to exactly 0 — the composite score's similarity component now uses the shared `l2ToCosine` (`cos = 1 − d²/2`, valid for our L2-normalized embeddings), with the 0-clamp kept at the correct scale (negative cosine = truly unrelated). Blend weights (0.4/0.3/0.2/0.1) are deliberately unchanged in this pass — similarity values roughly double for related content, and rebalancing is a data-driven follow-up after a measured before/after comparison. (2) The `stageReflection` contradiction check (`1 − n.distance > 0.80`) effectively required cosine > 0.98 and almost never fired; it now triggers at TRUE cosine 0.80 (new `isContradictionCandidate` / `REFLECTION_CONTRADICTION_MIN_COSINE`), the original intent. Also scale-coupled: the placeholder distance for FTS-only/graph-discovered candidates (`DEFAULT_GRAPH_DISTANCE`) moves 0.5 → 1.0 so those candidates keep their neutral similarity of 0.5 instead of jumping to 0.875. `l2ToCosine` now lives in `retrieval.ts` (dependency root) and is re-exported by `consolidate.ts` for existing importers.
- **Infra errors during classification no longer mis-file memories as Unsorted (closes the #150 robustness item).** `classifyMemoryTags` distinguishes a genuine no-fit (a valid model reply that matched no vocabulary tag → `primary = Unsorted`) from an infrastructure error (the reflect endpoint throws after the one retry → returns `null`). On `null` the nightly SKIPS that memory (leaves it unclassified for a later run) and `hicortex classify-domains` ABORTS cleanly after committing the last full batch — the cursor sits at the last successfully-classified row and nothing is written as Unsorted. Previously an endpoint that died mid-run would file good technical memories into Unsorted.
- **Link similarity was computed as 1−L2, not cosine — linking was effectively a near-duplicate detector.** `discoverLinkCandidates` treated sqlite-vec's L2 `distance` as a similarity (`1 − distance`); with the 0.55 threshold that silently required cosine > 0.90, so only 12% of memories on the 2945-memory production corpus got links and the /viz graph was nearly disconnected. Embeddings are L2-normalized, so the honest conversion is `cos = 1 − d²/2` (new `l2ToCosine`). The threshold is recalibrated to **0.75 in true cosine space** (measured top-10 neighbor cosine histogram on the production corpus: top-1 median 0.823) with a new **top-3 cap per memory** (`CONSOLIDATE_LINK_TOP_K`) — together ≈ 2.2 candidate links/memory. **Migration v5** rescales existing `memory_links.strength` values (stored on the old 1−L2 scale; LLM-classified links also stored candidate similarity as strength, so all rows are rewritten) to cosine via `1 − (1−s)²/2`. The nightly linking stage and `hicortex relink` share this code and change behavior identically. (Note: `classifyRelationship`'s cosine boundaries were subsequently simplified to two labels — see the linking audit under Changed.)

### Added
- **`init` scaffolds generic default memory domains (issue #150 — packaging/docs pass).** Server-mode `init` now writes an editable 5-domain starting set to `~/.hicortex/config.json` when the config has no `domains` key: **Work, Personal, People, Health, Finance** (`GENERIC_DEFAULT_DOMAINS` in `init.ts`), with a printed hint that the list is user-owned and can be life areas OR project/topic areas. Non-clobber, same philosophy as the auth token: an existing `domains` key — even an empty array — is never touched. Upgrading installs get the scaffold when they re-run init; installs that never re-run init keep the legacy project-grouping. There is deliberately NO fallback category in the defaults (no "Unsorted" — the no-fit weak-primary/decay lifecycle handles unclassifiable memories automatically), and no interactive per-domain wizard — edit the JSON to taste. Classification activates automatically once an LLM is configured (strict-skip until then).
- **`domains.example.json` shipped in the npm package.** The 5 generic defaults as a copy-paste config snippet, plus a power-user example showing a narrower life-sphere set with `compartment: true` on Work (work/life firewall) and a custom `weakPrimaryFloor`.
- **Domains documented for release:** npm README gains a "Memory Domains & Tags" section (what domains are, editing config, the graded weight/derived-primary model, `hicortex classify-domains` backfill with flags, `weakPrimaryFloor`), install section notes the init scaffold, CLI help lists the scaffold under `init`, and the repo CLAUDE.md MODULE_INDEX section now describes the content-based multi-tag model vs the legacy project-grouping fallback.
- **Optional dedicated LLM tier for memory tag classification (`classifyModel`/`classifyBaseUrl`).** New optional config keys in `~/.hicortex/config.json`: when set, `classifyMemoryTags` (nightly content-domain stage + `hicortex classify-domains`) runs on `classifyModel@classifyBaseUrl` via the new `LlmClient.completeClassify`; when absent, classification falls back to the reflect tier exactly as before (zero behavior change for existing installs). If only `classifyModel` is set, it runs on the reflect endpoint (else the base endpoint). Pre-flight (the nightly `contentDomainsReady` gate and the classify-domains preflight) now probes the endpoint classification will ACTUALLY use, resolved by the shared pure `resolveClassifyProbeTarget`. Chosen after an A/B benchmark: gemma4:31b-mlx scored 83.7% vs qwen3.6:35b-a3b 65.4% primary accuracy on a 104-memory judged sample — while reflection/lesson extraction stays on the reflect model.
- **Content-based per-memory domain classification (config-owned domain list).** _(Superseded within this same 0.11.0 cycle by multi-tag classification — see Changed above. Retained here for history.)_ The nightly previously set each memory's `domain` by grouping PROJECTS into LLM-invented domains and assigning every memory its project's domain — wrong when "projects" are agent names (lenny, nano, …) and a single agent produces memories spanning many life areas. When `~/.hicortex/config.json` carries a `domains` array (`[{ name, description }, …]` — e.g. Work, Ventures, Hardware, Finances, Property, Vehicles, Boating, Health, Family, People, Travel, Unsorted), the nightly instead classifies **each memory into one life-sphere by its CONTENT** via one constrained reflect-model (35B) call, replacing the project-grouping path. Only NULL or stale-domain rows are (re)classified, so re-runs are cheap and editing the list re-files affected rows. Strict, quality-first: if the reflect endpoint fails pre-flight, domain classification is **skipped** for the run (no fall-back to a weak model or to project grouping). No-match/low-confidence memories fall to the `Unsorted` bucket. `moduleIndex` becomes the configured domains + live per-domain counts, so `/index` and lesson selection keep working. **When `domains` is absent, the legacy project-grouping behaviour is unchanged** (backward compatible for other installs). Sub-labels within a sphere (e.g. Ventures→Gamaze/Personal, Work→employer/workstream) are a **future phase** — this ships sphere-level `domain` only.
- **`hicortex classify-domains` — resumable content-domain backfill command.** Server-mode-only backfill over the corpus (needs `config.domains`), same discipline as `relink`: rowid-ordered batches (default 200), a `domainCursor` in state.json persisted per committed batch (interrupt-safe), reflect-endpoint pre-flight with clean abort, and a per-domain summary. Default scope classifies only NULL/stale-domain rows; `--all` reclassifies every memory; `--reset` restarts from the beginning; `--batch <n>` sets batch size.
- **`hicortex relink` — resumable link-discovery pass over the ENTIRE corpus (closes #143).** The nightly's linking stage only processes memories that are new since the last consolidation, so everything ingested before it existed (e.g. a migrated corpus — on bedrock, 88% of memories had no links) never went through link discovery, leaving the knowledge graph and /viz artificially sparse. `relink` back-fills the graph by reusing the exact nightly machinery (extracted from `stageLinks` into shared `discoverLinkCandidates`/`classifyLinkCandidates`): all memories are processed in rowid-ordered batches (default 200) using their STORED embeddings (no re-embedding), with the same candidate rules as the nightly (top-10 neighbors, cosine above `CONSOLIDATE_LINK_THRESHOLD` — `CROSS_PROJECT_LINK_THRESHOLD` for cross-project pairs — top-3 cap; see the linking fix under Fixed and the audit under Changed) and the same heuristic-only classification. A `relinkCursor` in state.json is persisted after every committed batch, so the run is safe to interrupt and resumes where it stopped; pairs already linked in either direction are never duplicated, making re-runs idempotent. Flags: `--dry-run` (counts only, zero writes), `--batch <n>`, `--reset`. Server-mode only; run manually, not part of the nightly.
- **Memory visualization: `GET /viz` knowledge-graph page (closes #124).** The server now serves a self-contained HTML page (inline CSS/JS, zero external requests — no CDN, works offline) that renders the memory knowledge graph on a hand-rolled canvas force-directed layout. Nodes are colored by knowledge domain, sized by effective (decayed) strength, hubs get a halo; edges are styled by relationship type (similarity, CONTRADICTS, SUPERSEDES, DEPENDS_ON, CAUSED_BY, VALIDATES). Pan/zoom/drag, hover tooltips, click-to-read detail panel, server-side filters (domain, memory type, min strength, node limit) and client-side search-to-highlight.
- **`GET /graph?op=export`** — the JSON surface feeding /viz: `{nodes, edges, domains, types, meta}`. Nodes ranked by effective strength, capped at 500 by default (hard max 2000); edges included only when both endpoints made the cut. Implemented as `exportGraph()` in `graph.ts`.
- **Browser auth for /viz.** The page shell is served without auth (like `/health` — it contains no data or secrets; all memory content comes from the bearer-only `/graph` endpoint). Remote browsers authenticate client-side: paste the token once into the in-page prompt (persisted in localStorage), or open `/viz?token=<authToken>` (the page strips the token from the URL on load). Localhost needs no token, as before. All data routes remain header-only.
- **/viz v2: 3D graph by default + 2D toggle, always-visible labels, redesigned controls (closes #139).** Follow-up on owner feedback that the hand-rolled 2D canvas was not intuitive (anonymous dots, unclear controls).
  - **3D default view** rendered with `3d-force-graph`; one-click toggle to a 2D view (`force-graph`). Same data (`/graph?op=export`) and same encodings in both: node color = knowledge domain, size = effective strength, halo = hub, edge color = relationship type (dashed CONTRADICTS in 2D; color-only in 3D).
  - **Vendored renderers, still zero external requests.** Pinned standalone bundles of three.js 0.183.0, 3d-force-graph 1.80.0, and force-graph 1.51.4 (all MIT) ship inside the package under `assets/vendor/` and are served same-origin by the daemon — no CDN, works offline. Versions, copyrights, and full license texts in the new `THIRD_PARTY_NOTICES.md`.
  - **`GET /viz/vendor/:file`** — new public asset route with a strict four-filename allowlist (anything else 404s; the served path is never built from request input). Auth exemption is as narrow as the /viz shell's: GET-only, exact allowlisted paths; all data routes stay bearer-only.
  - **Always-visible labels.** Hubs and the strongest memories are labeled permanently (canvas-texture sprites in 3D, canvas text in 2D, ~40 chars); the remaining labels fade in as you move the camera closer (3D) or zoom in (2D). Label density is adjustable.
  - **Controls redo.** Grouped left panel — Filters (domain, type, min strength, node limit, Apply), View (3D/2D toggle, similarity-edge threshold, label density), Search (matches highlighted, everything else dimmed) — plus a collapsible "How to read this" hint. Weak similarity edges are hidden by default (threshold slider reveals them). Click a node for the full memory; Esc closes.

## [0.10.1] - 2026-07-03

### Fixed
- npm README: added the missing "Install — Hermes" section (mirror-repo install + `hermes memory setup hicortex`); harness ordering. Identical code to 0.10.0.

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
