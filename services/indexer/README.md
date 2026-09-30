# services/indexer

Chain event indexing, venue fill reconciliation, finality and reorg handling, normalized receipt construction, and evidence-grade attribution.

Read-only with respect to every venue. Holds no signer and has no broadcast path.

May depend on `packages/protocol-types`, `packages/adapter-core`, `packages/adapters/*`, and `deployments`.

Must not depend on `apps/web`, `packages/sdk`, or another service's internals.

Reverted, expired, and recovered packages are indexed and reported, not only successful ones.

## Current slice

`SqliteReceiptIndex` is the durable, read-only index. Chain observations arrive through `ingestBlock` from a domain source; this slice ships no RPC client and never writes to any venue or chain.

- Each domain follows one canonical chain. A block must extend the canonical block one height below, so a source replays a new branch from its fork point. A different block at a canonical height orphans that height and everything above it, and the orphaned events stop contributing. A known orphaned block can become canonical again.
- `advanceFinality` moves confirmation and finality forward only, onto canonical blocks the index holds. A block that would displace finalized history is refused as `FINALIZED_CONFLICT` and nothing is rewritten.
- A known block or venue fill that arrives with different content is refused. Chain events and venue fills are append-only by trigger.
- `ingestVenueFill` records committed venue fills, which are final on arrival and graded `VENUE_API_CORROBORATED`.

`packageRecord` builds the normalized package record from canonical events and committed fills only, hashed under `CON/v1/indexed-package-record`. Each domain leg is judged separately: a settled leg beside a failed leg is `PARTIAL_EXPOSURE` until recovery; contradictory terminal evidence on one domain, or two attempts with effect, is `CONFLICTING_EVIDENCE` for manual review. Reverted, dropped, and expired attempts are indexed and reported. The record's finality is the weakest finality of any contributing event, and its evidence grade is the weakest grade supplied; the indexer never upgrades either. Because only canonical evidence contributes, deleting the index and re-ingesting the canonical chain reproduces the same record hash.

`reconciliationReport` turns package records into an audit and accounting report for a period. Every package is kept, including failed, partial, conflicting, and unresolved ones; partial exposure, recovery in progress, and contradictory evidence are listed as requiring attention, and terminal outcomes that are not yet final are listed as provisional. Each row's fields are committed with caller-supplied random salts, and the report hash under `CON/v1/reconciliation-report` covers the period, the counts, and the row roots only, so the hash can be shared while `discloseReportRow` reveals chosen fields of one row to an auditor, who checks them with `verifySelectiveDisclosure`. `verifyReportHash` recomputes the hash and checks that the counts cover every row. `accountingCsv` is a deterministic export with fixed columns, printable ASCII cells, and CRLF rows.

`runEvmIndexerPass` follows one EVM domain into the index through read-only JSON-RPC (`eth_blockNumber`, `eth_getBlockByNumber`, `eth_getLogs`). It decodes `PackageVerified` and `PackageExecuted` settlement logs from the configured contracts. The receipt hash is the package identity, the transaction hash is the attempt, a recovery settlement is `RECOVERED`, and the fields hash commits to the exact topics and data. When a block does not extend the canonical chain, the pass steps back until one does and replays the branch from there. Confirmation follows the endpoint's `safe` block and finality its `finalized` block, only once the index holds those exact blocks. One endpoint's view is graded `CONTROLLER_ATTESTED`. Two to five independent endpoints must agree on every block's hash, parent, and logs, and their agreed view is graded `VENUE_API_CORROBORATED`. Nothing here claims `CONSENSUS_VERIFIED`, which needs a light client. Reverted submissions emit no settlement log, so they come from the submitting service's attempt records, not from this source.

Performance bonds are indexed from `PerformanceBondVault` logs when `NARYX_INDEXER_EVM_BOND_VAULTS` lists vault addresses. `decodeBondVaultLog` checks every word against its declared width and stamps each event with its block time, the time the vault judged it by; endpoints must agree on vault logs exactly as on settlement logs. `bond(domainId, vault, bondId)` and `bondsForSolver` replay a bond's canonical events in chain order through the kernel's bond rules (coverage, per-claim cap, unencumbered bond, dispute window, one-time release): any transition the kernel refuses, a payment of a different amount or to another beneficiary than the claim named, or a remainder other than the unpaid bond marks the bond `INCONSISTENT` with the exact violations. A reorged vault log drops out of the replay with its block. Observation is not payment authority: the indexer holds no key and files, disputes, or settles nothing.

`src/main.ts` runs the pass on an interval. It is off unless `NARYX_INDEXER_DB` (an absolute path), `NARYX_INDEXER_EVM_DOMAIN`, `NARYX_INDEXER_EVM_RPC_URLS` (1 to 5 https or loopback endpoints, comma separated), `NARYX_INDEXER_EVM_CONTRACTS`, and `NARYX_INDEXER_EVM_START_HEIGHT` are set, with `NARYX_INDEXER_INTERVAL_MS` at least 1000.

```sh
npm test
```

`exportReconciliationReport` (and `node dist/report-cli.js` with the `NARYX_REPORT_*` variables it documents) writes the reconciliation report for every package with a canonical event in a height range: `report.json` with its report hash, the accounting `report.csv`, and `disclosures.json`, readable only by its owner, holding the fresh random salts behind every field commitment so single rows can be disclosed to an auditor later.
