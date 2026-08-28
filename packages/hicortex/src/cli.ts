#!/usr/bin/env node
/**
 * Hicortex CLI — entry point for `npx @gamaze/hicortex <command>`.
 *
 * Commands:
 *   server     Start the MCP HTTP/SSE server (persistent daemon)
 *   init       Detect existing setup and configure for CC/OC
 *   nightly    Run capture + consolidate (manual trigger)
 *              nightly --capture-only     Capture only, skip consolidation
 *              nightly --consolidate-only Consolidate only, skip capture (hosted service)
 *              nightly --evict-only       Memory-cap eviction only — pure DB, no LLM (#317)
 *              nightly --status           Show nightly pipeline health check
 *   relink     Resumable link-discovery pass over the entire corpus (issue #143)
 *   dedup      Cluster + merge near-duplicate memories (issue #100)
 *              dedup --apply           Execute the merge (default: dry run)
 *   status     Show config, DB stats, adapter status
 *   uninstall  Clean removal of CC integration
 */

import { readValueFlag, resolveCommandAlias } from "./cli-args.js";

const command = resolveCommandAlias(process.argv[2]);

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
      const consolidateOnly = args.includes("--consolidate-only");
      const evictOnly = args.includes("--evict-only");
      const watchdog = args.includes("--watchdog");
      if (captureOnly && consolidateOnly) {
        console.error("[hicortex] nightly: --capture-only and --consolidate-only are mutually exclusive");
        process.exit(1);
      }
      if (evictOnly && (captureOnly || consolidateOnly)) {
        console.error("[hicortex] nightly: --evict-only is mutually exclusive with --capture-only and --consolidate-only");
        process.exit(1);
      }
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
        runNightly({ dryRun, captureOnly, consolidateOnly, evictOnly, watchdog, recaptureWindowDays }).catch((err) => {
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

  case "classify-types": {
    const args = process.argv.slice(3);
    const intFlag = (name: string): number | undefined => {
      const idx = args.indexOf(name);
      if (idx === -1) return undefined;
      const val = parseInt(args[idx + 1], 10);
      if (isNaN(val)) {
        console.error(`[hicortex] classify-types: ${name} requires an integer value`);
        process.exit(1);
      }
      return val;
    };
    const classifyTypeOptions = {
      all: args.includes("--all"),
      reset: args.includes("--reset"),
      batchSize: intFlag("--batch"),
    };
    import("./type-classify.js").then(({ runClassifyTypes }) => {
      runClassifyTypes(classifyTypeOptions).catch((err) => {
        console.error(err instanceof Error ? err.message : `[hicortex] classify-types failed: ${err}`);
        process.exit(1);
      });
    });
    break;
  }

  case "backup": {
    // Backup — transactionally-consistent snapshot of the irreplaceable data
    // (#6, Phase 0B). Mirrors `dedup`: flags parsed here, the runner (config
    // load + DB open + createBackup + hook + close) lives in backup.ts so this
    // switch stays thin and the heavy module is lazily imported.
    const args = process.argv.slice(3);
    let outDir: string | undefined;
    try {
      outDir = readValueFlag(args, "--out");
    } catch {
      console.error("[hicortex] backup: --out requires a directory path");
      process.exit(1);
    }
    const stdout = args.includes("--stdout");
    // `--out` is the output DIRECTORY (the artifact is auto-named
    // hicortex-<ISO>.tar.gz inside it) — matches the `backupDir` config and the
    // natural "put the backup here" invocation. Omit for the default <home>/backups.
    const backupOptions = { outDir, stdout };
    import("./backup.js").then(({ runBackupCli }) => {
      runBackupCli(backupOptions).catch((err) => {
        console.error(err instanceof Error ? err.message : `[hicortex] backup failed: ${err}`);
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

  case "identity": {
    // Standing identity layer edit surface (spec §6; renamed from context in
    // 0.18 #264): show|edit against the configured server. Secondary to the
    // /identity/ui Web UI; for headless boxes. The legacy `context` command is
    // kept as a hidden backcompat alias via resolveCommandAlias so old scripts
    // and muscle memory keep working.
    const args = process.argv.slice(3);
    import("./identity-cli.js").then(({ runIdentityCommand, IdentityCliError }) => {
      runIdentityCommand(args).catch((err) => {
        if (err instanceof IdentityCliError) console.error(err.message);
        else console.error("[hicortex] identity command failed:", err instanceof Error ? err.message : err);
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

  case "learnings-identity": {
    // CC SessionStart hook: fetch identity + lessons from the configured server
    // and print a Markdown block to stdout. Canonical command name since #264;
    // the legacy `lessons-context` subcommand is kept as a backcompat alias via
    // resolveCommandAlias so existing installed hooks keep working. Fail-soft —
    // any error = silent exit 0 so a broken hook never blocks a CC session.
    import("./learnings-identity.js").then(({ fetchLessonsIdentity }) => {
      fetchLessonsIdentity()
        .then((block) => {
          if (block) process.stdout.write(block + "\n");
          process.exit(0);
        })
        .catch(() => process.exit(0));
    }).catch(() => process.exit(0));
    break;
  }

  default:
    console.log(`Hicortex — Human-like memory for self-improving AI agents

Usage: hicortex <command> [options]

Commands:
  server          Start the MCP HTTP/SSE server (server mode)
  init            Set up Hicortex (server mode, local DB + daemon)
                  Scaffolds 5 editable default memory domains (Work, Personal,
                  People, Health, Finance) in ~/.hicortex/config.json
  init --server <url>  Set up as client (remote server)
  init --agent-name <name>  Opt in to a per-agent identity id (default: unset — shared global identity)
                            Pass --agent-name "" to clear it back to global
  init --repair-config  Recover from a malformed ~/.hicortex/config.json: move it to
                        config.json.corrupt-<timestamp> and rebuild. Nothing is deleted.
                        Mints a NEW authToken — every thin client must be updated.
  nightly         Run nightly denoise + capture + consolidate
  relink          Resumable link-discovery pass over the ENTIRE corpus (server mode)
  dedup           Cluster + merge near-duplicate memories (server mode; dry run by default)
  backup          Snapshot the DB + identity + state to a tar.gz (online, WAL-safe)
  classify-domains  Backfill content-based domain tags over the corpus (server mode, needs config.domains)
  classify-types    Backfill episode→fact/decision type tags over the corpus (server mode)
  learnings-identity  Fetch identity + lessons and print Markdown to stdout (CC SessionStart hook)
                      (alias: lessons-context — the pre-#264 name, kept for backcompat)
  recall-hook    Pushed recall index for the current prompt (CC UserPromptSubmit/SessionStart hook)
  identity        Standing identity layer (show|edit) against the configured server
                  (alias: context — the pre-0.18 name, kept for backcompat)
  telemetry       Show exactly what anonymous telemetry sends (read-only)
  status          Show current configuration and stats
  uninstall       Remove CC integration (preserves DB)

Options:
  server --port <n>    Port (default: 8787)
  server --host <h>    Host (default: 127.0.0.1)
  nightly --dry-run         Preview without changes
  nightly --capture-only    Capture only, skip consolidation (safe to run multiple times/day)
  nightly --consolidate-only  Consolidate only, skip capture (hosted-service per-tenant runs)
  nightly --evict-only      Memory-cap eviction only — pure DB, no capture, no LLM (#317)
  nightly --recapture-window <days>   Re-discover sessions quiet since <days> ago (one-shot #189 recovery)
  nightly --status          Show nightly pipeline health
  relink --dry-run          Discovery + counts only, zero writes, cursor untouched
  relink --batch <n>        Memories per batch (default: 200)
  relink --reset            Restart from the beginning (ignore saved cursor)
  dedup --apply             Execute the merge (default: dry run, report only)
  dedup --threshold <t>     Override config dedupMergeThreshold for one run
  dedup --db <path>         DB path override (defaults to the configured DB)
  backup --out <dir>        Write the artifact into <dir> as hicortex-<ISO>.tar.gz (default: <home>/backups)
  backup --stdout           Stream the tar.gz to stdout (offsite pipe: hicortex backup --stdout | rclone rcat …)
  classify-domains --all    Reclassify every memory (default: only NULL/stale-domain rows)
  classify-domains --batch <n>  Memories per batch (default: 200)
  classify-domains --reset  Restart from the beginning (ignore saved cursor)
  classify-types --all      Reclassify every memory (default: only episodes)
  classify-types --batch <n>  Memories per batch (default: 200)
  classify-types --reset    Restart from the beginning (ignore saved cursor)
  identity show [name]      Print all identity sections, or just <name> (raw, pipeable)
  identity edit <name>      Edit a section in $EDITOR; PUT only if changed
  identity … --agent <id>   Target a per-agent scope instead of the global set
  (the legacy 'context' command remains as a hidden alias for 'identity')

Examples:
  npx @gamaze/hicortex server
  npx @gamaze/hicortex init
  npx @gamaze/hicortex nightly --status
  npx @gamaze/hicortex init --server https://myserver.example.com
  npx @gamaze/hicortex status`);
    process.exit(command ? 1 : 0);
}
