import {
  applyNativeClearingMatch,
  assetRef,
  bytesEqual,
  domainRef,
  nativeClearingExecutionId,
  nativeClearingMatchAuthorization,
  nativeClearingMarkObservation,
  nativeClearingPolicy,
  normalizeNativeClearingAccount,
  protocolId,
  resolveNativeClearingDefault,
  toHex,
  type NativeClearingAccount,
  type NativeClearingDomainState,
  type NativeClearingMarkObservation,
  type NativeClearingMatchAuthorizationInput,
  type NativeClearingPolicy,
} from '@naryx/protocol-types';
import { decodeEventLog, encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, type Hex, type Log, type TransactionReceipt } from 'viem';
import { EvmNativeClearingBackingVerifier, evmNativeClearingAccountId, type EvmNativeClearingBackingReadPort, type EvmNativeClearingBinding } from './native-clearing-backing.js';
import { hash32, requiredEvmAddress, structField } from './readPort.js';

const ABI = parseAbi([
  'event PackageMatched(bytes32 indexed authorizationHash,bytes32 indexed longAccountId,bytes32 indexed shortAccountId,uint128 quantityAtoms,uint128 priceTicks,uint256 feeAtoms)',
  'event DefaultAuctionSettled(bytes32 indexed auctionId,bytes32 indexed defaultedAccountId,bytes32 indexed backstopAccountId,uint256 reserveConsumed,uint256 uncoveredDeficit)',
  'function currentMark() view returns(bytes32 observationHash,uint128 priceTicks,uint64 sourceSequence,uint64 observedAt,uint64 validUntil)',
  'function consumedAuthorization(bytes32) view returns(bool)',
  'function normalizeFlatAccount(bytes32)',
  'function auction(bytes32) view returns((bytes32 defaultedAccountId,bytes32 defaultedAccountHash,bytes32 markObservationHash,int128 positionAtoms,uint128 markPriceTicks,uint128 minimumPriceTicks,uint128 maximumPriceTicks,uint64 markValidUntil,uint64 closeAt,bytes32 bestBackstopAccountId,bytes32 bestBackstopAccountHash,uint128 bestPriceTicks,uint64 bestBidValidUntil,bool settled))',
]);

export interface EvmNativeClearingTransitionReadPort extends EvmNativeClearingBackingReadPort {
  receipt(transactionHash: Hex): Promise<Pick<TransactionReceipt, 'transactionHash' | 'status' | 'blockNumber' | 'blockHash' | 'logs'>>;
  timestamp(blockNumber: bigint): Promise<bigint>;
  clearingLogs(blockNumber: bigint): Promise<readonly Log[]>;
  transaction?(transactionHash: Hex): Promise<{ readonly hash: Hex; readonly from: string; readonly to: string | null;
    readonly input: Hex; readonly value: bigint; readonly blockNumber: bigint | null; readonly blockHash: Hex | null }>;
}

export function evmNativeClearingAuctionId(policyHash: Hex, auctionId: string): Hex {
  return keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'string' }], [
    hash32(policyHash, 'clearing policy hash'), `auction:${protocolId(auctionId, 'clearing auction id')}`,
  ]));
}

export interface EvmNativeClearingTransitionInput {
  readonly policy: NativeClearingPolicy;
  readonly state: NativeClearingDomainState;
  readonly accounts: readonly NativeClearingAccount[];
  readonly mark: NativeClearingMarkObservation;
  readonly transactionHash: Hex;
}

export class EvmNativeClearingTransitionVerifier {
  readonly #binding: EvmNativeClearingBinding;
  readonly #reads: EvmNativeClearingTransitionReadPort;
  readonly #backing: EvmNativeClearingBackingVerifier;

