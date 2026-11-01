import { afterEach, describe, expect, it, vi } from "vitest";
import { formatErrorMessage, serializeError } from "@/util/errorSerializer";
import { logStartupFailure } from "@/util/logger";

describe("serializeError", () => {
  const originalServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  afterEach(() => {
    if (originalServiceRoleKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalServiceRoleKey;
  });

  it("preserves Error name, message, stack, code, status, response, and nested cause", () => {
    const cause = Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
    const error = Object.assign(new Error("provider request failed", { cause }), {
      code: "ERR_RPC",
      status: 502,
      response: { status: 502, statusText: "Bad Gateway", data: { message: "upstream unavailable" } },
    });

    expect(serializeError(error)).toMatchObject({
      name: "Error",
      message: "provider request failed",
      code: "ERR_RPC",
      status: 502,
      response: { status: 502, statusText: "Bad Gateway", data: { message: "upstream unavailable" } },
      cause: { name: "Error", message: "socket reset", code: "ECONNRESET" },
    });
    expect(serializeError(error).stack).toContain("Error: provider request failed");
  });

  it("serializes plain RPC and PostgREST errors with nested provider response data", () => {
    const error = {
      name: "PostgrestError",
      message: "permission denied for relation indexer_state",
      code: "42501",
      details: "service role cannot access the requested table",
      cause: {
        code: -32000,
        statusCode: 503,
        response: { status: 503, data: { message: "provider unavailable" } },
      },
    };

    expect(serializeError(error)).toMatchObject({
      name: "PostgrestError",
      message: "permission denied for relation indexer_state",
      code: "42501",
      details: "service role cannot access the requested table",
      cause: { code: -32000, statusCode: 503, response: { status: 503 } },
    });
  });

  it("redacts secret fields, configured secrets, authorization tokens, and URL paths", () => {
    const secret = "service-role-test-secret";
    process.env.SUPABASE_SERVICE_ROLE_KEY = secret;
    const serialized = serializeError({
      message: `request failed with ${secret} at https://rpc.example.test/v2/private-token`,
      headers: { Authorization: `Bearer ${secret}`, "content-type": "application/json" },
      nested: { access_token: secret, details: `Bearer ${secret}` },
    });
    const output = JSON.stringify(serialized);

    expect(output).not.toContain(secret);
    expect(output).not.toContain("/v2/private-token");
    expect(serialized.headers).toMatchObject({ Authorization: "[REDACTED]" });
    expect(JSON.parse(formatErrorMessage({ message: "RPC failed", code: "EHOSTUNREACH", status: 502 }))).toMatchObject({
      message: "RPC failed",
      code: "EHOSTUNREACH",
      status: 502,
    });
  });

  it("handles cyclic plain objects without throwing", () => {
    const error: Record<string, unknown> = { code: "ERR_LOOP" };
    error.cause = error;

    expect(serializeError(error)).toMatchObject({ code: "ERR_LOOP", cause: "[Circular]" });
  });

  it("writes nested error objects as structured JSON rather than object strings", () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      logStartupFailure("rpc_verification", Object.assign(new Error("RPC failed"), { code: "ERR_RPC" }));

      const line = JSON.parse(String(output.mock.calls[0]?.[0]));
      expect(line).toMatchObject({
        event: "indexer_fatal_error",
        stage: "rpc_verification",
        error: { name: "Error", message: "RPC failed", code: "ERR_RPC" },
      });
      expect(line.error).not.toBe("[object Object]");
    } finally {
      output.mockRestore();
    }
  });
});