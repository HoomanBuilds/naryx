# packages/protocol-types

The protocol kernel and the bottom of the dependency graph.

- canonical package, order, quote, route, receipt, recovery-receipt, and error schemas;
- canonical encoding and domain-separated hashing;
- exact integer arithmetic for decimals, lots, ticks, spread, margin, and fees;
- terminal states and evidence grades;
- golden test vectors shared with `contracts/solana` and `contracts/evm` through committed fixtures.

Depends on nothing else in this repository. Everything else may depend on it.

Phase 8 readiness policy types provide canonical authority inventories, scoped integer-atom caps,
funded-operation manifests, security finding summaries, and computed readiness decisions. A caller
cannot assert readiness directly: required evidence, roles, caps, validity, and finding state are
validated before the decision can become `READY`.

Funded operations bind exact operation and account commitments, unsigned payload identity,
separate principal and loss budgets, prerequisites, stop conditions, simulation and recovery
evidence, and explicit approvers. Readiness additionally checks aggregate asset and account caps,
signed evidence categories, independent security review, and critical or high finding closure.
Canonical operation-ledger records define reserve, consume, reconcile, and release transitions for
durable service storage without embedding a database implementation in the protocol kernel.

Arithmetic is exact and integer-based. Rounding direction, overflow, zero quantity, expiry, and replay are behavior to be tested, not assumptions.

## Implemented so far

Protocol Canonical Encoding v1 foundations, exact arithmetic, the registry-identity primitives
those schemas reference, and the immutable `DomainManifest`, `AssetManifest`, `VenueManifest`,
`MarketManifest`, `AdapterManifest`, `PriceSourceManifest`, `PackageTemplateManifest`,
`EconomicStrategySeries`, `SeriesExecutionClass`,
`PackageTemplateRegistryRecord`, `DomainRegistryRecord`, `FeePolicyManifest`, `PackageOrder`, and
`SolverQuote` kernels. The composite `RoutePayload` and `PackageReceipt` schemas are not encoded
yet, and neither are the remaining resource manifests. Reusable signed-order primitives now cover
commitment hashes, exact prices and signed rates, versioned adapter references, and fee caps.

- `CanonicalWriter`: fixed-length raw bytes, `u8` through `u256`, `i64`/`i128`/`i256` as
  fixed-width two's-complement big-endian, booleans as exactly `0` or `1`, byte strings and
  UTF-8 strings behind a `u32` byte-length prefix, one-byte optional presence tags, arrays
  behind a `u32` element count, and sets sorted by canonical element bytes that reject
  duplicates.
- `HASH_DOMAIN` and `domainHash`: SHA-256 over raw ASCII domain bytes concatenated directly
  with canonical payload bytes. No JSON, no hidden prefix, no length framing around the domain.
  The set is closed and rejects an unregistered domain. Implemented wire objects use their
  assigned domains, while the remaining entries reserve identities for later schema slices.
- `hash32`, `manifestHash`, `protocolId`, `domainId`, `assetId`, `versionedManifestRef`,
  `domainRef`, `assetRef`, `assetAmount`, `expiry`, `duration`: constructor-validated primitives.
- Frozen discriminant tables: `EXPIRY_UNIT`, `DURATION_UNIT`, `DIRECTION`, `PACKAGE_ACTION`,
  `PACKAGE_ORDER_TYPE`, `PACKAGE_TIME_IN_FORCE`, `RECOVERY_ACTION`, `SETTLEMENT_CLASS`,
  `QUANTITY_POLICY_CLASS`, `PARTIAL_FILL_POLICY`, `REGISTRY_STATE`, `REGISTRY_RECORD_KIND`,
  `RISK_LIMIT_KIND`, `FEE_CATEGORY`, `PASS_THROUGH_COST_CATEGORY`,
  `SERVICE_FEE_RATE_BASE`, `ROUNDING_DIRECTION`, `REFUND_RULE`, `SOLVER_SIGNATURE_SCHEME`,
  `QUOTE_MODE`, and `QUOTED_OUTCOME_KIND`. Discriminant `0` is reserved on every table, so an
  all-zero payload never decodes to a valid variant.

## Solver quote wire object

