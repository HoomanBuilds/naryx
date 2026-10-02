import {
  CHAINLINK_AGGREGATOR_ABI,
  NARYX_TEST_PERP_MARKET_ABI,
  PACKAGE_VERIFIER_ACCOUNT_ABI,
  UNISWAP_V3_POOL_ABI,
  equalAddress,
  equalHash,
  packageVerifierOpenPackage,
  requiredEvmAddress,
  testPerpCloseSettlement,
  type TestPerpPositionState,
} from '@naryx/adapter-evm';
import {
  domainRefFromManifest,
  packageOrderHash,
  quoteHash,
  routeHash,
  routePayload,
  routePayloadBytes,
  scaleDecimals,
  solverQuote,
  solverQuoteBytes,
  solverSignatureDigest,
  toHex,
  toProtocolJson,
  validatePackageOrderProfile,
  type Hash32,
  type PackageOrder,
  type RoutePayloadInput,
  type SolverQuoteInput,
} from '@naryx/protocol-types';
import type { Abi, Address } from 'viem';
import {
  BASE_SEPOLIA_DOMAIN_ID,
  baseSepoliaFeesByAsset,
  readBaseSepoliaAccountOf,
  reducedPrice,
  requireBaseSepoliaChain,
  sameAdapter,
  sameAsset,
  sameDomain,
  type BaseSepoliaQuoteRuntimeInput,
} from './base-sepolia-quote-runtime.js';
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
const FEE_SCALE = 1_000_000n;
const Q192 = 1n << 192n;
const HASH_HEX = /^[0-9a-f]{64}$/;

export type BaseSepoliaExitQuoteMath = Readonly<{
  /** Exact-input sale of the package base at the pool mid less the pool fee, rounded down. */
  spotProceedsAtoms: bigint;
  spotFeeAtoms: bigint;
  /** The market's own buy-back notional, rounded up to quote atoms. */
  closeNotionalAtoms: bigint;
  closeFeeAtoms: bigint;
  /** What the close credits to the account's reserve at the market. */
  payoutAtoms: bigint;
  /** exitQuoteOutcome v1: the spot proceeds plus the reserve payout less the position margin. */
  outcomeAtoms: bigint;
}>;

function fail(message: string): never {
  throw new Error(`Base Sepolia exit quote refused: ${message}`);
}

function floorDiv(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  return numerator % denominator !== 0n && (numerator < 0n) !== (denominator < 0n) ? quotient - 1n : quotient;
}

/**
 * Prices an exit of exactly the open short: the spot leg sells `quantityAtoms` through the pool and
 * the perp leg closes the whole position at the market's `previewOpen` of the buy-back, settled the
 * way the market settles it. A position that is not exactly the package's short is refused.
 */
export function baseSepoliaExitQuoteMath(input: Readonly<{
  quantityAtoms: bigint;
  sqrtPriceX96: bigint;
  baseIsToken0: boolean;
  poolFee: bigint;
  position: TestPerpPositionState;
  previewCloseNotionalWad: bigint;
  previewCloseFeeWad: bigint;
  currentFundingIndex: bigint;
  collateralScale: bigint;
}>): BaseSepoliaExitQuoteMath {
  const { quantityAtoms, position, collateralScale } = input;
  if (quantityAtoms <= 0n || position.sizeWad !== -quantityAtoms) fail('position is not the exact package short');
  if (input.sqrtPriceX96 <= 0n || input.poolFee < 0n || input.poolFee >= FEE_SCALE) fail('pool state is invalid');
  if (input.previewCloseNotionalWad <= 0n || collateralScale <= 0n) fail('market buy-back preview is invalid');
  const squared = input.sqrtPriceX96 * input.sqrtPriceX96;
  const [midNumerator, midDenominator] = input.baseIsToken0 ? [squared, Q192] : [Q192, squared];
  const spotMidAtoms = (quantityAtoms * midNumerator) / midDenominator;
  const spotProceedsAtoms = (quantityAtoms * midNumerator * (FEE_SCALE - input.poolFee)) / (midDenominator * FEE_SCALE);
  if (spotProceedsAtoms <= 0n) fail('spot proceeds round to zero');
  const close = testPerpCloseSettlement({
    position,
    exitNotionalWad: input.previewCloseNotionalWad,
    feeWad: input.previewCloseFeeWad,
    currentFundingIndex: input.currentFundingIndex,
    collateralScale,
  });
  return Object.freeze({
    spotProceedsAtoms,
    spotFeeAtoms: spotMidAtoms - spotProceedsAtoms,
    closeNotionalAtoms: (input.previewCloseNotionalWad + collateralScale - 1n) / collateralScale,
    closeFeeAtoms: close.chargedWad / collateralScale,
    payoutAtoms: close.payoutWad / collateralScale,
    outcomeAtoms: spotProceedsAtoms + floorDiv(close.payoutWad - position.balanceWad, collateralScale),
  });
}

