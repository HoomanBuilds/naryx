# services/solver

Reference solver runtime. Venue market-data ingestion, implied and direct quote generation, cost modelling, quote signing, inventory and exposure limits, and capacity reservation.

Public control reaches `services/api` over the published solver protocol, so an independent solver can run the same path from outside this repository. The only direct venue write implemented here is the private Hyperliquid Testnet submission boundary described below.

May depend on `packages/protocol-types`, `packages/adapter-core`, `packages/adapters/*`, and `deployments`.

Must not depend on `apps/web`, `packages/sdk`, or another service's internals.

Being the reference implementation is not a network claim. Team-operated solver volume is reported separately from independent volume.

## Current implementation

The Hyperliquid submission service accepts only an existing compiled `HyperliquidExecutionPlan` for `hypercore:testnet`. It independently binds the master and trading account relation, subaccount vault context, agent wallet and lease, package commitments, exact official-shape IOC action, client order IDs, nonce, and request expiry. It requires an injected durable journal port whose compare-and-set lifecycle matches the keeper journal: `PREPARED`, `DURABLE_RECORD_CONFIRMED`, `SUBMITTED_UNKNOWN`, then acknowledgement, rejection, or reconciliation. An unavailable or inconsistent journal fails closed before signing or submission.

The concrete SQLite journal requires an explicit absolute database path and never defaults into the repository or accepts an in-memory database. It uses WAL mode, full synchronous commits, schema version 1, exact decimal text for bigint values, BLOBs for 32-byte commitments, global compare-and-set revisions, permanent signer lease and account nonce fences, and a committed row readback before durable confirmation. Restart recovery is limited to reading an attempt or listing unresolved submissions. It exposes no arbitrary SQL and stores no signer or other secret.

The production transport has no configurable base URL and pins `https://api.hyperliquid-testnet.xyz`. The signer is an injected server-side SDK signer capability. This workspace contains no secret loader, private-key parser, raw-key export, browser signer, mainnet endpoint, fallback URL, retry loop, or recovery submission path. A lost or ambiguous response is not resubmitted. It returns the durable action and request commitments plus both client order IDs for the keeper's Testnet authoritative evidence collector. A successful response is submission evidence only and always requires authoritative reconciliation before settlement classification.

The private loopback executor accepts only an `attemptId` and `idempotencyKey`. An injected trusted provider resolves the complete package attempt, and the boundary validates its Testnet domain, plan commitments, account, market indices, evidence windows, nonce, bounds, and expiry before invoking the existing runtime coordinator. The server is unavailable unless a runtime factory is explicitly injected. It never loads a signer or constructs a submission port, and ambiguous or deferred outcomes remain explicit.

## Hyperliquid SDK dependency

`@nktkas/hyperliquid` is pinned at `0.33.3` for its maintained TypeScript order codec, L1 signing, and request transport. The release is MIT licensed, requires Node `>=22.12.0`, and has npm integrity `sha512-fvnEw/2ejN14ZZVXA+nFQ9YgfFNjCI1yLliYyUboC6hr3Gwd/RwC4Ox90K4e8tkKWqkVpOcLRQ30p0nTeK4NBQ==`. `npm audit --omit=dev` reports zero vulnerabilities. The service imports the SDK order function, signing abstraction, and exchange request transport; it does not implement signing or wire codecs.

## SQLite dependency

`better-sqlite3` is pinned at `13.0.3` for its synchronous transaction and SQLite durability controls on Node 22. It is MIT licensed, maintained through the pinned August 2026 release, and has npm integrity `sha512-RbOBxmLBG8uvFUc15X9+9SFemKcQ0WBuISBVkpuiaUB2qblC8UWlHEjdWVoZ8AdhSwmoEgsiXKfopX0CQxaACQ==`. `@types/better-sqlite3` is pinned at `9.6.0` for build-time types only. `npm audit --omit=dev` reports zero vulnerabilities.
