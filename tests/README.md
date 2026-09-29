# tests

Cross-workspace evidence that no single workspace can produce alone:

- golden cross-language fixtures shared by Rust, Solidity, and TypeScript;
- template and adapter conformance suites;
- integration and full lifecycle scenarios;
- pinned fork and production-state-clone runs;
- fault injection for partial fills, rejections, stale state, response loss, restart, and recovery;
- the capped mainnet canary procedure.

## Allowed dependencies

Depends on every workspace. Nothing depends on this one.

## Boundary

Workspace-local unit tests stay in their own workspace:

- `contracts/solana/programs/naryx_core/tests` for LiteSVM program tests;
- `contracts/evm/test` for Foundry tests;
- each package's and service's own test directory.

Only what crosses a workspace boundary belongs here.

## Phase 10 local demo

`phase10-demo` runs the existing Solana, Base, and Arbitrum local lifecycle scenarios and emits one machine-readable evidence report. It is a thin orchestrator and does not replace workspace-local tests.

## Rules

- Every scenario is reproducible from a documented command without a mainnet signer and without real funds.
- Every dependency is labeled with its real evidence grade: public test dependency, conformance dependency, pinned production state, shadow production, or capped production. A conformance market is never presented as the production venue, and a fork is never presented as a public mainnet settlement.
- Negative and failure results are reported, not hidden.
- Fault-injection controls are excluded from production builds.

Responsibilities and dependency direction are specified in the repository architecture document.
