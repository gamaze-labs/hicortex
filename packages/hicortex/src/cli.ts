#!/usr/bin/env node
/**
 * Hicortex CLI — entry point for `npx @gamaze/hicortex <command>`.
 *
 * Commands:
 *   server     Start the MCP HTTP/SSE server (persistent daemon)
 *   init       Detect existing setup and configure for CC/OC
 *   nightly    Run capture + consolidate (manual trigger)
 *              nightly --capture-only  Capture only, skip consolidation
 *              nightly --status        Show nightly pipeline health check
 *   relink     Resumable link-discovery pass over the entire corpus (issue #143)
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
      const captureOnly = args.includes("--capture-only");
      import("./nightly.js").then(({ runNightly }) => {
        runNightly({ dryRun, captureOnly }).catch((err) => {
          console.error("[hicortex] Nightly pipeline failed:", err);
          process.exit(1);
        });
      });
    }
    break;
  }

  case "relink": {
    const args = process.argv.slice(3);
    const intFlag = (name: string): number | undefined => {
      const idx = args.indexOf(name);
      if (idx === -1) return undefined;
      const val = parseInt(args[idx + 1], 10);
      if (isNaN(val)) {
        console.error(`[hicortex] relink: ${name} requires an integer value`);
        process.exit(1);
      }
      return val;
    };
    const relinkOptions = {
      dryRun: args.includes("--dry-run"),
      reset: args.includes("--reset"),
      batchSize: intFlag("--batch"),
    };
    import("./relink.js").then(({ runRelink }) => {
      runRelink(relinkOptions).catch((err) => {
        console.error(err instanceof Error ? err.message : `[hicortex] Relink failed: ${err}`);
        process.exit(1);
      });
    });
    break;
  }

  case "classify-domains": {
    const args = process.argv.slice(3);
    const intFlag = (name: string): number | undefined => {
      const idx = args.indexOf(name);
      if (idx === -1) return undefined;
      const val = parseInt(args[idx + 1], 10);
      if (isNaN(val)) {
        console.error(`[hicortex] classify-domains: ${name} requires an integer value`);
        process.exit(1);
      }
      return val;
    };
    const classifyOptions = {
      all: args.includes("--all"),
      reset: args.includes("--reset"),
      batchSize: intFlag("--batch"),
    };
    import("./classify-domains.js").then(({ runClassifyDomains }) => {
      runClassifyDomains(classifyOptions).catch((err) => {
        console.error(err instanceof Error ? err.message : `[hicortex] classify-domains failed: ${err}`);
        process.exit(1);
      });
    });
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

  case "lessons-context":
    // CC SessionStart hook: fetch lessons from the configured server and print
    // a Markdown block to stdout. Fail-soft — any error = silent exit 0 so a
    // broken hook never blocks a CC session.
    import("./lessons-context.js").then(({ fetchLessonsContext }) => {
      fetchLessonsContext()
        .then((block) => {
          if (block) process.stdout.write(block + "\n");
          process.exit(0);
        })
        .catch(() => process.exit(0));
    }).catch(() => process.exit(0));
    break;

  default:
    console.log(`Hicortex — Human-like memory for self-improving AI agents

Usage: hicortex <command> [options]

Commands:
  server          Start the MCP HTTP/SSE server (server mode)
  init            Set up Hicortex (server mode, local DB + daemon)
                  Scaffolds 5 editable default memory domains (Work, Personal,
                  People, Health, Finance) in ~/.hicortex/config.json
  init --server <url>  Set up as client (remote server)
  nightly         Run nightly denoise + capture + consolidate
  relink          Resumable link-discovery pass over the ENTIRE corpus (server mode)
  classify-domains  Backfill content-based domain tags over the corpus (server mode, needs config.domains)
  lessons-context Fetch lessons and print Markdown to stdout (CC SessionStart hook)
  status          Show current configuration and stats
  uninstall       Remove CC integration (preserves DB)

Options:
  server --port <n>    Port (default: 8787)
  server --host <h>    Host (default: 127.0.0.1)
  nightly --dry-run         Preview without changes
  nightly --capture-only    Capture only, skip consolidation (safe to run multiple times/day)
  nightly --status          Show nightly pipeline health
  relink --dry-run          Discovery + counts only, zero writes, cursor untouched
  relink --batch <n>        Memories per batch (default: 200)
  relink --reset            Restart from the beginning (ignore saved cursor)
  classify-domains --all    Reclassify every memory (default: only NULL/stale-domain rows)
  classify-domains --batch <n>  Memories per batch (default: 200)
  classify-domains --reset  Restart from the beginning (ignore saved cursor)

Examples:
  npx @gamaze/hicortex server
  npx @gamaze/hicortex init
  npx @gamaze/hicortex nightly --status
  npx @gamaze/hicortex init --server https://myserver.example.com
  npx @gamaze/hicortex status`);
    process.exit(command ? 1 : 0);
}
