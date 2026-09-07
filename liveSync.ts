import type { PublicClient } from "viem";
import { getConfirmedBlockNumber } from "@/chain/provider";
import { runBackfill } from "@/indexing/backfill";
import { detectAndHandleReorg } from "@/indexing/reorg";
import { getCheckpoint } from "@/db/checkpoints";
import { logger } from "@/util/logger";
import type { AbiItem } from "@/config/abiLoader";
import type { ContractName } from "@/config/network";

export interface SyncTarget {
  contract: ContractName;
  contractAddress: `0x${string}`;
  abi: AbiItem[];
}

export interface LiveSyncParams {
  client: PublicClient;
  chainId: number;
  confirmations: number;
  batchSize: number;
  maxRetries: number;
  targets: SyncTarget[];
}

/** Runs one full reconciliation pass for every configured contract:
 * reorg check -> backfill any newly confirmed blocks. Never depends
 * exclusively on WebSocket subscriptions — this is a poll/reconcile model
 * suitable for restart-safe, at-least-once processing. */
export async function runSyncPass(params: LiveSyncParams): Promise<void> {
  const confirmedBlock = await getConfirmedBlockNumber(params.client, params.confirmations);

  for (const target of params.targets) {
    const checkpoint = await getCheckpoint(params.chainId, target.contractAddress);

    if (checkpoint.lastProcessedBlock > 0n) {
      const { reorgDetected, safeBlock } = await detectAndHandleReorg({
        client: params.client,
        chainId: params.chainId,
        contractAddress: target.contractAddress,
        lastProcessedBlock: checkpoint.lastProcessedBlock,
      });
      if (reorgDetected) {
        logger.warn("checkpoint_rolled_back", { contract: target.contract, safeBlock: safeBlock.toString() });
      }
    }

    const freshCheckpoint = await getCheckpoint(params.chainId, target.contractAddress);
    const fromBlock = freshCheckpoint.lastProcessedBlock + 1n;

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
        logger.error("sync_pass_failed", { error: String(err) });
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
