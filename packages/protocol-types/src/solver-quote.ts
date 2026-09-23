import { checkedSigned, checkedUnsigned } from './arithmetic.js';
import { bytesEqual, compareBytes, concatBytes } from './bytes.js';
import { canonicalBytes, CanonicalWriter } from './encoding.js';
import {
  enumDiscriminant,
  EXPIRY_UNIT,
  QUOTED_OUTCOME_KIND,
  QUOTE_MODE,
  SOLVER_SIGNATURE_SCHEME,
  type ExpiryUnit,
  type QuoteMode,
  type SolverSignatureScheme,
} from './enums.js';
import { DuplicateElementError, MalformedInputError } from './errors.js';
import { HASH_DOMAIN, domainHash } from './hashing.js';
import {
  commitmentHash,
  encodeCommitmentHash,
  encodeExactSignedRate,
  encodeFeeCap,
  exactSignedRate,
  feeCap,
  type CommitmentHash,
  type ExactSignedRate,
  type ExactSignedRateInput,
  type FeeCap,
  type FeeCapInput,
} from './package-order-primitives.js';
import {
  assetAmount,
  domainRef,
  encodeAssetAmount,
  encodeAssetRef,
  encodeDomainRef,
  encodeManifestHash,
  encodeProtocolId,
  expiry,
  manifestHash,
  protocolId,
  type AssetAmount,
  type AssetRef,
  type DomainRef,
  type Hash32,
  type ManifestHash,
  type ProtocolId,
} from './primitives.js';

const VERSION = 1;
const U32_BITS = 32;
const U256_BITS = 256;
const SECP256K1_ORDER =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SECP256K1_HALF_ORDER =
  0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

export type QuotedOutcomeInput =
  | Readonly<{
      kind: 'ENTRY_SPREAD';
      entrySpread: ExactSignedRateInput;
    }>
  | Readonly<{
      kind: 'EXIT_QUOTE_OUTCOME';
      exitQuoteOutcome: AssetAmount;
    }>;

export type QuotedOutcome =
  | Readonly<{
      kind: 'ENTRY_SPREAD';
      entrySpread: ExactSignedRate;
    }>
  | Readonly<{
      kind: 'EXIT_QUOTE_OUTCOME';
      exitQuoteOutcome: AssetAmount;
    }>;

export interface SolverQuoteInput {
  readonly version: number;
  readonly environment: string;
  readonly domain: DomainRef;
  readonly orderHash: Uint8Array | string;
  readonly solverId: string;
  readonly solverCapabilityManifestHash: Uint8Array | string;
  readonly solverSignatureScheme: SolverSignatureScheme;
  readonly solverVerificationKey: Uint8Array;
  readonly quoteMode: QuoteMode;
  readonly routeHash: Uint8Array | string;
  readonly quotedOutcome: QuotedOutcomeInput;
  readonly expectedSpotNotional: AssetAmount;
  readonly expectedPerpNotional: AssetAmount;
  readonly expectedGrossSpotQuantity: AssetAmount;
  readonly expectedNetSpotQuantity: AssetAmount;
  readonly expectedBaseAssetFee: AssetAmount;
  readonly expectedTerminalResidualBaseQuantity?: AssetAmount;
  readonly expectedTerminalResidualQuoteValue?: AssetAmount;
  readonly expectedMarginDelta: AssetAmount;
  readonly expectedRawFillFeesByAsset: readonly AssetAmount[];
  readonly expectedBuilderFeesByAsset: readonly AssetAmount[];
  readonly expectedNormalizedVenueFeesByAsset: readonly AssetAmount[];
  readonly solverFee: AssetAmount;
  readonly protocolFee: AssetAmount;
  readonly expectedPriorityFee: AssetAmount;
  readonly maxRecoveryCostAtomsByAsset: readonly FeeCapInput[];
  readonly feePolicyVersion: number;
  readonly feePolicyManifestHash: Uint8Array | string;
  readonly validUntilUnit: ExpiryUnit;
  readonly validUntilValue: bigint;
  readonly reservationId?: Uint8Array | string;
  readonly quoteNonce: bigint;
  readonly signature: Uint8Array;
}

