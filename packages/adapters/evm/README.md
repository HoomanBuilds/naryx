# EVM atomic package adapter

This package compiles an admitted atomic cash-and-carry package into unsigned calldata for the published `NaryxStrategyAccount.executePackage` ABI. The result contains an explicit call target, zero native value, chain reference, calldata, and the exact order, quote, and route commitments.

The compiler is chain-neutral. Base, Arbitrum, and later EIP-155 domains use the same code after their immutable EVM domain manifest and deployment identity pass their own registration gates. There is no chain enum or built-in deployment address.

The caller supplies deployment-pinned resource addresses, code hashes, and verifier execution bounds. The compiler checks those identities against the admitted route and domain manifest before encoding calldata. It never signs, opens an RPC connection, simulates, or broadcasts.

Only `EVM_ATOMIC_BATCH` with `ATOMIC_POSTCONDITION` is supported. Asynchronous venue flows, including GMX-style execution, are outside this settlement class and require a separate reviewed adapter path.
