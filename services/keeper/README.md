# services/keeper

Lifecycle and risk automation. Strategy health evaluation, pre-authorized rebalance, roll, scheduled exit, funding settlement, bounded recovery driving, and dependency and qualification monitoring.

May depend on `packages/protocol-types`, `packages/adapter-core`, `packages/adapters/*`, and `deployments`.

Must not depend on `apps/web`, `packages/sdk`, or another service's internals.

Every action is bound to a signed condition, maximum cost, resulting risk bound, and expiry. An action labeled risk-reducing may not increase leverage, notional, loss bound, or authority. A keeper never receives a general trading key, and an unsupported automatic action stays disabled rather than being granted one.

## Current implementation

The Hyperliquid package-attempt state machine consumes a compiled `HyperliquidExecutionPlan` and authoritative account reconciliation snapshots. It binds the exact domain, commitments, 128-bit client order IDs, master or subaccount identity, monotonic evidence, terminal IOC states, deltas, positions, open orders, and fee evidence before classifying an outcome.

Immediate submission responses cannot complete an attempt. Exact and bounded outcomes remain distinct, no-effect requires zero fills and no open orders, and unsafe or unresolved evidence fails into reconciliation, a typed recovery obligation, or manual intervention. The implementation is pure and deterministic. It has no networking, signing, key handling, nonce allocation, persistence, or broadcast path.

The pure submission journal adds a per-agent signer-process lease, strictly increasing nonce reservations, exact action and plan commitments, and compare-and-set transitions. Its action digest uses the exported Naryx canonical action commitment scheme; it is not a Hyperliquid signing hash or wire codec. Its durable-record-confirmed state records a caller's claim that the prepared record was persisted. The caller must durably commit the journal's submitted-unknown transition before attempting a network write. A crash or lost response then hands the same trading-account identity and client order IDs to account reconciliation. HyperCore retains only its 100 highest nonces per agent wallet, so the monotonic high-water mark must be retained by an external durable store. The journal has no storage, signer, API client, or broadcast path. A fenced or retired agent address cannot be registered again within the persisted journal; recovery requires a fresh agent address.
