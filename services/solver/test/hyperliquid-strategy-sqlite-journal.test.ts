import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type {
  HypercoreOrderWire,
  HyperliquidStrategyExecutionPlan,
} from '@naryx/adapter-hyperliquid';
import {
  HyperliquidSqliteDurableJournal,
  HyperliquidStrategySqliteDurableJournal,
  type HyperliquidStrategyJournalPrepareInput,
} from '../src/index.js';
import { trustedTimeDecision } from './hyperliquid-trusted-time-fixture.js';

const masterAccount = `0x${'11'.repeat(20)}` as const;
const tradingAccount = `0x${'22'.repeat(20)}` as const;
const agentWallet = `0x${'33'.repeat(20)}` as const;
const nowMs = 1_000_000n;

function hash(byte: number): Uint8Array {
  return new Uint8Array(32).fill(byte);
}

function wire(index: number, clientOrderId?: `0x${string}`): HypercoreOrderWire {
  return {
    a: index,
    b: index % 2 === 0,
    p: `${60_000 + index}`,
    s: '0.001',
    r: false,
    t: { limit: { tif: 'Ioc' } },
    c: clientOrderId ?? `0x${(0x50 + index).toString(16).repeat(16)}`,
  };
}

function plan(routeByte = 4, duplicateClientOrderId = false): HyperliquidStrategyExecutionPlan {
  const orders = [0, 1, 2].map((index) => {
    const order = wire(index, duplicateClientOrderId && index === 2 ? wire(1).c : undefined);
    return {
      legId: `leg-${index}`,
      stage: 0,
      clientOrderId: order.c,
      wire: order,
    };
  });
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
    routeHash: hash(routeByte),
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

function input(overrides: Partial<HyperliquidStrategyJournalPrepareInput> = {}):
HyperliquidStrategyJournalPrepareInput {
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
    ...overrides,
  };
}

function databasePath(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'naryx-hyperliquid-strategy-journal-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'journal.sqlite');
  const base = new HyperliquidSqliteDurableJournal({ databasePath: path });
  base.close();
  return path;
}

test('persists a three-leg strategy submission lifecycle across reopen', async (t) => {
  const path = databasePath(t);
  let journal = new HyperliquidStrategySqliteDurableJournal({ databasePath: path });
  const prepared = await journal.prepare(input());
  assert.equal(prepared.journalVersion, 1n);
  assert.equal(prepared.record.status, 'PREPARED');
  assert.deepEqual(prepared.record.legIds, ['leg-0', 'leg-1', 'leg-2']);
  assert.equal(prepared.record.clientOrderIds.length, 3);
  const durable = await journal.confirmDurable({
    expectedVersion: prepared.journalVersion,
    attemptId: prepared.record.attemptId,
    batchStage: prepared.record.batchStage,
    recordHash: prepared.record.recordHash,
  });
  const submitted = await journal.markSubmittedUnknown({
    expectedVersion: durable.journalVersion,
    attemptId: durable.record.attemptId,
    batchStage: durable.record.batchStage,
    nowMs,
  });
  const acknowledged = await journal.acknowledge({
    expectedVersion: submitted.journalVersion,
    attemptId: submitted.record.attemptId,
    batchStage: submitted.record.batchStage,
    acknowledgementId: 'response-1',
  });
  const reconciling = await journal.beginReconciliation({
    expectedVersion: acknowledged.journalVersion,
    attemptId: acknowledged.record.attemptId,
    batchStage: acknowledged.record.batchStage,
  });
  assert.equal(reconciling.record.status, 'RECONCILING');
  journal.close();

  journal = new HyperliquidStrategySqliteDurableJournal({ databasePath: path });
  const recovered = await journal.readAttempt('strategy-attempt-1', 0);
  assert.equal(recovered?.record.recordHash, prepared.record.recordHash);
  assert.equal(recovered?.record.status, 'RECONCILING');
  assert.equal((await journal.listUnresolvedSubmissions()).length, 1);
  journal.close();
});

test('shares the signer nonce fence and rejects changed or ambiguous package bindings', async (t) => {
  const path = databasePath(t);
  const journal = new HyperliquidStrategySqliteDurableJournal({ databasePath: path });
  const prepared = await journal.prepare(input());
  const timeDecision = trustedTimeDecision(
    Number(nowMs), 10_000, 'strategy-attempt-1:stage-0',
  );
  journal.recordTrustedTimeDecision('strategy-attempt-1:stage-0', timeDecision);
  assert.deepEqual(journal.submissionContext({
    account: { masterAccount, tradingAccount, accountKind: 'SUBACCOUNT' },
    agentWallet,
    signerLeaseId: 'solver-process-1',
    nowMs,
    timeDecisionHash: timeDecision.decisionHash,
  }), { expectedVersion: 1n, nonce: nowMs + 2n });
  const replay = await journal.prepare(input());
  assert.equal(replay.record.recordHash, prepared.record.recordHash);
  await assert.rejects(journal.prepare(input({ plan: plan(9) })), /immutable binding/);
  await assert.rejects(journal.prepare(input({
    expectedVersion: 1n,
    attemptId: 'strategy-attempt-2',
    nonce: nowMs + 2n,
    plan: plan(5, true),
  })), /batch identities must be unique/);
  journal.close();
});
