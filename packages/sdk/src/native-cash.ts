import { domainRef, nativeClearingPolicy, protocolId, toHex, type DomainRef, type NativeClearingPolicy } from '@naryx/protocol-types';
import { encodeAbiParameters, encodeFunctionData, erc20Abi, getAddress, hashTypedData, keccak256, parseAbi,
  recoverTypedDataAddress, type Address, type Hex } from 'viem';

const HOUSE_ABI = parseAbi([
  'function openAccount(bytes32)', 'function deposit(bytes32,uint256)', 'function withdraw(bytes32,uint256)',
  'function normalizeFlatAccount(bytes32)',
  'function executeMatch((bytes32 authorizationHash,bytes32 longAccountId,bytes32 shortAccountId,bytes32 feePayerAccountId,uint64 longSequence,uint64 shortSequence,uint128 quantityAtoms,uint128 priceTicks,uint16 maxFeeBps,uint64 expiry),bytes,bytes)',
]);
const MATCH_TYPES = { NativeMatch: [
  { name: 'policyHash', type: 'bytes32' }, { name: 'authorizationHash', type: 'bytes32' },
  { name: 'longAccountId', type: 'bytes32' }, { name: 'shortAccountId', type: 'bytes32' },
  { name: 'feePayerAccountId', type: 'bytes32' }, { name: 'longSequence', type: 'uint64' },
  { name: 'shortSequence', type: 'uint64' }, { name: 'quantityAtoms', type: 'uint128' },
  { name: 'priceTicks', type: 'uint128' }, { name: 'maxFeeBps', type: 'uint16' }, { name: 'expiry', type: 'uint64' },
] } as const;

export interface NativeCashMarket {
  readonly marketId: string;
  readonly kind: 'EVM_NATIVE_CASH_RANGE_V1';
  readonly environment: 'testnet';
  readonly settlement: 'NATIVE_CASH_ONLY';
  readonly createsExternalPositions: false;
  readonly binding: Readonly<{ kind: 'EVM_NATIVE_CASH_RANGE_V1'; marketId: string; domain: DomainRef;
    controller: Address; controllerCodeHash: Hex; clearingHouse: Address; clearingHouseCodeHash: Hex;
    collateralToken: Address; collateralTokenCodeHash: Hex; policy: NativeClearingPolicy;
    maximumPriceTicks: bigint; makerAccountId: string; makerOwner: Address }>;
  readonly reference: unknown;
}

export interface NativeCashAccount {
  readonly version: 1;
  readonly marketId: string;
  readonly owner: Address;
  readonly accountId: string;
  readonly onchainAccountId: Hex;
  readonly chainId: number;
  readonly clearingHouse: Address;
  readonly collateralToken: Address;
  readonly decimals: number;
  readonly opened: boolean;
  readonly collateralQuoteAtoms: bigint;
  readonly cashBalanceQuoteAtoms: bigint;
  readonly positionAtoms: bigint;
  readonly sequence: bigint;
  readonly walletBalanceAtoms: bigint;
  readonly allowanceAtoms: bigint;
  readonly markPriceTicks: bigint;
  readonly markValidUntil: bigint;
  readonly block: Readonly<{ number: bigint; hash: Hex; timestamp: bigint }>;
}

export interface NativeCashQuoteRequest {
  readonly requestId: string; readonly marketId: string; readonly owner: string; readonly accountId: string;
  readonly side: 'BUY' | 'SELL'; readonly quantityAtoms: bigint;
}
export interface NativeCashMatch {
  readonly authorizationHash: Hex; readonly longAccountId: Hex; readonly shortAccountId: Hex; readonly feePayerAccountId: Hex;
  readonly longSequence: bigint; readonly shortSequence: bigint; readonly quantityAtoms: bigint;
  readonly priceTicks: bigint; readonly maxFeeBps: number; readonly expiry: bigint;
}
export interface NativeCashSignedQuote {
  readonly version: 1; readonly requestId: string; readonly makerSignature: Hex;
  readonly quote: Readonly<{ version: 1; kind: 'EVM_NATIVE_CASH_RANGE_V1'; marketId: string; environment: 'testnet';
    domain: DomainRef; guarantee: 'OWNER_SIGNED_NATIVE_CASH_MATCH'; quoteMode: 'EXECUTION_COMMITMENT';
    chainId: number; clearingHouse: Address; makerOwner: Address; owner: Address; side: 'BUY' | 'SELL'; reducingOnly: boolean;
    priceTicks: bigint; referencePriceTicks: bigint; maximumPriceTicks: bigint;
    match: NativeCashMatch; typedData: ReturnType<typeof nativeCashTypedData>; digest: Hex }>;
}
export interface NativeCashTrade {
  readonly version: 1; readonly kind: 'NATIVE_CASH_RANGE_MATCH'; readonly environment: 'testnet';
  readonly evidenceGrade: 'FINALIZED_CONTRACT_RECEIPT'; readonly marketId: string; readonly domain: DomainRef;
  readonly clearingHouse: Address; readonly owner: Address; readonly makerOwner: Address; readonly quoteDigest: Hex;
  readonly authorizationHash: Hex; readonly transactionHash: Hex; readonly blockNumber: bigint;
  readonly blockHash: Hex; readonly logIndex: number; readonly side: 'BUY' | 'SELL'; readonly quantityAtoms: bigint;
  readonly priceTicks: bigint; readonly feeAtoms: bigint;
}
export type NativeCashTransaction = Readonly<{ to: Address; data: Hex; value: '0' }>;

