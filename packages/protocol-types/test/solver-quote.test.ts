import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  CanonicalWriter,
  DuplicateElementError,
  MalformedInputError,
  RangeViolationError,
  assetAmount,
  assetRef,
  domainRef,
  encodeSolverQuote,
  fromHex,
  quoteHash,
  solverQuote,
  solverQuoteBytes,
  solverSignatureDigest,
  toHex,
  unsignedSolverQuoteBytes,
  type AssetAmount,
  type ExpiryUnit,
  type QuoteMode,
  type RoundingDirection,
  type SolverQuote,
  type SolverQuoteInput,
  type SolverSignatureScheme,
} from '../src/index.js';
import {
  loadFixture,
  type SolverQuoteAmountFixture,
  type SolverQuoteAssetFixture,
  type SolverQuoteFixture,
} from './fixtures.js';

function fixtureAsset(value: SolverQuoteAssetFixture) {
  return assetRef(value.assetId, value.assetManifestHash, value.decimals);
}

function fixtureAmount(value: SolverQuoteAmountFixture): AssetAmount {
  return assetAmount(fixtureAsset(value.asset), BigInt(value.atoms));
}

function fixtureInput(fixture: SolverQuoteFixture): SolverQuoteInput {
  return {
    version: Number(fixture.version),
    environment: fixture.environment,
    domain: domainRef(
      fixture.domain.domainId,
      Number(fixture.domain.domainManifestVersion),
      fixture.domain.domainManifestHash,
    ),
    orderHash: fixture.orderHash,
    solverId: fixture.solverId,
    solverCapabilityManifestHash: fixture.solverCapabilityManifestHash,
    solverSignatureScheme: fixture.solverSignatureScheme as SolverSignatureScheme,
    solverVerificationKey: fromHex(fixture.solverVerificationKey),
    quoteMode: fixture.quoteMode as QuoteMode,
    routeHash: fixture.routeHash,
    quotedOutcome: {
      kind: 'ENTRY_SPREAD',
      entrySpread: {
        baseAsset: fixtureAsset(fixture.quotedOutcome.entrySpread.baseAsset),
        quoteAsset: fixtureAsset(fixture.quotedOutcome.entrySpread.quoteAsset),
        quoteAtoms: BigInt(fixture.quotedOutcome.entrySpread.quoteAtoms),
        baseAtoms: BigInt(fixture.quotedOutcome.entrySpread.baseAtoms),
        roundingDirection: fixture.quotedOutcome.entrySpread
          .roundingDirection as RoundingDirection,
      },
    },
    expectedSpotNotional: fixtureAmount(fixture.expectedSpotNotional),
    expectedPerpNotional: fixtureAmount(fixture.expectedPerpNotional),
    expectedGrossSpotQuantity: fixtureAmount(fixture.expectedGrossSpotQuantity),
    expectedNetSpotQuantity: fixtureAmount(fixture.expectedNetSpotQuantity),
    expectedBaseAssetFee: fixtureAmount(fixture.expectedBaseAssetFee),
    expectedMarginDelta: fixtureAmount(fixture.expectedMarginDelta),
    expectedRawFillFeesByAsset: fixture.expectedRawFillFeesByAsset.map(fixtureAmount),
    expectedBuilderFeesByAsset: fixture.expectedBuilderFeesByAsset.map(fixtureAmount),
    expectedNormalizedVenueFeesByAsset:
      fixture.expectedNormalizedVenueFeesByAsset.map(fixtureAmount),
    solverFee: fixtureAmount(fixture.solverFee),
    protocolFee: fixtureAmount(fixture.protocolFee),
    expectedPriorityFee: fixtureAmount(fixture.expectedPriorityFee),
    maxRecoveryCostAtomsByAsset: fixture.maxRecoveryCostAtomsByAsset.map((cap) => ({
      asset: fixtureAsset(cap.asset),
      maxAtoms: BigInt(cap.maxAtoms),
    })),
    feePolicyVersion: Number(fixture.feePolicyVersion),
    feePolicyManifestHash: fixture.feePolicyManifestHash,
    validUntilUnit: fixture.validUntilUnit as ExpiryUnit,
    validUntilValue: BigInt(fixture.validUntilValue),
    quoteNonce: BigInt(fixture.quoteNonce),
    signature: fromHex(fixture.signature),
  };
}

