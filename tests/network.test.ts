import { describe, it, expect } from "vitest";
import { loadDeploymentMetadata, NetworkConfigError, MAINNET_CHAIN_ID } from "@/config/network";

describe("loadDeploymentMetadata", () => {
  it("loads and validates the official celoSepolia deployment file", () => {
    const meta = loadDeploymentMetadata("celoSepolia");
    expect(meta.chainId).toBe(11142220);
    expect(meta.network).toBe("celoSepolia");
    expect(meta.agentRegistry).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(meta.canonicalRepositoryCommit).toBe("bdfc9ecf879f09418fb609b0695986b5dbe6ee27");
  });

  it("fails closed for an unlisted network (e.g. Mainnet)", () => {
    expect(() => loadDeploymentMetadata("celoMainnet")).toThrow(NetworkConfigError);
  });

  it("fails closed for a completely unknown network name", () => {
    expect(() => loadDeploymentMetadata("someRandomNetwork")).toThrow(NetworkConfigError);
  });

  it("never allows the configured Mainnet chain id to be loaded", () => {
    expect(MAINNET_CHAIN_ID).toBe(42220);
    // celoSepolia's own chainId must not equal Mainnet's.
    const meta = loadDeploymentMetadata("celoSepolia");
    expect(meta.chainId).not.toBe(MAINNET_CHAIN_ID);
  });
});
