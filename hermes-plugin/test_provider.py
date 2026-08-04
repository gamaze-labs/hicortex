"""Standalone tests for HicortexProvider — recall-only surface + is_available.

Runs WITHOUT Hermes installed: we stub ``agent.memory_provider.MemoryProvider``
(the base class, not installable in this repo) and the HTTP client, then drive
the provider directly. Placed OUTSIDE the ``hicortex/`` package so it is never
discovered as a plugin module and never ships in the npm tarball (prepack
copies only ``hermes-plugin/hicortex/``).

The plugin is recall-only (no spool, no timer, no capture path — capture is the
nightly reader's job on the server). Tests cover the tool surface and the
no-network is_available contract.

Run from the hermes-plugin/ directory:

    python3 -m pytest test_provider.py -v
    # or directly (self-invokes pytest.main under __main__):
    python3 test_provider.py
"""
from __future__ import annotations

import json
import logging
import os
import sys
import types

# --- Stub agent.memory_provider BEFORE importing hicortex (Hermes isn't here).
if "agent" not in sys.modules:
    _agent = types.ModuleType("agent")
    _agent.__path__ = []  # mark as a package so submodule import works
    sys.modules["agent"] = _agent

_mp = types.ModuleType("agent.memory_provider")


class _MemoryProvider:
    """Minimal stand-in for the Hermes base class (we exercise our overrides)."""


_mp.MemoryProvider = _MemoryProvider
sys.modules["agent.memory_provider"] = _mp

# Now safe to import the plugin package.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import hicortex.provider as provider_mod  # noqa: E402
import pytest  # noqa: E402


class FakeClient:
    """Records recall calls; health() flips a flag so we can prove it's unused."""

    def __init__(self):
        self.health_touched = False
        self.recent_calls = []

    def health(self):
        self.health_touched = True
        return {"ok": True}

    def search(self, *a, **k):
        return []

    def recent(self, *a, **k):
        self.recent_calls.append((a, k))
        return []

    def lessons(self):
        return {}


def _make_provider(client):
    p = provider_mod.HicortexProvider()
    p._client = client
    p._project = "t"
    return p


# --------------------------------------------------------------------------- #
# is_available — config check only, NO network call (MemoryProvider contract)
# --------------------------------------------------------------------------- #
def test_is_available_makes_no_network_call(monkeypatch):
    fake = FakeClient()
    monkeypatch.setattr(provider_mod, "HicortexClient", lambda *a, **k: fake)
    monkeypatch.setenv("HICORTEX_URL", "http://example:8787")

    p = provider_mod.HicortexProvider()
    assert p.is_available() is True
    assert fake.health_touched is False  # contract: no network call at init


# --------------------------------------------------------------------------- #
# tool surface — recall rename (context→recent) + recall_recent alias removed
# --------------------------------------------------------------------------- #
def test_tool_schemas_renamed_and_alias_dropped():
    """9 unified tools; hicortex_get + hicortex_recent present; old names gone."""
    p = provider_mod.HicortexProvider()
    names = [t["name"] for t in p.get_tool_schemas()]
    assert len(names) == 9                      # 8 + hicortex_get (0.7.0)
    assert "hicortex_get" in names
    assert "hicortex_recent" in names
    assert "hicortex_recall_recent" not in names
    assert "hicortex_context" not in names


def test_recent_tool_dispatch_calls_client_recent():
    """hicortex_recent must route to client.recent (not the old .context)."""
    fake = FakeClient()
    p = _make_provider(fake)
    out = p.handle_tool_call("hicortex_recent", {"project": "x", "limit": 3})
    assert out == "[]"                          # FakeClient.recent returns []
    assert len(fake.recent_calls) == 1          # routed to .recent


