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
pool is a separate custodial mode, not a substitute for owning a venue account. Version 3 supports
public enrollment with explicit signed custody consent, owner-scoped funding operations, and
submission of fully signed pooled epoch plans. Admission limits are 100,000 mock USDC total
and 1,000 per wallet, bound into fresh custody consent. These limits do not supply liquidity
or raise leverage and execution-policy budgets. The terminal displays current deposit room;
settlement profits above the admission caps remain withdrawable.
Pooled epochs need at least two funded traders and a separately consenting recovery sponsor.

Cross-chain calendar setup now resolves each wallet's accounts from the deployed Base and
Arbitrum factories. The terminal guides account creation, adapter creation and funding, then
obtains separate entry and recovery approvals. Registered factory checks, exact recovery,
finality and lifetime worker gas budgets remain enforced. This is not cross-chain atomicity.

The October 18 public-access release was initially compiled and deployed without running tests at
the owner's request. Subsequently authorized verification completed the public version-3 pooled
browser cycle recorded below. Service availability alone is not execution evidence; earlier
execution records remain historical and are not attributed to this release.

## 9. Public copy

Replace the landing page's "Pre-mainnet: public deployment deferred" status only after step 8
passes on every lane being announced.

## Fixed testnet completion scope

The six outstanding items below are the completion scope established on 2026-10-17.
Changes and verification belong to these items; the broader roadmap does not add new launch
requirements. Process health, implemented classes and isolated checks are not end-to-end activation.

Status checked 2026-10-19:

| Item | Current state | Evidence needed to close |
| --- | --- | --- |
| 1. Standing liquidity for routed strategies | Closed for the enabled Solana cash-and-carry maker lane. Actual entry/exit and inventory reconciliation completed on 2026-10-18. | Evidence below. This does not advertise native cash liquidity as routed liquidity or activate additional routed maker lanes. |
| 2. Cross-chain execution activation | Recovery contracts, replacement reservation books and executor profile 5 are active. Public wallet onboarding derives accounts and adapters from verified factories. Fresh website entries finalized on both chains. The clock-order defect is fixed on AWS and the existing job has a separately recorded receipt-bound resolution. Both owner-signed closes succeeded. | Entry and exit receipts are recorded below. Finalized browser closure reconciliation remains pending. Existing operator evidence does not replace this public-flow check. |
| 3. Hyperliquid pooled-mode terminal integration | Closed for the public version-3 application/provider flow. Three dedicated wallets enrolled under fresh custody consent, reconciled 12 mock USDC, submitted an epoch signed by both traders and the recovery sponsor, and withdrew every remaining balance through Portfolio. Admission limits remain 100,000 mock USDC aggregate and 1,000 per wallet. | The public-release browser cycle below opened and closed an actual net BTC position. All seven ledger operations completed; final venue backing, member balances, orders and positions were zero. A restricted test-wallet provider supplied real signatures; this does not establish compatibility with every wallet extension. |
| 4. Strategy ownership transfers | Closed for the Base cash-and-carry account path. The seller proposed and the buyer accepted through live Portfolio, acceptance finalized, dual-signed strategy-book novation succeeded, and the new owner's exit finalized. Book closure and collateral withdrawals reconciled with an empty strategy account. | Evidence below. This does not claim transferable positions on other venues or compatibility with every wallet extension. |
| 5. Threshold-encryption backend | Backend and solver participation deployed; a real beacon opening was verified. | Preserve this completed backend evidence. Any claim of terminal-integrated encrypted trading also needs an encrypted auction award and settlement; current terminal auctions remain ordinary commit/reveal. |
| 6. Operational wiring and documentation | Closed for the explicitly owner-approved Solana devnet cash-and-carry scope. All seven deployed program identities, hashes, authorities and slots match; finalized funded-cycle evidence was checked. The signed testnet-only policy is active and the API reports ready. | This is not independent review. The approval expires on 2026-10-25 at 10:32:15 UTC; continued activation needs a renewed explicit approval. The unchanged independent-review policy remains required for any claim of independent qualification. |

Independent maker recruitment and additional roadmap capabilities are not new items in this
completion scope. Report their limitations separately without reopening completed work.

