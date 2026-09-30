import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  assetAmount,
  assetRef,
  domainRef,
  evidenceManifestHash,
  isRecoveredTerminalState,
  packageReceipt,
  packageReceiptHash,
  requiresSuccessfulReceipt,
  terminalOutcomeHash,
  terminalOutcomeRecord,
  toHex,
  verifyOutcomeReceiptLink,
  verifyReceiptFees,
  type AcceptedQuoteFeeTerms,
  type EvidenceManifestInput,
  type PackageReceiptInput,
  type TerminalOutcomeInput,
} from '../src/index.js';

const hash = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);
const domain = domainRef('hyperliquid:testnet', 1, hash(40));
const usdc = assetRef('usdc', hash(41), 6);
const hype = assetRef('hype', hash(42), 8);
const usd = (atoms: bigint) => assetAmount(usdc, atoms);

const manifest: EvidenceManifestInput = {
  manifestVersion: 1,
  environment: 'testnet',
  domain,
  orderHash: hash(1),
  entries: [
    { sequence: 0n, kind: 'ATTEMPT', attemptId: 'attempt-1', reference: 'attempt-1', contentHash: hash(50), observedAtValue: 10n },
    { sequence: 1n, kind: 'OUTBOUND_ACTION', attemptId: 'attempt-1', reference: 'action-0xabc', contentHash: hash(51), observedAtValue: 11n },
    { sequence: 2n, kind: 'RESPONSE_RECEIVED', attemptId: 'attempt-1', reference: 'response-1', contentHash: hash(52), observedAtValue: 12n },
    { sequence: 3n, kind: 'FILL', attemptId: 'attempt-1', reference: 'fill-1', contentHash: hash(53), observedAtValue: 13n },
  ],
};

const fieldEvidence = ['evidenceManifestHash', 'orderHash', 'protocolFee', 'quantity', 'quoteHash', 'solverFee', 'spotExecutionPrice', 'terminalState']
  .map((fieldId) => ({ fieldId, grade: 'CONTROLLER_ATTESTED' as const, onchainEnforced: false }));

function receiptInput(overrides: Partial<PackageReceiptInput> = {}): PackageReceiptInput {
  return {
    receiptVersion: 1,
    environment: 'testnet',
    domain,
    attemptIds: ['attempt-1'],
    orderedActionEvidenceRefs: [hash(51)],
    orderedOrderEvidenceRefs: [],
    orderedFillEvidenceRefs: [hash(53)],
    transactionIds: ['action-0xabc'],
    evidenceManifestHash: evidenceManifestHash(manifest),
    orderHash: hash(1),
    quoteHash: hash(2),
    templateId: 'cash-carry',
    templateVersion: 1,
    packageTemplateManifestHash: hash(3),
    templateRegistryReference: hash(4),
    solverCapabilityManifestHash: hash(5),
    packageMarketId: 'hype-carry-30d',
    owner: '0xowner',
    solver: 'solver-a',
    action: 'ENTRY',
    settlementClass: 'BATCHED_IOC_WITH_RECOVERY',
    terminalState: 'FINALIZED_COMPLETE',
    quantity: 100_000_000n,
    spotVenue: 'hyperliquid-spot',
    perpVenue: 'hyperliquid-perp',
    spotExecutionPrice: 25_000_000n,
    perpExecutionPrice: 25_140_000n,
    perpPriceEnforcement: 'EVENT_ONLY',
    packageSpread: 140_000n,
    spotQuoteDelta: -25_000_000n,
    externalQuoteBalanceDelta: 0n,
    venueWithdrawableQuoteDelta: -25_000_000n,
    exitOutcomeSchemaVersion: 1,
    authoritativePreStateRefs: [{ locator: 'action-0xabc', accountKey: '0xowner', component: 'spot-balance', value: 0n, unit: 'hype', evidenceHash: hash(54) }],
    authoritativePostStateRefs: [{ locator: 'fill-1', accountKey: '0xowner', component: 'spot-balance', value: 100_000_000n, unit: 'hype', evidenceHash: hash(55) }],
    perpPositionDelta: -100_000_000n,
    marginDelta: 12_500_000n,
    matchedPackageNotional: 25_000_000n,
    grossLegNotional: 50_140_000n,
    rawFillFeesByAsset: [assetAmount(hype, 7_000n), usd(9_000n)],
    builderFeesByAsset: [usd(2_000n)],
    normalizedVenueFeesByAsset: [assetAmount(hype, 7_000n), usd(7_000n)],
    protocolFee: usd(5_000n),
    solverFee: usd(10_000n),
    feePolicyVersion: 3,
    feePolicyManifestHash: hash(6),
    maxResidualBaseQuantityObserved: 0n,
    timeUnhedgedMs: 180n,
    recoveryCostByAsset: [],
    recoveryRefundByAsset: [],
    priorityFee: usd(0n),
    finalityStatus: 'VENUE_COMMITTED',
    fieldEvidence,
    timestampValue: 1_790_000_000_000n,
    ...overrides,
  };
}

