# Solana local conformance environment

This workspace starts a fresh local validator, loads the current Naryx core and conformance venue SBF programs at their declared IDs, and provisions ephemeral identities, six-decimal test assets, protocol governance, a solver, entry state, a venue market, a trader position, and bounded balances.

Run from this directory:

```bash
npm test
```

The factory writes its ledger, identity keypairs, validator log, deployed-program dumps, and read-only environment manifest to a uniquely named operating-system temp directory. It stops the validator before removing that exact directory. Nothing is deployed to a public cluster.

The manifest labels this environment `CONFORMANCE_DEPENDENCY`. The local venue is not Orca or Phoenix and does not claim to reproduce either venue's liquidity, market structure, or execution behavior.
