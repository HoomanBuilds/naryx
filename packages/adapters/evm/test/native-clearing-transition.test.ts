import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyNativeClearingMatch, assetRef, domainRef, nativeClearingAccount, nativeClearingDomainState, nativeClearingExecutionId,
  nativeClearingMarkObservation, nativeClearingMatchAuthorization, nativeClearingPolicy, packageAllocation, packageAllocationHash,
  packageMatchingPolicy, packageMatchingPolicyHash, packageSettlementCommitment, packageSettlementCommitmentHash,
  packageSettlementHandoff, resolveNativeClearingDefault, normalizeNativeClearingAccount, toHex, versionedManifestRef, protocolId, commitmentHash,
} from '@naryx/protocol-types';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, keccak256, parseAbi, type Hex, type TransactionReceipt } from 'viem';
import { evmNativeClearingAccountId } from '../src/native-clearing-backing.js';
import { EvmNativeClearingTransitionVerifier, evmNativeClearingAuctionId, type EvmNativeClearingTransitionReadPort } from '../src/native-clearing-transition.js';

const hash = '11'.repeat(32);
const blockHash = `0x${'22'.repeat(32)}` as Hex;
const tx = `0x${'33'.repeat(32)}` as Hex;
const house = `0x${'44'.repeat(20)}` as const;
const token = `0x${'55'.repeat(20)}` as const;
const longOwner = `0x${'66'.repeat(20)}` as const;
const shortOwner = `0x${'77'.repeat(20)}` as const;
const code = '0x6000';

