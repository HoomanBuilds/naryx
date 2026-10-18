# Go-live checklist (testnets)

Deploying contracts is one step of nine. A lane is live only when its contracts are deployed and
activated through delayed governance, its operator wallets are funded, the generated service config
loads against the live chain, and its deployed user flows satisfy the completion target below.
A `LIVE` runtime in `/internal/healthz` proves runtime availability, not that every feature works.
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
  mint tUSDC to the test perp owner and `fundInsurance`. Deploy the independent multi-strategy suite,
  conformance markets, typed adapter factories, and native clearing house, then activate its fee,
  adapter, and risk policies through the same delayed governance roles.
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
  and unpause; mint USDC.SG to the solver for its bond and recovery reserve. Deploy and activate the
  same independent multi-strategy suite used on Base so both EVM lanes expose the same package types.
- Solana Devnet: build with the `devnet-test-perp` feature, deploy and verify the seven programs,
  run `initialize-devnet.mjs` (it waits for each activation slot), create the lookup table, fund the
  solver's SOL inventory. Before the first deploy, require the payer to hold the measured seven-program
  rent total plus at least 2 SOL for fees, initialization, lookup-table rent, and retries.
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
  `api/testnet-execution-policy.json` output in your template copy. A per-network cap requires the
  per-wallet cap, so one wallet cannot use up the day for everyone. Exits count as zero principal
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

Users connect their own wallets. Entry still requires the specific lane's funding,
qualification, supported account mode and execution caps:

| Lane | Funding | Entry | Exit |
|---|---|---|---|
| Base Sepolia | Claim tUSDC in Portfolio; ETH gas from a public faucet | The wallet signs and sends the atomic package | Wallet-signed, from any device |
| Arbitrum Sepolia | Mint USDC.SG in Portfolio; ETH gas from a public faucet | The wallet creates its own Naryx account and signs; the solver submits to GMX and pays GMX fees | Wallet-signed exit authorization; the solver submits the full close |
| Solana Devnet | Claim test USDC in Portfolio; SOL from a public faucet | The wallet signs the solver's firm quote; one atomic transaction | Wallet-signed firm buy-back exit from the solver |
| Hyperliquid testnet | Fund the user's own Standard testnet account and approve its restricted agent through enrollment | The owner signs the package authorization; its enrolled venue account executes | The owner signs; only its own packages |

The Activity page lists each wallet's packages from the API, so they follow the wallet across
devices. How many users can trade at once is bounded by the funded operator inventory (the solver's
bonds and inventory), each user's venue account, and the caps above. The optional shared Hyperliquid
pool is a separate dedicated test cohort, not a substitute for public enrollment. Its signed
browser API exposes only each approved owner's consent, balance and funding operations. Epoch
trading controls remain operator-only.

## 9. Public copy

Replace the landing page's "Pre-mainnet: public deployment deferred" status only after step 8
passes on every lane being announced.

## Fixed testnet completion scope

The six outstanding items below are the completion scope established on 2026-10-17.
Changes and verification belong to these items; the broader roadmap does not add new launch
requirements. Process health, implemented classes and isolated checks are not end-to-end activation.

Status checked 2026-10-18:

| Item | Current state | Evidence needed to close |
| --- | --- | --- |
| 1. Standing liquidity for routed strategies | Open. Funded native cash books are live, but represent different instruments. | Funded routed quotes, an actual matching execution, and reconciled inventory. Do not copy cash liquidity into routed books. |
| 2. Cross-chain execution activation | Open. Submission journaling exists; coordinator startup and filled-position compensation are not activated. | A successful multi-domain execution and a failed-side recovery that reconciles already-filled positions without duplicate submission. |
| 3. Hyperliquid pooled-mode terminal integration | Browser controls deployed. The funded operator cycle passed; browser navigation passed. | Authenticated browser account actions and their reconciled records. A new funded browser cycle needs separate funding approval because the completed pool was fully withdrawn. |
| 4. Strategy ownership transfers | Open. The public strategy book has no venue-transfer evidence verifier. | Both owners' consent plus verified transfer of the underlying positions, reconciled in the strategy book. Database reassignment alone is not a transfer. |
| 5. Threshold-encryption backend | Backend and solver participation deployed; a real beacon opening was verified. | Preserve this completed backend evidence. Any claim of terminal-integrated encrypted trading also needs an encrypted auction award and settlement; current terminal auctions remain ordinary commit/reveal. |
| 6. Operational wiring and documentation | Runbook corrected, incident endpoint wired, bounded oracle maintenance deployed. Solana qualification evidence remains unavailable. | A valid qualification journal backed by current release evidence. Do not manufacture a healthy status from a matching code watchlist. |

