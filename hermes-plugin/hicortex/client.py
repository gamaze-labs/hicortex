"""Thin HTTP client for the Hicortex memory server.

Stdlib-only (no pip dependencies) so the plugin installs with zero friction.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Optional


class HicortexClient:
    """Stateless HTTP client for the Hicortex REST surface."""

    def __init__(
        self,
        base_url: str,
        auth_token: Optional[str] = None,
        timeout: float = 5.0,
    ):
        self.base_url = base_url.rstrip("/")
        # Omit the token when targeting localhost — the server bypasses auth there.
        # Match the server's bypass list exactly (mcp-server.ts): IPv4, IPv6,
        # and IPv4-mapped-IPv6 (which Node reports for v4 clients on a 0.0.0.0 bind).
        host = urllib.parse.urlparse(self.base_url).hostname or ""
        self.auth_token = (
            None
            if host in ("127.0.0.1", "localhost", "::1", "::ffff:127.0.0.1")
            else auth_token
        )
        self.timeout = timeout

    def _headers(self) -> dict[str, str]:
        h = {"Content-Type": "application/json", "Accept": "application/json"}
        if self.auth_token:
            h["Authorization"] = f"Bearer {self.auth_token}"
        return h

    def _get(self, path: str, params: Optional[dict[str, Any]] = None) -> Any:
        url = f"{self.base_url}{path}"
        if params:
            qs = urllib.parse.urlencode(
                {k: v for k, v in params.items() if v is not None}
            )
            url = f"{url}?{qs}"
        req = urllib.request.Request(url, headers=self._headers(), method="GET")
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def _post(self, path: str, body: dict[str, Any]) -> tuple[int, Any]:
        """POST JSON body; returns (status_code, parsed_response)."""
        url = f"{self.base_url}{path}"
        data = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers=self._headers(), method="POST")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return resp.status, json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            body_bytes = e.read()
            try:
                parsed = json.loads(body_bytes.decode("utf-8"))
            except Exception:
                parsed = {"error": body_bytes.decode("utf-8", errors="replace")}
            return e.code, parsed

    # -- endpoints ------------------------------------------------------------

    def health(self) -> dict[str, Any]:
        return self._get("/health")

    def search(
        self,
        query: str,
        limit: int = 5,
        project: Optional[str] = None,
        privacy: Optional[str] = None,
    ) -> list[dict]:
        return self._get(
            "/search",
            {"query": query, "limit": limit, "project": project, "privacy": privacy},
        ).get("results", [])

    def context(
        self,
        project: Optional[str] = None,
        limit: int = 10,
        privacy: Optional[str] = None,
    ) -> list[dict]:
        return self._get(
            "/context", {"project": project, "limit": limit, "privacy": privacy}
        ).get("results", [])

    def lessons(self) -> dict[str, Any]:
        return self._get("/lessons")

    def index(self) -> dict[str, Any]:
        return self._get("/index")

    def graph(
        self,
        op: str,
        id: Optional[str] = None,
        target_id: Optional[str] = None,
        limit: Optional[int] = None,
        domain: Optional[str] = None,
        relationship: Optional[str] = None,
    ) -> dict[str, Any]:
        return self._get(
            "/graph",
            {
                "op": op,
                "id": id,
                "target_id": target_id,
                "limit": limit,
                "domain": domain,
                "relationship": relationship,
            },
        )

    def ingest(
        self,
        content: str,
        source_agent: Optional[str] = None,
        project: Optional[str] = None,
        memory_type: str = "episode",
        privacy: str = "WORK",
    ) -> tuple[int, dict[str, Any]]:
        return self._post(
            "/ingest",
            {
                "content": content,
                "source_agent": source_agent or "hermes/manual",
                "project": project,
                "memory_type": memory_type,
                "privacy": privacy,
            },
        )

    def update(
        self,
        id: str,
        content: Optional[str] = None,
        project: Optional[str] = None,
        memory_type: Optional[str] = None,
        privacy: Optional[str] = None,
    ) -> tuple[int, dict[str, Any]]:
        body: dict[str, Any] = {"id": id}
        if content is not None:
            body["content"] = content
        if project is not None:
            body["project"] = project
        if memory_type is not None:
            body["memory_type"] = memory_type
        if privacy is not None:
            body["privacy"] = privacy
        return self._post("/update", body)

    def delete(self, id: str) -> tuple[int, dict[str, Any]]:
        return self._post("/delete", {"id": id})