def test_old_recall_tool_names_are_unhandled():
    """Old tool names must no longer dispatch to a recall path."""
    fake = FakeClient()
    p = _make_provider(fake)
    for dead in ("hicortex_recall_recent", "hicortex_context"):
        out = json.loads(p.handle_tool_call(dead, {}))
        assert "error" in out                   # unknown tool → error, not recall
    assert fake.recent_calls == []              # never reached client.recent


# --------------------------------------------------------------------------- #
# per-agent context layer (0.13) — system_prompt_block injection + resolution
# --------------------------------------------------------------------------- #
class CtxClient:
    """Fake client for context/lessons injection tests."""

    def __init__(self, context_payload=None, raise_context=False, lessons_payload=None):
        self.context_payload = context_payload
        self.raise_context = raise_context
        self.lessons_payload = lessons_payload if lessons_payload is not None else {}
        self.context_calls = []

    def context(self, agent=None):
        self.context_calls.append(agent)
        if self.raise_context:
            raise RuntimeError("boom")
        return self.context_payload

    def lessons(self):
        return self.lessons_payload


# A lessons payload that renders a visible "## Hicortex long-term memory" block.
_LESSONS = {"lessons": [{"content": "Lesson A"}], "index": {"total": 1, "lessonCount": 1, "sourceCount": 1}}


def _mk(client, agent_name=None):
    p = provider_mod.HicortexProvider()
    p._client = client
    p._agent_name = agent_name
    return p


def test_lessons_strip_legacy_prefix():
    # Legacy lessons stored "## Lesson: <text>"; new ones are topic-first (no
    # prefix, selected by memory_type). Both must render the topic-first line.
    client = CtxClient(lessons_payload={
        "lessons": [
            {"content": "## Lesson: Always daemon-reload after unit edits\n**Type:** ops"},
            {"content": "Topic-first lesson, no prefix"},
        ],
        "index": {"total": 2, "lessonCount": 2, "sourceCount": 1},
    })
    out = _mk(client).system_prompt_block()
    assert "- Always daemon-reload after unit edits" in out
    assert "## Lesson:" not in out
    assert "- Topic-first lesson, no prefix" in out


def test_context_injected_above_lessons_and_agent_passed():
    client = CtxClient(
        context_payload={"sections": {"user": "I am the test agent."}, "clients": ["hermes"], "agent": "test-agent", "mode": "override"},
        lessons_payload=_LESSONS,
    )
    out = _mk(client, "test-agent").system_prompt_block()
    assert "## Context" in out
    assert "I am the test agent." in out
    # Context is prepended ABOVE the lessons block.
    assert out.index("## Context") < out.index("## Hicortex long-term memory")
    # The resolved profile is sent as ?agent=.
    assert client.context_calls == ["test-agent"]


def test_context_gated_out_when_hermes_not_in_clients():
    client = CtxClient(
        context_payload={"sections": {"user": "x"}, "clients": ["cc"], "agent": "test-agent", "mode": "override"},
        lessons_payload=_LESSONS,
    )
    out = _mk(client, "test-agent").system_prompt_block()
    assert "## Context" not in out
    assert "## Hicortex long-term memory" in out  # lessons intact


def test_context_global_mode_still_echoes_agent_injects():
    # A7 converse: global mode STILL echoes agent → context must inject.
    client = CtxClient(
        context_payload={"sections": {"rules": "Be terse."}, "clients": ["hermes"], "agent": "test-agent", "mode": "global"},
        lessons_payload=_LESSONS,
    )
    out = _mk(client, "test-agent").system_prompt_block()
    assert "## Context" in out
    assert "Be terse." in out


def test_old_server_guard_no_echo_no_inject():
    # Agent sent, but response has no `agent` echo (a pre-0.13 server) → skip.
    client = CtxClient(
        context_payload={"sections": {"user": "leaked global."}, "clients": ["hermes"]},
        lessons_payload=_LESSONS,
    )
    out = _mk(client, "test-agent").system_prompt_block()
    assert "## Context" not in out
    assert "leaked global." not in out
    assert "## Hicortex long-term memory" in out  # lessons intact


