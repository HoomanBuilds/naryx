import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import {
  CHAINLINK_AGGREGATOR_ABI,
  NARYX_STRATEGY_ACCOUNT_FACTORY_ABI,
  NARYX_TEST_PERP_MARKET_ABI,
  UNISWAP_V3_POOL_ABI,
  equalAddress,
  requiredEvmAddress,
  type EvmDeploymentIdentity,
} from '@naryx/adapter-evm';
import {
  adapterRef,
  bytesEqual,
  domainRefFromManifest,
  exactPrice,
  exactSignedRate,
  manifestHash,
  parseProtocolJson,
  routeHash,
  versionedManifestRef,
  type ActionCommitmentInput,
  type AdapterRef,
  type AssetRef,
  type CashCarrySeriesBindingV1Input,
  type DomainRef,
  type EvidenceRequirementsInput,
  type ExactPrice,
  type Hash32,
  type PackageAdmissionInput,
  type PackageOrder,
  type RouteAccountBindingInput,
  type RoutePayloadInput,
  type VersionedManifestRef,
} from '@naryx/protocol-types';
import { createPublicClient, http, keccak256, type Abi, type Address, type Hex } from 'viem';
import type { AtomicRouteCandidate, AtomicRouteDecision } from './atomic-route-decision.js';
import type { AtomicQuoteNonceSource } from './configured-atomic-market.js';
import type { QuoteProviders } from './hyperliquid-testnet-quote-runtime.js';
import type {
  InternalAtomicQuoteCandidateProvider,
  InternalAtomicQuoteTermsProvider,
} from './internal-atomic-quote-server.js';
import type { AtomicEntryQuoteTerms } from './signed-atomic-entry-quote.js';

export const BASE_SEPOLIA_DOMAIN_ID = 'eip155:84532';
export const BASE_SEPOLIA_CHAIN_ID = 84_532n;
export const BASE_SEPOLIA_QUOTE_ENABLED_ENV = 'NARYX_BASE_SEPOLIA_QUOTE_ENABLED';

const BPS = 10_000n;
const FEE_SCALE = 1_000_000n;
const Q192 = 1n << 192n;
const U64_MAX = (1n << 64n) - 1n;
const MAX_PREPARED_QUOTES = 64;

/** Signerless Base Sepolia reads. Chain identity always comes from eth_chainId. */
export interface BaseSepoliaReadPort {
  chainId(): Promise<bigint>;
  codeHash(address: Address): Promise<Hex | undefined>;
  latestBlockTimestamp(): Promise<bigint>;
  readContract(request: Readonly<{
    address: Address;
    abi: Abi;
    functionName: string;
    args?: readonly unknown[];
  }>): Promise<unknown>;
}

/**
 * The reviewed deployment section of the Base Sepolia runtime manifest the API also loads. The
 * solver reads it as data so it prices and co-signs against the same identities.
 */
export interface BaseSepoliaSolverDeployment {
  readonly admission: Omit<PackageAdmissionInput, 'order' | 'quote' | 'route' | 'currentTime'>;
  readonly deployment: EvmDeploymentIdentity;
  readonly seriesBindingInput: CashCarrySeriesBindingV1Input;
  readonly executionPolicy: Readonly<{ solver: Address; oracleMoveAllowanceBps: number }>;
}

export interface BaseSepoliaQuoteLeg {
  readonly adapter: AdapterRef;
  readonly venue: VersionedManifestRef;
  readonly market: VersionedManifestRef;
  readonly action: ActionCommitmentInput;
}

export interface BaseSepoliaQuoteMarketConfig {
  readonly templateRegistryRecordHash: Uint8Array | string;
  readonly candidateId: string;
  readonly capacityBaseAtoms: bigint;
  readonly solverId: string;
  readonly solverCapabilityManifestHash: Uint8Array | string;
  readonly feePolicyVersion: number;
  readonly feePolicyManifestHash: Uint8Array | string;
  readonly routeTtlSeconds: bigint;
  /** Perp margin the quote asks the trader to post, as basis points of the perp entry notional. */
  readonly marginBps: number;
  readonly perpSlippageBps: number;
  readonly spot: BaseSepoliaQuoteLeg;
  readonly perpetual: BaseSepoliaQuoteLeg;
  /** The `strategyAccountBindingId` binding is rewritten to each order's own factory account. */
  readonly strategyAccountBindingId: string;
  readonly accountBindings: readonly RouteAccountBindingInput[];
  readonly preconditions: RoutePayloadInput['preconditions'];
  readonly postconditions: RoutePayloadInput['postconditions'];
  readonly evidenceRequirements: EvidenceRequirementsInput;
}

