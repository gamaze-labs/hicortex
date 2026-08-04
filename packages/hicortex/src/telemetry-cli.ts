/**
 * `hicortex telemetry` — transparency surface for anonymous usage telemetry.
 *
 * Read-only BY DESIGN (owner decision 30.07.2026). It shows the exact payload
 * and both documented ways to switch telemetry off, but it does not flip the
 * switch itself: the `telemetry` key is deliberately NOT scaffolded into
 * config.json, and opting out is a deliberate edit the operator makes. Turning
 * it off must stay completely possible and completely documented — just not a
 * one-keystroke default-path action.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hicortexHome } from "./paths.js";
import {
  TELEMETRY_URL,
  TELEMETRY_PAYLOAD_VERSION,
  getTelemetryId,
  telemetryDisabledReason,
} from "./telemetry.js";

function readConfig(home: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(join(home, "config.json"), "utf-8"));
  } catch {
    return null;
  }
}

function printHowToDisable(home: string): void {
  console.log("To turn it off (either one works, both are permanent):");
  console.log(`  1. add  "telemetry": false  to ${join(home, "config.json")}`);
  console.log("  2. or set  HICORTEX_TELEMETRY=off  in the environment");
}

export function runTelemetryCommand(args: string[]): void {
  const home = hicortexHome();
  const sub = args[0] ?? "status";

  if (sub === "on" || sub === "off") {
    // Intentionally not a write command — see the module docstring.
    console.log(
      `[hicortex] telemetry is not toggled by this command; it reports state only.`
    );
    printHowToDisable(home);
    return;
  }

  if (sub !== "status") {
    console.error(`[hicortex] telemetry: unknown subcommand '${sub}' (only 'status' is supported)`);
    process.exit(1);
  }

  const config = readConfig(home);
  const reason = telemetryDisabledReason(config);
  const mode = config?.mode === "client" ? "client" : "server";

  console.log("Hicortex telemetry");
  console.log("──────────────────────────────────────────");
  if (reason) {
    console.log(
      `Status:    DISABLED (via ${reason === "env" ? "HICORTEX_TELEMETRY env var" : 'config.json "telemetry": false'})`
    );
    console.log("Nothing is sent. Remove that setting to re-enable.");
    return;
  }
  console.log("Status:    ENABLED (anonymous, aggregate only) — the default");
  console.log(`Endpoint:  ${TELEMETRY_URL}`);
  console.log("When:      once at the end of each full nightly run");
  console.log("");
  console.log("Exactly what is sent (counts from this install; values vary per run):");
  const example: Record<string, unknown> = {
    id: getTelemetryId(home),
    v: "<package version>",
    pv: TELEMETRY_PAYLOAD_VERSION,
    mode,
    agent: "<cc|hermes|pi|oc|mixed>",
    mem: "<total memories>",
    lessons: "<total lessons>",
    sessions: "<sessions captured this run>",
    ok: "<nightly succeeded>",
  };
  if (mode === "server") {
    example.shown = "<sum of shown_count>";
    example.uses = "<sum of access_count>";
    example.cold = "<memories never shown or used>";
  }
  console.log(JSON.stringify(example, null, 2));
  console.log("");
  console.log("NOT sent: memory content, prompts, file paths, project names,");
  console.log("hostnames, tokens, or IP addresses (the server stores no IPs).");
  console.log("Every install sends the same fields — nothing marks yours as special.");
  console.log("");
  printHowToDisable(home);
}