function baseInput(overrides: Partial<SolverQuoteInput> = {}): SolverQuoteInput {
  return {
    ...fixtureInput(loadFixture<SolverQuoteFixture>('solver-quote.json')),
    ...overrides,
  };
}

function secpSignature(s = 1n, recoveryId = 0): Uint8Array {
  const result = new Uint8Array(65);
  result[31] = 1;
  let remaining = s;
  for (let index = 63; index >= 32; index -= 1) {
    result[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  result[64] = recoveryId;
  return result;
}

describe('solver quote', () => {
  test('matches the atomic language-neutral vector and fixed hash formulas', () => {
    const fixture = loadFixture<SolverQuoteFixture>('solver-quote.json');
    const input = fixtureInput(fixture);

    assert.equal(toHex(unsignedSolverQuoteBytes(input)), fixture.unsignedCanonicalHex);
    assert.equal(toHex(solverQuoteBytes(input)), fixture.canonicalHex);
    assert.equal(toHex(quoteHash(input)), fixture.quoteHashHex);
    assert.equal(toHex(solverSignatureDigest(input)), fixture.solverSignatureDigestHex);
  });

  test('enforces fixed versions, nonzero commitments, and nonzero u256 nonce', () => {
    assert.throws(() => solverQuote(baseInput({ version: 2 })), MalformedInputError);
    assert.throws(() => solverQuote(baseInput({ feePolicyVersion: 0 })), MalformedInputError);
    assert.throws(() => solverQuote(baseInput({ quoteNonce: 0n })), MalformedInputError);
    assert.throws(
      () => solverQuote(baseInput({ quoteNonce: 1n << 256n })),
      RangeViolationError,
    );
    assert.throws(() => solverQuote(baseInput({ orderHash: '00'.repeat(32) })), MalformedInputError);
    assert.throws(() => solverQuote(baseInput({ routeHash: '00'.repeat(32) })), MalformedInputError);
  });

  test('requires canonical fee keys and exact checked fee conservation', () => {
    const input = baseInput();
    const raw = input.expectedRawFillFeesByAsset;
    assert.throws(
      () => solverQuote(baseInput({ expectedRawFillFeesByAsset: [raw[1]!, raw[0]!] })),
      MalformedInputError,
    );
    assert.throws(
      () => solverQuote(baseInput({ expectedRawFillFeesByAsset: [raw[0]!, raw[0]!] })),
      DuplicateElementError,
    );
    assert.throws(
      () => solverQuote(baseInput({ expectedBuilderFeesByAsset: [input.expectedBuilderFeesByAsset[0]!] })),
      MalformedInputError,
    );
    assert.throws(
      () =>
        solverQuote(
          baseInput({
            expectedNormalizedVenueFeesByAsset: [
              input.expectedNormalizedVenueFeesByAsset[0]!,
              assetAmount(input.expectedNormalizedVenueFeesByAsset[1]!.asset, 24_999n),
            ],
          }),
        ),
      MalformedInputError,
    );
    assert.throws(
      () =>
        solverQuote(
          baseInput({
            expectedBaseAssetFee: assetAmount(input.expectedBaseAssetFee.asset, 999n),
          }),
        ),
      MalformedInputError,
    );
  });

  test('validates signature byte shape, recovery ID, and secp256k1 low-s', () => {
    assert.throws(
      () => solverQuote(baseInput({ solverVerificationKey: new Uint8Array(31) })),
      MalformedInputError,
    );
    assert.throws(
      () => solverQuote(baseInput({ signature: new Uint8Array(63) })),
      MalformedInputError,
    );
    assert.doesNotThrow(() =>
      solverQuote(
        baseInput({
          solverSignatureScheme: 'SECP256K1_RECOVERABLE',
          solverVerificationKey: new Uint8Array(20).fill(7),
          signature: secpSignature(),
        }),
      ),
    );
    assert.throws(
      () =>
        solverQuote(
          baseInput({
            solverSignatureScheme: 'SECP256K1_RECOVERABLE',
            solverVerificationKey: new Uint8Array(20).fill(7),
            signature: secpSignature(
              0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a1n,
            ),
          }),
        ),
      MalformedInputError,
    );
    assert.throws(
      () =>
        solverQuote(
          baseInput({
            solverSignatureScheme: 'SECP256K1_RECOVERABLE',
            solverVerificationKey: new Uint8Array(20).fill(7),
            signature: secpSignature(1n, 2),
          }),
        ),
      MalformedInputError,
    );
  });

  test('a FIRM_BONDED quote carries its reservation and bond, and other modes keep their bytes', () => {
    assert.throws(() => solverQuote(baseInput({ quoteMode: 'FIRM_BONDED', reservationId: 'aa'.repeat(32) })), /performance bond is required/);
    assert.throws(() => solverQuote(baseInput({ quoteMode: 'FIRM_BONDED', performanceBondId: 'bb'.repeat(32) })), /reservation is required/);
    assert.throws(() => solverQuote(baseInput({ quoteMode: 'FIRM_ONCHAIN', reservationId: 'aa'.repeat(32), performanceBondId: 'bb'.repeat(32) })), /exactly for FIRM_BONDED/);
    const bonded = baseInput({ quoteMode: 'FIRM_BONDED', reservationId: 'aa'.repeat(32), performanceBondId: 'bb'.repeat(32) });
    assert.equal(toHex(solverQuote(bonded).performanceBondId as Uint8Array), 'bb'.repeat(32));
    const onchain = unsignedSolverQuoteBytes(baseInput({ quoteMode: 'FIRM_ONCHAIN', reservationId: 'aa'.repeat(32) }));
    assert.equal(unsignedSolverQuoteBytes(bonded).length, onchain.length + 32, 'only the bonded mode appends its bond');
    assert.notEqual(toHex(quoteHash(bonded)), toHex(quoteHash({ ...bonded, performanceBondId: 'bc'.repeat(32) })));
  });

  test('enforces firm reservation and residual structural boundaries', () => {
    assert.throws(
      () => solverQuote(baseInput({ quoteMode: 'FIRM_ONCHAIN' })),
      MalformedInputError,
    );
    assert.doesNotThrow(() =>
      solverQuote(baseInput({ quoteMode: 'FIRM_ONCHAIN', reservationId: 'aa'.repeat(32) })),
    );
    assert.throws(
      () => solverQuote(baseInput({ quoteMode: 'IMPLIED', reservationId: 'aa'.repeat(32) })),
      MalformedInputError,
    );
    assert.throws(
      () =>
        solverQuote(
          baseInput({
            expectedTerminalResidualBaseQuantity: baseInput().expectedBaseAssetFee,
          }),
        ),
      MalformedInputError,
    );
    assert.throws(
      () =>
        solverQuote(
          baseInput({
            maxRecoveryCostAtomsByAsset: [
              { asset: baseInput().expectedPriorityFee.asset, maxAtoms: 1n },
            ],
          }),
        ),
      MalformedInputError,
    );
  });

  test('defensively copies signature material and encoder-revalidates forged values', () => {
    const quote = solverQuote(baseInput());
    const exposedKey = quote.solverVerificationKey;
    const exposedSignature = quote.signature;
    const exposedDomainHash = quote.domain.domainManifestHash;
    const exposedOrderHash = quote.orderHash;
    const exposedPolicyHash = quote.feePolicyManifestHash;
    exposedKey.fill(0);
    exposedSignature.fill(0);
    exposedDomainHash.fill(0);
    exposedOrderHash.fill(0);
    exposedPolicyHash.fill(0);
    assert.notEqual(quote.solverVerificationKey[0], 0);
    assert.notEqual(quote.signature[0], 0);
    assert.notEqual(quote.domain.domainManifestHash[0], 0);
    assert.notEqual(quote.orderHash[0], 0);
    assert.notEqual(quote.feePolicyManifestHash[0], 0);

    const forged = {
      ...quote,
      feePolicyManifestHash: '77'.repeat(32),
    } as unknown as SolverQuote;
    assert.throws(
      () => encodeSolverQuote(new CanonicalWriter(), forged),
      MalformedInputError,
    );
  });
});
