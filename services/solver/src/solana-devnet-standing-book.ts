import { bytesEqual } from '@naryx/protocol-types';
import type { SolanaDevnetLiveQuoteState } from './solana-devnet-firm-quote.js';
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
  state: Pick<SolanaDevnetLiveQuoteState, 'slot' | 'shard' | 'reservationClass' | 'levels'>,
  config: Pick<SolanaDevnetSolverConfig, 'accounts' | 'series'>,
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
    const level = state.levels.filter((candidate) => eligible(candidate, side))
      .sort((left, right) => left.expirySlot === right.expirySlot
        ? left.slotIndex - right.slotIndex : left.expirySlot > right.expirySlot ? -1 : 1)[0];
    return level === undefined ? null : Object.freeze({
      levelId: level.levelId.toString(),
      referenceOffsetAtoms: level.referenceOffset.toString(),
      remainingCapacityUnits: level.remainingCapacity.toString(),
      minPackageSizeUnits: level.minPackageSizeUnits.toString(),
      maxPackageSizeUnits: level.maxPackageSizeUnits.toString(),
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