`SolverQuote` canonically binds one order and route commitment to a solver identity, capability
manifest, verification key, typed entry or exit outcome, expected quantities and costs, exact fee
policy, validity, optional firm reservation, and nonzero quote nonce. Ed25519 and recoverable
secp256k1 signature shapes are validated structurally, including recovery ID and low-s rules. This
package does not perform cryptographic signature verification or admission against a live order,
route, capability, policy, registry, or clock.

Fee vectors are keyed by complete `AssetRef` bytes, arrive in canonical order, share the same
explicit key set, and prove `raw = normalized venue + builder` with checked signed arithmetic.
Atomic quote shape excludes terminal residuals and recovery caps. Residual quote shape requires
both residual values and nonempty recovery caps. The quote hash deliberately prefixes `orderHash`
and `routeHash` before the unsigned quote even though both commitments also occur inside it.

## Registry identity

There is no closed `PACKAGE_KIND` enum. A package type is identified by template identity plus
`packageTemplateManifestHash`, so adding a template means publishing a manifest and a delayed
registry record rather than editing a shared type. `REGISTRY_STATE` carries activation state for
every registry record kind, not just templates.

A protocol identifier is a nonempty ASCII string of at most `PROTOCOL_ID_MAX_BYTES` (128) encoded
bytes. It names a registered subject on the wire - a domain, asset, economic asset, venue, market,
adapter, price source, or template - and is not a user-visible name. Non-ASCII rejects rather than
being transliterated, and nothing is Unicode-normalized. `DomainId` and `AssetId` are named
factories over the same rule.

A `ManifestHash` is a `Hash32` that additionally rejects the all-zero digest, so a zeroed account
or an omitted field cannot pass as a registered manifest. Generic `Hash32` still accepts all-zero,
because zero is a legitimate digest value elsewhere. A constructor takes a hex string or bytes for
ergonomics; an encoder takes 32 canonical nonzero bytes only, so a forged string hash is refused
rather than parsed a second time, and nothing is written when it is refused.

A hash is a `Uint8Array`, and `Object.freeze` does not protect the contents of a typed array. A
constructed `VersionedManifestRef` or `AssetRef` therefore keeps the only copy of its hash and
returns a fresh copy on every read, so mutating what a hash property hands back changes neither
the stored identity nor any later encoding. An `AssetAmount` inherits that through its `AssetRef`.

`VersionedManifestRef` binds `subjectId`, a nonzero `u32` `manifestVersion`, and `manifestHash`, in
that field order. `DomainRef` binds `domainId`, a nonzero `u32` `domainManifestVersion`, and
`domainManifestHash`, in that field order. `AssetRef` binds `assetId`, `assetManifestHash`, and
`decimals`, in that field order. An `AssetAmount` is an `AssetRef` plus signed `i128` atoms, so every amount names the exact
registered asset version it is denominated in. Atoms stay signed because rebates and deltas are
negative.
- `mulDiv`, `scaleDecimals`, `checkedUnsigned`, `checkedSigned`, `absBigInt`, `compareExpiry`,
  `assertU32Length`: exact `BigInt` arithmetic with `FLOOR`, `CEIL`, `TOWARD_ZERO`, and
  `AWAY_FROM_ZERO` named at every call site.

No economic value passes through a JavaScript floating point number. A numeric input is
accepted only when it is a safe integer; every amount, fee, price bound, and expiry is a
`bigint`.

Unicode is never normalized before encoding. Two canonically equivalent strings encode to
different bytes and therefore hash differently.

Expiry is a tagged integer. `compareExpiry` rejects a comparison between two different
expiry units rather than converting between them.

Duration is a positive tagged `u64` elapsed-time bound and is distinct from an absolute expiry.
Version 1 has one canonical unit, milliseconds, so equivalent durations cannot have multiple
wire encodings. Adding another unit requires a reviewed wire-version change.

## Domain identity

A chain is data, not a shared type. There is no `CHAIN` enum, no `RUNTIME_CLASS` enum, no
chain-specific product union, and no flattened chain by venue by asset discriminant in this
package. A domain is a bounded `DomainId` plus the hash of the immutable `DomainManifest` that
states which implemented runtime class, execution verifier, clock model, address codec, and
settlement classes that chain deployment actually runs.

