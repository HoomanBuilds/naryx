import { createPublicKey, verify } from 'node:crypto';
import {
  bytesEqual,
  manifestHash,
  packageOrderHash,
  quoteHash,
  routeHash,
  routePayload,
  routePayloadBytes,
  solverQuote,
  solverQuoteBytes,
  solverSignatureDigest,
  validatePackageOrderProfile,
} from '@naryx/protocol-types';
import type {
  AssetAmount,
  AssetRef,
  ExpiryUnit,
  FeeCapInput,
  Hash32,
  PackageOrder,
  QuotedOutcomeInput,
  SolverQuote,
  SolverQuoteInput,
} from '@naryx/protocol-types';
import { planAtomicEntryRoute, type AtomicRouteDecision } from './atomic-route-decision.js';

export interface Ed25519AtomicQuoteSigner {
  readonly verificationKey: Uint8Array;
  signDigest(digest: Hash32): Uint8Array | Promise<Uint8Array>;
}

export interface AtomicEntryQuoteTerms {
  readonly solverId: string;
  readonly solverCapabilityManifestHash: Uint8Array | string;
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
  readonly quoteNonce: bigint;
}

export interface SignedAtomicEntryQuoteInput {
  readonly order: PackageOrder;
  readonly decision: AtomicRouteDecision;
  readonly terms: AtomicEntryQuoteTerms;
  readonly signer: Ed25519AtomicQuoteSigner;
}

export interface SignedAtomicEntryQuote {
  readonly quote: SolverQuote;
  readonly solverQuoteBytes: Uint8Array;
  readonly quoteHash: Hash32;
  readonly solverSignatureDigest: Hash32;
}

export type SignedAtomicEntryQuoteCode =
  | 'BINDING_MISMATCH'
  | 'EXPIRY_INVALID'
  | 'FEE_CAP_EXCEEDED'
  | 'INVALID_SIGNATURE';

export class SignedAtomicEntryQuoteError extends Error {
  readonly code: SignedAtomicEntryQuoteCode;

  constructor(code: SignedAtomicEntryQuoteCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'SignedAtomicEntryQuoteError';
    this.code = code;
  }
}

const PLACEHOLDER_SIGNATURE = new Uint8Array(64);
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function fail(code: SignedAtomicEntryQuoteCode, message: string): never {
  throw new SignedAtomicEntryQuoteError(code, message);
}

function sameAsset(left: AssetRef, right: AssetRef): boolean {
  return left.assetId === right.assetId
    && left.decimals === right.decimals
    && bytesEqual(left.assetManifestHash, right.assetManifestHash);
}

function ed25519Spki(raw: Uint8Array): Buffer {
  return Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(raw)]);
}

function verifyEd25519(digest: Hash32, signature: Uint8Array, rawKey: Uint8Array): boolean {
  const keyObject = createPublicKey({ key: ed25519Spki(rawKey), format: 'der', type: 'spki' });
  return verify(null, Buffer.from(digest), keyObject, Buffer.from(signature));
}