The subsequent verification request on 2026-10-18 authorizes the two outstanding public-release
flows: calendar entry/exit and the shared Hyperliquid pool cycle. It does not reopen unrelated
suites or authorize mainnet. Existing evidence remains valid for its exact code version; unexecuted
flows remain unverified, and runtime safety gates remain enforced.

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
not authenticated transaction verification. Routed depth was empty. The intermittent Arbitrum
native cash standing-book refusal was traced to a fresh oracle price arriving before the clearing
mark updater. Fix `5888323c` now waits within a bounded deadline after all qualification checks,
without serving stale quotes or weakening contract guards. Both native cash books returned HTTP
200 with funded five-unit bid and ask quotes after the AWS deployment. This fixes that availability
defect, not the missing routed-strategy liquidity in item 1.
All nine checked Naryx AWS services were active, but health remained degraded because one configured
Solana incident scope had no qualification journal. These findings do not close the action matrix.

## Verified testnet scope and remaining limitations

Updated 2026-10-18. The root README and versioned release records identify the live paths.
First-route cash-and-carry execution has testnet evidence on all four domains. Additional
strategy support is specific to a registered template and deployment, not every catalogue entry.

- Solana routed cash-and-carry maker capacity now reads finalized maker token balances and
  clips both published and signed sizes to inventory, venue lot increments and minimum notional.
  Before the fix the ask could advertise 10 SOL against 0.45 SOL in inventory. The live ask now
  advertises 450 units of 0.001 SOL. An actual 0.02 SOL entry consumed 20 units; the exit restored
  the maker's base inventory and the advertised 450-unit capacity. Both transactions finalized
  and were observed through the API, leaving the trader with zero position lots and no open package.
  Each trader transaction cost 5,000 Devnet lamports. Maker rent funding was 0.05 Devnet SOL.
  Entry signature: `6585Fnf5BPMfttvmfircSX27YU5xygLmwv8RpE5fybG3R3fAYEHsg89MWTigXfKmjHVtYY1ikAjZXZc7NcuywTfN`.
  Exit signature: `4rcwiD3g856MY9ax5PyADb4ig77TYY1mmA2fd3CSJ8RXuSGxgy9SGqCKFXhfCjgt8jfxbJ8UDPr6ApVJkxcEMGXN`.
  API lifecycle records are FINALIZED; the final account read has zero lots and no package.
  A read-only browser check on `naryx.xyz/liquidity` confirmed the funded capacity and reference-price
  distinction with no browser exceptions. The price displayed in this card is a shard reference,
  not an executable net strategy price; a complete quote reserves inventory during preparation.
  This verifies the actual public API/signing/settlement path and the browser read surface, not
  a wallet-extension click-through trade. Commits `4de5fc67` and `85e3fea6` are deployed to AWS;
  `9e5d31da` is promoted as a static-only frontend. The exit retry fix preserves the first priced
  order across oracle changes, races and restart; pre-fix request identities are not rewritten.

- Base and Arbitrum native cash-range markets have funded browser entry/exit, withdrawal and
  finalized receipt evidence, including server reconciliation after browser closure and restart.
  Their standing makers quote only those cash instruments. They do not populate routed spot/perp
  strategy books or create positions at external venues.
