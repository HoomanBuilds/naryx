# Arbitrum local environment

This workspace deploys the Naryx asynchronous coordinator, the shared GMX route bound into the per-owner isolated account factory, and labeled local venue dependencies to a private Anvil chain. It never connects to a public network and the assets have no value.

The trader's ephemeral wallet creates its own factory account, signs its reservation and full close as EIP-712 typed data, and funds its own entry. The solver only posts the bond.

Run `npm test` after building the Foundry workspace.

`npm run test:arbitrum-sepolia` runs the bounded public Arbitrum Sepolia evidence lane. It first proves that a rejected GMX submission reverts the spot purchase and request creation together, releases the reserved owner funding, then opens and closes one real asynchronous GMX testnet cash-and-carry package. It writes evidence outside the repository. Required environment variables are `NARYX_ARBITRUM_SEPOLIA_RPC_URL`, `NARYX_ARBITRUM_SEPOLIA_SOLVER_KEY_PATH`, and `NARYX_ARBITRUM_SEPOLIA_OWNER_KEY_PATH`. Both key files remain outside the repository with owner-only permissions. The runner is testnet-only and refuses every other chain.
