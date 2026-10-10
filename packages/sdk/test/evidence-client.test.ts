import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { privateKeyToAccount } from 'viem/accounts';
import {
  adapterRef,
  versionedManifestRef,
  assetAmount,
  assetRef,
  buildExposureGraph,
  packageGraph,
  packageCloseCostIndex,
  stressPortfolio,
  packageGraphHash,
  simulatePackageGraphFailures,
  optimizePortfolio,
  positionSnapshotRecord,
  positionSnapshotRecordHash,
  marketCatalogueHash,
  applyStrategyCommand,
  builderAttributionHash,
  builderManifestHash,
  collateralSnapshotHash,
  strategyCommandHash,
  strategyHealthSnapshotHash,
  strategyState,
  strategyStateHash,
  strategyPackageOrder,
  strategyPackageOrderHash,
  strategyPackageQuote,
  strategyPackageQuoteHash,
  strategyPackageReceipt,
  strategyPackageReceiptHash,
  strategyTemplateDefinitions,
  typedStrategyRouteHash,
  requireStrategyTemplateDefinition,
  domainRef,
  evidenceManifestHash,
  executionIntelligence,
  fromProtocolJson,
  manualRecoveryApprovalHash,
  manualRecoveryIncidentHash,
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
  type MarketCatalogueInput,
  type StrategyCommandInput,
  type StrategyHealthSnapshotInput,
  type StrategyState,
  type PackageOrderInput,
  type PackageGraphInput,
  type PackageReceiptInput,
  type PrivateRfqEnvelopeInput,
  type PortfolioOptimizationCandidateInput,
  type PortfolioOptimizationPolicyInput,
  type QualificationRecordInput,
  type RoutePayloadInput,
  type SolverCapabilityManifestInput,
  type SolverQuoteInput,
  type StrategyPackageOrderInput,
  type StrategyPackageQuoteInput,
  type StrategyPackageReceiptInput,
  type TerminalOutcomeInput,
  type TypedStrategyRoute,
} from '@naryx/protocol-types';
import { NaryxClient, NaryxSolverClient, authorizeStrategyCommand, base58Decode, base58Encode, type FetchLike } from '../src/index.js';

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

  test('collateral snapshots are re-hashed and signatures verify only under trusted authorities', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const trustedKey = new Uint8Array((publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32));
    const unsigned = {
      version: 2,
      environment: 'testnet',
      snapshotId: 'collateral-1',
      sourceId: 'margin-source-1',
      strategyAccount: 'strategy-1',
      owner: 'trader',
      authority: 'collateral-key-1',
      observedAtMs: 1_000n,
      asset: usdc,
      riskDomainId: 'sol-carry',
      mode: 'ISOLATED' as const,
      ownAvailableQuoteAtoms: 1_000_000n,
      borrowAvailableQuoteAtoms: 500_000n,
      requestedBorrowQuoteAtoms: 100_000n,
      borrowCostQuoteAtoms: 1_000n,
      haircutBps: 500n,
      withdrawalDelayMs: 1_000n,
      inventoryEligible: true,
      withdrawalAllowed: true,
      sourceEvidenceHash: '41'.repeat(32),
      signature: new Uint8Array([1]),
    };
    const signed = { ...unsigned, signature: new Uint8Array(sign(null, collateralSnapshotHash(unsigned), privateKey)) };
    const snapshotHash = toHex(collateralSnapshotHash(signed));
    const body = (record = signed, recordHash = snapshotHash) => ({
      strategyAccount: 'strategy-1',
      label: 'OBSERVED',
      sources: [{ recordHash, ageMs: 500n, record }],
    });
    const route = 'GET /v1/collateral/strategy-1';
    const verified = await client({ [route]: { body: body() } }).getCollateral('strategy-1', {
      trustedAuthorities: new Map([['collateral-key-1', trustedKey]]),
    });
    assert.equal(verified.sources[0]?.signatureVerified, true);
    assert.equal((await client({ [route]: { body: body() } }).getCollateral('strategy-1')).sources[0]?.signatureVerified, false);
    await assert.rejects(
      client({ [route]: { body: body() } }).getCollateral('strategy-1', {
        trustedAuthorities: new Map([['collateral-key-1', new Uint8Array(32).fill(9)]]),
      }),
      /does not verify/,
    );
    await assert.rejects(
      client({ [route]: { body: body({ ...signed, ownAvailableQuoteAtoms: 2_000_000n }) } }).getCollateral('strategy-1'),
      /does not match its record hash/,
    );
    const published = await client({
      'POST /v1/collateral-snapshots': { body: { recordHashHex: snapshotHash, replayed: false } },
    }).publishCollateralSnapshot(signed);
    assert.equal(published.recordHash, snapshotHash);
    assert.equal(published.replayed, false);
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
    const positionsBody = (record = signed) => {
      const normalizedRecord = positionSnapshotRecord(record);
      return {
        strategyAccount: 'strategy-1',
        label: 'OBSERVED',
        sources: [{
          sourceId: normalizedRecord.sourceId,
          recordHash: toHex(positionSnapshotRecordHash(normalizedRecord)),
          observedAtMs: normalizedRecord.observedAtMs,
          ageMs: 500n,
          positionCount: normalizedRecord.positions.length,
          unmappedInstruments: normalizedRecord.unmappedInstruments,
        }],
        records: [normalizedRecord],
        positions: normalizedRecord.positions.map((entry) => ({ sourceId: normalizedRecord.sourceId, position: entry })),
      };
    };
    const scenarios = [
      { scenarioId: 'uniform-down-10pct', priceShocksBps: [{ underlyingId: 'btc', shockBps: -1_000n }], closeCostMultiplierBps: 15_000n, failedDependencyIds: [] },
      { scenarioId: 'uniform-up-10pct', priceShocksBps: [{ underlyingId: 'btc', shockBps: 1_000n }], closeCostMultiplierBps: 15_000n, failedDependencyIds: [] },
    ];
    const stress = scenarios.map((scenario) => stressPortfolio(normalized.positions, scenario, usdc));
    const riskBody = (exposure: unknown = buildExposureGraph(normalized.positions, usdc), results: unknown = stress) => ({
      strategyAccount: 'strategy-1',
      methodology: 'uniform shocks',
      byAccountingAsset: [{ accountingAsset: usdc, exposure, closeCost: packageCloseCostIndex(normalized.positions), stress: { label: 'MODELED', results } }],
    });
    const trust = new Map([['position-key-1', trustedKey]]);
    const reader = (positions: unknown, risk: unknown = riskBody()) => client({ 'GET /v1/positions/strategy-1': { body: positions }, 'GET /v1/risk/strategy-1': { body: risk } });
    const verified = await reader(positionsBody()).getPositions('strategy-1', { trustedAuthorities: trust });
    assert.equal(verified.sources[0]?.signatureVerified, true);
    const published = await client({
      'POST /v1/position-snapshots': { body: { recordHashHex: toHex(positionSnapshotRecordHash(signed)), replayed: false } },
    }).publishPositionSnapshot(signed);
    assert.equal(published.recordHash, toHex(positionSnapshotRecordHash(signed)));
    assert.equal((await reader(positionsBody()).getPositions('strategy-1')).sources[0]?.signatureVerified, false);
    await assert.rejects(reader(positionsBody()).getPositions('strategy-1', { trustedAuthorities: new Map([['position-key-1', new Uint8Array(32).fill(9)]]) }), /does not verify/);
    // A position altered after signing no longer matches its served hash.
    const altered = positionsBody();
    altered.records = [{ ...normalized, positions: [{ ...normalized.positions[0]!, quantityBaseAtoms: -1n }] }];
    await assert.rejects(reader(altered).getPositions('strategy-1'), /does not describe its record/);
    const risk = await reader(positionsBody()).getRisk('strategy-1', { trustedAuthorities: trust });
    assert.equal(risk.byAccountingAsset.length, 1);
    const riskDomainBody = (positionsInDomain = 1) => ({
      riskDomainId: 'btc-carry',
      label: 'OBSERVED',
      accounts: [{
        strategyAccount: 'strategy-1',
        sourceId: signed.sourceId,
        recordHash: toHex(positionSnapshotRecordHash(signed)),
        observedAtMs: signed.observedAtMs,
        ageMs: 500n,
        positionCount: signed.positions.length,
        unmappedInstruments: [],
        positionsInDomain,
      }],
      methodology: 'uniform shocks',
      byAccountingAsset: riskBody().byAccountingAsset,
    });
    const riskDomainClient = (body: unknown) => client({
      'GET /v1/risk-domains/btc-carry': { body },
      'GET /v1/positions/strategy-1': { body: positionsBody() },
    });
    const riskDomain = await riskDomainClient(riskDomainBody()).getRiskDomain('btc-carry', { trustedAuthorities: trust });
    assert.equal(riskDomain.accounts[0]?.source.signatureVerified, true);
    assert.equal(riskDomain.byAccountingAsset.length, 1);
    await assert.rejects(riskDomainClient(riskDomainBody(0)).getRiskDomain('btc-carry'), /domain position count is inconsistent/);
    const inflated = { ...buildExposureGraph(normalized.positions, usdc), byUnderlying: [] };
    await assert.rejects(reader(positionsBody(), riskBody(inflated)).getRisk('strategy-1'), /differs from the local computation/);
    await assert.rejects(reader(positionsBody(), riskBody(undefined, [{ ...stress[0], lossQuoteAtoms: 0n }, stress[1]])).getRisk('strategy-1'), /stress differs from the local computation/);
  });

  test('health publication signs the canonical snapshot and current health stays bound to strategy state', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const snapshot: StrategyHealthSnapshotInput = {
      snapshotVersion: 1,
      environment: 'testnet',
      strategyId: 'strategy-1',
      strategyStateHash: '51'.repeat(32),
      observedAtUnit: 'EVM_UNIX_SECONDS',
      observedAtValue: 1_000n,
      deltaBaseAtoms: -40n,
      grossNotionalQuoteAtoms: 30_000_000_000n,
      leverageBps: 30_000n,
      marginHealthBps: 2_500n,
      liquidationDistanceBps: 1_800n,
      basisTicks: 60n,
      fundingPpm: 120n,
      volatilityPpm: 450_000n,
      residualBaseAtoms: 0n,
      maximumLossBoundQuoteAtoms: 900n,
      dependencyState: 'HEALTHY',
      recoveryCapacityQuoteAtoms: 5_000n,
      evidenceHash: '52'.repeat(32),
    };
    const snapshotHash = toHex(strategyHealthSnapshotHash(snapshot));
    const signed: Uint8Array[] = [];
    const routes = {
      'POST /v1/health-snapshots': { body: { snapshotHash, replayed: false } },
      'GET /v1/strategies/strategy-1/health': {
        body: { snapshot, stateHash: '51'.repeat(32), manualTakeover: false },
      },
    };
    const api = client(routes);
    const published = await api.publishStrategyHealth(snapshot, 'health-authority-1', async (digest) => {
      signed.push(digest);
      return new Uint8Array(sign(null, digest, privateKey));
    });
    assert.equal(published.snapshotHash, snapshotHash);
    assert.deepEqual(signed, [strategyHealthSnapshotHash(snapshot)]);
    const health = await api.getStrategyHealth('strategy-1');
    assert.equal(health.snapshotHash, snapshotHash);
    assert.equal(health.evidence, 'SERVER_ASSERTED');
    await assert.rejects(
      client({
        'GET /v1/strategies/strategy-1/health': {
          body: { snapshot, stateHash: '53'.repeat(32), manualTakeover: false },
        },
      }).getStrategyHealth('strategy-1'),
      /does not describe the requested current state/,
    );
  });

  test('portfolio optimization is replayed over current signed position and collateral snapshots', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const trustedKey = new Uint8Array((publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32));
    const btc = assetRef('btc', '44'.repeat(32), 8);
    const closeRoute = (routeId: string, dependencyId: string) => ({
      routeId,
      executableQuantityAtoms: 50_000_000n,
      expectedCostQuoteAtoms: 15_000_000n,
      settlementDelayMs: 1_000n,
      authorityHeld: true,
      atomicGroupId: 'carry-unwind',
      requiredDependencyIds: [dependencyId],
    });
    const position = (input: { snapshotId: string; venueId: string; marketId: string; positionType: 'SPOT' | 'PERPETUAL'; quantityBaseAtoms: bigint; dependencyId: string }) => ({
      adapterVersion: 1,
      snapshotId: input.snapshotId,
      domain,
      observedAtMs: 1_000n,
      owner: 'strategy-1',
      venueId: input.venueId,
      marketId: input.marketId,
      underlyingId: 'btc',
      positionType: input.positionType,
      quantityBaseAtoms: input.quantityBaseAtoms,
      markPrice: { baseAsset: btc, quoteAsset: usdc, quoteAtoms: 600n, baseAtoms: 1n, roundingDirection: 'AWAY_FROM_ZERO' as const },
      collateralQuoteAtoms: 3_000_000_000n,
      maintenanceRequirementQuoteAtoms: 750_000_000n,
      dependencyIds: [input.dependencyId],
      riskDomainId: 'btc-carry',
      closeRoutes: [closeRoute(`close-${input.snapshotId}`, input.dependencyId)],
    });
    const positionUnsigned = {
      recordVersion: 1,
      environment: 'testnet',
      strategyAccount: 'strategy-1',
      sourceId: 'carry-sources',
      observedAtMs: 1_500n,
      positions: [
        position({ snapshotId: 'spot-btc', venueId: 'spot-venue', marketId: 'btc-usdc', positionType: 'SPOT', quantityBaseAtoms: 50_000_000n, dependencyId: 'venue:spot' }),
        position({ snapshotId: 'perp-btc', venueId: 'perp-venue', marketId: 'btc-perp', positionType: 'PERPETUAL', quantityBaseAtoms: -50_000_000n, dependencyId: 'venue:perp' }),
      ],
      unmappedInstruments: [],
      sourceEvidenceHash: '45'.repeat(32),
      authority: 'snapshot-key-1',
      signature: new Uint8Array(0),
    };
    const positionSigned = {
      ...positionUnsigned,
      signature: new Uint8Array(sign(null, positionSnapshotRecordHash(positionUnsigned), privateKey)),
    };
    const positionHash = toHex(positionSnapshotRecordHash(positionSigned));
    const collateralUnsigned = {
      version: 2,
      environment: 'testnet',
      snapshotId: 'collateral-1',
      sourceId: 'collateral-source',
      strategyAccount: 'strategy-1',
      owner: 'trader',
      authority: 'snapshot-key-1',
      observedAtMs: 1_600n,
      asset: usdc,
      riskDomainId: 'btc-carry',
      mode: 'ISOLATED' as const,
      ownAvailableQuoteAtoms: 20_000_000_000n,
      borrowAvailableQuoteAtoms: 0n,
      requestedBorrowQuoteAtoms: 0n,
      borrowCostQuoteAtoms: 0n,
      haircutBps: 0n,
      withdrawalDelayMs: 0n,
      inventoryEligible: true,
      withdrawalAllowed: true,
      sourceEvidenceHash: '46'.repeat(32),
      signature: new Uint8Array([1]),
    };
    const collateralSigned = {
      ...collateralUnsigned,
      signature: new Uint8Array(sign(null, collateralSnapshotHash(collateralUnsigned), privateKey)),
    };
    const collateralHash = toHex(collateralSnapshotHash(collateralSigned));
    const policy: PortfolioOptimizationPolicyInput = {
      version: 1,
      policyId: 'carry-policy',
      policyVersion: 1,
      environment: 'testnet',
      owner: 'trader',
      accountingAsset: usdc,
      allowedSnapshotAuthorities: ['snapshot-key-1'],
      allowedCollateralAssetIds: [usdc.assetId],
      allowedCollateralModes: ['ISOLATED'],
      allowedRiskDomainIds: ['btc-carry'],
      objectivePriority: ['MAXIMIZE_NET_OUTCOME', 'MINIMIZE_REQUIRED_COLLATERAL', 'MINIMIZE_STRESS_LOSS', 'MINIMIZE_TIME_TO_UNWIND', 'MINIMIZE_TOTAL_COST'],
      maximumStateAgeMs: 5_000n,
      maximumSourceSkewMs: 5_000n,
      maximumWithdrawalDelayMs: 5_000n,
      maximumTimeToUnwindMs: 5_000n,
      maximumStressLossQuoteAtoms: 100_000_000_000n,
      maximumRequiredCollateralQuoteAtoms: 100_000_000_000n,
      maximumTotalCostQuoteAtoms: 100_000_000_000n,
      maximumBorrowQuoteAtoms: 0n,
      maximumBorrowCostQuoteAtoms: 0n,
      maximumSolverConcentrationBps: 5_000n,
      minimumRecoveryReserveQuoteAtoms: 1_000n,
      allowBorrow: false,
    };
    const proposal = {
      candidateId: 'carry-a',
      positionSnapshotHash: positionHash,
      collateralSnapshotHash: collateralHash,
      routeHash: '50'.repeat(32),
      executionGraphHash: '51'.repeat(32),
      unwindRouteHash: '52'.repeat(32),
      solverId: 'solver-a',
      solverConcentrationBps: 1_000n,
      expectedGrossOutcomeQuoteAtoms: 100_000_000n,
      expectedFeesQuoteAtoms: 5_000_000n,
      expectedGasQuoteAtoms: 1_000_000n,
      expectedFundingCostQuoteAtoms: 5_000_000n,
      expectedRebatesQuoteAtoms: 0n,
      marginOffsetPolicy: {
        riskDomainId: 'btc-carry',
        offsetRateBps: 5_000n,
        haircutsBps: { basis: 0n, liquidity: 0n, latency: 0n, oracle: 0n, venue: 0n, bridge: 0n, issuer: 0n, recovery: 0n },
        maximumStalenessMs: 5_000n,
        maximumTimeToUnwindMs: 5_000n,
        riskDomainGrossCapQuoteAtoms: 100_000_000_000n,
        requiredRecoveryReserveQuoteAtoms: 1_000n,
        absoluteFloorQuoteAtoms: 100_000_000n,
      },
      marginOffsetContext: { reservedRecoveryQuoteAtoms: 1_000n, fundedCreditAvailable: true, failedDependencyIds: [] },
      stressScenarios: [
        { scenarioId: 'down-10pct', priceShocksBps: [{ underlyingId: 'btc', shockBps: -1_000n }], closeCostMultiplierBps: 15_000n, failedDependencyIds: [] },
        { scenarioId: 'up-10pct', priceShocksBps: [{ underlyingId: 'btc', shockBps: 1_000n }], closeCostMultiplierBps: 15_000n, failedDependencyIds: [] },
      ],
    };
    const decisionAtMs = 2_000n;
    const optimizerInput: PortfolioOptimizationCandidateInput = {
      ...proposal,
      active: true,
      authorityVerified: true,
      positionSnapshot: positionSigned,
      collateralSnapshot: collateralSigned,
      marginOffsetContext: { ...proposal.marginOffsetContext, nowMs: decisionAtMs },
    };
    const decision = optimizePortfolio(policy, decisionAtMs, [optimizerInput]);
    const selectedCandidate = decision.candidates[0];
    assert.equal(selectedCandidate?.eligible, true);
    const normalizedPositionRecord = positionSnapshotRecord(positionSigned);
    const positionsBody = {
      strategyAccount: 'strategy-1',
      label: 'OBSERVED',
      sources: [{
        sourceId: normalizedPositionRecord.sourceId,
        recordHash: positionHash,
        observedAtMs: normalizedPositionRecord.observedAtMs,
        ageMs: 500n,
        positionCount: normalizedPositionRecord.positions.length,
        unmappedInstruments: normalizedPositionRecord.unmappedInstruments,
      }],
      records: [normalizedPositionRecord],
      positions: normalizedPositionRecord.positions.map((entry) => ({ sourceId: normalizedPositionRecord.sourceId, position: entry })),
    };
    const collateralBody = {
      strategyAccount: 'strategy-1',
      label: 'OBSERVED',
      sources: [{ recordHash: collateralHash, ageMs: 400n, record: collateralSigned }],
    };
    const routes = (servedDecision: unknown = decision) => ({
      'POST /v1/portfolio/optimize': { body: { decision: servedDecision, selectedCandidate } },
      'GET /v1/positions/strategy-1': { body: positionsBody },
      'GET /v1/collateral/strategy-1': { body: collateralBody },
    });
    const verified = await client(routes()).optimizePortfolio(
      { strategyAccount: 'strategy-1', policy, candidates: [proposal] },
      { trustedAuthorities: new Map([['snapshot-key-1', trustedKey]]) },
    );
    assert.equal(verified.selectedCandidate.candidateId, 'carry-a');
    assert.equal(verified.allPositionSignaturesVerified, true);
    assert.equal(verified.allCollateralSignaturesVerified, true);
    await assert.rejects(
      client(routes({ ...decision, decisionHash: 'ab'.repeat(32) })).optimizePortfolio({ strategyAccount: 'strategy-1', policy, candidates: [proposal] }),
      /differs from the local replay/,
    );
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
      seriesVersion: 1,
      seriesManifestHash: new Uint8Array(32).fill(9),
      executionClassId: 'class',
      executionClassVersion: 1,
      executionClassManifestHash: new Uint8Array(32).fill(10),
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

  test('strategy discovery and owner summaries preserve their evidence limits and arithmetic', async () => {
    const program = {
      programVersion: 1,
      templates: strategyTemplateDefinitions().map((template) => ({
        templateId: template.templateId,
        templateVersion: template.templateVersion,
        displayName: template.displayName,
        quoteConventionId: template.quoteConventionId,
        riskClassId: template.riskClassId,
        lifecycleConventionId: template.lifecycleConventionId,
        metricIds: template.metricIds,
        actions: template.actionSpecs.map((action) => ({
          action: action.action,
          minimumLegs: action.minimumLegs,
          maximumLegs: action.maximumLegs,
          settlementClasses: action.allowedSettlementClasses,
          legRoles: action.legRules.map((leg) => ({
            legTypeId: leg.legTypeId,
            allowedFamilies: leg.allowedFamilies,
            allowedSides: leg.allowedSides,
            minimumCount: leg.minimumCount,
            maximumCount: leg.maximumCount,
          })),
        })),
      })),
    };
    assert.equal((await client({ 'GET /v1/strategy-program': { body: program } }).getStrategyProgram()).templates.length, program.templates.length);
    await assert.rejects(
      client({
        'GET /v1/strategy-program': {
          body: { ...program, templates: [{ ...program.templates[0]!, displayName: 'substituted' }, ...program.templates.slice(1)] },
        },
      }).getStrategyProgram(),
      /differs from this SDK/,
    );

    const admission = {
      orderHashHex: '11'.repeat(32),
      quoteHashHex: '12'.repeat(32),
      routeHashHex: '13'.repeat(32),
      templateId: 'cash-and-carry-v1',
      templateVersion: 1,
      lifecycleAction: 'ENTRY',
      settlementClass: 'ATOMIC_POSTCONDITION',
      solverId: 'solver-a',
      domainIds: ['svm:testnet'],
      validUntilUnit: 'SOLANA_SLOT',
      validUntilValue: 500n,
      recordedAtMs: 1_000,
    };
    const recent = await client({
      'GET /v1/strategy-packages/recent?limit=2': { body: { version: 1, admissions: [admission] } },
    }).getRecentStrategyPackages(2);
    assert.equal(recent[0]?.quoteHash, admission.quoteHashHex);
    assert.equal(recent[0]?.validUntilValue, 500n);

    const ownerStrategies = await client({
      'GET /v1/owners/trader/strategies': {
        body: { environment: 'testnet', ownerId: 'trader', strategies: [{ strategyId: 'strategy-a', stateVersion: 2n, stateHash: '21'.repeat(32), open: true, retired: false }] },
      },
    }).getOwnerStrategies('trader');
    assert.equal(ownerStrategies.strategies[0]?.stateVersion, 2n);

    const ownerReceipt = {
      receiptHashHex: '31'.repeat(32),
      orderHashHex: '32'.repeat(32),
      quoteHashHex: '33'.repeat(32),
      templateId: 'cash-and-carry-v1',
      lifecycleAction: 'ENTRY',
      expectedStrategyStateHashHex: null,
      terminalState: 'FINALIZED_COMPLETE',
      finalityStatus: 'FINALIZED',
      domainIds: ['svm:testnet'],
      portfolioEligible: true,
      executionEvidence: {
        routeHashHex: '34'.repeat(32),
        solverId: 'solver-a',
        settlementClass: 'ATOMIC_POSTCONDITION',
        legCount: 2,
        onchainEnforcedLegCount: 2,
        evidenceGrades: ['CONSENSUS_VERIFIED'],
      },
      executionEconomics: {
        quoteAssetId: 'usdc',
        quoteAssetDecimals: 6,
        grossLegNotionalAtoms: 200n,
        serviceFeeAtoms: 2n,
        solverFeeAtoms: 3n,
        venueFeeAtoms: 5n,
        networkCostAtoms: 7n,
        recoveryCostAtoms: 11n,
        explicitCostAtoms: 28n,
        terminalResidualValueAtoms: 0n,
      },
      recordedAtMs: 1_100,
    };
    const receiptRoute = 'GET /v1/owners/trader/strategy-receipts?limit=50';
    const summaries = await client({
      [receiptRoute]: { body: { version: 1, ownerId: 'trader', receipts: [ownerReceipt] } },
    }).getOwnerStrategyReceipts('trader');
    assert.equal(summaries[0]?.executionEconomics.explicitCostAtoms, 28n);
    await assert.rejects(
      client({
        [receiptRoute]: {
          body: {
            version: 1,
            ownerId: 'trader',
            receipts: [{ ...ownerReceipt, executionEconomics: { ...ownerReceipt.executionEconomics, explicitCostAtoms: 29n } }],
          },
        },
      }).getOwnerStrategyReceipts('trader'),
      /does not equal its components/,
    );
  });

  test('strategy quote proofs re-hash and cross-check the selected order, graph, quote, route, and solver signature', async () => {
    const sol = assetRef('sol', new Uint8Array(32).fill(31), 9);
    const quoteAsset = assetRef('usdc', new Uint8Array(32).fill(32), 6);
    const spotAdapter = adapterRef({ adapterId: 'spot-v1', adapterManifestVersion: 1, adapterManifestHash: new Uint8Array(32).fill(33) });
    const perpAdapter = adapterRef({ adapterId: 'perp-v1', adapterManifestVersion: 1, adapterManifestHash: new Uint8Array(32).fill(34) });
    const venue = versionedManifestRef('venue', 1, new Uint8Array(32).fill(35));
    const market = versionedManifestRef('market', 1, new Uint8Array(32).fill(36));
    const template = requireStrategyTemplateDefinition('cash-and-carry-v1');
    const leg = (
      legId: string,
      legFamily: 'SPOT_SWAP' | 'PERP_OPEN',
      legTypeId: string,
      side: 'BUY' | 'SELL',
      adapter: typeof spotAdapter,
    ) => ({
      legId,
      legFamily,
      legTypeId,
      domain,
      adapter,
      venue,
      market,
      assets: [sol, quoteAsset],
      side,
      quantityAsset: sol,
      quantityAtoms: 10n,
      minimumQuantityAtoms: 10n,
      maximumFeeQuoteAtoms: 0n,
      preconditionHashes: [],
      postconditionHashes: [],
      timeInForce: 'FOK' as const,
      legExpiryValue: 900n,
    });
    const graphInput: PackageGraphInput = {
      graphVersion: 1,
      environment: 'testnet',
      templateId: template.templateId,
      templateVersion: template.templateVersion,
      packageTemplateManifestHash: new Uint8Array(32).fill(37),
      seriesId: 'sol-basis',
      seriesVersion: 1,
      seriesManifestHash: new Uint8Array(32).fill(38),
      executionClassId: 'sol-basis-atomic',
      executionClassVersion: 1,
      executionClassManifestHash: new Uint8Array(32).fill(39),
      lifecycleAction: 'ENTRY',
      owner: 'trader',
      strategyAccountRefs: ['strategy'],
      legs: [leg('spot', 'SPOT_SWAP', 'spot-purchase', 'BUY', spotAdapter), leg('perp', 'PERP_OPEN', 'perp-sale', 'SELL', perpAdapter)],
      dependencyEdges: [],
      executionGroups: [{ groupId: 'atomic', kind: 'ALL_OR_NONE', legIds: ['spot', 'perp'] }],
      settlementClass: 'ATOMIC_POSTCONDITION',
      policyHashes: {
        netting: new Uint8Array(32).fill(40),
        privacy: new Uint8Array(32).fill(41),
        solver: new Uint8Array(32).fill(42),
        delivery: new Uint8Array(32).fill(43),
        resource: new Uint8Array(32).fill(44),
        portfolioRiskLimits: new Uint8Array(32).fill(45),
      },
      recoverySlots: [],
      maximumRecoveryCostQuoteAtoms: 0n,
      expiryUnit: 'EVM_UNIX_SECONDS',
      packageExpiryValue: 1_000n,
      nonce: 1n,
    };
    const graph = packageGraph(graphInput);
    const orderInput: StrategyPackageOrderInput = {
      version: 1,
      environment: graph.environment,
      templateId: graph.templateId,
      templateVersion: graph.templateVersion,
      packageTemplateManifestHash: graph.packageTemplateManifestHash,
      graphHash: packageGraphHash(graph),
      seriesId: graph.seriesId,
      seriesVersion: graph.seriesVersion,
      seriesManifestHash: graph.seriesManifestHash,
      executionClassId: graph.executionClassId,
      executionClassVersion: graph.executionClassVersion,
      executionClassManifestHash: graph.executionClassManifestHash,
      quoteConventionId: template.quoteConventionId,
      riskClassId: template.riskClassId,
      owner: graph.owner,
      settlementAccount: 'strategy',
      lifecycleAction: graph.lifecycleAction,
      settlementClass: graph.settlementClass,
      packageOrderType: 'LIMIT',
      packageTimeInForce: 'FOK',
      economicQuantity: assetAmount(sol, 10n),
      quoteAsset,
      metricLimits: [],
      maximumServiceFeesByAsset: [],
      maximumVenueFeesByAsset: [],
      maximumNetworkFeesByAsset: [],
      maximumRecoveryCostByAsset: [],
      maximumMarginIncrease: assetAmount(quoteAsset, 0n),
      maximumResidualValue: assetAmount(quoteAsset, 0n),
      expiryUnit: graph.expiryUnit,
      expiryValue: 950n,
      nonce: 1n,
    };
    const order = strategyPackageOrder(orderInput);
    const route = {
      version: 1,
      environment: graph.environment,
      orderHash: strategyPackageOrderHash(order),
      graphHash: packageGraphHash(graph),
      solverId: 'solver-a',
      settlementClass: graph.settlementClass,
      legs: [
        { legId: 'perp', domain, adapter: perpAdapter, legFamily: 'PERP_OPEN', materializationClassId: 'perp-open-v1', executionPlanKind: 'SVM_ATOMIC_CPI', stage: 0, groupId: 'atomic' },
        { legId: 'spot', domain, adapter: spotAdapter, legFamily: 'SPOT_SWAP', materializationClassId: 'spot-swap-v1', executionPlanKind: 'SVM_ATOMIC_CPI', stage: 0, groupId: 'atomic' },
      ],
      domainPlans: [{ domain, executionPlanKind: 'SVM_ATOMIC_CPI', legIds: ['perp', 'spot'], stageCount: 1 }],
      routeExpiryUnit: graph.expiryUnit,
      routeExpiryValue: 850n,
    } as unknown as TypedStrategyRoute;
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const verificationKey = new Uint8Array((publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32));
    const zero = assetAmount(quoteAsset, 0n);
    const unsigned: StrategyPackageQuoteInput = {
      version: 1,
      environment: graph.environment,
      domains: [domain],
      orderHash: strategyPackageOrderHash(order),
      graphHash: packageGraphHash(graph),
      routeHash: typedStrategyRouteHash(route),
      templateId: graph.templateId,
      templateVersion: graph.templateVersion,
      packageTemplateManifestHash: graph.packageTemplateManifestHash,
      seriesId: graph.seriesId,
      seriesVersion: graph.seriesVersion,
      seriesManifestHash: graph.seriesManifestHash,
      executionClassId: graph.executionClassId,
      executionClassVersion: graph.executionClassVersion,
      executionClassManifestHash: graph.executionClassManifestHash,
      quoteConventionId: template.quoteConventionId,
      riskClassId: template.riskClassId,
      solverId: route.solverId,
      solverCapabilityManifestHash: new Uint8Array(32).fill(46),
      quoteMode: 'EXECUTION_COMMITMENT',
      settlementClass: graph.settlementClass,
      quoteAsset,
      metrics: template.metricIds.map((metricId) => ({ metricId, value: 0n, scale: 0, unitId: 'unit' })),
      legEconomics: graph.legs.map((entry) => ({
        legId: entry.legId,
        quantity: assetAmount(sol, entry.quantityAtoms),
        grossNotional: assetAmount(quoteAsset, 100n),
        marginDelta: zero,
        venueFee: zero,
        builderFee: zero,
        residualValue: zero,
      })),
      netPackageOutcome: zero,
      totalGrossNotional: assetAmount(quoteAsset, 200n),
      totalMarginDelta: zero,
      totalResidualValue: zero,
      serviceCharges: [],
      passThroughCosts: [],
      feePolicyVersion: 1,
      feePolicyManifestHash: new Uint8Array(32).fill(47),
      validUntilUnit: graph.expiryUnit,
      validUntilValue: 900n,
      quoteNonce: 1n,
      solverSignatureScheme: 'ED25519',
      solverVerificationKey: verificationKey,
      signature: new Uint8Array(64),
    };
    const quote = strategyPackageQuote({ ...unsigned, signature: new Uint8Array(sign(null, strategyPackageQuoteHash(unsigned), privateKey)) });
    const quoteHash = toHex(strategyPackageQuoteHash(quote));
    const proof = {
      version: 1,
      orderHash: toHex(strategyPackageOrderHash(order)),
      graphHash: toHex(packageGraphHash(graph)),
      quoteHash,
      routeHash: toHex(typedStrategyRouteHash(route)),
      order,
      graph,
      quote,
      route,
      recordedAtMs: 12_345,
    };
    const path = `GET /v1/strategy-quotes/${quoteHash}/proof`;
    const verifiedProof = await client({ [path]: { body: proof } }).getStrategyQuoteProof(quoteHash);
    assert.equal(verifiedProof.signatureVerified, true);
    assert.equal(verifiedProof.route.domainPlans[0]?.executionPlanKind, 'SVM_ATOMIC_CPI');
    await assert.rejects(
      client({ [path]: { body: { ...proof, route: { ...route, legs: [{ ...route.legs[0]!, stage: 1 }, route.legs[1]!] } } } }).getStrategyQuoteProof(quoteHash),
      /strategy route does not hash to its served hash/,
    );

    const validated = await client({
      'POST /v1/strategy-orders/validate': { body: { valid: true, order, orderHash: proof.orderHash } },
    }).validateStrategyOrder(orderInput);
    assert.equal(validated.valid, true);
    if (validated.valid) assert.equal(validated.orderHash, proof.orderHash);

    const intake = await client({
      'POST /v1/strategy-orders': {
        body: {
          version: 1,
          status: 'STORED_FOR_QUOTING',
          created: true,
          orderHashHex: proof.orderHash,
          graphHashHex: proof.graphHash,
          currentTime: { unit: graph.expiryUnit, value: 100n },
          timeSource: 'SERVER',
          stages: graph.stages,
        },
      },
    }).submitStrategyOrder(orderInput, graphInput);
    assert.equal(intake.created, true);
    assert.equal(intake.graphHash, proof.graphHash);

    const requestedQuoteBody = {
      version: 1,
      status: 'SIGNED_AND_STORED',
      orderHash: proof.orderHash,
      graphHash: proof.graphHash,
      quoteHash,
      routeHash: proof.routeHash,
      quote,
      route,
    };
    const requested = await client({
      'POST /v1/strategy-quotes/request': { body: requestedQuoteBody },
    }).requestStrategyQuote({
      orderHash: proof.orderHash,
      graphHash: proof.graphHash,
      idempotencyKey: 'quote-request-0001',
    });
    assert.equal(requested.signatureVerified, true);
    assert.equal(requested.quoteHash, quoteHash);
    await assert.rejects(
      client({
        'POST /v1/strategy-quotes/request': { body: { ...requestedQuoteBody, routeHash: 'aa'.repeat(32) } },
      }).requestStrategyQuote({ orderHash: proof.orderHash, graphHash: proof.graphHash, idempotencyKey: 'quote-request-0002' }),
      /commitments differ/,
    );

    const compiledGraph = {
      compiled: true,
      graphHash: packageGraphHash(graph),
      stages: graph.stages,
      groups: [{
        groupId: 'atomic',
        domainId: domain.domainId,
        legIds: ['perp', 'spot'],
        actionCount: 2,
        maximumActionsPerTransaction: 4,
      }],
      ungroupedLegIds: [],
      worstCaseRecoveryCostQuoteAtoms: 0n,
    };
    const adapterSupport = [
      {
        domain,
        adapter: spotAdapter,
        legFamily: 'SPOT_SWAP' as const,
        supportedSides: ['BUY' as const],
        materializationClassId: 'spot-swap-v1',
        executionPlanKind: 'SVM_ATOMIC_CPI' as const,
        supportedSettlementClasses: ['ATOMIC_POSTCONDITION' as const],
      },
      {
        domain,
        adapter: perpAdapter,
        legFamily: 'PERP_OPEN' as const,
        supportedSides: ['SELL' as const],
        materializationClassId: 'perp-open-v1',
        executionPlanKind: 'SVM_ATOMIC_CPI' as const,
        supportedSettlementClasses: ['ATOMIC_POSTCONDITION' as const],
      },
    ];
    const compiled = await client({
      'POST /v1/strategy-routes/compile': {
        body: {
          ...compiledGraph,
          graph: compiledGraph,
          route,
          routeHash: typedStrategyRouteHash(route),
          currentTime: { unit: graph.expiryUnit, value: 100n },
          timeSource: 'SERVER',
        },
      },
    }).compileStrategyRoute({
      graph: graphInput,
      adapterSupport,
      orderHash: proof.orderHash,
      solverId: route.solverId,
      routeExpiryValue: route.routeExpiryValue,
    });
    assert.equal(compiled.compiled, true);
    if (compiled.compiled) assert.equal(compiled.routeHash, proof.routeHash);

    const admittedBody = { order, graph, quote, route, compiledGraph };
    const admitted = await client({
      'POST /v1/strategy-quotes/admit': { body: admittedBody },
    }).admitStrategyPackage(orderInput, graphInput, quote, route);
    assert.equal(admitted.quoteHash, quoteHash);
    assert.equal(admitted.signatureVerified, true);

    const submitted = await client({
      'POST /v1/strategy-packages/submit': {
        body: {
          admitted: admittedBody,
          storage: {
            orderCreated: true,
            quoteCreated: true,
            orderHashHex: proof.orderHash,
            graphHashHex: proof.graphHash,
            quoteHashHex: proof.quoteHash,
            routeHashHex: proof.routeHash,
          },
        },
      },
    }).submitStrategyPackage(orderInput, graphInput, quote, route);
    assert.equal(submitted.orderCreated, true);
    assert.equal(submitted.quoteCreated, true);

    const receiptInput: StrategyPackageReceiptInput = {
      version: 1,
      environment: order.environment,
      domains: [domain],
      orderHash: strategyPackageOrderHash(order),
      graphHash: packageGraphHash(graph),
      quoteHash: strategyPackageQuoteHash(quote),
      routeHash: typedStrategyRouteHash(route),
      templateId: order.templateId,
      templateVersion: order.templateVersion,
      packageTemplateManifestHash: order.packageTemplateManifestHash,
      seriesId: order.seriesId,
      seriesVersion: order.seriesVersion,
      seriesManifestHash: order.seriesManifestHash,
      executionClassId: order.executionClassId,
      executionClassVersion: order.executionClassVersion,
      executionClassManifestHash: order.executionClassManifestHash,
      lifecycleAction: order.lifecycleAction,
      owner: order.owner,
      solverId: quote.solverId,
      settlementClass: order.settlementClass,
      terminalState: 'FINALIZED_COMPLETE',
      quoteAsset,
      legOutcomes: graph.legs.map((entry, index) => ({
        legId: entry.legId,
        positionLegId: entry.legId,
        domain: entry.domain,
        status: 'EXECUTED' as const,
        requestedQuantity: assetAmount(entry.quantityAsset, entry.quantityAtoms),
        settledQuantity: assetAmount(entry.quantityAsset, entry.side === 'SELL' ? -entry.quantityAtoms : entry.quantityAtoms),
        grossNotional: assetAmount(quoteAsset, 100n),
        venueFee: zero,
        residualValue: zero,
        evidenceGrade: 'CONSENSUS_VERIFIED' as const,
        onchainEnforced: true,
        evidenceHash: new Uint8Array(32).fill(50 + index),
      })),
      serviceFee: zero,
      solverFee: zero,
      venueFees: zero,
      networkCost: zero,
      recoveryCost: zero,
      terminalResidualValue: zero,
      finalityStatus: 'FINALIZED',
      executedAtValue: 800n,
      receiptNonce: 1n,
    };
    const receipt = strategyPackageReceipt(receiptInput);
    const receiptHash = toHex(strategyPackageReceiptHash(receipt));
    const intelligence = executionIntelligence({
      version: 1,
      receiptHash,
      orderHash: strategyPackageOrderHash(order),
      observerId: 'observer-a',
      clockUnit: 'milliseconds',
      observerEvidenceHash: hash(70),
      observation: {
        orderHash: strategyPackageOrderHash(order),
        side: 'BUY',
        quotedPrice: 10_000n,
        inclusionReferencePrice: 10_010n,
        executionPrice: 10_005n,
        markouts: [{ horizonValue: 60_000n, referencePrice: 10_020n }],
        expectedNetOutcomeAtoms: quote.netPackageOutcome.atoms,
        realizedNetOutcomeAtoms: quote.netPackageOutcome.atoms - 5n,
        submittedAtValue: 100n,
        includedAtValue: 110n,
        legCompletedAtValues: graph.legs.map((_, index) => 110n + BigInt(index)),
        ordering: { sameActorBefore: false, sameActorAfter: false },
        adverseMoveThresholdBps: 5n,
      },
      deliveryPolicy: {
        requestedPath: 'PRIVATE_RELAY',
        permittedFallbacks: ['PROTECTED_BUNDLE'],
        maximumInclusionDelayValue: 20n,
        provenProtectedPaths: ['PROTECTED_BUNDLE'],
      },
      deliveryAttempts: [{ attemptId: 'delivery-1', path: 'PRIVATE_RELAY', submittedAtValue: 100n, outcome: 'INCLUDED', includedAtValue: 110n }],
      observedAtValue: 60_110n,
    });
    const receiptPath = `GET /v1/strategy-receipts/${receiptHash}/proof`;
    const receiptProof = {
      version: 1,
      receiptHash,
      receipt,
      recordedAtMs: 12_400,
      quoteProof: proof,
      executionIntelligence: { intelligence, recordedAtMs: 12_500 },
    };
    const verifiedReceipt = await client({ [receiptPath]: { body: receiptProof } }).getStrategyReceiptProof(receiptHash);
    assert.equal(verifiedReceipt.receiptHash, receiptHash);
    assert.equal(verifiedReceipt.receipt.terminalState, 'FINALIZED_COMPLETE');
    assert.equal(verifiedReceipt.signatureVerified, true);
    assert.equal(verifiedReceipt.executionIntelligence?.intelligence.quality.slippageBps, 5n);
    assert.equal(verifiedReceipt.executionIntelligence?.intelligence.delivery.mevProtectionLabel, 'REDUCED_PUBLIC_EXPOSURE');
    const rawReceiptPath = `GET /v1/strategy-receipts/${receiptHash}`;
    const rawReceipt = await client({
      [rawReceiptPath]: { body: { version: 1, receiptHash, receipt } },
    }).getStrategyReceipt(receiptHash);
    assert.equal(rawReceipt.receiptHash, receiptHash);
    const byQuotePath = `GET /v1/strategy-receipts/by-quote/${quoteHash}`;
    const byQuote = await client({
      [byQuotePath]: { body: { version: 1, quoteHash, receiptHashHex: receiptHash, receipt, recordedAtMs: 12_400 } },
    }).getStrategyReceiptByQuote(quoteHash);
    assert.equal(byQuote.receiptHash, receiptHash);
    assert.equal(byQuote.recordedAtMs, 12_400);
    const otherQuoteHash = 'ab'.repeat(32);
    await assert.rejects(
      client({
        [`GET /v1/strategy-receipts/by-quote/${otherQuoteHash}`]: {
          body: { version: 1, quoteHash: otherQuoteHash, receiptHashHex: receiptHash, receipt, recordedAtMs: 12_400 },
        },
      }).getStrategyReceiptByQuote(otherQuoteHash),
      /does not bind the requested quote/,
    );
    await assert.rejects(
      client({ [receiptPath]: { body: { ...receiptProof, receipt: { ...receipt, solverId: 'solver-b' } } } }).getStrategyReceiptProof(receiptHash),
      /strategy receipt does not hash to the requested hash/,
    );
    await assert.rejects(
      client({
        [receiptPath]: {
          body: {
            ...receiptProof,
            executionIntelligence: {
              intelligence: { ...intelligence, observerEvidenceHash: hash(71) },
              recordedAtMs: 12_500,
            },
          },
        },
      }).getStrategyReceiptProof(receiptHash),
      /does not hash to its served record hash/,
    );
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
  test('the market catalogue is re-hashed, checked against trusted keys, refuses replays, and is searched locally', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const trustedKey = new Uint8Array((publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32));
    const entry = (packageMarketId: string, halted = false) => ({
      packageMarketId,
      executionClassVersion: 1,
      seriesId: 'sol-carry',
      seriesVersion: 1,
      templateId: 'cash-and-carry-v1',
      templateVersion: 1,
      underlyingRefs: ['sol'],
      quoteAsset: 'usdc',
      settlementClass: 'ATOMIC_POSTCONDITION' as const,
      firmnessClass: 'firm',
      collateralMode: 'isolated',
      domainIds: ['svm:testnet'],
      halted,
    });
    const issue = (sequence: bigint, entries = [entry('sol-carry-atomic'), entry('sol-carry-halted', true)]): { catalogue: MarketCatalogueInput; catalogueHash: string } => {
      const unsigned: MarketCatalogueInput = { catalogueVersion: 1, environment: 'testnet', sequence, issuedAtMs: 1_000n, expiresAtMs: 61_000n, entries, solverIds: ['solver-a'], authority: 'catalogue-1', signature: new Uint8Array(0) };
      const hashed = marketCatalogueHash(unsigned);
      return { catalogue: { ...unsigned, signature: new Uint8Array(sign(null, hashed, privateKey)) }, catalogueHash: toHex(hashed) };
    };
    const routes: Record<string, Route> = { 'GET /v1/catalogue': { body: issue(5n) } };
    const seen: { method: string; path: string; body?: unknown }[] = [];
    const reader = client(routes, seen);
    const trust = new Map([['catalogue-1', trustedKey]]);
    const verified = await reader.getCatalogue({ trustedAuthorities: trust, environment: 'testnet', nowMs: 2_000n });
    assert.equal(verified.signatureVerified, true);
    assert.equal(verified.current, true);
    assert.deepEqual(verified.search({ text: 'SOL' }).map((found) => found.packageMarketId), ['sol-carry-atomic']);
    assert.equal(verified.search({ includeHalted: true, domainId: 'svm:testnet' }).length, 2);
    assert.equal(seen.length, 1, 'searching makes no request');
    assert.equal((await reader.getCatalogue({ nowMs: 61_000n })).current, false);
    await assert.rejects(reader.getCatalogue({ environment: 'devnet' }), /another environment/);
    await assert.rejects(reader.getCatalogue({ trustedAuthorities: new Map([['catalogue-1', new Uint8Array(32).fill(9)]]) }), /does not verify/);
    // An older signed catalogue is a replay once a newer one was accepted from the same authority.
    routes['GET /v1/catalogue'] = { body: issue(4n) };
    await assert.rejects(reader.getCatalogue({ trustedAuthorities: trust }), /older than one already accepted/);
    // A market added after signing no longer matches the served hash.
    const altered = issue(6n);
    routes['GET /v1/catalogue'] = { body: { ...altered, catalogue: { ...altered.catalogue, entries: [...altered.catalogue.entries, entry('sol-carry-shadow')] } } };
    await assert.rejects(reader.getCatalogue({ trustedAuthorities: trust }), /hash does not match/);
  });

  test('solver performance figures are recomputed from their counts and must be ordered', async () => {
    const states = { FINALIZED_COMPLETE: 1, FINALIZED_BOUNDED: 0, RECOVERED_COMPLETE: 0, RECOVERED_BOUNDED: 0, RECOVERED_FLAT: 0, MANUAL_INTERVENTION: 0, NO_EFFECT: 1 };
    const served = (overrides: Record<string, unknown> = {}) => ({
      label: 'OBSERVED',
      methodology: 'raw dimensions',
      solverId: 'solver-a',
      eligibleDomainIds: ['svm:testnet'],
      coverage: { eligibleOrders: 3, quotedOrders: 2, coverageBps: 6_666 },
      firstQuoteLatencyMs: { median: 250, p95: 400, max: 400 },
      outcomes: { total: 2, byTerminalState: states, settledBps: 5_000, fadeBps: 5_000, recoveredBps: 0, boundedResidualBps: 0, manualInterventionBps: 0 },
      priceImprovementBps: { measured: 1, median: 100, min: 100, max: 100 },
      ...overrides,
    });
    const read = (body: unknown) => client({ 'GET /v1/solvers/solver-a/performance': { body } }).getSolverPerformance('solver-a');
    const verified = await read(served());
    assert.equal(verified.coverage.coverageBps, 6_666);
    assert.equal(verified.outcomes.fadeBps, 5_000);
    await assert.rejects(read(served({ coverage: { eligibleOrders: 3, quotedOrders: 2, coverageBps: 9_000 } })), /does not match its counts/);
    await assert.rejects(read(served({ outcomes: { ...served().outcomes, fadeBps: 0 } })), /fadeBps does not match/);
    await assert.rejects(read(served({ outcomes: { ...served().outcomes, total: 3 } })), /do not sum/);
    await assert.rejects(read(served({ firstQuoteLatencyMs: { median: 500, p95: 400, max: 400 } })), /not ordered/);
    await assert.rejects(read(served({ priceImprovementBps: { measured: 2, median: 100, min: 100, max: 100 } })), /beyond the settled outcomes/);
    await assert.rejects(read(served({ solverId: 'solver-b' })), /another solver/);
  });
  test('strategy histories are re-hashed, signature-checked against each actor, and chained state to state', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const ownerId = base58Encode(new Uint8Array((publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32)));
    assert.deepEqual(base58Decode(ownerId), new Uint8Array((publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32)));
    assert.equal(base58Decode('0OIl'), undefined);
    const initial: StrategyState = strategyState({
      version: 1, strategyId: 'carry-1', ownerId, subaccountId: 'desk-1', seriesId: 'sol-cash-carry', executionClassId: 'sol-carry', open: true, stateVersion: 1n,
      legs: [
        { legId: 'spot', underlyingId: 'sol', instrumentId: 'sol-spot', venueId: 'phoenix', signedQuantityAtoms: 100n, lotAtoms: 10n, ratioNumerator: 1n, ratioDenominator: 1n },
        { legId: 'perp', underlyingId: 'sol', instrumentId: 'sol-perp', venueId: 'drift', signedQuantityAtoms: -100n, lotAtoms: 10n, ratioNumerator: -1n, ratioDenominator: 1n },
      ],
      liabilities: [], delegations: [], venuePositionsTransferable: false, legalTransferRestricted: false,
    });
    const base = { commandVersion: 1, environment: 'testnet', strategyId: 'carry-1', actorId: ownerId, atValue: 1_790_000_000_000n } as const;
    const open: StrategyCommandInput = { ...base, expectedStateVersion: 0n, expectedStateHash: '00'.repeat(32), parameters: { kind: 'OPEN', originReceiptHash: '11'.repeat(32), state: initial } };
    const assign: StrategyCommandInput = { ...base, expectedStateVersion: 1n, expectedStateHash: strategyStateHash(initial), parameters: { kind: 'ASSIGN_INTERNAL', subaccountId: 'desk-2' } };
    const transition = applyStrategyCommand(assign, new Map([['carry-1', initial]]));
    assert.ok(transition.kind === 'TRANSITIONED' && transition.result.accepted);
    const entry = (command: StrategyCommandInput, receipt?: unknown, signer = privateKey) => ({
      command,
      commandHash: toHex(strategyCommandHash(command)),
      authorization: { scheme: 'ED25519', signature: base58Encode(new Uint8Array(sign(null, strategyCommandHash(command), signer))) },
      ...(receipt === undefined ? {} : { receipt }),
      recordedAtMs: 1,
    });
    const reader = (commands: unknown[]) => client({ 'GET /v1/strategies/carry-1/history': { body: { strategyId: 'carry-1', commands } } });
    const history = await reader([entry(open), entry(assign, transition.result.receipt)]).getStrategyHistory('carry-1');
    assert.deepEqual(history.map((item) => [item.command.parameters.kind, item.signatureVerified]), [['OPEN', true], ['ASSIGN_INTERNAL', true]]);
    await assert.rejects(reader([entry(open, undefined, generateKeyPairSync('ed25519').privateKey)]).getStrategyHistory('carry-1'), /not signed by its actor/);
    await assert.rejects(reader([{ ...entry(open), commandHash: 'ab'.repeat(32) }]).getStrategyHistory('carry-1'), /does not match its hash/);
    const detached: StrategyCommandInput = { ...assign, expectedStateVersion: 5n, expectedStateHash: 'cd'.repeat(32) };
    await assert.rejects(reader([entry(open), entry(detached, { ...transition.result.receipt, priorStateHashes: [new Uint8Array(32).fill(0xcd)] })]).getStrategyHistory('carry-1'), /no earlier command produced/);
    await assert.rejects(reader([entry(open), entry(assign)]).getStrategyHistory('carry-1'), /no receipt from the state it bound/);

    const seen: { method: string; path: string; body?: unknown }[] = [];
    const ack = client({ 'POST /v1/strategies/commands': { body: { accepted: true, replayed: false, commandHashHex: toHex(strategyCommandHash(assign)), states: [] } } }, seen);
    const submitted = await ack.submitStrategyCommand(assign, async (hash) => new Uint8Array(sign(null, hash, privateKey)));
    assert.equal(submitted.commandHash, toHex(strategyCommandHash(assign)));
    const evmOwner = privateKeyToAccount(`0x${'45'.repeat(32)}`);
    const evmCommand: StrategyCommandInput = { ...assign, actorId: evmOwner.address.toLowerCase() };
    const evmSeen: { method: string; path: string; body?: unknown }[] = [];
    const evmAck = client({ 'POST /v1/strategies/commands': { body: { accepted: true, replayed: false, commandHashHex: toHex(strategyCommandHash(evmCommand)), states: [] } } }, evmSeen);
    const evmSubmitted = await evmAck.submitAuthorizedStrategyCommand(evmCommand, {
      scheme: 'EIP712_SECP256K1',
      signerId: evmOwner.address.toLowerCase(),
      sign: (typedData) => evmOwner.signTypedData(typedData as never),
    });
    assert.equal(evmSubmitted.commandHash, toHex(strategyCommandHash(evmCommand)));
    assert.equal((evmSeen[0]?.body as { authorization?: { scheme?: string } }).authorization?.scheme, 'EIP712_SECP256K1');
    const preparedAuthorization = await authorizeStrategyCommand(assign, {
      scheme: 'ED25519',
      signerId: ownerId,
      sign: async (hash) => new Uint8Array(sign(null, hash, privateKey)),
    });
    const preparedSeen: { method: string; path: string; body?: unknown }[] = [];
    const preparedAck = client({ 'POST /v1/strategies/commands': { body: { accepted: true, replayed: false, commandHashHex: preparedAuthorization.commandHash, states: [] } } }, preparedSeen);
    assert.equal((await preparedAck.submitPreparedStrategyCommand(assign, preparedAuthorization)).commandHash, preparedAuthorization.commandHash);
    assert.equal((preparedSeen[0]?.body as { authorization?: { scheme?: string } }).authorization?.scheme, 'ED25519');
    await assert.rejects(
      preparedAck.submitPreparedStrategyCommand(assign, { ...preparedAuthorization, commandHash: 'ef'.repeat(32) }),
      /bind the submitted command hash/,
    );
    const wrong = client({ 'POST /v1/strategies/commands': { body: { accepted: true, replayed: false, commandHashHex: 'ef'.repeat(32), states: [] } } });
    await assert.rejects(wrong.submitStrategyCommand(assign, async (hash) => new Uint8Array(sign(null, hash, privateKey))), /different strategy command/);
  });
  test('builder attributions acknowledge the local hash and builder manifests are re-hashed', async () => {
    const attribution = { attributionVersion: 1, orderHash: '11'.repeat(32), builderId: 'builder-a', builderManifestHash: '22'.repeat(32), maximumBuilderFeeBps: 5n };
    const { privateKey } = generateKeyPairSync('ed25519');
    const signer = async (hash: Uint8Array) => new Uint8Array(sign(null, hash, privateKey));
    const ack = client({ 'POST /v1/builders/attributions': { body: { attributionHash: toHex(builderAttributionHash(attribution)), replayed: false } } });
    assert.equal((await ack.submitBuilderAttribution(attribution, signer)).attributionHash, toHex(builderAttributionHash(attribution)));
    const wrong = client({ 'POST /v1/builders/attributions': { body: { attributionHash: 'ab'.repeat(32), replayed: false } } });
    await assert.rejects(wrong.submitBuilderAttribution(attribution, signer), /different attribution/);
    const manifest = { manifestVersion: 1, environment: 'testnet', builderId: 'builder-a', identityKey: new Uint8Array(32).fill(7), payoutAccounts: [{ domainId: 'svm:testnet', account: 'payout-a' }], supportedDomainIds: ['svm:testnet'], maximumBuilderFeeBpsByTemplate: [{ templateId: 'cash-and-carry-v1', maximumFeeBps: 10n }], validFromMs: 0n, validUntilMs: 10n, nonce: 1n, signature: new Uint8Array(64) };
    const read = (hash: string) => client({ 'GET /v1/builders/builder-a': { body: { builderId: 'builder-a', manifest, manifestHash: hash } } }).getBuilder('builder-a');
    assert.equal((await read(toHex(builderManifestHash(manifest)))).manifestHash, toHex(builderManifestHash(manifest)));
    await assert.rejects(read('ab'.repeat(32)), /does not match its hash/);
    const revenue = await client({ 'GET /v1/builders/builder-a/revenue': { body: { builderId: 'builder-a', label: 'OBSERVED', payableByAsset: [{ assetId: 'usdc', atoms: 70n, orders: 1 }] } } }).getBuilderRevenue('builder-a');
    assert.deepEqual(revenue, [{ assetId: 'usdc', atoms: 70n, orders: 1 }]);
  });
  test('recovery incidents are re-hashed, every approval is checked against its named approver, and the phase is replayed locally', async () => {
    const keys = [generateKeyPairSync('ed25519'), generateKeyPairSync('ed25519')];
    const ids = keys.map(({ publicKey }) => base58Encode(new Uint8Array((publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32))));
    const incident = {
      incidentVersion: 1, environment: 'testnet', incidentId: 'incident-1', orderHash: '11'.repeat(32), timeUnit: 'EVM_UNIX_SECONDS' as const,
      fencedAtValue: 100n, approverIds: ids, approvalQuorum: 2, baselineTargetHash: '77'.repeat(32),
    };
    const incidentHash = toHex(manualRecoveryIncidentHash(incident));
    const approval = (index: number, atValue: bigint, signer = keys[index]!.privateKey) => {
      const event = { kind: 'ACTION_APPROVED' as const, actionHash: '62'.repeat(32), approverId: ids[index]!, atValue };
      return { event, signature: new Uint8Array(sign(null, manualRecoveryApprovalHash({ incidentHash, ...event }), signer)) };
    };
    const reader = (events: unknown[]) => client({ 'GET /v1/recovery/incidents/incident-1': { body: { incident, incidentHash, events, state: { phase: 'RESTORED' } } } });
    const read = await reader([approval(0, 101n), approval(1, 102n), { event: { kind: 'ACTION_EXECUTED', actionHash: '62'.repeat(32), evidenceHash: '63'.repeat(32), atValue: 103n } }]).getRecoveryIncident('incident-1');
    assert.equal(read.state.phase, 'FENCED', 'the served phase is replaced by the local replay');
    assert.equal(read.state.executedActions.length, 1);
    await assert.rejects(reader([approval(0, 101n, keys[1]!.privateKey)]).getRecoveryIncident('incident-1'), /not signed by its approver/);
    const seen: { method: string; path: string; body?: unknown }[] = [];
    await client({ 'POST /v1/recovery/approvals': { body: { sequence: 1 } } }, seen)
      .submitRecoveryApproval('incident-1', { incidentHash, actionHash: '62'.repeat(32), approverId: ids[0]!, atValue: 101n }, async (hash) => new Uint8Array(sign(null, hash, keys[0]!.privateKey)));
    assert.equal((seen[0]?.body as { incidentId: string }).incidentId, 'incident-1');
  });
});
