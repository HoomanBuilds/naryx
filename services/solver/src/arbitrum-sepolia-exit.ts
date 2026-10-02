import { createPublicKey, verify } from 'node:crypto';
import {
  bytesEqual,
  canonicalBytes,
  compareBytes,
  encodeAssetRef,
  exactPrice,
  manifestHash,
  packageOrderHash,
  quoteHash,
  routeHash,
  routePayload,
  routePayloadBytes,
  solverQuote,
  solverQuoteBytes,
  solverSignatureDigest,
  toProtocolJson,
  validatePackageOrderProfile,
  type AssetRef,
  type ExactPrice,
  type Hash32,
  type PackageOrder,
  type RoutePayloadInput,
  type SolverQuoteInput,
} from '@naryx/protocol-types';
import { encodeAbiParameters, keccak256, parseAbi, type Address, type Hex } from 'viem';
import {
  ARBITRUM_SEPOLIA_DOMAIN_ID,
  GMX_FLOAT_PRECISION,
  arbitrumSepoliaAccountOf,
  ceilDiv,
  createViemArbitrumSepoliaReadPort,
  gmxPositionFieldKey,
  readArbitrumSepoliaReferencePrice,
  readGmxPositionFeeFactor,
  readGmxUint,
  requireArbitrumSepoliaCode,
  type ArbitrumSepoliaReadPort,
  type ArbitrumSepoliaReferencePrice,
} from './arbitrum-sepolia-gmx.js';
import {
  loadArbitrumSepoliaQuoteMarketConfig,
  validateArbitrumSepoliaQuoteRuntimeInput,
  type ArbitrumSepoliaQuoteMarketConfig,
} from './arbitrum-sepolia-quote-runtime.js';
import type { AtomicQuoteNonceSource } from './configured-atomic-market.js';
import {
  InternalAtomicQuoteError,
  type InternalAtomicQuoteOrderProvider,
  type InternalAtomicQuotePort,
  type InternalAtomicQuoteRequest,
  type InternalAtomicQuoteResponse,
  type InternalAtomicQuoteStore,
} from './internal-atomic-quote-server.js';
import type { Ed25519AtomicQuoteSigner } from './signed-atomic-entry-quote.js';

const BPS = 10_000n;
const POOL_FEE_SCALE = 1_000_000n;
const GMX_USD_DECIMALS = 30;
const Q192 = 2n ** 192n;
const ZERO_HASH = `0x${'0'.repeat(64)}` as Hex;
const HASH_HEX = /^[0-9a-f]{64}$/;
const ENTRY_EXECUTED = 2;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
export const ARBITRUM_EXIT_EIP712_NAME = 'Naryx GMX V2 Exit';

const SPOT_REGISTRATION = 'struct SpotEntryRegistration { bytes32 packageId; bytes32 requestPayloadHash; address fundingOwner; address port; bytes32 portCodeHash; address baseToken; address quoteToken; uint256 packageNonce; bytes32 orderHash; bytes32 quoteHash; bytes32 routeHash; bytes32 entryFillCommitment; bytes32 rollbackFillCommitment; uint256 baseAtoms; uint256 maxQuoteAtoms; uint256 rollbackMinQuoteAtoms; }';

export const ARBITRUM_EXIT_CONTROLLER_ABI = parseAbi([
  'struct ExitAuthorization { bytes32 packageId; bytes32 entryRequestKey; bytes32 spotRegistrationHash; address account; address owner; address receiver; address spotProceedsRecipient; address feePayer; address executionFeeRefundRecipient; address market; address collateralToken; bool isLong; uint256 fullCloseSizeUsd; uint256 spotBaseAtoms; uint256 spotMinQuoteAtoms; uint256 packageNonce; bytes32 exitOrderHash; bytes32 exitQuoteHash; bytes32 exitRouteHash; bytes32 exitFillCommitment; uint256 acceptablePrice; uint256 minOutputAmount; uint256 executionFeeWei; uint256 callbackGasLimit; uint64 authorizationExpiry; uint64 cancelAfter; uint256 nonce; }',
  'struct FinalPackageReceipt { bytes32 commitment; bytes32 packageId; bytes32 entryRequestKey; bytes32 exitRequestKey; bytes32 entryRequestPayloadHash; bytes32 spotRegistrationHash; bytes32 exitAuthorizationHash; bytes32 perpEvidenceHash; bytes32 spotEvidenceHash; bytes32 entryCommitmentsHash; bytes32 exitCommitmentsHash; address recipient; uint256 fullCloseSizeUsd; uint256 spotBaseAtoms; uint256 spotQuoteAtoms; uint8 perpStatus; uint8 terminalState; }',
  'function nextNonce(address account) view returns (uint256)',
  'function activeExitRequestKey(address account) view returns (bytes32)',
  'function exitDigest(ExitAuthorization authorization) view returns (bytes32)',
  'function exitEvidence(bytes32 requestKey) view returns (uint8 status, bytes32 evidenceHash, uint64 revision, bool reconciling, bool released)',
  'function finalPackageReceipt(bytes32 requestKey) view returns (FinalPackageReceipt)',
  'function submitFullClose(ExitAuthorization authorization, bytes ownerSignature) payable returns (bytes32)',
  'function requestCancellationOrReconciliation(bytes32 requestKey) returns (bool)',
  'function processReconciliation(bytes32 requestKey) returns (bool)',
  'function finalizeExecutedExit(bytes32 requestKey) returns (bool)',
  'event ExitSubmitted(bytes32 indexed packageId, bytes32 indexed requestKey, bytes32 authorizationHash)',
]);

