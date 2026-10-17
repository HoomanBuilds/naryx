import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createServer } from 'node:http';
import { domainRef, parseProtocolJson, stringifyProtocolJson } from '@naryx/protocol-types';
import { NativeCashAwaitingFinality } from '@naryx/adapter-evm';
import { hashTypedData, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { NativeCashService, type NativeCashMarketPort } from '../src/native-cash-service.js';
import { createNativeCashTestnetHandler, loadNativeCashTestnetRuntime } from '../src/native-cash-testnet-runtime.js';

const maker = privateKeyToAccount(`0x${'01'.repeat(32)}`);
const owner = privateKeyToAccount(`0x${'02'.repeat(32)}`).address;
const hash = `0x${'ab'.repeat(32)}` as Hex;
const house = `0x${'11'.repeat(20)}` as const;
const request = { requestId: 'request-1', marketId: 'cash-range', owner, accountId: 'cash-trader', side: 'BUY' as const, quantityAtoms: 1n };

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'naryx-native-cash-'));
  const path = join(dir, 'cash.sqlite');
  let now = 1_000_000, signCount = 0, observations = 0;
  const port: NativeCashMarketPort = { marketId: request.marketId, makerOwner: maker.address,
    quote: async input => {
      const match = { authorizationHash: input.authorizationHash, longAccountId: hash, shortAccountId: `0x${'cd'.repeat(32)}` as Hex,
        feePayerAccountId: hash, longSequence: 1n, shortSequence: 1n, quantityAtoms: input.quantityAtoms, priceTicks: 500_000n, maxFeeBps: 0,
        expiry: input.nowSeconds + input.lifetimeSeconds };
      const typedData = { domain: { name: 'Naryx Native Package Clearing', version: '1', chainId: 84532, verifyingContract: house },
        types: { NativeMatch: [{ name: 'policyHash', type: 'bytes32' }, { name: 'authorizationHash', type: 'bytes32' },
          { name: 'longAccountId', type: 'bytes32' }, { name: 'shortAccountId', type: 'bytes32' }, { name: 'feePayerAccountId', type: 'bytes32' },
          { name: 'longSequence', type: 'uint64' }, { name: 'shortSequence', type: 'uint64' }, { name: 'quantityAtoms', type: 'uint128' },
          { name: 'priceTicks', type: 'uint128' }, { name: 'maxFeeBps', type: 'uint16' }, { name: 'expiry', type: 'uint64' }] },
        primaryType: 'NativeMatch' as const, message: { policyHash: hash, ...match } } as const;
      return { version: 1, kind: 'EVM_NATIVE_CASH_RANGE_V1', marketId: request.marketId, environment: 'testnet',
        domain: domainRef('eip155:84532', 1, hash), guarantee: 'OWNER_SIGNED_NATIVE_CASH_MATCH', quoteMode: 'EXECUTION_COMMITMENT',
        chainId: 84532, clearingHouse: house, makerOwner: maker.address, owner: input.owner, side: input.side, reducingOnly: false,
        priceTicks: match.priceTicks, referencePriceTicks: 499_500n, maximumPriceTicks: 1_000_001n,
        observedBlock: { number: 1n, hash, timestamp: input.nowSeconds }, match, typedData, digest: hashTypedData(typedData) };
    },
    sign: async quote => { signCount++; return maker.signTypedData(quote.typedData); },
    observe: async (quote, transactionHash) => { observations++; return { version: 1, kind: 'NATIVE_CASH_RANGE_MATCH', environment: 'testnet',
      evidenceGrade: 'FINALIZED_CONTRACT_RECEIPT', marketId: quote.marketId, domain: quote.domain, clearingHouse: house,
      owner, makerOwner: maker.address, quoteDigest: quote.digest, authorizationHash: quote.match.authorizationHash, transactionHash,
      blockNumber: 2n, blockHash: hash, logIndex: 0, side: quote.side, quantityAtoms: quote.match.quantityAtoms, priceTicks: quote.match.priceTicks, feeAtoms: 0n }; },
  };
  const service = () => new NativeCashService(path, [port], () => now);
  return { dir, path, port, service, advance: (ms: number) => { now += ms; }, counts: () => ({ signCount, observations }) };
}

