import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  MalformedInputError,
  authorizeSolverQuote,
  commitSolverCapacity,
  domainRef,
  evaluateSolverQualification,
  openSolverCapacityLedger,
  promoteSolverQualification,
  refreshSolverCapacity,
  releaseSolverCapacity,
  solverCapabilityManifest,
  solverCapabilityManifestHash,
  solverCapacityStatus,
  toHex,
  unsignedSolverCapabilityManifestBytes,
  type SolverCapacityLedger,
  type SolverCapacityRecordInput,
  type SolverQuoteAuthorizationQuery,
} from '../src/index.js';
import { loadFixture } from './fixtures.js';
import { DOMAIN, USD, key, manifestInput } from './solver-fixtures.js';

function query(overrides: Partial<SolverQuoteAuthorizationQuery> = {}): SolverQuoteAuthorizationQuery {
  return {
    environment: 'local',
    domain: DOMAIN,
    templateId: 'cash-and-carry-v1',
    quoteMode: 'IMPLIED',
    marketId: 'sol-carry',
    notionalAtoms: 1_000n,
    scheme: 'ED25519',
    verificationKey: key(2),
    atValue: 50n,
    ...overrides,
  };
}

function record(overrides: Partial<SolverCapacityRecordInput> = {}): SolverCapacityRecordInput {
  return {
    version: 1,
    environment: 'local',
    solverId: 'solver-a',
    domain: DOMAIN,
    asset: USD,
    availableAtoms: 100n,
    maximumConcurrentRecoveryAtoms: 10n,
    evidenceGrade: 'ONCHAIN_RESERVED',
    evidenceCommitment: '44'.repeat(32),
    observedAtValue: 1n,
    expiresAtValue: 1_000n,
    ...overrides,
  };
}

function commit(ledger: SolverCapacityLedger, id: number, atoms: bigint, extra: { recoveryAtoms?: bigint; firm?: boolean; atValue?: bigint } = {}) {
  return commitSolverCapacity(ledger, {
    commitmentId: id.toString(16).padStart(64, '0'),
    atoms,
    recoveryAtoms: extra.recoveryAtoms ?? 0n,
    firm: extra.firm ?? true,
    atValue: extra.atValue ?? 10n,
  });
}

function committed(result: ReturnType<typeof commit>): SolverCapacityLedger {
  assert.equal(result.accepted, true, result.accepted ? '' : result.rejection);
  if (!result.accepted) throw new Error('unreachable');
  return result.ledger;
}

