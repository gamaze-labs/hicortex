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
            "Bearer token for the server. Leave blank when targeting "
            "localhost — the server bypasses auth there. To find a remote "
            "server's token, run `hicortex status` on the server machine "
            "(or check ~/.hicortex/config.json there)."
        ),
        "secret": True,
        "env_var": "HICORTEX_AUTH_TOKEN",
    },
    # 0.7.6: setup asks ONLY url + token. default_project joined the
    # config-only knobs (0.7.5 removed recall_limit / agent_name /
    # mission_domains) after live-install feedback: "no human will understand
    # what it is" — a memory-attribution bucket is not a setup question.
    # Config-only knobs (set directly in config.json, all have correct
    # defaults): default_project (blank = unattributed), recall_limit (5;
    # tools + legacy fallback only — the pushed index is SERVER-sized via
    # recallMaxItems), agent_name (blank auto-derives from the running
    # profile), mission_domains (blank = off).
    # privacy_filter was removed outright in 0.7.4 (dead since server 0.16.2;
    # tolerated at load with a one-time warning if an old file carries it).
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
    # No privacy_filter default — the setting is dead (see schema note) and
    # must not be injected into new configs.

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

    #243: Does NOT clobber existing values with schema defaults. When the form
    sends a value that matches the schema default for a field AND the existing
    config.json already has a non-default value, the existing value is kept —
    so re-opening the dashboard and clicking Save without editing doesn't
    silently overwrite a remote URL with localhost.
    """
    path = _config_path(hermes_home)
    os.makedirs(os.path.dirname(path), exist_ok=True)

    # Load existing file values (merge target).
    existing: Dict[str, Any] = {}
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as f:
                existing = json.load(f) or {}
        except Exception:
            existing = {}

    # Build a map of schema defaults for the clobber guard.
    defaults = {f["key"]: f.get("default") for f in CONFIG_SCHEMA if "default" in f}

    # Merge: for each incoming value, skip it if (a) it equals the schema
    # default AND (b) the existing config has a different non-default value.
    # This prevents the dashboard's default-populated form from clobbering a
    # real remote URL with localhost on a no-op Save.
    merged = dict(existing)
    for k, v in values.items():
        if k == "hicortex_auth_token":
            continue  # secrets handled by Hermes env store, never written here
        if v == defaults.get(k) and existing.get(k, defaults.get(k)) != defaults.get(k):
            # Incoming value is the schema default but existing is NOT — keep existing.
            logger.debug("hicortex: save_config preserving existing %s=%s (form sent default %s)", k, existing.get(k), v)
            continue
        merged[k] = v

    with open(path, "w", encoding="utf-8") as f:
        json.dump(merged, f, indent=2)
