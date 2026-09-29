import { createHash } from 'node:crypto';
import {
  Connection,
  PublicKey,
  type AccountInfo,
  type Commitment,
} from '@solana/web3.js';
import { SOLANA_MAINNET_BETA_GENESIS_HASH } from './materializer.js';
import { SOLANA_UPGRADEABLE_LOADER_ID } from './deployment-identity.js';

const PROGRAM_STATE = 2;
const PROGRAM_DATA_STATE = 3;
const PROGRAM_DATA_METADATA_SIZE = 45;
const SPL_MINT_SIZE = 82;
const MAX_EXPECTATIONS = 64;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export type SolanaMainnetShadowAccountRole = 'VENUE' | 'MARKET' | 'DEPENDENCY';

export interface SolanaMainnetShadowProgramExpectation {
  readonly kind: 'UPGRADEABLE_PROGRAM';
  readonly name: string;
  readonly address: PublicKey | string;
  readonly programDataAddress: PublicKey | string;
  readonly deploymentSlot: bigint;
  readonly upgradeAuthority: PublicKey | string | null;
  readonly programDataSha256?: string;
  readonly deployedCodeSha256?: string;
}

export interface SolanaMainnetShadowAccountExpectation {
  readonly kind: 'ACCOUNT';
  readonly role: SolanaMainnetShadowAccountRole;
  readonly name: string;
  readonly address: PublicKey | string;
  readonly owner: PublicKey | string;
  readonly executable: boolean;
  readonly dataLength: number;
  readonly dataSha256?: string;
}

export interface SolanaMainnetShadowMintExpectation {
  readonly kind: 'SPL_MINT';
  readonly name: string;
  readonly address: PublicKey | string;
  readonly tokenProgram: PublicKey | string;
  readonly dataLength: number;
  readonly decimals: number;
  readonly mintAuthority: PublicKey | string | null;
  readonly freezeAuthority: PublicKey | string | null;
  readonly dataSha256?: string;
}

export type SolanaMainnetShadowExpectation =
  | SolanaMainnetShadowProgramExpectation
  | SolanaMainnetShadowAccountExpectation
  | SolanaMainnetShadowMintExpectation;

export interface SolanaMainnetShadowAccountSnapshot {
  readonly owner: PublicKey;
  readonly executable: boolean;
  readonly lamports: bigint;
  readonly data: Uint8Array;
}

export interface SolanaMainnetShadowAccountsSnapshot {
  readonly contextSlot: number;
  readonly accounts: readonly (SolanaMainnetShadowAccountSnapshot | null)[];
}

export interface SolanaMainnetShadowReadPort {
  readonly endpoint: string;
  getGenesisHash(): Promise<string>;
  getFinalizedSlot(): Promise<number>;
  getMultipleAccounts(
    addresses: readonly PublicKey[],
    minContextSlot: number,
  ): Promise<SolanaMainnetShadowAccountsSnapshot>;
}

export interface SolanaMainnetShadowAccountEvidence {
  readonly kind: SolanaMainnetShadowExpectation['kind'];
  readonly role: SolanaMainnetShadowAccountRole | 'PROGRAM' | 'ASSET_MINT';
  readonly name: string;
  readonly address: string;
  readonly owner: string;
  readonly executable: boolean;
  readonly lamports: string;
  readonly dataLength: number;
  readonly dataSha256: string;
  readonly programDataAddress?: string;
  readonly programDataLength?: number;
  readonly programDataSha256?: string;
  readonly deploymentSlot?: string;
  readonly upgradeAuthority?: string | null;
  readonly deployedCodeSha256?: string;
  readonly decimals?: number;
  readonly supplyAtoms?: string;
  readonly mintAuthority?: string | null;
  readonly freezeAuthority?: string | null;
}

