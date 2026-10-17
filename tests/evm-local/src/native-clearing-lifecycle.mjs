import assert from 'node:assert/strict';
import { encodeFunctionData, getAddress, hashTypedData, keccak256, parseAbi } from 'viem';
import {
  applyNativeClearingMatch, nativeClearingCollateralAuthorization, nativeClearingExecutionId, nativeClearingMarkObservation,
  nativeClearingMatchAuthorization,
  parseProtocolJson, resolveNativeClearingDefault, strategyPackageOrder, stringifyProtocolJson, toHex,
} from '@naryx/protocol-types';
import { evmNativeClearingAccountId, evmNativeClearingAuctionId } from '@naryx/adapter-evm';

const factoryAbi = parseAbi(['function accountOf(address) view returns(address)', 'function create(address) returns(address)']);
const matchTypes = { NativeMatch: [
  { name: 'policyHash', type: 'bytes32' }, { name: 'authorizationHash', type: 'bytes32' },
  { name: 'longAccountId', type: 'bytes32' }, { name: 'shortAccountId', type: 'bytes32' },
  { name: 'feePayerAccountId', type: 'bytes32' }, { name: 'longSequence', type: 'uint64' },
  { name: 'shortSequence', type: 'uint64' }, { name: 'quantityAtoms', type: 'uint128' },
  { name: 'priceTicks', type: 'uint128' }, { name: 'maxFeeBps', type: 'uint16' }, { name: 'expiry', type: 'uint64' },
] };

export function clearingMatchTypedData(record, authorization, long, short) {
  const policyHash = `0x${toHex(record.policy.policyHash)}`;
  const longAccountId = evmNativeClearingAccountId(policyHash, long.accountId);
  return { domain: { name: 'Naryx Native Package Clearing', version: '1', chainId: record.chainId, verifyingContract: record.house },
    types: matchTypes, primaryType: 'NativeMatch', message: { policyHash,
      authorizationHash: `0x${toHex(authorization.authorizationHash)}`, longAccountId,
      shortAccountId: evmNativeClearingAccountId(policyHash, short.accountId), feePayerAccountId: longAccountId,
      longSequence: long.sequence, shortSequence: short.sequence, quantityAtoms: authorization.quantityAtoms,
      priceTicks: authorization.priceTicks, maxFeeBps: 0, expiry: authorization.validUntilValue } };
}

