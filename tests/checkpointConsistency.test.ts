import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicClient } from "viem";

interface Anchor {
  chain_id: number;
  block_number: string;
  block_hash: string;
  parent_hash: string;
  confirmation_status: "canonical" | "confirmed" | "orphaned";
}

const { database } = vi.hoisted(() => ({
  database: {
    contracts: { id: "contract-id", deployment_block: "100" },
    indexer_state: {
      chain_id: 11142220,
      contract_address: "test-contract",
      last_processed_block: "100",
      latest_confirmed_block: "105",
      sync_status: "idle",
    },
    indexer_sync_state: {
      next_block: "101",
      last_processed_block: "100",
      last_processed_block_hash: `0x${"aa".repeat(32)}`,
      last_processed_parent_hash: `0x${"bb".repeat(32)}`,
      latest_confirmed_block: "105",
    },
    anchors: [] as Anchor[],
  },
}));

vi.mock("@/db/supabaseClient", () => ({
  getServiceRoleClient: () => ({
    from: (table: string) => {
      const filters: Array<{ action: string; column: string; value: unknown }> = [];
      const query = {
        select: () => query,
        eq: (column: string, value: unknown) => {
          filters.push({ action: "eq", column, value });
          return query;
        },
        in: (column: string, value: unknown[]) => {
          filters.push({ action: "in", column, value });
          return query;
        },
        single: async () => ({ data: database[table as "contracts" | "indexer_state" | "indexer_sync_state"], error: null }),
        maybeSingle: async () => {
          let anchors = [...database.anchors];
          for (const filter of filters) {
            if (filter.action === "eq") {
              anchors = anchors.filter((anchor) => String(anchor[filter.column as keyof Anchor]) === String(filter.value));
            } else if (filter.action === "in") {
              anchors = anchors.filter((anchor) => (filter.value as string[]).includes(anchor[filter.column as keyof Anchor]));
            }
          }
          return { data: anchors[0] ?? null, error: null };
        },
      };
      return query;
    },
  }),
}));

import { CheckpointRecoveryRequiredError, getCheckpoint } from "@/db/checkpoints";

const chainId = 11142220;
const contractAddress = "test-contract";
const blockHash = `0x${"aa".repeat(32)}`;
const parentHash = `0x${"bb".repeat(32)}`;

function client(blockNumber = 100n, hash = blockHash): PublicClient {
  return {
    getBlock: vi.fn(async () => ({
      number: blockNumber,
      hash,
      parentHash,
      timestamp: 1n,
    })),
  } as unknown as PublicClient;
}

function request(rpcClient = client(), initialBlock = 100) {
  return getCheckpoint({ chainId, contractAddress, client: rpcClient, initialBlock });
}

function setMatchingCheckpoint(): void {
  database.contracts.deployment_block = "100";
  database.indexer_state.last_processed_block = "100";
  database.indexer_state.latest_confirmed_block = "105";
  database.indexer_sync_state.last_processed_block = "100";
  database.indexer_sync_state.next_block = "101";
  database.indexer_sync_state.last_processed_block_hash = blockHash;
  database.indexer_sync_state.last_processed_parent_hash = parentHash;
  database.indexer_sync_state.latest_confirmed_block = "105";
  database.anchors.splice(0, database.anchors.length, {
    chain_id: 11142220,
    block_number: "100",
    block_hash: blockHash,
    parent_hash: parentHash,
    confirmation_status: "canonical",
  });
}

describe("verified checkpoint ledger policy", () => {
  beforeEach(() => {
    setMatchingCheckpoint();
  });

  it("treats the production legacy-high/sync-zero tuple as an uninitialized deployment cursor", async () => {
    database.contracts.deployment_block = "35343240";
    database.indexer_state.last_processed_block = "35343239";
    database.indexer_state.latest_confirmed_block = null;
    database.indexer_sync_state.last_processed_block = "0";
    database.indexer_sync_state.next_block = "35343240";
    database.indexer_sync_state.last_processed_block_hash = null;
    database.indexer_sync_state.last_processed_parent_hash = null;
    database.indexer_sync_state.latest_confirmed_block = null;
    database.anchors.splice(0);
    const rpc = client();

    await expect(request(rpc, 35343240)).resolves.toMatchObject({
      lastProcessedBlock: null,
      nextBlock: 35343240n,
      lastProcessedBlockHash: null,
    });
    expect(rpc.getBlock).not.toHaveBeenCalled();
  });

  it("accepts matching ledgers only when the canonical anchor hash matches RPC", async () => {
    await expect(request()).resolves.toMatchObject({
      lastProcessedBlock: 100n,
      nextBlock: 101n,
      lastProcessedBlockHash: blockHash,
    });
  });

  it("rejects a legacy checkpoint higher than a processed sync checkpoint unless it is the exact uninitialized seed", async () => {
    database.indexer_state.last_processed_block = "101";
    await expect(request()).rejects.toBeInstanceOf(CheckpointRecoveryRequiredError);
  });

  it("rejects a sync checkpoint higher than the legacy checkpoint", async () => {
    database.indexer_state.last_processed_block = "99";
    await expect(request()).rejects.toBeInstanceOf(CheckpointRecoveryRequiredError);
  });

  it("requires recovery when a processed checkpoint has no hash", async () => {
    database.indexer_sync_state.last_processed_block_hash = null;
    await expect(request()).rejects.toThrow(/hash is missing or malformed/);
  });

  it("requires recovery when the indexed block anchor is missing", async () => {
    database.anchors.splice(0);
    await expect(request()).rejects.toThrow(/No eligible indexed_blocks anchor/);
  });

  it("requires recovery when RPC reports a different checkpoint hash", async () => {
    await expect(request(client(100n, `0x${"cc".repeat(32)}`)))
      .rejects.toThrow(/RPC hash does not verify checkpoint/);
  });

  it("accepts a verified checkpoint after restart following normal checkpoint persistence", async () => {
    database.contracts.deployment_block = "100";
    database.indexer_state.last_processed_block = "99";
    database.indexer_state.latest_confirmed_block = null;
    database.indexer_sync_state.last_processed_block = "0";
    database.indexer_sync_state.next_block = "100";
    database.indexer_sync_state.last_processed_block_hash = null;
    database.indexer_sync_state.last_processed_parent_hash = null;
    database.indexer_sync_state.latest_confirmed_block = null;
    database.anchors.splice(0);

    await expect(request(client(), 100)).resolves.toMatchObject({ lastProcessedBlock: null, nextBlock: 100n });

    setMatchingCheckpoint();
    await expect(request(client(), 100)).resolves.toMatchObject({
      lastProcessedBlock: 100n,
      nextBlock: 101n,
      lastProcessedBlockHash: blockHash,
    });
  });
});