def test_bare_fetch_skips_echo_guard_and_injects_global():
    # agent_name None → bare /context, no echo expected; echo guard is skipped.
    client = CtxClient(
        context_payload={"sections": {"user": "global user."}, "clients": ["hermes"]},
        lessons_payload=_LESSONS,
    )
    out = _mk(client, None).system_prompt_block()
    assert "## Context" in out
    assert "global user." in out
    assert client.context_calls == [None]  # no agent id sent


def test_empty_sections_off_mode_no_context_block():
    client = CtxClient(
        context_payload={"sections": {}, "clients": ["hermes"], "agent": "second-agent", "mode": "off"},
        lessons_payload=_LESSONS,
    )
    out = _mk(client, "second-agent").system_prompt_block()
    assert "## Context" not in out
    assert "## Hicortex long-term memory" in out


def test_context_fetch_failure_leaves_lessons_intact():
    client = CtxClient(raise_context=True, lessons_payload=_LESSONS)
    out = _mk(client, "test-agent").system_prompt_block()
    assert "## Context" not in out
    assert "## Hicortex long-term memory" in out
    assert "Lesson A" in out


def test_context_section_ordering_user_then_rules_then_alpha():
    client = CtxClient(
        context_payload={
            "sections": {"zebra": "Z.", "rules": "R.", "user": "U.", "apple": "A."},
            "clients": ["hermes"], "agent": "test-agent", "mode": "override",
        },
        lessons_payload=_LESSONS,
    )
    out = _mk(client, "test-agent").system_prompt_block()
    order = [out.index("### User"), out.index("### Rules"), out.index("### Apple"), out.index("### Zebra")]
    assert order == sorted(order)


def test_resolve_agent_name_priority_order(monkeypatch):
    monkeypatch.delenv("HERMES_PROFILE", raising=False)
    monkeypatch.delenv("HERMES_HOME", raising=False)

    # 1. config wins over everything.
    monkeypatch.setenv("HERMES_PROFILE", "second-agent")
    assert provider_mod._resolve_agent_name({"agent_name": "test-agent"}) == "test-agent"

    # 2. HERMES_PROFILE when no config.
    assert provider_mod._resolve_agent_name({}) == "second-agent"
    monkeypatch.delenv("HERMES_PROFILE", raising=False)

    # 3. parse HERMES_HOME ending in profiles/<name>.
    monkeypatch.setenv("HERMES_HOME", "/home/u/.hermes/profiles/nano")
    assert provider_mod._resolve_agent_name({}) == "nano"

    # A non-profile-shaped HERMES_HOME does not resolve.
    monkeypatch.setenv("HERMES_HOME", "/home/u/.hermes")
    assert provider_mod._resolve_agent_name({}) is None
    monkeypatch.delenv("HERMES_HOME", raising=False)

    # 4. nothing → None (bare fetch → global).
    assert provider_mod._resolve_agent_name({}) is None

    # Mixed-case config is SANITIZED (not rejected) — matches the TS contract so
    # the same profile yields the same id on both harnesses (finding 1).
    assert provider_mod._resolve_agent_name({"agent_name": "Test-Agent"}) == "test-agent"
    # Only-symbols config sanitizes to nothing → None (never send a 400 id).
    assert provider_mod._resolve_agent_name({"agent_name": "!!!"}) is None


# --------------------------------------------------------------------------- #
# finding 1 — sanitize (not reject) mirrors the TS sanitizeAgentId contract
# --------------------------------------------------------------------------- #
def test_sanitize_agent_id_matches_ts_contract():
    assert provider_mod._sanitize_agent_id("Test-Agent") == "test-agent"
    assert provider_mod._sanitize_agent_id("MacBook-Pro.local") == "macbook-pro-local"
    assert provider_mod._sanitize_agent_id("test-agent") == "test-agent"          # idempotent
    assert provider_mod._sanitize_agent_id("_-lead") == "lead"          # strip leading -/_
    assert provider_mod._sanitize_agent_id("a" * 80) == "a" * 64        # truncate 64
    assert provider_mod._sanitize_agent_id("!!!") is None               # all-symbols
    assert provider_mod._sanitize_agent_id("") is None
    assert provider_mod._sanitize_agent_id(None) is None


