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
 *   dedup      Cluster + merge near-duplicate memories (issue #100)
 *              dedup --apply           Execute the merge (default: dry run)
 *   status     Show config, DB stats, adapter status
 *   uninstall  Clean removal of CC integration
 */

import { readValueFlag } from "./cli-args.js";

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
    let agentName: string | undefined;
    try {
      agentName = readValueFlag(process.argv, "--agent-name");
    } catch {
      console.error("[hicortex] init: --agent-name requires a value, e.g. --agent-name my-agent");
      process.exit(1);
    }
    const repairConfig = process.argv.includes("--repair-config");
    import("./init.js").then(({ runInit }) => {
      runInit({ serverUrl, agentName, repairConfig }).catch((err) => {
        // Operator-fixable failures (a malformed config.json) carry a complete,
        // actionable message — print that alone. A stack trace would bury it.
        // Anything else is a real bug and gets the full error object.
        const operatorFixable = err instanceof Error && /^Refusing to (read|write) /.test(err.message);
        console.error("[hicortex] Init failed:", operatorFixable ? err.message : err);
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
      const watchdog = args.includes("--watchdog");
      // Timestamp every log line. The nightly writes to a file (launchd /
      // systemd StandardOutput append) with NO per-line timestamp, which made
      // diagnosing capture gaps impossible (the #239 investigation couldn't
      // tell when a fire aborted). The daemon is unaffected — it logs to
      // journald, which already timestamps. Scoped to this process only.
      const origLog = console.log, origWarn = console.warn, origErr = console.error;
      const ts = () => `[${new Date().toISOString()}]`;
      console.log = (...a: unknown[]) => origLog(ts(), ...a);
      console.warn = (...a: unknown[]) => origWarn(ts(), ...a);
      console.error = (...a: unknown[]) => origErr(ts(), ...a);
      // #189 Tier-2 recovery: re-discover sessions that went quiet before the
      // upgrade by widening the discovery window to now−N days for one run.
      let recaptureWindowDays: number | undefined;
      const rwIdx = args.indexOf("--recapture-window");
      if (rwIdx !== -1) {
        recaptureWindowDays = parseInt(args[rwIdx + 1], 10);
        if (isNaN(recaptureWindowDays) || recaptureWindowDays <= 0) {
          console.error("[hicortex] nightly: --recapture-window requires a positive integer (days)");
          process.exit(1);
        }
      }
      import("./nightly.js").then(({ runNightly }) => {
        runNightly({ dryRun, captureOnly, watchdog, recaptureWindowDays }).catch((err) => {
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

  case "dedup": {
    const args = process.argv.slice(3);
    let threshold: number | undefined;
    try {
      const raw = readValueFlag(args, "--threshold");
      if (raw !== undefined) {
        threshold = parseFloat(raw);
        if (isNaN(threshold)) {
          console.error("[hicortex] dedup: --threshold requires a numeric value, e.g. --threshold 0.9");
          process.exit(1);
        }
      }
    } catch {
      console.error("[hicortex] dedup: --threshold requires a value, e.g. --threshold 0.9");
      process.exit(1);
    }
    let dbPath: string | undefined;
    try {
      dbPath = readValueFlag(args, "--db");
    } catch {
      console.error("[hicortex] dedup: --db requires a path value");
      process.exit(1);
    }
    const dedupOptions = { apply: args.includes("--apply"), threshold, dbPath };
    import("./dedup.js").then(({ runDedup }) => {
      runDedup(dedupOptions).catch((err) => {
        console.error(err instanceof Error ? err.message : `[hicortex] dedup failed: ${err}`);
        process.exit(1);
      });
    });
    break;
  }

  case "context": {
    // Standing context layer edit surface (spec §6): show|edit against the
    // configured server. Secondary to the /context/ui Web UI; for headless boxes.
    const args = process.argv.slice(3);
    import("./context-cli.js").then(({ runContextCommand, ContextCliError }) => {
      runContextCommand(args).catch((err) => {
        if (err instanceof ContextCliError) console.error(err.message);
        else console.error("[hicortex] context command failed:", err instanceof Error ? err.message : err);
        process.exit(1);
      });
    });
    break;
  }

  case "telemetry": {
    // Transparency surface: reports what anonymous telemetry sends. Read-only
    // by design — opting out is a deliberate config/env edit (0.15.1).
    import("./telemetry-cli.js").then(({ runTelemetryCommand }) => {
      runTelemetryCommand(process.argv.slice(3));
    }).catch((err) => {
      console.error("[hicortex] telemetry command failed:", err instanceof Error ? err.message : err);
      process.exit(1);
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

  case "recall-hook":
    // CC UserPromptSubmit + SessionStart hook: pushed recall index (#192).
    // Reads the CC hook payload from stdin, POSTs to the server, prints the
    // index block (UserPromptSubmit) or resets session dedup (SessionStart).
    // Fail-soft — any error = silent exit 0, never blocks a CC session.
    import("./recall-hook-cli.js").then(({ runRecallHook }) => {
      runRecallHook()
        .then(() => process.exit(0))
        .catch(() => process.exit(0));
    }).catch(() => process.exit(0));
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
  init --agent-name <name>  Opt in to a per-agent context id (default: unset — shared global context)
                            Pass --agent-name "" to clear it back to global
  init --repair-config  Recover from a malformed ~/.hicortex/config.json: move it to
                        config.json.corrupt-<timestamp> and rebuild. Nothing is deleted.
                        Mints a NEW authToken — every thin client must be updated.
  nightly         Run nightly denoise + capture + consolidate
  relink          Resumable link-discovery pass over the ENTIRE corpus (server mode)
  dedup           Cluster + merge near-duplicate memories (server mode; dry run by default)
  classify-domains  Backfill content-based domain tags over the corpus (server mode, needs config.domains)
  lessons-context Fetch lessons and print Markdown to stdout (CC SessionStart hook)
  recall-hook    Pushed recall index for the current prompt (CC UserPromptSubmit/SessionStart hook)
  context         Standing context layer (show|edit) against the configured server
  telemetry       Show exactly what anonymous telemetry sends (read-only)
  status          Show current configuration and stats
  uninstall       Remove CC integration (preserves DB)

Options:
  server --port <n>    Port (default: 8787)
  server --host <h>    Host (default: 127.0.0.1)
  nightly --dry-run         Preview without changes
  nightly --capture-only    Capture only, skip consolidation (safe to run multiple times/day)
  nightly --recapture-window <days>   Re-discover sessions quiet since <days> ago (one-shot #189 recovery)
  nightly --status          Show nightly pipeline health
  relink --dry-run          Discovery + counts only, zero writes, cursor untouched
  relink --batch <n>        Memories per batch (default: 200)
  relink --reset            Restart from the beginning (ignore saved cursor)
  dedup --apply             Execute the merge (default: dry run, report only)
  dedup --threshold <t>     Override config dedupMergeThreshold for one run
  dedup --db <path>         DB path override (defaults to the configured DB)
  classify-domains --all    Reclassify every memory (default: only NULL/stale-domain rows)
  classify-domains --batch <n>  Memories per batch (default: 200)
  classify-domains --reset  Restart from the beginning (ignore saved cursor)
  context show [name]       Print all context sections, or just <name> (raw, pipeable)
  context edit <name>       Edit a section in $EDITOR; PUT only if changed
  context … --agent <id>    Target a per-agent scope instead of the global set

Examples:
  npx @gamaze/hicortex server
  npx @gamaze/hicortex init
  npx @gamaze/hicortex nightly --status
  npx @gamaze/hicortex init --server https://myserver.example.com
  npx @gamaze/hicortex status`);
    process.exit(command ? 1 : 0);
}
