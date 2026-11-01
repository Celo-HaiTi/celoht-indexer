import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loadDeploymentMetadata,
  NetworkConfigError,
  CELO_SEPOLIA_CHAIN_ID,
  MAINNET_CHAIN_ID,
} from "@/config/network";

describe("loadDeploymentMetadata", () => {
  it("fails closed when the allowed network manifest is missing", () => {
    const originalDirectory = process.cwd();
    const emptyWorkspace = mkdtempSync(path.join(tmpdir(), "celoht-indexer-no-manifest-"));
    try {
      process.chdir(emptyWorkspace);
      expect(() => loadDeploymentMetadata("celoSepolia")).toThrow(/No deployment metadata file found/);
    } finally {
      process.chdir(originalDirectory);
      rmSync(emptyWorkspace, { recursive: true, force: true });
    }
  });

  it("loads and validates the official celoSepolia deployment file", () => {
    const meta = loadDeploymentMetadata("celoSepolia");
    expect(meta.chainId).toBe(CELO_SEPOLIA_CHAIN_ID);
    expect(meta.network).toBe("celoSepolia");
    for (const contract of ["agentRegistry", "servicePayments", "education", "reforestation", "governance"] as const) {
      expect(meta[contract]).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
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