export interface SolverQuote {
  readonly version: 1;
  readonly environment: ProtocolId;
  readonly domain: DomainRef;
  readonly orderHash: CommitmentHash;
  readonly solverId: ProtocolId;
  readonly solverCapabilityManifestHash: ManifestHash;
  readonly solverSignatureScheme: SolverSignatureScheme;
  readonly solverVerificationKey: Uint8Array;
  readonly quoteMode: QuoteMode;
  readonly routeHash: CommitmentHash;
  readonly quotedOutcome: QuotedOutcome;
  readonly expectedSpotNotional: AssetAmount;
  readonly expectedPerpNotional: AssetAmount;
  readonly expectedGrossSpotQuantity: AssetAmount;
  readonly expectedNetSpotQuantity: AssetAmount;
  readonly expectedBaseAssetFee: AssetAmount;
  readonly expectedTerminalResidualBaseQuantity?: AssetAmount;
  readonly expectedTerminalResidualQuoteValue?: AssetAmount;
  readonly expectedMarginDelta: AssetAmount;
  readonly expectedRawFillFeesByAsset: readonly AssetAmount[];
  readonly expectedBuilderFeesByAsset: readonly AssetAmount[];
  readonly expectedNormalizedVenueFeesByAsset: readonly AssetAmount[];
  readonly solverFee: AssetAmount;
  readonly protocolFee: AssetAmount;
  readonly expectedPriorityFee: AssetAmount;
  readonly maxRecoveryCostAtomsByAsset: readonly FeeCap[];
  readonly feePolicyVersion: number;
  readonly feePolicyManifestHash: ManifestHash;
  readonly validUntilUnit: ExpiryUnit;
  readonly validUntilValue: bigint;
  readonly reservationId?: CommitmentHash;
  readonly quoteNonce: bigint;
  readonly signature: Uint8Array;
}

function checkedObject(value: unknown, context: string): void {
  if (typeof value !== 'object' || value === null) {
    throw new MalformedInputError(context, 'expected an object');
  }
}

function checkedVersion(value: number, context: string): 1 {
  if (typeof value !== 'number') {
    throw new MalformedInputError(context, 'expected a number');
  }
  const checked = checkedUnsigned(value, U32_BITS, context);
  if (checked !== BigInt(VERSION)) {
    throw new MalformedInputError(context, `expected version ${VERSION}`);
  }
  return VERSION;
}

function nonzeroU32(value: number, context: string): number {
  if (typeof value !== 'number') {
    throw new MalformedInputError(context, 'expected a number');
  }
  const checked = checkedUnsigned(value, U32_BITS, context);
  if (checked === 0n) {
    throw new MalformedInputError(context, 'version is zero');
  }
  return Number(checked);
}

function nonzeroU256(value: bigint, context: string): bigint {
  if (typeof value !== 'bigint') {
    throw new MalformedInputError(context, 'expected a bigint');
  }
  const checked = checkedUnsigned(value, U256_BITS, context);
  if (checked === 0n) {
    throw new MalformedInputError(context, 'nonce is zero');
  }
  return checked;
}

function checkedAssetAmount(value: AssetAmount, context: string): AssetAmount {
  checkedObject(value, context);
  return assetAmount(value.asset, value.atoms, context);
}

function positiveAssetAmount(value: AssetAmount, context: string): AssetAmount {
  const checked = checkedAssetAmount(value, context);
  if (checked.atoms <= 0n) {
    throw new MalformedInputError(`${context}.atoms`, 'expected a positive amount');
  }
  return checked;
}

function assetKey(value: AssetRef): Uint8Array {
  return canonicalBytes((writer) => encodeAssetRef(writer, value));
}

function sameAsset(left: AssetRef, right: AssetRef): boolean {
  return bytesEqual(assetKey(left), assetKey(right));
}