`DomainManifest` canonically binds manifest version, environment, domain identity, runtime-class
identity and version, chain namespace and reference, execution-verifier identity and code hash,
clock model, finality policy hash, address codec, and the exact nonempty settlement-class set. Its
hash is computed from the canonical bytes under `CON/v1/domain-manifest`; callers cannot supply it.

`DomainRef` is what a signed object carries. The identifier alone would be too weak, because one
domain outlives its manifest versions, so binding `domainManifestVersion` and the computed
`domainManifestHash` is what keeps a later domain registration from reinterpreting an order,
quote, route, receipt, or manifest hash signed under an earlier one.

Adding a chain instance under a runtime class that is already implemented is therefore a new
manifest plus deployment and registry records, never an edit here. A genuinely new runtime family
is executable semantics rather than data, and needs reviewed verifier and adapter code before any
manifest registers an instance of it. Constructing or hashing a manifest does not activate a
domain or claim that its runtime class is supported.

## Asset identity

`AssetManifest` binds a chain-scoped asset ID to an exact `DomainRef`, token identity, decimals,
atom unit, minimum transferable atom count, and versioned transfer-semantics identifier. Its
`economicAssetId` is descriptive only and never permits substitution between chain-specific asset
records. Lot size and tick size belong to a market and are intentionally absent. The manifest hash
is computed from canonical bytes under `CON/v1/asset-manifest`, and `assetRefFromManifest` binds
the resulting digest and decimals into the reference carried by amounts and later market records.

## Venue identity

`VenueManifest` canonically binds one venue's version, environment, venue identity, exact domain
reference, venue kind, protocol identity, code identity, and authority identity. It contains no
market identity, assets, lot or tick sizes, minimum notional, price sources, or market-specific
configuration. Adding a market therefore never changes the venue identity. These identifiers bind
already recognized versioned identity; constructing or hashing a manifest does not manufacture
new executable semantics or activate a venue.

## Market identity

`MarketManifest` binds exactly one market to its exact domain, venue manifest, base and quote
asset manifests, market identity, and instrument kind. Its lot, price tick, minimum notional, and
contract multiplier state every unit explicitly with unsigned `u128` integer magnitudes. The
multiplier is a reduced positive rational, never a float or an out-of-manifest scale. Permitted
price sources form a nonempty set sorted by full canonical reference bytes. This kernel checks
canonical shape and internal asset consistency; a later registry and verifier layer is responsible
for confirming that referenced venue, assets, and price sources are active.

## Package template identity

`PackageTemplateManifest` binds one versioned template to exact domain references, schema and risk
policy hashes, compiler versions, ordered leg semantics, and the supported direction, settlement,
and adapter sets. Leg order remains significant while every set is sorted by complete canonical
element bytes and rejects duplicates. Constructing or hashing a template does not activate it or
claim that an unknown template, leg type, or compiler is implemented.

## Strategy series and execution classes

`EconomicStrategySeries` binds one domain-independent payoff to an exact template manifest,
ordered economic underlyings, reduced signed `i128/u128` leg ratios, an accounting asset, a
positive evaluation window, and explicitly supported versioned quote, risk, and lifecycle
semantics. Its leg arrays are bounded and remain ordered because repeated underlyings and leg
position are economically meaningful.

`SeriesExecutionClass` binds one series manifest to complete domain references, recognized venue
classes, collateral mode, settlement class, firmness class, and immutable delivery, recovery, and
matching policies. Domain and venue-class sets are sorted by canonical bytes and reject duplicates.
Qualification and activation state are intentionally absent because they are mutable registry
concerns. Constructing or hashing either schema does not activate a market.

## Package matching and allocation evidence

`PackageMatchingPolicy` is the immutable matching policy an execution class references through
`matchingPolicyHash`. It binds price-time allocation, direct-before-implied priority at one price,
the self-match and common-control policy, the amendment priority rule, the package quantity
increment and minimum execution quantity, and the maximum implication depth. Only implemented
variants exist, and implication deeper than one leg-sourced level fails closed.

`matchPackageOrder` is a deterministic matcher over one execution-class book. Resting liquidity
fills best price first, direct before implied at equal price, then by assigned sequence, always at
the resting price. Fills are lot-aligned and may be partial for direct liquidity. IOC, FOK, GTC, GTD,
post-only, and package minimum quantity are enforced against the complete package. A rejected
order leaves the book untouched, and a remainder rests only when it cannot cross the book.

