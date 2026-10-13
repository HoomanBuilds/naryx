# Naryx contracts

Naryx verifies complete strategy outcomes on Solana and EVM chains. Each contract family owns only the guarantees its transaction model can enforce. The surrounding services coordinate quotes, delayed venue actions, finality, recovery, and receipts.

| Workspace | Language | Current role | Guide |
|---|---|---|---|
| [`solana/`](solana/) | Rust and Anchor | Package books, firm inventory, registry and risk controls, atomic strategy execution, and typed testnet venue adapters | [Solana programs](solana/README.md) |
| [`evm/`](evm/) | Solidity and Foundry | Atomic Base strategy accounts, bonded Arbitrum coordination, typed multi-strategy adapters, and isolated native clearing | [EVM contracts](evm/README.md) |

Hyperliquid has no Naryx contract. Its IOC planning, account checks, attempt journal, and fill reconciliation live in the [Hyperliquid adapter](../packages/adapters/hyperliquid/README.md) and the execution services.

## Execution boundaries

| Route | What the contract can guarantee | What requires observation or recovery |
|---|---|---|
| Solana Devnet | A signed package meets its checked postconditions inside one Solana transaction or the transaction fails. | Subsequent position management and public receipt projection. |
| Base Sepolia | The strategy account, verifier, and ports enforce a same-transaction package outcome. A failed leg rolls the transaction back. | Event finality, indexer projection, and later lifecycle actions. |
| Arbitrum Sepolia | The isolated account and bonded coordinator bind the user, request, recovery limits, and solver obligations. | GMX request callbacks, rollback, exit, and terminal reconciliation across transactions. |
| Hyperliquid Testnet | No Naryx contract guarantee. | Authoritative venue fills, fees, residuals, and bounded recovery are reconciled by the adapter and services. |

The settlement class is part of a signed route. A delayed or batched route is never described as atomic.

## Public testnet records

- [Solana Devnet cash-and-carry release](../deployments/solana/devnet/release.json) and [multi-strategy release](../deployments/solana/devnet/multi-strategy-release.json) record program identities and activation transactions.
- [Base Sepolia atomic release](../deployments/evm/base-sepolia/release.json) and [multi-strategy release](../deployments/evm/base-sepolia/multi-strategy-release.json) record contracts and activation.
- [Arbitrum Sepolia bonded release](../deployments/evm/arbitrum-sepolia/release.json) records the coordinator, isolated account, venue adapters, and activation.

The records use test assets and controlled test liquidity. A deployed module is not automatically an active market, and no mainnet write is authorized.

## Local checks

```bash
cd contracts/solana
anchor build --ignore-keys
cargo test
```

```bash
cd contracts/evm
forge fmt --check
forge build
forge test
```

Cross-workspace flows are exercised by [`tests/solana-local`](../tests/solana-local/README.md), [`tests/evm-local`](../tests/evm-local/README.md), and [`tests/arbitrum-local`](../tests/arbitrum-local/README.md). The [deployment guide](../deployments/README.md) covers artifact publication and testnet release records.
