import assert from 'node:assert/strict';
import test from 'node:test';
import { TransportError } from '@nktkas/hyperliquid';
import type { OrderSuccessResponse } from '@nktkas/hyperliquid/api/exchange';
import {
  HYPERCORE_EXECUTION_GUARANTEE,
  type HypercoreOrderWire,
  type HyperliquidExecutionPlan,
} from '@naryx/adapter-hyperliquid';
import {
  HYPERLIQUID_RECONCILIATION_COLLECTOR,
  HYPERLIQUID_JOURNAL_ACTION_COMMITMENT_SCHEME,
  HYPERLIQUID_SERVER_SIGNER_SCOPE,
  HYPERLIQUID_TESTNET_EXCHANGE_URL,
  HyperliquidSdkTestnetOrderSubmitter,
  HyperliquidTestnetPackageSubmissionService,
  type HyperliquidDurableSubmissionJournalPort,
  type HyperliquidJournalPrepareInput,
  type HyperliquidJournalReceipt,
  type HyperliquidJournalStatus,
  type HyperliquidPackageSubmissionInput,
  type HyperliquidServerSigner,
  type HyperliquidTestnetExchangeTransport,
} from '../src/index.js';

const masterAccount = `0x${'11'.repeat(20)}` as const;
const tradingAccount = `0x${'22'.repeat(20)}` as const;
const agentWallet = `0x${'33'.repeat(20)}` as const;
const spotClientOrderId = `0x${'51'.repeat(16)}` as const;
const perpetualClientOrderId = `0x${'52'.repeat(16)}` as const;
const nowMs = 1_000_000n;
const nonce = nowMs + 1n;
const expiry = nowMs + 5_000n;
const actionHash = `0x${'a1'.repeat(32)}` as const;
const recordHash = `0x${'a2'.repeat(32)}` as const;

function hash(byte: number): Uint8Array {
  return new Uint8Array(32).fill(byte);
}

function wire(clientOrderId: `0x${string}`, buy: boolean): HypercoreOrderWire {
  return {
    a: buy ? 10_007 : 3,
    b: buy,
    p: '60000',
    s: '0.001',
    r: false,
    t: { limit: { tif: 'Ioc' } },
    c: clientOrderId,
  };
}

function plan(): HyperliquidExecutionPlan {
  const spot = wire(spotClientOrderId, true);
  const perpetual = wire(perpetualClientOrderId, false);
  return {
    version: 1,
    guarantee: HYPERCORE_EXECUTION_GUARANTEE,
    domain: {
      domainId: 'hypercore:testnet', domainManifestVersion: 1, domainManifestHash: hash(1),
    },
    commitments: {
      seriesManifestHash: hash(2), executionClassManifestHash: hash(3),
      orderHash: hash(4), quoteHash: hash(5), routeHash: hash(6),
    },
    requestExpiryMs: expiry,
    unsignedRequestFields: {
      action: { type: 'order', grouping: 'na', orders: [spot, perpetual] },
      expiresAfter: Number(expiry),
    },
    legs: [
      { role: 'SPOT', clientOrderId: spotClientOrderId, order: spot },
      { role: 'PERPETUAL', clientOrderId: perpetualClientOrderId, order: perpetual },
    ],
  } as unknown as HyperliquidExecutionPlan;
}

function submissionInput(): HyperliquidPackageSubmissionInput {
  return {
    expectedVersion: 0n,
    attemptId: 'attempt-1',
    agentWallet,
    signerLeaseId: 'solver-process-1',
    plan: plan(),
    account: { masterAccount, tradingAccount, accountKind: 'SUBACCOUNT' },
    nonce,
    nowMs,
    vaultAddress: tradingAccount,
  };
}

class FakeDurableJournal implements HyperliquidDurableSubmissionJournalPort {
  readonly events: string[];
  readonly failPrepare: boolean;
  #receipt: HyperliquidJournalReceipt | null = null;

  constructor(events: string[], failPrepare = false) {
    this.events = events;
    this.failPrepare = failPrepare;
  }

