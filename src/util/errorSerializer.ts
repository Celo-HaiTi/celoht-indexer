export type SerializedValue =
  | null
  | boolean
  | number
  | string
  | SerializedValue[]
  | { [key: string]: SerializedValue };

const MAX_DEPTH = 6;
const MAX_PROPERTIES = 60;
const MAX_STRING_LENGTH = 4000;
const SENSITIVE_KEY = /authorization|cookie|api[-_]?key|service[-_]?role[-_]?key|private[-_]?key|password|passwd|secret|token|credential/i;
const SENSITIVE_ENV_NAME = /url|key|token|secret|password|credential|auth/i;
const DIAGNOSTIC_PROPERTIES = [
  "name",
  "message",
  "stack",
  "cause",
  "code",
  "status",
  "statusCode",
  "statusText",
  "details",
  "hint",
  "shortMessage",
  "metaMessages",
  "docsPath",
  "version",
  "response",
  "data",
  "body",
  "headers",
  "errno",
  "syscall",
  "requestId",
] as const;

export function serializeLogValue(value: unknown): SerializedValue {
  return serializeValue(value, new WeakSet<object>(), 0);
}

export function serializeError(error: unknown): Record<string, SerializedValue> {
  const serialized = serializeLogValue(error);
  if (serialized !== null && typeof serialized === "object" && !Array.isArray(serialized)) {
    return serialized;
  }
  return { message: serialized };
}

export function formatErrorMessage(error: unknown): string {
  const serialized = serializeError(error);
  const message = serialized.message;
  const formatted = typeof message === "string" && Object.keys(serialized).length === 1
    ? message
    : JSON.stringify(serialized);
  return formatted.slice(0, 4000);
}

function serializeValue(value: unknown, seen: WeakSet<object>, depth: number): SerializedValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return "[undefined]";
  if (typeof value === "symbol") return redactString(value.toString());
  if (typeof value === "function") return `[Function${value.name ? `: ${value.name}` : ""}]`;
  if (typeof value !== "object" || value === null) return redactString(String(value));
  if (depth >= MAX_DEPTH) return "[MaxDepth]";
  if (value instanceof URL) return redactString(value.toString());
  if (value instanceof Date) return value.toISOString();
  if (seen.has(value)) return "[Circular]";

  seen.add(value);
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_PROPERTIES).map((item) => serializeValue(item, seen, depth + 1));
    if (value.length > MAX_PROPERTIES) items.push(`[${value.length - MAX_PROPERTIES} more items]`);
    return items;
  }

  const result = Object.create(null) as Record<string, SerializedValue>;
  const keys = new Set<string>();
  try {
    for (const key of Object.getOwnPropertyNames(value).slice(0, MAX_PROPERTIES)) keys.add(key);
  } catch {
    result.serializationError = "Unable to inspect error properties";
    return result;
  }

  for (const key of DIAGNOSTIC_PROPERTIES) {
    try {
      if (key in value) keys.add(key);
    } catch {
      result[key] = "[Unavailable]";
    }
  }

  for (const key of keys) {
    if (Object.hasOwn(result, key)) continue;
    if (SENSITIVE_KEY.test(key)) {
      result[key] = "[REDACTED]";
      continue;
    }
    const property = readProperty(value, key);
    result[key] = property.ok ? serializeValue(property.value, seen, depth + 1) : "[Unavailable]";
  }
  return result;
}

function readProperty(value: object, key: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: (value as Record<string, unknown>)[key] };
  } catch {
    return { ok: false };
  }
}

function redactString(value: string): string {
  let result = value
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\bBasic\s+[A-Za-z0-9+/=]+/gi, "Basic [REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]")
    .replace(/\b(authorization|api[-_]?key|service[-_]?role[-_]?key|private[-_]?key|password|secret|access[-_]?token|refresh[-_]?token|credential)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1$2[REDACTED]")
    .replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi, redactUrl);

  for (const secret of configuredSecrets()) {
    result = result.split(secret).join("[REDACTED]");
  }
  return result.length > MAX_STRING_LENGTH ? `${result.slice(0, MAX_STRING_LENGTH)}[TRUNCATED]` : result;
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}/[REDACTED]`;
  } catch {
    return "[REDACTED_URL]";
  }
}

function configuredSecrets(): string[] {
  return Object.entries(process.env)
    .filter(([name, value]) => SENSITIVE_ENV_NAME.test(name) && Boolean(value) && value!.length >= 4)
    .map(([, value]) => value!)
    .sort((left, right) => right.length - left.length);
}