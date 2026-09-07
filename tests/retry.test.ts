import { describe, it, expect, vi } from "vitest";
import { withRetry } from "@/chain/retry";

describe("withRetry", () => {
  it("returns the result on first success without retrying", async () => {
    const fn = vi.fn().mockResolvedValue(42);
    const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 1, label: "test" });
    expect(result).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on failure and eventually succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("rpc timeout"))
      .mockRejectedValueOnce(new Error("rpc timeout"))
      .mockResolvedValue("ok");
    const result = await withRetry(fn, { maxRetries: 5, baseDelayMs: 1, label: "test" });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws the last error after exhausting retries", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("permanent failure"));
    await expect(withRetry(fn, { maxRetries: 2, baseDelayMs: 1, label: "test" })).rejects.toThrow("permanent failure");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("caps exponential backoff", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const promise = withRetry(
      async () => {
        calls += 1;
        throw new Error("permanent failure");
      },
      { maxRetries: 2, baseDelayMs: 100, maxDelayMs: 150, label: "bounded" }
    );
    const rejection = expect(promise).rejects.toThrow("permanent failure");
    await vi.advanceTimersByTimeAsync(300);
    await rejection;
    expect(calls).toBe(3);
    vi.useRealTimers();
  });
});