`deriveImpliedPackageQuote` builds implied-in liquidity from leg sources with every leg term rounded
against the taker. Indicative implication is never executable depth. Reservation-backed and
solver-backed implied liquidity fills all or nothing, consumes each source reservation or solver
commitment at most once, invalidates every sibling built on a consumed source, and is removed when
`invalidateImpliedSource` observes a newer source version.

Every accepted match produces a `PackageAllocation`. `verifyPackageAllocation` recomputes quantity
conservation (`requested = direct fills + implied fills + rested + cancelled`), contiguous fill
sequences, price, source, and time priority, taker limits, and single source consumption before the
allocation is hashed under `CON/v1/package-allocation`. `packageBookState` revalidates any stored or
caller-supplied book against its policy.

## Solver network

`SolverCapabilityManifest` binds a solver identity and common-control group to its operator
identity key, purpose-scoped quote and RFQ keys with non-overlapping validity intervals, and the
exact domains, templates, quote modes, per-market notional caps, and endpoints it serves. The
operator signs `solverCapabilityManifestHash`, which excludes the signature. `authorizeSolverQuote`
checks scope only and returns one deterministic rejection reason; the caller verifies the signature.

`SolverCapacityRecord` states evidence-scoped available capacity and recovery capacity for one
solver, domain, and asset. A capacity ledger debits commitments against that evidence, refuses a
firm commitment unless the evidence is onchain, and reports an order-independent outstanding
commitment root. When commitments exceed refreshed evidence or the evidence expires, the ledger is
reduce-only: new commitments stop while releases continue. Qualification evaluation reads raw
metrics, can only keep or lower a solver's state, and never hides them in a composite score.
Promotion requires two distinct reviewers.

`decideRfq` turns multi-dealer responses into a replayable decision hashed under
`CON/v1/rfq-decision`. Each response is ranked inside its settlement and risk class by fee-complete
net outcome, then firmness, arrival, and quote hash, or excluded with one reason. Firm responses
need active capacity. `independentOrganizations` counts common-control groups, not keys.

`generateMakerQuotes` prices a maker quote surface from one reference in constant time per level,
skews against inventory, clips each side so fills cannot breach the inventory limit, and returns
nothing under a market or portfolio kill switch. Performance bonds cover only named objective
faults, claim each fault evidence hash once, cap payouts per claim and in aggregate, pay after an
undisputed window or an explicit resolution, and release the unpaid remainder once after expiry.

## Price source identity

`PriceSourceManifest` binds one price source to an exact domain, feed identity, source kind,
price decimals and convention, a positive millisecond freshness bound, and an explicit fallback
rule. `no-fallback-v1` names the absence of a fallback rather than leaving it optional or inferred.
The manifest defines immutable identity only; it neither activates a source nor proves a live
observation is fresh.

## Adapter identity

`AdapterManifest` binds one recognized adapter class and version to an exact domain, venue,
code identity, supported market, asset, leg, settlement and template upper bounds, accounting
schema, and a canonical account and authority map. Each binding states how an account and its
authority are resolved, which access modes are allowed, and which signer rule applies. The map
cannot authorize arbitrary calls or account lists; executable instruction, selector and action
semantics remain in the pinned adapter class and fail closed when a binding is missing or extra.

## Package template registry

`PackageTemplateRegistryRecord` binds one template manifest to an exact domain, environment,
activation point, registry state, and governance reference. Its activation unit and unsigned
`u64` value use the expiry tag rules, but this identity layer does not interpret the domain clock,
check current time, or activate the template. The enforcing controller owns those policies.

Registry risk limits bind an exact asset manifest and unsigned `u128` atom capacity. Outflow
limits additionally bind a positive millisecond window. Change classification compares exact
rational throughput with checked `u128` cross-products; an overflow or identity mismatch is a
relaxation, never an immediate tightening. Registry lists are accepted only in canonical order
and reject duplicate keys rather than sorting governance input silently.

`DomainRegistryRecord` binds one asset, venue, market, adapter, or price-source manifest to its
exact domain, environment, activation point, state, risk limits, permitted templates, settlement
classes, and governance reference. Empty policy lists are explicit fail-closed inputs rather than
implicit permission. The `PACKAGE_TEMPLATE` kind remains reserved but rejects here because
`PackageTemplateRegistryRecord` is the sole version 1 activation authority for templates. This
identity kernel validates and hashes the record; the domain controller separately enforces clock,
delay, active-reference, and lifecycle policy.

