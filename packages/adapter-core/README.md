# @naryx/adapter-core

Shared interfaces for domain adapters. A concrete adapter compiles an admitted package, simulates its payload, and reads the resulting execution receipt. This package does not encode a transaction, sign it, broadcast it, or verify chain-specific receipt data.

The payload and receipt remain adapter-specific type parameters. Domain identity and package hashes use `@naryx/protocol-types`; there is no chain enum or adapter registry here.