Independent maker recruitment and additional roadmap capabilities are not new items in this
completion scope. Report their limitations separately without reopening completed work.

### Finish line: usable shipped website

Target: the existing Naryx website works end to end on testnet, including the original six items
above. The scope baseline is commit `3037ee1d`. This is a release acceptance record, not runtime
configuration. Do not add features, chains, templates or redesigns unrelated to a failing shipped
flow. Newly discovered defects belong to their existing page and completion item, not a new phase.

| Shipped surface | Required result |
| --- | --- |
| Trade | Chain and market selection, charts, depth, quote comparison, RFQ, auctions, order entry, cancellation and supported lifecycle actions work. Every enabled template/action has an explicit supported-domain check. Wallet refusal, expiry and insufficient balance leave no false fill or stranded local pending state. |
| Markets | Search, watchlists, comparison, market details, registry reads, curves, scanner, paper desk and graph studio work against their stated data. Routed liquidity and native cash liquidity remain distinct. Paper results never appear as real trades. |
| Portfolio | Wallet balances and faucets work; deposits, collateral, positions, exits, strategy lifecycle, transfers and approved pool controls reconcile with authoritative state. One wallet cannot read private account data or operate another wallet's positions. |
| Activity | Orders, cancellations, auctions, fills, fees, receipts, exports and recovery status match backend and chain/venue evidence. Refresh and reconnect preserve the result without duplicate execution. |
| Makers | Published levels, backed capacity, reservations, fills, quote refresh, cancellation and kill controls agree with the actual maker state. Empty or expired levels are never advertised as executable. |
| Network | Runtime health, qualification, settlement class, solver evidence and incidents describe the actual deployed controls. A running process does not override missing qualification evidence. |
| Landing and shared shell | Links reach the correct pages; wallet connection and network changes work; market names and layouts remain readable. No broken navigation, clipped execution controls or misleading live claims. |

Completion requires all of the following:

1. Each currently enabled action is recorded as passed, blocked or not applicable for its actual
   template, domain and account mode. Hidden wallet-dependent controls are included. Route reuse
   permits shared low-level evidence, but does not prove an untested template's execution.
2. Funded execution checks use approved test accounts and limits. UI state, persisted API records
   and finalized chain or authoritative venue outcomes agree, including fees and resulting balances.
   Actual empty accounts and zero activity are valid; fabricated depth, receipts or PnL are not.
3. The affected failure paths are checked once: rejected signature, stale quote, insufficient
   funds, duplicate submission and relevant recovery. Repeat only a failed flow or a flow affected
   by a subsequent fix, not the whole test suite after every edit.
4. Each fix reaches the relevant AWS service or static frontend deployment. One final browser
   pass checks the shipped action matrix, plus a controlled restart/reconnect check for changed
   pending-execution paths. No known blocking defect or unreconciled test operation remains.
5. All six original items have evidence-based closure, or an explicit release-scope decision.
   Disabling a broken control protects users but does not complete its underlying feature.
   Missing funding or external authority is reported as a specific blocker, not silently waived.

After these conditions pass, stop this completion sprint. Optional polish and additional roadmap
capabilities require a separate task. Do not claim that this bounded verification proves zero bugs.

Latest read-only website pass, 2026-10-18: Trade, Markets, Portfolio, Activity, Network and Makers
returned HTTP 200 with no uncaught browser exceptions at 1440px. This was disconnected navigation,
not authenticated transaction verification. Routed depth was empty. The Arbitrum standing-book
endpoint returned HTTP 409 on Markets and Portfolio before a subsequent read returned valid
five-unit bid and ask quotes; its intermittent availability remains open under items 1 and 6.
All nine checked Naryx AWS services were active, but health remained degraded because one configured
Solana incident scope had no qualification journal. These findings do not close the action matrix.

## Verified testnet scope and remaining limitations

Updated 2026-10-18. The root README and versioned release records identify the live paths.
First-route cash-and-carry execution has testnet evidence on all four domains. Additional
strategy support is specific to a registered template and deployment, not every catalogue entry.

- Base and Arbitrum native cash-range markets have funded browser entry/exit, withdrawal and
  finalized receipt evidence, including server reconciliation after browser closure and restart.
  Their standing makers quote only those cash instruments. They do not populate routed spot/perp
  strategy books or create positions at external venues.