function fixture(recovery = false) {
  const matchingPolicy = packageMatchingPolicy({ matchingPolicyVersion: 1, environment: 'testnet', executionClassId: 'native-test',
    allocationRule: 'PRICE_TIME', directVersusImpliedPriority: 'DIRECT_FIRST', selfMatchPolicy: 'CANCEL_INCOMING', commonControlAsSelf: true,
    amendmentPriorityRule: 'RETAIN_ON_SIZE_REDUCTION', quantityIncrement: 10n, minimumExecutionQuantity: 10n, maximumImplicationDepth: 2 });
  const policy = nativeClearingPolicy({ version: 1, clearingDomainId: 'native-test-clearing', environment: 'testnet', executionClassId: 'native-test',
    matchingPolicyHash: packageMatchingPolicyHash(matchingPolicy), strategySeries: versionedManifestRef('test-series', 1, hash), riskDomainId: 'test-risk',
    markSource: versionedManifestRef('test-mark', 1, hash), markAuthorityId: longOwner, accountingAsset: assetRef('test-usdc', hash, 6),
    packageQuantityIncrementAtoms: 10n, priceTickQuoteAtoms: 1n, initialMarginQuoteAtomsPerIncrement: 200n,
    maintenanceMarginQuoteAtomsPerIncrement: 100n, maximumPositionAtoms: 1_000n, maximumOpenInterestAtoms: 10_000n,
    maximumDefaultTransferDiscountBps: 500n, markMaximumStalenessMs: 60_000n });
  const mark = nativeClearingMarkObservation({ version: 1, policyHash: policy.policyHash, source: policy.markSource, authorityId: policy.markAuthorityId,
    sourceSequence: 1n, priceTicks: recovery ? 50n : 1_000n, observedAtMs: 10_000n, validUntilMs: 70_000n }, policy);
  const state = nativeClearingDomainState({ version: 1, policyHash: policy.policyHash, openInterestAtoms: recovery ? 10n : 0n,
    recoveryReserveQuoteAtoms: 300n, sequence: 1n }, policy);
  const long = nativeClearingAccount({ version: 1, policyHash: policy.policyHash, accountId: 'long', ownerId: longOwner, collateralQuoteAtoms: 200n,
    cashBalanceQuoteAtoms: recovery ? -1_000n : 0n, positionAtoms: recovery ? 10n : 0n, sequence: 1n }, policy);
  const short = nativeClearingAccount({ version: 1, policyHash: policy.policyHash, accountId: 'short', ownerId: shortOwner, collateralQuoteAtoms: 5_000n,
    cashBalanceQuoteAtoms: 0n, positionAtoms: 0n, sequence: 1n }, policy);
  const accounts = [long, short];
  const allocation = packageAllocation({ version: 1, environment: protocolId('testnet'), executionClassId: protocolId('native-test'), matchingPolicyHash: packageMatchingPolicyHash(matchingPolicy),
    takerOrderId: commitmentHash(hash), takerParticipantId: protocolId(longOwner), takerCommonControlGroupId: protocolId('long-group'), takerSide: 'BID', takerTimeInForce: 'IOC',
    takerLimitPriceTicks: 1_000n, requestedQuantity: 10n, firstFillSequence: 1n,
    fills: [{ fillSequence: 1n, makerEntryId: commitmentHash('22'.repeat(32)), makerSource: 'DIRECT', makerSequence: 1n, makerParticipantId: protocolId(shortOwner), makerCommonControlGroupId: protocolId('short-group'),
      priceTicks: 1_000n, quantity: 10n, consumedSourceKeys: [] }], restedQuantity: 0n, cancelledQuantity: 0n,
    selfMatchCancelledEntryIds: [], invalidatedEntryIds: [], internalMatchedQuantity: 10n, externalImpliedQuantity: 0n });
  const commitment = (maker: boolean) => packageSettlementCommitment({ version: 1, environment: 'testnet', executionClassId: 'native-test',
    packageOrderId: maker ? allocation.fills[0]!.makerEntryId : allocation.takerOrderId, strategyOrderHash: maker ? '88'.repeat(32) : hash, graphHash: hash,
    participantId: maker ? shortOwner : longOwner, settlementAccount: maker ? short.accountId : long.accountId,
    quantity: 10n, validUntilUnit: 'EVM_UNIX_SECONDS', validUntilValue: 20n });
  const takerSettlementCommitment = commitment(false), makerSettlementCommitment = commitment(true);
  const handoff = packageSettlementHandoff({ version: 1, allocationHash: packageAllocationHash(allocation), executionClassId: 'native-test',
    takerSettlementCommitmentHash: packageSettlementCommitmentHash(takerSettlementCommitment), fills: [{ fillSequence: 1n, makerEntryId: allocation.fills[0]!.makerEntryId,
      makerSource: 'DIRECT', priceTicks: 1_000n, quantity: 10n, makerSettlementCommitmentHash: packageSettlementCommitmentHash(makerSettlementCommitment) }] });
  const authorization = { policy, matchingPolicy, allocation, handoff, takerSettlementCommitment, makerSettlementCommitment, fillSequence: 1n };
  const authorized = nativeClearingMatchAuthorization({ ...authorization, currentExpiryUnit: 'EVM_UNIX_SECONDS', currentExpiryValue: 11n });
  const match = recovery ? undefined : applyNativeClearingMatch({ policy, domainState: state, longAccount: long, shortAccount: short,
    executionId: nativeClearingExecutionId(authorized), quantityAtoms: 10n, priceTicks: 1_000n, markPriceTicks: 1_000n, observedAtMs: 10_000n, nowMs: 11_000n });
  const resolved = recovery ? resolveNativeClearingDefault({ policy, domainState: state, defaultedAccount: long, backstopAccount: short,
    resolutionId: 'default-1', transferPriceTicks: 48n, markPriceTicks: 50n, observedAtMs: 10_000n, nowMs: 11_000n }) : undefined;
  const nextState = resolved?.domainState ?? match!.domainState;
  const nextAccounts = resolved === undefined ? [match!.longAccount, match!.shortAccount] : [resolved.defaultedAccount, resolved.backstopAccount];
  const policyHash = `0x${toHex(policy.policyHash)}` as Hex;
  const abi = parseAbi([recovery
    ? 'event DefaultAuctionSettled(bytes32 indexed auctionId,bytes32 indexed defaultedAccountId,bytes32 indexed backstopAccountId,uint256 reserveConsumed,uint256 uncoveredDeficit)'
    : 'event PackageMatched(bytes32 indexed authorizationHash,bytes32 indexed longAccountId,bytes32 indexed shortAccountId,uint128 quantityAtoms,uint128 priceTicks,uint256 feeAtoms)']);
  const topics = recovery
    ? encodeEventTopics({ abi, eventName: 'DefaultAuctionSettled', args: { auctionId: evmNativeClearingAuctionId(policyHash, 'default-1'), defaultedAccountId: evmNativeClearingAccountId(policyHash, long.accountId), backstopAccountId: evmNativeClearingAccountId(policyHash, short.accountId) } })
    : encodeEventTopics({ abi, eventName: 'PackageMatched', args: { authorizationHash: `0x${toHex(authorized.authorizationHash)}`, longAccountId: evmNativeClearingAccountId(policyHash, long.accountId), shortAccountId: evmNativeClearingAccountId(policyHash, short.accountId) } });
  const log = { address: house, blockHash, blockNumber: 42n, transactionHash: tx, transactionIndex: 0, logIndex: 0, removed: false, topics,
    data: recovery ? encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [resolved!.resolution.reserveConsumedQuoteAtoms, resolved!.resolution.uncoveredDeficitQuoteAtoms])
      : encodeAbiParameters([{ type: 'uint128' }, { type: 'uint128' }, { type: 'uint256' }], [10n, 1_000n, 0n]) } as TransactionReceipt['logs'][number];
  const reads: EvmNativeClearingTransitionReadPort = {
    chainId: async () => 84532n, finalizedBlock: async () => ({ number: 100n, hash: blockHash }), blockHash: async () => blockHash,
    code: async () => code, timestamp: async () => 11n, clearingLogs: async () => [log],
    receipt: async () => ({ transactionHash: tx, status: 'success', blockNumber: 42n, blockHash, logs: [log] }),
    read: async (request, atBlock) => {
      assert.ok(atBlock === 41n || atBlock === 42n);
      const selectedAccounts = atBlock === 41n ? accounts : nextAccounts;
      const selectedState = atBlock === 41n ? state : nextState;
      if (request.functionName === 'account') {
        const account = selectedAccounts.find((account) => request.args?.[0] === evmNativeClearingAccountId(policyHash, account.accountId))!;
        return { ...account, owner: account.ownerId };
      }
      const fields: Record<string, unknown> = { policyHash, collateralToken: token, markAuthority: longOwner,
        packageQuantityIncrementAtoms: 10n, priceTickQuoteAtoms: 1n, initialMarginQuoteAtomsPerIncrement: 200n, maintenanceMarginQuoteAtomsPerIncrement: 100n,
        maximumPositionAtoms: 1_000n, maximumOpenInterestAtoms: 10_000n, maximumDefaultTransferDiscountBps: 500, markMaximumStalenessSeconds: 60n,
        openInterestAtoms: selectedState.openInterestAtoms, recoveryReserveQuoteAtoms: selectedState.recoveryReserveQuoteAtoms,
        feeBps: 0, accruedProtocolFees: 0n, entryPaused: false, balanceOf: 100_000n, decimals: 6, consumedAuthorization: true,
        currentMark: { observationHash: `0x${toHex(mark.observationHash)}`, priceTicks: mark.priceTicks, sourceSequence: 1n, observedAt: 10n, validUntil: 70n },
        auction: { defaultedAccountId: evmNativeClearingAccountId(policyHash, long.accountId), bestBackstopAccountId: evmNativeClearingAccountId(policyHash, short.accountId), bestPriceTicks: 48n, settled: true } };
      return fields[request.functionName];
    },
  };
  const binding = { domain: domainRef('eip155:84532', 1, hash), clearingHouse: house, clearingHouseCodeHash: keccak256(code),
    collateralToken: token, collateralTokenCodeHash: keccak256(code), collateralAsset: policy.accountingAsset };
  return { binding, reads, input: { policy, state, accounts, mark, transactionHash: tx, authorization }, log };
}

