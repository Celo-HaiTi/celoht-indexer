import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { AbiLoadError, eventNamesFromAbi, loadAbiFile, type AbiItem } from "@/config/abiLoader";

export const VERIFIED_USDM_ABI_SHA256 = "c9a8c29a950e13c1ef27291f65d7bbc7475247af36f97bb6df1af9f3cfbc2031";

export function loadUsdmAbi(): AbiItem[] {
  const filePath = path.resolve(process.cwd(), "abis", "USDm.json");
  const artifactHash = createHash("sha256").update(readFileSync(filePath)).digest("hex");
  if (artifactHash !== VERIFIED_USDM_ABI_SHA256) {
    throw new AbiLoadError(
      `USDm ABI hash ${artifactHash} does not match the verified implementation artifact ${VERIFIED_USDM_ABI_SHA256}.`
    );
  }
  const abi = loadAbiFile("USDm");
  const transfer = abi.find((item) => item.type === "event" && item.name === "Transfer");
  if (!transfer || !hasCanonicalTransferShape(transfer)) {
    throw new AbiLoadError(
      "USDm ABI must contain the canonical ERC-20 Transfer(address indexed from, address indexed to, uint256 value) event. " +
        "Refusing to index USDm with an incomplete or guessed ABI."
    );
  }
  if (!eventNamesFromAbi(abi).includes("Transfer")) {
    throw new AbiLoadError("USDm ABI does not expose a Transfer event.");
  }
  if (!abi.some((item) => item.type === "function" && item.name === "decimals")) {
    throw new AbiLoadError("USDm ABI must expose the canonical decimals() function.");
  }
  return abi;
}

function hasCanonicalTransferShape(item: Record<string, unknown>): boolean {
  const inputs = item.inputs;
  if (!Array.isArray(inputs) || inputs.length !== 3) return false;
  const [from, to, value] = inputs as Array<Record<string, unknown>>;
  return from?.type === "address" && from.indexed === true &&
    to?.type === "address" && to.indexed === true &&
    value?.type === "uint256" && value.indexed === false;
}