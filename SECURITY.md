# Security Policy

## Supported versions

Only the latest minor version of `@gamaze/hicortex` on npm is supported with
security fixes. Older versions may not receive patches.

| Version | Supported |
|---------|-----------|
| latest  | yes       |
| older   | no        |

## Reporting a vulnerability

**Please don't open public GitHub issues for security problems.**

Email **security@gamaze.com** with:

- A description of the vulnerability
- Steps to reproduce
- The affected version(s)
- Your assessment of impact

You'll get an acknowledgement within 72 hours. We'll work with you on a fix
and a coordinated disclosure timeline.

## Scope

In scope:

- The npm package `@gamaze/hicortex` (this repository)
- The MCP HTTP server it runs (`hicortex server`)
- The CC integration (transcript reader, CLAUDE.md injection)
- The OpenClaw plugin entry
- Database file handling (SQLite, vector store)

Out of scope:

- Self-hosted deployments where you've changed the code
- Third-party LLM providers (report to them directly)
- The Hicortex Pro server at `hicortex.gamaze.com` — report to
  security@gamaze.com but it's a separate codebase
- The license validation API at `hicortex.gamaze.com/api/validate` — same

## What to expect

- Acknowledgement within 72 hours
- Initial assessment within 7 days
- Fix and disclosure within 30-90 days depending on severity
- Credit in the release notes (unless you prefer otherwise)

We don't currently run a paid bug bounty program.
