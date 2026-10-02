import { createPublicKey, verify } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isAbsolute } from 'node:path';
import {
  NARYX_TEST_PERP_MARKET_ABI,
  PACKAGE_VERIFIER_ACCOUNT_ABI,
  equalAddress,
  equalHash,
  packageVerifierOpenPackage,
  prepareEvmSolverAuthorization,
  prepareEvmTraderPermitAuthorization,
  requiredEvmAddress,
  type EvmAtomicAuthorizationBounds,
} from '@naryx/adapter-evm';
import {
  bytesEqual,
  fromProtocolJson,
  solverSignatureDigest,
  toHex,
  validatePackageAdmission,
  type Hash32,
  type PackageOrderInput,
  type RoutePayloadInput,
  type SolverQuoteInput,
} from '@naryx/protocol-types';
import { recoverAddress, type Abi, type Address, type Hex, type LocalAccount } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { AtomicQuoteNonceSource } from './configured-atomic-market.js';
import type { QuoteProviders } from './hyperliquid-testnet-quote-runtime.js';
import {
  BASE_SEPOLIA_QUOTE_ENABLED_ENV,
  createViemBaseSepoliaReadPort,
  loadBaseSepoliaQuoteRuntime,
  loadBaseSepoliaSolverDeployment,
  readBaseSepoliaAccountOf,
  requireBaseSepoliaChain,
  type BaseSepoliaReadPort,
  type BaseSepoliaSolverDeployment,
} from './base-sepolia-quote-runtime.js';

export const BASE_SEPOLIA_SOLVER_AUTHORIZATION_PATH = '/internal/base-sepolia/solver-authorizations';

const ATTEMPT_ID = /^base-atomic-[0-9a-f]{52}$/;
const HASH_HEX = /^0x[0-9a-f]{64}$/;
const SIGNATURE = /^0x[0-9a-f]{130}$/i;
const DECIMAL = /^-?(?:0|[1-9][0-9]{0,77})$/;
const PRIVATE_KEY = /^0x[0-9a-f]{64}$/;
const MAX_BODY_BYTES = 4_096;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export class BaseSepoliaSolverAuthorizationError extends Error {
  readonly code: 'INVALID_REQUEST' | 'ATTEMPT_NOT_FOUND' | 'NOT_AUTHORIZED';

  constructor(code: BaseSepoliaSolverAuthorizationError['code'], message: string) {
    super(message);
    this.name = 'BaseSepoliaSolverAuthorizationError';
    this.code = code;
  }
}

function fail(code: BaseSepoliaSolverAuthorizationError['code'], message: string): never {
  throw new BaseSepoliaSolverAuthorizationError(code, message);
}

export type SelectedBaseSepoliaAttempt = Readonly<{
  order: unknown;
  route: unknown;
  quote: unknown;
}>;

export type SelectedBaseSepoliaAttemptProvider = (attemptId: string) => Promise<SelectedBaseSepoliaAttempt | undefined>;

export interface BaseSepoliaSolverAuthorizationOptions {
  readonly deployment: BaseSepoliaSolverDeployment;
  readonly chain: BaseSepoliaReadPort;
  readonly attempts: SelectedBaseSepoliaAttemptProvider;
  /** The Ed25519 key the quote coordinator signs with: only its own quotes are co-signed. */
  readonly quoteVerificationKey: Uint8Array;
  readonly solver: LocalAccount;
}

function hashBytes(value: unknown, name: string): Hash32 {
  if (typeof value !== 'string' || !HASH_HEX.test(value)) fail('INVALID_REQUEST', `${name} must be a 0x 32-byte hash`);
  return Uint8Array.from(Buffer.from(value.slice(2), 'hex')) as Hash32;
}

function integer(value: unknown, name: string): bigint {
  if (typeof value !== 'string' || !DECIMAL.test(value)) fail('INVALID_REQUEST', `${name} must be a decimal string`);
  return BigInt(value);
}

