# Go-live checklist (testnets)

Deploying contracts is one step of nine. A lane is live only when its contracts are deployed and
activated through delayed governance, its operator wallets are funded, the generated service config
loads against the live chain, all four services run, and `/internal/healthz` reports the lane live.
Mainnet stays out of scope: every script, token, and service refuses mainnet chain ids and genesis.

Each step links to the runbook that holds the exact commands. Env examples:

| Where | File | Used by |
|---|---|---|
| EVM deploy shell | `contracts/evm/.env.example` | `deployments/evm/README.md` commands |
| Solana deploy shell | `contracts/solana/.env.example` | `deployments/solana/devnet/README.md` commands |
| Release generator | `deployments/.env.example` | `deployments/tools/release-manifests.mjs` |
| Services | `services/{api,solver,keeper,indexer}/.env.example` | reference; the generator writes the real files |
| Web | `apps/web/.env.example` | reference; the generator writes `web/.env.production` |

## 1. Wallets and tools

- Foundry, the Solana CLI and Anchor toolchain, Node 22, and `jq`.
- Separate testnet wallets, each in a Foundry keystore or an external Solana keypair file (never in
  the repository): EVM deployer, proposer, canceller, executor, pauser, solver, test perp owner,
  funding keeper; Solana payer, upgrade authority, proposer, executor, market owner, solver, funder,
  lookup table authority; Hyperliquid master or trading account and its approved agent wallet.
- Gas: Base Sepolia ETH and Arbitrum Sepolia ETH for every EVM wallet that sends (the Arbitrum
  solver also pays GMX execution fees), Devnet SOL for every Solana wallet (program deploys need
  several SOL), and Hyperliquid testnet USDC in the trading account (Hyperliquid's faucet pays only
  addresses with mainnet history).

## 2. Test USDC and spot liquidity

`deployments/evm/README.md`, "Test USDC and spot liquidity", and `deployments/solana/devnet/README.md`
operator step 2.

- Base: deploy `NaryxTestUSDC`; seed the WETH / tUSDC Uniswap V3 pool at the Chainlink price.
- Arbitrum: seed the WETH / USDC.SG pool (fee 100) at the Chainlink price. USDC.SG is GMX's token.
- Solana: create the faucet test USDC mint; claim for the funder and the solver.

## 3. Deploy and activate each lane

- Base Sepolia: deploy the atomic package with the tUSDC quote route, rotate the domain and set the
  template through the delayed `ProtocolConfig` steps, deploy the firm liquidity layer with
  `runWith`, run every configure wave (propose, wait `configDelaySeconds`, activate), unpause, then
  mint tUSDC to the test perp owner and `fundInsurance`.
- Arbitrum Sepolia: first confirm GMX has not migrated. The pinned ExchangeRouter and OrderHandler
  must still hold GMX's CONTROLLER role (both did on 2026-10-02; GMX's repository already lists newer,
  not yet activated, addresses):

  ```bash
  ROLE=$(cast keccak "$(cast abi-encode 'f(string)' CONTROLLER)")
  for a in 0x6B489dD5bB1AAE8df246359d59aA7316760a75d2 0xC881c2391611829d7bc81c12a285cB0201F08f8c; do
    cast call 0x433E3C47885b929aEcE4149E3c835E565a20D95c "hasRole(address,bytes32)(bool)" "$a" "$ROLE" --rpc-url "$ARBITRUM_SEPOLIA_RPC_URL"
  done
  ```

  If either prints `false`, update `ARBITRUM_SEPOLIA_GMX_DEPENDENCIES` and the deploy parameters to
  GMX's current contracts before deploying. Then deploy against GMX market
  `0xb6fC4C9eB02C35A134044526C62bb15014Ac0Bcc` and the seeded pool, rotate the domain, run admission
  and unpause; mint USDC.SG to the solver for its bond and recovery reserve.
- Solana Devnet: build with the `devnet-test-perp` feature, deploy and verify the five programs,
  run `initialize-devnet.mjs` (it waits for each activation slot), create the lookup table, fund the
  solver's SOL inventory.
