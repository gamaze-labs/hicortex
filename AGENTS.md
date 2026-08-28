# AGENTS.md — verification contract

Machine-parseable truth for "done" in this repository. Mirrors what CI runs
(.github/workflows/test.yml). When this file and CI disagree, CI wins and this
file must be fixed.

agent-verification: (cd packages/hicortex && npm ci && npm run build && npm test) && uv run --with pytest pytest hermes-plugin/test_provider.py

exit-code: 0 = pass, non-zero = fail (authoritative signal)

## Prerequisites

- agent-satisfiable: node 22, npm, uv — uv is the fleet-standard python runner (owner rule, 2026-08-24: always uv for python, bun for js where possible). System pip is absent on Debian hosts; never use it.
- privileged/human/credentialed: none. The full chain is agent-runnable.

## Notes for agents

- Run the whole chain from the repository root; it is one command line.
- `npm ci` (not `npm install`) — the lockfile is the contract. (Node steps stay npm while CI uses npm; a move to bun must change CI and this file together.)
- Python steps go through uv — `uv run --with pytest …` provisions pytest itself.
- If you changed only docs, the chain still must pass — it is cheap insurance
  against repo-level breakage you did not notice.
