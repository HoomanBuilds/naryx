# Arbitrum local environment

This workspace deploys the Naryx asynchronous coordinator, the shared GMX route bound into the per-owner isolated account factory, and labeled local venue dependencies to a private Anvil chain. It never connects to a public network and the assets have no value.

The trader's ephemeral wallet creates its own factory account, signs its reservation and full close as EIP-712 typed data, and funds its own entry. The solver only posts the bond.

Run `npm test` after building the Foundry workspace.
