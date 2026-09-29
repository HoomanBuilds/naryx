# packages/sdk

Public TypeScript client SDK. Quote, authorize, preflight, submit, watch, recover, and exit against the public API, plus receipt verification helpers.

May depend on `packages/protocol-types` and type-only imports from `packages/adapter-core`.

Must not depend on a concrete adapter package, a service, `apps/web`, or `tests`.

Keeping the SDK thin is what makes the reference integration meaningful: an external integrator must be able to enter and exit a package without any terminal-specific code. If a future slice proves the SDK needs local domain transaction construction, that is a reviewed amendment to the repository architecture, not an ad hoc import.

## Current slice

`NaryxMarketClient` reads the public market-data API: package depth, the trade tape, and allocation evidence. It accepts only an HTTPS endpoint or HTTP on a loopback host, bounds response size, requires protocol JSON, and validates every field it returns. It holds no key and signs nothing.

Served evidence is never trusted. `getVerifiedAllocation` and `verifyAllocationEvidence` require the allocation to belong to the requested order, require the served matching policy to hash to the policy the allocation binds, and rerun every matching invariant locally. Tape cursors must strictly advance. The package also re-exports the protocol-types verifiers an integrator can run with no Naryx service in the loop: allocation hashing and verification, route-decision replay, sealed-auction replay and result verification, selective-disclosure verification, and strategy state hashing.

Quote, authorize, submit, watch, recover, and exit calls are added only when the public API exposes them; no terminal-internal route is wrapped.

```sh
npm test
```

