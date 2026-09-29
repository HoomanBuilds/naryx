import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import anchor, { type Idl } from '@coral-xyz/anchor';
import {
  Connection,
  Ed25519Program,
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  bytesEqual,
  type DomainRef,
  type PackageAdmission,
} from '@naryx/protocol-types';
import type {
  CompiledExecution,
  ExecutionAdapter,
  ExecutionEvidence,
  SimulationEvidence,
} from '@naryx/adapter-core';

export * from './firm-plan.js';
export * from './materializer.js';
export * from './public-exit-plan.js';
export * from './cash-carry-accounts.js';
export * from './deployment-identity.js';
export * from './mainnet-shadow.js';

const U64_MAX = (1n << 64n) - 1n;
const EXECUTION_DIGEST_DOMAIN = 'NARYX/conformance-execution/v1';
const { BorshCoder, BN } = anchor;
const ACCOUNT_BINDING_IDS = {
  trader: 'trader',
  solver: 'solver',
  market: 'market',
  position: 'position',
  trader_base: 'trader-base',
  trader_quote: 'trader-quote',
  spot_base_vault: 'spot-base-vault',
  spot_quote_vault: 'spot-quote-vault',
  perp_quote_vault: 'perp-quote-vault',
  conformance_program: 'conformance-program',
  entry_receipt: 'entry-receipt',
} as const;

const BASE_BINDINGS: ReadonlySet<string> = new Set(
  Object.values(ACCOUNT_BINDING_IDS).filter((value) => value !== ACCOUNT_BINDING_IDS.entry_receipt),
);

export interface ConformanceReceipt {
  readonly address: PublicKey;
  readonly domain: DomainRef;
  readonly trader: PublicKey;
  readonly solver: PublicKey;
  readonly orderHash: Uint8Array;
  readonly quoteHash: Uint8Array;
  readonly routeHash: Uint8Array;
  readonly action: 'ENTRY' | 'EXIT';
  readonly nonce: bigint;
  readonly executionDigest: Uint8Array;
  readonly baseQuantityAtoms: bigint;
  readonly preBaseBalance: bigint;
  readonly postBaseBalance: bigint;
  readonly preQuoteBalance: bigint;
  readonly postQuoteBalance: bigint;
  readonly preShortBaseAtoms: bigint;
  readonly postShortBaseAtoms: bigint;
  readonly preCollateralQuoteAtoms: bigint;
  readonly postCollateralQuoteAtoms: bigint;
  readonly executionSlot: bigint;
}

export interface ConformancePosition {
  readonly market: PublicKey;
  readonly trader: PublicKey;
  readonly shortBaseAtoms: bigint;
  readonly collateralQuoteAtoms: bigint;
}

export interface AuthenticatedConformanceExecution {
  readonly instructions: readonly TransactionInstruction[];
  readonly executionDigest: Uint8Array;
  readonly coreInstruction: TransactionInstruction;
}

export interface ConformanceExecutionAuthorizationPayload {
  readonly executionDigest: Uint8Array;
  readonly programId: string;
  readonly solver: string;
  readonly nonce: bigint;
  readonly expirySlot: bigint;
}

export type ConformanceExecutionSignatureProvider = (
  executionDigest: Uint8Array,
  admission: PackageAdmission,
) => Uint8Array | Promise<Uint8Array>;