- The earlier dedicated-only Hyperliquid pool release completed observed deposits, a two-owner netted BTC epoch,
  an open-position service restart, close and all withdrawals. Final cash, liabilities and venue
  positions were zero. That release was restricted to dedicated test accounts. The signed owner API is
  deployed; balance reads have been verified separately for both traders and the sponsor.
  Its Portfolio controls are included in the static frontend deployed on 2026-10-18 after the
  hosting block cleared. Following separate funding approval, both dedicated traders completed
  sequential 2 mock-USDC deposit/withdrawal cycles through `naryx.xyz/portfolio`. Wallet-signed
  account reads, deposit crediting, withdrawal authorization, submission and receipt reconciliation
  all returned HTTP 200, with no uncaught browser errors. Each reload preserved zero owner balance;
  the final venue and database both held zero pool cash, liabilities and pending operations. No
  trades were submitted in this browser cycle. Transfer signing remained outside the browser;
  the browser used a restricted test-wallet provider with real owner signatures, not a wallet
  extension. This proves the application/provider flow, not compatibility with every wallet UI.
  A separate rejected-signature check sent no execute request and displayed no account balance;
  a subsequent accepted signature recovered the normal account view without a page reload.
  Re-funding requires separate approval; a healthy empty service is not funded liquidity.

  | Dedicated owner | Deposit receipt | Withdrawal receipt |
  | --- | --- | --- |
  | `0x68306408c1cf9baf22e2f3c6d79e87d496e63f8f` | `0x5216d6896cd5c56e5390042bfb533c010100ee6f07d8e440f5df81dc2bd99f58` | `0x1682d440fe7401fd17fc042bfb5851010200ec26997720cfba4b7f93bd77dbe7` |
  | `0x4bd0926b35b9df531d79ed480f47b8a425f498a8` | `0x845e27b8c2ce920f85d7042bfb5c870101003f9e5dc1b0e12826d30b81c26bfa` | `0x091e6cade9914ae90a98042bfb60280111008493849469bbace71800a89524d3` |

  Each deposit and withdrawal was 2 mock USDC with no transfer fee. The pool never exceeded
  2 mock USDC during this cycle. Source wallets ended at 6 and 6.990344 mock USDC respectively.
  Durable operation journals use the `browser-cycle-20261018-owner-1` and
  `browser-cycle-20261018-owner-2` prefixes under the existing pool operator journal directory.
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
- Seeded Uniswap pools drift from the oracle as people trade; nothing re-centres them yet. Quotes
  enforce both executable pool liquidity and the signed maximum spot/perp spread before signing.
  Pool drift can therefore refuse an otherwise liquid entry. The ownership-transfer preparation
  was refused at 5,215 quote atoms of spread against its 5,000-atom limit; no trade was signed.
  Do not relax the global spread guard merely to produce a successful verification receipt.
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
- The API reads the keeper's configured incident-status endpoint. On 2026-10-18 the owner
  explicitly approved a separate Solana devnet policy, labelled `OWNER_APPROVED_TESTNET` and
  not independently reviewed. Its signed release binds all seven deployed programs, upgrade
  authority, deployment slots, the exact unchanged execution-cap file, and the owner-attested
  reconciled funded cycle. Read-only checks confirmed the code and finalized invocations before
  activation. The keeper now refreshes five-minute evidence and quarantines on failed checks;
  it cannot silently restore a quarantined scope or extend the owner's seven-day approval.
  The public API reports ready, with no unavailable incident scopes. This does not independently
  audit the release, qualify other templates, or authorize mainnet.

  Approval commitment: `0xefbaf98857fa0a874fc491d67005fe23f70257747cbfcba8e3e9a7dc48a43826`.
  Release commitment: `0x14afd670d169d3283a96ede00c2c603f3d862cf89c52fa95284aa6d2f14d6728`.
  Execution-cap SHA-256: `bd8aa2ebe01254ea4def9146d18e6ecccddd18ce056db346ceb344c072c8faa8`.
  Approval expires at `2026-10-25T10:32:15.937Z`.
  Static frontend deployment `dpl_CHJZ6ZHiDG3Cx3yDPRyb1AcdhEpL` displays the policy explicitly
  on Network; the build lists every page as static. No request-time frontend compute was added.
