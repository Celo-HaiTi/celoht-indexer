import { describe, it, expect } from "vitest";
import { loadAbi, eventNamesFromAbi } from "@/config/abiLoader";
import { loadUsdmAbi, VERIFIED_USDM_ABI_SHA256 } from "@/config/token";
import { CONTRACT_NAMES } from "@/config/network";

describe("loadAbi", () => {
  it("loads event-bearing official ABIs for every indexed CeloHT contract", () => {
    for (const contract of CONTRACT_NAMES) {
      expect(eventNamesFromAbi(loadAbi(contract)).length, contract).toBeGreaterThan(0);
    }
  });

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
