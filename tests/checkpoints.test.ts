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

  it("rewinds every checkpoint beyond a chain-wide common ancestor", async () => {
    await rollbackCheckpoint({ chainId: 11142220, safeBlock: 100n });

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
      args: ["next_block", "101"],
    });
    expect(operations).toContainEqual({
      table: "indexer_sync_state",
      action: "eq",
      args: ["chain_id", 11142220],
    });
  });
});