import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  HYPERCORE_EXECUTION_GUARANTEE,
  type HypercoreOrderWire,
  type HyperliquidExecutionPlan,
} from '@naryx/adapter-hyperliquid';
import {
  HyperliquidSqliteDurableJournal,
  type HyperliquidJournalPrepareInput,
} from '../src/index.js';

const masterAccount = `0x${'11'.repeat(20)}` as const;
const tradingAccount = `0x${'22'.repeat(20)}` as const;
const agentWallet = `0x${'33'.repeat(20)}` as const;
const spotClientOrderId = `0x${'51'.repeat(16)}` as const;
const perpetualClientOrderId = `0x${'52'.repeat(16)}` as const;
const nowMs = 1_000_000n;
const nonce = nowMs + 1n;
const expiry = nowMs + 5_000n;

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

function plan(routeByte = 6): HyperliquidExecutionPlan {
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
      orderHash: hash(4), quoteHash: hash(5), routeHash: hash(routeByte),
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

function input(overrides: Partial<HyperliquidJournalPrepareInput> = {}):
HyperliquidJournalPrepareInput {
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
    ...overrides,
  };
}

function databasePath(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'naryx-hyperliquid-journal-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'journal.sqlite');
}

test('persists the complete journal lifecycle across reopen', async (t) => {
  assert.throws(() => new HyperliquidSqliteDurableJournal({
    databasePath: join(process.cwd(), 'journal.sqlite'),
  }), /outside the current project/);
  const path = databasePath(t);
  let journal = new HyperliquidSqliteDurableJournal({ databasePath: path });
  const prepared = await journal.prepare(input());
  assert.equal(prepared.journalVersion, 1n);
  assert.equal(prepared.record.status, 'PREPARED');
  const actionHash = prepared.record.actionHash;
  const recordHash = prepared.record.recordHash;
  journal.close();

  journal = new HyperliquidSqliteDurableJournal({ databasePath: path });
  const durable = await journal.confirmDurable({
    expectedVersion: 1n, attemptId: 'attempt-1', recordHash,
  });
  assert.equal(durable.record.status, 'DURABLE_RECORD_CONFIRMED');
  assert.match(durable.record.durableRevision!, /^sqlite-v1:[0-9]+$/);
  const submitted = await journal.markSubmittedUnknown({
    expectedVersion: durable.journalVersion, attemptId: 'attempt-1', nowMs,
  });
  const acknowledged = await journal.acknowledge({
    expectedVersion: submitted.journalVersion,
    attemptId: 'attempt-1',
    acknowledgementId: `0x${'a1'.repeat(32)}`,
  });
  const reconciling = await journal.beginReconciliation({
    expectedVersion: acknowledged.journalVersion, attemptId: 'attempt-1',
  });
  assert.equal(reconciling.record.status, 'RECONCILING');
  journal.close();

  journal = new HyperliquidSqliteDurableJournal({ databasePath: path });
  const recovered = await journal.readAttempt('attempt-1');
  assert.equal(recovered?.journalVersion, 5n);
  assert.equal(recovered?.record.status, 'RECONCILING');
  assert.equal(recovered?.record.actionHash, actionHash);
  assert.equal(recovered?.record.recordHash, recordHash);
  assert.deepEqual(recovered?.record.commitments, prepared.record.commitments);
  journal.close();
});

test('rejects changed replay, stale CAS, signer lease changes, and nonce reuse', async (t) => {
  const path = databasePath(t);
  let journal = new HyperliquidSqliteDurableJournal({ databasePath: path });
  assert.deepEqual(journal.submissionContext({
    account: { masterAccount, tradingAccount, accountKind: 'SUBACCOUNT' },
    agentWallet,
    signerLeaseId: 'solver-process-1',
    nowMs,
  }), { expectedVersion: 0n, nonce: nowMs });
  const prepared = await journal.prepare(input());
  assert.deepEqual(journal.submissionContext({
    account: { masterAccount, tradingAccount, accountKind: 'SUBACCOUNT' },
    agentWallet,
    signerLeaseId: 'solver-process-1',
    nowMs,
  }), { expectedVersion: 1n, nonce: nonce + 1n });
  const replay = await journal.prepare(input());
  assert.equal(replay.record.recordHash, prepared.record.recordHash);
  assert.equal(replay.journalVersion, prepared.journalVersion);
  await assert.rejects(journal.prepare(input({ plan: plan(9) })), /immutable binding/);
  await assert.rejects(journal.prepare(input({
    attemptId: 'attempt-2', nonce: nonce + 1n,
  })), /compare-and-set/);
  await assert.rejects(journal.prepare(input({
    expectedVersion: 1n, attemptId: 'attempt-2', nonce,
  })), /strictly increase/);
  await assert.rejects(journal.prepare(input({
    expectedVersion: 1n, attemptId: 'attempt-2', nonce: nonce + 1n,
    signerLeaseId: 'solver-process-2',
  })), /already bound/);
  const second = await journal.prepare(input({
    expectedVersion: 1n, attemptId: 'attempt-2', nonce: nonce + 1n,
  }));
  assert.equal(second.journalVersion, 2n);
  journal.close();

  journal = new HyperliquidSqliteDurableJournal({ databasePath: path });
  await assert.rejects(journal.prepare(input({
    expectedVersion: 2n, attemptId: 'attempt-3', nonce: nonce + 1n,
  })), /strictly increase/);
  await assert.rejects(journal.prepare(input({
    expectedVersion: 1n, attemptId: 'attempt-3', nonce: nonce + 2n,
  })), /compare-and-set/);
  journal.close();
});

test('lists restart-recoverable prepared and response-unknown attempts', async (t) => {
  const path = databasePath(t);
  let journal = new HyperliquidSqliteDurableJournal({ databasePath: path });
  await journal.prepare(input({ attemptId: 'attempt-prepared' }));
  const second = await journal.prepare(input({
    expectedVersion: 1n, attemptId: 'attempt-unknown', nonce: nonce + 1n,
  }));
  const durable = await journal.confirmDurable({
    expectedVersion: second.journalVersion,
    attemptId: second.record.attemptId,
    recordHash: second.record.recordHash,
  });
  await journal.markSubmittedUnknown({
    expectedVersion: durable.journalVersion,
    attemptId: durable.record.attemptId,
    nowMs,
  });
  journal.close();

  journal = new HyperliquidSqliteDurableJournal({ databasePath: path });
  const unresolved = await journal.listUnresolvedSubmissions();
  assert.deepEqual(unresolved.map((receipt) => [
    receipt.record.attemptId, receipt.record.status,
  ]), [
    ['attempt-prepared', 'PREPARED'],
    ['attempt-unknown', 'SUBMITTED_UNKNOWN'],
  ]);
  assert.equal(await journal.readAttempt('missing-attempt'), null);
  const reconciling = await journal.beginReconciliation({
    expectedVersion: unresolved[1]!.journalVersion,
    attemptId: 'attempt-unknown',
  });
  assert.equal(reconciling.record.status, 'RECONCILING');
  journal.close();
});
