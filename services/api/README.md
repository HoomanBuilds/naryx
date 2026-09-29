# services/api

Private backend-for-frontend for the operator terminal.

The service exposes deterministic package snapshots and previews plus injected boundaries for preparing unsigned Solana Devnet transactions and observing a submitted Devnet signature. The default process has no execution ports, so preparation and observation fail with `EXECUTION_UNAVAILABLE`.

Preparation accepts only a normalized cash-and-carry request. The injected port owns route compilation and returns an unsigned materialization. The HTTP boundary independently verifies the Devnet identity, plan kind, trader signer, zero signatures, wire size, resolved-account count, compute-unit cap, lookup commitments, and evidence before returning `DEVNET_UNSIGNED_REVIEW_REQUIRED`.

Observation is read-only and reports `SUBMITTED`, `FINALIZED`, `FAILED`, or `EXPIRED`. The observation boundary has no signer, wallet authority, submission, simulation, broadcast, arbitrary instruction input, RPC URL input, or mainnet path.

The service also exposes an internal unsigned-order boundary at POST `/internal/terminal/orders` and GET `/internal/terminal/orders/{orderHash}`. The browser request carries only `contextId`, `owner`, `settlementAccount`, `size`, `slippageBps`, and `idempotencyKey`; size is parsed to integer atoms with the server-owned active context base-asset decimals and the authoritative clock is injected by the server. Orders are stored as `UNSIGNED_CREATED` and responses state that trader authorization and solver quoting are still required. The default process has no order ports, so both routes fail with `ORDER_CREATION_UNAVAILABLE`. This boundary performs no signing, quote creation, transaction preparation, submission, simulation, broadcast, or mainnet path.

It binds to loopback by default. Cross-origin browser access is allowed only for the exact configured terminal origin.

Concrete Devnet ports are built by `createSolanaDevnetExecutionPorts`. The factory must receive reviewed server-owned contexts and a trusted Devnet RPC before the existing server can use it.

The Base Sepolia atomic boundary is disabled by default. When enabled, `NARYX_BASE_SEPOLIA_RUNTIME_MANIFEST` must name an external immutable protocol-JSON manifest containing the exact reviewed deployment, domain, admission, execution-bound, finality, and `ACTIVE` activation identities. `NARYX_BASE_SEPOLIA_RPC_URL` supplies a signerless read endpoint. Startup verifies chain ID and every deployment bytecode hash, and each attempt rechecks them before materializing durable selected order and quote evidence. Missing, inactive, stale, or mismatched identity fails the boundary closed. The API has no wallet, signing, submission, or broadcast path.

The service also exposes POST `/internal/terminal/hyperliquid-testnet/execute`. The browser request carries only `attemptId` and `idempotencyKey`. The server-owned injected port owns the Testnet attempt and returns a sanitized `hypercore:testnet` `TESTNET` result. The default process has no port, so the route fails with `EXECUTION_UNAVAILABLE`. The current limit is one identified attempt per request with no plan, account, signer, or venue payload from the browser.

It may depend on `packages/protocol-types`, `packages/adapter-core`, `packages/adapters/*`, and `deployments`. It must not depend on `apps/web`, `packages/sdk`, or another service's internals.

The Hyperliquid Testnet evidence runtime is separate from execution. It resolves an attempt only from the durable selected intent, canonical order, and signed quote stores, verifies the exact domain, solver, route, account, market metadata, bounds, and expiry, and can call only loopback solver preparation and reconciliation endpoints. Its readiness explicitly reports submission unavailable. It does not create the terminal execution port because no reviewed API-to-solver submission endpoint is composed here.
