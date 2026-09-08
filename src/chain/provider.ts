import { createPublicClient, http, type PublicClient } from "viem";
import { getEnv } from "@/config/env";
import type { DeploymentMetadata } from "@/config/network";
import { NetworkConfigError } from "@/config/network";

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

  const observedChainId = await client.getChainId();
  if (observedChainId !== meta.chainId) {
    throw new NetworkConfigError(
      `RPC endpoint reports chainId ${observedChainId}, but deployment metadata for ` +
        `"${meta.network}" declares chainId ${meta.chainId}. Refusing to index against a ` +
        `mismatched chain.`
    );
  }

  const addresses = [
    meta.usdm,
    meta.agentRegistry,
    meta.servicePayments,
    meta.education,
    meta.reforestation,
    meta.governance,
  ] as `0x${string}`[];
  for (const address of new Set(addresses.map((value) => value.toLowerCase()))) {
    const bytecode = await client.getBytecode({ address: address as `0x${string}` });
    if (!bytecode || bytecode === "0x") {
      throw new NetworkConfigError(
        `Deployment metadata address ${address} has no contract bytecode on chain ${meta.chainId}. ` +
          "Refusing to index a wrong or undeployed contract."
      );
    }
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
