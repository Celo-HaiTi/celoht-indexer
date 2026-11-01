import { logger } from "@/util/logger";
import { formatErrorMessage, serializeError } from "@/util/errorSerializer";

export type RpcErrorCategory =
  | "historical_retention_limit"
  | "max_block_range"
  | "response_size_limit"
  | "too_many_logs"
  | "rate_limit"
  | "timeout"
  | "provider_internal"
  | "invalid_request"
  | "transient";

export class RpcProviderCapabilityError extends Error {
  constructor(
    message: string,
    readonly category: RpcErrorCategory,
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
  if (/rate.?limit|too many requests|request limit exceeded|status(?:code)?["=: ]+429|\b429\b/.test(detail)) return "rate_limit";
  if (/timed? ?out|timeout|etimedout|econnaborted|deadline exceeded|gateway timeout|\b408\b|\b504\b/.test(detail)) return "timeout";
  if (/response (?:size|body).*(?:limit|large)|payload too large|response too large|max(?:imum)? response bytes|content length exceeded/.test(detail)) {
    return "response_size_limit";
  }
  if (/too many (?:logs|results)|(?:logs|results) (?:limit|exceeded)|query returned more than|exceeds? .*?(?:logs|results)/.test(detail)) {
    return "too_many_logs";
  }
  if (/block range|range limit|maximum (?:block )?range|range (?:is )?too (?:large|wide)|max(?:imum)? block span|exceeds? (?:the )?max(?:imum)? .*blocks?/.test(detail)) {
    return "max_block_range";
  }
  if (/internal error|server error|-32603\b|\b5\d\d\b/.test(detail)) return "provider_internal";
  if (/\b-32602\b|invalid params?|invalid argument/.test(detail)) return "invalid_request";
  return "transient";
}

export function isSplittableLogRangeError(category: RpcErrorCategory): boolean {
  return category === "max_block_range" || category === "response_size_limit" || category === "too_many_logs";
}

export function sanitizedRpcMessage(error: unknown): string {
  return formatErrorMessage(error).slice(0, 1000);
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
          providerMessage: sanitizedRpcMessage(err),
          error: serializeError(err),
        });
        throw new RpcProviderCapabilityError(
          `${opts.label} failed permanently (${category})`,
          category,
          { cause: err }
        );
      }
      if (isSplittableLogRangeError(category)) throw err;
      if (attempt === opts.maxRetries) break;
      const exponentialDelay = baseDelay * 2 ** attempt;
      const retryAfterDelay = category === "rate_limit" ? getRetryAfterDelayMs(err) : 0;
      const delay = Math.min(Math.max(exponentialDelay, retryAfterDelay), maxDelay);
      logger.warn("rpc_retry", {
        label: opts.label,
        endpointRole: opts.endpointRole ?? "unknown",
        requestedBlock: opts.requestedBlock ?? null,
        requestedRange: opts.requestedRange ?? null,
        errorCategory: category,
        providerMessage: sanitizedRpcMessage(err),
        attempt,
        delayMs: delay,
        error: serializeError(err),
      });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

function getRetryAfterDelayMs(error: unknown): number {
  if (!error || typeof error !== "object") return 0;
  const root = error as Record<string, unknown>;
  const response = root.response && typeof root.response === "object" ? root.response as Record<string, unknown> : null;
  const headers = response?.headers ?? root.headers;
  let value: unknown;
  if (headers && typeof headers === "object" && "get" in headers && typeof headers.get === "function") {
    value = headers.get("retry-after");
  } else if (headers && typeof headers === "object") {
    const headerRecord = headers as Record<string, unknown>;
    value = headerRecord["retry-after"] ?? headerRecord["Retry-After"];
  }
  value ??= root.retryAfter;
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value * 1000);
  if (typeof value !== "string") return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? 0 : Math.max(0, date - Date.now());
}

function extractRpcErrorDetail(error: unknown, seen = new WeakSet<object>()): string {
  if (typeof error === "string") return error;
  if (!error || typeof error !== "object" || seen.has(error)) return "";
  seen.add(error);

  const value = error as Record<string, unknown>;
  const fields = ["code", "status", "statusCode", "httpStatus", "message", "shortMessage", "details", "metaMessages"];
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
