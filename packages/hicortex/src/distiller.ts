/**
 * Session knowledge extraction (distillation).
 * Simplified from hicortex/distiller.py — messages come from agent_end hook,
 * not from filesystem scanning.
 */

import type { LlmClient } from "./llm.js";
import { distillation } from "./prompts.js";
import { redact, type RedactionConfig } from "./redact.js";

const MAX_TRANSCRIPT_CHARS = 80_000;
const MIN_CONVERSATION_CHARS = 200;

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
 */
export async function distillSession(
  llm: LlmClient,
  conversation: string,
  projectName: string,
  date: string,
  chunkSizeChars?: number,
  droppedOut?: string[]
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
    const { entries, dropped } = await distillChunk(llm, transcript, projectName, date);
    if (droppedOut) droppedOut.push(...dropped);
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
  let lastError: Error | null = null;

  for (let i = 0; i < chunks.length; i++) {
    console.log(`[hicortex]     Chunk ${i + 1}/${chunks.length} (${chunks[i].length} chars)`);
    try {
      const { entries, dropped } = await distillChunk(llm, chunks[i], projectName, date);
      if (droppedOut) droppedOut.push(...dropped);
      for (const entry of entries) {
        // Deduplicate by normalized content (type tag does not participate —
        // two chunks extracting the same fact should collapse regardless of
        // whether one tagged it [F] and the other [E]).
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

  return allEntries;
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
 */
async function distillChunk(
  llm: LlmClient,
  transcript: string,
  projectName: string,
  date: string
): Promise<{ entries: DistilledEntry[]; dropped: string[] }> {
  const prompt = distillation(projectName, date, transcript);

  // NOTE: Intentionally no try/catch here. Transient LLM errors (network
  // failures, 4xx/5xx, model-not-found, timeouts) propagate up to the caller
  // so the nightly pipeline can treat them as "retry later" instead of
  // "processed successfully with zero extractions".
  const { text: result } = await llm.completeDistill(prompt);
  if (!result) return { entries: [], dropped: [] };
  if (result === "NO_EXTRACT" || result.slice(0, 20).includes("NO_EXTRACT")) {
    return { entries: [], dropped: [] };
  }

  const parsed = parseDistilledEntries(result);

  // Smoke alarm (PR #218 review): the prompt enforces topic-first, but models
  // sometimes ignore constraints (cf. the prior max-15-bullet failure). Count
  // entries that still look actor-led or bracket-led so a format regression
  // shows in nightly logs, not months later in the next eval. Non-blocking.
  // Note: the type tag ([E]/[F]/[D]) is already stripped by the parser, so a
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
  const dropped: string[] = [];
  for (const entry of parsed) {
    if (hasMinimalSubstance(entry.content)) {
      entries.push(entry);
    } else {
      dropped.push(entry.content);
    }
  }
  if (dropped.length > 0) {
    for (const d of dropped) {
      const preview = d.length > 120 ? `${d.slice(0, 120)}…` : d;
      console.log(`[hicortex]     Substance gate: dropped "${preview}"`);
    }
    console.log(
      `[hicortex]     Substance gate: dropped ${dropped.length}/${parsed.length} content-free fragment(s)`
    );
  }
  return { entries, dropped };
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

/**
 * A parsed distillation entry: the stored content (type tag STRIPPED) plus the
 * classified memory_type. `memoryType` is one of "episode" | "fact" |
 * "decision" — the three distillation-time types. "lesson" is deliberately
 * absent: lessons are the reflection stage's product, never distillation's
 * (#216). A missing/unknown tag defaults to "episode" so older distiller
 * output (pre-#216, no tag) stays backward-compatible.
 */
export interface DistilledEntry {
  content: string;
  memoryType: "episode" | "fact" | "decision";
}

/**
 * Map a single-letter type tag to the stored memory_type. Unknown/absent →
 * episode (the pre-#216 default). `[L]` is explicitly rejected → episode: the
 * distiller must NEVER emit lessons (that's the reflection stage's job), so a
 * model that emits `[L]` is wrong and we do not propagate it as a lesson.
 */
function typeFromTag(letter: string | undefined): DistilledEntry["memoryType"] {
  switch (letter) {
    case "F":
    case "f":
      return "fact";
    case "D":
    case "d":
      return "decision";
    // E, e, L, l (rejected), undefined, or anything else → episode.
    default:
      return "episode";
  }
}

/**
 * Parse distilled markdown into individual memory entries with type tags.
 * Each bullet becomes a separate memory. The leading `[E]`/`[F]`/`[D]` type
 * tag is extracted (→ memoryType), stripped from the stored content, and
 * passed to `insertMemory` via the `memoryType` option (#216). Bullets with
 * no tag default to "episode" (backward compatible with pre-#216 distiller
 * output that never carried a tag).
 */
function parseDistilledEntries(markdown: string): DistilledEntry[] {
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
      const tagMatch = body.match(/^\[([EFDefdLl])\]\s*/);
      if (tagMatch) {
        const memoryType = typeFromTag(tagMatch[1].toUpperCase());
        entries.push({ content: body.slice(tagMatch[0].length), memoryType });
      } else {
        // No tag → episode (pre-#216 distiller output, or a model that
        // skipped the tag). Keep the content verbatim.
        entries.push({ content: body, memoryType: "episode" });
      }
    }
  }

  return entries;
}
