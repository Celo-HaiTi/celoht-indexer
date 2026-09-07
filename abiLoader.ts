import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { CONTRACT_DISPLAY_NAMES, type ContractName } from "@/config/network";

/**
 * Loads a contract ABI from abis/<DisplayName>.json.
 *
 * This function NEVER returns a fabricated or partial ABI. If the file is
 * missing or is not a valid ABI array, it throws — the caller must treat
 * that contract as un-indexable rather than guessing event signatures.
 *
 * Accepts either:
 *  - a raw ABI array, or
 *  - a Hardhat/Foundry artifact object with an `abi` field,
 * since official tooling can export either shape.
 */
export class AbiLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AbiLoadError";
  }
}

// Minimal shape check only — we intentionally do not attempt to
// re-validate ABI semantics; the compiled ABI from the official repository
// is trusted as-is once its file shape is confirmed to be a real ABI.
export type AbiItem = Record<string, unknown>;

export function loadAbi(contract: ContractName): AbiItem[] {
  const displayName = CONTRACT_DISPLAY_NAMES[contract];
  const filePath = path.resolve(process.cwd(), "abis", `${displayName}.json`);

  if (!existsSync(filePath)) {
    throw new AbiLoadError(
      `Missing ABI file for ${displayName} at ${filePath}. Copy the compiled ABI from ` +
        `Celo-HaiTi/celoht-smart-contracts before starting the indexer for this contract. ` +
        `Refusing to index ${displayName} with a guessed or partial ABI.`
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    throw new AbiLoadError(`Failed to parse ${filePath} as JSON: ${(err as Error).message}`);
  }

  const abi = Array.isArray(raw) ? raw : (raw as { abi?: unknown }).abi;

  if (!Array.isArray(abi) || abi.length === 0) {
    throw new AbiLoadError(`${filePath} does not contain a non-empty ABI array.`);
  }

  return abi as AbiItem[];
}

export function eventNamesFromAbi(abi: AbiItem[]): string[] {
  return abi
    .filter((item) => item.type === "event" && typeof item.name === "string")
    .map((item) => item.name as string);
}
