import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  admitPrivateRfqEnvelope,
  applySealedAuctionEvent,
  closeSealedAuction,
  openSealedAuction,
  privateRfqAssociatedData,
  privateRfqEnvelopeHash,
  privateRfqResponseAssociatedData,
  replaySealedAuction,
  resolvePrivateDelivery,
  sealedAuctionFallback,
  sealedAuctionHash,
  sealedAuctionPublicView,
  sealedQuoteCommitment,
  toHex,
  verifyPrivateRfqResponse,
  verifySealedAuctionResult,
  type PrivateRfqAdmission,
  type PrivateRfqEnvelopeInput,
  type SealedAuctionDefinitionInput,
  type SealedAuctionEvent,
  type SealedAuctionState,
} from '../src/index.js';
import { DOMAIN, key, manifestInput } from './solver-fixtures.js';

const hex = (fill: string): string => fill.repeat(32);

const envelope: PrivateRfqEnvelopeInput = {
  envelopeVersion: 1,
  environment: 'local',
  domain: DOMAIN,
  templateId: 'cash-and-carry-v1',
  templateVersion: 1,
  packageTemplateManifestHash: hex('44'),
  orderHash: hex('55'),
  senderKeyId: 'taker-key-1',
  responseEncryptionKey: key(7),
  recipientSolverId: 'solver-a',
  recipientEncryptionKeyId: 'rfq-1',
  encryptionSuiteId: 'hpke-x25519-sha256-aes256gcm',
  ciphertextHash: hex('66'),
  createdAtUnit: 'EVM_UNIX_SECONDS',
  createdAtValue: 10n,
  expiresAtUnit: 'EVM_UNIX_SECONDS',
  expiresAtValue: 60n,
  envelopeNonce: 1n,
};

const recipient = manifestInput({
  rfqEncryptionKeys: [
    { keyId: 'rfq-1', encryptionSuiteId: 'hpke-x25519-sha256-aes256gcm', publicKey: key(8), validFromValue: 0n, validUntilValue: 50n },
    { keyId: 'rfq-2', encryptionSuiteId: 'legacy-suite', publicKey: key(9), validFromValue: 50n, validUntilValue: 150n },
  ],
});

const admission: PrivateRfqAdmission = {
  environment: 'local',
  pinnedSuiteIds: ['hpke-x25519-sha256-aes256gcm'],
  recipientManifest: recipient,
  atValue: 20n,
  nonceSeen: false,
  receivedCiphertextHash: hex('66'),
};