test('signed cash quotes and verified settlements survive restart without resigning or reapplying', async () => {
  const f = fixture(); let service = f.service();
  try {
    const signed = await service.requestQuote(request);
    assert.equal(signed.quote.owner, owner);
    service.close(); service = f.service();
    assert.deepEqual(await service.requestQuote(request), signed);
    await assert.rejects(service.requestQuote({ ...request, quantityAtoms: 2n }), /different terms/);
    const receipt = await service.observe(request.requestId, hash);
    assert.deepEqual(service.trades(request.marketId), [receipt]);
    service.close(); service = f.service();
    assert.deepEqual(await service.observe(request.requestId, hash), receipt);
    assert.equal(service.trades(request.marketId).length, 1);
    assert.throws(() => service.trades('unknown'), /not activated/);
    assert.deepEqual(f.counts(), { signCount: 1, observations: 1 });
    await assert.rejects(service.observe(request.requestId, `0x${'ff'.repeat(32)}`), /different transaction/);
  } finally { service.close(); rmSync(f.dir, { recursive: true }); }
});

test('durable maker leases refuse concurrent quotes until expiry across separate processes', async () => {
  const f = fixture(); const a = f.service(), b = f.service();
  try {
    const first = a.requestQuote(request);
    await assert.rejects(b.requestQuote({ ...request, requestId: 'request-2' }), /outstanding quote/);
    await first;
    f.advance(20_000);
    await b.requestQuote({ ...request, requestId: 'request-2' });
    assert.equal(f.counts().signCount, 2);
  } finally { a.close(); b.close(); rmSync(f.dir, { recursive: true }); }
});

test('verified included cash trades reconcile after restart without the browser or new signatures', async () => {
  const f = fixture(); let service = f.service();
  const observe = f.port.observe;
  try {
    await service.requestQuote(request);
    f.port.observe = async (quote, tx) => { throw new NativeCashAwaitingFinality(tx, quote.digest); };
    await assert.rejects(service.observe(request.requestId, hash), NativeCashAwaitingFinality);
    service.close(); service = f.service();
    assert.deepEqual(await service.reconcilePending(), { checked: 1, finalized: 0 });
    f.port.observe = async () => { throw new Error('Reorg or unavailable RPC'); };
    assert.deepEqual(await service.reconcilePending(), { checked: 1, finalized: 0 });
    assert.equal(service.trades(request.marketId).length, 0);
    f.port.observe = observe;
    assert.deepEqual(await service.reconcilePending(), { checked: 1, finalized: 1 });
    assert.deepEqual(await service.reconcilePending(), { checked: 0, finalized: 0 });
    assert.equal(service.trades(request.marketId).length, 1);
    assert.equal(f.counts().signCount, 1);
  } finally { service.close(); rmSync(f.dir, { recursive: true }); }
});

test('unknown, unverified and mismatched cash observations cannot acquire finality queue capacity', async () => {
  const f = fixture(); const service = f.service();
  try {
    await assert.rejects(service.observe('unknown', hash), /not found/);
    await service.requestQuote(request);
    for (const failure of [new Error('Receipt unavailable'), new NativeCashAwaitingFinality(hash, `0x${'ff'.repeat(32)}`)]) {
      f.port.observe = async () => { throw failure; };
      await assert.rejects(service.observe(request.requestId, hash));
      assert.deepEqual(await service.reconcilePending(), { checked: 0, finalized: 0 });
    }
  } finally { service.close(); rmSync(f.dir, { recursive: true }); }
});

test('interrupted signing never retries a signature and holds a conservative lease', async () => {
  const f = fixture(); const service = f.service();
  f.port.sign = async () => { throw new Error('signer unavailable'); };
  try {
    await assert.rejects(service.requestQuote(request), /unavailable/);
    await assert.rejects(service.requestQuote(request), /fresh ID/);
    await assert.rejects(service.requestQuote({ ...request, requestId: 'request-2' }), /outstanding quote/);
    assert.equal(service.quote(request.requestId), undefined);
    await assert.rejects(service.observe(request.requestId, hash), /not found/);
  } finally { service.close(); rmSync(f.dir, { recursive: true }); }
});

test('a consumed onchain maker sequence permits a fresh quote before the old lease expires', async () => {
  const f = fixture(); const service = f.service(); const original = f.port.quote;
  try {
    await service.requestQuote(request);
    f.port.quote = async input => {
      const q = await original(input);
      const match = { ...q.match, shortSequence: 2n };
      const typedData = { ...q.typedData, message: { ...q.typedData.message, ...match } };
      return { ...q, observedBlock: { ...q.observedBlock, number: 2n }, match, typedData, digest: hashTypedData(typedData) };
    };
    const next = await service.requestQuote({ ...request, requestId: 'after-consumed-entry' });
    assert.equal(next.quote.match.shortSequence, 2n);
    await assert.rejects(service.requestQuote({ ...request, requestId: 'same-sequence' }), /outstanding quote/);
  } finally { service.close(); rmSync(f.dir, { recursive: true }); }
});

