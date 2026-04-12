/**
 * Pre-ingestion redaction — scrubs secrets and PII from transcript text
 * BEFORE it reaches the distillation LLM or storage.
 *
 * Why this exists:
 *   - Session transcripts contain tool output: file reads, command output,
 *     env var dumps. These regularly contain API keys, tokens, and paths.
 *   - The distillation LLM is often remote (e.g., Ollama on MBP via
 *     Tailscale). Secrets in the transcript travel over the network.
 *   - Even if the LLM correctly classifies the memory as SENSITIVE, the
 *     secret is already stored and searchable via hicortex_search.
 *   - Redaction runs BEFORE the LLM sees the text, eliminating the risk.
 *
 * Default patterns cover common API key formats, bearer tokens, absolute
 * paths, and generic key=value secrets. Users can add custom patterns via
 * config.json "redaction.extraPatterns".
 *
 * The replacement is always [REDACTED] (or configurable). This preserves
 * the structure of the text so the LLM can still extract useful knowledge
 * from the surrounding context.
 */

/** Result of a redaction pass. */
export interface RedactionResult {
  /** The redacted text. */
  text: string;
  /** Number of individual redactions applied. */
  count: number;
}

/** Configuration for redaction, read from config.json. */
export interface RedactionConfig {
  /** Master switch. Default: true. */
  enabled?: boolean;
  /** Additional regex patterns (strings, compiled to RegExp with 'g' flag). */
  extraPatterns?: string[];
  /** Replacement string. Default: "[REDACTED]". */
  replacement?: string;
}

/**
 * Default redaction patterns. Each targets a specific class of secret.
 * Order matters: more specific patterns should come first to avoid
 * partial matches by generic patterns.
 */
const DEFAULT_PATTERNS: { name: string; pattern: RegExp }[] = [
  // Anthropic API keys: sk-ant-api03-...
  { name: "anthropic_key", pattern: /sk-ant-[a-zA-Z0-9\-_]{20,}/g },

  // OpenAI API keys: sk-proj-... or sk-...
  { name: "openai_key", pattern: /sk-(?:proj-)?[a-zA-Z0-9]{20,}/g },

  // Hicortex license keys: hctx-... (case-insensitive — keys could appear uppercased in logs)
  { name: "hicortex_key", pattern: /hctx-[a-f0-9]{16}/gi },

  // GitHub Personal Access Tokens: ghp_...
  { name: "github_pat", pattern: /ghp_[a-zA-Z0-9]{36}/g },

  // GitHub OAuth tokens: gho_...
  { name: "github_oauth", pattern: /gho_[a-zA-Z0-9]{36}/g },

  // Google API keys: AIza...
  { name: "google_key", pattern: /AIza[a-zA-Z0-9_\-]{35}/g },

  // AWS access keys: AKIA...
  { name: "aws_key", pattern: /AKIA[A-Z0-9]{16}/g },

  // Stripe live/test keys: sk_live_..., sk_test_...
  { name: "stripe_key", pattern: /sk_(?:live|test)_[a-zA-Z0-9]{20,}/g },

  // Bearer tokens in headers (case-insensitive — headers are case-insensitive)
  { name: "bearer_token", pattern: /[Bb]earer\s+[a-zA-Z0-9._\-]{20,}/g },

  // Generic secret assignments: password=..., secret_key=..., token: ...
  // Matches key=value and key: value patterns with common secret key names.
  // The key name can have underscores/hyphens and optional suffixes (SECRET_KEY, api-key, etc.)
  // Negative lookahead for [REDACTED] prevents double-counting when a prior pattern
  // already replaced the value (e.g., bearer_token fires, then generic_secret sees
  // "token: [REDACTED]" and would otherwise match again).
  { name: "generic_secret", pattern: /(?:password|secret(?:[_-]?key)?|token|api[_-]?key|private[_-]?key|access[_-]?key)\s*[:=]\s*["']?(?!\[REDACTED\])[^\s"']{8,}["']?/gi },

  // Absolute macOS paths: /Users/<username>/...
  // Negative lookbehind avoids matching URL paths like https://api.example.com/Users/list
  { name: "macos_path", pattern: /(?<![:/])\/Users\/[a-zA-Z0-9._-]+/g },

  // Absolute Linux home paths: /home/<username>/...
  // Same lookbehind to avoid URL false positives
  { name: "linux_path", pattern: /(?<![:/])\/home\/[a-zA-Z0-9._-]+/g },
];

/**
 * Redact secrets and PII from text.
 *
 * @param text The raw transcript text to redact
 * @param config Optional configuration (extra patterns, replacement string)
 * @returns The redacted text and count of redactions applied
 */
export function redact(text: string, config?: RedactionConfig): RedactionResult {
  if (config?.enabled === false) return { text, count: 0 };

  const replacement = config?.replacement ?? "[REDACTED]";
  let count = 0;
  let result = text;

  // Apply default patterns
  for (const { pattern } of DEFAULT_PATTERNS) {
    // Reset lastIndex for global regexes (they're stateful)
    pattern.lastIndex = 0;
    result = result.replace(pattern, () => {
      count++;
      return replacement;
    });
  }

  // Apply user-configured extra patterns
  if (config?.extraPatterns) {
    for (const patternStr of config.extraPatterns) {
      try {
        const re = new RegExp(patternStr, "g");
        result = result.replace(re, () => {
          count++;
          return replacement;
        });
      } catch {
        // Invalid regex — skip silently (don't crash the pipeline)
      }
    }
  }

  return { text: result, count };
}