describe('private direct RFQ envelope', () => {
  test('admits an intact envelope for its addressed, currently keyed recipient', () => {
    const result = admitPrivateRfqEnvelope(envelope, admission);
    assert.ok(result.admitted);
    assert.equal(toHex(result.envelopeHash), toHex(privateRfqEnvelopeHash(envelope)));
  });

  test('replay, substitution, downgrade, expiry, and mutation fail before decryption', () => {
    const cases: [Partial<PrivateRfqEnvelopeInput>, Partial<PrivateRfqAdmission>, string][] = [
      [{}, { environment: 'devnet' }, 'ENVIRONMENT_MISMATCH'],
      [{ createdAtUnit: 'SOLANA_SLOT', expiresAtUnit: 'SOLANA_SLOT' }, {}, 'CLOCK_MISMATCH'],
      [{ encryptionSuiteId: 'legacy-suite', recipientEncryptionKeyId: 'rfq-2' }, { atValue: 55n }, 'SUITE_NOT_PINNED'],
      [{ recipientSolverId: 'solver-b' }, {}, 'RECIPIENT_MISMATCH'],
      [{ recipientEncryptionKeyId: 'rfq-9' }, {}, 'KEY_UNKNOWN'],
      [{ recipientEncryptionKeyId: 'rfq-2' }, { atValue: 55n }, 'KEY_SUITE_MISMATCH'],
      [{ expiresAtValue: 100n }, { atValue: 55n }, 'KEY_OUTSIDE_VALIDITY'],
      [{}, { atValue: 5n }, 'NOT_YET_VALID'],
      [{ createdAtValue: 0n, expiresAtValue: 15n }, {}, 'ENVELOPE_EXPIRED'],
      [{}, { nonceSeen: true }, 'REPLAY'],
      [{}, { receivedCiphertextHash: hex('67') }, 'CIPHERTEXT_MUTATED'],
    ];
    for (const [change, context, reason] of cases) {
      assert.deepEqual(admitPrivateRfqEnvelope({ ...envelope, ...change }, { ...admission, ...context }), { admitted: false, reason }, reason);
    }
  });

  test('associated data binds every header field except the ciphertext it produces', () => {
    const base = toHex(privateRfqAssociatedData(envelope));
    assert.equal(toHex(privateRfqAssociatedData({ ...envelope, ciphertextHash: hex('77') })), base);
    for (const change of [{ recipientSolverId: 'solver-b' }, { envelopeNonce: 2n }, { expiresAtValue: 61n }, { responseEncryptionKey: key(6) }]) {
      assert.notEqual(toHex(privateRfqAssociatedData({ ...envelope, ...change })), base);
    }
    assert.notEqual(toHex(privateRfqEnvelopeHash({ ...envelope, ciphertextHash: hex('77') })), toHex(privateRfqEnvelopeHash(envelope)));
  });

  test('responses bind the envelope, recipient, response key, and order', () => {
    const response = {
      envelopeHash: privateRfqEnvelopeHash(envelope),
      solverId: 'solver-a',
      quoteHash: hex('88'),
      quoteOrderHash: hex('55'),
      responseEncryptionKey: key(7),
      responseCiphertextHash: hex('99'),
    };
    assert.ok(verifyPrivateRfqResponse(envelope, response).valid);
    assert.deepEqual(verifyPrivateRfqResponse(envelope, { ...response, envelopeHash: hex('12') }), { valid: false, reason: 'ENVELOPE_MISMATCH' });
    assert.deepEqual(verifyPrivateRfqResponse(envelope, { ...response, solverId: 'solver-b' }), { valid: false, reason: 'RESPONDER_MISMATCH' });
    assert.deepEqual(verifyPrivateRfqResponse(envelope, { ...response, responseEncryptionKey: key(6) }), { valid: false, reason: 'RESPONSE_KEY_SUBSTITUTED' });
    assert.deepEqual(verifyPrivateRfqResponse(envelope, { ...response, quoteOrderHash: hex('56') }), { valid: false, reason: 'QUOTE_ORDER_SUBSTITUTED' });
    const associatedData = toHex(privateRfqResponseAssociatedData(response));
    for (const change of [{ solverId: 'solver-b' }, { quoteHash: hex('89') }, { quoteOrderHash: hex('56') }, { responseEncryptionKey: key(6) }]) {
      assert.notEqual(toHex(privateRfqResponseAssociatedData({ ...response, ...change })), associatedData);
    }
  });

  test('a failed private path never downgrades silently', () => {
    const status = {
      requestedMode: 'PRIVATE_DIRECT_RFQ' as const,
      pinnedSuiteAvailable: true,
      keyDiscoveryAvailable: true,
      eligibleSolverIds: ['solver-a', 'solver-b'],
      acknowledgedSolverIds: ['solver-b', 'solver-z'],
      publicFallbackConsented: false,
    };
    assert.deepEqual(resolvePrivateDelivery(status), { outcome: 'DELIVERED', mode: 'PRIVATE_DIRECT_RFQ', privacyClaim: true, acknowledgedCount: 1 });
    assert.deepEqual(resolvePrivateDelivery({ ...status, acknowledgedSolverIds: ['solver-z'] }), {
      outcome: 'NOT_DELIVERED',
      privacyClaim: false,
      reason: 'NO_ELIGIBLE_ACKNOWLEDGEMENT',
    });
    assert.deepEqual(resolvePrivateDelivery({ ...status, pinnedSuiteAvailable: false, publicFallbackConsented: true }), {
      outcome: 'PUBLIC_FALLBACK',
      mode: 'PUBLIC_RFQ',
      privacyClaim: false,
      label: 'PRIVATE_PATH_UNAVAILABLE',
    });
    assert.equal(resolvePrivateDelivery({ ...status, requestedMode: 'PUBLIC_RFQ' }).privacyClaim, false);
  });
});

