import { createHash } from 'node:crypto';
import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  type Commitment,
  Connection,
  PACKET_DATA_SIZE,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { bytesEqual, type DomainRef, type PackageAdmission } from '@naryx/protocol-types';
import {
  compileFirmCashCarryPlan,
  type FirmCashCarryBinding,
  type SolanaMessageContext,
  type UnsignedSolanaTransactionPlan,
} from './firm-plan.js';
import type { PublicCashCarryExitPlan } from './public-exit-plan.js';

export const SOLANA_DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export const SOLANA_MAINNET_BETA_GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

const MAX_RESOLVED_ADDRESSES = 64;
const MAX_ROUTE_COMPUTE_UNITS = 1_260_000;
const U64_MAX = (1n << 64n) - 1n;
const REQUEST_COMMITMENT_DOMAIN = 'NARYX/solana-unsigned-materialization/v1';
const LOOKUP_TABLE_COMMITMENT_DOMAIN = 'NARYX/solana-lookup-table/v1';

export type SolanaMaterializedPlanKind =
  | 'SOLVER_LOCK'
  | 'TRADER_ENTRY'
  | 'SOLVER_AUTHORIZED_EXIT'
  | 'TRADER_RECOVERY_EXIT';

export interface SolanaLookupTableConfig {
  readonly address: PublicKey | string;
  readonly expectedAddresses: readonly (PublicKey | string)[];
}

export interface SolanaMaterializerConfig {
  readonly environment: 'local' | 'devnet';
  readonly domain: DomainRef;
  readonly rpcUrl: string;
  readonly expectedGenesisHash: string;
  readonly lookupTables: readonly SolanaLookupTableConfig[];
}

export interface SolanaLatestBlockhashSnapshot {
  readonly contextSlot: number;
  readonly blockhash: string;
  readonly lastValidBlockHeight: number;
}

export interface SolanaLookupTableSnapshot {
  readonly contextSlot: number;
  readonly owner: PublicKey;
  readonly executable: boolean;
  readonly account: AddressLookupTableAccount;
}

export interface SolanaReadOnlyRpc {
  readonly rpcUrl: string;
  getGenesisHash(): Promise<string>;
  getLatestBlockhash(): Promise<SolanaLatestBlockhashSnapshot>;
  getLookupTable(address: PublicKey, minContextSlot: number): Promise<SolanaLookupTableSnapshot | null>;
}

export class ConnectionSolanaReadOnlyRpc implements SolanaReadOnlyRpc {
  readonly rpcUrl: string;
  readonly #connection: Connection;
  readonly #commitment: Commitment;

  constructor(rpcUrl: string, commitment: Commitment = 'finalized') {
    validateRpcUrl(rpcUrl);
    this.rpcUrl = rpcUrl;
    this.#commitment = commitment;
    this.#connection = new Connection(rpcUrl, commitment);
  }

  getGenesisHash(): Promise<string> {
    return this.#connection.getGenesisHash();
  }

  async getLatestBlockhash(): Promise<SolanaLatestBlockhashSnapshot> {
    const response = await this.#connection.getLatestBlockhashAndContext(this.#commitment);
    return Object.freeze({
      contextSlot: response.context.slot,
      blockhash: response.value.blockhash,
      lastValidBlockHeight: response.value.lastValidBlockHeight,
    });
  }

  async getLookupTable(address: PublicKey, minContextSlot: number): Promise<SolanaLookupTableSnapshot | null> {
    const response = await this.#connection.getAccountInfoAndContext(address, {
      commitment: this.#commitment,
      minContextSlot,
    });
    if (response.value === null) return null;
    return Object.freeze({
      contextSlot: response.context.slot,
      owner: response.value.owner,
      executable: response.value.executable,
      account: new AddressLookupTableAccount({
        key: address,
        state: AddressLookupTableAccount.deserialize(response.value.data),
      }),
    });
  }
}

export interface SolanaMaterializationRequest {
  readonly planKind: SolanaMaterializedPlanKind;
  readonly admission: PackageAdmission;
  readonly binding: FirmCashCarryBinding;
}

export interface SolanaLookupTableCommitment {
  readonly address: string;
  readonly addresses: readonly string[];
  readonly contentCommitment: Uint8Array;
  readonly contextSlot: number;
}

