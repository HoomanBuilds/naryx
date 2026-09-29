import assert from 'node:assert/strict';
import test from 'node:test';
import type { Address, Hex } from 'viem';
import {
  qualifyEvmDeploymentAuthority,
  type EvmDeploymentAuthorityPolicy,
  type EvmDeploymentAuthorityReadPort,
  type EvmObservedDeploymentAuthorityEvidence,
} from '../src/authorityQualification.js';

const subject = '0x1000000000000000000000000000000000000001' as Address;
const proposer = '0x2000000000000000000000000000000000000002' as Address;
const executor = '0x3000000000000000000000000000000000000003' as Address;
const pauser = '0x4000000000000000000000000000000000000004' as Address;
const codeHash = `0x${'11'.repeat(32)}` as Hex;

function policy(): EvmDeploymentAuthorityPolicy {
  return {
    chainReference: 84532n,
    subject,
    expectedCodeHash: codeHash,
    deploymentShape: { kind: 'DIRECT' },
    requireImmutableVerifier: true,
    authorities: [
      { role: 'PROPOSER', authority: proposer },
      { role: 'EXECUTOR', authority: executor },
      { role: 'PAUSER', authority: pauser },
    ],
    forbiddenRoleCollisions: [
      { left: 'PROPOSER', right: 'EXECUTOR' },
      { left: 'EXECUTOR', right: 'PAUSER' },
    ],
    capPolicy: {
      activationState: 'EXIT_ONLY',
      entryCapAtoms: 0n,
      exitCapAtoms: 1_000n,
      preserveExitWhenDeprecated: true,
    },
  };
}

function evidence(): EvmObservedDeploymentAuthorityEvidence {
  return {
    subject,
    codeHash,
    deploymentShape: { kind: 'DIRECT' },
    verifierMutable: false,
    authorities: [
      { role: 'PROPOSER', authority: proposer },
      { role: 'EXECUTOR', authority: executor },
      { role: 'PAUSER', authority: pauser },
    ],
    activationState: 'EXIT_ONLY',
    entryCapAtoms: 0n,
    exitCapAtoms: 1_000n,
    observedBlock: 42n,
  };
}

function port(observed = evidence()): EvmDeploymentAuthorityReadPort {
  return {
    async chainId() { return 84532n; },
    async readDeploymentAuthorityEvidence() { return observed; },
  };
}

test('qualifies separated authorities while preserving exit-only capacity', async () => {
  const qualified = await qualifyEvmDeploymentAuthority(policy(), port());
  assert.equal(qualified.activationState, 'EXIT_ONLY');
  assert.equal(qualified.entryCapAtoms, 0n);
  assert.equal(qualified.exitCapAtoms, 1_000n);
});

test('rejects unexpected authorities and forbidden role collisions', async () => {
  await assert.rejects(
    qualifyEvmDeploymentAuthority(policy(), port({
      ...evidence(),
      authorities: [
        { role: 'PROPOSER', authority: proposer },
        { role: 'EXECUTOR', authority: proposer },
        { role: 'PAUSER', authority: pauser },
      ],
    })),
    /unexpected executor authority/,
  );

  const collidedPolicy = policy();
  await assert.rejects(
    qualifyEvmDeploymentAuthority({
      ...collidedPolicy,
      authorities: [
        { role: 'PROPOSER', authority: proposer },
        { role: 'EXECUTOR', authority: proposer },
        { role: 'PAUSER', authority: pauser },
      ],
    }, port({
      ...evidence(),
      authorities: [
        { role: 'PROPOSER', authority: proposer },
        { role: 'EXECUTOR', authority: proposer },
        { role: 'PAUSER', authority: pauser },
      ],
    })),
    /PROPOSER and EXECUTOR authorities must be separated/,
  );
});

test('rejects mutable verifier, code drift, proxy mismatch, and disabled exit capacity', async () => {
  await assert.rejects(
    qualifyEvmDeploymentAuthority(policy(), port({ ...evidence(), verifierMutable: true })),
    /verifier is mutable/,
  );
  await assert.rejects(
    qualifyEvmDeploymentAuthority(policy(), port({ ...evidence(), codeHash: `0x${'22'.repeat(32)}` })),
    /code hash drift/,
  );
  await assert.rejects(
    qualifyEvmDeploymentAuthority(policy(), port({
      ...evidence(),
      deploymentShape: {
        kind: 'PROXY',
        proxyAdmin: proposer,
        implementation: executor,
        proxyCodeHash: `0x${'33'.repeat(32)}`,
        implementationCodeHash: `0x${'44'.repeat(32)}`,
      },
    })),
    /proxy shape mismatch/,
  );
  await assert.rejects(
    qualifyEvmDeploymentAuthority(policy(), port({ ...evidence(), exitCapAtoms: 0n })),
    /exit cap mismatch/,
  );
});