/** The inverse of the API's wire form; every field is required and nothing else is accepted. */
export function parseBaseSepoliaAuthorizationBounds(value: unknown): EvmAtomicAuthorizationBounds {
  const record = value as Record<string, unknown> | null;
  const keys = [
    'currentUnixSeconds', 'expectedPrePerpBalanceWad', 'expectedPrePerpEntryNotionalWad',
    'maximumPostPerpBalanceWad', 'maximumPostPerpEntryNotionalWad', 'minimumPostPerpBalanceWad',
    'packageNonce', 'perpArgs', 'perpExpiry', 'solver', 'spotFillCommitment', 'strategyAccount',
  ];
  if (typeof record !== 'object' || record === null || Object.keys(record).sort().join(',') !== keys.join(',')
    || !Array.isArray(record.perpArgs) || record.perpArgs.length !== 2
    || !Number.isSafeInteger(record.perpExpiry)) {
    fail('INVALID_REQUEST', 'bounds are malformed');
  }
  let strategyAccount;
  let solver;
  try {
    strategyAccount = requiredEvmAddress(record.strategyAccount, 'bounds.strategyAccount');
    solver = requiredEvmAddress(record.solver, 'bounds.solver');
  } catch {
    fail('INVALID_REQUEST', 'bounds addresses are invalid');
  }
  return Object.freeze({
    currentUnixSeconds: integer(record.currentUnixSeconds, 'currentUnixSeconds'),
    strategyAccount,
    solver,
    spotFillCommitment: hashBytes(record.spotFillCommitment, 'spotFillCommitment'),
    packageNonce: integer(record.packageNonce, 'packageNonce'),
    expectedPrePerpEntryNotionalWad: integer(record.expectedPrePerpEntryNotionalWad, 'expectedPrePerpEntryNotionalWad'),
    expectedPrePerpBalanceWad: integer(record.expectedPrePerpBalanceWad, 'expectedPrePerpBalanceWad'),
    minimumPostPerpBalanceWad: integer(record.minimumPostPerpBalanceWad, 'minimumPostPerpBalanceWad'),
    maximumPostPerpBalanceWad: integer(record.maximumPostPerpBalanceWad, 'maximumPostPerpBalanceWad'),
    maximumPostPerpEntryNotionalWad: integer(record.maximumPostPerpEntryNotionalWad, 'maximumPostPerpEntryNotionalWad'),
    perpExpiry: record.perpExpiry as number,
    perpArgs: Object.freeze([
      hashBytes(record.perpArgs[0], 'perpArgs[0]'),
      hashBytes(record.perpArgs[1], 'perpArgs[1]'),
    ] as const),
  });
}

function verifyOwnQuote(quote: { solverVerificationKey: Uint8Array; signature: Uint8Array }, digest: Uint8Array, key: Uint8Array): boolean {
  if (!bytesEqual(quote.solverVerificationKey, key) || quote.signature.length !== 64) return false;
  try {
    const publicKey = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(key)]),
      format: 'der',
      type: 'spki',
    });
    return verify(null, Buffer.from(digest), publicKey, Buffer.from(quote.signature));
  } catch {
    return false;
  }
}

/**
 * The account state the signed bounds must equal on chain: the verifier's next package nonce and,
 * for an exit, the exact open package record and short it closes, ending flat with no balance.
 */
