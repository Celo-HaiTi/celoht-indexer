import { logger } from "@/util/logger";

/**
 * Wraps an RPC call with exponential backoff. Used around log fetches and
 * block/receipt lookups so transient RPC failures don't crash the process
 * or silently drop a batch of events.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { maxRetries: number; baseDelayMs?: number; maxDelayMs?: number; label: string }
): Promise<T> {
  const baseDelay = opts.baseDelayMs ?? 500;
  const maxDelay = opts.maxDelayMs ?? 10_000;
  let lastError: unknown;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === opts.maxRetries) break;
      const delay = Math.min(baseDelay * 2 ** attempt, maxDelay);
      logger.warn("rpc_retry", { label: opts.label, attempt, delayMs: delay, error: String(err) });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