- Cross-domain EVM submissions now journal signed bytes before broadcast, reserve bounded gas
  before signing and reconcile the exact finalized transaction after restart. Full reversal
  requires exact spot quantities or a derivative close bound to its entry generation and payload,
  bounded collateral loss, zero remaining derivative position and reserve, and finalized receipts.
  On 2026-10-18 separate registry/account factories, recoverable perpetual and dated-future
  adapters, spot adapters, reservation books, and delayed fee/risk registrations were deployed
  and activated on Base and Arbitrum Sepolia. Domain manifest version 3 binds these new account
  deployments; existing accounts and signed version-2 manifests are unchanged. Sixteen deployed
  code hashes per chain matched before configuration was installed. Each dedicated solver received
  0.0003 test ETH, with a worker gas budget of 0.00025 test ETH per chain.
  Risk policy version 2 corrects the initial generic dependency into all five exact adapter
  subject IDs on each chain. Both upgrades passed delayed governance before any job was admitted;
  the configuration exporter now checks every dependency cap against the deployed registry.
  The AWS cross-domain worker is enabled and running with a separate durable job database,
  allowlisted owner/accounts, and a 10 mock-USDC entry cap per chain. This is an operator-admitted
  recovery cohort using controlled test derivative venues, not activation of every website strategy
  or a claim of atomic cross-chain settlement. A subsequently admitted capped recovery job funded
  each strategy account with 3 mock USDC. Arbitrum entered successfully; Base intentionally failed
  its signed notional guard; Arbitrum's compensating close succeeded. Both unused-reservation
  refunds finalized, both domains reached `COMPENSATED`, and the durable job reached `TERMINAL`
  with outcome `RECOVERED_FLAT`, no error and zero remaining account locks. Arbitrum collateral
  decreased by 402 quote atoms (0.000402 mock USDC), within its 100,000-atom signed recovery cap;
  Base's 3 mock USDC collateral was unchanged. No second funded cycle was started.
  Submission-journal reconciliation now runs at startup and before job closure, so finalized
  reservation refunds do not remain labelled pending after the coordination has completed.
  Multi-domain wallet entry/recovery authorization is now deployed as described below.
  Canonical calendar materialization is deployed in the later release recorded below.

  | Recovery cycle action | Testnet transaction |
  | --- | --- |
  | Arbitrum entry | `0x2054146323dd1bb82eeb803a309b211f50ea63789c4dce143faa478f94a70e04` |
  | Base bounded entry revert | `0x802615767fcfb58b02c9a8b6a458d8d7caa892c166df4c64edd6a74cfef4bbe3` |
  | Arbitrum exact compensating close | `0x0f32d6bcca7a0998eedb9f217fac30d5801136dca6502acf2bab2975e4a55577` |
  | Base reservation refund | `0x1062a18a39ddbfb2b4790c6961c1d29d64f0e388dbbfd79ba378d9eaaa6c0766` |
  | Arbitrum reservation refund | `0xc8e141b04dd4069ffe9ed81ac7b27759a2df8e5f0254f3160af7cc819e7e989a` |

  Coordination plan: `4437ad97cee7bf2aceee05c0d4104e8886b4131c853ac508bda4ce05c74ae347`.
- Base strategy-account transfer verification now checks both wallet consents, the exact account,
  its finalized ownership transition and receipt-backed strategy lifecycle. The Portfolio UI
  proposes and accepts transfers through the owners' wallets; it does not transfer an account by
  changing a database owner. This is scoped Base support, not generic novation of every venue.
  After correcting quote lot sizing and bringing the controlled spot pool back within the signed
  spread bound, the funded transfer completed on 2026-10-18. Both onchain transfer actions used the
  live Portfolio with a restricted test-wallet provider and real signatures, not simulated receipts.
  Finalized acceptance preceded the two-owner signed `NOVATE` command. The new owner exited through
  the public execution API; its finalized receipt closed the strategy book. Withdrawals left no
  open package and zero base, quote, reserve and required margin in the strategy account. The buyer
  wallet balance was 4.977596 mock USDC after withdrawal. The confirmation-read retry fix is
  deployed to the static frontend.

  | Ownership cycle action | Base Sepolia transaction |
  | --- | --- |
  | Funded entry | `0x7ac91defa85628543b8a4e2164bd3cae60dd1d63cd9c01ad6889e450c643e1c9` |
  | Seller proposal | `0x553e260765204adb682d528f8cc7ddc41b2be6d1abdc7f87fa8ddcbbe4c5a248` |
  | Buyer acceptance | `0xe6a7ebcd59ff6f0f99e4c4ca02bbed085e3d1fe0201c8fb726c6d34bc78dbaa8` |
  | New-owner exit | `0xcac567f33333f7dbc712e3e9324f4154c7fb890a9ce3609d6a7d53b4540d7da6` |
  | First collateral withdrawal | `0x3aa9a0a1435240ef4ed2cc32e602268fbbc4f641312ad66590611d35cb7dc7df` |
  | Remaining collateral withdrawal | `0xb2965c6e14bf23a5901786291aae49396c2af3851d4b7ea91022e9e4266622dd` |

  Account: `0x04F5d46111a7D57374D2DD501Be5Ca0Bb19f3319`.
  The closed strategy record is
  `strategy-dccee7f18509e003b3cf68665c85cdace2ad404bedcb3fab5a68da970f03119a`.

## Cross-chain wallet approval release

