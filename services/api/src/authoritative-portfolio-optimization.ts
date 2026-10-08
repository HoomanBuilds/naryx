import type {
  MarginOffsetContext,
  MarginOffsetPolicy,
  PortfolioOptimizationCandidateInput,
  PortfolioOptimizationPolicyInput,
  StressScenario,
} from "@naryx/protocol-types";
import type { StoredCollateralSnapshot } from "./collateral-snapshot-store.js";
import type { PortfolioOptimizationPort, PortfolioOptimizationResult } from "./portfolio-optimization-client.js";
import type { StoredPositionSnapshot } from "./position-snapshot-store.js";

export interface PortfolioOptimizationCandidateProposal {
  readonly candidateId: string;
  readonly positionSnapshotHash: string;
  readonly collateralSnapshotHash: string;
  readonly routeHash: Uint8Array | string;
  readonly executionGraphHash: Uint8Array | string;
  readonly unwindRouteHash: Uint8Array | string;
  readonly solverId: string;
  readonly solverConcentrationBps: bigint;
  readonly expectedGrossOutcomeQuoteAtoms: bigint;
  readonly expectedFeesQuoteAtoms: bigint;
  readonly expectedGasQuoteAtoms: bigint;
  readonly expectedFundingCostQuoteAtoms: bigint;
  readonly expectedRebatesQuoteAtoms: bigint;
  readonly marginOffsetPolicy: MarginOffsetPolicy;
  readonly marginOffsetContext: Omit<MarginOffsetContext, "nowMs">;
  readonly stressScenarios: readonly StressScenario[];
}

export interface AuthoritativePortfolioOptimizationRequest {
  readonly strategyAccount: string;
  readonly policy: PortfolioOptimizationPolicyInput;
  readonly candidates: readonly PortfolioOptimizationCandidateProposal[];
}

export interface AuthoritativePortfolioOptimizationPort {
  optimize(request: AuthoritativePortfolioOptimizationRequest): Promise<PortfolioOptimizationResult>;
}

export class AuthoritativePortfolioOptimizationError extends Error {
  readonly code: "INVALID_REQUEST" | "POSITION_SNAPSHOT_NOT_CURRENT" | "COLLATERAL_SNAPSHOT_NOT_CURRENT";

  constructor(code: AuthoritativePortfolioOptimizationError["code"], message: string) {
    super(message);
    this.name = "AuthoritativePortfolioOptimizationError";
    this.code = code;
  }
}