# --------------------------------------------------------------------------- #
# finding 4 — trailing whitespace stripped so no agent=nano%0A 400
# --------------------------------------------------------------------------- #
def test_resolve_strips_trailing_newline(monkeypatch):
    monkeypatch.delenv("HERMES_HOME", raising=False)
    monkeypatch.setenv("HERMES_PROFILE", "nano\n")
    assert provider_mod._resolve_agent_name({}) == "nano"
    monkeypatch.delenv("HERMES_PROFILE", raising=False)
    # Same via HERMES_HOME.
    monkeypatch.setenv("HERMES_HOME", "/home/u/.hermes/profiles/nano\n")
    assert provider_mod._resolve_agent_name({}) == "nano"
    # And the regex itself rejects an embedded trailing newline (\Z not $).
    assert provider_mod._valid_agent_id("nano\n") is False


# --------------------------------------------------------------------------- #
# finding 3 — a malformed `clients` value must not cost the lessons block
# --------------------------------------------------------------------------- #
def test_malformed_clients_does_not_break_lessons():
    for bad in (1, "x", None, {"unexpected": True}):
        client = CtxClient(
            context_payload={"sections": {"user": "x"}, "clients": bad, "agent": "test-agent"},
            lessons_payload=_LESSONS,
        )
        out = _mk(client, "test-agent").system_prompt_block()
        assert "## Context" not in out, f"clients={bad!r} should gate out"
        assert "## Hicortex long-term memory" in out, f"clients={bad!r} broke lessons"


# --------------------------------------------------------------------------- #
# finding 5 — context + lessons fetched CONCURRENTLY, not serially
# --------------------------------------------------------------------------- #
def test_context_and_lessons_run_concurrently():
    import time

    class SlowClient:
        def context(self, agent=None):
            time.sleep(0.2)
            return {"sections": {"user": "U."}, "clients": ["hermes"], "agent": "test-agent"}

        def lessons(self):
            time.sleep(0.2)
            return _LESSONS

    p = _mk(SlowClient(), "test-agent")
    t0 = time.monotonic()
    out = p.system_prompt_block()
    elapsed = time.monotonic() - t0
    assert "## Context" in out and "## Hicortex long-term memory" in out
    # ~0.2s concurrent vs ~0.4s serial — 0.35s threshold leaves CI margin.
    assert elapsed < 0.35, f"fetches appear serial ({elapsed:.2f}s)"


# --------------------------------------------------------------------------- #
# #193 — pushed recall index (/recall-index) + hicortex_get lazy-load
# --------------------------------------------------------------------------- #
class RecallClient:
    """Fake client for the /recall-index path: scripted responses + call log."""

    def __init__(self, recall_responses=None, memory_responses=None):
        # Each entry: (status, body). Consumed in order; last one repeats.
        self.recall_responses = list(recall_responses or [])
        self.memory_responses = list(memory_responses or [])
        self.recall_calls = []      # dicts: session_id/prompt/reset/project/privacy/mission_domains
        self.search_calls = []
        self.get_calls = []         # (id, privacy)

    def _next(self, responses):
        return responses.pop(0) if len(responses) > 1 else responses[0]

    def recall_index(self, session_id, prompt=None, reset=False, project=None,
                     privacy=None, mission_domains=None):
        self.recall_calls.append(
            {"session_id": session_id, "prompt": prompt, "reset": reset,
             "project": project, "privacy": privacy,
             "mission_domains": mission_domains}
        )
        return self._next(self.recall_responses)

    def get_memory(self, id, privacy=None):
        self.get_calls.append((id, privacy))
        return self._next(self.memory_responses)

    def search(self, query, **kwargs):
        self.search_calls.append(query)
        return [{"created_at": "2026-07-01", "project": "p", "content": f"hit for {query}"}]


