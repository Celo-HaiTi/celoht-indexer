import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadDeploymentMetadata, CELO_SEPOLIA_CHAIN_ID } from "@/config/network";

const mocks = vi.hoisted(() => ({
  createPublicClient: vi.fn(),
  getChainId: vi.fn(),
  getBytecode: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return { ...actual, createPublicClient: mocks.createPublicClient };
});

vi.mock("@/config/env", () => ({
  getEnv: () => ({ CELO_RPC_URL: "https://rpc.example.test", RPC_TIMEOUT_MS: 15000, RPC_MAX_RETRIES: 5 }),
}));

vi.mock("@/util/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: mocks.loggerError },
}));

import { createVerifiedClient } from "@/chain/provider";

describe("createVerifiedClient", () => {
  const meta = loadDeploymentMetadata("celoSepolia");

  beforeEach(() => {
    mocks.getChainId.mockReset();
    mocks.getBytecode.mockReset();
    mocks.loggerError.mockReset();
    mocks.createPublicClient.mockReset().mockImplementation(() => ({
      getChainId: mocks.getChainId,
      getBytecode: mocks.getBytecode,
    }));
  });

  it("keeps HTTP RPC and verifies Celo Sepolia chain ID and contract code", async () => {
    mocks.getChainId.mockResolvedValue(CELO_SEPOLIA_CHAIN_ID);
    mocks.getBytecode.mockResolvedValue("0x6000");

    await createVerifiedClient(meta);

    const config = mocks.createPublicClient.mock.calls[0]?.[0] as { transport: unknown } | undefined;
    expect(typeof config?.transport).toBe("function");
    expect(mocks.getChainId).toHaveBeenCalledOnce();
    expect(mocks.getBytecode).toHaveBeenCalledTimes(6);
  });

  it("fails closed and reports the observed chain ID when RPC points elsewhere", async () => {
    mocks.getChainId.mockResolvedValue(1);

    await expect(createVerifiedClient(meta)).rejects.toMatchObject({
      name: "NetworkConfigError",
      message: expect.stringContaining("chainId 1"),
    });
    expect(mocks.getChainId).toHaveBeenCalledOnce();
    expect(mocks.getBytecode).not.toHaveBeenCalled();
  });

  it("preserves structured RPC error details in diagnostics", async () => {
    const rpcError = {
      code: -32000,
      message: "upstream RPC unavailable",
      status: 503,
      response: { status: 503, data: { message: "provider unavailable" } },
    };
    mocks.getChainId.mockRejectedValue(rpcError);

    await expect(createVerifiedClient(meta)).rejects.toBe(rpcError);
    expect(mocks.loggerError).toHaveBeenCalledWith(
      "rpc_chain_id_check_failed",
      expect.objectContaining({
        error: expect.objectContaining({
          code: -32000,
          message: "upstream RPC unavailable",
          status: 503,
          response: { status: 503, data: { message: "provider unavailable" } },
        }),
      })
    );
  });
});