describe('solver capability manifest', () => {
  test('unsigned bytes and hash match the committed golden vector', () => {
    const fixture = loadFixture<{ bytesHex: string; hashHex: string }>('solver-capability-manifest.json');
    assert.equal(toHex(unsignedSolverCapabilityManifestBytes(manifestInput())), fixture.bytesHex);
    assert.equal(toHex(solverCapabilityManifestHash(manifestInput())), fixture.hashHex);
  });

  test('the hash covers content, not input order or the signature', () => {
    const base = solverCapabilityManifestHash(manifestInput());
    const reordered = manifestInput({
      supportedQuoteModes: ['FIRM_ONCHAIN', 'IMPLIED'],
      quoteVerificationKeys: [...manifestInput().quoteVerificationKeys].reverse(),
      signature: new Uint8Array(64).fill(7),
    });
    assert.equal(toHex(solverCapabilityManifestHash(reordered)), toHex(base));
    assert.notEqual(toHex(solverCapabilityManifestHash(manifestInput({ manifestNonce: 2n }))), toHex(base));
  });

  test('ambiguous, malformed, or duplicate capability rejects', () => {
    const overlap = manifestInput({
      quoteVerificationKeys: [
        { keyId: 'q-1', scheme: 'ED25519', verificationKey: key(2), validFromValue: 0n, validUntilValue: 101n },
        { keyId: 'q-2', scheme: 'ED25519', verificationKey: key(3), validFromValue: 100n, validUntilValue: 200n },
      ],
    });
    assert.throws(() => solverCapabilityManifest(overlap), /overlap/);
    const empty = { keyId: 'q-1', scheme: 'ED25519' as const, verificationKey: key(2), validFromValue: 5n, validUntilValue: 5n };
    assert.throws(() => solverCapabilityManifest(manifestInput({ quoteVerificationKeys: [empty] })), /interval is empty/);
    assert.throws(() => solverCapabilityManifest(manifestInput({ operatorIdentityKey: new Uint8Array(31) })), MalformedInputError);
    const cap = manifestInput().maximumNotionalByMarket[0] as never;
    assert.throws(() => solverCapabilityManifest(manifestInput({ maximumNotionalByMarket: [cap, cap] })), /two notional caps/);
    assert.throws(() => solverCapabilityManifest(manifestInput({ manifestVersion: 2 })), MalformedInputError);
  });

  test('authorization is scoped to environment, domain, template, mode, market, notional, and key validity', () => {
    const manifest = manifestInput();
    assert.deepEqual(authorizeSolverQuote(manifest, query()), { authorized: true, keyId: 'q-1' });
    const reason = (overrides: Partial<SolverQuoteAuthorizationQuery>) => {
      const result = authorizeSolverQuote(manifest, query(overrides));
      return result.authorized ? 'AUTHORIZED' : result.reason;
    };
    assert.equal(reason({ environment: 'testnet' }), 'ENVIRONMENT_MISMATCH');
    assert.equal(reason({ atValue: 150n }), 'MANIFEST_EXPIRED');
    assert.equal(reason({ domain: domainRef('svm:solana-devnet', 2, '22'.repeat(32)) }), 'DOMAIN_UNSUPPORTED');
    assert.equal(reason({ templateId: 'reverse-carry-v1' }), 'TEMPLATE_UNSUPPORTED');
    assert.equal(reason({ quoteMode: 'EXECUTION_COMMITMENT' }), 'QUOTE_MODE_UNSUPPORTED');
    assert.equal(reason({ marketId: 'eth-carry' }), 'MARKET_UNSUPPORTED');
    assert.equal(reason({ notionalAtoms: 1_001n }), 'NOTIONAL_ABOVE_CAPABILITY');
    assert.equal(reason({ verificationKey: key(4) }), 'KEY_UNKNOWN');
    assert.equal(reason({ atValue: 120n }), 'KEY_OUTSIDE_VALIDITY');
    assert.equal(reason({ atValue: 120n, verificationKey: key(3) }), 'AUTHORIZED');
  });
});

describe('solver capacity ledger', () => {
  test('commitments debit capacity to the exact boundary', () => {
    let ledger = openSolverCapacityLedger(record());
    ledger = committed(commit(ledger, 1, 60n));
    const over = commit(ledger, 2, 41n);
    assert.equal(over.accepted ? '' : over.rejection, 'INSUFFICIENT_CAPACITY');
    ledger = committed(commit(ledger, 2, 40n));
    assert.equal(solverCapacityStatus(ledger, 10n).remainingAtoms, 0n);
    const duplicate = commit(ledger, 2, 1n);
    assert.equal(duplicate.accepted ? '' : duplicate.rejection, 'DUPLICATE_COMMITMENT');
    ledger = releaseSolverCapacity(ledger, (1).toString(16).padStart(64, '0'));
    assert.equal(solverCapacityStatus(ledger, 10n).remainingAtoms, 60n);
    assert.throws(() => releaseSolverCapacity(ledger, (1).toString(16).padStart(64, '0')), /not outstanding/);
  });

  test('firm commitments need onchain evidence and recovery capacity', () => {
    const attested = openSolverCapacityLedger(record({ evidenceGrade: 'OPERATOR_ATTESTED' }));
    const firm = commit(attested, 1, 10n);
    assert.equal(firm.accepted ? '' : firm.rejection, 'EVIDENCE_TOO_WEAK_FOR_FIRM');
    assert.equal(commit(attested, 1, 10n, { firm: false }).accepted, true);
    const recovery = commit(openSolverCapacityLedger(record()), 1, 10n, { recoveryAtoms: 11n });
    assert.equal(recovery.accepted ? '' : recovery.rejection, 'INSUFFICIENT_RECOVERY_CAPACITY');
    const expired = commit(openSolverCapacityLedger(record()), 1, 10n, { atValue: 1_000n });
    assert.equal(expired.accepted ? '' : expired.rejection, 'RECORD_EXPIRED');
  });

  test('weaker evidence forces reduce-only wind-down while releases continue', () => {
    let ledger = committed(commit(openSolverCapacityLedger(record()), 1, 80n));
    ledger = committed(commit(ledger, 2, 20n));
    ledger = refreshSolverCapacity(ledger, record({ availableAtoms: 90n, observedAtValue: 2n }));
    assert.equal(solverCapacityStatus(ledger, 10n).state, 'REDUCE_ONLY');
    const blocked = commit(ledger, 3, 1n);
    assert.equal(blocked.accepted ? '' : blocked.rejection, 'WIND_DOWN');
    ledger = releaseSolverCapacity(ledger, (2).toString(16).padStart(64, '0'));
    assert.equal(solverCapacityStatus(ledger, 10n).state, 'ACTIVE');
    assert.throws(() => refreshSolverCapacity(ledger, record({ observedAtValue: 2n })), /only moves forward/);
    assert.throws(() => refreshSolverCapacity(ledger, record({ solverId: 'solver-b', observedAtValue: 3n })), /another solver/);
  });

  test('the outstanding commitment root is order independent', () => {
    const base = openSolverCapacityLedger(record());
    const one = committed(commit(committed(commit(base, 1, 10n)), 2, 10n));
    const two = committed(commit(committed(commit(base, 2, 10n)), 1, 10n));
    assert.equal(
      toHex(solverCapacityStatus(one, 10n).outstandingCommitmentRoot),
      toHex(solverCapacityStatus(two, 10n).outstandingCommitmentRoot),
    );
    assert.notEqual(
      toHex(solverCapacityStatus(one, 10n).outstandingCommitmentRoot),
      toHex(solverCapacityStatus(base, 10n).outstandingCommitmentRoot),
    );
  });
});