Commits `3f63106f` and `50033809` add durable wallet approval and its Network panel.
The AWS API and cross-domain worker were updated without changing contract identities,
owner/account allowlists, funding limits or the other services. The worker has
`NARYX_CROSS_DOMAIN_WALLET_ENABLED=true`; the API forwards only draft reads and signature
submission to its fixed loopback origin. Operators alone can stage unsigned preparations.

Each owner approves entry and bounded recovery separately for Base Sepolia and Arbitrum
Sepolia. All four owner signatures are verified before solver authorization. Approved
preparations persist through restart, await the exact funded reservations, and enter the
existing durable worker. Expired unused reservations remain pending until release is confirmed.
There is no new funding or allowance path, unrestricted solver signing, or mainnet operation.

Static deployment `dpl_EKoSsjcHZkvu9fpcuDJ8GvNA58NE` is promoted to `naryx.xyz`.
The build lists static pages only, with no request-time frontend functions. A read-only browser
check on Network returned HTTP 200, no uncaught page errors, no horizontal overflow at 1440px,
and the expected not-found message for an unknown preparation. API checks returned 404 for
an unknown draft, 409 for malformed authorization, and 404 for public draft creation.
The worker reports wallet approval available; both restarted services have zero automatic
restarts. Public health is ready across the four configured runtimes, and Solana qualification
remains explicitly owner-approved testnet evidence.

Validation: 24 focused solver/recovery checks and one API proxy check passed, along with
API/solver builds, web typecheck and the two affected components' lint checks. No new funded
trade ran. The previous operator job remains terminal, and the new wallet database has no
staged preparations. These checks prove deployment and rejection behavior, not a successful
browser-signed cross-chain execution.

That release left canonical order preparation against the separately registered per-chain
templates open. The following release implements that same item 2; it does not add launch scope.

## Canonical calendar activation, 2026-10-18

Commits `1ebb0bdc`, `6d1ebd1e` and `7a556b74` implement and deploy the bounded public calendar
path. The owner signs a preparation request in Network, reviews the exact package, signs entry
and recovery on each testnet, then submits all four approvals. Only then may the worker reserve
existing solver inventory and admit execution. The canonical graph, order, signed quote and route
commitments bind both exact local registrations without replacing either local template identity.
The dedicated compiler enforces this mapping; the contracts enforce their own local execution,
authorization, accounting and postconditions. This is not arbitrary cross-chain compilation.

The enabled market buys the near future on Base Sepolia and sells the far future on Arbitrum
Sepolia, using 0.0001 test base units, 1 mock USDC collateral per chain and a maximum signed
recovery loss of 0.10 mock USDC per chain. The owner remains the existing funded test cohort,
not arbitrary public account enrollment. It uses controlled derivative venues, no bridge and
no mainnet assets. Cross-chain execution is coordinated, not atomic.

After a job is terminal, the owner can request a fresh close authorization for either chain.
The close retains the original minimum collateral return, accepts profitable returns, and checks
account identity, package state, nonce and ownership. The wallet submits the transaction; the
service records closure only after matching finalized package state and a receipt for that order.
The browser preserves a pending close transaction identifier and reconciles it before retrying.

The user explicitly approved increasing each dedicated worker's lifetime gas allowance from
250,000,000,000,000 to 500,000,000,000,000 wei (0.0005 test ETH). The migration preserved every
submission, nonce and reserved-budget entry, kept both historical journals, and transferred no
funds. The existing overall 0.01 test ETH per-network ceiling is unchanged.

| Testnet | Preserved reserved budget (wei) | Remaining approved budget (wei) | Observed worker balance (wei) |
| --- | ---: | ---: | ---: |
| Base Sepolia | 107500000000000 | 392500000000000 | 278524189998363 |
| Arbitrum Sepolia | 207500000000000 | 292500000000000 | 239132944678000 |

A preparation requires 231250000000000 wei of remaining allowance per chain for entry, recovery
and inventory operations. Both observed balances also covered that bound. The UI exposes a pause
when the allowance is insufficient rather than advertising a new executable preparation.
Observed finalized-head lag was 1,072 seconds on Base and 1,020 seconds on Arbitrum. The earlier
15-minute preparation window was too short for serialized inventory finality. The corrected
windows are three hours for preparation, four for commitment and eight for compensation, all
before the near contract's maturity. Finality, price bounds and recovery-loss limits were not
weakened. Testnet preparation can therefore take over an hour; this is not instant settlement.

