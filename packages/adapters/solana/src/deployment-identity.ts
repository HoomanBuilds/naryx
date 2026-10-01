import { createHash } from 'node:crypto';
import {
  Connection,
  PublicKey,
  type AccountInfo,
  type Commitment,
} from '@solana/web3.js';
import {
  SOLANA_DEVNET_GENESIS_HASH,
  SOLANA_MAINNET_BETA_GENESIS_HASH,
} from './materializer.js';

const PROGRAM_STATE = 2;
const PROGRAM_DATA_STATE = 3;
const PROGRAM_DATA_METADATA_SIZE = 45;

export const SOLANA_PROGRAM_DATA_HEADER_IDENTITY_DOMAIN = 'naryx.program-data-header.v1';

export const SOLANA_UPGRADEABLE_LOADER_ID = new PublicKey(
  'BPFLoaderUpgradeab1e11111111111111111111111',
);

export type SolanaUpgradeAuthorityPolicy =
  | Readonly<{ kind: 'EXACT'; authority: PublicKey | string }>
  | Readonly<{ kind: 'IMMUTABLE' }>;

export interface SolanaDevnetProgramExpectation {
  readonly name: string;
  readonly programId: PublicKey | string;
  readonly programDataAddress: PublicKey | string;
  readonly deploymentSlot: bigint;
  readonly upgradeAuthority: SolanaUpgradeAuthorityPolicy;
  readonly programDataHeaderIdentity: Uint8Array;
  readonly programElfSha256: Uint8Array;
}

export interface SolanaDeploymentAccountSnapshot {
  readonly owner: PublicKey;
  readonly executable: boolean;
  readonly data: Uint8Array;
}

export interface SolanaDeploymentAccountsSnapshot {
  readonly contextSlot: number;
  readonly accounts: readonly (SolanaDeploymentAccountSnapshot | null)[];
}

export interface SolanaDeploymentIdentityReadPort {
  getGenesisHash(): Promise<string>;
  getContextSlot(): Promise<number>;
  getMultipleAccounts(
    addresses: readonly PublicKey[],
    minContextSlot: number,
  ): Promise<SolanaDeploymentAccountsSnapshot>;
}

export interface VerifiedSolanaDevnetProgramIdentity {
  readonly name: string;
  readonly programId: PublicKey;
  readonly programDataAddress: PublicKey;
  readonly deploymentSlot: bigint;
  readonly upgradeAuthority: PublicKey | null;
  readonly programDataLength: number;
  readonly programDataHeaderIdentity: Uint8Array;
  readonly programElfSha256: Uint8Array;
}

export interface VerifiedSolanaDevnetDeploymentIdentity {
  readonly genesisHash: typeof SOLANA_DEVNET_GENESIS_HASH;
  readonly contextSlot: number;
  readonly programs: readonly VerifiedSolanaDevnetProgramIdentity[];
}

export class ConnectionSolanaDeploymentIdentityReadPort implements SolanaDeploymentIdentityReadPort {
  readonly #connection: Connection;
  readonly #commitment: Commitment;

  constructor(rpcUrl: string, commitment: Commitment = 'finalized') {
    this.#connection = new Connection(rpcUrl, commitment);
    this.#commitment = commitment;
  }

  getGenesisHash(): Promise<string> {
    return this.#connection.getGenesisHash();
  }

  getContextSlot(): Promise<number> {
    return this.#connection.getSlot(this.#commitment);
  }

  async getMultipleAccounts(
    addresses: readonly PublicKey[],
    minContextSlot: number,
  ): Promise<SolanaDeploymentAccountsSnapshot> {
    const response = await this.#connection.getMultipleAccountsInfoAndContext([...addresses], {
      commitment: this.#commitment,
      minContextSlot,
    });
    return Object.freeze({
      contextSlot: response.context.slot,
      accounts: Object.freeze(response.value.map((account) => account === null
        ? null
        : accountSnapshot(account))),
    });
  }
}

function accountSnapshot(account: AccountInfo<Buffer>): SolanaDeploymentAccountSnapshot {
  return Object.freeze({
    owner: account.owner,
    executable: account.executable,
    data: Uint8Array.from(account.data),
  });
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function publicKey(value: PublicKey | string, name: string): PublicKey {
  try {
    const checked = value instanceof PublicKey ? value : new PublicKey(value);
    requireCondition(
      value instanceof PublicKey || checked.toBase58() === value,
      `${name} must be canonical base58`,
    );
    return checked;
  } catch {
    throw new Error(`${name} must be a Solana public key`);
  }
}

function commitment(value: Uint8Array, name: string): Uint8Array {
  requireCondition(
    value instanceof Uint8Array && value.length === 32 && value.some((byte) => byte !== 0),
    `${name} must be 32 nonzero bytes`,
  );
  return Uint8Array.from(value);
}

function sha256(value: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(value).digest());
}

