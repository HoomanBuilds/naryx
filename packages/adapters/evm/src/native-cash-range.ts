import {
  applyNativeClearingMatch, assetRef, domainRef, nativeClearingAccount, nativeClearingDomainState,
  nativeClearingPolicy, protocolId, toHex, type NativeClearingPolicy,
} from '@naryx/protocol-types';
import { encodeAbiParameters, getAddress, hashTypedData, keccak256, parseAbi, parseAbiParameters, recoverTypedDataAddress, type Address, type Hex } from 'viem';
import { evmNativeClearingAccountId, type EvmNativeClearingBinding } from './native-clearing-backing.js';
import { hash32, requiredEvmAddress, structField, type EvmContractRead } from './readPort.js';

export const NATIVE_CASH_RANGE_ABI = parseAbi([
  'function clearingHouse() view returns(address)',
  'function maximumPriceTicks() view returns(uint128)',
  'function previewMark() view returns(uint128 priceTicks,uint80 sourceRound,uint64 sourceUpdatedAt,uint64 maximumValidUntil)',
  'function refreshMark(bytes32,uint128,uint64,uint64)',
]);
export const NATIVE_CASH_HOUSE_ABI = parseAbi([
  'function policyHash() view returns(bytes32)', 'function markAuthority() view returns(address)',
  'function collateralToken() view returns(address)', 'function feeBps() view returns(uint16)',
  'function entryPaused() view returns(bool)', 'function openInterestAtoms() view returns(uint128)',
  'function recoveryReserveQuoteAtoms() view returns(uint256)',
  'function consumedAuthorization(bytes32) view returns(bool)',
  'function matchDigest((bytes32 authorizationHash,bytes32 longAccountId,bytes32 shortAccountId,bytes32 feePayerAccountId,uint64 longSequence,uint64 shortSequence,uint128 quantityAtoms,uint128 priceTicks,uint16 maxFeeBps,uint64 expiry)) view returns(bytes32)',
  'function currentMark() view returns(bytes32 observationHash,uint128 priceTicks,uint64 sourceSequence,uint64 observedAt,uint64 validUntil)',
  'function account(bytes32) view returns((address owner,uint256 collateralQuoteAtoms,int256 cashBalanceQuoteAtoms,int128 positionAtoms,uint64 sequence))',
  'function executeMatch((bytes32 authorizationHash,bytes32 longAccountId,bytes32 shortAccountId,bytes32 feePayerAccountId,uint64 longSequence,uint64 shortSequence,uint128 quantityAtoms,uint128 priceTicks,uint16 maxFeeBps,uint64 expiry),bytes,bytes)',
]);
const TOKEN_ABI = parseAbi(['function decimals() view returns(uint8)', 'function balanceOf(address) view returns(uint256)',
  'function allowance(address,address) view returns(uint256)']);
const MATCH_TYPES = { NativeMatch: [
  { name: 'policyHash', type: 'bytes32' }, { name: 'authorizationHash', type: 'bytes32' },
  { name: 'longAccountId', type: 'bytes32' }, { name: 'shortAccountId', type: 'bytes32' },
  { name: 'feePayerAccountId', type: 'bytes32' }, { name: 'longSequence', type: 'uint64' },
  { name: 'shortSequence', type: 'uint64' }, { name: 'quantityAtoms', type: 'uint128' },
  { name: 'priceTicks', type: 'uint128' }, { name: 'maxFeeBps', type: 'uint16' }, { name: 'expiry', type: 'uint64' },
] } as const;

export interface EvmNativeCashRangeBinding extends EvmNativeClearingBinding {
  readonly kind: 'EVM_NATIVE_CASH_RANGE_V1';
  readonly marketId: string;
  readonly controller: Address;
  readonly controllerCodeHash: Hex;
  readonly maximumPriceTicks: bigint;
  readonly policy: NativeClearingPolicy;
  readonly makerAccountId: string;
  readonly makerOwner: Address;
  readonly makerAuthorization?: Readonly<{ kind: 'ERC1271_NATIVE_CASH_STANDING_V1'; codeHash: Hex }>;
}

