import { describe, it, expect } from "vitest";
import { loadAbi, eventNamesFromAbi } from "@/config/abiLoader";

describe("loadAbi", () => {
  it("loads the compiled ABI from the authoritative artifact", () => {
    const abi = loadAbi("agentRegistry");
    expect(eventNamesFromAbi(abi)).toContain("AgentRegistered");
  });
});