function requireCash(condition: boolean): asserts condition {
  if (!condition) throw new Error('Native cash response does not match the selected testnet market or wallet.');
}
function hash(value: unknown): asserts value is Hex {
  requireCash(typeof value === 'string' && /^0x(?!0{64}$)[0-9a-f]{64}$/i.test(value));
}
export function reviewNativeCashMarket(input: unknown): NativeCashMarket {
  const market = input as NativeCashMarket;
  requireCash(!!market && market.kind === 'EVM_NATIVE_CASH_RANGE_V1' && market.environment === 'testnet'
    && market.settlement === 'NATIVE_CASH_ONLY' && market.createsExternalPositions === false && !!market.binding);
  const b = market.binding;
  protocolId(market.marketId);
  const domain = domainRef(b.domain.domainId, b.domain.domainManifestVersion, b.domain.domainManifestHash);
  const policy = nativeClearingPolicy(b.policy);
  requireCash(b.kind === market.kind && b.marketId === market.marketId && policy.environment === 'testnet'
    && ['eip155:84532', 'eip155:421614'].includes(domain.domainId)
    && policy.packageQuantityIncrementAtoms === 1n && policy.priceTickQuoteAtoms === 1n
    && b.maximumPriceTicks > 1n && policy.initialMarginQuoteAtomsPerIncrement >= b.maximumPriceTicks
    && policy.maintenanceMarginQuoteAtomsPerIncrement >= b.maximumPriceTicks);
  for (const address of [b.controller, b.clearingHouse, b.collateralToken, b.makerOwner]) {
    requireCash(getAddress(address) !== '0x0000000000000000000000000000000000000000');
  }
  requireCash(getAddress(policy.markAuthorityId) === getAddress(b.controller));
  for (const value of [b.controllerCodeHash, b.clearingHouseCodeHash, b.collateralTokenCodeHash]) hash(value);
  protocolId(b.makerAccountId);
  return Object.freeze({ ...market, binding: Object.freeze({ ...b, domain, policy }) });
}

export function nativeCashAccountKey(market: NativeCashMarket, accountId: string): Hex {
  return keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'string' }],
    [`0x${toHex(market.binding.policy.policyHash)}`, protocolId(accountId)]));
}
export function nativeCashWalletAccountId(owner: string): string {
  return `cash-wallet-${getAddress(owner).toLowerCase()}`;
}
export function reviewNativeCashAccount(value: unknown, market: NativeCashMarket, owner: string, accountId: string): NativeCashAccount {
  const a = value as NativeCashAccount;
  requireCash(!!a && a.version === 1 && a.marketId === market.marketId && getAddress(a.owner) === getAddress(owner)
    && a.accountId === accountId && a.onchainAccountId === nativeCashAccountKey(market, accountId)
    && a.chainId === Number(market.binding.domain.domainId.slice(7))
    && getAddress(a.clearingHouse) === getAddress(market.binding.clearingHouse)
    && getAddress(a.collateralToken) === getAddress(market.binding.collateralToken)
    && a.decimals === market.binding.policy.accountingAsset.decimals && typeof a.opened === 'boolean');
  for (const key of ['collateralQuoteAtoms', 'sequence', 'walletBalanceAtoms', 'allowanceAtoms', 'markPriceTicks', 'markValidUntil'] as const) {
    requireCash(typeof a[key] === 'bigint' && a[key] >= 0n && a[key] < (1n << 256n));
  }
  requireCash(typeof a.positionAtoms === 'bigint' && a.positionAtoms >= -(1n << 127n) && a.positionAtoms < (1n << 127n)
    && typeof a.cashBalanceQuoteAtoms === 'bigint' && a.cashBalanceQuoteAtoms >= -(1n << 255n) && a.cashBalanceQuoteAtoms < (1n << 255n)
    && a.sequence < (1n << 64n) && !!a.block && typeof a.block.number === 'bigint' && a.block.number > 0n
    && typeof a.block.timestamp === 'bigint' && a.block.timestamp > 0n);
  hash(a.block.hash);
  requireCash(a.opened || a.positionAtoms === 0n && a.cashBalanceQuoteAtoms === 0n && a.collateralQuoteAtoms === 0n && a.sequence === 0n);
  return Object.freeze(a);
}