AWS uses immutable executor manifest version 3, hash
`0x9c4c7621f152f2443f0d7e9cb11f47c0f80134962a7e9821c524d635158a4327`.
All six recorded module hashes match the deployed files. The earlier executor manifests remain
preserved. The API and cross-domain worker are active with zero automatic restarts. Public
`/internal/healthz` reports ready across all four configured runtimes, and the public calendar
market reports execution budget available. No signed preparations, pending jobs or new trades
were created by these deployment checks.

Static frontend deployment `dpl_HdUrsFhpqish8KZdaNvdQPuY6vco` is promoted to `naryx.xyz`.
The build contains static pages only, not request-time Vercel Functions. A real browser read of
Network displayed the calendar controls, no allowance-pause warning, no uncaught page errors
and no horizontal overflow at 1440px.

Validation: solver/API builds, 11 focused solver checks, one API proxy check, web typecheck and
the changed component's lint passed. After the timing correction, the two canonical-builder
checks passed again, including the maturity boundary. Read-only preparation against actual
registrations returned `preparationReady: true`, `executionBudgetAvailable: true`,
`staged: false`, `broadcast: false`. These checks do not claim a fresh funded browser round trip.
No contract redeployment or mainnet operation occurred in this release.

## Calendar reservation compatibility correction, 2026-10-18

The browser-signed attempt exposed a missing dependency check in the earlier activation:
the original reservation books enforce an immutable 3,600-second maximum TTL, while the
calendar requires a 14,640-second reservation window. Read-only entry simulation did not
exercise inventory reservation and therefore did not detect this mismatch.

The worker was stopped after a bounded Base inventory approval, before any reservation or
new derivative entry. The approval transaction is
`0x660f5160e22faf85d443a29fd07f2d831cdd6ac0131feecf898f028b17ddb15a`.
Both strategy accounts were flat and both original books had no live reservation. The signed
draft `039cbf8e6d7e9ec7d5b21cebe25e7daa247826d8935160b71bacd688a4e43910`
and its authorizations are retained as historical evidence, not reinterpreted under a new book.

Commits `9724f86b` and `03544c8d` add replacement book deployment and reject incompatible
TTL or inventory capacity before issuing a calendar quote. Book address, code hash and observed
capacity now contribute to the canonical package commitment. Existing tokens, accounts, limits,
registrations and historical books remain unchanged. No Solidity source changed.

| Testnet | Calendar reservation book | Deployment transaction |
| --- | --- | --- |
| Base Sepolia | `0xdbda14397ce04bde022e647c471b11267e181de3` | `0x70b8647d2f91aa978f591984de798dfa2f0e3cdfcf68e11bc154c1eb862e0341` |
| Arbitrum Sepolia | `0x1a318898123969abe0cef8889be8cc65e8347574` | `0x785d029a9f39e8843666c1b919fb116aaa8ef99b9fdb902ff0bb8adac1d9a674` |

Both replacements retain the original token identities and inventory caps and allow a maximum
TTL of 21,600 seconds. Deployment gas was 15,616,092,000,094 wei on Base and
52,105,693,640,000 wei on Arbitrum, inside the existing recovery-deployment ceiling. No additional
mock USDC was allocated. Worker journals retain their existing cumulative spending and the
approved 500,000,000,000,000-wei lifetime ceiling per network.

At 17:00 UTC both replacement runtime hashes were finalized. The original approval transaction
was reconciled as successful, both old books had zero live reservations, both accounts were flat,
and no active execution job or account lock existed. The draft moved through `RELEASING` to
`EXPIRED` without another transaction. Its signed documents remain unchanged. The private
incident record and wallet-database backup are retained on AWS.

Executor manifest version 4 is active with hash
`0xe2f8be359ebb1a821313aa6240af45e872027f4d8a8b5be742ce3734aacb29a1`.
The earlier profiles and configuration are preserved. Both deployed solver modules match the
local build hashes. The cross-domain worker, API, solver and keeper are active with zero automatic
restarts. The public calendar endpoint returns HTTP 200 and available execution budget; the
historical draft endpoint returns `EXPIRED` with no admitted job. No unrelated service changed.