  constructor(binding: EvmNativeClearingBinding, reads: EvmNativeClearingTransitionReadPort) {
    this.#backing = new EvmNativeClearingBackingVerifier(binding, reads);
    this.#binding = Object.freeze({
      domain: domainRef(binding.domain.domainId, binding.domain.domainManifestVersion, binding.domain.domainManifestHash),
      clearingHouse: requiredEvmAddress(binding.clearingHouse, 'clearing house'), clearingHouseCodeHash: hash32(binding.clearingHouseCodeHash, 'house code hash'),
      collateralToken: requiredEvmAddress(binding.collateralToken, 'collateral token'), collateralTokenCodeHash: hash32(binding.collateralTokenCodeHash, 'token code hash'),
      collateralAsset: assetRef(binding.collateralAsset.assetId, binding.collateralAsset.assetManifestHash, binding.collateralAsset.decimals),
    });
    this.#reads = reads;
  }

  async executionMarkHash(transactionHash: Hex): Promise<Hex> {
    hash32(transactionHash, 'clearing transaction hash');
    if (await this.#reads.chainId() !== BigInt(this.#binding.domain.domainId.slice(7))) throw new Error('Clearing transaction chain differs.');
    const receipt = await this.#reads.receipt(transactionHash);
    if (receipt.status !== 'success' || receipt.transactionHash.toLowerCase() !== transactionHash.toLowerCase()) {
      throw new Error('Clearing transaction has no successful receipt.');
    }
    const mark = await this.#reads.read({ address: this.#binding.clearingHouse, abi: ABI, functionName: 'currentMark' }, receipt.blockNumber);
    return hash32(structField(mark, 0, 'observationHash'), 'execution mark hash');
  }

  async normalize(input: Omit<EvmNativeClearingTransitionInput, 'mark'> & { readonly accountId: string }) {
    hash32(input.transactionHash, 'clearing transaction hash');
    if (this.#reads.transaction === undefined) throw new Error('Clearing transaction reads are unavailable.');
    if (await this.#reads.chainId() !== BigInt(this.#binding.domain.domainId.slice(7))) throw new Error('Clearing transaction chain differs.');
    const receipt = await this.#reads.receipt(input.transactionHash);
    const transaction = await this.#reads.transaction(input.transactionHash);
    const before = input.accounts.find((account) => account.accountId === input.accountId);
    if (before === undefined || receipt.status !== 'success' || receipt.blockNumber <= 1n
      || receipt.transactionHash.toLowerCase() !== input.transactionHash.toLowerCase()
      || transaction.hash.toLowerCase() !== input.transactionHash.toLowerCase()
      || transaction.to?.toLowerCase() !== this.#binding.clearingHouse.toLowerCase()
      || transaction.from.toLowerCase() !== before.ownerId.toLowerCase() || transaction.value !== 0n
      || transaction.blockNumber !== receipt.blockNumber || transaction.blockHash !== receipt.blockHash
      || transaction.input !== encodeFunctionData({ abi: ABI, functionName: 'normalizeFlatAccount',
        args: [evmNativeClearingAccountId(`0x${toHex(input.policy.policyHash)}`, input.accountId)] })) {
      throw new Error('Clearing normalization is not the registered owner call.');
    }
    const finalized = await this.#reads.finalizedBlock();
    if (receipt.blockNumber > finalized.number || await this.#reads.blockHash(receipt.blockNumber) !== receipt.blockHash
      || (await this.#reads.clearingLogs(receipt.blockNumber)).some((log) => log.address.toLowerCase() === this.#binding.clearingHouse.toLowerCase())) {
      throw new Error('Clearing normalization is not an isolated finalized call.');
    }
    await this.#backing.verify(input.policy, input.state, input.accounts, {
      number: receipt.blockNumber - 1n, hash: await this.#reads.blockHash(receipt.blockNumber - 1n),
    });
    const next = normalizeNativeClearingAccount(before, input.policy);
    const accounts = input.accounts.map((account) => account.accountId === before.accountId ? next : account);
    const proof = await this.#backing.verify(input.policy, input.state, accounts, { number: receipt.blockNumber, hash: receipt.blockHash });
    return { kind: 'NORMALIZE' as const, state: input.state, accounts,
      receipt: { policyHash: input.policy.policyHash, accountId: before.accountId,
        previousDomainStateHash: input.state.stateHash, previousAccountHash: before.accountHash,
        resultingAccountHash: next.accountHash, receiptHash: next.accountHash },
      proof: { ...proof, transactionHash: input.transactionHash, logIndex: null, evidenceKind: 'CALL_AND_STATE' as const,
        executedAtMs: await this.#reads.timestamp(receipt.blockNumber) * 1000n } };
  }

  async #context(input: EvmNativeClearingTransitionInput) {
    const observation = nativeClearingMarkObservation(input.mark, input.policy);
    if (!bytesEqual(observation.observationHash, input.mark.observationHash)) throw new Error('Clearing observation hash differs.');
    hash32(input.transactionHash, 'clearing transaction hash');
    if (await this.#reads.chainId() !== BigInt(this.#binding.domain.domainId.slice(7))) throw new Error('Clearing transaction chain differs.');
    const receipt = await this.#reads.receipt(input.transactionHash);
    if (receipt.transactionHash.toLowerCase() !== input.transactionHash.toLowerCase() || receipt.status !== 'success' || receipt.blockNumber <= 1n) {
      throw new Error('Clearing transaction has no successful canonical receipt.');
    }
    const block = { number: receipt.blockNumber, hash: receipt.blockHash };
    const previous = { number: block.number - 1n, hash: await this.#reads.blockHash(block.number - 1n) };
    await this.#backing.verify(input.policy, input.state, input.accounts, previous);
    const finalized = await this.#reads.finalizedBlock();
    if (block.number > finalized.number || await this.#reads.blockHash(block.number) !== block.hash) {
      throw new Error('Clearing transaction is not finalized.');
    }
    const logs = (await this.#reads.clearingLogs(block.number)).filter((log) => log.address.toLowerCase() === this.#binding.clearingHouse.toLowerCase());
    if (logs.length !== 1 || logs[0]!.transactionHash?.toLowerCase() !== input.transactionHash.toLowerCase()
      || logs[0]!.blockHash !== block.hash || logs[0]!.removed || logs[0]!.logIndex === null) {
      throw new Error('Clearing reconciliation requires one isolated house event per block.');
    }
    const log = logs[0]!;
    if (!receipt.logs.some((candidate) => candidate.address.toLowerCase() === log.address.toLowerCase()
      && candidate.logIndex === log.logIndex && candidate.data === log.data
      && candidate.topics.length === log.topics.length && candidate.topics.every((topic, index) => topic === log.topics[index]))) {
      throw new Error('Clearing event is absent from its transaction receipt.');
    }
    const event = decodeEventLog({ abi: ABI, data: log.data, topics: log.topics, strict: true });
    const nowMs = await this.#reads.timestamp(block.number) * 1_000n;
    const mark = await this.#reads.read({ address: this.#binding.clearingHouse, abi: ABI, functionName: 'currentMark' }, block.number);
    if (`0x${toHex(input.mark.observationHash)}` !== structField(mark, 0, 'observationHash')
      || input.mark.priceTicks !== structField(mark, 1, 'priceTicks') || input.mark.sourceSequence !== structField(mark, 2, 'sourceSequence')
      || input.mark.validUntilMs !== (structField(mark, 4, 'validUntil') as bigint) * 1_000n
      || input.mark.observedAtMs > (structField(mark, 3, 'observedAt') as bigint) * 1_000n
      || nowMs < input.mark.observedAtMs || nowMs > input.mark.validUntilMs) throw new Error('Clearing execution mark differs from the registered observation.');
    return { block, log, event, nowMs };
  }

  async match(input: EvmNativeClearingTransitionInput & {
    readonly authorization: Omit<NativeClearingMatchAuthorizationInput, 'currentExpiryUnit' | 'currentExpiryValue'>;
  }) {
    const context = await this.#context(input);
    if (context.event.eventName !== 'PackageMatched') throw new Error('Clearing receipt is not a package match.');
    const policy = nativeClearingPolicy(input.policy);
    const authorization = nativeClearingMatchAuthorization({ ...input.authorization,
      currentExpiryUnit: 'EVM_UNIX_SECONDS', currentExpiryValue: context.nowMs / 1_000n });
    if (!bytesEqual(policy.policyHash, authorization.policyHash)) throw new Error('Clearing match policy differs.');
    const policyHash = `0x${toHex(policy.policyHash)}` as Hex;
    const args = context.event.args;
    if (args.authorizationHash !== `0x${toHex(authorization.authorizationHash)}`
      || args.longAccountId !== evmNativeClearingAccountId(policyHash, authorization.longAccountId)
      || args.shortAccountId !== evmNativeClearingAccountId(policyHash, authorization.shortAccountId)
      || args.quantityAtoms !== authorization.quantityAtoms || args.priceTicks !== authorization.priceTicks || args.feeAtoms !== 0n) {
      throw new Error('Clearing match event differs from the package authorization.');
    }
    const long = input.accounts.find((account) => account.accountId === authorization.longAccountId);
    const short = input.accounts.find((account) => account.accountId === authorization.shortAccountId);
    if (long === undefined || short === undefined || long.ownerId !== authorization.longParticipantId || short.ownerId !== authorization.shortParticipantId) {
      throw new Error('Clearing match owners differ from the registered accounts.');
    }
    if (await this.#reads.read({ address: this.#binding.clearingHouse, abi: ABI, functionName: 'consumedAuthorization', args: [args.authorizationHash] }, context.block.number) !== true) {
      throw new Error('Clearing match authorization was not consumed.');
    }
    const result = applyNativeClearingMatch({ policy, domainState: input.state, longAccount: long, shortAccount: short,
      executionId: nativeClearingExecutionId(authorization), quantityAtoms: authorization.quantityAtoms, priceTicks: authorization.priceTicks,
      markPriceTicks: input.mark.priceTicks, observedAtMs: input.mark.observedAtMs, nowMs: context.nowMs });
    const accounts = input.accounts.map((account) => account.accountId === long.accountId ? result.longAccount : account.accountId === short.accountId ? result.shortAccount : account);
    const backing = await this.#backing.verify(policy, result.domainState, accounts, context.block);
    return { kind: 'MATCH' as const, state: result.domainState, accounts, receipt: result.receipt,
      authorizationHash: authorization.authorizationHash, markObservationHash: input.mark.observationHash,
      proof: { ...backing, transactionHash: input.transactionHash, logIndex: context.log.logIndex!, executedAtMs: context.nowMs } };
  }

  async recover(input: EvmNativeClearingTransitionInput & { readonly auctionId: string }) {
    const context = await this.#context(input);
    if (context.event.eventName !== 'DefaultAuctionSettled') throw new Error('Clearing receipt is not a settled default auction.');
    const policyHash = `0x${toHex(input.policy.policyHash)}` as Hex;
    const args = context.event.args;
    if (args.auctionId !== evmNativeClearingAuctionId(policyHash, input.auctionId)) throw new Error('Clearing recovery auction differs.');
    const defaulted = input.accounts.find((account) => evmNativeClearingAccountId(policyHash, account.accountId) === args.defaultedAccountId);
    const backstop = input.accounts.find((account) => evmNativeClearingAccountId(policyHash, account.accountId) === args.backstopAccountId);
    if (defaulted === undefined || backstop === undefined) throw new Error('Clearing recovery account was not registered.');
    const auction = await this.#reads.read({ address: this.#binding.clearingHouse, abi: ABI, functionName: 'auction', args: [args.auctionId] }, context.block.number);
    if (structField(auction, 0, 'defaultedAccountId') !== args.defaultedAccountId
      || structField(auction, 9, 'bestBackstopAccountId') !== args.backstopAccountId
      || structField(auction, 13, 'settled') !== true) throw new Error('Clearing recovery auction state differs.');
    const result = resolveNativeClearingDefault({ policy: input.policy, domainState: input.state,
      defaultedAccount: defaulted, backstopAccount: backstop, resolutionId: input.auctionId,
      transferPriceTicks: structField(auction, 11, 'bestPriceTicks') as bigint,
      markPriceTicks: input.mark.priceTicks, observedAtMs: input.mark.observedAtMs, nowMs: context.nowMs });
    if (result.resolution.reserveConsumedQuoteAtoms !== args.reserveConsumed || result.resolution.uncoveredDeficitQuoteAtoms !== args.uncoveredDeficit) {
      throw new Error('Clearing recovery loss accounting differs.');
    }
    const accounts = input.accounts.map((account) => account.accountId === defaulted.accountId ? result.defaultedAccount : account.accountId === backstop.accountId ? result.backstopAccount : account);
    const backing = await this.#backing.verify(input.policy, result.domainState, accounts, context.block);
    return { kind: 'DEFAULT' as const, state: result.domainState, accounts, receipt: result.resolution,
      markObservationHash: input.mark.observationHash,
      proof: { ...backing, transactionHash: input.transactionHash, logIndex: context.log.logIndex!, executedAtMs: context.nowMs } };
  }
}

export type EvmNativeClearingTransition = Awaited<ReturnType<EvmNativeClearingTransitionVerifier['match'] | EvmNativeClearingTransitionVerifier['recover'] | EvmNativeClearingTransitionVerifier['normalize']>>;
