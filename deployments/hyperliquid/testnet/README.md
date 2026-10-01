# Hyperliquid Testnet release values

Hyperliquid has no Naryx contract, so there is no deployment record here. `release.template.json` holds the reviewed operator configuration the API and solver load for `hypercore:testnet`: the domain manifest (its hash is computed with `packages/protocol-types`), market and token indexes, adapter, venue, and market manifest identities, order bounds, and the solver quote route.

Fill a copy outside the repository and pass it to `deployments/tools/release-manifests.mjs` with the shared release file. The generator writes `api/hyperliquid-testnet-runtime.json`, `solver/hyperliquid-testnet-quote.json`, the execution policy entry, and the env entries, loads them with `loadHyperliquidTestnetRuntimeConfig` and `loadHyperliquidTestnetQuoteRuntime`, and checks the asset indexes and size decimals against the public testnet `meta` and `spotMeta`. It never reads an agent key.

The evidence runtime, the API executor client, and the solver executor stay off (`false`) in the generated env. Enabling the solver executor additionally needs the `NARYX_HYPERLIQUID_TESTNET_*` executor variables (agent key path and address, master and trading accounts, allowed coins and token indices, book and authority bounds, journal path); add them to this template's `env/solver.env` output after review. Nothing here authorizes a mainnet action.