function nativeCashTypedData(market: NativeCashMarket, match: NativeCashMatch) {
  return { domain: { name: 'Naryx Native Package Clearing', version: '1',
    chainId: Number(market.binding.domain.domainId.slice(7)), verifyingContract: market.binding.clearingHouse },
    types: MATCH_TYPES, primaryType: 'NativeMatch' as const,
    message: { policyHash: `0x${toHex(market.binding.policy.policyHash)}` as Hex, ...match } };
}
export async function reviewNativeCashQuote(value: unknown, market: NativeCashMarket, request: NativeCashQuoteRequest, nowSeconds: bigint): Promise<NativeCashSignedQuote> {
  const signed = value as NativeCashSignedQuote;
  const q = signed?.quote;
  requireCash(!!q && signed.version === 1 && signed.requestId === request.requestId && request.marketId === market.marketId
    && q.version === 1 && q.kind === market.kind && q.marketId === market.marketId && q.environment === 'testnet'
    && q.guarantee === 'OWNER_SIGNED_NATIVE_CASH_MATCH' && q.quoteMode === 'EXECUTION_COMMITMENT'
    && q.chainId === Number(market.binding.domain.domainId.slice(7)) && getAddress(q.clearingHouse) === getAddress(market.binding.clearingHouse)
    && getAddress(q.owner) === getAddress(request.owner) && getAddress(q.makerOwner) === getAddress(market.binding.makerOwner)
    && q.side === request.side && ['BUY', 'SELL'].includes(q.side) && typeof q.reducingOnly === 'boolean'
    && q.domain.domainId === market.binding.domain.domainId && q.domain.domainManifestVersion === market.binding.domain.domainManifestVersion
    && toHex(q.domain.domainManifestHash) === toHex(market.binding.domain.domainManifestHash));
  const m = q.match;
  requireCash(!!m && Object.keys(m).sort().join(',') === 'authorizationHash,expiry,feePayerAccountId,longAccountId,longSequence,maxFeeBps,priceTicks,quantityAtoms,shortAccountId,shortSequence');
  for (const key of ['longSequence', 'shortSequence', 'quantityAtoms', 'priceTicks', 'expiry'] as const) requireCash(typeof m[key] === 'bigint' && m[key] >= 0n);
  requireCash(typeof q.referencePriceTicks === 'bigint' && q.referencePriceTicks >= 1n && q.referencePriceTicks <= market.binding.maximumPriceTicks);
  hash(m.authorizationHash);
  const ownerKey = nativeCashAccountKey(market, request.accountId), makerKey = nativeCashAccountKey(market, market.binding.makerAccountId);
  requireCash(ownerKey !== makerKey && getAddress(q.owner) !== getAddress(q.makerOwner)
    && m.longAccountId === (q.side === 'BUY' ? ownerKey : makerKey) && m.shortAccountId === (q.side === 'BUY' ? makerKey : ownerKey)
    && m.feePayerAccountId === ownerKey && m.quantityAtoms === request.quantityAtoms && m.quantityAtoms > 0n
    && m.quantityAtoms <= market.binding.policy.maximumPositionAtoms && m.maxFeeBps === 0
    && m.priceTicks === q.priceTicks && m.priceTicks >= 1n && m.priceTicks <= market.binding.maximumPriceTicks
    && q.maximumPriceTicks === market.binding.maximumPriceTicks && typeof m.expiry === 'bigint'
    && m.expiry > nowSeconds && m.expiry <= nowSeconds + 30n);
  const typedData = nativeCashTypedData(market, m);
  requireCash(hashTypedData(typedData) === q.digest && hashTypedData(q.typedData) === q.digest
    && /^0x[0-9a-f]{130}$/i.test(signed.makerSignature)
    && getAddress(await recoverTypedDataAddress({ ...typedData, signature: signed.makerSignature })) === getAddress(market.binding.makerOwner));
  return Object.freeze({ ...signed, quote: Object.freeze({ ...q, typedData }) });
}

