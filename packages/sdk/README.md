# packages/sdk

Public TypeScript client SDK. Quote, authorize, preflight, submit, watch, recover, and exit against the public API, plus receipt verification helpers.

May depend on `packages/protocol-types` and type-only imports from `packages/adapter-core`.

Must not depend on a concrete adapter package, a service, `apps/web`, or `tests`.

Keeping the SDK thin is what makes the reference integration meaningful: an external integrator must be able to enter and exit a package without any terminal-specific code. If a future slice proves the SDK needs local domain transaction construction, that is a reviewed amendment to the repository architecture, not an ad hoc import.

## Current slice

`NaryxClient` covers every public v1 route: registries (domains, instruments, package templates, solvers), strategy series and execution classes, package markets (listing, depth, tape, candles, executable index, implied provenance), allocation evidence, and the computation routes (order validation, route-decision replay, route comparison, clearing simulation, de-risk validation). It accepts only an HTTPS endpoint or HTTP on a loopback host, bounds response size, requires protocol JSON, and validates every field it returns. It holds no key and signs nothing.

Served evidence is never trusted where it can be checked:

- `getVerifiedAllocation` and `verifyAllocationEvidence` require the allocation to belong to the requested order, the served policy to hash to the policy the allocation binds, and every matching invariant to hold locally.
- `validateOrder` and `replayRouteDecision` recompute the verdict and hash locally and reject a server that disagrees.
- Candles must be labeled `OBSERVED`, ordered, aligned to the interval, and internally consistent; `candlesFromTape` rebuilds a series from tape pages.
- Tape cursors must strictly advance, a listed market must not be crossed, and a clearing response must be marked as a simulation.

The package also re-exports kernel verifiers an integrator can run with no Naryx service in the loop: allocation hashing and verification, candle aggregation, the executable index, the privacy profile, route-decision replay, sealed-auction replay and result verification, selective-disclosure verification, and strategy state hashing.

`NaryxSolverClient` covers the authenticated solver API: manifest registration, quote shards (put, replace, heartbeat, cancel-all, kill switch), capacity evidence and reservations, and book quotes. It signs every request over `solverRequestDigest` with a fresh random nonce through a caller-supplied `sign` function, so the quote key stays in the solver's own signer and never enters the SDK. `NaryxClient` also reads live market quotes, rejecting any quote without a known quote mode, and solver capacity.

Order submission, receipt, and outcome calls are added as the API exposes them; no terminal-internal route is wrapped.

```sh
npm test
```
