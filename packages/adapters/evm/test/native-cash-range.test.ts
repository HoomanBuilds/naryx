import assert from 'node:assert/strict';
import test from 'node:test';
import { assetRef, domainRef, nativeClearingPolicy, toHex, versionedManifestRef } from '@naryx/protocol-types';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, getAddress, hashTypedData, keccak256, parseAbi, type Address, type Hex, type TransactionReceipt } from 'viem';
import { EvmNativeCashRangeAdapter, type EvmNativeCashRangeBinding, type EvmNativeCashRangeReadPort } from '../src/native-cash-range.js';
import { NATIVE_CASH_HOUSE_ABI, nativeCashContractAuthorization } from '../src/native-cash-range.js';
import { observeNativeCashMatch } from '../src/native-cash-observation.js';
import type { EvmNativeClearingTransitionReadPort } from '../src/native-clearing-transition.js';
import { evmNativeClearingAccountId } from '../src/native-clearing-backing.js';

const address = (digit: string) => getAddress(`0x${digit.repeat(40)}`);
const controller = address('1'), house = address('2'), token = address('3'), maker = address('4'), owner = address('5');
const hash = 'ab'.repeat(32);
const asset = assetRef('test-usdc', hash, 6);
const policy = nativeClearingPolicy({ version: 1, environment: 'testnet', clearingDomainId: 'native-cash-range-test',
  executionClassId: 'native-cash-range-v1', matchingPolicyHash: hash,
  strategySeries: versionedManifestRef('range-series', 1, hash), riskDomainId: 'range-risk',
  markSource: versionedManifestRef('range-oracle-source', 1, hash), markAuthorityId: controller,
  accountingAsset: asset, packageQuantityIncrementAtoms: 1n, priceTickQuoteAtoms: 1n,
  initialMarginQuoteAtomsPerIncrement: 1_000_001n, maintenanceMarginQuoteAtomsPerIncrement: 1_000_001n,
  maximumPositionAtoms: 5n, maximumOpenInterestAtoms: 10n, maximumDefaultTransferDiscountBps: 500n,
  markMaximumStalenessMs: 600_000n });
const binding: EvmNativeCashRangeBinding = { kind: 'EVM_NATIVE_CASH_RANGE_V1', marketId: 'native-eth-range',
  domain: domainRef('eip155:84532', 1, hash), controller, controllerCodeHash: keccak256('0x01'),
  clearingHouse: house, clearingHouseCodeHash: keccak256('0x01'), collateralToken: token,
  collateralTokenCodeHash: keccak256('0x01'), collateralAsset: asset, maximumPriceTicks: 1_000_001n,
  policy, makerAccountId: 'range-maker', makerOwner: maker };
const input = { owner, accountId: 'range-trader', side: 'BUY' as const, quantityAtoms: 1n,
  authorizationHash: `0x${'cd'.repeat(32)}` as Hex, nowSeconds: 1000n, lifetimeSeconds: 20n, spreadBps: 10 };

function fixture() {
  const makerId = evmNativeClearingAccountId(`0x${toHex(policy.policyHash)}`, binding.makerAccountId);
  const values = new Map<string, unknown>([
    ['clearingHouse', house], ['maximumPriceTicks', 1_000_001n], ['previewMark', [500_001n, 1n, 990n, 1600n]],
    ['policyHash', `0x${toHex(policy.policyHash)}`], ['markAuthority', controller], ['collateralToken', token],
    ['feeBps', 0], ['entryPaused', false], ['currentMark', [`0x${hash}`, 500_001n, 1n, 990n, 1600n]],
    ['openInterestAtoms', 0n], ['recoveryReserveQuoteAtoms', 1_000_000n], ['balanceOf', 5_000_000n], ['decimals', 6],
  ]);
  let chainId = 84532n;
  const reads: EvmNativeCashRangeReadPort = {
    chainId: async () => chainId, head: async () => ({ number: 10n, hash: `0x${hash}`, timestamp: 1000n }),
    code: async () => '0x01', read: async (read, block) => {
      assert.equal(block, 10n);
      if (read.functionName === 'account') return [read.args?.[0] === makerId ? maker : owner, 2_000_000n, 0n, 0n, 1n];
      assert.ok(values.has(read.functionName)); return values.get(read.functionName);
    },
  };
  return { values, reads, setChain: (value: bigint) => { chainId = value; } };
}

