# services/solver

Reference solver runtime. Venue market-data ingestion, implied and direct quote generation, cost modelling, quote signing, inventory and exposure limits, and capacity reservation.

Public control reaches `services/api` over the published solver protocol, so an independent solver can run the same path from outside this repository. The only direct venue write implemented here is the private Hyperliquid Testnet submission boundary described below.

May depend on `packages/protocol-types`, `packages/adapter-core`, `packages/adapters/*`, and `deployments`.

Must not depend on `apps/web`, `packages/sdk`, or another service's internals.

Being the reference implementation is not a network claim. Team-operated solver volume is reported separately from independent volume.

## Current implementation

The Hyperliquid submission service accepts only an existing compiled `HyperliquidExecutionPlan` for `hypercore:testnet`. It independently binds the master and trading account relation, subaccount vault context, agent wallet and lease, package commitments, exact official-shape IOC action, client order IDs, nonce, and request expiry. It requires an injected durable journal port whose compare-and-set lifecycle matches the keeper journal: `PREPARED`, `DURABLE_RECORD_CONFIRMED`, `SUBMITTED_UNKNOWN`, then acknowledgement, rejection, or reconciliation. No persistence implementation is supplied here. An unavailable or inconsistent journal fails closed before signing or submission.

The production transport has no configurable base URL and pins `https://api.hyperliquid-testnet.xyz`. The signer is an injected server-side SDK signer capability. This workspace contains no secret loader, private-key parser, raw-key export, browser signer, mainnet endpoint, fallback URL, retry loop, or recovery submission path. A lost or ambiguous response is not resubmitted. It returns the durable action and request commitments plus both client order IDs for the keeper's Testnet authoritative evidence collector. A successful response is submission evidence only and always requires authoritative reconciliation before settlement classification.

## Hyperliquid SDK dependency

`@nktkas/hyperliquid` is pinned at `0.33.3` for its maintained TypeScript order codec, L1 signing, and request transport. The release is MIT licensed, requires Node `>=22.12.0`, and has npm integrity `sha512-fvnEw/2ejN14ZZVXA+nFQ9YgfFNjCI1yLliYyUboC6hr3Gwd/RwC4Ox90K4e8tkKWqkVpOcLRQ30p0nTeK4NBQ==`. `npm audit --omit=dev` reports zero vulnerabilities. The service imports the SDK order function, signing abstraction, and exchange request transport; it does not implement signing or wire codecs.