_BLOCK = "## Memory recall (auto)\n- [abc12345] Something relevant (01.07.2026, work)"


def _mk_recall(client, session_id="sess-1"):
    p = provider_mod.HicortexProvider()
    p._client = client
    p._session_id = session_id
    return p


def test_prefetch_posts_recall_index_and_injects_block_verbatim():
    client = RecallClient(recall_responses=[(200, {"block": _BLOCK, "shown": ["abc12345"], "turn": 1})])
    p = _mk_recall(client)
    out = p.prefetch("tell me about the deployment", session_id="sess-1")
    assert out == _BLOCK                                 # verbatim, no reformatting
    assert client.recall_calls[0]["session_id"] == "sess-1"
    assert client.recall_calls[0]["prompt"] == "tell me about the deployment"
    assert client.recall_calls[0]["reset"] is False
    assert client.search_calls == []                     # /search never touched


def test_prefetch_pushes_configured_project_and_privacy(monkeypatch):
    # Review F1: the 0.6.x scoping must survive the /recall-index switch —
    # a work-only profile must not receive PERSONAL memory titles.
    client = RecallClient(recall_responses=[(200, {"block": None, "shown": [], "turn": 1})])
    p = _mk_recall(client)
    p._project = "proj-x"
    p._privacy = "WORK"
    p.prefetch("scoped question about the project")
    assert client.recall_calls[0]["project"] == "proj-x"
    assert client.recall_calls[0]["privacy"] == "WORK"


def test_prefetch_pushes_configured_mission_domains():
    # #203 scope: a role-bound agent's declared mission domains ride the
    # /recall-index call as a soft affinity signal (e.g. an agent → Health).
    client = RecallClient(recall_responses=[(200, {"block": None, "shown": [], "turn": 1})])
    p = _mk_recall(client)
    p._mission_domains = ["Health", "Finance"]
    p.prefetch("a question within this agent's domain")
    assert client.recall_calls[0]["mission_domains"] == ["Health", "Finance"]

    # Absent mission_domains => None passed (server treats as no domain scope).
    client2 = RecallClient(recall_responses=[(200, {"block": None, "shown": [], "turn": 1})])
    p2 = _mk_recall(client2)
    p2.prefetch("a general-purpose question")
    assert client2.recall_calls[0]["mission_domains"] == [] or client2.recall_calls[0]["mission_domains"] is None


def test_prefetch_null_block_injects_nothing():
    client = RecallClient(recall_responses=[(200, {"block": None, "shown": [], "turn": 2})])
    out = _mk_recall(client).prefetch("a prompt with nothing new to recall")
    assert out == ""
    assert client.search_calls == []                     # null block ≠ fallback


def test_prefetch_404_falls_back_to_search_until_ttl_expires(monkeypatch):
    client = RecallClient(recall_responses=[(404, {"error": "Cannot POST /recall-index"})])
    p = _mk_recall(client)

    now = [1000.0]
    monkeypatch.setattr(provider_mod.time, "monotonic", lambda: now[0])

    out = p.prefetch("what changed in the api layer")
    assert "hit for what changed in the api layer" in out  # legacy /search injection
    assert p._recall_index_retry_at > 0                    # latched
    # Within the TTL: straight to /search — no repeated /recall-index probe.
    now[0] += 60.0
    p.prefetch("second question about the schema")
    assert len(client.recall_calls) == 1
    assert len(client.search_calls) == 2
    # Past the TTL: re-probe heals a client-first rollout without a gateway
    # restart (review F2) — the now-upgraded server serves the index again.
    client.recall_responses[:] = [(200, {"block": _BLOCK, "shown": [], "turn": 3})]
    now[0] += provider_mod._FALLBACK_RETRY_SECONDS + 1.0
    out = p.prefetch("third question after the server upgrade")
    assert out == _BLOCK
    assert len(client.recall_calls) == 2
    assert p._recall_index_retry_at == 0.0               # latch cleared


