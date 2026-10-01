import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { createPublicClient, createWalletClient, getAddress, http, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { chainIdentity, rpcUrl, verifyRpcIdentity, type FetchLike } from './chain-identity.js';

// Funding mirror: reads the real Hyperliquid mainnet funding rate (signerless Info API read) and
// sets the same rate on the Naryx test perpetual markets on Base Sepolia and Solana Devnet, so a
// testnet strategy accrues funding the way the mainnet venue would charge it. Only these two
// testnet chain references are accepted; every pass verifies chain identity from chain data
// before reading or writing a market.

/** The only read source. Mainnet Info API reads carry no signer and no exchange surface. */
export const HYPERLIQUID_MAINNET_FUNDING_INFO_URL = 'https://api.hyperliquid.xyz/info';
export const BASE_SEPOLIA_CHAIN_REF = 'eip155:84532';
export const SOLANA_DEVNET_CHAIN_REF = 'solana:devnet';

const SECONDS_PER_HOUR = 3600n;
/** EVM test market: quote WAD per one base unit per second (absolute, not a fraction of notional). */
const WAD = 10n ** 18n;
/** Solana test market: fraction of oracle notional per second scaled by 1e12 (FUNDING_RATE_SCALE). */
const SOLANA_FUNDING_RATE_SCALE = 10n ** 12n;
const EVM_MAX_FUNDING_RATE_PER_SECOND = 10n ** 17n;
const SOLANA_MAX_FUNDING_RATE_PER_SECOND = 1_000_000n;
const I64_MAX = (1n << 63n) - 1n;
const DECIMAL = /^(-?)(0|[1-9][0-9]{0,30})(?:\.([0-9]{1,30}))?$/;
const COIN = /^[A-Z0-9]{1,16}$/;
const MARKET_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const UNSIGNED = /^(0|[1-9][0-9]{0,30})$/;

// Anchor discriminators and Borsh offsets from deployments/solana/devnet/test-perp/idl/naryx_test_perp.json.
const SET_FUNDING_RATE_DISCRIMINATOR = Uint8Array.from([113, 127, 53, 135, 107, 37, 58, 65]);
const TEST_PERP_MARKET_DISCRIMINATOR = Uint8Array.from([86, 79, 229, 187, 233, 172, 84, 21]);
const MARKET_FUNDING_KEEPER_OFFSET = 40;
const MARKET_ORACLE_OFFSET = 104;
const MARKET_MAX_FUNDING_RATE_OFFSET = 318;
const MARKET_FUNDING_RATE_OFFSET = 326;

const EVM_MARKET_ABI = [
  { type: 'function', name: 'fundingKeeper', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'maxAbsFundingRatePerSecond', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint128' }] },
  { type: 'function', name: 'fundingRatePerSecond', stateMutability: 'view', inputs: [], outputs: [{ type: 'int256' }] },
  { type: 'function', name: 'setFundingRatePerSecond', stateMutability: 'nonpayable', inputs: [{ name: 'ratePerSecond', type: 'int256' }], outputs: [] },
] as const;

/** A finite decimal as an exact rational `numerator / denominator`; no float ever touches a rate. */
export interface ExactDecimal {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

export function parseExactDecimal(value: unknown, context: string): ExactDecimal {
  if (typeof value !== 'string') throw new Error(`${context} must be a decimal string`);
  const match = DECIMAL.exec(value);
  if (match === null) throw new Error(`${context} is not a plain decimal`);
  const fraction = match[3] ?? '';
  const magnitude = BigInt(`${match[2]}${fraction}`);
  return { numerator: match[1] === '-' ? -magnitude : magnitude, denominator: 10n ** BigInt(fraction.length) };
}

/** Truncates toward zero, so a mirrored rate never exceeds the venue's magnitude. */
function divideTowardZero(numerator: bigint, denominator: bigint): bigint {
  return numerator / denominator;
}

/** Hyperliquid hourly funding fraction to the Solana market unit: fraction per second times 1e12. */
export function solanaRateFromHourlyFunding(hourly: ExactDecimal): bigint {
  return divideTowardZero(hourly.numerator * SOLANA_FUNDING_RATE_SCALE, hourly.denominator * SECONDS_PER_HOUR);
}

/**
 * Hyperliquid hourly funding fraction to the EVM market unit. The EVM market accrues an absolute
 * quote amount per base unit, so the fraction is applied to the Hyperliquid oracle price, the price
 * Hyperliquid itself charges funding against: hourly * oraclePx * 1e18 / 3600.
 */
export function evmRateFromHourlyFunding(hourly: ExactDecimal, oraclePx: ExactDecimal): bigint {
  if (oraclePx.numerator <= 0n) throw new Error('oracle price must be positive');
  return divideTowardZero(hourly.numerator * oraclePx.numerator * WAD, hourly.denominator * oraclePx.denominator * SECONDS_PER_HOUR);
}

export function clampToBound(rate: bigint, bound: bigint): { readonly rate: bigint; readonly clamped: boolean } {
  if (bound < 0n) throw new Error('funding bound must be nonnegative');
  if (rate > bound) return { rate: bound, clamped: true };
  if (rate < -bound) return { rate: -bound, clamped: true };
  return { rate, clamped: false };
}

export interface VenueFunding {
  readonly funding: ExactDecimal;
  readonly oraclePx: ExactDecimal;
  readonly fundingText: string;
  readonly oraclePxText: string;
}

export interface FundingSource {
  read(coins: readonly string[]): Promise<ReadonlyMap<string, VenueFunding>>;
}

/** Signerless read of `metaAndAssetCtxs` from the pinned Hyperliquid mainnet Info API. */
export function hyperliquidMainnetFundingSource(fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike): FundingSource {
  return {
    async read(coins) {
      const response = await fetchImpl(HYPERLIQUID_MAINNET_FUNDING_INFO_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
      });
      if (!response.ok) throw new Error(`Hyperliquid metaAndAssetCtxs answered ${response.status}`);
      const body = await response.json();
      if (!Array.isArray(body) || body.length !== 2) throw new Error('metaAndAssetCtxs returned an unexpected shape');
      const universe = (body[0] as { universe?: unknown }).universe;
      const contexts = body[1];
      if (!Array.isArray(universe) || !Array.isArray(contexts) || universe.length !== contexts.length) {
        throw new Error('metaAndAssetCtxs universe and contexts do not align');
      }
      const result = new Map<string, VenueFunding>();
      for (const coin of coins) {
        const matches = universe.flatMap((entry, index) => ((entry as { name?: unknown }).name === coin ? [index] : []));
        if (matches.length !== 1) throw new Error(`metaAndAssetCtxs has ${matches.length} perpetuals named ${coin}`);
        const context = contexts[matches[0] as number] as { funding?: unknown; oraclePx?: unknown };
        result.set(coin, {
          funding: parseExactDecimal(context.funding, `${coin} funding`),
          oraclePx: parseExactDecimal(context.oraclePx, `${coin} oraclePx`),
          fundingText: String(context.funding),
          oraclePxText: String(context.oraclePx),
        });
      }
      return result;
    },
  };
}

export interface MarketState {
  readonly keeperAuthorized: boolean;
  readonly bound: bigint;
  readonly currentRate: bigint;
}

/** One test market on one verified chain. `verifyIdentity` runs before any read or write. */
export interface FundingMarketPort {
  verifyIdentity(): Promise<void>;
  readMarket(): Promise<MarketState>;
  submit(rate: bigint): Promise<string>;
}

export interface FundingMarketConfig {
  readonly id: string;
  readonly chainRef: typeof BASE_SEPOLIA_CHAIN_REF | typeof SOLANA_DEVNET_CHAIN_REF;
  readonly market: string;
  readonly programId?: string;
  readonly coin: string;
  /** Skip when |target - current onchain rate| is below this, in the market's native rate units. */
  readonly minChange: bigint;
}

export interface FundingSubmissionRecord {
  readonly rate: string;
  readonly transaction: string;
  readonly submittedAtMs: number;
  readonly sourceFunding: string;
  readonly sourceOraclePx: string;
  readonly clamped: boolean;
}

/** Durable last-submitted record per market: one JSON file, replaced atomically after fsync. */
export class FundingSubmissionRecordFile {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  read(): Record<string, FundingSubmissionRecord> {
    if (!existsSync(this.#path)) return {};
    const parsed: unknown = JSON.parse(readFileSync(this.#path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('funding record file is malformed');
    return parsed as Record<string, FundingSubmissionRecord>;
  }

  write(marketId: string, record: FundingSubmissionRecord): void {
    const next = { ...this.read(), [marketId]: record };
    const temporary = `${this.#path}.tmp`;
    const fd = openSync(temporary, 'w', 0o600);
    try {
      writeSync(fd, `${JSON.stringify(next, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, this.#path);
  }
}

export type FundingMirrorStatus = 'SUBMITTED' | 'DRY_RUN' | 'SKIPPED_BELOW_THRESHOLD' | 'FAILED';

export interface FundingMirrorResult {
  readonly marketId: string;
  readonly status: FundingMirrorStatus;
  readonly targetRate?: bigint;
  readonly currentRate?: bigint;
  readonly clamped?: boolean;
  readonly transaction?: string;
  readonly detail?: string;
}

export interface FundingMirrorPassInput {
  readonly markets: readonly FundingMarketConfig[];
  readonly source: FundingSource;
  readonly ports: ReadonlyMap<string, FundingMarketPort>;
  readonly record: Pick<FundingSubmissionRecordFile, 'write'>;
  readonly writesEnabled: boolean;
  readonly nowMs: () => number;
  readonly log: (line: string) => void;
}

function targetRate(market: FundingMarketConfig, venue: VenueFunding): bigint {
  return market.chainRef === BASE_SEPOLIA_CHAIN_REF ? evmRateFromHourlyFunding(venue.funding, venue.oraclePx) : solanaRateFromHourlyFunding(venue.funding);
}

export async function runFundingMirrorPass(input: FundingMirrorPassInput): Promise<FundingMirrorResult[]> {
  const venue = await input.source.read([...new Set(input.markets.map((market) => market.coin))]);
  const results: FundingMirrorResult[] = [];
  for (const market of input.markets) {
    try {
      const port = input.ports.get(market.id);
      const funding = venue.get(market.coin);
      if (port === undefined || funding === undefined) throw new Error('market has no port or venue funding');
      await port.verifyIdentity();
      const state = await port.readMarket();
      const raw = targetRate(market, funding);
      const { rate, clamped } = clampToBound(raw, state.bound);
      if (clamped) input.log(`Funding mirror ${market.id}: ${market.coin} funding ${funding.fundingText}/h converts to ${raw}, clamped to market bound ${rate}`);
      const delta = rate > state.currentRate ? rate - state.currentRate : state.currentRate - rate;
      const base = { marketId: market.id, targetRate: rate, currentRate: state.currentRate, clamped };
      if (delta < market.minChange || delta === 0n) {
        results.push({ ...base, status: 'SKIPPED_BELOW_THRESHOLD' });
        continue;
      }
      if (!input.writesEnabled) {
        results.push({ ...base, status: 'DRY_RUN' });
        continue;
      }
      if (!state.keeperAuthorized) throw new Error('loaded key is not the market funding keeper');
      const transaction = await port.submit(rate);
      input.record.write(market.id, {
        rate: rate.toString(),
        transaction,
        submittedAtMs: input.nowMs(),
        sourceFunding: funding.fundingText,
        sourceOraclePx: funding.oraclePxText,
        clamped,
      });
      results.push({ ...base, status: 'SUBMITTED', transaction });
    } catch (error) {
      results.push({ marketId: market.id, status: 'FAILED', detail: error instanceof Error ? error.message : 'unknown error' });
    }
  }
  return results;
}

export interface FundingMirrorConfig {
  readonly intervalMs: number;
  readonly recordPath: string;
  readonly writesEnabled: boolean;
  readonly evmKeyPath?: string;
  readonly solanaKeyPath?: string;
  readonly markets: readonly FundingMarketConfig[];
}

function absolutePath(value: unknown, context: string): string {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error(`${context} must be an absolute path`);
  return value;
}

/**
 * Off unless NARYX_FUNDING_MIRROR_CONFIG names a config file. Writes stay off (dry run) unless
 * NARYX_FUNDING_MIRROR_WRITES is exactly `enabled`, and then need the keeper key file for every
 * chain that has a market. Only Base Sepolia and Solana Devnet markets are accepted.
 */
export function loadFundingMirrorConfig(environment: NodeJS.ProcessEnv, readText: (path: string) => string): FundingMirrorConfig | undefined {
  const configPath = environment.NARYX_FUNDING_MIRROR_CONFIG;
  if (configPath === undefined || configPath === '') return undefined;
  const raw = JSON.parse(readText(absolutePath(configPath, 'NARYX_FUNDING_MIRROR_CONFIG'))) as Record<string, unknown>;
  const intervalMs = raw.intervalMs;
  if (typeof intervalMs !== 'number' || !Number.isSafeInteger(intervalMs) || intervalMs < 60_000) throw new Error('funding mirror intervalMs must be an integer of at least 60000');
  if (!Array.isArray(raw.markets) || raw.markets.length === 0) throw new Error('funding mirror markets must be a nonempty array');
  const ids = new Set<string>();
  const markets = raw.markets.map((entry: Record<string, unknown>): FundingMarketConfig => {
    const { id, chainRef, market, programId, coin, minChange } = entry;
    if (typeof id !== 'string' || !MARKET_ID.test(id) || ids.has(id)) throw new Error('funding mirror market id must be unique lowercase kebab case');
    ids.add(id);
    if (typeof coin !== 'string' || !COIN.test(coin)) throw new Error(`${id} coin must be a Hyperliquid perpetual name`);
    if (typeof minChange !== 'string' || !UNSIGNED.test(minChange)) throw new Error(`${id} minChange must be an unsigned integer string`);
    if (chainRef === BASE_SEPOLIA_CHAIN_REF) {
      if (typeof market !== 'string') throw new Error(`${id} market must be an address`);
      return { id, chainRef, market: getAddress(market), coin, minChange: BigInt(minChange) };
    }
    if (chainRef === SOLANA_DEVNET_CHAIN_REF) {
      if (typeof market !== 'string' || typeof programId !== 'string') throw new Error(`${id} needs market and programId public keys`);
      return { id, chainRef, market: new PublicKey(market).toBase58(), programId: new PublicKey(programId).toBase58(), coin, minChange: BigInt(minChange) };
    }
    throw new Error(`${id} chainRef must be ${BASE_SEPOLIA_CHAIN_REF} or ${SOLANA_DEVNET_CHAIN_REF}`);
  });
  const writesEnabled = environment.NARYX_FUNDING_MIRROR_WRITES === 'enabled';
  const evmKey = environment.NARYX_FUNDING_KEEPER_EVM_KEY_FILE;
  const solanaKey = environment.NARYX_FUNDING_KEEPER_SOLANA_KEY_FILE;
  const needs = (chainRef: string) => markets.some((market) => market.chainRef === chainRef);
  if (writesEnabled && needs(BASE_SEPOLIA_CHAIN_REF) && (evmKey === undefined || evmKey === '')) throw new Error('NARYX_FUNDING_KEEPER_EVM_KEY_FILE is required for Base Sepolia writes');
  if (writesEnabled && needs(SOLANA_DEVNET_CHAIN_REF) && (solanaKey === undefined || solanaKey === '')) throw new Error('NARYX_FUNDING_KEEPER_SOLANA_KEY_FILE is required for Solana Devnet writes');
  return {
    intervalMs,
    recordPath: absolutePath(raw.recordPath, 'funding mirror recordPath'),
    writesEnabled,
    ...(evmKey === undefined || evmKey === '' ? {} : { evmKeyPath: absolutePath(evmKey, 'NARYX_FUNDING_KEEPER_EVM_KEY_FILE') }),
    ...(solanaKey === undefined || solanaKey === '' ? {} : { solanaKeyPath: absolutePath(solanaKey, 'NARYX_FUNDING_KEEPER_SOLANA_KEY_FILE') }),
    markets,
  };
}

/** Reads a 0x-prefixed 32-byte hex key; the key value never appears in an error. */
export function loadEvmKeeperAccount(text: string) {
  const key = text.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('EVM keeper key file must hold one 0x-prefixed 32-byte hex key');
  return privateKeyToAccount(key as Hex);
}

/** Reads a Solana CLI keypair file (JSON array of 64 bytes). */
export function loadSolanaKeeperKeypair(text: string): Keypair {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed) || parsed.length !== 64 || !parsed.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
    throw new Error('Solana keeper key file must be a 64-byte JSON keypair');
  }
  return Keypair.fromSecretKey(Uint8Array.from(parsed as number[]));
}

/** Base Sepolia port. The account signs only `setFundingRatePerSecond` on the configured market. */
export function baseSepoliaFundingPort(rpc: string, marketAddress: string, account: ReturnType<typeof privateKeyToAccount> | undefined, fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike): FundingMarketPort {
  const url = rpcUrl(rpc, BASE_SEPOLIA_CHAIN_REF);
  const identity = chainIdentity(BASE_SEPOLIA_CHAIN_REF);
  const address = getAddress(marketAddress) as Address;
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(url) });
  const read = <const name extends 'fundingKeeper' | 'maxAbsFundingRatePerSecond' | 'fundingRatePerSecond'>(functionName: name) =>
    publicClient.readContract({ address, abi: EVM_MARKET_ABI, functionName });
  return {
    verifyIdentity: () => verifyRpcIdentity(fetchImpl, url, identity),
    async readMarket() {
      const [keeper, bound, currentRate] = await Promise.all([read('fundingKeeper'), read('maxAbsFundingRatePerSecond'), read('fundingRatePerSecond')]);
      if (bound > EVM_MAX_FUNDING_RATE_PER_SECOND) throw new Error('market bound exceeds the contract maximum');
      return { keeperAuthorized: account !== undefined && getAddress(keeper) === account.address, bound, currentRate };
    },
    async submit(rate) {
      if (account === undefined) throw new Error('no Base Sepolia keeper key loaded');
      if ((await publicClient.getChainId()) !== baseSepolia.id) throw new Error('Base Sepolia chain id changed before submission');
      const { request } = await publicClient.simulateContract({ account, address, abi: EVM_MARKET_ABI, functionName: 'setFundingRatePerSecond', args: [rate] });
      const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(url) });
      const hash = await wallet.writeContract(request);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error(`setFundingRatePerSecond reverted in ${hash}`);
      return hash;
    },
  };
}

function readI64(data: Uint8Array, offset: number): bigint {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigInt64(offset, true);
}

/** Solana Devnet port. The keypair signs only `set_funding_rate` on the configured market. */
export function solanaDevnetFundingPort(rpc: string, marketKey: string, programKey: string, keeper: Keypair | undefined, fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike): FundingMarketPort {
  const url = rpcUrl(rpc, SOLANA_DEVNET_CHAIN_REF);
  const identity = chainIdentity(SOLANA_DEVNET_CHAIN_REF);
  const market = new PublicKey(marketKey);
  const programId = new PublicKey(programKey);
  const connection = new Connection(url, 'confirmed');
  let oracle: PublicKey | undefined;
  return {
    verifyIdentity: () => verifyRpcIdentity(fetchImpl, url, identity),
    async readMarket() {
      const account = await connection.getAccountInfo(market, 'confirmed');
      if (account === null || !account.owner.equals(programId)) throw new Error('market account is missing or not owned by the test perp program');
      const data = account.data;
      if (data.length < MARKET_FUNDING_RATE_OFFSET + 8 || !TEST_PERP_MARKET_DISCRIMINATOR.every((byte, index) => data[index] === byte)) throw new Error('account is not a TestPerpMarket');
      const fundingKeeper = new PublicKey(data.subarray(MARKET_FUNDING_KEEPER_OFFSET, MARKET_FUNDING_KEEPER_OFFSET + 32));
      oracle = new PublicKey(data.subarray(MARKET_ORACLE_OFFSET, MARKET_ORACLE_OFFSET + 32));
      const bound = readI64(data, MARKET_MAX_FUNDING_RATE_OFFSET);
      if (bound < 0n || bound > SOLANA_MAX_FUNDING_RATE_PER_SECOND) throw new Error('market bound is outside the program maximum');
      return { keeperAuthorized: keeper !== undefined && fundingKeeper.equals(keeper.publicKey), bound, currentRate: readI64(data, MARKET_FUNDING_RATE_OFFSET) };
    },
    async submit(rate) {
      if (keeper === undefined || oracle === undefined) throw new Error('no Solana Devnet keeper key loaded or market not read');
      if (rate > I64_MAX || rate < -I64_MAX) throw new Error('rate does not fit i64');
      if (identity.chain !== 'SVM' || (await connection.getGenesisHash()) !== identity.genesisHash) throw new Error('Solana Devnet genesis changed before submission');
      const data = new Uint8Array(16);
      data.set(SET_FUNDING_RATE_DISCRIMINATOR, 0);
      new DataView(data.buffer).setBigInt64(8, rate, true);
      const instruction = new TransactionInstruction({
        programId,
        keys: [
          { pubkey: keeper.publicKey, isSigner: true, isWritable: false },
          { pubkey: market, isSigner: false, isWritable: true },
          { pubkey: oracle, isSigner: false, isWritable: false },
        ],
        data: Buffer.from(data),
      });
      const latest = await connection.getLatestBlockhash('confirmed');
      const transaction = new Transaction({ feePayer: keeper.publicKey, ...latest }).add(instruction);
      transaction.sign(keeper);
      const signature = await connection.sendRawTransaction(transaction.serialize());
      const confirmation = await connection.confirmTransaction({ signature, ...latest }, 'confirmed');
      if (confirmation.value.err !== null) throw new Error(`set_funding_rate failed in ${signature}`);
      return signature;
    },
  };
}
