import { beforeEach, describe, expect, it, vi } from "vitest";

const { rows } = vi.hoisted(() => ({
  rows: {
    contracts: { id: "contract-id" },
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
  },
}));

vi.mock("@/db/supabaseClient", () => ({
  getServiceRoleClient: () => ({
    from: (table: keyof typeof rows) => {
      return {
        select: () => ({
          eq: () => {
            return {
              eq: () => {
                return {
                  single: async () => ({ data: rows[table], error: null }),
                };
              },
              single: async () => ({ data: rows[table], error: null }),
            };
          },
        }),
      };
    },
  }),
}));

import { CheckpointConsistencyError, getCheckpoint } from "@/db/checkpoints";

const contractAddress = "test-contract";

describe("checkpoint ledger consistency", () => {
  beforeEach(() => {
    rows.indexer_state.last_processed_block = "100";
    rows.indexer_state.latest_confirmed_block = "105";
    rows.indexer_sync_state.last_processed_block = "100";
    rows.indexer_sync_state.next_block = "101";
    rows.indexer_sync_state.latest_confirmed_block = "105";
  });

  it("returns the hash metadata when indexer_state and indexer_sync_state agree", async () => {
    await expect(getCheckpoint(11142220, contractAddress)).resolves.toEqual({
      chainId: 11142220,
      contractAddress,
      lastProcessedBlock: 100n,
      lastProcessedBlockHash: `0x${"aa".repeat(32)}`,
      lastProcessedParentHash: `0x${"bb".repeat(32)}`,
      latestConfirmedBlock: 105n,
      syncStatus: "idle",
    });
  });

  it("fails closed when the checkpoint ledgers disagree", async () => {
    rows.indexer_sync_state.last_processed_block = "101";

    await expect(getCheckpoint(11142220, contractAddress)).rejects.toBeInstanceOf(CheckpointConsistencyError);
  });
});