import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HYPERCORE_EXECUTION_GUARANTEE,
  type HypercoreOrderWire,
  type HyperliquidExecutionPlan,
} from '@naryx/adapter-hyperliquid';
import { domainRef, hash32, manifestHash } from '@naryx/protocol-types';
import {
  acknowledgeHyperliquidSubmission,
  beginHyperliquidSubmissionReconciliation,
  confirmHyperliquidDurableRecord,
  createHyperliquidSubmissionJournal,
  fenceHyperliquidAgentWallet,
  hyperliquidReconciliationHandoff,
  markHyperliquidSubmittedUnknown,
  prepareHyperliquidSubmission,
  registerHyperliquidAgentWallet,
  rejectHyperliquidSubmission,
  type HyperliquidSubmissionJournal,
} from '../src/hyperliquid-submission-journal.js';

const masterAccount = `0x${'11'.repeat(20)}` as const;
const tradingAccount = `0x${'22'.repeat(20)}` as const;
const agentWallet = `0x${'33'.repeat(20)}` as const;
const secondAgentWallet = `0x${'44'.repeat(20)}` as const;
const spotClientOrderId = `0x${'51'.repeat(16)}` as const;
const perpetualClientOrderId = `0x${'52'.repeat(16)}` as const;
const nowMs = 1_000_000_000n;
const nonce = nowMs + 1n;

function wire(clientOrderId: `0x${string}`, buy: boolean): HypercoreOrderWire {
  return { a: buy ? 10_007 : 3, b: buy, p: '60000', s: '0.000001', r: false,
    t: { limit: { tif: 'Ioc' } }, c: clientOrderId };
}

function plan(): HyperliquidExecutionPlan {
  const spot = wire(spotClientOrderId, true);
  const perpetual = wire(perpetualClientOrderId, false);
  return {
    version: 1,
    guarantee: HYPERCORE_EXECUTION_GUARANTEE,
    domain: domainRef('hypercore:testnet', 1, '61'.repeat(32)),
    commitments: {
      seriesManifestHash: manifestHash('62'.repeat(32)),
      executionClassManifestHash: manifestHash('63'.repeat(32)),
      orderHash: hash32('64'.repeat(32)),
      quoteHash: hash32('65'.repeat(32)),
      routeHash: hash32('66'.repeat(32)),
    },
    requestExpiryMs: nowMs + 5_000n,
    unsignedRequestFields: {
      action: { type: 'order', orders: [spot, perpetual], grouping: 'na' },
      expiresAfter: Number(nowMs + 5_000n),
    },
    legs: [
      { role: 'SPOT', signedBaseDeltaAtoms: 100n, clientOrderId: spotClientOrderId, order: spot },
      { role: 'PERPETUAL', signedBaseDeltaAtoms: -100n,
        clientOrderId: perpetualClientOrderId, order: perpetual },
    ],
    grossSpotQuantityAtoms: 100n,
    prePerpPositionAtoms: 0n,
    signedPerpDeltaAtoms: -100n,
    signedPerpTargetAtoms: -100n,
    terminalResidualPolicy: {
      kind: 'EXACT_NET', netSpotDeltaAtoms: 100n,
      maxTerminalResidualBaseAtoms: 0n, maxTerminalResidualQuoteAtoms: 0n,
    },
    recoveryDeadlineMs: nowMs + 10_000n,
  };
}

function registered(): HyperliquidSubmissionJournal {
  return registerHyperliquidAgentWallet(createHyperliquidSubmissionJournal(), {
    expectedVersion: 0n, agentWallet, signerLeaseId: 'process-1',
  });
}

function prepared(journal = registered(), overrides: Record<string, unknown> = {}) {
  return prepareHyperliquidSubmission(journal, {
    expectedVersion: journal.version,
    attemptId: 'attempt-1', agentWallet, signerLeaseId: 'process-1',
    plan: plan(), account: { masterAccount, tradingAccount, accountKind: 'SUBACCOUNT' },
    nonce, nowMs, vaultAddress: tradingAccount, ...overrides,
  });
}

function durable(journal = prepared()) {
  const record = journal.agents[0]!.attempts[0]!;
  return confirmHyperliquidDurableRecord(journal, {
    expectedVersion: journal.version, attemptId: record.attemptId,
    recordHash: record.recordHash, durableRevision: 'store-rev-7',
  });
}

