# Naryx Hackathon Brief

## Product

Naryx is the Complex Order Network: an open protocol where traders price, authorize, execute, recover, and verify a complete multi-leg strategy as one bounded package instead of manually trading each leg.

The first implemented market is cash-and-carry. A trader buys spot and shorts the matching perpetual through one package order with a quoted net outcome, explicit fee and slippage limits, a defined settlement class, and one lifecycle from entry through exit.

## Problem

A strategy may be economically simple while its execution is operationally dangerous. Today a trader must discover multiple venues, calculate leg ratios, submit separate orders, manage timing risk, reconcile fees and fills, recover partial execution, and later unwind the same legs. Existing routers optimize individual swaps or orders. Existing exchanges own one venue. Neither gives an open market for the combined strategy outcome.

This fragmentation causes four concrete failures:

1. Traders compare leg prices instead of the net strategy result.
2. One leg can fill while another fails or arrives late.
3. Independent venues cannot share authorization, recovery limits, or lifecycle evidence.
4. Integrators rebuild the same execution and reconciliation logic for every strategy.

## Missing primitive

Onchain venues expose individual orders, but no open protocol lets a user price, authorize, execute, recover, and verify a complete multi-leg strategy as one bounded object.

## Mechanism

Naryx turns a strategy into a canonical package order. The order binds the strategy series, domain identities, quantities, prices, fees, residual exposure, recovery permissions, deadline, and nonce. Solvers compete on the complete package outcome and sign quotes that commit to an exact route and settlement class.

The protocol recognizes three different guarantees:

- **Atomic postcondition:** all legs share one rollback boundary, and the contract verifies the final combined state before committing.
- **Bonded asynchronous execution:** a solver accepts explicit completion and rollback obligations for venues that settle later.
- **Batched IOC with recovery:** HyperCore legs are sent together, but partial fills remain possible, so the user pre-authorizes bounded residual exposure and specific recovery actions.

The package lifecycle never upgrades a weak guarantee into a stronger marketing label. A package is completed only when evidence proves its signed postcondition. Otherwise it is pending, recovered, failed, or unresolved.

## Owned technical depth

Naryx is more than a trading interface over third-party venues. Its protocol-owned mechanisms include:

- canonical economic strategy series and versioned package schemas;
- package order books, maker quote shards, signed solver quotes, and firm inventory reservations;
- exact combined-outcome accounting across prices, fees, deltas, and residuals;
- authenticated Solana package execution with program-level postconditions;
- EVM strategy accounts with atomic package verification and protected exit liveness;
- bonded asynchronous coordination for GMX-style delayed settlement;
- deterministic HyperCore client order identities, durable monotonic nonces, authoritative reconciliation, and bounded recovery;
- immutable domain, asset, venue, market, adapter, price-source, and template identities with delayed activation;
- evidence-graded receipts and dependency incident state;
- operation readiness that binds authority, capital, fee, slippage, margin, recovery, loss, and evidence budgets before a funded handoff.

All financial arithmetic uses integer atoms. Rounding direction is explicit. Signed objects bind exact manifest versions and hashes, so a later registry update cannot reinterpret an older order.

## User workflow

1. The trader opens the package terminal and chooses a supported strategy series and environment.
2. The trader enters strategy size, outcome bounds, slippage, and expiry rather than constructing venue calldata.
3. The API creates a canonical unsigned package order from server-owned active context.
4. Solvers return signed quotes for the complete outcome, route, settlement class, fees, and recovery policy.
5. The terminal shows the package economics and guarantee before asking for authorization.
6. The selected domain compiler creates the exact execution materialization.
7. The user or isolated execution service submits only after readiness, identity, authority, and risk checks pass.
8. The lifecycle view follows every leg through confirmation, recovery, exit, and final evidence.

## Why these chains

### Solana

Solana is the native package-exchange domain. Naryx implements package books, maker quote shards, reservations, typed Orca and Rise adapters, authenticated atomic execution, and public exit compilation. Its account model allows the combined postcondition to be checked inside one transaction when all selected legs are synchronously composable.

### Base

Base demonstrates the synchronous EVM route. A Naryx strategy account coordinates package execution with a pinned Uniswap V3 spot port and exact receipt verification. The Base Sepolia perpetual component is labeled test support and is not represented as a live production venue.

### Arbitrum

Arbitrum demonstrates why the protocol needs a second settlement class. GMX V2 requests execute asynchronously, so Naryx uses a bonded coordinator, an isolated account, exact request ownership, failed-entry rollback, recovery, and signed full-close controls.

### Hyperliquid

Hyperliquid provides composable spot and perpetual execution without a Naryx contract. The adapter compiles a batched IOC action, while isolated services enforce account authority, market identity, depth, durable nonces, evidence collection, reconciliation, and bounded recovery. Naryx never claims the batch is atomic.

## Business model

The protocol is designed for several revenue lines, none of which is claimed as live revenue today:

