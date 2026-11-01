import { createPublicClient, http, type PublicClient } from "viem";
import { getEnv } from "@/config/env";
import type { DeploymentMetadata } from "@/config/network";
import { NetworkConfigError } from "@/config/network";
import { logger } from "@/util/logger";
import { serializeError } from "@/util/errorSerializer";

/**
 * Creates the RPC client and verifies, before any indexing begins, that the
 * RPC endpoint actually reports the chain ID declared in the deployment
 * metadata. This catches misconfiguration (wrong RPC URL pointed at the
 * wrong network) before a single event is ever indexed.
 */
export async function createVerifiedClient(meta: DeploymentMetadata): Promise<PublicClient> {
  const env = getEnv();

  const client = createPublicClient({
    transport: http(env.CELO_RPC_URL, {
      timeout: env.RPC_TIMEOUT_MS,
      retryCount: env.RPC_MAX_RETRIES,
    }),
  });

  logger.info("rpc_chain_id_check_started", { network: meta.network, expectedChainId: meta.chainId });
  let observedChainId: number;
  try {
    observedChainId = await client.getChainId();
  } catch (error) {
    logger.error("rpc_chain_id_check_failed", {
      network: meta.network,
      expectedChainId: meta.chainId,
      error: serializeError(error),
    });
    throw error;
  }
  if (observedChainId !== meta.chainId) {
    throw new NetworkConfigError(
      `RPC endpoint reports chainId ${observedChainId}, but deployment metadata for ` +
        `"${meta.network}" declares chainId ${meta.chainId}. Refusing to index against a ` +
        `mismatched chain.`
    );
  }
  logger.info("rpc_chain_id_verified", { network: meta.network, chainId: observedChainId });

  const contracts = [
    { name: "USDm", address: meta.usdm },
    { name: "agentRegistry", address: meta.agentRegistry },
    { name: "servicePayments", address: meta.servicePayments },
    { name: "education", address: meta.education },
    { name: "reforestation", address: meta.reforestation },
    { name: "governance", address: meta.governance },
  ];
  for (const contract of contracts) {
    let bytecode: `0x${string}` | undefined;
    try {
      bytecode = await client.getBytecode({ address: contract.address as `0x${string}` });
    } catch (error) {
      logger.error("rpc_contract_code_check_failed", {
        network: meta.network,
        contract: contract.name,
        error: serializeError(error),
      });
      throw error;
    }
    if (!bytecode || bytecode === "0x") {
      throw new NetworkConfigError(
        `Deployment metadata address for ${contract.name} has no contract bytecode on chain ${meta.chainId}. ` +
          "Refusing to index a wrong or undeployed contract."
      );
    }
    logger.info("rpc_contract_code_verified", { network: meta.network, contract: contract.name });
  }

  return client;
}

/**
 * Returns the highest block number safe to treat as "confirmed" given the
 * configured confirmation depth. Callers must never process events from
 * blocks above this number as final.
 */
export async function getConfirmedBlockNumber(client: PublicClient, confirmations: number): Promise<bigint> {
  const head = await client.getBlockNumber();
  const confirmed = head - BigInt(confirmations);
  return confirmed > 0n ? confirmed : 0n;
}