- Hyperliquid testnet: no contracts. Approve the agent wallet on the trading account and fund it.

## 4. Generate the service configuration

`deployments/tools/README.md`. Copy each `release.template.json` outside the repository, fill every
`{"$operator": ...}` value (including the per-domain execution caps), fill `deployments/.env`, then
run the generator once with every deployed network. It writes `env/api.env`, `env/solver.env`,
`env/keeper.env`, `env/indexer-<network>.env`, `web/.env.production`, and the runtime JSON files,
and it fails unless each one loads with the services' own code against the live chains (code
hashes, domain and template hashes, oracle reads, Hyperliquid metadata).

Set the Hyperliquid template's `executionEnabled` to `true` only once the agent wallet is approved
and funded; `false` serves quotes without executing.

## 5. Run the services

Build once per reviewed commit (`deployments/tools/README.md`, build loop), then run each service with
its generated env file on one host:

```bash
node --env-file=/srv/naryx/release/env/api.env services/api/dist/main.js
node --env-file=/srv/naryx/release/env/solver.env services/solver/dist/main.js
node --env-file=/srv/naryx/release/env/keeper.env services/keeper/dist/main.js
node --env-file=/srv/naryx/release/env/indexer-base-sepolia.env services/indexer/dist/main.js
node --env-file=/srv/naryx/release/env/indexer-arbitrum-sepolia.env services/indexer/dist/main.js
```

Default loopback ports: API 8787, solver 8788, keeper 8789, public market API 8790 (only when
enabled), Hyperliquid executor 8792, Arbitrum executor 8793, Base solver authorization 8794,
Solana binding 8795. Every listener binds 127.0.0.1; keep it that way.

## 6. Expose the API to browsers

The browser calls the API directly. Put an HTTPS reverse proxy on the same host in front of
`127.0.0.1:8787` and forward only:

- `/internal/terminal/` (prefix)
- `/internal/healthz`

Never forward `/internal/solver/` or any other path. The API admits solver, keeper, and executor
routes only from loopback peers, and every request a same-host proxy forwards arrives from loopback.
Set the API's `NARYX_TERMINAL_ORIGIN` to the exact web origin (CORS), and the web's
`NEXT_PUBLIC_PRIVATE_TERMINAL_API_BASE_URL` to the proxy's public HTTPS URL.

## 7. Deploy the web app

Copy the generated `web/.env.production` into `apps/web/.env.production` (or the hosting provider's
environment settings), then `npm run build` in `apps/web` and deploy. `NEXT_PUBLIC_*` values are
compiled into the bundle, so rebuild after any change.

## 8. Smoke test each lane

1. `curl https://<api>/internal/healthz`: every deployed lane reports live.
2. Portfolio: connect a fresh wallet, claim test USDC on Base, Arbitrum, and Solana, and see the
   balances update.
3. Trade: one minimum-size package per lane, entry and exit, and its receipts on the Activity page.
4. Keeper: the code watchlist reports every target `MATCH`; the funding mirror stays `disabled`
   until its keeper key is funded and reviewed.

## 9. Public copy

Replace the landing page's "Pre-mainnet: public deployment deferred" status only after step 8
passes on every lane being announced.

## Not yet proven

These have passed local, fork, and LiteSVM tests but have never run against the live testnets:

- No lane has executed a package on a live testnet yet; step 8 is the first end-to-end run.
- Arbitrum: GMX execution depends on GMX's testnet keepers (they executed 122 of 143 orders in the
  week to 2026-10-02). The GMX fee and gas keys the solver reads return live values. Automated
  recovery of a stuck GMX order is not built, so a failed order is resolved by the bonded recovery
  path and the operator.
- Hyperliquid: execution runs on the service's own testnet account, not the user's.
- Solana: firm entry and exit have no end-to-end LiteSVM test; concurrent package book writes may
  need a retry.
- Seeded Uniswap pools drift from the oracle as people trade; nothing re-centres them yet.
- The public v1 market API (package order book, solver metrics) is optional and off unless
  configured; quote-based trading does not need it.
