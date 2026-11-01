import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadDeploymentMetadata, CELO_SEPOLIA_CHAIN_ID } from "@/config/network";

const mocks = vi.hoisted(() => ({
  createPublicClient: vi.fn(),
  http: vi.fn((url: string, options: unknown) => ({ url, options })),
  clients: [] as Array<Record<string, ReturnType<typeof vi.fn>>>,
  archiveUrl: "https://archive.example.test/path?api_key=archive-secret" as string | undefined,
  loggerError: vi.fn(),
}));

vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return { ...actual, createPublicClient: mocks.createPublicClient, http: mocks.http };
});

vi.mock("@/config/env", () => ({
  getEnv: () => ({
    CELO_RPC_URL: "https://live.example.test/path?api_key=live-secret",
    CELO_SEPOLIA_ARCHIVE_RPC_URL: mocks.archiveUrl,
    RPC_TIMEOUT_MS: 15000,
    RPC_MAX_RETRIES: 5,
  }),
}));

vi.mock("@/util/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: mocks.loggerError },
}));

import { createVerifiedClients } from "@/chain/provider";

describe("createVerifiedClients", () => {
  const meta = loadDeploymentMetadata("celoSepolia");
  let liveClient: Record<string, ReturnType<typeof vi.fn>>;
  let archiveClient: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    liveClient = {
      getChainId: vi.fn().mockResolvedValue(CELO_SEPOLIA_CHAIN_ID),
      getBytecode: vi.fn().mockResolvedValue("0x6000"),
    };
    archiveClient = {
      getChainId: vi.fn().mockResolvedValue(CELO_SEPOLIA_CHAIN_ID),
      getBlock: vi.fn().mockResolvedValue({
        number: 35343240n,
        hash: `0x${"ab".repeat(32)}`,
      }),
    };
    mocks.clients = [liveClient, archiveClient];
    mocks.archiveUrl = "https://archive.example.test/path?api_key=archive-secret";
    mocks.loggerError.mockReset();
    mocks.http.mockClear();
    mocks.createPublicClient.mockReset().mockImplementation(() => mocks.clients.shift());
  });

  it("validates both endpoints and proves the archive endpoint can read the deployment block", async () => {
    const clients = await createVerifiedClients(meta);

    expect(clients.liveClient).toBe(liveClient);
    expect(clients.historicalClient).toBe(archiveClient);
    expect(mocks.http).toHaveBeenNthCalledWith(1, expect.stringContaining("live.example.test"), expect.objectContaining({ retryCount: 0 }));
    expect(mocks.http).toHaveBeenNthCalledWith(2, expect.stringContaining("archive.example.test"), expect.objectContaining({ retryCount: 0 }));
    expect(liveClient.getChainId).toHaveBeenCalledOnce();
    expect(archiveClient.getChainId).toHaveBeenCalledOnce();
    expect(archiveClient.getBlock).toHaveBeenCalledWith({ blockNumber: 35343240n });
    expect(liveClient.getBytecode).toHaveBeenCalledTimes(6);
  });

  it("fails closed when the archive endpoint reports a different chain", async () => {
    archiveClient.getChainId.mockResolvedValue(1);

    await expect(createVerifiedClients(meta)).rejects.toMatchObject({
      name: "NetworkConfigError",
      message: expect.stringContaining("archive RPC endpoint reports chainId 1"),
    });
    expect(archiveClient.getBlock).not.toHaveBeenCalled();
    expect(liveClient.getBytecode).not.toHaveBeenCalled();
  });

  it("falls back to the normal URL when the optional archive URL is unset", async () => {
    mocks.archiveUrl = undefined;

    await createVerifiedClients(meta);

    expect(mocks.http).toHaveBeenNthCalledWith(1, expect.stringContaining("live.example.test"), expect.anything());
    expect(mocks.http).toHaveBeenNthCalledWith(2, expect.stringContaining("live.example.test"), expect.anything());
  });

  it("fails clearly when the archive endpoint is behind its historical retention limit", async () => {
    archiveClient.getBlock.mockRejectedValue({
      code: -32602,
      message: "block is more than 10064 blocks behind head",
    });

    await expect(createVerifiedClients(meta)).rejects.toMatchObject({
      name: "NetworkConfigError",
      message: expect.stringContaining("historical_retention_limit"),
    });
    expect(mocks.loggerError).toHaveBeenCalledWith(
      "rpc_archive_block_check_failed",
      expect.objectContaining({ endpointRole: "archive", requestedBlock: "35343240", errorCategory: "historical_retention_limit" })
    );
  });

  it.each([
    { label: "wrong block number", block: { number: 35343241n, hash: `0x${"ab".repeat(32)}` } },
    { label: "malformed hash", block: { number: 35343240n, hash: "0xabc" } },
  ])("rejects archive probe with $label", async ({ block }) => {
    archiveClient.getBlock.mockResolvedValue(block);
    await expect(createVerifiedClients(meta)).rejects.toMatchObject({
      name: "NetworkConfigError",
      message: expect.stringContaining("valid block number and hash"),
    });
  });

  it("preserves structured RPC error details in diagnostics", async () => {
    const rpcError = {
      code: -32000,
      message: "upstream RPC unavailable",
      status: 503,
      response: { status: 503, data: { message: "provider unavailable" } },
    };
    liveClient.getChainId.mockRejectedValue(rpcError);

    await expect(createVerifiedClients(meta)).rejects.toBe(rpcError);
    expect(mocks.loggerError).toHaveBeenCalledWith(
      "rpc_chain_id_check_failed",
      expect.objectContaining({
        endpointRole: "live",
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