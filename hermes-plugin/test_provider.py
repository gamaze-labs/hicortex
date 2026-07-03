"""Standalone tests for HicortexProvider — session-switch salvage + is_available.

Runs WITHOUT Hermes installed: we stub ``agent.memory_provider.MemoryProvider``
(the base class, not installable in this repo) and the HTTP client, then drive
the provider's spool/flush logic directly. Placed OUTSIDE the ``hicortex/``
package so it is never discovered as a plugin module and never ships in the npm
tarball (prepack copies only ``hermes-plugin/hicortex/``).

Run from the hermes-plugin/ directory:

    .venv/bin/python -m pytest test_provider.py -v
"""
from __future__ import annotations

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

# _MIN_CONTENT_CHARS in provider.py — flush is a no-op below this.
_BLOB = "x" * 250


class FakeClient:
    """Records /distill calls; health() flips a flag so we can prove it's unused."""

    def __init__(self):
        self.calls = []
        self.health_touched = False

    def health(self):
        self.health_touched = True
        return {"ok": True}

    def distill(self, messages, *, source_agent=None, project=None,
                session_id=None, segment_id=None, timeout=None):
        self.calls.append(
            {"session_id": session_id, "segment_id": segment_id, "n": len(messages)}
        )
        return {"distilled": 1}

    def search(self, *a, **k):
        return []

    def context(self, *a, **k):
        return []

    def lessons(self):
        return {}


def _make_provider(tmp_path, client=None):
    """A provider wired for testing: spool dir set, client injected."""
    p = provider_mod.HicortexProvider()
    p._spool_dir = str(tmp_path)
    p._client = client or FakeClient()
    p._source_agent = "hermes/test"
    p._project = "t"
    return p


def _spool_pending(provider, sid, n_turns=3):
    """Write n_turns of >_MIN_CONTENT_CHARS turns into sid's spool so _flush distills."""
    for t in range(1, n_turns + 1):
        provider._append_spool(sid, t, _BLOB, _BLOB)
    return provider._spool_path(sid)


# --------------------------------------------------------------------------- #
# on_session_switch — the compaction-adjacent salvage path
# --------------------------------------------------------------------------- #
def test_switch_salvages_old_session(tmp_path):
    """Pending content in A must be flushed when we rotate away to B."""
    p = _make_provider(tmp_path)
    p._session_id = "A"
    _spool_pending(p, "A", n_turns=3)
    assert p._client.calls == []  # nothing distilled yet

    p.on_session_switch("B", reset=True)

    assert p._session_id == "B"           # switch is immediate
    p.shutdown()                          # join the background salvage flush
    assert len(p._client.calls) == 1
    assert p._client.calls[0]["session_id"] == "A"
    # Watermark advanced past everything spooled for A → nothing pending.
    assert p._read_spool_since("A", p._read_watermark("A")) == []


def test_switch_same_session_does_not_salvage(tmp_path):
    """rewound (new id == old id) must not spawn a redundant salvage flush."""
    p = _make_provider(tmp_path)
    p._session_id = "A"
    _spool_pending(p, "A", n_turns=2)

    p.on_session_switch("A", reset=False, rewound=True)  # same id

    # No background thread was spawned (old_sid == new_session_id), so nothing is
    # in flight and no distill can have happened. We deliberately do NOT call
    # shutdown() here: its teardown flush of the *current* session would distill
    # A and conflate with the switch behavior under test.
    assert p._client.calls == []          # nothing flushed — session continues
    assert p._session_id == "A"
    assert p._read_spool_since("A", 0) != []  # pending content left untouched


def test_switch_then_pre_compress_no_double_distill(tmp_path):
    """Switch salvages A; a later pre_compress (now on B) must not re-distill A."""
    p = _make_provider(tmp_path)
    p._session_id = "A"
    _spool_pending(p, "A", n_turns=3)

    p.on_session_switch("B", reset=False, parent_session_id="A")  # compression
    p.on_pre_compress(messages=[])  # self._session_id is now B (empty spool)
    p.shutdown()

    assert len(p._client.calls) == 1
    assert p._client.calls[0]["session_id"] == "A"


def test_switch_to_empty_session_then_turns_go_to_new_id(tmp_path):
    """After switching to B, new capture lands in B's spool, not A's."""
    p = _make_provider(tmp_path)
    p._session_id = "A"
    p.on_turn_start(1, "hi")
    p.sync_turn("hi A", "resp A")  # tiny — below threshold, just spooled
    p.on_session_switch("B", reset=True)
    p.shutdown()  # A's tiny turn (<_MIN_CONTENT_CHARS) won't distill — that's fine

    # New turn under B routes to B's spool.
    p.on_turn_start(1, "hi")
    p.sync_turn("hi B", "resp B")
    assert os.path.exists(p._spool_path("B"))
    entries_b = p._read_spool_since("B", 0)
    assert any("hi B" in e["content"] for e in entries_b)


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


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
