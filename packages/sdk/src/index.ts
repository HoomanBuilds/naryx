export {
  NaryxApiError,
  NaryxEvidenceError,
  NaryxMarketClient,
  verifyAllocationEvidence,
  type FetchLike,
  type NaryxMarketClientOptions,
  type PackageBookLevelView,
  type PackageBookSnapshot,
  type PackageTapePage,
  type PackageTapeTrade,
  type VerifiedAllocation,
} from './market-client.js';

// Evidence verifiers an integrator can run without any Naryx service in the loop.
export {
  packageAllocationHash,
  replayRouteDecision,
  replaySealedAuction,
  strategyStateHash,
  verifyPackageAllocation,
  verifySealedAuctionResult,
  verifySelectiveDisclosure,
} from '@naryx/protocol-types';
