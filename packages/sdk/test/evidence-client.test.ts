import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import {
  adapterRef,
  versionedManifestRef,
  assetAmount,
  assetRef,
  buildExposureGraph,
  packageCloseCostIndex,
  packageGraphHash,
  simulatePackageGraphFailures,
  positionSnapshotRecord,
  positionSnapshotRecordHash,
  domainRef,
  evidenceManifestHash,
  fromProtocolJson,
  packageOrderBytes,
  packageOrderHash,
  packageReceiptHash,
  privateRfqEnvelopeHash,
  qualificationRecordHash,
  quoteHash,
  replayRouteDecision,
  routeHash,
  solverRequestDigest,
  solverCapabilityManifestHash,
  solverSignatureDigest,
  terminalOutcomeHash,
  toHex,
  toProtocolJson,
  type AcceptedQuoteFeeTerms,
  type EvidenceManifestInput,
  type PackageOrderInput,
  type PackageReceiptInput,
  type PrivateRfqEnvelopeInput,
  type QualificationRecordInput,
  type RoutePayloadInput,
  type SolverCapabilityManifestInput,
  type SolverQuoteInput,
  type TerminalOutcomeInput,
} from '@naryx/protocol-types';
import { NaryxClient, NaryxSolverClient, base58Encode, type FetchLike } from '../src/index.js';

const ORDER = fromProtocolJson(
  JSON.parse(readFileSync(new URL('../../test/fixtures/solana-entry-order.json', import.meta.url), 'utf8')),
) as PackageOrderInput;
const ORDER_HASH = toHex(packageOrderHash(ORDER));
const ORDER_QUOTE = fromProtocolJson(
  JSON.parse(readFileSync(new URL('../../test/fixtures/order-quote.json', import.meta.url), 'utf8')),
) as { quote: SolverQuoteInput; route: RoutePayloadInput };

const hash = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);
const domain = domainRef('svm:testnet', 1, '11'.repeat(32));
const usdc = assetRef('svm:testnet:usdc', '33'.repeat(32), 6);
const orderHash = hash(1);
const orderHashHex = toHex(orderHash);

function manifest(): EvidenceManifestInput {
  return {
    manifestVersion: 1,
    environment: 'testnet',
    domain,
    orderHash,
    entries: [
      { sequence: 0n, kind: 'ATTEMPT', attemptId: 'attempt-1', reference: 'attempt-1', contentHash: hash(50), observedAtValue: 10n },
      { sequence: 1n, kind: 'CHAIN_TRANSACTION', attemptId: 'attempt-1', reference: 'tx-1', contentHash: hash(51), observedAtValue: 11n },
    ],
  };
}

function receipt(overrides: Partial<PackageReceiptInput> = {}): PackageReceiptInput {
  return {
    receiptVersion: 1,
    environment: 'testnet',
    domain,
    attemptIds: ['attempt-1'],
    orderedActionEvidenceRefs: [hash(51)],
    orderedOrderEvidenceRefs: [],
    orderedFillEvidenceRefs: [],
    transactionIds: ['tx-1'],
    evidenceManifestHash: evidenceManifestHash(manifest()),
    orderHash,
    quoteHash: hash(2),
    templateId: 'cash-and-carry-v1',
    templateVersion: 1,
    packageTemplateManifestHash: '44'.repeat(32),
    templateRegistryReference: hash(4),
    solverCapabilityManifestHash: hash(5),
    packageMarketId: 'sol-carry',
    owner: 'owner',
    solver: 'solver-a',
    action: 'ENTRY',
    settlementClass: 'ATOMIC_POSTCONDITION',
    terminalState: 'FINALIZED_COMPLETE',
    quantity: 1_000_000_000n,
    spotVenue: 'phoenix',
    perpVenue: 'drift',
    spotExecutionPrice: 148_240_000n,
    perpExecutionPrice: 149_070_000n,
    perpPriceEnforcement: 'CONTRACT_ENFORCED',
    spotQuoteDelta: -148_240_000n,
    externalQuoteBalanceDelta: -148_240_000n,
    venueWithdrawableQuoteDelta: 0n,
    exitOutcomeSchemaVersion: 1,
    authoritativePreStateRefs: [{ locator: 'slot-1', accountKey: 'owner', component: 'spot-balance', value: 0n, unit: 'sol', evidenceHash: hash(54) }],
    authoritativePostStateRefs: [{ locator: 'slot-2', accountKey: 'owner', component: 'spot-balance', value: 1_000_000_000n, unit: 'sol', evidenceHash: hash(55) }],
    perpPositionDelta: -1_000_000_000n,
    marginDelta: 20_000_000n,
    matchedPackageNotional: 148_240_000n,
    grossLegNotional: 297_310_000n,
    rawFillFeesByAsset: [assetAmount(usdc, 9_000n)],
    builderFeesByAsset: [],
    normalizedVenueFeesByAsset: [assetAmount(usdc, 9_000n)],
    protocolFee: assetAmount(usdc, 5_000n),
    solverFee: assetAmount(usdc, 10_000n),
    feePolicyVersion: 3,
    feePolicyManifestHash: hash(6),
    maxResidualBaseQuantityObserved: 0n,
    timeUnhedgedMs: 0n,
    recoveryCostByAsset: [],
    recoveryRefundByAsset: [],
    priorityFee: assetAmount(usdc, 5_000n),
    finalityStatus: 'FINALIZED',
    fieldEvidence: ['evidenceManifestHash', 'orderHash', 'protocolFee', 'quantity', 'quoteHash', 'solverFee', 'spotExecutionPrice', 'terminalState']
      .map((fieldId) => ({ fieldId, grade: 'CONSENSUS_VERIFIED' as const, onchainEnforced: true })),
    timestampValue: 1_790_000_000_000n,
    ...overrides,
  };
}

