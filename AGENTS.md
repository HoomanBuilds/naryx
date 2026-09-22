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

Keep generator-authored files as generated. If generated output produces a warning, report it rather than hand-editing the starter.

## Boundaries

Dependencies flow one way:

```text
deployments -> packages/protocol-types -> packages/adapter-core
  -> packages/adapters/{solana,evm,hyperliquid} -> services/* -> apps/web
```

- `packages/protocol-types` depends on nothing in this repository.
- `packages/sdk` depends on `packages/protocol-types` and `packages/adapter-core` types only. Never an adapter, never a service, never `apps/web`.
- An adapter never imports a sibling adapter. Cross-domain behavior is composed by a service.
- A service never imports another service's internals, `apps/web`, or `packages/sdk`.
- `apps/web` reaches services over the public API only. It never imports an adapter, a service's internals, or contract source, and it never holds a signing key.
- `contracts/solana` and `contracts/evm` depend on nothing in this repository. They publish IDLs, ABIs, and identities into `deployments`, which is consumed from there.
- `deployments` is data only and contains no executable business logic.
- `tests` depends on everything. Nothing depends on `tests`.
- A dependency cycle is a defect, not a tradeoff.

Hyperliquid has no Naryx smart contract. All Hyperliquid code, identifiers, addresses, and assumptions live in `packages/adapters/hyperliquid` and the execution services that drive it. Never in `contracts/solana` or `contracts/evm`.

Build order is contract-first: `packages/protocol-types`, then the contract workspaces, then `packages/adapter-core` and the adapters, then `services/*`, then `packages/sdk`, then `apps/web`. A surface is never built against a postcondition no contract yet checks.

Splitting a workspace into finer packages is a reviewed change to the repository architecture, not an ad hoc decision inside a feature slice.

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

New logic ships with unit tests in the workspace's configured framework. Cover the edges: boundary values, zero and empty input, overflow, rounding direction, expiry, replay, and error paths.

Workspace-local unit tests stay in their workspace (`contracts/solana/programs/naryx_core/tests`, `contracts/evm/test`, each package's own test directory). `tests/` is only for what crosses a workspace boundary.

Do not add a test framework to a workspace that has none. It arrives through its official generator in a slice that says so.

Report failing tests as failing, with their output. Never claim a command passed without having run it.

## Code style

Be concise. Do not over-engineer. Match the surrounding code's naming, structure, and idiom.

Comments only where the code cannot carry the meaning: a non-obvious constraint, a venue quirk, a reason. Never narrate the next line or restate the obvious. Do not add comments, docstrings, or type annotations to code you did not change.

Arithmetic on money, quantities, and fees is exact and integer-based. Rounding direction is a decision to be tested, not a default.

A guarantee must name the component that enforces it. Never label a batched or sequenced action atomic.

## Text rules

No Unicode em dash and no Unicode arrow anywhere: code, docs, commits, comments, or UI copy. Use `-`, `>`, or `->`.

One scoped exception: `apps/web/AGENTS.md` carries a block that `next dev` rewrites on every run. Leave it as generated. Editing it only re-creates an uncommitted change.

No personal names, reference-repository names, or private provenance in any committed file.

## Commits

One-line conventional commit messages: `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`. Separate logical changes into separate commits.

No AI attribution. No `Co-Authored-By` trailer, no generated-with line, no tool name in the message.

No unrelated edits: no drive-by refactors, no reformatting untouched files, no dependency bumps outside the slice's scope.

## Slice handoff

Each slice states its bounded scope, its inputs, and its outputs before work starts. It reports every file changed, every command run with real output, the validation evidence, and the commit hashes. Blockers are reported with the exact error, never worked around silently. The reviewer approves a slice before the next one starts.
