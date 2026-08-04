/**
 * OpenClaw transcript reader — reads OC session JSONL files.
 *
 * OC persists sessions at ~/.openclaw/agents/<agentId>/sessions/*.jsonl in the
 * Pi version-3 event format (OpenClaw is Pi-runtime based): event types
 * `session`, `model_change`, `thinking_level_change`, `message`, `custom`.
 * The Pi parser handles the format; this wrapper only adapts the directory
 * layout (one extra `agents/<agentId>` level) and sets OC provenance.
 *
 * Known limitation: rotated files (`*.jsonl.reset.<ts>`) are not read — only
 * live `*.jsonl` files. Server-side session dedup keeps re-reads idempotent.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { readPiTranscripts, type TranscriptBatch, type CursorMap } from "./pi-transcript-reader.js";

const DEFAULT_OC_AGENTS_DIR = join(homedir(), ".openclaw", "agents");

/**
 * Read OpenClaw session transcripts modified after `since`.
 *
 * @param since Only return sessions with mtime > this date
 * @param agentsDir Override the OC agents directory (default: ~/.openclaw/agents/)
 * @param cursors Per-session capture cursors (#189); keyed `oc:<agentId>:<sid>`
 */
export function readOcTranscripts(
  since: Date,
  agentsDir: string = DEFAULT_OC_AGENTS_DIR,
  cursors: CursorMap = {},
): TranscriptBatch[] {
  let agentIds: string[];
  try {
    agentIds = readdirSync(agentsDir);
  } catch {
    // No OpenClaw install — not an error.
    return [];
  }

  const batches: TranscriptBatch[] = [];
  for (const agentId of agentIds) {
    const agentPath = join(agentsDir, agentId);
    try {
      if (!statSync(agentPath).isDirectory()) continue;
    } catch {
      continue;
    }

    // agents/<agentId>/ contains a `sessions/` child with *.jsonl — exactly
    // the <root>/<projectDir>/*.jsonl shape readPiTranscripts walks. The
    // key prefix namespaces cursors per agent (oc:<agentId>:<sessionId>).
    for (const batch of readPiTranscripts(since, agentPath, cursors, `oc:${agentId}`)) {
      batches.push({
        ...batch,
        // The Pi walk labels the project from the cwd or the "sessions" dir
        // name — the agent id is the meaningful label for OC.
        projectName:
          batch.projectName && batch.projectName !== "sessions"
            ? batch.projectName
            : agentId,
        sourceAgent: `openclaw/${agentId}`,
      });
    }
  }
  return batches;
}
