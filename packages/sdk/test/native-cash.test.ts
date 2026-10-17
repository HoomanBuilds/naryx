import assert from 'node:assert/strict';
import test from 'node:test';
import { assetRef, domainRef, nativeClearingPolicy, stringifyProtocolJson, toHex, versionedManifestRef } from '@naryx/protocol-types';
import { decodeFunctionData, erc20Abi, hashTypedData, parseAbi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { NaryxClient, NaryxApiError, nativeCashAccountKey, nativeCashAccountTransaction, nativeCashMatchTransaction,
  reviewNativeCashMarket, reviewNativeCashAccount, reviewNativeCashQuote, type NativeCashMarket,
  type NativeCashAccount, type NativeCashSignedQuote, type NativeCashQuoteRequest } from '../src/index.js';

const maker = privateKeyToAccount(`0x${'01'.repeat(32)}`), owner = privateKeyToAccount(`0x${'02'.repeat(32)}`);
const hash = 'ab'.repeat(32), house = '0x1111111111111111111111111111111111111111';
const token = '0x2222222222222222222222222222222222222222', controller = '0x3333333333333333333333333333333333333333';
const policy = nativeClearingPolicy({ version: 1, environment: 'testnet', clearingDomainId: 'cash-test', executionClassId: 'native-cash-range-v1',
  matchingPolicyHash: hash, strategySeries: versionedManifestRef('series', 1, hash), riskDomainId: 'risk',
  markSource: versionedManifestRef('source', 1, hash), markAuthorityId: controller, accountingAsset: assetRef('test-usdc', hash, 6),
  packageQuantityIncrementAtoms: 1n, priceTickQuoteAtoms: 1n, initialMarginQuoteAtomsPerIncrement: 4_000_001n,
  maintenanceMarginQuoteAtomsPerIncrement: 4_000_001n, maximumPositionAtoms: 5n, maximumOpenInterestAtoms: 5n,
  maximumDefaultTransferDiscountBps: 500n, markMaximumStalenessMs: 300_000n });
const market: NativeCashMarket = { marketId: 'cash-test', kind: 'EVM_NATIVE_CASH_RANGE_V1', environment: 'testnet',
  settlement: 'NATIVE_CASH_ONLY', createsExternalPositions: false, reference: {}, binding: {
    kind: 'EVM_NATIVE_CASH_RANGE_V1', marketId: 'cash-test', domain: domainRef('eip155:84532', 1, hash),
    controller, controllerCodeHash: `0x${hash}`, clearingHouse: house, clearingHouseCodeHash: `0x${hash}`,
    collateralToken: token, collateralTokenCodeHash: `0x${hash}`, policy, maximumPriceTicks: 4_000_001n,
    makerAccountId: 'maker', makerOwner: maker.address } };
const accountId = 'user';
const account: NativeCashAccount = { version: 1, marketId: market.marketId, owner: owner.address, accountId,
  onchainAccountId: nativeCashAccountKey(market, accountId), chainId: 84532, clearingHouse: house, collateralToken: token,
  decimals: 6, opened: true, collateralQuoteAtoms: 10_000_000n, cashBalanceQuoteAtoms: 0n, positionAtoms: 0n, sequence: 1n,
  walletBalanceAtoms: 10_000_000n, allowanceAtoms: 10_000_000n, markPriceTicks: 1_500_000n, markValidUntil: 1300n,
  block: { number: 100n, hash: `0x${hash}`, timestamp: 1000n } };
const request: NativeCashQuoteRequest = { requestId: 'test-request', marketId: market.marketId, owner: owner.address, accountId, side: 'BUY', quantityAtoms: 1n };

async function signedQuote(side: 'BUY' | 'SELL' = 'BUY'): Promise<NativeCashSignedQuote> {
  const ownerId = nativeCashAccountKey(market, accountId), makerId = nativeCashAccountKey(market, 'maker');
  const match = { authorizationHash: `0x${'cd'.repeat(32)}` as Hex, longAccountId: side === 'BUY' ? ownerId : makerId,
    shortAccountId: side === 'BUY' ? makerId : ownerId, feePayerAccountId: ownerId, longSequence: 1n, shortSequence: 1n,
    quantityAtoms: 1n, priceTicks: 1_500_000n, maxFeeBps: 0, expiry: 1020n };
  const types = { NativeMatch: [{ name: 'policyHash', type: 'bytes32' }, { name: 'authorizationHash', type: 'bytes32' },
    { name: 'longAccountId', type: 'bytes32' }, { name: 'shortAccountId', type: 'bytes32' }, { name: 'feePayerAccountId', type: 'bytes32' },
    { name: 'longSequence', type: 'uint64' }, { name: 'shortSequence', type: 'uint64' }, { name: 'quantityAtoms', type: 'uint128' },
    { name: 'priceTicks', type: 'uint128' }, { name: 'maxFeeBps', type: 'uint16' }, { name: 'expiry', type: 'uint64' }] } as const;
  const typedData = { domain: { name: 'Naryx Native Package Clearing', version: '1', chainId: 84532, verifyingContract: house as Hex },
    types, primaryType: 'NativeMatch' as const, message: { policyHash: `0x${toHex(policy.policyHash)}` as Hex, ...match } };
  return { version: 1, requestId: request.requestId, makerSignature: await maker.signTypedData(typedData), quote: {
    version: 1, kind: market.kind, marketId: market.marketId, environment: 'testnet', domain: market.binding.domain,
    guarantee: 'OWNER_SIGNED_NATIVE_CASH_MATCH', quoteMode: 'EXECUTION_COMMITMENT', chainId: 84532, clearingHouse: house,
    makerOwner: maker.address, owner: owner.address, side, reducingOnly: false, priceTicks: match.priceTicks,
    referencePriceTicks: match.priceTicks, maximumPriceTicks: 4_000_001n, match, typedData, digest: hashTypedData(typedData) } };
}

test('native cash funding encodes exact approvals and refuses unsafe withdrawals, oversized amounts and owner substitutions', () => {
  reviewNativeCashMarket(market);
  reviewNativeCashAccount(account, market, owner.address, accountId);
  const approval = nativeCashAccountTransaction(market, account, 'approve', 5_000_000n);
  assert.equal(approval.to, token);
  assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: approval.data }).args, [house, 5_000_000n]);
  assert.throws(() => nativeCashAccountTransaction(market, account, 'deposit', 100_000_001n), /does not match/);
  assert.throws(() => nativeCashAccountTransaction(market, account, 'deposit', 0n), /does not match/);
  assert.throws(() => nativeCashAccountTransaction(market, { ...account, cashBalanceQuoteAtoms: -1n }, 'withdraw', 10_000_000n), /does not match/);
  assert.throws(() => nativeCashAccountTransaction(market, { ...account, positionAtoms: 1n }, 'withdraw', 1n), /does not match/);
  assert.throws(() => nativeCashAccountTransaction(market, account, 'unknown' as never), /does not match/);
  assert.throws(() => reviewNativeCashAccount(account, market, maker.address, accountId), /does not match/);
  assert.throws(() => reviewNativeCashMarket({ ...market, binding: { ...market.binding, domain: domainRef('eip155:1', 1, hash) } }), /does not match/);
  assert.throws(() => reviewNativeCashAccount({ ...account, opened: false }, market, owner.address, accountId), /does not match/);
});

