import type { PublicClient } from "viem";
import { withRetry } from "@/chain/retry";
import { decodeLog, MalformedEventError } from "@/indexing/eventDecoder";
import { persistEvent } from "@/indexing/persist";
import { updateCheckpointProgress, recordCheckpointError } from "@/db/checkpoints";
import { persistIndexedBlock } from "@/db/canonical";
import { logger } from "@/util/logger";
import type { AbiItem } from "@/config/abiLoader";
import type { IndexTargetName } from "@/config/network";

export interface BackfillParams {
  client: PublicClient;
  chainId: number;
  contract: IndexTargetName;
  contractAddress: `0x${string}`;
  abi: AbiItem[];
  fromBlock: bigint;
  toBlock: bigint; // last confirmed block, inclusive
  batchSize: number;
  maxRetries: number;
  dryRun?: boolean;
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
          const block = await withRetry(
            () => client.getBlock({ blockNumber: log.blockNumber as bigint }),
            { maxRetries, label: `getBlock(${log.blockNumber})` }
          );
          const decoded = decodeLog({
            log,
            abi,
            chainId,
            contractAddress,
            blockTimestamp: block.timestamp,
            parentHash: block.parentHash,
          });
          if (params.dryRun) {
            logger.info("dry_run_event", { contract, event: decoded.eventName, block: decoded.blockNumber.toString() });
          } else {
            await persistEvent(decoded, contract);
          }
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

      if (!params.dryRun) {
        const endBlock = await withRetry(
          () => client.getBlock({ blockNumber: chunkEnd }),
          { maxRetries, label: `getBlock(${chunkEnd})` }
        );
        await persistIndexedBlock({
          chainId,
          blockNumber: chunkEnd,
          blockHash: endBlock.hash,
          parentHash: endBlock.parentHash,
          blockTimestamp: endBlock.timestamp,
        });
      }

      if (!params.dryRun) await updateCheckpointProgress({
        chainId,
        contractAddress,
        lastProcessedBlock: chunkEnd,
        latestConfirmedBlock: toBlock,
      });

      logger.info("backfill_chunk_complete", { contract, from: cursor.toString(), to: chunkEnd.toString(), events: logs.length });
      cursor = chunkEnd + 1n;
    } catch (err) {
      if (!params.dryRun) {
        try {
          await recordCheckpointError({ chainId, contractAddress, errorMessage: String(err) });
        } catch (checkpointError) {
          logger.error("checkpoint_error_record_failed", { contract, error: String(checkpointError) });
        }
      }
      throw err;
    }
  }

  logger.info("backfill_complete", { contract, toBlock: toBlock.toString() });
}
