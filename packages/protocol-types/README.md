# packages/protocol-types

The protocol kernel and the bottom of the dependency graph.

- canonical package, order, quote, route, receipt, recovery-receipt, and error schemas;
- canonical encoding and domain-separated hashing;
- exact integer arithmetic for decimals, lots, ticks, spread, margin, and fees;
- terminal states and evidence grades;
- golden test vectors shared with `contracts/solana` and `contracts/evm` through committed fixtures.

Depends on nothing else in this repository. Everything else may depend on it.

Arithmetic is exact and integer-based. Rounding direction, overflow, zero quantity, expiry, and replay are behavior to be tested, not assumptions.

## Implemented so far

Protocol Canonical Encoding v1 foundations, exact arithmetic, and the registry-identity
primitives those schemas reference. The composite `PackageOrder`, `RoutePayload`, `SolverQuote`,
and `PackageReceipt` schemas are not encoded yet, and neither are the manifests and registry
records themselves; only the immutable references to them are.

- `CanonicalWriter`: fixed-length raw bytes, `u8` through `u256`, `i64`/`i128`/`i256` as
  fixed-width two's-complement big-endian, booleans as exactly `0` or `1`, byte strings and
  UTF-8 strings behind a `u32` byte-length prefix, one-byte optional presence tags, arrays
  behind a `u32` element count, and sets sorted by canonical element bytes that reject
  duplicates.
- `HASH_DOMAIN` and `domainHash`: SHA-256 over raw ASCII domain bytes concatenated directly
  with canonical payload bytes. No JSON, no hidden prefix, no length framing around the domain.
  The set is closed and rejects an unregistered domain. The asset, venue, market, adapter,
  price-source, domain-registry-record, and fee-policy domains are reserved; the slices that
  implement those schemas encode payloads under them.
- `hash32`, `manifestHash`, `protocolId`, `domainId`, `assetId`, `versionedManifestRef`,
  `assetRef`, `assetAmount`, `expiry`: constructor-validated primitives.
- Frozen discriminant tables: `EXPIRY_UNIT`, `DIRECTION`, `PACKAGE_ACTION`, `SETTLEMENT_CLASS`,
  `QUANTITY_POLICY_CLASS`, `PARTIAL_FILL_POLICY`, `REGISTRY_STATE`, `REGISTRY_RECORD_KIND`,
  `RISK_LIMIT_KIND`, `FEE_CATEGORY`, and `PASS_THROUGH_COST_CATEGORY`. Discriminant `0` is
  reserved on every table, so an all-zero payload never decodes to a valid variant.

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
that field order. `AssetRef` binds `assetId`, `assetManifestHash`, and `decimals`, in that field
order. An `AssetAmount` is an `AssetRef` plus signed `i128` atoms, so every amount names the exact
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

`fixtures/encoding.json`, `fixtures/hashing.json`, and `fixtures/arithmetic.json` hold
language-neutral inputs and fixed expected outputs for the Rust, Solidity, and controller
implementations of the same wire format. JSON carries the fixtures; JSON is never hashed, and
every integer in a fixture is a decimal string. Expected hex and digest values are committed
constants, not values regenerated by the implementation under test.

## What a hash does not prove

A canonical hash proves consistency with the exact bytes supplied to it. It does not prove
that those bytes describe an executed action, and it does not prove their venue origin.

## Commands

```bash
npm run build
npm test
npm pack --dry-run
```