describe('solver qualification', () => {
  const policy = {
    minimumSample: 10n,
    minimumCoverageBps: 5_000n,
    minimumSettlementBps: 9_900n,
    maximumFadeBps: 100n,
    maximumResidualBreaches: 0n,
    maximumDisputesLost: 0n,
  };
  const healthy = {
    eligibleRequests: 200n,
    responses: 180n,
    acceptedQuotes: 100n,
    settledAcceptedQuotes: 99n,
    fadedAcceptedQuotes: 1n,
    residualBreaches: 0n,
    disputesLost: 0n,
  };

  test('raw metrics downgrade automatically at their exact thresholds', () => {
    assert.deepEqual(evaluateSolverQualification('ACTIVE', healthy, policy), { state: 'ACTIVE', triggers: [] });
    const settlement = evaluateSolverQualification('ACTIVE', { ...healthy, settledAcceptedQuotes: 98n }, policy);
    assert.deepEqual([settlement.state, settlement.triggers], ['REDUCE_ONLY', ['SETTLEMENT_RATE']]);
    const fade = evaluateSolverQualification('ACTIVE', { ...healthy, settledAcceptedQuotes: 98n, fadedAcceptedQuotes: 2n }, policy);
    assert.deepEqual([fade.state, fade.triggers], ['REDUCE_ONLY', ['SETTLEMENT_RATE', 'FADE_RATE']]);
    const coverage = evaluateSolverQualification('ACTIVE', { ...healthy, responses: 99n, acceptedQuotes: 99n, settledAcceptedQuotes: 99n, fadedAcceptedQuotes: 0n }, policy);
    assert.deepEqual([coverage.state, coverage.triggers], ['RESTRICTED', ['COVERAGE']]);
    assert.equal(evaluateSolverQualification('ACTIVE', { ...healthy, disputesLost: 1n }, policy).state, 'QUARANTINED');
  });

  test('a small sample cannot trip rate triggers and evaluation never promotes', () => {
    const small = { ...healthy, eligibleRequests: 9n, responses: 1n, acceptedQuotes: 1n, settledAcceptedQuotes: 0n, fadedAcceptedQuotes: 1n };
    assert.equal(evaluateSolverQualification('ACTIVE', small, policy).state, 'ACTIVE');
    assert.equal(evaluateSolverQualification('QUARANTINED', healthy, policy).state, 'QUARANTINED');
    assert.throws(() => evaluateSolverQualification('ACTIVE', { ...healthy, responses: 201n }, policy), /inconsistent/);
  });

  test('promotion needs two distinct reviewers and must lower severity', () => {
    assert.equal(promoteSolverQualification('QUARANTINED', 'RESTRICTED', ['review-a', 'review-b']), 'RESTRICTED');
    assert.throws(() => promoteSolverQualification('QUARANTINED', 'ACTIVE', ['review-a', 'review-a']), /two distinct/);
    assert.throws(() => promoteSolverQualification('RESTRICTED', 'REDUCE_ONLY', ['review-a', 'review-b']), /lower severity/);
  });
});
