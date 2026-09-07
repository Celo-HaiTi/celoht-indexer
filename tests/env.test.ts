import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getEnv, EnvConfigError, __resetEnvCacheForTests } from "@/config/env";

const VALID_ENV: Record<string, string> = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  CELO_NETWORK: "celoSepolia",
  CELO_RPC_URL: "https://rpc.example.com",
};

describe("getEnv (fail closed)", () => {
  const original = { ...process.env };

  beforeEach(() => {
    __resetEnvCacheForTests();
    process.env = { ...original };
  });
  afterEach(() => {
    process.env = original;
    __resetEnvCacheForTests();
  });

  it("parses successfully with required variables present", () => {
    Object.assign(process.env, VALID_ENV);
    expect(() => getEnv()).not.toThrow();
  });

  it("throws when SUPABASE_SERVICE_ROLE_KEY is missing", () => {
    Object.assign(process.env, VALID_ENV);
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(() => getEnv()).toThrow(EnvConfigError);
  });

  it("throws when CELO_RPC_URL is missing", () => {
    Object.assign(process.env, VALID_ENV);
    delete process.env.CELO_RPC_URL;
    expect(() => getEnv()).toThrow(EnvConfigError);
  });

  it("applies sensible defaults for tuning parameters", () => {
    Object.assign(process.env, VALID_ENV);
    const env = getEnv();
    expect(env.CONFIRMATIONS).toBe(5);
    expect(env.BACKFILL_BATCH_SIZE).toBe(2000);
  });
});
