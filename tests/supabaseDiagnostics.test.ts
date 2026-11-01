import { describe, expect, it, vi } from "vitest";

const { loggerError } = vi.hoisted(() => ({ loggerError: vi.fn() }));

vi.mock("@/util/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: loggerError },
}));

import { throwSupabaseError } from "@/db/supabaseDiagnostics";

describe("throwSupabaseError", () => {
  it("logs the failing table operation and structured PostgREST error before rethrowing", () => {
    const error = {
      code: "PGRST205",
      message: "Could not find the table 'public.indexer_state' in the schema cache",
      details: "Searched schema public",
      hint: "Apply the reviewed indexer migration",
      status: 404,
    };

    try {
      throwSupabaseError("indexer_state.insert", error);
      throw new Error("Expected the PostgREST error to be rethrown");
    } catch (caught) {
      expect(caught).toBe(error);
    }

    expect(loggerError).toHaveBeenCalledWith(
      "supabase_operation_failed",
      expect.objectContaining({
        operation: "indexer_state.insert",
        error: expect.objectContaining({
          code: "PGRST205",
          status: 404,
          message: expect.stringContaining("public.indexer_state"),
          hint: "Apply the reviewed indexer migration",
        }),
      })
    );
  });
});