export async function signAtomicEntryQuote(
  input: SignedAtomicEntryQuoteInput,
): Promise<SignedAtomicEntryQuote> {
  if (typeof input !== 'object' || input === null) {
    fail('BINDING_MISMATCH', 'quote input must be an object');
  }
  const { order, decision, terms, signer } = input;
  if (typeof signer !== 'object' || signer === null || typeof signer.signDigest !== 'function') {
    fail('INVALID_SIGNATURE', 'ed25519 signer capability is missing');
  }
  if (!(signer.verificationKey instanceof Uint8Array) || signer.verificationKey.length !== 32) {
    fail('INVALID_SIGNATURE', 'verification key must be 32 raw bytes');
  }
  if (typeof terms !== 'object' || terms === null) {
    fail('BINDING_MISMATCH', 'quote terms must be an object');
  }
  if (typeof decision !== 'object' || decision === null) {
    fail('BINDING_MISMATCH', 'route decision must be an object');
  }

  let validatedOrder: PackageOrder;
  try {
    validatedOrder = validatePackageOrderProfile(order, 'packageOrder');
  } catch {
    fail('BINDING_MISMATCH', 'package order revalidation failed');
  }
  if (validatedOrder.direction !== 'LONG_SPOT_SHORT_PERP'
    || validatedOrder.action !== 'ENTRY'
    || (validatedOrder.settlementClass !== 'ATOMIC_POSTCONDITION'
      && validatedOrder.settlementClass !== 'BATCHED_IOC_WITH_RECOVERY')) {
    fail('BINDING_MISMATCH', 'quote requires a supported long-spot short-perp ENTRY order');
  }
  const recomputedOrderHash = packageOrderHash(validatedOrder);
  if (!(decision.orderHash instanceof Uint8Array) || !bytesEqual(recomputedOrderHash, decision.orderHash)) {
    fail('BINDING_MISMATCH', 'order hash does not match the recomputed hash');
  }

  let validatedRoute;
  try {
    validatedRoute = routePayload(decision.route, 'routePayload');
  } catch {
    fail('BINDING_MISMATCH', 'route payload revalidation failed');
  }
  const recomputedRouteHash = routeHash(decision.route);
  const recomputedRouteBytes = routePayloadBytes(decision.route);
  if (!(decision.routeHash instanceof Uint8Array) || !bytesEqual(recomputedRouteHash, decision.routeHash)) {
    fail('BINDING_MISMATCH', 'route hash does not match the recomputed hash');
  }
  if (!(decision.routeBytes instanceof Uint8Array) || !bytesEqual(recomputedRouteBytes, decision.routeBytes)) {
    fail('BINDING_MISMATCH', 'route bytes do not match canonical route bytes');
  }
  if (!bytesEqual(validatedRoute.orderHash, recomputedOrderHash)) {
    fail('BINDING_MISMATCH', 'route order hash is not bound to the package order');
  }
  if (validatedRoute.environment !== validatedOrder.environment) {
    fail('BINDING_MISMATCH', 'route environment is not bound to the order');
  }
  if (validatedRoute.domain.domainId !== validatedOrder.domain.domainId
    || validatedRoute.domain.domainManifestVersion !== validatedOrder.domain.domainManifestVersion
    || !bytesEqual(
      validatedRoute.domain.domainManifestHash,
      validatedOrder.domain.domainManifestHash,
    )) {
    fail('BINDING_MISMATCH', 'route domain is not bound to the order domain');
  }
  if (validatedRoute.action !== validatedOrder.action
    || validatedRoute.direction !== validatedOrder.direction
    || validatedRoute.settlementClass !== validatedOrder.settlementClass) {
    fail('BINDING_MISMATCH', 'route action binding does not match the order');
  }
  if (terms.solverId !== validatedRoute.solver) {
    fail('BINDING_MISMATCH', 'quote solver is not bound to the route solver');
  }
  let termsFeePolicyHash: Uint8Array;
  try {
    termsFeePolicyHash = manifestHash(terms.feePolicyManifestHash, 'terms.feePolicyManifestHash');
  } catch {
    fail('BINDING_MISMATCH', 'fee policy manifest hash is invalid');
  }
  if (terms.feePolicyVersion !== validatedRoute.feePolicyVersion
    || !bytesEqual(termsFeePolicyHash, validatedRoute.feePolicyManifestHash)) {
    fail('BINDING_MISMATCH', 'fee policy is not bound to the route fee policy');
  }
  let replayedRoute: ReturnType<typeof planAtomicEntryRoute>;
  try {
    replayedRoute = planAtomicEntryRoute(
      { order: validatedOrder, orderHash: recomputedOrderHash },
      () => [{
        candidateId: decision.candidateId,
        active: true,
        capacityBaseAtoms: validatedOrder.quantity.atoms,
        expectedNetPackageOutcomeQuoteAtoms: decision.expectedNetPackageOutcomeQuoteAtoms,
        expectedTotalFeesQuoteAtoms: decision.expectedTotalFeesQuoteAtoms,
        evidenceGrade: decision.evidenceGrade,
        route: decision.route,
      }],
    );
  } catch {
    fail('BINDING_MISMATCH', 'selected route failed eligibility replay for the order');
  }
  if (!bytesEqual(replayedRoute.routeHash, decision.routeHash)
    || !bytesEqual(replayedRoute.routeBytes, decision.routeBytes)) {
    fail('BINDING_MISMATCH', 'route decision does not match the replayed route');
  }

  if (terms.validUntilUnit !== validatedOrder.expiryUnit
    || terms.validUntilUnit !== validatedRoute.routeExpiryUnit) {
    fail('EXPIRY_INVALID', 'quote validity unit must equal order and route expiry units');
  }
  // Atomic quotes end with their route. A batched route's expiry is the initial action's
  // expiresAfter, which must end strictly before the quote validity (half-open intervals).
  const batched = validatedOrder.settlementClass === 'BATCHED_IOC_WITH_RECOVERY';
  if (typeof terms.validUntilValue !== 'bigint'
    || terms.validUntilValue <= 0n
    || terms.validUntilValue > validatedOrder.expiryValue
    || (batched
      ? terms.validUntilValue <= validatedRoute.routeExpiryValue
      : terms.validUntilValue > validatedRoute.routeExpiryValue)) {
    fail('EXPIRY_INVALID', batched
      ? 'quote validity must be positive, within order expiry, and strictly after the initial action expiry'
      : 'quote validity must be positive and within order and route expiry');
  }
  if (typeof terms.quoteNonce !== 'bigint' || terms.quoteNonce <= 0n) {
    fail('BINDING_MISMATCH', 'quote nonce must be a positive integer');
  }

  const quoteAsset = validatedOrder.maxSpotQuoteIn?.asset;
  if (quoteAsset === undefined) {
    fail('BINDING_MISMATCH', 'entry order has no quote asset cap');
  }
  const isHyperliquid = validatedOrder.settlementClass === 'BATCHED_IOC_WITH_RECOVERY';
  if (!isHyperliquid && terms.maxRecoveryCostAtomsByAsset.length !== 0) {
    fail('FEE_CAP_EXCEEDED', 'atomic entry cannot carry recovery caps');
  }
  if (isHyperliquid) {
    if (terms.maxRecoveryCostAtomsByAsset.length !== validatedOrder.maxRecoveryCostAtomsByAsset.length
      || terms.maxRecoveryCostAtomsByAsset.some((cap, index) => {
        const signed = validatedOrder.maxRecoveryCostAtomsByAsset[index];
        return signed === undefined || !sameAsset(cap.asset, signed.asset) || cap.maxAtoms !== signed.maxAtoms;
      })) {
      fail('FEE_CAP_EXCEEDED', 'recovery cost caps must equal the signed order caps');
    }
  }
  const cappedFees: ReadonlyArray<Readonly<{ fee: AssetAmount; cap: AssetAmount; name: string }>> = [
    { fee: terms.solverFee, cap: validatedOrder.maxSolverFee, name: 'solverFee' },
    { fee: terms.protocolFee, cap: validatedOrder.maxProtocolFee, name: 'protocolFee' },
    { fee: terms.expectedPriorityFee, cap: validatedOrder.maxPriorityFee, name: 'expectedPriorityFee' },
  ];
  for (const entry of cappedFees) {
    if (typeof entry.fee !== 'object' || entry.fee === null || typeof entry.fee.atoms !== 'bigint') {
      fail('FEE_CAP_EXCEEDED', `${entry.name} must carry an integer atom amount`);
    }
    if (!sameAsset(entry.fee.asset, quoteAsset)) {
      fail('FEE_CAP_EXCEEDED', `${entry.name} must use the order quote asset`);
    }
    if (entry.fee.atoms < 0n || entry.fee.atoms > entry.cap.atoms) {
      fail('FEE_CAP_EXCEEDED', `${entry.name} exceeds the order cap`);
    }
  }
  const maxSpotQuoteIn = validatedOrder.maxSpotQuoteIn;
  if (maxSpotQuoteIn === undefined) {
    fail('BINDING_MISMATCH', 'entry order has no spot quote cap');
  }
  const maxSpread = validatedOrder.maxEntrySpread;
  const outcome = terms.quotedOutcome;
  if (typeof outcome !== 'object' || outcome === null || outcome.kind !== 'ENTRY_SPREAD') {
    fail('BINDING_MISMATCH', 'atomic entry quote requires an ENTRY_SPREAD outcome');
  }
  if (maxSpread === undefined
    || typeof outcome.entrySpread !== 'object'
    || outcome.entrySpread === null) {
    fail('BINDING_MISMATCH', 'entry spread terms are missing');
  }
  if (!sameAsset(outcome.entrySpread.baseAsset, maxSpread.baseAsset)
    || !sameAsset(outcome.entrySpread.quoteAsset, maxSpread.quoteAsset)) {
    fail('BINDING_MISMATCH', 'quoted spread assets must equal the order spread assets');
  }
  if (typeof outcome.entrySpread.quoteAtoms !== 'bigint'
    || typeof outcome.entrySpread.baseAtoms !== 'bigint'
    || outcome.entrySpread.quoteAtoms * maxSpread.baseAtoms
      > maxSpread.quoteAtoms * outcome.entrySpread.baseAtoms) {
    fail('BINDING_MISMATCH', 'quoted spread is worse than the order maximum');
  }
  if (!sameAsset(terms.expectedSpotNotional.asset, quoteAsset)
    || !sameAsset(terms.expectedPerpNotional.asset, quoteAsset)) {
    fail('BINDING_MISMATCH', 'expected notionals must use the order quote asset');
  }
  if (typeof terms.expectedSpotNotional.atoms !== 'bigint'
    || terms.expectedSpotNotional.atoms > maxSpotQuoteIn.atoms) {
    fail('BINDING_MISMATCH', 'expected spot notional exceeds the order cap');
  }
  const grossQuantity = terms.expectedGrossSpotQuantity;
  const signedGrossQuantity = isHyperliquid
    ? validatedOrder.hyperliquidGrossSpotQuantity
    : validatedOrder.quantity;
  if (signedGrossQuantity === undefined
    || !sameAsset(grossQuantity.asset, validatedOrder.quantity.asset)
    || grossQuantity.atoms !== signedGrossQuantity.atoms) {
    fail('BINDING_MISMATCH', 'expected gross spot quantity must equal the signed gross quantity');
  }
  const baseFee = terms.expectedBaseAssetFee;
  if (!sameAsset(baseFee.asset, validatedOrder.quantity.asset)
    || typeof baseFee.atoms !== 'bigint'
    || baseFee.atoms < 0n) {
    fail('BINDING_MISMATCH', 'expected base-asset fee must be a nonnegative order-base amount');
  }
  const netQuantity = terms.expectedNetSpotQuantity;
  if (!sameAsset(netQuantity.asset, validatedOrder.quantity.asset)) {
    fail('BINDING_MISMATCH', 'expected net spot quantity must use the order base asset');
  }
  // An entry spot buy receives the gross quantity less any fee charged in the base asset.
  if (netQuantity.atoms !== grossQuantity.atoms - baseFee.atoms) {
    fail('BINDING_MISMATCH', 'expected net spot quantity must equal gross minus base fee');
  }
  if (isHyperliquid) {
    const minimum = validatedOrder.hyperliquidMinNetSpotDelta;
    const maximum = validatedOrder.hyperliquidMaxNetSpotDelta;
    const residualBase = terms.expectedTerminalResidualBaseQuantity;
    const residualQuote = terms.expectedTerminalResidualQuoteValue;
    // The expected terminal residual is the hedge mismatch between the expected net spot delta and
    // the exact perpetual delta, valued with the signed reference price rounded up, and must stay
    // within the signed caps.
    const residual = netQuantity.atoms - validatedOrder.quantity.atoms;
    const absoluteResidual = residual < 0n ? -residual : residual;
    const valuation = validatedOrder.hyperliquidResidualValuationReferencePrice;
    const residualValue = absoluteResidual === 0n
      ? 0n
      : valuation === undefined
        ? undefined
        : (absoluteResidual * valuation.quoteAtoms + valuation.baseAtoms - 1n) / valuation.baseAtoms;
    const baseCap = validatedOrder.hyperliquidMaxTerminalResidualBaseQuantity;
    const quoteCap = validatedOrder.hyperliquidMaxTerminalResidualQuoteValue;
    if (minimum === undefined || maximum === undefined
      || netQuantity.atoms < minimum.atoms || netQuantity.atoms > maximum.atoms
      || residualBase === undefined || residualQuote === undefined
      || baseCap === undefined || quoteCap === undefined || residualValue === undefined
      || !sameAsset(residualBase.asset, validatedOrder.quantity.asset)
      || !sameAsset(residualQuote.asset, quoteAsset)
      || residualBase.atoms !== absoluteResidual
      || residualQuote.atoms !== residualValue
      || residualBase.atoms > baseCap.atoms
      || residualQuote.atoms > quoteCap.atoms) {
      fail('BINDING_MISMATCH', 'Hyperliquid net quantity and residuals must remain within signed bounds');
    }
  }
  const marginDelta = terms.expectedMarginDelta;
  if (!sameAsset(marginDelta.asset, quoteAsset)
    || typeof marginDelta.atoms !== 'bigint'
    || marginDelta.atoms > validatedOrder.maxMarginAdded.atoms) {
    fail('BINDING_MISMATCH', 'expected margin delta exceeds the order cap');
  }
  if (!Array.isArray(terms.expectedNormalizedVenueFeesByAsset)
    || !Array.isArray(terms.expectedBuilderFeesByAsset)) {
    fail('FEE_CAP_EXCEEDED', 'venue and builder fees must be arrays');
  }
  for (const fee of terms.expectedNormalizedVenueFeesByAsset) {
    if (typeof fee !== 'object' || fee === null || typeof fee.atoms !== 'bigint') {
      fail('FEE_CAP_EXCEEDED', 'normalized venue fee must carry an integer atom amount');
    }
    if (fee.atoms < 0n) {
      fail('FEE_CAP_EXCEEDED', 'normalized venue fee must be nonnegative');
    }
    const cap = validatedOrder.maxVenueFeeAtomsByAsset.find((entry) => sameAsset(entry.asset, fee.asset));
    if (cap === undefined || fee.atoms > cap.maxAtoms) {
      fail('FEE_CAP_EXCEEDED', 'normalized venue fee exceeds the signed cap');
    }
  }
  const quotedServiceFees: Array<{ category: 'PROTOCOL' | 'SOLVER' | 'BUILDER'; fee: AssetAmount }> = [
    { category: 'PROTOCOL', fee: terms.protocolFee },
    { category: 'SOLVER', fee: terms.solverFee },
    ...terms.expectedBuilderFeesByAsset.map((fee) => ({ category: 'BUILDER' as const, fee })),
  ];
  for (const entry of quotedServiceFees) {
    if (typeof entry.fee !== 'object' || entry.fee === null || typeof entry.fee.atoms !== 'bigint') {
      fail('FEE_CAP_EXCEEDED', 'quoted service fee must carry an integer atom amount');
    }
    if (entry.fee.atoms !== 0n
      && !validatedRoute.serviceCharges.some((charge) => charge.feeCategory === entry.category
        && sameAsset(charge.asset, entry.fee.asset)
        && charge.atoms === entry.fee.atoms)) {
      fail('FEE_CAP_EXCEEDED', 'quoted service fee does not match the route charge');
    }
  }
  for (const charge of validatedRoute.serviceCharges) {
    if (charge.atoms !== 0n
      && !quotedServiceFees.some((entry) => entry.category === charge.feeCategory
        && sameAsset(entry.fee.asset, charge.asset)
        && entry.fee.atoms === charge.atoms)) {
      fail('FEE_CAP_EXCEEDED', 'route service charge does not match the quoted fee');
    }
  }

  const verificationKey = Uint8Array.from(signer.verificationKey);
  const unsignedInput: SolverQuoteInput = {
    version: 1,
    environment: validatedOrder.environment,
    domain: validatedOrder.domain,
    orderHash: recomputedOrderHash,
    solverId: terms.solverId,
    solverCapabilityManifestHash: terms.solverCapabilityManifestHash,
    solverSignatureScheme: 'ED25519',
    solverVerificationKey: verificationKey,
    quoteMode: 'EXECUTION_COMMITMENT',
    routeHash: recomputedRouteHash,
    quotedOutcome: terms.quotedOutcome,
    expectedSpotNotional: terms.expectedSpotNotional,
    expectedPerpNotional: terms.expectedPerpNotional,
    expectedGrossSpotQuantity: terms.expectedGrossSpotQuantity,
    expectedNetSpotQuantity: terms.expectedNetSpotQuantity,
    expectedBaseAssetFee: terms.expectedBaseAssetFee,
    ...(terms.expectedTerminalResidualBaseQuantity === undefined
      ? {}
      : {
          expectedTerminalResidualBaseQuantity: terms.expectedTerminalResidualBaseQuantity,
          expectedTerminalResidualQuoteValue: terms.expectedTerminalResidualQuoteValue,
        }),
    expectedMarginDelta: terms.expectedMarginDelta,
    expectedRawFillFeesByAsset: terms.expectedRawFillFeesByAsset,
    expectedBuilderFeesByAsset: terms.expectedBuilderFeesByAsset,
    expectedNormalizedVenueFeesByAsset: terms.expectedNormalizedVenueFeesByAsset,
    solverFee: terms.solverFee,
    protocolFee: terms.protocolFee,
    expectedPriorityFee: terms.expectedPriorityFee,
    maxRecoveryCostAtomsByAsset: terms.maxRecoveryCostAtomsByAsset,
    feePolicyVersion: terms.feePolicyVersion,
    feePolicyManifestHash: terms.feePolicyManifestHash,
    validUntilUnit: terms.validUntilUnit,
    validUntilValue: terms.validUntilValue,
    quoteNonce: terms.quoteNonce,
    signature: Uint8Array.from(PLACEHOLDER_SIGNATURE),
  };
  try {
    solverQuote(unsignedInput, 'solverQuote');
  } catch {
    fail('BINDING_MISMATCH', 'unsigned quote terms are not a valid solver quote');
  }
  const digestBefore = solverSignatureDigest(unsignedInput);
  if (!(digestBefore instanceof Uint8Array) || digestBefore.length !== 32) {
    fail('INVALID_SIGNATURE', 'signature digest must be 32 bytes');
  }

  let signature: Uint8Array;
  try {
    const produced = await signer.signDigest(digestBefore);
    if (!(produced instanceof Uint8Array)) {
      fail('INVALID_SIGNATURE', 'signer must return signature bytes');
    }
    signature = Uint8Array.from(produced);
  } catch (error) {
    if (error instanceof SignedAtomicEntryQuoteError) throw error;
    throw new SignedAtomicEntryQuoteError('INVALID_SIGNATURE', 'signer failed to sign the digest');
  }
  if (signature.length !== 64) {
    fail('INVALID_SIGNATURE', 'ed25519 signature must be 64 bytes');
  }
  let verified = false;
  try {
    verified = verifyEd25519(digestBefore, signature, verificationKey);
  } catch {
    fail('INVALID_SIGNATURE', 'ed25519 verification failed');
  }
  if (verified !== true) {
    fail('INVALID_SIGNATURE', 'signature does not verify over the quote digest');
  }

  const signedInput: SolverQuoteInput = { ...unsignedInput, signature: Uint8Array.from(signature) };
  const digestAfter = solverSignatureDigest(signedInput);
  if (!bytesEqual(digestBefore, digestAfter)) {
    fail('INVALID_SIGNATURE', 'quote digest changed when the signature was inserted');
  }
  let quote: SolverQuote;
  try {
    quote = solverQuote(signedInput, 'solverQuote');
  } catch {
    fail('INVALID_SIGNATURE', 'signed quote failed final validation');
  }
  return Object.freeze({
    quote,
    solverQuoteBytes: solverQuoteBytes(signedInput),
    quoteHash: quoteHash(signedInput),
    solverSignatureDigest: digestAfter,
  });
}
