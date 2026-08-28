/**
 * Local embeddings using @huggingface/transformers.
 * Ported from hicortex/embedder.py — same model (bge-small-en-v1.5, 384-dim).
 *
 * Uses dynamic import so the plugin compiles without @huggingface/transformers
 * installed. The model is lazy-loaded on first call.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const EMBEDDING_DIMENSIONS = 384;
const MODEL_NAME = "Xenova/bge-small-en-v1.5";

// Pipeline is lazy-loaded on first use
let pipeline: any = null;
let initPromise: Promise<void> | null = null;

/**
 * Resolve the directory where @huggingface/transformers caches model weights.
 *
 * Exported as a pure function so it can be unit-tested without mocking the
 * dynamic import. The default (`~/.hicortex/models`) is stable across package
 * upgrades and writable by the installing user even under global npm installs
 * (where the package dir is root-owned).
 *
 * @param home Override for the user home directory (used in tests).
 */
export function resolveModelCacheDir(home?: string): string {
  return join(home ?? homedir(), ".hicortex", "models");
}

/**
 * Initialize the embedding pipeline (called lazily on first embed call).
 * Throws with a clear error if @huggingface/transformers is not available.
 */
async function ensureInit(): Promise<void> {
  if (pipeline) return;
  if (initPromise) {
    await initPromise;
    return;
  }

  initPromise = (async () => {
    try {
      // Dynamic import — package may not be installed (it's optional)
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const transformers = await (Function('return import("@huggingface/transformers")')() as Promise<any>);

      // Point the model cache at a stable user-writable directory so the
      // ~130 MB weights survive package upgrades and work under global installs
      // (the package dir is root-owned; defaulting to it causes EACCES).
      const cacheDir = resolveModelCacheDir();
      mkdirSync(cacheDir, { recursive: true });
      const env = transformers.env ?? (transformers as any).default?.env;
      if (env) {
        env.cacheDir = cacheDir;
      }
      console.log(`[hicortex] Model cache: ${cacheDir}`);

      const pipelineFn =
        transformers.pipeline ?? (transformers as any).default?.pipeline;
      if (!pipelineFn) {
        throw new Error(
          "Could not find pipeline function in @huggingface/transformers"
        );
      }
      console.log("[hicortex] Loading embedding model (first run downloads ~130MB)...");
      pipeline = await pipelineFn("feature-extraction", MODEL_NAME, {
        dtype: "fp32",
      });
      console.log("[hicortex] Embedding model ready");
    } catch (err: unknown) {
      initPromise = null;
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes("Cannot find module") ||
        msg.includes("MODULE_NOT_FOUND")
      ) {
        throw new Error(
          `@huggingface/transformers is not installed. ` +
            `Run: npm install @huggingface/transformers`
        );
      }
      throw err;
    }
  })();

  await initPromise;
}

/**
 * Embed a single text string. Returns a Float32Array of 384 dimensions.
 */
export async function embed(text: string): Promise<Float32Array> {
  await ensureInit();
  const output = await pipeline(text, { pooling: "mean", normalize: true });
  // output.data is a Float32Array from transformers.js
  return new Float32Array(output.data);
}

/**
 * Embed multiple texts. Returns an array of Float32Array embeddings.
 */
export async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  // Process sequentially to avoid OOM on large batches
  const results: Float32Array[] = [];
  for (const text of texts) {
    results.push(await embed(text));
  }
  return results;
}

/**
 * Fire-and-forget embedder warm-up (#329 item 2), called at the END of server
 * boot. The ONNX pipeline lazy-loads inside the first embed() (~0.5-3s cold),
 * so without this the FIRST /recall-index after every restart paid the model
 * load inside its own latency budget — the 1s client hook budget blows and
 * that turn silently loses recall.
 *
 * Contract (unit-pinned in tests/embedder-warm.test.ts):
 *   - fires exactly ONE embed call ("warmup"), NEVER awaited — returns
 *     synchronously so boot/listen is never blocked;
 *   - a failing warm-up is logged once (console.warn) and swallowed —
 *     warm-up is an optimization, never a boot dependency. The next real
 *     embed() retries the lazy load on its own terms.
 *
 * `embedFn` is injectable for tests; production passes the module's embed().
 *
 * MEMORY NOTE (accepted trade-off, #329 CR finding 3): warming at boot makes
 * the model (~150-300MB resident) load in every server process from startup —
 * including idle hosted tenant containers, which previously never loaded it.
 * Accepted at current hosted sizing (2g per-tenant caps; active tenants load
 * it on first use anyway). See the warm-site comment in mcp-server.ts.
 */
export function warmEmbedder(
  embedFn: (text: string) => Promise<Float32Array> = embed
): void {
  embedFn("warmup").catch((err: unknown) => {
    console.warn(
      `[hicortex] Embedder warm-up failed (first search will lazy-load instead): ` +
        (err instanceof Error ? err.message : String(err))
    );
  });
}

/**
 * Return the embedding dimension count.
 */
export function dimensions(): number {
  return EMBEDDING_DIMENSIONS;
}
