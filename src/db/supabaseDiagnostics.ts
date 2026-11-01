import { logger } from "@/util/logger";
import { serializeError } from "@/util/errorSerializer";

export function throwSupabaseError(operation: string, error: unknown): never {
  logger.error("supabase_operation_failed", { operation, error: serializeError(error) });
  throw error;
}