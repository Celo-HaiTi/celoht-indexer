import { describe, it, expect, vi } from "vitest";
import { classifyRpcError, withRetry } from "@/chain/retry";

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

  it("does not retry a permanent historical-retention error", async () => {
    const fn = vi.fn().mockRejectedValue({ code: -32602, message: "block is more than 10064 blocks behind head" });

    await expect(withRetry(fn, {
      maxRetries: 5,
      baseDelayMs: 1,
      label: "archive.getBlock",
      endpointRole: "archive",
      requestedBlock: "35343240",
    })).rejects.toMatchObject({ name: "RpcProviderCapabilityError", category: "historical_retention_limit" });

    expect(fn).toHaveBeenCalledOnce();
  });

  it("classifies range limits for adaptive splitting without retrying the same range", async () => {
    const rangeError = { code: -32602, message: "block range exceeds maximum range" };
    const fn = vi.fn().mockRejectedValue(rangeError);

    await expect(withRetry(fn, {
      maxRetries: 4,
      baseDelayMs: 1,
      label: "archive.getLogs",
      endpointRole: "archive",
      requestedRange: "100-2000",
    })).rejects.toBe(rangeError);

    expect(classifyRpcError(rangeError)).toBe("range_limit");
    expect(fn).toHaveBeenCalledOnce();
  });

  it("retries rate-limited requests using the configured backoff", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce({ code: 429, message: "rate limit exceeded" })
      .mockResolvedValue("ok");

    await expect(withRetry(fn, { maxRetries: 2, baseDelayMs: 1, label: "archive.getLogs", endpointRole: "archive" }))
      .resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(classifyRpcError({ code: 429, message: "rate limit exceeded" })).toBe("rate_limit");
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
