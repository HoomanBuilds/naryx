import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import anchor, { type Idl } from '@coral-xyz/anchor';
import {
  Connection,
  PublicKey,
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

const U64_MAX = (1n << 64n) - 1n;
const { BorshCoder, BN } = anchor;
const ACCOUNT_BINDING_IDS = {
  trader: 'trader',
  market: 'market',
  position: 'position',
  trader_base: 'trader-base',
  trader_quote: 'trader-quote',
  spot_base_vault: 'spot-base-vault',
  spot_quote_vault: 'spot-quote-vault',
  perp_quote_vault: 'perp-quote-vault',
  conformance_program: 'conformance-program',
} as const;

const REQUIRED_BINDINGS: ReadonlySet<string> = new Set(Object.values(ACCOUNT_BINDING_IDS));

export interface ConformanceReceipt {
  readonly address: PublicKey;
  readonly trader: PublicKey;
  readonly orderHash: Uint8Array;
  readonly quoteHash: Uint8Array;
  readonly routeHash: Uint8Array;
  readonly action: 'ENTRY' | 'EXIT';
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

export interface SolanaConformanceAdapterOptions {
  readonly connection: Connection;
  readonly domain: DomainRef;
  readonly environment: 'local' | 'devnet' | 'testnet';
  readonly expectedGenesisHash: string;
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function checkedU64(value: bigint, name: string): InstanceType<typeof BN> {
  requireCondition(typeof value === 'bigint' && value >= 0n && value <= U64_MAX, `${name} must fit u64`);
  return new BN(value.toString());
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

export class SolanaConformanceAdapter implements ExecutionAdapter<TransactionInstruction, ConformanceReceipt> {
  readonly #connection: Connection;
  readonly #domain: DomainRef;
  readonly #environment: 'local' | 'devnet' | 'testnet';
  readonly #expectedGenesisHash: string;
  readonly #coreIdl = loadIdl('naryx_core.json');
  readonly #venueIdl = loadIdl('naryx_conformance_venue.json');
  readonly #coder = new BorshCoder(this.#coreIdl);
  readonly #programId = requiredPubkey(this.#coreIdl.address, 'core IDL address');
  readonly #venueProgramId = requiredPubkey(this.#venueIdl.address, 'venue IDL address');

  constructor(options: SolanaConformanceAdapterOptions) {
    requireCondition(options.domain.domainId.startsWith('svm:'), 'domain must use the SVM namespace');
    requireCondition(options.expectedGenesisHash.length > 0, 'expected genesis hash is required');
    this.#connection = options.connection;
    this.#domain = options.domain;
    this.#environment = options.environment;
    this.#expectedGenesisHash = options.expectedGenesisHash;
    requireCondition(
      this.#coreIdl.instructions.some((instruction) => instruction.name === 'execute_conformance_atomic'),
      'published core IDL does not include conformance execution',
    );
  }

  configAddress(): PublicKey {
    return PublicKey.findProgramAddressSync([Buffer.from('naryx-protocol-config')], this.#programId)[0];
  }

  receiptAddress(trader: PublicKey, orderHash: Uint8Array): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from('conformance-receipt'), trader.toBuffer(), Buffer.from(hashBytes(orderHash, 'orderHash'))],
      this.#programId,
    )[0];
  }

  async compile(admission: PackageAdmission): Promise<CompiledExecution<TransactionInstruction>> {
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
    equalHash(route.orderHash, admission.orderHash, 'route order hash');
    equalHash(quote.orderHash, admission.orderHash, 'quote order hash');
    equalHash(quote.routeHash, admission.routeHash, 'quote route hash');

    const bindings = new Map<string, PublicKey>();
    for (const binding of route.accountBindings) {
      requireCondition(REQUIRED_BINDINGS.has(binding.routeBindingId), `unsupported route binding ${binding.routeBindingId}`);
      requireCondition(!bindings.has(binding.routeBindingId), `duplicate route binding ${binding.routeBindingId}`);
      bindings.set(binding.routeBindingId, requiredPubkey(binding.accountIdentity, binding.routeBindingId));
    }
    for (const bindingId of REQUIRED_BINDINGS) requireCondition(bindings.has(bindingId), `missing route binding ${bindingId}`);
    const trader = bindings.get('trader')!;
    requireCondition(trader.equals(requiredPubkey(order.owner, 'order owner')), 'trader binding does not match order owner');
    requireCondition(bindings.get('conformance-program')!.equals(this.#venueProgramId), 'conformance program binding mismatch');
    requireCondition(route.actions.length === 2 && route.actions.every((action) => action.targetBindingId === 'conformance-program' && action.authorityBindingId === 'trader'), 'route actions are unsupported');

    const expiry = [order.expiryValue, quote.validUntilValue, route.routeExpiryValue].reduce((a, b) => a < b ? a : b);
    const entry = order.action === 'ENTRY';
    const spotLimit = entry ? order.maxSpotQuoteIn?.atoms : order.minSpotQuoteOut?.atoms;
    requireCondition(spotLimit !== undefined, 'spot quote bound is missing');
    const collateralLimit = entry ? order.maxMarginAdded.atoms : order.minVenueReserveReturned.atoms;
    const accounts = new Map<string, PublicKey>([
      ['config', this.configAddress()],
      ['receipt', this.receiptAddress(trader, admission.orderHash)],
      ['token_program', requiredPubkey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'token program')],
      ['system_program', requiredPubkey('11111111111111111111111111111111', 'system program')],
    ]);
    for (const [accountName, bindingId] of Object.entries(ACCOUNT_BINDING_IDS)) accounts.set(accountName, bindings.get(bindingId)!);

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
      },
    });
    return {
      domain: this.#domain,
      orderHash: admission.orderHash,
      quoteHash: admission.quoteHash,
      routeHash: admission.routeHash,
      payload: new TransactionInstruction({ programId: this.#programId, keys, data }),
    };
  }

  async simulate(compiled: CompiledExecution<TransactionInstruction>): Promise<SimulationEvidence> {
    requireCondition(sameDomain(compiled.domain, this.#domain), 'simulation domain is unsupported');
    requireCondition(compiled.payload.programId.equals(this.#programId), 'simulation program is unsupported');
    const genesisHash = await this.#connection.getGenesisHash();
    requireCondition(genesisHash === this.#expectedGenesisHash, 'RPC genesis hash mismatch');
    const payer = compiled.payload.keys.find((key) => key.isSigner)?.pubkey;
    requireCondition(payer !== undefined, 'simulation requires a trader account meta');
    const blockhash = await this.#connection.getLatestBlockhash('confirmed');
    const message = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash.blockhash, instructions: [compiled.payload] }).compileToV0Message();
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
    requireCondition(trader instanceof PublicKey, 'receipt trader is invalid');
    requireCondition(address.equals(this.receiptAddress(trader, orderHash)), 'receipt PDA mismatch');
    const action = decoded.action;
    requireCondition(action === 1 || action === 2, 'receipt action is invalid');
    return {
      address,
      trader,
      orderHash,
      quoteHash: quoteHashValue,
      routeHash: routeHashValue,
      action: action === 1 ? 'ENTRY' : 'EXIT',
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
