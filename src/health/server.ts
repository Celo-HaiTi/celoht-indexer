import { createServer } from "node:http";
import type { PublicClient } from "viem";
import { getServiceRoleClient } from "@/db/supabaseClient";
import { getEnv } from "@/config/env";
import type { DeploymentMetadata } from "@/config/network";
import { logger } from "@/util/logger";

/**
 * Reports health for: RPC reachability, chain ID match, chain head vs.
 * indexer checkpoints (sync lag), and database reachability. Never reports
 * "healthy" if a critical dependency is unavailable — an RPC or DB failure
 * here returns HTTP 503.
 */
export function startHealthServer(params: { client: PublicClient; meta: DeploymentMetadata; port: number }) {
  const server = createServer(async (req, res) => {
    if (req.url !== "/health" && req.url !== "/readyz") {
      res.writeHead(404).end();
      return;
    }

    try {
      const env = getEnv();
      const [chainId, headBlock] = await Promise.all([params.client.getChainId(), params.client.getBlockNumber()]);

      if (chainId !== params.meta.chainId) {
        res.writeHead(503, { "content-type": "application/json" }).end(
          JSON.stringify({ status: "down", reason: "chain_id_mismatch", expected: params.meta.chainId, observed: chainId })
        );
        return;
      }

      const supabase = getServiceRoleClient();
      const { data: checkpoints, error } = await supabase
        .from("indexer_state")
        .select("contract_name, last_processed_block, sync_status, last_error")
        .eq("chain_id", params.meta.chainId);

      if (error) {
        res.writeHead(503, { "content-type": "application/json" }).end(
          JSON.stringify({ status: "down", reason: "database_unreachable" })
        );
        return;
      }

      const anyErrored = (checkpoints ?? []).some((c) => c.sync_status === "error");
      const lag = (checkpoints ?? []).map((c) => ({
        contract: c.contract_name,
        lastProcessedBlock: c.last_processed_block,
        blocksBehind: Number(headBlock) - Number(c.last_processed_block),
        syncStatus: c.sync_status,
        lastError: c.last_error,
      }));

      res.writeHead(anyErrored ? 503 : 200, { "content-type": "application/json" }).end(
        JSON.stringify({
          status: anyErrored ? "degraded" : "healthy",
          chainId,
          headBlock: headBlock.toString(),
          confirmations: env.CONFIRMATIONS,
          checkpoints: lag,
        })
      );
    } catch (err) {
      logger.error("health_check_failed", { error: String(err) });
      res.writeHead(503, { "content-type": "application/json" }).end(
        JSON.stringify({ status: "down", reason: "unexpected_error" })
      );
    }
  });

  server.listen(params.port, () => {
    logger.info("health_server_listening", { port: params.port });
  });

  return server;
}
