import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { OrderSuccessResponse } from '@nktkas/hyperliquid/api/exchange';
import type { HyperliquidNettingResidualPlan } from '@naryx/adapter-hyperliquid';
import {
  HYPERLIQUID_SERVER_SIGNER_SCOPE,
  HYPERLIQUID_TESTNET_EXCHANGE_URL,
  HyperliquidNettingResidualSqliteDurableJournal,
  HyperliquidNettingResidualTestnetSubmissionService,
  HyperliquidSdkTestnetOrderSubmitter,
  HyperliquidSqliteDurableJournal,
  type HyperliquidNettingResidualSubmissionInput,
  type HyperliquidServerSigner,
  type HyperliquidTestnetExchangeTransport,
} from '../src/index.js';

const masterAccount = `0x${'11'.repeat(20)}` as const;
const tradingAccount = `0x${'22'.repeat(20)}` as const;
const agentWallet = `0x${'33'.repeat(20)}` as const;
const clientOrderId = `0x${'44'.repeat(16)}` as const;
const nowMs = 1_000_000n;

function hash(byte: number): Uint8Array {
  return new Uint8Array(32).fill(byte);
}

function plan(instrumentByte = 3): HyperliquidNettingResidualPlan {
  const order = {
    a: 7,
    b: true,
    p: '152.25',
    s: '2.5',
    r: false,
    t: { limit: { tif: 'Ioc' as const } },
    c: clientOrderId,
  };
  return {
    version: 1,
    guarantee: 'SINGLE_IOC_WITH_TERMINAL_EVIDENCE',
    intentHash: hash(2),
    domain: {
      domainId: 'hypercore:testnet',
      domainManifestVersion: 1,
      domainManifestHash: hash(1),
    },
    instrumentHash: hash(instrumentByte),
    quantityAsset: { assetId: 'sol', decimals: 9, assetManifestVersion: 1, assetManifestHash: hash(4) },
    quoteAsset: { assetId: 'usdc', decimals: 6, assetManifestVersion: 1, assetManifestHash: hash(5) },
    requestedSignedQuantityAtoms: 2_500_000_000n,
    maximumFeeQuoteAtoms: 10_000n,
    requestExpiryMs: nowMs + 10_000n,
    clientOrderId,
    order,
    action: { type: 'order', grouping: 'na', orders: [order] },
  } as unknown as HyperliquidNettingResidualPlan;
}

function input(overrides: Partial<HyperliquidNettingResidualSubmissionInput> = {}):
HyperliquidNettingResidualSubmissionInput {
  return {
    expectedVersion: 0n,
    attemptId: 'net-residual-attempt-1',
    agentWallet,
    signerLeaseId: 'solver-process-1',
    plan: plan(),
    account: { masterAccount, tradingAccount, accountKind: 'SUBACCOUNT' },
    nonce: nowMs + 1n,
    nowMs,
    vaultAddress: tradingAccount,
    ...overrides,
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
    const response: OrderSuccessResponse = {
      status: 'ok',
      response: {
        type: 'order',
        data: {
          statuses: [{ filled: { totalSz: '2.5', avgPx: '152.25', oid: 1, cloid: clientOrderId } }],
        },
      },
    };
    return Promise.resolve(response as T);
  }
}

function databasePath(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'naryx-hyperliquid-net-residual-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'journal.sqlite');
  const base = new HyperliquidSqliteDurableJournal({ databasePath: path });
  base.close();
  return path;
}

test('durably submits one net residual on Hyperliquid Testnet', async (t) => {
  const path = databasePath(t);
  let journal = new HyperliquidNettingResidualSqliteDurableJournal({ databasePath: path });
  t.after(() => journal.close());
  const transport = new FakeExchangeTransport();
  const service = new HyperliquidNettingResidualTestnetSubmissionService(
    journal,
    new HyperliquidSdkTestnetOrderSubmitter(signer(), transport),
  );

  const result = await service.submitResidual(input());
  assert.equal(result.status, 'SUBMISSION_ACKNOWLEDGED', JSON.stringify(result));
  assert.equal(result.settlementStatus, 'RECONCILIATION_REQUIRED');
  assert.equal(result.reconciliation?.clientOrderId, clientOrderId);
  assert.equal(transport.requests.length, 1);
  assert.equal((await journal.readAttempt('net-residual-attempt-1'))?.record.status, 'RECONCILING');
  journal.close();
  journal = new HyperliquidNettingResidualSqliteDurableJournal({ databasePath: path });
  assert.equal((await journal.readAttempt('net-residual-attempt-1'))?.record.status, 'RECONCILING');
});

test('rejects a replay that changes the residual instrument binding', async (t) => {
  const journal = new HyperliquidNettingResidualSqliteDurableJournal({ databasePath: databasePath(t) });
  t.after(() => journal.close());
  const prepared = await journal.prepare(input());
  assert.equal((await journal.prepare(input())).record.recordHash, prepared.record.recordHash);
  await assert.rejects(journal.prepare(input({ plan: plan(9) })), /immutable binding/);
});
