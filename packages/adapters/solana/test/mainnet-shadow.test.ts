import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { PublicKey } from '@solana/web3.js';
import {
  SOLANA_DEVNET_GENESIS_HASH,
  SOLANA_MAINNET_BETA_GENESIS_HASH,
  SOLANA_UPGRADEABLE_LOADER_ID,
  qualifySolanaMainnetShadow,
  type SolanaMainnetShadowExpectation,
  type SolanaMainnetShadowReadPort,
} from '../src/index.js';

const programId = key(1);
const programDataAddress = PublicKey.findProgramAddressSync(
  [programId.toBuffer()],
  SOLANA_UPGRADEABLE_LOADER_ID,
)[0];
const authority = key(2);
const market = key(3);
const mint = key(4);
const tokenProgram = key(5);
const mintAuthority = key(6);
const freezeAuthority = key(7);
const deployedCode = Buffer.from('reviewed-production-program');

function key(byte: number): PublicKey {
  return new PublicKey(new Uint8Array(32).fill(byte));
}

function hash(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function programState(): Uint8Array {
  const data = Buffer.alloc(36);
  data.writeUInt32LE(2, 0);
  programDataAddress.toBuffer().copy(data, 4);
  return data;
}

function programDataState(): Uint8Array {
  const data = Buffer.alloc(45 + deployedCode.length);
  data.writeUInt32LE(3, 0);
  data.writeBigUInt64LE(42n, 4);
  data.writeUInt32LE(1, 12);
  authority.toBuffer().copy(data, 13);
  deployedCode.copy(data, 45);
  return data;
}

function mintState(decimals = 6): Uint8Array {
  const data = Buffer.alloc(82);
  data.writeUInt32LE(1, 0);
  mintAuthority.toBuffer().copy(data, 4);
  data.writeBigUInt64LE(1_000_000n, 36);
  data[44] = decimals;
  data[45] = 1;
  data.writeUInt32LE(1, 46);
  freezeAuthority.toBuffer().copy(data, 50);
  return data;
}

function expectations(): readonly SolanaMainnetShadowExpectation[] {
  const programData = programDataState();
  const marketData = Uint8Array.from([1, 2, 3, 4]);
  const mintData = mintState();
  return [
    {
      kind: 'UPGRADEABLE_PROGRAM',
      name: 'venue_program',
      address: programId,
      programDataAddress,
      deploymentSlot: 42n,
      upgradeAuthority: authority,
      programDataSha256: hash(programData),
      deployedCodeSha256: hash(deployedCode),
    },
    {
      kind: 'ACCOUNT',
      role: 'MARKET',
      name: 'sol_usdc_market',
      address: market,
      owner: programId,
      executable: false,
      dataLength: marketData.length,
      dataSha256: hash(marketData),
    },
    {
      kind: 'SPL_MINT',
      name: 'usdc_mint',
      address: mint,
      tokenProgram,
      dataLength: mintData.length,
      decimals: 6,
      mintAuthority,
      freezeAuthority,
      dataSha256: hash(mintData),
    },
  ];
}

function readPort(options: Readonly<{
  genesisHash?: string;
  marketOwner?: PublicKey;
  mintDecimals?: number;
}> = {}): SolanaMainnetShadowReadPort & { minimumContextSlot: number | undefined } {
  return {
    endpoint: 'https://rpc.example.test',
    minimumContextSlot: undefined,
    getGenesisHash: async () => options.genesisHash ?? SOLANA_MAINNET_BETA_GENESIS_HASH,
    getFinalizedSlot: async () => 500,
    async getMultipleAccounts(_addresses, minContextSlot) {
      this.minimumContextSlot = minContextSlot;
      return {
        contextSlot: 501,
        accounts: [
          { owner: SOLANA_UPGRADEABLE_LOADER_ID, executable: true, lamports: 1n, data: programState() },
          { owner: SOLANA_UPGRADEABLE_LOADER_ID, executable: false, lamports: 2n, data: programDataState() },
          { owner: options.marketOwner ?? programId, executable: false, lamports: 3n, data: Uint8Array.from([1, 2, 3, 4]) },
          { owner: tokenProgram, executable: false, lamports: 4n, data: mintState(options.mintDecimals) },
        ],
      };
    },
  };
}

test('qualifies one finalized mainnet batch as bounded hash evidence', async () => {
  const port = readPort();
  const evidence = await qualifySolanaMainnetShadow(expectations(), port);
  assert.equal(port.minimumContextSlot, 500);
  assert.equal(evidence.endpoint, 'https://rpc.example.test/');
  assert.equal(evidence.genesisHash, SOLANA_MAINNET_BETA_GENESIS_HASH);
  assert.equal(evidence.commitment, 'finalized');
  assert.equal(evidence.accountContextSlot, 501);
  assert.equal(evidence.accounts.length, 3);
  assert.equal(evidence.accounts[0]?.role, 'PROGRAM');
  assert.equal(evidence.accounts[0]?.deploymentSlot, '42');
  assert.equal(evidence.accounts[0]?.programDataSha256, hash(programDataState()));
  assert.equal(evidence.accounts[1]?.role, 'MARKET');
  assert.equal(evidence.accounts[2]?.role, 'ASSET_MINT');
  assert.equal(evidence.accounts[2]?.decimals, 6);
  assert.equal(evidence.accounts[2]?.mintAuthority, mintAuthority.toBase58());
  assert.equal('data' in evidence.accounts[2]!, false);
});

test('rejects non-mainnet genesis before account reads', async () => {
  const port = readPort({ genesisHash: SOLANA_DEVNET_GENESIS_HASH });
  await assert.rejects(qualifySolanaMainnetShadow(expectations(), port), /not Solana mainnet-beta/);
  assert.equal(port.minimumContextSlot, undefined);
});

test('rejects market identity and mint semantic mismatches', async (context) => {
  await context.test('market owner', async () => {
    await assert.rejects(
      qualifySolanaMainnetShadow(expectations(), readPort({ marketOwner: key(9) })),
      /sol_usdc_market owner mismatch/,
    );
  });
  await context.test('mint decimals', async () => {
    await assert.rejects(
      qualifySolanaMainnetShadow(expectations(), readPort({ mintDecimals: 9 })),
      /usdc_mint decimals mismatch/,
    );
  });
});