async function requireAccountState(
  chain: BaseSepoliaReadPort,
  deployment: BaseSepoliaSolverDeployment['deployment'],
  order: Readonly<{ action: string; quantity: { atoms: bigint }; entryReceiptHash?: Uint8Array }>,
  bounds: EvmAtomicAuthorizationBounds,
): Promise<void> {
  const verifier = requiredEvmAddress(deployment.packageVerifier.address, 'packageVerifier');
  const read = (address: Address, abi: Abi, functionName: string, args: readonly unknown[]) =>
    chain.readContract({ address, abi, functionName, args });
  const [nonce, openRecord] = await Promise.all([
    read(verifier, PACKAGE_VERIFIER_ACCOUNT_ABI as Abi, 'nextNonce', [bounds.strategyAccount]),
    read(verifier, PACKAGE_VERIFIER_ACCOUNT_ABI as Abi, 'openPackage', [bounds.strategyAccount]),
  ]);
  if (nonce !== bounds.packageNonce) fail('NOT_AUTHORIZED', "bounds nonce is not the account's next package nonce");
  let open;
  try {
    open = packageVerifierOpenPackage(openRecord);
  } catch {
    fail('NOT_AUTHORIZED', 'open package read is malformed');
  }
  if (order.action !== 'EXIT') return;
  const quantity = order.quantity.atoms;
  if (open === null || order.entryReceiptHash === undefined
    || !equalHash(open.entryReceiptHash, `0x${toHex(order.entryReceiptHash)}`)
    || open.baseQuantityAtoms !== quantity || open.perpQuantityWad !== quantity
    || open.entryPerpNotionalWad !== bounds.expectedPrePerpEntryNotionalWad) {
    fail('NOT_AUTHORIZED', 'exit bounds do not match the open package record');
  }
  const market = requiredEvmAddress(deployment.perpetual.market.address, 'perpetual.market');
  const position = await read(market, NARYX_TEST_PERP_MARKET_ABI as Abi, 'getPosition', [market, bounds.perpExpiry, bounds.strategyAccount]) as
    Record<string, unknown> | undefined;
  if (position?.size !== -quantity || position.balance !== bounds.expectedPrePerpBalanceWad
    || bounds.minimumPostPerpBalanceWad !== 0n || bounds.maximumPostPerpBalanceWad !== 0n
    || bounds.maximumPostPerpEntryNotionalWad !== 0n) {
    fail('NOT_AUTHORIZED', 'exit bounds do not close the exact open short');
  }
}

/**
 * Co-signs the PackageVerifier SolverAuthorization for one selected Base attempt. The solver
 * re-derives everything it signs: it fetches the selected order, route, and quote itself, admits
 * them against the reviewed manifest at chain time, requires its own quote signature, the owner's
 * factory account, and an owner trader signature over the same bounds, and only then signs.
 */
export function createBaseSepoliaSolverAuthorization(options: BaseSepoliaSolverAuthorizationOptions) {
  const solverAddress = requiredEvmAddress(options.solver.address, 'solver');
  if (!equalAddress(solverAddress, requiredEvmAddress(options.deployment.executionPolicy.solver, 'executionPolicy.solver'))) {
    throw new Error('Base Sepolia solver key is not the manifest execution solver');
  }
  if (!(options.quoteVerificationKey instanceof Uint8Array) || options.quoteVerificationKey.length !== 32) {
    throw new Error('Base Sepolia quote verification key must be 32 bytes');
  }
  return async (request: unknown): Promise<Readonly<{ version: 1; attemptId: string; solverSignature: Hex; digest: Hex }>> => {
    const body = request as Record<string, unknown> | null;
    if (typeof body !== 'object' || body === null
      || Object.keys(body).sort().join(',') !== 'attemptId,bounds,traderSignature,version'
      || body.version !== 1 || typeof body.attemptId !== 'string' || !ATTEMPT_ID.test(body.attemptId)
      || typeof body.traderSignature !== 'string' || !SIGNATURE.test(body.traderSignature)) {
      fail('INVALID_REQUEST', 'authorization request is malformed');
    }
    const attemptId = body.attemptId;
    const traderSignature = body.traderSignature as Hex;
    const bounds = parseBaseSepoliaAuthorizationBounds(body.bounds);
    if (!equalAddress(bounds.solver, solverAddress)) fail('NOT_AUTHORIZED', 'bounds name a different solver');
    const selected = await options.attempts(attemptId);
    if (selected === undefined) fail('ATTEMPT_NOT_FOUND', 'selected Base attempt was not found');
    await requireBaseSepoliaChain(options.chain);
    const now = await options.chain.latestBlockTimestamp();
    let admission;
    try {
      admission = validatePackageAdmission({
        ...options.deployment.admission,
        order: fromProtocolJson(selected.order, 'selected.order') as PackageOrderInput,
        route: fromProtocolJson(selected.route, 'selected.route') as RoutePayloadInput,
        quote: fromProtocolJson(selected.quote, 'selected.quote') as SolverQuoteInput,
        currentTime: { unit: 'EVM_UNIX_SECONDS', value: now },
      });
    } catch {
      fail('NOT_AUTHORIZED', 'selected attempt failed admission at chain time');
    }
    if (!verifyOwnQuote(admission.quote, solverSignatureDigest(admission.quote), options.quoteVerificationKey)) {
      fail('NOT_AUTHORIZED', 'selected quote was not signed by this solver');
    }
    const account = await readBaseSepoliaAccountOf(options.chain, options.deployment.deployment, admission.order.owner);
    if (!equalAddress(account, bounds.strategyAccount)) {
      fail('NOT_AUTHORIZED', 'bounds strategy account is not the owner factory account');
    }
    const deployment = options.deployment.deployment;
    await requireAccountState(options.chain, deployment, admission.order, bounds);
    const series = options.deployment.seriesBindingInput;
    let traderDigest: Hex;
    let solverDigest: Hex;
    try {
      traderDigest = prepareEvmTraderPermitAuthorization(admission, deployment, series, bounds).digest;
      solverDigest = prepareEvmSolverAuthorization(admission, deployment, series, bounds).digest;
    } catch (error) {
      fail('NOT_AUTHORIZED', error instanceof Error ? error.message : 'execution is not admissible');
    }
    const trader = await recoverAddress({ hash: traderDigest, signature: traderSignature });
    if (!equalAddress(trader, requiredEvmAddress(admission.order.owner, 'order.owner'))) {
      fail('NOT_AUTHORIZED', 'trader signature does not recover to the order owner');
    }
    const solverSignature = await options.solver.sign!({ hash: solverDigest });
    return Object.freeze({ version: 1 as const, attemptId, solverSignature, digest: solverDigest });
  };
}

