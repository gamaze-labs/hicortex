/**
 * Session knowledge extraction (distillation).
 * Simplified from hicortex/distiller.py — messages come from agent_end hook,
 * not from filesystem scanning.
 */

import type { LlmClient, LlmUsage } from "./llm.js";
import { distillation } from "./prompts.js";
import { redact, type RedactionConfig } from "./redact.js";
import { VOLATILE_STATUS_FILTER, VOLATILE_GATE_MAX_CHARS } from "./calibration.js";

const MAX_TRANSCRIPT_CHARS = 80_000;
const MIN_CONVERSATION_CHARS = 200;

// #339 (2026-08-24 postmortem): NO_EXTRACT over-firing visibility threshold.
// Real summary-led segments that the model wrongly abandoned ran 38-64K
// denoised chars; genuine pure-status noise is ~2.6K. A segment larger than
// this whose every chunk returns an empty LLM verdict is far more likely the
// model pattern-matching a bookkeeping-heavy OPENING to the ephemera gate than
// a legitimately empty segment — so it gets a warning line. Warning ONLY: no
// auto-retry (cost); the goal is that silent segment loss shows up in the
// nightly log instead of in a weeks-later eval.
//
// The threshold compares the PRE-CHUNKING conversation length, never the chunk
// length: default ollama chunking (numCtx 8192 → ~19.6K chars) and the
// small-model speed cap (20K) both keep every chunk at or below this number,
// so a chunk-level check would be unreachable exactly where the incident lived.
const NO_EXTRACT_WARN_MIN_CHARS = 20_000;

// Chunk size limits by model parameter count (for local/CPU inference)
// Small models are slow on CPU — cap input size to keep inference under ~60s
const SMALL_MODEL_PARAMS = 8_000_000_000; // 8B — threshold for "small"
const SMALL_MODEL_MAX_CHUNK_CHARS = 20_000; // ~5K tokens — safe for 4-8B on CPU
const LARGE_MODEL_MAX_CHUNK_CHARS = 60_000; // ~15K tokens — ok for 8B+ on GPU or API

/**
 * Estimate a safe chunk size in chars based on the LLM provider and model.
 * - API providers (Anthropic, OpenAI, claude-cli): no chunking needed (large context windows)
 * - Ollama: chunk size derives from the resolved `numCtx` (the request's actual
 *   context window), capped by parameter-count-derived speed limits:
 *   - Small models (<8B params): max 20K chars (~5K tokens) — keeps CPU inference under ~60s
 *   - Larger models: up to 60K chars (~15K tokens)
 * - Fallback: 20K chars
 *
 * `numCtx` is the single source of truth for the context constraint (#231): it is
 * the value completeOllama will actually send as `num_ctx`, so chunking against it
 * keeps the chunker and the request in agreement (kills the silent-truncation bug
 * #228, where chunks were sized from the model's ADVERTISED context while the
 * request used a smaller `numCtx`). The `/api/show` query is KEPT — but only for
 * the parameter-count speed cap (`maxBySpeed`, SMALL vs LARGE), NOT for context.
 */
