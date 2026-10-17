import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { packageGraph, parseProtocolJson, stringifyProtocolJson, strategyPackageOrder, strategyPackageOrderHash,
  packageGraphHash, toHex } from '@naryx/protocol-types';

const infoUrl = 'https://api.hyperliquid-testnet.xyz/info';
const root = resolve(import.meta.dirname, '../../..');
const roles = ['naryx-clearing-maker-v1', 'naryx-test-trader-v1', 'naryx-clearing-backstop-v1', 'naryx-market-owner-v1'];

export function crossBatchEntryMarkets(markets, reverse) {
  assert.equal(markets.length, 2);
  return markets.map((market, index) => ({ ...(reverse ? markets[1 - index] : market),
    role: market.role, entrySide: market.entrySide }));
}

export function crossBatchEntryLimit(levels, side, requiredQuantityAtoms) {
  assert.ok(Array.isArray(levels) && levels.length > 0 && ['BUY', 'SELL'].includes(side));
  assert.ok(typeof requiredQuantityAtoms === 'bigint' && requiredQuantityAtoms > 0n);
  const parsed = levels.map((level) => {
    assert.ok(typeof level.px === 'string' && /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,8})?$/.test(level.px));
    assert.ok(typeof level.sz === 'string' && /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,10})?$/.test(level.sz));
    const price = parseUnits(level.px, 8), quantity = parseUnits(level.sz, 10);
    assert.ok(price > 0n);
    return { price, quantity };
  });
  const quote = parsed[0].price;
  const limit = side === 'BUY' ? (quote * 10100n + 9999n) / 10000n : quote * 9900n / 10000n;
  assert.ok(limit > 0n);
  const available = parsed.filter((level) => side === 'BUY' ? level.price <= limit : level.price >= limit)
    .reduce((total, level) => total + level.quantity, 0n);
  assert.ok(available >= requiredQuantityAtoms, 'Insufficient real venue depth for the complete controlled cohort');
  return limit;
}

export function requireCrossBatchExitLiquidity(levels, buy, oraclePrice, quantityAtoms) {
  const oracle = parseUnits(oraclePrice, 8);
  assert.ok(oracle > 0n);
  const lower = oracle * 95n / 100n, upper = oracle * 105n / 100n;
  const available = levels.filter((level) => {
    const price = parseUnits(level.px, 8);
    return buy ? price <= upper : price >= lower;
  }).reduce((sum, level) => sum + parseUnits(level.sz, 10), 0n);
  assert.ok(available >= quantityAtoms, 'Executable exit depth is unavailable inside the conservative oracle bound');
}

