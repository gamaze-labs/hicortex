#!/usr/bin/env bash
# Sync hermes-plugin/hicortex/ to the read-only mirror repo
# gamaze-labs/hicortex-hermes-plugin (the Hermes installer needs plugin.yaml
# at the repo root; it git-clones whole repos and has no subdir support).
#
# Manual for now — same model as sync-public.sh. The GitHub Action variant
# (.github/workflows/sync-hermes-plugin.yml) is committed but needs a push
# credential: gamaze-labs disables deploy keys, so it requires a fine-grained
# PAT stored as HERMES_MIRROR_DEPLOY_KEY (currently holds an unusable SSH key).
#
# Usage: bash scripts/sync-hermes-plugin.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$REPO_ROOT/hermes-plugin/hicortex"
MIRROR="git@github.com:gamaze-labs/hicortex-hermes-plugin.git"
SHA="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cp -R "$SRC"/. "$TMP/"
cd "$TMP"
rm -rf __pycache__ ./*.pyc config.json 2>/dev/null || true
git init -q -b main
git config user.name "hicortex-sync"
git config user.email "support@gamaze.com"
git add -A
git commit -q -m "sync from mha33/hicortex@$SHA"
git push --force "$MIRROR" main
echo "✓ mirror updated: gamaze-labs/hicortex-hermes-plugin @ $SHA"