const auction: SealedAuctionDefinitionInput = {
  version: 1,
  auctionId: 'auction-1',
  environment: 'local',
  orderHash: hex('55'),
  eligibleSolverIds: ['solver-a', 'solver-b', 'solver-c'],
  timeUnit: 'EVM_UNIX_SECONDS',
  commitDeadlineValue: 100n,
  revealDeadlineValue: 200n,
  settlementDeadlineValue: 300n,
  minimumValidReveals: 1,
};
const auctionHash = sealedAuctionHash(auction);
const opening = (solverId: string, netOutcomeAtoms: bigint, fill: number) => ({
  solverId,
  quoteHash: new Uint8Array(32).fill(fill),
  netOutcomeAtoms,
  salt: new Uint8Array(32).fill(fill + 100),
});
const commit = (solverId: string, netOutcomeAtoms: bigint, fill: number, atValue: bigint): SealedAuctionEvent => ({
  kind: 'COMMIT',
  solverId,
  commitment: sealedQuoteCommitment(auctionHash, opening(solverId, netOutcomeAtoms, fill)),
  atValue,
});
const reveal = (solverId: string, netOutcomeAtoms: bigint, fill: number, atValue: bigint): SealedAuctionEvent => ({
  kind: 'REVEAL',
  ...opening(solverId, netOutcomeAtoms, fill),
  atValue,
});

function apply(state: SealedAuctionState, event: SealedAuctionEvent): SealedAuctionState {
  const result = applySealedAuctionEvent(state, event);
  if (!result.accepted) assert.fail(`expected acceptance, got ${result.reason}`);
  return result.state;
}

