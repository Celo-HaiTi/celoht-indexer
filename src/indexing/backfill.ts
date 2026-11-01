import type { PublicClient } from "viem";
import { classifyRpcError, isSplittableLogRangeError, RpcProviderCapabilityError, sanitizedRpcMessage, withRetry } from "@/chain/retry";
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
  currentBatchSize?: number;
  minBatchSize?: number;
  maxConcurrency?: number;
  maxChunksPerRun?: number;
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
export async function runBackfill(params: BackfillParams): Promise<number> {
  const { client, chainId, contract, contractAddress, abi, toBlock, batchSize, maxRetries } = params;
  const minBatchSize = params.minBatchSize ?? 1;
  const maxConcurrency = params.maxConcurrency ?? 1;
  const maxChunksPerRun = params.maxChunksPerRun ?? Number.POSITIVE_INFINITY;
  if (!Number.isInteger(batchSize) || batchSize < 1 || !Number.isInteger(minBatchSize) || minBatchSize < 1 || minBatchSize > batchSize) {
    throw new RangeError("Backfill batch sizes must be positive integers with minBatchSize <= batchSize");
  }
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || !(Number.isInteger(maxChunksPerRun) && maxChunksPerRun > 0) && maxChunksPerRun !== Number.POSITIVE_INFINITY) {
    throw new RangeError("Backfill concurrency and chunks-per-run must be positive integers");
  }
  let cursor = params.fromBlock;
  let currentBatchSize = params.currentBatchSize ?? batchSize;
  if (!Number.isInteger(currentBatchSize) || currentBatchSize < minBatchSize || currentBatchSize > batchSize) {
    throw new RangeError("currentBatchSize must be between minBatchSize and batchSize");
  }
  let completedChunks = 0;
  const logRequestLimiter = new Semaphore(maxConcurrency);

  if (cursor > toBlock) {
    logger.info("backfill_already_caught_up", { contract, cursor: cursor.toString(), toBlock: toBlock.toString() });
    return currentBatchSize;
  }

  logger.info("backfill_start", { contract, fromBlock: cursor.toString(), toBlock: toBlock.toString() });

  while (cursor <= toBlock) {
    const chunkEnd = cursor + BigInt(currentBatchSize) - 1n > toBlock ? toBlock : cursor + BigInt(currentBatchSize) - 1n;

    try {
      const fetched = await fetchLogsInBoundedRanges({
        client,
        contract,
        contractAddress,
        fromBlock: cursor,
        toBlock: chunkEnd,
        minBatchSize,
        maxRetries,
        limiter: logRequestLimiter,
      });
      const logs = fetched.logs;
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
      completedChunks += 1;

      const previousBatchSize = currentBatchSize;
      currentBatchSize = fetched.splitCount > 0
        ? Math.max(minBatchSize, fetched.smallestSuccessfulRangeSize)
        : Math.min(batchSize, Math.max(currentBatchSize + 1, Math.ceil(currentBatchSize * 1.25)));
      if (currentBatchSize !== previousBatchSize) {
        logger.info("backfill_range_size_adapted", {
          contract,
          previousBatchSize,
          nextBatchSize: currentBatchSize,
          minimumBatchSize: minBatchSize,
          maximumBatchSize: batchSize,
          splitCount: fetched.splitCount,
        });
      }

      if (completedChunks >= maxChunksPerRun && cursor <= toBlock) {
        logger.info("backfill_pass_yield", {
          contract,
          lastCompletedBlock: (cursor - 1n).toString(),
          nextBlock: cursor.toString(),
          remainingToBlock: toBlock.toString(),
        });
        return currentBatchSize;
      }
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
  return currentBatchSize;
}

async function fetchLogsInBoundedRanges(params: {
  client: PublicClient;
  contract: IndexTargetName;
  contractAddress: `0x${string}`;
  fromBlock: bigint;
  toBlock: bigint;
  minBatchSize: number;
  maxRetries: number;
  limiter: Semaphore;
}): Promise<{ logs: Awaited<ReturnType<PublicClient["getLogs"]>>; smallestSuccessfulRangeSize: number; splitCount: number }> {
  const requestedRangeSize = params.toBlock - params.fromBlock + 1n;
  try {
    const logs = await params.limiter.run(() => withRetry(
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
      ));
    for (const log of logs) {
      if (log.blockNumber === null || log.blockNumber < params.fromBlock || log.blockNumber > params.toBlock) {
        throw new MalformedEventError(
          `Archive RPC returned a log outside requested range ${params.fromBlock}-${params.toBlock}.`
        );
      }
    }
    return { logs, smallestSuccessfulRangeSize: Number(requestedRangeSize), splitCount: 0 };
  } catch (error) {
    const category = classifyRpcError(error);
    if (!isSplittableLogRangeError(category)) throw error;
    if (requestedRangeSize < BigInt(params.minBatchSize) * 2n) {
      logger.error("rpc_log_range_unserviceable", {
        endpointRole: "archive",
        contract: params.contract,
        requestedRange: `${params.fromBlock}-${params.toBlock}`,
        rangeSize: Number(requestedRangeSize),
        minimumBatchSize: params.minBatchSize,
        errorCategory: category,
        providerMessage: sanitizedRpcMessage(error),
        error: serializeError(error),
      });
      throw new RpcProviderCapabilityError(
        `Archive RPC cannot serve getLogs for range ${params.fromBlock}-${params.toBlock} at configured minimum size ${params.minBatchSize} (${category})`,
        category,
        { cause: error }
      );
    }

    const leftSize = requestedRangeSize / 2n;
    const midpoint = params.fromBlock + leftSize - 1n;
    logger.warn("rpc_log_range_split", {
      endpointRole: "archive",
      contract: params.contract,
      requestedRange: `${params.fromBlock}-${params.toBlock}`,
      splitAt: midpoint.toString(),
      rangeSize: Number(requestedRangeSize),
      minimumBatchSize: params.minBatchSize,
      errorCategory: category,
      providerMessage: sanitizedRpcMessage(error),
      error: serializeError(error),
    });
    const [firstHalf, secondHalf] = await Promise.all([
      fetchLogsInBoundedRanges({ ...params, toBlock: midpoint }),
      fetchLogsInBoundedRanges({ ...params, fromBlock: midpoint + 1n }),
    ]);
    return {
      logs: [...firstHalf.logs, ...secondHalf.logs],
      smallestSuccessfulRangeSize: Math.min(firstHalf.smallestSuccessfulRangeSize, secondHalf.smallestSuccessfulRangeSize),
      splitCount: firstHalf.splitCount + secondHalf.splitCount + 1,
    };
  }
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
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
