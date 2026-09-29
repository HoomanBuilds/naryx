export {
  NaryxApiError,
  NaryxClient,
  NaryxEvidenceError,
  candlesFromTape,
  verifyAllocationEvidence,
  type CandlePage,
  type FetchLike,
  type NaryxClientOptions,
  type PackageBookLevelView,
  type PackageDepth,
  type PackageMarketSummary,
  type PackageTapePage,
  type PackageTapeTrade,
  type RegisteredDocumentView,
  type VerifiedAllocation,
} from './client.js';
export { NaryxSolverClient, type NaryxSolverClientOptions } from './solver-client.js';

// Evidence verifiers an integrator can run without any Naryx service in the loop.
export {
  aggregateCandles,
  executablePackageIndex,
  packageAllocationHash,
  privacyProfile,
  replayRouteDecision,
  replaySealedAuction,
  strategyStateHash,
  verifyPackageAllocation,
  verifySealedAuctionResult,
  verifySelectiveDisclosure,
} from '@naryx/protocol-types';
