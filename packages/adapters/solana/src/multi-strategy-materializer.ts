import { createHash } from 'node:crypto';
import {
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  PACKET_DATA_SIZE,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { bytesEqual, type DomainRef } from '@naryx/protocol-types';
import {
  SOLANA_DEVNET_GENESIS_HASH,
  SOLANA_MAINNET_BETA_GENESIS_HASH,
  type SolanaLookupTableCommitment,
  type SolanaLookupTableConfig,
  type SolanaMaterializerConfig,
  type SolanaReadOnlyRpc,
} from './materializer.js';
import type { SolanaMultiStrategyEnvelope } from './multi-strategy-account.js';

const U64_MAX = (1n << 64n) - 1n;
const MAX_RESOLVED_ADDRESSES = 64;
const MAX_COMPUTE_UNIT_LIMIT = 1_260_000;
const LOOKUP_TABLE_COMMITMENT_DOMAIN = 'NARYX/solana-multi-strategy-lookup-table/v1';
const MATERIALIZATION_COMMITMENT_DOMAIN = 'NARYX/solana-multi-strategy-materialization/v1';

interface NormalizedLookupTableConfig {
  readonly address: PublicKey;
  readonly expectedAddresses: readonly PublicKey[];
}

export interface SolanaMultiStrategyMaterializationRequest {
  readonly domain: DomainRef;
  readonly payer: PublicKey | string;
  readonly envelope: SolanaMultiStrategyEnvelope;
  readonly computeUnitLimit: number;
}

export interface SolanaMultiStrategyMaterialization {
  readonly domain: DomainRef;
  readonly messageBytes: Uint8Array;
  readonly messageBase64: string;
  readonly transactionBytes: Uint8Array;
  readonly transactionBase64: string;
  readonly requiredSignerPubkeys: readonly string[];
  readonly recentBlockhash: string;
  readonly blockhashContextSlot: number;
  readonly lastValidBlockHeight: number;
  readonly genesisHash: string;
  readonly lookupTables: readonly SolanaLookupTableCommitment[];
  readonly evidence: Readonly<{
    resolvedAddressCount: number;
    serializedMessageBytes: number;
    serializedTransactionBytes: number;
    packetDataLimit: number;
    computeUnitLimit: number;
  }>;
  readonly materializationCommitment: Uint8Array;
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function publicKey(value: PublicKey | string, name: string): PublicKey {
  try {
    return value instanceof PublicKey ? value : new PublicKey(value);
  } catch {
    throw new Error(`${name} must be a Solana public key`);
  }
}

function validateRpcUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('trusted RPC URL is invalid');
  }
  requireCondition(
    (url.protocol === 'http:' || url.protocol === 'https:') && url.username === '' && url.password === '',
    'trusted RPC URL must use HTTP or HTTPS without credentials',
  );
}

function validateDomain(domain: DomainRef): void {
  requireCondition(domain.domainId.startsWith('svm:'), 'materializer domain must use the SVM namespace');
  requireCondition(
    Number.isInteger(domain.domainManifestVersion) && domain.domainManifestVersion > 0,
    'materializer domain version must be nonzero',
  );
  requireCondition(
    domain.domainManifestHash.length === 32 && domain.domainManifestHash.some((byte) => byte !== 0),
    'materializer domain hash must be nonzero',
  );
}

function sameDomain(left: DomainRef, right: DomainRef): boolean {
  return left.domainId === right.domainId
    && left.domainManifestVersion === right.domainManifestVersion
    && bytesEqual(left.domainManifestHash, right.domainManifestHash);
}

