# Contributing to Hicortex

Thanks for your interest in contributing! Hicortex is open source under MIT,
maintained by [Gamaze](https://hicortex.gamaze.com).

## How to contribute

1. **Open an issue first** for non-trivial changes — describe the problem and
   the proposed approach. We'd rather align on direction before you spend time
   on a PR that might not land.
2. **Fork, branch, build, test, PR.** Standard GitHub workflow.
3. **One concern per PR.** A bug fix or a feature, not both. Easier to review
   and revert.
4. **Match the existing code style.** TypeScript strict mode, no semicolons in
   prose, prefer small focused functions over clever one-liners.

## Development setup

```bash
git clone https://github.com/gamaze-labs/hicortex.git
cd hicortex/packages/openclaw-plugin
npm install
npm run build
npm test
```

Requirements:
- Node.js 18+
- An LLM provider (Ollama 9b+ recommended for local dev, or any API key)

## What we accept

- **Bug fixes** with a clear reproduction case
- **Documentation improvements** (README, code comments, examples)
- **Test coverage** for existing untested code paths
- **Provider integrations** (new LLM providers in `src/llm.ts`)
- **Performance improvements** with measurements
- **Compatibility fixes** for new Node versions, new MCP clients, etc.

## What we don't accept (without prior discussion)

- **Architectural rewrites** — open an issue first
- **New top-level features** that compete with the commercial Pro tier (lesson
  selection, validation, cross-agent learning, prescriptive distillation,
  smart context assembly). The OSS scope is the memory client; intelligence
  features are commercial. We're happy to discuss where the line is in any
  specific case.
- **Dependencies on services that aren't free for end users**

## Pro features

Hicortex is open core: the client is MIT-licensed and free forever. Commercial
"Pro" intelligence features are sold separately by Gamaze and live in a
private repository. If you're interested in Pro features, see
[hicortex.gamaze.com](https://hicortex.gamaze.com).

PRs that effectively reimplement Pro features in OSS are not accepted —
they undermine the economic model that funds OSS development. If you think
something we're treating as Pro should actually be OSS, open an issue and
make the case.

## Reporting security issues

See [SECURITY.md](SECURITY.md). Please don't open public issues for
security problems.

## License

By contributing, you agree that your contributions will be licensed under
the MIT license (see [LICENSE](LICENSE)).