export interface BaseSepoliaQuoteRuntimeInput extends BaseSepoliaQuoteMarketConfig {
  readonly deployment: BaseSepoliaSolverDeployment;
  readonly chain: BaseSepoliaReadPort;
  readonly nonceSource: AtomicQuoteNonceSource;
}

export type BaseSepoliaEntryPricing = Readonly<{
  observedAt: bigint;
  oracleAnswer: bigint;
  oracleDecimals: number;
  spotNotionalAtoms: bigint;
  spotFeeAtoms: bigint;
  perpNotionalAtoms: bigint;
  perpFeeAtoms: bigint;
  marginAtoms: bigint;
}>;

function sameAsset(left: AssetRef, right: AssetRef): boolean {
  return left.assetId === right.assetId && left.decimals === right.decimals
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

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

export async function requireBaseSepoliaChain(chain: Pick<BaseSepoliaReadPort, 'chainId'>): Promise<void> {
  if (await chain.chainId() !== BASE_SEPOLIA_CHAIN_ID) throw new Error('Base Sepolia RPC eth_chainId is not 84532');
}

/** `accountOf(owner)` from the reviewed factory; the only settlement account an order may name. */
export async function readBaseSepoliaAccountOf(
  chain: BaseSepoliaReadPort,
  deployment: EvmDeploymentIdentity,
  owner: string,
): Promise<Address> {
  const factory = requiredEvmAddress(deployment.strategyAccountFactory.address, 'strategyAccountFactory');
  return requiredEvmAddress(String(await chain.readContract({
    address: factory,
    abi: NARYX_STRATEGY_ACCOUNT_FACTORY_ABI as Abi,
    functionName: 'accountOf',
    args: [requiredEvmAddress(owner, 'order.owner')],
  })), 'accountOf(owner)');
}

/**
 * Prices an entry from live state: the Uniswap pool's slot0 mid plus its fee for the exact-output
 * spot buy (rounded up), and the market's own `previewOpen` for the perp fill and taker fee. The
 * market reverts `previewOpen` on a stale or incomplete Chainlink round, so a stale oracle fails here.
 */
export async function priceBaseSepoliaEntry(
  chain: BaseSepoliaReadPort,
  deployment: EvmDeploymentIdentity,
  quantityAtoms: bigint,
  marginBps: bigint,
): Promise<BaseSepoliaEntryPricing> {
  await requireBaseSepoliaChain(chain);
  const pool = requiredEvmAddress(deployment.spot.market.address, 'spot.market');
  const market = requiredEvmAddress(deployment.perpetual.market.address, 'perpetual.market');
  const baseToken = requiredEvmAddress(deployment.baseAsset.address, 'baseAsset');
  const read = (address: Address, abi: Abi, functionName: string, args?: readonly unknown[]) =>
    chain.readContract({ address, abi, functionName, ...(args === undefined ? {} : { args }) });
  if (deployment.baseAsset.decimals !== 18) throw new Error('Base Sepolia perp quantity requires an 18-decimal base asset');
  const [slot0, token0, poolFee, oracle, collateralScale, preview, observedAt] = await Promise.all([
    read(pool, UNISWAP_V3_POOL_ABI as Abi, 'slot0'),
    read(pool, UNISWAP_V3_POOL_ABI as Abi, 'token0'),
    read(pool, UNISWAP_V3_POOL_ABI as Abi, 'fee'),
    read(market, NARYX_TEST_PERP_MARKET_ABI as Abi, 'oracle'),
    read(market, NARYX_TEST_PERP_MARKET_ABI as Abi, 'collateralScale'),
    read(market, NARYX_TEST_PERP_MARKET_ABI as Abi, 'previewOpen', [-quantityAtoms, 0n]),
    chain.latestBlockTimestamp(),
  ]);
  const feed = requiredEvmAddress(String(oracle), 'market.oracle');
  const [decimals, round] = await Promise.all([
    read(feed, CHAINLINK_AGGREGATOR_ABI as Abi, 'decimals'),
    read(feed, CHAINLINK_AGGREGATOR_ABI as Abi, 'latestRoundData'),
  ]);
  const sqrtPrice = (slot0 as readonly unknown[])[0];
  const answer = (round as readonly unknown[])[1];
  const [, entryNotionalWad, feeWad] = preview as readonly unknown[];
  if (typeof sqrtPrice !== 'bigint' || sqrtPrice <= 0n || typeof answer !== 'bigint' || answer <= 0n
    || typeof collateralScale !== 'bigint' || collateralScale <= 0n
    || typeof entryNotionalWad !== 'bigint' || entryNotionalWad <= 0n || typeof feeWad !== 'bigint') {
    throw new Error('Base Sepolia market reads are invalid');
  }
  const squared = sqrtPrice * sqrtPrice;
  const baseIsToken0 = equalAddress(requiredEvmAddress(String(token0), 'pool.token0'), baseToken);
  const [midNumerator, midDenominator] = baseIsToken0 ? [squared, Q192] : [Q192, squared];
  const fee = BigInt(Number(poolFee));
  const spotMidAtoms = ceilDiv(quantityAtoms * midNumerator, midDenominator);
  const spotNotionalAtoms = ceilDiv(quantityAtoms * midNumerator * (FEE_SCALE + fee), midDenominator * FEE_SCALE);
  const perpNotionalAtoms = entryNotionalWad / collateralScale;
  const perpFeeAtoms = ceilDiv(feeWad, collateralScale);
  if (spotNotionalAtoms <= 0n || perpNotionalAtoms <= 0n) throw new Error('Base Sepolia entry notional is zero');
  return Object.freeze({
    observedAt,
    oracleAnswer: answer,
    oracleDecimals: Number(decimals),
    spotNotionalAtoms,
    spotFeeAtoms: spotNotionalAtoms - spotMidAtoms,
    perpNotionalAtoms,
    perpFeeAtoms,
    marginAtoms: ceilDiv(perpNotionalAtoms * marginBps, BPS) + perpFeeAtoms,
  });
}

function validateConfiguration(input: BaseSepoliaQuoteRuntimeInput): void {
  try {
    const deployment = input.deployment.deployment;
    if (deployment.domainManifest.domainId !== BASE_SEPOLIA_DOMAIN_ID
      || input.capacityBaseAtoms <= 0n
      || typeof input.nonceSource?.next !== 'function'
      || typeof input.chain?.chainId !== 'function'
      || input.spot.action.sequence !== 0
      || input.perpetual.action.sequence !== 1
      || !sameAdapter(input.spot.action.adapter!, input.spot.adapter)
      || !sameAdapter(input.perpetual.action.adapter!, input.perpetual.adapter)
      || !input.accountBindings.some((binding) => binding.routeBindingId === input.strategyAccountBindingId)
      || !Number.isSafeInteger(input.marginBps) || input.marginBps <= 0 || input.marginBps >= 10_000
      || !Number.isSafeInteger(input.perpSlippageBps) || input.perpSlippageBps < 0 || input.perpSlippageBps >= 10_000
      || typeof input.routeTtlSeconds !== 'bigint' || input.routeTtlSeconds <= 0n || input.routeTtlSeconds > U64_MAX) {
      throw new Error('missing required configuration');
    }
    for (const value of [
      input.templateRegistryRecordHash, input.solverCapabilityManifestHash, input.feePolicyManifestHash,
    ]) manifestHash(value);
    for (const leg of [input.spot, input.perpetual]) {
      adapterRef(leg.adapter);
      versionedManifestRef(leg.venue.subjectId, leg.venue.manifestVersion, leg.venue.manifestHash);
      versionedManifestRef(leg.market.subjectId, leg.market.manifestVersion, leg.market.manifestHash);
    }
    requiredEvmAddress(input.deployment.executionPolicy.solver, 'executionPolicy.solver');
  } catch {
    throw new Error('Base Sepolia quote runtime configuration is incomplete or invalid');
  }
}

function requireOrder(order: PackageOrder, input: BaseSepoliaQuoteRuntimeInput): void {
  const deployment = input.deployment.deployment;
  const admission = input.deployment.admission;
  if (order.environment !== 'testnet'
    || order.settlementClass !== 'ATOMIC_POSTCONDITION'
    || order.expiryUnit !== 'EVM_UNIX_SECONDS'
    || order.action !== 'ENTRY'
    || !sameDomain(order.domain, domainRefFromManifest(deployment.domainManifest))) {
    throw new Error('order is outside the configured Base Sepolia quote domain');
  }
  if (order.templateId !== admission.templateManifest.templateId
    || order.templateVersion !== admission.templateManifest.templateVersion) {
    throw new Error('order package template does not match the configured manifest');
  }
  if (!order.permittedSpotAdapters.some((adapter) => sameAdapter(adapter, input.spot.adapter))
    || !order.permittedPerpAdapters.some((adapter) => sameAdapter(adapter, input.perpetual.adapter))) {
    throw new Error('configured Base adapters are not permitted by the order');
  }
  if (order.maxSpotQuoteIn === undefined) throw new Error('entry order has no spot quote cap');
  if (order.quantity.atoms > input.capacityBaseAtoms) throw new Error('order exceeds configured capacity');
}

async function build(order: PackageOrder, orderHash: Hash32, input: BaseSepoliaQuoteRuntimeInput) {
  requireOrder(order, input);
  const deployment = input.deployment.deployment;
  const account = await readBaseSepoliaAccountOf(input.chain, deployment, order.owner);
  if (!equalAddress(account, requiredEvmAddress(order.settlementAccount, 'order.settlementAccount'))) {
    throw new Error('order settlement account is not the owner factory account');
  }
  const pricing = await priceBaseSepoliaEntry(
    input.chain, deployment, order.quantity.atoms, BigInt(input.marginBps),
  );
  const now = pricing.observedAt;
  if (now >= order.expiryValue) throw new Error('order is expired');
  const quoteAsset = order.maxSpotQuoteIn!.asset;
  const base = order.quantity.asset;
  if (pricing.spotNotionalAtoms > order.maxSpotQuoteIn!.atoms) throw new Error('spot cost exceeds the order cap');
  if (pricing.marginAtoms > order.maxMarginAdded.atoms) throw new Error('margin exceeds the order cap');
  const venueFeeAtoms = pricing.spotFeeAtoms + pricing.perpFeeAtoms;
  const feeCap = order.maxVenueFeeAtomsByAsset.find((cap) => sameAsset(cap.asset, quoteAsset));
  if (feeCap === undefined || venueFeeAtoms > feeCap.maxAtoms) throw new Error('venue fees exceed the signed cap');

  // Atomic quotes end with their route, and the package deadline is the earliest of the three.
  const routeExpiryValue = order.expiryValue < now + input.routeTtlSeconds
    ? order.expiryValue
    : now + input.routeTtlSeconds;
  if (routeExpiryValue <= now) throw new Error('configured freshness window is empty');
  const referenceQuoteAtoms = pricing.oracleAnswer * 10n ** BigInt(quoteAsset.decimals);
  const referenceBaseAtoms = 10n ** BigInt(pricing.oracleDecimals + base.decimals);
  const accountBindings = input.accountBindings.map((binding) => binding.routeBindingId === input.strategyAccountBindingId
    ? { ...binding, accountIdentity: order.settlementAccount, ownerIdentity: order.owner }
    : binding);
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
    quantityPolicyClass: 'EXACT_ATOMIC',
    partialFillPolicy: order.partialFillPolicy,
    settlementClass: 'ATOMIC_POSTCONDITION',
    executionPlanKind: 'EVM_ATOMIC_BATCH',
    routeExpiryUnit: 'EVM_UNIX_SECONDS',
    routeExpiryValue,
    feePolicyVersion: input.feePolicyVersion,
    feePolicyManifestHash: input.feePolicyManifestHash,
    accountBindings,
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
        limitPrice: reducedPrice(
          base, quoteAsset,
          referenceQuoteAtoms * (BPS - BigInt(input.perpSlippageBps)), referenceBaseAtoms * BPS, 'CEIL',
        ),
        timeInForce: 'FOK', reduceOnly: false,
      },
    ],
    actions: [input.spot.action, input.perpetual.action],
    postconditions: input.postconditions,
    evidenceRequirements: input.evidenceRequirements,
  };
  const spreadNumerator = pricing.spotNotionalAtoms - pricing.perpNotionalAtoms;
  const spreadDivisor = spreadNumerator === 0n ? order.quantity.atoms : gcd(
    spreadNumerator < 0n ? -spreadNumerator : spreadNumerator,
    order.quantity.atoms,
  );
  const venueFees = [{ asset: quoteAsset, atoms: venueFeeAtoms }];
  const zeroBase = { asset: base, atoms: 0n };
  const candidate: AtomicRouteCandidate = Object.freeze({
    candidateId: input.candidateId,
    active: true,
    capacityBaseAtoms: input.capacityBaseAtoms,
    expectedNetPackageOutcomeQuoteAtoms: pricing.perpNotionalAtoms - pricing.spotNotionalAtoms - pricing.perpFeeAtoms,
    expectedTotalFeesQuoteAtoms: venueFeeAtoms,
    evidenceGrade: 'BASE_SEPOLIA_LIVE_POOL_AND_ORACLE',
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
    expectedBuilderFeesByAsset: [{ asset: quoteAsset, atoms: 0n }],
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

export function createBaseSepoliaQuoteRuntime(input: BaseSepoliaQuoteRuntimeInput): QuoteProviders {
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
    if (created === undefined) throw new Error('no live Base Sepolia quote was prepared for the order');
    if (decision.candidateId !== input.candidateId
      || !bytesEqual(routeHash(created.candidate.route), decision.routeHash)
      || decision.expectedNetPackageOutcomeQuoteAtoms !== created.candidate.expectedNetPackageOutcomeQuoteAtoms
      || decision.expectedTotalFeesQuoteAtoms !== created.candidate.expectedTotalFeesQuoteAtoms) {
      throw new Error('route decision does not match the prepared Base Sepolia quote');
    }
    prepared.delete(key(decision.orderHash));
    const quoteNonce = input.nonceSource.next();
    if (quoteNonce <= 0n) throw new Error('quote nonce must be positive');
    return Object.freeze({ ...created.terms, quoteNonce });
  };
  return Object.freeze({ candidates, terms });
}

/** Routes Base Sepolia orders to the Base providers and everything else to the existing composition. */
export function withBaseSepoliaQuoteProviders(
  base: QuoteProviders | undefined,
  others: QuoteProviders,
): QuoteProviders {
  if (base === undefined) return others;
  const select = (order: PackageOrder) =>
    order.environment === 'testnet' && order.domain.domainId === BASE_SEPOLIA_DOMAIN_ID ? base : others;
  return Object.freeze({
    candidates: (value) => select(value.order).candidates(value),
    terms: (value) => select(value.order).terms(value),
  } satisfies QuoteProviders);
}

function absoluteJson(path: string | undefined, name: string, label: string): unknown {
  if (path === undefined || !isAbsolute(path)) throw new Error(`${name} must be an absolute path`);
  return parseProtocolJson(readFileSync(resolve(path), 'utf8'), label);
}

/** The deployment section of the API's Base Sepolia runtime manifest, validated for the solver. */
export function loadBaseSepoliaSolverDeployment(path: string | undefined): BaseSepoliaSolverDeployment {
  const manifest = absoluteJson(path, 'NARYX_BASE_SEPOLIA_RUNTIME_MANIFEST', 'baseSepoliaRuntimeManifest') as
    Record<string, unknown> | null;
  const deployment = manifest?.deployment as BaseSepoliaSolverDeployment | undefined;
  if (manifest?.schemaVersion !== 1 || manifest.activationState !== 'ACTIVE' || deployment === undefined
    || deployment.deployment?.domainManifest?.domainId !== BASE_SEPOLIA_DOMAIN_ID
    || deployment.deployment.deploymentChainReference !== BASE_SEPOLIA_CHAIN_ID
    || typeof deployment.executionPolicy?.solver !== 'string') {
    throw new Error('Base Sepolia runtime manifest must be an ACTIVE schema version 1 Base deployment');
  }
  return deployment;
}

export function loadBaseSepoliaQuoteRuntime(
  env: NodeJS.ProcessEnv,
  dependencies: Readonly<{
    nonceSource: AtomicQuoteNonceSource;
    deployment: BaseSepoliaSolverDeployment;
    chain: BaseSepoliaReadPort;
  }>,
): QuoteProviders {
  const decoded = absoluteJson(env.NARYX_BASE_SEPOLIA_QUOTE_CONFIG, 'NARYX_BASE_SEPOLIA_QUOTE_CONFIG', 'baseSepoliaQuoteConfig');
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)
    || (decoded as Record<string, unknown>).version !== 1
    || typeof (decoded as Record<string, unknown>).market !== 'object') {
    throw new Error('Base Sepolia quote config must be version 1 with market');
  }
  return createBaseSepoliaQuoteRuntime({
    ...((decoded as Record<string, unknown>).market as BaseSepoliaQuoteMarketConfig),
    deployment: dependencies.deployment,
    chain: dependencies.chain,
    nonceSource: dependencies.nonceSource,
  });
}

export function createViemBaseSepoliaReadPort(rpcUrl: string): BaseSepoliaReadPort {
  if (typeof rpcUrl !== 'string' || !/^https?:\/\//.test(rpcUrl)) {
    throw new Error('NARYX_BASE_SEPOLIA_RPC_URL must be an HTTP or HTTPS URL');
  }
  const client = createPublicClient({ transport: http(rpcUrl) });
  return Object.freeze({
    chainId: async () => BigInt(await client.getChainId()),
    codeHash: async (address: Address) => {
      const code = await client.getCode({ address });
      return code === undefined || code === '0x' ? undefined : keccak256(code);
    },
    latestBlockTimestamp: async () => (await client.getBlock({ blockTag: 'latest' })).timestamp,
    readContract: async (request: Parameters<BaseSepoliaReadPort['readContract']>[0]) => client.readContract({
      address: request.address,
      abi: request.abi,
      functionName: request.functionName,
      ...(request.args === undefined ? {} : { args: request.args }),
    } as never),
  });
}
