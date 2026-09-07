import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

/**
 * Loads and validates official deployment metadata from deployments/<network>.json.
 *
 * This is the ONLY place contract addresses, deployment blocks, and network
 * identity enter this codebase. Nothing here is hand-typed elsewhere — see
 * the ESLint rule in .eslintrc.json that flags hex-looking literals in source.
 *
 * The deployment file itself must originate from the official source of
 * truth (Celo-HaiTi/celoht-smart-contracts). This loader does not fetch it
 * automatically (no assumed network access at build/deploy time) — it reads
 * whatever JSON file has been placed in `deployments/`, and fails closed if
 * it is absent, malformed, or internally inconsistent.
 */

const AddressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "Must be a 20-byte hex address");
const TxHashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "Must be a 32-byte hex transaction hash");

export const DeploymentMetadataSchema = z.object({
  network: z.string().min(1),
  chainId: z.number().int().positive(),
  deployer: AddressSchema,
  usdm: AddressSchema,
  generalTreasury: AddressSchema,
  educationTreasury: AddressSchema,
  reforestationTreasury: AddressSchema,
  governanceTreasury: AddressSchema,
  treasuryConfiguration: z.string(),
  agentRegistry: AddressSchema,
  servicePayments: AddressSchema,
  education: AddressSchema,
  reforestation: AddressSchema,
  governance: AddressSchema,
  deploymentBlocks: z.object({
    agentRegistry: z.number().int().nonnegative(),
    servicePayments: z.number().int().nonnegative(),
    education: z.number().int().nonnegative(),
    reforestation: z.number().int().nonnegative(),
    governance: z.number().int().nonnegative(),
  }),
  transactionHashes: z.object({
    agentRegistry: TxHashSchema,
    servicePayments: TxHashSchema,
    education: TxHashSchema,
    reforestation: TxHashSchema,
    governance: TxHashSchema,
  }),
  deploymentTimestamps: z.object({
    agentRegistry: z.string(),
    servicePayments: z.string(),
    education: z.string(),
    reforestation: z.string(),
    governance: z.string(),
  }),
  compilerVersion: z.string(),
  optimizerEnabled: z.boolean(),
  optimizerRuns: z.number().int().nonnegative(),
  verification: z.string(),
  verificationStatus: z.string().optional(),
  verificationSource: z.string(),
  abiReferences: z.record(z.string()).optional(),
  gitCommit: z.string().nullable(),
  metadataSource: z.string(),
});

export type DeploymentMetadata = z.infer<typeof DeploymentMetadataSchema>;

export type ContractName =
  | "agentRegistry"
  | "servicePayments"
  | "education"
  | "reforestation"
  | "governance";

export type IndexTargetName = ContractName | "usdm";

export const CONTRACT_NAMES: ContractName[] = [
  "agentRegistry",
  "servicePayments",
  "education",
  "reforestation",
  "governance",
];

/** Canonical contract names as they appear on-chain / in docs. */
export const CONTRACT_DISPLAY_NAMES: Record<ContractName, string> = {
  agentRegistry: "CeloHTAgentRegistry",
  servicePayments: "CeloHTServicePayments",
  education: "CeloHTEducation",
  reforestation: "CeloHTReforestation",
  governance: "CeloHTGovernance",
};

export class NetworkConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetworkConfigError";
  }
}

/**
 * Networks this indexer is permitted to run against. Mainnet is
 * intentionally absent: it must fail closed until
 * Celo-HaiTi/celoht-smart-contracts publishes official Mainnet deployment
 * metadata, at which point a `deployments/celoMainnet.json` file should be
 * added and this list updated in a reviewed change — never silently.
 */
export const ALLOWED_NETWORKS = ["celoSepolia"] as const;
export const MAINNET_CHAIN_ID = 42220;

export function loadDeploymentMetadata(network: string): DeploymentMetadata {
  if (!(ALLOWED_NETWORKS as readonly string[]).includes(network)) {
    throw new NetworkConfigError(
      `Network "${network}" is not in ALLOWED_NETWORKS (${ALLOWED_NETWORKS.join(", ")}). ` +
        `Mainnet and any other network fail closed until official deployment metadata is added deliberately.`
    );
  }

  const filePath = path.resolve(process.cwd(), "deployments", `${network}.json`);
  if (!existsSync(filePath)) {
    throw new NetworkConfigError(
      `No deployment metadata file found at ${filePath}. Refusing to guess contract addresses.`
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    throw new NetworkConfigError(`Failed to parse ${filePath} as JSON: ${(err as Error).message}`);
  }

  const parsed = DeploymentMetadataSchema.safeParse(raw);
  if (!parsed.success) {
    throw new NetworkConfigError(
      `Deployment metadata at ${filePath} failed validation: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`
    );
  }

  if (parsed.data.chainId === MAINNET_CHAIN_ID) {
    throw new NetworkConfigError(
      `Deployment metadata declares chainId ${MAINNET_CHAIN_ID} (Mainnet). ` +
        `Mainnet operations are disabled in this implementation until explicitly enabled by project decision.`
    );
  }

  return parsed.data;
}

export function contractAddress(meta: DeploymentMetadata, name: ContractName): `0x${string}` {
  return meta[name] as `0x${string}`;
}

export function deploymentBlock(meta: DeploymentMetadata, name: ContractName): number {
  return meta.deploymentBlocks[name];
}