test('native cash quotes bind exact owner sequences and fully funded contract state', async () => {
  const f = fixture();
  const adapter = new EvmNativeCashRangeAdapter(binding, f.reads);
  const quote = await adapter.quote(input);
  assert.equal(quote.priceTicks, 500_502n);
  assert.equal(quote.digest, hashTypedData(quote.typedData));
  assert.equal(quote.typedData.domain.chainId, 84532);
  assert.equal(quote.match.expiry, 1020n);
  assert.equal(quote.match.longSequence, 1n); assert.equal(quote.match.shortSequence, 1n);
  assert.equal(quote.quoteMode, 'EXECUTION_COMMITMENT');
  const sell = await adapter.quote({ ...input, side: 'SELL' });
  assert.equal(sell.priceTicks, 499_500n);
  assert.equal(quote.match.longAccountId, sell.match.shortAccountId);
  assert.equal(quote.match.shortAccountId, sell.match.longAccountId);
});

test('standing maker books pin their contract identity and use exact ERC1271 match authorizations', async () => {
  const f = fixture();
  const smart = { ...binding, makerAuthorization: { kind: 'ERC1271_NATIVE_CASH_STANDING_V1' as const, codeHash: keccak256('0x01') } };
  f.values.set('controller', controller);
  f.values.set('makerAccountId', evmNativeClearingAccountId(`0x${toHex(policy.policyHash)}`, binding.makerAccountId));
  f.values.set('spreadBps', 10);
  f.values.set('book', [499_500n, 500_502n, 1n, 1n, 1600n]);
  f.values.set('isValidSignature', '0x1626ba7e');
  const adapter = new EvmNativeCashRangeAdapter(smart, f.reads);
  const book = await adapter.standingBook(); assert.equal(book.bidQuantity, 1n);
  const q = await adapter.quote(input);
  assert.equal(await adapter.verifyMakerSignature(q, nativeCashContractAuthorization(q)), true);
  assert.equal(await adapter.verifyMakerSignature(q, '0x00'), false);
  f.values.set('controller', address('9'));
  await assert.rejects(adapter.standingBook(), /binding differs/);
});

test('native account reads bind owner, policy, collateral and testnet identity without depending on live marks', async () => {
  const f = fixture(); f.values.set('allowance', 100n);
  const adapter = new EvmNativeCashRangeAdapter(binding, f.reads);
  const account = await adapter.account(owner, 'range-trader');
  assert.equal(account.opened, true);
  assert.equal(account.allowanceAtoms, 100n);
  assert.equal(account.onchainAccountId, evmNativeClearingAccountId(`0x${toHex(policy.policyHash)}`, 'range-trader'));
  await assert.rejects(adapter.account(address('6'), 'range-trader'), /belongs to another owner/);
  await assert.rejects(adapter.account(owner, binding.makerAccountId), /maker account/);
  f.values.set('policyHash', `0x${'cc'.repeat(32)}`);
  await assert.rejects(adapter.account(owner, 'range-trader'), /policy or collateral/);
  f.setChain(1n);
  await assert.rejects(adapter.account(owner, 'range-trader'), /RPC chain identity/);
  const unopened = fixture(); unopened.values.set('allowance', 0n);
  const original = unopened.reads.read;
  unopened.reads.read = async (read, block) => read.functionName === 'account'
    ? ['0x0000000000000000000000000000000000000000', 0n, 0n, 0n, 0n] : original(read, block);
  assert.equal((await new EvmNativeCashRangeAdapter(binding, unopened.reads).account(owner, 'new-user')).opened, false);
});

test('unfunded, expired, stale, paused and changed cash market state refuse quotes', async () => {
  for (const [key, value] of [
    ['balanceOf', 1n], ['previewMark', [500_002n, 1n, 990n, 1600n]],
    ['currentMark', [`0x${hash}`, 500_001n, 1n, 900n, 1000n]],
    ['entryPaused', true], ['feeBps', 1], ['clearingHouse', address('9')],
  ] as const) {
    const f = fixture(); f.values.set(key, value);
    await assert.rejects(new EvmNativeCashRangeAdapter(binding, f.reads).quote(input), /Native cash quote refused/);
  }
  const f = fixture(); f.setChain(1n);
  await assert.rejects(new EvmNativeCashRangeAdapter(binding, f.reads).quote(input), /RPC chain identity/);
  await assert.rejects(new EvmNativeCashRangeAdapter(binding, fixture().reads).quote({ ...input, quantityAtoms: 2n }), /initial margin/);
  await assert.rejects(new EvmNativeCashRangeAdapter(binding, fixture().reads).quote({ ...input, owner: maker }), /bounds are invalid/);
});

