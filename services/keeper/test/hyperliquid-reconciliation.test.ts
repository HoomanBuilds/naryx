import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HYPERCORE_EXECUTION_GUARANTEE,
  type HypercoreOrderWire,
  type HyperliquidExecutionPlan,
} from '@naryx/adapter-hyperliquid';
import {
  adapterRef,
  assetRef,
  domainRef,
  exactPrice,
  hash32,
  manifestHash,
  protocolId,
  versionedManifestRef,
} from '@naryx/protocol-types';
import {
  HYPERCORE_RECONCILIATION_SOURCE,
  beginHyperliquidReconciliation,
  createHyperliquidPackageAttempt,
  markHyperliquidSubmissionUnknown,
  reconcileHyperliquidPackageAttempt,
  type HyperliquidAccountIdentityInput,
  type HyperliquidReconciliationSnapshotInput,
} from '../src/index.js';

const domain = domainRef('hypercore:testnet', 1, '11'.repeat(32));
const account: HyperliquidAccountIdentityInput = {
  masterAccount: `0x${'12'.repeat(20)}`,
  tradingAccount: `0x${'34'.repeat(20)}`,
  accountKind: 'SUBACCOUNT',
};
const spotClientOrderId = `0x${'41'.repeat(16)}` as const;
const perpetualClientOrderId = `0x${'42'.repeat(16)}` as const;
const commitments = {
  seriesManifestHash: manifestHash('51'.repeat(32)),
  executionClassManifestHash: manifestHash('52'.repeat(32)),
  orderHash: hash32('53'.repeat(32)),
  quoteHash: hash32('54'.repeat(32)),
  routeHash: hash32('55'.repeat(32)),
};
const baseAsset = assetRef('btc', '61'.repeat(32), 8);
const quoteAsset = assetRef('usdc', '62'.repeat(32), 6);
const spotAdapter = adapterRef({
  adapterId: 'hypercore-spot-v1',
  adapterManifestVersion: 1,
  adapterManifestHash: '71'.repeat(32),
});
const perpetualAdapter = adapterRef({
  adapterId: 'hypercore-perp-v1',
  adapterManifestVersion: 1,
  adapterManifestHash: '72'.repeat(32),
});
const venue = versionedManifestRef('hypercore', 1, '73'.repeat(32));
const spotMarket = versionedManifestRef('btc-usdc-spot', 1, '74'.repeat(32));
const perpetualMarket = versionedManifestRef('btc-usdc-perp', 1, '75'.repeat(32));
const limitPrice = exactPrice({
  baseAsset,
  quoteAsset,
  baseAtoms: 1n,
  quoteAtoms: 600n,
  roundingDirection: 'CEIL',
});

function order(
  clientOrderId: `0x${string}`,
  isBuy: boolean,
): HypercoreOrderWire {
  return {
    a: isBuy ? 10_007 : 3,
    b: isBuy,
    p: '60000',
    s: '0.000001',
    r: false,
    t: { limit: { tif: 'Ioc' } },
    c: clientOrderId,
  };
}