/** Views on the adapter, the owner's account, the factory, the spot port, and its pool. */
export const ARBITRUM_EXIT_VIEWS_ABI = parseAbi([
  SPOT_REGISTRATION,
  'function activePackageOf(address account) view returns (bytes32)',
  'function activeRequestKeyOf(address account) view returns (bytes32)',
  'function requestEvidence(bytes32 requestKey) view returns (uint8 status, bytes32 evidenceHash, uint256 positionSizeBefore, uint256 positionSizeAfter, uint64 revision)',
  'function positionSize(bool isLong) view returns (uint256)',
  'function hasActiveSpotInventory() view returns (bool)',
  'function activeSpotRequestKey() view returns (bytes32)',
  'function activeSpotRegistration() view returns (SpotEntryRegistration)',
  'function adapter() view returns (address)',
  'function exitController() view returns (address)',
  'function spotPort() view returns (address)',
  'function collateralToken() view returns (address)',
  'function pool() view returns (address)',
  'function poolFee() view returns (uint24)',
  'function baseToken() view returns (address)',
  'function token0() view returns (address)',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)',
]);

const SPOT_REGISTRATION_TUPLE = (() => {
  const fn = parseAbi([SPOT_REGISTRATION, 'function encode(SpotEntryRegistration registration)'])
    .find((item) => item.type === 'function');
  const input = fn !== undefined && 'inputs' in fn ? fn.inputs[0] : undefined;
  if (input === undefined) throw new Error('SpotEntryRegistration ABI is missing');
  return input;
})();

/** The EIP-712 fields of `GmxV2ExitController.ExitAuthorization`, in its typehash order. */
export const ARBITRUM_EXIT_AUTHORIZATION_FIELDS = Object.freeze([
  ['packageId', 'bytes32'], ['entryRequestKey', 'bytes32'], ['spotRegistrationHash', 'bytes32'],
  ['account', 'address'], ['owner', 'address'], ['receiver', 'address'], ['spotProceedsRecipient', 'address'],
  ['feePayer', 'address'], ['executionFeeRefundRecipient', 'address'], ['market', 'address'],
  ['collateralToken', 'address'], ['isLong', 'bool'], ['fullCloseSizeUsd', 'uint256'], ['spotBaseAtoms', 'uint256'],
  ['spotMinQuoteAtoms', 'uint256'], ['packageNonce', 'uint256'], ['exitOrderHash', 'bytes32'],
  ['exitQuoteHash', 'bytes32'], ['exitRouteHash', 'bytes32'], ['exitFillCommitment', 'bytes32'],
  ['acceptablePrice', 'uint256'], ['minOutputAmount', 'uint256'], ['executionFeeWei', 'uint256'],
  ['callbackGasLimit', 'uint256'], ['authorizationExpiry', 'uint64'], ['cancelAfter', 'uint64'], ['nonce', 'uint256'],
] as const);

export type ArbitrumExitAuthorization = Readonly<{
  packageId: Hex; entryRequestKey: Hex; spotRegistrationHash: Hex;
  account: Address; owner: Address; receiver: Address; spotProceedsRecipient: Address; feePayer: Address;
  executionFeeRefundRecipient: Address; market: Address; collateralToken: Address; isLong: boolean;
  fullCloseSizeUsd: bigint; spotBaseAtoms: bigint; spotMinQuoteAtoms: bigint; packageNonce: bigint;
  exitOrderHash: Hex; exitQuoteHash: Hex; exitRouteHash: Hex; exitFillCommitment: Hex;
  acceptablePrice: bigint; minOutputAmount: bigint; executionFeeWei: bigint; callbackGasLimit: bigint;
  authorizationExpiry: bigint; cancelAfter: bigint; nonce: bigint;
}>;

export function arbitrumExitTypedData(authorization: ArbitrumExitAuthorization, exitController: Address) {
  return {
    domain: { name: ARBITRUM_EXIT_EIP712_NAME, version: '1', chainId: 421_614, verifyingContract: exitController },
    types: { ExitAuthorization: ARBITRUM_EXIT_AUTHORIZATION_FIELDS.map(([name, type]) => ({ name, type })) },
    primaryType: 'ExitAuthorization',
    message: authorization,
  } as const;
}