// The identity naryx_core, the package book, and the reservation program compute on-chain.
export function solanaProgramDataHeaderIdentity(programData: Uint8Array): Uint8Array {
  decodeProgramData(programData, 'ProgramData');
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(programData.length));
  return new Uint8Array(createHash('sha256')
    .update(SOLANA_PROGRAM_DATA_HEADER_IDENTITY_DOMAIN)
    .update(programData.subarray(0, PROGRAM_DATA_METADATA_SIZE))
    .update(length)
    .digest());
}

// Trailing zero padding is stripped, matching `solana-verify get-program-hash`, so a reviewed
// artifact and a ProgramData account deployed with extra length hash the same.
export function solanaProgramElfSha256(elf: Uint8Array): Uint8Array {
  let end = elf.length;
  while (end > 0 && elf[end - 1] === 0) end -= 1;
  requireCondition(end > 0, 'program ELF must not be empty');
  return sha256(elf.subarray(0, end));
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function contextSlot(value: number, name: string): number {
  requireCondition(Number.isSafeInteger(value) && value > 0, `${name} must be a positive safe integer`);
  return value;
}

function decodeProgram(data: Uint8Array, name: string): PublicKey {
  const bytes = Buffer.from(data);
  requireCondition(
    bytes.length === 36 && bytes.readUInt32LE(0) === PROGRAM_STATE,
    `${name} program account has invalid upgradeable-loader state`,
  );
  return new PublicKey(bytes.subarray(4));
}

function decodeProgramData(data: Uint8Array, name: string): Readonly<{
  deploymentSlot: bigint;
  upgradeAuthority: PublicKey | null;
  deployedCode: Uint8Array;
}> {
  const bytes = Buffer.from(data);
  requireCondition(
    bytes.length > PROGRAM_DATA_METADATA_SIZE && bytes.readUInt32LE(0) === PROGRAM_DATA_STATE,
    `${name} ProgramData account has invalid upgradeable-loader state`,
  );
  const authorityOption = bytes[12];
  requireCondition(
    authorityOption === 0 || authorityOption === 1,
    `${name} ProgramData account has invalid upgrade authority state`,
  );
  return Object.freeze({
    deploymentSlot: bytes.readBigUInt64LE(4),
    upgradeAuthority: authorityOption === 0 ? null : new PublicKey(bytes.subarray(13, 45)),
    deployedCode: Uint8Array.from(bytes.subarray(PROGRAM_DATA_METADATA_SIZE)),
  });
}

function normalizedExpectations(
  expectations: readonly SolanaDevnetProgramExpectation[],
): readonly Readonly<{
  name: string;
  programId: PublicKey;
  programDataAddress: PublicKey;
  deploymentSlot: bigint;
  upgradeAuthority: SolanaUpgradeAuthorityPolicy;
  programDataHeaderIdentity: Uint8Array;
  programElfSha256: Uint8Array;
}>[] {
  requireCondition(Array.isArray(expectations) && expectations.length > 0, 'program expectations must not be empty');
  const names = new Set<string>();
  const addresses = new Set<string>();
  return expectations.map((expectation, index) => {
    requireCondition(
      typeof expectation.name === 'string'
        && /^[a-z][a-z0-9_]{1,63}$/.test(expectation.name)
        && !names.has(expectation.name),
      `program expectation ${index} has a duplicate or invalid name`,
    );
    names.add(expectation.name);
    const programId = publicKey(expectation.programId, `${expectation.name} program id`);
    const programDataAddress = publicKey(
      expectation.programDataAddress,
      `${expectation.name} ProgramData address`,
    );
    const derivedProgramData = PublicKey.findProgramAddressSync(
      [programId.toBuffer()],
      SOLANA_UPGRADEABLE_LOADER_ID,
    )[0];
    requireCondition(
      derivedProgramData.equals(programDataAddress),
      `${expectation.name} ProgramData address is not derived from its program id`,
    );
    for (const address of [programId.toBase58(), programDataAddress.toBase58()]) {
      requireCondition(!addresses.has(address), 'program expectations contain duplicate identities');
      addresses.add(address);
    }
    requireCondition(
      typeof expectation.deploymentSlot === 'bigint' && expectation.deploymentSlot >= 0n,
      `${expectation.name} deployment slot must be a nonnegative bigint`,
    );
    requireCondition(
      expectation.upgradeAuthority.kind === 'IMMUTABLE'
        || expectation.upgradeAuthority.kind === 'EXACT',
      `${expectation.name} upgrade authority policy is invalid`,
    );
    if (expectation.upgradeAuthority.kind === 'EXACT') {
      publicKey(expectation.upgradeAuthority.authority, `${expectation.name} upgrade authority`);
    }
    return Object.freeze({
      name: expectation.name,
      programId,
      programDataAddress,
      deploymentSlot: expectation.deploymentSlot,
      upgradeAuthority: expectation.upgradeAuthority,
      programDataHeaderIdentity: commitment(
        expectation.programDataHeaderIdentity,
        `${expectation.name} ProgramData header identity`,
      ),
      programElfSha256: commitment(
        expectation.programElfSha256,
        `${expectation.name} program ELF SHA-256`,
      ),
    });
  });
}

export async function verifySolanaDevnetDeploymentIdentity(
  expectations: readonly SolanaDevnetProgramExpectation[],
  rpc: SolanaDeploymentIdentityReadPort,
): Promise<VerifiedSolanaDevnetDeploymentIdentity> {
  const programs = normalizedExpectations(expectations);
  const genesisHash = await rpc.getGenesisHash();
  if (genesisHash === SOLANA_MAINNET_BETA_GENESIS_HASH) {
    throw new Error('Solana mainnet-beta genesis is prohibited');
  }
  requireCondition(genesisHash === SOLANA_DEVNET_GENESIS_HASH, 'RPC is not Solana Devnet');
  const minimumContextSlot = contextSlot(await rpc.getContextSlot(), 'minimum context slot');
  const addresses = programs.flatMap((program) => [program.programId, program.programDataAddress]);
  const snapshot = await rpc.getMultipleAccounts(addresses, minimumContextSlot);
  const observedContextSlot = contextSlot(snapshot.contextSlot, 'account context slot');
  requireCondition(observedContextSlot >= minimumContextSlot, 'program account snapshot is stale');
  requireCondition(
    snapshot.accounts.length === addresses.length,
    'program account snapshot is incomplete',
  );
  const verified = programs.map((program, index): VerifiedSolanaDevnetProgramIdentity => {
    const programAccount = snapshot.accounts[index * 2];
    const programDataAccount = snapshot.accounts[index * 2 + 1];
    requireCondition(
      programAccount !== null && programAccount !== undefined
        && programDataAccount !== null && programDataAccount !== undefined,
      `${program.name} program or ProgramData account is missing`,
    );
    requireCondition(
      programAccount.executable && programAccount.owner.equals(SOLANA_UPGRADEABLE_LOADER_ID),
      `${program.name} program has invalid executable or loader identity`,
    );
    requireCondition(
      !programDataAccount.executable
        && programDataAccount.owner.equals(SOLANA_UPGRADEABLE_LOADER_ID),
      `${program.name} ProgramData has invalid executable or loader identity`,
    );
    const linkedProgramData = decodeProgram(programAccount.data, program.name);
    requireCondition(
      linkedProgramData.equals(program.programDataAddress),
      `${program.name} ProgramData linkage mismatch`,
    );
    const decoded = decodeProgramData(programDataAccount.data, program.name);
    requireCondition(
      decoded.deploymentSlot === program.deploymentSlot,
      `${program.name} deployment slot mismatch`,
    );
    const expectedAuthority = program.upgradeAuthority.kind === 'IMMUTABLE'
      ? null
      : publicKey(program.upgradeAuthority.authority, `${program.name} upgrade authority`);
    requireCondition(
      (decoded.upgradeAuthority === null && expectedAuthority === null)
        || (decoded.upgradeAuthority !== null
          && expectedAuthority !== null
          && decoded.upgradeAuthority.equals(expectedAuthority)),
      `${program.name} upgrade authority policy mismatch`,
    );
    const programDataHeaderIdentity = solanaProgramDataHeaderIdentity(programDataAccount.data);
    const programElfSha256 = solanaProgramElfSha256(decoded.deployedCode);
    requireCondition(
      equalBytes(programDataHeaderIdentity, program.programDataHeaderIdentity),
      `${program.name} ProgramData header identity mismatch`,
    );
    requireCondition(
      equalBytes(programElfSha256, program.programElfSha256),
      `${program.name} program ELF SHA-256 mismatch`,
    );
    return Object.freeze({
      name: program.name,
      programId: program.programId,
      programDataAddress: program.programDataAddress,
      deploymentSlot: decoded.deploymentSlot,
      upgradeAuthority: decoded.upgradeAuthority,
      programDataLength: programDataAccount.data.length,
      programDataHeaderIdentity,
      programElfSha256,
    });
  });
  return Object.freeze({
    genesisHash: SOLANA_DEVNET_GENESIS_HASH,
    contextSlot: observedContextSlot,
    programs: Object.freeze(verified),
  });
}