function bigEndian(value: bigint, bytes: number): Uint8Array {
  requireCondition(value >= 0n && value <= (1n << BigInt(bytes * 8)) - 1n, 'commitment integer is out of range');
  const output = new Uint8Array(bytes);
  let remaining = value;
  for (let index = bytes - 1; index >= 0; index -= 1) {
    output[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return output;
}

function lengthPrefixed(value: Uint8Array): Uint8Array {
  return Buffer.concat([Buffer.from(bigEndian(BigInt(value.length), 4)), Buffer.from(value)]);
}

function hashDomain(domain: string, ...parts: readonly Uint8Array[]): Uint8Array {
  const hash = createHash('sha256');
  hash.update(Buffer.from(domain, 'ascii'));
  for (const part of parts) hash.update(part);
  return new Uint8Array(hash.digest());
}

function domainBytes(domain: DomainRef): Uint8Array {
  return Buffer.concat([
    Buffer.from(lengthPrefixed(Buffer.from(domain.domainId, 'utf8'))),
    Buffer.from(bigEndian(BigInt(domain.domainManifestVersion), 4)),
    Buffer.from(domain.domainManifestHash),
  ]);
}

function lookupTableCommitment(
  address: PublicKey,
  owner: PublicKey,
  deactivationSlot: bigint,
  lastExtendedSlot: number,
  lastExtendedSlotStartIndex: number,
  authority: PublicKey | undefined,
  addresses: readonly PublicKey[],
): Uint8Array {
  return hashDomain(
    LOOKUP_TABLE_COMMITMENT_DOMAIN,
    owner.toBytes(),
    address.toBytes(),
    bigEndian(deactivationSlot, 8),
    bigEndian(BigInt(lastExtendedSlot), 8),
    bigEndian(BigInt(lastExtendedSlotStartIndex), 1),
    Uint8Array.of(authority === undefined ? 0 : 1),
    ...(authority === undefined ? [] : [authority.toBytes()]),
    bigEndian(BigInt(addresses.length), 4),
    ...addresses.map((item) => item.toBytes()),
  );
}

function normalizedLookupTables(values: readonly SolanaLookupTableConfig[]): readonly NormalizedLookupTableConfig[] {
  const seen = new Set<string>();
  return Object.freeze(values.map((value, index) => {
    const address = publicKey(value.address, `lookup table ${index}`);
    requireCondition(!seen.has(address.toBase58()), `duplicate lookup table ${address.toBase58()}`);
    seen.add(address.toBase58());
    requireCondition(value.expectedAddresses.length > 0 && value.expectedAddresses.length <= 256,
      `lookup table ${address.toBase58()} must contain 1 to 256 expected addresses`);
    return Object.freeze({
      address,
      expectedAddresses: Object.freeze(value.expectedAddresses.map((item) =>
        publicKey(item, `lookup table ${address.toBase58()} address`))),
    });
  }));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export class SolanaMultiStrategyTransactionMaterializer {
  readonly #rpc: SolanaReadOnlyRpc;
  readonly #config: SolanaMaterializerConfig;
  readonly #lookupConfigs: readonly NormalizedLookupTableConfig[];

  constructor(rpc: SolanaReadOnlyRpc, config: SolanaMaterializerConfig) {
    validateRpcUrl(config.rpcUrl);
    validateDomain(config.domain);
    requireCondition(config.environment === 'local' || config.environment === 'devnet',
      'materializer environment must be local or devnet');
    requireCondition(rpc.rpcUrl === config.rpcUrl, 'RPC port URL does not match trusted configuration');
    requireCondition(config.expectedGenesisHash !== SOLANA_MAINNET_BETA_GENESIS_HASH,
      'mainnet-beta genesis is prohibited');
    if (config.environment === 'devnet') {
      requireCondition(config.expectedGenesisHash === SOLANA_DEVNET_GENESIS_HASH, 'unknown Devnet genesis hash');
    } else {
      publicKey(config.expectedGenesisHash, 'local genesis hash');
    }
    this.#rpc = rpc;
    this.#config = Object.freeze({
      ...config,
      domain: Object.freeze({
        ...config.domain,
        domainManifestHash: Uint8Array.from(config.domain.domainManifestHash) as DomainRef['domainManifestHash'],
      }),
      lookupTables: Object.freeze([...config.lookupTables]),
    });
    this.#lookupConfigs = normalizedLookupTables(config.lookupTables);
  }

  async materialize(request: SolanaMultiStrategyMaterializationRequest): Promise<SolanaMultiStrategyMaterialization> {
    requireCondition(sameDomain(request.domain, this.#config.domain), 'materialization domain mismatch');
    requireCondition(request.envelope.executionHash.length === 32
      && request.envelope.executionHash.some((byte) => byte !== 0),
    'execution hash must be a nonzero 32-byte value');
    requireCondition(request.envelope.callsHash.length === 32
      && request.envelope.callsHash.some((byte) => byte !== 0),
    'calls hash must be a nonzero 32-byte value');
    requireCondition(Number.isInteger(request.computeUnitLimit)
      && request.computeUnitLimit > 0
      && request.computeUnitLimit <= MAX_COMPUTE_UNIT_LIMIT,
    'compute unit limit must be between 1 and 1260000');
    const payer = publicKey(request.payer, 'payer');
    requireCondition(request.envelope.instruction.keys[0]?.pubkey.equals(payer) === true
      && request.envelope.instruction.keys[0]?.isSigner === true,
    'payer must be the first signer of the multi-strategy instruction');

    const genesisHash = await this.#rpc.getGenesisHash();
    requireCondition(genesisHash !== SOLANA_MAINNET_BETA_GENESIS_HASH, 'mainnet-beta genesis is prohibited');
    requireCondition(genesisHash === this.#config.expectedGenesisHash,
      'RPC genesis hash does not match trusted configuration');
    const latest = await this.#rpc.getLatestBlockhash();
    requireCondition(Number.isSafeInteger(latest.contextSlot) && latest.contextSlot >= 0,
      'latest blockhash context slot is invalid');
    requireCondition(Number.isSafeInteger(latest.lastValidBlockHeight) && latest.lastValidBlockHeight >= 0,
      'last-valid block height is invalid');
    publicKey(latest.blockhash, 'recent blockhash');

    const lookupAccounts = [];
    const lookupEvidence: SolanaLookupTableCommitment[] = [];
    for (const config of this.#lookupConfigs) {
      const snapshot = await this.#rpc.getLookupTable(config.address, latest.contextSlot);
      requireCondition(snapshot !== null, `lookup table ${config.address.toBase58()} is missing`);
      requireCondition(snapshot.contextSlot >= latest.contextSlot,
        `lookup table ${config.address.toBase58()} context is stale`);
      requireCondition(snapshot.owner.equals(AddressLookupTableProgram.programId),
        `lookup table ${config.address.toBase58()} owner mismatch`);
      requireCondition(!snapshot.executable, `lookup table ${config.address.toBase58()} must not be executable`);
      requireCondition(snapshot.account.key.equals(config.address),
        `lookup table ${config.address.toBase58()} identity mismatch`);
      requireCondition(snapshot.account.isActive() && snapshot.account.state.deactivationSlot === U64_MAX,
        `lookup table ${config.address.toBase58()} is deactivated`);
      requireCondition(snapshot.account.state.lastExtendedSlot < snapshot.contextSlot,
        `lookup table ${config.address.toBase58()} extension is not warmed up`);
      requireCondition(snapshot.account.state.lastExtendedSlotStartIndex <= snapshot.account.state.addresses.length,
        `lookup table ${config.address.toBase58()} state is invalid`);
      requireCondition(snapshot.account.state.addresses.length === config.expectedAddresses.length,
        `lookup table ${config.address.toBase58()} content length mismatch`);
      for (const [index, address] of snapshot.account.state.addresses.entries()) {
        requireCondition(address.equals(config.expectedAddresses[index]!),
          `lookup table ${config.address.toBase58()} content mismatch at index ${index}`);
      }
      lookupAccounts.push(snapshot.account);
      lookupEvidence.push(Object.freeze({
        address: config.address.toBase58(),
        addresses: Object.freeze(snapshot.account.state.addresses.map((address) => address.toBase58())),
        contentCommitment: lookupTableCommitment(
          snapshot.account.key,
          snapshot.owner,
          snapshot.account.state.deactivationSlot,
          snapshot.account.state.lastExtendedSlot,
          snapshot.account.state.lastExtendedSlotStartIndex,
          snapshot.account.state.authority,
          snapshot.account.state.addresses,
        ),
        contextSlot: snapshot.contextSlot,
      }));
    }

    const message = new TransactionMessage({
      payerKey: payer,
      recentBlockhash: latest.blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: request.computeUnitLimit }),
        request.envelope.instruction,
      ],
    }).compileToV0Message(lookupAccounts);
    const usedLookupTables = message.addressTableLookups.map((lookup) => lookup.accountKey.toBase58()).sort();
    const configuredLookupTables = lookupAccounts.map((account) => account.key.toBase58()).sort();
    requireCondition(sameStrings(usedLookupTables, configuredLookupTables),
      'configured lookup-table set does not exactly match the materialized message');
    const requiredSignerPubkeys = Object.freeze(
      message.staticAccountKeys.slice(0, message.header.numRequiredSignatures).map((key) => key.toBase58()),
    );
    requireCondition(sameStrings(
      [...requiredSignerPubkeys].sort(),
      [...request.envelope.requiredSignerPubkeys].sort(),
    ), 'materialized transaction signer set differs from the strategy envelope');
    const resolvedAddressCount = message.staticAccountKeys.length + message.addressTableLookups.reduce(
      (count, lookup) => count + lookup.writableIndexes.length + lookup.readonlyIndexes.length,
      0,
    );
    requireCondition(resolvedAddressCount <= MAX_RESOLVED_ADDRESSES,
      'materialized message exceeds 64 resolved addresses');
    const messageBytes = message.serialize();
    const transaction = new VersionedTransaction(message);
    requireCondition(transaction.signatures.every((signature) => signature.every((byte) => byte === 0)),
      'unsigned transaction contains a signature');
    let transactionBytes: Uint8Array;
    try {
      transactionBytes = transaction.serialize();
    } catch (error) {
      if (error instanceof Error && error.message.includes('encoding overruns Uint8Array')) {
        throw new Error('materialized transaction exceeds the 1232-byte wire limit');
      }
      throw error;
    }
    requireCondition(transactionBytes.length <= PACKET_DATA_SIZE,
      'materialized transaction exceeds the 1232-byte wire limit');
    const materializationCommitment = hashDomain(
      MATERIALIZATION_COMMITMENT_DOMAIN,
      domainBytes(request.domain),
      Buffer.from(genesisHash, 'ascii'),
      publicKey(latest.blockhash, 'recent blockhash').toBytes(),
      bigEndian(BigInt(latest.contextSlot), 8),
      bigEndian(BigInt(latest.lastValidBlockHeight), 8),
      bigEndian(BigInt(request.computeUnitLimit), 4),
      request.envelope.executionHash,
      request.envelope.callsHash,
      bigEndian(BigInt(lookupEvidence.length), 4),
      ...lookupEvidence.flatMap((table) => [bigEndian(BigInt(table.contextSlot), 8), table.contentCommitment]),
      hashDomain('NARYX/solana-v0-message/v1', messageBytes),
      hashDomain('NARYX/solana-zero-signature-transaction/v1', transactionBytes),
    );
    return Object.freeze({
      domain: this.#config.domain,
      messageBytes: Uint8Array.from(messageBytes),
      messageBase64: Buffer.from(messageBytes).toString('base64'),
      transactionBytes: Uint8Array.from(transactionBytes),
      transactionBase64: Buffer.from(transactionBytes).toString('base64'),
      requiredSignerPubkeys,
      recentBlockhash: latest.blockhash,
      blockhashContextSlot: latest.contextSlot,
      lastValidBlockHeight: latest.lastValidBlockHeight,
      genesisHash,
      lookupTables: Object.freeze(lookupEvidence),
      evidence: Object.freeze({
        resolvedAddressCount,
        serializedMessageBytes: messageBytes.length,
        serializedTransactionBytes: transactionBytes.length,
        packetDataLimit: PACKET_DATA_SIZE,
        computeUnitLimit: request.computeUnitLimit,
      }),
      materializationCommitment,
    });
  }
}