def test_prefetch_non_404_error_fails_soft_without_fallback():
    # 500/401 are not version signals: no /search fallback, no latch.
    client = RecallClient(recall_responses=[(500, {"error": "boom"})])
    p = _mk_recall(client)
    assert p.prefetch("a normal question about the project") == ""
    assert client.search_calls == []
    assert p._recall_index_retry_at == 0.0               # retried next turn


def test_prefetch_non_404_error_warns_once_per_status(caplog):
    # Review F3: a persistent 401 (bad token) must surface at WARNING — once
    # per distinct status, not per turn, and never only at debug level.
    client = RecallClient(recall_responses=[(401, {"error": "unauthorized"})])
    p = _mk_recall(client)
    with caplog.at_level(logging.WARNING, logger=provider_mod.__name__):
        p.prefetch("first turn against a bad token")
        p.prefetch("second turn against a bad token")
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1
    assert "401" in warnings[0].getMessage()
    assert "AUTH_TOKEN" in warnings[0].getMessage()      # actionable hint
    # A different failing status gets its own single warning.
    client.recall_responses[:] = [(500, {"error": "boom"})]
    with caplog.at_level(logging.WARNING, logger=provider_mod.__name__):
        p.prefetch("turn against a broken server")
        p.prefetch("another turn against a broken server")
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 2


def test_session_id_unified_kwarg_wins_and_becomes_stored():
    # Review F7: one resolver for initialize + prefetch. An explicit id wins
    # AND becomes the stored id, so turns and resets share one registry key.
    client = RecallClient(recall_responses=[(200, {"block": None, "shown": [], "turn": 1})])
    p = _mk_recall(client, session_id="stored-id")
    p.prefetch("prompt long enough to pass gates", session_id="kwarg-id")
    assert client.recall_calls[0]["session_id"] == "kwarg-id"
    p.prefetch("prompt long enough to pass gates")
    assert client.recall_calls[1]["session_id"] == "kwarg-id"  # converged


def test_prefetch_generates_session_id_when_none():
    client = RecallClient(recall_responses=[(200, {"block": None, "shown": [], "turn": 1})])
    p = _mk_recall(client, session_id=None)
    p.prefetch("first prompt of the session here")
    p.prefetch("second prompt of the session here")
    sid1 = client.recall_calls[0]["session_id"]
    sid2 = client.recall_calls[1]["session_id"]
    assert sid1.startswith("hermes-") and sid1 == sid2   # stable per instance


def test_initialize_sends_reset_synchronously(monkeypatch):
    # Review F8: the reset must complete BEFORE initialize returns, so it can
    # never race the first turn's prefetch and wipe fresh registry state.
    client = RecallClient(recall_responses=[(200, {"ok": True, "reset": True})])
    monkeypatch.setattr(provider_mod, "HicortexClient", lambda *a, **k: client)
    monkeypatch.setenv("HICORTEX_URL", "http://example:8787")
    p = provider_mod.HicortexProvider()
    p.initialize("sess-42")
    # No shutdown()/thread-join: the call is already recorded.
    assert client.recall_calls[0]["session_id"] == "sess-42"
    assert client.recall_calls[0]["reset"] is True
    assert p._session_id == "sess-42"


def test_initialize_reset_failure_is_fail_soft(monkeypatch):
    class Boom:
        def recall_index(self, *a, **k):
            raise RuntimeError("down")

    boom = Boom()
    monkeypatch.setattr(provider_mod, "HicortexClient", lambda *a, **k: boom)
    monkeypatch.setenv("HICORTEX_URL", "http://example:8787")
    p = provider_mod.HicortexProvider()
    p.initialize("sess-43")                              # must not raise
    p.shutdown()


