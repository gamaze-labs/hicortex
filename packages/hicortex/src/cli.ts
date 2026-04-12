#!/usr/bin/env node
/**
 * Hicortex CLI — entry point for `npx @gamaze/hicortex <command>`.
 *
 * Commands:
 *   server     Start the MCP HTTP/SSE server (persistent daemon)
 *   init       Detect existing setup and configure for CC/OC
 *   nightly    Run distill + consolidate + inject lessons (manual trigger)
 *              nightly --status  Show nightly pipeline health check
 *   status     Show config, DB stats, adapter status
 *   uninstall  Clean removal of CC integration
 */

const command = process.argv[2];

switch (command) {
  case "server": {
    const portArg = process.argv.indexOf("--port");
    const port = portArg !== -1 ? parseInt(process.argv[portArg + 1], 10) : undefined;
    const hostArg = process.argv.indexOf("--host");
    const host = hostArg !== -1 ? process.argv[hostArg + 1] : undefined;

    import("./mcp-server.js").then(({ startServer }) => {
      startServer({ port, host }).catch((err) => {
        console.error("[hicortex] Server failed to start:", err);
        process.exit(1);
      });
    });
    break;
  }

  case "init": {
    const serverArg = process.argv.indexOf("--server");
    const serverUrl = serverArg !== -1 ? process.argv[serverArg + 1] : undefined;
    import("./init.js").then(({ runInit }) => {
      runInit({ serverUrl }).catch((err) => {
        console.error("[hicortex] Init failed:", err);
        process.exit(1);
      });
    });
    break;
  }

  case "nightly": {
    const args = process.argv.slice(3);
    if (args.includes("--status")) {
      import("./nightly-status.js").then(({ showNightlyStatus }) => {
        showNightlyStatus().catch((err) => {
          console.error("[hicortex] Status check failed:", err);
          process.exit(1);
        });
      });
    } else {
      const dryRun = args.includes("--dry-run");
      import("./nightly.js").then(({ runNightly }) => {
        runNightly({ dryRun }).catch((err) => {
          console.error("[hicortex] Nightly pipeline failed:", err);
          process.exit(1);
        });
      });
    }
    break;
  }

  case "status":
    import("./status.js").then(({ runStatus }) => {
      runStatus().catch((err) => {
        console.error("[hicortex] Status failed:", err);
        process.exit(1);
      });
    });
    break;

  case "uninstall":
    import("./uninstall.js").then(({ runUninstall }) => {
      runUninstall().catch((err) => {
        console.error("[hicortex] Uninstall failed:", err);
        process.exit(1);
      });
    });
    break;

  default:
    console.log(`Hicortex — Human-like memory for self-improving AI agents

Usage: hicortex <command> [options]

Commands:
  server     Start the MCP HTTP/SSE server (server mode)
  init       Set up Hicortex (server mode, local DB + daemon)
  init --server <url>  Set up as client (remote server, local distillation)
  nightly    Run nightly distill + consolidate + inject
  status     Show current configuration and stats
  uninstall  Remove CC integration (preserves DB)

Options:
  server --port <n>    Port (default: 8787)
  server --host <h>    Host (default: 127.0.0.1)
  nightly --dry-run    Preview without changes
  nightly --status     Show nightly pipeline health

Examples:
  npx @gamaze/hicortex server
  npx @gamaze/hicortex init
  npx @gamaze/hicortex nightly --status
  npx @gamaze/hicortex init --server https://myserver.example.com
  npx @gamaze/hicortex status`);
    process.exit(command ? 1 : 0);
}
