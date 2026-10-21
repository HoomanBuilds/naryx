import { bytesEqual } from '@naryx/protocol-types';
import { priceSolanaDevnetEntry, priceSolanaDevnetExit, solanaDevnetInventoryCapacity, solanaDevnetMinimumPackageUnits, type SolanaDevnetLiveQuoteState } from './solana-devnet-firm-quote.js';
import type { SolanaDevnetSolverConfig } from './solana-devnet-solver-config.js';
import { QUOTE_MODE_FIRM_ONCHAIN, QUOTE_SIDE_ASK, QUOTE_SIDE_BID, type QuoteLevelState } from './solana-devnet-wire.js';

type StandingLevel = Readonly<{
  levelId: string;
  referenceOffsetAtoms: string;
  remainingCapacityUnits: string;
  minPackageSizeUnits: string;
  maxPackageSizeUnits: string;
  expirySlot: string;
}>;

export type SolanaDevnetStandingBook = Readonly<{
  version: 1;
  domainId: 'svm:devnet';
  shard: string;
  seriesManifestHash: string;
  finalizedSlot: string;
  referencePackagePriceAtoms: string;
  bid: StandingLevel | null;
  ask: StandingLevel | null;
}>;

export function solanaDevnetStandingBook(
  state: Pick<SolanaDevnetLiveQuoteState, 'slot' | 'shard' | 'reservationClass' | 'levels' | 'availableInventory' | 'market' | 'oraclePricePerLot' | 'marketMinimumNotionals'>,
  config: Pick<SolanaDevnetSolverConfig, 'accounts' | 'series' | 'inventorySpreadBps' | 'maxQuantityAtoms' | 'levelCapacityUnits' | 'spotBaseLotAtoms' | 'perpLimitToleranceBps'>,
): SolanaDevnetStandingBook {
  if (!bytesEqual(state.shard.seriesManifestHash, config.series.seriesManifestHash)) {
    throw new Error('Solana Devnet standing book series does not match the reviewed solver configuration.');
  }
  const eligible = (level: QuoteLevelState, side: number) =>
    !state.shard.killed && state.shard.heartbeatExpirySlot > state.slot
    && level.active && level.epoch === state.shard.epoch && level.side === side
    && level.quoteMode === QUOTE_MODE_FIRM_ONCHAIN && level.maxFeeAtoms === 0n
    && bytesEqual(level.reservationPolicyHash, state.reservationClass.policyHash)
    && bytesEqual(level.settlementClassIdentityHash, config.series.settlementClassIdentityHash)
    && level.expirySlot > state.slot && level.expirySlot <= state.shard.heartbeatExpirySlot
    && level.minPackageSizeUnits > 0n && level.maxPackageSizeUnits >= level.minPackageSizeUnits
    && level.remainingCapacity >= level.minPackageSizeUnits;
  const latest = (side: number): StandingLevel | null => {
    const capacity = solanaDevnetInventoryCapacity(state, config, side);
    const marketMinimum = solanaDevnetMinimumPackageUnits(state, config);
    const level = state.levels.filter((candidate) => eligible(candidate, side))
      .filter((candidate) => candidate.minPackageSizeUnits <= capacity && marketMinimum <= capacity
        && marketMinimum <= candidate.maxPackageSizeUnits && marketMinimum <= candidate.remainingCapacity)
      .sort((left, right) => left.expirySlot === right.expirySlot
        ? left.slotIndex - right.slotIndex : left.expirySlot > right.expirySlot ? -1 : 1)[0];
    return level === undefined ? null : Object.freeze({
      levelId: level.levelId.toString(),
      referenceOffsetAtoms: level.referenceOffset.toString(),
      remainingCapacityUnits: (level.remainingCapacity < capacity ? level.remainingCapacity : capacity).toString(),
      minPackageSizeUnits: (level.minPackageSizeUnits > marketMinimum ? level.minPackageSizeUnits : marketMinimum).toString(),
      maxPackageSizeUnits: (level.maxPackageSizeUnits < capacity ? level.maxPackageSizeUnits : capacity).toString(),
      expirySlot: level.expirySlot.toString(),
    });
  };
  return Object.freeze({
    version: 1,
    domainId: 'svm:devnet',
    shard: config.accounts.packageBookShard,
    seriesManifestHash: Buffer.from(config.series.seriesManifestHash).toString('hex'),
    finalizedSlot: state.slot.toString(),
    referencePackagePriceAtoms: state.shard.referencePackagePrice.toString(),
    bid: latest(QUOTE_SIDE_BID),
    ask: latest(QUOTE_SIDE_ASK),
  });
}

