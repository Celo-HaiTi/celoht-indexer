import type { PublicClient } from "viem";
import { classifyRpcError, RpcProviderCapabilityError, withRetry } from "@/chain/retry";
import { decodeLog, MalformedEventError } from "@/indexing/eventDecoder";
import { persistEvent } from "@/indexing/persist";
import { updateCheckpointProgress, recordCheckpointError } from "@/db/checkpoints";
import { logger } from "@/util/logger";
import { formatErrorMessage, serializeError } from "@/util/errorSerializer";
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
      const logs = await fetchLogsInBoundedRanges({
        client,
        contract,
        contractAddress,
        fromBlock: cursor,
        toBlock: chunkEnd,
        maxRetries,
      });
      const eventBlockCache = new Map<bigint, Promise<Awaited<ReturnType<PublicClient["getBlock"]>>>>();

      for (const log of logs) {
        try {
          if (
            log.blockNumber === null || typeof log.blockHash !== "string" ||
            log.blockNumber < cursor || log.blockNumber > chunkEnd
          ) {
            throw new MalformedEventError("RPC returned an event outside the requested range or without a block number/hash.");
          }
          let blockPromise = eventBlockCache.get(log.blockNumber);
          if (!blockPromise) {
            blockPromise = withRetry(
              () => client.getBlock({ blockNumber: log.blockNumber as bigint }),
              {
                maxRetries,
                label: `getBlock(${log.blockNumber})`,
                endpointRole: "archive",
                requestedBlock: log.blockNumber.toString(),
              }
            );
            eventBlockCache.set(log.blockNumber, blockPromise);
          }
          const block = await blockPromise;
          verifyBlockHeader(block, log.blockNumber, log.blockHash, contract);
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
              error: serializeError(err),
            });
            throw err;
          }
          throw err;
        }
      }

      if (!params.dryRun) {
        let endBlockPromise = eventBlockCache.get(chunkEnd);
        if (!endBlockPromise) {
          endBlockPromise = withRetry(
            () => client.getBlock({ blockNumber: chunkEnd }),
            {
              maxRetries,
              label: `getBlock(${chunkEnd})`,
              endpointRole: "archive",
              requestedBlock: chunkEnd.toString(),
            }
          );
          eventBlockCache.set(chunkEnd, endBlockPromise);
        }
        const endBlock = await endBlockPromise;
        verifyBlockHeader(endBlock, chunkEnd, null, contract);
        await updateCheckpointProgress({
          chainId,
          contractAddress,
          lastProcessedBlock: chunkEnd,
          latestConfirmedBlock: toBlock,
          blockHash: endBlock.hash as string,
          parentHash: endBlock.parentHash,
          blockTimestamp: endBlock.timestamp,
        });
      }

      logger.info("backfill_chunk_complete", { contract, from: cursor.toString(), to: chunkEnd.toString(), events: logs.length });
      cursor = chunkEnd + 1n;
    } catch (err) {
      if (!params.dryRun) {
        try {
          await recordCheckpointError({ chainId, contractAddress, errorMessage: formatErrorMessage(err) });
        } catch (checkpointError) {
          logger.error("checkpoint_error_record_failed", { contract, error: String(checkpointError) });
        }
      }
      throw err;
    }
  }

  logger.info("backfill_complete", { contract, toBlock: toBlock.toString() });
}

async function fetchLogsInBoundedRanges(params: {
  client: PublicClient;
  contract: IndexTargetName;
  contractAddress: `0x${string}`;
  fromBlock: bigint;
  toBlock: bigint;
  maxRetries: number;
}): Promise<Awaited<ReturnType<PublicClient["getLogs"]>>> {
  try {
    return await withRetry(
      () => params.client.getLogs({
        address: params.contractAddress,
        fromBlock: params.fromBlock,
        toBlock: params.toBlock,
      }),
      {
        maxRetries: params.maxRetries,
        label: `getLogs(${params.contract}, ${params.fromBlock}-${params.toBlock})`,
        endpointRole: "archive",
        requestedRange: `${params.fromBlock}-${params.toBlock}`,
      }
    );
  } catch (error) {
    if (classifyRpcError(error) !== "range_limit") throw error;
    if (params.fromBlock >= params.toBlock) {
      logger.error("rpc_log_range_unserviceable", {
        endpointRole: "archive",
        contract: params.contract,
        requestedRange: `${params.fromBlock}-${params.toBlock}`,
        errorCategory: "range_limit",
        error: serializeError(error),
      });
      throw new RpcProviderCapabilityError(
        `Archive RPC cannot serve getLogs for block ${params.fromBlock} even as a single-block range`,
        "range_limit",
        { cause: error }
      );
    }

    const midpoint = params.fromBlock + (params.toBlock - params.fromBlock) / 2n;
    logger.warn("rpc_log_range_split", {
      endpointRole: "archive",
      contract: params.contract,
      requestedRange: `${params.fromBlock}-${params.toBlock}`,
      splitAt: midpoint.toString(),
    });
    const firstHalf = await fetchLogsInBoundedRanges({ ...params, toBlock: midpoint });
    const secondHalf = await fetchLogsInBoundedRanges({ ...params, fromBlock: midpoint + 1n });
    return [...firstHalf, ...secondHalf];
  }
}

function verifyBlockHeader(
  block: Awaited<ReturnType<PublicClient["getBlock"]>>,
  expectedNumber: bigint,
  expectedHash: string | null,
  contract: IndexTargetName
): asserts block is NonNullable<typeof block> {
  const hashPattern = /^0x[0-9a-f]{64}$/i;
  if (
    !block || block.number !== expectedNumber || typeof block.hash !== "string" || !hashPattern.test(block.hash) ||
    typeof block.parentHash !== "string" || !hashPattern.test(block.parentHash) ||
    (expectedHash !== null && (!hashPattern.test(expectedHash) || block.hash.toLowerCase() !== expectedHash.toLowerCase()))
  ) {
    const message = `Archive RPC returned an invalid or mismatched block header at ${expectedNumber} for ${contract}.`;
    logger.error("archive_block_verification_failed", {
      endpointRole: "archive",
      requestedBlock: expectedNumber.toString(),
      contract,
      errorCategory: expectedHash === null ? "invalid_block_header" : "event_block_hash_mismatch",
      returnedBlock: block?.number?.toString() ?? null,
      returnedHash: block?.hash ?? null,
      expectedHash,
    });
    throw new Error(message);
  }
}
