import type { PublicClient } from "viem";
import { getServiceRoleClient } from "@/db/supabaseClient";
import { rollbackCheckpoint } from "@/db/checkpoints";
import { logger } from "@/util/logger";

/**
 * Detects whether the block we last processed is still part of the
 * canonical chain. If the stored block hash for `lastProcessedBlock` no
 * longer matches what the RPC reports, a reorg has invalidated it (and
 * possibly earlier blocks). We walk backward until we find a block whose
 * hash still matches, then roll the checkpoint back to that safe point —
 * events from invalidated blocks are deleted, never permanently trusted.
 */
export async function detectAndHandleReorg(params: {
  client: PublicClient;
  chainId: number;
  contractAddress: `0x${string}`;
  lastProcessedBlock: bigint;
  maxLookback?: number;
}): Promise<{ reorgDetected: boolean; safeBlock: bigint }> {
  const maxLookback = params.maxLookback ?? 50;
  const supabase = getServiceRoleClient();

  let candidate = params.lastProcessedBlock;
  let steps = 0;

  while (steps < maxLookback && candidate > 0n) {
    const { data: storedRows, error } = await supabase
      .from("blockchain_transactions")
      .select("block_hash")
      .eq("chain_id", params.chainId)
      .eq("contract_address", params.contractAddress)
      .eq("block_number", candidate.toString())
      .limit(1);
    if (error) throw error;

    if (!storedRows || storedRows.length === 0) {
      // No stored events at this height for this contract — nothing to
      // validate here; treat the block itself as the boundary and verify
      // via chain block hash comparison isn't necessary without stored data.
      candidate -= 1n;
      steps += 1;
      continue;
    }

    const chainBlock = await params.client.getBlock({ blockNumber: candidate });
    const storedHash = storedRows[0]?.block_hash;

    if (chainBlock.hash === storedHash) {
      // Found a safe, still-canonical block.
      if (steps > 0) {
        logger.warn("reorg_detected", {
          contract: params.contractAddress,
          invalidatedFrom: (candidate + 1n).toString(),
          safeBlock: candidate.toString(),
        });
        await rollbackCheckpoint({
          chainId: params.chainId,
          contractAddress: params.contractAddress,
          safeBlock: candidate,
        });
        return { reorgDetected: true, safeBlock: candidate };
      }
      return { reorgDetected: false, safeBlock: candidate };
    }

    candidate -= 1n;
    steps += 1;
  }

  // Could not find a matching block within maxLookback — an unusually deep
  // reorg. Fail closed: surface this as an error rather than guessing a
  // rollback point.
  throw new Error(
    `Could not find a canonical block within ${maxLookback} blocks of ${params.lastProcessedBlock} ` +
      `for contract ${params.contractAddress}. Manual investigation required.`
  );
}
