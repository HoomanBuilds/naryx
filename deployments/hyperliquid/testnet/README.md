# Hyperliquid Testnet release values

Hyperliquid has no Naryx contract, so there is no deployment record here. `release.template.json` holds the reviewed operator configuration the API and solver load for `hypercore:testnet`: the domain manifest (its hash is computed with `packages/protocol-types`), market and token indexes, adapter, venue, and market manifest identities, order bounds, and the solver quote route.

Fill a copy outside the repository and pass it to `deployments/tools/release-manifests.mjs` with the shared release file. The generator writes the runtime, native strategy-order profiles, cash-and-carry, treasury-hedge, and funding-spread preparation files, their three generalized quote lanes, the execution policy entry, and the env entries. It loads every file with the service's own loader, checks that every native profile matches its exact template and quote execution class, and checks the cash-and-carry asset indexes, order asset ids, size decimals, and token precisions against the public testnet `meta` and `spotMeta`. It never reads an agent key.

Pick a market whose spot and perpetual books are both two-sided within `maxBookSpreadBps` (at most 1000): the API serves the lane's market, previews, and orders only while both books pass, and `/internal/healthz` reports each configured lane's market as `LIVE` or `UNAVAILABLE`. On 2026-10-03 no Hyperliquid testnet spot pair that tracks a perpetual met that bound (the Unit ETH pair `@1137` quoted 46 / 139 against an ETH perpetual near 2675), so the lane correctly shows its market unavailable until one does.

Every venue fee cap a package signs is checked against the solver's quote. The configured `maxVenueFeeAtomsByAsset` caps the quote asset; the base-asset cap for HyperCore's spot-buy fee is derived per order from the live spot taker rate plus `feeShortfallSlackBps`, rounded up, the same allowance that bounds the order's net spot shortfall. An entry size the live books cannot fill within the order's limits (the spot asks up to the ask plus the trader's slippage, the perpetual bids down to the bid less `maxSlippageBps`) is refused before anything is signed.

The base asset is carried at the spot token's full precision (`weiDecimals`), not its size grid. HyperCore takes a spot buy's taker fee in the received base token, so an entry leaves the account holding slightly less than it bought, below one size unit; the keeper reconciles that exactly and attributes the package's spot delta as its fill less its base fee. Entry sizes must be whole lots of the coarser size grid, and an exit sells the package's spot floored to the spot lot: the sub-lot fee dust stays in the trading account, is recorded on the package, and must fit `maxTerminalResidualBaseQuantityAtoms`.

Execution is one reviewed switch: `definitions.executionEnabled`. With `false` the lane serves quotes only. With `true` the generated env turns on the API evidence runtime and executor client and the solver executor together, and writes every executor variable from `definitions.executor`: the approved agent wallet address and key file path (the path only), the master account and account kind, the spot universe, token names, token ids, and canonical flags, the perpetual name, minimum book depths, leverage mode, and the reference divergence bound. The generator then checks those names, token ids, canonical flags, and size decimals against the live testnet `meta` and `spotMeta`. The executor posts orders through the agent wallet to the trading account, and the keeper (`NARYX_KEEPER_PORT`, default 8789) serves its evidence, so the keeper must run beside it. Approve the agent wallet on the trading account and fund the account with Hyperliquid testnet USDC before setting `true`. Nothing here authorizes a mainnet action.

## Account modes

Normal execution uses `NARYX_HYPERLIQUID_TESTNET_ACCOUNT_MODE=PER_USER` in both API and
solver. Each owner funds their own Hyperliquid testnet account and approves its dedicated
agent. Orders, quotes and execution bind to that owner's account. An unenrolled owner is
refused; the runtime never falls back to the operator account. Funding availability and
venue faucet eligibility are separate from Naryx account enrollment.

`SHARED_TEST_FIXTURE` is the legacy controlled-test mode, not public customer custody.
Its explicit `omnibus` limits bound open packages per owner and total entry notional;
missing limits refuse entries. Account-wide execution is serialized through a durable
lane, and uncertain outcomes keep that lane blocked until authoritative evidence resolves
them. The legacy configuration must not be used to silently pool normal users' funds.

The optional shared collateral pool is a third, separately deployed runtime with its own
account, ledger, signed custody consent, owner allowlist and 20 mock-USDC test cap. Its
Portfolio controls expose authenticated account reads, deposit reconciliation and signed
withdrawals. Epoch trading remains operator-only and requires separate signatures from
every participating owner and its recovery sponsor. Pool balances are custodial claims,
not transferable owner-specific HyperCore positions. See the solver README and GO-LIVE
record for the executed test cycles and their limitations.
