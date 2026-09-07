# ABIs

This directory must contain the exact compiled ABI JSON files from the
authoritative source of truth:

https://github.com/Celo-HaiTi/celoht-smart-contracts

Required files (Hardhat/Foundry artifact `.abi.json` or extracted ABI arrays):

- CeloHTAgentRegistry.json
- CeloHTServicePayments.json
- CeloHTEducation.json
- CeloHTReforestation.json
- CeloHTGovernance.json

## Why they are not included here

This indexer never hand-writes or guesses an ABI, an event name, or an event
signature — the project's global principles ("no fake blockchain data",
"never guess event names") prohibit it. I do not have network/GitHub access
in this environment, so I could not fetch the real compiled ABI artifacts
from `celoht-smart-contracts` to embed here.

## What happens if a file is missing

`src/config/abiLoader.ts` fails closed: on startup, the indexer refuses to
begin syncing any contract whose ABI file is absent, and refuses to start
Mainnet indexing until Mainnet deployment metadata AND ABIs both exist. It
never falls back to a partial or fabricated ABI.

## How to populate this directory

```bash
# from a checkout of Celo-HaiTi/celoht-smart-contracts, after `npx hardhat compile`
cp artifacts/contracts/CeloHTAgentRegistry.sol/CeloHTAgentRegistry.json \
   /path/to/celoht-indexer/abis/CeloHTAgentRegistry.json
# (repeat for the other four contracts, or write a small sync script that
# extracts just the `abi` field from each Hardhat artifact)
```
