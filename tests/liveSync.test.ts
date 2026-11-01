import { beforeEach, describe, expect, it, vi } from "vitest";

const { operations, state } = vi.hoisted(() => ({
  operations: {
    backfills: [] as Array<Record<string, unknown>>,
    reorgs: [] as Array<Record<string, unknown>>,
  },
  state: {
    checkpoint: null as null | Record<string, unknown>,
  },
}));

vi.mock("@/chain/provider", () => ({
  getConfirmedBlockNumber: vi.fn(async () => 35343250n),
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

import { runSyncPass } from "@/indexing/liveSync";

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
    const client = {} as never;
    const params = {
      client,
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
    expect(operations.reorgs).toHaveLength(0);

    await expect(runSyncPass(params)).resolves.toBeUndefined();
    expect(operations.reorgs).toHaveLength(1);
    expect(operations.reorgs[0]).toMatchObject({ lastProcessedBlock: 35343250n });
    expect(operations.backfills).toHaveLength(1);
  });
});