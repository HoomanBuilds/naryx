<p align="center"><img src="apps/web/src/app/icon.svg" alt="Naryx" width="72" /></p>

<h1 align="center">Naryx</h1>

<p align="center"><strong>The Complex Order Network. Trade the strategy, not the legs.</strong></p>

<p align="center">
  <a href="https://naryx.xyz">Website</a> |
  <a href="https://naryx.xyz/trade">Trading terminal</a> |
  <a href="apps/web/README.md">Web guide</a> |
  <a href="contracts/README.md">Contracts</a> |
  <a href="packages/sdk/README.md">TypeScript SDK</a>
</p>

Naryx is an open execution network for complete onchain financial strategies. A trader describes one typed package, receives one signed package quote, authorizes one bounded outcome, and follows one lifecycle through execution, recovery, exit, and receipt verification. The first fully evidenced route is cash-and-carry: acquire spot and short the matching perpetual as one economic order.

The missing primitive is simple: onchain venues expose individual orders, but not an open protocol that can price, authorize, execute, recover, and verify a complete multi-leg strategy as one bounded object.

Naryx does not pretend independent chains are atomic. It assigns every route an explicit settlement class:

- `ATOMIC_POSTCONDITION` for legs sharing one rollback boundary;
- `ASYNC_BONDED_SOLVER` for delayed venues with bonded completion and rollback obligations;
- `BATCHED_IOC_WITH_RECOVERY` for HyperCore batches with signed residual and recovery limits.

**Current scope:** Naryx is a testnet product. The deployed routes use test assets and controlled test liquidity. A deployed program, enabled template, or populated trading screen does not establish organic volume, external market makers, or production readiness. Mainnet writes are prohibited by this repository's policy.

## Contents

