/**
 * Tiny, dependency-free argv helpers for cli.ts. Kept in their own module so
 * cli.ts can import them statically without pulling in a heavy command module
 * (its command handlers stay lazily `import()`-ed).
 */

/** Thrown when a value-flag is present but missing its value. */
export class MissingFlagValueError extends Error {}

/**
 * Read a required value for `flag` from `argv`. Returns undefined when the flag
 * is absent; throws MissingFlagValueError when it is present without a value
 * (end of args) OR the next token is itself a flag (starts with "-"). The
 * latter guard stops `--agent-name --server <url>` from silently swallowing
 * `--server` as the agent name — a typo must be loud.
 */
export function readValueFlag(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i === -1) return undefined;
  const val = argv[i + 1];
  if (val === undefined || val.startsWith("-")) {
    throw new MissingFlagValueError(`${flag} requires a value`);
  }
  return val;
}
