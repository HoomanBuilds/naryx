import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { OrderSuccessResponse } from '@nktkas/hyperliquid/api/exchange';
import type {
  HypercoreOrderWire,
  HyperliquidStrategyExecutionPlan,
} from '@naryx/adapter-hyperliquid';
import {
  HYPERLIQUID_SERVER_SIGNER_SCOPE,
  HYPERLIQUID_TESTNET_EXCHANGE_URL,
  HyperliquidSdkTestnetOrderSubmitter,
  HyperliquidSqliteDurableJournal,
  HyperliquidStrategySqliteDurableJournal,
  HyperliquidStrategyTestnetSubmissionService,
  type HyperliquidServerSigner,
  type HyperliquidStrategySubmissionInput,
  type HyperliquidTestnetExchangeTransport,
} from '../src/index.js';

const masterAccount = `0x${'11'.repeat(20)}` as const;
const tradingAccount = `0x${'22'.repeat(20)}` as const;
const agentWallet = `0x${'33'.repeat(20)}` as const;
const nowMs = 1_000_000n;

function hash(byte: number): Uint8Array {
  return new Uint8Array(32).fill(byte);
}

function wire(index: number): HypercoreOrderWire {
  return {
    a: index,
    b: index % 2 === 0,
    p: `${60_000 + index}`,
    s: '0.001',
    r: false,
    t: { limit: { tif: 'Ioc' } },
    c: `0x${(0x50 + index).toString(16).repeat(16)}`,
  };
}

function plan(): HyperliquidStrategyExecutionPlan {
  const orders = [0, 1, 2].map((index) => ({
    legId: `leg-${index}`,
    stage: 0,
    clientOrderId: wire(index).c,
    wire: wire(index),
  }));
  return {
    version: 1,
    guarantee: 'BATCHED_IOC_WITH_BOUNDED_RECOVERY',
    domain: {
      domainId: 'hypercore:testnet',
      domainManifestVersion: 1,
      domainManifestHash: hash(1),
    },
    orderHash: hash(2),
    graphHash: hash(3),
    quoteHash: hash(4),
    routeHash: hash(5),
    requestExpiryMs: nowMs + 10_000n,
    orders,
    batches: [{
      stage: 0,
      action: { type: 'order', grouping: 'na', orders: orders.map((order) => order.wire) },
      legIds: orders.map((order) => order.legId),
    }],
    recoveryAuthorizations: [],
    maximumRecoveryCostQuoteAtoms: 0n,
  } as unknown as HyperliquidStrategyExecutionPlan;
}

function input(): HyperliquidStrategySubmissionInput {
  return {
    expectedVersion: 0n,
    attemptId: 'strategy-attempt-1',
    batchStage: 0,
    agentWallet,
    signerLeaseId: 'solver-process-1',
    plan: plan(),
    account: { masterAccount, tradingAccount, accountKind: 'SUBACCOUNT' },
    nonce: nowMs + 1n,
    nowMs,
    vaultAddress: tradingAccount,
  };
}

function signer(): HyperliquidServerSigner {
  return {
    signerScope: HYPERLIQUID_SERVER_SIGNER_SCOPE,
    address: agentWallet,
    async signTypedData(_args: unknown) {
      return `0x${'01'.repeat(64)}1b`;
    },
  } as HyperliquidServerSigner;
}

class FakeExchangeTransport implements HyperliquidTestnetExchangeTransport {
  readonly isTestnet = true as const;
  readonly apiUrl = HYPERLIQUID_TESTNET_EXCHANGE_URL;
  requests: unknown[] = [];

  request<T>(endpoint: 'exchange', payload: unknown): Promise<T> {
    assert.equal(endpoint, 'exchange');
    this.requests.push(payload);
    const statuses = [0, 1, 2].map((index) => ({
      filled: {
        totalSz: '0.001',
        avgPx: `${60_000 + index}`,
        oid: index + 1,
        cloid: wire(index).c,
      },
    }));
    const response: OrderSuccessResponse = {
      status: 'ok',
      response: { type: 'order', data: { statuses } },
    };
    return Promise.resolve(response as T);
  }
}

test('submits a durable three-leg strategy batch through Hyperliquid Testnet', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'naryx-hyperliquid-strategy-submit-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const databasePath = join(directory, 'journal.sqlite');
  const base = new HyperliquidSqliteDurableJournal({ databasePath });
  base.close();
  const journal = new HyperliquidStrategySqliteDurableJournal({ databasePath });
  t.after(() => journal.close());
  const transport = new FakeExchangeTransport();
  const submitter = new HyperliquidSdkTestnetOrderSubmitter(signer(), transport);
  assert.equal(await submitter.signerAddress(), agentWallet);
  const service = new HyperliquidStrategyTestnetSubmissionService(
    journal,
    submitter,
  );

  const result = await service.submitBatch(input());
  assert.equal(result.status, 'SUBMISSION_ACKNOWLEDGED', JSON.stringify(result));
  assert.equal(result.settlementStatus, 'RECONCILIATION_REQUIRED');
  assert.equal(result.reconciliation?.clientOrderIds.length, 3);
  assert.equal(transport.requests.length, 1);
  assert.equal((await journal.readAttempt('strategy-attempt-1', 0))?.record.status, 'RECONCILING');
});