function requireExitOrder(order: PackageOrder, input: BaseSepoliaQuoteRuntimeInput): void {
  const deployment = input.deployment.deployment;
  const admission = input.deployment.admission;
  if (order.environment !== 'testnet' || order.settlementClass !== 'ATOMIC_POSTCONDITION'
    || order.expiryUnit !== 'EVM_UNIX_SECONDS' || order.action !== 'EXIT'
    || order.direction !== 'LONG_SPOT_SHORT_PERP' || order.partialFillPolicy !== 'EXACT_ALL_LEGS'
    || !sameDomain(order.domain, domainRefFromManifest(deployment.domainManifest))) {
    fail('order is not a Base Sepolia atomic package exit');
  }
  if (order.templateId !== admission.templateManifest.templateId
    || order.templateVersion !== admission.templateManifest.templateVersion) {
    fail('order package template does not match the configured manifest');
  }
  if (!order.permittedSpotAdapters.some((adapter) => sameAdapter(adapter, input.spot.adapter))
    || !order.permittedPerpAdapters.some((adapter) => sameAdapter(adapter, input.perpetual.adapter))) {
    fail('configured Base adapters are not permitted by the order');
  }
  if (order.minSpotQuoteOut === undefined || order.minExitQuoteOutcome === undefined || order.entryReceiptHash === undefined) {
    fail('exit order has no spot floor, outcome floor, or entry receipt');
  }
}