export type SolanaDevnetQuoteLadder = Readonly<{
  version: 1;
  domainId: 'svm:devnet';
  templateId: 'cash-and-carry-v1';
  pricing: 'INDICATIVE';
  reservation: 'ON_ACCEPT';
  quantityKind: 'ALTERNATIVE_SIZES';
  capturedAtMs: number;
  finalizedSlot: string;
  seriesManifestHash: string;
  baseMint: string;
  quoteMint: string;
  baseDecimals: number;
  quoteDecimals: number;
  bids: readonly SolanaDevnetQuotePoint[];
  asks: readonly SolanaDevnetQuotePoint[];
}>;

type SolanaDevnetQuotePoint = Readonly<{
  levelId: string;
  quantityAtoms: string;
  basisQuoteAtoms: string;
  feeQuoteAtoms: string;
  expirySlot: string;
}>;

export function solanaDevnetQuoteLadder(
  state: Parameters<typeof solanaDevnetStandingBook>[0],
  config: Parameters<typeof solanaDevnetStandingBook>[1] & Pick<SolanaDevnetSolverConfig, 'quoteTtlSlots' | 'resources'>,
  capturedAtMs: number,
): SolanaDevnetQuoteLadder {
  const book = solanaDevnetStandingBook(state, config);
  const points = (level: StandingLevel | null, side: 'BID' | 'ASK'): SolanaDevnetQuotePoint[] => {
    if (level === null || BigInt(level.expirySlot) <= state.slot + config.quoteTtlSlots * 2n / 3n) return [];
    const minimum = BigInt(level.minPackageSizeUnits);
    const maximum = BigInt(level.maxPackageSizeUnits) < BigInt(level.remainingCapacityUnits)
      ? BigInt(level.maxPackageSizeUnits) : BigInt(level.remainingCapacityUnits);
    const sizes = new Set<bigint>();
    for (let index = 0n; index < 5n; index++) {
      sizes.add((minimum + (maximum - minimum) * index / 4n) / minimum * minimum);
    }
    return [...sizes].map((units) => {
      const quantityAtoms = units * config.series.spotBaseAtomsPerPackageUnit;
      const pricing = side === 'ASK'
        ? priceSolanaDevnetEntry(config, state.market, state.oraclePricePerLot, quantityAtoms)
        : priceSolanaDevnetExit(config, state.market, state.oraclePricePerLot, quantityAtoms);
      return {
        levelId: level.levelId,
        quantityAtoms: quantityAtoms.toString(),
        basisQuoteAtoms: (pricing.firmQuoteAtoms - pricing.perpNotionalAtoms).toString(),
        feeQuoteAtoms: pricing.perpFeeAtoms.toString(),
        expirySlot: level.expirySlot,
      };
    });
  };
  return Object.freeze({
    version: 1,
    domainId: 'svm:devnet',
    templateId: 'cash-and-carry-v1',
    pricing: 'INDICATIVE',
    reservation: 'ON_ACCEPT',
    quantityKind: 'ALTERNATIVE_SIZES',
    capturedAtMs,
    finalizedSlot: book.finalizedSlot,
    seriesManifestHash: book.seriesManifestHash,
    baseMint: config.resources.baseAsset.subjectAddress,
    quoteMint: config.resources.quoteAsset.subjectAddress,
    baseDecimals: state.market.baseDecimals,
    quoteDecimals: state.market.collateralDecimals,
    bids: points(book.bid, 'BID'),
    asks: state.market.pauseOpens ? [] : points(book.ask, 'ASK'),
  });
}