describe('sealed batch auction', () => {
  test('rejects ineligible, late, duplicate, early, unmatched, and out-of-order events', () => {
    let state = openSealedAuction(auction);
    const reason = (event: SealedAuctionEvent) => {
      const result = applySealedAuctionEvent(state, event);
      return result.accepted ? 'ACCEPTED' : result.reason;
    };
    assert.equal(reason(commit('solver-x', 10n, 1, 10n)), 'NOT_ELIGIBLE');
    state = apply(state, commit('solver-a', 10n, 1, 10n));
    assert.equal(reason(commit('solver-a', 11n, 1, 20n)), 'DUPLICATE_COMMIT');
    assert.equal(reason(reveal('solver-a', 10n, 1, 20n)), 'EARLY_REVEAL');
    assert.equal(reason(commit('solver-b', 10n, 2, 5n)), 'OUT_OF_ORDER');
    assert.equal(reason(commit('solver-b', 10n, 2, 100n)), 'COMMIT_CLOSED');
    assert.equal(reason(reveal('solver-b', 10n, 2, 150n)), 'NO_COMMITMENT');
    assert.equal(reason(reveal('solver-a', 11n, 1, 150n)), 'REVEAL_MISMATCH');
    state = apply(state, reveal('solver-a', 10n, 1, 150n));
    assert.equal(reason(reveal('solver-a', 10n, 1, 160n)), 'DUPLICATE_REVEAL');
    assert.equal(reason(reveal('solver-a', 10n, 1, 200n)), 'AUCTION_CLOSED');
  });

  test('reveals stay withheld until close and the best net outcome wins', () => {
    let state = openSealedAuction(auction);
    state = apply(state, commit('solver-a', 40n, 1, 10n));
    state = apply(state, commit('solver-b', 90n, 2, 20n));
    state = apply(state, commit('solver-c', 70n, 3, 30n));
    assert.deepEqual(sealedAuctionPublicView(state, 50n), { phase: 'COMMIT', commitmentCount: 3 });
    assert.deepEqual(closeSealedAuction(state, 50n), { closed: false, reason: 'COMMIT_WINDOW_OPEN' });
    state = apply(state, reveal('solver-a', 40n, 1, 110n));
    state = apply(state, reveal('solver-c', 70n, 3, 120n));
    assert.deepEqual(closeSealedAuction(state, 150n), { closed: false, reason: 'REVEALS_PENDING' });
    const closed = closeSealedAuction(state, 200n);
    assert.ok(closed.closed);
    const { result } = closed;
    assert.equal(result.outcome, 'AWARDED');
    assert.equal(result.winner?.solverId, 'solver-c');
    assert.deepEqual(result.ranked.map((entry) => entry.solverId), ['solver-c', 'solver-a']);
    assert.deepEqual(result.missingRevealSolverIds, ['solver-b']);
  });

  test('a restarted coordinator recomputes the same result and a substituted winner is detected', () => {
    const events = [
      commit('solver-a', 40n, 1, 10n),
      commit('solver-b', 90n, 2, 20n),
      reveal('solver-b', 90n, 2, 101n),
      reveal('solver-a', 40n, 1, 102n),
      reveal('solver-a', 40n, 1, 103n),
    ];
    const first = replaySealedAuction(auction, events, 150n);
    const restarted = replaySealedAuction(auction, events, 250n);
    assert.equal(toHex(first.result.resultHash), toHex(restarted.result.resultHash));
    assert.deepEqual(first.rejected, [{ index: 4, reason: 'DUPLICATE_REVEAL' }]);
    assert.ok(verifySealedAuctionResult(auction, events, 150n, first.result.resultHash));
    const withoutWinner = replaySealedAuction(auction, events.filter((_, index) => index !== 2), 250n);
    assert.equal(withoutWinner.result.winner?.solverId, 'solver-a');
    assert.equal(verifySealedAuctionResult(auction, events, 150n, withoutWinner.result.resultHash), false);
  });

  test('exact ties are deterministic and the fallback follows rank until the settlement deadline', () => {
    const events = [commit('solver-a', 50n, 1, 10n), commit('solver-b', 50n, 2, 20n), reveal('solver-a', 50n, 1, 110n), reveal('solver-b', 50n, 2, 120n)];
    const { result } = replaySealedAuction(auction, events, 200n);
    const { result: reversed } = replaySealedAuction(
      auction,
      [commit('solver-b', 50n, 2, 10n), commit('solver-a', 50n, 1, 20n), reveal('solver-b', 50n, 2, 110n), reveal('solver-a', 50n, 1, 120n)],
      200n,
    );
    assert.equal(result.winner?.solverId, reversed.winner?.solverId);
    const winner = result.winner?.solverId as string;
    const runnerUp = result.ranked[1]?.solverId as string;
    const fallback = sealedAuctionFallback(auction, result, [winner], 250n);
    assert.equal(fallback.outcome === 'AWARDED' && fallback.award.solverId, runnerUp);
    assert.deepEqual(sealedAuctionFallback(auction, result, [winner, runnerUp], 250n), { outcome: 'NO_FILL', reason: 'NO_REMAINING_QUOTE' });
    assert.deepEqual(sealedAuctionFallback(auction, result, [winner], 300n), { outcome: 'NO_FILL', reason: 'SETTLEMENT_DEADLINE_PASSED' });
  });

  test('too few valid reveals is a no-fill, and deadlines must strictly increase', () => {
    const strict = { ...auction, minimumValidReveals: 2 };
    const { result } = replaySealedAuction(strict, [
      { kind: 'COMMIT', solverId: 'solver-a', commitment: sealedQuoteCommitment(sealedAuctionHash(strict), opening('solver-a', 50n, 1)), atValue: 10n },
      reveal('solver-a', 50n, 1, 110n),
    ], 200n);
    assert.equal(result.outcome, 'NO_FILL');
    assert.equal(result.winner, undefined);
    assert.throws(() => sealedAuctionHash({ ...auction, revealDeadlineValue: 100n }), /strictly increase/);
    assert.throws(() => sealedQuoteCommitment(auctionHash, { ...opening('solver-a', 1n, 1), salt: new Uint8Array(16) }), /salt must be 32 bytes/);
  });
});
