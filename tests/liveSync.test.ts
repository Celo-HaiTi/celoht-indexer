import { beforeEach, describe, expect, it, vi } from "vitest";

const { operations, state } = vi.hoisted(() => ({
  operations: {
    backfills: [] as Array<Record<string, unknown>>,
    reorgs: [] as Array<Record<string, unknown>>,
    liveClients: [] as unknown[],
  },
  state: {
    checkpoint: null as null | Record<string, unknown>,
    backfillError: null as Error | null,
  },
}));

vi.mock("@/chain/provider", () => ({
  getConfirmedBlockNumber: vi.fn(async (client: unknown) => {
    operations.liveClients.push(client);
    return 35343250n;
  }),
}));

vi.mock("@/db/checkpoints", () => ({
  getCheckpoint: vi.fn(async () => state.checkpoint),
}));

vi.mock("@/indexing/reorg", () => ({
  detectAndHandleReorg: vi.fn(async (params: Record<string, unknown>) => {
    operations.reorgs.push(params);
    return { reorgDetected: false, safeBlock: 35343250n };
  }),
}));

vi.mock("@/indexing/backfill", () => ({
  runBackfill: vi.fn(async (params: Record<string, unknown>) => {
    operations.backfills.push(params);
    if (state.backfillError) throw state.backfillError;
    state.checkpoint = {
      chainId: 11142220,
      contractAddress: "test-contract",
      lastProcessedBlock: 35343250n,
      nextBlock: 35343251n,
      lastProcessedBlockHash: `0x${"aa".repeat(32)}`,
      lastProcessedParentHash: `0x${"bb".repeat(32)}`,
      latestConfirmedBlock: 35343250n,
      syncStatus: "idle",
    };
  }),
}));

import { RpcProviderCapabilityError } from "@/chain/retry";
import { runSyncPass, startLiveSyncLoop } from "@/indexing/liveSync";

const target = {
  contract: "governance" as const,
  contractAddress: "test-contract" as `0x${string}`,
  abi: [],
  deploymentBlock: 35343240,
  startBlock: 35343240,
};

describe("live sync checkpoint recovery", () => {
  beforeEach(() => {
    operations.backfills.splice(0);
    operations.reorgs.splice(0);
    operations.liveClients.splice(0);
    state.backfillError = null;
    state.checkpoint = {
      chainId: 11142220,
      contractAddress: target.contractAddress,
      lastProcessedBlock: null,
      nextBlock: 35343240n,
      lastProcessedBlockHash: null,
      lastProcessedParentHash: null,
      latestConfirmedBlock: null,
      syncStatus: "idle",
    };
  });

  it("backfills from the official deployment cursor, then restarts from persisted progress", async () => {
    const liveClient = { role: "live" } as never;
    const historicalClient = { role: "archive" } as never;
    const params = {
      client: liveClient,
      historicalClient,
      chainId: 11142220,
      confirmations: 5,
      batchSize: 2000,
      maxRetries: 0,
      targets: [target],
    };

    await expect(runSyncPass(params)).resolves.toBeUndefined();
    expect(operations.backfills).toHaveLength(1);
    expect(operations.backfills[0]).toMatchObject({
      fromBlock: 35343240n,
      toBlock: 35343250n,
    });
    expect(operations.backfills[0]?.client).toBe(historicalClient);
    expect(operations.liveClients[0]).toBe(liveClient);
    expect(operations.reorgs).toHaveLength(0);

    await expect(runSyncPass(params)).resolves.toBeUndefined();
    expect(operations.reorgs).toHaveLength(1);
    expect(operations.reorgs[0]).toMatchObject({ lastProcessedBlock: 35343250n });
    expect(operations.reorgs[0]?.client).toBe(historicalClient);
    expect(operations.backfills).toHaveLength(1);
  });

  it("stops polling after a permanent archive capability failure", async () => {
    state.backfillError = new RpcProviderCapabilityError(
      "archive retention unavailable",
      "historical_retention_limit"
    );
    const sync = startLiveSyncLoop({
      client: { role: "live" } as never,
      historicalClient: { role: "archive" } as never,
      chainId: 11142220,
      confirmations: 5,
      batchSize: 2000,
      maxRetries: 5,
      pollIntervalMs: 1000,
      targets: [target],
    });

    await sync.stop();

    expect(operations.backfills).toHaveLength(1);
  });
});