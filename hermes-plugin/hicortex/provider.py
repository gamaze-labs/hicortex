"""Hicortex MemoryProvider for Hermes — recall-only.

Recall:   prefetch()          -> POST /recall-index (pushed recall index, 0.14 —
                                 compact one-line-per-memory menu; the agent
                                 lazy-loads full content with hicortex_get).
                                 Falls back to GET /search full-content
                                 injection against a pre-0.14 server (404).
          queue_prefetch()    -> no-op on the recall-index path (the server
                                 dedups per turn; a client-side cache would
                                 double-suppress). Legacy background GET /search
                                 only on the 404 fallback path.
          tools               -> hicortex_search / hicortex_get / hicortex_recent / …
          system_prompt_block -> lessons + memory index injected into the prompt
          initialize()        -> POST /recall-index {reset:true} (new session =
                                 fresh context, so the server's per-session
                                 shown-set is cleared). Synchronous with the
                                 short recall timeout so it can never land
                                 AFTER the first turn's prefetch and wipe the
                                 registry state that turn just built. The
                                 MemoryProvider interface exposes NO
                                 compaction/context-rebuild signal, so a
                                 mid-session compaction cannot trigger a reset
                                 — the server's turn-based re-show window
                                 (recallReshowTurns) covers that gap by
                                 re-showing after enough turns.

Capture is NOT the plugin's job. A nightly reader on the Hicortex server
distills each agent's own session store (Hermes: ~/.hermes/profiles/<agent>/
state.db) centrally — see specs/2026-07-01-memory-capture-architecture.md. This
plugin has no local LLM, no spool, no timer, and no capture path.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, Iterable, List, Optional, Set

from agent.memory_provider import MemoryProvider

from .client import HicortexClient
from .config import CONFIG_SCHEMA, load_config

logger = logging.getLogger(__name__)

_INJECT_CONTENT_CAP = 500

# How long a /recall-index 404 latches the legacy-fallback path before the
# endpoint is re-probed. The latch must EXPIRE (review F2): during a
# client-first rollout the plugin may probe a still-0.13 server once and would
# otherwise stay on the legacy path until a gateway restart nobody knows to do.
# Long enough not to hammer an old server every turn, short enough that a
# server upgrade is picked up within minutes.
_FALLBACK_RETRY_SECONDS = 600.0

# Agent ids are joined into a filesystem path server-side, so they share the
# section-name allowlist. \Z (NOT $) anchors the END OF STRING: Python's $ also
# matches just before a trailing "\n", so "alice\n" would pass and go out as
# agent=alice%0A → a 400 the fail-soft path silently swallows.
_AGENT_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*\Z")


def _valid_agent_id(name: Optional[str]) -> bool:
    return bool(name) and len(name) <= 64 and bool(_AGENT_ID_RE.match(name))


def _sanitize_agent_id(raw: Optional[str]) -> Optional[str]:
    """Sanitize a raw identity (profile name / env value) into a valid agent id,
    or None when nothing valid remains — mirrors the TS ``sanitizeAgentId``
    EXACTLY so a profile resolves to the SAME id on both harnesses (a mismatch
    would make one honor the persona firewall and the other leak global context
    into an ``off``/``override`` persona): lowercase → collapse invalid runs to
    "-" → strip leading -/_ → truncate 64 → validate. "Alice" → "alice";
    "MacBook-Pro.local" → "macbook-pro-local"; all-symbols → None."""
    if not isinstance(raw, str):
        return None
    cleaned = re.sub(r"[^a-z0-9_-]+", "-", raw.lower())
    cleaned = re.sub(r"^[-_]+", "", cleaned)[:64]
    return cleaned if _valid_agent_id(cleaned) else None


def _profile_from_home(home: str) -> Optional[str]:
    """Parse a Hermes profile name from a ``HERMES_HOME`` ending in
    ``…/profiles/<name>``; None when the path is not profile-shaped."""
    home = (home or "").strip().rstrip("/")
    if not home:
        return None
    parent, name = os.path.split(home)
    return name if name and os.path.basename(parent) == "profiles" else None


def _resolve_agent_name(cfg: Dict[str, Any]) -> Optional[str]:
    """Resolve the per-agent context id (0.13), in priority order:
      1. config ``agent_name`` (explicit override);
      2. ``HERMES_PROFILE`` env;
      3. parse ``HERMES_HOME`` when it ends ``profiles/<name>``;
      4. None → bare fetch → the global set.
    Each source is stripped then SANITIZED (not rejected) so "Alice" → "alice"
    matches the TS contract; a source that sanitizes to None yields None (bare
    fetch), never a fall-through to another identity."""
    configured = (cfg.get("agent_name") or "").strip()
    if configured:
        return _sanitize_agent_id(configured)
    prof = (os.environ.get("HERMES_PROFILE") or "").strip()
    if prof:
        return _sanitize_agent_id(prof)
    parsed = _profile_from_home(os.environ.get("HERMES_HOME") or "")
    if parsed:
        return _sanitize_agent_id(parsed)
    return None


def _title_case_section(name: str) -> str:
    """"user" → "User", "my_notes" → "My Notes" (mirrors the CC/OC helper)."""
    words = [w for w in re.split(r"[-_]+", name) if w]
    return " ".join(w[:1].upper() + w[1:] for w in words)


# #313 scope labels — mirror of the TS ``SECTION_LABELS`` in
# identity-store.ts (keep in sync). "Global rules" marks the section as
# fleet-wide; unknown section names fall back to title-case.
_SECTION_LABELS = {
    "agent_identity": "Agent identity",
    "user": "User",
    "rules": "Global rules",
}


def _order_section_names(names: Iterable[str]) -> List[str]:
    """Stable ordering — the #313 precedence contract, mirroring the TS
    ``SECTION_PRECEDENCE`` (keep in sync): ``agent_identity`` (the agent's own
    self + role conduct, per-agent only) first, then ``user`` (the principal),
    then ``rules`` (fleet-wide house rules), then the rest alphabetically."""
    names = list(names)
    primaries = [p for p in ("agent_identity", "user", "rules") if p in names]
    rest = sorted(n for n in names if n not in ("agent_identity", "user", "rules"))
    return primaries + rest


def _render_context_block(sections: Dict[str, Any]) -> str:
    """Render the ``## Identity`` block, or "" when every section is blank.
    Headings use the #313 scope labels (``_SECTION_LABELS``); unknown sections
    fall back to title-case."""
    body_parts: List[str] = []
    for name in _order_section_names(sections.keys()):
        body = sections.get(name)
        if not isinstance(body, str) or not body.strip():
            continue
        label = _SECTION_LABELS.get(name) or _title_case_section(name)
        body_parts.extend([f"### {label}", "", body.strip()])
    if not body_parts:
        return ""
    return "\n".join(["## Identity", "", *body_parts])


class HicortexProvider(MemoryProvider):
    """Hicortex long-term memory backend for Hermes (recall-only)."""

    def __init__(self):
        self._client: Optional[HicortexClient] = None
        self._project: Optional[str] = None
        self._recall_limit: int = 5
        self._privacy: Optional[str] = "WORK,PERSONAL"
        self._mission_domains: List[str] = []  # #203 scope (set from config in initialize)
        self._agent_name: Optional[str] = None
        self._prefetch_cache: Dict[str, str] = {}
        self._bg_threads: List[threading.Thread] = []
        self._session_id: Optional[str] = None
        # /recall-index 404 latch: 0.0 = not latched; otherwise the
        # time.monotonic() deadline until which the legacy /search prefetch is
        # used. Expires (re-probe) per _FALLBACK_RETRY_SECONDS. Only a
        # definitive 404 latches; network errors stay fail-soft per turn.
        self._recall_index_retry_at: float = 0.0
        # Warn-once bookkeeping (review F3): a persistent non-404 HTTP error —
        # especially 401/403 from a bad token — must surface at WARNING level
        # once per distinct status, not vanish at debug level (the class of
        # silent auth failure that once hid a dead recall path for days).
        self._warned_recall_statuses: Set[int] = set()

    @property
    def name(self) -> str:
        return "hicortex"

    # ------------------------------------------------------------------ config
    def _build_client(self) -> Optional[HicortexClient]:
        cfg = load_config()
        url = cfg.get("hicortex_url")
        if not url:
            return None
        token = cfg.get("hicortex_auth_token")
        return HicortexClient(url, auth_token=token or None)

    def _client_or_none(self) -> Optional[HicortexClient]:
        if self._client is None:
            try:
                self._client = self._build_client()
            except Exception as e:
                logger.warning("hicortex: failed to build client: %s", e)
        return self._client

    def is_available(self) -> bool:
        """Configured and ready — NO network call (per MemoryProvider contract).

        ``is_available`` runs at agent init to decide whether to activate this
        provider. Pinging the server here would mean a slow or momentarily-down
        server silently disables memory for the whole session. Per the contract
        ("should not make network calls — just check config and installed deps")
        we only verify a server URL is configured; per-request failures are
        handled at use time.
        """
        return self._build_client() is not None

    def initialize(self, session_id: str, **kwargs) -> None:
        cfg = load_config()
        self._project = cfg.get("default_project") or None
        try:
            self._recall_limit = int(cfg.get("recall_limit", 5))
        except (TypeError, ValueError):
            self._recall_limit = 5
        self._privacy = cfg.get("privacy_filter", "WORK,PERSONAL")
        # #203 scope: declared knowledge domains for this role-bound agent
        # (e.g. a health-focused agent → Health). Soft affinity boost on
        # recall; never excludes.
        _md_raw = cfg.get("mission_domains") or ""
        self._mission_domains = [d.strip() for d in _md_raw.split(",") if d.strip()]
        self._agent_name = _resolve_agent_name(cfg)
        try:
            self._client = self._build_client()
        except Exception as e:
            logger.warning("hicortex: init client build failed: %s", e)
        # New session = fresh context window, so the server's per-session
        # shown-set is stale by definition. SYNCHRONOUS (review F8): a
        # background reset could land AFTER the first turn's prefetch and wipe
        # the shown-set/turn counter that turn just built. The client's short
        # recall timeout (1.5 s) bounds the startup cost; fail-soft. The id
        # goes through the SAME resolver as prefetch (review F7) so the reset
        # hits the key the turns will accumulate under.
        sid = self._resolve_session_id(session_id)
        client = self._client
        if client is not None:
            try:
                status, _ = client.recall_index(sid, reset=True)
                if status == 404:
                    # Pre-0.14 server — latch the legacy path now rather than
                    # paying another probe on the first turn; the TTL heals it.
                    self._recall_index_retry_at = (
                        time.monotonic() + _FALLBACK_RETRY_SECONDS
                    )
            except Exception as e:
                logger.debug("hicortex recall reset failed: %s", e)

    # ------------------------------------------------------------------- recall
    def _format_hits(self, hits: list[dict]) -> str:
        if not hits:
            return ""
        lines = [
            "Relevant prior context from your long-term memory "
            "(verify before relying on these — each shows date and project):"
        ]
        for h in hits[: self._recall_limit]:
            date = (h.get("created_at") or "")[:10]
            proj = h.get("project") or "global"
            content = (h.get("content") or "").strip().replace("\n", " ")
            if len(content) > _INJECT_CONTENT_CAP:
                content = content[:_INJECT_CONTENT_CAP] + "…"
            lines.append(f"- [{date}, {proj}] {content}")
        return "\n".join(lines)

    def _resolve_session_id(self, session_id: str) -> str:
        """Session id for /recall-index, unified across initialize() and
        prefetch() (review F7). Precedence: an explicit non-empty id ALWAYS
        wins and becomes the stored id (so a Hermes that hands initialize an
        empty id but passes real ids per turn converges on the real id — the
        turns and any later reset then share one registry key); else the
        stored id; else a generated ``hermes-<uuid4>`` stored once (dedup
        degrades from session to provider-instance scope — still correct,
        never a shared "" that would merge every session on the server)."""
        if session_id:
            self._session_id = session_id
            return session_id
        if not self._session_id:
            self._session_id = f"hermes-{uuid.uuid4()}"
        return self._session_id

    def _recall_index_latched(self) -> bool:
        """True while the /recall-index 404 latch is active (legacy path)."""
        return (
            self._recall_index_retry_at > 0
            and time.monotonic() < self._recall_index_retry_at
        )

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        client = self._client_or_none()
        if client is None:
            return ""
        # Pushed recall index (0.14): the server does relevance gating and
        # TURN-based dedup — every user turn is sent, the server decides what
        # is new. The sha1 prefetch cache is deliberately NOT consulted on this
        # path: replaying a cached block would skip the server call, so the
        # registry's turn counter would drift and dedup would double-suppress.
        if not self._recall_index_latched():
            try:
                status, resp = client.recall_index(
                    self._resolve_session_id(session_id),
                    prompt=query,
                    project=self._project,
                    privacy=self._privacy,
                    mission_domains=self._mission_domains,
                )
                if status == 404:
                    # Old-server guard: pre-0.14 has no /recall-index. Latch
                    # the legacy /search prefetch, re-probe after the TTL.
                    logger.info(
                        "hicortex: server has no /recall-index (pre-0.14) — "
                        "falling back to /search prefetch for %.0f s",
                        _FALLBACK_RETRY_SECONDS,
                    )
                    self._recall_index_retry_at = (
                        time.monotonic() + _FALLBACK_RETRY_SECONDS
                    )
                elif status == 200:
                    self._recall_index_retry_at = 0.0
                    block = resp.get("block") if isinstance(resp, dict) else None
                    # block is None when nothing is new/relevant → inject nothing.
                    return block if isinstance(block, str) else ""
                else:
                    # Auth/5xx/…: not a version signal — fail soft this turn
                    # (legacy /search would hit the same wall anyway), but
                    # surface it ONCE per status at WARNING: a persistent 401
                    # from a bad token must never hide at debug level.
                    if status not in self._warned_recall_statuses:
                        self._warned_recall_statuses.add(status)
                        hint = (
                            " — check hicortex_auth_token/HICORTEX_AUTH_TOKEN"
                            if status in (401, 403)
                            else ""
                        )
                        logger.warning(
                            "hicortex: /recall-index returned HTTP %s; recall "
                            "injection is disabled while this persists%s",
                            status,
                            hint,
                        )
                    else:
                        logger.debug("hicortex recall-index HTTP %s", status)
                    return ""
            except Exception as e:
                logger.debug("hicortex recall-index failed: %s", e)
                return ""
        return self._legacy_search_prefetch(client, query)

    def _legacy_search_prefetch(self, client: HicortexClient, query: str) -> str:
        """Pre-0.14 behavior: full-content /search injection with the one-shot
        sha1 cache warmed by queue_prefetch."""
        key = hashlib.sha1(query.encode("utf-8")).hexdigest()
        cached = self._prefetch_cache.pop(key, None)
        if cached is not None:
            return cached
        try:
            hits = client.search(
                query, limit=self._recall_limit, project=self._project, privacy=self._privacy
            )
            return self._format_hits(hits)
        except Exception as e:
            logger.debug("hicortex prefetch failed: %s", e)
            return ""

    def queue_prefetch(self, query: str, *, session_id: str = "") -> None:
        # Recall-index path: no background warm-up. One /recall-index POST per
        # turn (from prefetch) is the contract — a queued call here would burn
        # a registry turn AND cache a block the server thinks it already
        # showed. Only the latched (confirmed-404) legacy path keeps the old
        # behavior.
        if not self._recall_index_latched():
            return
        client = self._client_or_none()
        if client is None:
            return
        key = hashlib.sha1(query.encode("utf-8")).hexdigest()

        def _bg() -> None:
            try:
                hits = client.search(
                    query, limit=self._recall_limit, project=self._project, privacy=self._privacy
                )
                self._prefetch_cache[key] = self._format_hits(hits)
            except Exception as e:
                logger.debug("hicortex queue_prefetch failed: %s", e)

        self._spawn(_bg)

    # ------------------------------------------------------ system prompt/tools
    def system_prompt_block(self) -> str:
        client = self._client_or_none()
        if client is None:
            return ""
        # Standing context (L2, 0.13) is prepended ABOVE the lessons block. The
        # two fetches run CONCURRENTLY (matching the TS Promise.all paths): run
        # serially, a blackholed server would stall the turn for up to 2× the
        # client timeout. Each block fails soft independently — a context failure
        # must never cost the lessons block, and vice versa.
        with ThreadPoolExecutor(max_workers=2) as executor:
            f_context = executor.submit(self._context_block, client)
            f_lessons = executor.submit(self._lessons_block, client)
            blocks = [f_context.result(), f_lessons.result()]
        return "\n\n".join(b for b in blocks if b)

    def _context_block(self, client: HicortexClient) -> str:
        """Fetch the standing context layer and render a ``## Identity`` block,
        or "" when nothing should be injected. Gates (ALL): "hermes" in the
        server-resolved ``clients``; when an agent id was SENT, the response
        echoes ``agent`` (old-server guard — a pre-0.13 server ignores ?agent=
        and returns global with no echo; injecting would push global context
        into every persona; the check is skipped on a bare fetch); and the
        resolved section set is non-empty (mode "off" → {}).

        Reference implementation for the gate: TS ``gateAndRenderContext`` in
        ``packages/hicortex/src/lessons-context.ts`` (keep the two in sync).

        The ENTIRE path — fetch, parse, gate, render — is inside the try: a
        malformed ``clients`` value (e.g. an int from a proxy error page) would
        otherwise raise during the ``in`` check, escape, and cost the lessons
        block too (mirrors the TS ``.catch(() => null)`` totality)."""
        try:
            data = client.context(agent=self._agent_name)
            if not isinstance(data, dict):
                return ""
            clients = data.get("clients") or []
            if "hermes" not in clients:
                return ""
            if self._agent_name is not None and not isinstance(data.get("agent"), str):
                return ""
            sections = data.get("sections") or {}
            if not isinstance(sections, dict):
                return ""
            return _render_context_block(sections)
        except Exception as e:
            logger.debug("hicortex context injection failed: %s", e)
            return ""

    def _lessons_block(self, client: HicortexClient) -> str:
        try:
            data = client.lessons()
        except Exception as e:
            logger.debug("hicortex lessons fetch failed: %s", e)
            return ""
        lessons = (data.get("lessons") or [])[:8]
        idx = data.get("index") or {}
        lines = [
            "## Hicortex long-term memory",
            "You have shared long-term memory across sessions. Use `hicortex_search` "
            "for specific recall, `hicortex_get` to fetch one memory by id (e.g. from "
            "the recall index), and `hicortex_recent` for recent memories by project.",
        ]
        if lessons:
            lines.append("Learnings:")
            for l in lessons:
                c = (l.get("content") or "").strip().replace("\n", " ")
                # Legacy lessons were stored with a "## Lesson:" prefix; new ones are
                # topic-first (selected by memory_type, not the prefix). Strip it so
                # Hermes renders the same topic-first line as the CC/OC lessons blocks.
                if c.startswith("## Lesson: "):
                    c = c[len("## Lesson: "):]
                lines.append(f"- {c[:200]}")
        if idx.get("total"):
            lines.append(
                f"({idx.get('total')} memories, {idx.get('lessonCount')} learnings "
                f"across {idx.get('sourceCount')} agents)"
            )
        return "\n".join(lines)

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        return [
            {
                "name": "hicortex_search",
                "description": (
                    "Search long-term memory using semantic similarity. Returns the most "
                    "relevant memories from past sessions."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "Search query text"},
                        "limit": {
                            "type": "number",
                            "description": "Max results (default 5)",
                        },
                        "project": {"type": "string", "description": "Filter by project name"},
                    },
                    "required": ["query"],
                },
            },
            {
                "name": "hicortex_get",
                "description": (
                    "Fetch ONE memory's full content by id — use this to lazy-load "
                    "entries from the recall index or from search results whose "
                    "snippet was not enough. Fetching a memory marks it as used "
                    "(strengthens it), so fetch entries that could change your "
                    "action — not every shown one. When the memory shapes your "
                    "answer, cite it as given in the response — mark a fetched "
                    "memory FETCHED and a one-line entry cited unread SNIPPET; "
                    "don't pass SNIPPET off as established."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "id": {
                            "type": "string",
                            "description": "Memory ID (as shown in the recall index or search results)",
                        },
                    },
                    "required": ["id"],
                },
            },
            {
                "name": "hicortex_recent",
                "description": (
                    "Get recent memories, optionally filtered by project. Queryless recall "
                    "of the latest memories by project, ranked by importance. Useful to "
                    "catch up on what happened recently."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "project": {"type": "string", "description": "Filter by project name"},
                        "limit": {"type": "number", "description": "Max results (default 10)"},
                    },
                },
            },
            {
                "name": "hicortex_ingest",
                "description": (
                    "Store a new memory in long-term storage. "
                    "Use for Knowledge, Decisions, or Learnings."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "content": {"type": "string", "description": "Memory content to store"},
                        "project": {"type": "string", "description": "Project this memory belongs to"},
                        "memory_type": {
                            "type": "string",
                            "enum": ["knowledge", "experience", "decisions", "learnings", "fact", "episode", "decision", "lesson"],
                            "description": "Type of memory (default: experience). Accepted: Knowledge/Experience/Decisions/Learnings (legacy raw enum also accepted, normalized server-side).",
                        },
                    },
                    "required": ["content"],
                },
            },
            {
                "name": "hicortex_lessons",
                "description": (
                    "Get actionable Learnings distilled from past sessions. "
                    "Auto-generated insights about mistakes to avoid."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "project": {"type": "string", "description": "Filter by project name"},
                    },
                },
            },
            {
                "name": "hicortex_index",
                "description": (
                    "Get the knowledge domain index — shows what topics and projects "
                    "are stored in memory, grouped by domain."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {},
                },
            },
            {
                "name": "hicortex_graph",
                "description": (
                    "Query the memory knowledge graph — find connected memories, "
                    "hub nodes, or paths between memories."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "operation": {
                            "type": "string",
                            "enum": ["neighbors", "hubs", "path"],
                            "description": "Graph operation to perform",
                        },
                        "id": {"type": "string", "description": "Memory ID (required for neighbors and path operations)"},
                        "target_id": {"type": "string", "description": "Target memory ID (required for path operation)"},
                        "limit": {"type": "number", "description": "Max results (default 10)"},
                        "domain": {"type": "string", "description": "Filter hubs by domain"},
                        "relationship": {
                            "type": "string",
                            "description": "Filter neighbors by relationship type (e.g., CONTRADICTS, SUPERSEDES, derives)",
                        },
                    },
                    "required": ["operation"],
                },
            },
            {
                "name": "hicortex_update",
                "description": (
                    "Update an existing memory. Use after searching to fix incorrect information. "
                    "If content changes, the embedding is re-computed."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "string", "description": "Memory ID (from search results, first 8 chars or full UUID)"},
                        "content": {"type": "string", "description": "New content text"},
                        "project": {"type": "string", "description": "New project name"},
                        "memory_type": {
                            "type": "string",
                            "enum": ["knowledge", "experience", "decisions", "learnings", "fact", "episode", "decision", "lesson"],
                            "description": "New memory type. Accepted: Knowledge/Experience/Decisions/Learnings (legacy raw enum also accepted, normalized server-side).",
                        },
                    },
                    "required": ["id"],
                },
            },
            {
                "name": "hicortex_delete",
                "description": (
                    "Permanently delete a memory and its links. "
                    "Use when a memory is incorrect and should be removed entirely."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "string", "description": "Memory ID (from search results, first 8 chars or full UUID)"},
                    },
                    "required": ["id"],
                },
            },
        ]

    def handle_tool_call(self, tool_name: str, args: Dict[str, Any], **kwargs) -> str:
        client = self._client_or_none()
        if client is None:
            return json.dumps({"error": "hicortex server not configured"})
        try:
            if tool_name == "hicortex_search":
                hits = client.search(
                    args.get("query", ""),
                    limit=int(args.get("limit", 5)),
                    project=args.get("project") or self._project,
                )
                return json.dumps(hits)

            elif tool_name == "hicortex_get":
                id_val = args.get("id", "")
                if not id_val:
                    return json.dumps({"error": "id is required"})
                # The configured privacy filter rides along (review F1): an
                # out-of-scope memory reads as 404 server-side.
                status, resp = client.get_memory(id_val, privacy=self._privacy)
                if status == 404:
                    # Either no such memory (0.14+) or a pre-0.14 server with
                    # no /memory endpoint — the id hint covers the common case.
                    return json.dumps(
                        {"error": f"Memory not found: {id_val} (or the server predates 0.14)"}
                    )
                if status != 200 or not isinstance(resp, dict):
                    err = resp.get("error") if isinstance(resp, dict) else None
                    return json.dumps({"error": err or f"HTTP {status}"})
                memory = resp.get("memory") or {}
                content = memory.get("content") or ""
                citation = resp.get("citation") or ""
                # Render the content BEHIND the server's citation string — the
                # server-side rendering is the single provenance norm (0.14.1).
                return f"{citation}\n\n{content}".strip()

            elif tool_name == "hicortex_recent":
                hits = client.recent(
                    project=args.get("project") or self._project,
                    limit=int(args.get("limit", 10)),
                )
                return json.dumps(hits)

            elif tool_name == "hicortex_ingest":
                content = args.get("content", "")
                if not content:
                    return json.dumps({"error": "content is required"})
                status, resp = client.ingest(
                    content=content,
                    source_agent="hermes/manual",
                    project=args.get("project") or self._project,
                    memory_type=args.get("memory_type", "experience"),
                )
                if status not in (200, 201):
                    return json.dumps({"error": resp.get("error", f"HTTP {status}")})
                id_val = resp.get("id") or ""
                return json.dumps({"id": id_val, "message": f"Memory stored (id: {id_val[:8]})"})

            elif tool_name == "hicortex_lessons":
                data = client.lessons()
                lessons = (data.get("lessons") or [])
                if not lessons:
                    return json.dumps({"message": "No Learnings found."})
                return json.dumps([{"content": l.get("content", "")[:500]} for l in lessons])

            elif tool_name == "hicortex_index":
                return json.dumps(client.index())

            elif tool_name == "hicortex_graph":
                op = args.get("operation", "")
                result = client.graph(
                    op=op,
                    id=args.get("id"),
                    target_id=args.get("target_id"),
                    limit=args.get("limit"),
                    domain=args.get("domain"),
                    relationship=args.get("relationship"),
                )
                return json.dumps(result)

            elif tool_name == "hicortex_update":
                id_val = args.get("id", "")
                if not id_val:
                    return json.dumps({"error": "id is required"})
                status, resp = client.update(
                    id=id_val,
                    content=args.get("content"),
                    project=args.get("project"),
                    memory_type=args.get("memory_type"),
                )
                if status == 404:
                    return json.dumps({"error": f"Memory not found: {id_val}"})
                if status not in (200, 201):
                    return json.dumps({"error": resp.get("error", f"HTTP {status}")})
                return json.dumps({"updated": True, "id": resp.get("id", id_val)})

            elif tool_name == "hicortex_delete":
                id_val = args.get("id", "")
                if not id_val:
                    return json.dumps({"error": "id is required"})
                status, resp = client.delete(id=id_val)
                if status == 404:
                    return json.dumps({"error": f"Memory not found: {id_val}"})
                if status not in (200, 201):
                    return json.dumps({"error": resp.get("error", f"HTTP {status}")})
                return json.dumps({"deleted": True, "id": resp.get("id", id_val)})

            else:
                return json.dumps({"error": f"unknown tool: {tool_name}"})

        except Exception as e:
            return json.dumps({"error": str(e)})

    # ---------------------------------------------------------------- lifecycle
    def _spawn(self, fn) -> None:
        self._bg_threads = [t for t in self._bg_threads if t.is_alive()]
        t = threading.Thread(target=fn, daemon=True)
        t.start()
        self._bg_threads.append(t)

    def shutdown(self) -> None:
        for t in self._bg_threads:
            t.join(timeout=2.0)

    def get_config_schema(self) -> List[Dict[str, Any]]:
        return CONFIG_SCHEMA

    def get_config(self) -> Dict[str, Any]:
        """Return the live, effective config values (file ← env ← defaults).

        Called by the Hermes dashboard to populate the settings form with
        CURRENT values — not schema defaults. Without this, the form always
        shows localhost regardless of what config.json/.env actually contain
        (#243).

        Secret fields (hicortex_auth_token) are redacted — the dashboard
        should never receive the raw token. If the operator needs to change
        it, they re-type it; save_config handles the write.
        """
        cfg = load_config()
        if cfg.get("hicortex_auth_token"):
            cfg["hicortex_auth_token"] = "***"
        return cfg

    def save_config(self, values: Dict[str, Any], hermes_home: str) -> None:
        from .config import save_config as _save

        _save(values, hermes_home)