async function main() {
  const { values } = parseArgs({ options: { output: { type: 'string' }, 'admin-url': { type: 'string' },
    step: { type: 'string', default: 'prepare' }, broadcast: { type: 'boolean', default: false },
    residual: { type: 'boolean', default: false },
    'password-env': { type: 'string', default: 'SETRYN_DEPLOYER_PASSWORD' } } });
  assert.ok(values.output && isAbsolute(values.output) && !resolve(values.output).startsWith(`${root}/`), 'Use an external evidence file');
  assert.ok(['prepare', 'submit', 'inspect', 'cancel'].includes(values.step));
  const origin = new URL(values['admin-url']);
  assert.ok(origin.protocol === 'http:' && origin.hostname === '127.0.0.1' && origin.pathname === '/', 'Only a loopback API is supported');
  const request = async (path, body) => {
    const response = await fetch(new URL(path, origin), body === undefined ? {} : { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: stringifyProtocolJson(body) });
    const result = parseProtocolJson(await response.text());
    assert.ok(response.ok, `${path}: ${response.status} ${result.error?.code ?? 'rejected'} ${result.error?.message ?? ''}`);
    return result;
  };
  const info = async (body) => {
    const response = await fetch(infoUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    assert.equal(response.status, 200, 'Testnet venue data is unavailable');
    return response.json();
  };
  assert.equal((await info({ type: 'meta' })).universe[3].name, 'BTC', 'Expected testnet catalog differs');
  assert.equal((await info({ type: 'spotMeta' })).tokens.find((token) => token.name === 'USDC').tokenId,
    '0xeb62eee3685fc4c43992febcd9e75443', 'Testnet collateral identity differs');
  const profiles = await request('/internal/terminal/strategy-order-profiles');
  const profile = profiles.profiles.find((item) => item.profileId === 'btc-funding-spread-testnet');
  assert.ok(profile && profile.baseAsset.decimals === 10 && profile.quoteAsset.decimals === 8);
  const sourceState = await info({ type: 'clearinghouseState', user: profile.settlementAccount });
  const destinationState = await info({ type: 'clearinghouseState', user: profile.settlementAccount, dex: 'sekaw' });
  let record;
  const save = () => writeFileSync(values.output, `${stringifyProtocolJson(record)}\n`, { mode: 0o600 });
  if (values.step === 'inspect') {
    const netting = await request('/v1/netting/cross-batch');
    console.log(JSON.stringify({ crossBatchCount: netting.clearings?.length ?? 0,
      positions: [sourceState, destinationState].flatMap((state) => state.assetPositions.map((item) => ({ coin: item.position.coin, size: item.position.szi }))) }));
    return;
  }
  assert.equal(values.broadcast, true, 'Admission and submission require --broadcast');
  if (!existsSync(values.output)) {
    assert.equal(values.step, 'prepare');
    assert.equal(sourceState.assetPositions.length, 0, 'Shared source account has positions; inspect them first');
    assert.equal(destinationState.assetPositions.length, 0, 'Secondary account has positions; inspect them first');
    assert.ok(parseUnits(sourceState.withdrawable, 6) >= 20_000_000n);
    assert.ok(parseUnits(destinationState.withdrawable, 6) >= 20_000_000n);
    for (const coin of ['BTC', 'sekaw:BTC']) {
      const data = await info({ type: 'activeAssetData', user: profile.settlementAccount, coin });
      assert.equal(data.leverage.type, 'isolated');
      assert.equal(data.leverage.value, 5);
    }
    record = { version: 1, environment: 'TESTNET', account: profile.settlementAccount, profileId: profile.profileId,
      quantityAtoms: 2_000_000n, economicQuantityAtoms: 2_000_000n, residual: values.residual, nonce: BigInt(Date.now()),
      expiry: BigInt(Date.now()) + 290_000n, pairs: [], sourceBefore: sourceState, destinationBefore: destinationState,
      scope: 'CONTROLLED_TESTNET_CROSS_BATCH_NOT_ORGANIC_VOLUME' };
    save();
  } else record = structuredClone(parseProtocolJson(readFileSync(values.output, 'utf8')));
  if (record.pairs.length === 0 && record.economicQuantityAtoms !== record.quantityAtoms) {
    assert.equal(values.step, 'prepare');
    record.rejectedEconomicQuantityAtoms = record.economicQuantityAtoms;
    record.economicQuantityAtoms = record.quantityAtoms;
    save();
  }
  assert.equal(record.environment, 'TESTNET');
  assert.equal(record.account, profile.settlementAccount);
  if (values.step !== 'cancel') assert.ok(BigInt(Date.now()) < record.expiry - 20_000n, 'Do not replace an expired signed run; inspect its existing executions first');
  const password = process.env[values['password-env']];
  assert.ok(password, 'Test owner keystore password is required');
  const wallets = new Map();
  const wallet = (role) => {
    if (!wallets.has(role)) {
      let key;
      try { key = execFileSync('cast', ['wallet', 'private-key', '--account', role, '--password', password],
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim(); }
      catch { throw new Error('Cannot unlock the dedicated test owner'); }
      wallets.set(role, privateKeyToAccount(key));
    }
    return wallets.get(role);
  };
  if (values.step === 'cancel') {
    for (const pair of record.pairs) for (const item of pair.entries) {
      if (item.order.side !== 'ASK' || item.cancelled) continue;
      const response = await fetch(new URL(`/v1/package-book/orders/${item.order.orderId}/settlement-readiness`, origin));
      if (response.status === 404) continue;
      assert.equal(response.status, 200);
      const progress = parseProtocolJson(await response.text());
      if (!progress.readiness.acceptsFurtherMatches) continue;
      const cancellation = { version: 1, executionClassId: item.order.executionClassId,
        entryId: item.order.orderId, participantId: item.order.participantId };
      const signing = await request('/v1/package-book/cancellations/authorization', { cancellation });
      assert.equal(signing.scheme, 'EIP712_SECP256K1');
      const signature = await wallet(item.role).signTypedData(signing.typedData);
      item.cancellation = { cancellation, authorization: { scheme: signing.scheme, signature } };
      save();
      item.cancelled = await request('/v1/package-book/cancellations', item.cancellation);
      save();
    }
    console.log(JSON.stringify({ cancelledOrders: record.pairs.flatMap((pair) => pair.entries).filter((item) => item.cancelled).length }));
    return;
  }
  if (values.step === 'prepare') {
    for (let pairIndex = 0; pairIndex < 2; pairIndex += 1) {
      if (record.pairs[pairIndex]) continue;
      const quantityAtoms = record.residual && pairIndex === 1 ? record.quantityAtoms / 2n : record.quantityAtoms;
      const markets = crossBatchEntryMarkets(profile.markets, pairIndex === 1);
      const limits = [];
      for (const market of markets) {
        const book = await info({ type: 'l2Book', coin: market.coin });
        const context = await info({ type: 'metaAndAssetCtxs', ...(market.coin.includes(':') ? { dex: market.coin.split(':')[0] } : {}) });
        const marketIndex = context[0].universe.findIndex((item) => item.name === market.coin);
        assert.ok(marketIndex >= 0);
        requireCrossBatchExitLiquidity(book.levels[market.entrySide === 'BUY' ? 0 : 1],
          market.entrySide !== 'BUY', context[1][marketIndex].oraclePx, record.quantityAtoms * 4n);
        const side = market.entrySide === 'BUY' ? book.levels[1] : book.levels[0];
        const quoteAtoms = crossBatchEntryLimit(side, market.entrySide, record.quantityAtoms * 4n);
        limits.push({ legId: market.role, quoteAtoms: quoteAtoms.toString(), baseAtoms: '10000000000' });
      }
      const pair = { entries: [] };
      for (let index = 0; index < 2; index += 1) {
        const role = roles[pairIndex * 2 + index];
        const owner = wallet(role);
        const created = await request('/internal/terminal/strategy-orders/create', { profileId: profile.profileId,
          owner: owner.address.toLowerCase(), lifecycleAction: 'ENTRY', quantityAtoms: quantityAtoms.toString(),
          economicQuantityAtoms: quantityAtoms.toString(), limitPrices: limits,
          expiryValue: record.expiry.toString(), nonce: (record.nonce + BigInt(pairIndex * 2 + index)).toString() });
        assert.equal(toHex(strategyPackageOrderHash(created.order)), created.orderHash);
        assert.equal(toHex(packageGraphHash(created.graph)), created.graphHash);
        assert.equal(created.order.environment, 'testnet');
        assert.equal(created.order.executionClassId, profile.executionClassId);
        assert.ok(created.graph.legs.every((leg) => leg.domain.domainId === 'hypercore:testnet'));
        const graph = packageGraph({ ...created.graph, legs: created.graph.legs.map((leg, legIndex) => {
          const target = pairIndex === 1 ? created.graph.legs[1 - legIndex] : leg;
          return { ...leg, adapter: target.adapter, venue: target.venue, market: target.market };
        }) });
        const order = strategyPackageOrder({ ...created.order, graphHash: packageGraphHash(graph),
          ...(index === 0 ? { packageOrderType: 'LIMIT', packageTimeInForce: 'GTD' } : {}) });
        const orderHash = (await request('/v1/strategy-orders', { order, graph })).orderHashHex;
        const ready = await request('/v1/package-book/orders/prepare', { strategyOrderHash: orderHash,
          side: index === 0 ? 'ASK' : 'BID', limitPriceTicks: '1000' });
        const signing = await request('/v1/package-book/orders/authorization', { order: ready.order, settlementCommitment: ready.settlementCommitment });
        assert.equal(signing.scheme, 'EIP712_SECP256K1');
        const signature = await owner.signTypedData(signing.typedData);
        pair.entries.push({ role, strategyOrder: order, graph, order: ready.order,
          settlementCommitment: ready.settlementCommitment, signature });
      }
      record.pairs.push(pair);
      save();
    }
    console.log(JSON.stringify({ preparedPairs: record.pairs.length, sourcePackages: 4,
      quantityPerLegBTC: record.residual ? ['0.0002', '0.0001'] : ['0.0002', '0.0002'], broadcastToVenue: false }));
    return;
  }
  assert.equal(record.pairs.length, 2, 'Prepare both pairs first');
  if (!record.pairs.some((pair) => pair.entries.some((entry) => entry.submitted))) {
    assert.equal(sourceState.assetPositions.length, 0);
    assert.equal(destinationState.assetPositions.length, 0);
    assert.ok(parseUnits(destinationState.withdrawable, 6) >= 20_000_000n);
  }
  for (const pair of record.pairs) {
    for (const item of pair.entries) {
      const result = await request('/v1/package-book/orders', { order: item.order, settlementCommitment: item.settlementCommitment,
        authorization: { scheme: 'EIP712_SECP256K1', signature: item.signature } });
      assert.equal(result.accepted, true);
      item.submitted = true;
      item.submission = result;
      save();
      if (item.order.side === 'BID') {
        assert.equal(result.allocation.fills.length, 1);
        assert.equal(toHex(result.allocation.fills[0].makerEntryId), pair.entries[0].order.orderId);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  console.log(JSON.stringify({ submittedPairs: 2, sourcePackages: 4, settlement: 'PENDING_VERIFICATION' }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.shortMessage ?? error.message); process.exitCode = 1; });
}