function executionPlan(kind: 'EXACT_NET' | 'BOUNDED_NET' = 'EXACT_NET'):
  HyperliquidExecutionPlan {
  const spotOrder = order(spotClientOrderId, true);
  const perpetualOrder = order(perpetualClientOrderId, false);
  return {
    version: 1,
    guarantee: HYPERCORE_EXECUTION_GUARANTEE,
    domain,
    commitments,
    requestExpiryMs: 1_000n,
    unsignedRequestFields: {
      action: { type: 'order', orders: [spotOrder, perpetualOrder], grouping: 'na' },
      expiresAfter: 1_000,
    },
    legs: [
      {
        legId: 'spot',
        role: 'SPOT',
        legIndex: 0,
        adapter: spotAdapter,
        venue,
        market: spotMarket,
        baseAsset,
        quoteAsset,
        side: 'BUY',
        quantityAtoms: 100n,
        sizeDecimals: 6,
        maxPriceDecimals: 2,
        signedBaseDeltaAtoms: 100n,
        clientOrderId: spotClientOrderId,
        order: spotOrder,
      },
      {
        legId: 'perpetual',
        role: 'PERPETUAL',
        legIndex: 1,
        adapter: perpetualAdapter,
        venue,
        market: perpetualMarket,
        baseAsset,
        quoteAsset,
        side: 'SELL',
        quantityAtoms: 100n,
        sizeDecimals: 6,
        maxPriceDecimals: 0,
        signedBaseDeltaAtoms: -100n,
        clientOrderId: perpetualClientOrderId,
        order: perpetualOrder,
      },
    ],
    grossSpotQuantityAtoms: 100n,
    prePerpPositionAtoms: 0n,
    signedPerpDeltaAtoms: -100n,
    signedPerpTargetAtoms: -100n,
    terminalResidualPolicy: kind === 'EXACT_NET'
      ? {
          kind: 'EXACT_NET',
          netSpotDeltaAtoms: 100n,
          maxTerminalResidualBaseAtoms: 0n,
          maxTerminalResidualQuoteAtoms: 0n,
        }
      : {
          kind: 'BOUNDED_NET',
          minNetSpotDeltaAtoms: 95n,
          maxNetSpotDeltaAtoms: 105n,
          maxTerminalResidualBaseAtoms: 5n,
          residualValuationSchemaVersion: 1,
          residualValuationReferencePrice: exactPrice({
            baseAsset,
            quoteAsset,
            baseAtoms: 1n,
            quoteAtoms: 600n,
            roundingDirection: 'CEIL',
          }),
          maxTerminalResidualQuoteAtoms: 3_000n,
        },
    recoveryPolicy: {
      policyVersion: 1,
      controllerId: protocolId('hypercore-recovery-controller-v1'),
      controllerCodeHash: manifestHash('76'.repeat(32)),
      authorityModeId: protocolId('agent-wallet-v1'),
      recoveryExpiryUnit: 'HYPERLIQUID_UNIX_MILLISECONDS',
      maxActionExpiryValue: 1_500n,
      deadlineValue: 2_000n,
      minRecoveryWindowMs: 500n,
      maxRecoveryCostCaps: [{ asset: quoteAsset, maxAtoms: 100n }],
      maxAggregateRecoveryLoss: { asset: quoteAsset, atoms: 1_000n },
      maxIntermediateResidual: { asset: baseAsset, atoms: 100n },
      maxTerminalResidual: { asset: baseAsset, atoms: kind === 'EXACT_NET' ? 0n : 5n },
      reconciledStateSchemaHash: manifestHash('77'.repeat(32)),
      actionBuilderCodeHash: manifestHash('78'.repeat(32)),
      actionSlots: [
        {
          sequence: 0,
          action: 'COMPLETE_PERP',
          targetLeg: 1,
          adapter: perpetualAdapter,
          markets: [perpetualMarket],
          maxQuantity: { asset: baseAsset, atoms: 100n },
          limitPrice,
          reduceOnly: false,
          timeInForce: 'IOC',
        },
      ],
    },
    recoveryDeadlineMs: 2_000n,
  };
}

function snapshot(
  overrides: Partial<HyperliquidReconciliationSnapshotInput> = {},
): HyperliquidReconciliationSnapshotInput {
  return {
    source: HYPERCORE_RECONCILIATION_SOURCE,
    domain,
    commitments,
    account,
    evidenceVersion: 1n,
    observedAtMs: 1_100n,
    spot: {
      clientOrderId: spotClientOrderId,
      terminalStatus: 'FILLED',
      openOrderStatus: 'NONE',
      filledSignedBaseAtoms: 100n,
    },
    perpetual: {
      clientOrderId: perpetualClientOrderId,
      terminalStatus: 'FILLED',
      openOrderStatus: 'NONE',
      filledSignedBaseAtoms: -100n,
    },
    netSpotDeltaAtoms: 100n,
    perpetualPositionDeltaAtoms: -100n,
    observedPerpetualPositionAtoms: -100n,
    perpetualPositionTargetAtoms: -100n,
    feeEvidenceComplete: true,
    fees: [{
      assetId: 'USDC',
      assetDecimals: 6,
      amountAtoms: 10n,
      evidenceStatus: 'CONFIRMED',
    }],
    ...overrides,
  };
}

