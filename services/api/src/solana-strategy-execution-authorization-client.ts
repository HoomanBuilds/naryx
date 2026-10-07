import { commitmentHash, fromProtocolJson, toHex, type DomainRef } from '@naryx/protocol-types';
import { PACKET_DATA_SIZE, PublicKey, VersionedTransaction } from '@solana/web3.js';

const MAX_RESPONSE_BYTES = 262_144;
const HASH = /^[0-9a-f]{64}$/;

export interface AuthorizedSolanaStrategyExecution {
  readonly version: 1;
  readonly domain: DomainRef;
  readonly owner: string;
  readonly solver: string;
  readonly transactionBase64: string;
  readonly messageBase64: string;
  readonly requiredSignerPubkeys: readonly string[];
  readonly recentBlockhash: string;
  readonly blockhashContextSlot: number;
  readonly lastValidBlockHeight: number;
  readonly strategyAccount: string;
  readonly position: string;
  readonly receipt: string;
  readonly packageId: string;
  readonly orderHash: string;
  readonly quoteHash: string;
  readonly routeHash: string;
  readonly executionHash: string;
  readonly callsHash: string;
  readonly materializationCommitment: string;
  readonly lookupTables: readonly Readonly<{
    address: string;
    addresses: readonly string[];
    contentCommitment: string;
    contextSlot: number;
  }>[];
  readonly evidence: Readonly<{
    resolvedAddressCount: number;
    serializedMessageBytes: number;
    serializedTransactionBytes: number;
    packetDataLimit: number;
    computeUnitLimit: number;
  }>;
}

export interface SolanaStrategyExecutionAuthorizationPort {
  authorize(quoteHash: string): Promise<AuthorizedSolanaStrategyExecution>;
}

export class SolanaStrategyExecutionAuthorizationClientError extends Error {
  readonly code: 'INVALID_ENDPOINT' | 'INVALID_REQUEST' | 'NOT_FOUND' | 'UPSTREAM_REJECTED' | 'INVALID_RESPONSE';

  constructor(code: SolanaStrategyExecutionAuthorizationClientError['code'], message: string) {
    super(message);
    this.name = 'SolanaStrategyExecutionAuthorizationClientError';
    this.code = code;
  }
}

function fail(message: string): never {
  throw new SolanaStrategyExecutionAuthorizationClientError('INVALID_RESPONSE', message);
}

function loopbackOrigin(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new SolanaStrategyExecutionAuthorizationClientError('INVALID_ENDPOINT', 'authorization endpoint must be an absolute URL');
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || url.hostname.startsWith('127.');
  if (url.protocol !== 'http:' || !loopback || url.username !== '' || url.password !== ''
    || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new SolanaStrategyExecutionAuthorizationClientError('INVALID_ENDPOINT',
      'authorization endpoint must be a loopback HTTP origin');
  }
  return url.origin;
}

function address(value: unknown, context: string): string {
  try {
    const checked = new PublicKey(String(value));
    if (checked.toBase58() !== value) throw new Error();
    return checked.toBase58();
  } catch {
    return fail(`${context} is invalid`);
  }
}

function hash(value: unknown, context: string): string {
  if (typeof value !== 'string' || !HASH.test(value) || /^0{64}$/.test(value)) fail(`${context} is invalid`);
  return value;
}

function base64(value: unknown, context: string): Uint8Array {
  if (typeof value !== 'string' || value.length === 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    return fail(`${context} is invalid`);
  }
  const bytes = Uint8Array.from(Buffer.from(value, 'base64'));
  if (Buffer.from(bytes).toString('base64') !== value) return fail(`${context} is not canonical base64`);
  return bytes;
}