- The dedicated Hyperliquid pool completed observed deposits, a two-owner netted BTC epoch,
  an open-position service restart, close and all withdrawals. Final cash, liabilities and venue
  positions were zero. It remains restricted to dedicated test accounts. The signed owner API is
  deployed; balance reads have been verified separately for both traders and the sponsor.
  Its Portfolio controls are included in the static frontend deployed on 2026-10-18 after the
  hosting block cleared. Browser navigation passed; no additional pool funding or trading was
  performed as part of the frontend deployment.
  Re-funding requires separate approval; a healthy empty service is not funded liquidity.
- Arbitrum: GMX execution depends on GMX's testnet keepers (they executed 122 of 143 orders in the
  week to 2026-10-02). The GMX fee and gas keys the solver reads return live values. A request GMX
  cancels, or one still pending after its venue deadline, is recovered by the solver through the
  coordinator's bonded recovery (the spot leg is sold back to the owner and the package closes);
  the API sweep drives it even when the owner has left the page. A request still pending when its
  recovery deadline passes goes to manual intervention, which has no on-chain path out while GMX
  still holds the order; keep the solver and API running.
- Arbitrum entry pricing: entries and exits are priced at GMX's own Reader execution price for the
  exact size, so the quoted spread includes GMX's price impact. On 2026-10-03 the GMX ETH/USD testnet
  market was about 29:1 short-heavy and a new short paid about 15% negative price impact, so entries
  are declined before signing: the spread exceeds any usual `maxEntrySpread`, and the impact, which
  GMX V2.2 charges when the short closes, exceeds a 15% margin. A short whose collateral after fees
  is under GMX's `MIN_COLLATERAL_USD` (1 USD, for example 0.001 WETH at 15% margin) is declined too.
  Of a close's negative impact GMX pays out at most `MAX_POSITION_IMPACT_FACTOR` (0.5%) and keeps
  the rest as claimable collateral for the account; the Naryx account has no path to claim it, so
  the quotes count it as a cost. The open-interest multiplier on GMX's minimum collateral factor is
  not modeled (about 0.001% on testnet).
- Arbitrum exits are asynchronous. A cancelled close leaves the position open until a verified
  retry or recovery finishes. Do not classify a submission or an API acknowledgement as a fill.
  Keep callback, fee and price-impact bounds tied to the exact registered deployment.
- Hyperliquid: an uncertain outcome fences the affected account until authoritative evidence
  resolves it. Never release an account merely because a local deadline passed. A spot buy's fee is
  paid in the base token, so each package leaves sub-lot base dust in the account; size the
  terminal base residual cap to at least the largest base fee plus one spot lot.
- Seeded Uniswap pools drift from the oracle as people trade; nothing re-centres them yet. Orders
  are bounded by the pinned Uniswap quoter's executable price for their size, so drift costs price,
  not failed transactions, and a size the pool cannot fill is refused before signing.
- The public v1 market API (package order book, tape, solver metrics, strategy receipts, RFQ and
  sealed auctions) runs on its own listener (8790) when a release enables it; the Hyperliquid
  release does. nginx forwards `/v1/` to it, and the web needs `NARYX_WEB_PUBLIC_API_BASE_URL` set to
  the API's HTTPS origin or those panels show as not configured. Quote-based trading does not need it.
- The optional threshold-opening backend is deployed using pinned drand quicknet identity and
  verified public beacons. Openings become public after the release round; threshold collusion
  can disclose them early. The backend accepts at most eight pending openings globally and two
  per solver. The deployed solver participants now encrypt compatible Unix-clock auctions when
  the release window leaves more than 60 seconds for verified opening. Their exact ciphertext
  is journaled before submission and reused after restart, never replaced by a plaintext reveal.
  An isolated AWS check observed a sealed opening release at quicknet round 33163252; this was
  cryptographic release evidence, not a trade or public-market record. The terminal still creates
  short ordinary commit/reveal auctions. This is not a claim that all auctions are encrypted.
- The API now reads the keeper's configured incident-status endpoint. Its missing Solana
  qualification journal is reported as unavailable, not synthesized as healthy. A code watchlist
  alone is not a qualified incident journal.
- Cross-domain EVM submissions now journal signed bytes before broadcast, reserve bounded gas
  before signing and reconcile the exact finalized transaction after restart. This closes the
  duplicate-send gap, but does not activate the multi-domain coordinator. Its current compensation
  lane releases expired inventory reservations, not already-executed external positions.
  Venue-confirmed novation remains unavailable without its evidence verifier. These capabilities
  need their own activation evidence, not a general service-health assertion.

## Not available yet

- Solana Devnet public Orca exits. Current exits use the solver's firm buy-back
  (`execute_firm_cash_and_carry` with action `EXIT`). The public Orca route stays fail-closed until
  a Devnet Orca spot venue, market, and adapter are registered.
