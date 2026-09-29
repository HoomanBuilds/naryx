import type {
  ExecutionHandoff,
  ExecutionReadinessGate,
  ExecutionReadinessScope,
  ExecutionReadinessScopeResolver,
} from "../src/index.js";

export const executionReadinessFixtureGate: ExecutionReadinessGate = Object.freeze({
  authorize: (scope: ExecutionReadinessScope) => Object.freeze({
    handoff: scope.handoff,
    attemptId: scope.attemptId,
    idempotencyKey: scope.idempotencyKey,
    fundedOperationManifestHash: "11".repeat(32),
    readinessDecisionHash: "22".repeat(32),
  }),
});

export const executionReadinessFixtureScopes: ExecutionReadinessScopeResolver = Object.freeze({
  resolve: (
    handoff: ExecutionHandoff,
    request: Readonly<{ attemptId?: string; idempotencyKey: string }>,
  ) => ({
    handoff,
    attemptId: request.attemptId ?? request.idempotencyKey,
    idempotencyKey: request.idempotencyKey,
  }) as ExecutionReadinessScope,
});