test('finalized native matches bind the event, historical authorization clock and exact account transition', async () => {
  const { binding, reads, input } = fixture();
  const result = await new EvmNativeClearingTransitionVerifier(binding, reads).match(input);
  assert.equal(await new EvmNativeClearingTransitionVerifier(binding, reads).executionMarkHash(tx), `0x${toHex(input.mark.observationHash)}`);
  assert.equal(result.state.openInterestAtoms, 10n);
  assert.equal(result.accounts[0]!.positionAtoms, 10n);
  assert.equal(result.proof.blockNumber, 42n);
  assert.equal(result.proof.executedAtMs, 11_000n);
  assert.equal(result.proof.transactionHash, tx);
});

test('native match reconciliation refuses unfinalized, ambiguous, unconsumed and mismatched receipts', async () => {
  const { binding, reads, input, log } = fixture();
  const variants: Partial<EvmNativeClearingTransitionReadPort>[] = [
    { finalizedBlock: async () => ({ number: 41n, hash: blockHash }) },
    { clearingLogs: async () => [log, { ...log, logIndex: 1 }] },
    { receipt: async () => ({ transactionHash: tx, status: 'reverted', blockNumber: 42n, blockHash, logs: [log] }) },
    { read: async (request, block) => request.functionName === 'consumedAuthorization' ? false : reads.read(request, block) },
    { read: async (request, block) => request.functionName === 'account' && block === 42n ? { ...(await reads.read(request, block) as object), sequence: 99n } : reads.read(request, block) },
    { timestamp: async () => 20n },
    { chainId: async () => 1n },
  ];
  for (const variant of variants) await assert.rejects(new EvmNativeClearingTransitionVerifier(binding, { ...reads, ...variant }).match(input));
  await assert.rejects(new EvmNativeClearingTransitionVerifier(binding, reads).match({ ...input,
    mark: { ...input.mark, observationHash: commitmentHash('99'.repeat(32)) } }), /observation hash differs/);
});