export interface UnsignedSolanaMaterialization {
  readonly domain: DomainRef;
  readonly planKind: SolanaMaterializedPlanKind;
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
    computeUnitLimit: number | null;
    computeUnitLimitSource: 'EXPLICIT' | 'NO_COMPUTE_BUDGET_INSTRUCTION';
    routeComputeUnitLimit: number;
  }>;
  readonly requestCommitment: Uint8Array;
}

type SelectedPlan = UnsignedSolanaTransactionPlan | PublicCashCarryExitPlan;

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

function sameDomain(left: DomainRef, right: DomainRef): boolean {
  return left.domainId === right.domainId
    && left.domainManifestVersion === right.domainManifestVersion
    && bytesEqual(left.domainManifestHash, right.domainManifestHash);
}

function validateDomain(domain: DomainRef): void {
  requireCondition(domain.domainId.startsWith('svm:'), 'materializer domain must use the SVM namespace');
  requireCondition(Number.isInteger(domain.domainManifestVersion) && domain.domainManifestVersion > 0, 'materializer domain version must be nonzero');
  requireCondition(domain.domainManifestHash.length === 32 && domain.domainManifestHash.some((byte) => byte !== 0), 'materializer domain hash must be nonzero');
}

function validateRpcUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('trusted RPC URL is invalid');
  }
  requireCondition((url.protocol === 'http:' || url.protocol === 'https:') && url.username === '' && url.password === '', 'trusted RPC URL must use HTTP or HTTPS without credentials');
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

function textBytes(value: string): Uint8Array {
  return lengthPrefixed(Buffer.from(value, 'utf8'));
}

function hashDomain(domain: string, ...parts: readonly Uint8Array[]): Uint8Array {
  const hash = createHash('sha256');
  hash.update(Buffer.from(domain, 'ascii'));
  for (const part of parts) hash.update(part);
  return new Uint8Array(hash.digest());
}

function domainBytes(domain: DomainRef): Uint8Array {
  return Buffer.concat([
    Buffer.from(textBytes(domain.domainId)),
    Buffer.from(bigEndian(BigInt(domain.domainManifestVersion), 4)),
    Buffer.from(domain.domainManifestHash),
  ]);
}

function lookupTableCommitment(account: AddressLookupTableAccount, owner: PublicKey): Uint8Array {
  const authority = account.state.authority;
  return hashDomain(
    LOOKUP_TABLE_COMMITMENT_DOMAIN,
    owner.toBytes(),
    account.key.toBytes(),
    bigEndian(account.state.deactivationSlot, 8),
    bigEndian(BigInt(account.state.lastExtendedSlot), 8),
    bigEndian(BigInt(account.state.lastExtendedSlotStartIndex), 1),
    Uint8Array.of(authority === undefined ? 0 : 1),
    ...(authority === undefined ? [] : [authority.toBytes()]),
    bigEndian(BigInt(account.state.addresses.length), 4),
    ...account.state.addresses.map((address) => address.toBytes()),
  );
}

function requestCommitment(
  environment: 'local' | 'devnet',
  domain: DomainRef,
  planKind: SolanaMaterializedPlanKind,
  genesisHash: string,
  orderHash: Uint8Array,
  quoteHash: Uint8Array,
  routeHash: Uint8Array,
  blockhash: string,
  blockhashContextSlot: number,
  lastValidBlockHeight: number,
  lookupTables: readonly SolanaLookupTableCommitment[],
  messageBytes: Uint8Array,
  transactionBytes: Uint8Array,
): Uint8Array {
  return hashDomain(
    REQUEST_COMMITMENT_DOMAIN,
    textBytes(environment),
    domainBytes(domain),
    textBytes(planKind),
    textBytes(genesisHash),
    orderHash,
    quoteHash,
    routeHash,
    publicKey(blockhash, 'recent blockhash').toBytes(),
    bigEndian(BigInt(blockhashContextSlot), 8),
    bigEndian(BigInt(lastValidBlockHeight), 8),
    bigEndian(BigInt(lookupTables.length), 4),
    ...lookupTables.flatMap((table) => [bigEndian(BigInt(table.contextSlot), 8), table.contentCommitment]),
    hashDomain('NARYX/solana-v0-message/v1', messageBytes),
    hashDomain('NARYX/solana-zero-signature-transaction/v1', transactionBytes),
  );
}

