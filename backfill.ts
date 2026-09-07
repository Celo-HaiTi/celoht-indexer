import type { PublicClient } from "viem";
import { withRetry } from "@/chain/retry";
import { decodeLog, MalformedEventError } from "@/indexing/eventDecoder";
import { persistEvent } from "@/indexing/persist";
import { updateCheckpointProgress, recordCheckpointError } from "@/db/checkpoints";
import { logger } from "@/util/logger";
import type { AbiItem } from "@/config/abiLoader";
import type { ContractName } from "@/config/network";

export interface BackfillParams {
  client: PublicClient;
  chainId: number;
  contract: ContractName;
  contractAddress: `0x${string}`;
  abi: AbiItem[];
  fromBlock: bigint;
  toBlock: bigint; // last confirmed block, inclusive
  batchSize: number;
  maxRetries: number;
}

/**
 * Backfills [fromBlock, toBlock] in chunks of `batchSize`, persisting each
 * chunk's events and advancing the checkpoint only after a chunk fully
 * succeeds — so a crash mid-backfill resumes at the last completed chunk
 * boundary rather than re-scanning from the deployment block or silently
 * skipping a range.
 */
export async function runBackfill(params: BackfillParams): Promise<void> {
  const { client, chainId, contract, contractAddress, abi, toBlock, batchSize, maxRetries } = params;
  let cursor = params.fromBlock;

  if (cursor > toBlock) {
    logger.info("backfill_already_caught_up", { contract, cursor: cursor.toString(), toBlock: toBlock.toString() });
    return;
  }

  logger.info("backfill_start", { contract, fromBlock: cursor.toString(), toBlock: toBlock.toString() });

  while (cursor <= toBlock) {
    const chunkEnd = cursor + BigInt(batchSize) - 1n > toBlock ? toBlock : cursor + BigInt(batchSize) - 1n;

    try {
      const logs = await withRetry(
        () =>
          client.getLogs({
            address: contractAddress,
            fromBlock: cursor,
            toBlock: chunkEnd,
          }),
        { maxRetries, label: `getLogs(${contract}, ${cursor}-${chunkEnd})` }
      );

      for (const log of logs) {
        try {
          const decoded = decodeLog({ log, abi, chainId, contractAddress });
          await persistEvent(decoded, contract);
        } catch (err) {
          if (err instanceof MalformedEventError) {
            logger.error("malformed_event_skipped", {
              contract,
              tx: log.transactionHash,
              logIndex: log.logIndex,
              error: err.message,
            });
            continue; // never persist malformed data; skip just this log
          }
          throw err;
        }
      }

      await updateCheckpointProgress({
        chainId,
        contractAddress,
        lastProcessedBlock: chunkEnd,
        latestConfirmedBlock: toBlock,
      });

      logger.info("backfill_chunk_complete", { contract, from: cursor.toString(), to: chunkEnd.toString(), events: logs.length });
      cursor = chunkEnd + 1n;
    } catch (err) {
      await recordCheckpointError({ chainId, contractAddress, errorMessage: String(err) });
      throw err;
    }
  }

  logger.info("backfill_complete", { contract, toBlock: toBlock.toString() });
}
