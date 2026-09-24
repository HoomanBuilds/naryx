# Solana Devnet deployment lane

This directory records reviewed public Solana Devnet deployments. A README without a release manifest is not a deployment claim.

## Scope

The normal cash-and-carry route requires these Naryx programs to be built from one synchronized identity set:

1. `naryx_orca_adapter`
2. `naryx_rise_adapter`
3. `naryx_inventory_reservation`
4. `naryx_package_book`
5. `naryx_core`

The normal `naryx_core` binary is compiled without the `conformance` feature.

`naryx_conformance_venue` is local deterministic test infrastructure. It is not a Phoenix Rise substitute and the normal core does not call it. The feature-gated conformance core binary must never replace the normal Devnet core at the same program identity. A future Phoenix-compatible public Devnet conformance dependency needs its own reviewed program, identity, deployment record, and `CONFORMANCE_DEPENDENCY` label.

## Safety gates

- Use only `https://api.devnet.solana.com`.
- Verify the cluster genesis hash is `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG` before every write.
- Use a fresh Devnet-only payer and fresh program keypairs held outside the repository.
- Fund the payer only with free Devnet SOL.
- Never read, copy, or reuse the configured default wallet.
- Never deploy when the observed genesis hash differs.
- Never run this procedure against mainnet, testnet, or a URL chosen only by a label.

## Build and identity synchronization

From `contracts/solana`:

```bash
anchor build --ignore-keys
solana genesis-hash --url https://api.devnet.solana.com
```

Generate or retrieve the five Devnet program keypairs from an external secret directory, then copy them into the ignored `target/deploy` paths with mode `600`. Do not place any keypair under `deployments` or stage it in Git.

Sync one reviewed normal program at a time:

```bash
anchor keys sync -p naryx_orca_adapter --provider.cluster https://api.devnet.solana.com
anchor keys sync -p naryx_rise_adapter --provider.cluster https://api.devnet.solana.com
anchor keys sync -p naryx_inventory_reservation --provider.cluster https://api.devnet.solana.com
anchor keys sync -p naryx_package_book --provider.cluster https://api.devnet.solana.com
anchor keys sync -p naryx_core --provider.cluster https://api.devnet.solana.com
anchor build
```

Review the resulting source and `Anchor.toml` diff before deployment. Only public program identity changes are expected.

## Funding check

Calculate rent from the final artifacts rather than using a fixed budget:

```bash
solana rent "$(( $(stat -c %s target/deploy/naryx_core.so) + 45 ))" --url https://api.devnet.solana.com
```

Repeat for every program in the release. The payer balance must cover the complete rent estimate, deployment fees, and a small retry margin before the first deploy begins. Do not partially deploy a coordinated identity set without recording the incomplete state.

## Deployment

Deploy each reviewed artifact with the official Solana CLI, an explicit Devnet URL, the external Devnet payer, the matching ignored program keypair, and the same Devnet-only upgrade authority. Capture the JSON output without capturing key material.

```bash
solana program deploy \
  --url https://api.devnet.solana.com \
  --keypair /external/devnet-payer.json \
  --fee-payer /external/devnet-payer.json \
  --upgrade-authority /external/devnet-payer.json \
  --program-id target/deploy/naryx_core-keypair.json \
  --use-rpc \
  --output json-compact \
  target/deploy/naryx_core.so
```

Run the same command for each program in the synchronized release. The example path is intentionally external and must be replaced with an actual Devnet-only secret path at execution time.

## Evidence and release manifest

After each successful deployment, verify the program through a read-only query:

```bash
solana program show PROGRAM_ID --url https://api.devnet.solana.com --output json
```

Dump the deployed bytes to an external temporary directory and compare their SHA-256 hash with the final artifact. A committed release manifest must record:

- cluster name and observed genesis hash;
- release commit;
- program name, public ID, ProgramData address, deployment slot, and deployment signature;
- artifact SHA-256 and dumped deployed-code SHA-256;
- upgrade authority public key and whether it remains active;
- exact compiler and CLI versions;
- every mock or conformance dependency with an explicit evidence label;
- known limitations, including the absence of a verified Phoenix Rise Devnet deployment;
- a statement that no initialization, market creation, asset funding, or package execution is implied by program deployment.

Commit only the public identity changes and the completed non-secret release manifest. Program keypairs, payer keys, raw CLI logs, temporary dumps, and local deployment records remain untracked.
