import { randomBytes, createPublicKey, verify } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import {
  bytesEqual,
  exactPrice,
  packageOrderHash,
  quoteHash,
  routeHash,
  routePayload,
  routePayloadBytes,
  solverQuote,
  solverQuoteBytes,
  solverSignatureDigest,
  toHex,
  toProtocolJson,
  validatePackageOrderProfile,
  type AssetRef,
  type Hash32,
  type PackageOrder,
  type RouteAccountBindingInput,
  type RoutePayloadInput,
  type SolverQuoteInput,
} from '@naryx/protocol-types';
import { PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, SystemProgram } from '@solana/web3.js';
import type { AtomicQuoteNonceSource } from './configured-atomic-market.js';
import {
  InternalAtomicQuoteError,
  type InternalAtomicQuoteOrderProvider,
  type InternalAtomicQuotePort,
  type InternalAtomicQuoteRequest,
  type InternalAtomicQuoteResponse,
} from './internal-atomic-quote-server.js';
import type { SolanaDevnetSharedManifest, SolanaDevnetSolverConfig, SolanaDevnetSolverKey } from './solana-devnet-solver-config.js';
import { SOLANA_DEVNET_RESOURCE_NAMES } from './solana-devnet-solver-config.js';
import { requireSolanaDevnet, type SolanaDevnetSolverReadPort, type SolanaDevnetSolverWritePort } from './solana-devnet-rpc.js';
import {
  BorshWriter,
  MAX_QUOTE_LEVELS,
  QUOTE_MODE_FIRM_ONCHAIN,
  QUOTE_SIDE_ASK,
  QUOTE_SIDE_BID,
  TOKEN_PROGRAM_ID,
  associatedTokenAddress,
  bigEndian,
  decodeOpenCashCarryPackage,
  decodeTestPerpPosition,
  decodePackageQuoteShard,
  decodeQuoteLevelPage,
  decodeReservationClass,
  decodeTestPerpMarket,
  instructionDiscriminator,
  priceTestPerpCloseShort,
  priceTestPerpShort,
  reservationIdFor,
  sameDomain,
  sha256,
  testPerpOraclePricePerLot,
  type PackageQuoteShardState,
  type QuoteLevelState,
  type ReservationClassState,
  type TestPerpMarketState,
} from './solana-devnet-wire.js';

const BPS = 10_000n;
const HASH_HEX = /^[0-9a-f]{64}$/;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');


const shardWriteTails = new Map<string, Promise<unknown>>();

/** Runs package book writes for one shard one at a time within this solver process. */
/**
 * A binding's quote lock pins the shard's reference and shard sequences, and the user's execution
 * requires them unchanged until the binding expires. Bindings hold the shard until their expiry slot;
 * the standing-level refresher never writes a held shard.
 */
const shardHolds = new Map<string, bigint>();

export function holdShardSequences(shard: string, untilSlot: bigint): void {
  const current = shardHolds.get(shard);
  if (current === undefined || untilSlot > current) shardHolds.set(shard, untilSlot);
}

/** Whether a standing-level write at `slot` could invalidate a binding still in flight. */
export function shardSequencesHeld(shard: string, slot: bigint): boolean {
  const until = shardHolds.get(shard);
  return until !== undefined && slot < until;
}

export async function withShardWriteLock<T>(shard: string, task: () => Promise<T>): Promise<T> {
  const previous = shardWriteTails.get(shard) ?? Promise.resolve();
  const run = previous.then(task, task);
  const tail = run.catch(() => undefined);
  shardWriteTails.set(shard, tail);
  try {
    return await run;
  } finally {
    if (shardWriteTails.get(shard) === tail) shardWriteTails.delete(shard);
  }
}

function fail(message: string): never {
  throw new Error(`Solana Devnet firm quote: ${message}`);
}

