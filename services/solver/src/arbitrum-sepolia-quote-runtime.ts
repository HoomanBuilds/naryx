import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import {
  adapterRef,
  assetRef,
  bytesEqual,
  canonicalBytes,
  compareBytes,
  domainRef,
  encodeAssetRef,
  exactPrice,
  exactSignedRate,
  manifestHash,
  parseProtocolJson,
  routeHash,
  versionedManifestRef,
  type ActionCommitmentInput,
  type AdapterRef,
  type AssetRef,
  type DomainRef,
  type EvidenceRequirementsInput,
  type ExactPrice,
  type Hash32,
  type PackageOrder,
  type RouteAccountBindingInput,
  type RoutePayloadInput,
  type VersionedManifestRef,
} from '@naryx/protocol-types';
import type { Address } from 'viem';
import type { AtomicRouteCandidate, AtomicRouteDecision } from './atomic-route-decision.js';
import type { AtomicQuoteNonceSource } from './configured-atomic-market.js';
import type { QuoteProviders } from './hyperliquid-testnet-quote-runtime.js';
import type {
  InternalAtomicQuoteCandidateProvider,
  InternalAtomicQuoteTermsProvider,
} from './internal-atomic-quote-server.js';
import type { AtomicEntryQuoteTerms } from './signed-atomic-entry-quote.js';
import {
  ARBITRUM_SEPOLIA_DOMAIN_ID,
  createViemArbitrumSepoliaReadPort,
  priceArbitrumEntry,
  readArbitrumSepoliaReferencePrice,
  readGmxPositionFeeFactor,
  requireArbitrumSepoliaCode,
  type ArbitrumSepoliaContractIdentity,
  type ArbitrumSepoliaReadPort,
} from './arbitrum-sepolia-gmx.js';

export const ARBITRUM_SEPOLIA_QUOTE_ENABLED_ENV = 'NARYX_ARBITRUM_SEPOLIA_QUOTE_ENABLED';
export const ARBITRUM_SEPOLIA_QUOTE_CONFIG_VERSION = 1;

const BPS_SCALE = 10_000n;
const U64_MAX = (1n << 64n) - 1n;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const MAX_PREPARED_QUOTES = 64;

export interface ArbitrumSepoliaQuoteLeg {
  readonly adapter: AdapterRef;
  readonly venue: VersionedManifestRef;
  readonly market: VersionedManifestRef;
  readonly action: ActionCommitmentInput;
}

export interface ArbitrumSepoliaRecoveryIdentity {
  readonly policyVersion: number;
  readonly controllerId: string;
  readonly controllerCodeHash: Uint8Array | string;
  readonly authorityModeId: string;
  readonly reconciledStateSchemaHash: Uint8Array | string;
  readonly actionBuilderCodeHash: Uint8Array | string;
}

export interface ArbitrumSepoliaQuoteMarketConfig {
  readonly domain: DomainRef;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly packageTemplateManifestHash: Uint8Array | string;
  readonly templateRegistryRecordHash: Uint8Array | string;
  readonly candidateId: string;
  readonly capacityBaseAtoms: bigint;
  readonly solverId: string;
  readonly solverCapabilityManifestHash: Uint8Array | string;
  readonly feePolicyVersion: number;
  readonly feePolicyManifestHash: Uint8Array | string;
  readonly routeTtlSeconds: bigint;
  readonly venueWindowSeconds: bigint;
  readonly recoveryWindowSeconds: bigint;
  readonly marginBps: number;
  readonly perpSlippageBps: number;
  readonly rollbackSlippageBps: number;
  readonly baseAsset: AssetRef;
  readonly quoteAsset: AssetRef;
  /** The isolated account owner (beneficiary). Per-user accounts are not supported yet. */
  readonly owner: Address;
  /** The GmxV2IsolatedAccount that settles every package. */
  readonly settlementAccount: Address;
  readonly priceFeed: ArbitrumSepoliaContractIdentity;
  readonly priceFeedDecimals: number;
  readonly maxPriceAgeSeconds: bigint;
  readonly gmxDataStore: ArbitrumSepoliaContractIdentity;
  readonly gmxMarket: Address;
  readonly spot: ArbitrumSepoliaQuoteLeg;
  readonly perpetual: ArbitrumSepoliaQuoteLeg;
  readonly accountBindings: readonly RouteAccountBindingInput[];
  readonly preconditions: RoutePayloadInput['preconditions'];
  readonly postconditions: RoutePayloadInput['postconditions'];
  readonly evidenceRequirements: EvidenceRequirementsInput;
  readonly recovery: ArbitrumSepoliaRecoveryIdentity;
}

