import { createPublicKey, verify } from 'node:crypto';
import {
  bytesEqual,
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
  type Hash32,
  type PackageOrder,
  type ProtocolJsonValue,
  type RoutePayloadInput,
  type SolverQuoteInput,
} from '@naryx/protocol-types';
import type { AtomicEntryQuoteTerms, Ed25519AtomicQuoteSigner } from './signed-atomic-entry-quote.js';
import {
  InternalAtomicQuoteError,
  type InternalAtomicQuoteOrderProvider,
  type InternalAtomicQuotePort,
  type InternalAtomicQuoteRequest,
  type InternalAtomicQuoteResponse,
  type InternalAtomicQuoteStore,
} from './internal-atomic-quote-server.js';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const HASH_HEX = /^[0-9a-f]{64}$/;

/** The signed fields of an internal quote response, without the caller's idempotency key. */
export type SignedHyperliquidTestnetExitQuote = Readonly<{
  routeHash: string;
  quoteHash: string;
  solverSignatureDigest: string;
  routeBytes: string;
  solverQuoteBytes: string;
  route: ProtocolJsonValue;
  quote: ProtocolJsonValue;
}>;

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

/**
 * Signs a Hyperliquid EXIT execution commitment. The route and quote bind the exit order hash, and
 * the batched route's initial action must expire strictly before the quote validity.
 */
export async function signHyperliquidTestnetExitQuote(input: Readonly<{
  order: PackageOrder;
  orderHash: Hash32;
  route: RoutePayloadInput;
  terms: AtomicEntryQuoteTerms;
  signer: Ed25519AtomicQuoteSigner;
}>): Promise<SignedHyperliquidTestnetExitQuote> {
  const order = validatePackageOrderProfile(input.order, 'packageOrder');
  const orderHash = packageOrderHash(order);
  if (order.action !== 'EXIT' || order.settlementClass !== 'BATCHED_IOC_WITH_RECOVERY'
    || !bytesEqual(orderHash, input.orderHash)) {
    throw new Error('exit quote requires the exact Hyperliquid EXIT order');
  }
  const route = routePayload(input.route, 'routePayload');
  if (!bytesEqual(route.orderHash, orderHash) || route.action !== 'EXIT'
    || route.routeExpiryValue >= input.terms.validUntilValue
    || input.terms.validUntilValue > order.expiryValue) {
    throw new Error('exit route does not bind the order inside the quote validity');
  }
  const computedRouteHash = routeHash(route);
  const unsigned: SolverQuoteInput = {
    version: 1,
    environment: order.environment,
    domain: order.domain,
    orderHash,
    solverId: input.terms.solverId,
    solverCapabilityManifestHash: input.terms.solverCapabilityManifestHash,
    solverSignatureScheme: 'ED25519',
    solverVerificationKey: Uint8Array.from(input.signer.verificationKey),
    quoteMode: 'EXECUTION_COMMITMENT',
    routeHash: computedRouteHash,
    quotedOutcome: input.terms.quotedOutcome,
    expectedSpotNotional: input.terms.expectedSpotNotional,
    expectedPerpNotional: input.terms.expectedPerpNotional,
    expectedGrossSpotQuantity: input.terms.expectedGrossSpotQuantity,
    expectedNetSpotQuantity: input.terms.expectedNetSpotQuantity,
    expectedBaseAssetFee: input.terms.expectedBaseAssetFee,
    ...(input.terms.expectedTerminalResidualBaseQuantity === undefined ? {} : {
      expectedTerminalResidualBaseQuantity: input.terms.expectedTerminalResidualBaseQuantity,
      expectedTerminalResidualQuoteValue: input.terms.expectedTerminalResidualQuoteValue,
    }),
    expectedMarginDelta: input.terms.expectedMarginDelta,
    expectedRawFillFeesByAsset: input.terms.expectedRawFillFeesByAsset,
    expectedBuilderFeesByAsset: input.terms.expectedBuilderFeesByAsset,
    expectedNormalizedVenueFeesByAsset: input.terms.expectedNormalizedVenueFeesByAsset,
    solverFee: input.terms.solverFee,
    protocolFee: input.terms.protocolFee,
    expectedPriorityFee: input.terms.expectedPriorityFee,
    maxRecoveryCostAtomsByAsset: input.terms.maxRecoveryCostAtomsByAsset,
    feePolicyVersion: input.terms.feePolicyVersion,
    feePolicyManifestHash: input.terms.feePolicyManifestHash,
    validUntilUnit: input.terms.validUntilUnit,
    validUntilValue: input.terms.validUntilValue,
    quoteNonce: input.terms.quoteNonce,
    signature: new Uint8Array(64),
  };
  solverQuote(unsigned, 'solverQuote');
  const digest = solverSignatureDigest(unsigned);
  const signature = Uint8Array.from(await input.signer.signDigest(digest));
  const key = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(input.signer.verificationKey)]),
    format: 'der',
    type: 'spki',
  });
  if (signature.length !== 64 || !verify(null, Buffer.from(digest), key, Buffer.from(signature))) {
    throw new Error('exit quote signature does not verify over the quote digest');
  }
  const signed: SolverQuoteInput = { ...unsigned, signature };
  const quote = solverQuote(signed, 'solverQuote');
  return Object.freeze({
    routeHash: hex(computedRouteHash),
    quoteHash: hex(quoteHash(signed)),
    solverSignatureDigest: hex(solverSignatureDigest(signed)),
    routeBytes: hex(routePayloadBytes(route)),
    solverQuoteBytes: hex(solverQuoteBytes(signed)),
    route: toProtocolJson(route, 'route'),
    quote: toProtocolJson(quote, 'quote'),
  });
}

/**
 * Quotes Hyperliquid Testnet package exits for one package of the shared trading account; every
 * other order is delegated unchanged to `fallback`, the entry coordinator.
 */
export function createHyperliquidTestnetExitQuotePort(
  dependencies: Readonly<{
    exit: (input: Readonly<{ order: PackageOrder; orderHash: Hash32; signer: Ed25519AtomicQuoteSigner }>)
      => Promise<SignedHyperliquidTestnetExitQuote>;
    orders: InternalAtomicQuoteOrderProvider;
    signer: Ed25519AtomicQuoteSigner;
    store: InternalAtomicQuoteStore;
  }>,
  fallback: InternalAtomicQuotePort,
): InternalAtomicQuotePort {
  const { exit, orders, signer, store } = dependencies;
  const pending = new Map<string, Readonly<{ orderHash: string; promise: Promise<InternalAtomicQuoteResponse> }>>();
  return Object.freeze({
    async quote(request: InternalAtomicQuoteRequest): Promise<InternalAtomicQuoteResponse> {
      if (typeof request?.orderHash !== 'string' || !HASH_HEX.test(request.orderHash)) return fallback.quote(request);
      const supplied = await orders(Uint8Array.from(Buffer.from(request.orderHash, 'hex')) as Hash32);
      if (supplied === undefined || supplied.domain.domainId !== 'hypercore:testnet' || supplied.action !== 'EXIT') {
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
      const task = exit({ order, orderHash, signer }).then((signed) => Object.freeze({
        version: 1 as const,
        status: 'SIGNED' as const,
        idempotencyKey: request.idempotencyKey,
        orderHash: request.orderHash,
        ...signed,
      }));
      pending.set(request.idempotencyKey, { orderHash: request.orderHash, promise: task });
      try {
        return store.save({ orderHash: request.orderHash, response: await task }).response;
      } finally {
        pending.delete(request.idempotencyKey);
      }
    },
  });
}