test('reserves one monotonic nonce and replays an identical prepare without a second reservation', () => {
  const initial = registered();
  const first = prepared(initial);
  assert.equal(first.agents[0]!.highestReservedNonce, nonce);
  assert.equal(first.agents[0]!.attempts[0]!.status, 'PREPARED');
  assert.strictEqual(prepared(first, { expectedVersion: initial.version }), first);
  assert.throws(() => prepared(first, { attemptId: 'attempt-2' }), /strictly increase/);
  assert.throws(() => prepared(first, { attemptId: 'attempt-1', nonce: nonce + 1n }),
    /attempt replay changed/);
  assert.throws(() => prepareHyperliquidSubmission(first, {
    expectedVersion: initial.version, attemptId: 'attempt-2', agentWallet,
    signerLeaseId: 'process-1', plan: plan(),
    account: { masterAccount, tradingAccount, accountKind: 'SUBACCOUNT' },
    nonce: nonce + 2n, nowMs, vaultAddress: tradingAccount,
  }), /compare-and-set/);
});

test('binds account, lease, action and all plan commitments before durable confirmation', () => {
  const initial = registered();
  assert.throws(() => prepared(initial, { signerLeaseId: 'process-2' }), /lease mismatch/);
  assert.throws(() => prepared(initial, {
    account: { masterAccount, tradingAccount: agentWallet, accountKind: 'SUBACCOUNT' },
  }), /agent wallet must be distinct/);
  assert.throws(() => prepared(initial, { vaultAddress: null }), /vault context/);
  assert.throws(() => prepared(initial, { vaultAddress: masterAccount }), /vault context/);
  assert.throws(() => prepared(initial, {
    account: { masterAccount, tradingAccount: masterAccount, accountKind: 'MASTER' },
  }), /vault context/);
  const malformed = plan();
  const swapped = wire(`0x${'53'.repeat(16)}`, true);
  assert.throws(() => prepared(initial, { plan: {
    ...malformed, unsignedRequestFields: {
      ...malformed.unsignedRequestFields,
      action: { ...malformed.unsignedRequestFields.action,
        orders: [swapped, malformed.unsignedRequestFields.action.orders[1]] },
    },
  } }), /action does not match/);
  const saved = prepared(initial);
  assert.throws(() => confirmHyperliquidDurableRecord(saved, {
    expectedVersion: saved.version, attemptId: 'attempt-1',
    recordHash: `0x${'00'.repeat(32)}`, durableRevision: 'store-rev-7',
  }), /hash mismatch/);
  const replayPlan = plan();
  assert.throws(() => prepared(saved, {
    plan: { ...replayPlan, commitments: {
      ...replayPlan.commitments, routeHash: hash32('ff'.repeat(32)),
    } },
  }), /attempt replay changed/);
});

test('requires durable confirmation before send and reconciles crash or response loss', () => {
  const saved = prepared();
  assert.throws(() => markHyperliquidSubmittedUnknown(saved, {
    expectedVersion: saved.version, attemptId: 'attempt-1', nowMs,
  }), /cannot follow/);
  assert.throws(() => hyperliquidReconciliationHandoff(saved, 'attempt-1'), /unconfirmed/);
  const confirmed = durable(saved);
  const afterCrash = hyperliquidReconciliationHandoff(confirmed, 'attempt-1');
  assert.equal(afterCrash.attempt.status, 'RECONCILING');
  assert.equal(afterCrash.account.tradingAccount, tradingAccount);
  assert.notEqual(afterCrash.account.tradingAccount, afterCrash.agentWallet);
  assert.equal(afterCrash.spotClientOrderId, spotClientOrderId);
  assert.equal(afterCrash.perpetualClientOrderId, perpetualClientOrderId);
  assert.equal(afterCrash.vaultAddress, tradingAccount);
  assert.equal(afterCrash.actionCommitmentScheme,
    'NARYX_CANONICAL_HYPERCORE_ACTION_SHA256_V1');
  assert.equal(afterCrash.attempt.plan.commitments.routeHash.toString(),
    saved.agents[0]!.attempts[0]!.packageAttempt.plan.commitments.routeHash.toString());
  afterCrash.attempt.plan.commitments.routeHash[0] = 0;
  assert.notEqual(afterCrash.attempt.plan.commitments.routeHash[0],
    hyperliquidReconciliationHandoff(confirmed, 'attempt-1').attempt.plan.commitments.routeHash[0]);
  const unknown = markHyperliquidSubmittedUnknown(confirmed, {
    expectedVersion: confirmed.version, attemptId: 'attempt-1', nowMs,
  });
  assert.strictEqual(confirmHyperliquidDurableRecord(unknown, {
    expectedVersion: confirmed.version, attemptId: 'attempt-1',
    recordHash: unknown.agents[0]!.attempts[0]!.recordHash,
    durableRevision: 'store-rev-7',
  }), unknown);
  assert.strictEqual(markHyperliquidSubmittedUnknown(unknown, {
    expectedVersion: confirmed.version, attemptId: 'attempt-1', nowMs,
  }), unknown);
  assert.equal(hyperliquidReconciliationHandoff(unknown, 'attempt-1').attempt.status, 'RECONCILING');
});