async function buildExitQuote(
  order: PackageOrder,
  orderHash: Hash32,
  input: BaseSepoliaQuoteRuntimeInput,
  signer: Ed25519AtomicQuoteSigner,
): Promise<Readonly<{ route: ReturnType<typeof routePayload>; quote: ReturnType<typeof solverQuote> }>> {
  requireExitOrder(order, input);
  const deployment = input.deployment.deployment;
  const chain = input.chain;
  await requireBaseSepoliaChain(chain);
  const account = await readBaseSepoliaAccountOf(chain, deployment, order.owner);
  if (!equalAddress(account, requiredEvmAddress(order.settlementAccount, 'order.settlementAccount'))) {
    fail('order settlement account is not the owner factory account');
  }
  const verifier = requiredEvmAddress(deployment.packageVerifier.address, 'packageVerifier');
  const market = requiredEvmAddress(deployment.perpetual.market.address, 'perpetual.market');
  const pool = requiredEvmAddress(deployment.spot.market.address, 'spot.market');
  const read = (address: Address, abi: Abi, functionName: string, args?: readonly unknown[]) =>
    chain.readContract({ address, abi, functionName, ...(args === undefined ? {} : { args }) });
  const quantity = order.quantity.atoms;
  const quoteAsset = order.minSpotQuoteOut!.asset;
  const baseAsset = order.quantity.asset;
  // The open package and the short are read from chain; the exit binds to exactly them.
  const [openRecord, expiryValue] = await Promise.all([
    read(verifier, PACKAGE_VERIFIER_ACCOUNT_ABI as Abi, 'openPackage', [account]),
    read(market, NARYX_TEST_PERP_MARKET_ABI as Abi, 'expiry'),
  ]);
  const open = packageVerifierOpenPackage(openRecord);
  if (open === null || !equalHash(open.entryReceiptHash, `0x${toHex(order.entryReceiptHash!)}`)) {
    fail('the account has no open package for the order entry receipt');
  }
  if (open.baseQuantityAtoms !== quantity || open.perpQuantityWad !== quantity
    || -order.expectedPrePositionSize.atoms !== quantity
    || scaleDecimals(open.entryPerpNotionalWad, 18, quoteAsset.decimals, 'FLOOR') !== order.expectedPrePositionEntryNotional.atoms) {
    fail('order quantities do not match the open package');
  }
  const [slot0, token0, poolFee, rawPosition, preview, fundingIndex, collateralScale, oracle, observedAt] = await Promise.all([
    read(pool, UNISWAP_V3_POOL_ABI as Abi, 'slot0'),
    read(pool, UNISWAP_V3_POOL_ABI as Abi, 'token0'),
    read(pool, UNISWAP_V3_POOL_ABI as Abi, 'fee'),
    read(market, NARYX_TEST_PERP_MARKET_ABI as Abi, 'getPosition', [market, Number(expiryValue), account]),
    read(market, NARYX_TEST_PERP_MARKET_ABI as Abi, 'previewOpen', [quantity, 0n]),
    read(market, NARYX_TEST_PERP_MARKET_ABI as Abi, 'currentFundingIndex'),
    read(market, NARYX_TEST_PERP_MARKET_ABI as Abi, 'collateralScale'),
    read(market, NARYX_TEST_PERP_MARKET_ABI as Abi, 'oracle'),
    chain.latestBlockTimestamp(),
  ]);
  const feed = requiredEvmAddress(String(oracle), 'market.oracle');
  const [oracleDecimals, round] = await Promise.all([
    read(feed, CHAINLINK_AGGREGATOR_ABI as Abi, 'decimals'),
    read(feed, CHAINLINK_AGGREGATOR_ABI as Abi, 'latestRoundData'),
  ]);
  const position = rawPosition as Record<string, unknown> | undefined;
  const [, closeNotionalWad, closeFeeWad] = (preview ?? []) as readonly unknown[];
  const sqrtPriceX96 = (slot0 as readonly unknown[])[0];
  const answer = (round as readonly unknown[])[1];
  if (typeof position?.balance !== 'bigint' || typeof position.size !== 'bigint'
    || typeof position.entryNotional !== 'bigint' || typeof position.entryFundingIndex !== 'bigint'
    || position.entryNotional !== open.entryPerpNotionalWad
    || typeof closeNotionalWad !== 'bigint' || typeof closeFeeWad !== 'bigint' || typeof fundingIndex !== 'bigint'
    || typeof collateralScale !== 'bigint' || typeof sqrtPriceX96 !== 'bigint'
    || typeof answer !== 'bigint' || answer <= 0n) {
    fail('Base Sepolia market reads are invalid');
  }
  const math = baseSepoliaExitQuoteMath({
    quantityAtoms: quantity,
    sqrtPriceX96,
    baseIsToken0: equalAddress(requiredEvmAddress(String(token0), 'pool.token0'), requiredEvmAddress(deployment.baseAsset.address, 'baseAsset')),
    poolFee: BigInt(Number(poolFee)),
    position: {
      balanceWad: position.balance,
      sizeWad: position.size,
      entryNotionalWad: position.entryNotional,
      entryFundingIndex: position.entryFundingIndex,
    },
    previewCloseNotionalWad: closeNotionalWad,
    previewCloseFeeWad: closeFeeWad,
    currentFundingIndex: fundingIndex,
    collateralScale,
  });
  if (observedAt >= order.expiryValue) fail('order is expired');
  if (math.spotProceedsAtoms < order.minSpotQuoteOut!.atoms) fail('spot proceeds are below the order minimum');
  if (math.outcomeAtoms < order.minExitQuoteOutcome!.atoms) fail('exit outcome is below the order minimum');
  const venueFeeAtoms = math.spotFeeAtoms + math.closeFeeAtoms;
  const feeCap = order.maxVenueFeeAtomsByAsset.find((cap) => sameAsset(cap.asset, quoteAsset));
  if (feeCap === undefined || venueFeeAtoms > feeCap.maxAtoms) fail('venue fees exceed the signed cap');

  const routeExpiryValue = order.expiryValue < observedAt + input.routeTtlSeconds
    ? order.expiryValue
    : observedAt + input.routeTtlSeconds;
  if (routeExpiryValue <= observedAt) fail('configured freshness window is empty');
  const referenceQuoteAtoms = answer * 10n ** BigInt(quoteAsset.decimals);
  const referenceBaseAtoms = 10n ** BigInt(Number(oracleDecimals) + baseAsset.decimals);
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
        baseAsset, quoteAsset, side: 'SELL', quantity: order.quantity,
        // The signed floor the verifier enforces on the exact-input sale.
        limitPrice: reducedPrice(baseAsset, quoteAsset, order.minSpotQuoteOut!.atoms, quantity, 'FLOOR'),
        timeInForce: 'FOK', reduceOnly: false,
      },
      {
        legIndex: 1, legRole: 'PERPETUAL', actionSequence: input.perpetual.action.sequence,
        adapter: input.perpetual.adapter, venue: input.perpetual.venue, market: input.perpetual.market,
        baseAsset, quoteAsset, side: 'BUY', quantity: order.quantity,
        limitPrice: reducedPrice(
          baseAsset, quoteAsset,
          referenceQuoteAtoms * (BPS + BigInt(input.perpSlippageBps)), referenceBaseAtoms * BPS, 'FLOOR',
        ),
        timeInForce: 'FOK', reduceOnly: true,
      },
    ],
    actions: [input.spot.action, input.perpetual.action],
    postconditions: input.postconditions,
    evidenceRequirements: input.evidenceRequirements,
  };
  const validatedRoute = routePayload(route, 'baseSepoliaExitRoute');
  const zeroQuote = { asset: quoteAsset, atoms: 0n };
  const venueFees = baseSepoliaFeesByAsset(baseAsset, quoteAsset, venueFeeAtoms);
  const quoteNonce = input.nonceSource.next();
  if (quoteNonce <= 0n) fail('quote nonce must be positive');
  const unsigned: SolverQuoteInput = {
    version: 1,
    environment: order.environment,
    domain: order.domain,
    orderHash,
    solverId: input.solverId,
    solverCapabilityManifestHash: input.solverCapabilityManifestHash,
    solverSignatureScheme: 'ED25519',
    solverVerificationKey: signer.verificationKey,
    quoteMode: 'EXECUTION_COMMITMENT',
    routeHash: routeHash(validatedRoute),
    quotedOutcome: { kind: 'EXIT_QUOTE_OUTCOME', exitQuoteOutcome: { asset: quoteAsset, atoms: math.outcomeAtoms } },
    expectedSpotNotional: { asset: quoteAsset, atoms: math.spotProceedsAtoms },
    expectedPerpNotional: { asset: quoteAsset, atoms: math.closeNotionalAtoms },
    expectedGrossSpotQuantity: order.quantity,
    expectedNetSpotQuantity: { asset: baseAsset, atoms: -quantity },
    expectedBaseAssetFee: { asset: baseAsset, atoms: 0n },
    expectedMarginDelta: zeroQuote,
    expectedRawFillFeesByAsset: venueFees,
    expectedBuilderFeesByAsset: baseSepoliaFeesByAsset(baseAsset, quoteAsset, 0n),
    expectedNormalizedVenueFeesByAsset: venueFees,
    solverFee: zeroQuote,
    protocolFee: zeroQuote,
    expectedPriorityFee: zeroQuote,
    maxRecoveryCostAtomsByAsset: [],
    feePolicyVersion: input.feePolicyVersion,
    feePolicyManifestHash: input.feePolicyManifestHash,
    validUntilUnit: 'EVM_UNIX_SECONDS',
    validUntilValue: routeExpiryValue,
    quoteNonce,
    signature: new Uint8Array(64),
  };
  const signature = await signer.signDigest(solverSignatureDigest(unsigned));
  return Object.freeze({ route: validatedRoute, quote: solverQuote({ ...unsigned, signature }, 'baseSepoliaExitQuote') });
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

