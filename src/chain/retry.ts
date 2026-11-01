import { logger } from "@/util/logger";
import { serializeError } from "@/util/errorSerializer";

export type RpcErrorCategory = "historical_retention_limit" | "range_limit" | "rate_limit" | "invalid_request" | "transient";

export class RpcProviderCapabilityError extends Error {
  constructor(
    message: string,
    readonly category: "historical_retention_limit" | "range_limit" | "invalid_request",
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "RpcProviderCapabilityError";
  }
}

export function classifyRpcError(error: unknown): RpcErrorCategory {
  const detail = extractRpcErrorDetail(error).toLowerCase();
  if (
    /more than\s+\d+\s+blocks? behind|historical (?:block|state|data)|(?:block|state) prun(?:ed|ing)|retention limit|archive data unavailable/.test(detail)
  ) return "historical_retention_limit";
  if (
    /block range|range limit|maximum (?:block )?range|range (?:is )?too (?:large|wide)|too many results|query returned more than|exceeds? (?:the )?max(?:imum)? .*blocks?/.test(detail)
  ) return "range_limit";
  if (/rate.?limit|too many requests|request limit exceeded|status(?:code)?["=: ]+429|\b429\b|\b-32005\b/.test(detail)) {
    return "rate_limit";
  }
  if (/\b-32602\b|invalid params?|invalid argument/.test(detail)) return "invalid_request";
  return "transient";
}

/**
 * Wraps an RPC call with exponential backoff. Used around log fetches and
 * block/receipt lookups so transient RPC failures don't crash the process
 * or silently drop a batch of events.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: {
    maxRetries: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    label: string;
    endpointRole?: "live" | "archive";
    requestedBlock?: string;
    requestedRange?: string;
  }
): Promise<T> {
  const baseDelay = opts.baseDelayMs ?? 500;
  const maxDelay = opts.maxDelayMs ?? 10_000;
  let lastError: unknown;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const category = classifyRpcError(err);
      if (category === "historical_retention_limit" || category === "invalid_request") {
        logger.error("rpc_provider_capability_error", {
          label: opts.label,
          endpointRole: opts.endpointRole ?? "unknown",
          requestedBlock: opts.requestedBlock ?? null,
          requestedRange: opts.requestedRange ?? null,
          errorCategory: category,
          error: serializeError(err),
        });
        throw new RpcProviderCapabilityError(
          `${opts.label} failed permanently (${category})`,
          category,
          { cause: err }
        );
      }
      if (category === "range_limit") throw err;
      if (attempt === opts.maxRetries) break;
      const delay = Math.min(baseDelay * 2 ** attempt, maxDelay);
      logger.warn("rpc_retry", {
        label: opts.label,
        endpointRole: opts.endpointRole ?? "unknown",
        requestedBlock: opts.requestedBlock ?? null,
        requestedRange: opts.requestedRange ?? null,
        errorCategory: category,
        attempt,
        delayMs: delay,
        error: serializeError(err),
      });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

function extractRpcErrorDetail(error: unknown, seen = new WeakSet<object>()): string {
  if (typeof error === "string") return error;
  if (!error || typeof error !== "object" || seen.has(error)) return "";
  seen.add(error);

  const value = error as Record<string, unknown>;
  const fields = ["code", "message", "shortMessage", "details", "metaMessages"];
  const ownDetail = fields
    .map((field) => value[field])
    .filter((field) => typeof field === "string" || typeof field === "number")
    .map(String)
    .join(" ");
  return [
    ownDetail,
    extractRpcErrorDetail(value.cause, seen),
    extractRpcErrorDetail(value.data, seen),
    extractRpcErrorDetail(value.error, seen),
    extractRpcErrorDetail(value.response, seen),
  ].filter(Boolean).join(" ");
}