test('range endpoints stay bounded and a replacement runtime cannot masquerade as the recognized class', async () => {
  for (const price of [1n, 1_000_001n]) {
    const f = fixture(); f.values.set('previewMark', [price, 1n, 990n, 1600n]);
    f.values.set('currentMark', [`0x${hash}`, price, 1n, 990n, 1600n]);
    const adapter = new EvmNativeCashRangeAdapter(binding, f.reads);
    for (const side of ['BUY', 'SELL'] as const) {
      const quote = await adapter.quote({ ...input, side });
      assert.ok(quote.priceTicks >= 1n && quote.priceTicks <= binding.maximumPriceTicks);
    }
  }
  assert.throws(() => new EvmNativeCashRangeAdapter({ ...binding, kind: 'OTHER' as never }, fixture().reads), /recognized Sepolia/);
  const f = fixture(); f.reads.code = async (_address: Address) => '0x02';
  await assert.rejects(new EvmNativeCashRangeAdapter(binding, f.reads).quote(input), /contract code differs/);
});

test('cash settlement records only exact finalized owner matches and rejects replays of different terms', async () => {
  const f = fixture();
  const quote = await new EvmNativeCashRangeAdapter(binding, f.reads).quote(input);
  const tx = `0x${'ef'.repeat(32)}` as Hex;
  const abi = parseAbi(['event PackageMatched(bytes32 indexed authorizationHash,bytes32 indexed longAccountId,bytes32 indexed shortAccountId,uint128 quantityAtoms,uint128 priceTicks,uint256 feeAtoms)']);
  const log = { address: house, blockNumber: 12n, blockHash: `0x${hash}`, transactionHash: tx, transactionIndex: 0,
    logIndex: 0, removed: false, topics: encodeEventTopics({ abi, eventName: 'PackageMatched', args: {
      authorizationHash: quote.match.authorizationHash, longAccountId: quote.match.longAccountId, shortAccountId: quote.match.shortAccountId } }),
    data: encodeAbiParameters([{ type: 'uint128' }, { type: 'uint128' }, { type: 'uint256' }], [1n, quote.priceTicks, 0n]) } as TransactionReceipt['logs'][number];
  const transaction = { hash: tx, from: owner, to: house, value: 0n, blockNumber: 12n, blockHash: `0x${hash}` as Hex,
    input: encodeFunctionData({ abi: NATIVE_CASH_HOUSE_ABI, functionName: 'executeMatch', args: [quote.match, '0x11', '0x22'] }) };
  const reads: EvmNativeClearingTransitionReadPort = { ...f.reads,
    finalizedBlock: async () => ({ number: 12n, hash: `0x${hash}` }), blockHash: async () => `0x${hash}`,
    timestamp: async () => 1010n, clearingLogs: async () => [log], transaction: async () => transaction,
    receipt: async () => ({ transactionHash: tx, status: 'success', blockNumber: 12n, blockHash: `0x${hash}`, logs: [log] }),
    read: async request => request.functionName === 'consumedAuthorization' ? true : request.functionName === 'matchDigest' ? quote.digest
      : [request.args?.[0] === quote.match.longAccountId ? owner : maker, 2_000_000n, 0n, 1n, 2n],
  };
  const receipt = await observeNativeCashMatch(binding, reads, quote, tx);
  assert.equal(receipt.evidenceGrade, 'FINALIZED_CONTRACT_RECEIPT');
  assert.equal(receipt.authorizationHash, quote.match.authorizationHash);
  assert.equal(receipt.quantityAtoms, 1n);
  for (const variant of [
    { finalizedBlock: async () => ({ number: 11n, hash: `0x${hash}` as Hex }) },
    { blockHash: async () => `0x${'99'.repeat(32)}` as Hex },
    { timestamp: async () => quote.match.expiry },
    { transaction: async () => ({ ...transaction, to: token }) },
    { read: async (request: Parameters<typeof reads.read>[0], block: bigint) => request.functionName === 'consumedAuthorization' ? false : reads.read(request, block) },
    { chainId: async () => 1n },
  ]) await assert.rejects(observeNativeCashMatch(binding, { ...reads, ...variant }, quote, tx));
  await assert.rejects(observeNativeCashMatch(binding, reads, { ...quote, match: { ...quote.match, quantityAtoms: 2n } }, tx));
  await assert.rejects(observeNativeCashMatch({ ...binding, makerOwner: owner }, reads, quote, tx));
  await assert.rejects(observeNativeCashMatch({ ...binding, makerAccountId: 'different-maker-account' }, reads, quote, tx));
  await assert.rejects(observeNativeCashMatch(binding, reads, { ...quote, maximumPriceTicks: quote.maximumPriceTicks + 1n }, tx));
});