function requireAsset(value: AssetAmount, expected: AssetRef, context: string): void {
  if (!sameAsset(value.asset, expected)) {
    throw new MalformedInputError(context, 'asset does not match the package asset');
  }
}

function canonicalAssetAmounts(
  values: readonly AssetAmount[],
  context: string,
): readonly AssetAmount[] {
  if (!Array.isArray(values)) {
    throw new MalformedInputError(context, 'expected an array');
  }
  const checked = values.map((value, index) =>
    checkedAssetAmount(value, `${context}[${index}]`),
  );
  for (let index = 1; index < checked.length; index += 1) {
    const relation = compareBytes(
      assetKey(checked[index - 1]!.asset),
      assetKey(checked[index]!.asset),
    );
    if (relation === 0) {
      throw new DuplicateElementError(context, `duplicate asset at index ${index}`);
    }
    if (relation > 0) {
      throw new MalformedInputError(context, `noncanonical ordering at index ${index}`);
    }
  }
  return Object.freeze(checked);
}

function requireSameAssetKeys(
  left: readonly AssetAmount[],
  right: readonly AssetAmount[],
  context: string,
): void {
  if (left.length !== right.length) {
    throw new MalformedInputError(context, 'fee arrays have different asset-key sets');
  }
  for (let index = 0; index < left.length; index += 1) {
    if (!sameAsset(left[index]!.asset, right[index]!.asset)) {
      throw new MalformedInputError(context, 'fee arrays have different asset-key sets');
    }
  }
}

