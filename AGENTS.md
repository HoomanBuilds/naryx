# Repository rules

Authoritative policy for this repository. A framework's own `AGENTS.md` inside a workspace is generator output and governs that framework's coding style only. Where the two overlap, this file wins.

## Repository root

This checkout is the repository root. There is exactly one `.git` directory. Never create a nested `naryx/` folder, a second project root, or a nested Git repository inside this one.

## Setup: official generators only

Every workspace an official generator can produce is produced by that generator. Never hand-author a package manifest, lockfile, toolchain file, or framework config as a substitute for running the tool.

| Workspace | Generator |
|---|---|
| `contracts/solana` | `anchor init` |
| `contracts/evm` | `forge init` |
| `apps/web` | `create-next-app` |

Fixed choices: npm, TypeScript, Anchor multiple-file program template, Anchor LiteSVM tests, Foundry empty template, Next.js App Router with `src/`, Tailwind, ESLint, `@/*` alias.

Do not use pnpm, yarn, Bun, Hardhat, Truffle, Vite, or Create React App.

Suppress the generator's own Git init: `anchor init --no-git`, `forge init --use-parent-git --no-git`, `create-next-app --disable-git`.

Workspaces with no official generator (`services/*`, `packages/*`, `deployments`, `tests`) stay as a directory and a boundary `README.md` until a slice has a real reason to add a manifest. Never commit a placeholder package, a fake implementation, or a speculative dependency.

Keep generator-authored files as generated, with one carve-out: where a rule in this file requires a narrow correction to generated output, the rule wins and the correction is named in the slice. Today that is the text rule and the secret-ignore rule. If generated output produces a warning, report it rather than hand-editing the starter.

## Program identity

No program keypair is committed. Every keypair under `contracts/solana/target/deploy` is ignored build output, regenerated per checkout, so a fresh clone's keypair never matches the ID declared in `Anchor.toml` and `programs/naryx_core/src/lib.rs`.

That declared ID is a scaffold-only local identity. It is not a deployed program and carries no authority until a reviewed network deployment provisions an externally managed keypair.

Pre-deployment validation therefore skips the keypair check:

```bash
cd contracts/solana && anchor build --ignore-keys
cd contracts/solana && cargo test
```

A reviewed devnet or testnet deployment supplies the program keypair from outside the repository into ignored build output, runs `anchor keys sync`, commits only the resulting public ID change, and then verifies an ordinary `anchor build` without `--ignore-keys` against that injected keypair. No deployment is authorized before that review.

## Boundaries

Three different relations are tracked separately. Mixing them is what produces a wrong graph.

Compile-time imports, where `A -> B` means B imports A:

```text
packages/protocol-types -> packages/adapter-core
packages/adapter-core   -> packages/adapters/{solana,evm,hyperliquid}
packages/adapters/*     -> services/{api,solver,indexer,keeper}
packages/protocol-types -> packages/sdk
packages/adapter-core   -> packages/sdk   (types only)
packages/sdk            -> apps/web
```

Artifact publication, where `A -> B` means B reads A as data:

```text
contracts/solana -> deployments
contracts/evm    -> deployments
deployments      -> packages/adapters/*, services/*, apps/web, tests
```

Runtime calls, where `A -> B` means A calls B over the network:

```text
apps/web     -> services/api   (public API)
packages/sdk -> services/api   (public API)
```

Test consumption, where `A -> B` means B exercises A:

```text
every workspace -> tests
```

- `packages/protocol-types` depends on nothing in this repository. It is the bottom of the import graph.
- `deployments` depends on nothing in this repository. It is data only, contains no executable business logic, and is consumed rather than imported.
- `contracts/solana` and `contracts/evm` depend on nothing in this repository. They publish IDLs, ABIs, and identities into `deployments`, which is consumed from there.
- `packages/sdk` depends on `packages/protocol-types` and `packages/adapter-core` types only. Never an adapter, never a service's internals, never `apps/web`. It reaches `services/api` over the public API.
- An adapter never imports a sibling adapter, including one runtime adapter importing another runtime family's adapter. Cross-domain behavior is composed by a service.
- A contract verifies its own domain reference and the semantics it implements. It never carries a list of every present or future chain.
- A service never imports another service's internals, `apps/web`, or `packages/sdk`.
- `apps/web` reaches services over the public API only. It never imports an adapter, a service's internals, or contract source, and it never holds a signing key.
- `tests` may consume every workspace. Nothing depends on `tests`.
- A dependency cycle is a defect, not a tradeoff.

Hyperliquid has no Naryx smart contract. All Hyperliquid code, identifiers, addresses, and assumptions live in `packages/adapters/hyperliquid` and the execution services that drive it. Never in `contracts/solana` or `contracts/evm`.