## Fee policy rules

Service fee rules bind one protocol, solver, or builder charge to an exact asset manifest. A rule
is either a signed `i128` rate over matched package notional or a signed fixed-atom amount, never
both. Fixed rules use the version 1 scale and rounding sentinels. Pass-through rules are separate
unsigned `u128` caps for actual venue, network, or recovery cost and always refund unused prepaid
atoms to the owner. Both rule lists must arrive in canonical `(category, assetId)` order and reject
duplicate keys even when another field differs. `FeePolicyManifest` binds these arrays to one exact
domain, activation interval, direction, and optional promotion cohort. Unscoped manifests are
zero-fee fallbacks only, and optional expiry is same-unit, half-open, and strictly after activation.
This identity kernel does not select a policy or settle a charge.

## Package order wire

`PackageOrder` binds the exact template, owner, settlement account, nonce, expiry, package behavior,
typed quantities and limits, fee caps, permitted adapters, settlement class, and ordered recovery
authorization into canonical bytes under `CON/v1/order`. Fee-cap and adapter collections must arrive
in canonical order, while recovery actions preserve signed sequence order and may repeat. The
constructor defensively copies hashes and nested values, and the encoder revalidates runtime objects
before writing.

This layer validates canonical shape, fixed widths, nonzero versions, enum membership, and collection
ordering only. `validatePackageOrderProfile` is the separate semantic gate for ENTRY and EXIT shapes,
exact asset relationships, the activated atomic Solana and EVM profile, and the Hyperliquid batched
IOC recovery profile. It enforces the initial marketable-limit activation policy plus exact-net and
bounded-net quantity rules without changing generic canonical bytes. Registry activity, venue state,
and live domain configuration remain verifier work and are not implied by successful validation.

## Failure modes

Every public failure is a typed `ProtocolError` with a stable `code`:

| Code | Raised for |
|---|---|
| `RANGE` | an integer outside its fixed width, a collection length above `u32`, decimals outside `u8`, a protocol identifier above 128 bytes, a number outside the safe integer range |
| `MALFORMED` | malformed hex, a wrong fixed-byte length, a manifest hash reaching an encoder as anything but 32 bytes, ill-formed UTF-16, a non-ASCII or empty protocol identifier, an all-zero manifest hash, a zero manifest version, an optional tag that is neither `0` nor `1`, an unknown enum variant, a non-integer number |
| `DUPLICATE` | two set elements with identical canonical bytes |
| `INCOMPATIBLE_UNIT` | a comparison between two different expiry units |
| `DIVISION_BY_ZERO` | a zero divisor |

## Golden vectors

`fixtures/encoding.json`, `fixtures/hashing.json`, `fixtures/arithmetic.json`,
`fixtures/domain-manifest.json`, `fixtures/asset-manifest.json`, and
`fixtures/venue-manifest.json`, `fixtures/market-manifest.json`, and
`fixtures/adapter-manifest.json`, `fixtures/package-template-manifest.json`,
`fixtures/economic-strategy-series.json`, `fixtures/series-execution-class.json`,
`fixtures/price-source-manifest.json`, `fixtures/package-template-registry-record.json`,
`fixtures/domain-registry-record.json`, `fixtures/fee-policy-manifest.json`, and
`fixtures/package-order-atomic.json`, `fixtures/package-order-hyperliquid-exit.json`, and
`fixtures/solver-quote.json`, `fixtures/package-matching-policy.json`, and
`fixtures/solver-capability-manifest.json` hold
language-neutral inputs and fixed expected outputs
for the Rust, Solidity, and controller implementations of the same wire format. JSON carries the
fixtures; JSON is never hashed, and wide or version integers in a fixture are decimal strings.
Expected hex and digest values are committed constants, not values
regenerated by the implementation under test.

## What a hash does not prove

A canonical hash proves consistency with the exact bytes supplied to it. It does not prove
that those bytes describe an executed action, and it does not prove their venue origin.

## Commands

```bash
npm run build
npm test
npm pack --dry-run
```
