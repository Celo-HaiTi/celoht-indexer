import { describe, it, expect } from "vitest";
import { loadAbi, AbiLoadError } from "@/config/abiLoader";

describe("loadAbi", () => {
  it("fails closed when the ABI file is missing (expected in this repo until populated)", () => {
    // abis/ intentionally ships without real ABI files (see abis/README.md).
    expect(() => loadAbi("agentRegistry")).toThrow(AbiLoadError);
  });
});