export async function detectChunkSize(
  provider: string,
  model: string,
  baseUrl?: string,
  numCtx?: number,
): Promise<number> {
  // API-based providers handle large contexts natively — no chunking needed
  if (provider !== "ollama") {
    return MAX_TRANSCRIPT_CHARS;
  }

  // Query Ollama for model metadata (parameter count → speed cap)
  if (baseUrl) {
    try {
      const resp = await fetch(`${baseUrl}/api/show`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: model }),
        signal: AbortSignal.timeout(5000),
      });
      if (resp.ok) {
        const data = await resp.json() as {
          model_info?: Record<string, unknown>;
          parameters?: string;
        };
        const info = data.model_info ?? {};

        // Extract parameter count for speed-aware capping
        const paramKey = Object.keys(info).find(
          (k) => k.endsWith("parameter_count")
        );
        const paramCount = paramKey && typeof info[paramKey] === "number"
          ? (info[paramKey] as number)
          : 0;
        const isSmallModel = paramCount > 0 && paramCount < SMALL_MODEL_PARAMS;

        // Determine max chunk size based on model size (speed constraint)
        // Unknown param count defaults to conservative (small model) — safe for any hardware
        const maxBySpeed = !isSmallModel && paramCount > 0 ? LARGE_MODEL_MAX_CHUNK_CHARS : SMALL_MODEL_MAX_CHUNK_CHARS;

        // Determine max chunk size from the resolved numCtx (the request's ACTUAL
        // context window), NOT the model's advertised context_length. 60% of context,
        // ~4 chars/token. Falls back to MAX_TRANSCRIPT_CHARS when numCtx is unknown
        // (caller didn't pass it) — but the mcp-server call site always passes it.
        const resolvedCtx = numCtx ?? 8192;
        const maxByContext = Math.floor(resolvedCtx * 0.6 * 4);

        const chunkChars = Math.min(maxBySpeed, maxByContext);
        console.log(
          `[hicortex]     Model: ${paramCount > 0 ? `${(paramCount / 1e9).toFixed(1)}B params` : "unknown size"}, ` +
          `numCtx: ${resolvedCtx}, ` +
          `chunk size: ${chunkChars} chars${isSmallModel ? " (small model cap)" : ""}`
        );
        return chunkChars;
      }
    } catch {
      // Failed to query — use fallback
    }
  }

  // Fallback: 20K chars (~5K tokens) — safe for 4B models with 32K context
  return 20_000;
}

// Entry types to skip entirely (from the Python distiller)
const SKIP_ENTRY_TYPES = new Set([
  "progress",
  "system",
  "file-history-snapshot",
  "queue-operation",
  "summary",
]);

/**
 * Extract readable text from a message content value (string or block list).
 */
function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content.length > 20_000 ? content.slice(0, 20_000) : content;
  }

  if (!Array.isArray(content)) return "";

  const texts: string[] = [];
  let totalLen = 0;

  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const btype = (block as Record<string, unknown>).type;

    if (btype === "text") {
      const t = String((block as Record<string, unknown>).text ?? "");
      texts.push(t.length > 10_000 ? t.slice(0, 10_000) : t);
      totalLen += t.length;
    }
    // Skip: tool_use, tool_result, thinking, image blocks

    if (totalLen > 20_000) break;
  }

  return texts.join("\n");
}

/**
 * Strip noise from message text, keep the human conversation.
 */
function cleanMessageContent(text: string): string {
  // Hard cap
  if (text.length > 50_000) {
    text = text.slice(0, 50_000);
  }

  // Remove large code blocks (>10 lines)
  const lines = text.split("\n");
  const cleaned: string[] = [];
  let inCodeBlock = false;
  let codeBlockLines = 0;
  let codeBlockStart = 0;

  for (const line of lines) {
    if (line.startsWith("```") && !inCodeBlock) {
      inCodeBlock = true;
      codeBlockLines = 0;
      codeBlockStart = cleaned.length;
      cleaned.push(line);
    } else if (line.startsWith("```") && inCodeBlock) {
      inCodeBlock = false;
      if (codeBlockLines > 10) {
        cleaned.length = codeBlockStart;
        cleaned.push("[code block removed]");
      } else {
        cleaned.push(line);
      }
    } else if (inCodeBlock) {
      codeBlockLines++;
      cleaned.push(line);
    } else {
      cleaned.push(line);
    }
  }

  if (inCodeBlock && codeBlockLines > 10) {
    cleaned.length = codeBlockStart;
    cleaned.push("[code block removed]");
  }

  text = cleaned.join("\n");

  // Remove <system-reminder>...</system-reminder>
  text = text.replace(/<system-reminder>[^<]{0,10000}<\/system-reminder>/g, "");

  // Remove file path dumps (Read tool output: "  123->...")
  text = text.replace(/^\s*\d+\u2192.*$/gm, "");

  // Remove base64 content
  text = text.replace(/[A-Za-z0-9+/]{100,}={0,2}/g, "[binary removed]");

  // Collapse excessive whitespace
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim();
}

/**
 * Convert session messages to a filtered transcript string.
 * Handles OC hook format, CC JSONL, and Pi JSONL.
 *
 * If redactionConfig is provided (or defaults to enabled), secrets and PII
 * are scrubbed from the final text BEFORE it reaches any LLM or storage.
 */