export function nativeCashAccountTransaction(market: NativeCashMarket, account: NativeCashAccount,
  action: 'open' | 'approve' | 'deposit' | 'normalize' | 'withdraw', amountAtoms = 0n): NativeCashTransaction {
  reviewNativeCashMarket(market);
  reviewNativeCashAccount(account, market, account.owner, account.accountId);
  requireCash(account.owner.toLowerCase() !== market.binding.makerOwner.toLowerCase());
  requireCash(['open', 'approve', 'deposit', 'normalize', 'withdraw'].includes(action));
  const quantityAction = ['approve', 'deposit', 'withdraw'].includes(action);
  requireCash(!quantityAction || amountAtoms > 0n && amountAtoms <= 100n * 10n ** BigInt(account.decimals));
  requireCash(action === 'open' ? !account.opened : account.opened);
  const key = account.onchainAccountId;
  if (action === 'approve') return { to: market.binding.collateralToken, value: '0',
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [market.binding.clearingHouse, amountAtoms] }) };
  if (action === 'deposit') requireCash(amountAtoms <= account.walletBalanceAtoms && amountAtoms <= account.allowanceAtoms);
  if (action === 'normalize') requireCash(account.positionAtoms === 0n && account.collateralQuoteAtoms + account.cashBalanceQuoteAtoms >= 0n);
  if (action === 'withdraw') requireCash(account.positionAtoms === 0n && account.cashBalanceQuoteAtoms === 0n && amountAtoms <= account.collateralQuoteAtoms);
  const data = action === 'open' ? encodeFunctionData({ abi: HOUSE_ABI, functionName: 'openAccount', args: [key] })
    : action === 'normalize' ? encodeFunctionData({ abi: HOUSE_ABI, functionName: 'normalizeFlatAccount', args: [key] })
      : encodeFunctionData({ abi: HOUSE_ABI, functionName: action === 'withdraw' ? 'withdraw' : 'deposit', args: [key, amountAtoms] });
  return { to: market.binding.clearingHouse, data, value: '0' };
}
export async function nativeCashMatchTransaction(signed: NativeCashSignedQuote, ownerSignature: Hex, nowSeconds: bigint): Promise<NativeCashTransaction> {
  const q = signed.quote;
  requireCash([84532, 421614].includes(q.chainId) && q.environment === 'testnet' && q.match.expiry > nowSeconds
    && q.typedData.domain.chainId === q.chainId && q.typedData.domain.verifyingContract === q.clearingHouse
    && hashTypedData(q.typedData) === q.digest && q.match.maxFeeBps === 0
    && Object.entries(q.match).every(([key, value]) => q.typedData.message[key as keyof typeof q.typedData.message] === value)
    && getAddress(await recoverTypedDataAddress({ ...q.typedData, signature: signed.makerSignature })) === getAddress(q.makerOwner)
    && getAddress(await recoverTypedDataAddress({ ...q.typedData, signature: ownerSignature })) === getAddress(q.owner));
  return { to: q.clearingHouse, value: '0', data: encodeFunctionData({ abi: HOUSE_ABI, functionName: 'executeMatch',
    args: [q.match, q.side === 'BUY' ? ownerSignature : signed.makerSignature, q.side === 'BUY' ? signed.makerSignature : ownerSignature] }) };
}

export function reviewNativeCashTrade(value: unknown, market: NativeCashMarket): NativeCashTrade {
  const t = value as NativeCashTrade;
  requireCash(!!t && t.version === 1 && t.kind === 'NATIVE_CASH_RANGE_MATCH' && t.environment === 'testnet'
    && t.evidenceGrade === 'FINALIZED_CONTRACT_RECEIPT' && t.marketId === market.marketId
    && t.domain.domainId === market.binding.domain.domainId && t.domain.domainManifestVersion === market.binding.domain.domainManifestVersion
    && toHex(t.domain.domainManifestHash) === toHex(market.binding.domain.domainManifestHash)
    && getAddress(t.clearingHouse) === getAddress(market.binding.clearingHouse)
    && getAddress(t.makerOwner) === getAddress(market.binding.makerOwner)
    && getAddress(t.owner) !== getAddress(t.makerOwner) && ['BUY', 'SELL'].includes(t.side)
    && typeof t.quantityAtoms === 'bigint' && t.quantityAtoms > 0n && typeof t.priceTicks === 'bigint'
    && t.priceTicks >= 1n && t.priceTicks <= market.binding.maximumPriceTicks && t.feeAtoms === 0n
    && typeof t.blockNumber === 'bigint' && t.blockNumber > 0n && Number.isSafeInteger(t.logIndex) && t.logIndex >= 0);
  for (const h of [t.quoteDigest, t.authorizationHash, t.transactionHash, t.blockHash]) hash(h);
  getAddress(t.owner);
  return Object.freeze(t);
}
