import { createHash } from 'node:crypto';
import {
  bytesEqual,
  exactPrice,
  nettingExternalExecutionEvidence,
  nettingInstrumentHash,
  type AdapterRef,
  type AssetRef,
  type CommitmentHash,
  type DomainRef,
  type NettingExternalExecutionIntent,
  type NettingExternalExecutionEvidence,
  type NettingInstrumentPolicy,
  type VersionedManifestRef,
} from '@naryx/protocol-types';
import {
  type HypercoreBatchedOrderAction,
  type HypercoreOrderWire,
} from './index.js';
import {
  formatHypercorePrice,
  formatHypercoreSize,
  powerOfTen,
  type HypercoreFormattedPrice,
} from './wire-format.js';

const CLIENT_ORDER_ID_DOMAIN = 'naryx/hypercore/netting-residual-client-order-id/v1';
const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);

export interface HyperliquidNettingResidualMarketBinding {
  readonly adapter: AdapterRef;
  readonly venue: VersionedManifestRef;
  readonly market: VersionedManifestRef;
  readonly assetId: number;
  readonly sizeDecimals: number;
  readonly maximumPriceDecimals: number;
}

export interface HyperliquidNettingResidualPlan {
  readonly version: 1;
  readonly guarantee: 'SINGLE_IOC_WITH_TERMINAL_EVIDENCE';
  readonly intentHash: CommitmentHash;
  readonly domain: DomainRef;
  readonly instrumentHash: CommitmentHash;
  readonly quantityAsset: AssetRef;
  readonly quoteAsset: AssetRef;
  readonly requestedSignedQuantityAtoms: bigint;
  readonly maximumFeeQuoteAtoms: bigint;
  readonly requestExpiryMs: bigint;
  readonly clientOrderId: `0x${string}`;
  readonly order: HypercoreOrderWire;
  readonly action: HypercoreBatchedOrderAction;
}