const zeroMark = { availability: 'PRESENT' as const, quoteValue: 0n, evidenceHash: hash(60) };

function outcomeInput(overrides: Partial<TerminalOutcomeInput> = {}): TerminalOutcomeInput {
  return {
    outcomeVersion: 1,
    environment: 'testnet',
    domain,
    orderHash: hash(1),
    packageTemplateManifestHash: hash(3),
    templateRegistryReference: hash(4),
    terminalState: 'FINALIZED_COMPLETE',
    attemptIds: ['attempt-1'],
    responseAvailability: 'RECEIVED',
    initialBatchResponseHash: hash(52),
    authoritativeEvidenceRefs: [hash(53)],
    evidenceManifestHash: evidenceManifestHash(manifest),
    residualValuationApplicability: 'HYPERLIQUID_EXACT',
    intermediateResidualBaseQuantity: 0n,
    terminalResidualBaseQuantity: 0n,
    authorizedResidualValue: { availability: 'NOT_APPLICABLE' },
    terminalResidualMark: zeroMark,
    successfulReceiptHash: packageReceiptHash(receiptInput()),
    issuerKind: 'CONTROLLER',
    issuer: 'controller-1',
    fieldEvidence: ['evidenceManifestHash', 'orderHash', 'terminalState'].map((fieldId) => ({ fieldId, grade: 'CONTROLLER_ATTESTED' as const, onchainEnforced: false })),
    controllerSignature: new Uint8Array(64).fill(7),
    timestampValue: 1_790_000_000_000n,
    ...overrides,
  };
}

const terms: AcceptedQuoteFeeTerms = {
  protocolFee: usd(5_000n),
  solverFee: usd(10_000n),
  feePolicyVersion: 3,
  feePolicyManifestHash: hash(6),
  maxRecoveryCostByAsset: [usd(50_000n)],
  builderFeesByAsset: [usd(2_000n)],
};

describe('canonical terminal states', () => {
  test('only successful outcomes require a receipt and only recovered outcomes are fee-free', () => {
    assert.deepEqual(
      (['FINALIZED_COMPLETE', 'FINALIZED_BOUNDED', 'RECOVERED_COMPLETE', 'RECOVERED_BOUNDED', 'RECOVERED_FLAT', 'MANUAL_INTERVENTION', 'NO_EFFECT'] as const)
        .map((state) => [requiresSuccessfulReceipt(state), isRecoveredTerminalState(state)]),
      [[true, false], [true, false], [true, true], [true, true], [false, true], [false, false], [false, false]],
    );
  });
});

describe('evidence manifest', () => {
  test('hash is stable and changes with any entry', () => {
    const base = toHex(evidenceManifestHash(manifest));
    assert.equal(base, toHex(evidenceManifestHash({ ...manifest })));
    const changed = { ...manifest, entries: manifest.entries.map((entry, index) => (index === 3 ? { ...entry, contentHash: hash(99) } : entry)) };
    assert.notEqual(base, toHex(evidenceManifestHash(changed)));
  });

  test('rejects gaps, evidence before its attempt, duplicates, and both response markers', () => {
    const entries = manifest.entries;
    assert.throws(() => evidenceManifestHash({ ...manifest, entries: [entries[0]!, { ...entries[1]!, sequence: 2n }] }), /expected sequence 1/);
    assert.throws(() => evidenceManifestHash({ ...manifest, entries: [{ ...entries[1]!, sequence: 0n }] }), /precedes the attempt/);
    assert.throws(() => evidenceManifestHash({ ...manifest, entries: [entries[0]!, entries[1]!, { ...entries[1]!, sequence: 2n }] }), /listed twice/);
    assert.throws(
      () => evidenceManifestHash({
        ...manifest,
        entries: [...entries, { sequence: 4n, kind: 'RESPONSE_ABSENT', attemptId: 'attempt-1', reference: 'timeout-1', contentHash: hash(56), observedAtValue: 14n }],
      }),
      /both a received and an absent/,
    );
  });
});

