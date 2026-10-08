import {
  optimizePortfolio,
  type PortfolioCandidateDecision,
  type PortfolioOptimizationCandidateInput,
  type PortfolioOptimizationDecision,
  type PortfolioOptimizationPolicyInput,
} from '@naryx/protocol-types';

export interface PortfolioOptimizationRequest {
  readonly policy: PortfolioOptimizationPolicyInput;
  readonly decisionAtMs: bigint;
  readonly candidates: readonly PortfolioOptimizationCandidateInput[];
}

export interface SelectedPortfolioOptimization {
  readonly decision: PortfolioOptimizationDecision;
  readonly selectedCandidate: PortfolioCandidateDecision;
}

export type PortfolioOptimizer = (
  policy: PortfolioOptimizationPolicyInput,
  decisionAtMs: bigint,
  candidates: readonly PortfolioOptimizationCandidateInput[],
) => PortfolioOptimizationDecision;

export type PortfolioOptimizationServiceErrorCode =
  | 'NO_ELIGIBLE_CANDIDATE'
  | 'INVALID_OPTIMIZER_DECISION';

export class PortfolioOptimizationServiceError extends Error {
  readonly code: PortfolioOptimizationServiceErrorCode;
  readonly decision: PortfolioOptimizationDecision;

  constructor(code: PortfolioOptimizationServiceErrorCode, decision: PortfolioOptimizationDecision) {
    super(`${code}: portfolio optimization did not produce an executable selection`);
    this.name = 'PortfolioOptimizationServiceError';
    this.code = code;
    this.decision = decision;
  }
}

export class PortfolioOptimizationService {
  readonly #optimizer: PortfolioOptimizer;

  constructor(optimizer: PortfolioOptimizer = optimizePortfolio) {
    this.#optimizer = optimizer;
  }

  decide(request: PortfolioOptimizationRequest): SelectedPortfolioOptimization {
    if (typeof request !== 'object' || request === null) throw new Error('portfolio optimization request must be an object');
    const decision = this.#optimizer(request.policy, request.decisionAtMs, request.candidates);
    if (decision.selectedCandidateId === undefined) {
      throw new PortfolioOptimizationServiceError('NO_ELIGIBLE_CANDIDATE', decision);
    }
    const selectedCandidate = decision.candidates.find(
      (candidate) => candidate.candidateId === decision.selectedCandidateId,
    );
    if (selectedCandidate === undefined || !selectedCandidate.eligible) {
      throw new PortfolioOptimizationServiceError('INVALID_OPTIMIZER_DECISION', decision);
    }
    return Object.freeze({ decision, selectedCandidate });
  }
}
