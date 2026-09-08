import { describe, it, expect } from "vitest";
import { loadAbi, eventNamesFromAbi } from "@/config/abiLoader";
import { AbiLoadError } from "@/config/abiLoader";
import { loadUsdmAbi } from "@/config/token";

describe("loadAbi", () => {
  it("loads the compiled ABI from the authoritative artifact", () => {
    const abi = loadAbi("agentRegistry");
    expect(eventNamesFromAbi(abi)).toContain("AgentRegistered");
  });

  it("contains the deployed governance event set", () => {
    const names = eventNamesFromAbi(loadAbi("governance"));
    expect(names).toEqual(expect.arrayContaining([
      "ProposalCreated",
      "VoteCast",
      "ProposalFinalized",
      "ParticipationFeeUpdated",
      "TreasuryUpdated",
      "ProposerAuthorizationChanged",
    ]));
  });

  it("fails closed when the canonical USDm artifact is unavailable", () => {
    expect(() => loadUsdmAbi()).toThrow(AbiLoadError);
  });
});