export function extractConversationText(
  messages: unknown[],
  redactionConfig?: RedactionConfig,
): string {
  const parts: string[] = [];

  for (const msg of messages) {
    if (typeof msg !== "object" || msg === null) continue;
    const m = msg as Record<string, unknown>;

    // Entry-level filter
    if (SKIP_ENTRY_TYPES.has(String(m.type ?? ""))) continue;
    if (m.isSidechain) continue;

    // Extract the message role from whichever format we're dealing with:
    //   OC hook:  m.role = "user" | "assistant"
    //   CC JSONL:  m.type = "user" | "assistant"
    //   Pi JSONL:  m.message.role = "user" | "assistant" | "toolResult"
    const nestedMsg = m.message as Record<string, unknown> | undefined;
    const msgRole = String(m.role ?? nestedMsg?.role ?? m.type ?? "");

    // Skip tool results — they're noisy (file contents, command output) and
    // add bulk without much extractable knowledge for distillation.
    if (msgRole === "toolResult" || msgRole === "tool_result") continue;

    // Extract content — OC has content at top level; CC/Pi have message.content
    const content = m.content ?? nestedMsg?.content;
    if (content === undefined || content === null) continue;

    let text = extractTextFromContent(content);
    text = cleanMessageContent(text);

    if (text.length < 20) continue;

    const role = msgRole === "user" ? "USER" : "ASSISTANT";
    parts.push(`${role}: ${text}`);
  }

  let result = parts.join("\n\n");

  // Redact secrets and PII before the text reaches any LLM or storage.
  // This is the last step — after all cleaning/filtering but before return.
  const { text: redacted, count } = redact(result, redactionConfig);
  if (count > 0) {
    console.log(`[hicortex] Redacted ${count} secret(s) from transcript`);
  }
  result = redacted;

  return result;
}

/**
 * Send filtered conversation to LLM for knowledge extraction.
 * For large transcripts, chunks into segments to avoid overwhelming small models.
 * Returns an array of memory entries to ingest, or empty array if nothing worth extracting.
 *
 * `droppedOut`, when provided, is filled with every entry the substance gate
 * discarded (full text). Callers use it to build a durable audit trail (#156);
 * omitting it leaves gate behaviour unchanged.
 *
 * `segmentLabel` (optional) identifies the caller's segment in the #339
 * over-firing warning (e.g. the capture pipeline's segment_id). Purely for
 * log correlation — omitting it falls back to "chunk".
 */
