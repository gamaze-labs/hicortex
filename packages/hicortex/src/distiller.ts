/**
 * Session knowledge extraction (distillation).
 * Simplified from hicortex/distiller.py — messages come from agent_end hook,
 * not from filesystem scanning.
 */

import type { LlmClient } from "./llm.js";
import { distillation } from "./prompts.js";

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
 * - Ollama: query /api/show for context_length AND parameter_count, cap based on both
 * - Small models (<8B params): max 20K chars (~5K tokens) — keeps CPU inference under ~60s
 * - Larger models: up to 60K chars (~15K tokens)
 * - Fallback: 20K chars
 */
export async function detectChunkSize(
  provider: string,
  model: string,
  baseUrl?: string
): Promise<number> {
  // API-based providers handle large contexts natively — no chunking needed
  if (provider !== "ollama") {
    return MAX_TRANSCRIPT_CHARS;
  }

  // Query Ollama for model metadata
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

        // Extract context length for context-aware capping
        const ctxKey = Object.keys(info).find(
          (k) => k.endsWith("context_length") || k.endsWith("context_window")
        );
        const contextTokens = ctxKey && typeof info[ctxKey] === "number"
          ? (info[ctxKey] as number)
          : 0;

        // Determine max chunk size based on model size (speed constraint)
        // Unknown param count defaults to conservative (small model) — safe for any hardware
        const maxBySpeed = !isSmallModel && paramCount > 0 ? LARGE_MODEL_MAX_CHUNK_CHARS : SMALL_MODEL_MAX_CHUNK_CHARS;

        // Determine max chunk size based on context window (fits-in-context constraint)
        const maxByContext = contextTokens > 0
          ? Math.floor(contextTokens * 0.6 * 4) // 60% of context, ~4 chars/token
          : MAX_TRANSCRIPT_CHARS;

        const chunkChars = Math.min(maxBySpeed, maxByContext);
        console.log(
          `[hicortex]     Model: ${paramCount > 0 ? `${(paramCount / 1e9).toFixed(1)}B params` : "unknown size"}, ` +
          `context: ${contextTokens > 0 ? `${contextTokens} tokens` : "unknown"}, ` +
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
 * Convert OpenClaw hook messages to a filtered transcript string.
 */
export function extractConversationText(messages: unknown[]): string {
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

  return parts.join("\n\n");
}

/**
 * Send filtered conversation to LLM for knowledge extraction.
 * For large transcripts, chunks into segments to avoid overwhelming small models.
 * Returns an array of memory entries to ingest, or empty array if nothing worth extracting.
 */
export async function distillSession(
  llm: LlmClient,
  conversation: string,
  projectName: string,
  date: string,
  chunkSizeChars?: number
): Promise<string[]> {
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
    return distillChunk(llm, transcript, projectName, date);
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
  const allEntries: string[] = [];
  const seen = new Set<string>();
  let chunkFailures = 0;
  let lastError: Error | null = null;

  for (let i = 0; i < chunks.length; i++) {
    console.log(`[hicortex]     Chunk ${i + 1}/${chunks.length} (${chunks[i].length} chars)`);
    try {
      const entries = await distillChunk(llm, chunks[i], projectName, date);
      for (const entry of entries) {
        // Deduplicate by normalized content
        const key = entry.toLowerCase().replace(/\s+/g, " ").slice(0, 100);
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
 *   - Returns `[]` for legitimate empty results (NO_EXTRACT, empty LLM response,
 *     transcript produced no entries). These are terminal states — the chunk was
 *     processed successfully, there's just nothing worth keeping.
 *   - Throws for transient errors (LLM unreachable, HTTP 4xx/5xx, timeout, model
 *     not found, rate limit). These MUST propagate so the nightly pipeline can
 *     distinguish "nothing to extract" from "try again later" and avoid
 *     advancing the last-run watermark past sessions it never actually processed.
 */
async function distillChunk(
  llm: LlmClient,
  transcript: string,
  projectName: string,
  date: string
): Promise<string[]> {
  const prompt = distillation(projectName, date, transcript);

  // NOTE: Intentionally no try/catch here. Transient LLM errors (network
  // failures, 4xx/5xx, model-not-found, timeouts) propagate up to the caller
  // so the nightly pipeline can treat them as "retry later" instead of
  // "processed successfully with zero extractions".
  const result = await llm.completeDistill(prompt);
  if (!result) return [];
  if (result === "NO_EXTRACT" || result.slice(0, 20).includes("NO_EXTRACT")) {
    return [];
  }

  return parseDistilledEntries(result);
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

/**
 * Parse distilled markdown into individual memory entry strings.
 * Each section item becomes a separate memory.
 */
function parseDistilledEntries(markdown: string): string[] {
  const entries: string[] = [];
  const lines = markdown.split("\n");
  let currentSection = "";

  for (const line of lines) {
    const trimmed = line.trim();

    // Section headers
    if (trimmed.startsWith("### ")) {
      currentSection = trimmed.slice(4).trim();
      continue;
    }

    // Skip top-level headers and classification
    if (trimmed.startsWith("# ") || trimmed.startsWith("## ")) continue;

    // Bullet items are individual memories
    if (trimmed.startsWith("- ") && trimmed.length > 5) {
      const entry = currentSection
        ? `[${currentSection}] ${trimmed.slice(2)}`
        : trimmed.slice(2);
      entries.push(entry);
    }
  }

  return entries;
}
