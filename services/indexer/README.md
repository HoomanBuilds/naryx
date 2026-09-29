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

```sh
npm test
```