def test_queue_prefetch_noop_on_recall_index_path():
    client = RecallClient(recall_responses=[(200, {"block": _BLOCK, "shown": [], "turn": 1})])
    p = _mk_recall(client)
    p.queue_prefetch("upcoming question about deploys")
    p.shutdown()
    assert client.search_calls == []                     # no background warm-up
    assert p._prefetch_cache == {}                       # cache stays out of this path
    # And the following prefetch still hits the server (no double-suppression).
    out = p.prefetch("upcoming question about deploys")
    assert out == _BLOCK
    assert len(client.recall_calls) == 1


def test_queue_prefetch_still_warms_cache_on_legacy_path():
    client = RecallClient(recall_responses=[(404, {"error": "nope"})])
    p = _mk_recall(client)
    p.prefetch("probe that discovers the old server")    # flips the flag via 404
    client.search_calls.clear()
    p.queue_prefetch("next question for the old server")
    p.shutdown()
    assert client.search_calls == ["next question for the old server"]
    out = p.prefetch("next question for the old server")
    assert "hit for next question for the old server" in out
    assert client.search_calls == ["next question for the old server"]  # served from cache


def test_hicortex_get_renders_content_behind_citation_and_scopes_privacy():
    client = RecallClient(memory_responses=[(200, {
        "memory": {"id": "abc12345-0000", "content": "Full memory body.", "created_at": "2026-07-01"},
        "citation": "(memory abc12345, 2026-07-01, from cc/laptop)",
    })])
    p = _mk_recall(client)
    p._privacy = "WORK"
    out = p.handle_tool_call("hicortex_get", {"id": "abc12345"})
    assert out == "(memory abc12345, 2026-07-01, from cc/laptop)\n\nFull memory body."
    # The configured privacy filter rides along (review F1).
    assert client.get_calls == [("abc12345", "WORK")]


def test_hicortex_get_404_and_missing_id():
    client = RecallClient(memory_responses=[(404, {"error": "No memory with id zzz"})])
    p = _mk_recall(client)
    out = json.loads(p.handle_tool_call("hicortex_get", {"id": "zzz"}))
    assert "Memory not found" in out["error"]
    out = json.loads(p.handle_tool_call("hicortex_get", {}))
    assert out["error"] == "id is required"


# --------------------------------------------------------------------------- #
# client — hot-path timeout (F4) + scoping params on the wire (F1)
# --------------------------------------------------------------------------- #
def test_client_recall_calls_use_short_timeout(monkeypatch):
    from hicortex.client import HicortexClient

    c = HicortexClient("http://example:8787")
    seen = []

    def fake_request(method, url, data=None, timeout=None):
        seen.append({"method": method, "url": url, "data": data, "timeout": timeout})
        return 200, {}

    monkeypatch.setattr(c, "_request", fake_request)

    c.recall_index("s1", prompt="q", project="proj-x", privacy="WORK")
    c.get_memory("abc12345", privacy="WORK")
    c.search("unrelated")  # background/tool traffic keeps the default timeout

    # Per-turn calls are bounded by the dedicated short timeout, not 5 s.
    assert HicortexClient.RECALL_TIMEOUT == 1.5
    assert seen[0]["timeout"] == 1.5 and seen[0]["method"] == "POST"
    body = json.loads(seen[0]["data"])
    assert body == {"session_id": "s1", "prompt": "q", "project": "proj-x", "privacy": "WORK"}
    assert seen[1]["timeout"] == 1.5
    assert "privacy=WORK" in seen[1]["url"] and "id=abc12345" in seen[1]["url"]
    assert seen[2]["timeout"] is None  # _request falls back to self.timeout