  async prepare(input: HyperliquidJournalPrepareInput): Promise<HyperliquidJournalReceipt> {
    this.events.push('journal:prepare');
    if (this.failPrepare) throw new Error('durable journal unavailable');
    const spot = input.plan.legs.find((leg) => leg.role === 'SPOT')!;
    const perpetual = input.plan.legs.find((leg) => leg.role === 'PERPETUAL')!;
    this.#receipt = {
      journalVersion: input.expectedVersion + 1n,
      record: {
        attemptId: input.attemptId,
        status: 'PREPARED',
        account: input.account,
        agentWallet: input.agentWallet,
        signerLeaseId: input.signerLeaseId,
        nonce: input.nonce,
        expiresAfterMs: input.plan.requestExpiryMs,
        vaultAddress: input.vaultAddress,
        action: input.plan.unsignedRequestFields.action,
        actionCommitmentScheme: HYPERLIQUID_JOURNAL_ACTION_COMMITMENT_SCHEME,
        actionHash,
        recordHash,
        spotClientOrderId: spot.clientOrderId,
        perpetualClientOrderId: perpetual.clientOrderId,
        domain: input.plan.domain,
        commitments: input.plan.commitments,
        durableRevision: null,
      },
    };
    return this.#receipt;
  }

  confirmDurable(input: {
    expectedVersion: bigint; attemptId: string; recordHash: `0x${string}`;
  }): Promise<HyperliquidJournalReceipt> {
    assert.equal(input.recordHash, recordHash);
    return this.#transition('DURABLE_RECORD_CONFIRMED', input.expectedVersion, 'journal:durable');
  }

  markSubmittedUnknown(input: {
    expectedVersion: bigint; attemptId: string; nowMs: bigint;
  }): Promise<HyperliquidJournalReceipt> {
    return this.#transition('SUBMITTED_UNKNOWN', input.expectedVersion, 'journal:submitted-unknown');
  }

  acknowledge(input: {
    expectedVersion: bigint; attemptId: string; acknowledgementId: string;
  }): Promise<HyperliquidJournalReceipt> {
    assert.match(input.acknowledgementId, /^0x[0-9a-f]{64}$/);
    return this.#transition('ACKNOWLEDGED', input.expectedVersion, 'journal:acknowledged');
  }

  reject(input: {
    expectedVersion: bigint; attemptId: string; rejectionId: string;
  }): Promise<HyperliquidJournalReceipt> {
    assert.match(input.rejectionId, /^0x[0-9a-f]{64}$/);
    return this.#transition('REJECTED', input.expectedVersion, 'journal:rejected');
  }

  beginReconciliation(input: {
    expectedVersion: bigint; attemptId: string;
  }): Promise<HyperliquidJournalReceipt> {
    return this.#transition('RECONCILING', input.expectedVersion, 'journal:reconciling');
  }

  #transition(
    status: HyperliquidJournalStatus,
    expectedVersion: bigint,
    event: string,
  ): Promise<HyperliquidJournalReceipt> {
    assert.ok(this.#receipt);
    assert.equal(expectedVersion, this.#receipt.journalVersion);
    this.events.push(event);
    this.#receipt = {
      journalVersion: expectedVersion + 1n,
      record: {
        ...this.#receipt.record,
        status,
        durableRevision: status === 'PREPARED' ? null : 'durable-revision-7',
      },
    };
    return Promise.resolve(this.#receipt);
  }
}

function signer(events: string[], reject = false): HyperliquidServerSigner {
  return {
    signerScope: HYPERLIQUID_SERVER_SIGNER_SCOPE,
    async getAddress() {
      return agentWallet;
    },
    async signTypedData(_domain: unknown, _types: unknown, _value: unknown) {
      events.push('signer:sign');
      if (reject) throw new Error('signer refused request');
      return `0x${'01'.repeat(64)}1b`;
    },
  } as HyperliquidServerSigner;
}

class FakeExchangeTransport implements HyperliquidTestnetExchangeTransport {
  readonly isTestnet = true as const;
  readonly apiUrl = HYPERLIQUID_TESTNET_EXCHANGE_URL;
  readonly events: string[];
  readonly response: OrderSuccessResponse | Error;
  requests: unknown[] = [];

  constructor(events: string[], response: OrderSuccessResponse | Error) {
    this.events = events;
    this.response = response;
  }

  request<T>(endpoint: 'exchange', payload: unknown): Promise<T> {
    assert.equal(endpoint, 'exchange');
    this.events.push('transport:request');
    this.requests.push(payload);
    if (this.response instanceof Error) return Promise.reject(this.response);
    return Promise.resolve(this.response as T);
  }
}

function acceptedResponse(): OrderSuccessResponse {
  return {
    status: 'ok',
    response: {
      type: 'order',
      data: {
        statuses: [
          { filled: { totalSz: '0.001', avgPx: '60000', oid: 1, cloid: spotClientOrderId } },
          { filled: { totalSz: '0.001', avgPx: '60000', oid: 2,
            cloid: perpetualClientOrderId } },
        ],
      },
    },
  };
}

test('submits a durable compiled package through the pinned SDK Testnet path', async () => {
  const events: string[] = [];
  const journal = new FakeDurableJournal(events);
  const transport = new FakeExchangeTransport(events, acceptedResponse());
  const submitter = new HyperliquidSdkTestnetOrderSubmitter(signer(events), transport);
  const result = await new HyperliquidTestnetPackageSubmissionService(journal, submitter)
    .submitPackage(submissionInput());

  assert.equal(result.status, 'SUBMISSION_ACKNOWLEDGED');
  assert.equal(result.evidenceStatus, 'SUBMISSION_EVIDENCE_ONLY');
  assert.equal(result.settlementStatus, 'RECONCILIATION_REQUIRED');
  assert.equal(result.actionCommitmentScheme, HYPERLIQUID_JOURNAL_ACTION_COMMITMENT_SCHEME);
  assert.equal(result.actionCommitment, actionHash);
  assert.equal(result.requestCommitment, recordHash);
  assert.equal(result.reconciliation.collector, HYPERLIQUID_RECONCILIATION_COLLECTOR);
  assert.equal(result.reconciliation.actionCommitmentScheme,
    HYPERLIQUID_JOURNAL_ACTION_COMMITMENT_SCHEME);
  assert.equal(result.reconciliation.spotClientOrderId, spotClientOrderId);
  assert.deepEqual(events, [
    'journal:prepare', 'journal:durable', 'journal:submitted-unknown',
    'signer:sign', 'transport:request', 'journal:acknowledged', 'journal:reconciling',
  ]);
  assert.equal(transport.requests.length, 1);
  assert.deepEqual(transport.requests[0], {
    action: submissionInput().plan.unsignedRequestFields.action,
    signature: { r: `0x${'01'.repeat(32)}`, s: `0x${'01'.repeat(32)}`, v: 27 },
    nonce: Number(nonce),
    vaultAddress: tradingAccount,
    expiresAfter: Number(expiry),
  });
});

test('rejects wrong network, signer scope, unavailable durability, and signer refusal', async () => {
  const events: string[] = [];
  const goodSigner = signer(events);
  const wrongNetwork = {
    isTestnet: false,
    apiUrl: 'https://api.hyperliquid.xyz',
    request: async () => acceptedResponse(),
  } as unknown as HyperliquidTestnetExchangeTransport;
  assert.throws(() => new HyperliquidSdkTestnetOrderSubmitter(goodSigner, wrongNetwork),
    /not exact Hyperliquid Testnet/);
  const transport = new FakeExchangeTransport(events, acceptedResponse());
  assert.throws(() => new HyperliquidSdkTestnetOrderSubmitter({
    ...goodSigner, signerScope: 'BROWSER_WALLET',
  } as unknown as HyperliquidServerSigner, transport), /server-side/);

  const unavailable = await new HyperliquidTestnetPackageSubmissionService(
    new FakeDurableJournal(events, true),
    new HyperliquidSdkTestnetOrderSubmitter(goodSigner, transport),
  ).submitPackage(submissionInput());
  assert.equal(unavailable.status, 'NOT_SUBMITTED');
  assert.equal(unavailable.evidenceStatus, 'JOURNAL_REJECTED');
  assert.equal(unavailable.settlementStatus, 'NOT_APPLICABLE');
  assert.equal(transport.requests.length, 0);

  events.length = 0;
  const refused = await new HyperliquidTestnetPackageSubmissionService(
    new FakeDurableJournal(events),
    new HyperliquidSdkTestnetOrderSubmitter(signer(events, true), transport),
  ).submitPackage(submissionInput());
  assert.equal(refused.status, 'SUBMISSION_REJECTED');
  assert.equal(refused.evidenceStatus, 'SIGNER_REJECTED');
  assert.equal(refused.settlementStatus, 'RECONCILIATION_REQUIRED');
  assert.equal(transport.requests.length, 0);
  assert.deepEqual(events, [
    'journal:prepare', 'journal:durable', 'journal:submitted-unknown',
    'signer:sign', 'journal:rejected', 'journal:reconciling',
  ]);
});

test('hands an ambiguous response to cloid reconciliation without resubmission', async () => {
  const events: string[] = [];
  const journal = new FakeDurableJournal(events);
  const transport = new FakeExchangeTransport(events, new TransportError('response lost'));
  const service = new HyperliquidTestnetPackageSubmissionService(
    journal,
    new HyperliquidSdkTestnetOrderSubmitter(signer(events), transport),
  );
  const result = await service.submitPackage(submissionInput());

  assert.equal(result.status, 'SUBMISSION_AMBIGUOUS');
  assert.equal(result.evidenceStatus, 'RESPONSE_UNKNOWN');
  assert.equal(result.settlementStatus, 'RECONCILIATION_REQUIRED');
  assert.equal(result.reconciliation.spotClientOrderId, spotClientOrderId);
  assert.equal(result.reconciliation.perpetualClientOrderId, perpetualClientOrderId);
  assert.equal(transport.requests.length, 1);
  assert.deepEqual(events.slice(-2), ['transport:request', 'journal:reconciling']);
});