export interface SolanaMainnetShadowEvidence {
  readonly evidenceClass: 'SOLANA_MAINNET_FINALIZED_READ_ONLY_SHADOW_V1';
  readonly endpoint: string;
  readonly genesisHash: typeof SOLANA_MAINNET_BETA_GENESIS_HASH;
  readonly commitment: 'finalized';
  readonly minimumFinalizedSlot: number;
  readonly accountContextSlot: number;
  readonly accounts: readonly SolanaMainnetShadowAccountEvidence[];
}

export class ConnectionSolanaMainnetShadowReadPort implements SolanaMainnetShadowReadPort {
  readonly endpoint: string;
  readonly #connection: Connection;
  readonly #commitment: Commitment = 'finalized';

  constructor(endpoint: string) {
    this.endpoint = validatedEndpoint(endpoint);
    this.#connection = new Connection(this.endpoint, this.#commitment);
  }

  getGenesisHash(): Promise<string> {
    return this.#connection.getGenesisHash();
  }

  getFinalizedSlot(): Promise<number> {
    return this.#connection.getSlot(this.#commitment);
  }

  async getMultipleAccounts(
    addresses: readonly PublicKey[],
    minContextSlot: number,
  ): Promise<SolanaMainnetShadowAccountsSnapshot> {
    const response = await this.#connection.getMultipleAccountsInfoAndContext([...addresses], {
      commitment: this.#commitment,
      minContextSlot,
    });
    return Object.freeze({
      contextSlot: response.context.slot,
      accounts: Object.freeze(response.value.map((account) => account === null
        ? null
        : snapshot(account))),
    });
  }
}

function snapshot(account: AccountInfo<Buffer>): SolanaMainnetShadowAccountSnapshot {
  return Object.freeze({
    owner: account.owner,
    executable: account.executable,
    lamports: BigInt(account.lamports),
    data: Uint8Array.from(account.data),
  });
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function validatedEndpoint(value: string): string {
  requireCondition(typeof value === 'string' && value.length > 0, 'mainnet shadow endpoint is required');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('mainnet shadow endpoint must be an absolute URL');
  }
  requireCondition(parsed.protocol === 'https:', 'mainnet shadow endpoint must use HTTPS');
  requireCondition(parsed.username === '' && parsed.password === '', 'mainnet shadow endpoint must not contain credentials');
  requireCondition(parsed.search === '', 'mainnet shadow endpoint must not contain query credentials');
  requireCondition(parsed.hash === '', 'mainnet shadow endpoint must not contain a fragment');
  return parsed.toString();
}

function publicKey(value: PublicKey | string, name: string): PublicKey {
  try {
    const checked = value instanceof PublicKey ? value : new PublicKey(value);
    requireCondition(value instanceof PublicKey || checked.toBase58() === value, `${name} must be canonical base58`);
    return checked;
  } catch {
    throw new Error(`${name} must be a Solana public key`);
  }
}