function planHashes(
  kind: SolanaMaterializedPlanKind,
  admission: PackageAdmission,
  exit: PublicCashCarryExitPlan | undefined,
): readonly [Uint8Array, Uint8Array, Uint8Array] {
  if (kind === 'SOLVER_AUTHORIZED_EXIT' || kind === 'TRADER_RECOVERY_EXIT') {
    requireCondition(exit !== undefined, 'public exit plan is unavailable');
    return [exit.orderHash, exit.quoteHash, exit.routeHash];
  }
  return [admission.orderHash, admission.quoteHash, admission.routeHash];
}

function selectedComputeUnitLimit(request: SolanaMaterializationRequest): number | null {
  if (request.planKind === 'SOLVER_LOCK') return null;
  if (request.planKind === 'TRADER_ENTRY') return request.binding.computeUnitLimit;
  requireCondition(request.binding.publicExit !== undefined, 'public exit binding is required');
  return request.binding.publicExit.computeUnitLimit;
}

export class SolanaUnsignedTransactionMaterializer {
  readonly #rpc: SolanaReadOnlyRpc;
  readonly #config: SolanaMaterializerConfig;
  readonly #lookupConfigs: readonly Readonly<{ address: PublicKey; expectedAddresses: readonly PublicKey[] }>[];