Build order is contract-first: `packages/protocol-types`, then the contract workspaces, then `packages/adapter-core` and the adapters, then `services/*`, then `packages/sdk`, then `apps/web`. A surface is never built against a postcondition no contract yet checks.

Splitting a workspace into finer packages is a reviewed change to the repository architecture, not an ad hoc decision inside a feature slice.

## Extensibility

Extension has two shapes and they are not interchangeable.

Routine additions are data registration. A new asset, a new venue instance, a new market, a new adapter instance of an adapter class that already exists, and a new price source are added by publishing an immutable versioned manifest plus a delayed domain registry record. They are never added by editing a shared type.

A genuinely new adapter class, package template schema, or settlement class is not data. It carries new executable semantics, so it requires reviewed code or schema support first, and only then its own immutable manifest and delayed registry activation. Publishing a manifest is not the extension mechanism for new semantics.

- A manifest can activate only behavior that is already implemented and explicitly recognized by the verifier. A manifest never manufactures new semantics, and an unrecognized class, schema, or combination fails closed rather than being interpreted.
- Adapter instance identity is data. `packages/protocol-types` never grows a flattened venue by asset by oracle product enum. Where a discriminant must exist onchain it is separate axes, never their product.
- A new specialized adapter class arrives through its own reviewed registration path. Widening a generic path to admit it is a defect.
- Unknown, unregistered, mismatched, inactive, and unsupported records fail closed. There is no permissive default.
- Adding a record never reinterprets an existing signed order, quote, route, receipt, or manifest hash. A new version is a new identity and a new hash, and the meaning of an active manifest is never mutated in place.
- A mutable registry record carries only activation state and bounded current risk and economic configuration. Its lifecycle is `ACTIVE`, `ENTRY_PAUSED`, `EXIT_ONLY`, `ALL_PAUSED`, `DEPRECATED`, and exits are preserved wherever the underlying dependency is still safe to call.
- Registration is security-gated on exact domain identity, token identity, venue and market identity, decimals, lot, tick and minimum sizes, code or manifest hash, allowed templates and settlement classes, risk limits, and an activation delay. Extensible never means arbitrary calldata or arbitrary contract execution.

### Chains

A chain follows the same split, and the split runs between a runtime family and an instance of it.

An immutable `DomainManifest` is the boundary. It binds manifest version, environment, domain ID, runtime class ID and version, chain namespace and reference, execution verifier ID and code hash, clock model ID, finality policy hash, address codec ID, and supported settlement classes. `runtimeClassId` names executable semantics that are already implemented, such as an EVM, SVM, or HyperCore controller family. It is not a promise that an arbitrary runtime class works.

- A new chain instance under an implemented runtime class is a new `DomainManifest` plus deployment records, delayed registry records, and adapter instances. It is never an edit to a shared order, quote, route, receipt, or expiry type.
- A genuinely new runtime family is executable semantics. It requires isolated reviewed verifier and adapter code with its own tests before any manifest registers an instance of it. Widening an existing runtime class to admit it is a defect.
- `packages/protocol-types` never grows a closed chain enum, a chain-specific product union, or a flattened chain by venue by asset discriminant. Chain identity is a bounded `DomainId` plus a manifest hash.
- Every signed order, quote, route, solver capability, receipt, outcome, evidence manifest, registry record, and manifest field that names a domain carries a `DomainRef` of `domainId`, a nonzero `domainManifestVersion`, and a nonzero `domainManifestHash`, in that field order. Registering a domain therefore never reinterprets bytes already signed under an earlier one.
- An unknown or unrecognized runtime class or version, execution verifier, clock model, address codec, settlement class, or combination of them fails closed.
- Chain activation is gated separately by domain, environment, adapter, template, settlement class, and size cohort. A manifest being publishable is not support for a chain, and support is never claimed before the gates pass.

## No mainnet writes

Testnet, devnet, local, pinned fork, and read-only shadow mainnet only.

Never deploy, upgrade, initialize, close, or change authority for a mainnet program or contract. Never approve a mainnet allowance; transfer, bridge, deposit, withdraw, wrap, or unwrap a real asset; open, close, modify, or recover a real position; fund a solver reservation, bond, strategy account, margin account, or recovery account; approve an API wallet or builder fee on mainnet; or sign a mainnet payload for later broadcast. Never run a script with a production signer attached, even one expected only to simulate.

Read-only mainnet RPC and API calls are allowed. They must have no signer and no broadcast path.

Write paths fail closed: disabled by default, network identity verified from chain data rather than an RPC URL label, and amount limits enforced in integer asset atoms. Foundry scripts stay non-broadcast unless the launch procedure explicitly supplies `--broadcast`.