test('owner and maker signatures bind the exact cash market, terms, side, fee and deadline', async () => {
  for (const side of ['BUY', 'SELL'] as const) {
    const signed = await signedQuote(side);
    const reviewed = await reviewNativeCashQuote(signed, market, { ...request, side }, 1000n);
    const ownerSignature = await owner.signTypedData(reviewed.quote.typedData);
    const tx = await nativeCashMatchTransaction(reviewed, ownerSignature, 1001n);
    const abi = parseAbi(['function executeMatch((bytes32 authorizationHash,bytes32 longAccountId,bytes32 shortAccountId,bytes32 feePayerAccountId,uint64 longSequence,uint64 shortSequence,uint128 quantityAtoms,uint128 priceTicks,uint16 maxFeeBps,uint64 expiry),bytes,bytes)']);
    const decoded = decodeFunctionData({ abi, data: tx.data });
    assert.equal(decoded.args[side === 'BUY' ? 1 : 2], ownerSignature);
    await assert.rejects(nativeCashMatchTransaction(reviewed, ownerSignature, 1020n), /does not match/);
    await assert.rejects(nativeCashMatchTransaction(reviewed, signed.makerSignature, 1001n), /does not match/);
    await assert.rejects(reviewNativeCashQuote(signed, market, { ...request, side, quantityAtoms: 2n }, 1000n), /does not match/);
    await assert.rejects(reviewNativeCashQuote({ ...signed, quote: { ...signed.quote, match: { ...signed.quote.match, maxFeeBps: 1 } } }, market, { ...request, side }, 1000n), /does not match/);
    await assert.rejects(reviewNativeCashQuote(signed, market, { ...request, side, accountId: 'someone-else' }, 1000n), /does not match/);
  }
});

test('native cash client uses public account and quote routes and translates string service errors', async () => {
  const calls: { path: string; method: string; body?: string }[] = [];
  const client = new NaryxClient({ baseUrl: 'https://api.example', fetch: async (url, init) => {
    calls.push({ path: url, ...init });
    const value = url.endsWith('/markets') ? { version: 1, markets: [market] }
      : url.endsWith('/account') ? { version: 1, result: account } : { error: 'Temporarily unavailable.' };
    return { status: url.endsWith('/quotes') ? 409 : 200, headers: { get: () => 'application/json' }, text: async () => stringifyProtocolJson(value) };
  } });
  const [m] = await client.getNativeCashMarkets();
  assert.equal(m?.marketId, market.marketId);
  assert.equal((await client.getNativeCashAccount(m!, owner.address, accountId)).collateralQuoteAtoms, 10_000_000n);
  assert.equal(calls[1]?.method, 'POST');
  await assert.rejects(client.requestNativeCashQuote(m!, request), (e: unknown) => e instanceof NaryxApiError && e.status === 409);
});
