import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import {
  assetAmount,
  assetRef,
  domainRef,
  evidenceManifestHash,
  fromProtocolJson,
  packageOrderBytes,
  packageOrderHash,
  packageReceiptHash,
  terminalOutcomeHash,
  toHex,
  toProtocolJson,
  type AcceptedQuoteFeeTerms,
  type EvidenceManifestInput,
  type PackageOrderInput,
  type PackageReceiptInput,
  type TerminalOutcomeInput,
} from '@naryx/protocol-types';
import { NaryxClient, NaryxSolverClient, base58Encode, type FetchLike } from '../src/index.js';

const ORDER = fromProtocolJson(
  JSON.parse(readFileSync(new URL('../../test/fixtures/solana-entry-order.json', import.meta.url), 'utf8')),
) as PackageOrderInput;
const ORDER_HASH = toHex(packageOrderHash(ORDER));

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
    await assert.rejects(solver({ orders: [{ cursor: 3, orderHash: ORDER_HASH, order: ORDER, receivedAtMs: 9 }], nextCursor: 4 }).pollOrders(), /next cursor/);
    await assert.rejects(solver({ orders: [{ cursor: 0, orderHash: ORDER_HASH, order: ORDER, receivedAtMs: 9 }], nextCursor: 0 }).pollOrders(), /strictly increase/);
    assert.equal((await solver({ orders: [], nextCursor: 0 }).pollOrders()).orders.length, 0);
  });
});