Environment promotion order is local, then devnet and testnet, then pinned production-state clone or fork, then read-only shadow mainnet, then capped mainnet only after the readiness gates pass. Promotion is one way, per domain, adapter, template, settlement class, quote mode, and size cohort.

## No secrets in the repository

Never commit a private key, keypair file, mnemonic, API credential, or `.env`. Only `.env.example` with placeholder values.

Never stage `docs/`, `inspiration/`, `.agents/`, `.codex/`, `node_modules/`, build output, caches, Rust `target/`, Anchor or Foundry artifacts, local deployment records, or logs. Run `git status` before committing and confirm what is actually staged.

Generated program keypairs stay in ignored build output and are never promoted to a network with real value.

## Tests

New logic ships with tests in the workspace's configured framework. Depth is proportional to risk, not uniform. Test count and coverage percentage are not goals.

Critical logic gets deep coverage: boundary values, zero and empty input, overflow, rounding direction, expiry, replay, negative and error paths, cross-language vectors, and property, fuzz, or invariant tests. Critical means consensus, security, or money: canonical encoding and hashing, signatures and replay protection, fee arithmetic and rounding, access control and authority, state transitions, settlement postconditions, recovery, and accounting conservation.

Ordinary adapters, plumbing, and wiring get focused contract tests for their own behavior plus one small integration test across the boundary they cross.

UI presentation gets no combinatorial or duplicated tests unless the behavior carries money, authorization, or state.

Each invariant has one primary test at the lowest layer that can enforce it. A higher layer tests the boundary it owns rather than repeating every lower-layer permutation. Critical money and security behavior gets the minimum representative set that proves it: happy path, the closest meaningful boundary, and the applicable failure, replay, or overflow case. Prefer one property or invariant test over many permutations that prove the same thing.

Never weaken a critical test to save time, and never add a duplicate, cosmetic, or framework-only test. Do not restate framework, library, fixture, or lower-layer behavior in a higher layer. Do not test getters, generated boilerplate, or static wiring unless they enforce a protocol guarantee.

Workspace-local unit tests stay in their workspace (`contracts/solana/programs/naryx_core/tests`, `contracts/evm/test`, each package's own test directory). `tests/` is only for what crosses a workspace boundary.

Do not add a test framework to a workspace that has none. It arrives through its official generator in a slice that says so.

While implementing, run the focused tests for the code being changed. Run the full relevant workspace suite once at slice exit, not again after every edit.

Report failing tests as failing, with their output. Never claim a command passed without having run it.

## Libraries and dependencies

Use official or established maintained libraries and official SDKs for standard cryptography, signing, hashing primitives, token standards, serialization, ABI and Borsh support, RPC, wallet integration, and venue APIs. Never hand-roll standard cryptography or a standard protocol codec.

Custom implementation is justified only for Naryx-specific semantics or where no suitable safe library exists. The slice names that reason and protects only the novel invariant with focused vectors and tests.

Pin every dependency and review its license, maintenance, release integrity, and security posture before adopting it.

## Code style

Be concise. Do not over-engineer. Match the surrounding code's naming, structure, and idiom.

Comments only where the code cannot carry the meaning: a non-obvious constraint, a venue quirk, a reason. Never narrate the next line or restate the obvious. Do not add comments, docstrings, or type annotations to code you did not change.

Arithmetic on money, quantities, and fees is exact and integer-based. Rounding direction is a decision to be tested, not a default.

A guarantee must name the component that enforces it. Never label a batched or sequenced action atomic.

## Text rules

No Unicode em dash and no Unicode arrow anywhere: code, docs, commits, comments, or UI copy. Use `-`, `>`, or `->`. There is no exception.

A framework command can regenerate a prohibited character. `next dev` rewrites `apps/web/AGENTS.md` on every run and reintroduces Unicode em dashes. When a generated instruction file comes back with prohibited Unicode, the implementation agent normalizes it to ASCII punctuation before committing. The text rule outranks the generated form of the file.

No personal names, reference-repository names, or private provenance in any committed file.

## Commits

One-line conventional commit messages: `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`. Separate logical changes into separate commits.

No AI attribution. No `Co-Authored-By` trailer, no generated-with line, no tool name in the message.

No unrelated edits: no drive-by refactors, no reformatting untouched files, no dependency bumps outside the slice's scope.

## Slice handoff

Each slice states its bounded scope, its inputs, and its outputs before work starts. It reports every file changed, every command run with real output, the validation evidence, and the commit hashes. Blockers are reported with the exact error, never worked around silently. The reviewer approves a slice before the next one starts.