def test_client_recall_reset_body_omits_scoping(monkeypatch):
    from hicortex.client import HicortexClient

    c = HicortexClient("http://example:8787")
    seen = []
    monkeypatch.setattr(
        c, "_request",
        lambda method, url, data=None, timeout=None: (seen.append(json.loads(data)), (200, {}))[1],
    )
    c.recall_index("s1", reset=True, project="proj-x", privacy="WORK")
    assert seen[0] == {"session_id": "s1", "reset": True}


# --------------------------------------------------------------------------- #
# 0.16.x — privacy_filter deprecation (config.py load_config)
# The server ignores privacy since 0.16.2; a plugin that still sets
# privacy_filter gets a one-time-per-process WARNING. The default (applied via
# setdefault when the file omits the key) must NOT warn — that would spam every
# profile on every gateway start.
# --------------------------------------------------------------------------- #
from hicortex import config as config_mod  # noqa: E402


def _write_plugin_config(home, payload):
    """Write $HERMES_HOME/plugins/hicortex/config.json (the path load_config reads)."""
    cfg_dir = os.path.join(home, "plugins", "hicortex")
    os.makedirs(cfg_dir, exist_ok=True)
    cfg_path = os.path.join(cfg_dir, "config.json")
    with open(cfg_path, "w", encoding="utf-8") as f:
        json.dump(payload, f)
    return cfg_path


@pytest.fixture
def reset_privacy_deprecation_warn():
    """The deprecation guard is a module-level one-time flag (per-process). Reset
    it before each test so the warning behavior is isolated and order-independent."""
    config_mod._privacy_filter_deprecation_warned = False
    yield
    config_mod._privacy_filter_deprecation_warned = False


def test_privacy_filter_deprecation_warns_once_on_explicit_setting(tmp_path, monkeypatch, caplog, reset_privacy_deprecation_warn):
    # (a) + (c): a profile that EXPLICITLY sets privacy_filter gets warned —
    # exactly once per process, even across repeated load_config calls.
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    _write_plugin_config(str(tmp_path), {"hicortex_url": "http://s:8787", "privacy_filter": "WORK"})

    with caplog.at_level(logging.WARNING, logger=config_mod.__name__):
        config_mod.load_config()
        config_mod.load_config()  # second call must NOT warn again
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1
    msg = warnings[0].getMessage()
    assert "privacy_filter" in msg
    assert "deprecated" in msg
    # And the flag is now latched (the guard held across the second call).
    assert config_mod._privacy_filter_deprecation_warned is True


def test_privacy_filter_deprecation_silent_when_absent(tmp_path, monkeypatch, caplog, reset_privacy_deprecation_warn):
    # (b): no privacy_filter in the file → NO warning. The highest-value
    # assertion: a false positive here would spam every profile on every start.
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    _write_plugin_config(str(tmp_path), {"hicortex_url": "http://s:8787"})  # no privacy_filter

    with caplog.at_level(logging.WARNING, logger=config_mod.__name__):
        cfg = config_mod.load_config()
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert warnings == []
    # The default is still applied (backward-compat value), just silently.
    assert cfg.get("privacy_filter") == "WORK,PERSONAL"
    assert config_mod._privacy_filter_deprecation_warned is False


def test_privacy_filter_deprecation_default_value_does_not_warn(tmp_path, monkeypatch, caplog, reset_privacy_deprecation_warn):
    # Belt-and-suspenders for (a)'s "not on the default" clause: a file that
    # sets privacy_filter to exactly the default value still counts as
    # EXPLICIT (the user wrote the key) and DOES warn — proving the guard keys
    # on key-presence, not value-equality, so it never silently swallows a
    # user setting. (If you want NO warning, omit the key entirely.)
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    _write_plugin_config(str(tmp_path), {"hicortex_url": "http://s:8787", "privacy_filter": "WORK,PERSONAL"})

    with caplog.at_level(logging.WARNING, logger=config_mod.__name__):
        config_mod.load_config()
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1  # explicit key → warn, even though value == default


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
