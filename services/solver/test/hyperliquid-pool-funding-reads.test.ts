import assert from 'node:assert/strict';
import test from 'node:test';
import type { ClearinghouseStateResponse, UserNonFundingLedgerUpdatesResponse } from '@nktkas/hyperliquid/api/info';
import type { TxDetailsResponse } from '@nktkas/hyperliquid/api/explorer';
import type { AllDexsClearinghouseStateEvent } from '@nktkas/hyperliquid/api/subscription';
import { createHyperliquidPoolFundingReads } from '../src/hyperliquid-pool-funding-reads.js';

const source = `0x${'11'.repeat(20)}` as const;
const destination = `0x${'22'.repeat(20)}` as const;
const hash = `0x${'33'.repeat(32)}` as const;
const token = `0x${'44'.repeat(16)}` as const;

function fixture() {
  const state: ClearinghouseStateResponse = { marginSummary: { accountValue: '19', totalNtlPos: '0', totalRawUsd: '19', totalMarginUsed: '0' },
    crossMarginSummary: { accountValue: '19', totalNtlPos: '0', totalRawUsd: '19', totalMarginUsed: '0' },
    crossMaintenanceMarginUsed: '0', withdrawable: '19', assetPositions: [], time: 10_000 };
  const snapshot: AllDexsClearinghouseStateEvent = { user: destination, clearinghouseStates: [['', state]] };
  const entry: UserNonFundingLedgerUpdatesResponse[number] = { time: 9_000, hash,
    delta: { type: 'internalTransfer', user: source, destination, usdc: '20', fee: '1' } };
  const tx: TxDetailsResponse['tx'] = { action: { type: 'usdSend', hyperliquidChain: 'Testnet', destination, amount: '20', time: 8_999 },
    block: 1, error: null, hash, time: 9_000, user: source };
  let destinationHistory: UserNonFundingLedgerUpdatesResponse = [structuredClone(entry)];
  const info: Parameters<typeof createHyperliquidPoolFundingReads>[1] = {
    async userRole() { return { role: 'user' }; },
    async userAbstraction() { return 'default'; },
    async userDexAbstraction() { return false; },
    async spotClearinghouseState() { return { balances: [] }; },
    async openOrders() { return []; },
    async meta() { return { universe: [], marginTables: [], collateralToken: 0 }; },
    async spotMeta() { return { universe: [], tokens: [{ name: 'USDC', szDecimals: 2, weiDecimals: 8,
      index: 0, tokenId: token, isCanonical: true, evmContract: null, fullName: null, deployerTradingFeeShare: '0' }] }; },
    async twapHistory() { return []; },
    async userNonFundingLedgerUpdates({ user, startTime, endTime }) {
      assert.equal(startTime, 9_000); assert.equal(endTime, 9_000);
      return user === source ? [entry] : destinationHistory;
    },
  };
  const reads = createHyperliquidPoolFundingReads(token, info, { async txDetails() { return { type: 'txDetails', tx }; } },
    async () => snapshot, () => 10_000);
  return { state, snapshot, entry, tx, info, reads, setDestinationHistory(value: UserNonFundingLedgerUpdatesResponse) { destinationHistory = value; } };
}

test('transfer evidence requires both ledgers and the successful matching testnet transaction', async () => {
  const f = fixture();
  const read = () => f.reads.transfer(hash, 9_000, source, destination);
  assert.deepEqual(await read(), { environment: 'TESTNET', hash, source, destination,
    debitedQuoteAtoms: 20_000_000n, receivedQuoteAtoms: 19_000_000n, timeMs: 9_000, nonce: 8_999 });
  f.setDestinationHistory([]);
  await assert.rejects(read(), /both account histories/);
  f.setDestinationHistory([f.entry, f.entry]);
  await assert.rejects(read(), /both account histories/);
  f.setDestinationHistory([f.entry]);
  for (const patch of [{ error: 'rejected' }, { action: { ...f.tx.action, hyperliquidChain: 'Mainnet' } },
    { action: { ...f.tx.action, amount: '19' } }, { action: { ...f.tx.action, time: 9_001 } }]) {
    const original = structuredClone(f.tx);
    Object.assign(f.tx, patch);
    await assert.rejects(read(), /does not match/);
    Object.assign(f.tx, original);
  }
});

test('flat backing refuses foreign DEX cash, stale state, wrong token, nonstandard account and pending orders', async () => {
  const f = fixture();
  assert.equal((await f.reads.flat(destination)).equityQuoteAtoms, 19_000_000n);
  f.snapshot.clearinghouseStates.push(['other', structuredClone(f.state)]);
  await assert.rejects(f.reads.flat(destination), /unsupported DEX/);
  f.snapshot.clearinghouseStates.pop();
  f.state.time = 4_999;
  await assert.rejects(f.reads.flat(destination), /freshly flat/);
  f.state.time = 10_000;
  const spotMeta = f.info.spotMeta;
  f.info.spotMeta = async () => ({ ...await spotMeta(), tokens: [] });
  await assert.rejects(f.reads.flat(destination), /collateral identity/);
  f.info.spotMeta = spotMeta;
  f.info.userDexAbstraction = async () => true;
  await assert.rejects(f.reads.flat(destination), /Standard/);
  f.info.userDexAbstraction = async () => false;
  f.info.openOrders = async () => [{ coin: 'BTC', side: 'B', limitPx: '100', sz: '1', origSz: '1', oid: 1, timestamp: 9_000 }];
  await assert.rejects(f.reads.flat(destination), /open orders/);
});
