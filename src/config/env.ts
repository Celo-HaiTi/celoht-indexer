import { z } from "zod";

const EnvSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  CELO_NETWORK: z.string().min(1),
  CELO_RPC_URL: z.string().url(),
  CELO_SEPOLIA_ARCHIVE_RPC_URL: z.string().url().optional(),
  CONFIRMATIONS: z.coerce.number().int().min(1).default(5),
  BACKFILL_BATCH_SIZE: z.coerce.number().int().min(1).max(10_000).default(2000),
  BACKFILL_MIN_BATCH_SIZE: z.coerce.number().int().min(1).max(10_000).default(100),
  BACKFILL_RPC_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  BACKFILL_CHUNKS_PER_PASS: z.coerce.number().int().min(1).max(100).default(1),
  POLL_INTERVAL_MS: z.coerce.number().int().min(1000).default(15_000),
  RPC_MAX_RETRIES: z.coerce.number().int().min(0).default(5),
  RPC_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15_000),
  START_BLOCK: z.coerce.number().int().nonnegative().optional(),
  USDM_START_BLOCK: z.coerce.number().int().nonnegative().default(0),
  DRY_RUN: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
}).superRefine((env, context) => {
  if (env.BACKFILL_MIN_BATCH_SIZE > env.BACKFILL_BATCH_SIZE) {
    context.addIssue({
      code: "custom",
      path: ["BACKFILL_MIN_BATCH_SIZE"],
      message: "must not exceed BACKFILL_BATCH_SIZE",
    });
  }
});

export type Env = z.infer<typeof EnvSchema>;

export class EnvConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvConfigError";
  }
}

let cached: Env | null = null;

export function getEnv(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new EnvConfigError(
      `Missing or invalid environment configuration: ${parsed.error.issues
        .map((i) => i.path.join("."))
        .join(", ")}`
    );
  }
  cached = parsed.data;
  return cached;
}

export function __resetEnvCacheForTests(): void {
  cached = null;
}
