import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';
import {
  qualifySolanaDeploymentAuthority,
  type SolanaDeploymentAuthorityPolicy,
  type SolanaDeploymentAuthorityReadPort,
  type SolanaObservedDeploymentAuthorityEvidence,
} from '../src/authority-qualification.js';
import { SOLANA_UPGRADEABLE_LOADER_ID } from '../src/deployment-identity.js';

const key = (byte: number): PublicKey => new PublicKey(new Uint8Array(32).fill(byte));
const programId = key(1);
const programDataAddress = PublicKey.findProgramAddressSync(
  [programId.toBuffer()],
  SOLANA_UPGRADEABLE_LOADER_ID,
)[0];
const proposer = key(2);
const executor = key(3);
const pauser = key(4);
const codeHash = '11'.repeat(32);

function policy(): SolanaDeploymentAuthorityPolicy {
  return {
    programId,
    programDataAddress,
    expectedLoader: SOLANA_UPGRADEABLE_LOADER_ID,
    expectedDeployedCodeSha256: codeHash,
    requireImmutableVerifier: true,
    upgradeAuthority: null,
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

function evidence(): SolanaObservedDeploymentAuthorityEvidence {
  return {
    programId,
    programOwner: SOLANA_UPGRADEABLE_LOADER_ID,
    executable: true,
    linkedProgramDataAddress: programDataAddress,
    programDataAddress,
    programDataOwner: SOLANA_UPGRADEABLE_LOADER_ID,
    programDataExecutable: false,
    deployedCodeSha256: codeHash,
    upgradeAuthority: null,
    authorities: [
      { role: 'PROPOSER', authority: proposer },
      { role: 'EXECUTOR', authority: executor },
      { role: 'PAUSER', authority: pauser },
    ],
    activationState: 'EXIT_ONLY',
    entryCapAtoms: 0n,
    exitCapAtoms: 1_000n,
    contextSlot: 42,
  };
}

function port(observed = evidence()): SolanaDeploymentAuthorityReadPort {
  return {
    async readDeploymentAuthorityEvidence() { return observed; },
  };
}

test('qualifies separated Solana authorities while preserving exit-only capacity', async () => {
  const qualified = await qualifySolanaDeploymentAuthority(policy(), port());
  assert.equal(qualified.activationState, 'EXIT_ONLY');
  assert.equal(qualified.entryCapAtoms, 0n);
  assert.equal(qualified.exitCapAtoms, 1_000n);
  assert.equal(qualified.upgradeAuthority, null);
});

test('rejects unexpected authority and forbidden Solana role collision', async () => {
  await assert.rejects(
    qualifySolanaDeploymentAuthority(policy(), port({
      ...evidence(),
      authorities: [
        { role: 'PROPOSER', authority: proposer },
        { role: 'EXECUTOR', authority: key(9) },
        { role: 'PAUSER', authority: pauser },
      ],
    })),
    /unexpected executor authority/,
  );

  const collidedPolicy = policy();
  await assert.rejects(
    qualifySolanaDeploymentAuthority({
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

test('rejects mutable verifier, code drift, ProgramData mismatch, and disabled exit capacity', async () => {
  await assert.rejects(
    qualifySolanaDeploymentAuthority(policy(), port({ ...evidence(), upgradeAuthority: key(8) })),
    /verifier is mutable/,
  );
  await assert.rejects(
    qualifySolanaDeploymentAuthority(policy(), port({ ...evidence(), deployedCodeSha256: '22'.repeat(32) })),
    /code hash drift/,
  );
  await assert.rejects(
    qualifySolanaDeploymentAuthority(policy(), port({ ...evidence(), linkedProgramDataAddress: key(9) })),
    /ProgramData mismatch/,
  );
  await assert.rejects(
    qualifySolanaDeploymentAuthority(policy(), port({ ...evidence(), exitCapAtoms: 0n })),
    /exit cap mismatch/,
  );
});
