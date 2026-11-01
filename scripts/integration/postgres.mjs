import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const connectionString = process.env.POSTGRES_TEST_URL || process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("POSTGRES_TEST_URL or DATABASE_URL is required; refusing to skip PostgreSQL integration tests.");
}

const pool = new pg.Pool({ connectionString, max: 2 });
try {
  await pool.query("drop schema public cascade; create schema public;");
  for (const file of ["migrations/001_indexer_schema.sql", "migrations/002_atomic_checkpoint.sql"]) {
    await pool.query(await readFile(path.join(root, file), "utf8"));
  }

  await pool.query("begin");
  await pool.query("insert into blockchain_networks (chain_id, network) values (11142220, 'celoSepolia')");
  const contract = await pool.query(
    "insert into contracts (chain_id, contract_name, contract_address, deployment_block, metadata_ref) values ($1, $2, $3, $4, $5) returning id",
    [11142220, "CeloHTGovernance", "0x7D384851FAbB912287206556479Dd30c740CAdA5", 35343249, "integration-test"]
  );
  await pool.query(
    "insert into indexer_state (chain_id, contract_name, contract_address) values ($1, $2, $3)",
    [11142220, "CeloHTGovernance", "0x7D384851FAbB912287206556479Dd30c740CAdA5"]
  );
  await pool.query("insert into indexer_sync_state (chain_id, contract_id, next_block) values ($1, $2, $3)", [11142220, contract.rows[0].id, 35343249]);
  await pool.query("commit");

  const tx = "0x" + "11".repeat(32);
  const block = "0x" + "22".repeat(32);
  await pool.query(
    "insert into indexed_transactions (chain_id, transaction_hash, block_number, block_hash) values ($1, $2, $3, $4) on conflict (chain_id, transaction_hash) do update set block_hash = excluded.block_hash",
    [11142220, tx, 35343250, block]
  );
  await pool.query(
    "insert into blockchain_events (chain_id, contract_id, transaction_id, block_number, block_hash, transaction_hash, log_index, event_name, event_type, event_data) values ($1, $2, (select id from indexed_transactions where chain_id = $1 and transaction_hash = $3), $4, $5, $3, $6, $7, $8, $9) on conflict (chain_id, transaction_hash, log_index) do update set event_data = excluded.event_data",
    [11142220, contract.rows[0].id, tx, 35343250, block, 0, "ProposalCreated", "governance", JSON.stringify({ proposalId: "1" })]
  );
  const duplicate = await pool.query("select count(*)::int as count from blockchain_events where chain_id = $1 and transaction_hash = $2 and log_index = 0", [11142220, tx]);
  if (duplicate.rows[0].count !== 1) throw new Error("duplicate event was created");

  await pool.query("select public.commit_indexer_checkpoint($1, $2, $3, $4, $5, now(), $3)", [11142220, "0x7D384851FAbB912287206556479Dd30c740CAdA5", 35343250, block, "0x" + "33".repeat(32)]);
  const checkpoint = await pool.query("select last_processed_block from indexer_state where chain_id = $1", [11142220]);
  if (checkpoint.rows[0].last_processed_block !== "35343250") throw new Error("checkpoint did not advance");

  const orphanHash = "0x" + "44".repeat(32);
  const replacementHash = "0x" + "55".repeat(32);
  await pool.query("insert into indexed_blocks (chain_id, block_number, block_hash) values ($1, $2, $3)", [11142220, 35343251, orphanHash]);
  await pool.query("update indexed_blocks set confirmation_status = 'orphaned' where chain_id = $1 and block_number = $2 and block_hash = $3", [11142220, 35343251, orphanHash]);
  await pool.query("select public.commit_indexer_checkpoint($1, $2, $3, $4, $5, now(), $3)", [11142220, "0x7D384851FAbB912287206556479Dd30c740CAdA5", 35343251, replacementHash, orphanHash]);
  await pool.query("select public.commit_indexer_checkpoint($1, $2, $3, $4, $5, now(), $3)", [11142220, "0x7D384851FAbB912287206556479Dd30c740CAdA5", 35343251, replacementHash, orphanHash]);
  const history = await pool.query("select block_hash, confirmation_status from indexed_blocks where chain_id = $1 and block_number = $2 order by block_hash", [11142220, 35343251]);
  if (history.rows.length !== 2 || !history.rows.some((row) => row.block_hash === orphanHash && row.confirmation_status === "orphaned") || !history.rows.some((row) => row.block_hash === replacementHash && row.confirmation_status === "canonical")) {
    throw new Error("checkpoint reindex did not preserve the orphaned observation");
  }

  const secondContractAddress = "0x7D384851FAbB912287206556479Dd30c740CAdA6";
  const secondContract = await pool.query(
    "insert into contracts (chain_id, contract_name, contract_address, deployment_block, metadata_ref) values ($1, $2, $3, $4, $5) returning id",
    [11142220, "CeloHTEducation", secondContractAddress, 35343240, "integration-test"]
  );
  await pool.query("insert into indexer_state (chain_id, contract_name, contract_address) values ($1, $2, $3)", [11142220, "CeloHTEducation", secondContractAddress]);
  await pool.query("insert into indexer_sync_state (chain_id, contract_id, next_block) values ($1, $2, $3)", [11142220, secondContract.rows[0].id, 35343240]);
  await pool.query("select public.commit_indexer_checkpoint($1, $2, $3, $4, $5, now(), $3)", [11142220, secondContractAddress, 35343240, "0x" + "66".repeat(32), "0x" + "77".repeat(32)]);
  const checkpoints = await pool.query("select contract_address, last_processed_block from indexer_state where chain_id = $1 order by contract_address", [11142220]);
  if (checkpoints.rows.find((row) => row.contract_address === "0x7D384851FAbB912287206556479Dd30c740CAdA5")?.last_processed_block !== "35343251"
    || checkpoints.rows.find((row) => row.contract_address === secondContractAddress)?.last_processed_block !== "35343240") {
    throw new Error("checkpoint writes for contracts on the same chain were not isolated");
  }

  await pool.query("begin");
  await pool.query("insert into indexed_blocks (chain_id, block_number, block_hash) values ($1, $2, $3)", [11142220, 35343252, "0x" + "88".repeat(32)]);
  await pool.query("rollback");
  const rolledBack = await pool.query("select count(*)::int as count from indexed_blocks where chain_id = $1 and block_number = 35343252", [11142220]);
  if (rolledBack.rows[0].count !== 0) throw new Error("transaction rollback did not remove uncommitted block");
  console.log("POSTGRES_INTEGRATION_PASS composite-key reorg-history idempotent-checkpoint multi-contract rollback");
} finally {
  await pool.end();
}