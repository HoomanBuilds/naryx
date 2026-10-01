import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DomainRef } from '@naryx/protocol-types';
import { Keypair, PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { createSolanaDevnetReservationReleaser, SolanaDevnetReleaseError } from '../src/solana-devnet-reservation-release.js';
import { BorshWriter, accountDiscriminator, associatedTokenAddress, instructionDiscriminator, reservationIdFor } from '../src/solana-devnet-wire.js';

const domain = { domainId: 'svm:devnet', domainManifestVersion: 1, domainManifestHash: new Uint8Array(32).fill(7) } as DomainRef;
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const reservationProgram = Keypair.generate().publicKey;
const reservationClass = Keypair.generate().publicKey;
const baseMint = Keypair.generate().publicKey;
const solverKey = Keypair.generate();
const strategyAuthority = Keypair.generate().publicKey;
const orderHash = new Uint8Array(32).fill(9);
const nonce = new Uint8Array(32).fill(3);
const reservationId = reservationIdFor(domain, solverKey.publicKey.toBase58(), orderHash, nonce);
const pda = (...seeds: (Buffer | Uint8Array)[]) =>
  PublicKey.findProgramAddressSync(seeds.map((seed) => Buffer.from(seed)), reservationProgram)[0].toBase58();
const reservation = pda(Buffer.from('reservation'), reservationClass.toBuffer(), solverKey.publicKey.toBuffer(), reservationId);
const vault = pda(Buffer.from('reservation-vault'), reservationClass.toBuffer(), solverKey.publicKey.toBuffer(), reservationId);

function reservationData(solver: PublicKey, state: number): Uint8Array {
  const key = (value: PublicKey) => value.toBytes();
  return new BorshWriter()
    .bytes(accountDiscriminator('FirmReservation')).bytes(Buffer.from([2, 0])).bytes(key(reservationClass)).domain(domain)
    .bytes(reservationId).string(solver.toBase58()).bytes(key(solver)).bytes(key(strategyAuthority)).u64(5n)
    .bytes(orderHash).bytes(new Uint8Array(32).fill(1)).bytes(new Uint8Array(32).fill(2)).bytes(nonce)
    .bytes(key(baseMint)).bytes(new Uint8Array(32).fill(4)).bytes(key(associatedTokenAddress(solver, baseMint)))
    .bytes(new Uint8Array(32).fill(5)).bytes(new Uint8Array(32).fill(6)).bytes(new Uint8Array(32).fill(8))
    .u64(2_000n).u64(300n).u64(900n).u8(1).u8(state).u8(255).u8(254)
    .done();
}

function tokenData(mint: PublicKey, owner: string, amount: bigint): Uint8Array {
  const data = Buffer.alloc(165);
  mint.toBuffer().copy(data, 0);
  new PublicKey(owner).toBuffer().copy(data, 32);
  data.writeBigUInt64LE(amount, 64);
  return data;
}

function harness(input: Readonly<{ slot: bigint; solver?: PublicKey; vaultAtoms?: bigint; writes?: boolean }>) {
  let state = 0;
  const sent: TransactionInstruction[][] = [];
  const accounts = () => new Map<string, { owner: string; data: Uint8Array }>([
    [reservation, { owner: reservationProgram.toBase58(), data: reservationData(input.solver ?? solverKey.publicKey, state) }],
    [vault, { owner: TOKEN_PROGRAM, data: tokenData(baseMint, reservation, input.vaultAtoms ?? 2_000n) }],
  ]);
  const releaser = createSolanaDevnetReservationReleaser({
    manifest: {
      domain,
      programs: [{ name: 'reservation', programId: reservationProgram, programDataAddress: Keypair.generate().publicKey, programDataHeaderIdentity: new Uint8Array(32).fill(1) }],
    } as never,
    config: { solverId: solverKey.publicKey.toBase58(), accounts: { reservationClass: reservationClass.toBase58() } } as never,
    rpc: {
      getGenesisHash: async () => 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
      getFinalizedSlot: async () => input.slot,
      getBlockTime: async () => 0n,
      getAccounts: async (addresses: readonly string[]) => addresses.map((address) => accounts().get(address) ?? null),
    },
    ...(input.writes === false ? {} : {
      writer: {
        sendAndFinalize: async (instructions: readonly TransactionInstruction[]) => {
          sent.push([...instructions]);
          state = 3;
          return 'signature';
        },
      },
    }),
    key: { publicKey: solverKey.publicKey, keypair: solverKey } as never,
    journal: { get: (hash: string) => (hash === Buffer.from(orderHash).toString('hex') ? { reservationNonceHex: Buffer.from(nonce).toString('hex') } as never : undefined) },
  });
  return { releaser, sent };
}

const orderHex = Buffer.from(orderHash).toString('hex');

test('releases an expired funded reservation only for this solver, once, with exact accounts', async () => {
  const early = harness({ slot: 899n });
  await assert.rejects(early.releaser.releaseForOrder(orderHex), (error) => error instanceof SolanaDevnetReleaseError && error.code === 'NOT_READY');
  assert.equal(early.sent.length, 0);

  await assert.rejects(harness({ slot: 900n, solver: Keypair.generate().publicKey }).releaser.releaseForOrder(orderHex), /RELEASE_REFUSED/);
  await assert.rejects(harness({ slot: 900n, vaultAtoms: 1_999n }).releaser.releaseForOrder(orderHex), /exactly the reserved base atoms/);
  await assert.rejects(harness({ slot: 900n, writes: false }).releaser.releaseForOrder(orderHex), /writes are disabled/);
  await assert.rejects(harness({ slot: 900n }).releaser.releaseForOrder('00'.repeat(32)), /NOT_FOUND/);

  const ready = harness({ slot: 900n });
  const result = await ready.releaser.releaseForOrder(orderHex);
  assert.equal(result.status, 'RELEASED');
  assert.equal(result.baseAtoms, 2_000n);
  const instruction = ready.sent[0]![1]!;
  assert.equal(instruction.programId.toBase58(), reservationProgram.toBase58());
  assert.deepEqual(Buffer.from(instruction.data), instructionDiscriminator('release_reservation'));
  assert.deepEqual(instruction.keys.map((meta) => meta.pubkey.toBase58()), [
    solverKey.publicKey.toBase58(), strategyAuthority.toBase58(), reservationClass.toBase58(),
    pda(Buffer.from('reservation-capacity'), reservationClass.toBuffer(), solverKey.publicKey.toBuffer()),
    reservation,
    pda(Buffer.from('live-pair'), reservationClass.toBuffer(), solverKey.publicKey.toBuffer(), strategyAuthority.toBuffer()),
    vault,
    associatedTokenAddress(solverKey.publicKey, baseMint).toBase58(),
    TOKEN_PROGRAM,
  ]);
  assert.equal((await ready.releaser.releaseForOrder(orderHex)).status, 'ALREADY_RELEASED');
  assert.equal(ready.sent.length, 1);
});
