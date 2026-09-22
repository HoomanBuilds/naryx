# packages/protocol-types

The protocol kernel and the bottom of the dependency graph.

- canonical package, order, quote, route, receipt, recovery-receipt, and error schemas;
- canonical encoding and domain-separated hashing;
- exact integer arithmetic for decimals, lots, ticks, spread, margin, and fees;
- terminal states and evidence grades;
- golden test vectors shared with `contracts/solana` and `contracts/evm` through committed fixtures.

Depends on nothing else in this repository. Everything else may depend on it.

Arithmetic is exact and integer-based. Rounding direction, overflow, zero quantity, expiry, and replay are behavior to be tested, not assumptions.
