import { describe, it, expect } from "vitest";
import { loadAbi, eventNamesFromAbi } from "@/config/abiLoader";
import { loadUsdmAbi, VERIFIED_USDM_ABI_SHA256 } from "@/config/token";

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

  it("loads the verified USDm implementation artifact", () => {
    expect(VERIFIED_USDM_ABI_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(eventNamesFromAbi(loadUsdmAbi())).toContain("Transfer");
  });
});
