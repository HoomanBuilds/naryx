import assert from "node:assert/strict";
import test from "node:test";
import {
  assetRef,
  collateralSnapshot,
  collateralSnapshotHash,
  positionSnapshotRecord,
  positionSnapshotRecordHash,
  toHex,
  type CollateralSnapshotInput,
  type PortfolioOptimizationCandidateInput,
  type PositionSnapshotRecordInput,
} from "@naryx/protocol-types";
import {
  AuthoritativePortfolioOptimization,
  AuthoritativePortfolioOptimizationError,
  type AuthoritativePortfolioOptimizationRequest,
  type PortfolioOptimizationRequest,
  type PortfolioOptimizationResult,
} from "../src/index.js";

const NOW_MS = 1_790_000_000_000;
const usdc = assetRef("usdc", "33".repeat(32), 6);

const positionInput: PositionSnapshotRecordInput = {
  recordVersion: 1,
  environment: "testnet",
  strategyAccount: "strategy-1",
  sourceId: "position-source",
  observedAtMs: BigInt(NOW_MS - 100),
  positions: [],
  unmappedInstruments: [],
  sourceEvidenceHash: "44".repeat(32),
  authority: "risk-key",
  signature: new Uint8Array(64).fill(1),
};

const collateralInput: CollateralSnapshotInput = {
  version: 2,
  environment: "testnet",
  snapshotId: "collateral-1",
  sourceId: "collateral-source",
  strategyAccount: "strategy-1",
  owner: "owner-1",
  authority: "risk-key",
  observedAtMs: BigInt(NOW_MS - 100),
  asset: usdc,
  riskDomainId: "sol-carry",
  mode: "ISOLATED",
  ownAvailableQuoteAtoms: 10_000_000n,
  borrowAvailableQuoteAtoms: 0n,
  requestedBorrowQuoteAtoms: 0n,
  borrowCostQuoteAtoms: 0n,
  haircutBps: 500n,
  withdrawalDelayMs: 1_000n,
  inventoryEligible: true,
  withdrawalAllowed: true,
  sourceEvidenceHash: "55".repeat(32),
  signature: new Uint8Array(64).fill(2),
};

const position = positionSnapshotRecord(positionInput);
const collateral = collateralSnapshot(collateralInput);
const positionHash = toHex(positionSnapshotRecordHash(position));
const collateralHash = toHex(collateralSnapshotHash(collateral));

function request(overrides: Partial<AuthoritativePortfolioOptimizationRequest> = {}): AuthoritativePortfolioOptimizationRequest {
  return {
    strategyAccount: "strategy-1",
    policy: {} as AuthoritativePortfolioOptimizationRequest["policy"],
    candidates: [{
      candidateId: "candidate-1",
      positionSnapshotHash: positionHash,
      collateralSnapshotHash: collateralHash,
      routeHash: "66".repeat(32),
      executionGraphHash: "77".repeat(32),
      unwindRouteHash: "88".repeat(32),
      solverId: "solver-1",
      solverConcentrationBps: 1_000n,
      expectedGrossOutcomeQuoteAtoms: 100n,
      expectedFeesQuoteAtoms: 10n,
      expectedGasQuoteAtoms: 10n,
      expectedFundingCostQuoteAtoms: 10n,
      expectedRebatesQuoteAtoms: 0n,
      marginOffsetPolicy: {} as AuthoritativePortfolioOptimizationRequest["candidates"][number]["marginOffsetPolicy"],
      marginOffsetContext: {
        reservedRecoveryQuoteAtoms: 1n,
        fundedCreditAvailable: true,
        failedDependencyIds: [],
      },
      stressScenarios: [],
    }],
    ...overrides,
  };
}

test("portfolio optimization resolves current signed state and supplies authority and time", async () => {
  let received: PortfolioOptimizationRequest | undefined;
  const expected = Object.freeze({}) as PortfolioOptimizationResult;
  const optimizer = {
    optimize(input: PortfolioOptimizationRequest): Promise<PortfolioOptimizationResult> {
      received = input;
      return Promise.resolve(expected);
    },
  };
  const service = new AuthoritativePortfolioOptimization({
    positions: {
      latest: () => [{ record: position, recordHashHex: positionHash, recordedAtMs: NOW_MS }],
    },
    collateral: {
      latest: () => [{ record: collateral, recordHashHex: collateralHash, recordedAtMs: NOW_MS }],
    },
    optimizer,
    clock: () => NOW_MS,
  });

  assert.equal(await service.optimize(request()), expected);
  assert.equal(received?.decisionAtMs, BigInt(NOW_MS));
  const [candidate] = received?.candidates as readonly PortfolioOptimizationCandidateInput[];
  assert.equal(candidate?.authorityVerified, true);
  assert.equal(candidate?.active, true);
  assert.equal(candidate?.positionSnapshot, position);
  assert.equal(candidate?.collateralSnapshot, collateral);
  assert.equal(candidate?.marginOffsetContext.nowMs, BigInt(NOW_MS));

  await assert.rejects(
    () => service.optimize(request({
      candidates: [{ ...request().candidates[0]!, positionSnapshotHash: "99".repeat(32) }],
    })),
    (error: unknown) => error instanceof AuthoritativePortfolioOptimizationError
      && error.code === "POSITION_SNAPSHOT_NOT_CURRENT",
  );
});
