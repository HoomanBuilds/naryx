# packages/adapter-core

The adapter contract every domain implements. Contains no venue-specific code.

- adapter interface and versioning;
- supported and unsupported operation declarations;
- dependency identity and code-hash binding;
- evidence grades;
- `PackageResourcePlan`;
- settlement-class capability declarations;
- normalized fill, fee, and state-delta shapes.

May depend on `packages/protocol-types`.

Must not depend on a concrete adapter, a service, `apps/web`, or `tests`.

A package cannot claim a settlement class until an adapter proves the concrete transaction or action fits its domain's resource envelope.
