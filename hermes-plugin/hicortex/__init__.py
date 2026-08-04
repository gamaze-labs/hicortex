"""Hicortex memory provider plugin for Hermes — recall-only.

Recall:   prefetch()          -> POST /recall-index (pushed recall index; falls
                                 back to GET /search on a pre-0.14 server)
          tools               -> hicortex_search / hicortex_get / hicortex_recent / …
          system_prompt_block -> lessons injected into the system prompt

Capture is NOT the plugin's job. A nightly reader on the Hicortex server
distills each agent's own session store (Hermes: ~/.hermes/profiles/<agent>/
state.db) centrally. The plugin has no local LLM, no spool, no timer, and no
capture path.
"""

from agent.memory_provider import MemoryProvider  # noqa: F401  (loader scans for this name)

from .provider import HicortexProvider

__all__ = ["HicortexProvider"]