async function responseJson(response: Response): Promise<unknown> {
  if (response.headers.get('content-type')?.split(';', 1)[0]?.trim() !== 'application/json' || response.body === null) {
    throw new SolanaStrategyExecutionAuthorizationClientError('INVALID_RESPONSE', 'authorization response must be JSON');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    length += item.value.length;
    if (length > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new SolanaStrategyExecutionAuthorizationClientError('INVALID_RESPONSE', 'authorization response is too large');
    }
    chunks.push(item.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return fromProtocolJson(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  } catch {
    throw new SolanaStrategyExecutionAuthorizationClientError('INVALID_RESPONSE', 'authorization response is malformed');
  }
}

function authorization(value: unknown, expectedQuoteHash: string): AuthorizedSolanaStrategyExecution {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail('authorization response must be an object');
  const root = value as Record<string, unknown>;
  if (Object.keys(root).sort().join(',') !== 'authorization,version' || root.version !== 1
    || typeof root.authorization !== 'object' || root.authorization === null || Array.isArray(root.authorization)) {
    return fail('authorization response fields are invalid');
  }
  const result = root.authorization as Record<string, unknown>;
  if (result.version !== 1 || typeof result.domain !== 'object' || result.domain === null || Array.isArray(result.domain)
    || !Array.isArray(result.requiredSignerPubkeys) || !Array.isArray(result.lookupTables)
    || typeof result.evidence !== 'object' || result.evidence === null || Array.isArray(result.evidence)
    || !Number.isSafeInteger(result.blockhashContextSlot) || Number(result.blockhashContextSlot) < 0
    || !Number.isSafeInteger(result.lastValidBlockHeight) || Number(result.lastValidBlockHeight) <= 0) {
    return fail('authorization identity fields are invalid');
  }
  const domain = result.domain as Record<string, unknown>;
  if (domain.domainId !== 'svm:devnet' || !Number.isSafeInteger(domain.domainManifestVersion)
    || Number(domain.domainManifestVersion) <= 0 || !(domain.domainManifestHash instanceof Uint8Array)
    || domain.domainManifestHash.length !== 32 || domain.domainManifestHash.every((byte) => byte === 0)) {
    return fail('authorization domain is invalid');
  }
  const owner = address(result.owner, 'authorization owner');
  const solver = address(result.solver, 'authorization solver');
  if (owner === solver) return fail('authorization signer roles collide');
  const requiredSignerPubkeys = result.requiredSignerPubkeys.map((candidate, index) =>
    address(candidate, `required signer ${index}`));
  if (new Set(requiredSignerPubkeys).size !== requiredSignerPubkeys.length
    || !requiredSignerPubkeys.includes(owner) || !requiredSignerPubkeys.includes(solver)) {
    return fail('authorization signer set is invalid');
  }
  const transactionBytes = base64(result.transactionBase64, 'authorization transaction');
  const messageBytes = base64(result.messageBase64, 'authorization message');
  if (transactionBytes.length > PACKET_DATA_SIZE) return fail('authorization transaction exceeds the packet limit');
  let transaction: VersionedTransaction;
  try {
    transaction = VersionedTransaction.deserialize(transactionBytes);
  } catch {
    return fail('authorization transaction cannot be decoded');
  }
  if (!Buffer.from(transaction.message.serialize()).equals(Buffer.from(messageBytes))) {
    return fail('authorization transaction differs from its message');
  }
  const messageSignerPubkeys = transaction.message.staticAccountKeys
    .slice(0, transaction.message.header.numRequiredSignatures)
    .map((candidate) => candidate.toBase58());
  if (messageSignerPubkeys.length !== requiredSignerPubkeys.length
    || messageSignerPubkeys.some((candidate, index) => candidate !== requiredSignerPubkeys[index])) {
    return fail('authorization transaction signer set differs from its evidence');
  }
  const ownerIndex = messageSignerPubkeys.indexOf(owner);
  const solverIndex = messageSignerPubkeys.indexOf(solver);
  if (ownerIndex < 0 || solverIndex < 0
    || transaction.signatures[ownerIndex]?.some((byte) => byte !== 0) === true
    || transaction.signatures[solverIndex]?.some((byte) => byte !== 0) !== true
    || transaction.signatures.some((signature, index) => index !== solverIndex
      && signature.some((byte) => byte !== 0))) {
    return fail('authorization transaction signatures are invalid');
  }
  if (typeof result.recentBlockhash !== 'string'
    || transaction.message.recentBlockhash !== result.recentBlockhash) {
    return fail('authorization recent blockhash is invalid');
  }
  const lookupTables = result.lookupTables.map((value, index) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return fail(`lookup table ${index} is invalid`);
    }
    const table = value as Record<string, unknown>;
    if (!Array.isArray(table.addresses) || !Number.isSafeInteger(table.contextSlot) || Number(table.contextSlot) < 0) {
      return fail(`lookup table ${index} fields are invalid`);
    }
    return Object.freeze({
      address: address(table.address, `lookup table ${index} address`),
      addresses: Object.freeze(table.addresses.map((candidate, addressIndex) =>
        address(candidate, `lookup table ${index} account ${addressIndex}`))),
      contentCommitment: hash(table.contentCommitment, `lookup table ${index} commitment`),
      contextSlot: Number(table.contextSlot),
    });
  });
  const messageLookupTables = transaction.message.addressTableLookups.map((table) => table.accountKey.toBase58());
  if (messageLookupTables.length !== lookupTables.length
    || messageLookupTables.some((candidate, index) => candidate !== lookupTables[index]?.address)) {
    return fail('authorization transaction lookup tables differ from their evidence');
  }
  const evidence = result.evidence as Record<string, unknown>;
  if (!Number.isSafeInteger(evidence.resolvedAddressCount) || Number(evidence.resolvedAddressCount) <= 0
    || evidence.serializedMessageBytes !== messageBytes.length
    || evidence.serializedTransactionBytes !== transactionBytes.length
    || evidence.packetDataLimit !== PACKET_DATA_SIZE
    || !Number.isSafeInteger(evidence.computeUnitLimit) || Number(evidence.computeUnitLimit) <= 0
    || Number(evidence.computeUnitLimit) > 1_260_000) {
    return fail('authorization materialization evidence is invalid');
  }
  const quoteHash = hash(result.quoteHash, 'quote hash');
  if (quoteHash !== expectedQuoteHash) return fail('authorization quote differs from the request');
  return Object.freeze({
    version: 1,
    domain: Object.freeze({
      domainId: 'svm:devnet',
      domainManifestVersion: Number(domain.domainManifestVersion),
      domainManifestHash: Uint8Array.from(domain.domainManifestHash),
    }) as DomainRef,
    owner,
    solver,
    transactionBase64: result.transactionBase64 as string,
    messageBase64: result.messageBase64 as string,
    requiredSignerPubkeys: Object.freeze(requiredSignerPubkeys),
    recentBlockhash: result.recentBlockhash,
    blockhashContextSlot: Number(result.blockhashContextSlot),
    lastValidBlockHeight: Number(result.lastValidBlockHeight),
    strategyAccount: address(result.strategyAccount, 'strategy account'),
    position: address(result.position, 'strategy position'),
    receipt: address(result.receipt, 'strategy receipt'),
    packageId: hash(result.packageId, 'package ID'),
    orderHash: hash(result.orderHash, 'order hash'),
    quoteHash,
    routeHash: hash(result.routeHash, 'route hash'),
    executionHash: hash(result.executionHash, 'execution hash'),
    callsHash: hash(result.callsHash, 'calls hash'),
    materializationCommitment: hash(result.materializationCommitment, 'materialization commitment'),
    lookupTables: Object.freeze(lookupTables),
    evidence: Object.freeze({
      resolvedAddressCount: Number(evidence.resolvedAddressCount),
      serializedMessageBytes: messageBytes.length,
      serializedTransactionBytes: transactionBytes.length,
      packetDataLimit: PACKET_DATA_SIZE,
      computeUnitLimit: Number(evidence.computeUnitLimit),
    }),
  });
}