export interface SolanaConformanceAdapterOptions {
  readonly connection: Connection;
  readonly domain: DomainRef;
  readonly environment: 'local' | 'devnet' | 'testnet';
  readonly expectedGenesisHash: string;
  readonly executionSignatureProvider: ConformanceExecutionSignatureProvider;
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function checkedU64(value: bigint, name: string): InstanceType<typeof BN> {
  requireCondition(typeof value === 'bigint' && value >= 0n && value <= U64_MAX, `${name} must fit u64`);
  return new BN(value.toString());
}

function bigEndian(value: bigint, bytes: number): Uint8Array {
  checkedU64(value, 'execution digest integer');
  const output = new Uint8Array(bytes);
  let remaining = value;
  for (let index = bytes - 1; index >= 0; index -= 1) {
    output[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  requireCondition(remaining === 0n, 'execution digest integer is out of range');
  return output;
}

function domainBytes(domain: DomainRef): Uint8Array {
  const domainId = Buffer.from(domain.domainId, 'utf8');
  requireCondition(domainId.length > 0 && domainId.length <= 128 && /^[\x00-\x7f]+$/.test(domain.domainId), 'domain id is invalid');
  return Buffer.concat([
    Buffer.from(bigEndian(BigInt(domainId.length), 4)),
    domainId,
    Buffer.from(bigEndian(BigInt(domain.domainManifestVersion), 4)),
    Buffer.from(domain.domainManifestHash),
  ]);
}

function conformanceExecutionDigest(
  domain: DomainRef,
  hashes: readonly Uint8Array[],
  action: 1 | 2,
  values: readonly bigint[],
  entryExecutionDigest: Uint8Array,
  expectedPreValues: readonly bigint[],
  accountKeys: readonly PublicKey[],
): Uint8Array {
  const digest = createHash('sha256');
  digest.update(Buffer.from(EXECUTION_DIGEST_DOMAIN, 'ascii'));
  digest.update(domainBytes(domain));
  for (const hash of hashes) digest.update(hash);
  digest.update(Uint8Array.of(action));
  for (const value of values) digest.update(bigEndian(value, 8));
  digest.update(entryExecutionDigest);
  for (const value of expectedPreValues) digest.update(bigEndian(value, 8));
  for (const key of accountKeys) digest.update(key.toBytes());
  return new Uint8Array(digest.digest());
}

function requiredPubkey(value: string, name: string): PublicKey {
  try {
    return new PublicKey(value);
  } catch {
    throw new Error(`${name} must be a Solana public key`);
  }
}

function loadIdl(name: string): Idl {
  let directory = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const path = join(directory, 'deployments', 'solana', 'conformance', 'idl', name);
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8')) as Idl;
    const parent = dirname(directory);
    requireCondition(parent !== directory, `published IDL ${name} was not found`);
    directory = parent;
  }
}

function sameDomain(left: DomainRef, right: DomainRef): boolean {
  return left.domainId === right.domainId
    && left.domainManifestVersion === right.domainManifestVersion
    && bytesEqual(left.domainManifestHash, right.domainManifestHash);
}

function equalHash(actual: Uint8Array, expected: Uint8Array, name: string): void {
  requireCondition(bytesEqual(actual, expected), `${name} mismatch`);
}

function hashBytes(value: Uint8Array, name: string): number[] {
  requireCondition(value.length === 32 && value.some((byte) => byte !== 0), `${name} must be a nonzero hash`);
  return Array.from(value);
}

function rawBigInt(value: InstanceType<typeof BN>, name: string): bigint {
  const converted = BigInt(value.toString());
  checkedU64(converted, name);
  return converted;
}

function rawHash(value: Uint8Array | number[], name: string): Uint8Array {
  requireCondition((Array.isArray(value) || value instanceof Uint8Array) && value.length === 32, `${name} must be a 32-byte hash`);
  const bytes = Uint8Array.from(value);
  hashBytes(bytes, name);
  return bytes;
}

function rawDomain(value: unknown): DomainRef {
  requireCondition(typeof value === 'object' && value !== null, 'receipt domain is invalid');
  const decoded = value as Record<string, unknown>;
  requireCondition(typeof decoded.domain_id === 'string' && decoded.domain_id.length > 0, 'receipt domain id is invalid');
  requireCondition(typeof decoded.domain_manifest_version === 'number' && Number.isInteger(decoded.domain_manifest_version) && decoded.domain_manifest_version > 0, 'receipt domain version is invalid');
  return Object.freeze({
    domainId: decoded.domain_id,
    domainManifestVersion: decoded.domain_manifest_version,
    domainManifestHash: rawHash(decoded.domain_manifest_hash as Uint8Array, 'receipt domain hash'),
  }) as DomainRef;
}

interface CompiledConformanceCore {
  readonly admission: PackageAdmission;
  readonly coreInstruction: TransactionInstruction;
  readonly executionDigest: Uint8Array;
  readonly solver: PublicKey;
}

export class SolanaConformanceAdapter implements ExecutionAdapter<AuthenticatedConformanceExecution, ConformanceReceipt> {
  readonly #connection: Connection;
  readonly #domain: DomainRef;
  readonly #environment: 'local' | 'devnet' | 'testnet';
  readonly #expectedGenesisHash: string;
  readonly #executionSignatureProvider: ConformanceExecutionSignatureProvider;
  readonly #coreIdl = loadIdl('naryx_core.json');
  readonly #venueIdl = loadIdl('naryx_conformance_venue.json');
  readonly #coder = new BorshCoder(this.#coreIdl);
  readonly #programId = requiredPubkey(this.#coreIdl.address, 'core IDL address');
  readonly #venueProgramId = requiredPubkey(this.#venueIdl.address, 'venue IDL address');

  constructor(options: SolanaConformanceAdapterOptions) {
    requireCondition(options.domain.domainId.startsWith('svm:'), 'domain must use the SVM namespace');
    requireCondition(options.expectedGenesisHash.length > 0, 'expected genesis hash is required');
    requireCondition(typeof options.executionSignatureProvider === 'function', 'execution signature provider is required');
    this.#connection = options.connection;
    this.#domain = options.domain;
    this.#environment = options.environment;
    this.#expectedGenesisHash = options.expectedGenesisHash;
    this.#executionSignatureProvider = options.executionSignatureProvider;
    requireCondition(
      this.#coreIdl.instructions.some((instruction) => instruction.name === 'execute_conformance_atomic'),
      'published core IDL does not include conformance execution',
    );
  }

  configAddress(): PublicKey {
    return PublicKey.findProgramAddressSync([Buffer.from('naryx-protocol-config')], this.#programId)[0];
  }

  solverRegistryAddress(): PublicKey {
    return PublicKey.findProgramAddressSync([Buffer.from('conformance-solver')], this.#programId)[0];
  }

  nonceMarkerAddress(trader: PublicKey, nonce: bigint): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from('conformance-nonce'), trader.toBuffer(), Buffer.from(bigEndian(nonce, 8))],
      this.#programId,
    )[0];
  }

  receiptAddress(trader: PublicKey, orderHash: Uint8Array): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from('conformance-receipt'), trader.toBuffer(), Buffer.from(hashBytes(orderHash, 'orderHash'))],
      this.#programId,
    )[0];
  }

  async compile(admission: PackageAdmission): Promise<CompiledExecution<AuthenticatedConformanceExecution>> {
    const compiled = this.#compileCore(admission);
    const signature = await this.#executionSignatureProvider(Uint8Array.from(compiled.executionDigest), admission);
    return this.#authenticatedPlan(compiled, signature);
  }

  async compileAuthenticated(
    admission: PackageAdmission,
    solverSignature: Uint8Array,
  ): Promise<CompiledExecution<AuthenticatedConformanceExecution>> {
    return this.#authenticatedPlan(this.#compileCore(admission), solverSignature);
  }

  compileAuthorizationPayload(
    admission: PackageAdmission,
  ): ConformanceExecutionAuthorizationPayload {
    const compiled = this.#compileCore(admission);
    const expirySlot = [
      admission.order.expiryValue,
      admission.quote.validUntilValue,
      admission.route.routeExpiryValue,
    ].reduce((left, right) => left < right ? left : right);
    return Object.freeze({
      executionDigest: Uint8Array.from(compiled.executionDigest),
      programId: compiled.coreInstruction.programId.toBase58(),
      solver: compiled.solver.toBase58(),
      nonce: admission.order.nonce,
      expirySlot,
    });
  }

  #compileCore(admission: PackageAdmission): CompiledConformanceCore {
    const { order, quote, route } = admission;
    requireCondition(order.environment === this.#environment, 'order environment is unsupported');
    requireCondition(quote.environment === this.#environment && route.environment === this.#environment, 'package environment mismatch');
    requireCondition(sameDomain(order.domain, this.#domain) && sameDomain(quote.domain, this.#domain) && sameDomain(route.domain, this.#domain), 'domain is unsupported');
    requireCondition(order.templateId === 'cash-and-carry-v1' && route.templateId === order.templateId, 'template is unsupported');
    requireCondition(order.direction === 'LONG_SPOT_SHORT_PERP' && route.direction === order.direction, 'direction is unsupported');
    requireCondition(order.settlementClass === 'ATOMIC_POSTCONDITION' && route.settlementClass === order.settlementClass, 'settlement class is unsupported');
    requireCondition(route.executionPlanKind === 'SVM_ATOMIC_CPI', 'execution plan is unsupported');
    requireCondition(order.action === route.action && (order.action === 'ENTRY' || order.action === 'EXIT'), 'action is unsupported');
    requireCondition(order.expiryUnit === 'SOLANA_SLOT' && quote.validUntilUnit === 'SOLANA_SLOT' && route.routeExpiryUnit === 'SOLANA_SLOT', 'expiry clock is unsupported');
    requireCondition(order.partialFillPolicy === 'EXACT_ALL_LEGS' && route.partialFillPolicy === 'EXACT_ALL_LEGS', 'partial fills are unsupported');
    requireCondition(order.quantity.atoms === quote.expectedGrossSpotQuantity.atoms, 'quantity mismatch');
    requireCondition(route.legs.length === 2 && route.legs.every((leg) => leg.quantity.atoms === order.quantity.atoms), 'route legs are unsupported');
    requireCondition(route.legs[0]?.legRole === 'SPOT' && route.legs[1]?.legRole === 'PERPETUAL', 'route leg roles are unsupported');
    requireCondition(route.legs[0]?.side === (order.action === 'ENTRY' ? 'BUY' : 'SELL'), 'spot side mismatch');
    requireCondition(route.legs[1]?.side === (order.action === 'ENTRY' ? 'SELL' : 'BUY'), 'perpetual side mismatch');
    requireCondition(route.serviceCharges.length === 0 && quote.protocolFee.atoms === 0n && quote.solverFee.atoms === 0n, 'this conformance program does not collect service charges');
    requireCondition(order.nonce > 0n, 'nonce must be nonzero');
    equalHash(route.orderHash, admission.orderHash, 'route order hash');
    equalHash(quote.orderHash, admission.orderHash, 'quote order hash');
    equalHash(quote.routeHash, admission.routeHash, 'quote route hash');

    const requiredBindings = order.action === 'EXIT'
      ? new Set(Object.values(ACCOUNT_BINDING_IDS))
      : BASE_BINDINGS;
    const bindings = new Map<string, PublicKey>();
    for (const binding of route.accountBindings) {
      requireCondition(requiredBindings.has(binding.routeBindingId), `unsupported route binding ${binding.routeBindingId}`);
      requireCondition(!bindings.has(binding.routeBindingId), `duplicate route binding ${binding.routeBindingId}`);
      bindings.set(binding.routeBindingId, requiredPubkey(binding.accountIdentity, binding.routeBindingId));
    }
    for (const bindingId of requiredBindings) requireCondition(bindings.has(bindingId), `missing route binding ${bindingId}`);
    const trader = bindings.get('trader')!;
    const solver = bindings.get('solver')!;
    requireCondition(trader.equals(requiredPubkey(order.owner, 'order owner')), 'trader binding does not match order owner');
    requireCondition(solver.equals(requiredPubkey(route.solver, 'route solver')), 'solver binding does not match route solver');
    requireCondition(quote.solverSignatureScheme === 'ED25519', 'conformance execution requires Ed25519 solver verification');
    requireCondition(bytesEqual(solver.toBytes(), quote.solverVerificationKey), 'solver binding does not match quote verification key');
    requireCondition(bindings.get('conformance-program')!.equals(this.#venueProgramId), 'conformance program binding mismatch');
    requireCondition(route.actions.length === 2 && route.actions.every((action) => action.targetBindingId === 'conformance-program' && action.authorityBindingId === 'trader'), 'route actions are unsupported');

    const expiry = [order.expiryValue, quote.validUntilValue, route.routeExpiryValue].reduce((a, b) => a < b ? a : b);
    const entry = order.action === 'ENTRY';
    const spotLimit = entry ? order.maxSpotQuoteIn?.atoms : order.minSpotQuoteOut?.atoms;
    requireCondition(spotLimit !== undefined, 'spot quote bound is missing');
    const collateralLimit = entry ? order.maxMarginAdded.atoms : order.minVenueReserveReturned.atoms;
    const entryExecutionDigest = entry ? new Uint8Array(32) : order.entryReceiptHash;
    const expectedPreShort = entry ? 0n : -order.expectedPrePositionSize.atoms;
    const expectedPreCollateral = entry ? 0n : order.expectedPrePositionEntryNotional.atoms;
    requireCondition(entryExecutionDigest !== undefined, 'exit entry receipt hash is missing');
    requireCondition(entry || expectedPreShort === order.quantity.atoms, 'exit must close the exact authoritative short position');
    requireCondition(entry || expectedPreCollateral > 0n, 'exit pre-position collateral must be positive');
    const accounts = new Map<string, PublicKey>([
      ['config', this.configAddress()],
      ['solver_registry', this.solverRegistryAddress()],
      ['receipt', this.receiptAddress(trader, admission.orderHash)],
      ['nonce_marker', this.nonceMarkerAddress(trader, order.nonce)],
      ['entry_receipt', entry ? this.#programId : bindings.get('entry-receipt')!],
      ['token_program', requiredPubkey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'token program')],
      ['system_program', requiredPubkey('11111111111111111111111111111111', 'system program')],
      ['instructions_sysvar', SYSVAR_INSTRUCTIONS_PUBKEY],
    ]);
    for (const [accountName, bindingId] of Object.entries(ACCOUNT_BINDING_IDS)) {
      if (bindingId !== ACCOUNT_BINDING_IDS.entry_receipt) accounts.set(accountName, bindings.get(bindingId)!);
    }

    const instruction = this.#coreIdl.instructions.find((item) => item.name === 'execute_conformance_atomic')!;
    const keys = instruction.accounts.map((account) => {
      if ('accounts' in account) throw new Error('nested IDL accounts are unsupported');
      const pubkey = accounts.get(account.name);
      requireCondition(pubkey !== undefined, `unbound IDL account ${account.name}`);
      if (account.address !== undefined) requireCondition(pubkey.equals(requiredPubkey(account.address, account.name)), `IDL account ${account.name} mismatch`);
      return { pubkey, isSigner: account.signer === true, isWritable: account.writable === true };
    });
    const data = this.#coder.instruction.encode('execute_conformance_atomic', {
      order_hash: hashBytes(admission.orderHash, 'orderHash'),
      quote_hash: hashBytes(admission.quoteHash, 'quoteHash'),
      route_hash: hashBytes(admission.routeHash, 'routeHash'),
      args: {
        action: entry ? { Entry: {} } : { Exit: {} },
        base_quantity_atoms: checkedU64(order.quantity.atoms, 'base quantity'),
        spot_quote_limit_atoms: checkedU64(spotLimit, 'spot quote limit'),
        collateral_quote_limit_atoms: checkedU64(collateralLimit, 'collateral quote limit'),
        expiry_slot: checkedU64(expiry, 'expiry slot'),
        nonce: checkedU64(order.nonce, 'nonce'),
        entry_execution_digest: Array.from(entryExecutionDigest),
        expected_pre_short_base_atoms: checkedU64(expectedPreShort, 'expected pre short base'),
        expected_pre_collateral_quote_atoms: checkedU64(expectedPreCollateral, 'expected pre collateral quote'),
      },
    });
    const coreInstruction = new TransactionInstruction({ programId: this.#programId, keys, data });
    const executionDigest = conformanceExecutionDigest(
      this.#domain,
      [admission.orderHash, admission.quoteHash, admission.routeHash],
      entry ? 1 : 2,
      [order.quantity.atoms, spotLimit, collateralLimit, expiry, order.nonce],
      entryExecutionDigest,
      [expectedPreShort, expectedPreCollateral],
      [
        this.#programId,
        trader,
        accounts.get('config')!,
        accounts.get('solver_registry')!,
        solver,
        accounts.get('receipt')!,
        accounts.get('nonce_marker')!,
        accounts.get('entry_receipt')!,
        accounts.get('market')!,
        accounts.get('position')!,
        accounts.get('trader_base')!,
        accounts.get('trader_quote')!,
        accounts.get('spot_base_vault')!,
        accounts.get('spot_quote_vault')!,
        accounts.get('perp_quote_vault')!,
        accounts.get('conformance_program')!,
        accounts.get('token_program')!,
        accounts.get('system_program')!,
        accounts.get('instructions_sysvar')!,
      ],
    );
    return { admission, coreInstruction, executionDigest, solver };
  }

  #authenticatedPlan(
    compiled: CompiledConformanceCore,
    solverSignature: Uint8Array,
  ): CompiledExecution<AuthenticatedConformanceExecution> {
    requireCondition(solverSignature instanceof Uint8Array && solverSignature.length === 64, 'solver execution signature must be 64 bytes');
    const verificationInstruction = Ed25519Program.createInstructionWithPublicKey({
      publicKey: compiled.solver.toBytes(),
      message: compiled.executionDigest,
      signature: solverSignature,
    });
    const instructions = Object.freeze([verificationInstruction, compiled.coreInstruction]);
    return {
      domain: this.#domain,
      orderHash: compiled.admission.orderHash,
      quoteHash: compiled.admission.quoteHash,
      routeHash: compiled.admission.routeHash,
      payload: Object.freeze({
        instructions,
        executionDigest: Uint8Array.from(compiled.executionDigest),
        coreInstruction: compiled.coreInstruction,
      }),
    };
  }

  async simulate(compiled: CompiledExecution<AuthenticatedConformanceExecution>): Promise<SimulationEvidence> {
    requireCondition(sameDomain(compiled.domain, this.#domain), 'simulation domain is unsupported');
    requireCondition(compiled.payload.coreInstruction.programId.equals(this.#programId), 'simulation program is unsupported');
    requireCondition(compiled.payload.instructions.at(-1) === compiled.payload.coreInstruction, 'core instruction must be last');
    requireCondition(compiled.payload.instructions.at(-2)?.programId.equals(Ed25519Program.programId) === true, 'solver verification must immediately precede core execution');
    const genesisHash = await this.#connection.getGenesisHash();
    requireCondition(genesisHash === this.#expectedGenesisHash, 'RPC genesis hash mismatch');
    const payer = compiled.payload.coreInstruction.keys.find((key) => key.isSigner)?.pubkey;
    requireCondition(payer !== undefined, 'simulation requires a trader account meta');
    const blockhash = await this.#connection.getLatestBlockhash('confirmed');
    const message = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash.blockhash, instructions: [...compiled.payload.instructions] }).compileToV0Message();
    const transaction = new VersionedTransaction(message);
    const response = await this.#connection.simulateTransaction(transaction, { sigVerify: false, replaceRecentBlockhash: true });
    return {
      succeeded: response.value.err === null,
      ...(response.value.err === null ? {} : { error: JSON.stringify(response.value.err) }),
      logs: response.value.logs ?? [],
      ...(response.value.unitsConsumed === undefined ? {} : { resourceUnits: BigInt(response.value.unitsConsumed) }),
    };
  }

  decodeReceipt(address: PublicKey, data: Buffer): ConformanceReceipt {
    const decoded = this.#coder.accounts.decode('ConformanceExecutionReceipt', data) as Record<string, unknown>;
    const orderHash = rawHash(decoded.order_hash as Uint8Array, 'receipt order hash');
    const quoteHashValue = rawHash(decoded.quote_hash as Uint8Array, 'receipt quote hash');
    const routeHashValue = rawHash(decoded.route_hash as Uint8Array, 'receipt route hash');
    const trader = decoded.trader as PublicKey;
    const solver = decoded.solver as PublicKey;
    requireCondition(trader instanceof PublicKey, 'receipt trader is invalid');
    requireCondition(solver instanceof PublicKey, 'receipt solver is invalid');
    requireCondition(address.equals(this.receiptAddress(trader, orderHash)), 'receipt PDA mismatch');
    const action = decoded.action;
    requireCondition(action === 1 || action === 2, 'receipt action is invalid');
    return {
      address,
      domain: rawDomain(decoded.domain),
      trader,
      solver,
      orderHash,
      quoteHash: quoteHashValue,
      routeHash: routeHashValue,
      action: action === 1 ? 'ENTRY' : 'EXIT',
      nonce: rawBigInt(decoded.nonce as InstanceType<typeof BN>, 'nonce'),
      executionDigest: rawHash(decoded.execution_digest as Uint8Array, 'execution digest'),
      baseQuantityAtoms: rawBigInt(decoded.base_quantity_atoms as InstanceType<typeof BN>, 'base quantity'),
      preBaseBalance: rawBigInt(decoded.pre_base_balance as InstanceType<typeof BN>, 'pre base balance'),
      postBaseBalance: rawBigInt(decoded.post_base_balance as InstanceType<typeof BN>, 'post base balance'),
      preQuoteBalance: rawBigInt(decoded.pre_quote_balance as InstanceType<typeof BN>, 'pre quote balance'),
      postQuoteBalance: rawBigInt(decoded.post_quote_balance as InstanceType<typeof BN>, 'post quote balance'),
      preShortBaseAtoms: rawBigInt(decoded.pre_short_base_atoms as InstanceType<typeof BN>, 'pre short base'),
      postShortBaseAtoms: rawBigInt(decoded.post_short_base_atoms as InstanceType<typeof BN>, 'post short base'),
      preCollateralQuoteAtoms: rawBigInt(decoded.pre_collateral_quote_atoms as InstanceType<typeof BN>, 'pre collateral'),
      postCollateralQuoteAtoms: rawBigInt(decoded.post_collateral_quote_atoms as InstanceType<typeof BN>, 'post collateral'),
      executionSlot: rawBigInt(decoded.execution_slot as InstanceType<typeof BN>, 'execution slot'),
    };
  }

  decodePosition(data: Buffer): ConformancePosition {
    const decoded = new BorshCoder(this.#venueIdl).accounts.decode('PerpPosition', data) as Record<string, unknown>;
    const market = decoded.market;
    const trader = decoded.trader;
    requireCondition(market instanceof PublicKey && trader instanceof PublicKey, 'position identity is invalid');
    return Object.freeze({
      market,
      trader,
      shortBaseAtoms: rawBigInt(decoded.short_base_atoms as InstanceType<typeof BN>, 'position short base'),
      collateralQuoteAtoms: rawBigInt(decoded.collateral_quote_atoms as InstanceType<typeof BN>, 'position collateral quote'),
    });
  }

  async readEvidence(executionReference: string, admission: PackageAdmission): Promise<ExecutionEvidence<ConformanceReceipt> | null> {
    requireCondition(sameDomain(admission.order.domain, this.#domain), 'evidence domain is unsupported');
    const trader = requiredPubkey(admission.order.owner, 'order owner');
    const address = this.receiptAddress(trader, admission.orderHash);
    requireCondition(executionReference === address.toBase58(), 'execution reference must be the receipt PDA');
    const genesisHash = await this.#connection.getGenesisHash();
    requireCondition(genesisHash === this.#expectedGenesisHash, 'RPC genesis hash mismatch');
    const account = await this.#connection.getAccountInfo(address, 'confirmed');
    if (account === null) return null;
    requireCondition(account.owner.equals(this.#programId), 'receipt program owner mismatch');
    const receipt = this.decodeReceipt(address, account.data);
    equalHash(receipt.orderHash, admission.orderHash, 'receipt order hash');
    equalHash(receipt.quoteHash, admission.quoteHash, 'receipt quote hash');
    equalHash(receipt.routeHash, admission.routeHash, 'receipt route hash');
    requireCondition(receipt.trader.equals(trader) && receipt.action === admission.order.action, 'receipt order mismatch');
    requireCondition(sameDomain(receipt.domain, this.#domain), 'receipt domain mismatch');
    requireCondition(receipt.solver.equals(requiredPubkey(admission.route.solver, 'route solver')), 'receipt solver mismatch');
    requireCondition(receipt.nonce === admission.order.nonce, 'receipt nonce mismatch');
    requireCondition(receipt.baseQuantityAtoms === admission.order.quantity.atoms, 'receipt quantity mismatch');
    return {
      executionReference,
      domain: this.#domain,
      orderHash: admission.orderHash,
      quoteHash: admission.quoteHash,
      routeHash: admission.routeHash,
      receipt,
    };
  }
}
