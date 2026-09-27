# EVM atomic package adapter

This package compiles an admitted atomic cash-and-carry package into unsigned calldata for the published `NaryxStrategyAccount.executePackage` ABI. The result contains an explicit call target, zero native value, chain reference, calldata, and the exact order, quote, and route commitments.

The compiler is chain-neutral. Base, Arbitrum, and later EIP-155 domains use the same code after their immutable EVM domain manifest and deployment identity pass their own registration gates. There is no chain enum or built-in deployment address.

The caller supplies deployment-pinned resource addresses, code hashes, and verifier execution bounds. The compiler checks those identities against the admitted route and domain manifest before encoding calldata. It never signs, opens an RPC connection, simulates, or broadcasts.

Only `EVM_ATOMIC_BATCH` with `ATOMIC_POSTCONDITION` is supported. Asynchronous venue flows, including GMX-style execution, are outside this settlement class and require a separate reviewed adapter path.

## Read-only execution observation

`src/atomicObservation.ts` and `src/asyncObservation.ts` normalize read-only execution state through the injected `EvmReadPort` (`src/readPort.ts`). The port exposes only chain ID, transaction receipts, contract reads, and chain head data. It has no signer, no send path, and no simulate or broadcast path.

`observeEvmAtomicPackage` binds a transaction to the expected chain reference, verifier, strategy account, order, quote, and route hashes. A successful transaction alone is never package completion: the observer requires a matching `PackageVerified` log plus a matching `PackageVerifier` receipt (or the open-package postcondition for entry), then gates on the caller-supplied finality policy (`requiredConfirmations`, `requireFinalized`). Lifecycle is one of `NOT_FOUND`, `SUBMITTED`, `REVERTED`, `CONFIRMED`, `FINALIZED`, or `EVIDENCE_MISMATCH`. Anything asynchronous passed to this observer throws.

`observeAsyncBondedPackage` normalizes `ASYNC_BONDED_SOLVER` packages across the coordinator `State`, the entry adapter `Status`, the optional exit controller `Status`, and the final package receipt. It checks chain, domain, owner, adapter and handler identity, order, quote, and route hashes, request-key ownership, nonzero evidence commitments, revision monotonicity, coordinator and adapter compatibility, and, for a completed exit, a nonzero matching `FinalPackageReceipt` with terminal state complete. Conflicts surface as `CONFLICT`; anything unknown, missing, wrong-chain, or mismatched is `EVIDENCE_MISMATCH`. A pending or recovered entry is never reported as a completed exit.

Both observers return frozen objects with evidence grades (`transaction-receipt`, `contract-state`, `authenticated-callback-record`, `finalized-contract-receipt`) that describe only what the injected reads prove. Status discriminants follow the Solidity enum order exactly. There is no chain enum and no environment-specific address in runtime code; any registered EIP-155 domain with implemented EVM semantics works after its own registration gates pass.