Validation: solver build and the two focused canonical-calendar checks passed, including
one-hour-book rejection, insufficient-capacity rejection and the exact supported TTL boundary.
The activated runtime's chain-backed inspection returns `preparationReady: true`,
`executionBudgetAvailable: true`, `staged: false`, `broadcast: false`. This does not claim a
completed calendar trade, and no further funded cycle was started during this deployment fix.

## Public version-3 pooled browser cycle, 2026-10-18

The live Portfolio page exercised fresh version-3 enrollment, authenticated balance reads,
deposit reconciliation, signed epoch submission, withdrawal authorization and receipt
reconciliation using three dedicated test wallets. The public release had no cohort allowlist;
the wallets used for this check were existing dedicated test identities, not newly created wallets.
Transfers used the official testnet venue transport. Browser controls used a restricted EIP-1193
provider backed by real signatures; compatibility with a particular wallet extension is not claimed.

Traders deposited 5 mock USDC each and the recovery sponsor deposited 2, reusing approved funds.
Epoch `public-v3-browser-epoch` carried all three participant signatures. The venue opened an actual
net position of 0.00013 BTC at 81,068, then the worker closed it and reconciled the ledger. The final
allocated balances were 4.996295, 4.997989 and 2 mock USDC, totaling the observed venue backing of
11.994284. The 0.005716 reduction reflects the cycle's realized trading result and fees, not a
missing withdrawal. All balances were then withdrawn through Portfolio.

| Participant | Deposit receipt | Withdrawal receipt | Withdrawn mock USDC |
| --- | --- | --- | --- |
| Trader 1 | `0xb407f0f44ad48a3db581042c059cf3010e0008d9e5d7a90f57d09c4709d86428` | `0xa9787433ebd6c66aaaf2042c05b4df0102008c1986d9e53c4d411f86aadaa055` | 4.996295 |
| Trader 2 | `0x993bb629336a95739ab5042c05a13f010300ce0ece6db4453d04617bf26e6f5e` | `0x4407fe29ab3455f64581042c05b9b2010900160f463774c8e7d0a97c6a382fe0` | 4.997989 |
| Recovery sponsor | `0x880dde5d58228bb98987042c05a595010100f642f325aa8b2bd689b0172665a4` | `0x8455efd24806c93f85cf042c05be7800009107b7e309e811281e9b25070aa32a` | 2 |

All seven ledger operations completed. Final read-only reconciliation showed zero member balances,
zero venue account value and withdrawable cash, no open positions, no open orders and no pending
operations. Browser execution reported no uncaught page errors. Entry and exit request, dispatch,
proof and result stages remain in the durable operation journal. No mainnet assets were involved.
An authenticated member read returned HTTP 200. Reusing that signature with another owner or
a different action returned HTTP 409; neither request authorized access or a ledger operation.
This verifies this public-release pooled flow, not every strategy template or wallet extension.

## Public calendar browser cycle, 2026-10-19

The live Network page submitted a fresh calendar package using an existing dedicated owner's
factory-registered accounts. A restricted EIP-1193 provider supplied real wallet signatures.
This checks the website flow, not every wallet extension or fresh-wallet account creation.
Each domain committed 1 mock USDC against a 0.0001-unit futures leg under the previously
approved spending limits. No mainnet transaction was signed or sent.

Plan: `efc97c9d90c443932bd8e7cc221ce10fee7f2c24820adfebedee6d468b80f859`.

| Domain | Finalized entry | Expired inventory release |
| --- | --- | --- |
| Base Sepolia | `0x53cc45880026ee23680e508e523191843d69e2d12820722d0c9156b03170ee7b` | `0x78c7c0123670837ede97c2b12a177423aed9685d4b919c2d6ae5625d800fbf93` |
| Arbitrum Sepolia | `0x967579ee607bf6329d8318f6c9a3ed0671a253423f3a173b69fc038ad179639d` | `0x72f5d3e3e9d1945087c1af13a3e64dbdaeea21e00d20a80c1827a40b92138227` |

Both entries succeeded, but Base's finalized observation time was 19 seconds behind the
Arbitrum observation already in the append-only coordination journal. The kernel correctly
fenced the backward event. Fix `0f7e238a` defers lagging observations without replacing their
timestamps. The original events, authorizations, executor profile 5 and its hashed modules
remain unchanged. The journal history hash is
`61ab5d1209521aab88c07b6291f32f2d10da822c5e697a2f5d6479f1b05eef41`.