export interface ArbitrumSepoliaQuoteRuntimeInput extends ArbitrumSepoliaQuoteMarketConfig {
  readonly chain: ArbitrumSepoliaReadPort;
  readonly nonceSource: AtomicQuoteNonceSource;
}

function sameAsset(left: AssetRef, right: AssetRef): boolean {
  return left.assetId === right.assetId
    && left.decimals === right.decimals
    && bytesEqual(left.assetManifestHash, right.assetManifestHash);
}

function sameAdapter(left: AdapterRef, right: AdapterRef): boolean {
  return left.adapterId === right.adapterId
    && left.adapterManifestVersion === right.adapterManifestVersion
    && bytesEqual(left.adapterManifestHash, right.adapterManifestHash);
}

function sameDomain(left: DomainRef, right: DomainRef): boolean {
  return left.domainId === right.domainId
    && left.domainManifestVersion === right.domainManifestVersion
    && bytesEqual(left.domainManifestHash, right.domainManifestHash);
}

function bps(value: number, name: string): bigint {
  if (!Number.isSafeInteger(value) || value < 0 || value >= 10_000) {
    throw new Error(`${name} must be an integer from 0 through 9999`);
  }
  return BigInt(value);
}

function positiveSeconds(value: bigint, name: string): bigint {
  if (typeof value !== 'bigint' || value <= 0n || value > U64_MAX) {
    throw new Error(`${name} must be a positive u64`);
  }
  return value;
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left;
  let b = right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function reducedPrice(
  base: AssetRef,
  quote: AssetRef,
  quoteAtoms: bigint,
  baseAtoms: bigint,
  roundingDirection: 'FLOOR' | 'CEIL',
): ExactPrice {
  const divisor = gcd(quoteAtoms, baseAtoms);
  return exactPrice({
    baseAsset: base, quoteAsset: quote,
    quoteAtoms: quoteAtoms / divisor, baseAtoms: baseAtoms / divisor, roundingDirection,
  });
}

function validateConfiguration(input: ArbitrumSepoliaQuoteRuntimeInput): void {
  try {
    if (input.domain.domainId !== ARBITRUM_SEPOLIA_DOMAIN_ID
      || input.capacityBaseAtoms <= 0n
      || typeof input.nonceSource?.next !== 'function'
      || typeof input.chain?.chainId !== 'function'
      || !ADDRESS.test(input.owner) || !ADDRESS.test(input.settlementAccount)
      || !ADDRESS.test(input.gmxMarket.toLowerCase())
      || !Number.isSafeInteger(input.priceFeedDecimals) || input.priceFeedDecimals < 0
      || input.priceFeedDecimals > 36
      || input.accountBindings.length === 0
      || input.spot.action.sequence !== 0
      || input.perpetual.action.sequence !== 1
      || !sameAdapter(input.spot.action.adapter!, input.spot.adapter)
      || !sameAdapter(input.perpetual.action.adapter!, input.perpetual.adapter)
      || input.recovery.controllerId.length === 0
      || input.recovery.authorityModeId.length === 0) {
      throw new Error('missing required configuration');
    }
    domainRef(input.domain.domainId, input.domain.domainManifestVersion, input.domain.domainManifestHash);
    for (const value of [
      input.packageTemplateManifestHash, input.templateRegistryRecordHash,
      input.solverCapabilityManifestHash, input.feePolicyManifestHash,
      input.recovery.controllerCodeHash, input.recovery.reconciledStateSchemaHash,
      input.recovery.actionBuilderCodeHash,
    ]) manifestHash(value);
    const base = assetRef(input.baseAsset.assetId, input.baseAsset.assetManifestHash, input.baseAsset.decimals);
    const quote = assetRef(input.quoteAsset.assetId, input.quoteAsset.assetManifestHash, input.quoteAsset.decimals);
    if (sameAsset(base, quote)) throw new Error('base and quote assets must differ');
    for (const leg of [input.spot, input.perpetual]) {
      adapterRef(leg.adapter);
      versionedManifestRef(leg.venue.subjectId, leg.venue.manifestVersion, leg.venue.manifestHash);
      versionedManifestRef(leg.market.subjectId, leg.market.manifestVersion, leg.market.manifestHash);
    }
    positiveSeconds(input.routeTtlSeconds, 'routeTtlSeconds');
    positiveSeconds(input.venueWindowSeconds, 'venueWindowSeconds');
    positiveSeconds(input.recoveryWindowSeconds, 'recoveryWindowSeconds');
    positiveSeconds(input.maxPriceAgeSeconds, 'maxPriceAgeSeconds');
    if (bps(input.marginBps, 'marginBps') === 0n) throw new Error('margin must be positive');
    bps(input.perpSlippageBps, 'perpSlippageBps');
    bps(input.rollbackSlippageBps, 'rollbackSlippageBps');
  } catch {
    throw new Error('Arbitrum Sepolia quote runtime configuration is incomplete or invalid');
  }
}

function requireOrder(order: PackageOrder, input: ArbitrumSepoliaQuoteRuntimeInput): void {
  if (order.environment !== 'testnet'
    || order.settlementClass !== 'ASYNC_BONDED_SOLVER'
    || order.expiryUnit !== 'EVM_UNIX_SECONDS'
    || order.action !== 'ENTRY'
    || !sameDomain(order.domain, input.domain)) {
    throw new Error('order is outside the configured Arbitrum Sepolia quote domain');
  }
  if (order.templateId !== input.templateId
    || order.templateVersion !== input.templateVersion
    || !bytesEqual(order.packageTemplateManifestHash, manifestHash(input.packageTemplateManifestHash))) {
    throw new Error('order package template does not match the configured manifest');
  }
  // Until a per-user isolated account factory exists, only the configured account may trade.
  if (order.owner.toLowerCase() !== input.owner || order.settlementAccount.toLowerCase() !== input.settlementAccount) {
    throw new Error('order owner or settlement account is not the configured isolated account');
  }
  if (!order.permittedSpotAdapters.some((adapter) => sameAdapter(adapter, input.spot.adapter))
    || !order.permittedPerpAdapters.some((adapter) => sameAdapter(adapter, input.perpetual.adapter))) {
    throw new Error('configured Arbitrum adapters are not permitted by the order');
  }
  const quoteAsset = order.maxSpotQuoteIn?.asset;
  if (quoteAsset === undefined || !sameAsset(input.baseAsset, order.quantity.asset)
    || !sameAsset(input.quoteAsset, quoteAsset)) {
    throw new Error('configured Arbitrum market assets do not match the order');
  }
  if (order.quantity.atoms > input.capacityBaseAtoms) throw new Error('order exceeds configured capacity');
}

async function build(order: PackageOrder, orderHash: Hash32, input: ArbitrumSepoliaQuoteRuntimeInput) {
  requireOrder(order, input);
  const base = input.baseAsset;
  const quoteAsset = input.quoteAsset;
  const reference = await readArbitrumSepoliaReferencePrice(input.chain, {
    feed: input.priceFeed,
    decimals: input.priceFeedDecimals,
    maxAgeSeconds: input.maxPriceAgeSeconds,
  });
  await requireArbitrumSepoliaCode(input.chain, input.gmxDataStore, 'GMX data store');
  const positionFeeFactor = await readGmxPositionFeeFactor(input.chain, input.gmxDataStore.address, input.gmxMarket);
  const now = reference.observedAt;
  if (now >= order.expiryValue) throw new Error('order is expired');
  const pricing = priceArbitrumEntry({
    quantityAtoms: order.quantity.atoms,
    baseDecimals: base.decimals,
    quoteDecimals: quoteAsset.decimals,
    reference,
    positionFeeFactor,
    marginBps: BigInt(input.marginBps),
  });
  if (pricing.spotNotionalAtoms > order.maxSpotQuoteIn!.atoms) throw new Error('spot cost exceeds the order cap');
  if (pricing.marginAtoms > order.maxMarginAdded.atoms) throw new Error('margin exceeds the order cap');
  const feeCap = order.maxVenueFeeAtomsByAsset.find((cap) => sameAsset(cap.asset, quoteAsset));
  if (feeCap === undefined || pricing.positionFeeAtoms > feeCap.maxAtoms) {
    throw new Error('GMX position fee exceeds the signed venue fee cap');
  }

  // Quote validity equals the route expiry; the GMX request must be submitted before it.
  const routeExpiryValue = order.expiryValue < now + input.routeTtlSeconds
    ? order.expiryValue
    : now + input.routeTtlSeconds;
  const maxActionExpiryValue = routeExpiryValue + input.venueWindowSeconds;
  const deadlineValue = maxActionExpiryValue + input.recoveryWindowSeconds;
  if (routeExpiryValue <= now || deadlineValue > U64_MAX) throw new Error('configured freshness window is empty');

  const referenceQuoteAtoms = reference.answer * 10n ** BigInt(quoteAsset.decimals);
  const referenceBaseAtoms = 10n ** BigInt(reference.decimals + base.decimals);
  const floorAt = (slippageBps: number) => reducedPrice(
    base, quoteAsset,
    referenceQuoteAtoms * (BPS_SCALE - BigInt(slippageBps)), referenceBaseAtoms * BPS_SCALE, 'CEIL',
  );
  const zeroBase = { asset: base, atoms: 0n };
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
    action: order.action,
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
        baseAsset: base, quoteAsset, side: 'BUY', quantity: order.quantity,
        limitPrice: reducedPrice(base, quoteAsset, order.maxSpotQuoteIn!.atoms, order.quantity.atoms, 'FLOOR'),
        timeInForce: 'FOK', reduceOnly: false,
      },
      {
        legIndex: 1, legRole: 'PERPETUAL', actionSequence: input.perpetual.action.sequence,
        adapter: input.perpetual.adapter, venue: input.perpetual.venue, market: input.perpetual.market,
        baseAsset: base, quoteAsset, side: 'SELL', quantity: order.quantity,
        limitPrice: floorAt(input.perpSlippageBps), timeInForce: 'FOK', reduceOnly: false,
      },
    ],
    actions: [input.spot.action, input.perpetual.action],
    postconditions: input.postconditions,
    evidenceRequirements: input.evidenceRequirements,
    // The coordinator's CANCEL_OR_RECONCILE policy cancels the GMX request and sells the spot leg back.
    // Recovery is paid from the solver bond and reserve, so the trader-facing recovery cost cap is zero.
    recoveryPlan: {
      ...input.recovery,
      recoveryExpiryUnit: 'EVM_UNIX_SECONDS',
      maxActionExpiryValue,
      deadlineValue,
      minRecoveryWindowMs: input.recoveryWindowSeconds * 1_000n,
      maxRecoveryCostCaps: [{ asset: quoteAsset, maxAtoms: 0n }],
      maxAggregateRecoveryLoss: order.maxAggregateRecoveryLossQuote,
      maxIntermediateResidual: order.quantity,
      maxTerminalResidual: zeroBase,
      actionSlots: [
        {
          sequence: 0, action: 'CANCEL_OPEN_ORDERS', targetLeg: 1,
          adapter: input.perpetual.adapter, markets: [input.perpetual.market],
        },
        {
          sequence: 1, action: 'ROLLBACK_SPOT', targetLeg: 0,
          adapter: input.spot.adapter, markets: [input.spot.market],
          maxQuantity: order.quantity, limitPrice: floorAt(input.rollbackSlippageBps),
          reduceOnly: false, timeInForce: 'IOC',
        },
      ],
    },
  };
  // entrySpread = spot notional / quantity - perpetual notional / quantity.
  const spreadNumerator = pricing.spotNotionalAtoms - pricing.perpNotionalAtoms;
  const spreadDivisor = spreadNumerator === 0n ? order.quantity.atoms : gcd(
    spreadNumerator < 0n ? -spreadNumerator : spreadNumerator,
    order.quantity.atoms,
  );
  // GMX charges the position fee in collateral; the exact-output spot buy charges no base-asset fee.
  const assetKey = (asset: AssetRef) => canonicalBytes((writer) => encodeAssetRef(writer, asset));
  const canonical = (amounts: readonly { asset: AssetRef; atoms: bigint }[]) =>
    [...amounts].sort((left, right) => compareBytes(assetKey(left.asset), assetKey(right.asset)));
  const venueFees = canonical([{ asset: base, atoms: 0n }, { asset: quoteAsset, atoms: pricing.positionFeeAtoms }]);
  const candidate: AtomicRouteCandidate = Object.freeze({
    candidateId: input.candidateId,
    active: true,
    capacityBaseAtoms: input.capacityBaseAtoms,
    expectedNetPackageOutcomeQuoteAtoms:
      pricing.perpNotionalAtoms - pricing.spotNotionalAtoms - pricing.positionFeeAtoms,
    expectedTotalFeesQuoteAtoms: pricing.positionFeeAtoms,
    evidenceGrade: 'ARBITRUM_SEPOLIA_REFERENCE',
    route,
  });
  const terms: Omit<AtomicEntryQuoteTerms, 'quoteNonce'> = Object.freeze({
    solverId: input.solverId,
    solverCapabilityManifestHash: input.solverCapabilityManifestHash,
    quotedOutcome: {
      kind: 'ENTRY_SPREAD' as const,
      entrySpread: exactSignedRate({
        baseAsset: base, quoteAsset,
        quoteAtoms: spreadNumerator / spreadDivisor, baseAtoms: order.quantity.atoms / spreadDivisor,
        roundingDirection: 'CEIL',
      }),
    },
    expectedSpotNotional: { asset: quoteAsset, atoms: pricing.spotNotionalAtoms },
    expectedPerpNotional: { asset: quoteAsset, atoms: pricing.perpNotionalAtoms },
    expectedGrossSpotQuantity: order.quantity,
    expectedNetSpotQuantity: order.quantity,
    expectedBaseAssetFee: zeroBase,
    expectedMarginDelta: { asset: quoteAsset, atoms: pricing.marginAtoms },
    expectedRawFillFeesByAsset: venueFees,
    expectedBuilderFeesByAsset: venueFees.map((fee) => ({ asset: fee.asset, atoms: 0n })),
    expectedNormalizedVenueFeesByAsset: venueFees,
    solverFee: { asset: quoteAsset, atoms: 0n },
    protocolFee: { asset: quoteAsset, atoms: 0n },
    expectedPriorityFee: { asset: quoteAsset, atoms: 0n },
    maxRecoveryCostAtomsByAsset: [],
    feePolicyVersion: input.feePolicyVersion,
    feePolicyManifestHash: input.feePolicyManifestHash,
    validUntilUnit: 'EVM_UNIX_SECONDS',
    validUntilValue: routeExpiryValue,
  });
  return Object.freeze({ candidate, terms });
}