function attempt(kind: 'EXACT_NET' | 'BOUNDED_NET' = 'EXACT_NET') {
  return beginHyperliquidReconciliation(
    markHyperliquidSubmissionUnknown(createHyperliquidPackageAttempt(executionPlan(kind), account)),
  );
}

test('completes EXACT_NET only from authoritative exact terminal evidence', () => {
  const planned = createHyperliquidPackageAttempt(executionPlan(), account);
  assert.equal(planned.status, 'PLANNED');
  const submissionUnknown = markHyperliquidSubmissionUnknown(planned);
  assert.equal(submissionUnknown.status, 'SUBMISSION_UNKNOWN');

  const completed = reconcileHyperliquidPackageAttempt(submissionUnknown, snapshot());
  assert.equal(completed.status, 'COMPLETED_EXACT');
  assert.equal(completed.acceptedEvidence?.evidenceVersion, 1n);
  assert.equal(completed.recoveryObligation, null);
});

test('keeps a zero-residual BOUNDED_NET completion labeled bounded', () => {
  const completed = reconcileHyperliquidPackageAttempt(attempt('BOUNDED_NET'), snapshot());

  assert.equal(completed.status, 'COMPLETED_BOUNDED');
  assert.equal(completed.plan.terminalResidualPolicy.kind, 'BOUNDED_NET');
});

test('classifies two terminal zero-fill IOC legs with no effects as NO_EFFECT', () => {
  const completed = reconcileHyperliquidPackageAttempt(attempt(), snapshot({
    spot: {
      clientOrderId: spotClientOrderId,
      terminalStatus: 'UNFILLED_IOC_CANCELLED',
      openOrderStatus: 'NONE',
      filledSignedBaseAtoms: 0n,
    },
    perpetual: {
      clientOrderId: perpetualClientOrderId,
      terminalStatus: 'REJECTED',
      openOrderStatus: 'NONE',
      filledSignedBaseAtoms: 0n,
    },
    netSpotDeltaAtoms: 0n,
    perpetualPositionDeltaAtoms: 0n,
    observedPerpetualPositionAtoms: 0n,
    fees: [],
  }));

  assert.equal(completed.status, 'NO_EFFECT');
});

test('creates a typed recovery obligation for one-leg execution', () => {
  const recovery = reconcileHyperliquidPackageAttempt(attempt(), snapshot({
    perpetual: {
      clientOrderId: perpetualClientOrderId,
      terminalStatus: 'UNFILLED_IOC_CANCELLED',
      openOrderStatus: 'NONE',
      filledSignedBaseAtoms: 0n,
    },
    perpetualPositionDeltaAtoms: 0n,
    observedPerpetualPositionAtoms: 0n,
  }));

  assert.equal(recovery.status, 'RECOVERY_REQUIRED');
  assert.deepEqual(recovery.reasons, ['ONE_LEG_FILLED']);
  assert.equal(recovery.recoveryObligation?.remainingPerpetualDeltaAtoms, -100n);
  assert.equal(recovery.recoveryObligation?.allowedTerminalOutcome, 'EXACT_NET');
  assert.equal(recovery.recoveryObligation?.deadlineMs, 2_000n);
});

test('does not complete unresolved or unexpectedly open IOC orders', () => {
  const unresolved = reconcileHyperliquidPackageAttempt(attempt(), snapshot({
    spot: {
      clientOrderId: spotClientOrderId,
      terminalStatus: 'UNKNOWN',
      openOrderStatus: 'UNKNOWN',
      filledSignedBaseAtoms: 0n,
    },
    perpetual: {
      clientOrderId: perpetualClientOrderId,
      terminalStatus: 'UNKNOWN',
      openOrderStatus: 'UNKNOWN',
      filledSignedBaseAtoms: 0n,
    },
    netSpotDeltaAtoms: 0n,
    perpetualPositionDeltaAtoms: 0n,
    observedPerpetualPositionAtoms: 0n,
  }));
  assert.equal(unresolved.status, 'RECONCILING');

  const open = reconcileHyperliquidPackageAttempt(attempt(), snapshot({
    spot: {
      clientOrderId: spotClientOrderId,
      terminalStatus: 'FILLED',
      openOrderStatus: 'OPEN',
      filledSignedBaseAtoms: 100n,
    },
  }));
  assert.equal(open.status, 'RECOVERY_REQUIRED');
  assert.deepEqual(open.reasons, ['OPEN_IOC_ORDER']);
});

