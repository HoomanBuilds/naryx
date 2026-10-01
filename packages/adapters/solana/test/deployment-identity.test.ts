import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';
import {
  SOLANA_DEVNET_GENESIS_HASH,
  SOLANA_MAINNET_BETA_GENESIS_HASH,
  SOLANA_UPGRADEABLE_LOADER_ID,
  solanaProgramDataHeaderIdentity,
  solanaProgramElfSha256,
  verifySolanaDevnetDeploymentIdentity,
  type SolanaDeploymentIdentityReadPort,
  type SolanaDevnetProgramExpectation,
} from '../src/index.js';

const programId = new PublicKey(new Uint8Array(32).fill(1));
const programDataAddress = PublicKey.findProgramAddressSync(
  [programId.toBuffer()],
  SOLANA_UPGRADEABLE_LOADER_ID,
)[0];
const authority = new PublicKey(new Uint8Array(32).fill(2));
const otherAuthority = new PublicKey(new Uint8Array(32).fill(3));
const deployedCode = Buffer.from('reviewed-devnet-program');

function programState(link = programDataAddress): Uint8Array {
  const data = Buffer.alloc(36);
  data.writeUInt32LE(2, 0);
  link.toBuffer().copy(data, 4);
  return data;
}

function programDataState(localAuthority = authority, padding = 0): Uint8Array {
  const data = Buffer.alloc(45 + deployedCode.length + padding);
  data.writeUInt32LE(3, 0);
  data.writeBigUInt64LE(42n, 4);
  data[12] = 1;
  localAuthority.toBuffer().copy(data, 13);
  deployedCode.copy(data, 45);
  return data;
}

function expectation(): SolanaDevnetProgramExpectation {
  const data = programDataState();
  return {
    name: 'naryx_core',
    programId,
    programDataAddress,
    deploymentSlot: 42n,
    upgradeAuthority: { kind: 'EXACT', authority },
    programDataHeaderIdentity: solanaProgramDataHeaderIdentity(data),
    programElfSha256: new Uint8Array(createHash('sha256').update(deployedCode).digest()),
  };
}

function rpc(options: Readonly<{
  genesisHash?: string;
  linkage?: PublicKey;
  authority?: PublicKey;
  padding?: number;
}> = {}): SolanaDeploymentIdentityReadPort & { minimumSlot: number | undefined } {
  return {
    minimumSlot: undefined,
    getGenesisHash: async () => options.genesisHash ?? SOLANA_DEVNET_GENESIS_HASH,
    getContextSlot: async () => 500,
    async getMultipleAccounts(_addresses, minContextSlot) {
      this.minimumSlot = minContextSlot;
      return {
        contextSlot: 500,
        accounts: [
          {
            owner: SOLANA_UPGRADEABLE_LOADER_ID,
            executable: true,
            data: programState(options.linkage),
          },
          {
            owner: SOLANA_UPGRADEABLE_LOADER_ID,
            executable: false,
            data: programDataState(options.authority, options.padding),
          },
        ],
      };
    },
  };
}

test('verifies exact Devnet deployment identity at one minimum context slot', async () => {
  const port = rpc();
  const verified = await verifySolanaDevnetDeploymentIdentity([expectation()], port);
  assert.equal(port.minimumSlot, 500);
  assert.equal(verified.contextSlot, 500);
  assert.equal(verified.programs[0]?.programId.toBase58(), programId.toBase58());
  assert.equal(verified.programs[0]?.deploymentSlot, 42n);
  assert.equal(verified.programs[0]?.upgradeAuthority?.toBase58(), authority.toBase58());
});

test('rejects mismatched ProgramData linkage', async () => {
  const wrongLink = new PublicKey(new Uint8Array(32).fill(9));
  await assert.rejects(
    verifySolanaDevnetDeploymentIdentity([expectation()], rpc({ linkage: wrongLink })),
    /ProgramData linkage mismatch/,
  );
});

test('rejects mainnet genesis before reading program accounts', async () => {
  const port = rpc({ genesisHash: SOLANA_MAINNET_BETA_GENESIS_HASH });
  await assert.rejects(
    verifySolanaDevnetDeploymentIdentity([expectation()], port),
    /mainnet-beta genesis is prohibited/,
  );
  assert.equal(port.minimumSlot, undefined);
});

test('rejects an unexpected upgrade authority', async () => {
  await assert.rejects(
    verifySolanaDevnetDeploymentIdentity([expectation()], rpc({ authority: otherAuthority })),
    /upgrade authority policy mismatch/,
  );
});

test('header identity binds slot, authority, and length; ELF hash ignores zero padding', async () => {
  const base = programDataState();
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(base.length));
  assert.deepEqual(
    solanaProgramDataHeaderIdentity(base),
    new Uint8Array(createHash('sha256')
      .update('naryx.program-data-header.v1')
      .update(base.subarray(0, 45))
      .update(length)
      .digest()),
  );
  const upgraded = Buffer.from(base);
  upgraded.writeBigUInt64LE(43n, 4);
  for (const changed of [upgraded, programDataState(otherAuthority), programDataState(authority, 8)]) {
    assert.notDeepEqual(solanaProgramDataHeaderIdentity(changed), solanaProgramDataHeaderIdentity(base));
  }
  assert.deepEqual(
    solanaProgramElfSha256(programDataState(authority, 8).subarray(45)),
    expectation().programElfSha256,
  );
  await assert.rejects(
    verifySolanaDevnetDeploymentIdentity([expectation()], rpc({ padding: 8 })),
    /ProgramData header identity mismatch/,
  );
});
