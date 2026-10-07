"""Thin HTTP client for the Hicortex memory server.

Stdlib-only (no pip dependencies) so the plugin installs with zero friction.
"""

from __future__ import annotations

import json
import logging
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Optional, Tuple

logger = logging.getLogger(__name__)

# One-shot-per-process guard for the cleartext-transport warning. Clients are
# rebuilt per provider/config read; warning per construction would spam the
# gateway log on every rebuild.
_cleartext_warned = False


def _origin(url: str) -> Tuple[Optional[str], Optional[int]]:
    """(host, port) origin of a URL, default-port-normalized (http→80,
    https→443) and lower-cased — the identity a redirect must preserve for the
    Authorization header to be safe to keep. Unparseable URLs never compare
    equal, so they fail CLOSED (token stripped)."""
    try:
        parsed = urllib.parse.urlparse(url)
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        return (parsed.hostname or "").lower(), port
    except ValueError:
        return (url, None)


class _AuthStrippingRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Strip ``Authorization`` on any redirect that leaves the original origin.

    urllib's default redirect handler forwards the request's headers to the
    redirect target (only content headers — length/type/encoding — are
    dropped), so a cross-host 302 hands the bearer token to whoever answers
    the redirect. Same-origin redirects (path changes, trailing-slash fixes)
    keep authenticating as before."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        new_req = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new_req is not None and _origin(req.full_url) != _origin(newurl):
            # Request headers are Capitalized by add_header ("Authorization").
            new_req.headers.pop("Authorization", None)
            new_req.unredirected_hdrs.pop("Authorization", None)
        return new_req