function checkedHash(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  requireCondition(SHA256_HEX.test(value), `${name} must be lowercase SHA-256 hex`);
  return value;
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function checkedSlot(value: number, name: string): number {
  requireCondition(Number.isSafeInteger(value) && value > 0, `${name} must be a positive safe integer`);
  return value;
}

function checkedDataLength(value: number, name: string): number {
  requireCondition(Number.isSafeInteger(value) && value >= 0, `${name} data length must be a nonnegative safe integer`);
  return value;
}

function optionPublicKey(data: Buffer, offset: number, name: string): PublicKey | null {
  const option = data.readUInt32LE(offset);
  requireCondition(option === 0 || option === 1, `${name} option is invalid`);
  return option === 0 ? null : new PublicKey(data.subarray(offset + 4, offset + 36));
}

function sameNullableKey(actual: PublicKey | null, expected: PublicKey | string | null, name: string): void {
  const normalized = expected === null ? null : publicKey(expected, name);
  requireCondition(
    (actual === null && normalized === null)
      || (actual !== null && normalized !== null && actual.equals(normalized)),
    `${name} mismatch`,
  );
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
  requireCondition(authorityOption === 0 || authorityOption === 1, `${name} upgrade authority option is invalid`);
  return Object.freeze({
    deploymentSlot: bytes.readBigUInt64LE(4),
    upgradeAuthority: authorityOption === 0 ? null : new PublicKey(bytes.subarray(13, 45)),
    deployedCode: Uint8Array.from(bytes.subarray(PROGRAM_DATA_METADATA_SIZE)),
  });
}

function validateName(value: string, index: number, names: Set<string>): void {
  requireCondition(
    typeof value === 'string' && /^[a-z][a-z0-9_]{1,63}$/.test(value) && !names.has(value),
    `mainnet shadow expectation ${index} has a duplicate or invalid name`,
  );
  names.add(value);
}

type NormalizedExpectation = Readonly<{
  expectation: SolanaMainnetShadowExpectation;
  address: PublicKey;
  programDataAddress?: PublicKey | undefined;
  owner?: PublicKey | undefined;
  tokenProgram?: PublicKey | undefined;
  dataSha256?: string | undefined;
  programDataSha256?: string | undefined;
  deployedCodeSha256?: string | undefined;
}>;

function normalizeExpectations(
  expectations: readonly SolanaMainnetShadowExpectation[],
): readonly NormalizedExpectation[] {
  requireCondition(
    Array.isArray(expectations) && expectations.length > 0 && expectations.length <= MAX_EXPECTATIONS,
    `mainnet shadow expectations must contain 1 to ${MAX_EXPECTATIONS} records`,
  );
  const names = new Set<string>();
  const addresses = new Set<string>();
  return expectations.map((expectation, index): NormalizedExpectation => {
    validateName(expectation.name, index, names);
    const address = publicKey(expectation.address, `${expectation.name} address`);
    requireCondition(!addresses.has(address.toBase58()), `${expectation.name} address is duplicated`);
    addresses.add(address.toBase58());
    if (expectation.kind === 'UPGRADEABLE_PROGRAM') {
      const programDataAddress = publicKey(expectation.programDataAddress, `${expectation.name} ProgramData address`);
      const derived = PublicKey.findProgramAddressSync([address.toBuffer()], SOLANA_UPGRADEABLE_LOADER_ID)[0];
      requireCondition(derived.equals(programDataAddress), `${expectation.name} ProgramData address is not derived from its program id`);
      requireCondition(!addresses.has(programDataAddress.toBase58()), `${expectation.name} ProgramData address is duplicated`);
      addresses.add(programDataAddress.toBase58());
      requireCondition(expectation.deploymentSlot >= 0n, `${expectation.name} deployment slot is invalid`);
      if (expectation.upgradeAuthority !== null) publicKey(expectation.upgradeAuthority, `${expectation.name} upgrade authority`);
      return Object.freeze({
        expectation,
        address,
        programDataAddress,
        programDataSha256: checkedHash(expectation.programDataSha256, `${expectation.name} ProgramData hash`),
        deployedCodeSha256: checkedHash(expectation.deployedCodeSha256, `${expectation.name} deployed code hash`),
      });
    }
    checkedDataLength(expectation.dataLength, expectation.name);
    if (expectation.kind === 'ACCOUNT') {
      return Object.freeze({
        expectation,
        address,
        owner: publicKey(expectation.owner, `${expectation.name} owner`),
        dataSha256: checkedHash(expectation.dataSha256, `${expectation.name} data hash`),
      });
    }
    requireCondition(expectation.dataLength >= SPL_MINT_SIZE, `${expectation.name} mint data is too short`);
    requireCondition(Number.isInteger(expectation.decimals) && expectation.decimals >= 0 && expectation.decimals <= 255, `${expectation.name} decimals are invalid`);
    if (expectation.mintAuthority !== null) publicKey(expectation.mintAuthority, `${expectation.name} mint authority`);
    if (expectation.freezeAuthority !== null) publicKey(expectation.freezeAuthority, `${expectation.name} freeze authority`);
    return Object.freeze({
      expectation,
      address,
      tokenProgram: publicKey(expectation.tokenProgram, `${expectation.name} token program`),
      dataSha256: checkedHash(expectation.dataSha256, `${expectation.name} data hash`),
    });
  });
}

function baseEvidence(
  normalized: NormalizedExpectation,
  account: SolanaMainnetShadowAccountSnapshot,
  role: SolanaMainnetShadowAccountEvidence['role'],
): SolanaMainnetShadowAccountEvidence {
  return {
    kind: normalized.expectation.kind,
    role,
    name: normalized.expectation.name,
    address: normalized.address.toBase58(),
    owner: account.owner.toBase58(),
    executable: account.executable,
    lamports: account.lamports.toString(),
    dataLength: account.data.length,
    dataSha256: sha256(account.data),
  };
}

function verifyExactAccount(
  normalized: NormalizedExpectation,
  account: SolanaMainnetShadowAccountSnapshot,
): SolanaMainnetShadowAccountEvidence {
  const expectation = normalized.expectation;
  requireCondition(expectation.kind === 'ACCOUNT' && normalized.owner !== undefined, 'account expectation is invalid');
  requireCondition(account.owner.equals(normalized.owner), `${expectation.name} owner mismatch`);
  requireCondition(account.executable === expectation.executable, `${expectation.name} executable flag mismatch`);
  requireCondition(account.data.length === expectation.dataLength, `${expectation.name} data length mismatch`);
  const evidence = baseEvidence(normalized, account, expectation.role);
  requireCondition(normalized.dataSha256 === undefined || evidence.dataSha256 === normalized.dataSha256, `${expectation.name} data hash mismatch`);
  return Object.freeze(evidence);
}

function verifyMint(
  normalized: NormalizedExpectation,
  account: SolanaMainnetShadowAccountSnapshot,
): SolanaMainnetShadowAccountEvidence {
  const expectation = normalized.expectation;
  requireCondition(expectation.kind === 'SPL_MINT' && normalized.tokenProgram !== undefined, 'mint expectation is invalid');
  requireCondition(account.owner.equals(normalized.tokenProgram), `${expectation.name} token program mismatch`);
  requireCondition(!account.executable, `${expectation.name} mint must not be executable`);
  requireCondition(account.data.length === expectation.dataLength, `${expectation.name} data length mismatch`);
  const bytes = Buffer.from(account.data);
  const mintAuthority = optionPublicKey(bytes, 0, `${expectation.name} mint authority`);
  const supplyAtoms = bytes.readBigUInt64LE(36);
  const decimals = bytes[44];
  requireCondition(bytes[45] === 1, `${expectation.name} mint is not initialized`);
  const freezeAuthority = optionPublicKey(bytes, 46, `${expectation.name} freeze authority`);
  requireCondition(decimals === expectation.decimals, `${expectation.name} decimals mismatch`);
  sameNullableKey(mintAuthority, expectation.mintAuthority, `${expectation.name} mint authority`);
  sameNullableKey(freezeAuthority, expectation.freezeAuthority, `${expectation.name} freeze authority`);
  const evidence = {
    ...baseEvidence(normalized, account, 'ASSET_MINT'),
    decimals,
    supplyAtoms: supplyAtoms.toString(),
    mintAuthority: mintAuthority?.toBase58() ?? null,
    freezeAuthority: freezeAuthority?.toBase58() ?? null,
  };
  requireCondition(normalized.dataSha256 === undefined || evidence.dataSha256 === normalized.dataSha256, `${expectation.name} data hash mismatch`);
  return Object.freeze(evidence);
}

function verifyProgram(
  normalized: NormalizedExpectation,
  program: SolanaMainnetShadowAccountSnapshot,
  programData: SolanaMainnetShadowAccountSnapshot,
): SolanaMainnetShadowAccountEvidence {
  const expectation = normalized.expectation;
  requireCondition(expectation.kind === 'UPGRADEABLE_PROGRAM' && normalized.programDataAddress !== undefined, 'program expectation is invalid');
  requireCondition(program.executable && program.owner.equals(SOLANA_UPGRADEABLE_LOADER_ID), `${expectation.name} program executable or loader mismatch`);
  requireCondition(!programData.executable && programData.owner.equals(SOLANA_UPGRADEABLE_LOADER_ID), `${expectation.name} ProgramData executable or loader mismatch`);
  requireCondition(decodeProgram(program.data, expectation.name).equals(normalized.programDataAddress), `${expectation.name} ProgramData linkage mismatch`);
  const decoded = decodeProgramData(programData.data, expectation.name);
  requireCondition(decoded.deploymentSlot === expectation.deploymentSlot, `${expectation.name} deployment slot mismatch`);
  sameNullableKey(decoded.upgradeAuthority, expectation.upgradeAuthority, `${expectation.name} upgrade authority`);
  const programDataSha256 = sha256(programData.data);
  const deployedCodeSha256 = sha256(decoded.deployedCode);
  requireCondition(normalized.programDataSha256 === undefined || programDataSha256 === normalized.programDataSha256, `${expectation.name} ProgramData hash mismatch`);
  requireCondition(normalized.deployedCodeSha256 === undefined || deployedCodeSha256 === normalized.deployedCodeSha256, `${expectation.name} deployed code hash mismatch`);
  return Object.freeze({
    ...baseEvidence(normalized, program, 'PROGRAM'),
    programDataAddress: normalized.programDataAddress.toBase58(),
    programDataLength: programData.data.length,
    programDataSha256,
    deploymentSlot: decoded.deploymentSlot.toString(),
    upgradeAuthority: decoded.upgradeAuthority?.toBase58() ?? null,
    deployedCodeSha256,
  });
}

export async function qualifySolanaMainnetShadow(
  expectations: readonly SolanaMainnetShadowExpectation[],
  rpc: SolanaMainnetShadowReadPort,
): Promise<SolanaMainnetShadowEvidence> {
  const endpoint = validatedEndpoint(rpc.endpoint);
  const normalized = normalizeExpectations(expectations);
  requireCondition(await rpc.getGenesisHash() === SOLANA_MAINNET_BETA_GENESIS_HASH, 'RPC is not Solana mainnet-beta');
  const minimumFinalizedSlot = checkedSlot(await rpc.getFinalizedSlot(), 'minimum finalized slot');
  const addresses = normalized.flatMap((item) => item.programDataAddress === undefined
    ? [item.address]
    : [item.address, item.programDataAddress]);
  const snapshotValue = await rpc.getMultipleAccounts(addresses, minimumFinalizedSlot);
  const accountContextSlot = checkedSlot(snapshotValue.contextSlot, 'account context slot');
  requireCondition(accountContextSlot >= minimumFinalizedSlot, 'mainnet shadow account snapshot is stale');
  requireCondition(snapshotValue.accounts.length === addresses.length, 'mainnet shadow account snapshot is incomplete');
  const evidence: SolanaMainnetShadowAccountEvidence[] = [];
  let accountIndex = 0;
  for (const item of normalized) {
    const account = snapshotValue.accounts[accountIndex++];
    requireCondition(account !== null && account !== undefined, `${item.expectation.name} account is missing`);
    requireCondition(account.lamports >= 0n, `${item.expectation.name} lamports are invalid`);
    if (item.expectation.kind === 'UPGRADEABLE_PROGRAM') {
      const programData = snapshotValue.accounts[accountIndex++];
      requireCondition(programData !== null && programData !== undefined, `${item.expectation.name} ProgramData account is missing`);
      evidence.push(verifyProgram(item, account, programData));
    } else if (item.expectation.kind === 'SPL_MINT') {
      evidence.push(verifyMint(item, account));
    } else {
      evidence.push(verifyExactAccount(item, account));
    }
  }
  return Object.freeze({
    evidenceClass: 'SOLANA_MAINNET_FINALIZED_READ_ONLY_SHADOW_V1',
    endpoint,
    genesisHash: SOLANA_MAINNET_BETA_GENESIS_HASH,
    commitment: 'finalized',
    minimumFinalizedSlot,
    accountContextSlot,
    accounts: Object.freeze(evidence),
  });
}
