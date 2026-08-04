"""Config schema + load/save for the Hicortex Hermes plugin.

Config lives at ``$HERMES_HOME/plugins/hicortex/config.json``. Environment
variables (``HICORTEX_URL``, ``HICORTEX_AUTH_TOKEN``) override the file, so the
plugin also works with env-only setup.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

# One-time-per-process guard for the privacy_filter deprecation warning.
_privacy_filter_deprecation_warned = False

# Declarative config schema — drives `hermes memory setup` (see MemoryProvider
# .get_config_schema). Field shape per the Hermes MemoryProvider contract:
# key, label, description, default, required, secret, env_var, choices, url.
CONFIG_SCHEMA: list[dict[str, Any]] = [
    {
        "key": "hicortex_url",
        "label": "Hicortex server URL",
        "description": (
            "URL of the Hicortex memory server. On the server host use "
            "http://localhost:8787; on other machines use the server's "
            "private hostname, e.g. http://memory-server:8787."
        ),
        "default": "http://localhost:8787",
        "required": True,
    },
    {
        "key": "hicortex_auth_token",
        "label": "Auth token",
        "description": (
            "Bearer token for the server. Omit (leave blank) when targeting "
            "localhost — the server bypasses auth there. Default token: "
            "hctx-default-token."
        ),
        "secret": True,
        "env_var": "HICORTEX_AUTH_TOKEN",
    },
    {
        "key": "default_project",
        "label": "Default project",
        "description": "Optional project name to scope recall and capture.",
        "required": False,
    },
    {
        "key": "recall_limit",
        "label": "Recall limit",
        "description": (
            "Max memories returned per recall (default 5). Applies to the "
            "tools and the legacy pre-0.14 /search prefetch fallback only — "
            "the pushed recall index is sized by SERVER config (recallMaxItems)."
        ),
        "default": "5",
        "required": False,
    },
    {
        "key": "privacy_filter",
        "label": "Privacy filter (DEPRECATED)",
        "description": (
            "DEPRECATED since plugin 0.7.2 / server 0.16.2. The server no "
            "longer filters on privacy — the column is vestigial. This setting "
            "is now a harmless no-op: it is still accepted for backward "
            "compat but ignored. For work/personal isolation, run a separate "
            "Hicortex server per scope. (Historically: comma-separated privacy "
            "levels to include, e.g. WORK,PERSONAL.)"
        ),
        "default": "WORK,PERSONAL",
        "required": False,
    },
    {
        "key": "agent_name",
        "label": "Agent name (per-agent context)",
        "description": (
            "Identity sent as ?agent= when fetching the standing context layer, "
            "so this profile gets its own context (0.13). Leave blank to "
            "auto-derive from the running profile (HERMES_PROFILE / HERMES_HOME)."
        ),
        "required": False,
    },
    {
        "key": "mission_domains",
        "label": "Mission domains",
        "description": (
            "Comma-separated knowledge domains this agent works in (e.g. Health, "
            "or Finance,Work). Recall boosts memories tagged into these domains "
            "(soft — never excludes others). Pick from the domains in your "
            "Hicortex config; leave blank for a general-purpose agent."
        ),
        "required": False,
    },
    # NOTE: recall-only plugin — no capture config. Capture is handled by the
    # nightly server-side reader of each agent's session store.
]


def _config_path(hermes_home: Optional[str] = None) -> str:
    home = hermes_home or os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")
    return os.path.join(home, "plugins", "hicortex", "config.json")


def load_config() -> Dict[str, Any]:
    """Load merged config: file <- env overrides <- defaults."""
    global _privacy_filter_deprecation_warned
    path = _config_path()
    cfg: Dict[str, Any] = {}
    file_set_privacy_filter = False
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as f:
                cfg = json.load(f) or {}
        except Exception:
            cfg = {}
        # Detect an EXPLICIT user setting (the default is applied via setdefault
        # below); only warn when the profile actually configured it.
        file_set_privacy_filter = "privacy_filter" in cfg

    # Env overrides
    if os.environ.get("HICORTEX_URL"):
        cfg["hicortex_url"] = os.environ["HICORTEX_URL"]
    if os.environ.get("HICORTEX_AUTH_TOKEN"):
        cfg["hicortex_auth_token"] = os.environ["HICORTEX_AUTH_TOKEN"]

    # Defaults
    cfg.setdefault("hicortex_url", "http://localhost:8787")
    cfg.setdefault("recall_limit", 5)
    cfg.setdefault("privacy_filter", "WORK,PERSONAL")

    # 0.16.2 deprecation: privacy_filter is a no-op now (server ignores privacy
    # entirely). Warn once per process if the profile explicitly sets it.
    if file_set_privacy_filter and not _privacy_filter_deprecation_warned:
        _privacy_filter_deprecation_warned = True
        logger.warning(
            "hicortex: config.json sets 'privacy_filter', which is deprecated "
            "since plugin 0.7.2 / server 0.16.2 — the server no longer filters "
            "on privacy (the column is vestigial). It is a harmless no-op now. "
            "For work/personal isolation, run a separate Hicortex server per "
            "scope. (This warning fires once per process.)"
        )

    return cfg


def save_config(values: Dict[str, Any], hermes_home: str) -> None:
    """Write non-secret config values to the plugin's config file.

    Called by `hermes memory setup` after collecting user inputs. Secret fields
    (hicortex_auth_token) are routed to the env store by Hermes, not written here.
    """
    path = _config_path(hermes_home)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    # Don't persist secrets to the JSON file — Hermes stores them separately.
    safe = {k: v for k, v in values.items() if k != "hicortex_auth_token"}
    with open(path, "w", encoding="utf-8") as f:
        json.dump(safe, f, indent=2)
