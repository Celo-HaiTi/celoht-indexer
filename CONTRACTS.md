# CONTRACTS.md

| Name | Address (celoSepolia) | Deployment block |
|---|---|---|
| CeloHTAgentRegistry | `0x7C5bF20191f6b467aAcd2DD7693110cc4c17Cc2e` | 35343240 |
| CeloHTServicePayments | `0xe91b8A6302FCf5a64A84c671C61B0F1DdA5F0ad2` | 35343243 |
| CeloHTEducation | `0x7422F20F025aCaad86c4de5E6Fa0F3a7B55ac09a` | 35343245 |
| CeloHTReforestation | `0xc1eEd81Aa989D818897CCffc755dC2a9B37F9e2A` | 35343247 |
| CeloHTGovernance | `0x7D384851FAbB912287206556479Dd30c740CAdA5` | 35343249 |

Source: `deployments/celoSepolia.json`, copied from
`Celo-HaiTi/celoht-smart-contracts/deployments/celoSepolia.json`. This file —
not this document — is the value the code actually reads.

USDm (settlement asset): `0xdE9e4C3ce781b4bA68120d6261cbad65ce0aB00b`.
Treasuries (general/education/reforestation/governance) all currently point
to the same confirmed CeloHT Treasury Safe: `0xd856e0599cc49C9cef6C358d2c2f064112A6b384`.

## ABIs

The five files in `abis/` are compiled Hardhat artifacts generated from the
authoritative smart-contract repository. The loader refuses missing or empty
artifacts. Event names and parameter names used by the decoder are therefore
source-derived rather than hand-written guesses.
