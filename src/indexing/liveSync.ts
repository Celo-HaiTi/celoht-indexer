import type { PublicClient } from "viem";
import { getConfirmedBlockNumber } from "@/chain/provider";
import { runBackfill } from "@/indexing/backfill";
import { detectAndHandleReorg } from "@/indexing/reorg";
import { getCheckpoint } from "@/db/checkpoints";
import { logger } from "@/util/logger";
import { serializeError } from "@/util/errorSerializer";
import { RpcProviderCapabilityError } from "@/chain/retry";
import type { AbiItem } from "@/config/abiLoader";
import type { IndexTargetName } from "@/config/network";

export interface SyncTarget {
  contract: IndexTargetName;
  contractAddress: `0x${string}`;
  abi: AbiItem[];
  deploymentBlock: number;
  startBlock: number;
}

export interface LiveSyncParams {
  client: PublicClient;
  historicalClient: PublicClient;
  chainId: number;
  confirmations: number;
  batchSize: number;
  minBatchSize: number;
  backfillConcurrency: number;
  backfillChunksPerPass: number;
  maxRetries: number;
  targets: SyncTarget[];
  adaptiveBatchSizes?: Map<string, number>;
  dryRun?: boolean;
}

/** Runs one full reconciliation pass for every configured contract:
 * reorg check -> backfill any newly confirmed blocks. Never depends
 * exclusively on WebSocket subscriptions — this is a poll/reconcile model
 * suitable for restart-safe, at-least-once processing. */
export async function runSyncPass(params: LiveSyncParams): Promise<void> {
  const confirmedBlock = await getConfirmedBlockNumber(params.client, params.confirmations, params.maxRetries);

  for (const target of params.targets) {
    const checkpoint = params.dryRun
      ? {
          lastProcessedBlock: null,
          nextBlock: BigInt(target.startBlock),
          lastProcessedBlockHash: null,
          lastProcessedParentHash: null,
          latestConfirmedBlock: null,
          syncStatus: "idle" as const,
        }
      : await getCheckpoint({
          chainId: params.chainId,
          contractAddress: target.contractAddress,
          client: params.historicalClient,
          initialBlock: target.startBlock,
          maxRetries: params.maxRetries,
        });

    if (!params.dryRun && checkpoint.lastProcessedBlock !== null) {
      const { reorgDetected, safeBlock } = await detectAndHandleReorg({
        client: params.historicalClient,
        chainId: params.chainId,
        contractAddress: target.contractAddress,
        lastProcessedBlock: checkpoint.lastProcessedBlock,
        lastProcessedBlockHash: checkpoint.lastProcessedBlockHash,
        lastProcessedParentHash: checkpoint.lastProcessedParentHash,
        latestConfirmedBlock: checkpoint.latestConfirmedBlock,
        deploymentBlock: target.deploymentBlock,
        maxRetries: params.maxRetries,
      });
      if (reorgDetected) {
        logger.warn("checkpoint_rolled_back", { contract: target.contract, safeBlock: safeBlock.toString() });
      }
    }

    const freshCheckpoint = params.dryRun
      ? checkpoint
      : await getCheckpoint({
          chainId: params.chainId,
          contractAddress: target.contractAddress,
          client: params.historicalClient,
          initialBlock: target.startBlock,
          maxRetries: params.maxRetries,
        });
    const fromBlock = freshCheckpoint.nextBlock;

    if (fromBlock > confirmedBlock) {
      logger.info("sync_pass_no_new_blocks", { contract: target.contract });
      continue;
    }

    const adaptiveKey = `${params.chainId}:${target.contractAddress.toLowerCase()}`;
    const currentBatchSize = params.adaptiveBatchSizes?.get(adaptiveKey) ?? params.batchSize;
    const nextBatchSize = await runBackfill({
      client: params.historicalClient,
      chainId: params.chainId,
      contract: target.contract,
      contractAddress: target.contractAddress,
      abi: target.abi,
      fromBlock,
      toBlock: confirmedBlock,
      batchSize: params.batchSize,
      currentBatchSize,
      minBatchSize: params.minBatchSize,
      maxConcurrency: params.backfillConcurrency,
      maxChunksPerRun: params.backfillChunksPerPass,
      maxRetries: params.maxRetries,
      dryRun: params.dryRun,
    });
    params.adaptiveBatchSizes?.set(adaptiveKey, nextBatchSize);
  }
}

/** Polls `runSyncPass` on an interval until the process receives a shutdown
 * signal. Graceful shutdown lets an in-flight pass finish before exiting. */
export function startLiveSyncLoop(params: LiveSyncParams & { pollIntervalMs: number }): {
  stop: () => Promise<void>;
} {
  let stopped = false;
  let currentRun: Promise<void> = Promise.resolve();
  const adaptiveBatchSizes = new Map<string, number>();

  const loop = async () => {
    while (!stopped) {
      currentRun = runSyncPass({ ...params, adaptiveBatchSizes }).catch((err) => {
        logger.error("sync_pass_failed", { error: serializeError(err) });
        if (hasPermanentProviderCapabilityError(err)) {
          stopped = true;
          logger.error("sync_loop_stopped_permanent_rpc_capability_error", { error: serializeError(err) });
        }
      });
      await currentRun;
      if (stopped) break;
      await new Promise((resolve) => setTimeout(resolve, params.pollIntervalMs));
    }
  };

  void loop();

  return {
    stop: async () => {
      stopped = true;
      await currentRun;
    },
  };
}

function hasPermanentProviderCapabilityError(error: unknown, seen = new WeakSet<object>()): boolean {
  if (error instanceof RpcProviderCapabilityError) return true;
  if (!error || typeof error !== "object" || seen.has(error)) return false;
  seen.add(error);
  return hasPermanentProviderCapabilityError((error as { cause?: unknown }).cause, seen);
}
