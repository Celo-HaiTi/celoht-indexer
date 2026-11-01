import { beforeEach, describe, expect, it, vi } from "vitest";

const { operations } = vi.hoisted(() => ({
  operations: [] as Array<{ table: string; action: string; args: unknown[] }>,
}));

vi.mock("@/db/supabaseClient", () => ({
  getServiceRoleClient: () => ({
    from: (table: string) => {
      class Query implements PromiseLike<{ error: null }> {
        update(value: unknown): this {
          operations.push({ table, action: "update", args: [value] });
          return this;
        }

        delete(): this {
          operations.push({ table, action: "delete", args: [] });
          return this;
        }

        eq(column: string, value: unknown): this {
          operations.push({ table, action: "eq", args: [column, value] });
          return this;
        }

        gt(column: string, value: unknown): this {
          operations.push({ table, action: "gt", args: [column, value] });
          return this;
        }

        in(column: string, values: unknown[]): this {
          operations.push({ table, action: "in", args: [column, values] });
          return this;
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

import { rollbackCheckpoint } from "@/db/checkpoints";

describe("rollbackCheckpoint", () => {
  beforeEach(() => operations.splice(0));

  it("retains and orphans invalidated history while rewinding every affected contract checkpoint", async () => {
    await rollbackCheckpoint({
      chainId: 11142220,
      safeBlock: 100n,
      safeBlockHash: `0x${"aa".repeat(32)}`,
      safeParentHash: `0x${"bb".repeat(32)}`,
    });

    expect(operations).toContainEqual({
      table: "indexed_blocks",
      action: "update",
      args: [{ confirmation_status: "orphaned" }],
    });
    expect(operations).toContainEqual({
      table: "indexed_blocks",
      action: "gt",
      args: ["block_number", "100"],
    });
    expect(operations).toContainEqual({
      table: "indexed_blocks",
      action: "in",
      args: ["confirmation_status", ["canonical", "confirmed"]],
    });
    expect(operations).toContainEqual({
      table: "blockchain_events",
      action: "update",
      args: [{ confirmation_status: "orphaned" }],
    });
    expect(operations).toContainEqual({
      table: "indexed_transactions",
      action: "update",
      args: [{ confirmation_status: "orphaned" }],
    });
    expect(operations).toContainEqual({
      table: "blockchain_transactions",
      action: "update",
      args: [{ confirmed: false }],
    });
    expect(operations.some((operation) => operation.action === "delete")).toBe(false);

    const legacyCheckpointFilters = operations.filter((operation) => operation.table === "indexer_state");
    expect(legacyCheckpointFilters).toContainEqual({
      table: "indexer_state",
      action: "gt",
      args: ["last_processed_block", "100"],
    });
    expect(legacyCheckpointFilters).not.toContainEqual(
      expect.objectContaining({ action: "eq", args: ["contract_address", expect.anything()] })
    );

    expect(operations).toContainEqual({
      table: "indexer_sync_state",
      action: "gt",
      args: ["last_processed_block", "100"],
    });
    expect(operations).toContainEqual({
      table: "indexer_sync_state",
      action: "eq",
      args: ["chain_id", 11142220],
    });
    expect(operations).toContainEqual({
      table: "indexer_sync_state",
      action: "update",
      args: [expect.objectContaining({
        next_block: "101",
        last_processed_block: "100",
        last_processed_block_hash: `0x${"aa".repeat(32)}`,
        last_processed_parent_hash: `0x${"bb".repeat(32)}`,
        safe_block: "100",
      })],
    });
  });

  it("is idempotent when recovery is repeated and leaves orphan history intact", async () => {
    const params = {
      chainId: 11142220,
      safeBlock: 100n,
      safeBlockHash: `0x${"aa".repeat(32)}`,
      safeParentHash: null,
    };

    await rollbackCheckpoint(params);
    const firstCallCount = operations.length;
    await rollbackCheckpoint(params);

    expect(operations).toHaveLength(firstCallCount * 2);
    expect(operations.filter((operation) => operation.table === "indexed_blocks" && operation.action === "delete")).toHaveLength(0);
    expect(operations.filter((operation) => operation.table === "indexed_blocks" && operation.action === "update")).toHaveLength(2);
  });
});