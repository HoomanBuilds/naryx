# deployments

Data only. No executable business logic.

Holds per-network deployment identity and the generated environment manifests that make a run reproducible:

- program IDs and contract addresses;
- ABIs and IDLs published from `contracts/evm` and `contracts/solana`;
- code hashes, deployment slots and blocks, and upgrade-authority state;
- proxy, beacon, implementation, and admin graphs where applicable;
- pinned external dependency identities and reviewed source revisions;
- generated parity environment manifests.

## Allowed dependencies

Depends on nothing. Consumed by `packages/adapters/*`, `services/*`, `apps/web`, and `tests`.

## Rules

- Never contains a private key, mnemonic, API credential, or any other secret.
- Local and ephemeral deployment records are ignored by Git. Only intentional, reproducible release artifacts are committed.
- A recorded mainnet identity is evidence of what exists, not authorization to write to it. No mainnet write until the readiness gates pass.
- Environments are recorded in promotion order: local deterministic, devnet and testnet, pinned production-state clone or fork, read-only shadow mainnet, capped mainnet.

Responsibilities and dependency direction are specified in the repository architecture document.
