# services/keeper

Lifecycle and risk automation. Strategy health evaluation, pre-authorized rebalance, roll, scheduled exit, funding settlement, bounded recovery driving, and dependency and qualification monitoring.

May depend on `packages/protocol-types`, `packages/adapter-core`, `packages/adapters/*`, and `deployments`.

Must not depend on `apps/web`, `packages/sdk`, or another service's internals.

Every action is bound to a signed condition, maximum cost, resulting risk bound, and expiry. An action labeled risk-reducing may not increase leverage, notional, loss bound, or authority. A keeper never receives a general trading key, and an unsupported automatic action stays disabled rather than being granted one.
