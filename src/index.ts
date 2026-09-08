import { getEnv } from "@/config/env";
import { loadDeploymentMetadata, CONTRACT_NAMES, CONTRACT_DISPLAY_NAMES, contractAddress, deploymentBlock } from "@/config/network";
import { loadAbi, AbiLoadError } from "@/config/abiLoader";
import { loadUsdmAbi } from "@/config/token";
import { createVerifiedClient } from "@/chain/provider";
import { ensureCheckpoint } from "@/db/checkpoints";
import { startLiveSyncLoop, type SyncTarget } from "@/indexing/liveSync";
import { startHealthServer } from "@/health/server";
import { getServiceRoleClient } from "@/db/supabaseClient";
import { logger } from "@/util/logger";

async function main(): Promise<void> {
  const env = getEnv();
  const meta = loadDeploymentMetadata(env.CELO_NETWORK);

  logger.info("indexer_starting", { network: meta.network, chainId: meta.chainId });

  const client = await createVerifiedClient(meta);

  const targets: SyncTarget[] = [];
  for (const contract of CONTRACT_NAMES) {
    try {
      const abi = loadAbi(contract);
      const address = contractAddress(meta, contract);
      if (!env.DRY_RUN) {
        await ensureCheckpoint({
          chainId: meta.chainId,
          contractName: contract,
          displayName: CONTRACT_DISPLAY_NAMES[contract],
          contractAddress: address,
          deploymentBlock: deploymentBlock(meta, contract),
          deploymentTxHash: meta.transactionHashes[contract],
          startBlock: env.START_BLOCK,
          network: meta.network,
        });
      }
      targets.push({ contract, contractAddress: address, abi, deploymentBlock: deploymentBlock(meta, contract) });
      logger.info("contract_ready", { contract, address });
    } catch (err) {
      if (err instanceof AbiLoadError) {
        logger.error("required_abi_unavailable", { contract, error: err.message });
        throw err;
      }
      throw err;
    }
  }

  const usdmStartBlock = env.USDM_START_BLOCK;
  const usdmAbi = loadUsdmAbi();
  if (!env.DRY_RUN) {
    await ensureCheckpoint({
      chainId: meta.chainId,
      contractName: "usdm",
      displayName: "USDm",
      contractAddress: meta.usdm,
      deploymentBlock: 0,
      startBlock: usdmStartBlock,
      network: meta.network,
    });
  }
  targets.push({ contract: "usdm", contractAddress: meta.usdm as `0x${string}`, abi: usdmAbi, deploymentBlock: 0 });
  logger.info("token_ready", { token: "USDm", address: meta.usdm, startBlock: usdmStartBlock });

  if (targets.length === 0) {
    throw new Error("No contracts are indexable (no ABI files present). Populate abis/ before starting. See abis/README.md.");
  }

  if (!env.DRY_RUN) {
    const { error } = await getServiceRoleClient().from("system_health").insert({
      component: "indexer",
      status: "healthy",
      details: { network: meta.network, chainId: meta.chainId },
    });
    if (error) throw error;
  }

  const healthServer = startHealthServer({ client, meta, port: Number(process.env.PORT ?? 8080) });

  const sync = startLiveSyncLoop({
    client,
    chainId: meta.chainId,
    confirmations: env.CONFIRMATIONS,
    batchSize: env.BACKFILL_BATCH_SIZE,
    maxRetries: env.RPC_MAX_RETRIES,
    pollIntervalMs: env.POLL_INTERVAL_MS,
    targets,
    dryRun: env.DRY_RUN,
  });

  const shutdown = async (signal: string) => {
    logger.info("indexer_shutting_down", { signal });
    await sync.stop();
    healthServer.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error("indexer_fatal_error", { error: String(err) });
  process.exit(1);
});