test('keeps identical terminal replay idempotent and locks stale or conflicting evidence', () => {
  const unresolvedEvidence = snapshot({
    evidenceVersion: 2n,
    observedAtMs: 1_200n,
    spot: {
      clientOrderId: spotClientOrderId,
      terminalStatus: 'UNKNOWN',
      openOrderStatus: 'UNKNOWN',
      filledSignedBaseAtoms: 0n,
    },
    perpetual: {
      clientOrderId: perpetualClientOrderId,
      terminalStatus: 'UNKNOWN',
      openOrderStatus: 'UNKNOWN',
      filledSignedBaseAtoms: 0n,
    },
    netSpotDeltaAtoms: 0n,
    perpetualPositionDeltaAtoms: 0n,
    observedPerpetualPositionAtoms: 0n,
  });
  const unresolved = reconcileHyperliquidPackageAttempt(attempt(), unresolvedEvidence);
  const stale = reconcileHyperliquidPackageAttempt(unresolved, snapshot());
  assert.equal(stale.status, 'MANUAL_INTERVENTION');
  assert.deepEqual(stale.reasons, ['STALE_EVIDENCE']);

  const terminalEvidence = snapshot();
  const completed = reconcileHyperliquidPackageAttempt(attempt(), terminalEvidence);
  assert.strictEqual(
    reconcileHyperliquidPackageAttempt(completed, terminalEvidence),
    completed,
  );
  const conflicting = reconcileHyperliquidPackageAttempt(completed, snapshot({
    evidenceVersion: 2n,
    observedAtMs: 1_200n,
    fees: [{
      assetId: 'USDC',
      assetDecimals: 6,
      amountAtoms: 11n,
      evidenceStatus: 'CONFIRMED',
    }],
  }));
  assert.equal(conflicting.status, 'MANUAL_INTERVENTION');
  assert.deepEqual(conflicting.reasons, ['CONFLICTING_TERMINAL_EVIDENCE']);
  assert.strictEqual(conflicting.acceptedEvidence, completed.acceptedEvidence);
  assert.strictEqual(
    reconcileHyperliquidPackageAttempt(conflicting, snapshot({
      evidenceVersion: 3n,
      observedAtMs: 1_300n,
      netSpotDeltaAtoms: 99n,
    })),
    conflicting,
  );
});

test('fails closed on identity, fee, deadline, overfill, ratio, and impossible-plan evidence', () => {
  const cases: readonly [string, HyperliquidReconciliationSnapshotInput, string][] = [
    ['account', snapshot({
      account: { ...account, tradingAccount: `0x${'35'.repeat(20)}` },
    }), 'MANUAL_INTERVENTION'],
    ['commitment', snapshot({
      commitments: { ...commitments, quoteHash: hash32('ff'.repeat(32)) },
    }), 'MANUAL_INTERVENTION'],
    ['client ID', snapshot({
      spot: { ...snapshot().spot, clientOrderId: `0x${'43'.repeat(16)}` },
    }), 'MANUAL_INTERVENTION'],
    ['fee certainty', snapshot({
      fees: [{
        assetId: 'USDC',
        assetDecimals: 6,
        amountAtoms: 10n,
        evidenceStatus: 'UNCERTAIN',
      }],
    }), 'MANUAL_INTERVENTION'],
    ['deadline', snapshot({ observedAtMs: 2_001n }), 'MANUAL_INTERVENTION'],
    ['overfill', snapshot({
      spot: { ...snapshot().spot, filledSignedBaseAtoms: 101n },
      netSpotDeltaAtoms: 101n,
    }), 'MANUAL_INTERVENTION'],
    ['unequal ratio', snapshot({
      perpetual: {
        ...snapshot().perpetual,
        terminalStatus: 'PARTIALLY_FILLED_IOC_CANCELLED',
        filledSignedBaseAtoms: -50n,
      },
      perpetualPositionDeltaAtoms: -50n,
      observedPerpetualPositionAtoms: -50n,
    }), 'RECOVERY_REQUIRED'],
  ];
  for (const [name, evidence, expected] of cases) {
    assert.equal(
      reconcileHyperliquidPackageAttempt(attempt(), evidence).status,
      expected,
      name,
    );
  }

  const impossible = executionPlan('BOUNDED_NET');
  const bounded = impossible.terminalResidualPolicy;
  assert.equal(bounded.kind, 'BOUNDED_NET');
  assert.throws(
    () => createHyperliquidPackageAttempt({
      ...impossible,
      terminalResidualPolicy: {
        ...bounded,
        minNetSpotDeltaAtoms: 90n,
        maxNetSpotDeltaAtoms: 90n,
        maxTerminalResidualBaseAtoms: 5n,
      },
    }, account),
    /no satisfiable outcome/,
  );
});

