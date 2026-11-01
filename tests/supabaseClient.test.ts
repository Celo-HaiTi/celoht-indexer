import { afterEach, describe, expect, it, vi } from "vitest";

const { createClientMock } = vi.hoisted(() => ({ createClientMock: vi.fn() }));

vi.mock("@supabase/supabase-js", () => ({ createClient: createClientMock }));

const originalEnv = { ...process.env };

function jwtWithRole(role: string): string {
  return `header.${Buffer.from(JSON.stringify({ role })).toString("base64url")}.signature`;
}

function setRequiredEnv(key: string): void {
  Object.assign(process.env, {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: key,
    CELO_NETWORK: "celoSepolia",
    CELO_RPC_URL: "https://rpc.example.com",
  });
}

describe("service-role Supabase client", () => {
  afterEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
    vi.clearAllMocks();
  });

  it.each([jwtWithRole("service_role"), "sb_secret_server_only_test_key"])(
    "passes a server-side service-role credential to createClient",
    async (key) => {
      setRequiredEnv(key);
      const client = {};
      createClientMock.mockReturnValue(client);

      const { getServiceRoleClient } = await import("@/db/supabaseClient");

      expect(getServiceRoleClient()).toBe(client);
      expect(createClientMock).toHaveBeenCalledExactlyOnceWith(
        "https://example.supabase.co",
        key,
        { auth: { persistSession: false, autoRefreshToken: false } }
      );
    }
  );

  it("rejects an anon JWT before creating a client", async () => {
    setRequiredEnv(jwtWithRole("anon"));
    const { getServiceRoleClient } = await import("@/db/supabaseClient");

    expect(() => getServiceRoleClient()).toThrow("must authorize the Supabase service_role");
    expect(createClientMock).not.toHaveBeenCalled();
  });
});