import {
  MalformedInputError,
  NORMALIZED_POSITION_VERSION,
  normalizedPosition,
  type AssetRef,
  type CloseRouteInput,
  type DomainRef,
  type ExactPriceInput,
  type NormalizedPositionInput,
} from '@naryx/protocol-types';

const DECIMAL = /^(-?)(\d{1,40})(?:\.(\d{1,40}))?$/;

/** The HyperCore perpetual account fields a position snapshot reads; everything else is ignored. */
export interface HyperliquidClearinghouseStateLike {
  readonly assetPositions: readonly {
    readonly position: {
      readonly coin: string;
      readonly szi: string;
      readonly positionValue: string;
      readonly liquidationPx: string | null;
      readonly marginUsed: string;
    };
  }[];
  readonly time: number;
}

/** The HyperCore spot account fields a balance snapshot reads. */
export interface HyperliquidSpotClearinghouseStateLike {
  readonly balances: readonly { readonly coin: string; readonly total: string }[];
}

/** How one HyperCore coin maps onto registered identities; unmapped coins are reported, never guessed. */
export interface HyperliquidPositionBinding {
  readonly coin: string;
  readonly venueId: string;
  readonly marketId: string;
  readonly underlyingId: string;
  readonly baseAsset: AssetRef;
  readonly riskDomainId: string;
  readonly dependencyIds: readonly string[];
  readonly closeRoutes: readonly CloseRouteInput[];
}

export interface HyperliquidSnapshotContext {
  readonly domain: DomainRef;
  /** The strategy account the positions belong to, as the normalized owner. */
  readonly owner: string;
  readonly quoteAsset: AssetRef;
  /** Prefix of each position's snapshot id; the coin is appended. */
  readonly snapshotPrefix: string;
  readonly bindings: readonly HyperliquidPositionBinding[];
}

export interface HyperliquidPositionSnapshot {
  readonly positions: readonly NormalizedPositionInput[];
  /** Coins the account holds that no binding maps; they are left out of risk, and said so. */
  readonly unmappedCoins: readonly string[];
}

