# Naryx

**The Complex Order Network. Trade the strategy, not the legs.**

Naryx is an open execution network for complete onchain financial strategies. A trader describes one typed package, receives one signed package quote, authorizes one bounded outcome, and follows one lifecycle through execution, recovery, exit, and receipt verification. The first implemented strategy is cash-and-carry: acquire spot and short the matching perpetual as one economic order.

The missing primitive is simple: onchain venues expose individual orders, but not an open protocol that can price, authorize, execute, recover, and verify a complete multi-leg strategy as one bounded object.

Naryx does not pretend independent chains are atomic. It assigns every route an explicit settlement class:

- `ATOMIC_POSTCONDITION` for legs sharing one rollback boundary;
- `ASYNC_BONDED_SOLVER` for delayed venues with bonded completion and rollback obligations;
- `BATCHED_IOC_WITH_RECOVERY` for HyperCore batches with signed residual and recovery limits.

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
| `packages/sdk`, `services/indexer` | Defined future boundaries. They are not claimed as completed public products. |

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

**Pre-mainnet. Public deployment is intentionally deferred. Mainnet writes are prohibited.**

| Environment | Current evidence | Activation status |
|---|---|---|
| Solana local | Real local validator, current SBF programs, canonical manifests, authenticated entry, rollback, public exit, and receipt reconciliation. | Locally verified. |
| Base local | Private Anvil deployment of the atomic EVM contract graph with entry, exit, solver authorization, and receipts. | Locally verified. |
| Arbitrum local | Private Anvil deployment of the bonded asynchronous coordinator and isolated GMX lifecycle with entry and exit scenarios. | Locally verified. |
| Solana Devnet | Five public program identities, build artifacts, release verifier, unsigned transaction materializer, signerless observer, readiness gate, and browser review flow exist. | Deployment and initialization deferred. |
| Base Sepolia | Deployment and configuration scripts, immutable runtime manifest validation, bytecode qualification, unsigned attempt materialization, and wallet handoff exist. | Deployment deferred. |
| Arbitrum Sepolia | Deployment and configuration scripts plus signerless asynchronous lifecycle observation exist. | Deployment deferred. |
| Hyperliquid Testnet | Signed quote, batched IOC compiler, durable nonce journal, account and market preflight, isolated executor, evidence collection, reconciliation, recovery, and terminal flow exist behind independent default-off gates. | Public execution deferred pending a qualified dedicated Testnet account, test assets, and passing market depth. |
| Base and Arbitrum production-state forks | Pinned read-only qualification harnesses are committed. Without the required RPC and reviewed point-in-time inputs, the harnesses compile and explicitly skip instead of inventing evidence. | No completed fork evidence is claimed. |
| Solana and Hyperliquid mainnet shadow | Signerless readers validate production identity, authority, market state, liquidity, fees, and bounded executable economics. | Read-only capability only. No activation or trading claim. |
| Any mainnet write | No deployment, approval, transfer, bridge, deposit, order, recovery, or signed payload for later broadcast is allowed. | Prohibited until explicit authorization and all readiness gates pass. |

Public program identities are not deployment claims. Published conformance IDLs and ABIs identify local test dependencies, not live venue integrations.

The native clearing path is implemented but inactive. Its canonical control layer binds exact package-book allocations, owner-authorized collateral changes, independently signed sequence-monotonic marks, bounded default auctions, and durable evidence. The EVM clearing house adds token custody, owner-signed bilateral matching, exact margin and fee accounting, open-interest and position caps, pause controls, funded recovery reserves, and auction recovery. It has not been deployed or funded on any public network.

The landing page uses third-party fonts under `apps/web/src/features/landing/fonts` and third-party artwork under `apps/web/public/landing` as local design material. Their licenses are unverified, so they must be verified or replaced with assets Naryx can ship before any public release of `apps/web`. Chain, token, and wallet marks in the landing page and terminal come from the pinned `@web3icons/react` package (MIT-licensed code); the marks themselves are trademarks of their owners, used only to name the networks and assets Naryx operates on, and each owner's brand guidelines should be confirmed before public release.

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
