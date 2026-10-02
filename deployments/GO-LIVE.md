# Go-live checklist (testnets)

Deploying contracts is one step of nine. A lane is live only when its contracts are deployed and
activated through delayed governance, its operator wallets are funded, the generated service config
loads against the live chain, all four services run, and `/internal/healthz` reports the lane live.
Mainnet stays out of scope: every script, token, and service refuses mainnet chain ids and genesis.

Hosting: the web app on Vercel, and the API, solver, keeper, and indexers on one AWS instance behind
nginx, with SQLite state backed up to S3. `deployments/aws/README.md` has the host setup, systemd
units, nginx site, and Vercel settings; steps 5 to 7 below summarize them.

Each step links to the runbook that holds the exact commands. Env examples:

| Where | File | Used by |
|---|---|---|
| EVM deploy shell | `contracts/evm/.env.example` | `deployments/evm/README.md` commands |
| Solana deploy shell | `contracts/solana/.env.example` | `deployments/solana/devnet/README.md` commands |
| Release generator | `deployments/.env.example` | `deployments/tools/release-manifests.mjs` |
| Services | `services/{api,solver,keeper,indexer}/.env.example` | reference; the generator writes the real files |
| Web | `apps/web/.env.example` | reference; the generator writes `web/.env.production` |

## 1. Wallets and tools

- Foundry, the Solana CLI and Anchor toolchain, Node 22 with npm 11 (the lockfiles need it for `npm ci`), and `jq`.
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
- Size the pools before the packages. Every Base and Arbitrum entry buys WETH from its pool and
  every exit sells it back, so the WETH seeded in a pool bounds all users' open positions on that
  lane together, and testnet ETH is the scarce input (faucets pay little per day). Seed as much
  WETH as you can collect, then set the lane's maximum order size to about 1% of it (for example
  2 WETH seeded allows 0.02 WETH packages). Order bounds include each size's price impact from the
  pinned Uniswap quoter, and a size the pool cannot fill is refused before signing. The
  runbook examples seed 1 WETH, which suits a private test, not a public launch.
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

Timing values (quote, route, and order lifetimes, staleness bounds, poll intervals): each template
prompt carries a recommended value sized for a first-time user reading two wallet prompts and for
how often that chain's oracle updates. Shorter values pass every test and then fail real users.

Limits, modelled on how large venues bound risk rather than ration trading:

- `maxPrincipalAtomsPerOperation` and `maxRecoveryLossAtomsPerOperation`: every package, every lane.
- Capacity comes from the solver's own funds: a trade the solver cannot fill fails cleanly before
  anything moves (Base reverts atomically, an Arbitrum reservation fails without the bond).
- Hyperliquid `omnibus`: open packages per wallet in the shared trading account, and the total
  entry notional the account carries (an open-interest limit). Without it the API refuses
  Hyperliquid entries.
- Each lane's entry in the generated `api/testnet-execution-policy.json` is its on/off switch:
  remove a domain to stop new trades on it at once (exits on a removed domain are refused too, so
  prefer this only for emergencies).
- Optional daily brakes, off by default: add `maxPrincipalAtomsPerDay` (per network per UTC day)
  and `maxPrincipalAtomsPerOwnerPerDay` (per wallet) to the lane's entry under the
  `api/testnet-execution-policy.json` output in your template copy. Exits count as zero principal
  against them.
- Arbitrum `exitCallbackGasLimit`: the GMX callback of a full close also sells the spot leg, so it
  needs far more gas than the entry callback.

## 5. Run the services

On AWS, `deployments/aws/build.sh` builds and the systemd units in `deployments/aws/systemd` run
each service with its generated env file. By hand, build once per reviewed commit
(`deployments/tools/README.md`, build loop), then run each service on one host:

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

Never forward `/internal/solver/` or any other path. `deployments/aws/nginx/naryx-api.conf` does
exactly this, with per-IP read and write limits. The API also refuses any request that carries
proxy forwarding headers on its solver, keeper, and executor routes, so a proxy mistake cannot
expose them. Set the API's `NARYX_TERMINAL_ORIGIN` to the exact web origins, comma-separated (for
example the Vercel production domain and a custom domain; no wildcards), and the web's
`NEXT_PUBLIC_PRIVATE_TERMINAL_API_BASE_URL` to the proxy's public HTTPS URL.

## 7. Deploy the web app

On Vercel: Root Directory `apps/web`, Node.js 22, and the values of the generated
`web/.env.production` as Production environment variables. `NEXT_PUBLIC_*` values are compiled into
the bundle, so redeploy after any change. Leave the API URL unset for Preview deployments.

## 8. Smoke test each lane

1. `curl https://<api>/internal/healthz`: every deployed lane reports live.
2. Portfolio: connect a fresh wallet, claim test USDC on Base, Arbitrum, and Solana, and see the
   balances update.
3. Trade: one minimum-size package per lane, entry and exit, and its receipts on the Activity page.
4. Many users: repeat step 3 with a second wallet at the same time, then open the Activity page
   from another browser with the first wallet and exit from there.
5. Keeper: the code watchlist reports every target `MATCH`; the funding mirror stays `disabled`
   until its keeper key is funded and reviewed.

## What any user can do

Nothing in a lane is tied to the operator's wallet. Any visitor connects their own wallets and:

| Lane | Funding | Entry | Exit |
|---|---|---|---|
| Base Sepolia | Claim tUSDC in Portfolio; ETH gas from a public faucet | The wallet signs and sends the atomic package | Wallet-signed, from any device |
| Arbitrum Sepolia | Mint USDC.SG in Portfolio; ETH gas from a public faucet | The wallet creates its own Naryx account and signs; the solver submits to GMX and pays GMX fees | Wallet-signed exit authorization; the solver submits the full close |
| Solana Devnet | Claim test USDC in Portfolio; SOL from a public faucet | The wallet signs the service-built steps | Wallet-signed, from any device |
| Hyperliquid testnet | None | The EVM wallet signs the package authorization; the shared trading account executes, one package at a time | The owner wallet signs; only its own packages |

The Activity page lists each wallet's packages from the API, so they follow the wallet across
devices. How many users can trade at once is bounded by the funded operator inventory (the solver's
bonds and inventory, the Hyperliquid account) and by the caps above, so keep them funded.

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
- Arbitrum exit: GMX's accrued borrowing and funding fees are not read exactly, so the close carries
  a slippage allowance; if it is too small, GMX cancels the close and the package stays open. The
  close callback gas (`exitCallbackGasLimit`) is untested on the live network, and GMX refunds the
  unused execution fee to the owner, not the solver.
- Hyperliquid: every user's package runs in the service's shared testnet account (Hyperliquid's
  faucet does not fund new users), one package at a time; an outcome that is not final blocks the
  lane until fresh evidence shows it final (released automatically) or an operator releases it
  (`deployments/aws/README.md`, Operating). A spot buy's fee is
  paid in the base token, so each package leaves sub-lot base dust in the account; size the
  terminal base residual cap to at least the largest base fee plus one spot lot.
- Solana: firm entry and exit have no end-to-end LiteSVM test.
- Seeded Uniswap pools drift from the oracle as people trade; nothing re-centres them yet.
- The public v1 market API (package order book, solver metrics) is optional and off unless
  configured; quote-based trading does not need it.
