import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { reconcilePendingEvmStrategies, recordFinalizedEvmStrategy } from '../src/evm-strategy-reconciliation.js';
import { SqliteStrategyPackageStore } from '../src/strategy-package-store.js';
import type { ObservedEvmStrategyExecution } from '../src/evm-strategy-execution-observation-client.js';

const quoteHashHex = '11'.repeat(32);
const transactionHash = `0x${'22'.repeat(32)}` as const;
const otherQuote = '33'.repeat(32);
const otherTransaction = `0x${'44'.repeat(32)}` as const;

test('pending observation bindings survive reopening, reject replacement, and rotate bounded batches fairly', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'naryx-evm-observations-'));
  const path = join(scratch, 'strategies.db');
  let now = 1000;
  let store = new SqliteStrategyPackageStore(path, { clock: () => now });
  try {
    const raw = new Database(path);
    try {
      raw.prepare('INSERT INTO strategy_package_orders VALUES (?, ?, ?, ?, ?, ?)')
        .run(Buffer.alloc(32, 1), Buffer.alloc(32, 2), 'test-owner', '{}', '{}', now);
      for (const [quote, route] of [[quoteHashHex, 3], [otherQuote, 4]] as const) {
        raw.prepare('INSERT INTO strategy_package_quotes VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(Buffer.from(quote, 'hex'), Buffer.alloc(32, 1), Buffer.alloc(32, route), 'test-solver', '{}', '{}', now);
      }
    } finally {
      raw.close();
    }
    store.queueEvmStrategyObservation(quoteHashHex, transactionHash);
    store.queueEvmStrategyObservation(quoteHashHex, transactionHash);
    assert.throws(() => store.queueEvmStrategyObservation(quoteHashHex, otherTransaction), { code: 'RECEIPT_CONFLICT' });
    assert.throws(() => store.queueEvmStrategyObservation('55'.repeat(32), transactionHash), { code: 'QUOTE_NOT_FOUND' });
    assert.throws(() => store.queueEvmStrategyObservation(otherQuote, `0x${'00'.repeat(32)}`), { code: 'INVALID_HASH' });
    store.queueEvmStrategyObservation(otherQuote, otherTransaction);
    store.close();
    store = new SqliteStrategyPackageStore(path, { clock: () => now });
    assert.deepEqual(store.pendingEvmStrategyObservations(1), [{ quoteHashHex, transactionHash }]);
    now += 1;
    store.touchEvmStrategyObservation(quoteHashHex, transactionHash);
    assert.deepEqual(store.pendingEvmStrategyObservations(1), [{ quoteHashHex: otherQuote, transactionHash: otherTransaction }]);
    store.completeEvmStrategyObservation(quoteHashHex, otherTransaction);
    assert.equal(store.pendingEvmStrategyObservations(2).length, 2);
    store.completeEvmStrategyObservation(quoteHashHex, transactionHash);
    assert.deepEqual(store.pendingEvmStrategyObservations(2), [{ quoteHashHex: otherQuote, transactionHash: otherTransaction }]);
    for (const limit of [0, 101, 1.5, NaN]) {
      assert.throws(() => store.pendingEvmStrategyObservations(limit), { code: 'INVALID_LIMIT' });
    }
  } finally {
    store.close();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('reconciliation keeps pending and failed obligations without starving another transaction', async () => {
  const touched: string[] = [];
  const result = await reconcilePendingEvmStrategies({
    pendingEvmStrategyObservations: (limit) => {
      assert.equal(limit, 10);
      return [{ quoteHashHex, transactionHash }, { quoteHashHex: otherQuote, transactionHash: otherTransaction }];
    },
    touchEvmStrategyObservation: (quote) => { touched.push(quote); },
    recordReceipt: () => { throw new Error('must not record unfinalized receipts'); },
    recordEvmStrategyPosition: () => { throw new Error('must not change unfinalized positions'); },
    completeEvmStrategyObservation: () => { throw new Error('must retain unfinished obligations'); },
  }, {
    observe: async (quote, transaction) => {
      if (quote === quoteHashHex) throw new Error('temporary RPC outage');
      return { version: 1, status: 'PENDING_FINALITY', transactionHash: transaction as `0x${string}` };
    },
  });
  assert.deepEqual(result, { finalized: 0, pending: 1, failed: 1 });
  assert.deepEqual(touched, [quoteHashHex, otherQuote]);
});

test('finalization retains the retry obligation until both receipt and position are recorded', async () => {
  const calls: string[] = [];
  const observation = {
    version: 1, status: 'FINALIZED', transactionHash, chainId: 84532,
    account: '0x' + '11'.repeat(20), packageId: '0x' + '55'.repeat(32),
    previousStateHash: '0x' + '00'.repeat(32), nextStateHash: '0x' + '66'.repeat(32),
    onchainReceiptHash: '0x' + '77'.repeat(32), receipt: {},
  } as Extract<ObservedEvmStrategyExecution, { status: 'FINALIZED' }>;
  let failPosition = true;
  const store = {
    pendingEvmStrategyObservations: () => [{ quoteHashHex, transactionHash }],
    touchEvmStrategyObservation: () => {},
    recordReceipt: () => { calls.push('receipt'); return { created: false, receiptHashHex: '88'.repeat(32) }; },
    recordEvmStrategyPosition: () => {
      calls.push('position');
      if (failPosition) throw new Error('temporary position failure');
      return { status: 'CLOSED' } as ReturnType<SqliteStrategyPackageStore['recordEvmStrategyPosition']>;
    },
    completeEvmStrategyObservation: (quote: string, transaction: string) => {
      assert.equal(quote, quoteHashHex);
      assert.equal(transaction, transactionHash);
      calls.push('complete');
    },
  };
  assert.deepEqual(await reconcilePendingEvmStrategies(store, { observe: async () => observation }),
    { finalized: 0, pending: 0, failed: 1 });
  assert.deepEqual(calls, ['receipt', 'position']);
  failPosition = false;
  assert.equal(recordFinalizedEvmStrategy(store, quoteHashHex, observation).position.status, 'CLOSED');
  assert.deepEqual(calls, ['receipt', 'position', 'receipt', 'position', 'complete']);
});
