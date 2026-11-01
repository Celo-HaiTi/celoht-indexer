import pg from "pg";
import { createPublicClient, http } from "viem";
import { loadAbiFile } from "../../dist/config/abiLoader.js";

const connectionString = process.env.POSTGRES_TEST_URL || process.env.DATABASE_URL;
if (!connectionString) throw new Error("POSTGRES_TEST_URL or DATABASE_URL is required; refusing to skip failure tests.");
const pool = new pg.Pool({ connectionString, max: 2 });
try {
  const before = await pool.query("select count(*)::int as count from indexed_blocks");
  await pool.query("begin");
  await pool.query("insert into indexed_blocks (chain_id, block_number, block_hash) values ($1, $2, $3)", [11142220, 99999999, "0x" + "aa".repeat(32)]);
  await pool.query("rollback");
  const after = await pool.query("select count(*)::int as count from indexed_blocks");
  if (before.rows[0].count !== after.rows[0].count) throw new Error("database rollback failure left uncommitted data");

  await pool.query("insert into indexed_blocks (chain_id, block_number, block_hash) values ($1, $2, $3) on conflict (chain_id, block_number, block_hash) do update set confirmation_status = 'canonical'", [11142220, 99999998, "0x" + "bb".repeat(32)]);
  await pool.query("update indexed_blocks set confirmation_status = 'orphaned' where chain_id = $1 and block_number = $2 and block_hash = $3", [11142220, 99999998, "0x" + "bb".repeat(32)]);
  await pool.query("insert into indexed_blocks (chain_id, block_number, block_hash) values ($1, $2, $3) on conflict (chain_id, block_number, block_hash) do update set confirmation_status = 'canonical'", [11142220, 99999998, "0x" + "cc".repeat(32)]);
  const duplicateBlock = await pool.query("select count(*)::int as count from indexed_blocks where chain_id = $1 and block_number = $2", [11142220, 99999998]);
  const blockHistory = await pool.query("select block_hash, confirmation_status from indexed_blocks where chain_id = $1 and block_number = $2", [11142220, 99999998]);
  if (duplicateBlock.rows[0].count !== 2 || !blockHistory.rows.some((row) => row.block_hash === "0x" + "bb".repeat(32) && row.confirmation_status === "orphaned") || !blockHistory.rows.some((row) => row.block_hash === "0x" + "cc".repeat(32) && row.confirmation_status === "canonical")) throw new Error("reindexing did not preserve the orphaned observation");

  await pool.query("insert into indexed_blocks (chain_id, block_number, block_hash) values ($1, $2, $3) on conflict (chain_id, block_number, block_hash) do update set confirmation_status = 'canonical'", [11142220, 99999997, "0x" + "dd".repeat(32)]);
  await pool.query("update indexed_blocks set confirmation_status = 'orphaned' where chain_id = $1 and block_number in ($2, $3)", [11142220, 99999998, 99999997]);
  try {
    await pool.query("select public.commit_indexer_checkpoint($1, $2, $3, $4, $5, now(), $3)", [11142220, "0x0000000000000000000000000000000000000000", 99999999, "0x" + "ee".repeat(32), "0x" + "ff".repeat(32)]);
    throw new Error("invalid contract checkpoint unexpectedly succeeded");
  } catch (error) {
    if (!String(error.message).includes("Unknown indexer contract")) throw error;
  }
  const failedCheckpoint = await pool.query("select count(*)::int as count from indexed_blocks where chain_id = $1 and block_number = $2", [11142220, 99999999]);
  if (failedCheckpoint.rows[0].count !== 0) throw new Error("failed checkpoint persisted a block");

  const unavailable = createPublicClient({ transport: http("http://127.0.0.1:1", { timeout: 100, retryCount: 0 }) });
  await unavailable.getChainId().then(() => { throw new Error("unavailable RPC unexpectedly succeeded"); }).catch(() => undefined);
  let malformedAbiFailed = false;
  try { loadAbiFile("missing-USDm-artifact"); } catch { malformedAbiFailed = true; }
  if (!malformedAbiFailed) throw new Error("missing ABI did not fail closed");
  console.log("FAILURE_INTEGRATION_PASS rollback orphan-history reindex checkpoint-failure rpc-unavailable missing-abi");
} finally {
  await pool.end();
}