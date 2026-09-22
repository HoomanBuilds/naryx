# packages/sdk

Public TypeScript client SDK. Quote, authorize, preflight, submit, watch, recover, and exit against the public API, plus receipt verification helpers.

May depend on `packages/protocol-types` and type-only imports from `packages/adapter-core`.

Must not depend on a concrete adapter package, a service, `apps/web`, or `tests`.

Keeping the SDK thin is what makes the reference integration meaningful: an external integrator must be able to enter and exit a package without any terminal-specific code. If a future slice proves the SDK needs local domain transaction construction, that is a reviewed amendment to the repository architecture, not an ad hoc import.