export function httpSelectedBaseSepoliaAttempts(
  apiOrigin: string,
  fetchImplementation: typeof fetch = fetch,
): SelectedBaseSepoliaAttemptProvider {
  const origin = new URL(apiOrigin).origin;
  return async (attemptId) => {
    if (!ATTEMPT_ID.test(attemptId)) fail('INVALID_REQUEST', 'attemptId is invalid');
    const response = await fetchImplementation(`${origin}/internal/solver/attempts/${attemptId}`, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(5_000),
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`selected attempt endpoint returned HTTP ${response.status}`);
    const value = await response.json() as Record<string, unknown>;
    if (value?.version !== 1 || value.attemptId !== attemptId) fail('NOT_AUTHORIZED', 'selected attempt response is invalid');
    return Object.freeze({ order: value.order, route: value.route, quote: value.quote });
  };
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) fail('INVALID_REQUEST', 'request body is too large');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    fail('INVALID_REQUEST', 'request body must be JSON');
  }
}

export function createBaseSepoliaSolverAuthorizationServer(
  authorize: ReturnType<typeof createBaseSepoliaSolverAuthorization>,
): Server {
  return createServer((request, response) => {
    if (request.url !== BASE_SEPOLIA_SOLVER_AUTHORIZATION_PATH || request.method !== 'POST') {
      send(response, 404, { error: { code: 'NOT_FOUND' } });
      return;
    }
    void readBody(request).then(authorize).then(
      (result) => send(response, 200, result),
      (error: unknown) => {
        if (error instanceof BaseSepoliaSolverAuthorizationError) {
          send(response, error.code === 'ATTEMPT_NOT_FOUND' ? 404 : error.code === 'INVALID_REQUEST' ? 400 : 409, {
            error: { code: error.code, message: error.message },
          });
          return;
        }
        send(response, 502, { error: { code: 'AUTHORIZATION_FAILED' } });
      },
    );
  });
}