describe('terminal outcome record', () => {
  test('successful outcome links its receipt and hashes deterministically without the signature', () => {
    const record = terminalOutcomeRecord(outcomeInput());
    assert.equal(record.terminalState, 'FINALIZED_COMPLETE');
    const withOtherSignature = terminalOutcomeHash(outcomeInput({ controllerSignature: new Uint8Array(64).fill(9) }));
    assert.equal(toHex(terminalOutcomeHash(outcomeInput())), toHex(withOtherSignature));
  });

  test('non-successful outcomes never link a receipt, successful ones always do', () => {
    assert.throws(() => terminalOutcomeRecord(outcomeInput({ terminalState: 'RECOVERED_FLAT' })), /must not link a successful receipt/);
    const { successfulReceiptHash: _omitted, ...withoutReceipt } = outcomeInput();
    assert.throws(() => terminalOutcomeRecord(withoutReceipt), /must link a successful receipt/);
    assert.equal(terminalOutcomeRecord({ ...withoutReceipt, terminalState: 'RECOVERED_FLAT' }).terminalState, 'RECOVERED_FLAT');
  });

  test('response loss must carry a reason and never a fabricated response', () => {
    assert.throws(() => terminalOutcomeRecord(outcomeInput({ responseAvailability: 'ABSENT' })), /never a fabricated response/);
    const { initialBatchResponseHash: _dropped, ...absent } = outcomeInput();
    assert.equal(terminalOutcomeRecord({ ...absent, responseAvailability: 'ABSENT', responseAbsenceReason: 'timeout' }).responseAvailability, 'ABSENT');
  });

  test('zero-residual states require canonical zero quantities and a present zero mark', () => {
    assert.throws(() => terminalOutcomeRecord(outcomeInput({ terminalResidualBaseQuantity: 5n })), /canonical zero residual/);
    assert.throws(() => terminalOutcomeRecord(outcomeInput({ terminalResidualMark: { availability: 'ABSENT', absenceReason: 'stale' } })), /present canonical zero mark/);
  });

  test('bounded success needs bounded valuation with both values present', () => {
    const bounded = outcomeInput({
      terminalState: 'FINALIZED_BOUNDED',
      residualValuationApplicability: 'HYPERLIQUID_BOUNDED',
      terminalResidualBaseQuantity: 3_000n,
      authorizedResidualValue: { availability: 'PRESENT', quoteValue: 750n, evidenceHash: hash(61) },
      terminalResidualMark: { availability: 'PRESENT', quoteValue: -760n, evidenceHash: hash(62) },
    });
    assert.equal(terminalOutcomeRecord(bounded).terminalState, 'FINALIZED_BOUNDED');
    assert.throws(() => terminalOutcomeRecord({ ...bounded, terminalResidualMark: { availability: 'ABSENT', absenceReason: 'stale' } }), /both the authorized value/);
    assert.throws(() => terminalOutcomeRecord({ ...bounded, residualValuationApplicability: 'HYPERLIQUID_EXACT' }), /bounded valuation/);
  });

  test('availability tags and their values must agree', () => {
    assert.throws(
      () => terminalOutcomeRecord(outcomeInput({ terminalResidualMark: { availability: 'PRESENT', quoteValue: 0n } })),
      /present exactly when availability is PRESENT/,
    );
  });

  test('controller outcomes are signed; consensus-bound outcomes are atomic and unsigned', () => {
    assert.throws(() => terminalOutcomeRecord(outcomeInput({ controllerSignature: new Uint8Array(10) })), /64-byte controller signature/);
    const { controllerSignature: _signature, ...unsigned } = outcomeInput();
    assert.throws(() => terminalOutcomeRecord({ ...unsigned, issuerKind: 'CONSENSUS_EVENT' }), /consensus-bound outcomes are atomic/);
    const { intermediateResidualBaseQuantity: _intermediate, terminalResidualBaseQuantity: _terminal, ...withoutResidual } = unsigned;
    const atomic = terminalOutcomeRecord({
      ...withoutResidual,
      issuerKind: 'CONSENSUS_EVENT',
      residualValuationApplicability: 'NOT_APPLICABLE',
      terminalResidualMark: { availability: 'NOT_APPLICABLE' },
    });
    assert.equal(atomic.issuerKind, 'CONSENSUS_EVENT');
  });

  test('field evidence must be sorted, unique, and cover the required fields', () => {
    const evidence = outcomeInput().fieldEvidence;
    assert.throws(() => terminalOutcomeRecord(outcomeInput({ fieldEvidence: [...evidence].reverse() })), /sorted by canonical fieldId/);
    assert.throws(() => terminalOutcomeRecord(outcomeInput({ fieldEvidence: evidence.slice(1) })), /required field evidenceManifestHash/);
  });
});

