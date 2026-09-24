import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  MalformedInputError,
  assetRef,
  asyncBondedAuthorization,
  asyncBondedAuthorizationBytes,
  asyncBondedAuthorizationHash,
  asyncBondedTransition,
  asyncBondedTransitionHash,
  domainRef,
  fromHex,
  toHex,
  versionedManifestRef,
  type AsyncBondedAuthorizationInput,
  type AsyncBondedTransitionInput,
} from '../src/index.js';

const hash = (byte: string): string => byte.repeat(64);

function authorizationInput(
  overrides: Partial<AsyncBondedAuthorizationInput> = {},
): AsyncBondedAuthorizationInput {
  const arb = domainRef('arbitrum-sepolia', 1, hash('1'));
  const usdc = assetRef('usdc', hash('2'), 6);
  const weth = assetRef('weth', hash('3'), 18);
  return {
    version: 1,
    domain: arb,
    orderHash: hash('4'),
    quoteHash: hash('5'),
    routeHash: hash('6'),
    seriesBindingHash: hash('7'),
    executionClassManifestHash: hash('8'),
    strategyAccount: 'strategy-account-1',
    solver: 'solver-alpha',
    venue: versionedManifestRef('gmx', 1, hash('9')),
    market: versionedManifestRef('eth-usd-perp', 1, hash('a')),
    handler: versionedManifestRef('gmx-order-handler', 3, hash('b')),
    handlerCodeHash: hash('c'),
    callbackTarget: 'naryx-async-coordinator',
    requestCommitment: hash('d'),
    reservationId: hash('e'),
    bondId: hash('f'),
    bond: { asset: usdc, atoms: 10_000_000n },
    recoveryReserve: { asset: usdc, atoms: 2_000_000n },
    maxAggregateLoss: { asset: usdc, atoms: 1_000_000n },
    maxIntermediateResidual: { asset: weth, atoms: 100_000_000_000_000_000n },
    maxTerminalResidual: { asset: weth, atoms: 10_000_000_000_000_000n },
    submissionDeadline: 2_000_000_000n,
    venueRequestDeadline: 2_000_000_300n,
    recoveryDeadline: 2_000_000_900n,
    slashPolicyHash: `01${'0'.repeat(62)}`,
    recoveryPolicyHash: `02${'0'.repeat(62)}`,
    evidenceSchemaHash: `03${'0'.repeat(62)}`,
    ...overrides,
  };
}

function transitionInput(
  overrides: Partial<AsyncBondedTransitionInput> = {},
): AsyncBondedTransitionInput {
  return {
    version: 1,
    authorizationHash: hash('1'),
    priorState: 'RESERVED',
    nextState: 'REQUEST_SUBMITTED',
    priorStateVersion: 0,
    nextStateVersion: 1,
    evidenceHash: hash('2'),
    observedAtUnixSeconds: 2_000_000_001n,
    requestKey: hash('3'),
    ...overrides,
  };
}

describe('asynchronous bonded authorization', () => {
  test('binds the domain, route, venue request, handler, capital, and deadlines', () => {
    const input = authorizationInput();
    const checked = asyncBondedAuthorization(input);
    assert.equal(checked.domain.domainId, 'arbitrum-sepolia');
    assert.equal(checked.handler.subjectId, 'gmx-order-handler');
    assert.equal(checked.maxTerminalResidual.atoms, 10_000_000_000_000_000n);
    assert.equal(asyncBondedAuthorizationBytes(input).length > 0, true);
    assert.equal(toHex(asyncBondedAuthorizationHash(input)).length, 64);
  });

  test('captures caller-owned hashes and returns defensive copies', () => {
    const orderHash = fromHex(hash('4'));
    const input = authorizationInput({ orderHash });
    const checked = asyncBondedAuthorization(input);
    const before = toHex(asyncBondedAuthorizationBytes(input));
    orderHash[0] = 0xff;
    checked.orderHash[0] = 0xee;
    assert.equal(toHex(asyncBondedAuthorizationBytes({ ...input, orderHash: hash('4') })), before);
    assert.equal(toHex(checked.orderHash), hash('4'));
  });

  test('rejects unsafe deadline, reserve, and residual relationships', () => {
    const input = authorizationInput();
    assert.throws(
      () => asyncBondedAuthorization(authorizationInput({
        venueRequestDeadline: input.submissionDeadline,
      })),
      MalformedInputError,
    );
    assert.throws(
      () => asyncBondedAuthorization(authorizationInput({
        recoveryReserve: { ...input.recoveryReserve, asset: input.maxTerminalResidual.asset },
      })),
      MalformedInputError,
    );
    assert.throws(
      () => asyncBondedAuthorization(authorizationInput({
        recoveryReserve: { ...input.recoveryReserve, atoms: input.maxAggregateLoss.atoms - 1n },
      })),
      MalformedInputError,
    );
    assert.throws(
      () => asyncBondedAuthorization(authorizationInput({
        maxTerminalResidual: {
          ...input.maxTerminalResidual,
          atoms: input.maxIntermediateResidual.atoms + 1n,
        },
      })),
      MalformedInputError,
    );
  });
});

describe('asynchronous bonded transitions', () => {
  test('accepts request submission and authenticated late venue execution', () => {
    const submitted = asyncBondedTransition(transitionInput());
    assert.equal(submitted.nextState, 'REQUEST_SUBMITTED');
    const executed = asyncBondedTransition(transitionInput({
      priorState: 'RECOVERY_PENDING',
      nextState: 'EXECUTED',
      priorStateVersion: 7,
      nextStateVersion: 8,
      venueTransactionHash: hash('4'),
    }));
    assert.equal(executed.nextState, 'EXECUTED');
    assert.equal(toHex(asyncBondedTransitionHash(transitionInput())).length, 64);
  });

  test('rejects skipped states, stale versions, and incomplete evidence', () => {
    const { requestKey: _requestKey, ...missingRequestKey } = transitionInput();
    assert.throws(
      () => asyncBondedTransition(transitionInput({ nextState: 'CLOSED' })),
      MalformedInputError,
    );
    assert.throws(
      () => asyncBondedTransition(transitionInput({ nextStateVersion: 2 })),
      MalformedInputError,
    );
    assert.throws(
      () => asyncBondedTransition(missingRequestKey),
      MalformedInputError,
    );
    const {
      requestKey: _pendingRequestKey,
      ...pendingWithoutRequestKey
    } = transitionInput({
      priorState: 'VENUE_PENDING',
      nextState: 'RECOVERY_PENDING',
    });
    assert.throws(
      () => asyncBondedTransition(pendingWithoutRequestKey),
      MalformedInputError,
    );
    assert.throws(
      () => asyncBondedTransition(transitionInput({
        priorState: 'VENUE_PENDING',
        nextState: 'EXECUTED',
      })),
      MalformedInputError,
    );
    assert.throws(
      () => asyncBondedTransition(transitionInput({
        priorState: 'RECOVERY_PENDING',
        nextState: 'RECOVERED',
      })),
      MalformedInputError,
    );
  });
});
