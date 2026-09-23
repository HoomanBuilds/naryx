# Solana conformance adapter

This package compiles an admitted atomic cash-and-carry package into one unsigned `execute_conformance_atomic` instruction. It resolves account addresses from named route bindings, derives the config and trader-bound receipt PDAs, and uses the published Anchor IDLs in `deployments/solana/conformance/idl` for instruction and receipt encoding.

`simulate` verifies the RPC genesis hash and submits only an unsigned simulation. `readEvidence` reads a receipt PDA and verifies the program owner, order hashes, trader, and action. This package has no signing or broadcast path.

The caller must pass the result of `validatePackageAdmission`. The conformance program currently enforces exact spot and short quantity changes plus the stated spot and collateral limits. It does not verify package signatures, quote signatures, route hashes, package spread, or fee collection onchain. This adapter is for local and test networks until those checks exist in a production verifier.
