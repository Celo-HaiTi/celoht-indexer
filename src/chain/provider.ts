import { createPublicClient, http, type PublicClient } from "viem";
import { getEnv } from "@/config/env";
import type { DeploymentMetadata } from "@/config/network";
import { NetworkConfigError } from "@/config/network";
import { logger } from "@/util/logger";
import { serializeError } from "@/util/errorSerializer";
import { withRetry } from "@/chain/retry";

/**
 * Creates the RPC client and verifies, before any indexing begins, that the
 * RPC endpoint actually reports the chain ID declared in the deployment
 * metadata. This catches misconfiguration (wrong RPC URL pointed at the
 * wrong network) before a single event is ever indexed.
 */
export interface VerifiedRpcClients {
  liveClient: PublicClient;
  historicalClient: PublicClient;
}

const ARCHIVE_PROBE_BLOCK = 35343240n;
const BLOCK_HASH_PATTERN = /^0x[0-9a-f]{64}$/i;

export async function createVerifiedClients(meta: DeploymentMetadata): Promise<VerifiedRpcClients> {
  const env = getEnv();

  const liveClient = createClient(env.CELO_RPC_URL, env.RPC_TIMEOUT_MS);
  const archiveUrl = env.CELO_SEPOLIA_ARCHIVE_RPC_URL ?? env.CELO_RPC_URL;
  const historicalClient = createClient(archiveUrl, env.RPC_TIMEOUT_MS);

  await verifyChainId(liveClient, meta, "live");
  await verifyChainId(historicalClient, meta, "archive");
  await verifyArchiveBlock(historicalClient, meta);

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
      bytecode = await liveClient.getBytecode({ address: contract.address as `0x${string}` });
    } catch (error) {
      logger.error("rpc_contract_code_check_failed", {
        endpointRole: "live",
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
    logger.info("rpc_contract_code_verified", { endpointRole: "live", network: meta.network, contract: contract.name });
  }

  return { liveClient, historicalClient };
}

function createClient(url: string, timeout: number): PublicClient {
  return createPublicClient({
    transport: http(url, {
      timeout,
      retryCount: 0,
    }),
  });
}

async function verifyChainId(client: PublicClient, meta: DeploymentMetadata, endpointRole: "live" | "archive"): Promise<void> {
  logger.info("rpc_chain_id_check_started", { endpointRole, network: meta.network, expectedChainId: meta.chainId });
  let observedChainId: number;
  try {
    observedChainId = await client.getChainId();
  } catch (error) {
    logger.error("rpc_chain_id_check_failed", {
      endpointRole,
      network: meta.network,
      expectedChainId: meta.chainId,
      error: serializeError(error),
    });
    throw error;
  }
  if (observedChainId !== meta.chainId) {
    throw new NetworkConfigError(
      `${endpointRole} RPC endpoint reports chainId ${observedChainId}, but deployment metadata for ` +
        `"${meta.network}" declares chainId ${meta.chainId}. Refusing to index against a ` +
        `mismatched chain.`
    );
  }
  logger.info("rpc_chain_id_verified", { endpointRole, network: meta.network, chainId: observedChainId });
}

async function verifyArchiveBlock(client: PublicClient, meta: DeploymentMetadata): Promise<void> {
  logger.info("rpc_archive_block_check_started", {
    endpointRole: "archive",
    network: meta.network,
    requestedBlock: ARCHIVE_PROBE_BLOCK.toString(),
  });
  let block;
  try {
    block = await client.getBlock({ blockNumber: ARCHIVE_PROBE_BLOCK });
  } catch (error) {
    const category = classifyHistoricalAccessError(error);
    logger.error("rpc_archive_block_check_failed", {
      endpointRole: "archive",
      requestedBlock: ARCHIVE_PROBE_BLOCK.toString(),
      errorCategory: category,
      error: serializeError(error),
    });
    throw new NetworkConfigError(
      `Archive RPC cannot retrieve required Celo Sepolia block ${ARCHIVE_PROBE_BLOCK}: ${category}. ` +
        "Configure CELO_SEPOLIA_ARCHIVE_RPC_URL with a historical-capable endpoint."
    );
  }

  if (
    !block || block.number !== ARCHIVE_PROBE_BLOCK || typeof block.hash !== "string" ||
    !BLOCK_HASH_PATTERN.test(block.hash)
  ) {
    logger.error("rpc_archive_block_check_failed", {
      endpointRole: "archive",
      requestedBlock: ARCHIVE_PROBE_BLOCK.toString(),
      returnedBlock: block?.number?.toString() ?? null,
      errorCategory: "invalid_historical_block_response",
    });
    throw new NetworkConfigError(
      `Archive RPC did not return a valid block number and hash for required Celo Sepolia block ${ARCHIVE_PROBE_BLOCK}.`
    );
  }

  logger.info("rpc_archive_block_verified", {
    endpointRole: "archive",
    network: meta.network,
    chainId: meta.chainId,
    blockNumber: block.number.toString(),
    blockHash: block.hash.toLowerCase(),
  });
}

function classifyHistoricalAccessError(error: unknown): string {
  const serialized = serializeError(error);
  const detail = JSON.stringify(serialized).toLowerCase();
  if (detail.includes("10064") || detail.includes("retention") || detail.includes("historical") || detail.includes("prun")) {
    return "historical_retention_limit";
  }
  return "historical_block_unavailable";
}

/**
 * Returns the highest block number safe to treat as "confirmed" given the
 * configured confirmation depth. Callers must never process events from
 * blocks above this number as final.
 */
export async function getConfirmedBlockNumber(client: PublicClient, confirmations: number, maxRetries = 0): Promise<bigint> {
  const head = await withRetry(() => client.getBlockNumber(), {
    maxRetries,
    label: "live.getBlockNumber",
    endpointRole: "live",
  });
  const confirmed = head - BigInt(confirmations);
  return confirmed > 0n ? confirmed : 0n;
}