export const NATIVE_CASH_STANDING_ABI = parseAbi([
  'function clearingHouse() view returns(address)', 'function controller() view returns(address)',
  'function makerAccountId() view returns(bytes32)', 'function spreadBps() view returns(uint16)',
  'function book() view returns(uint128 bidTicks,uint128 askTicks,uint128 bidQuantity,uint128 askQuantity,uint64 validUntil)',
  'function isValidSignature(bytes32,bytes) view returns(bytes4)',
]);
export function nativeCashContractAuthorization(quote: Pick<EvmNativeCashRangeQuote, 'match'>): Hex {
  return encodeAbiParameters(parseAbiParameters('(bytes32 authorizationHash,bytes32 longAccountId,bytes32 shortAccountId,bytes32 feePayerAccountId,uint64 longSequence,uint64 shortSequence,uint128 quantityAtoms,uint128 priceTicks,uint16 maxFeeBps,uint64 expiry)'), [quote.match]);
}

export interface EvmNativeCashRangeReadPort {
  chainId(): Promise<bigint>;
  head(): Promise<{ number: bigint; hash: Hex; timestamp: bigint }>;
  code(address: Address, block: bigint): Promise<Hex>;
  read(read: EvmContractRead, block: bigint): Promise<unknown>;
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Native cash quote refused: ${message}`);
}

function integer(value: unknown): bigint {
  requireCondition(typeof value === 'bigint', 'contract integer is malformed');
  return value;
}

export class NativeCashMarkUpdating extends Error {
  constructor() {
    super('Native cash clearing mark is updating to the qualified oracle price.');
    this.name = 'NativeCashMarkUpdating';
  }
}

export class EvmNativeCashRangeAdapter {
  readonly #binding: EvmNativeCashRangeBinding;
  readonly #reads: EvmNativeCashRangeReadPort;

  constructor(input: EvmNativeCashRangeBinding, reads: EvmNativeCashRangeReadPort) {
    const domain = domainRef(input.domain.domainId, input.domain.domainManifestVersion, input.domain.domainManifestHash);
    const policy = nativeClearingPolicy(input.policy);
    requireCondition(input.kind === 'EVM_NATIVE_CASH_RANGE_V1' && ['eip155:84532', 'eip155:421614'].includes(domain.domainId)
      && policy.environment === 'testnet', 'only the recognized Sepolia market class is enabled');
    const controller = requiredEvmAddress(input.controller, 'range controller');
    requireCondition(getAddress(policy.markAuthorityId) === controller && policy.packageQuantityIncrementAtoms === 1n
      && policy.priceTickQuoteAtoms === 1n && input.maximumPriceTicks > 1n
      && policy.initialMarginQuoteAtomsPerIncrement >= input.maximumPriceTicks
      && policy.maintenanceMarginQuoteAtomsPerIncrement >= input.maximumPriceTicks, 'policy is not a fully collateralized range');
    const asset = assetRef(input.collateralAsset.assetId, input.collateralAsset.assetManifestHash, input.collateralAsset.decimals);
    requireCondition(policy.accountingAsset.assetId === asset.assetId && policy.accountingAsset.decimals === asset.decimals
      && toHex(policy.accountingAsset.assetManifestHash) === toHex(asset.assetManifestHash), 'policy collateral differs');
    this.#binding = Object.freeze({ ...input, domain, policy, collateralAsset: asset,
      marketId: protocolId(input.marketId), makerAccountId: protocolId(input.makerAccountId), controller,
      controllerCodeHash: hash32(input.controllerCodeHash, 'controller code hash'),
      clearingHouse: requiredEvmAddress(input.clearingHouse, 'cash house'), clearingHouseCodeHash: hash32(input.clearingHouseCodeHash, 'house code hash'),
      collateralToken: requiredEvmAddress(input.collateralToken, 'collateral token'), collateralTokenCodeHash: hash32(input.collateralTokenCodeHash, 'token code hash'),
      makerOwner: requiredEvmAddress(input.makerOwner, 'maker owner') });
    this.#reads = reads;
    if (input.makerAuthorization !== undefined) {
      requireCondition(input.makerAuthorization.kind === 'ERC1271_NATIVE_CASH_STANDING_V1', 'maker authorization class is unsupported');
      hash32(input.makerAuthorization.codeHash, 'standing maker code hash');
    }
  }

  async standingBook() {
    const b = this.#binding;
    requireCondition(b.makerAuthorization?.kind === 'ERC1271_NATIVE_CASH_STANDING_V1', 'no standing maker is registered');
    requireCondition(await this.#reads.chainId() === BigInt(b.domain.domainId.slice(7)), 'RPC chain identity differs');
    const block = await this.#reads.head();
    await Promise.all(([[b.makerOwner, b.makerAuthorization.codeHash], [b.controller, b.controllerCodeHash],
      [b.clearingHouse, b.clearingHouseCodeHash], [b.collateralToken, b.collateralTokenCodeHash]] as const).map(async ([address, codeHash]) => {
      requireCondition(keccak256(await this.#reads.code(address, block.number)) === codeHash, 'standing maker dependency code differs');
    }));
    const read = (functionName: string) => this.#reads.read({ address: b.makerOwner, abi: NATIVE_CASH_STANDING_ABI, functionName }, block.number);
    const [house, controller, accountId, spread, result] = await Promise.all([
      read('clearingHouse'), read('controller'), read('makerAccountId'), read('spreadBps'),
      read('book').then(value => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error })),
    ]);
    requireCondition(getAddress(String(house)) === b.clearingHouse && getAddress(String(controller)) === b.controller
      && accountId === evmNativeClearingAccountId(`0x${toHex(b.policy.policyHash)}`, b.makerAccountId)
      && spread === 10, 'standing maker binding differs');
    if (!result.ok) {
      const [reference, mark, fees] = await Promise.all([
        this.#reads.read({ address: b.controller, abi: NATIVE_CASH_RANGE_ABI, functionName: 'previewMark' }, block.number),
        this.#reads.read({ address: b.clearingHouse, abi: NATIVE_CASH_HOUSE_ABI, functionName: 'currentMark' }, block.number),
        this.#reads.read({ address: b.clearingHouse, abi: NATIVE_CASH_HOUSE_ABI, functionName: 'feeBps' }, block.number),
      ]);
      const referencePrice = integer(structField(reference, 0, 'priceTicks'));
      const markPrice = integer(structField(mark, 1, 'priceTicks'));
      const observedAt = integer(structField(mark, 3, 'observedAt'));
      if ((fees === 0 || fees === 0n) && referencePrice >= 1n && referencePrice <= b.maximumPriceTicks
        && markPrice >= 1n && markPrice <= b.maximumPriceTicks && markPrice !== referencePrice
        && integer(structField(reference, 3, 'maximumValidUntil')) > block.timestamp
        && integer(structField(mark, 4, 'validUntil')) > block.timestamp && observedAt <= block.timestamp
        && block.timestamp - observedAt <= b.policy.markMaximumStalenessMs / 1000n) throw new NativeCashMarkUpdating();
      throw result.error;
    }
    const book = result.value;
    const qualified = { version: 1, marketId: b.marketId, environment: 'testnet' as const, domain: b.domain,
      makerOwner: b.makerOwner, clearingHouse: b.clearingHouse, codeHash: b.makerAuthorization.codeHash,
      quoteMode: 'EXECUTION_COMMITMENT' as const, reservationPolicy: 'RESERVE_ON_ACCEPT' as const,
      bidTicks: integer(structField(book, 0, 'bidTicks')), askTicks: integer(structField(book, 1, 'askTicks')),
      bidQuantity: integer(structField(book, 2, 'bidQuantity')), askQuantity: integer(structField(book, 3, 'askQuantity')),
      validUntil: integer(structField(book, 4, 'validUntil')), block };
    requireCondition(qualified.validUntil > block.timestamp && qualified.bidTicks >= 1n && qualified.askTicks <= b.maximumPriceTicks
      && qualified.bidTicks <= qualified.askTicks && qualified.bidQuantity <= b.policy.maximumPositionAtoms
      && qualified.askQuantity <= b.policy.maximumPositionAtoms, 'standing book bounds differ');
    return Object.freeze(qualified);
  }

  async verifyMakerSignature(quote: EvmNativeCashRangeQuote, signature: Hex): Promise<boolean> {
    if (this.#binding.makerAuthorization === undefined) return getAddress(await recoverTypedDataAddress({ ...quote.typedData, signature })) === this.#binding.makerOwner;
    await this.standingBook();
    if (signature !== nativeCashContractAuthorization(quote)) return false;
    const block = await this.#reads.head();
    return await this.#reads.read({ address: this.#binding.makerOwner, abi: NATIVE_CASH_STANDING_ABI,
      functionName: 'isValidSignature', args: [quote.digest, signature] }, block.number) === '0x1626ba7e';
  }

  async account(ownerInput: Address, logicalId: string) {
    const binding = this.#binding;
    const owner = requiredEvmAddress(ownerInput, 'account owner');
    const accountId = protocolId(logicalId);
    requireCondition(accountId !== binding.makerAccountId && owner !== binding.makerOwner, 'maker account is not a user account');
    const chainId = Number(binding.domain.domainId.slice(7));
    requireCondition(await this.#reads.chainId() === BigInt(chainId), 'RPC chain identity differs');
    const block = await this.#reads.head();
    for (const [address, hash] of [[binding.controller, binding.controllerCodeHash],
      [binding.clearingHouse, binding.clearingHouseCodeHash], [binding.collateralToken, binding.collateralTokenCodeHash]] as const) {
      requireCondition(keccak256(await this.#reads.code(address, block.number)) === hash, 'reviewed contract code differs');
    }
    const onchainAccountId = evmNativeClearingAccountId(`0x${toHex(binding.policy.policyHash)}`, accountId);
    const read = (address: Address, abi: EvmContractRead['abi'], functionName: string, args?: readonly unknown[]) =>
      this.#reads.read({ address, abi, functionName, ...(args === undefined ? {} : { args }) }, block.number);
    const [value, walletBalanceAtoms, allowanceAtoms, decimals, policyHash, token, mark] = await Promise.all([
      read(binding.clearingHouse, NATIVE_CASH_HOUSE_ABI, 'account', [onchainAccountId]),
      read(binding.collateralToken, TOKEN_ABI, 'balanceOf', [owner]),
      read(binding.collateralToken, TOKEN_ABI, 'allowance', [owner, binding.clearingHouse]),
      read(binding.collateralToken, TOKEN_ABI, 'decimals'), read(binding.clearingHouse, NATIVE_CASH_HOUSE_ABI, 'policyHash'),
      read(binding.clearingHouse, NATIVE_CASH_HOUSE_ABI, 'collateralToken'),
      read(binding.clearingHouse, NATIVE_CASH_HOUSE_ABI, 'currentMark'),
    ]);
    const accountOwner = getAddress(String(structField(value, 0, 'owner')));
    requireCondition(accountOwner === owner || accountOwner === '0x0000000000000000000000000000000000000000', 'account belongs to another owner');
    requireCondition(policyHash === `0x${toHex(binding.policy.policyHash)}` && getAddress(String(token)) === binding.collateralToken
      && decimals === binding.collateralAsset.decimals, 'account policy or collateral differs');
    requireCondition(await this.#reads.chainId() === BigInt(chainId), 'RPC chain identity changed');
    return Object.freeze({ version: 1, marketId: binding.marketId, owner, accountId, onchainAccountId, chainId,
      clearingHouse: binding.clearingHouse, collateralToken: binding.collateralToken, decimals,
      opened: accountOwner === owner, collateralQuoteAtoms: integer(structField(value, 1, 'collateralQuoteAtoms')),
      cashBalanceQuoteAtoms: integer(structField(value, 2, 'cashBalanceQuoteAtoms')),
      positionAtoms: integer(structField(value, 3, 'positionAtoms')), sequence: integer(structField(value, 4, 'sequence')),
      walletBalanceAtoms: integer(walletBalanceAtoms), allowanceAtoms: integer(allowanceAtoms),
      markPriceTicks: integer(structField(mark, 1, 'priceTicks')), markValidUntil: integer(structField(mark, 4, 'validUntil')), block });
  }

  async quote(input: Readonly<{
    owner: Address; accountId: string; side: 'BUY' | 'SELL'; quantityAtoms: bigint;
    authorizationHash: Hex; nowSeconds: bigint; lifetimeSeconds: bigint; spreadBps: number;
  }>) {
    const binding = this.#binding;
    if (binding.makerAuthorization !== undefined) await this.standingBook();
    const owner = requiredEvmAddress(input.owner, 'taker owner');
    const takerId = protocolId(input.accountId);
    hash32(input.authorizationHash, 'cash quote authorization hash');
    requireCondition(!/^0x0{64}$/.test(input.authorizationHash) && owner !== binding.makerOwner && takerId !== binding.makerAccountId
      && ['BUY', 'SELL'].includes(input.side) && input.quantityAtoms > 0n && input.quantityAtoms <= binding.policy.maximumPositionAtoms
      && input.lifetimeSeconds >= 5n && input.lifetimeSeconds <= 30n
      && Number.isInteger(input.spreadBps) && input.spreadBps >= 0 && input.spreadBps <= 500, 'request bounds are invalid');
    requireCondition(await this.#reads.chainId() === BigInt(binding.domain.domainId.slice(7)), 'RPC chain identity differs');
    const head = await this.#reads.head();
    requireCondition(head.timestamp <= input.nowSeconds + 5n && head.timestamp >= input.nowSeconds - 30n, 'RPC head is stale or future dated');
    requireCondition(!/^0x0{64}$/.test(hash32(head.hash, 'quote block hash')), 'quote block hash is zero');
    await Promise.all([
      [binding.controller, binding.controllerCodeHash], [binding.clearingHouse, binding.clearingHouseCodeHash],
      [binding.collateralToken, binding.collateralTokenCodeHash],
    ].map(async ([address, hash]) => requireCondition(keccak256(await this.#reads.code(address as Address, head.number)) === hash, 'reviewed contract code differs')));
    const read = (address: Address, abi: EvmContractRead['abi'], functionName: string, args?: readonly unknown[]) => this.#reads.read({ address, abi, functionName, ...(args === undefined ? {} : { args }) }, head.number);
    const policyHash = `0x${toHex(binding.policy.policyHash)}` as Hex;
    const makerId = evmNativeClearingAccountId(policyHash, binding.makerAccountId);
    const userId = evmNativeClearingAccountId(policyHash, takerId);
    const [house, maximum, reference, storedPolicy, authority, token, fees, paused, mark, maker, taker, oi, reserve, balance, decimals] = await Promise.all([
      read(binding.controller, NATIVE_CASH_RANGE_ABI, 'clearingHouse'), read(binding.controller, NATIVE_CASH_RANGE_ABI, 'maximumPriceTicks'),
      read(binding.controller, NATIVE_CASH_RANGE_ABI, 'previewMark'), read(binding.clearingHouse, NATIVE_CASH_HOUSE_ABI, 'policyHash'),
      read(binding.clearingHouse, NATIVE_CASH_HOUSE_ABI, 'markAuthority'), read(binding.clearingHouse, NATIVE_CASH_HOUSE_ABI, 'collateralToken'),
      read(binding.clearingHouse, NATIVE_CASH_HOUSE_ABI, 'feeBps'), read(binding.clearingHouse, NATIVE_CASH_HOUSE_ABI, 'entryPaused'),
      read(binding.clearingHouse, NATIVE_CASH_HOUSE_ABI, 'currentMark'),
      read(binding.clearingHouse, NATIVE_CASH_HOUSE_ABI, 'account', [makerId]), read(binding.clearingHouse, NATIVE_CASH_HOUSE_ABI, 'account', [userId]),
      read(binding.clearingHouse, NATIVE_CASH_HOUSE_ABI, 'openInterestAtoms'), read(binding.clearingHouse, NATIVE_CASH_HOUSE_ABI, 'recoveryReserveQuoteAtoms'),
      read(binding.collateralToken, TOKEN_ABI, 'balanceOf', [binding.clearingHouse]), read(binding.collateralToken, TOKEN_ABI, 'decimals'),
    ]);
    requireCondition(getAddress(String(house)) === binding.clearingHouse && maximum === binding.maximumPriceTicks
      && storedPolicy === policyHash && getAddress(String(authority)) === binding.controller
      && getAddress(String(token)) === binding.collateralToken && (fees === 0 || fees === 0n) && decimals === binding.collateralAsset.decimals
      && typeof paused === 'boolean', 'cash market binding or zero-fee activation policy differs');
    const referencePrice = integer(structField(reference, 0, 'priceTicks'));
    const markPrice = integer(structField(mark, 1, 'priceTicks'));
    const observedAt = integer(structField(mark, 3, 'observedAt'));
    const validUntil = integer(structField(mark, 4, 'validUntil'));
    const sourceUntil = integer(structField(reference, 3, 'maximumValidUntil'));
    requireCondition(markPrice === referencePrice && markPrice >= 1n && markPrice <= binding.maximumPriceTicks
      && observedAt <= head.timestamp && head.timestamp - observedAt <= binding.policy.markMaximumStalenessMs / 1000n
      && validUntil > head.timestamp, 'clearing mark differs from the current qualified reference');
    const account = (value: unknown, accountId: string, expectedOwner: Address) => {
      requireCondition(getAddress(String(structField(value, 0, 'owner'))) === expectedOwner, 'clearing account owner differs');
      return nativeClearingAccount({ version: 1, policyHash: binding.policy.policyHash, accountId, ownerId: expectedOwner.toLowerCase(),
        collateralQuoteAtoms: integer(structField(value, 1, 'collateralQuoteAtoms')),
        cashBalanceQuoteAtoms: integer(structField(value, 2, 'cashBalanceQuoteAtoms')),
        positionAtoms: integer(structField(value, 3, 'positionAtoms')), sequence: integer(structField(value, 4, 'sequence')) }, binding.policy);
    };
    const makerAccount = account(maker, binding.makerAccountId, binding.makerOwner);
    const takerAccount = account(taker, takerId, owner);
    const equity = (value: typeof makerAccount) => value.collateralQuoteAtoms + value.cashBalanceQuoteAtoms + value.positionAtoms * markPrice;
    requireCondition(equity(makerAccount) >= 0n && equity(takerAccount) >= 0n
      && integer(balance) >= equity(makerAccount) + equity(takerAccount), 'clearing collateral is not funded');
    const long = input.side === 'BUY' ? takerAccount : makerAccount;
    const short = input.side === 'BUY' ? makerAccount : takerAccount;
    const reducingOnly = long.positionAtoms < 0n && short.positionAtoms > 0n
      && input.quantityAtoms <= -long.positionAtoms && input.quantityAtoms <= short.positionAtoms;
    requireCondition(!paused || reducingOnly, 'entry is paused');
    const offset = (markPrice * BigInt(input.spreadBps) + 9999n) / 10000n;
    const price = input.side === 'BUY' ? (markPrice + offset > binding.maximumPriceTicks ? binding.maximumPriceTicks : markPrice + offset)
      : markPrice - offset < 1n ? 1n : markPrice - offset;
    const state = nativeClearingDomainState({ version: 1, policyHash: binding.policy.policyHash,
      openInterestAtoms: integer(oi), recoveryReserveQuoteAtoms: integer(reserve), sequence: 0n }, binding.policy);
    applyNativeClearingMatch({ policy: binding.policy, domainState: state, longAccount: long, shortAccount: short,
      executionId: `native-cash-${input.authorizationHash.slice(2)}`, quantityAtoms: input.quantityAtoms,
      priceTicks: price, markPriceTicks: markPrice, observedAtMs: observedAt * 1000n, nowMs: head.timestamp * 1000n });
    const expiry = [input.nowSeconds + input.lifetimeSeconds, validUntil, sourceUntil].reduce((a, b) => a < b ? a : b);
    requireCondition(expiry >= input.nowSeconds + 5n && expiry >= head.timestamp + 5n, 'quote has insufficient source validity');
    const message = { policyHash, authorizationHash: input.authorizationHash,
      longAccountId: input.side === 'BUY' ? userId : makerId, shortAccountId: input.side === 'BUY' ? makerId : userId,
      feePayerAccountId: userId, longSequence: long.sequence, shortSequence: short.sequence,
      quantityAtoms: input.quantityAtoms, priceTicks: price, maxFeeBps: 0, expiry };
    const typedData = { domain: { name: 'Naryx Native Package Clearing', version: '1',
      chainId: Number(BigInt(binding.domain.domainId.slice(7))), verifyingContract: binding.clearingHouse },
      types: MATCH_TYPES, primaryType: 'NativeMatch' as const, message };
    const { policyHash: omitted, ...match } = message;
    return Object.freeze({ version: 1, kind: binding.kind, marketId: binding.marketId, environment: 'testnet' as const,
      domain: binding.domain, guarantee: 'OWNER_SIGNED_NATIVE_CASH_MATCH' as const, quoteMode: 'EXECUTION_COMMITMENT' as const,
      chainId: typedData.domain.chainId, clearingHouse: binding.clearingHouse, makerOwner: binding.makerOwner, owner,
      side: input.side, reducingOnly, priceTicks: price, referencePriceTicks: markPrice, maximumPriceTicks: binding.maximumPriceTicks,
      observedBlock: Object.freeze(head), match: Object.freeze(match), typedData, digest: hashTypedData(typedData),
      ...(binding.makerAuthorization === undefined ? {} : { makerAuthorization: binding.makerAuthorization }) });
  }
}

export type EvmNativeCashRangeQuote = Awaited<ReturnType<EvmNativeCashRangeAdapter['quote']>>;
