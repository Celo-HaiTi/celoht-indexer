import { describe, it, expect } from "vitest";
import { decodeLog, MalformedEventError } from "@/indexing/eventDecoder";
import type { Log } from "viem";

const SAMPLE_ABI = [
  {
    type: "event",
    name: "AgentRegistered",
    inputs: [
      { indexed: true, name: "agent", type: "address" },
      { indexed: false, name: "timestamp", type: "uint256" },
    ],
  },
];

const CONTRACT = "0x7C5bF20191f6b467aAcd2DD7693110cc4c17Cc2e";

function baseLog(overrides: Partial<Log> = {}): Log {
  return {
    address: CONTRACT,
    topics: [],
    data: "0x",
    blockNumber: 35343240n,
    transactionHash: "0x851713db156384b693a759c7028fad89d75ebb3661c0de98fa4166ee1cdd932",
    transactionIndex: 0,
    blockHash: "0x851713db156384b693a759c7028fad89d75ebb3661c0de98fa4166ee1cdd932",
    logIndex: 0,
    removed: false,
    ...overrides,
  } as Log;
}

describe("decodeLog validation", () => {
  it("rejects a log whose address does not match the expected contract", () => {
    const log = baseLog({ address: "0x0000000000000000000000000000000000000000" as `0x${string}` });
    expect(() => decodeLog({ log, abi: SAMPLE_ABI, chainId: 11142220, contractAddress: CONTRACT })).toThrow(
      MalformedEventError
    );
  });

  it("rejects a log with a malformed transaction hash", () => {
    const log = baseLog({ transactionHash: "0xnothex" as `0x${string}` });
    expect(() => decodeLog({ log, abi: SAMPLE_ABI, chainId: 11142220, contractAddress: CONTRACT })).toThrow(
      MalformedEventError
    );
  });

  it("rejects a log with a missing blockHash", () => {
    const log = baseLog({ blockHash: null as unknown as `0x${string}` });
    expect(() => decodeLog({ log, abi: SAMPLE_ABI, chainId: 11142220, contractAddress: CONTRACT })).toThrow(
      MalformedEventError
    );
  });

  it("rejects a log whose topic0 does not match any event in the ABI (wrong/unexpected event)", () => {
    const log = baseLog({ topics: ["0xdeadbeef00000000000000000000000000000000000000000000000000000000"] as `0x${string}`[] });
    expect(() => decodeLog({ log, abi: SAMPLE_ABI, chainId: 11142220, contractAddress: CONTRACT })).toThrow(
      MalformedEventError
    );
  });
});
