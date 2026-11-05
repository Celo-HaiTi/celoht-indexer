import { createPublicClient, http, parseAbiItem } from "viem";
import { celoSepolia } from "viem/chains";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const rpcUrl = process.env.CELO_RPC_URL || "https://forno.celo-sepolia.celo-testnet.org";
const meta = JSON.parse(await readFile(path.join(root, "deployments/celoSepolia.json"), "utf8"));
const client = createPublicClient({ chain: celoSepolia, transport: http(rpcUrl, { timeout: 15000, retryCount: 0 }) });

const chainId = await client.getChainId();
if (chainId !== meta.chainId) throw new Error(`RPC chain mismatch: expected ${meta.chainId}, got ${chainId}`);
const head = await client.getBlockNumber();
const block = await client.getBlock({ blockNumber: head });
if (!block.hash || !block.parentHash) throw new Error("RPC returned malformed block data");
const contractNames = ["agentRegistry", "servicePayments", "education", "reforestation", "governance"];
for (const name of contractNames) {
	const deploymentResponse = await fetch(
		`https://celo-sepolia.blockscout.com/api/v2/transactions/${meta.transactionHashes[name]}`
	);
	if (!deploymentResponse.ok) throw new Error(`Blockscout deployment lookup failed for ${name}: HTTP ${deploymentResponse.status}`);
	const deployment = await deploymentResponse.json();
	if (
		deployment.hash?.toLowerCase() !== meta.transactionHashes[name].toLowerCase() ||
		BigInt(deployment.block_number) !== BigInt(meta.deploymentBlocks[name]) ||
		deployment.created_contract?.hash?.toLowerCase() !== meta[name].toLowerCase()
	) {
		throw new Error(`deployment receipt for ${name} does not match the manifest address and block`);
	}
	const bytecode = await client.getBytecode({ address: meta[name] });
	if (!bytecode || bytecode === "0x") throw new Error(`${name} address has no deployed bytecode`);
}
const usdmBytecode = await client.getBytecode({ address: meta.usdm });
if (!usdmBytecode || usdmBytecode === "0x") throw new Error("USDm address has no deployed bytecode");
const governanceEvent = parseAbiItem("event ProposalCreated(uint256 indexed proposalId,address indexed proposer,bytes32 contentHash,string metadataURI,uint64 startTime,uint64 endTime)");
const transferEvent = parseAbiItem("event Transfer(address indexed from,address indexed to,uint256 value)");
let governanceLogs = 0;
let transferLogs = 0;
const fromBlock = BigInt(meta.deploymentBlocks.governance);
for (let start = fromBlock; start <= head; start += 90_000n) {
	const end = start + 89_999n > head ? head : start + 89_999n;
	governanceLogs += (await client.getLogs({ address: meta.governance, event: governanceEvent, fromBlock: start, toBlock: end })).length;
	transferLogs += (await client.getLogs({ address: meta.usdm, event: transferEvent, fromBlock: start, toBlock: end })).length;
}
console.log(`RPC_INTEGRATION_PASS chain=${chainId} head=${head} contractsVerified=${contractNames.length} governanceLogs=${governanceLogs} usdmTransferLogs=${transferLogs}`);
