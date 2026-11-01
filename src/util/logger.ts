type Level = "info" | "warn" | "error";
import { serializeLogValue } from "@/util/errorSerializer";

function log(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  const serializedFields = serializeLogValue(fields);
  const safeFields =
    serializedFields !== null && typeof serializedFields === "object" && !Array.isArray(serializedFields)
      ? serializedFields
      : {};
  const line = JSON.stringify({ level, event, ts: new Date().toISOString(), ...safeFields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  info: (event: string, fields?: Record<string, unknown>) => log("info", event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => log("warn", event, fields),
  error: (event: string, fields?: Record<string, unknown>) => log("error", event, fields),
};

export function logStartupFailure(stage: string, error: unknown): void {
  logger.error("indexer_fatal_error", { stage, error });
}