- a low package execution fee on successfully matched strategy notional;
- solver and maker infrastructure subscriptions;
- professional terminal and lifecycle automation subscriptions;
- private RFQ and protected execution fees;
- package market-data, execution-quality, and risk APIs;
- enterprise integrations and custom venue adapters;
- future collateral-optimization and native package-clearing fees after separate security and capital readiness.

The initial users are active traders, market makers, vault operators, and treasuries that repeatedly enter and unwind hedged positions. The initial wedge is one concentrated cash-and-carry series rather than every possible strategy.

## Security model

- Mainnet writes are prohibited. No live funds are required for the current evidence.
- Public test environments are disabled by default and require exact external manifests.
- Browser input cannot select arbitrary contracts, venue calldata, runtime domains, or service signers.
- Every execution is replay-protected and bound to an exact owner, solver, route, domain, nonce, expiry, and outcome.
- Contracts enforce same-domain postconditions. Cross-domain and delayed execution are coordinated by explicitly weaker settlement classes with bounded recovery.
- Hyperliquid uses a dedicated Testnet account and agent, exact market qualification, durable nonce fencing, and no automatic retry after an ambiguous response.
- Readiness gates bind funded operations to approved integer-atom budgets and required security evidence.
- Dependency drift can only reduce permissions automatically. Restoring entry requires fresh evidence and independent reviewer commitments.
- Signerless production-state readers have no key, transaction construction, or broadcast path.

The project has not received an external audit and does not claim production readiness.

## Current evidence

### Working locally

- Solana local validator lifecycle with authenticated cash-and-carry entry, rollback, exit, and receipt reconciliation.
- Base local Anvil lifecycle with atomic strategy-account execution, solver authorization, entry, exit, and receipts.
- Arbitrum local Anvil lifecycle with bonded asynchronous entry, isolated account state, rollback, recovery boundaries, and final exit evidence.
- Private web terminal with package construction, signed quote selection, readiness state, wallet handoff, lifecycle status, and receipt rendering.
- Cross-language canonical types and published Solana IDLs and EVM ABIs.

### Prepared but not publicly deployed

- Solana Devnet identities, release verifier, unsigned materialization, read-only observation, and browser review.
- Base Sepolia deployment and configuration scripts, bytecode qualification, and wallet handoff.
- Arbitrum Sepolia deployment and configuration scripts plus read-only asynchronous lifecycle observation.
- Hyperliquid Testnet quote, compiler, executor, evidence, reconciliation, recovery, and terminal path behind independent default-off gates.

### Production-state evidence boundaries

- Base and Arbitrum pinned-fork qualification harnesses are committed. Without the required RPC and reviewed point-in-time inputs, they compile and explicitly skip.
- Solana and Hyperliquid have signerless mainnet shadow readers for identity, authority, market, liquidity, fee, and bounded economics checks.
- No completed public deployment, production fork evidence record, mainnet execution, user volume, revenue, audit, or performance benchmark is claimed.

## Limitations

- Cash-and-carry is the only end-to-end strategy template implemented today.
- Public Devnet and testnet deployments and funded executions are deferred.
- Hyperliquid Testnet execution still requires a dedicated qualified account, test assets, and a market that passes configured depth and divergence bounds.
- Base Sepolia uses clearly labeled perpetual test support rather than a production venue integration.
- Arbitrum execution is asynchronous and cannot provide atomic rollback after an external GMX request executes.
- The public SDK and standalone indexer are architectural boundaries, not completed products.
- Native cross-user portfolio margin, cross-chain atomic settlement, options packages, and native package clearing remain future work.
- No external security audit has been completed.

## Demo sequence: 2 to 3 minutes

### 0:00 to 0:20 - The problem

Show the cash-and-carry package in the terminal. Explain that the trader wants one economic outcome, not two disconnected orders and a manual recovery runbook.

### 0:20 to 0:50 - Build one package

Enter size, slippage, and expiry. Show the canonical strategy series, exact domain identity, spot and perpetual legs, settlement class, and combined outcome bounds.

### 0:50 to 1:20 - Quote the strategy

Create the package order and display a signed solver quote. Highlight that the quote commits to both legs, total fees, route, nonce, expiry, and permitted residual exposure rather than advertising two unrelated top-of-book prices.

### 1:20 to 1:50 - Execute under the correct guarantee

Use a local deterministic environment. Show the wallet authorization and the package moving through submitted and completed lifecycle states. Open the receipt and point to the order, quote, route, solver, execution, and final-state commitments.

### 1:50 to 2:15 - Prove failure handling

Run or display the local failure scenario. Show that a failed leg does not become a false success: the atomic route reverts, while an asynchronous or batched route moves into its explicit rollback or recovery state.

### 2:15 to 2:40 - Show multi-chain depth

Display the chain activation matrix. Contrast Solana atomic execution, Base strategy accounts, Arbitrum bonded asynchronous GMX lifecycle, and Hyperliquid batched IOC plus bounded recovery. State clearly that public deployments are deferred and mainnet is read-only.

### 2:40 to 3:00 - Close

Return to the package receipt and summarize: Naryx makes the complete strategy the traded object, the signed risk boundary, and the unit of lifecycle evidence.
