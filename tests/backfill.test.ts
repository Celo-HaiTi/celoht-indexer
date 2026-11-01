import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicClient } from "viem";

const { operations } = vi.hoisted(() => ({
  operations: {
    decoded: [] as Array<Record<string, unknown>>,
    persisted: [] as Array<Record<string, unknown>>,
    checkpoints: [] as Array<Record<string, unknown>>,
    errors: [] as Array<Record<string, unknown>>,
  },
}));

vi.mock("@/indexing/eventDecoder", () => ({
  MalformedEventError: class MalformedEventError extends Error {},
  decodeLog: vi.fn((params: Record<string, unknown>) => {
    const log = params.log as Record<string, unknown>;
    const decoded = {
      chainId: params.chainId,
      contractAddress: params.contractAddress,
      transactionHash: log.transactionHash,
      logIndex: log.logIndex,
      blockNumber: log.blockNumber,
      blockHash: log.blockHash,
      parentHash: params.parentHash,
      blockTimestamp: params.blockTimestamp,
      transactionIndex: log.transactionIndex,
      eventName: "TestEvent",
      args: {},
    };
    operations.decoded.push(decoded);
    return decoded;
  }),
}));

vi.mock("@/indexing/persist", () => ({
  persistEvent: vi.fn(async (event: Record<string, unknown>) => operations.persisted.push(event)),
}));

vi.mock("@/db/checkpoints", () => ({
  updateCheckpointProgress: vi.fn(async (params: Record<string, unknown>) => operations.checkpoints.push(params)),
  recordCheckpointError: vi.fn(async (params: Record<string, unknown>) => operations.errors.push(params)),
}));

import { runBackfill } from "@/indexing/backfill";

const contractAddress = "test-contract" as `0x${string}`;

function hash(blockNumber: number): string {
  return `0x${blockNumber.toString(16).padStart(64, "0")}`;
}

function eventLog(blockNumber: bigint, logIndex: number) {
  return {
    blockNumber,
    blockHash: hash(Number(blockNumber)),
    transactionHash: hash(logIndex + 100),
    transactionIndex: logIndex,
    logIndex,
  };
}

function block(blockNumber: bigint) {
  return {
    number: blockNumber,
    hash: hash(Number(blockNumber)),
    parentHash: hash(Math.max(0, Number(blockNumber) - 1)),
    timestamp: blockNumber,
  };
}

function params(client: PublicClient, overrides: Record<string, unknown> = {}) {
  return {
    client,
    chainId: 11142220,
    contract: "governance" as const,
    contractAddress,
    abi: [],
    fromBlock: 1n,
    toBlock: 2n,
    batchSize: 2,
    maxRetries: 0,
    ...overrides,
  };
}

describe("historical backfill", () => {
  beforeEach(() => {
    operations.decoded.splice(0);
    operations.persisted.splice(0);
    operations.checkpoints.splice(0);
    operations.errors.splice(0);
  });

  it("splits a rejected bounded log range into adjacent ranges without skipping blocks", async () => {
    const requests: Array<[bigint, bigint]> = [];
    const client = {
      getLogs: vi.fn(async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
        requests.push([fromBlock, toBlock]);
        if (fromBlock === 1n && toBlock === 4n) {
          throw { code: -32602, message: "block range exceeds maximum range" };
        }
        return [];
      }),
      getBlock: vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => block(blockNumber)),
    } as unknown as PublicClient;

    await runBackfill(params(client, { toBlock: 4n, batchSize: 4 }));

    expect(requests).toEqual([[1n, 4n], [1n, 2n], [3n, 4n]]);
    expect(operations.checkpoints).toHaveLength(1);
    expect(operations.checkpoints[0]).toMatchObject({ lastProcessedBlock: 4n });
  });

  it("uses one verified archive header per event-bearing block and persists a canonical checkpoint", async () => {
    const logs = [eventLog(1n, 0), eventLog(1n, 1), eventLog(2n, 2)];
    const client = {
      getLogs: vi.fn().mockResolvedValue(logs),
      getBlock: vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => block(blockNumber)),
    } as unknown as PublicClient;

    await runBackfill(params(client));

    expect(client.getBlock).toHaveBeenCalledTimes(2);
    expect(client.getBlock).toHaveBeenNthCalledWith(1, { blockNumber: 1n });
    expect(client.getBlock).toHaveBeenNthCalledWith(2, { blockNumber: 2n });
    expect(operations.persisted).toHaveLength(3);
    expect(operations.checkpoints).toEqual([expect.objectContaining({
      lastProcessedBlock: 2n,
      blockHash: hash(2),
      parentHash: hash(1),
    })]);
  });

  it("fails a hash mismatch without persisting the event or advancing the checkpoint", async () => {
    const log = { ...eventLog(1n, 0), blockHash: hash(9) };
    const client = {
      getLogs: vi.fn().mockResolvedValue([log]),
      getBlock: vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => block(blockNumber)),
    } as unknown as PublicClient;

    await expect(runBackfill(params(client))).rejects.toThrow(/invalid or mismatched block header/);
    expect(operations.persisted).toHaveLength(0);
    expect(operations.checkpoints).toHaveLength(0);
    expect(operations.errors).toHaveLength(1);
  });

  it("does not retry or advance on a historical-retention error", async () => {
    const client = {
      getLogs: vi.fn().mockRejectedValue({
        code: -32602,
        message: "block is more than 10064 blocks behind head",
      }),
      getBlock: vi.fn(),
    } as unknown as PublicClient;

    await expect(runBackfill(params(client, { maxRetries: 5 }))).rejects.toMatchObject({
      name: "RpcProviderCapabilityError",
      category: "historical_retention_limit",
    });
    expect(client.getLogs).toHaveBeenCalledOnce();
    expect(client.getBlock).not.toHaveBeenCalled();
    expect(operations.checkpoints).toHaveLength(0);
  });
});