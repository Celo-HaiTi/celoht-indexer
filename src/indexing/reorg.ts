import type { PublicClient } from "viem";
import { getServiceRoleClient } from "@/db/supabaseClient";
import { rollbackCheckpoint } from "@/db/checkpoints";
import { logger } from "@/util/logger";
import { serializeError } from "@/util/errorSerializer";

const ELIGIBLE_STATUSES = ["canonical", "confirmed"] as const;

interface CanonicalAnchorRow {
  block_number: string | number;
  block_hash: string;
  confirmation_status: string;
}

export class MissingCanonicalAnchorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingCanonicalAnchorError";
  }
}

export class CanonicalAnchorIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalAnchorIntegrityError";
  }
}

export class CanonicalAnchorRpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalAnchorRpcError";
  }
}

export class DeepReorganizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeepReorganizationError";
  }
}

export async function detectAndHandleReorg(params: {
  client: PublicClient;
  chainId: number;
  contractAddress: `0x${string}`;
  lastProcessedBlock: bigint;
  maxLookback?: number;
}): Promise<{ reorgDetected: boolean; safeBlock: bigint }> {
  const maxLookback = params.maxLookback ?? 50;
  if (!Number.isInteger(maxLookback) || maxLookback < 1) {
    throw new RangeError("maxLookback must be a positive integer");
  }
  const supabase = getServiceRoleClient();
  const { data, error } = await supabase
    .from("indexed_blocks")
    .select("block_number, block_hash, confirmation_status")
    .eq("chain_id", params.chainId)
    .in("confirmation_status", [...ELIGIBLE_STATUSES])
    .lte("block_number", params.lastProcessedBlock.toString())
    .order("block_number", { ascending: false })
    .limit(maxLookback);
  if (error) throw error;

  const anchors = (data ?? []) as CanonicalAnchorRow[];
  if (anchors.length === 0) {
    const message = `No canonical or confirmed indexed_blocks anchor exists at or below checkpoint ${params.lastProcessedBlock} ` +
      `for chain ${params.chainId} and contract ${params.contractAddress}.`;
    logger.error("canonical_anchor_missing", {
      contract: params.contractAddress,
      chainId: params.chainId,
      blockNumber: params.lastProcessedBlock.toString(),
      status: null,
      storedHash: null,
      rpcHash: null,
      anchorsExamined: 0,
    });
    throw new MissingCanonicalAnchorError(message);
  }

  let previousBlockNumber: bigint | null = null;
  const validatedAnchors = anchors.map((anchor, index) => {
    try {
      const blockNumber = parseAnchorBlockNumber(anchor, params.lastProcessedBlock, previousBlockNumber);
      const storedHash = normalizeAnchorHash(anchor.block_hash, blockNumber, anchor.confirmation_status);
      if (!ELIGIBLE_STATUSES.includes(anchor.confirmation_status as (typeof ELIGIBLE_STATUSES)[number])) {
        throw new CanonicalAnchorIntegrityError(
          `Unexpected confirmation_status ${String(anchor.confirmation_status)} for indexed_blocks anchor ${blockNumber}.`
        );
      }
      previousBlockNumber = blockNumber;
      return { blockNumber, storedHash, status: anchor.confirmation_status };
    } catch (error) {
      logger.error("canonical_anchor_database_integrity_failed", {
        contract: params.contractAddress,
        chainId: params.chainId,
        blockNumber: String(anchor.block_number),
        status: anchor.confirmation_status,
        storedHash: anchor.block_hash,
        rpcHash: null,
        anchorsExamined: index + 1,
        error: serializeError(error),
      });
      throw error;
    }
  });

  let anchorsExamined = 0;
  let lastMismatch: { blockNumber: bigint; storedHash: string; rpcHash: string; status: string } | null = null;

  for (const anchor of validatedAnchors) {
    const { blockNumber, storedHash, status } = anchor;
    anchorsExamined += 1;

    let chainBlock;
    try {
      chainBlock = await params.client.getBlock({ blockNumber });
    } catch (error) {
      logger.error("canonical_anchor_rpc_read_failed", {
        contract: params.contractAddress,
        chainId: params.chainId,
        blockNumber: blockNumber.toString(),
        status,
        storedHash,
        rpcHash: null,
        anchorsExamined,
        error: serializeError(error),
      });
      throw new CanonicalAnchorRpcError(
        `RPC failed while verifying indexed_blocks anchor ${blockNumber} for ${params.contractAddress}.`
      );
    }

    const rpcHashValue: unknown = chainBlock?.hash;
    if (!chainBlock || chainBlock.number !== blockNumber || typeof rpcHashValue !== "string" || !isHash(rpcHashValue)) {
      const rpcHash = typeof rpcHashValue === "string" ? rpcHashValue : null;
      logger.error("canonical_anchor_rpc_integrity_failed", {
        contract: params.contractAddress,
        chainId: params.chainId,
        blockNumber: blockNumber.toString(),
        rpcBlockNumber: chainBlock?.number?.toString() ?? null,
        status,
        storedHash,
        rpcHash,
        anchorsExamined,
      });
      throw new CanonicalAnchorIntegrityError(
        `RPC returned a null, malformed, or unexpected block while verifying anchor ${blockNumber} ` +
          `for ${params.contractAddress}.`
      );
    }

    const rpcHash = rpcHashValue.toLowerCase();
    if (rpcHash === storedHash) {
      const checkpointBehindAnchor = blockNumber < params.lastProcessedBlock;
      const recoveryNeeded = anchorsExamined > 1 || checkpointBehindAnchor;
      if (!recoveryNeeded) return { reorgDetected: false, safeBlock: blockNumber };

      logger.warn("reorg_anchor_verified_recovery_point", {
        contract: params.contractAddress,
        chainId: params.chainId,
        invalidatedFrom: (blockNumber + 1n).toString(),
        blockNumber: blockNumber.toString(),
        status,
        storedHash,
        rpcHash,
        anchorsExamined,
        checkpointBlock: params.lastProcessedBlock.toString(),
      });
      await rollbackCheckpoint({
        chainId: params.chainId,
        safeBlock: blockNumber,
        safeBlockHash: rpcHash,
        safeParentHash: chainBlock.parentHash,
      });
      return { reorgDetected: true, safeBlock: blockNumber };
    }

    lastMismatch = {
      blockNumber,
      storedHash,
      rpcHash,
      status,
    };
    logger.warn("reorg_anchor_mismatch", {
      contract: params.contractAddress,
      chainId: params.chainId,
      blockNumber: blockNumber.toString(),
      status,
      storedHash,
      rpcHash,
      anchorsExamined,
    });
  }

  const diagnostic = {
    contract: params.contractAddress,
    chainId: params.chainId,
    blockNumber: lastMismatch?.blockNumber.toString() ?? params.lastProcessedBlock.toString(),
    status: lastMismatch?.status ?? null,
    storedHash: lastMismatch?.storedHash ?? null,
    rpcHash: lastMismatch?.rpcHash ?? null,
    anchorsExamined,
    maxLookback,
  };
  if (anchorsExamined === maxLookback) {
    logger.error("deep_reorganization_unresolved", diagnostic);
    throw new DeepReorganizationError(
      `No canonical anchor matched the RPC after examining ${anchorsExamined} eligible anchors ` +
        `for chain ${params.chainId}, contract ${params.contractAddress}, checkpoint ${params.lastProcessedBlock}.`
    );
  }

  logger.error("canonical_anchor_history_incomplete", diagnostic);
  throw new MissingCanonicalAnchorError(
    `No matching canonical anchor was found and only ${anchorsExamined} eligible anchors exist ` +
      `for chain ${params.chainId}, contract ${params.contractAddress}, checkpoint ${params.lastProcessedBlock}; ` +
      "the stored history is insufficient to identify a safe rollback point."
  );
}

function parseAnchorBlockNumber(
  anchor: CanonicalAnchorRow,
  checkpoint: bigint,
  previousBlockNumber: bigint | null
): bigint {
  let blockNumber: bigint;
  try {
    blockNumber = BigInt(anchor.block_number);
  } catch {
    throw new CanonicalAnchorIntegrityError("indexed_blocks contains a non-numeric block_number.");
  }
  if (blockNumber < 0n || blockNumber > checkpoint || (previousBlockNumber !== null && blockNumber >= previousBlockNumber)) {
    throw new CanonicalAnchorIntegrityError(
      `indexed_blocks returned inconsistent block ordering at ${blockNumber} for checkpoint ${checkpoint}.`
    );
  }
  return blockNumber;
}

function normalizeAnchorHash(value: unknown, blockNumber: bigint, status: string): string {
  if (typeof value !== "string" || !isHash(value)) {
    throw new CanonicalAnchorIntegrityError(
      `indexed_blocks has a malformed block_hash at block ${blockNumber} with status ${String(status)}.`
    );
  }
  return value.toLowerCase();
}

function isHash(value: string): boolean {
  return /^0x[0-9a-f]{64}$/i.test(value);
}
