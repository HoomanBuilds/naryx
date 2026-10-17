import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { ExchangeClient, HttpTransport, InfoClient } from '@nktkas/hyperliquid';
import { getAddress, parseUnits, type PrivateKeyAccount } from 'viem';
import { parseProtocolJson, toHex, verifyCrossBatchClearingPlan, verifyCrossBatchClearingReceipt,
  type CrossBatchClearingPolicy, type CrossBatchClearingPlan, type CrossBatchClearingReceipt,
  type CrossBatchExternalExecutionIntent, type CrossBatchExternalExecutionEvidence,
  type NettingExternalExecutionIntent } from '@naryx/protocol-types';
import { loadHyperliquidTestnetAgentSigner } from './hyperliquid-testnet-agent-key.js';

interface Clearing {
  status: string;
  policy: CrossBatchClearingPolicy;
  sourceIntents: NettingExternalExecutionIntent[];
  plan: CrossBatchClearingPlan;
  receipt: CrossBatchClearingReceipt;
  intent: CrossBatchExternalExecutionIntent;
  evidence: CrossBatchExternalExecutionEvidence;
}

export function validateTestnetUnwindAction(payload: unknown, expected: { asset: number; buy: boolean; price: string; tif?: 'Gtc' | 'Ioc' }): void {
  const request = payload as { nonce?: unknown; vaultAddress?: unknown; action?: { type?: string; grouping?: string; orders?: unknown[] } };
  const action = request.action;
  assert.ok(Number.isSafeInteger(request.nonce) && Number(request.nonce) > 0 && request.vaultAddress === undefined);
  assert.ok(action?.type === 'order' && action.grouping === 'na' && action.orders?.length === 1);
  assert.deepEqual(action.orders[0], { a: expected.asset, b: expected.buy, p: expected.price,
    s: '0.0002', r: true, t: { limit: { tif: expected.tif ?? 'Ioc' } } });
  assert.ok((expected.asset === 3 && !expected.buy) || (expected.asset === 390000 && expected.buy));
  if (expected.tif === 'Gtc') assert.equal(expected.asset, 390000);
}

export function validateTestnetRecoveryCancellation(payload: unknown, orderId: number): void {
  const request = payload as { nonce?: unknown; vaultAddress?: unknown; action?: unknown };
  assert.ok(Number.isSafeInteger(orderId) && orderId > 0 && Number.isSafeInteger(request.nonce) && Number(request.nonce) > 0);
  assert.equal(request.vaultAddress, undefined);
  assert.deepEqual(request.action, { type: 'cancel', cancels: [{ a: 390000, o: orderId }] });
}

