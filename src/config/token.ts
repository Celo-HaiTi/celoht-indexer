import { AbiLoadError, eventNamesFromAbi, loadAbiFile, type AbiItem } from "@/config/abiLoader";

export function loadUsdmAbi(): AbiItem[] {
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