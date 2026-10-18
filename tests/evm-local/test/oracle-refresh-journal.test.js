import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { encodeFunctionData, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { OracleRefreshJournal, REFRESH_BUDGET_WEI, REFRESH_RESERVATION_WEI } from '../../../deployments/tools/evm-oracle-refresh-journal.mjs';

const signer = privateKeyToAccount(`0x${'12'.repeat(32)}`);
const oracle = `0x${'34'.repeat(20)}`;
const answer = 2000_00000000n;
async function transaction(overrides = {}, account = signer) {
  return { raw: await account.signTransaction({ chainId: 84532, type: 'eip1559', nonce: 0,
    to: oracle, value: 0n, gas: 50_000n, maxFeePerGas: 1_000_000n, maxPriorityFeePerGas: 1n,
    data: encodeFunctionData({ abi: parseAbi(['function setAnswer(int256 nextAnswer)']), functionName: 'setAnswer', args: [answer] }),
    ...overrides }), answer, round: 1n, updatedAt: 100n };
}
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'naryx-oracle-journal-'));
  const path = join(dir, 'oracle.sqlite');
  t.after(() => rmSync(dir, { recursive: true }));
  return { path, journal: new OracleRefreshJournal(path, 84532, oracle, signer.address) };
}

test('refresh journal retains exact pending transaction and reserved gas across restart', async t => {
  const { path, journal } = fixture(t);
  const submitted = await journal.reserve(await transaction());
  journal.close();
  const restarted = new OracleRefreshJournal(path, 84532, oracle, signer.address);
  try {
    assert.deepEqual(restarted.pending(), submitted);
    assert.equal(restarted.reserved(), REFRESH_RESERVATION_WEI);
    await assert.rejects(restarted.reserve(await transaction({ nonce: 1 })), /unresolved/);
    restarted.resolve(submitted.hash, true, 100n);
    assert.equal(restarted.reserved(), REFRESH_RESERVATION_WEI);
    assert.equal(restarted.pending(), undefined);
    assert.throws(() => restarted.resolve(submitted.hash, true, 100n), /not pending/);
  } finally { restarted.close(); }
  assert.throws(() => new OracleRefreshJournal(path, 421614, oracle, signer.address), /binding changed/);
});

test('refresh refuses mainnet, wrong contracts, owners, calldata, value and oversized gas', async t => {
  const { path, journal } = fixture(t);
  try {
    assert.throws(() => new OracleRefreshJournal(path, 1, oracle, signer.address), /invalid/);
    for (const override of [{ chainId: 1 }, { to: signer.address }, { data: '0x' }, { value: 1n },
      { maxFeePerGas: REFRESH_RESERVATION_WEI }, { gas: 0n }]) {
      await assert.rejects(journal.reserve(await transaction(override)), /bounds/);
    }
    await assert.rejects(journal.reserve(await transaction({}, privateKeyToAccount(`0x${'56'.repeat(32)}`))), /bounds/);
    assert.equal(journal.reserved(), 0n);
  } finally { journal.close(); }
});

test('refresh budget permits the exact limit and never refunds confirmations', async t => {
  const { journal } = fixture(t);
  try {
    for (let nonce = 0; nonce < Number(REFRESH_BUDGET_WEI / REFRESH_RESERVATION_WEI); nonce++) {
      const pending = await journal.reserve(await transaction({ nonce }));
      journal.resolve(pending.hash, true, 1n);
    }
    assert.equal(journal.reserved(), REFRESH_BUDGET_WEI);
    await assert.rejects(journal.reserve(await transaction({ nonce: 201 })), /exhausted/);
    assert.equal(journal.reserved(), REFRESH_BUDGET_WEI);
  } finally { journal.close(); }
});

test('refresh stops after reverted or over-budget receipts instead of spending repeatedly', async t => {
  for (const [success, cost] of [[false, 1n], [true, REFRESH_RESERVATION_WEI + 1n]]) {
    const { journal } = fixture(t);
    try {
      const pending = await journal.reserve(await transaction());
      assert.throws(() => journal.resolve(pending.hash, success, cost), /review required/);
      await assert.rejects(journal.reserve(await transaction({ nonce: 1 })), /review/);
    } finally { journal.close(); }
  }
});