export interface HyperliquidNettingResidualObservation {
  readonly clientOrderId: `0x${string}`;
  readonly terminalStatus: 'FILLED' | 'PARTIALLY_FILLED_IOC_CANCELLED'
    | 'UNFILLED_IOC_CANCELLED' | 'REJECTED' | 'UNKNOWN';
  readonly filledSignedQuantityAtoms: bigint;
  readonly grossQuoteAtoms: bigint;
  readonly feeQuoteAtoms: bigint;
  readonly submittedAtMs: bigint;
  readonly observedAtMs: bigint;
  readonly executionReferenceHash: Uint8Array | string;
  readonly authoritativeEvidenceHash: Uint8Array | string;
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sameAdapter(left: AdapterRef, right: AdapterRef): boolean {
  return left.adapterId === right.adapterId
    && left.adapterManifestVersion === right.adapterManifestVersion
    && bytesEqual(left.adapterManifestHash, right.adapterManifestHash);
}

function sameManifest(left: VersionedManifestRef, right: VersionedManifestRef): boolean {
  return left.subjectId === right.subjectId
    && left.manifestVersion === right.manifestVersion
    && bytesEqual(left.manifestHash, right.manifestHash);
}

function clientOrderId(intentHash: CommitmentHash, assetId: number): `0x${string}` {
  const asset = Buffer.allocUnsafe(4);
  asset.writeUInt32BE(assetId);
  return `0x${createHash('sha256')
    .update(CLIENT_ORDER_ID_DOMAIN, 'ascii')
    .update(Buffer.from(intentHash))
    .update(asset)
    .digest('hex')
    .slice(0, 32)}`;
}

function reduceOnly(legFamily: NettingInstrumentPolicy['legFamily']): boolean {
  return legFamily === 'PERP_CLOSE' || legFamily === 'PERP_DECREASE';
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left;
  let b = right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

function compareWirePrice(wire: HypercoreFormattedPrice, exact: ReturnType<typeof exactPrice>): number {
  const left = wire.scaled * exact.baseAtoms * powerOfTen(exact.quoteAsset.decimals);
  const right = exact.quoteAtoms * powerOfTen(exact.baseAsset.decimals + wire.decimals);
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compileHyperliquidNettingResidualPlan(input: Readonly<{
  intent: NettingExternalExecutionIntent;
  instrument: NettingInstrumentPolicy;
  binding: HyperliquidNettingResidualMarketBinding;
}>): HyperliquidNettingResidualPlan {
  const { intent, instrument, binding } = input;
  requireCondition(intent.domain.domainId === 'hypercore:testnet', 'only Hyperliquid Testnet residual execution is enabled');
  requireCondition(intent.validUntilUnit === 'HYPERLIQUID_UNIX_MILLISECONDS'
    && intent.validUntilValue > 0n
    && intent.validUntilValue <= MAX_SAFE_INTEGER, 'residual intent requires a safe Hyperliquid millisecond expiry');
  requireCondition(bytesEqual(nettingInstrumentHash(instrument), intent.instrumentHash)
    && instrument.instrumentId === intent.instrumentId, 'residual intent and instrument policy differ');
  requireCondition(sameAdapter(binding.adapter, intent.adapter)
    && sameAdapter(instrument.adapter, intent.adapter)
    && sameManifest(binding.venue, intent.venue)
    && sameManifest(instrument.venue, intent.venue)
    && sameManifest(binding.market, intent.market)
    && sameManifest(instrument.market, intent.market), 'residual market binding differs from the signed instrument');
  requireCondition(instrument.quantityIncrementAtoms === intent.quantityIncrementAtoms
    && instrument.priceTickQuoteAtoms === intent.priceTickQuoteAtoms
    && bytesEqual(instrument.quantityAsset.assetManifestHash, intent.quantityAsset.assetManifestHash)
    && bytesEqual(instrument.quoteAsset.assetManifestHash, intent.quoteAsset.assetManifestHash),
  'residual asset or lattice binding differs from the signed instrument');
  requireCondition(
    instrument.legFamily === 'SPOT_SWAP'
      || instrument.legFamily === 'PERP_OPEN'
      || instrument.legFamily === 'PERP_CLOSE'
      || instrument.legFamily === 'PERP_INCREASE'
      || instrument.legFamily === 'PERP_DECREASE',
    `HyperCore cannot execute residual ${instrument.legFamily}`,
  );
  requireCondition(Number.isInteger(binding.assetId) && binding.assetId >= 0 && binding.assetId <= 0xffff_ffff,
    'HyperCore residual asset id must fit u32');
  requireCondition(Number.isInteger(binding.sizeDecimals) && binding.sizeDecimals >= 0 && binding.sizeDecimals <= 8,
    'HyperCore residual size decimals are invalid');
  requireCondition(Number.isInteger(binding.maximumPriceDecimals)
    && binding.maximumPriceDecimals >= 0 && binding.maximumPriceDecimals <= 8,
  'HyperCore residual price decimals are invalid');
  const limitQuoteAtoms = intent.limitPriceTicks * intent.priceTickQuoteAtoms;
  const priceDivisor = gcd(limitQuoteAtoms, intent.quantityIncrementAtoms);
  const limit = exactPrice({
    baseAsset: intent.quantityAsset,
    quoteAsset: intent.quoteAsset,
    baseAtoms: intent.quantityIncrementAtoms / priceDivisor,
    quoteAtoms: limitQuoteAtoms / priceDivisor,
    roundingDirection: intent.side === 'BUY' ? 'FLOOR' : 'CEIL',
  });
  const price = formatHypercorePrice(limit, binding.maximumPriceDecimals);
  const relation = compareWirePrice(price, limit);
  requireCondition(intent.side === 'BUY' ? relation <= 0 : relation >= 0,
    'HyperCore residual wire price violates the signed limit');
  const clientId = clientOrderId(intent.intentHash, binding.assetId);
  const order = Object.freeze({
    a: binding.assetId,
    b: intent.side === 'BUY',
    p: price.value,
    s: formatHypercoreSize(intent.quantityAtoms, intent.quantityAsset.decimals, binding.sizeDecimals),
    r: reduceOnly(instrument.legFamily),
    t: Object.freeze({ limit: Object.freeze({ tif: 'Ioc' as const }) }),
    c: clientId,
  });
  return Object.freeze({
    version: 1,
    guarantee: 'SINGLE_IOC_WITH_TERMINAL_EVIDENCE',
    intentHash: intent.intentHash,
    domain: intent.domain,
    instrumentHash: intent.instrumentHash,
    quantityAsset: intent.quantityAsset,
    quoteAsset: intent.quoteAsset,
    requestedSignedQuantityAtoms: intent.side === 'BUY' ? intent.quantityAtoms : -intent.quantityAtoms,
    maximumFeeQuoteAtoms: intent.maximumFeeQuoteAtoms,
    requestExpiryMs: intent.validUntilValue,
    clientOrderId: clientId,
    order,
    action: Object.freeze({ type: 'order', orders: Object.freeze([order]), grouping: 'na' }),
  });
}

export function hyperliquidNettingResidualEvidence(input: Readonly<{
  intent: NettingExternalExecutionIntent;
  plan: HyperliquidNettingResidualPlan;
  observation: HyperliquidNettingResidualObservation;
}>): NettingExternalExecutionEvidence {
  const { intent, plan, observation } = input;
  requireCondition(plan.version === 1
    && plan.guarantee === 'SINGLE_IOC_WITH_TERMINAL_EVIDENCE'
    && plan.domain.domainId === 'hypercore:testnet'
    && bytesEqual(plan.intentHash, intent.intentHash)
    && plan.requestedSignedQuantityAtoms === (intent.side === 'BUY' ? intent.quantityAtoms : -intent.quantityAtoms)
    && plan.maximumFeeQuoteAtoms === intent.maximumFeeQuoteAtoms
    && plan.requestExpiryMs === intent.validUntilValue,
  'residual execution plan differs from the intent');
  requireCondition(observation.clientOrderId.toLowerCase() === plan.clientOrderId,
    'residual observation cites another client order');
  requireCondition(observation.terminalStatus !== 'UNKNOWN',
    'an unknown HyperCore order is not terminal evidence');
  const outcome = observation.terminalStatus === 'FILLED'
    ? 'EXACT_FILLED'
    : observation.terminalStatus === 'PARTIALLY_FILLED_IOC_CANCELLED'
      ? 'PARTIAL_FILL'
      : observation.terminalStatus === 'UNFILLED_IOC_CANCELLED'
        ? 'NO_FILL'
        : 'REJECTED';
  return nettingExternalExecutionEvidence({
    version: 1,
    intentHash: intent.intentHash,
    outcome,
    filledSignedQuantityAtoms: observation.filledSignedQuantityAtoms,
    grossQuoteAtoms: observation.grossQuoteAtoms,
    feeQuoteAtoms: observation.feeQuoteAtoms,
    submittedAtUnit: 'HYPERLIQUID_UNIX_MILLISECONDS',
    submittedAtValue: observation.submittedAtMs,
    observedAtUnit: 'HYPERLIQUID_UNIX_MILLISECONDS',
    observedAtValue: observation.observedAtMs,
    executionReferenceHash: observation.executionReferenceHash,
    authoritativeEvidenceHash: observation.authoritativeEvidenceHash,
  }, intent);
}
