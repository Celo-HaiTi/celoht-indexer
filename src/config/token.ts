import type { AbiItem } from "@/config/abiLoader";

// USDm is an ERC-20 token in the official deployment. The Transfer event is
// defined by the ERC-20 interface implemented by that token.
export const USDM_ABI: AbiItem[] = [
  {
    type: "event",
    name: "Transfer",
    anonymous: false,
    inputs: [
      { indexed: true, name: "from", type: "address" },
      { indexed: true, name: "to", type: "address" },
      { indexed: false, name: "value", type: "uint256" },
    ],
  },
];