function outcome(overrides: Partial<TerminalOutcomeInput> = {}): TerminalOutcomeInput {
  return {
    outcomeVersion: 1,
    environment: 'testnet',
    domain,
    orderHash,
    packageTemplateManifestHash: '44'.repeat(32),
    templateRegistryReference: hash(4),
    terminalState: 'FINALIZED_COMPLETE',
    attemptIds: ['attempt-1'],
    responseAvailability: 'ABSENT',
    responseAbsenceReason: 'chain-event-only',
    authoritativeEvidenceRefs: [hash(51)],
    evidenceManifestHash: evidenceManifestHash(manifest()),
    residualValuationApplicability: 'NOT_APPLICABLE',
    authorizedResidualValue: { availability: 'NOT_APPLICABLE' },
    terminalResidualMark: { availability: 'NOT_APPLICABLE' },
    successfulReceiptHash: packageReceiptHash(receipt()),
    issuerKind: 'CONSENSUS_EVENT',
    issuer: 'verifier-program',
    fieldEvidence: ['evidenceManifestHash', 'orderHash', 'terminalState'].map((fieldId) => ({ fieldId, grade: 'CONSENSUS_VERIFIED' as const, onchainEnforced: true })),
    timestampValue: 1_790_000_000_000n,
    ...overrides,
  };
}

const terms: AcceptedQuoteFeeTerms = {
  protocolFee: assetAmount(usdc, 5_000n),
  solverFee: assetAmount(usdc, 10_000n),
  feePolicyVersion: 3,
  feePolicyManifestHash: hash(6),
  maxRecoveryCostByAsset: [],
};

function served(input: { outcome?: TerminalOutcomeInput; receipt?: PackageReceiptInput | null; overrides?: Record<string, unknown> } = {}) {
  const chosenOutcome = input.outcome ?? outcome();
  const chosenReceipt = input.receipt === null ? undefined : input.receipt ?? receipt();
  return {
    orderHash: orderHashHex,
    terminalState: chosenOutcome.terminalState,
    evidenceManifest: manifest(),
    evidenceManifestHash: toHex(evidenceManifestHash(manifest())),
    outcome: chosenOutcome,
    outcomeHash: toHex(terminalOutcomeHash(chosenOutcome)),
    ...(chosenReceipt === undefined ? {} : { receipt: chosenReceipt, receiptHash: toHex(packageReceiptHash(chosenReceipt)) }),
    recordedAtMs: 1_000,
    ...input.overrides,
  };
}

type Route = { status?: number; body: unknown };

function serve(routes: Record<string, Route>, seen: { method: string; path: string; body?: unknown }[] = []): FetchLike {
  return async (url, init) => {
    const path = url.replace('https://api.example', '');
    seen.push({ method: init.method, path, ...(init.body === undefined ? {} : { body: fromProtocolJson(JSON.parse(init.body)) }) });
    const route = routes[`${init.method} ${path}`];
    const status = route === undefined ? 404 : route.status ?? 200;
    const body = route === undefined ? { error: { code: 'NOT_FOUND', message: 'missing' } } : route.body;
    return { status, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(toProtocolJson(body)) };
  };
}

const client = (routes: Record<string, Route>, seen?: { method: string; path: string; body?: unknown }[]) =>
  new NaryxClient({ baseUrl: 'https://api.example', fetch: serve(routes, seen) });

