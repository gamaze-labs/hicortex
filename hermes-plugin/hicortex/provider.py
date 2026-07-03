"""Hicortex MemoryProvider for Hermes — recall-only.

Recall:   prefetch()          -> GET /search   (relevant memories before each turn)
          queue_prefetch()    -> GET /search   (background recall for the next turn)
          tools               -> hicortex_search / hicortex_recall_recent
          system_prompt_block -> lessons + memory index injected into the prompt

Capture is NOT the plugin's job. A nightly reader on the Hicortex server
distills each agent's own session store (Hermes: ~/.hermes/profiles/<agent>/
state.db) centrally — see specs/2026-07-01-memory-capture-architecture.md. This
plugin has no local LLM, no spool, no timer, and no capture path.
"""

from __future__ import annotations

import hashlib
import json
import logging
import threading
from typing import Any, Dict, List, Optional

from agent.memory_provider import MemoryProvider

from .client import HicortexClient
from .config import CONFIG_SCHEMA, load_config

logger = logging.getLogger(__name__)

_INJECT_CONTENT_CAP = 500


class HicortexProvider(MemoryProvider):
    """Hicortex long-term memory backend for Hermes (recall-only)."""

    def __init__(self):
        self._client: Optional[HicortexClient] = None
        self._project: Optional[str] = None
        self._recall_limit: int = 5
        self._privacy: Optional[str] = "WORK,PERSONAL"
        self._prefetch_cache: Dict[str, str] = {}
        self._bg_threads: List[threading.Thread] = []

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
        try:
            self._client = self._build_client()
        except Exception as e:
            logger.warning("hicortex: init client build failed: %s", e)

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

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        key = hashlib.sha1(query.encode("utf-8")).hexdigest()
        cached = self._prefetch_cache.pop(key, None)
        if cached is not None:
            return cached
        client = self._client_or_none()
        if client is None:
            return ""
        try:
            hits = client.search(
                query, limit=self._recall_limit, project=self._project, privacy=self._privacy
            )
            return self._format_hits(hits)
        except Exception as e:
            logger.debug("hicortex prefetch failed: %s", e)
            return ""

    def queue_prefetch(self, query: str, *, session_id: str = "") -> None:
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
            "for specific recall and `hicortex_recall_recent` for recent context.",
        ]
        if lessons:
            lines.append("Lessons:")
            for l in lessons:
                c = (l.get("content") or "").strip().replace("\n", " ")
                lines.append(f"- {c[:200]}")
        if idx.get("total"):
            lines.append(
                f"({idx.get('total')} memories, {idx.get('lessonCount')} lessons "
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
                "name": "hicortex_recall_recent",
                "description": "Recall recent context memories, optionally filtered by project.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "project": {"type": "string"},
                        "limit": {
                            "type": "number",
                            "description": "Max results (default 10)",
                        },
                    },
                },
            },
            {
                "name": "hicortex_context",
                "description": (
                    "Get recent context memories, optionally filtered by project. "
                    "Useful to recall what happened recently."
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
                    "Use for important facts, decisions, or lessons."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "content": {"type": "string", "description": "Memory content to store"},
                        "project": {"type": "string", "description": "Project this memory belongs to"},
                        "memory_type": {
                            "type": "string",
                            "enum": ["episode", "lesson", "fact", "decision"],
                            "description": "Type of memory (default: episode)",
                        },
                    },
                    "required": ["content"],
                },
            },
            {
                "name": "hicortex_lessons",
                "description": (
                    "Get actionable lessons learned from past sessions. "
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
                            "enum": ["episode", "lesson", "fact", "decision"],
                            "description": "New memory type",
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

            elif tool_name in ("hicortex_recall_recent", "hicortex_context"):
                hits = client.context(
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
                    memory_type=args.get("memory_type", "episode"),
                )
                if status not in (200, 201):
                    return json.dumps({"error": resp.get("error", f"HTTP {status}")})
                id_val = resp.get("id") or ""
                return json.dumps({"id": id_val, "message": f"Memory stored (id: {id_val[:8]})"})

            elif tool_name == "hicortex_lessons":
                data = client.lessons()
                lessons = (data.get("lessons") or [])
                if not lessons:
                    return json.dumps({"message": "No lessons found."})
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

    def save_config(self, values: Dict[str, Any], hermes_home: str) -> None:
        from .config import save_config as _save

        _save(values, hermes_home)
