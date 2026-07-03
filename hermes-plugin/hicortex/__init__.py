"""Hicortex memory provider plugin for Hermes — recall-only.

Recall:   prefetch()          -> GET /search   (relevant memories before each turn)
          tools               -> hicortex_search / hicortex_recall_recent
          system_prompt_block -> lessons injected into the system prompt

Capture is NOT the plugin's job. A nightly reader on the Hicortex server
distills each agent's own session store (Hermes: ~/.hermes/profiles/<agent>/
state.db) centrally. The plugin has no local LLM, no spool, no timer, and no
capture path.
"""

from agent.memory_provider import MemoryProvider  # noqa: F401  (loader scans for this name)

from .provider import HicortexProvider

__all__ = ["HicortexProvider"]
