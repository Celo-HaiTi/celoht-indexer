import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicClient } from "viem";

interface Anchor {
  chain_id: number;
  block_number: string;
  block_hash: string;
  confirmation_status: "canonical" | "confirmed" | "orphaned";
}

const { database } = vi.hoisted(() => ({
  database: {
    anchors: [] as Anchor[],
    operations: [] as Array<{ table: string; action: string; args: unknown[] }>,
  },
}));

vi.mock("@/db/supabaseClient", () => ({
  getServiceRoleClient: () => ({
    from: (table: string) => {
      class Query implements PromiseLike<{ data: unknown; error: null }> {
        private action = "select";
        private values: unknown;
        private readonly filters: Array<{ action: string; args: unknown[] }> = [];
        private limitValue = Number.POSITIVE_INFINITY;

        select(): this {
          this.action = "select";
          return this;
        }

        update(values: unknown): this {
          this.action = "update";
          this.values = values;
          database.operations.push({ table, action: "update", args: [values] });
          return this;
        }

        delete(): this {
          this.action = "delete";
          database.operations.push({ table, action: "delete", args: [] });
          return this;
        }

        eq(column: string, value: unknown): this {
          this.filters.push({ action: "eq", args: [column, value] });
          database.operations.push({ table, action: "eq", args: [column, value] });
          return this;
        }

        in(column: string, values: unknown[]): this {
          this.filters.push({ action: "in", args: [column, values] });
          database.operations.push({ table, action: "in", args: [column, values] });
          return this;
        }

        lte(column: string, value: string): this {
          this.filters.push({ action: "lte", args: [column, value] });
          database.operations.push({ table, action: "lte", args: [column, value] });
          return this;
        }

        gt(column: string, value: string): this {
          this.filters.push({ action: "gt", args: [column, value] });
          database.operations.push({ table, action: "gt", args: [column, value] });
          return this;
        }

        order(column: string, options: { ascending: boolean }): this {
          database.operations.push({ table, action: "order", args: [column, options] });
          return this;
        }

        limit(value: number): this {
          this.limitValue = value;
          database.operations.push({ table, action: "limit", args: [value] });
          return this;
        }

        then<TResult1 = { data: unknown; error: null }, TResult2 = never>(
          onfulfilled?: ((value: { data: unknown; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
          onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
        ): PromiseLike<TResult1 | TResult2> {
          const result = this.action === "select" && table === "indexed_blocks"
            ? this.selectAnchors()
            : { data: null, error: null };
          return Promise.resolve(result).then(onfulfilled, onrejected);
        }

        private selectAnchors(): { data: Anchor[]; error: null } {
          let rows = [...database.anchors];
          for (const filter of this.filters) {
            const [column, value] = filter.args;
            if (filter.action === "eq" && column === "chain_id") {
              rows = rows.filter((row) => row.chain_id === value);
            } else if (filter.action === "in" && column === "confirmation_status") {
              rows = rows.filter((row) => (value as string[]).includes(row.confirmation_status));
            } else if (filter.action === "lte" && column === "block_number") {
              rows = rows.filter((row) => BigInt(row.block_number) <= BigInt(value as string));
            }
          }
          rows.sort((left, right) => Number(BigInt(right.block_number) - BigInt(left.block_number)));
          return { data: rows.slice(0, this.limitValue), error: null };
        }
      }

      return new Query();
    },
  }),
}));

import {
  CanonicalAnchorIntegrityError,
  DeepReorganizationError,
  detectAndHandleReorg,
  MissingCanonicalAnchorError,
} from "@/indexing/reorg";

const chainId = 11142220;
const contractAddress = `0x${"11".repeat(20)}` as const;

function hash(value: number): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function anchor(blockNumber: number, blockHash: string, confirmation_status: Anchor["confirmation_status"] = "canonical"): Anchor {
  return { chain_id: chainId, block_number: String(blockNumber), block_hash: blockHash, confirmation_status };
}

function rpc(blocks: Array<{ number: bigint; hash: string }> | null = []): PublicClient {
  const getBlock = vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => {
    const block = blocks?.find((candidate) => candidate.number === blockNumber);
    return block ? { ...block, parentHash: hash(Number(blockNumber) - 1), timestamp: 1n } : null;
  });
  return { getBlock } as unknown as PublicClient;
}

function rpcBlock(blockNumber: number, blockHash = hash(blockNumber)) {
  return { number: BigInt(blockNumber), hash: blockHash };
}

describe("detectAndHandleReorg", () => {
  beforeEach(() => {
    database.anchors.splice(0);
    database.operations.splice(0);
  });

  it("accepts a matching canonical block at the checkpoint", async () => {
    const client = rpc([rpcBlock(100)]);
    database.anchors.push(anchor(100, hash(100), "confirmed"));

    await expect(detectAndHandleReorg({ client, chainId, contractAddress, lastProcessedBlock: 100n }))
      .resolves.toEqual({ reorgDetected: false, safeBlock: 100n });
    expect(client.getBlock).toHaveBeenCalledWith({ blockNumber: 100n });
    expect(database.operations).toContainEqual({
      table: "indexed_blocks",
      action: "in",
      args: ["confirmation_status", ["canonical", "confirmed"]],
    });
    expect(database.operations.some((operation) => operation.action === "update")).toBe(false);
  });

  it("ignores a newer orphaned row and rolls the checkpoint back to the valid anchor", async () => {
    database.anchors.push(anchor(101, hash(999), "orphaned"), anchor(100, hash(100), "canonical"));
    const client = rpc([rpcBlock(100)]);

    await expect(detectAndHandleReorg({ client, chainId, contractAddress, lastProcessedBlock: 101n }))
      .resolves.toEqual({ reorgDetected: true, safeBlock: 100n });
    expect(client.getBlock).toHaveBeenCalledTimes(1);
    expect(database.operations).toContainEqual({
      table: "indexed_blocks",
      action: "gt",
      args: ["block_number", "100"],
    });
  });

  it("selects the canonical observation when orphaned and valid rows share a height", async () => {
    database.anchors.push(anchor(100, hash(999), "orphaned"), anchor(100, hash(100), "canonical"));
    const client = rpc([rpcBlock(100)]);

    await expect(detectAndHandleReorg({ client, chainId, contractAddress, lastProcessedBlock: 100n }))
      .resolves.toEqual({ reorgDetected: false, safeBlock: 100n });
    expect(client.getBlock).toHaveBeenCalledTimes(1);
  });

  it("walks backward to the nearest verified canonical anchor", async () => {
    database.anchors.push(anchor(120, hash(120)), anchor(118, hash(118), "confirmed"), anchor(116, hash(116)));
    const client = rpc([rpcBlock(120, hash(900)), rpcBlock(118, hash(901)), rpcBlock(116)]);

    await expect(detectAndHandleReorg({ client, chainId, contractAddress, lastProcessedBlock: 120n }))
      .resolves.toEqual({ reorgDetected: true, safeBlock: 116n });
    expect(client.getBlock).toHaveBeenNthCalledWith(1, { blockNumber: 120n });
    expect(client.getBlock).toHaveBeenNthCalledWith(2, { blockNumber: 118n });
    expect(client.getBlock).toHaveBeenNthCalledWith(3, { blockNumber: 116n });
  });

  it("classifies a full lookback of mismatching anchors as a deep reorganization", async () => {
    database.anchors.push(anchor(12, hash(12)), anchor(11, hash(11)), anchor(10, hash(10)));
    const client = rpc([rpcBlock(12, hash(90)), rpcBlock(11, hash(91)), rpcBlock(10, hash(92))]);

    await expect(detectAndHandleReorg({
      client,
      chainId,
      contractAddress,
      lastProcessedBlock: 12n,
      maxLookback: 3,
    })).rejects.toBeInstanceOf(DeepReorganizationError);
    expect(database.operations.some((operation) => operation.action === "update")).toBe(false);
  });

  it("distinguishes a checkpoint with no eligible canonical anchors", async () => {
    database.anchors.push(anchor(100, hash(100), "orphaned"));

    await expect(detectAndHandleReorg({
      client: rpc(),
      chainId,
      contractAddress,
      lastProcessedBlock: 100n,
    })).rejects.toBeInstanceOf(MissingCanonicalAnchorError);
  });

  it("reports incomplete history instead of guessing after mismatches", async () => {
    database.anchors.push(anchor(100, hash(100)));

    await expect(detectAndHandleReorg({
      client: rpc([rpcBlock(100, hash(999))]),
      chainId,
      contractAddress,
      lastProcessedBlock: 100n,
      maxLookback: 3,
    })).rejects.toBeInstanceOf(MissingCanonicalAnchorError);
    expect(database.operations.some((operation) => operation.action === "update")).toBe(false);
  });

  it.each([
    { label: "a null block", response: null },
    { label: "an unexpected block number", response: { number: 99n, hash: hash(100) } },
    { label: "a null hash", response: { number: 100n, hash: null } },
  ])("fails closed when RPC returns $label", async ({ response }) => {
    database.anchors.push(anchor(100, hash(100)));
    const client = { getBlock: vi.fn().mockResolvedValue(response) } as unknown as PublicClient;

    await expect(detectAndHandleReorg({ client, chainId, contractAddress, lastProcessedBlock: 100n }))
      .rejects.toBeInstanceOf(CanonicalAnchorIntegrityError);
    expect(database.operations.some((operation) => operation.action === "update")).toBe(false);
  });

  it("rejects duplicate eligible observations at the same height as inconsistent database state", async () => {
    database.anchors.push(anchor(100, hash(100)), anchor(100, hash(101), "confirmed"));

    await expect(detectAndHandleReorg({
      client: rpc([rpcBlock(100)]),
      chainId,
      contractAddress,
      lastProcessedBlock: 100n,
    })).rejects.toBeInstanceOf(CanonicalAnchorIntegrityError);
  });
});