export async function distillSession(
  llm: LlmClient,
  conversation: string,
  projectName: string,
  date: string,
  chunkSizeChars?: number,
  droppedOut?: string[],
  /** Called with each chunk's token usage (#5 budget metering). Optional. */
  onUsage?: (usage: LlmUsage) => void,
  /** Segment identifier for the #339 NO_EXTRACT warning. Optional. */
  segmentLabel?: string,
): Promise<DistilledEntry[]> {
  if (conversation.length < MIN_CONVERSATION_CHARS) {
    return [];
  }

  // Cap total input at MAX_TRANSCRIPT_CHARS
  let transcript = conversation;
  if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    transcript = transcript.slice(0, MAX_TRANSCRIPT_CHARS) + "\n\n[...truncated...]";
  }

  // Use provided chunk size or default to no chunking
  const chunkSize = chunkSizeChars ?? MAX_TRANSCRIPT_CHARS;

  // If transcript fits in one chunk, distill directly (errors propagate)
  if (transcript.length <= chunkSize) {
    const { entries, dropped, emptyVerdict } = await distillChunk(llm, transcript, projectName, date, onUsage);
    if (droppedOut) droppedOut.push(...dropped);
    if (emptyVerdict) warnSuspiciousEmptySegment(segmentLabel, conversation.length);
    return entries;
  }

  // Chunk large transcripts and distill each segment.
  //
  // Partial success policy:
  //   - If SOME chunks succeed and SOME fail, return the partial results and
  //     log a warning. The caller gets *something* and can decide whether
  //     to count this as success.
  //   - If ALL chunks fail, throw — no useful output, and the caller needs
  //     to know this session hit a transient error.
  const chunks = splitIntoChunks(transcript, chunkSize);
  console.log(`[hicortex]     Chunking ${transcript.length} chars into ${chunks.length} segments`);
  const allEntries: DistilledEntry[] = [];
  const seen = new Set<string>();
  let chunkFailures = 0;
  let emptyVerdicts = 0;
  let lastError: Error | null = null;

  for (let i = 0; i < chunks.length; i++) {
    console.log(`[hicortex]     Chunk ${i + 1}/${chunks.length} (${chunks[i].length} chars)`);
    try {
      const { entries, dropped, emptyVerdict } = await distillChunk(llm, chunks[i], projectName, date, onUsage);
      if (emptyVerdict) emptyVerdicts++;
      if (droppedOut) droppedOut.push(...dropped);
      for (const entry of entries) {
        // Deduplicate by normalized content (type tag does not participate —
        // two chunks extracting the same fact should collapse regardless of
        // whether one tagged it [K] and the other [E]).
        const key = entry.content.toLowerCase().replace(/\s+/g, " ").slice(0, 100);
        if (!seen.has(key)) {
          seen.add(key);
          allEntries.push(entry);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[hicortex]     Chunk ${i + 1} failed: ${msg}`);
      chunkFailures++;
      lastError = err instanceof Error ? err : new Error(msg);
    }
  }

  // If every chunk failed, the session wasn't actually processed. Throw so
  // the nightly pipeline knows to retry this session next run.
  if (chunkFailures === chunks.length) {
    throw lastError ?? new Error("All distillation chunks failed");
  }

  if (chunkFailures > 0) {
    console.warn(
      `[hicortex]     Partial distillation: ${chunks.length - chunkFailures}/${chunks.length} chunks succeeded`
    );
  }

  // #339 segment-level net (CR finding 1): fire when the WHOLE segment produced
  // zero memories and every processed chunk returned an empty LLM verdict. Fires
  // only with zero chunk failures — failed chunks are already loudly visible,
  // and "all failed" throws above. The size gate lives INSIDE
  // warnSuspiciousEmptySegment (strict >, pre-chunking conversation length).
  if (
    allEntries.length === 0 &&
    chunkFailures === 0 &&
    emptyVerdicts === chunks.length
  ) {
    warnSuspiciousEmptySegment(segmentLabel, conversation.length);
  }

  return allEntries;
}

/**
 * #339 over-firing visibility net: an empty result this large is the silent-loss
 * signature (real summary-led segments are 38-64K chars; legitimate pure-status
 * noise is ~2.6K). Warning-only, content-free — segment id + size, nothing from
 * the transcript. The empty SUCCESS semantics are unchanged (no throw, no
 * retry): the cursor advances, but the loss is now VISIBLE in the nightly log
 * instead of surfacing weeks later in an eval.
 *
 * The size check lives here, not at call sites, so no path can skip it. Strict
 * comparison: exactly NO_EXTRACT_WARN_MIN_CHARS chars is a legitimate small
 * segment and stays silent.
 */
function warnSuspiciousEmptySegment(
  segmentLabel: string | undefined,
  segmentChars: number,
): void {
  if (segmentChars <= NO_EXTRACT_WARN_MIN_CHARS) return;
  console.warn(
    `[hicortex]     Suspicious empty distillation: zero memories for a ${segmentChars}-char ` +
    `${segmentLabel ? `segment ${segmentLabel}` : "segment"} ` +
    `(every chunk returned NO_EXTRACT or nothing parseable) — segments this large almost always ` +
    `contain extractable material; if this repeats, suspect gate over-firing (logged only, not retried)`
  );
}

/**
 * Distill a single chunk of conversation text.
 *
 * Behaviour contract:
 *   - Returns `{entries: [], dropped: []}` for legitimate empty results
 *     (NO_EXTRACT, empty LLM response, transcript produced no entries). These are
 *     terminal states — the chunk was processed successfully, there's just
 *     nothing worth keeping.
 *   - Throws for transient errors (LLM unreachable, HTTP 4xx/5xx, timeout, model
 *     not found, rate limit). These MUST propagate so the nightly pipeline can
 *     distinguish "nothing to extract" from "try again later" and avoid
 *     advancing the last-run watermark past sessions it never actually processed.
 *
 * `dropped` carries entries the substance gate rejected (full text) so the
 * caller can surface them in a durable audit trail (#156).
 *
 * `emptyVerdict` is true when the chunk was processed successfully but the LLM's
 * verdict contained nothing extractable: bare NO_EXTRACT, an empty response, or
 * text that parses to zero bullets (prose — the silent twin of NO_EXTRACT,
 * #339 CR finding 2). The caller aggregates these for the segment-level
 * over-firing warning; entries extracted then dropped by the substance gate do
 * NOT count (their drops are already logged).
 */
async function distillChunk(
  llm: LlmClient,
  transcript: string,
  projectName: string,
  date: string,
  onUsage?: (usage: LlmUsage) => void,
): Promise<{ entries: DistilledEntry[]; dropped: string[]; emptyVerdict: boolean }> {
  const prompt = distillation(projectName, date, transcript);

  // NOTE: Intentionally no try/catch here. Transient LLM errors (network
  // failures, 4xx/5xx, model-not-found, timeouts) propagate up to the caller
  // so the nightly pipeline can treat them as "retry later" instead of
  // "processed successfully with zero extractions".
  const { text: result, usage } = await llm.complete(prompt);
  // #5: report this chunk's token usage to the caller's budget meter. Optional
  // (absent for callers that don't meter); a missing/undefined usage (claude-cli)
  // is a no-op — consistent with the existing design that such tenants never
  // trip a budget.
  if (usage && onUsage) onUsage(usage);
  if (!result || isNoExtractResponse(result)) {
    return { entries: [], dropped: [], emptyVerdict: true };
  }

  const parsed = parseDistilledEntries(result);

  // Smoke alarm (PR #218 review): the prompt enforces topic-first, but models
  // sometimes ignore constraints (cf. the prior max-15-bullet failure). Count
  // entries that still look actor-led or bracket-led so a format regression
  // shows in nightly logs, not months later in the next eval. Non-blocking.
  // Note: the type tag ([E]/[K]/[D]) is already stripped by the parser, so a
  // leading bracket here means a payload-bracket or a category-first regression.
  const offTopic = parsed.filter(
    (e) => /^\s*(user|ai|the user|assistant)\b/i.test(e.content) || /^\s*\[/.test(e.content)
  ).length;
  if (parsed.length > 0 && offTopic > 0) {
    console.log(
      `[hicortex]     topic-first check: ${offTopic}/${parsed.length} entries look actor/bracket-led (prompt may be ignored)`
    );
  }

  const entries: DistilledEntry[] = [];
  const substanceDropped: string[] = [];
  const volatileDropped: string[] = [];
  for (const entry of parsed) {
    if (!hasMinimalSubstance(entry.content)) {
      substanceDropped.push(entry.content);
      continue;
    }
    // #489 volatility gate (owner decision 2: entry-level, deterministic,
    // beside the substance gate — cleanMessageContent untouched): GH-ticket /
    // version-bump / commit-state status shapes drop into the SAME #156
    // trail (owner decision 1: mark-and-skip, never silent). Kill-switch =
    // the release-managed calibration constant (owner decision 5).
    if (VOLATILE_STATUS_FILTER && isVolatileStatusEntry(entry.content)) {
      volatileDropped.push(entry.content);
      continue;
    }
    entries.push(entry);
  }
  const dropped = [...substanceDropped, ...volatileDropped];
  for (const [label, list] of [
    ["Substance gate", substanceDropped],
    ["Volatility gate", volatileDropped],
  ] as const) {
    if (list.length === 0) continue;
    for (const d of list) {
      const preview = d.length > 120 ? `${d.slice(0, 120)}…` : d;
      console.log(`[hicortex]     ${label}: dropped "${preview}"`);
    }
    console.log(`[hicortex]     ${label}: dropped ${list.length}/${parsed.length} entr(ies)`);
  }
  // Parsed-zero bypass (#339 CR finding 2): a non-empty response with no
  // NO_EXTRACT token that still parses to zero bullets is the silent twin of
  // NO_EXTRACT — an empty verdict for the over-firing net.
  return { entries, dropped, emptyVerdict: parsed.length === 0 };
}

/**
 * The NO_EXTRACT check distillChunk applies to an LLM response. EXPORTED and
 * shared (not copy-pasted) with scripts/distill-ab-check/, whose counts must
 * classify empty verdicts exactly as production does (#339 CR finding 3).
 * Tolerant by design: a literal NO_EXTRACT anywhere in the first 20 chars
 * counts (models prepend stray whitespace or a short phrase).
 */
export function isNoExtractResponse(result: string): boolean {
  return result === "NO_EXTRACT" || result.slice(0, 20).includes("NO_EXTRACT");
}

/**
 * Split transcript text into chunks at natural boundaries (double newlines).
 * Each chunk is at most maxChars, split at the last paragraph boundary.
 */
function splitIntoChunks(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxChars) {
      chunks.push(remaining);
      break;
    }

    // Find the last paragraph break within maxChars
    let splitAt = remaining.lastIndexOf("\n\n", maxChars);
    if (splitAt < maxChars * 0.5) {
      // No good paragraph break — fall back to last newline
      splitAt = remaining.lastIndexOf("\n", maxChars);
    }
    if (splitAt < maxChars * 0.3) {
      // No good break at all — hard split
      splitAt = maxChars;
    }

    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  return chunks.filter((c) => c.length >= MIN_CONVERSATION_CHARS);
}

// Entries longer than this trivially carry substance; the cap short-circuits
// the checks below and bounds every regex to a small input, so no pathological
// input can make the gate expensive (#156).
const MAX_GATE_LENGTH = 2000;

/**
 * Reject ONLY structurally-empty distiller fragments before they become
 * memories (#156). The distiller occasionally emits leftovers that parse into
 * entries but carry no recallable content:
 *   - bare section prefixes:        "[Specific AI Content:]", "[Facts Learned]"
 *   - echoed template placeholders: "[decision]: [reasoning] (2026-07-05)"
 *   - pseudo-header bullets:        "**Facts Learned:**"
 *   - metadata-only lines:          "(2026-07-05)"
 *
 * PRECISION OVER RECALL — deliberate trade: the gate rejects only shapes that
 * are structurally empty of content, never on a length or word-count threshold.
 * A kept artifact ("Classification: WORK" style) is cheaply pruned later by the
 * no-fit decay path; a wrongly-dropped genuine memory is unrecoverable. So when
 * in doubt, keep. Consequence documented for the reviewer: metadata lines like
 * "Classification: WORK" now PASS the gate — that is intended.
 *
 * Stripping is scoped and anchored (one leading section prefix, one trailing
 * date stamp), never global, so bracketed payloads ("use [ollama] not
 * [claude-cli]") and content-bearing dates ("deadline moved (2026-08-01)")
 * survive. Stripping affects only this gate's decision, never stored text.
 */
export function hasMinimalSubstance(entry: string): boolean {
  const raw = entry.trim();
  if (raw.length > MAX_GATE_LENGTH) return true;
  // Strip ONE leading section prefix (anchored + length-bounded, never global).
  let body = raw.replace(/^\[[^\]]{0,80}\]\s*/, "");
  // Strip ONE trailing date stamp (anchored to end).
  body = body.replace(/\(\s*\d{4}-\d{2}-\d{2}\s*\)\s*$/, "");
  // Markdown decoration.
  body = body.replace(/[*_`#>]/g, " ").trim();
  if (!body) return false; // metadata-only line or bare section prefix
  if (/:$/.test(body)) return false; // pseudo-header: "Facts Learned:"
  // Pure placeholder echo — nothing but bracketed tokens and separators,
  // e.g. "[decision]: [reasoning]".
  if (/^(?:\[[^\]]{0,80}\]|[\s:.,;–-])+$/.test(body)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Volatility gate (#489) — deterministic, entry-level, beside the substance
// gate. Owner directive (gold-set A adjudication): GitHub ticket/workflow
// states and version numbers churn faster than nightly consolidation retires
// them — they arrive as supersession noise and inflate the store with
// same-subject rows. The ephemera PROMPT already names these categories and
// demonstrably under-fires (a month of it running, gold A still full of
// GH-status/version rows) — so the filter is deterministic, catching entries
// synthesized from ANY source prose.
// ---------------------------------------------------------------------------

/**
 * Durability escapes — decision/policy predicates that OVERRIDE every
 * volatility trigger (#489 spec): "switched from X to Y" is a durable model
 * choice even though it names two versions; a version boundary is a policy
 * even though it cites one. Whole-word, case-insensitive. Version numbers
 * never trigger alone — version + STATUS-verb triggers; version +
 * DECISION-verb escapes.
 */
const VOLATILE_ESCAPES: RegExp =
  /\b(?:switch(?:ed)?\s+from|adopt(?:ed)?|standardi[sz]ed|deprecated|polic(?:y|ies)|rule|boundary|convention|must|never|always|only\s+when)\b/i;

/** T1 — GH ticket/workflow status: a #number ticket + a status predicate, or
 *  a workflow-run shape (checks/CI outcome, test-count status). */
const TICKET_REF = /(?:^|[\s(#])(?:pr|issue|epic)?\s*#\d+/i;
const TICKET_STATUS =
  /\b(?:merged?|closed?|reopened?|opened?|approved?|blocked?|failing|pass(?:ed|ing)?|green|red|ready|draft)\b/i;
const WORKFLOW_STATUS =
  /\b(?:checks?\s+(?:passed|failed|green|red)|ci\s+(?:green|red)|\d+\s+tests?\s+(?:pass(?:ed|ing)?|fail(?:ed|ing)?))\b/i;

/** T2 — version-bump status: a semver-ish number + a release verb, or a
 *  version→version transition. The `\b` boundary keeps "Qwen3.6" (no
 *  boundary between n and 3) from matching — model names are not versions. */
const SEMVERISH = /\bv?\d+\.\d+(?:\.\d+)?\b/;
const RELEASE_VERB =
  /\b(?:released?|deployed?|promoted?|published?|tagged?|bumped?|cut|shipped?|rolled?\s+out|dist-tags?)\b/i;
const VERSION_TRANSITION =
  /\bv?\d+\.\d+(?:\.\d+)?\b[^.\d]{0,20}(?:→|->|to)\s*v?\d+\.\d+(?:\.\d+)?\b/i;

/** T3 — branch/commit state: a short sha (7-40 hex, word-bounded) + a
 *  vcs-motion verb. The SHA is the discriminator, so the verb list is bare
 *  ("rebased feature branch onto 4f9c1ab" must fire); a durable narrative
 *  carrying a sha + verb rides the escape list or the length cap. */
const SHORT_SHA = /\b[0-9a-f]{7,40}\b/;
const VCS_STATE =
  /\b(?:pushed?|merged?|rebased?|force-?pushed?|updated?)\b/i;

/**
 * True when the entry is a VOLATILE STATUS SHAPE — GH-ticket/workflow status,
 * version-bump status, or branch/commit state — and carries no durability
 * escape (#489, owner decisions 1+2). Runs in distillChunk's gate zone beside
 * hasMinimalSubstance; drops ride the SAME #156 dropped[] trail. Also reused
 * verbatim by `hicortex sweep-volatile` over the stored corpus — ONE gate,
 * one meaning.
 *
 * PRECISION OVER RECALL (the substance gate's law, inherited): escapes are
 * checked FIRST and override every trigger; entries longer than
 * VOLATILE_GATE_MAX_CHARS are treated as mixed prose whose status clause is
 * not the DOMINANT content (kept). Accepted false-positive mode, stated
 * plainly: an entry pairing a status clause with a distinct durable clause
 * and no escape word drops, losing the durable half — unless the distiller
 * emitted that half as its own entry, which is exactly what the ephemera
 * prompt tells it to do. Every drop is auditable via the trail.
 */
export function isVolatileStatusEntry(entry: string): boolean {
  const raw = entry.trim();
  if (!raw || raw.length > VOLATILE_GATE_MAX_CHARS) return false;
  if (VOLATILE_ESCAPES.test(raw)) return false;

  const ticketStatus = TICKET_REF.test(raw) && TICKET_STATUS.test(raw);
  const workflowStatus = WORKFLOW_STATUS.test(raw);
  // A version number + release verb, OR a bare version→version transition
  // (the transition fires without a verb — "0.22.2 → 0.22.3 on rc" is a
  // version-bump status; the escape list carries the durable flips).
  const versionBump =
    (SEMVERISH.test(raw) && RELEASE_VERB.test(raw)) || VERSION_TRANSITION.test(raw);
  const commitState = SHORT_SHA.test(raw) && VCS_STATE.test(raw);
  return ticketStatus || workflowStatus || versionBump || commitState;
}

/**
 * A parsed distillation entry: the stored content (type tag STRIPPED) plus the
 * classified memory_type. `memoryType` is one of "experience" | "knowledge" |
 * "decisions" — the three distillation-time types. "learnings" is deliberately
 * absent: learnings are the reflection stage's product, never distillation's
 * (#216). A missing/unknown tag defaults to "experience" so older distiller
 * output (pre-#216, no tag) stays backward-compatible.
 */
export interface DistilledEntry {
  content: string;
  memoryType: "experience" | "knowledge" | "decisions";
}

/**
 * Map a single-letter type tag to the stored memory_type. Unknown/absent →
 * experience (the pre-#216 default). `[L]` is explicitly rejected →
 * experience: the distiller must NEVER emit learnings (that's the reflection
 * stage's job), so a model that emits `[L]` is wrong and we do not propagate
 * it as a learning.
 *
 * The single-letter tags ([E]/[K]/[D]) are unchanged from the raw-enum era —
 * the model is taught these as "EXPERIENCE/KNOWLEDGE/DECISIONS" concepts in prompts.ts
 * (ordinary English the model understands), and only the resulting STORED
 * value changed in #264 (episode→experience, fact→knowledge, decision→
 * decisions). The tag letters stay stable so neither the prompt nor the
 * parser needs to change; only this mapping table moves.
 *
 * EXPORTED (with parseDistilledEntries) for scripts/distill-ab-check/ (#339 CR
 * finding 3): the A/B harness computes its counts from each variant build's own
 * parser instead of a copy-pasted mirror, so harness numbers are by construction
 * the numbers that build's production would store. tests/distill-ab-parser-contract.test.ts
 * pins the src and dist parsers against the same corpus.
 */
export function typeFromTag(letter: string | undefined): DistilledEntry["memoryType"] {
  switch (letter) {
    case "K":
    case "k":
    case "F":  // legacy tag (was Fact)
    case "f":
      return "knowledge";
    case "D":
    case "d":
      return "decisions";
    // E, e, L, l (rejected), undefined, or anything else → experience.
    default:
      return "experience";
  }
}

/**
 * Parse distilled markdown into individual memory entries with type tags.
 * Each bullet becomes a separate memory. The leading `[E]`/`[F]`/`[D]` type
 * tag is extracted (→ memoryType), stripped from the stored content, and
 * passed to `insertMemory` via the `memoryType` option (#216). Bullets with
 * no tag default to "experience" (backward compatible with pre-#216 distiller
 * output that never carried a tag). EXPORTED for the A/B harness — see
 * typeFromTag's comment (#339 CR finding 3).
 */
export function parseDistilledEntries(markdown: string): DistilledEntry[] {
  const entries: DistilledEntry[] = [];
  const lines = markdown.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip all markdown headers (session title, section headings). Sections
    // are NOT prefixed onto entries: each bullet already starts with its type
    // tag + [SUBJECT] (topic-first, enforced by prompts.ts), and prepending
    // "[Section]" re-introduced the category-first prefix the 2026-08-02
    // corpus rewrite removed.
    if (
      trimmed.startsWith("# ") ||
      trimmed.startsWith("## ") ||
      trimmed.startsWith("### ")
    ) {
      continue;
    }

    // Bullet items are individual, already topic-first memories.
    if (trimmed.startsWith("- ") && trimmed.length > 5) {
      const body = trimmed.slice(2);
      // Extract an optional leading single-letter type tag: "[E]", "[F]",
      // "[D]" (case-insensitive). The tag must be the very first token of the
      // bullet — a bracket that appears later is payload, not a type tag.
      const tagMatch = body.match(/^\[([EFDKefdklL])\]\s*/);
      if (tagMatch) {
        const memoryType = typeFromTag(tagMatch[1].toUpperCase());
        entries.push({ content: body.slice(tagMatch[0].length), memoryType });
      } else {
        // No tag → experience (pre-#216 distiller output, or a model that
        // skipped the tag). Keep the content verbatim.
        entries.push({ content: body, memoryType: "experience" });
      }
    }
  }

  return entries;
}
