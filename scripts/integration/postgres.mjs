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

  await pool.query("insert into blockchain_networks (chain_id, network) values (11142220, 'celoSepolia')");
  const bootstrapAddress = "0x7D384851FAbB912287206556479Dd30c740CAdA9";
  const bootstrapContract = await pool.query(
    "insert into contracts (chain_id, contract_name, contract_address, deployment_block, metadata_ref) values ($1, $2, $3, $4, $5) returning id",
    [11142220, "BootstrapSeed", bootstrapAddress, 35343240, "integration-test"]
  );
  await pool.query(
    "insert into indexer_state (chain_id, contract_name, contract_address, last_processed_block) values ($1, $2, $3, $4)",
    [11142220, "BootstrapSeed", bootstrapAddress, 35343239]
  );
  await pool.query(
    "insert into indexer_sync_state (chain_id, contract_id, next_block) values ($1, $2, $3)",
    [11142220, bootstrapContract.rows[0].id, 35343240]
  );
  await pool.query(await readFile(path.join(root, "migrations/003_checkpoint_recovery.sql"), "utf8"));

  const bootstrapState = await pool.query(
    "select legacy.last_processed_block as legacy_block, canonical.last_processed_block as canonical_block, canonical.next_block from indexer_state legacy join indexer_sync_state canonical on canonical.chain_id = legacy.chain_id join contracts c on c.id = canonical.contract_id and c.contract_address = legacy.contract_address where legacy.chain_id = $1 and legacy.contract_address = $2",
    [11142220, bootstrapAddress]
  );
  if (bootstrapState.rows[0]?.legacy_block !== "35343239" || bootstrapState.rows[0]?.canonical_block !== "35343239" || bootstrapState.rows[0]?.next_block !== "35343240") {
    throw new Error("migration did not align the untouched deployment-seed checkpoint");
  }

  const primaryKey = await pool.query(
    "select pg_get_constraintdef(oid) as definition from pg_constraint where conrelid = 'public.indexed_blocks'::regclass and contype = 'p'"
  );
  if (primaryKey.rows[0]?.definition !== "PRIMARY KEY (chain_id, block_number, block_hash)") {
    throw new Error("indexed_blocks composite primary key is missing or incorrect");
  }
  const rlsTables = await pool.query(
    "select count(*)::int as count from pg_class where relnamespace = 'public'::regnamespace and relrowsecurity and relname = any($1)",
    [["blockchain_networks", "contracts", "indexed_blocks", "indexed_transactions", "blockchain_events", "blockchain_transactions", "indexer_state", "indexer_sync_state", "system_health"]]
  );
  if (rlsTables.rows[0].count !== 8) throw new Error("RLS is not enabled on every indexer-owned table in the local schema");

  await pool.query("begin");
  await pool.query("insert into blockchain_networks (chain_id, network) values (11142220, 'celoSepolia') on conflict (chain_id) do nothing");
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
  const atomicCheckpoint = await pool.query(
    "select legacy.last_processed_block as legacy_block, canonical.last_processed_block as canonical_block, canonical.next_block, canonical.last_processed_block_hash from indexer_state legacy join indexer_sync_state canonical on canonical.chain_id = legacy.chain_id join contracts c on c.id = canonical.contract_id and c.contract_address = legacy.contract_address where legacy.chain_id = $1 and legacy.contract_address = $2",
    [11142220, "0x7D384851FAbB912287206556479Dd30c740CAdA5"]
  );
  if (atomicCheckpoint.rows[0]?.legacy_block !== "35343250" || atomicCheckpoint.rows[0]?.canonical_block !== "35343250" || atomicCheckpoint.rows[0]?.next_block !== "35343251" || atomicCheckpoint.rows[0]?.last_processed_block_hash !== block) {
    throw new Error("atomic checkpoint procedure did not update both ledgers and the canonical hash");
  }

  const missingLegacyAddress = "0x7D384851FAbB912287206556479Dd30c740CAdA7";
  const missingLegacyContract = await pool.query(
    "insert into contracts (chain_id, contract_name, contract_address, deployment_block, metadata_ref) values ($1, $2, $3, $4, $5) returning id",
    [11142220, "MissingLegacyState", missingLegacyAddress, 35343260, "integration-test"]
  );
  await pool.query("insert into indexer_sync_state (chain_id, contract_id, next_block) values ($1, $2, $3)", [11142220, missingLegacyContract.rows[0].id, 35343260]);
  await pool.query("begin");
  await pool.query("savepoint missing_legacy_checkpoint");
  let missingLegacyRejected = false;
  try {
    await pool.query("select public.commit_indexer_checkpoint($1, $2, $3, $4, $5, now(), $3)", [11142220, missingLegacyAddress, 35343260, "0x" + "99".repeat(32), "0x" + "98".repeat(32)]);
  } catch {
    missingLegacyRejected = true;
    await pool.query("rollback to savepoint missing_legacy_checkpoint");
  }
  await pool.query("release savepoint missing_legacy_checkpoint");
  await pool.query("commit");
  if (!missingLegacyRejected) throw new Error("checkpoint commit accepted a missing legacy state row");
  const partialAnchor = await pool.query("select count(*)::int as count from indexed_blocks where chain_id = $1 and block_number = $2", [11142220, 35343260]);
  if (partialAnchor.rows[0].count !== 0) throw new Error("failed checkpoint commit left a partial canonical anchor");

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

  await pool.query("insert into blockchain_networks (chain_id, network) values (11142221, 'recovery-test')");
  const recoveryAddress = "0x7D384851FAbB912287206556479Dd30c740CAdA8";
  const recoveryContract = await pool.query(
    "insert into contracts (chain_id, contract_name, contract_address, deployment_block, metadata_ref) values ($1, $2, $3, $4, $5) returning id",
    [11142221, "RecoveryContract", recoveryAddress, 100, "integration-test"]
  );
  await pool.query(
    "insert into indexer_state (chain_id, contract_name, contract_address, last_processed_block) values ($1, $2, $3, $4)",
    [11142221, "RecoveryContract", recoveryAddress, 200]
  );
  await pool.query(
    "insert into indexer_sync_state (chain_id, contract_id, next_block, last_processed_block) values ($1, $2, $3, $4)",
    [11142221, recoveryContract.rows[0].id, 201, 200]
  );
  const retainedOrphanHash = "0x" + "ab".repeat(32);
  await pool.query(
    "insert into indexed_blocks (chain_id, block_number, block_hash, confirmation_status) values ($1, $2, $3, 'orphaned')",
    [11142221, 200, retainedOrphanHash]
  );
  await pool.query("select public.rewind_indexer_checkpoint_to_deployment($1, $2, $3)", [11142221, recoveryAddress, 100]);
  const recoveredState = await pool.query(
    "select legacy.last_processed_block as legacy_block, canonical.last_processed_block as canonical_block, canonical.next_block, canonical.last_processed_block_hash from indexer_state legacy join indexer_sync_state canonical on canonical.chain_id = legacy.chain_id join contracts c on c.id = canonical.contract_id and c.contract_address = legacy.contract_address where legacy.chain_id = $1 and legacy.contract_address = $2",
    [11142221, recoveryAddress]
  );
  if (recoveredState.rows[0]?.legacy_block !== "99" || recoveredState.rows[0]?.canonical_block !== "99" || recoveredState.rows[0]?.next_block !== "100" || recoveredState.rows[0]?.last_processed_block_hash !== null) {
    throw new Error("deployment recovery did not atomically align both checkpoint ledgers");
  }
  const retainedOrphan = await pool.query("select confirmation_status from indexed_blocks where chain_id = $1 and block_number = $2 and block_hash = $3", [11142221, 200, retainedOrphanHash]);
  if (retainedOrphan.rows[0]?.confirmation_status !== "orphaned") throw new Error("deployment recovery removed orphaned history");

  const zeroDeploymentAddress = "0x7D384851FAbB912287206556479Dd30c740CAdA0";
  const zeroDeploymentContract = await pool.query(
    "insert into contracts (chain_id, contract_name, contract_address, deployment_block, metadata_ref) values ($1, $2, $3, $4, $5) returning id",
    [11142221, "ZeroDeploymentRecovery", zeroDeploymentAddress, 0, "integration-test"]
  );
  await pool.query(
    "insert into indexer_state (chain_id, contract_name, contract_address, last_processed_block) values ($1, $2, $3, $4)",
    [11142221, "ZeroDeploymentRecovery", zeroDeploymentAddress, 200]
  );
  await pool.query(
    "insert into indexer_sync_state (chain_id, contract_id, next_block, last_processed_block) values ($1, $2, $3, $4)",
    [11142221, zeroDeploymentContract.rows[0].id, 201, 200]
  );
  await pool.query("select public.rewind_indexer_checkpoint_to_deployment($1, $2, $3)", [11142221, zeroDeploymentAddress, 0]);
  const zeroDeploymentState = await pool.query(
    "select legacy.last_processed_block as legacy_block, canonical.last_processed_block as canonical_block, canonical.next_block, canonical.last_processed_block_hash from indexer_state legacy join indexer_sync_state canonical on canonical.chain_id = legacy.chain_id join contracts c on c.id = canonical.contract_id and c.contract_address = legacy.contract_address where legacy.chain_id = $1 and legacy.contract_address = $2",
    [11142221, zeroDeploymentAddress]
  );
  if (zeroDeploymentState.rows[0]?.legacy_block !== "0" || zeroDeploymentState.rows[0]?.canonical_block !== "0" || zeroDeploymentState.rows[0]?.next_block !== "0" || zeroDeploymentState.rows[0]?.last_processed_block_hash !== null) {
    throw new Error("block-zero recovery did not preserve the nonnegative uninitialized cursor");
  }

  await pool.query("begin");
  await pool.query("insert into indexed_blocks (chain_id, block_number, block_hash) values ($1, $2, $3)", [11142220, 35343252, "0x" + "88".repeat(32)]);
  await pool.query("rollback");
  const rolledBack = await pool.query("select count(*)::int as count from indexed_blocks where chain_id = $1 and block_number = 35343252", [11142220]);
  if (rolledBack.rows[0].count !== 0) throw new Error("transaction rollback did not remove uncommitted block");
  console.log("POSTGRES_INTEGRATION_PASS composite-key rls atomic-checkpoint recovery-history multi-contract rollback");
} finally {
  await pool.end();
}