describe('package receipt', () => {
  test('fee vectors reconcile: normalized equals raw minus builder per asset', () => {
    assert.equal(packageReceipt(receiptInput()).normalizedVenueFeesByAsset.length, 2);
    assert.throws(() => packageReceipt(receiptInput({ normalizedVenueFeesByAsset: [assetAmount(hype, 7_000n), usd(9_000n)] })), /raw minus builder/);
    assert.throws(() => packageReceipt(receiptInput({ builderFeesByAsset: [assetAmount(assetRef('eth', hash(43), 18), 1n)] })), /not a subset of raw/);
  });

  test('only successful states produce a receipt', () => {
    for (const state of ['RECOVERED_FLAT', 'MANUAL_INTERVENTION', 'NO_EFFECT'] as const) {
      assert.throws(() => packageReceipt(receiptInput({ terminalState: state })), /produces no package receipt/);
    }
  });

  test('recovered packages are protocol-fee-free', () => {
    assert.throws(() => packageReceipt(receiptInput({ terminalState: 'RECOVERED_COMPLETE' })), /protocol-fee-free/);
    assert.equal(packageReceipt(receiptInput({ terminalState: 'RECOVERED_COMPLETE', protocolFee: usd(0n) })).terminalState, 'RECOVERED_COMPLETE');
  });

  test('exit outcome equals external plus venue-withdrawable deltas; entries carry none', () => {
    const exit = { action: 'EXIT' as const, externalQuoteBalanceDelta: 24_000_000n, venueWithdrawableQuoteDelta: 1_100_000n };
    assert.equal(packageReceipt(receiptInput({ ...exit, exitQuoteOutcome: 25_100_000n })).exitQuoteOutcome, 25_100_000n);
    assert.throws(() => packageReceipt(receiptInput({ ...exit, exitQuoteOutcome: 25_100_001n })), /external plus venue-withdrawable/);
    assert.throws(() => packageReceipt(receiptInput({ exitQuoteOutcome: 1n })), /entry receipt has no exit outcome/);
  });

  test('unavailable perp price enforcement omits the perp price and spread', () => {
    assert.throws(() => packageReceipt(receiptInput({ perpPriceEnforcement: 'UNAVAILABLE' })), /perp price and package spread are absent/);
    const { perpExecutionPrice: _price, packageSpread: _spread, ...rest } = receiptInput();
    assert.equal(packageReceipt({ ...rest, perpPriceEnforcement: 'UNAVAILABLE' }).perpPriceEnforcement, 'UNAVAILABLE');
  });

  test('bounded receipts carry both residual valuations and their evidence', () => {
    assert.throws(() => packageReceipt(receiptInput({ terminalState: 'FINALIZED_BOUNDED' })), /both residual values/);
    const bounded = receiptInput({
      terminalState: 'FINALIZED_BOUNDED',
      terminalResidualBaseQuantity: 3_000n,
      authorizedReferenceResidualQuoteValue: 750n,
      terminalMarkedResidualQuoteValue: -760n,
      authorizedResidualValuationEvidence: hash(61),
      terminalResidualMarkEvidence: hash(62),
    });
    assert.equal(packageReceipt(bounded).terminalResidualBaseQuantity, 3_000n);
  });

  test('atomic receipts use exactly one attempt and one transaction', () => {
    assert.throws(
      () => packageReceipt(receiptInput({ settlementClass: 'ATOMIC_POSTCONDITION', attemptIds: ['a', 'b'] })),
      /one-element attempt and transaction arrays/,
    );
  });

  test('receipt hash changes with any charged amount', () => {
    assert.notEqual(toHex(packageReceiptHash(receiptInput())), toHex(packageReceiptHash(receiptInput({ solverFee: usd(9_999n) }))));
  });
});