- [How a package trade works](#how-a-package-trade-works)
- [Flagship mechanism](#flagship-mechanism)
- [Architecture](#architecture)
- [Chain roles](#chain-roles)
- [Implementation and activation status](#implementation-and-activation-status)
- [Trading terminal](#trading-terminal)
- [Fees and business model](#fees-and-business-model)
- [For reviewers](#for-reviewers)
- [Run locally](#run-locally)
- [Safety model](#safety-model)

## How a package trade works

Consider a trader who wants to own SOL spot and short the matching perpetual. The economic target is a cash-and-carry position, not either individual trade. Executing the legs separately can leave the trader exposed if the second venue rejects, moves, or fills only part of its order.

1. The trader chooses a typed strategy, size, domain, price bounds, fee caps, and permitted residual exposure. Naryx binds those terms to a versioned market and domain manifest.
2. A solver or maker quotes the **complete package outcome**, including the costs and capital required across its legs. A public package book, firm maker shard, or private quote may supply liquidity.
3. The trader authorizes the exact quote and route. The execution compiler prepares domain-specific actions and verifies that every action stays inside the signed bounds.
4. On Solana or Base, a same-domain package either meets the specified postconditions inside one transaction or fails. On Arbitrum, the coordinator tracks the GMX request and its recovery obligations across transactions. On Hyperliquid, the adapter records each IOC fill and fee before deciding whether the bounded residual needs recovery.
5. The position remains a strategy object through increase, decrease, exit, reconciliation, and a terminal receipt. The receipt distinguishes a settled outcome from an attempted submission.

Cash-and-carry is the first fully evidenced route. The typed strategy system also contains treasury inventory hedges, funding spreads, options, lending and collateral conversions, and other templates. Availability depends on the exact domain, adapter, market, and activation record; the catalogue is not a claim that every combination has executable liquidity.

## Flagship mechanism

The protocol owns the package market rather than presenting a thin router:

- canonical strategy series make economically equivalent package routes one recognizable market;
- package books, quote shards, firm inventory reservations, and signed solver quotes price the combined outcome;
- exact package postconditions measure what the trader receives across all legs, including fees and permitted residual exposure;
- isolated native package clearing supports signed bilateral matches, exact margin accounting, delayed fee governance, bounded open interest, signed marks, funded recovery reserves, and default auctions for selected standardized series;
- strategy accounts, delayed registries, nonce protection, and immutable domain references preserve authorization and exit liveness;
- asynchronous coordinators and bounded recovery state machines make partial execution explicit instead of mislabeling it atomic;
- evidence-graded lifecycle receipts distinguish submitted, completed, recovered, failed, and unresolved attempts;
- readiness policies bind exact authority, budget, evidence, risk, and recovery commitments before any funded handoff.

## Architecture

```text
Package terminal
      |
Private API and durable package lifecycle
      |
Signed package quotes and route selection
      |
Domain compiler and execution coordinator
      |
Solana programs | EVM contracts | HyperCore adapter
      |
Lifecycle observation, recovery, and evidence
```

The repository keeps compile-time imports, deployment artifacts, network calls, and test consumption as separate dependency relations. The authoritative boundaries are in [AGENTS.md](AGENTS.md).

Contracts enforce the guarantees available within one chain's transaction. The API persists orders and attempts, the solver supplies bounded quotes, the indexer observes finalized events, and the keeper reconciles delayed or failed actions. The browser reads these services over HTTP and asks the user's wallet to sign. No service imports another service's private implementation.

| Path | Current responsibility |
|---|---|
| `packages/protocol-types` | Canonical manifests, series, orders, quotes, routes, exact integer arithmetic, hashes, readiness policy, and evidence types. |
| `contracts/solana` | Anchor programs for core verification, package books, quote shards, inventory reservations, typed Orca spot execution, and typed Rise perpetual execution. |
| `contracts/evm` | Foundry contracts for atomic strategy accounts, package verification and execution, quote shards, reservations, registries, Uniswap V3 spot execution, bonded asynchronous GMX lifecycle control, and isolated native package clearing. |
| `packages/adapter-core` | Chain-neutral adapter compilation, simulation, and evidence interfaces. |
| `packages/adapters/solana` | Authenticated Solana compilation, unsigned simulation, evidence reads, deployment qualification, and signerless mainnet shadow qualification. |
| `packages/adapters/evm` | Chain-neutral atomic calldata compilation plus atomic and asynchronous read-only lifecycle observation. |
| `packages/adapters/hyperliquid` | HyperCore Testnet batched IOC planning, deterministic client order IDs, bounded residuals, reconciliation, and recovery semantics. |
| `services/api` | Private terminal API, durable orders, quote selection, readiness gating, unsigned transaction materialization, and lifecycle reads. |
| `services/solver` | Signed package quote generation and the isolated Hyperliquid Testnet executor boundary. |
| `services/keeper` | Hyperliquid evidence, recovery reconciliation, signerless mainnet shadow reads, and dependency incident state. |
| `apps/web` | Public landing page at `/` and the trading terminal at `/trade` for package construction, quote review, wallet authorization, readiness, execution progress, recovery state, and receipts. |
| `deployments` | Published IDLs, ABIs, identities, and reviewed deployment evidence. It contains no executable logic or secrets. |
| `tests` | Cross-workspace local lifecycle, fork qualification, and conformance evidence. |
| `packages/sdk` | Public TypeScript client and solver SDK with local evidence verification, market data, package lifecycle, RFQ, sealed-auction, maker automation, and streaming clients. |
| `services/indexer` | Read-only EVM event indexer with reorg handling, finality tracking, normalized package evidence, bonded-coordinator reconstruction, and accounting exports. |

## Chain roles

- **Solana** is the native package-exchange domain. Naryx implements package books, maker quote shards, firm reservations, authenticated atomic execution, typed Orca and Rise adapters, and public exit compilation.
- **Base** is the synchronous EVM domain. A Naryx strategy account coordinates package execution with a pinned Uniswap V3 spot port and exact postcondition verification. Base Sepolia includes conformance perpetual support for the test environment, not a claim of a production perpetual venue.
- **Arbitrum** is the asynchronous venue domain. A bonded coordinator and isolated account manage spot entry, GMX V2 request ownership, failed-entry rollback, recovery, and final exit evidence.
- **Hyperliquid** supplies HyperCore spot and perpetual execution through an adapter and isolated services. Naryx deploys no Hyperliquid contract and never calls a batched IOC action atomic.

Cross-domain parity decisions:

- **Performance bonds** live in the EVM `PerformanceBondVault`. The API verifies a `FIRM_BONDED` quote's bond by id through the configured bond reader, and a bond backs only fee exposure in its own asset, with its expiry compared in the vault's block seconds. A Solana or Hyperliquid quote is therefore bondable only when its fees are in the bond's asset; slot-timed quotes are never bondable against a wall-clock bond.
- **Solver fees** are policy-bounded. Base Sepolia deploys a `PolicyRegistry` bound to the verifier but leaves the fee subject inactive, so alpha fees start at zero and a later versioned cap requires delayed governance. The Solana core requires a zero maximum fee on every quote, which matches the zero-fee alpha; enabling Solana fees needs a reviewed fee-policy account first.
- **Strategy transfer**: the EVM `NaryxStrategyAccount` supports a two-step owner transfer and an expiring recovery-exit delegate. A Solana strategy authority is a PDA seeded by the trader key over a venue-owned Rise strategy, and a Hyperliquid account is a venue account, so a strategy on either domain is not transferable in place. The strategy book answers `NOT_TRANSFERABLE` with the remedy `EXIT_AND_REENTER`.

Adding another instance of an implemented runtime family is manifest registration plus deployment and adapter records. Adding new execution semantics requires reviewed code first. Unknown identities and combinations fail closed.

## Implementation and activation status

**Pre-mainnet. Public testnet deployments are active. Mainnet writes are prohibited.**

| Environment | Current evidence | Activation status |
|---|---|---|
| Solana local | Real local validator, current SBF programs, canonical manifests, authenticated entry, rollback, public exit, and receipt reconciliation. | Locally verified. |
| Base local | Private Anvil deployment of the atomic EVM contract graph with entry, exit, solver authorization, and receipts. | Locally verified. |
| Arbitrum local | Private Anvil deployment of the bonded asynchronous coordinator and isolated GMX lifecycle with entry and exit scenarios. | Locally verified. |
| Solana Devnet | The current cash-and-carry and multi-strategy release records are `ACTIVE`, with deployed programs, activation transactions, and test-asset identities. | Public testnet activation; the perpetual leg is a Naryx test venue and the spot inventory is funded test inventory. |
| Base Sepolia | Fifteen Naryx contracts and the reviewed dependency graph are active. Public evidence covers deliberate atomic rollback, entry, exit, and terminal cleanup. | Testnet evidence complete for the first cash-and-carry route. |
| Arbitrum Sepolia | The bonded asynchronous coordinator and isolated GMX lifecycle are active. Public evidence covers failed submission, slash, reclaim, entry and exit callbacks, and terminal cleanup. | Testnet evidence complete for the first cash-and-carry route. |
| Hyperliquid Testnet | Ordered spot and perpetual IOC stages completed entry and exit with exact fee evidence, durable attempt state, reconciliation, and a flat terminal perpetual position. | Testnet evidence complete for the first cash-and-carry route. |
| Base and Arbitrum production-state forks | Pinned read-only qualification harnesses are committed. Without the required RPC and reviewed point-in-time inputs, the harnesses compile and explicitly skip instead of inventing evidence. | No completed fork evidence is claimed. |
| Solana and Hyperliquid mainnet shadow | Signerless readers validate production identity, authority, market state, liquidity, fees, and bounded executable economics. | Read-only capability only. No activation or trading claim. |
| Any mainnet write | No deployment, approval, transfer, bridge, deposit, order, recovery, or signed payload for later broadcast is allowed. | Prohibited until explicit authorization and all readiness gates pass. |

Public program identities are not deployment claims. Published conformance IDLs and ABIs identify local test dependencies, not live venue integrations.

Review the exact public records in [Solana Devnet](deployments/solana/devnet/release.json), [Solana multi-strategy](deployments/solana/devnet/multi-strategy-release.json), [Base Sepolia](deployments/evm/base-sepolia/release.json), [Base multi-strategy](deployments/evm/base-sepolia/multi-strategy-release.json), and [Arbitrum Sepolia](deployments/evm/arbitrum-sepolia/release.json). Each record includes its own limitations. The [deployment guide](deployments/README.md) explains how these records become runtime configuration.

The native clearing path binds exact package-book allocations, owner-authorized collateral changes, independently signed sequence-monotonic marks, bounded default auctions, and durable evidence. The EVM clearing house adds token custody, owner-signed bilateral matching, exact margin and fee accounting, open-interest and position caps, pause controls, funded recovery reserves, and auction recovery. The [Base Sepolia multi-strategy release](deployments/evm/base-sepolia/multi-strategy-release.json) records a deployed, unpaused clearing house; that record alone does not establish funded reserves or trading volume.

A separate native cash range service supports a bounded oracle-priced payoff family on Base Sepolia and Arbitrum Sepolia. Its controller enforces the price formula and full-range collateral, while its quote service checks funded owner accounts and exact sequences before signing. Markets and Portfolio expose account opening, exact approvals, deposits, cash trades, exits, realized-cash settlement, withdrawals, and finalized receipts. Contract-backed standing makers derive executable bids, asks, and capacity from their funded clearing accounts. These books pause when the oracle and clearing mark disagree; capacity is shared and is not reserved until acceptance. Independently supervised domain refresh loops retain exact freshness and gas-budget limits.

Governor-signed manifest registration, delayed entry gates, durable quote leases, and finalized cash receipts remain separate from routed strategy execution. The service queues only independently verified included matches for restart-safe finality reconciliation, so an admitted trade does not depend on an open browser tab. Cash positions do not imply ownership of external spot, perpetual, or option positions. The dedicated `/v1/native-cash/` markets do not manufacture depth in unrelated strategy books.

Hyperliquid users enroll their own testnet trading accounts. Owner-cohort coordination sequences separately authorized executions and preserves independent receipts; it does not pool collateral, transfer positions between users, or grant cross-user margin offsets. Those guarantees would require a separate custody and clearing design, not another execution adapter.

An optional, separately deployed custodial test pool implements that distinct accounting boundary for allowlisted dedicated test accounts only. Every owner signs each trading epoch; a funded sponsor separately authorizes recovery risk. Opposing virtual positions net inside Naryx and only their remainder trades in the shared venue account. Deposits, observed fills, fees, funding, closing, and withdrawals must reconcile exactly. Its October 17, 2026 funded test survived an open-position service restart and completed all withdrawals with no remaining liabilities. This is operator-only test evidence, not public custody enrollment, a terminal feature, or position transfer between existing Hyperliquid accounts.

The landing page uses third-party fonts under `apps/web/src/features/landing/fonts` and third-party artwork under `apps/web/public/landing` as local design material. Their licenses are unverified, so they must be verified or replaced with assets Naryx can ship before any public release of `apps/web`. Chain, token, and wallet marks in the landing page and terminal come from the pinned `@web3icons/react` package (MIT-licensed code); the marks themselves are trademarks of their owners, used only to name the networks and assets Naryx operates on, and each owner's brand guidelines should be confirmed before public release.

## Trading terminal

| Route | User task |
|---|---|
| [`/trade`](https://naryx.vercel.app/trade) | Build a complete strategy order, inspect package depth and quote economics, sign bounded entry or exit, and follow execution state. |
| [`/markets`](https://naryx.vercel.app/markets) | Discover canonical strategy markets, compare package liquidity, and inspect executable or observed market data. |
| [`/portfolio`](https://naryx.vercel.app/portfolio) | Review balances, strategy positions, risk domains, and clearing state. |
| [`/activity`](https://naryx.vercel.app/activity) | Follow order attempts, receipts, and transaction evidence. |
| [`/liquidity`](https://naryx.vercel.app/liquidity) | Inspect solver and maker liquidity, quote shards, and capacity. |
| [`/network`](https://naryx.vercel.app/network) | Inspect domain availability, qualification, settlement classes, and network evidence. |

The interface labels **executable**, **observed**, **indicative**, and **fixture** data separately. A displayed quote is not reported as a trade until the corresponding execution and receipt evidence exists. See the [web guide](apps/web/README.md) for route ownership, wallet flow, data sources, and configuration.

## Fees and business model

The testnet cash-and-carry routes currently charge **zero Naryx service fees**. Signed orders still cap venue fees and pass-through costs, and the receipt reports the actual amounts. EVM fee policy versions use delayed governance and trader-signed limits; the Solana core's current cash-and-carry quote requires a zero maximum service fee. There is no current revenue claim based on testnet volume.

The business model is package execution fees once activated under reviewed policies, plus professional maker and solver tools, lifecycle automation, and market-data services. Those later products are not included in current fee revenue.

## For reviewers

Start with the [terminal](https://naryx.vercel.app/trade), then inspect one order through its quote, settlement class, attempt state, and receipt. The quickest code path is [protocol types](packages/protocol-types/README.md), [contracts](contracts/README.md), [API](services/api/README.md), [solver](services/solver/README.md), and [web](apps/web/README.md). The [SDK guide](packages/sdk/README.md) describes the external integration boundary.

For public deployment evidence, use the committed release records linked above. For local lifecycle verification, use the commands below. The [testnet go-live runbook](deployments/GO-LIVE.md) covers operator funding, configuration generation, health checks, and activation; it is not a mainnet deployment procedure.

## Run locally

Use Node.js 22 and npm 11 for the TypeScript workspaces. Contract work needs the matching Anchor and Solana toolchain or Foundry. Each workspace has its own committed lockfile.

```bash
npm ci --prefix packages/protocol-types
npm test --prefix packages/protocol-types

npm ci --prefix apps/web
npm run build:dependencies --prefix apps/web
npm run dev --prefix apps/web
```

The web app opens at `http://localhost:3000`; `/` is the website and `/trade` is the terminal. Without service configuration, trading data is explicitly labeled as a local fixture. To connect the testnet services, follow [web configuration](apps/web/README.md) and the [testnet go-live runbook](deployments/GO-LIVE.md). No private key belongs in a browser variable or repository file.

## Safety model

- The browser never holds a solver or service signing key.
- Runtime configuration is external, immutable, versioned, environment-bound, and disabled by default.
- Every order, quote, route, receipt, registry record, and readiness decision binds the exact domain manifest version and hash.
- Quantities, prices, fees, caps, and budgets use exact integer atoms with explicit rounding.
- Contracts verify their domain postconditions. Services coordinate only semantics that cannot share a rollback boundary.
- Hyperliquid uses a dedicated Testnet account and agent lease, durable monotonic nonces, exact market identity, pre-submission authority and liquidity checks, and no ambiguous-response retry.
- Unknown, stale, inactive, mismatched, over-budget, or unsupported state fails closed.
- Read-only mainnet components have no signer and no broadcast path.

## Reproduce the implemented evidence

This is a multi-workspace repository. There is intentionally no monolithic command that hides which boundary is being validated.

Install only the workspace you are exercising with its committed lockfile, for example:

```bash
npm ci --prefix packages/protocol-types
npm ci --prefix packages/adapters/solana
npm ci --prefix services/api
npm ci --prefix apps/web
```

Protocol and TypeScript boundaries:

```bash
npm test --prefix packages/protocol-types
npm test --prefix packages/adapters/solana
npm test --prefix packages/adapters/evm
npm test --prefix packages/adapters/hyperliquid
npm test --prefix services/api
npm test --prefix services/solver
npm test --prefix services/keeper
```

Contract workspaces:

```bash
cd contracts/solana && anchor build --ignore-keys
cd contracts/solana && cargo test
cd contracts/evm && forge fmt --check
cd contracts/evm && forge build
cd contracts/evm && forge test
```

Cross-workspace local lifecycles:

```bash
npm test --prefix tests/solana-local
npm test --prefix tests/evm-local
npm test --prefix tests/arbitrum-local
```

Web application, with the landing page at `/` and the terminal at `/trade`:

```bash
npm run lint --prefix apps/web
npm run build --prefix apps/web
npm run dev --prefix apps/web
```

The Solana local suite builds SBF programs and starts a fresh local validator. The EVM suites start private Anvil chains. They create only ephemeral assets and identities outside the repository.

## Repository rules

Read [AGENTS.md](AGENTS.md) before changing anything. It defines the dependency graph, extension model, testing policy, secret handling, generated artifact cleanup, deployment safety, and commit rules.