export function createArbitrumSepoliaQuoteRuntime(input: ArbitrumSepoliaQuoteRuntimeInput): QuoteProviders {
  validateConfiguration(input);
  // Terms come from the same chain snapshot that produced the selected candidate.
  const prepared = new Map<string, Awaited<ReturnType<typeof build>>>();
  const key = (orderHash: Hash32) => Buffer.from(orderHash).toString('hex');
  const candidates: InternalAtomicQuoteCandidateProvider = async ({ order, orderHash }) => {
    const created = await build(order, orderHash, input);
    prepared.delete(key(orderHash));
    prepared.set(key(orderHash), created);
    while (prepared.size > MAX_PREPARED_QUOTES) prepared.delete(prepared.keys().next().value!);
    return [created.candidate];
  };
  const terms: InternalAtomicQuoteTermsProvider = ({ decision }: Readonly<{
    order: PackageOrder;
    decision: AtomicRouteDecision;
  }>) => {
    const created = prepared.get(key(decision.orderHash));
    if (created === undefined) throw new Error('no live Arbitrum Sepolia quote was prepared for the order');
    if (decision.candidateId !== input.candidateId
      || !bytesEqual(routeHash(created.candidate.route), decision.routeHash)
      || decision.expectedNetPackageOutcomeQuoteAtoms !== created.candidate.expectedNetPackageOutcomeQuoteAtoms
      || decision.expectedTotalFeesQuoteAtoms !== created.candidate.expectedTotalFeesQuoteAtoms) {
      throw new Error('route decision does not match the prepared Arbitrum Sepolia quote');
    }
    prepared.delete(key(decision.orderHash));
    const quoteNonce = input.nonceSource.next();
    if (quoteNonce <= 0n) throw new Error('quote nonce must be positive');
    return Object.freeze({ ...created.terms, quoteNonce });
  };
  return Object.freeze({ candidates, terms });
}