  constructor(rpc: SolanaReadOnlyRpc, config: SolanaMaterializerConfig) {
    validateRpcUrl(config.rpcUrl);
    validateDomain(config.domain);
    requireCondition(config.environment === 'local' || config.environment === 'devnet', 'materializer environment must be local or devnet');
    requireCondition(rpc.rpcUrl === config.rpcUrl, 'RPC port URL does not match trusted configuration');
    requireCondition(config.expectedGenesisHash.length > 0, 'expected genesis hash is required');
    requireCondition(config.expectedGenesisHash !== SOLANA_MAINNET_BETA_GENESIS_HASH, 'mainnet-beta genesis is prohibited');
    if (config.environment === 'devnet') {
      requireCondition(config.expectedGenesisHash === SOLANA_DEVNET_GENESIS_HASH, 'unknown Devnet genesis hash');
    } else {
      publicKey(config.expectedGenesisHash, 'local genesis hash');
    }
    const seen = new Set<string>();
    this.#lookupConfigs = Object.freeze(config.lookupTables.map((table, index) => {
      const address = publicKey(table.address, `lookup table ${index}`);
      requireCondition(!seen.has(address.toBase58()), `duplicate lookup table ${address.toBase58()}`);
      seen.add(address.toBase58());
      requireCondition(table.expectedAddresses.length <= 256, `lookup table ${address.toBase58()} exceeds 256 addresses`);
      return Object.freeze({
        address,
        expectedAddresses: Object.freeze(table.expectedAddresses.map((value) => publicKey(value, `lookup table ${address.toBase58()} address`))),
      });
    }));
    this.#rpc = rpc;
    this.#config = Object.freeze({
      ...config,
      domain: Object.freeze({
        ...config.domain,
        domainManifestHash: Uint8Array.from(config.domain.domainManifestHash) as DomainRef['domainManifestHash'],
      }),
      lookupTables: Object.freeze([...config.lookupTables]),
    });
  }

  async materialize(request: SolanaMaterializationRequest): Promise<UnsignedSolanaMaterialization> {
    requireCondition(request.binding.environment === this.#config.environment, 'materialization environment mismatch');
    requireCondition(sameDomain(request.binding.domain, this.#config.domain), 'materialization binding domain mismatch');
    for (const [name, environment, domain] of [
      ['order', request.admission.order.environment, request.admission.order.domain],
      ['quote', request.admission.quote.environment, request.admission.quote.domain],
      ['route', request.admission.route.environment, request.admission.route.domain],
    ] as const) {
      requireCondition(environment === this.#config.environment, `materialization ${name} environment mismatch`);
      requireCondition(sameDomain(domain, this.#config.domain), `materialization ${name} domain mismatch`);
    }
    if (request.planKind === 'SOLVER_AUTHORIZED_EXIT' || request.planKind === 'TRADER_RECOVERY_EXIT') {
      requireCondition(request.binding.publicExit !== undefined, 'public exit binding is required');
      for (const [name, environment, domain] of [
        ['order', request.binding.publicExit.admission.order.environment, request.binding.publicExit.admission.order.domain],
        ['quote', request.binding.publicExit.admission.quote.environment, request.binding.publicExit.admission.quote.domain],
        ['route', request.binding.publicExit.admission.route.environment, request.binding.publicExit.admission.route.domain],
      ] as const) {
        requireCondition(environment === this.#config.environment, `public exit ${name} environment mismatch`);
        requireCondition(sameDomain(domain, this.#config.domain), `public exit ${name} historical domain mismatch`);
      }
      requireCondition(request.binding.publicExit.activeDomain.domainId === this.#config.domain.domainId, 'public exit active domain identity mismatch');
    }
    const computeUnitLimit = selectedComputeUnitLimit(request);
    requireCondition(computeUnitLimit === null || (Number.isInteger(computeUnitLimit) && computeUnitLimit > 0 && computeUnitLimit <= MAX_ROUTE_COMPUTE_UNITS), 'materialized plan exceeds the 1260000 CU route cap');

    const genesisHash = await this.#rpc.getGenesisHash();
    requireCondition(genesisHash !== SOLANA_MAINNET_BETA_GENESIS_HASH, 'mainnet-beta genesis is prohibited');
    requireCondition(genesisHash === this.#config.expectedGenesisHash, 'RPC genesis hash does not match trusted configuration');
    const latest = await this.#rpc.getLatestBlockhash();
    requireCondition(Number.isSafeInteger(latest.contextSlot) && latest.contextSlot >= 0, 'latest blockhash context slot is invalid');
    requireCondition(Number.isSafeInteger(latest.lastValidBlockHeight) && latest.lastValidBlockHeight >= 0, 'last-valid block height is invalid');
    publicKey(latest.blockhash, 'recent blockhash');

    const lookupAccounts: AddressLookupTableAccount[] = [];
    const lookupEvidence: SolanaLookupTableCommitment[] = [];
    for (const config of this.#lookupConfigs) {
      const snapshot = await this.#rpc.getLookupTable(config.address, latest.contextSlot);
      requireCondition(snapshot !== null, `lookup table ${config.address.toBase58()} is missing`);
      requireCondition(snapshot.contextSlot >= latest.contextSlot, `lookup table ${config.address.toBase58()} context is stale`);
      requireCondition(snapshot.owner.equals(AddressLookupTableProgram.programId), `lookup table ${config.address.toBase58()} owner mismatch`);
      requireCondition(!snapshot.executable, `lookup table ${config.address.toBase58()} must not be executable`);
      requireCondition(snapshot.account.key.equals(config.address), `lookup table ${config.address.toBase58()} identity mismatch`);
      requireCondition(snapshot.account.isActive() && snapshot.account.state.deactivationSlot === U64_MAX, `lookup table ${config.address.toBase58()} is deactivated`);
      requireCondition(snapshot.account.state.lastExtendedSlot < snapshot.contextSlot, `lookup table ${config.address.toBase58()} extension is not warmed up`);
      requireCondition(snapshot.account.state.lastExtendedSlotStartIndex <= snapshot.account.state.addresses.length, `lookup table ${config.address.toBase58()} state is invalid`);
      requireCondition(snapshot.account.state.addresses.length === config.expectedAddresses.length, `lookup table ${config.address.toBase58()} content length mismatch`);
      for (const [index, address] of snapshot.account.state.addresses.entries()) {
        requireCondition(address.equals(config.expectedAddresses[index]!), `lookup table ${config.address.toBase58()} content mismatch at index ${index}`);
      }
      lookupAccounts.push(snapshot.account);
      lookupEvidence.push(Object.freeze({
        address: config.address.toBase58(),
        addresses: Object.freeze(snapshot.account.state.addresses.map((address) => address.toBase58())),
        contentCommitment: lookupTableCommitment(snapshot.account, snapshot.owner),
        contextSlot: snapshot.contextSlot,
      }));
    }

    const messageContext: SolanaMessageContext = Object.freeze({
      recentBlockhash: latest.blockhash,
      addressLookupTables: Object.freeze(lookupAccounts),
    });
    let binding: FirmCashCarryBinding;
    if (request.planKind === 'SOLVER_LOCK' || request.planKind === 'TRADER_ENTRY') {
      const { publicExit: unusedExit, ...entryBinding } = request.binding;
      void unusedExit;
      binding = { ...entryBinding, messageContext };
    } else {
      requireCondition(request.binding.publicExit !== undefined, 'public exit binding is required');
      binding = {
        ...request.binding,
        messageContext,
        publicExit: { ...request.binding.publicExit, messageContext },
      };
    }
    let compiled: ReturnType<typeof compileFirmCashCarryPlan>;
    try {
      compiled = compileFirmCashCarryPlan(request.admission, binding);
    } catch (error) {
      if (error instanceof Error && error.message.includes('encoding overruns Uint8Array')) {
        throw new Error('materialized transaction exceeds the 1232-byte wire limit');
      }
      throw error;
    }
    let plan: SelectedPlan;
    let exit: PublicCashCarryExitPlan | undefined;
    if (request.planKind === 'SOLVER_LOCK') {
      plan = compiled.solverLock;
    } else if (request.planKind === 'TRADER_ENTRY') {
      plan = compiled.traderEntry;
    } else {
      requireCondition(compiled.publicExit.status === 'SUPPORTED', 'public exit plan is unavailable');
      exit = compiled.publicExit;
      if (request.planKind === 'SOLVER_AUTHORIZED_EXIT') {
        requireCondition(exit.authorization.mode === 'SOLVER_AUTHORIZED', 'public exit is not solver-authorized');
      } else {
        requireCondition(exit.authorization.mode === 'TRADER_RECOVERY', 'public exit is not trader recovery');
      }
      plan = exit;
    }
    requireCondition(plan.resolvedAddressCount <= MAX_RESOLVED_ADDRESSES, 'materialized plan exceeds 64 resolved addresses');
    requireCondition(plan.messageSize.status === 'PROVEN', 'materialized plan wire size is unproven');
    requireCondition(plan.messageSize.fitsPacketDataLimit, 'materialized plan exceeds the 1232-byte wire limit');

    const message = new TransactionMessage({
      payerKey: plan.payer,
      recentBlockhash: latest.blockhash,
      instructions: [...plan.instructions],
    }).compileToV0Message(lookupAccounts);
    const usedLookupTables = new Set(message.addressTableLookups.map((lookup) => lookup.accountKey.toBase58()));
    requireCondition(
      usedLookupTables.size === lookupAccounts.length
        && lookupAccounts.every((account) => usedLookupTables.has(account.key.toBase58())),
      'configured lookup-table set does not exactly match the materialized message',
    );
    const messageBytes = message.serialize();
    const transaction = new VersionedTransaction(message);
    requireCondition(transaction.signatures.every((signature) => signature.every((byte) => byte === 0)), 'unsigned transaction contains a signature');
    const transactionBytes = transaction.serialize();
    const resolvedAddressCount = message.staticAccountKeys.length + message.addressTableLookups.reduce(
      (count, lookup) => count + lookup.writableIndexes.length + lookup.readonlyIndexes.length,
      0,
    );
    requireCondition(resolvedAddressCount === plan.resolvedAddressCount, 'materialized resolved-account evidence mismatch');
    requireCondition(resolvedAddressCount <= MAX_RESOLVED_ADDRESSES, 'materialized message exceeds 64 resolved addresses');
    requireCondition(messageBytes.length === plan.messageSize.serializedMessageBytes, 'materialized message-size evidence mismatch');
    requireCondition(transactionBytes.length === plan.messageSize.serializedTransactionBytes, 'materialized transaction-size evidence mismatch');
    requireCondition(transactionBytes.length <= PACKET_DATA_SIZE, 'materialized transaction exceeds the 1232-byte wire limit');

    const hashes = planHashes(request.planKind, request.admission, exit);
    const requiredSignerPubkeys = Object.freeze(
      message.staticAccountKeys.slice(0, message.header.numRequiredSignatures).map((key) => key.toBase58()),
    );
    return Object.freeze({
      domain: this.#config.domain,
      planKind: request.planKind,
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
        computeUnitLimit,
        computeUnitLimitSource: computeUnitLimit === null ? 'NO_COMPUTE_BUDGET_INSTRUCTION' : 'EXPLICIT',
        routeComputeUnitLimit: MAX_ROUTE_COMPUTE_UNITS,
      }),
      requestCommitment: requestCommitment(
        this.#config.environment,
        this.#config.domain,
        request.planKind,
        genesisHash,
        hashes[0],
        hashes[1],
        hashes[2],
        latest.blockhash,
        latest.contextSlot,
        latest.lastValidBlockHeight,
        lookupEvidence,
        messageBytes,
        transactionBytes,
      ),
    });
  }
}