/** An exact decimal string as signed atoms at `decimals`; digits the atoms cannot hold are refused, never rounded. */
export function decimalToAtoms(value: string, decimals: number, context: string): bigint {
  if (typeof value !== 'string') throw new MalformedInputError(context, 'expected a decimal string');
  const match = DECIMAL.exec(value);
  if (match === null) throw new MalformedInputError(context, 'expected a decimal string');
  const [, sign, whole, fraction = ''] = match;
  const trimmed = fraction.replace(/0+$/, '');
  if (trimmed.length > decimals) throw new MalformedInputError(context, `more than ${decimals} fractional digits`);
  const atoms = BigInt(`${whole}${trimmed.padEnd(decimals, '0')}`);
  return sign === '-' ? -atoms : atoms;
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function reducedPrice(baseAsset: AssetRef, quoteAsset: AssetRef, quoteAtoms: bigint, baseAtoms: bigint): ExactPriceInput {
  const divisor = gcd(quoteAtoms, baseAtoms);
  // Marks round away from zero wherever they convert, so exposure is never understated.
  return { baseAsset, quoteAsset, quoteAtoms: quoteAtoms / divisor, baseAtoms: baseAtoms / divisor, roundingDirection: 'AWAY_FROM_ZERO' };
}

function bindingsByCoin(context: HyperliquidSnapshotContext): ReadonlyMap<string, HyperliquidPositionBinding> {
  const bindings = new Map<string, HyperliquidPositionBinding>();
  for (const binding of context.bindings) {
    if (bindings.has(binding.coin)) throw new MalformedInputError('hyperliquidSnapshot.bindings', `coin ${binding.coin} is bound twice`);
    bindings.set(binding.coin, binding);
  }
  return bindings;
}

/**
 * Normalizes a HyperCore perpetual account into kernel positions. Size and value are exact
 * decimals; the mark is value over size, the liquidation price is kept when the venue reports
 * one, and position margin becomes collateral. HyperCore reports maintenance margin only for the
 * whole cross account, so it stays an unknown field of each position rather than an invention.
 * Reading grants no authority over the account.
 */
export function normalizeHyperliquidPerpPositions(
  state: HyperliquidClearinghouseStateLike,
  context: HyperliquidSnapshotContext,
): HyperliquidPositionSnapshot {
  if (typeof state !== 'object' || state === null || !Array.isArray(state.assetPositions)) {
    throw new MalformedInputError('hyperliquidSnapshot.state', 'expected a clearinghouse state');
  }
  if (!Number.isSafeInteger(state.time) || state.time < 0) throw new MalformedInputError('hyperliquidSnapshot.time', 'expected a millisecond time');
  const bindings = bindingsByCoin(context);
  const positions: NormalizedPositionInput[] = [];
  const unmapped: string[] = [];
  state.assetPositions.forEach((entry, index) => {
    const at = `hyperliquidSnapshot.assetPositions[${index}]`;
    const position = entry?.position;
    if (typeof position !== 'object' || position === null) throw new MalformedInputError(at, 'expected a position');
    const binding = bindings.get(position.coin);
    if (binding === undefined) {
      unmapped.push(String(position.coin));
      return;
    }
    const baseDecimals = binding.baseAsset.decimals;
    const quoteDecimals = context.quoteAsset.decimals;
    const quantity = decimalToAtoms(position.szi, baseDecimals, `${at}.szi`);
    if (quantity === 0n) return;
    const value = decimalToAtoms(position.positionValue, quoteDecimals, `${at}.positionValue`);
    if (value <= 0n) throw new MalformedInputError(`${at}.positionValue`, 'an open position has a positive value');
    const size = quantity < 0n ? -quantity : quantity;
    const liquidation = position.liquidationPx === null ? undefined : decimalToAtoms(position.liquidationPx, quoteDecimals, `${at}.liquidationPx`);
    const input: NormalizedPositionInput = {
      adapterVersion: NORMALIZED_POSITION_VERSION,
      snapshotId: `${context.snapshotPrefix}:perp:${position.coin}`,
      domain: context.domain,
      observedAtMs: BigInt(state.time),
      owner: context.owner,
      venueId: binding.venueId,
      marketId: binding.marketId,
      underlyingId: binding.underlyingId,
      positionType: 'PERPETUAL',
      quantityBaseAtoms: quantity,
      markPrice: reducedPrice(binding.baseAsset, context.quoteAsset, value, size),
      ...(liquidation === undefined || liquidation <= 0n
        ? {}
        : { liquidationPrice: reducedPrice(binding.baseAsset, context.quoteAsset, liquidation, 10n ** BigInt(baseDecimals)) }),
      collateralQuoteAtoms: decimalToAtoms(position.marginUsed, quoteDecimals, `${at}.marginUsed`),
      dependencyIds: binding.dependencyIds,
      riskDomainId: binding.riskDomainId,
      closeRoutes: binding.closeRoutes,
    };
    normalizedPosition(input, at);
    positions.push(input);
  });
  return Object.freeze({ positions: Object.freeze(positions), unmappedCoins: Object.freeze(unmapped.sort()) });
}

/**
 * Normalizes HyperCore spot balances into spot positions marked at the caller's per-coin mid
 * prices. A mid is an indicative mark for risk only. A balance without a mark is reported
 * unmapped rather than valued at an invented price.
 */
export function normalizeHyperliquidSpotBalances(
  state: HyperliquidSpotClearinghouseStateLike,
  midPrices: Readonly<Record<string, string>>,
  observedAtMs: number,
  context: HyperliquidSnapshotContext,
): HyperliquidPositionSnapshot {
  if (typeof state !== 'object' || state === null || !Array.isArray(state.balances)) {
    throw new MalformedInputError('hyperliquidSpotSnapshot.state', 'expected a spot clearinghouse state');
  }
  if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0) throw new MalformedInputError('hyperliquidSpotSnapshot.observedAtMs', 'expected a millisecond time');
  const bindings = bindingsByCoin(context);
  const positions: NormalizedPositionInput[] = [];
  const unmapped: string[] = [];
  state.balances.forEach((balance, index) => {
    const at = `hyperliquidSpotSnapshot.balances[${index}]`;
    const binding = bindings.get(balance.coin);
    const mid = Object.hasOwn(midPrices, balance.coin) ? midPrices[balance.coin] : undefined;
    if (binding === undefined || mid === undefined) {
      unmapped.push(String(balance.coin));
      return;
    }
    const quantity = decimalToAtoms(balance.total, binding.baseAsset.decimals, `${at}.total`);
    if (quantity === 0n) return;
    const markAtoms = decimalToAtoms(mid, context.quoteAsset.decimals, `${at}.mid`);
    if (markAtoms <= 0n) throw new MalformedInputError(`${at}.mid`, 'a mark must be positive');
    const input: NormalizedPositionInput = {
      adapterVersion: NORMALIZED_POSITION_VERSION,
      snapshotId: `${context.snapshotPrefix}:spot:${balance.coin}`,
      domain: context.domain,
      observedAtMs: BigInt(observedAtMs),
      owner: context.owner,
      venueId: binding.venueId,
      marketId: binding.marketId,
      underlyingId: binding.underlyingId,
      positionType: 'SPOT',
      quantityBaseAtoms: quantity,
      markPrice: reducedPrice(binding.baseAsset, context.quoteAsset, markAtoms, 10n ** BigInt(binding.baseAsset.decimals)),
      dependencyIds: binding.dependencyIds,
      riskDomainId: binding.riskDomainId,
      closeRoutes: binding.closeRoutes,
    };
    normalizedPosition(input, at);
    positions.push(input);
  });
  return Object.freeze({ positions: Object.freeze(positions), unmappedCoins: Object.freeze(unmapped.sort()) });
}