function lowerHash(value: unknown, name: string): Hex {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${name} is invalid`);
  return value.toLowerCase() as Hex;
}

function lowerAddress(value: unknown, name: string): Address {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`${name} is invalid`);
  return value.toLowerCase() as Address;
}

function unsigned(value: unknown, name: string): bigint {
  if (typeof value !== 'bigint' || value < 0n) throw new Error(`${name} is invalid`);
  return value;
}

export type ArbitrumSepoliaSpotRegistration = Readonly<{
  packageId: Hex; requestPayloadHash: Hex; fundingOwner: Address; port: Address; portCodeHash: Hex;
  baseToken: Address; quoteToken: Address; packageNonce: bigint; orderHash: Hex; quoteHash: Hex; routeHash: Hex;
  entryFillCommitment: Hex; rollbackFillCommitment: Hex; baseAtoms: bigint; maxQuoteAtoms: bigint;
  rollbackMinQuoteAtoms: bigint;
}>;

/** The owner's executed open package, read from the adapter, the account, GMX, and the exit controller. */
export type ArbitrumSepoliaOpenPosition = Readonly<{
  account: Address;
  packageId: Hex;
  entryRequestKey: Hex;
  sizeInUsd: bigint;
  sizeInTokens: bigint;
  collateralAtoms: bigint;
  spotRegistration: ArbitrumSepoliaSpotRegistration;
  spotRegistrationHash: Hex;
  activeExitRequestKey: Hex;
  exitNonce: bigint;
}>;

export type ArbitrumSepoliaExitReferences = Readonly<{
  factory: Address;
  implementation: Address;
  adapter: Address;
  exitController: Address;
  market: Address;
  collateralToken: Address;
  dataStore: Address;
}>;

export async function readArbitrumSepoliaOpenPosition(
  chain: Pick<ArbitrumSepoliaReadPort, 'readContract'>,
  refs: ArbitrumSepoliaExitReferences,
  owner: Address,
): Promise<ArbitrumSepoliaOpenPosition> {
  const account = arbitrumSepoliaAccountOf(refs.factory, refs.implementation, owner);
  const view = (address: Address, functionName: string, args?: readonly unknown[]) => chain.readContract({
    address, abi: ARBITRUM_EXIT_VIEWS_ABI, functionName, ...(args === undefined ? {} : { args }),
  });
  const control = (functionName: string) => chain.readContract({
    address: refs.exitController, abi: ARBITRUM_EXIT_CONTROLLER_ABI, functionName, args: [account],
  });
  const [packageValue, requestValue] = await Promise.all([
    view(refs.adapter, 'activePackageOf', [account]),
    view(refs.adapter, 'activeRequestKeyOf', [account]),
  ]);
  const packageId = lowerHash(packageValue, 'active package');
  const entryRequestKey = lowerHash(requestValue, 'active request key');
  if (packageId === ZERO_HASH || entryRequestKey === ZERO_HASH) throw new Error('owner has no submitted open package');
  const field = (name: string) => readGmxUint(chain as ArbitrumSepoliaReadPort, refs.dataStore,
    gmxPositionFieldKey(account, refs.market, refs.collateralToken, false, name));
  const [evidence, shortSize, longSize, hasSpot, spotRequestKey, registrationValue, activeExit, nonce, sizeInTokens, collateralAtoms] =
    await Promise.all([
      view(refs.adapter, 'requestEvidence', [entryRequestKey]),
      view(account, 'positionSize', [false]),
      view(account, 'positionSize', [true]),
      view(account, 'hasActiveSpotInventory'),
      view(account, 'activeSpotRequestKey'),
      view(account, 'activeSpotRegistration'),
      control('activeExitRequestKey'),
      control('nextNonce'),
      field('SIZE_IN_TOKENS'),
      field('COLLATERAL_AMOUNT'),
    ]);
  const record = evidence as readonly unknown[];
  const raw = registrationValue as Record<string, unknown>;
  const spotRegistration: ArbitrumSepoliaSpotRegistration = Object.freeze({
    packageId: lowerHash(raw.packageId, 'spot package'),
    requestPayloadHash: lowerHash(raw.requestPayloadHash, 'spot request payload'),
    fundingOwner: lowerAddress(raw.fundingOwner, 'spot funding owner'),
    port: lowerAddress(raw.port, 'spot port'),
    portCodeHash: lowerHash(raw.portCodeHash, 'spot port code hash'),
    baseToken: lowerAddress(raw.baseToken, 'spot base token'),
    quoteToken: lowerAddress(raw.quoteToken, 'spot quote token'),
    packageNonce: unsigned(raw.packageNonce, 'package nonce'),
    orderHash: lowerHash(raw.orderHash, 'entry order hash'),
    quoteHash: lowerHash(raw.quoteHash, 'entry quote hash'),
    routeHash: lowerHash(raw.routeHash, 'entry route hash'),
    entryFillCommitment: lowerHash(raw.entryFillCommitment, 'entry fill commitment'),
    rollbackFillCommitment: lowerHash(raw.rollbackFillCommitment, 'rollback fill commitment'),
    baseAtoms: unsigned(raw.baseAtoms, 'spot base atoms'),
    maxQuoteAtoms: unsigned(raw.maxQuoteAtoms, 'spot quote cap'),
    rollbackMinQuoteAtoms: unsigned(raw.rollbackMinQuoteAtoms, 'rollback minimum'),
  });
  const sizeInUsd = unsigned(shortSize, 'short position size');
  if (Number(record[0]) !== ENTRY_EXECUTED || sizeInUsd === 0n || unsigned(record[3], 'entry position size') !== sizeInUsd
    || unsigned(longSize, 'long position size') !== 0n || hasSpot !== true
    || lowerHash(spotRequestKey, 'spot request key') !== entryRequestKey || spotRegistration.packageId !== packageId
    || spotRegistration.baseAtoms === 0n || unsigned(sizeInTokens, 'position tokens') === 0n) {
    throw new Error('open package is not an executed full short with its spot inventory');
  }
  return Object.freeze({
    account,
    packageId,
    entryRequestKey,
    sizeInUsd,
    sizeInTokens,
    collateralAtoms: unsigned(collateralAtoms, 'position collateral'),
    spotRegistration,
    spotRegistrationHash: keccak256(encodeAbiParameters([SPOT_REGISTRATION_TUPLE], [spotRegistration as never])),
    activeExitRequestKey: lowerHash(activeExit, 'active exit request key'),
    exitNonce: unsigned(nonce, 'exit nonce'),
  });
}

export type ArbitrumSepoliaSpotPool = Readonly<{ sqrtPriceX96: bigint; baseIsToken0: boolean; poolFee: bigint }>;

/** The factory's spot port pool: its mid price and fee. Reads only. */
export async function readArbitrumSepoliaSpotPool(
  chain: Pick<ArbitrumSepoliaReadPort, 'readContract'>,
  spotPort: Address,
): Promise<ArbitrumSepoliaSpotPool> {
  const view = (address: Address, functionName: string) =>
    chain.readContract({ address, abi: ARBITRUM_EXIT_VIEWS_ABI, functionName });
  const [poolValue, fee, base] = await Promise.all([view(spotPort, 'pool'), view(spotPort, 'poolFee'), view(spotPort, 'baseToken')]);
  const pool = lowerAddress(poolValue, 'spot pool');
  const [slot0, token0] = await Promise.all([view(pool, 'slot0'), view(pool, 'token0')]);
  const sqrtPriceX96 = (slot0 as readonly unknown[])[0];
  if (typeof sqrtPriceX96 !== 'bigint' || sqrtPriceX96 <= 0n || typeof fee !== 'number' || fee < 0 || fee >= 1_000_000) {
    throw new Error('spot pool price or fee is invalid');
  }
  return Object.freeze({
    sqrtPriceX96,
    baseIsToken0: lowerAddress(token0, 'pool token0') === lowerAddress(base, 'spot base token'),
    poolFee: BigInt(fee),
  });
}

export type ArbitrumExitPricing = Readonly<{
  entryNotionalAtoms: bigint;
  expectedSpotNotionalAtoms: bigint;
  closeNotionalAtoms: bigint;
  positionFeeAtoms: bigint;
  expectedPerpOutputAtoms: bigint;
  exitOutcomeAtoms: bigint;
}>;

/**
 * Prices a full close at the live reference: the spot sale at the lower of the pool mid and the
 * reference less the pool fee (rounded down), the short bought back at the reference (rounded up)
 * with the larger GMX position fee (rounded up), and the decrease paying collateral plus PnL.
 */
export function priceArbitrumExit(input: Readonly<{
  quantityAtoms: bigint;
  baseDecimals: number;
  quoteDecimals: number;
  reference: Pick<ArbitrumSepoliaReferencePrice, 'answer' | 'decimals'>;
  pool: ArbitrumSepoliaSpotPool;
  positionFeeFactor: bigint;
  position: Pick<ArbitrumSepoliaOpenPosition, 'sizeInUsd' | 'sizeInTokens' | 'collateralAtoms'>;
}>): ArbitrumExitPricing {
  const { reference, pool, position } = input;
  if (input.quantityAtoms <= 0n || reference.answer <= 0n || pool.sqrtPriceX96 <= 0n
    || input.positionFeeFactor < 0n || input.positionFeeFactor >= GMX_FLOAT_PRECISION
    || input.quoteDecimals < 0 || input.quoteDecimals > GMX_USD_DECIMALS || position.sizeInUsd <= 0n) {
    throw new Error('exit pricing inputs are invalid');
  }
  const usdScale = 10n ** BigInt(GMX_USD_DECIMALS - input.quoteDecimals);
  if (position.sizeInUsd % usdScale !== 0n) throw new Error('position size is not an exact quote-atom amount');
  const referenceNumerator = reference.answer * 10n ** BigInt(input.quoteDecimals);
  const referenceDenominator = 10n ** BigInt(reference.decimals + input.baseDecimals);
  const squared = pool.sqrtPriceX96 * pool.sqrtPriceX96;
  const [poolNumerator, poolDenominator] = pool.baseIsToken0 ? [squared, Q192] : [Q192, squared];
  const [numerator, denominator] = poolNumerator * referenceDenominator < referenceNumerator * poolDenominator
    ? [poolNumerator, poolDenominator]
    : [referenceNumerator, referenceDenominator];
  const expectedSpotNotionalAtoms = (input.quantityAtoms * numerator * (POOL_FEE_SCALE - pool.poolFee))
    / (denominator * POOL_FEE_SCALE);
  const entryNotionalAtoms = position.sizeInUsd / usdScale;
  const closeNotionalAtoms = ceilDiv(position.sizeInTokens * referenceNumerator, referenceDenominator);
  const positionFeeAtoms = ceilDiv(position.sizeInUsd * input.positionFeeFactor, GMX_FLOAT_PRECISION * usdScale);
  const expectedPerpOutputAtoms = position.collateralAtoms + entryNotionalAtoms - closeNotionalAtoms - positionFeeAtoms;
  if (expectedSpotNotionalAtoms <= 0n || expectedPerpOutputAtoms <= 0n) throw new Error('exit proceeds are not positive');
  return Object.freeze({
    entryNotionalAtoms,
    expectedSpotNotionalAtoms,
    closeNotionalAtoms,
    positionFeeAtoms,
    expectedPerpOutputAtoms,
    exitOutcomeAtoms: expectedSpotNotionalAtoms + expectedPerpOutputAtoms,
  });
}

function sameAsset(left: AssetRef, right: AssetRef): boolean {
  return left.assetId === right.assetId && left.decimals === right.decimals
    && bytesEqual(left.assetManifestHash, right.assetManifestHash);
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left;
  let b = right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function reducedPrice(base: AssetRef, quote: AssetRef, quoteAtoms: bigint, baseAtoms: bigint, roundingDirection: 'FLOOR' | 'CEIL'): ExactPrice {
  const divisor = gcd(quoteAtoms, baseAtoms);
  return exactPrice({
    baseAsset: base, quoteAsset: quote, quoteAtoms: quoteAtoms / divisor, baseAtoms: baseAtoms / divisor, roundingDirection,
  });
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

export interface ArbitrumSepoliaExitQuoteInput extends ArbitrumSepoliaQuoteMarketConfig {
  readonly chain: ArbitrumSepoliaReadPort;
  readonly nonceSource: AtomicQuoteNonceSource;
  readonly orders: InternalAtomicQuoteOrderProvider;
  readonly signer: Ed25519AtomicQuoteSigner;
  readonly store: InternalAtomicQuoteStore;
}

function requireExitOrder(order: PackageOrder, input: ArbitrumSepoliaExitQuoteInput): void {
  const quote = order.minSpotQuoteOut?.asset;
  if (order.environment !== 'testnet' || order.settlementClass !== 'ASYNC_BONDED_SOLVER'
    || order.expiryUnit !== 'EVM_UNIX_SECONDS' || order.action !== 'EXIT'
    || order.domain.domainId !== input.domain.domainId
    || order.domain.domainManifestVersion !== input.domain.domainManifestVersion
    || !bytesEqual(order.domain.domainManifestHash, input.domain.domainManifestHash)
    || order.templateId !== input.templateId || order.templateVersion !== input.templateVersion
    || !bytesEqual(order.packageTemplateManifestHash, manifestHash(input.packageTemplateManifestHash))
    || order.entryReceiptHash === undefined || order.minExitQuoteOutcome === undefined || quote === undefined
    || !sameAsset(order.quantity.asset, input.baseAsset) || !sameAsset(quote, input.quoteAsset)
    || order.quantity.atoms > input.capacityBaseAtoms) {
    throw new Error('order is not a configured Arbitrum Sepolia async exit');
  }
  const owner = order.owner.toLowerCase() as Address;
  if (!/^0x[0-9a-f]{40}$/.test(owner)
    || order.settlementAccount.toLowerCase() !== arbitrumSepoliaAccountOf(input.accountFactory, input.accountImplementation, owner)) {
    throw new Error('order settlement account is not the owner factory account');
  }
  const permitted = (list: PackageOrder['permittedSpotAdapters'], adapter: ArbitrumSepoliaQuoteMarketConfig['spot']['adapter']) =>
    list.some((item) => item.adapterId === adapter.adapterId && item.adapterManifestVersion === adapter.adapterManifestVersion
      && bytesEqual(item.adapterManifestHash, adapter.adapterManifestHash));
  if (!permitted(order.permittedSpotAdapters, input.spot.adapter) || !permitted(order.permittedPerpAdapters, input.perpetual.adapter)) {
    throw new Error('configured Arbitrum adapters are not permitted by the order');
  }
}

async function signExit(order: PackageOrder, request: InternalAtomicQuoteRequest, input: ArbitrumSepoliaExitQuoteInput) {
  requireExitOrder(order, input);
  const base = input.baseAsset;
  const quoteAsset = input.quoteAsset;
  const reference = await readArbitrumSepoliaReferencePrice(input.chain, {
    feed: input.priceFeed, decimals: input.priceFeedDecimals, maxAgeSeconds: input.maxPriceAgeSeconds,
  });
  await requireArbitrumSepoliaCode(input.chain, input.gmxDataStore, 'GMX data store');
  const now = reference.observedAt;
  if (now >= order.expiryValue) throw new Error('order is expired');
  const factoryView = (functionName: string) => input.chain.readContract({
    address: input.accountFactory, abi: ARBITRUM_EXIT_VIEWS_ABI, functionName,
  }).then((value) => lowerAddress(value, `factory ${functionName}`));
  const [adapter, exitController, spotPort, collateralToken] = await Promise.all([
    factoryView('adapter'), factoryView('exitController'), factoryView('spotPort'), factoryView('collateralToken'),
  ]);
  const owner = order.owner.toLowerCase() as Address;
  const position = await readArbitrumSepoliaOpenPosition(input.chain, {
    factory: input.accountFactory, implementation: input.accountImplementation, adapter, exitController,
    market: input.gmxMarket.toLowerCase() as Address, collateralToken, dataStore: input.gmxDataStore.address,
  }, owner);
  const usdScale = 10n ** BigInt(GMX_USD_DECIMALS - quoteAsset.decimals);
  if (`0x${hex(order.entryReceiptHash!)}` !== position.packageId || position.activeExitRequestKey !== ZERO_HASH
    || order.expectedPrePositionEntryNotional.atoms * usdScale !== position.sizeInUsd
    || order.expectedPrePositionSize.atoms !== -order.quantity.atoms
    || position.spotRegistration.baseAtoms !== order.quantity.atoms) {
    throw new Error('exit order does not match the open package on chain');
  }
  const [pool, positionFeeFactor] = await Promise.all([
    readArbitrumSepoliaSpotPool(input.chain, spotPort),
    readGmxPositionFeeFactor(input.chain, input.gmxDataStore.address, input.gmxMarket),
  ]);
  const pricing = priceArbitrumExit({
    quantityAtoms: order.quantity.atoms, baseDecimals: base.decimals, quoteDecimals: quoteAsset.decimals,
    reference, pool, positionFeeFactor, position,
  });
  if (pricing.expectedSpotNotionalAtoms < order.minSpotQuoteOut!.atoms) throw new Error('spot proceeds are below the order minimum');
  if (pricing.exitOutcomeAtoms < order.minExitQuoteOutcome!.atoms) throw new Error('exit outcome is below the order minimum');
  const feeCap = order.maxVenueFeeAtomsByAsset.find((cap) => sameAsset(cap.asset, quoteAsset));
  if (feeCap === undefined || pricing.positionFeeAtoms > feeCap.maxAtoms) {
    throw new Error('GMX position fee exceeds the signed venue fee cap');
  }
  const routeExpiryValue = order.expiryValue < now + input.routeTtlSeconds ? order.expiryValue : now + input.routeTtlSeconds;
  const maxActionExpiryValue = routeExpiryValue + input.venueWindowSeconds;
  const deadlineValue = maxActionExpiryValue + input.recoveryWindowSeconds;
  if (routeExpiryValue <= now) throw new Error('configured freshness window is empty');
  const referenceQuoteAtoms = reference.answer * 10n ** BigInt(quoteAsset.decimals);
  const referenceBaseAtoms = 10n ** BigInt(reference.decimals + base.decimals);
  const orderHash = packageOrderHash(order);
  const route: RoutePayloadInput = {
    version: 1,
    environment: order.environment,
    domain: order.domain,
    orderHash,
    templateId: order.templateId,
    templateVersion: order.templateVersion,
    packageTemplateManifestHash: order.packageTemplateManifestHash,
    templateRegistryRecordHash: input.templateRegistryRecordHash,
    owner: order.owner,
    settlementAccount: order.settlementAccount,
    solver: input.solverId,
    direction: order.direction,
    action: 'EXIT',
    quantityPolicyClass: 'EXACT_NET',
    partialFillPolicy: order.partialFillPolicy,
    settlementClass: 'ASYNC_BONDED_SOLVER',
    executionPlanKind: 'EVM_ASYNC_REQUEST',
    routeExpiryUnit: 'EVM_UNIX_SECONDS',
    routeExpiryValue,
    feePolicyVersion: input.feePolicyVersion,
    feePolicyManifestHash: input.feePolicyManifestHash,
    accountBindings: input.accountBindings,
    serviceCharges: [],
    preconditions: input.preconditions,
    legs: [
      {
        legIndex: 0, legRole: 'SPOT', actionSequence: input.spot.action.sequence,
        adapter: input.spot.adapter, venue: input.spot.venue, market: input.spot.market,
        baseAsset: base, quoteAsset, side: 'SELL', quantity: order.quantity,
        limitPrice: reducedPrice(base, quoteAsset, order.minSpotQuoteOut!.atoms, order.quantity.atoms, 'FLOOR'),
        timeInForce: 'FOK', reduceOnly: false,
      },
      {
        legIndex: 1, legRole: 'PERPETUAL', actionSequence: input.perpetual.action.sequence,
        adapter: input.perpetual.adapter, venue: input.perpetual.venue, market: input.perpetual.market,
        baseAsset: base, quoteAsset, side: 'BUY', quantity: order.quantity,
        limitPrice: reducedPrice(base, quoteAsset,
          referenceQuoteAtoms * (BPS + BigInt(input.perpSlippageBps)), referenceBaseAtoms * BPS, 'CEIL'),
        timeInForce: 'FOK', reduceOnly: true,
      },
    ],
    actions: [input.spot.action, input.perpetual.action],
    postconditions: input.postconditions,
    evidenceRequirements: input.evidenceRequirements,
    // A close the GMX keepers have not executed by the venue deadline is cancelled through the exit
    // controller; the spot inventory is sold only after the full close, so nothing else is unwound.
    recoveryPlan: {
      ...input.recovery,
      recoveryExpiryUnit: 'EVM_UNIX_SECONDS',
      maxActionExpiryValue,
      deadlineValue,
      minRecoveryWindowMs: input.recoveryWindowSeconds * 1_000n,
      maxRecoveryCostCaps: [{ asset: quoteAsset, maxAtoms: 0n }],
      maxAggregateRecoveryLoss: order.maxAggregateRecoveryLossQuote,
      maxIntermediateResidual: order.quantity,
      maxTerminalResidual: { asset: base, atoms: 0n },
      actionSlots: [{
        sequence: 0, action: 'CANCEL_OPEN_ORDERS', targetLeg: 1,
        adapter: input.perpetual.adapter, markets: [input.perpetual.market],
      }],
    },
  };
  const validatedRoute = routePayload(route, 'arbitrumSepoliaExitRoute');
  const assetKey = (asset: AssetRef) => canonicalBytes((writer) => encodeAssetRef(writer, asset));
  const venueFees = [{ asset: base, atoms: 0n }, { asset: quoteAsset, atoms: pricing.positionFeeAtoms }]
    .sort((left, right) => compareBytes(assetKey(left.asset), assetKey(right.asset)));
  const zeroQuote = { asset: quoteAsset, atoms: 0n };
  const unsignedQuote: SolverQuoteInput = {
    version: 1,
    environment: order.environment,
    domain: order.domain,
    orderHash,
    solverId: input.solverId,
    solverCapabilityManifestHash: input.solverCapabilityManifestHash,
    solverSignatureScheme: 'ED25519',
    solverVerificationKey: input.signer.verificationKey,
    quoteMode: 'EXECUTION_COMMITMENT',
    routeHash: routeHash(validatedRoute),
    quotedOutcome: { kind: 'EXIT_QUOTE_OUTCOME', exitQuoteOutcome: { asset: quoteAsset, atoms: pricing.exitOutcomeAtoms } },
    expectedSpotNotional: { asset: quoteAsset, atoms: pricing.expectedSpotNotionalAtoms },
    expectedPerpNotional: { asset: quoteAsset, atoms: pricing.closeNotionalAtoms },
    expectedGrossSpotQuantity: order.quantity,
    expectedNetSpotQuantity: { asset: base, atoms: -order.quantity.atoms },
    expectedBaseAssetFee: { asset: base, atoms: 0n },
    expectedMarginDelta: zeroQuote,
    expectedRawFillFeesByAsset: venueFees,
    expectedBuilderFeesByAsset: venueFees.map((fee) => ({ asset: fee.asset, atoms: 0n })),
    expectedNormalizedVenueFeesByAsset: venueFees,
    solverFee: zeroQuote,
    protocolFee: zeroQuote,
    expectedPriorityFee: zeroQuote,
    maxRecoveryCostAtomsByAsset: [],
    feePolicyVersion: input.feePolicyVersion,
    feePolicyManifestHash: input.feePolicyManifestHash,
    validUntilUnit: 'EVM_UNIX_SECONDS',
    validUntilValue: routeExpiryValue,
    quoteNonce: input.nonceSource.next(),
    signature: new Uint8Array(64),
  };
  const digest = solverSignatureDigest(unsignedQuote);
  const signature = await input.signer.signDigest(digest);
  const publicKey = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(input.signer.verificationKey)]), format: 'der', type: 'spki',
  });
  if (!verify(null, Buffer.from(digest), publicKey, Buffer.from(signature))) throw new Error('solver signature does not verify');
  const signed = solverQuote({ ...unsignedQuote, signature }, 'arbitrumSepoliaExitQuote');
  return Object.freeze({
    version: 1 as const,
    status: 'SIGNED' as const,
    idempotencyKey: request.idempotencyKey,
    orderHash: request.orderHash,
    routeHash: hex(routeHash(validatedRoute)),
    quoteHash: hex(quoteHash(signed)),
    solverSignatureDigest: hex(solverSignatureDigest(signed)),
    routeBytes: hex(routePayloadBytes(validatedRoute)),
    solverQuoteBytes: hex(solverQuoteBytes(signed)),
    route: toProtocolJson(validatedRoute, 'route'),
    quote: toProtocolJson(signed, 'quote'),
  });
}

/**
 * Signs EXECUTION_COMMITMENT quotes for Arbitrum Sepolia EXIT orders from the live reference, the
 * factory's spot pool, the GMX fee, and the owner's open package on chain. Every other order is
 * delegated unchanged to the existing quote coordinator.
 */
export function createArbitrumSepoliaExitQuotePort(
  input: ArbitrumSepoliaExitQuoteInput,
  fallback: InternalAtomicQuotePort,
): InternalAtomicQuotePort {
  validateArbitrumSepoliaQuoteRuntimeInput(input);
  if (typeof input.orders !== 'function' || typeof input.signer?.signDigest !== 'function'
    || typeof input.store?.get !== 'function') {
    throw new Error('Arbitrum Sepolia exit quotes require the order provider, signer, and store');
  }
  const pending = new Map<string, Promise<InternalAtomicQuoteResponse>>();
  return Object.freeze({
    async quote(request: InternalAtomicQuoteRequest): Promise<InternalAtomicQuoteResponse> {
      if (typeof request?.orderHash !== 'string' || !HASH_HEX.test(request.orderHash)) return fallback.quote(request);
      const supplied = await input.orders(Uint8Array.from(Buffer.from(request.orderHash, 'hex')) as Hash32);
      if (supplied === undefined || supplied.domain.domainId !== ARBITRUM_SEPOLIA_DOMAIN_ID || supplied.action !== 'EXIT') {
        return fallback.quote(request);
      }
      const prior = input.store.get(request.idempotencyKey);
      if (prior !== undefined) {
        if (prior.orderHash !== request.orderHash) {
          throw new InternalAtomicQuoteError('IDEMPOTENCY_CONFLICT', 'idempotencyKey is already bound to a different order');
        }
        return prior.response;
      }
      const order = validatePackageOrderProfile(supplied, 'packageOrder');
      if (hex(packageOrderHash(order)) !== request.orderHash) {
        throw new InternalAtomicQuoteError('ORDER_HASH_MISMATCH', 'stored order does not match the requested hash');
      }
      const active = pending.get(request.idempotencyKey);
      if (active !== undefined) return active;
      const task = signExit(order, request, input)
        .then((response) => input.store.save({ orderHash: request.orderHash, response }).response);
      pending.set(request.idempotencyKey, task);
      try {
        return await task;
      } finally {
        pending.delete(request.idempotencyKey);
      }
    },
  });
}

/** Enabled with the Arbitrum Sepolia quote runtime, from the same reviewed quote configuration. */
export function loadArbitrumSepoliaExitQuotes(
  env: NodeJS.ProcessEnv,
  dependencies: Readonly<{
    nonceSource: AtomicQuoteNonceSource;
    orders: InternalAtomicQuoteOrderProvider;
    signer: Ed25519AtomicQuoteSigner;
    store: InternalAtomicQuoteStore;
    chain?: ArbitrumSepoliaReadPort;
  }>,
): Readonly<{ wrap(port: InternalAtomicQuotePort): InternalAtomicQuotePort }> | undefined {
  const market = loadArbitrumSepoliaQuoteMarketConfig(env);
  if (market === undefined) return undefined;
  const input: ArbitrumSepoliaExitQuoteInput = {
    ...market,
    chain: dependencies.chain ?? createViemArbitrumSepoliaReadPort(env.NARYX_ARBITRUM_SEPOLIA_RPC_URL ?? ''),
    nonceSource: dependencies.nonceSource,
    orders: dependencies.orders,
    signer: dependencies.signer,
    store: dependencies.store,
  };
  validateArbitrumSepoliaQuoteRuntimeInput(input);
  return Object.freeze({ wrap: (port: InternalAtomicQuotePort) => createArbitrumSepoliaExitQuotePort(input, port) });
}
