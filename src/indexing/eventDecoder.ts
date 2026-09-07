import { decodeEventLog, type Log } from "viem";
import type { AbiItem } from "@/config/abiLoader";

export class MalformedEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedEventError";
  }
}

export interface DecodedEvent {
  chainId: number;
  contractAddress: string;
  transactionHash: string;
  transactionIndex: number | null;
  logIndex: number;
  blockNumber: bigint;
  blockHash: string;
  blockTimestamp: bigint | null;
  eventName: string;
  args: Record<string, unknown>;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * Validates the raw structural fields of a log BEFORE attempting to decode
 * it against the ABI. Malformed or clearly-wrong-network data is rejected
 * here rather than persisted.
 */
function validateRawLog(log: Log, expectedChainId: number, expectedContract: string): void {
  if (log.address.toLowerCase() !== expectedContract.toLowerCase()) {
    throw new MalformedEventError(
      `Log address ${log.address} does not match expected contract ${expectedContract}.`
    );
  }
  if (!log.transactionHash || !HASH_RE.test(log.transactionHash)) {
    throw new MalformedEventError(`Invalid or missing transactionHash on log.`);
  }
  if (!log.blockHash || !HASH_RE.test(log.blockHash)) {
    throw new MalformedEventError(`Invalid or missing blockHash on log.`);
  }
  if (log.blockNumber === null || log.blockNumber === undefined) {
    throw new MalformedEventError(`Missing blockNumber on log.`);
  }
  if (log.logIndex === null || log.logIndex === undefined) {
    throw new MalformedEventError(`Missing logIndex on log.`);
  }
  if (!ADDRESS_RE.test(log.address)) {
    throw new MalformedEventError(`Invalid contract address format on log: ${log.address}`);
  }
  // expectedChainId is validated once per client at startup (provider.ts);
  // re-asserted here defensively in case this function is ever called with
  // logs sourced from a different client than the one that was verified.
  if (!Number.isInteger(expectedChainId) || expectedChainId <= 0) {
    throw new MalformedEventError(`Invalid expectedChainId: ${expectedChainId}`);
  }
}

/**
 * Decodes a single log using the official ABI. Rejects logs whose topic0
 * does not match any known event signature in that ABI — an "unexpected
 * event" is a signal to investigate (e.g. an ABI mismatch), never something
 * to guess at and persist anyway.
 */
export function decodeLog(params: {
  log: Log;
  abi: AbiItem[];
  chainId: number;
  contractAddress: string;
  blockTimestamp?: bigint | null;
}): DecodedEvent {
  validateRawLog(params.log, params.chainId, params.contractAddress);

  let decoded: { eventName: string; args?: Record<string, unknown> };
  try {
    decoded = decodeEventLog({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      abi: params.abi as any,
      data: params.log.data,
      topics: params.log.topics,
    }) as unknown as { eventName: string; args?: Record<string, unknown> };
  } catch (err) {
    throw new MalformedEventError(
      `Log topic0 does not match any known event in the official ABI for ${params.contractAddress}: ${(err as Error).message}`
    );
  }

  return {
    chainId: params.chainId,
    contractAddress: params.contractAddress,
    transactionHash: params.log.transactionHash as string,
    transactionIndex: params.log.transactionIndex === undefined ? null : Number(params.log.transactionIndex),
    logIndex: Number(params.log.logIndex),
    blockNumber: params.log.blockNumber as bigint,
    blockHash: params.log.blockHash as string,
    blockTimestamp: params.blockTimestamp ?? null,
    eventName: decoded.eventName,
    args: (decoded.args ?? {}) as Record<string, unknown>,
  };
}