describe('order intake and terminal evidence', () => {
  test('base58 matches the reference alphabet, including leading zero bytes', () => {
    assert.equal(base58Encode(new TextEncoder().encode('Hello World!')), '2NEpo7TZRRrLZSi2U');
    assert.equal(base58Encode(new Uint8Array([0, 0, 1])), '112');
    assert.equal(base58Encode(new Uint8Array([])), '');
  });

  test('the signer sees only canonical order bytes, and the acknowledged hash must be the local one', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const signed: Uint8Array[] = [];
    const signer = async (bytes: Uint8Array) => {
      signed.push(bytes);
      return new Uint8Array(sign(null, bytes, privateKey));
    };
    const seen: { method: string; path: string; body?: unknown }[] = [];
    const accepted = await client({ 'POST /v1/orders': { body: { orderHashHex: ORDER_HASH, replayed: false, status: 'ACCEPTED_FOR_QUOTING' } } }, seen).submitOrder(ORDER, signer);
    assert.deepEqual(accepted, { orderHash: ORDER_HASH, replayed: false, status: 'ACCEPTED_FOR_QUOTING' });
    assert.deepEqual(signed, [packageOrderBytes(ORDER)]);
    const authorization = (seen[0]?.body as { authorization: { scheme: string; signature: string } }).authorization;
    assert.equal(authorization.scheme, 'ED25519');
    assert.equal(authorization.signature, base58Encode(new Uint8Array(sign(null, packageOrderBytes(ORDER), privateKey))));

    await assert.rejects(
      client({ 'POST /v1/orders': { body: { orderHashHex: 'ab'.repeat(32), replayed: false, status: 'ACCEPTED_FOR_QUOTING' } } }).submitOrder(ORDER, signer),
      /different order hash/,
    );
    await assert.rejects(client({}).submitOrder(ORDER, async () => new Uint8Array(12)), /64-byte signature/);
  });

  test('a served order must hash to the requested hash and an open order carries no outcome', async () => {
    const path = `GET /v1/orders/${ORDER_HASH}`;
    const open = await client({ [path]: { body: { orderHash: ORDER_HASH, order: ORDER, owner: ORDER.owner, status: 'OPEN', receivedAtMs: 5 } } }).getOrder(ORDER_HASH);
    assert.equal(open.status, 'OPEN');
    assert.equal(open.receivedAtMs, 5);
    const swapped = { ...ORDER, expiryValue: ORDER.expiryValue + 1n };
    await assert.rejects(client({ [path]: { body: { orderHash: ORDER_HASH, order: swapped, owner: ORDER.owner, status: 'OPEN' } } }).getOrder(ORDER_HASH), /does not hash/);
    await assert.rejects(
      client({ [path]: { body: { orderHash: ORDER_HASH, status: 'OPEN', outcomeHash: 'cd'.repeat(32) } } }).getOrder(ORDER_HASH),
      /open order cannot carry/,
    );
    await assert.rejects(client({ [path]: { body: { orderHash: ORDER_HASH, status: 'SETTLED' } } }).getOrder(ORDER_HASH), /unknown/);
    await assert.rejects(client({ [path]: { body: { orderHash: ORDER_HASH, status: 'NO_EFFECT' } } }).getOrder(ORDER_HASH), /must name its outcome/);
  });

  test('receipts are re-hashed, linked to their outcome, and checked against the accepted fees', async () => {
    const path = `GET /v1/receipts/${orderHashHex}`;
    const verified = await client({ [path]: { body: served() } }).getReceipt(orderHashHex, { acceptedQuoteFeeTerms: terms });
    assert.equal(verified.terminalState, 'FINALIZED_COMPLETE');
    assert.equal(verified.feesVerified, true);
    assert.equal(verified.receiptHash, toHex(packageReceiptHash(receipt())));

    const unchecked = await client({ [path]: { body: served() } }).getReceipt(orderHashHex);
    assert.equal(unchecked.feesVerified, false);

    // A receipt edited after the outcome was issued no longer matches the hash the outcome links.
    const edited = receipt({ solverFee: assetAmount(usdc, 10_001n) });
    await assert.rejects(client({ [path]: { body: served({ receipt: edited }) } }).getReceipt(orderHashHex), /do not link: RECEIPT_HASH_MISMATCH/);
    // An overcharge the outcome does link is still caught against the accepted quote.
    const overcharged = served({ outcome: outcome({ successfulReceiptHash: packageReceiptHash(edited) }), receipt: edited });
    await assert.rejects(client({ [path]: { body: overcharged } }).getReceipt(orderHashHex, { acceptedQuoteFeeTerms: terms }), /charged outside/);

    await assert.rejects(client({ [path]: { body: served({ overrides: { receiptHash: 'ee'.repeat(32) } }) } }).getReceipt(orderHashHex), /receipt does not hash/);
    await assert.rejects(client({ [path]: { body: served({ overrides: { outcomeHash: 'ee'.repeat(32) } }) } }).getReceipt(orderHashHex), /outcome does not hash/);
    await assert.rejects(client({ [path]: { body: served({ receipt: null }) } }).getReceipt(orderHashHex), /must be served with its receipt/);
    await assert.rejects(client({ [path]: { body: served({ overrides: { terminalState: 'NO_EFFECT' } }) } }).getReceipt(orderHashHex), /not the outcome state/);

    const { successfulReceiptHash: _dropped, ...rest } = outcome();
    void _dropped;
    const noEffectInput: TerminalOutcomeInput = { ...rest, terminalState: 'NO_EFFECT' };
    const flat = await client({ [path]: { body: served({ outcome: noEffectInput, receipt: null }) } }).getReceipt(orderHashHex);
    assert.equal(flat.terminalState, 'NO_EFFECT');
    assert.equal(flat.receipt, undefined);
    await assert.rejects(client({ [path]: { body: served({ outcome: noEffectInput }) } }).getReceipt(orderHashHex), /not a successful outcome/);

    const other = toHex(hash(9));
    await assert.rejects(
      client({ [`GET /v1/receipts/${other}`]: { body: { ...served(), orderHash: other } } }).getReceipt(other),
      /names another order/,
    );
  });

  test('execution quality must be observed and internally consistent', async () => {
    const byTerminalState = {
      FINALIZED_COMPLETE: 3,
      FINALIZED_BOUNDED: 0,
      RECOVERED_COMPLETE: 0,
      RECOVERED_BOUNDED: 0,
      RECOVERED_FLAT: 1,
      MANUAL_INTERVENTION: 0,
      NO_EFFECT: 0,
    };
    const body = {
      label: 'OBSERVED',
      methodology: 'counts',
      solverId: 'solver-a',
      terminalOutcomes: 4,
      byTerminalState,
      successfulBps: 7_500,
      recoveredBps: 2_500,
      timeUnhedgedMs: { median: 0n, p95: 10n, max: 10n },
      receiptFieldEvidence: { CONSENSUS_VERIFIED: 24 },
    };
    const path = 'GET /v1/analytics/execution-quality?solverId=solver-a';
    const quality = await client({ [path]: { body } }).getExecutionQuality({ solverId: 'solver-a' });
    assert.equal(quality.successfulBps, 7_500);
    assert.deepEqual(quality.timeUnhedgedMs, { median: 0n, p95: 10n, max: 10n });
    await assert.rejects(client({ [path]: { body: { ...body, terminalOutcomes: 5 } } }).getExecutionQuality({ solverId: 'solver-a' }), /do not sum/);
    await assert.rejects(client({ [path]: { body: { ...body, label: 'MODELED' } } }).getExecutionQuality({ solverId: 'solver-a' }), /OBSERVED/);
    await assert.rejects(client({ [path]: { body: { ...body, solverId: 'solver-b' } } }).getExecutionQuality({ solverId: 'solver-a' }), /another solver/);
    await assert.rejects(
      client({ [path]: { body: { ...body, timeUnhedgedMs: { median: 11n, p95: 10n, max: 10n } } } }).getExecutionQuality({ solverId: 'solver-a' }),
      /not ordered/,
    );
  });

  test('private RFQ envelopes are signed over their locally computed hash by the sender key', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const envelope: PrivateRfqEnvelopeInput = {
      envelopeVersion: 1,
      environment: 'testnet',
      domain,
      templateId: 'cash-and-carry-v1',
      templateVersion: 1,
      packageTemplateManifestHash: '44'.repeat(32),
      orderHash: '55'.repeat(32),
      senderKeyId: 'sender-key',
      responseEncryptionKey: new Uint8Array(32).fill(7),
      recipientSolverId: 'solver-a',
      recipientEncryptionKeyId: 'rfq-1',
      encryptionSuiteId: 'suite-1',
      ciphertextHash: hash(8),
      createdAtUnit: 'EVM_UNIX_SECONDS',
      createdAtValue: 10n,
      expiresAtUnit: 'EVM_UNIX_SECONDS',
      expiresAtValue: 70n,
      envelopeNonce: 1n,
    };
    const envelopeHash = privateRfqEnvelopeHash(envelope);
    const signedHashes: Uint8Array[] = [];
    const signer = async (digest: Uint8Array) => {
      signedHashes.push(digest);
      return new Uint8Array(sign(null, digest, privateKey));
    };
    const seen: { method: string; path: string; body?: unknown }[] = [];
    const results = await client({ 'POST /v1/rfqs/private': { body: { results: [{ admitted: true, envelopeHashHex: toHex(envelopeHash), created: true }] } } }, seen)
      .submitPrivateRfq([{ envelope, ciphertext: new Uint8Array([1]) }], signer);
    assert.equal(results[0]?.admitted, true);
    assert.deepEqual(signedHashes, [envelopeHash]);
    const sent = (seen[0]?.body as { envelopes: { senderSignature: Uint8Array }[] }).envelopes[0];
    assert.deepEqual(sent?.senderSignature, new Uint8Array(sign(null, envelopeHash, privateKey)));
    await assert.rejects(
      client({ 'POST /v1/rfqs/private': { body: { results: [{ admitted: true, envelopeHashHex: 'ab'.repeat(32) }] } } }).submitPrivateRfq([{ envelope, ciphertext: new Uint8Array([1]) }], signer),
      /names another envelope/,
    );
    await assert.rejects(client({}).submitPrivateRfq([{ envelope, ciphertext: new Uint8Array([1]) }], async () => new Uint8Array(3)), /64-byte signature/);
  });

  test('an outcome read re-hashes the outcome and names only the receipt the outcome links', async () => {
    const path = `GET /v1/outcomes/${orderHashHex}`;
    const { receipt: _receipt, ...withoutReceipt } = served();
    void _receipt;
    const read = await client({ [path]: { body: withoutReceipt } }).getOutcome(orderHashHex);
    assert.equal(read.receiptHash, toHex(packageReceiptHash(receipt())));
    await assert.rejects(client({ [path]: { body: { ...withoutReceipt, receiptHash: 'ee'.repeat(32) } } }).getOutcome(orderHashHex), /not the one the outcome links/);
    await assert.rejects(client({ [path]: { body: { ...withoutReceipt, outcomeHash: 'ee'.repeat(32) } } }).getOutcome(orderHashHex), /does not hash/);
  });

  test('curves and the opportunity feed must answer every requested size with the right labels', async () => {
    const quote = (size: bigint, averagePriceTicks?: bigint) => ({
      size,
      fillableQuantity: averagePriceTicks === undefined ? 0n : size,
      label: 'EXECUTABLE',
      ...(averagePriceTicks === undefined ? {} : { averagePriceTicks }),
    });
    const trade = { priceTicks: 100n, quantity: 10n, recordedAtMs: 5, allocationHash: 'ab'.repeat(32), label: 'OBSERVED' };
    const curve = {
      seriesId: 'sol-carry',
      quoteAsset: 'usd',
      quoteConvention: 'annualized-net-yield-v1',
      asOfValue: 1n,
      methodologyVersion: 1,
      points: [
        { executionClassId: 'class-a', settlementClass: 'ATOMIC_POSTCONDITION', domains: ['svm:testnet'], open: true, halted: false, executable: { bids: [quote(10n, 96n)], asks: [quote(10n, 104n)] }, lastTrade: trade },
        { executionClassId: 'class-b', settlementClass: 'ASYNC_BONDED_SOLVER', domains: ['evm:base'], open: false },
      ],
    };
    const curvePath = 'GET /v1/curves/sol-carry?sizes=10';
    const read = await client({ [curvePath]: { body: curve } }).getCurve('sol-carry', [10n]);
    assert.equal(read.points[0]?.lastTrade?.priceTicks, 100n);
    assert.equal(read.points[1]?.open, false);
    const mislabeled = { ...curve, points: [{ ...curve.points[0], lastTrade: { ...trade, label: 'MODELED' } }] };
    await assert.rejects(client({ [curvePath]: { body: mislabeled } }).getCurve('sol-carry', [10n]), /OBSERVED/);
    const phantom = { ...curve, points: [{ ...curve.points[0], executable: { bids: [{ ...quote(10n, 96n), fillableQuantity: 5n }], asks: [quote(10n, 104n)] } }] };
    await assert.rejects(client({ [curvePath]: { body: phantom } }).getCurve('sol-carry', [10n]), /depth it does not have/);
    const closedWithData = { ...curve, points: [{ ...curve.points[1], lastTrade: trade }] };
    await assert.rejects(client({ [curvePath]: { body: closedWithData } }).getCurve('sol-carry', [10n]), /closed but carries/);

    const feedPath = 'GET /v1/opportunities?size=10';
    const feed = {
      asOfValue: 1n,
      size: 10n,
      label: 'EXECUTABLE',
      opportunities: [
        { packageMarketId: 'class-a', seriesId: 'sol-carry', bid: quote(10n, 96n), ask: quote(10n, 104n), spreadAtSizeTicks: 8n, lastTrade: trade },
        { packageMarketId: 'class-c', bid: quote(10n, 90n), ask: quote(10n, 110n), spreadAtSizeTicks: 20n },
        { packageMarketId: 'class-d', ask: quote(10n, 120n) },
      ],
    };
    const opportunities = await client({ [feedPath]: { body: feed } }).getOpportunities(10n);
    assert.deepEqual(opportunities.map((entry) => [entry.packageMarketId, entry.spreadAtSizeTicks]), [['class-a', 8n], ['class-c', 20n], ['class-d', undefined]]);
    const unordered = { ...feed, opportunities: [feed.opportunities[1], feed.opportunities[0]] };
    await assert.rejects(client({ [feedPath]: { body: unordered } }).getOpportunities(10n), /not ordered/);
    const wrongSpread = { ...feed, opportunities: [{ ...feed.opportunities[0], spreadAtSizeTicks: 1n }] };
    await assert.rejects(client({ [feedPath]: { body: wrongSpread } }).getOpportunities(10n), /ask minus its bid/);
    await assert.rejects(client({ [feedPath]: { body: { ...feed, size: 20n } } }).getOpportunities(10n), /requested size/);
  });

  test('qualification reads re-hash every record and reject a history a monitor loosened', async () => {
    const base: QualificationRecordInput = {
      recordVersion: 1,
      environment: 'testnet',
      objectType: 'VENUE',
      objectId: 'phoenix-sol-usdc',
      domain,
      state: 'ACTIVE',
      effectiveLimits: { maximumNotionalQuoteAtoms: 1_000n, maximumOpenPackages: 5 },
      evidenceRefs: [hash(21)],
      triggerCodes: [],
      timeUnit: 'EVM_UNIX_SECONDS',
      observedAtValue: 100n,
      effectiveAtValue: 200n,
      authorityKind: 'REVIEWED_ACTIVATION',
      authority: 'qualification-key-1',
      reviewerIds: ['reviewer-a', 'reviewer-b'],
      signature: new Uint8Array(64),
    };
    const downgrade: QualificationRecordInput = {
      ...base,
      state: 'EXIT_ONLY',
      observedAtValue: 300n,
      effectiveAtValue: 300n,
      authorityKind: 'AUTOMATED_MONITOR',
      reviewerIds: [],
      previousRecordHash: qualificationRecordHash(base),
    };
    const entry = (value: QualificationRecordInput) => ({ record: value, recordHash: toHex(qualificationRecordHash(value)), recordedAtMs: 1 });
    const historyPath = 'GET /v1/qualification/VENUE/phoenix-sol-usdc/history';
    const history = await client({ [historyPath]: { body: { objectType: 'VENUE', objectId: 'phoenix-sol-usdc', records: [entry(base), entry(downgrade)] } } })
      .getQualificationHistory('VENUE', 'phoenix-sol-usdc');
    assert.deepEqual(history.map((value) => value.record.state), ['ACTIVE', 'EXIT_ONLY']);

    const loosened: QualificationRecordInput = { ...downgrade, state: 'ACTIVE', observedAtValue: 400n, effectiveAtValue: 400n, previousRecordHash: qualificationRecordHash(downgrade) };
    await assert.rejects(
      client({ [historyPath]: { body: { objectType: 'VENUE', objectId: 'phoenix-sol-usdc', records: [entry(base), entry(downgrade), entry(loosened)] } } }).getQualificationHistory('VENUE', 'phoenix-sol-usdc'),
      /breaks at record 2: MONITOR_CANNOT_LOOSEN/,
    );
    await assert.rejects(
      client({ [historyPath]: { body: { objectType: 'VENUE', objectId: 'phoenix-sol-usdc', records: [{ ...entry(base), recordHash: 'ab'.repeat(32) }] } } }).getQualificationHistory('VENUE', 'phoenix-sol-usdc'),
      /does not hash/,
    );

    const currentPath = 'GET /v1/qualification/VENUE/phoenix-sol-usdc';
    const current = await client({ [currentPath]: { body: { objectType: 'VENUE', objectId: 'phoenix-sol-usdc', asOfValue: 350n, ...entry(downgrade) } } }).getQualification('VENUE', 'phoenix-sol-usdc');
    assert.ok('current' in current && current.current.record.state === 'EXIT_ONLY');
    await assert.rejects(
      client({ [currentPath]: { body: { objectType: 'VENUE', objectId: 'phoenix-sol-usdc', asOfValue: 250n, ...entry(downgrade) } } }).getQualification('VENUE', 'phoenix-sol-usdc'),
      /does not govern/,
    );
    const expired = await client({ [currentPath]: { body: { objectType: 'VENUE', objectId: 'phoenix-sol-usdc', unavailable: 'EXPIRED' } } }).getQualification('VENUE', 'phoenix-sol-usdc');
    assert.deepEqual(expired, { objectType: 'VENUE', objectId: 'phoenix-sol-usdc', unavailable: 'EXPIRED' });
  });

  test('order quotes must re-hash, bind their route and order, and carry a key the solver registered', async () => {
    const keyPair = () => {
      const { publicKey, privateKey } = generateKeyPairSync('ed25519');
      return { raw: new Uint8Array((publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32)), sign: (message: Uint8Array) => new Uint8Array(sign(null, message, privateKey)) };
    };
    const operator = keyPair();
    const quoteKey = keyPair();
    const manifestFor = (verificationKey: Uint8Array, overrides: Partial<SolverCapabilityManifestInput> = {}): SolverCapabilityManifestInput => {
      const unsigned: SolverCapabilityManifestInput = {
        manifestVersion: 1,
        environment: 'testnet',
        solverId: 'solver-a',
        commonControlGroupId: 'org-a',
        operatorIdentityScheme: 'ED25519',
        operatorIdentityKey: operator.raw,
        quoteVerificationKeys: [{ keyId: 'q-1', scheme: 'ED25519', verificationKey, validFromValue: 0n, validUntilValue: 4_000_000_000n }],
        rfqEncryptionKeys: [],
        supportedDomains: [ORDER_QUOTE.quote.domain],
        supportedTemplateIds: ['cash-and-carry-v1'],
        supportedQuoteModes: ['EXECUTION_COMMITMENT'],
        maximumNotionalByMarket: [{ marketId: 'sol-carry', quoteAsset: usdc, maximumNotionalAtoms: 1_000n }],
        rfqEndpoints: ['https://solver-a.example/rfq'],
        validityUnit: 'EVM_UNIX_SECONDS',
        validUntilValue: 4_000_000_000n,
        manifestNonce: 1n,
        signature: new Uint8Array(64),
        ...overrides,
      };
      return { ...unsigned, signature: operator.sign(solverCapabilityManifestHash(unsigned)) };
    };
    const registered = manifestFor(quoteKey.raw);
    const registeredHash = toHex(solverCapabilityManifestHash(registered));
    const rebound = (manifestHash: string, key = quoteKey): SolverQuoteInput => {
      const unsigned = { ...ORDER_QUOTE.quote, solverCapabilityManifestHash: manifestHash, solverVerificationKey: key.raw };
      return { ...unsigned, signature: key.sign(solverSignatureDigest(unsigned)) };
    };
    const { route } = ORDER_QUOTE;
    const entry = (quote: SolverQuoteInput, overrides: Record<string, unknown> = {}) => ({
      quoteHash: toHex(quoteHash(quote)),
      routeHash: toHex(routeHash(route)),
      quoteMode: quote.quoteMode,
      solverId: quote.solverId,
      quote,
      route,
      receivedAtMs: 5,
      ...overrides,
    });
    const quotesPath = `GET /v1/orders/${ORDER_HASH}/quotes`;
    const manifestPath = (hash: string) => `GET /v1/solvers/solver-a/manifests/${hash}`;
    const manifestBody = (manifest: SolverCapabilityManifestInput, overrides: Record<string, unknown> = {}) => ({
      body: { solverId: 'solver-a', manifestHash: toHex(solverCapabilityManifestHash(manifest)), manifestNonce: 1, manifest, ...overrides },
    });
    const read = (quotes: unknown[], manifests: Record<string, { body: unknown; status?: number }> = { [manifestPath(registeredHash)]: manifestBody(registered) }) =>
      client({ [quotesPath]: { body: { orderHash: ORDER_HASH, quotes } }, ...manifests }).getOrderQuotes(ORDER_HASH);

    const quote = rebound(registeredHash);
    const [verified] = await read([entry(quote)]);
    assert.equal(verified?.quoteHash, toHex(quoteHash(quote)));
    // Node ships Ed25519 in Web Crypto, so the quote and the operator's manifest are checked locally.
    assert.equal(verified?.signatureVerified, true);
    await assert.rejects(read([entry({ ...quote, signature: new Uint8Array(64).fill(1) })]), /signature does not verify/);
    await assert.rejects(read([entry(quote, { quoteHash: 'ab'.repeat(32) })]), /served hashes/);
    await assert.rejects(read([entry(quote, { quoteMode: 'FIRM_ONCHAIN' })]), /labels differ/);
    const otherRoute = { ...route, routeExpiryValue: route.routeExpiryValue + 1n };
    await assert.rejects(read([entry(quote, { route: otherRoute, routeHash: toHex(routeHash(otherRoute)) })]), /does not bind its served route/);

    // A quote signed by a key the solver never registered is refused, even when it verifies.
    const stranger = keyPair();
    await assert.rejects(read([entry(rebound(registeredHash, stranger))]), /not registered in the solver's manifest/);
    // A manifest the operator did not sign, or one that does not hash to what the quote binds, is refused.
    const forged = { ...registered, signature: new Uint8Array(64).fill(9) };
    await assert.rejects(read([entry(quote)], { [manifestPath(registeredHash)]: manifestBody(forged) }), /operator signature does not verify/);
    const other = manifestFor(quoteKey.raw, { manifestNonce: 2n });
    await assert.rejects(read([entry(quote)], { [manifestPath(registeredHash)]: manifestBody(other, { manifestHash: registeredHash }) }), /does not hash/);
    // Without a registry the binding cannot be checked, so the quote is served but not verified.
    const [unverifiable] = await read([entry(quote)], { [manifestPath(registeredHash)]: { status: 503, body: { error: { code: 'REGISTRY_UNAVAILABLE', message: 'none' } } } });
    assert.equal(unverifiable?.signatureVerified, false);
  });

  test('route decisions are replayed locally and must agree with the served hash and replay', async () => {
    const eligible = (fill: number, expectedNetOutcomeAtoms: bigint) => ({
      routeHash: new Uint8Array(32).fill(fill),
      expectedNetOutcomeAtoms,
      feesAtoms: 5n,
      marginAtoms: 500n,
      residualAtoms: 0n,
      recoveryBoundAtoms: 20n,
      completionCohortBps: 9_900n,
      deliveryPolicyId: 'public-relay',
      resourceHeadroomBps: 4_000n,
    });
    const decision = {
      decisionVersion: 1,
      orderHash: ORDER_HASH,
      solverId: 'solver-a',
      stateSnapshots: [{ domainId: 'svm:testnet', sourceId: 'rpc-a', sequence: 9n, receivedAtValue: 95n, stateHash: new Uint8Array(32).fill(1) }],
      normalizationPolicyHash: new Uint8Array(32).fill(2),
      objective: { kind: 'MAXIMIZE_NET_OUTCOME' as const, maximumResidualAtoms: 50n, maximumStateAgeValue: 50n, maximumSourceSkewValue: 20n },
      eligible: [eligible(10, 100n), eligible(11, 90n)],
      excluded: [],
      selectedRouteHash: new Uint8Array(32).fill(10),
      resourcePlanHash: new Uint8Array(32).fill(3),
      decisionAtValue: 100n,
      quoteToSubmitBudgetValue: 2n,
    };
    const replay = replayRouteDecision(decision);
    const served = (overrides: Record<string, unknown> = {}) => ({
      decisionHash: toHex(replay.decisionHash),
      solverId: 'solver-a',
      decision,
      replay: { valid: replay.valid, discrepancies: replay.discrepancies },
      receivedAtMs: 7,
      ...overrides,
    });
    const path = `GET /v1/orders/${ORDER_HASH}/route-decisions`;
    const read = (decisions: unknown[]) => client({ [path]: { body: { orderHash: ORDER_HASH, decisions } } }).getRouteDecisions(ORDER_HASH);
    const [verified] = await read([served()]);
    assert.equal(verified?.replay.valid, true);
    await assert.rejects(read([served({ decisionHash: 'ab'.repeat(32) })]), /served hash/);
    // A server cannot launder a bad decision by claiming its replay was clean.
    const loser = { ...decision, selectedRouteHash: new Uint8Array(32).fill(11) };
    await assert.rejects(read([served({ decision: loser, decisionHash: toHex(replayRouteDecision(loser).decisionHash) })]), /replay differs/);
    await assert.rejects(read([served({ decision: { ...decision, orderHash: 'cd'.repeat(32) } })]), /another order/);
  });

  test('positions are re-hashed and signature-checked against trusted keys, and risk is recomputed locally', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const trustedKey = new Uint8Array((publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32));
    const btc = assetRef('btc', '44'.repeat(32), 8);
    const position = {
      adapterVersion: 1,
      snapshotId: 'hl:perp:BTC',
      domain,
      observedAtMs: 1_000n,
      owner: 'strategy-1',
      venueId: 'hypercore',
      marketId: 'btc-perp',
      underlyingId: 'btc',
      positionType: 'PERPETUAL' as const,
      quantityBaseAtoms: -50_000_000n,
      markPrice: { baseAsset: btc, quoteAsset: usdc, quoteAtoms: 600n, baseAtoms: 1n, roundingDirection: 'AWAY_FROM_ZERO' as const },
      collateralQuoteAtoms: 3_000_000_000n,
      dependencyIds: ['venue:hypercore'],
      riskDomainId: 'btc-carry',
      closeRoutes: [{ routeId: 'ioc-close', executableQuantityAtoms: 50_000_000n, expectedCostQuoteAtoms: 15_000_000n, settlementDelayMs: 1_000n, authorityHeld: true, requiredDependencyIds: ['venue:hypercore'] }],
    };
    const unsigned = {
      recordVersion: 1,
      environment: 'testnet',
      strategyAccount: 'strategy-1',
      sourceId: 'hypercore-testnet-info',
      observedAtMs: 1_500n,
      positions: [position],
      unmappedInstruments: [],
      sourceEvidenceHash: '45'.repeat(32),
      authority: 'position-key-1',
      signature: new Uint8Array(0),
    };
    const signed = { ...unsigned, signature: new Uint8Array(sign(null, positionSnapshotRecordHash(unsigned), privateKey)) };
    const normalized = positionSnapshotRecord(signed);
    const positionsBody = (record = signed) => ({
      strategyAccount: 'strategy-1',
      label: 'OBSERVED',
      sources: [{ sourceId: record.sourceId, recordHash: toHex(positionSnapshotRecordHash(record)), observedAtMs: record.observedAtMs, ageMs: 500n, positionCount: 1, unmappedInstruments: [] }],
      records: [record],
      positions: record.positions.map((entry) => ({ sourceId: record.sourceId, position: entry })),
    });
    const riskBody = (exposure: unknown = buildExposureGraph(normalized.positions, usdc)) => ({
      strategyAccount: 'strategy-1',
      methodology: 'uniform shocks',
      byAccountingAsset: [{ accountingAsset: usdc, exposure, closeCost: packageCloseCostIndex(normalized.positions), stress: { label: 'MODELED', results: [] } }],
    });
    const trust = new Map([['position-key-1', trustedKey]]);
    const reader = (positions: unknown, risk: unknown = riskBody()) => client({ 'GET /v1/positions/strategy-1': { body: positions }, 'GET /v1/risk/strategy-1': { body: risk } });
    const verified = await reader(positionsBody()).getPositions('strategy-1', { trustedAuthorities: trust });
    assert.equal(verified.sources[0]?.signatureVerified, true);
    assert.equal((await reader(positionsBody()).getPositions('strategy-1')).sources[0]?.signatureVerified, false);
    await assert.rejects(reader(positionsBody()).getPositions('strategy-1', { trustedAuthorities: new Map([['position-key-1', new Uint8Array(32).fill(9)]]) }), /does not verify/);
    // A position altered after signing no longer matches its served hash.
    const altered = positionsBody();
    altered.records = [{ ...signed, positions: [{ ...position, quantityBaseAtoms: -1n }] }];
    await assert.rejects(reader(altered).getPositions('strategy-1'), /does not describe its record/);
    const risk = await reader(positionsBody()).getRisk('strategy-1', { trustedAuthorities: trust });
    assert.equal(risk.byAccountingAsset.length, 1);
    const inflated = { ...buildExposureGraph(normalized.positions, usdc), byUnderlying: [] };
    await assert.rejects(reader(positionsBody(), riskBody(inflated)).getRisk('strategy-1'), /differs from the local computation/);
  });

  test('graph simulations must match the local failure-point walk and graph hash', async () => {
    const legFor = (legId: string) => ({
      legId,
      legFamily: 'SPOT_SWAP' as const,
      legTypeId: 'spot-purchase',
      domain,
      adapter: adapterRef({ adapterId: 'spot-adapter-v1', adapterManifestVersion: 1, adapterManifestHash: new Uint8Array(32).fill(5) }),
      venue: versionedManifestRef('venue-a', 1, new Uint8Array(32).fill(6)),
      market: versionedManifestRef('sol-usdc', 1, new Uint8Array(32).fill(7)),
      assets: [usdc],
      side: 'BUY' as const,
      quantityAsset: usdc,
      quantityAtoms: 10n,
      minimumQuantityAtoms: 10n,
      maximumFeeQuoteAtoms: 1n,
      preconditionHashes: [],
      postconditionHashes: [],
      timeInForce: 'IOC' as const,
      legExpiryValue: 100n,
    });
    const graph = {
      graphVersion: 1,
      environment: 'testnet',
      templateId: 'basis-graph-v1',
      templateVersion: 1,
      packageTemplateManifestHash: new Uint8Array(32).fill(8),
      seriesId: 'series',
      executionClassId: 'class',
      lifecycleAction: 'ENTRY' as const,
      owner: 'trader',
      strategyAccountRefs: ['strategy'],
      legs: [legFor('a'), legFor('b')],
      dependencyEdges: [{ fromLegId: 'a', toLegId: 'b' }],
      executionGroups: [],
      settlementClass: 'BATCHED_IOC_WITH_RECOVERY' as const,
      policyHashes: { netting: new Uint8Array(32).fill(1), privacy: new Uint8Array(32).fill(1), solver: new Uint8Array(32).fill(1), delivery: new Uint8Array(32).fill(1), resource: new Uint8Array(32).fill(1), portfolioRiskLimits: new Uint8Array(32).fill(1) },
      recoverySlots: [
        { legId: 'a', action: 'ROLLBACK' as const, maximumQuantityAtoms: 10n, maximumCostQuoteAtoms: 2n },
        { legId: 'b', action: 'COMPLETE' as const, maximumQuantityAtoms: 10n, maximumCostQuoteAtoms: 3n },
      ],
      maximumRecoveryCostQuoteAtoms: 5n,
      expiryUnit: 'EVM_UNIX_SECONDS' as const,
      packageExpiryValue: 100n,
      nonce: 1n,
    };
    const local = simulatePackageGraphFailures(graph);
    const body = (failurePoints: unknown) => ({ label: 'SIMULATED', graphHash: toHex(packageGraphHash(graph)), stages: [['a'], ['b']], failurePoints });
    const simulated = await client({ 'POST /v1/packages/simulate': { body: body(local) } }).simulatePackageGraph(graph);
    assert.equal(simulated.failurePoints[0]?.recoverable, true);
    await assert.rejects(client({ 'POST /v1/packages/simulate': { body: body([]) } }).simulatePackageGraph(graph), /differ from the local simulation/);
  });

  test('watching an order returns its terminal status and gives up after its timeout', async () => {
    let reads = 0;
    const statuses = ['OPEN', 'OPEN', 'FINALIZED_COMPLETE'];
    const fetcher: FetchLike = async () => {
      const status = statuses[Math.min(reads, statuses.length - 1)];
      reads += 1;
      const body = status === 'OPEN' ? { orderHash: ORDER_HASH, status } : { orderHash: ORDER_HASH, status, outcomeHash: 'ab'.repeat(32) };
      return { status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(toProtocolJson(body)) };
    };
    const watched = await new NaryxClient({ baseUrl: 'https://api.example', fetch: fetcher }).watchOrder(ORDER_HASH, { intervalMs: 100, timeoutMs: 5_000 });
    assert.equal(watched.status, 'FINALIZED_COMPLETE');
    assert.equal(reads, 3);
    const open = client({ [`GET /v1/orders/${ORDER_HASH}`]: { body: { orderHash: ORDER_HASH, status: 'OPEN' } } });
    await assert.rejects(open.watchOrder(ORDER_HASH, { intervalMs: 100, timeoutMs: 250 }), /no terminal outcome within the timeout/);
  });

  test('the stream auth message signs a GET of the stream path with an empty body and a fresh nonce', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const solver = new NaryxSolverClient({ baseUrl: 'https://api.example', solverId: 'solver-a', keyId: 'q-1', sign: async (digest) => new Uint8Array(sign(null, digest, privateKey)), fetch: serve({}), now: () => 1_900_000_000_000 });
    const first = await solver.streamAuthMessage();
    const second = await solver.streamAuthMessage();
    assert.notEqual(first.nonce, second.nonce);
    const digest = solverRequestDigest({
      method: 'GET',
      pathAndQuery: '/v1/solver/stream',
      bodySha256: new Uint8Array(createHash('sha256').update('').digest()),
      solverId: 'solver-a',
      keyId: 'q-1',
      timestampMs: 1_900_000_000_000n,
      nonce: first.nonce as string,
    });
    assert.equal(verify(null, digest, publicKey, Buffer.from(first.signature as string, 'hex')), true);
  });

  test('a solver polls open orders and rejects any whose served hash it cannot recompute', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const signer = async (digest: Uint8Array) => new Uint8Array(sign(null, digest, privateKey));
    const solver = (body: unknown) => new NaryxSolverClient({
      baseUrl: 'https://api.example',
      solverId: 'solver-a',
      keyId: 'q-1',
      sign: signer,
      fetch: serve({ 'GET /v1/solver/orders?after=0': { body } }),
    });
    const page = await solver({ orders: [{ cursor: 3, orderHash: ORDER_HASH, order: ORDER, receivedAtMs: 9 }], nextCursor: 3 }).pollOrders();
    assert.equal(page.nextCursor, 3);
    assert.equal(page.orders[0]?.orderHash, ORDER_HASH);
    await assert.rejects(solver({ orders: [{ cursor: 3, orderHash: 'ab'.repeat(32), order: ORDER, receivedAtMs: 9 }], nextCursor: 3 }).pollOrders(), /does not hash/);
    // Expired orders are skipped server-side, so the cursor may run ahead, never behind.
    assert.equal((await solver({ orders: [{ cursor: 3, orderHash: ORDER_HASH, order: ORDER, receivedAtMs: 9 }], nextCursor: 7 }).pollOrders()).nextCursor, 7);
    await assert.rejects(solver({ orders: [{ cursor: 3, orderHash: ORDER_HASH, order: ORDER, receivedAtMs: 9 }], nextCursor: 2 }).pollOrders(), /next cursor/);
    await assert.rejects(solver({ orders: [{ cursor: 0, orderHash: ORDER_HASH, order: ORDER, receivedAtMs: 9 }], nextCursor: 0 }).pollOrders(), /strictly increase/);
    assert.equal((await solver({ orders: [], nextCursor: 0 }).pollOrders()).orders.length, 0);
  });
});
