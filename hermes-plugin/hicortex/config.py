"""Config schema + load/save for the Hicortex Hermes plugin.

Config lives at ``$HERMES_HOME/plugins/hicortex/config.json``. Environment
variables (``HICORTEX_URL``, ``HICORTEX_AUTH_TOKEN``) override the file, so the
plugin also works with env-only setup.
"""

from __future__ import annotations

import json
import os
from typing import Any, Dict, Optional

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
            "Tailscale hostname, e.g. http://memory-server:8787."
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
        "description": "Max memories returned per recall (default 5).",
        "default": "5",
        "required": False,
    },
    {
        "key": "privacy_filter",
        "label": "Privacy filter",
        "description": "Comma-separated privacy levels to include (e.g. WORK,PERSONAL).",
        "default": "WORK,PERSONAL",
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
    path = _config_path()
    cfg: Dict[str, Any] = {}
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as f:
                cfg = json.load(f) or {}
        except Exception:
            cfg = {}

    # Env overrides
    if os.environ.get("HICORTEX_URL"):
        cfg["hicortex_url"] = os.environ["HICORTEX_URL"]
    if os.environ.get("HICORTEX_AUTH_TOKEN"):
        cfg["hicortex_auth_token"] = os.environ["HICORTEX_AUTH_TOKEN"]

    # Defaults
    cfg.setdefault("hicortex_url", "http://localhost:8787")
    cfg.setdefault("recall_limit", 5)
    cfg.setdefault("privacy_filter", "WORK,PERSONAL")
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
