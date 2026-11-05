import { beforeEach, describe, expect, it, vi } from "vitest";

const { database } = vi.hoisted(() => ({
  database: {
    blocks: [] as Array<Record<string, unknown>>,
    upserts: [] as Array<{ table: string; values: Record<string, unknown>; options: unknown }>,
    contract: null as Record<string, unknown> | null,
  },
}));

vi.mock("@/db/supabaseClient", () => ({
  getServiceRoleClient: () => ({
    from: (table: string) => {
      class Query implements PromiseLike<{ error: null }> {
        select(): this {
          return this;
        }

        eq(): this {
          return this;
        }

        maybeSingle(): Promise<{ data: Record<string, unknown> | null; error: null }> {
          return Promise.resolve({ data: table === "contracts" ? database.contract : null, error: null });
        }

        upsert(values: Record<string, unknown>, options: unknown): this {
          database.upserts.push({ table, values, options });
          if (table === "indexed_blocks") {
            const existing = database.blocks.find((block) =>
              block.chain_id === values.chain_id
              && block.block_number === values.block_number
              && block.block_hash === values.block_hash
            );
            if (existing) Object.assign(existing, values);
            else database.blocks.push({ ...values });
          }
          return this;
        }

        single(): Promise<{ data: { id: string }; error: null }> {
          const id = table === "contracts" ? "contract-id" : table === "indexed_transactions" ? "transaction-id" : "event-id";
          return Promise.resolve({ data: { id }, error: null });
        }

        then<TResult1 = { error: null }, TResult2 = never>(
          onfulfilled?: ((value: { error: null }) => TResult1 | PromiseLike<TResult1>) | null,
          onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
        ): PromiseLike<TResult1 | TResult2> {
          return Promise.resolve({ error: null }).then(onfulfilled, onrejected);
        }
      }

      return new Query();
    },
  }),
}));

import { persistCanonicalEvent, persistIndexedBlock } from "@/db/canonical";

const oldHash = `0x${"aa".repeat(32)}`;
const replacementHash = `0x${"bb".repeat(32)}`;

describe("canonical block persistence", () => {
  beforeEach(() => {
    database.blocks.splice(0);
    database.upserts.splice(0);
    database.contract = null;
  });

  it("preserves an orphaned observation and restores a replayed canonical row idempotently", async () => {
    database.blocks.push({
      chain_id: 11142220,
      block_number: "100",
      block_hash: oldHash,
      confirmation_status: "orphaned",
    });

    const block = {
      chainId: 11142220,
      blockNumber: 100n,
      blockHash: replacementHash,
      parentHash: oldHash,
      blockTimestamp: 1n,
    };
    await persistIndexedBlock(block);
    await persistIndexedBlock(block);

    expect(database.upserts[0]?.options).toEqual({ onConflict: "chain_id,block_number,block_hash" });
    expect(database.blocks).toHaveLength(2);
    expect(database.blocks).toContainEqual(expect.objectContaining({ block_hash: oldHash, confirmation_status: "orphaned" }));
    expect(database.blocks).toContainEqual(expect.objectContaining({ block_hash: replacementHash, confirmation_status: "canonical" }));
    expect(database.upserts[1]?.options).toEqual({ onConflict: "chain_id,block_number,block_hash" });
  });

  it("uses the canonical composite key and status in the production event persistence path", async () => {
    const event = {
      chainId: 11142220,
      contractAddress: `0x${"12".repeat(20)}`,
      transactionHash: `0x${"34".repeat(32)}`,
      logIndex: 0,
      blockNumber: 100n,
      blockHash: replacementHash,
      parentHash: oldHash,
      blockTimestamp: 1n,
      transactionIndex: 0,
      eventName: "TestEvent",
      args: {},
    };

    await persistCanonicalEvent(event as never, "governance");

    const blockUpsert = database.upserts.find((operation) => operation.table === "indexed_blocks");
    expect(blockUpsert?.options).toEqual({ onConflict: "chain_id,block_number,block_hash" });
    expect(blockUpsert?.values.confirmation_status).toBe("canonical");
  });

  it("reuses persisted contract metadata that matches the deployment manifest", async () => {
    database.contract = {
      id: "contract-id",
      contract_name: "CeloHTGovernance",
      contract_address: `0x${"12".repeat(20)}`,
      deployment_block: "100",
      deployment_tx_hash: `0x${"34".repeat(32)}`,
    };

    const { ensureCanonicalContract } = await import("@/db/canonical");
    await expect(ensureCanonicalContract({
      chainId: 11142220,
      network: "celoSepolia",
      contractName: "CeloHTGovernance",
      contractAddress: `0x${"12".repeat(20)}`,
      deploymentBlock: 100,
      deploymentTxHash: `0x${"34".repeat(32)}`,
      startBlock: 200,
    })).resolves.toBeUndefined();
    expect(database.upserts.some((operation) => operation.table === "contracts")).toBe(false);
    expect(database.upserts.find((operation) => operation.table === "indexer_sync_state")?.values)
      .toMatchObject({ contract_id: "contract-id", next_block: 200, last_processed_block: 199 });
  });

  it("rejects persisted contract metadata that differs from the deployment manifest", async () => {
    database.contract = {
      id: "contract-id",
      contract_name: "CeloHTGovernance",
      contract_address: `0x${"12".repeat(20)}`,
      deployment_block: "99",
      deployment_tx_hash: `0x${"34".repeat(32)}`,
    };

    const { ensureCanonicalContract } = await import("@/db/canonical");
    await expect(ensureCanonicalContract({
      chainId: 11142220,
      network: "celoSepolia",
      contractName: "CeloHTGovernance",
      contractAddress: `0x${"12".repeat(20)}`,
      deploymentBlock: 100,
      deploymentTxHash: `0x${"34".repeat(32)}`,
    })).rejects.toThrow(/Persisted contract metadata does not match the deployment manifest/);
    expect(database.upserts.some((operation) => operation.table === "contracts")).toBe(false);
  });
});