test('unqualified accounts cannot acquire the maker lease or block a funded quote', async () => {
  const f = fixture(); const service = f.service();
  const quote = f.port.quote;
  f.port.quote = async input => {
    if (input.accountId === 'unfunded-account') throw new Error('Unfunded account');
    return quote(input);
  };
  try {
    await assert.rejects(service.requestQuote({ ...request, requestId: 'unfunded-request', accountId: 'unfunded-account' }), /Unfunded/);
    assert.equal(service.quote('unfunded-request'), undefined);
    await service.requestQuote(request);
    assert.equal(f.counts().signCount, 1);
  } finally { service.close(); rmSync(f.dir, { recursive: true }); }
});

test('wrong maker signatures, invalid quantities and unverifiable receipts fail closed', async () => {
  const f = fixture(); const service = f.service();
  try {
    await assert.rejects(service.requestQuote({ ...request, quantityAtoms: 0n }), /invalid/);
    await assert.rejects(service.requestQuote({ ...request, marketId: 'unknown' }), /not activated/);
    const signer = f.port.sign;
    f.port.sign = quote => privateKeyToAccount(`0x${'03'.repeat(32)}`).signTypedData(quote.typedData);
    await assert.rejects(service.requestQuote(request), /signature differs/);
    f.port.sign = signer; f.advance(60_000);
    await service.requestQuote({ ...request, requestId: 'valid-request' });
    const observer = f.port.observe;
    f.port.observe = async (quote, tx) => ({ ...await observer(quote, tx), priceTicks: 99n });
    await assert.rejects(service.observe('valid-request', hash), /differs/);
    assert.equal(service.settlement('valid-request'), undefined);
  } finally { service.close(); rmSync(f.dir, { recursive: true }); }
});

test('native cash HTTP preserves tagged integer terms and refuses forwarded callers', async () => {
  const f = fixture(); const service = f.service();
  const accountCalls: unknown[] = [];
  const handler = createNativeCashTestnetHandler({ service, markets: [{ marketId: request.marketId, binding: {} as never,
    inspect: async () => ({}), book: async () => ({ bidQuantity: 1n }),
    account: async (owner, accountId) => { accountCalls.push({ owner, accountId }); return { collateralQuoteAtoms: 42n }; } }] });
  const server = createServer((request, response) => { void handler(request, response); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const trades = await fetch(`${origin}/v1/native-cash/markets/${request.marketId}/trades`);
    assert.equal(trades.status, 200);
    assert.deepEqual((await trades.json() as { trades: unknown[] }).trades, []);
    const response = await fetch(`${origin}/v1/native-cash/quotes`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: stringifyProtocolJson(request) });
    assert.equal(response.status, 200);
    const payload = parseProtocolJson(await response.text()) as { result: { quote: { match: { quantityAtoms: bigint } } } };
    assert.equal(payload.result.quote.match.quantityAtoms, 1n);
    assert.equal((await fetch(`${origin}/v1/native-cash/quotes/${request.requestId}`)).status, 200);
    const account = await fetch(`${origin}/v1/native-cash/markets/${request.marketId}/account`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: stringifyProtocolJson({ owner, accountId: 'wallet-user' }) });
    assert.equal(account.status, 200);
    assert.deepEqual(parseProtocolJson(await account.text()), { version: 1, result: { collateralQuoteAtoms: 42n } });
    assert.deepEqual(accountCalls, [{ owner, accountId: 'wallet-user' }]);
    const book = await fetch(`${origin}/v1/native-cash/markets/${request.marketId}/book`);
    assert.equal(book.status, 200);
    assert.deepEqual(parseProtocolJson(await book.text()), { version: 1, result: { bidQuantity: 1n } });
    assert.equal((await fetch(`${origin}/v1/native-cash/markets/unknown/account`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: stringifyProtocolJson({ owner, accountId: 'wallet-user' }) })).status, 409);
    for (const headers of [{ Origin: 'https://example.com' }, { 'X-Forwarded-For': '127.0.0.1' }, { Forwarded: 'for=127.0.0.1' }]) {
      assert.equal((await fetch(`${origin}/v1/native-cash/markets`, { headers })).status, 403);
    }
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); service.close(); rmSync(f.dir, { recursive: true }); }
});

test('runtime stays disabled by default and refuses missing explicit activation configuration', async () => {
  await assert.rejects(loadNativeCashTestnetRuntime({}), /disabled/);
  await assert.rejects(loadNativeCashTestnetRuntime({ NARYX_NATIVE_CASH_TESTNET_ENABLED: 'true' }), /configuration path/);
});