/** A testnet-only secp256k1 key from an owner-only file outside the repository. */
export function loadBaseSepoliaSolverKey(path: string | undefined, expectedAddress: string | undefined): LocalAccount {
  if (path === undefined || !isAbsolute(path)) throw new Error('NARYX_BASE_SEPOLIA_SOLVER_KEY_PATH must be an absolute path');
  const status = lstatSync(path);
  if (status.isSymbolicLink() || !status.isFile() || realpathSync(path) !== path
    || (status.mode & 0o077) !== 0 || status.size < 1 || status.size > 512
    || (typeof process.getuid === 'function' && status.uid !== process.getuid())) {
    throw new Error('Base Sepolia solver key must be a canonical owner-only regular file');
  }
  const record = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'environment,privateKey,version' || record.version !== 1
    || record.environment !== 'BASE_SEPOLIA' || typeof record.privateKey !== 'string'
    || !PRIVATE_KEY.test(record.privateKey) || /^0x0+$/.test(record.privateKey)) {
    throw new Error('Base Sepolia solver key file fields are invalid');
  }
  const account = privateKeyToAccount(record.privateKey as Hex);
  if (expectedAddress === undefined || account.address.toLowerCase() !== expectedAddress.toLowerCase()) {
    throw new Error('Base Sepolia solver key does not match NARYX_BASE_SEPOLIA_SOLVER_ADDRESS');
  }
  return account;
}

export type BaseSepoliaSolverRuntime = Readonly<{
  providers: QuoteProviders;
  listen(host: string): Promise<number>;
  close(): Promise<void>;
}>;

/**
 * Disabled unless `NARYX_BASE_SEPOLIA_QUOTE_ENABLED=true`. When enabled it needs the shared runtime
 * manifest, the quote config, a Base Sepolia RPC whose eth_chainId is 84532, and the solver key.
 */
export async function loadBaseSepoliaSolverRuntime(
  env: NodeJS.ProcessEnv,
  dependencies: Readonly<{
    nonceSource: AtomicQuoteNonceSource;
    quoteVerificationKey: Uint8Array;
    apiOrigin: string;
    reservedPorts: readonly number[];
  }>,
): Promise<BaseSepoliaSolverRuntime | undefined> {
  const enabled = env[BASE_SEPOLIA_QUOTE_ENABLED_ENV];
  if (enabled === undefined || enabled === 'false') return undefined;
  if (enabled !== 'true') throw new Error(`${BASE_SEPOLIA_QUOTE_ENABLED_ENV} must be true or false`);
  const deployment = loadBaseSepoliaSolverDeployment(env.NARYX_BASE_SEPOLIA_RUNTIME_MANIFEST);
  const chain = createViemBaseSepoliaReadPort(env.NARYX_BASE_SEPOLIA_RPC_URL ?? '');
  await requireBaseSepoliaChain(chain);
  const providers = loadBaseSepoliaQuoteRuntime(env, { nonceSource: dependencies.nonceSource, deployment, chain });
  const port = Number(env.NARYX_BASE_SEPOLIA_SOLVER_AUTHORIZATION_PORT ?? '8794');
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535 || dependencies.reservedPorts.includes(port)) {
    throw new Error('NARYX_BASE_SEPOLIA_SOLVER_AUTHORIZATION_PORT must be a free TCP port');
  }
  const server = createBaseSepoliaSolverAuthorizationServer(createBaseSepoliaSolverAuthorization({
    deployment,
    chain,
    attempts: httpSelectedBaseSepoliaAttempts(dependencies.apiOrigin),
    quoteVerificationKey: dependencies.quoteVerificationKey,
    solver: loadBaseSepoliaSolverKey(env.NARYX_BASE_SEPOLIA_SOLVER_KEY_PATH, env.NARYX_BASE_SEPOLIA_SOLVER_ADDRESS),
  }));
  return Object.freeze({
    providers,
    listen: (host: string) => new Promise<number>((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolveListen(port);
      });
    }),
    close: () => new Promise<void>((resolveClose, reject) => {
      if (!server.listening) {
        resolveClose();
        return;
      }
      server.close((error) => error === undefined ? resolveClose() : reject(error));
    }),
  });
}