# Shared opener: urllib's defaults plus the auth-stripping redirect handler.
# `urlopen` cannot be used for this — it goes through the process-global
# default opener, which we must not reconfigure from inside a plugin.
_OPENER = urllib.request.build_opener(_AuthStrippingRedirectHandler)


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
        # Cleartext transport warning (catalog review 130093): a plain http://
        # URL to a non-loopback host while a token is set means the token AND
        # every prompt sent for recall cross the network unencrypted. WARN,
        # never reject — plain http on a trusted private network (overlay
        # networks, private overlay meshes) is a legitimate setup.
        if self.auth_token and urllib.parse.urlparse(self.base_url).scheme != "https":
            global _cleartext_warned
            if not _cleartext_warned:
                _cleartext_warned = True
                logger.warning(
                    "hicortex: %s uses plain http:// on a non-loopback host "
                    "while an auth token is set — the token and every prompt "
                    "sent for recall cross the network in cleartext. Use "
                    "https://, or keep the server on a trusted private "
                    "network. (This warning fires once per process.)",
                    self.base_url,
                )
        self.timeout = timeout

    def _headers(self) -> dict[str, str]:
        h = {"Content-Type": "application/json", "Accept": "application/json"}
        if self.auth_token:
            h["Authorization"] = f"Bearer {self.auth_token}"
        return h

    def _build_url(self, path: str, params: Optional[dict[str, Any]] = None) -> str:
        url = f"{self.base_url}{path}"
        if params:
            qs = urllib.parse.urlencode(
                {k: v for k, v in params.items() if v is not None}
            )
            if qs:
                url = f"{url}?{qs}"
        return url

    @staticmethod
    def _parse_http_error(e: urllib.error.HTTPError) -> Any:
        """Parse an HTTPError body: JSON when possible, else {'error': text}."""
        body_bytes = e.read()
        try:
            return json.loads(body_bytes.decode("utf-8"))
        except Exception:
            return {"error": body_bytes.decode("utf-8", errors="replace")}

    def _request(
        self,
        method: str,
        url: str,
        data: Optional[bytes] = None,
        timeout: Optional[float] = None,
    ) -> tuple[int, Any]:
        """Perform a request; returns (status_code, parsed_response) with HTTP
        errors converted to statuses (never raised)."""
        req = urllib.request.Request(url, data=data, headers=self._headers(), method=method)
        try:
            with _OPENER.open(req, timeout=timeout or self.timeout) as resp:
                return resp.status, json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            return e.code, self._parse_http_error(e)

    def _get(self, path: str, params: Optional[dict[str, Any]] = None) -> Any:
        status, parsed = self._get_with_status(path, params)
        if status >= 400:
            err = parsed.get("error") if isinstance(parsed, dict) else None
            raise RuntimeError(f"HTTP {status}: {err or 'request failed'}")
        return parsed

    def _post(
        self,
        path: str,
        body: dict[str, Any],
        timeout: Optional[float] = None,
    ) -> tuple[int, Any]:
        """POST JSON body; returns (status_code, parsed_response)."""
        return self._request(
            "POST", self._build_url(path), json.dumps(body).encode("utf-8"), timeout
        )

    def _get_with_status(
        self,
        path: str,
        params: Optional[dict[str, Any]] = None,
        timeout: Optional[float] = None,
    ) -> tuple[int, Any]:
        """GET returning (status_code, parsed_response) — unlike ``_get``, an
        HTTP error is returned as a status, not raised. Needed where the caller
        must tell a 404 apart from other failures (old-server guards)."""
        return self._request("GET", self._build_url(path, params), None, timeout)

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

    def recent(
        self,
        project: Optional[str] = None,
        limit: int = 10,
        privacy: Optional[str] = None,
    ) -> list[dict]:
        return self._get(
            "/recent", {"project": project, "limit": limit, "privacy": privacy}
        ).get("results", [])

    def lessons(self) -> dict[str, Any]:
        return self._get("/lessons")

    def context(self, agent: Optional[str] = None) -> dict[str, Any]:
        """Standing context layer (L2). When ``agent`` is set, the server
        resolves the per-agent scope and echoes ``agent``/``mode`` (0.13); a
        pre-0.13 server ignores the param and returns the global set with no
        echo — the caller uses that echo as an old-server guard."""
        return self._get("/context", {"agent": agent})

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
        memory_type: str = "experience",
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

    # Per-turn hot path (F4): /recall-index runs synchronously inside every
    # prefetch and /memory inside an agent tool call — a slow/wedged server
    # must cost at most this much per turn, NOT the general default timeout
    # (5 s) meant for background/tool traffic.
    RECALL_TIMEOUT: float = 1.5

    def recall_index(
        self,
        session_id: str,
        prompt: Optional[str] = None,
        reset: bool = False,
        project: Optional[str] = None,
        privacy: Optional[str] = None,
        mission_domains: Optional[list[str]] = None,
    ) -> tuple[int, dict[str, Any]]:
        """Pushed recall index (0.14). ``prompt`` → ``{block, shown, turn}``
        where ``block`` is None when nothing is new/relevant; ``reset=True``
        clears the session's server-side dedup (context rebuilt). ``project``,
        ``privacy`` (CSV accepted server-side), and ``mission_domains`` (list)
        scope the recall — all SOFT on a 0.16+ server (affinity boosts, never
        hard filters); ``project``/``privacy`` stay hard on older servers.
        Returns the status so the caller can old-server-guard on 404."""
        body: dict[str, Any] = {"session_id": session_id}
        if reset:
            body["reset"] = True
        else:
            body["prompt"] = prompt or ""
            if project:
                body["project"] = project
            if privacy:
                body["privacy"] = privacy
            if mission_domains:
                body["mission_domains"] = mission_domains
        return self._post("/recall-index", body, timeout=self.RECALL_TIMEOUT)

    def get_memory(
        self, id: str, privacy: Optional[str] = None
    ) -> tuple[int, dict[str, Any]]:
        """Fetch ONE memory's full content (lazy-load counterpart of the recall
        index). The server marks it as USED (access_count + 1) and returns
        ``{memory, citation}`` — citation is server-rendered so every harness
        surfaces the same provenance norm. ``privacy`` (CSV) makes an
        out-of-scope memory read as 404 (the server never reveals existence)."""
        return self._get_with_status(
            "/memory", {"id": id, "privacy": privacy}, timeout=self.RECALL_TIMEOUT
        )
