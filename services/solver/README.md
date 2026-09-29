# services/solver

Reference solver runtime. Venue market-data ingestion, implied and direct quote generation, cost modelling, quote signing, inventory and exposure limits, and capacity reservation.

Public control reaches `services/api` over the published solver protocol, so an independent solver can run the same path from outside this repository. The only direct venue write implemented here is the private Hyperliquid Testnet submission boundary described below.

May depend on `packages/protocol-types`, `packages/adapter-core`, `packages/adapters/*`, and `deployments`.

Must not depend on `apps/web`, `packages/sdk`, or another service's internals.

Being the reference implementation is not a network claim. Team-operated solver volume is reported separately from independent volume.

## Current implementation

The ordinary signed quote listener can optionally dispatch canonical `hypercore:testnet` entry
orders to a separate reference cash-and-carry quote runtime. It is disabled unless
`NARYX_HYPERLIQUID_TESTNET_QUOTE_ENABLED=true` and a complete versioned protocol JSON config is
provided through `NARYX_HYPERLIQUID_TESTNET_QUOTE_CONFIG`. The runtime emits only
`BATCHED_IOC_WITH_RECOVERY` routes with `HYPERCORE_BATCHED_IOC`, exact configured versioned market
references, millisecond expiry, the order's explicit `EXACT_NET` or `BOUNDED_NET` residual policy,
and zero protocol and solver fees. Quote nonces are reserved durably in the existing quote SQLite
database. It performs no venue request, agent signing, or execution. Local Solana quote dispatch
continues to use the existing local-only runtime and semantics.

The Hyperliquid submission service accepts only an existing compiled `HyperliquidExecutionPlan` for `hypercore:testnet`. It independently binds the master and trading account relation, subaccount vault context, agent wallet and lease, package commitments, exact official-shape IOC action, client order IDs, nonce, and request expiry. It requires an injected durable journal port whose compare-and-set lifecycle matches the keeper journal: `PREPARED`, `DURABLE_RECORD_CONFIRMED`, `SUBMITTED_UNKNOWN`, then acknowledgement, rejection, or reconciliation. An unavailable or inconsistent journal fails closed before signing or submission.

The concrete SQLite journal requires an explicit absolute database path and never defaults into the repository or accepts an in-memory database. It uses WAL mode, full synchronous commits, schema version 1, exact decimal text for bigint values, BLOBs for 32-byte commitments, global compare-and-set revisions, permanent signer lease and account nonce fences, and a committed row readback before durable confirmation. Restart recovery is limited to reading an attempt or listing unresolved submissions. It exposes no arbitrary SQL and stores no signer or other secret.

The production transport has no configurable base URL and pins `https://api.hyperliquid-testnet.xyz`. The signer is an injected server-side SDK signer capability. This workspace contains no secret loader, private-key parser, raw-key export, browser signer, mainnet endpoint, fallback URL, retry loop, or recovery submission path. A lost or ambiguous response is not resubmitted. It returns the durable action and request commitments plus both client order IDs for the keeper's Testnet authoritative evidence collector. A successful response is submission evidence only and always requires authoritative reconciliation before settlement classification.

The private loopback executor accepts only an `attemptId` and `idempotencyKey`. An injected trusted provider resolves the complete package attempt, and the boundary validates its Testnet domain, plan commitments, account, market indices, evidence windows, nonce, bounds, and expiry before invoking the existing runtime coordinator. The server is unavailable unless a runtime factory is explicitly injected. It never loads a signer or constructs a submission port, and ambiguous or deferred outcomes remain explicit.

The executor runtime loader is disabled unless `NARYX_HYPERLIQUID_TESTNET_EXECUTION_ENABLED=true`. Enabling it requires an exact `TESTNET` environment, lowercase agent and account addresses, an absolute external SQLite journal path, a loopback keeper origin, an externally supplied trusted attempt provider, and an injected official SDK-compatible server signer. The signer address is checked against the configured Testnet agent before the pinned exchange transport is constructed. Resolved attempts are then restricted to that agent and account identity. The reusable loader does not read a private key or start a server.

The solver process starts a separate loopback executor listener only when `NARYX_HYPERLIQUID_TESTNET_EXECUTOR_ENABLED=true`. That opt-in process path requires `NARYX_HYPERLIQUID_TESTNET_AGENT_KEY_PATH` to identify an absolute, canonical regular file outside the repository, owned by the current user, with mode `0400` or `0600`. The file is strict JSON with only `version: 1`, `environment: "TESTNET"`, and a `privateKey` field. The key is converted to the official viem local account supported by the pinned SDK, tagged with the Testnet server signer scope, and checked against `NARYX_HYPERLIQUID_TESTNET_AGENT_ADDRESS`. A raw private key is never accepted through an environment variable or command-line argument.

The attempt client contract is `GET /internal/solver/hyperliquid-testnet/attempts/{attemptId}` on `NARYX_API_INTERNAL_ORIGIN`. A successful response is protocol JSON with exactly `{ "version": 1, "attempt": ... }`; `404` means no durable attempt. The client accepts only loopback HTTP, enforces a timeout and 256 KiB response cap, and applies the executor's complete attempt validator before returning state. The API does not yet implement this endpoint, so executor activation remains operationally blocked until that durable endpoint is supplied and reviewed. Keep `NARYX_HYPERLIQUID_TESTNET_EXECUTOR_ENABLED=false` until then. The ordinary quote server remains available while the executor is disabled.

Neither loader nor process composition approves an agent, transfers funds, changes margin mode, provides a default wallet, or adds a mainnet path. Testnet agent authorization and funding remain external reviewed operations.

## Hyperliquid SDK dependency

`@nktkas/hyperliquid` is pinned at `0.33.3` for its maintained TypeScript order codec, L1 signing, and request transport. The release is MIT licensed, requires Node `>=22.12.0`, and has npm integrity `sha512-fvnEw/2ejN14ZZVXA+nFQ9YgfFNjCI1yLliYyUboC6hr3Gwd/RwC4Ox90K4e8tkKWqkVpOcLRQ30p0nTeK4NBQ==`. `npm audit --omit=dev` reports zero vulnerabilities. The service imports the SDK order function, signing abstraction, and exchange request transport; it does not implement signing or wire codecs.

## SQLite dependency

`better-sqlite3` is pinned at `13.0.3` for its synchronous transaction and SQLite durability controls on Node 22. It is MIT licensed, maintained through the pinned August 2026 release, and has npm integrity `sha512-RbOBxmLBG8uvFUc15X9+9SFemKcQ0WBuISBVkpuiaUB2qblC8UWlHEjdWVoZ8AdhSwmoEgsiXKfopX0CQxaACQ==`. `@types/better-sqlite3` is pinned at `9.6.0` for build-time types only. `npm audit --omit=dev` reports zero vulnerabilities.