The operator reconciliation independently verifies both finalized transaction receipts,
the exact active package states, account ownership and deployment identities. It releases
unused expired inventory through the original submission journals and gas caps. Only after
finalized release may it append an immutable resolution and clear the job's account locks.
This does not rewrite the original fenced replay or qualify other failures for automatic recovery.
Both expired reservations finalized and the receipt-bound resolution was recorded separately
from the original journal. The website then submitted both owner-signed closes without browser
exceptions. Base close: `0x133a4c68368fe169792aef405b8199c4922c2f7f5530862b45b32c997290033f`.
Arbitrum close: `0xd8684c308ea0f813b3899a305a82c66b95af72b32a04bd25f0f517fbdbb7e821`.
Both close transactions were included successfully. Arbitrum finalized and the live browser
reported `Confirmed flat` with no page errors. Base remains pending finality: at 04:02:43 UTC,
its configured RPC still reported a finalized head older than the close, although the safe
head had passed it. An earlier public RPC check reported the same finalized head.
The browser reports the pending distinction and
retains that transaction hash. Reconciliation was run with transaction sending disabled.
The coordinator job is `TERMINAL`, its last error is null and it has zero account locks.
Closing deletes the contract's active package record, including its last-receipt pointer;
the API therefore records `FLAT` rather than inventing a receipt hash from that cleared state.
Transaction logs and the contract's separate receipt mapping remain the close evidence.

The owner separately approved raising both dedicated workers' lifetime allowances from
0.0005 to 0.002 test ETH. The stopped-worker migration backed up both SQLite journals,
preserved every submission and its hash, and changed only the approved cap plus its runtime
binding. Reserved expenditure remains 241250000000000 wei on Base and 338750000000000 wei
on Arbitrum. The API again reports sufficient allowance for a complete entry/recovery cycle.
This migration transferred no funds and did not change the overall 0.01 test ETH per-network
ceiling. The owner then separately approved transferring exactly 0.0005 test ETH to each
worker from the existing deployer. Both transfers succeeded after chain-ID, recipient,
nonce, value and bounded-gas verification. Signing used the existing encrypted keystore;
private keys were not extracted or moved to AWS. A durable local transaction record prevents
duplicate top-ups on retry.

| Domain | Worker | Top-up receipt | Balance at top-up block, test ETH |
| --- | --- | --- | --- |
| Base Sepolia | `0x4391c17B94175F2Ef7f535D81D516BF8B0596F2b` | `0x8d477c721c267144ff86526c047d43840e2af6ff42c19b74e12fdec9c72fb662` | 0.000728277764995516 |
| Arbitrum Sepolia | `0x3072B1Cda657730E0933cCc8c15Ed61F2D9A928F` | `0xcf327aac3fb25c4be9cc858059506f616af6dcda982de21c6579dab124112f62` | 0.000689939469678 |

Both worker balances exceed the conservative 231250000000000-wei full-cycle reserve.
The overall per-network budget and historical expenditure were not reset. The live API
reports all four testnet runtimes ready; this process-health result is separate from
the finalized browser closure evidence.

Validation: the 32 focused clock, execution-driver and durable-worker checks passed. The full
solver suite passed 382 of 385 checks; three older pool assertions expected superseded error
messages. Commit `ce009de7` aligned those expectations, and all six checks in the two affected
pool test files then passed. No production behavior or financial guard was relaxed for those tests.

## Recovery deployment identities

The separate recovery account factories are `0x210757cdcace99077fa81157e6224c2899cc4698`
on Base Sepolia and `0x12f45b20600d4d7ac7f82a6ccf63188d013c7814` on Arbitrum Sepolia.
Their reservation books are `0x8c3e369aaad5b377eacdbbeccb6a292cf05a8bca` and
`0xe6fb9393541a462702d5b3e5a7b3fc63a5cdef17`, respectively. Detailed transaction observations
are installed on AWS at `/srv/naryx/release/recovery/activation-observations.json`.
The completed operator-cycle receipts and terminal reconciliation are saved at
`/srv/naryx/release/recovery/completed-cycle-20261018.json`.

## Not available yet

- Solana Devnet public Orca exits. Current exits use the solver's firm buy-back
  (`execute_firm_cash_and_carry` with action `EXIT`). The public Orca route stays fail-closed until
  a Devnet Orca spot venue, market, and adapter are registered.
