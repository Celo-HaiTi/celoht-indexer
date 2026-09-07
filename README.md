# CeloHT Indexer

Production-oriented Celo Sepolia blockchain synchronizer for CeloHT. It reads verified contract events, validates and decodes them, persists canonical provenance in Supabase, and resumes from durable checkpoints.

## Verified deployment

The checked-in `deployments/celoSepolia.json` is copied from `Celo-HaiTi/celoht-smart-contracts`. The network is Celo Sepolia, chain ID `11142220`, with RPC verification required at startup. Mainnet is deliberately disabled until an official mainnet deployment manifest and ABI set are reviewed.

ABIs in `abis/` are generated Hardhat artifacts from the authoritative smart-contract source. The loader fails closed if any required ABI is missing or malformed.

## Events

Only events present in the deployed contract ABIs are accepted: Agent Registry (`AgentRegistered`, `AgentStatusUpdated`, `AgentVerificationUpdated`, `RegistrationFeeUpdated`, `TreasuryUpdated`), Service Payments (`ServicePaid`, `PaymentDistributed`, `ServicePriceUpdated`, `TreasuryUpdated`, `SplitUpdated`), Education (`CertificateFeePaid`, `CertificateIssued`, `CertificateRevoked`, `IssuerAuthorizationChanged`, `CertificateFeeUpdated`, `TreasuryUpdated`), Reforestation (`DonationReceived`, `TreasuryUpdated`), and Governance (`ProposalCreated`, `VoteCast`, `ProposalFinalized`, `ParticipationFeeUpdated`, `TreasuryUpdated`, `ProposerAuthorizationChanged`). OpenZeppelin role events are also decoded when present in the compiled ABI.

## Run

```bash
npm ci
cp .env.example .env
npm run typecheck && npm test && npm run build
npm start
```

Use `DRY_RUN=true` to scan and decode without writing events or checkpoints. Use `START_BLOCK` to choose a resume point; it is never allowed before a contract's verified deployment block. USDm has no deployment block in the official manifest, so its explicit scan lower bound is `USDM_START_BLOCK` (default `0`). See [CONFIGURATION.md](CONFIGURATION.md), [DATA_MODEL.md](DATA_MODEL.md), [OPERATIONS.md](OPERATIONS.md), and [DEPLOYMENT.md](DEPLOYMENT.md).

Health and readiness are exposed at `GET /health` and `GET /readyz` on port `PORT` or `8080`.

## Scope

This repository owns blockchain synchronization only. It indexes verified contract events and USDm transfers, but does not authenticate users, submit transactions, create application records, verify real-world impact, or write backend-owned Supabase tables.