function sameAsset(left: AssetRef, right: AssetRef): boolean {
  return left.assetId === right.assetId && left.decimals === right.decimals
    && bytesEqual(left.assetManifestHash, right.assetManifestHash);
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left;
  let b = right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

export function programAddress(manifest: SolanaDevnetSharedManifest, name: string): Readonly<{
  programId: string;
  programDataAddress: string;
  codeIdentity: Uint8Array;
}> {
  const program = manifest.programs.find((item) => item.name === name);
  if (program === undefined) fail(`program ${name} is missing`);
  return Object.freeze({
    programId: new PublicKey(program.programId).toBase58(),
    programDataAddress: new PublicKey(program.programDataAddress).toBase58(),
    codeIdentity: Uint8Array.from(program.programDataHeaderIdentity),
  });
}

export type SolanaDevnetFirmAccounts = Readonly<Record<string, string>>;

/**
 * Every account the firm entry and the quote lock touch. Per-order accounts are PDAs of the
 * trader, the order, and the reservation id; registry accounts are reviewed configuration.
 */
export function deriveSolanaDevnetFirmAccounts(input: Readonly<{
  manifest: SolanaDevnetSharedManifest;
  config: SolanaDevnetSolverConfig;
  market: TestPerpMarketState;
  owner: string;
  orderHash: Uint8Array;
  nonce: bigint;
  reservationId: Uint8Array;
  /** A firm exit settles the bought-back base into the solver's base account. */
  exit?: boolean;
}>): SolanaDevnetFirmAccounts {
  const { manifest, config, market } = input;
  const core = new PublicKey(programAddress(manifest, 'core').programId);
  const reservationProgram = new PublicKey(programAddress(manifest, 'reservation').programId);
  const trader = new PublicKey(input.owner);
  const solver = new PublicKey(config.solverId);
  const strategy = PublicKey.findProgramAddressSync(
    [Buffer.from('test-perp-strategy'), trader.toBuffer(), Buffer.from(manifest.testPerp.strategyIdHex, 'hex')],
    new PublicKey(programAddress(manifest, 'perp_adapter').programId),
  )[0];
  const position = PublicKey.findProgramAddressSync(
    [Buffer.from('test-perp-position'), new PublicKey(manifest.testPerp.market).toBuffer(), trader.toBuffer()],
    new PublicKey(programAddress(manifest, 'perp_venue').programId),
  )[0];
  const pda = (seeds: readonly (Buffer | Uint8Array)[], program: PublicKey) =>
    PublicKey.findProgramAddressSync(seeds.map((seed) => Buffer.from(seed)), program)[0].toBase58();
  const executorAuthority = pda([Buffer.from('cash-carry-executor'), trader.toBuffer(), strategy.toBuffer()], core);
  const reservationClass = new PublicKey(config.accounts.reservationClass);
  const baseMint = config.resources.baseAsset.subjectAddress;
  const quoteMint = config.resources.quoteAsset.subjectAddress;
  const programs = {
    coreProgram: programAddress(manifest, 'core'),
    reservationProgram: programAddress(manifest, 'reservation'),
    packageBookProgram: programAddress(manifest, 'package_book'),
    perpAdapterProgram: programAddress(manifest, 'perp_adapter'),
    perpVenueProgram: programAddress(manifest, 'perp_venue'),
  };
  const accounts: Record<string, string> = {
    trader: trader.toBase58(),
    config: pda([Buffer.from('naryx-protocol-config')], core),
    solverRegistry: pda([Buffer.from('conformance-solver')], core),
    solver: solver.toBase58(),
    receipt: pda([Buffer.from('cash-carry-receipt'), trader.toBuffer(), input.orderHash], core),
    nonceMarker: pda([Buffer.from('cash-carry-nonce'), trader.toBuffer(), bigEndian(input.nonce, 8)], core),
    openPackage: pda([Buffer.from('cash-carry-open'), trader.toBuffer(), strategy.toBuffer()], core),
    executorAuthority,
    reservationClass: reservationClass.toBase58(),
    reservationCapacity: pda([Buffer.from('reservation-capacity'), reservationClass.toBuffer(), solver.toBuffer()], reservationProgram),
    reservation: pda([Buffer.from('reservation'), reservationClass.toBuffer(), solver.toBuffer(), input.reservationId], reservationProgram),
    livePair: pda([Buffer.from('live-pair'), reservationClass.toBuffer(), solver.toBuffer(), new PublicKey(executorAuthority).toBuffer()], reservationProgram),
    reservationVault: pda([Buffer.from('reservation-vault'), reservationClass.toBuffer(), solver.toBuffer(), input.reservationId], reservationProgram),
    solverQuote: associatedTokenAddress(solver, input.exit === true ? baseMint : quoteMint).toBase58(),
    traderBase: associatedTokenAddress(trader, baseMint).toBase58(),
    traderQuote: associatedTokenAddress(trader, quoteMint).toBase58(),
    executorBase: associatedTokenAddress(executorAuthority, baseMint).toBase58(),
    executorQuote: associatedTokenAddress(executorAuthority, quoteMint).toBase58(),
    quoteLock: pda([Buffer.from('firm-quote-lock'), input.reservationId], core),
    seriesIndex: config.accounts.seriesIndex,
    seriesRecord: config.accounts.seriesRecord,
    coreProgram: programs.coreProgram.programId,
    coreProgramData: programs.coreProgram.programDataAddress,
    reservationProgram: programs.reservationProgram.programId,
    reservationProgramData: programs.reservationProgram.programDataAddress,
    packageBookProgram: programs.packageBookProgram.programId,
    packageBookProgramData: programs.packageBookProgram.programDataAddress,
    perpAdapterProgram: programs.perpAdapterProgram.programId,
    perpAdapterProgramData: programs.perpAdapterProgram.programDataAddress,
    perpVenueProgram: programs.perpVenueProgram.programId,
    perpVenueProgramData: programs.perpVenueProgram.programDataAddress,
    riseStrategy: strategy.toBase58(),
    testPerpMarket: new PublicKey(manifest.testPerp.market).toBase58(),
    testPerpPosition: position.toBase58(),
    testPerpOracle: market.oracle,
    testPerpCollateralVault: market.collateralVault,
    testPerpFeeVault: market.feeVault,
    testPerpInsuranceVault: market.insuranceVault,
    tokenProgram: TOKEN_PROGRAM_ID.toBase58(),
    instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY.toBase58(),
    systemProgram: SystemProgram.programId.toBase58(),
    packageBookClass: config.accounts.packageBookClass,
    packageBookShard: config.accounts.packageBookShard,
    packageBookLevelPage: config.accounts.packageBookLevelPage,
  };
  for (const name of SOLANA_DEVNET_RESOURCE_NAMES) {
    accounts[`${name}Index`] = config.accounts.indexes[name];
    accounts[`${name}Record`] = config.accounts.records[name];
  }
  if (accounts.config !== new PublicKey(config.accounts.config).toBase58()
    || accounts.solverRegistry !== new PublicKey(config.accounts.solverRegistry).toBase58()) {
    fail('configured core config or solver registry is not the core PDA');
  }
  return Object.freeze(accounts);
}

export function firmRouteBindingId(name: string): string {
  return `firm-${name}`;
}

function accountBindings(
  manifest: SolanaDevnetSharedManifest,
  accounts: SolanaDevnetFirmAccounts,
): RouteAccountBindingInput[] {
  const programCode: Record<string, string> = {
    coreProgram: 'core', reservationProgram: 'reservation', packageBookProgram: 'package_book',
    perpAdapterProgram: 'perp_adapter', perpVenueProgram: 'perp_venue',
  };
  const tokenAuthority: Record<string, string> = {
    reservationVault: accounts.reservation!, solverQuote: accounts.solver!, traderBase: accounts.trader!,
    traderQuote: accounts.trader!, executorBase: accounts.executorAuthority!, executorQuote: accounts.executorAuthority!,
  };
  return Object.entries(accounts).map(([name, identity]) => {
    const program = programCode[name];
    const authority = tokenAuthority[name];
    return {
      routeBindingId: firmRouteBindingId(name),
      accountIdentity: identity,
      ...(program === undefined ? {} : { codeIdentity: toHex(programAddress(manifest, program).codeIdentity) }),
      ...(authority === undefined ? {} : { ownerIdentity: TOKEN_PROGRAM_ID.toBase58(), authorityIdentity: authority }),
      ...(name === 'trader' ? { authorityIdentity: identity } : {}),
    };
  });
}

export type SolanaDevnetFirmQuoteRecord = Readonly<{
  orderHash: string;
  idempotencyKey: string;
  reservationNonceHex: string;
  slotIndex: number;
  levelId: bigint;
  response: InternalAtomicQuoteResponse;
  /** Protocol JSON of the CashCarryQuoteArgs the solver locked with, once the lock was sent. */
  lockArgsJson?: string;
}>;

export interface SolanaDevnetFirmQuoteJournal {
  get(orderHash: string): SolanaDevnetFirmQuoteRecord | undefined;
  getByIdempotencyKey(key: string): SolanaDevnetFirmQuoteRecord | undefined;
  save(record: SolanaDevnetFirmQuoteRecord): SolanaDevnetFirmQuoteRecord;
  /** The lock arguments are journaled before each lock transaction is sent. */
  recordLockArgs(orderHash: string, lockArgsJson: string): SolanaDevnetFirmQuoteRecord;
  close(): void;
}

function repositoryRoot(): string | undefined {
  let current = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export class SqliteSolanaDevnetFirmQuoteJournal implements SolanaDevnetFirmQuoteJournal {
  readonly #db: Database.Database;

  constructor(path: string) {
    if (path !== ':memory:') {
      if (!isAbsolute(path)) fail('journal path must be absolute');
      const root = repositoryRoot();
      if (root !== undefined && resolve(path).startsWith(resolve(root) + sep)) fail('journal must remain outside the repository');
    }
    this.#db = new Database(path);
    this.#db.pragma('journal_mode = WAL');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS solana_devnet_firm_quotes (
        order_hash TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        reservation_nonce_hex TEXT NOT NULL,
        slot_index INTEGER NOT NULL,
        level_id TEXT NOT NULL,
        response_json TEXT NOT NULL,
        lock_args_json TEXT
      )
    `);
  }

  #row(row: Record<string, unknown> | undefined): SolanaDevnetFirmQuoteRecord | undefined {
    if (row === undefined) return undefined;
    return Object.freeze({
      orderHash: String(row.order_hash),
      idempotencyKey: String(row.idempotency_key),
      reservationNonceHex: String(row.reservation_nonce_hex),
      slotIndex: Number(row.slot_index),
      levelId: BigInt(String(row.level_id)),
      response: JSON.parse(String(row.response_json)) as InternalAtomicQuoteResponse,
      ...(typeof row.lock_args_json === 'string' ? { lockArgsJson: row.lock_args_json } : {}),
    });
  }

  get(orderHash: string): SolanaDevnetFirmQuoteRecord | undefined {
    return this.#row(this.#db.prepare('SELECT * FROM solana_devnet_firm_quotes WHERE order_hash = ?').get(orderHash) as Record<string, unknown> | undefined);
  }

  getByIdempotencyKey(key: string): SolanaDevnetFirmQuoteRecord | undefined {
    return this.#row(this.#db.prepare('SELECT * FROM solana_devnet_firm_quotes WHERE idempotency_key = ?').get(key) as Record<string, unknown> | undefined);
  }

  save(record: SolanaDevnetFirmQuoteRecord): SolanaDevnetFirmQuoteRecord {
    // One firm quote per order: a reservation id is bound to exactly one order and one quote.
    this.#db.prepare(`
      INSERT INTO solana_devnet_firm_quotes (order_hash, idempotency_key, reservation_nonce_hex, slot_index, level_id, response_json)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING
    `).run(record.orderHash, record.idempotencyKey, record.reservationNonceHex, record.slotIndex, record.levelId.toString(), JSON.stringify(record.response));
    const stored = this.get(record.orderHash);
    if (stored === undefined || stored.idempotencyKey !== record.idempotencyKey) {
      throw new InternalAtomicQuoteError('IDEMPOTENCY_CONFLICT', 'order already has a different Solana Devnet firm quote');
    }
    return stored;
  }

  recordLockArgs(orderHash: string, lockArgsJson: string): SolanaDevnetFirmQuoteRecord {
    // Rewritten before each lock attempt. A lock transaction that never finalized expired with its
    // blockhash; if an earlier one did land, its onchain quote-args hash no longer matches this
    // journal and the binding fails closed instead of signing.
    this.#db.prepare('UPDATE solana_devnet_firm_quotes SET lock_args_json = ? WHERE order_hash = ?').run(lockArgsJson, orderHash);
    const stored = this.get(orderHash);
    if (stored === undefined || stored.lockArgsJson !== lockArgsJson) fail('lock arguments could not be journaled');
    return stored;
  }

  close(): void {
    this.#db.close();
  }
}

export type SolanaDevnetLiveQuoteState = Readonly<{
  slot: bigint;
  market: TestPerpMarketState;
  oraclePricePerLot: bigint;
  reservationClass: ReservationClassState;
  shard: PackageQuoteShardState;
  levels: readonly QuoteLevelState[];
}>;

export async function readSolanaDevnetQuoteState(
  rpc: SolanaDevnetSolverReadPort,
  manifest: SolanaDevnetSharedManifest,
  config: SolanaDevnetSolverConfig,
): Promise<SolanaDevnetLiveQuoteState> {
  await requireSolanaDevnet(rpc);
  const slot = await rpc.getFinalizedSlot();
  const [accounts, blockTime] = await Promise.all([
    rpc.getAccounts([
      manifest.testPerp.market, manifest.testPerp.oracle, config.accounts.reservationClass,
      config.accounts.packageBookShard, config.accounts.packageBookLevelPage,
    ], slot),
    rpc.getBlockTime(slot),
  ]);
  const [marketAccount, oracleAccount, classAccount, shardAccount, pageAccount] = accounts;
  const owned = (account: typeof marketAccount, program: string, name: string) => {
    if (account === null || account === undefined || account.owner !== programAddress(manifest, program).programId) {
      fail(`${name} is absent or not owned by the reviewed ${program} program`);
    }
    return account;
  };
  const market = decodeTestPerpMarket(owned(marketAccount, 'perp_venue', 'test perp market').data);
  if (market.oracle !== manifest.testPerp.oracle || market.feedIdHex !== manifest.testPerp.feedIdHex) {
    fail('test perp market does not pin the reviewed Pyth feed');
  }
  if (market.pauseOpens) fail('test perp market has opens paused');
  if (oracleAccount === null || oracleAccount === undefined) fail('oracle account is absent');
  const oraclePricePerLot = testPerpOraclePricePerLot(market, { address: manifest.testPerp.oracle, ...oracleAccount }, blockTime);
  const reservationClass = decodeReservationClass(owned(classAccount, 'reservation', 'reservation class').data);
  const shard = decodePackageQuoteShard(owned(shardAccount, 'package_book', 'package book shard').data);
  const page = decodeQuoteLevelPage(owned(pageAccount, 'package_book', 'package book level page').data);
  if (!sameDomain(reservationClass.domain, manifest.domain) || !sameDomain(shard.domain, manifest.domain)
    || page.shard !== new PublicKey(config.accounts.packageBookShard).toBase58()
    || shard.solver !== new PublicKey(config.solverId).toBase58() || shard.killed
    || !bytesEqual(shard.seriesManifestHash, config.series.seriesManifestHash)
    || !bytesEqual(shard.executionClassManifestHash, config.series.executionClassManifestHash)
    || reservationClass.baseMint !== new PublicKey(config.resources.baseAsset.subjectAddress).toBase58()
    || reservationClass.quoteMint !== new PublicKey(config.resources.quoteAsset.subjectAddress).toBase58()) {
    fail('reservation class or package book shard does not match the reviewed series and solver');
  }
  return Object.freeze({ slot, market, oraclePricePerLot, reservationClass, shard, levels: page.levels });
}

/** A usable firm level: active this epoch, the reviewed policy and settlement class, enough capacity. */
export function selectFirmLevel(
  state: SolanaDevnetLiveQuoteState,
  config: SolanaDevnetSolverConfig,
  units: bigint,
  minimumExpiry: bigint,
  maximumExpiry: bigint,
  side: number = QUOTE_SIDE_ASK,
): QuoteLevelState | undefined {
  return state.levels.find((level) => level.active && level.epoch === state.shard.epoch
    && level.side === side && level.quoteMode === QUOTE_MODE_FIRM_ONCHAIN && level.maxFeeAtoms === 0n
    && bytesEqual(level.reservationPolicyHash, state.reservationClass.policyHash)
    && bytesEqual(level.settlementClassIdentityHash, config.series.settlementClassIdentityHash)
    && units >= level.minPackageSizeUnits && units <= level.maxPackageSizeUnits && units <= level.remainingCapacity
    && level.expirySlot > minimumExpiry && level.expirySlot <= maximumExpiry
    && level.expirySlot <= state.shard.heartbeatExpirySlot);
}

/**
 * Quote automation for the solver's own shard: one heartbeat and one firm ask level whose expiry is
 * the quote's expiry. The level carries the reviewed policy and settlement class and zero fees.
 */
export function packageBookLevelInstructions(input: Readonly<{
  manifest: SolanaDevnetSharedManifest;
  config: SolanaDevnetSolverConfig;
  state: SolanaDevnetLiveQuoteState;
  expirySlot: bigint;
  /** Entry quotes an ask; a firm exit quotes the solver's bid. */
  side?: number;
}>) {
  const { manifest, config, state, expirySlot } = input;
  const side = input.side ?? QUOTE_SIDE_ASK;
  if (side !== QUOTE_SIDE_ASK && side !== QUOTE_SIDE_BID) fail('level side is invalid');
  const program = new PublicKey(programAddress(manifest, 'package_book').programId);
  const solver = new PublicKey(config.solverId);
  const keys = (levels: boolean) => [
    { pubkey: solver, isSigner: true, isWritable: false },
    { pubkey: new PublicKey(config.accounts.packageBookClass), isSigner: false, isWritable: false },
    { pubkey: new PublicKey(config.accounts.packageBookShard), isSigner: false, isWritable: true },
    ...(levels ? [{ pubkey: new PublicKey(config.accounts.packageBookLevelPage), isSigner: false, isWritable: true }] : []),
  ];
  const slotIndex = state.levels.findIndex((level) => !level.active || level.epoch !== state.shard.epoch || level.expirySlot <= state.slot);
  if (slotIndex < 0 || slotIndex >= MAX_QUOTE_LEVELS) fail('package book shard has no free level slot');
  const previous = state.levels[slotIndex]!;
  // An expired level that is still marked active keeps its id; replacing it bumps its sequence.
  const reusing = previous.active && previous.epoch === state.shard.epoch;
  const levelId = state.slot;
  const reference = new BorshWriter()
    .bytes(instructionDiscriminator('update_reference'))
    .u64(state.shard.referenceSequence)
    .u64(state.shard.shardSequence)
    .i128(state.oraclePricePerLot)
    .bytes(sha256(Buffer.from('NARYX/solana-devnet/reference', 'ascii'), bigEndian(state.slot, 8), bigEndian(state.oraclePricePerLot, 8)))
    .u64(expirySlot)
    .done();
  const upsert = new BorshWriter()
    .bytes(instructionDiscriminator('batch_upsert_levels'))
    .u64(state.shard.shardSequence + 1n)
    .bool(false)
    .u32(1)
    .u8(slotIndex)
    .u64(reusing ? previous.levelSequence : 0n)
    .u64(reusing ? previous.levelSequence + 1n : 1n)
    .u64(reusing ? previous.levelId : levelId)
    .u8(side)
    .u64(1n)
    .u64(config.levelCapacityUnits)
    .i128(0n)
    .u64(0n)
    .bytes(config.series.settlementClassIdentityHash)
    .u8(QUOTE_MODE_FIRM_ONCHAIN)
    .bytes(state.reservationClass.policyHash)
    .u64(expirySlot)
    .u64(config.levelCapacityUnits)
    .done();
  return Object.freeze({
    slotIndex,
    levelId: reusing ? previous.levelId : levelId,
    instructions: [
      { programId: program, keys: keys(false), data: reference },
      { programId: program, keys: keys(true), data: upsert },
    ],
  });
}

/**
 * Standing liquidity, as an exchange market maker keeps it: one firm level per side (the ask that
 * entries fill, the bid that exits fill) that a quote made `leadSlots` from now can still use, at
 * full capacity. Without it the first quote after a level ages out waits for a Devnet write to
 * finalize, which outlasts the API's quote request. A level written now (expiry now + quote TTL)
 * serves quotes for two thirds of the TTL, so this writes about once per side per that window.
 * Returns how many levels it wrote.
 */
export async function refreshSolanaDevnetStandingLevels(
  dependencies: Pick<SolanaDevnetFirmQuoteDependencies, 'manifest' | 'config' | 'rpc' | 'writer' | 'key'>,
  leadSlots: bigint,
): Promise<number> {
  const { manifest, config, rpc, writer, key } = dependencies;
  if (writer === undefined) return 0;
  let written = 0;
  for (const side of [QUOTE_SIDE_ASK, QUOTE_SIDE_BID]) {
    await withShardWriteLock(config.accounts.packageBookShard, async () => {
      const state = await readSolanaDevnetQuoteState(rpc, manifest, config);
      // A user between binding and execution needs the shard sequences unchanged.
      if (shardSequencesHeld(config.accounts.packageBookShard, state.slot)) return;
      const expirySlot = standingLevelExpiry(state, config, leadSlots, side);
      if (expirySlot === undefined) return;
      const plan = packageBookLevelInstructions({ manifest, config, state, expirySlot, side });
      await writer.sendAndFinalize(plan.instructions, key.keypair);
      written += 1;
    });
  }
  return written;
}

/**
 * The expiry of the standing level to write on `side`, or undefined when a level a quote made
 * `leadSlots` from now could still use already exists, at full size.
 */
export function standingLevelExpiry(
  state: SolanaDevnetLiveQuoteState,
  config: Pick<SolanaDevnetSolverConfig, 'maxQuantityAtoms' | 'levelCapacityUnits' | 'quoteTtlSlots' | 'series'>,
  leadSlots: bigint,
  side: number,
): bigint | undefined {
  const maxUnits = config.maxQuantityAtoms / config.series.spotBaseAtomsPerPackageUnit;
  const units = maxUnits < config.levelCapacityUnits ? maxUnits : config.levelCapacityUnits;
  if (units <= 0n) return undefined;
  const quotedAt = state.slot + leadSlots;
  // The window a quote at that slot applies: expiry beyond a third of the TTL, within the TTL.
  const usable = selectFirmLevel(state, config as SolanaDevnetSolverConfig, units, quotedAt + config.quoteTtlSlots / 3n,
    quotedAt + config.quoteTtlSlots, side);
  return usable === undefined ? state.slot + config.quoteTtlSlots : undefined;
}

export type SolanaDevnetEntryPricing = Readonly<{
  spotLots: bigint;
  spotLimitPerLot: bigint;
  firmQuoteAtoms: bigint;
  perpLots: bigint;
  perpLimitPerLot: bigint;
  perpNotionalAtoms: bigint;
  perpFeeAtoms: bigint;
  initialMarginAtoms: bigint;
}>;

/**
 * Firm inventory spot at the oracle plus the inventory spread (rounded up), and the test perp short
 * at the market's own spread, impact, and taker fee. Integer atoms throughout.
 */
export function priceSolanaDevnetEntry(
  config: Pick<SolanaDevnetSolverConfig, 'inventorySpreadBps' | 'perpLimitToleranceBps' | 'spotBaseLotAtoms'>,
  market: TestPerpMarketState,
  oraclePricePerLot: bigint,
  quantityAtoms: bigint,
): SolanaDevnetEntryPricing {
  if (quantityAtoms % config.spotBaseLotAtoms !== 0n) fail('quantity is not an exact spot lot');
  const perp = priceTestPerpShort(market, oraclePricePerLot, quantityAtoms);
  const spotLots = quantityAtoms / config.spotBaseLotAtoms;
  const firmQuoteAtoms = ceilDiv(
    quantityAtoms * oraclePricePerLot * (BPS + BigInt(config.inventorySpreadBps)),
    market.baseLotAtoms * BPS,
  );
  const spotLimitPerLot = ceilDiv(firmQuoteAtoms, spotLots);
  const tick = market.quoteTickAtomsPerBaseLot;
  const perpLimitPerLot = ((perp.fillPricePerLot * (BPS - BigInt(config.perpLimitToleranceBps))) / BPS / tick) * tick;
  if (perpLimitPerLot <= 0n) fail('perp limit is zero');
  return Object.freeze({
    spotLots,
    spotLimitPerLot,
    firmQuoteAtoms,
    perpLots: perp.baseLots,
    perpLimitPerLot,
    perpNotionalAtoms: perp.notionalAtoms,
    perpFeeAtoms: perp.feeAtoms,
    initialMarginAtoms: perp.initialMarginAtoms,
  });
}

export type SolanaDevnetExitPricing = Readonly<{
  spotLots: bigint;
  spotMinimumPerLot: bigint;
  firmQuoteAtoms: bigint;
  perpLots: bigint;
  perpLimitPerLot: bigint;
  perpNotionalAtoms: bigint;
  perpFeeAtoms: bigint;
}>;

/**
 * Firm inventory bid at the oracle less the inventory spread (rounded down), with the route spot
 * minimum at that exact bid per lot, and the test perp buy-back at the market's own spread, impact,
 * and taker fee with its limit rounded up to a tick. Integer atoms throughout.
 */
export function priceSolanaDevnetExit(
  config: Pick<SolanaDevnetSolverConfig, 'inventorySpreadBps' | 'perpLimitToleranceBps' | 'spotBaseLotAtoms'>,
  market: TestPerpMarketState,
  oraclePricePerLot: bigint,
  quantityAtoms: bigint,
): SolanaDevnetExitPricing {
  if (quantityAtoms % config.spotBaseLotAtoms !== 0n) fail('quantity is not an exact spot lot');
  const spread = BigInt(config.inventorySpreadBps);
  if (spread >= BPS) fail('inventory spread is invalid');
  const perp = priceTestPerpCloseShort(market, oraclePricePerLot, quantityAtoms);
  const spotLots = quantityAtoms / config.spotBaseLotAtoms;
  const firmQuoteAtoms = (quantityAtoms * oraclePricePerLot * (BPS - spread)) / (market.baseLotAtoms * BPS);
  const spotMinimumPerLot = firmQuoteAtoms / spotLots;
  if (spotMinimumPerLot <= 0n) fail('firm bid is zero');
  const tick = market.quoteTickAtomsPerBaseLot;
  const ceilLimit = ceilDiv(perp.fillPricePerLot * (BPS + BigInt(config.perpLimitToleranceBps)), BPS);
  return Object.freeze({
    spotLots,
    spotMinimumPerLot,
    firmQuoteAtoms,
    perpLots: perp.baseLots,
    perpLimitPerLot: ceilDiv(ceilLimit, tick) * tick,
    perpNotionalAtoms: perp.notionalAtoms,
    perpFeeAtoms: perp.feeAtoms,
  });
}

function requireOrder(order: PackageOrder, config: SolanaDevnetSolverConfig, manifest: SolanaDevnetSharedManifest): void {
  const exit = order.action === 'EXIT';
  const quoteAsset = exit ? order.minSpotQuoteOut?.asset : order.maxSpotQuoteIn?.asset;
  if (order.environment !== 'devnet' || !sameDomain(order.domain, manifest.domain)
    || (order.action !== 'ENTRY' && !exit) || order.direction !== 'LONG_SPOT_SHORT_PERP'
    || order.settlementClass !== 'ATOMIC_POSTCONDITION' || order.expiryUnit !== 'SOLANA_SLOT'
    || order.partialFillPolicy !== 'EXACT_ALL_LEGS' || quoteAsset === undefined
    || (exit && (order.minExitQuoteOutcome === undefined || order.entryReceiptHash === undefined))) {
    fail('order is not a Devnet atomic long-spot short-perp entry or exit');
  }
  if (order.settlementAccount !== order.owner) fail('Devnet settlement account must be the trader wallet');
  new PublicKey(order.owner);
  if (order.quantity.atoms <= 0n || order.quantity.atoms > config.maxQuantityAtoms) fail('quantity is outside the solver limit');
  if (order.quantity.atoms % config.series.spotBaseAtomsPerPackageUnit !== 0n
    || order.quantity.atoms % config.series.perpQuantityAtomsPerPackageUnit !== 0n) {
    fail('quantity is not an exact series unit');
  }
  if (order.quantity.asset.assetId !== new PublicKey(config.resources.baseAsset.subjectAddress).toBase58()
    || quoteAsset.assetId !== new PublicKey(config.resources.quoteAsset.subjectAddress).toBase58()) {
    fail('order assets are not the reviewed mints');
  }
  const adapterMatch = (list: readonly PackageOrder['permittedSpotAdapters'][number][], adapter: SolanaDevnetSolverConfig['spot']['adapter']) =>
    list.some((item) => item.adapterId === adapter.adapterId && item.adapterManifestVersion === adapter.adapterManifestVersion
      && bytesEqual(item.adapterManifestHash, adapter.adapterManifestHash));
  if (!adapterMatch(order.permittedSpotAdapters, config.spot.adapter) || !adapterMatch(order.permittedPerpAdapters, config.perpetual.adapter)) {
    fail('order does not permit the reviewed adapters');
  }
}

export type SolanaDevnetFirmQuoteDependencies = Readonly<{
  manifest: SolanaDevnetSharedManifest;
  config: SolanaDevnetSolverConfig;
  rpc: SolanaDevnetSolverReadPort;
  writer?: SolanaDevnetSolverWritePort;
  key: SolanaDevnetSolverKey;
  orders: InternalAtomicQuoteOrderProvider;
  journal: SolanaDevnetFirmQuoteJournal;
  nonceSource: AtomicQuoteNonceSource;
  randomNonce?: () => Uint8Array;
}>;

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

/**
 * Signs a FIRM_ONCHAIN quote for a Devnet order: live Pyth price, live test perp terms, a live
 * firm ask level in the solver's package book shard, and a fresh reservation id the binding later
 * funds. Every other domain is delegated unchanged to the existing coordinator.
 */
export function createSolanaDevnetFirmQuotePort(
  dependencies: SolanaDevnetFirmQuoteDependencies,
  fallback: InternalAtomicQuotePort,
): InternalAtomicQuotePort {
  const { manifest, config, rpc, key, journal } = dependencies;
  if (key.publicKey.toBase58() !== new PublicKey(config.solverId).toBase58()) fail('solver key does not match solverId');
  const pending = new Map<string, Promise<InternalAtomicQuoteResponse>>();

  /** Exit readiness: the trader's own open package for the receipt the order names and the exact short. */
  async function readOpenShort(order: PackageOrder, slot: bigint, perpLots: bigint): Promise<bigint> {
    const core = new PublicKey(programAddress(manifest, 'core').programId);
    const trader = new PublicKey(order.owner);
    const strategy = PublicKey.findProgramAddressSync(
      [Buffer.from('test-perp-strategy'), trader.toBuffer(), Buffer.from(manifest.testPerp.strategyIdHex, 'hex')],
      new PublicKey(programAddress(manifest, 'perp_adapter').programId),
    )[0];
    const accounts = {
      riseStrategy: strategy.toBase58(),
      openPackage: PublicKey.findProgramAddressSync([Buffer.from('cash-carry-open'), trader.toBuffer(), strategy.toBuffer()], core)[0].toBase58(),
      testPerpPosition: PublicKey.findProgramAddressSync(
        [Buffer.from('test-perp-position'), new PublicKey(manifest.testPerp.market).toBuffer(), trader.toBuffer()],
        new PublicKey(programAddress(manifest, 'perp_venue').programId),
      )[0].toBase58(),
    };
    const [openAccount, positionAccount] = await rpc.getAccounts([accounts.openPackage, accounts.testPerpPosition], slot);
    if (openAccount === null || openAccount === undefined || openAccount.owner !== core.toBase58()) fail('trader has no open package');
    const open = decodeOpenCashCarryPackage(openAccount.data);
    const entryReceipt = PublicKey.findProgramAddressSync(
      [Buffer.from('cash-carry-receipt'), trader.toBuffer(), Buffer.from(order.entryReceiptHash!)], core,
    )[0].toBase58();
    if (open.trader !== trader.toBase58() || !sameDomain(open.domain, manifest.domain) || open.entryReceipt !== entryReceipt) {
      fail('open package does not match the exit order entry receipt');
    }
    if (positionAccount === null || positionAccount === undefined
      || positionAccount.owner !== programAddress(manifest, 'perp_venue').programId) {
      fail('trader test perp position is absent');
    }
    const position = decodeTestPerpPosition(positionAccount.data);
    if (position.owner !== trader.toBase58() || position.delegate !== accounts.riseStrategy || position.baseLots !== -perpLots) {
      fail('trader position is not the exact open short');
    }
    if (position.entryNotionalAtoms !== order.expectedPrePositionEntryNotional.atoms) {
      fail('position entry notional does not match the exit order');
    }
    return position.entryNotionalAtoms;
  }

  async function sign(order: PackageOrder, request: InternalAtomicQuoteRequest): Promise<InternalAtomicQuoteResponse> {
    requireOrder(order, config, manifest);
    const exit = order.action === 'EXIT';
    const orderHash = packageOrderHash(order);
    let state = await readSolanaDevnetQuoteState(rpc, manifest, config);
    if (state.slot >= order.expiryValue) fail('order is expired');
    const quoteAsset = exit ? order.minSpotQuoteOut!.asset : order.maxSpotQuoteIn!.asset;
    const baseAsset = order.quantity.asset;
    const venueCap = order.maxVenueFeeAtomsByAsset.find((cap) => sameAsset(cap.asset, quoteAsset));
    let leg: Readonly<{ spotLimitPerLot: bigint; perpLimitPerLot: bigint; firmQuoteAtoms: bigint; perpNotionalAtoms: bigint; perpFeeAtoms: bigint }>;
    let quotedOutcome: SolverQuoteInput['quotedOutcome'];
    if (exit) {
      const pricing = priceSolanaDevnetExit(config, state.market, state.oraclePricePerLot, order.quantity.atoms);
      if (pricing.firmQuoteAtoms < order.minSpotQuoteOut!.atoms
        || pricing.spotLots * pricing.spotMinimumPerLot < order.minSpotQuoteOut!.atoms) {
        fail('firm bid is below the order minimum');
      }
      if (venueCap === undefined || pricing.perpFeeAtoms > venueCap.maxAtoms) fail('perp taker fee exceeds the order cap');
      const entryNotional = await readOpenShort(order, state.slot, pricing.perpLots);
      // exitQuoteOutcome v1: wallet quote delta plus the venue-withdrawable delta (short PnL less fee).
      const outcome = pricing.firmQuoteAtoms + entryNotional - pricing.perpNotionalAtoms - pricing.perpFeeAtoms;
      if (outcome < order.minExitQuoteOutcome!.atoms) fail('exit outcome is below the order minimum');
      leg = { ...pricing, spotLimitPerLot: pricing.spotMinimumPerLot };
      quotedOutcome = { kind: 'EXIT_QUOTE_OUTCOME', exitQuoteOutcome: { asset: quoteAsset, atoms: outcome } };
    } else {
      const pricing = priceSolanaDevnetEntry(config, state.market, state.oraclePricePerLot, order.quantity.atoms);
      if (pricing.spotLots * pricing.spotLimitPerLot > order.maxSpotQuoteIn!.atoms) fail('firm spot price exceeds the order bound');
      if (venueCap === undefined || pricing.perpFeeAtoms > venueCap.maxAtoms) fail('perp taker fee exceeds the order cap');
      const spreadQuoteAtoms = pricing.firmQuoteAtoms - pricing.perpNotionalAtoms + pricing.perpFeeAtoms;
      const maxSpread = order.maxEntrySpread;
      if (maxSpread === undefined || spreadQuoteAtoms * maxSpread.baseAtoms > maxSpread.quoteAtoms * order.quantity.atoms) {
        fail('entry spread is worse than the order maximum');
      }
      leg = pricing;
      quotedOutcome = {
        kind: 'ENTRY_SPREAD',
        entrySpread: { baseAsset, quoteAsset, quoteAtoms: spreadQuoteAtoms, baseAtoms: order.quantity.atoms, roundingDirection: 'CEIL' },
      };
    }
    const side = exit ? QUOTE_SIDE_BID : QUOTE_SIDE_ASK;
    const units = order.quantity.atoms / config.series.spotBaseAtomsPerPackageUnit;
    const latestExpiry = order.expiryValue < state.slot + config.quoteTtlSlots ? order.expiryValue : state.slot + config.quoteTtlSlots;
    if (latestExpiry - state.slot > state.reservationClass.maxTtlSlots) fail('quote TTL exceeds the reservation class TTL');
    // A route expiry must leave time to fund, lock, and sign; at least a third of the TTL.
    const minimumExpiry = state.slot + config.quoteTtlSlots / 3n;
    let level = selectFirmLevel(state, config, units, minimumExpiry, latestExpiry, side);
    if (level === undefined) {
      if (dependencies.writer === undefined) fail('no usable firm level and solver writes are disabled');
      const writer = dependencies.writer;
      // Every user quotes against the one shard, and a level write must name the shard's next
      // sequence. Writes are serialized here, and the shard is re-read under the lock: a request that
      // waited may find the level another request just wrote, and never sends a stale sequence.
      const written = await withShardWriteLock(config.accounts.packageBookShard, async () => {
        let current = await readSolanaDevnetQuoteState(rpc, manifest, config);
        const existing = selectFirmLevel(current, config, units, minimumExpiry, latestExpiry, side);
        if (existing !== undefined) return { state: current, level: existing };
        const plan = packageBookLevelInstructions({ manifest, config, state: current, expirySlot: latestExpiry, side });
        await writer.sendAndFinalize(plan.instructions, key.keypair);
        current = await readSolanaDevnetQuoteState(rpc, manifest, config);
        const fresh = current.levels[plan.slotIndex];
        if (fresh === undefined || fresh.levelId !== plan.levelId
          || selectFirmLevel({ ...current, levels: [fresh] }, config, units, current.slot, latestExpiry, side) === undefined) {
          fail('refreshed firm level is not usable');
        }
        return { state: current, level: fresh };
      });
      state = written.state;
      level = written.level;
    }
    const routeExpiryValue = level.expirySlot;
    const reservationNonce = dependencies.randomNonce?.() ?? Uint8Array.from(randomBytes(32));
    if (reservationNonce.length !== 32 || reservationNonce.every((byte) => byte === 0)) fail('reservation nonce is invalid');
    const reservationId = reservationIdFor(manifest.domain, config.solverId, orderHash, reservationNonce);
    const accounts = deriveSolanaDevnetFirmAccounts({
      manifest, config, market: state.market, owner: order.owner, orderHash, nonce: order.nonce, reservationId, exit,
    });
    const price = (quoteAtoms: bigint, baseAtoms: bigint, roundingDirection: 'CEIL' | 'FLOOR') => {
      const divisor = gcd(quoteAtoms, baseAtoms);
      return exactPrice({ baseAsset, quoteAsset, quoteAtoms: quoteAtoms / divisor, baseAtoms: baseAtoms / divisor, roundingDirection });
    };
    const route: RoutePayloadInput = {
      version: 1,
      environment: order.environment,
      domain: order.domain,
      orderHash,
      templateId: order.templateId,
      templateVersion: order.templateVersion,
      packageTemplateManifestHash: order.packageTemplateManifestHash,
      templateRegistryRecordHash: config.templateRegistryRecordHash,
      owner: order.owner,
      settlementAccount: order.settlementAccount,
      solver: config.solverId,
      direction: order.direction,
      action: order.action,
      quantityPolicyClass: 'EXACT_ATOMIC',
      partialFillPolicy: order.partialFillPolicy,
      settlementClass: order.settlementClass,
      executionPlanKind: 'SVM_ATOMIC_CPI',
      routeExpiryUnit: 'SOLANA_SLOT',
      routeExpiryValue,
      feePolicyVersion: config.feePolicyVersion,
      feePolicyManifestHash: config.feePolicyManifestHash,
      accountBindings: accountBindings(manifest, accounts),
      serviceCharges: [],
      preconditions: config.route.preconditions,
      legs: [
        {
          legIndex: 0, legRole: 'SPOT', actionSequence: config.spot.actionSequence, adapter: config.spot.adapter,
          venue: config.spot.venue, market: config.spot.market, baseAsset, quoteAsset, side: exit ? 'SELL' : 'BUY', quantity: order.quantity,
          limitPrice: price(leg.spotLimitPerLot, config.spotBaseLotAtoms, exit ? 'FLOOR' : 'CEIL'), timeInForce: 'FOK', reduceOnly: false,
        },
        {
          legIndex: 1, legRole: 'PERPETUAL', actionSequence: config.perpetual.actionSequence, adapter: config.perpetual.adapter,
          venue: config.perpetual.venue, market: config.perpetual.market, baseAsset, quoteAsset, side: exit ? 'BUY' : 'SELL', quantity: order.quantity,
          limitPrice: price(leg.perpLimitPerLot, state.market.baseLotAtoms, exit ? 'CEIL' : 'FLOOR'), timeInForce: 'FOK', reduceOnly: exit,
        },
      ],
      actions: config.route.actions,
      postconditions: config.route.postconditions,
      evidenceRequirements: config.route.evidenceRequirements,
    };
    const validatedRoute = routePayload(route, 'solanaDevnetRoute');
    const zeroQuote = { asset: quoteAsset, atoms: 0n };
    const unsigned: SolverQuoteInput = {
      version: 1,
      environment: order.environment,
      domain: order.domain,
      orderHash,
      solverId: config.solverId,
      solverCapabilityManifestHash: config.solverCapabilityManifestHash,
      solverSignatureScheme: 'ED25519',
      solverVerificationKey: key.verificationKey,
      quoteMode: 'FIRM_ONCHAIN',
      routeHash: routeHash(validatedRoute),
      quotedOutcome,
      expectedSpotNotional: { asset: quoteAsset, atoms: leg.firmQuoteAtoms },
      expectedPerpNotional: { asset: quoteAsset, atoms: leg.perpNotionalAtoms },
      expectedGrossSpotQuantity: order.quantity,
      expectedNetSpotQuantity: exit ? { asset: baseAsset, atoms: -order.quantity.atoms } : order.quantity,
      expectedBaseAssetFee: { asset: baseAsset, atoms: 0n },
      expectedMarginDelta: zeroQuote,
      expectedRawFillFeesByAsset: [{ asset: quoteAsset, atoms: leg.perpFeeAtoms }],
      expectedBuilderFeesByAsset: [zeroQuote],
      expectedNormalizedVenueFeesByAsset: [{ asset: quoteAsset, atoms: leg.perpFeeAtoms }],
      solverFee: zeroQuote,
      protocolFee: zeroQuote,
      expectedPriorityFee: zeroQuote,
      maxRecoveryCostAtomsByAsset: [],
      feePolicyVersion: config.feePolicyVersion,
      feePolicyManifestHash: config.feePolicyManifestHash,
      validUntilUnit: 'SOLANA_SLOT',
      validUntilValue: routeExpiryValue,
      reservationId,
      quoteNonce: dependencies.nonceSource.next(),
      signature: new Uint8Array(64),
    };
    const digest = solverSignatureDigest(unsigned);
    const signature = key.signDigest(digest);
    const publicKey = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(key.verificationKey)]), format: 'der', type: 'spki' });
    if (!verify(null, Buffer.from(digest), publicKey, Buffer.from(signature))) fail('solver signature does not verify');
    const signed = solverQuote({ ...unsigned, signature }, 'solanaDevnetQuote');
    const response: InternalAtomicQuoteResponse = Object.freeze({
      version: 1,
      status: 'SIGNED',
      idempotencyKey: request.idempotencyKey,
      orderHash: request.orderHash,
      routeHash: hex(routeHash(validatedRoute)),
      quoteHash: hex(quoteHash(signed)),
      solverSignatureDigest: hex(solverSignatureDigest(signed)),
      routeBytes: hex(routePayloadBytes(validatedRoute)),
      solverQuoteBytes: hex(solverQuoteBytes(signed)),
      route: toProtocolJson(validatedRoute, 'route'),
      quote: toProtocolJson(signed, 'quote'),
    });
    return journal.save({
      orderHash: request.orderHash,
      idempotencyKey: request.idempotencyKey,
      reservationNonceHex: hex(reservationNonce),
      slotIndex: level.slotIndex,
      levelId: level.levelId,
      response,
    }).response;
  }

  return Object.freeze({
    async quote(request: InternalAtomicQuoteRequest): Promise<InternalAtomicQuoteResponse> {
      if (typeof request?.orderHash !== 'string' || !HASH_HEX.test(request.orderHash)) return fallback.quote(request);
      const prior = journal.getByIdempotencyKey(request.idempotencyKey);
      if (prior !== undefined) {
        if (prior.orderHash !== request.orderHash) {
          throw new InternalAtomicQuoteError('IDEMPOTENCY_CONFLICT', 'idempotencyKey is already bound to a different order');
        }
        return prior.response;
      }
      const supplied = await dependencies.orders(Uint8Array.from(Buffer.from(request.orderHash, 'hex')) as Hash32);
      if (supplied === undefined || supplied.domain.domainId !== 'svm:devnet') return fallback.quote(request);
      const order = validatePackageOrderProfile(supplied, 'packageOrder');
      if (hex(packageOrderHash(order)) !== request.orderHash) {
        throw new InternalAtomicQuoteError('ORDER_HASH_MISMATCH', 'stored order does not match the requested hash');
      }
      const existing = journal.get(request.orderHash);
      if (existing !== undefined) {
        throw new InternalAtomicQuoteError('IDEMPOTENCY_CONFLICT', 'order already has a firm quote under another key');
      }
      const active = pending.get(request.orderHash);
      if (active !== undefined) return active;
      const task = sign(order, request);
      pending.set(request.orderHash, task);
      try {
        return await task;
      } finally {
        pending.delete(request.orderHash);
      }
    },
  });
}
