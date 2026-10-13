# Solana programs

This Anchor workspace contains Naryx's SVM verifier and the programs it calls for package liquidity and strategy execution. The current public deployment is on Solana Devnet; local conformance programs and the deterministic Devnet perpetual are test infrastructure.

## Program map

| Program | Responsibility |
|---|---|
| `naryx_core` | Domain and resource registries, risk domains, solver admission, signed cash-and-carry terms, fee policy, and exact entry or exit postconditions. |
| `naryx_package_book` | Canonical package markets, maker quote shards, public depth, and package allocation. |
| `naryx_inventory_reservation` | Firm, funded inventory commitments with bounded consumption. |
| `naryx_inventory_adapter` | Typed execution against a strategy's owned token inventory. |
| `naryx_multi_strategy` | Multi-leg strategy accounts, authorized actions, recovery, and idle-token withdrawal. |
| `naryx_orca_adapter` | Typed spot adapter for the supported Orca route. |
| `naryx_rise_adapter` | Typed perpetual adapter for the supported Rise route. |
| `naryx_test_perp` and `naryx_test_perp_adapter` | Pyth-priced Devnet perpetual and its typed adapter; these are testnet substitutes, not production venue liquidity. |
| `naryx_conformance_venue` | Local deterministic venue used for tests only. |

The [Devnet cash-and-carry release](../../deployments/solana/devnet/release.json) and [multi-strategy release](../../deployments/solana/devnet/multi-strategy-release.json) identify the actual public programs. `Anchor.toml` contains local and Devnet program identities, but an ID in configuration alone is not deployment evidence.

## A package on Solana

1. A versioned domain manifest, resource records, series binding, risk domain, and solver are activated through their required governance paths.
2. The owner signs a package with exact asset identities, size and price limits, fee caps, expiry, and permissible residuals.
3. A maker or solver supplies a quote bound to the same package, its supported execution class, and its inventory reservation.
4. The core invokes only recognized typed adapters and checks the resulting asset, position, fee, and strategy state in the transaction. A failed postcondition fails the transaction.
5. Later decreases and exits use their own authorization and evidence. An entry pause does not silently erase an available safe exit.

Unknown resources or manifest versions fail closed. A new asset or venue instance requires a versioned manifest and delayed registration; new adapter semantics require reviewed program code first.

## Build and test

Requirements: the Solana CLI, Anchor, Rust, and the pinned npm dependencies from this workspace's `package-lock.json`.

```bash
npm ci
anchor build --ignore-keys
cargo test
```

`--ignore-keys` is for a fresh checkout whose ignored `target/deploy` keypairs do not match the public IDs declared in source. A reviewed deployment injects external keypairs, synchronizes public IDs, and then runs an ordinary `anchor build`. No keypair is committed.

For a local transaction lifecycle, run the [Solana integration suite](../../tests/solana-local/README.md). For an existing Devnet release, inspect [deployment steps and verification](../../deployments/solana/devnet/README.md). Those steps are for Devnet only and require an explicit reviewed deployment action.

## Artifacts and limits

Published IDLs are under [`deployments/solana`](../../deployments/solana/). Generated `target/` files are ignored. The current Devnet quote asset is test USDC; its inventory and test perpetual have no real value. Program deployment, quote availability, and observed user fills are distinct claims.