test('native default reconciliation preserves exact reserve loss, residual deficit and transferred exposure', async () => {
  const { binding, reads, input } = fixture(true);
  const verifier = new EvmNativeClearingTransitionVerifier(binding, reads);
  const result = await verifier.recover({ ...input, auctionId: 'default-1' });
  assert.equal(result.receipt.reserveConsumedQuoteAtoms, 300n);
  assert.equal(result.receipt.uncoveredDeficitQuoteAtoms, 452n);
  assert.equal(result.accounts[0]!.positionAtoms, 0n);
  assert.equal(result.accounts[1]!.positionAtoms, 10n);
  await assert.rejects(verifier.recover({ ...input, auctionId: 'wrong-auction' }));
});

test('flat normalization verifies the owner calldata and exact pre/post state without inventing an event', async () => {
  const { binding, reads, input } = fixture();
  const { accountHash, ...source } = input.accounts[0]!;
  const before = nativeClearingAccount({ ...source, cashBalanceQuoteAtoms: 500n }, input.policy);
  const after = normalizeNativeClearingAccount(before, input.policy);
  const accounts = [before, input.accounts[1]!];
  const data = encodeFunctionData({ abi: parseAbi(['function normalizeFlatAccount(bytes32)']), functionName: 'normalizeFlatAccount',
    args: [evmNativeClearingAccountId(`0x${toHex(input.policy.policyHash)}`, before.accountId)] });
  const transaction = { hash: tx, from: before.ownerId, to: house, input: data, value: 0n, blockNumber: 42n, blockHash };
  const port: EvmNativeClearingTransitionReadPort = { ...reads,
    transaction: async () => transaction,
    receipt: async () => ({ transactionHash: tx, status: 'success', blockNumber: 42n, blockHash, logs: [] }),
    clearingLogs: async () => [],
    read: async (request, block) => {
      if (request.functionName === 'openInterestAtoms') return input.state.openInterestAtoms;
      if (request.functionName === 'account') {
        const selected = accounts.find((account) => request.args?.[0] === evmNativeClearingAccountId(`0x${toHex(input.policy.policyHash)}`, account.accountId))!;
        const result = selected.accountId === before.accountId && block === 42n ? after : selected;
        return { ...result, owner: result.ownerId };
      }
      return reads.read(request, block);
    },
  };
  const command = { ...input, accounts, accountId: before.accountId };
  const result = await new EvmNativeClearingTransitionVerifier(binding, port).normalize(command);
  assert.equal(result.accounts[0]!.collateralQuoteAtoms, before.collateralQuoteAtoms + 500n);
  assert.equal(result.accounts[0]!.cashBalanceQuoteAtoms, 0n);
  assert.equal(result.state.sequence, input.state.sequence);
  assert.equal(result.proof.logIndex, null);
  assert.equal(result.proof.evidenceKind, 'CALL_AND_STATE');
  for (const variant of [
    { transaction: async () => ({ ...transaction, from: shortOwner }) },
    { transaction: async () => ({ ...transaction, input: '0x' as Hex }) },
    { finalizedBlock: async () => ({ number: 41n, hash: blockHash }) },
  ]) await assert.rejects(new EvmNativeClearingTransitionVerifier(binding, { ...port, ...variant }).normalize(command));
});
