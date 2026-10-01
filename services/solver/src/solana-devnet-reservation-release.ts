import { bytesEqual } from '@naryx/protocol-types';
import { ComputeBudgetProgram, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { programAddress, type SolanaDevnetFirmQuoteJournal } from './solana-devnet-firm-quote.js';
import { requireSolanaDevnet, type SolanaDevnetSolverReadPort, type SolanaDevnetSolverWritePort } from './solana-devnet-rpc.js';
import type { SolanaDevnetSharedManifest, SolanaDevnetSolverConfig, SolanaDevnetSolverKey } from './solana-devnet-solver-config.js';
import {
  BorshReader,
  accountDiscriminator,
  associatedTokenAddress,
  decodeFirmReservation,
  decodeTokenAccount,
  instructionDiscriminator,
  reservationIdFor,
} from './solana-devnet-wire.js';

const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const RELEASE_COMPUTE_UNITS = 120_000;
const ORDER_HASH = /^[0-9a-f]{64}$/;

export class SolanaDevnetReleaseError extends Error {
  readonly code: 'INVALID_REQUEST' | 'NOT_FOUND' | 'NOT_READY' | 'RELEASE_REFUSED';

  constructor(code: SolanaDevnetReleaseError['code'], message: string) {
    super(`${code}: ${message}`);
    this.name = 'SolanaDevnetReleaseError';
    this.code = code;
  }
}

export type SolanaDevnetReleaseResult = Readonly<{
  status: 'RELEASED' | 'ALREADY_RELEASED';
  reservation: string;
  reservationIdHex: string;
  baseAtoms: bigint;
  signature?: string;
}>;

export type SolanaDevnetReservationReleaser = Readonly<{
  /** Releases this solver's expired, never-consumed reservation for a journaled firm quote. */
  releaseForOrder(orderHashHex: string): Promise<SolanaDevnetReleaseResult>;
  /** Releases the expired reservation a strategy authority's live pair still points at, if any. */
  releaseStaleLivePair(strategyAuthority: string, exceptReservationId: Uint8Array): Promise<SolanaDevnetReleaseResult | undefined>;
}>;

function refused(message: string): never {
  throw new SolanaDevnetReleaseError('RELEASE_REFUSED', message);
}

export function decodeLivePair(data: Uint8Array): Readonly<{ reservationClass: string; solver: string; strategyAuthority: string; reservationId: Uint8Array }> {
  const reader = new BorshReader(data, accountDiscriminator('LivePair'), 'LivePair');
  return Object.freeze({ reservationClass: reader.key(), solver: reader.key(), strategyAuthority: reader.key(), reservationId: reader.hash() });
}

/**
 * `release_reservation` is permissionless once the reservation expired, and returns the vaulted base
 * inventory to the solver's reclaim account. The solver only releases its own reservation in its
 * reviewed class, only after the finalized slot reached expiry, only from FUNDED or LIVE, and only
 * when the vault holds exactly the reserved base atoms; every other state fails closed. Writes need
 * the solver write port, which exists only with NARYX_SOLANA_DEVNET_SOLVER_WRITES_ENABLED=true.
 */
export function createSolanaDevnetReservationReleaser(dependencies: Readonly<{
  manifest: SolanaDevnetSharedManifest;
  config: SolanaDevnetSolverConfig;
  rpc: SolanaDevnetSolverReadPort;
  writer?: SolanaDevnetSolverWritePort;
  key: SolanaDevnetSolverKey;
  journal: Pick<SolanaDevnetFirmQuoteJournal, 'get'>;
}>): SolanaDevnetReservationReleaser {
  const { manifest, config, rpc, key } = dependencies;
  const reservationProgram = new PublicKey(programAddress(manifest, 'reservation').programId);
  const reservationClass = new PublicKey(config.accounts.reservationClass);
  const solver = new PublicKey(config.solverId);
  const pda = (seeds: readonly (Buffer | Uint8Array)[]) =>
    PublicKey.findProgramAddressSync(seeds.map((seed) => Buffer.from(seed)), reservationProgram)[0];

  async function release(reservationId: Uint8Array, expectedOrderHash?: Uint8Array): Promise<SolanaDevnetReleaseResult> {
    if (!key.publicKey.equals(solver)) refused('solver key does not match the configured solver');
    const reservation = pda([Buffer.from('reservation'), reservationClass.toBuffer(), solver.toBuffer(), reservationId]);
    const vault = pda([Buffer.from('reservation-vault'), reservationClass.toBuffer(), solver.toBuffer(), reservationId]);
    await requireSolanaDevnet(rpc);
    const slot = await rpc.getFinalizedSlot();
    const [reservationAccount, vaultAccount] = await rpc.getAccounts([reservation.toBase58(), vault.toBase58()], slot);
    if (reservationAccount === null || reservationAccount === undefined) {
      throw new SolanaDevnetReleaseError('NOT_FOUND', 'reservation account does not exist');
    }
    if (reservationAccount.owner !== reservationProgram.toBase58()) refused('reservation is not owned by the reviewed reservation program');
    const state = decodeFirmReservation(reservationAccount.data);
    if (state.solver !== solver.toBase58() || state.reservationClass !== reservationClass.toBase58()
      || !bytesEqual(state.reservationId, reservationId) || (expectedOrderHash !== undefined && !bytesEqual(state.orderHash, expectedOrderHash))) {
      refused('reservation does not belong to this solver, class, or order');
    }
    const result = { reservation: reservation.toBase58(), reservationIdHex: Buffer.from(reservationId).toString('hex'), baseAtoms: state.baseAtoms };
    if (state.state === 'RELEASED') return Object.freeze({ status: 'ALREADY_RELEASED', ...result });
    if (state.state !== 'FUNDED' && state.state !== 'LIVE') refused(`reservation is ${state.state} and cannot be released`);
    if (slot < state.expirySlot) {
      throw new SolanaDevnetReleaseError('NOT_READY', `reservation expires at slot ${state.expirySlot}; finalized slot is ${slot}`);
    }
    const reclaim = associatedTokenAddress(solver, state.baseMint).toBase58();
    if (state.solverReclaimBase !== reclaim) refused('reservation reclaim account is not the solver base inventory account');
    if (vaultAccount === null || vaultAccount === undefined || vaultAccount.owner !== TOKEN_PROGRAM_ID) refused('reservation vault is absent');
    const vaultToken = decodeTokenAccount(vaultAccount.data);
    if (vaultToken.mint !== state.baseMint || vaultToken.owner !== reservation.toBase58() || vaultToken.amount !== state.baseAtoms) {
      refused('reservation vault does not hold exactly the reserved base atoms');
    }
    if (dependencies.writer === undefined) {
      throw new SolanaDevnetReleaseError('NOT_READY', 'solver writes are disabled');
    }
    const strategyAuthority = new PublicKey(state.strategyAuthority);
    const meta = (pubkey: PublicKey, isWritable: boolean) => ({ pubkey, isSigner: false, isWritable });
    const instruction = new TransactionInstruction({
      programId: reservationProgram,
      keys: [
        { pubkey: solver, isSigner: true, isWritable: true },
        meta(strategyAuthority, false),
        meta(reservationClass, false),
        meta(pda([Buffer.from('reservation-capacity'), reservationClass.toBuffer(), solver.toBuffer()]), true),
        meta(reservation, true),
        meta(pda([Buffer.from('live-pair'), reservationClass.toBuffer(), solver.toBuffer(), strategyAuthority.toBuffer()]), true),
        meta(vault, true),
        meta(new PublicKey(reclaim), true),
        meta(new PublicKey(TOKEN_PROGRAM_ID), false),
      ],
      data: instructionDiscriminator('release_reservation'),
    });
    const signature = await dependencies.writer.sendAndFinalize(
      [ComputeBudgetProgram.setComputeUnitLimit({ units: RELEASE_COMPUTE_UNITS }), instruction],
      key.keypair,
    );
    const after = await rpc.getFinalizedSlot();
    const [released] = await rpc.getAccounts([reservation.toBase58()], after);
    if (released === null || released === undefined || decodeFirmReservation(released.data).state !== 'RELEASED') {
      refused('release transaction finalized without a RELEASED reservation');
    }
    return Object.freeze({ status: 'RELEASED', ...result, signature });
  }

  return Object.freeze({
    async releaseForOrder(orderHashHex: string) {
      if (!ORDER_HASH.test(orderHashHex)) throw new SolanaDevnetReleaseError('INVALID_REQUEST', 'orderHash must be 32 lowercase hex bytes');
      const record = dependencies.journal.get(orderHashHex);
      if (record === undefined) throw new SolanaDevnetReleaseError('NOT_FOUND', 'no firm quote from this solver for the order');
      const orderHash = Uint8Array.from(Buffer.from(orderHashHex, 'hex'));
      const reservationId = reservationIdFor(manifest.domain, config.solverId, orderHash, Uint8Array.from(Buffer.from(record.reservationNonceHex, 'hex')));
      return release(reservationId, orderHash);
    },
    async releaseStaleLivePair(strategyAuthority: string, exceptReservationId: Uint8Array) {
      const livePair = pda([Buffer.from('live-pair'), reservationClass.toBuffer(), solver.toBuffer(), new PublicKey(strategyAuthority).toBuffer()]);
      await requireSolanaDevnet(rpc);
      const [account] = await rpc.getAccounts([livePair.toBase58()], await rpc.getFinalizedSlot());
      if (account === null || account === undefined) return undefined;
      if (account.owner !== reservationProgram.toBase58()) refused('live pair is not owned by the reviewed reservation program');
      const pair = decodeLivePair(account.data);
      if (pair.strategyAuthority !== new PublicKey(strategyAuthority).toBase58() || pair.solver !== solver.toBase58()) refused('live pair binding mismatch');
      if (bytesEqual(pair.reservationId, exceptReservationId)) return undefined;
      return release(pair.reservationId);
    },
  });
}