async function main() {
  const { values } = parseArgs({ options: { journal: { type: 'string' }, plans: { type: 'string' },
    broadcast: { type: 'boolean', default: false }, passive: { type: 'boolean', default: false }, complete: { type: 'boolean', default: false } } });
  const root = resolve(import.meta.dirname, '../../..');
  assert.ok(values.journal && isAbsolute(values.journal) && !resolve(values.journal).startsWith(`${root}/`));
  assert.ok(!(values.passive && values.complete));
  const secondaryOnly = values.passive || values.complete;
  const journalPath = values.passive ? `${values.journal}.passive` : values.complete ? `${values.journal}.complete` : values.journal;
  const hashes = values.plans?.split(',') ?? [];
  assert.ok(hashes.length === 2 && new Set(hashes).size === 2 && hashes.every((hash) => /^[0-9a-f]{64}$/.test(hash)));
  const account = getAddress(process.env.NARYX_HYPERLIQUID_TESTNET_TRADING_ACCOUNT ?? '');
  assert.equal(account.toLowerCase(), process.env.NARYX_HYPERLIQUID_TESTNET_MASTER_ACCOUNT?.toLowerCase());
  const transport = new HttpTransport({ isTestnet: true, timeout: 15_000 });
  assert.equal(String(transport.apiUrl).replace(/\/$/, ''), 'https://api.hyperliquid-testnet.xyz');
  const info = new InfoClient({ transport });
  assert.equal((await info.meta()).universe[3]?.name, 'BTC');
  assert.equal((await info.perpDexs())[29]?.name, 'sekaw');
  assert.equal((await info.meta({ dex: 'sekaw' })).universe[0]?.name, 'sekaw:BTC');
  assert.equal((await info.spotMeta()).tokens.find((token) => token.name === 'USDC')?.tokenId,
    '0xeb62eee3685fc4c43992febcd9e75443');
  const state = async () => Promise.all(['', 'sekaw'].map((dex) => info.clearinghouseState({ user: account, dex })));
  if (existsSync(journalPath)) {
    const prior = JSON.parse(readFileSync(journalPath, 'utf8'));
    assert.equal(prior.account, account);
    assert.deepEqual(prior.plans, hashes);
    const flat = (await state()).every((item) => item.assetPositions.length === 0);
    let status = prior.status;
    if (flat && existsSync(`${values.journal}.complete`)) {
      const completed = JSON.parse(readFileSync(`${values.journal}.complete`, 'utf8'));
      assert.equal(completed.account, account);
      assert.deepEqual(completed.plans, hashes);
      if (completed.status === 'VERIFIED_FLAT') status = completed.status;
    }
    console.log(JSON.stringify({ status, resubmission: false, flat }));
    return;
  }
  const clearings: Clearing[] = [];
  for (const hash of hashes) {
    const response = await fetch(`http://127.0.0.1:8807/v1/netting/cross-batch/${hash}`, { signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, 200);
    const clearing = parseProtocolJson(await response.text()) as Clearing;
    assert.equal(clearing.status, 'EXACT_FILLED');
    assert.equal(toHex(clearing.plan.planHash), hash);
    assert.equal(clearing.plan.domain.domainId, 'hypercore:testnet');
    verifyCrossBatchClearingPlan(clearing.plan, clearing.sourceIntents, clearing.policy);
    verifyCrossBatchClearingReceipt(clearing.receipt, clearing.plan, clearing.intent, clearing.evidence);
    assert.equal(clearing.intent.quantityAtoms, 2_000_000n);
    assert.equal(clearing.intent.quantityAsset.decimals, 10);
    clearings.push(clearing);
  }
  assert.ok(clearings.some((item) => item.intent.market.subjectId === 'btc-usdc-perpetual' && item.intent.side === 'BUY'));
  assert.ok(clearings.some((item) => item.intent.market.subjectId === 'sekaw-btc-perpetual' && item.intent.side === 'SELL'));
  const before = await state();
  const specs = [{ asset: 3, coin: 'BTC', buy: false, size: '0.0002' },
    { asset: 390000, coin: 'sekaw:BTC', buy: true, size: '-0.0002' }];
  let recoveryOrderId: number | undefined;
  if (secondaryOnly) {
    assert.ok(existsSync(values.journal), 'Passive recovery requires the original unwind journal');
    const parent = JSON.parse(readFileSync(values.journal, 'utf8'));
    assert.equal(parent.account, account);
    assert.deepEqual(parent.plans, hashes);
    assert.equal(parseUnits(parent.responses[0].response.data.statuses[0].filled.totalSz, 10), 2_000_000n);
    assert.equal(before[0]!.assetPositions.length, 0, 'The first close must already be observed flat');
    if (values.complete) {
      const passive = JSON.parse(readFileSync(`${values.journal}.passive`, 'utf8'));
      assert.equal(passive.account, account);
      assert.deepEqual(passive.plans, hashes);
      assert.equal(passive.status, 'WAITING_LIQUIDITY');
      recoveryOrderId = passive.restingOrderId;
      assert.ok(Number.isSafeInteger(recoveryOrderId) && recoveryOrderId! > 0);
    }
  }
  for (const [index, spec] of specs.entries()) {
    if (secondaryOnly && index === 0) continue;
    assert.equal(before[index]!.assetPositions.length, 1, 'Unrelated positions prohibit cohort unwind');
    assert.equal(before[index]!.assetPositions[0]!.position.coin, spec.coin);
    assert.equal(before[index]!.assetPositions[0]!.position.szi, spec.size);
  }
  const orders: { asset: number; coin: string; buy: boolean; price: string; tif: 'Ioc' | 'Gtc' }[] = [];
  for (const spec of specs) {
    if (secondaryOnly && spec.asset === 3) continue;
    const book = await info.l2Book({ coin: spec.coin });
    const levels = book?.levels[spec.buy ? 1 : 0];
    assert.ok(levels?.length);
    const best = parseUnits(levels[0]!.px, 8);
    const context = values.passive ? await info.metaAndAssetCtxs({ dex: 'sekaw' }) : undefined;
    const oracle = context === undefined ? undefined : parseUnits(context[1][0]!.oraclePx!, 8);
    const bound = oracle === undefined
      ? spec.buy ? (best * 101n + 99n) / 100n : best * 99n / 100n
      : oracle * 103n / 100n;
    const integer = spec.buy ? (bound + 99_999_999n) / 100_000_000n : bound / 100_000_000n;
    assert.ok(integer > 0n && integer * 2n <= 1_000_000n, 'Close price exceeds the controlled notional cap');
    assert.ok(values.passive || levels.filter((level) => spec.buy ? parseUnits(level.px, 8) <= integer * 100_000_000n
      : parseUnits(level.px, 8) >= integer * 100_000_000n)
      .reduce((sum, level) => sum + parseUnits(level.sz, 10), 0n) >= 2_000_000n);
    orders.push({ asset: spec.asset, coin: spec.coin, buy: spec.buy, price: integer.toString(), tif: values.passive ? 'Gtc' : 'Ioc' });
  }
  if (!values.broadcast) { console.log(JSON.stringify({ account, orders, quantityBTC: '0.0002', reduceOnly: true, broadcast: false })); return; }
  const expectedAgent = process.env.NARYX_HYPERLIQUID_TESTNET_AGENT_ADDRESS ?? '';
  const role = await info.userRole({ user: getAddress(expectedAgent) });
  assert.ok(role.role === 'agent' && getAddress(role.data.user) === account);
  const signer = loadHyperliquidTestnetAgentSigner(process.env.NARYX_HYPERLIQUID_TESTNET_AGENT_KEY_PATH ?? '', expectedAgent);
  const wallet: PrivateKeyAccount = { ...signer, signTypedData: async (input) => {
    assert.equal(input.primaryType, 'Agent');
    assert.equal((input.message as Record<string, unknown>).source, 'b');
    return signer.signTypedData(input);
  } };
  const record: Record<string, unknown> = { version: 1, environment: 'TESTNET', account, plans: hashes,
    scope: 'CONTROLLED_COHORT_OPERATOR_UNWIND_NOT_OWNER_SETTLEMENT', before, orders, createdAtMs: Date.now(), status: 'PLANNED' };
  const save = () => writeFileSync(journalPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  let index = 0;
  let cancelling = false;
  const guarded = { isTestnet: true, request: async <T>(route: 'info' | 'exchange' | 'explorer', payload: unknown, signal?: AbortSignal): Promise<T> => {
    assert.equal(route, 'exchange');
    if (cancelling) validateTestnetRecoveryCancellation(payload, recoveryOrderId!);
    else validateTestnetUnwindAction(payload, orders[index]!);
    record.signedRequests = [...(record.signedRequests as unknown[] ?? []), payload];
    record.status = 'SUBMISSION_PENDING';
    save();
    const response = await transport.request<T>(route, payload, signal);
    record.wireResponses = [...(record.wireResponses as unknown[] ?? []), response];
    save();
    return response;
  } };
  const exchange = new ExchangeClient({ transport: guarded, wallet });
  save();
  for (const order of orders) {
    const result = await exchange.order({ grouping: 'na', orders: [{ a: order.asset, b: order.buy,
      p: order.price, s: '0.0002', r: true, t: { limit: { tif: order.tif } } }] });
    record.responses = [...(record.responses as unknown[] ?? []), result];
    save();
    const fill = result.response.data.statuses[0];
    if (values.passive && fill && typeof fill === 'object' && 'resting' in fill) {
      record.status = 'WAITING_LIQUIDITY';
      record.restingOrderId = fill.resting.oid;
      save();
      console.log(JSON.stringify({ account, status: record.status, restingOrderId: record.restingOrderId }));
      return;
    }
    assert.ok(fill && typeof fill === 'object' && 'filled' in fill
      && parseUnits(fill.filled.totalSz, 10) === 2_000_000n, 'Close did not fill exactly; inspect the journal');
    index += 1;
  }
  record.after = await state();
  assert.ok((record.after as Awaited<ReturnType<typeof state>>).every((item) => item.assetPositions.length === 0));
  if (recoveryOrderId !== undefined) {
    const status = await info.orderStatus({ user: account, oid: recoveryOrderId });
    if (status.status === 'order' && status.order.status === 'open') {
      cancelling = true;
      record.recoveryCancellation = await exchange.cancel({ cancels: [{ a: 390000, o: recoveryOrderId }] });
      save();
    }
    const finalOrderStatus = await info.orderStatus({ user: account, oid: recoveryOrderId });
    record.recoveryOrderStatus = finalOrderStatus;
    assert.ok(finalOrderStatus.status !== 'order' || finalOrderStatus.order.status !== 'open');
  }
  record.status = 'VERIFIED_FLAT';
  save();
  console.log(JSON.stringify({ account, status: record.status, quantityClosedPerMarketBTC: '0.0002' }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : 'Testnet unwind refused'); process.exitCode = 1; });
}