export async function runClearingLifecycle({ record, save, client, wallet, send, roles, artifact, release, adminUrl, reconcile, cashout = false }) {
  const origin = new URL(adminUrl);
  assert.ok(origin.protocol === 'http:' && origin.hostname === '127.0.0.1' && origin.pathname === '/', 'Loopback API only');
  assert.ok(record.reconciledAtMs, 'Reconcile funding before trading');
  assert.ok([84532, 421614].includes(await client.getChainId()), 'Sepolia only');
  const request = async (path, body) => {
    const response = await fetch(new URL(path, origin), body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: stringifyProtocolJson(body),
    });
    const value = parseProtocolJson(await response.text());
    assert.ok(response.ok, `${path}: ${response.status} ${value.error?.code ?? value.code ?? 'rejected'} ${value.error?.message ?? ''}`);
    return value;
  };
  const policy = record.policy;
  const policyHash = `0x${toHex(policy.policyHash)}`;
  const domainPath = `/v1/native-clearing/domains/${policy.clearingDomainId}`;
  const accountId = (role) => `${policy.clearingDomainId}-${role}`;
  const idOnchain = (role) => evmNativeClearingAccountId(policyHash, accountId(role));
  const call = (functionName, args) => ({ to: record.house, data: encodeFunctionData({ abi: artifact.abi, functionName, args }) });
  const now = async () => (await client.getBlock()).timestamp;
  if (!record.lifecycle) {
    assert.equal(reconcile, false, 'Execute lifecycle before reconciliation');
    const domain = await request(domainPath);
    const accounts = [];
    for (const role of ['trader', 'maker', 'backstop']) {
      const account = (await request(`/v1/native-clearing/accounts/${accountId(role)}`)).account;
      assert.equal(account.positionAtoms, 0n);
      assert.equal(account.cashBalanceQuoteAtoms, 0n);
      assert.equal(account.sequence, 1n);
      accounts.push(account);
    }
    record.lifecycle = { initialState: domain.state, initialAccounts: accounts, createdAtMs: BigInt(Date.now()),
      expiry: await now() + 3300n, nonce: BigInt(Date.now()), packages: {}, marks: {}, observations: [] };
    save();
  }
  const flow = record.lifecycle;
  if (cashout) {
    assert.ok(flow.completedAtMs, 'Complete the matched lifecycle before withdrawing');
    assert.equal(await client.readContract({ address: record.house, abi: artifact.abi, functionName: 'entryPaused' }), true);
    const before = await client.readContract({ address: record.house, abi: artifact.abi, functionName: 'account', args: [idOnchain('trader')] });
    assert.equal(before.positionAtoms, 0n);
    if (!flow.withdrawalAtoms) {
      flow.withdrawalAtoms = before.collateralQuoteAtoms + before.cashBalanceQuoteAtoms;
      assert.equal(flow.withdrawalAtoms, 6_020_000n);
      save();
    }
    await send('lifecycle-normalize-trader', roles.trader, call('normalizeFlatAccount', [idOnchain('trader')]));
    await send('lifecycle-withdraw-trader', roles.trader, call('withdraw', [idOnchain('trader'), flow.withdrawalAtoms]));
    const after = await client.readContract({ address: record.house, abi: artifact.abi, functionName: 'account', args: [idOnchain('trader')] });
    assert.equal(after.collateralQuoteAtoms, 0n);
    assert.equal(after.cashBalanceQuoteAtoms, 0n);
    flow.cashoutAtMs = BigInt(Date.now());
    save();
    console.log(JSON.stringify({ network: record.chainId, returnedToOwnerTestUSDC: '6.02', pendingFinality: true }));
    return;
  }
  const legacy = flow.packages.entry?.packages?.maker;
  if (legacy && legacy.order.minimumQuantity !== record.matchingPolicy.minimumExecutionQuantity) {
    assert.ok(!record.transactions['lifecycle-entry'], 'A submitted native match cannot be replaced');
    for (const item of Object.values(flow.packages.entry.packages)) {
      const result = await fetch(new URL(`/v1/allocations/${item.order.orderId}`, origin));
      assert.equal(result.status, 404, 'An allocated package cannot be replaced');
    }
    flow.rejectedDrafts ??= [];
    flow.rejectedDrafts.push(flow.packages.entry);
    delete flow.packages.entry;
    flow.nonce += 100n;
    save();
  }
  const account = (accounts, role) => accounts.find((item) => item.accountId === accountId(role));
  if (reconcile) {
    assert.ok(record.transactions['lifecycle-exit'], 'Complete onchain recovery and exit first');
    const final = await client.getBlock({ blockTag: 'finalized' });
    const required = record.transactions['lifecycle-withdraw-trader'] ?? record.transactions['lifecycle-exit'];
    assert.ok(final.number >= required.blockNumber,
      `Waiting for finality ${final.number}/${required.blockNumber}`);
    for (const stage of ['entry', 'recovery', 'exit']) {
      const transaction = record.transactions[`lifecycle-${stage}`];
      const receipt = await client.getTransactionReceipt({ hash: transaction.hash });
      const block = await client.getBlock({ blockNumber: receipt.blockNumber });
      assert.equal(receipt.status, 'success');
      assert.equal(receipt.blockHash, block.hash);
      assert.ok(receipt.blockNumber <= final.number);
      const mark = stage === 'entry' ? flow.marks.entry : flow.marks.fault;
      const stored = await request(`${domainPath}/mark`);
      if (stored.observation.sourceSequence < mark.observation.sourceSequence) {
        const previous = await client.getBlock({ blockNumber: receipt.blockNumber - 1n });
        await request('/internal/native-clearing/marks', { clearingDomainId: policy.clearingDomainId, ...mark,
          evidenceBlock: { number: previous.number, hash: previous.hash } });
      }
      const result = await request(`/internal/native-clearing/${stage === 'recovery' ? 'recovery' : 'match'}-observations`, {
        clearingDomainId: policy.clearingDomainId, transactionHash: transaction.hash,
        ...(stage === 'recovery' ? { auctionId: flow.auctionId } : { authorization: flow.packages[stage].authorization }),
      });
      flow.observations.push({ stage, transactionHash: transaction.hash, receipt: result.receipt });
      save();
    }
    if (flow.cashoutAtMs) {
      await request('/internal/native-clearing/normalization-observations', { clearingDomainId: policy.clearingDomainId,
        accountId: accountId('trader'), transactionHash: record.transactions['lifecycle-normalize-trader'].hash });
      const current = (await request(`/v1/native-clearing/accounts/${accountId('trader')}`)).account;
      if (current.collateralQuoteAtoms !== 0n) {
        const authorization = nativeClearingCollateralAuthorization({ version: 1, policyHash: policy.policyHash,
          accountId: current.accountId, ownerId: current.ownerId, expectedAccountHash: current.accountHash,
          expectedAccountSequence: current.sequence, collateralDeltaQuoteAtoms: -flow.withdrawalAtoms,
          validUntilUnit: 'EVM_UNIX_SECONDS', validUntilValue: await now() + 3600n });
        const receipt = await client.getTransactionReceipt({ hash: record.transactions['lifecycle-withdraw-trader'].hash });
        const block = await client.getBlock({ blockNumber: receipt.blockNumber });
        assert.equal(receipt.status, 'success');
        assert.equal(receipt.blockHash, block.hash);
        await request('/internal/native-clearing/collateral', { authorization,
          ownerSignature: { scheme: 'EIP191_SECP256K1', signature: await wallet(roles.trader).signMessage({ message: { raw: authorization.authorizationHash } }) },
          evidenceBlock: { number: block.number, hash: block.hash } });
      }
    }
    const backing = (await request(`${domainPath}/backing`)).backing;
    assert.equal((await request(domainPath)).state.openInterestAtoms, 0n);
    assert.equal(backing.entryPaused, true);
    flow.reconciledAtMs = BigInt(Date.now());
    save();
    console.log(JSON.stringify({ network: record.chainId, lifecycle: 'ENTRY_DEFAULT_RECOVERY_EXIT', finalized: true,
      clearingHouse: record.house, observations: flow.observations.length }));
    return;
  }
  assert.ok(await now() < flow.expiry - 120n, 'Lifecycle authorization window expired; do not replace a signed checkpoint');
  const factory = release.contracts.accountFactory;
  assert.equal(getAddress(record.profile.accountFactory), getAddress(factory.address));
  assert.equal(keccak256(await client.getCode({ address: factory.address })), factory.runtimeCodeHash);
  for (const role of ['trader', 'maker', 'backstop']) {
    const externalAccount = await client.readContract({ address: factory.address, abi: factoryAbi, functionName: 'accountOf', args: [record.actors[role]] });
    if (!(await client.getCode({ address: externalAccount })) || record.transactions[`lifecycle-account-${role}`]) {
      await send(`lifecycle-account-${role}`, roles.operator, { to: factory.address,
        data: encodeFunctionData({ abi: factoryAbi, functionName: 'create', args: [record.actors[role]] }) });
    }
  }
  const publish = async (key, priceTicks) => {
    if (!flow.marks[key]) {
      const onchain = await client.readContract({ address: record.house, abi: artifact.abi, functionName: 'currentMark' });
      const observedAtMs = await now() * 1000n;
      const observation = nativeClearingMarkObservation({ version: 1, policyHash: policy.policyHash, source: policy.markSource,
        authorityId: policy.markAuthorityId, sourceSequence: onchain[2] + 1n,
        priceTicks, observedAtMs, validUntilMs: observedAtMs + policy.markMaximumStalenessMs }, policy);
      flow.marks[key] = { observation, authorization: { scheme: 'EIP191_SECP256K1',
        signature: await wallet(roles.mark).signMessage({ message: { raw: observation.observationHash } }) } };
      save();
    }
    const mark = flow.marks[key].observation;
    await send(`lifecycle-mark-${key}`, roles.mark, call('publishMark', [
      `0x${toHex(mark.observationHash)}`, mark.priceTicks, mark.sourceSequence, mark.validUntilMs / 1000n,
    ]));
  };
  const prepare = async (key, takerRole, makerRole, side, priceTicks, accounts) => {
    if (flow.packages[key]) return flow.packages[key];
    const packages = {};
    for (const [index, role] of [makerRole, takerRole].entries()) {
      const created = await request('/internal/terminal/evm-option-spread-orders/create', {
        profileId: record.profile.profileId, owner: record.actors[role].toLowerCase(), lifecycleAction: 'ENTRY',
        quantityAtoms: '100000000000000000', limitPremiums: [
          { legId: 'option-long', quoteAtoms: '7', baseAtoms: '1000000000000000' },
          { legId: 'option-short', quoteAtoms: '3', baseAtoms: '1000000000000000' },
        ], expiryValue: flow.expiry.toString(), nonce: (flow.nonce + BigInt((key === 'exit' ? 2 : 0) + index)).toString(),
      });
      assert.ok(created.order && created.graph, 'API must return the exact admitted order and graph');
      let orderHash = created.orderHash;
      if (index === 0) {
        const resting = strategyPackageOrder({ ...created.order, packageOrderType: 'LIMIT', packageTimeInForce: 'GTD' });
        orderHash = (await request('/v1/strategy-orders', { order: resting, graph: created.graph })).orderHashHex;
      }
      const prepared = await request('/v1/package-book/orders/prepare', {
        strategyOrderHash: orderHash, side: index === 0 ? (side === 'BID' ? 'ASK' : 'BID') : side,
        limitPriceTicks: priceTicks.toString(),
      });
      const order = prepared.order;
      const settlementCommitment = prepared.settlementCommitment;
      const authorization = await request('/v1/package-book/orders/authorization', { order, settlementCommitment });
      assert.equal(authorization.scheme, 'EIP712_SECP256K1');
      const signature = await wallet(roles[role]).signTypedData(authorization.typedData);
      packages[role] = { order, settlementCommitment, graph: created.graph, signature };
    }
    const entry = { takerRole, makerRole, packages };
    flow.packages[key] = entry;
    save();
    return entry;
  };
  const execute = async (key, takerRole, makerRole, side, priceTicks, accounts) => {
    const entry = await prepare(key, takerRole, makerRole, side, priceTicks, accounts);
    for (const role of [makerRole, takerRole]) {
      const item = entry.packages[role];
      const result = await request('/v1/package-book/orders', { order: item.order, settlementCommitment: item.settlementCommitment,
        authorization: { scheme: 'EIP712_SECP256K1', signature: item.signature } });
      if (role === takerRole) {
        assert.equal(result.allocation.fills.length, 1, 'Expected one isolated consenting counterparty');
        assert.equal(toHex(result.allocation.fills[0].makerEntryId), entry.packages[makerRole].order.orderId);
        assert.equal(result.allocation.fills[0].quantity, 100_000_000_000_000_000n);
        entry.authorization = { policy, matchingPolicy: record.matchingPolicy,
          allocation: result.allocation, handoff: result.settlementHandoff,
          takerSettlementCommitment: item.settlementCommitment, makerSettlementCommitment: entry.packages[makerRole].settlementCommitment,
          takerGraph: item.graph, makerGraph: entry.packages[makerRole].graph, fillSequence: result.allocation.fills[0].fillSequence,
          takerClearingAccount: account(accounts, takerRole), makerClearingAccount: account(accounts, makerRole) };
        save();
      }
    }
    const authorization = nativeClearingMatchAuthorization({ ...entry.authorization, currentExpiryUnit: 'EVM_UNIX_SECONDS', currentExpiryValue: await now() });
    const long = accounts.find((item) => item.accountId === authorization.longAccountId);
    const short = accounts.find((item) => item.accountId === authorization.shortAccountId);
    const typedData = clearingMatchTypedData(record, authorization, long, short);
    const { policyHash: unused, ...match } = typedData.message;
    assert.equal(await client.readContract({ address: record.house, abi: artifact.abi, functionName: 'matchDigest', args: [match] }), hashTypedData(typedData));
    const roleOf = (owner) => Object.keys(roles).find((role) => record.actors[role].toLowerCase() === owner);
    entry.longSignature ??= await wallet(roles[roleOf(long.ownerId)]).signTypedData(typedData);
    entry.shortSignature ??= await wallet(roles[roleOf(short.ownerId)]).signTypedData(typedData);
    save();
    if (key === 'entry' && !record.transactions['lifecycle-entry']
      && await client.readContract({ address: record.house, abi: artifact.abi, functionName: 'entryPaused' })) {
      flow.enableAttempt = (flow.enableAttempt ?? 0) + 1;
      save();
      await send(`lifecycle-enable-${flow.enableAttempt}`, roles.operator, call('setEntryPaused', [false]));
    }
    await send(`lifecycle-${key}`, roles.operator, call('executeMatch', [match, entry.longSignature, entry.shortSignature]));
    return applyNativeClearingMatch({ policy, domainState: key === 'entry' ? flow.initialState : flow.recovered.state,
      longAccount: long, shortAccount: short, executionId: nativeClearingExecutionId(authorization),
      quantityAtoms: authorization.quantityAtoms, priceTicks, markPriceTicks: priceTicks,
      observedAtMs: flow.marks[key === 'entry' ? 'entry' : 'fault'].observation.observedAtMs, nowMs: await now() * 1000n });
  };
  await publish('entry', 1000n);
  let matched;
  try {
    matched = await execute('entry', 'trader', 'maker', 'BID', 1000n, flow.initialAccounts);
  } finally {
    if (!(await client.readContract({ address: record.house, abi: artifact.abi, functionName: 'entryPaused' }))) {
      await send(`lifecycle-pause-${flow.enableAttempt}`, roles.pauser, call('setEntryPaused', [true]));
    }
  }
  const afterEntry = flow.initialAccounts.map((item) => item.accountId === matched.longAccount.accountId ? matched.longAccount
    : item.accountId === matched.shortAccount.accountId ? matched.shortAccount : item);
  await publish('fault', 51_200n);
  flow.auctionId ??= `${policy.clearingDomainId}-recovery-${flow.nonce}`;
  save();
  const auctionId = evmNativeClearingAuctionId(policyHash, flow.auctionId);
  await send('lifecycle-auction-open', roles.operator, call('openDefaultAuction', [auctionId, idOnchain('maker')]));
  await send('lifecycle-auction-bid', roles.backstop, call('bidDefaultAuction', [auctionId, idOnchain('backstop'), 51_200n,
    flow.marks.fault.observation.validUntilMs / 1000n]));
  const auction = await client.readContract({ address: record.house, abi: artifact.abi, functionName: 'auction', args: [auctionId] });
  while (await now() < auction.closeAt) await new Promise((resolve) => setTimeout(resolve, 5000));
  await send('lifecycle-recovery', roles.operator, call('settleDefaultAuction', [auctionId]));
  const recovery = resolveNativeClearingDefault({ policy, domainState: matched.domainState,
    defaultedAccount: account(afterEntry, 'maker'), backstopAccount: account(afterEntry, 'backstop'),
    resolutionId: flow.auctionId, transferPriceTicks: 51_200n, markPriceTicks: 51_200n,
    observedAtMs: flow.marks.fault.observation.observedAtMs, nowMs: await now() * 1000n });
  assert.equal(recovery.resolution.reserveConsumedQuoteAtoms, 20_000n);
  assert.equal(recovery.resolution.uncoveredDeficitQuoteAtoms, 0n);
  flow.recovered = { state: recovery.domainState, accounts: afterEntry.map((item) => item.accountId === recovery.defaultedAccount.accountId
    ? recovery.defaultedAccount : item.accountId === recovery.backstopAccount.accountId ? recovery.backstopAccount : item) };
  save();
  const exited = await execute('exit', 'trader', 'backstop', 'ASK', 51_200n, flow.recovered.accounts);
  assert.equal(exited.domainState.openInterestAtoms, 0n);
  assert.equal(await client.readContract({ address: record.house, abi: artifact.abi, functionName: 'entryPaused' }), true);
  flow.completedAtMs = BigInt(Date.now());
  save();
  console.log(JSON.stringify({ network: record.chainId, lifecycle: 'ENTRY_DEFAULT_RECOVERY_EXIT', entryPaused: true,
    recoveryReserveConsumedAtoms: '20000', openInterestAtoms: '0', pendingFinality: true }));
}
