import { beforeEach, describe, expect, it, vi } from "vitest";

const { writes } = vi.hoisted(() => ({
  writes: [] as Array<{ table: string; action: string; values: Record<string, unknown> }>,
}));

vi.mock("@/db/supabaseClient", () => ({
  getServiceRoleClient: () => ({
    from: (table: string) => {
      class Query implements PromiseLike<{ data: null; error: null }> {
        upsert(values: Record<string, unknown>): this {
          writes.push({ table, action: "upsert", values });
          return this;
        }

        insert(values: Record<string, unknown>): this {
          writes.push({ table, action: "insert", values });
          return this;
        }

        select(): this {
          return this;
        }

        single(): Promise<{ data: { id: string }; error: null }> {
          return Promise.resolve({ data: { id: "contract-id" }, error: null });
        }

        then<TResult1 = { data: null; error: null }, TResult2 = never>(
          onfulfilled?: ((value: { data: null; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
          onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
        ): PromiseLike<TResult1 | TResult2> {
          return Promise.resolve({ data: null, error: null }).then(onfulfilled, onrejected);
        }
      }

      return new Query();
    },
  }),
}));

import { ensureCheckpoint } from "@/db/checkpoints";

describe("checkpoint initialization", () => {
  beforeEach(() => writes.splice(0));

  it("seeds both ledgers immediately before the configured start block", async () => {
    await ensureCheckpoint({
      chainId: 11142220,
      contractName: "governance",
      displayName: "CeloHTGovernance",
      contractAddress: `0x${"11".repeat(20)}`,
      deploymentBlock: 100,
      startBlock: 200,
      network: "celoSepolia",
    });

    const syncState = writes.find((write) => write.table === "indexer_sync_state")?.values;
    const legacyState = writes.find((write) => write.table === "indexer_state")?.values;
    expect(syncState).toMatchObject({ next_block: 200, last_processed_block: 199 });
    expect(legacyState).toMatchObject({ last_processed_block: 199 });
  });
});