function canonicalRecoveryCaps(
  values: readonly FeeCapInput[],
  context: string,
): readonly FeeCap[] {
  if (!Array.isArray(values)) {
    throw new MalformedInputError(context, 'expected an array');
  }
  const checked = values.map((value, index) => {
    const cap = feeCap(value, `${context}[${index}]`);
    if (cap.maxAtoms < 0n) {
      throw new MalformedInputError(`${context}[${index}].maxAtoms`, 'expected a nonnegative cap');
    }
    return cap;
  });
  for (let index = 1; index < checked.length; index += 1) {
    const relation = compareBytes(
      assetKey(checked[index - 1]!.asset),
      assetKey(checked[index]!.asset),
    );
    if (relation === 0) {
      throw new DuplicateElementError(context, `duplicate asset at index ${index}`);
    }
    if (relation > 0) {
      throw new MalformedInputError(context, `noncanonical ordering at index ${index}`);
    }
  }
  return Object.freeze(checked);
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function checkedSignatureMaterial(
  scheme: SolverSignatureScheme,
  verificationKey: Uint8Array,
  signature: Uint8Array,
  context: string,
): Readonly<{ verificationKey: Uint8Array; signature: Uint8Array }> {
  enumDiscriminant(SOLVER_SIGNATURE_SCHEME, scheme, `${context}.solverSignatureScheme`);
  if (!(verificationKey instanceof Uint8Array)) {
    throw new MalformedInputError(`${context}.solverVerificationKey`, 'expected a Uint8Array');
  }
  if (!(signature instanceof Uint8Array)) {
    throw new MalformedInputError(`${context}.signature`, 'expected a Uint8Array');
  }
  if (scheme === 'ED25519') {
    if (verificationKey.length !== 32) {
      throw new MalformedInputError(`${context}.solverVerificationKey`, 'expected 32 bytes');
    }
    if (signature.length !== 64) {
      throw new MalformedInputError(`${context}.signature`, 'expected 64 bytes');
    }
  } else {
    if (verificationKey.length !== 20) {
      throw new MalformedInputError(`${context}.solverVerificationKey`, 'expected 20 bytes');
    }
    if (signature.length !== 65) {
      throw new MalformedInputError(`${context}.signature`, 'expected 65 bytes');
    }
    const r = bytesToBigInt(signature.subarray(0, 32));
    const s = bytesToBigInt(signature.subarray(32, 64));
    const recoveryId = signature[64];
    if (r === 0n || r >= SECP256K1_ORDER) {
      throw new MalformedInputError(`${context}.signature.r`, 'scalar is outside secp256k1 range');
    }
    if (s === 0n || s > SECP256K1_HALF_ORDER) {
      throw new MalformedInputError(`${context}.signature.s`, 'signature is not low-s');
    }
    if (recoveryId !== 0 && recoveryId !== 1) {
      throw new MalformedInputError(`${context}.signature.recoveryId`, 'expected 0 or 1');
    }
  }
  return Object.freeze({
    verificationKey: Uint8Array.from(verificationKey),
    signature: Uint8Array.from(signature),
  });
}

export function quotedOutcome(
  input: QuotedOutcomeInput,
  context = 'quotedOutcome',
): QuotedOutcome {
  checkedObject(input, context);
  enumDiscriminant(QUOTED_OUTCOME_KIND, input.kind, `${context}.kind`);
  if (input.kind === 'ENTRY_SPREAD') {
    return Object.freeze({
      kind: input.kind,
      entrySpread: exactSignedRate(input.entrySpread, `${context}.entrySpread`),
    });
  }
  return Object.freeze({
    kind: input.kind,
    exitQuoteOutcome: checkedAssetAmount(
      input.exitQuoteOutcome,
      `${context}.exitQuoteOutcome`,
    ),
  });
}

export function encodeQuotedOutcome(writer: CanonicalWriter, value: QuotedOutcome): void {
  const checked = quotedOutcome(value, 'quotedOutcome');
  writer.writeEnum(QUOTED_OUTCOME_KIND, checked.kind, 'quotedOutcome.kind');
  if (checked.kind === 'ENTRY_SPREAD') {
    encodeExactSignedRate(writer, checked.entrySpread);
  } else {
    encodeAssetAmount(writer, checked.exitQuoteOutcome);
  }
}

function quoteAssets(outcome: QuotedOutcome, gross: AssetAmount): Readonly<{
  base: AssetRef;
  quote: AssetRef;
}> {
  if (outcome.kind === 'ENTRY_SPREAD') {
    return Object.freeze({
      base: outcome.entrySpread.baseAsset,
      quote: outcome.entrySpread.quoteAsset,
    });
  }
  return Object.freeze({ base: gross.asset, quote: outcome.exitQuoteOutcome.asset });
}

function frozenSolverQuote(
  fields: Omit<
    SolverQuote,
    | 'orderHash'
    | 'solverCapabilityManifestHash'
    | 'solverVerificationKey'
    | 'routeHash'
    | 'feePolicyManifestHash'
    | 'reservationId'
    | 'signature'
  >,
  hashes: Readonly<{
    orderHash: CommitmentHash;
    solverCapabilityManifestHash: ManifestHash;
    routeHash: CommitmentHash;
    feePolicyManifestHash: ManifestHash;
    reservationId?: CommitmentHash;
  }>,
  verificationKey: Uint8Array,
  signature: Uint8Array,
): SolverQuote {
  const orderHash = Uint8Array.from(hashes.orderHash) as CommitmentHash;
  const capabilityHash = Uint8Array.from(
    hashes.solverCapabilityManifestHash,
  ) as ManifestHash;
  const routeHash = Uint8Array.from(hashes.routeHash) as CommitmentHash;
  const feePolicyHash = Uint8Array.from(hashes.feePolicyManifestHash) as ManifestHash;
  const reservationId =
    hashes.reservationId === undefined
      ? undefined
      : (Uint8Array.from(hashes.reservationId) as CommitmentHash);
  const quote = {
    ...fields,
    get orderHash(): CommitmentHash {
      return Uint8Array.from(orderHash) as CommitmentHash;
    },
    get solverCapabilityManifestHash(): ManifestHash {
      return Uint8Array.from(capabilityHash) as ManifestHash;
    },
    get solverVerificationKey(): Uint8Array {
      return Uint8Array.from(verificationKey);
    },
    get routeHash(): CommitmentHash {
      return Uint8Array.from(routeHash) as CommitmentHash;
    },
    get feePolicyManifestHash(): ManifestHash {
      return Uint8Array.from(feePolicyHash) as ManifestHash;
    },
    get signature(): Uint8Array {
      return Uint8Array.from(signature);
    },
  };
  if (reservationId !== undefined) {
    Object.defineProperty(quote, 'reservationId', {
      enumerable: true,
      get(): CommitmentHash {
        return Uint8Array.from(reservationId) as CommitmentHash;
      },
    });
  }
  return Object.freeze(quote) as SolverQuote;
}

export function solverQuote(input: SolverQuoteInput, context = 'solverQuote'): SolverQuote {
  checkedObject(input, context);
  checkedObject(input.domain, `${context}.domain`);
  const version = checkedVersion(input.version, `${context}.version`);
  const environment = protocolId(input.environment, `${context}.environment`);
  const domain = domainRef(
    input.domain.domainId,
    input.domain.domainManifestVersion,
    input.domain.domainManifestHash,
    `${context}.domain`,
  );
  const orderHash = commitmentHash(input.orderHash, `${context}.orderHash`);
  const solverId = protocolId(input.solverId, `${context}.solverId`);
  const solverCapabilityManifestHash = manifestHash(
    input.solverCapabilityManifestHash,
    `${context}.solverCapabilityManifestHash`,
  );
  enumDiscriminant(
    SOLVER_SIGNATURE_SCHEME,
    input.solverSignatureScheme,
    `${context}.solverSignatureScheme`,
  );
  enumDiscriminant(QUOTE_MODE, input.quoteMode, `${context}.quoteMode`);
  const routeHash = commitmentHash(input.routeHash, `${context}.routeHash`);
  const outcome = quotedOutcome(input.quotedOutcome, `${context}.quotedOutcome`);
  const expectedSpotNotional = positiveAssetAmount(
    input.expectedSpotNotional,
    `${context}.expectedSpotNotional`,
  );
  const expectedPerpNotional = positiveAssetAmount(
    input.expectedPerpNotional,
    `${context}.expectedPerpNotional`,
  );
  const expectedGrossSpotQuantity = positiveAssetAmount(
    input.expectedGrossSpotQuantity,
    `${context}.expectedGrossSpotQuantity`,
  );
  const assets = quoteAssets(outcome, expectedGrossSpotQuantity);
  const expectedNetSpotQuantity = checkedAssetAmount(
    input.expectedNetSpotQuantity,
    `${context}.expectedNetSpotQuantity`,
  );
  const expectedBaseAssetFee = checkedAssetAmount(
    input.expectedBaseAssetFee,
    `${context}.expectedBaseAssetFee`,
  );
  const expectedMarginDelta = checkedAssetAmount(
    input.expectedMarginDelta,
    `${context}.expectedMarginDelta`,
  );
  const solverFee = checkedAssetAmount(input.solverFee, `${context}.solverFee`);
  const protocolFee = checkedAssetAmount(input.protocolFee, `${context}.protocolFee`);
  const expectedPriorityFee = checkedAssetAmount(
    input.expectedPriorityFee,
    `${context}.expectedPriorityFee`,
  );
  requireAsset(expectedSpotNotional, assets.quote, `${context}.expectedSpotNotional.asset`);
  requireAsset(expectedPerpNotional, assets.quote, `${context}.expectedPerpNotional.asset`);
  requireAsset(
    expectedGrossSpotQuantity,
    assets.base,
    `${context}.expectedGrossSpotQuantity.asset`,
  );
  requireAsset(expectedNetSpotQuantity, assets.base, `${context}.expectedNetSpotQuantity.asset`);
  requireAsset(expectedBaseAssetFee, assets.base, `${context}.expectedBaseAssetFee.asset`);
  requireAsset(expectedMarginDelta, assets.quote, `${context}.expectedMarginDelta.asset`);
  requireAsset(solverFee, assets.quote, `${context}.solverFee.asset`);
  requireAsset(protocolFee, assets.quote, `${context}.protocolFee.asset`);

  const rawFees = canonicalAssetAmounts(
    input.expectedRawFillFeesByAsset,
    `${context}.expectedRawFillFeesByAsset`,
  );
  const builderFees = canonicalAssetAmounts(
    input.expectedBuilderFeesByAsset,
    `${context}.expectedBuilderFeesByAsset`,
  );
  const normalizedFees = canonicalAssetAmounts(
    input.expectedNormalizedVenueFeesByAsset,
    `${context}.expectedNormalizedVenueFeesByAsset`,
  );
  requireSameAssetKeys(rawFees, builderFees, `${context}.expectedBuilderFeesByAsset`);
  requireSameAssetKeys(
    rawFees,
    normalizedFees,
    `${context}.expectedNormalizedVenueFeesByAsset`,
  );
  for (let index = 0; index < rawFees.length; index += 1) {
    const combined = checkedSigned(
      normalizedFees[index]!.atoms + builderFees[index]!.atoms,
      128,
      `${context}.expectedRawFillFeesByAsset[${index}].atoms`,
    );
    if (combined !== rawFees[index]!.atoms) {
      throw new MalformedInputError(
        `${context}.expectedRawFillFeesByAsset[${index}].atoms`,
        'raw fee does not equal normalized venue fee plus builder fee',
      );
    }
  }
  const rawBaseFee = rawFees.find((fee) => sameAsset(fee.asset, assets.base));
  if (rawBaseFee === undefined || rawBaseFee.atoms !== expectedBaseAssetFee.atoms) {
    throw new MalformedInputError(
      `${context}.expectedBaseAssetFee`,
      'amount does not match the raw base-asset fee entry',
    );
  }

  const recoveryCaps = canonicalRecoveryCaps(
    input.maxRecoveryCostAtomsByAsset,
    `${context}.maxRecoveryCostAtomsByAsset`,
  );
  const hasResidualBase = input.expectedTerminalResidualBaseQuantity !== undefined;
  const hasResidualQuote = input.expectedTerminalResidualQuoteValue !== undefined;
  if (hasResidualBase !== hasResidualQuote) {
    throw new MalformedInputError(context, 'terminal residual fields must be both present or absent');
  }
  const residualBase = hasResidualBase
    ? checkedAssetAmount(
        input.expectedTerminalResidualBaseQuantity!,
        `${context}.expectedTerminalResidualBaseQuantity`,
      )
    : undefined;
  const residualQuote = hasResidualQuote
    ? checkedAssetAmount(
        input.expectedTerminalResidualQuoteValue!,
        `${context}.expectedTerminalResidualQuoteValue`,
      )
    : undefined;
  if (residualBase !== undefined) {
    requireAsset(
      residualBase,
      assets.base,
      `${context}.expectedTerminalResidualBaseQuantity.asset`,
    );
    requireAsset(
      residualQuote!,
      assets.quote,
      `${context}.expectedTerminalResidualQuoteValue.asset`,
    );
    if (recoveryCaps.length === 0) {
      throw new MalformedInputError(
        `${context}.maxRecoveryCostAtomsByAsset`,
        'residual quotes require nonempty recovery caps',
      );
    }
  } else if (recoveryCaps.length !== 0) {
    throw new MalformedInputError(
      `${context}.maxRecoveryCostAtomsByAsset`,
      'atomic quotes cannot carry recovery caps',
    );
  }

  const isFirm = input.quoteMode === 'FIRM_SIMULATED' || input.quoteMode === 'FIRM_ONCHAIN';
  const hasReservation = input.reservationId !== undefined;
  if (isFirm !== hasReservation) {
    throw new MalformedInputError(
      `${context}.reservationId`,
      'reservation is required exactly for firm quote modes',
    );
  }
  if (isFirm && (outcome.kind !== 'ENTRY_SPREAD' || residualBase !== undefined)) {
    throw new MalformedInputError(context, 'firm quotes require atomic entry outcomes');
  }
  const reservationId = hasReservation
    ? commitmentHash(input.reservationId!, `${context}.reservationId`)
    : undefined;
  const feePolicyVersion = nonzeroU32(
    input.feePolicyVersion,
    `${context}.feePolicyVersion`,
  );
  const feePolicyManifestHash = manifestHash(
    input.feePolicyManifestHash,
    `${context}.feePolicyManifestHash`,
  );
  const validUntil = expiry(
    input.validUntilUnit,
    input.validUntilValue,
    `${context}.validUntil`,
  );
  const quoteNonce = nonzeroU256(input.quoteNonce, `${context}.quoteNonce`);
  const signatureMaterial = checkedSignatureMaterial(
    input.solverSignatureScheme,
    input.solverVerificationKey,
    input.signature,
    context,
  );

  const optionalResiduals =
    residualBase === undefined
      ? {}
      : {
          expectedTerminalResidualBaseQuantity: residualBase,
          expectedTerminalResidualQuoteValue: residualQuote!,
        };
  return frozenSolverQuote(
    {
      version,
      environment,
      domain,
      solverId,
      solverSignatureScheme: input.solverSignatureScheme,
      quoteMode: input.quoteMode,
      quotedOutcome: outcome,
      expectedSpotNotional,
      expectedPerpNotional,
      expectedGrossSpotQuantity,
      expectedNetSpotQuantity,
      expectedBaseAssetFee,
      ...optionalResiduals,
      expectedMarginDelta,
      expectedRawFillFeesByAsset: rawFees,
      expectedBuilderFeesByAsset: builderFees,
      expectedNormalizedVenueFeesByAsset: normalizedFees,
      solverFee,
      protocolFee,
      expectedPriorityFee,
      maxRecoveryCostAtomsByAsset: recoveryCaps,
      feePolicyVersion,
      validUntilUnit: validUntil.unit,
      validUntilValue: validUntil.value,
      quoteNonce,
    },
    {
      orderHash,
      solverCapabilityManifestHash,
      routeHash,
      feePolicyManifestHash,
      ...(reservationId === undefined ? {} : { reservationId }),
    },
    signatureMaterial.verificationKey,
    signatureMaterial.signature,
  );
}

function revalidate(value: SolverQuote, context: string): SolverQuote {
  if (
    !(value.domain?.domainManifestHash instanceof Uint8Array) ||
    !(value.orderHash instanceof Uint8Array) ||
    !(value.solverCapabilityManifestHash instanceof Uint8Array) ||
    !(value.routeHash instanceof Uint8Array) ||
    !(value.feePolicyManifestHash instanceof Uint8Array) ||
    (value.reservationId !== undefined && !(value.reservationId instanceof Uint8Array))
  ) {
    throw new MalformedInputError(context, 'expected canonical hash bytes');
  }
  return solverQuote(value, context);
}

function encodeAssetAmounts(
  writer: CanonicalWriter,
  values: readonly AssetAmount[],
  context: string,
): void {
  writer.writeArray(values, encodeAssetAmount, context);
}

function encodeUnsignedChecked(writer: CanonicalWriter, value: SolverQuote): void {
  writer.writeU32(value.version, 'solverQuote.version');
  encodeProtocolId(writer, value.environment, 'solverQuote.environment');
  encodeDomainRef(writer, value.domain);
  encodeCommitmentHash(writer, value.orderHash, 'solverQuote.orderHash');
  encodeProtocolId(writer, value.solverId, 'solverQuote.solverId');
  encodeManifestHash(
    writer,
    value.solverCapabilityManifestHash,
    'solverQuote.solverCapabilityManifestHash',
  );
  writer.writeEnum(
    SOLVER_SIGNATURE_SCHEME,
    value.solverSignatureScheme,
    'solverQuote.solverSignatureScheme',
  );
  writer.writeByteString(value.solverVerificationKey, 'solverQuote.solverVerificationKey');
  writer.writeEnum(QUOTE_MODE, value.quoteMode, 'solverQuote.quoteMode');
  encodeCommitmentHash(writer, value.routeHash, 'solverQuote.routeHash');
  encodeQuotedOutcome(writer, value.quotedOutcome);
  encodeAssetAmount(writer, value.expectedSpotNotional);
  encodeAssetAmount(writer, value.expectedPerpNotional);
  encodeAssetAmount(writer, value.expectedGrossSpotQuantity);
  encodeAssetAmount(writer, value.expectedNetSpotQuantity);
  encodeAssetAmount(writer, value.expectedBaseAssetFee);
  writer.writeOptional(
    value.expectedTerminalResidualBaseQuantity,
    encodeAssetAmount,
    'solverQuote.expectedTerminalResidualBaseQuantity',
  );
  writer.writeOptional(
    value.expectedTerminalResidualQuoteValue,
    encodeAssetAmount,
    'solverQuote.expectedTerminalResidualQuoteValue',
  );
  encodeAssetAmount(writer, value.expectedMarginDelta);
  encodeAssetAmounts(
    writer,
    value.expectedRawFillFeesByAsset,
    'solverQuote.expectedRawFillFeesByAsset',
  );
  encodeAssetAmounts(
    writer,
    value.expectedBuilderFeesByAsset,
    'solverQuote.expectedBuilderFeesByAsset',
  );
  encodeAssetAmounts(
    writer,
    value.expectedNormalizedVenueFeesByAsset,
    'solverQuote.expectedNormalizedVenueFeesByAsset',
  );
  encodeAssetAmount(writer, value.solverFee);
  encodeAssetAmount(writer, value.protocolFee);
  encodeAssetAmount(writer, value.expectedPriorityFee);
  writer.writeArray(
    value.maxRecoveryCostAtomsByAsset,
    encodeFeeCap,
    'solverQuote.maxRecoveryCostAtomsByAsset',
  );
  writer.writeU32(value.feePolicyVersion, 'solverQuote.feePolicyVersion');
  encodeManifestHash(
    writer,
    value.feePolicyManifestHash,
    'solverQuote.feePolicyManifestHash',
  );
  writer.writeEnum(EXPIRY_UNIT, value.validUntilUnit, 'solverQuote.validUntilUnit');
  writer.writeU64(value.validUntilValue, 'solverQuote.validUntilValue');
  writer.writeOptional(
    value.reservationId,
    (inner, reservation) =>
      encodeCommitmentHash(inner, reservation, 'solverQuote.reservationId'),
    'solverQuote.reservationId',
  );
  writer.writeU256(value.quoteNonce, 'solverQuote.quoteNonce');
}

export function encodeUnsignedSolverQuote(writer: CanonicalWriter, value: SolverQuote): void {
  encodeUnsignedChecked(writer, revalidate(value, 'solverQuote'));
}

export function encodeSolverQuote(writer: CanonicalWriter, value: SolverQuote): void {
  const checked = revalidate(value, 'solverQuote');
  encodeUnsignedChecked(writer, checked);
  writer.writeByteString(checked.signature, 'solverQuote.signature');
}

export function unsignedSolverQuoteBytes(input: SolverQuoteInput): Uint8Array {
  const checked = solverQuote(input);
  return canonicalBytes((writer) => encodeUnsignedChecked(writer, checked));
}

export function solverQuoteBytes(input: SolverQuoteInput): Uint8Array {
  const checked = solverQuote(input);
  return canonicalBytes((writer) => {
    encodeUnsignedChecked(writer, checked);
    writer.writeByteString(checked.signature, 'solverQuote.signature');
  });
}

export function quoteHash(input: SolverQuoteInput): Hash32 {
  const checked = solverQuote(input);
  const unsigned = canonicalBytes((writer) => encodeUnsignedChecked(writer, checked));
  return domainHash(
    HASH_DOMAIN.QUOTE,
    concatBytes([checked.orderHash, checked.routeHash, unsigned]),
    'quoteHash',
  );
}

export function solverSignatureDigest(input: SolverQuoteInput): Hash32 {
  return domainHash(HASH_DOMAIN.SOLVER_SIGNATURE, quoteHash(input), 'solverSignatureDigest');
}