test('acknowledgement and rejection are informational and both require account reconciliation', () => {
  const confirmed = durable();
  const unknown = markHyperliquidSubmittedUnknown(confirmed, {
    expectedVersion: confirmed.version, attemptId: 'attempt-1', nowMs,
  });
  const acknowledged = acknowledgeHyperliquidSubmission(unknown, {
    expectedVersion: unknown.version, attemptId: 'attempt-1', acknowledgementId: 'ack-1',
  });
  assert.equal(acknowledged.agents[0]!.attempts[0]!.status, 'ACKNOWLEDGED');
  assert.equal(hyperliquidReconciliationHandoff(acknowledged, 'attempt-1').attempt.status,
    'RECONCILING');
  assert.strictEqual(acknowledgeHyperliquidSubmission(acknowledged, {
    expectedVersion: unknown.version, attemptId: 'attempt-1', acknowledgementId: 'ack-1',
  }), acknowledged);
  assert.throws(() => acknowledgeHyperliquidSubmission(acknowledged, {
    expectedVersion: acknowledged.version, attemptId: 'attempt-1', acknowledgementId: 'ack-2',
  }), /requires submitted-unknown/);
  const rejected = rejectHyperliquidSubmission(unknown, {
    expectedVersion: unknown.version, attemptId: 'attempt-1', rejectionId: 'reject-1',
  });
  assert.equal(hyperliquidReconciliationHandoff(rejected, 'attempt-1').attempt.status,
    'RECONCILING');
  const reconciling = beginHyperliquidSubmissionReconciliation(rejected, {
    expectedVersion: rejected.version, attemptId: 'attempt-1',
  });
  assert.equal(reconciling.agents[0]!.attempts[0]!.status, 'RECONCILING');
  assert.strictEqual(rejectHyperliquidSubmission(reconciling, {
    expectedVersion: rejected.version, attemptId: 'attempt-1', rejectionId: 'reject-1',
  }), reconciling);
});

test('rejects stale expiry and nonces outside the venue time window', () => {
  const initial = registered();
  const stale = plan();
  assert.throws(() => prepared(initial, { plan: {
    ...stale, requestExpiryMs: nowMs,
    unsignedRequestFields: { ...stale.unsignedRequestFields, expiresAfter: Number(nowMs) },
  } }), /expiresAfter is stale/);
  assert.throws(() => prepared(initial, { nonce: nowMs + 86_400_001n }), /time window/);
  assert.throws(() => prepared(initial, { nonce: nowMs - 172_800_001n }), /clock and nonce must be positive|time window/);
  const confirmed = durable();
  assert.throws(() => markHyperliquidSubmittedUnknown(confirmed, {
    expectedVersion: confirmed.version, attemptId: 'attempt-1', nowMs: nowMs + 5_000n,
  }), /stale before submission/);
});

test('fencing prevents further submission and permanently excludes the old agent address', () => {
  const saved = durable();
  const fenced = fenceHyperliquidAgentWallet(saved, {
    expectedVersion: saved.version, agentWallet, signerLeaseId: 'process-1', disposition: 'FENCED',
  });
  assert.equal(fenced.agents[0]!.attempts[0]!.status, 'FENCED');
  assert.equal(hyperliquidReconciliationHandoff(fenced, 'attempt-1').attempt.status,
    'RECONCILING');
  assert.throws(() => prepared(fenced, { attemptId: 'attempt-2', nonce: nonce + 1n }),
    /fenced or retired/);
  assert.throws(() => registerHyperliquidAgentWallet(fenced, {
    expectedVersion: fenced.version, agentWallet, signerLeaseId: 'process-2',
  }), /already registered or retired/);
  const next = registerHyperliquidAgentWallet(fenced, {
    expectedVersion: fenced.version, agentWallet: secondAgentWallet,
    signerLeaseId: 'process-2',
  });
  assert.equal(next.agents[1]!.status, 'ACTIVE');
});

test('a failed signer before durable confirmation cannot create a reconciliation handoff', () => {
  const saved = prepared();
  const fenced = fenceHyperliquidAgentWallet(saved, {
    expectedVersion: saved.version, agentWallet, signerLeaseId: 'process-1', disposition: 'RETIRED',
  });
  assert.throws(() => hyperliquidReconciliationHandoff(fenced, 'attempt-1'), /unconfirmed/);
});