const CANDIDATE_KEYS = Object.freeze([
  "candidateId",
  "collateralSnapshotHash",
  "executionGraphHash",
  "expectedFeesQuoteAtoms",
  "expectedFundingCostQuoteAtoms",
  "expectedGasQuoteAtoms",
  "expectedGrossOutcomeQuoteAtoms",
  "expectedRebatesQuoteAtoms",
  "marginOffsetContext",
  "marginOffsetPolicy",
  "positionSnapshotHash",
  "routeHash",
  "solverConcentrationBps",
  "solverId",
  "stressScenarios",
  "unwindRouteHash",
]);

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AuthoritativePortfolioOptimizationError("INVALID_REQUEST", `${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new AuthoritativePortfolioOptimizationError("INVALID_REQUEST", `${label} fields are invalid.`);
  }
}

function hash(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new AuthoritativePortfolioOptimizationError("INVALID_REQUEST", `${label} must be a lowercase 32-byte hex hash.`);
  }
  return value;
}

export class AuthoritativePortfolioOptimization implements AuthoritativePortfolioOptimizationPort {
  private readonly positions: Pick<{ latest(strategyAccount: string): readonly StoredPositionSnapshot[] }, "latest">;
  private readonly collateral: Pick<{ latest(strategyAccount: string): readonly StoredCollateralSnapshot[] }, "latest">;
  private readonly optimizer: PortfolioOptimizationPort;
  private readonly clock: () => number;

  constructor(options: {
    readonly positions: Pick<{ latest(strategyAccount: string): readonly StoredPositionSnapshot[] }, "latest">;
    readonly collateral: Pick<{ latest(strategyAccount: string): readonly StoredCollateralSnapshot[] }, "latest">;
    readonly optimizer: PortfolioOptimizationPort;
    readonly clock?: () => number;
  }) {
    this.positions = options.positions;
    this.collateral = options.collateral;
    this.optimizer = options.optimizer;
    this.clock = options.clock ?? Date.now;
  }

  async optimize(input: AuthoritativePortfolioOptimizationRequest): Promise<PortfolioOptimizationResult> {
    const request = object(input, "Request");
    exactKeys(request, ["candidates", "policy", "strategyAccount"], "Request");
    if (typeof input.strategyAccount !== "string" || !/^[A-Za-z0-9._:-]{1,64}$/.test(input.strategyAccount)) {
      throw new AuthoritativePortfolioOptimizationError("INVALID_REQUEST", "Strategy account is invalid.");
    }
    if (!Array.isArray(input.candidates) || input.candidates.length === 0 || input.candidates.length > 64) {
      throw new AuthoritativePortfolioOptimizationError("INVALID_REQUEST", "Candidates must contain 1 to 64 entries.");
    }
    const positions = new Map(this.positions.latest(input.strategyAccount).map((entry) => [entry.recordHashHex, entry]));
    const collateral = new Map(this.collateral.latest(input.strategyAccount).map((entry) => [entry.recordHashHex, entry]));
    const candidates: PortfolioOptimizationCandidateInput[] = input.candidates.map((raw, index) => {
      const proposal = object(raw, `Candidate ${index}`);
      exactKeys(proposal, CANDIDATE_KEYS, `Candidate ${index}`);
      const positionHash = hash(raw.positionSnapshotHash, `Candidate ${index} position snapshot hash`);
      const collateralHash = hash(raw.collateralSnapshotHash, `Candidate ${index} collateral snapshot hash`);
      const position = positions.get(positionHash);
      if (position === undefined) {
        throw new AuthoritativePortfolioOptimizationError(
          "POSITION_SNAPSHOT_NOT_CURRENT",
          `Candidate ${index} does not name a current signed position snapshot for the strategy account.`,
        );
      }
      const collateralRecord = collateral.get(collateralHash);
      if (collateralRecord === undefined) {
        throw new AuthoritativePortfolioOptimizationError(
          "COLLATERAL_SNAPSHOT_NOT_CURRENT",
          `Candidate ${index} does not name a current signed collateral snapshot for the strategy account.`,
        );
      }
      return Object.freeze({
        candidateId: raw.candidateId,
        active: true,
        authorityVerified: true,
        positionSnapshot: position.record,
        collateralSnapshot: collateralRecord.record,
        routeHash: raw.routeHash,
        executionGraphHash: raw.executionGraphHash,
        unwindRouteHash: raw.unwindRouteHash,
        solverId: raw.solverId,
        solverConcentrationBps: raw.solverConcentrationBps,
        expectedGrossOutcomeQuoteAtoms: raw.expectedGrossOutcomeQuoteAtoms,
        expectedFeesQuoteAtoms: raw.expectedFeesQuoteAtoms,
        expectedGasQuoteAtoms: raw.expectedGasQuoteAtoms,
        expectedFundingCostQuoteAtoms: raw.expectedFundingCostQuoteAtoms,
        expectedRebatesQuoteAtoms: raw.expectedRebatesQuoteAtoms,
        marginOffsetPolicy: raw.marginOffsetPolicy,
        marginOffsetContext: raw.marginOffsetContext,
        stressScenarios: raw.stressScenarios,
      });
    });
    const decisionAtMs = BigInt(Math.floor(this.clock()));
    const timedCandidates = candidates.map((candidate) => Object.freeze({
      ...candidate,
      marginOffsetContext: Object.freeze({ ...candidate.marginOffsetContext, nowMs: decisionAtMs }),
    }));
    return this.optimizer.optimize({ policy: input.policy, decisionAtMs, candidates: timedCandidates });
  }
}