describe('receipt fee verification', () => {
  test('charges at or below the accepted quote under the same policy pass', () => {
    assert.deepEqual(verifyReceiptFees(receiptInput(), terms), { valid: true, violations: [] });
    assert.equal(verifyReceiptFees(receiptInput({ solverFee: usd(1n) }), terms).valid, true);
  });

  test('builder fees are bounded by the quoted builder fee', () => {
    assert.deepEqual(verifyReceiptFees(receiptInput(), { ...terms, builderFeesByAsset: [usd(1_999n)] }).violations, ['BUILDER_FEE_EXCEEDS_QUOTE']);
    const { builderFeesByAsset: _omitted, ...unquoted } = terms;
    assert.deepEqual(verifyReceiptFees(receiptInput(), unquoted).violations, ['BUILDER_FEE_UNQUOTED']);
  });

  test('overcharges, policy drift, and asset substitution are rejected', () => {
    assert.deepEqual(verifyReceiptFees(receiptInput({ protocolFee: usd(5_001n) }), terms).violations, ['PROTOCOL_FEE_EXCEEDS_QUOTE']);
    assert.deepEqual(verifyReceiptFees(receiptInput({ solverFee: usd(10_001n) }), terms).violations, ['SOLVER_FEE_EXCEEDS_QUOTE']);
    assert.deepEqual(verifyReceiptFees(receiptInput({ feePolicyVersion: 4 }), terms).violations, ['FEE_POLICY_VERSION_MISMATCH']);
    assert.deepEqual(verifyReceiptFees(receiptInput({ feePolicyManifestHash: hash(7) }), terms).violations, ['FEE_POLICY_MANIFEST_MISMATCH']);
    assert.deepEqual(verifyReceiptFees(receiptInput({ solverFee: assetAmount(hype, 1n) }), terms).violations, ['SOLVER_FEE_ASSET_MISMATCH']);
  });

  test('recovery cost stays within the order caps', () => {
    const recovered = { terminalState: 'RECOVERED_COMPLETE' as const, protocolFee: usd(0n) };
    assert.equal(verifyReceiptFees(receiptInput({ ...recovered, recoveryCostByAsset: [usd(50_000n)] }), terms).valid, true);
    assert.deepEqual(verifyReceiptFees(receiptInput({ ...recovered, recoveryCostByAsset: [usd(50_001n)] }), terms).violations, ['RECOVERY_COST_EXCEEDS_CAP']);
    assert.deepEqual(
      verifyReceiptFees(receiptInput({ ...recovered, recoveryCostByAsset: [assetAmount(hype, 1n)] }), terms).violations,
      ['RECOVERY_COST_ASSET_UNCAPPED'],
    );
  });
});

describe('outcome and receipt linkage', () => {
  test('a linked outcome and receipt verify; a swapped receipt does not', () => {
    assert.deepEqual(verifyOutcomeReceiptLink(outcomeInput(), receiptInput()), { valid: true, violations: [] });
    assert.deepEqual(verifyOutcomeReceiptLink(outcomeInput(), receiptInput({ solverFee: usd(1n) })).violations, ['RECEIPT_HASH_MISMATCH']);
  });

  test('both records must bind the same evidence manifest and attempts', () => {
    const receipt = receiptInput({ evidenceManifestHash: hash(90), attemptIds: ['attempt-2'] });
    const outcome = outcomeInput({ successfulReceiptHash: packageReceiptHash(receipt) });
    assert.deepEqual(verifyOutcomeReceiptLink(outcome, receipt).violations, ['EVIDENCE_MANIFEST_MISMATCH', 'ATTEMPTS_MISMATCH']);
  });
});