export class HttpSolanaStrategyExecutionAuthorizationClient implements SolanaStrategyExecutionAuthorizationPort {
  readonly #origin: string;
  readonly #fetch: typeof fetch;

  constructor(endpoint: string, fetchImplementation: typeof fetch = fetch) {
    this.#origin = loopbackOrigin(endpoint);
    this.#fetch = fetchImplementation;
  }

  async authorize(quoteHashValue: string): Promise<AuthorizedSolanaStrategyExecution> {
    let normalized: string;
    try {
      normalized = toHex(commitmentHash(quoteHashValue, 'quoteHash'));
    } catch {
      throw new SolanaStrategyExecutionAuthorizationClientError('INVALID_REQUEST',
        'quoteHash must be 32 bytes of lowercase hex');
    }
    if (normalized !== quoteHashValue) {
      throw new SolanaStrategyExecutionAuthorizationClientError('INVALID_REQUEST', 'quoteHash must be lowercase hex');
    }
    const response = await this.#fetch(`${this.#origin}/internal/strategy-executions/authorize-solana`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quoteHash: quoteHashValue }),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 404) {
      throw new SolanaStrategyExecutionAuthorizationClientError('NOT_FOUND', 'Strategy package was not found');
    }
    if (!response.ok) {
      throw new SolanaStrategyExecutionAuthorizationClientError('UPSTREAM_REJECTED',
        `authorization failed with HTTP ${response.status}`);
    }
    return authorization(await responseJson(response), quoteHashValue);
  }
}
