# Phase 10 local demo

This workspace runs the existing Naryx deterministic lifecycle evidence once and combines the real command results into one machine-readable report. It does not duplicate the underlying scenario assertions.

The required checks are:

- the Solana local cash-and-carry entry, atomic rollback, service restart recovery, canonical exit, and private terminal lifecycle;
- the Base local atomic entry, failed-entry rollback, and receipt-bound exit;
- the Arbitrum local asynchronous entry, failed-entry rollback, evidence relay, full close, and normalized final receipt.
- the visibly labeled Hyperliquid local conformance path with batched IOC entry, forced one-leg failure, bounded recovery, and complete exit.

The runner builds the current EVM artifacts first. The Solana scenario uses its existing build command. Every process has a bounded timeout, and the report contains the actual exit code, signal, duration, output hashes, bounded output tails, and Git commit.

Run from the repository root:

```bash
npm --prefix tests/phase10-demo run demo
```

The default report is `tmp/phase10-demo-evidence.json`, which is ignored repository output. Choose another location with:

```bash
npm --prefix tests/phase10-demo run demo -- --output /absolute/path/evidence.json
```

The child environment contains no RPC URL, API token, signer, mnemonic, or private key inherited from the caller. All required scenarios launch private loopback validators and create temporary valueless accounts. Public Devnet, testnet, fork, shadow, and mainnet checks are not run. Credential-dependent checks are recorded as `SKIPPED`, never as `PASSED`.

## Hyperliquid Testnet package lifecycle

The opt-in public Testnet runner uses the reviewed external executor environment and key. It fails
closed unless the account starts without a tradable package position, submits spot and perpetual
orders as separate IOC stages, reconciles authoritative evidence after each stage, exits both legs,
and verifies that no perpetual position or tradable spot lot remains.

```bash
NARYX_DEMO_NETWORK_POLICY=TESTNET_WRITES_EXPLICITLY_ENABLED \
node --env-file=/absolute/path/to/hyperliquid-executor.env \
  tests/phase10-demo/src/run-hyperliquid-testnet.js --execute
```

The runner is Testnet-only. Hyperliquid does not accept spot and perpetual orders in one action, so
the evidence truthfully reports ordered settlement with bounded recovery rather than atomicity.