test('attributes exactly one package delta on an omnibus account that holds other packages', () => {
  const omnibus = () => beginHyperliquidReconciliation(markHyperliquidSubmissionUnknown(
    createHyperliquidPackageAttempt({
      ...executionPlan(),
      prePerpPositionAtoms: -500n,
      signedPerpTargetAtoms: -600n,
    }, account),
  ));
  const completed = reconcileHyperliquidPackageAttempt(omnibus(), snapshot({
    observedPerpetualPositionAtoms: -600n,
    perpetualPositionTargetAtoms: -600n,
  }));
  assert.equal(completed.status, 'COMPLETED_EXACT');

  // Another package moving the account inside the window breaks the attribution and locks.
  const leaked = reconcileHyperliquidPackageAttempt(omnibus(), snapshot({
    perpetualPositionDeltaAtoms: -150n,
    observedPerpetualPositionAtoms: -650n,
    perpetualPositionTargetAtoms: -600n,
  }));
  assert.equal(leaked.status, 'MANUAL_INTERVENTION');
  assert.deepEqual(leaked.reasons, ['EVIDENCE_INCONSISTENT']);

  // Recovery owes only the unfilled part of this package, never a trade back to a flat account.
  const partial = reconcileHyperliquidPackageAttempt(omnibus(), snapshot({
    perpetual: {
      clientOrderId: perpetualClientOrderId,
      terminalStatus: 'PARTIALLY_FILLED_IOC_CANCELLED',
      openOrderStatus: 'NONE',
      filledSignedBaseAtoms: -60n,
    },
    perpetualPositionDeltaAtoms: -60n,
    observedPerpetualPositionAtoms: -560n,
    perpetualPositionTargetAtoms: -600n,
  }));
  assert.equal(partial.status, 'RECOVERY_REQUIRED');
  assert.equal(partial.recoveryObligation?.remainingPerpetualDeltaAtoms, -40n);
  assert.equal(partial.recoveryObligation?.targetPerpetualPositionAtoms, -600n);
});

test('attributes a spot fill net of its base-token fee dust and locks unexplained dust', () => {
  const dusty = reconcileHyperliquidPackageAttempt(attempt('BOUNDED_NET'), snapshot({
    netSpotDeltaAtoms: 97n,
    fees: [
      { assetId: 'USDC', assetDecimals: 6, amountAtoms: 10n, evidenceStatus: 'CONFIRMED' },
      { assetId: 'btc', assetDecimals: 8, amountAtoms: 3n, evidenceStatus: 'CONFIRMED' },
    ],
  }));
  assert.equal(dusty.status, 'COMPLETED_BOUNDED');

  // The same balance move without a matching base fee is another package's effect.
  const unexplained = reconcileHyperliquidPackageAttempt(attempt('BOUNDED_NET'), snapshot({
    netSpotDeltaAtoms: 97n,
  }));
  assert.equal(unexplained.status, 'MANUAL_INTERVENTION');
  assert.deepEqual(unexplained.reasons, ['EVIDENCE_INCONSISTENT']);
});
