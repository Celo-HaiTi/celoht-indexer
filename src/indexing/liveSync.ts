import type { PublicClient } from "viem";
import { getConfirmedBlockNumber } from "@/chain/provider";
import { runBackfill } from "@/indexing/backfill";
import { detectAndHandleReorg } from "@/indexing/reorg";
import { getCheckpoint } from "@/db/checkpoints";
import { logger } from "@/util/logger";
import { serializeError } from "@/util/errorSerializer";
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
  chainId: number;
  confirmations: number;
  batchSize: number;
  maxRetries: number;
  targets: SyncTarget[];
  dryRun?: boolean;
}

/** Runs one full reconciliation pass for every configured contract:
 * reorg check -> backfill any newly confirmed blocks. Never depends
 * exclusively on WebSocket subscriptions — this is a poll/reconcile model
 * suitable for restart-safe, at-least-once processing. */
export async function runSyncPass(params: LiveSyncParams): Promise<void> {
  const confirmedBlock = await getConfirmedBlockNumber(params.client, params.confirmations);

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
          client: params.client,
          initialBlock: target.startBlock,
        });

    if (!params.dryRun && checkpoint.lastProcessedBlock !== null) {
      const { reorgDetected, safeBlock } = await detectAndHandleReorg({
        client: params.client,
        chainId: params.chainId,
        contractAddress: target.contractAddress,
        lastProcessedBlock: checkpoint.lastProcessedBlock,
        lastProcessedBlockHash: checkpoint.lastProcessedBlockHash,
        lastProcessedParentHash: checkpoint.lastProcessedParentHash,
        latestConfirmedBlock: checkpoint.latestConfirmedBlock,
        deploymentBlock: target.deploymentBlock,
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
          client: params.client,
          initialBlock: target.startBlock,
        });
    const fromBlock = freshCheckpoint.nextBlock;

    if (fromBlock > confirmedBlock) {
      logger.info("sync_pass_no_new_blocks", { contract: target.contract });
      continue;
    }

    await runBackfill({
      client: params.client,
      chainId: params.chainId,
      contract: target.contract,
      contractAddress: target.contractAddress,
      abi: target.abi,
      fromBlock,
      toBlock: confirmedBlock,
      batchSize: params.batchSize,
      maxRetries: params.maxRetries,
      dryRun: params.dryRun,
    });
  }
}

/** Polls `runSyncPass` on an interval until the process receives a shutdown
 * signal. Graceful shutdown lets an in-flight pass finish before exiting. */
export function startLiveSyncLoop(params: LiveSyncParams & { pollIntervalMs: number }): {
  stop: () => Promise<void>;
} {
  let stopped = false;
  let currentRun: Promise<void> = Promise.resolve();

  const loop = async () => {
    while (!stopped) {
      currentRun = runSyncPass(params).catch((err) => {
        logger.error("sync_pass_failed", { error: serializeError(err) });
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