/**
 * Quotes Base Sepolia package exits: a signed EXECUTION_COMMITMENT for selling the open package's
 * exact base through the pinned pool and closing its exact short. Every other order is delegated
 * unchanged to `fallback`, the entry coordinator.
 */
export function createBaseSepoliaExitQuotePort(
  dependencies: Readonly<{
    input: BaseSepoliaQuoteRuntimeInput;
    orders: InternalAtomicQuoteOrderProvider;
    signer: Ed25519AtomicQuoteSigner;
    store: InternalAtomicQuoteStore;
  }>,
  fallback: InternalAtomicQuotePort,
): InternalAtomicQuotePort {
  const { input, orders, signer, store } = dependencies;
  const pending = new Map<string, Readonly<{ orderHash: string; promise: Promise<InternalAtomicQuoteResponse> }>>();
  return Object.freeze({
    async quote(request: InternalAtomicQuoteRequest): Promise<InternalAtomicQuoteResponse> {
      if (typeof request?.orderHash !== 'string' || !HASH_HEX.test(request.orderHash)) return fallback.quote(request);
      const supplied = await orders(Uint8Array.from(Buffer.from(request.orderHash, 'hex')) as Hash32);
      if (supplied === undefined || supplied.domain.domainId !== BASE_SEPOLIA_DOMAIN_ID || supplied.action !== 'EXIT') {
        return fallback.quote(request);
      }
      const prior = store.get(request.idempotencyKey) ?? pending.get(request.idempotencyKey);
      if (prior !== undefined) {
        if (prior.orderHash !== request.orderHash) {
          throw new InternalAtomicQuoteError('IDEMPOTENCY_CONFLICT', 'idempotencyKey is already bound to a different order');
        }
        return 'response' in prior ? prior.response : prior.promise;
      }
      const order = validatePackageOrderProfile(supplied, 'packageOrder');
      const orderHash = packageOrderHash(order);
      if (hex(orderHash) !== request.orderHash) {
        throw new InternalAtomicQuoteError('ORDER_HASH_MISMATCH', 'stored order does not match the requested hash');
      }
      const task = (async () => {
        const signed = await buildExitQuote(order, orderHash, input, signer);
        const route = signed.route;
        return Object.freeze({
          version: 1 as const,
          status: 'SIGNED' as const,
          idempotencyKey: request.idempotencyKey,
          orderHash: request.orderHash,
          routeHash: hex(routeHash(route)),
          quoteHash: hex(quoteHash(signed.quote)),
          solverSignatureDigest: hex(solverSignatureDigest(signed.quote)),
          routeBytes: hex(routePayloadBytes(route)),
          solverQuoteBytes: hex(solverQuoteBytes(signed.quote)),
          route: toProtocolJson(route, 'route'),
          quote: toProtocolJson(signed.quote, 'quote'),
        });
      })();
      pending.set(request.idempotencyKey, { orderHash: request.orderHash, promise: task });
      try {
        return store.save({ orderHash: request.orderHash, response: await task }).response;
      } finally {
        pending.delete(request.idempotencyKey);
      }
    },
  });
}