export function loadArbitrumSepoliaQuoteRuntime(
  env: NodeJS.ProcessEnv,
  dependencies: Readonly<{ nonceSource: AtomicQuoteNonceSource; chain?: ArbitrumSepoliaReadPort }>,
): QuoteProviders | undefined {
  const enabled = env[ARBITRUM_SEPOLIA_QUOTE_ENABLED_ENV];
  if (enabled === undefined || enabled === 'false') return undefined;
  if (enabled !== 'true') throw new Error(`${ARBITRUM_SEPOLIA_QUOTE_ENABLED_ENV} must be true or false`);
  const configuredPath = env.NARYX_ARBITRUM_SEPOLIA_QUOTE_CONFIG;
  if (configuredPath === undefined || !isAbsolute(configuredPath)) {
    throw new Error('NARYX_ARBITRUM_SEPOLIA_QUOTE_CONFIG must be an absolute path');
  }
  const decoded = parseProtocolJson(readFileSync(resolve(configuredPath), 'utf8'), 'arbitrumSepoliaQuoteConfig');
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)
    || (decoded as Record<string, unknown>).version !== ARBITRUM_SEPOLIA_QUOTE_CONFIG_VERSION
    || typeof (decoded as Record<string, unknown>).market !== 'object') {
    throw new Error(`Arbitrum Sepolia quote config must be version ${ARBITRUM_SEPOLIA_QUOTE_CONFIG_VERSION} with market`);
  }
  return createArbitrumSepoliaQuoteRuntime({
    ...((decoded as Record<string, unknown>).market as ArbitrumSepoliaQuoteMarketConfig),
    chain: dependencies.chain ?? createViemArbitrumSepoliaReadPort(env.NARYX_ARBITRUM_SEPOLIA_RPC_URL ?? ''),
    nonceSource: dependencies.nonceSource,
  });
}
