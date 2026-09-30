import { createHash, createPrivateKey, sign, type KeyObject } from 'node:crypto';
import {
  normalizeHyperliquidPerpPositions,
  normalizeHyperliquidSpotBalances,
  type HyperliquidClearinghouseStateLike,
  type HyperliquidPositionBinding,
  type HyperliquidSpotClearinghouseStateLike,
} from '@naryx/adapter-hyperliquid';
import {
  positionSnapshotRecordHash,
  toHex,
  toProtocolJson,
  type AssetRef,
  type DomainRef,
  type PositionSnapshotRecordInput,
} from '@naryx/protocol-types';

/** The read-only HyperCore views a position snapshot needs. */
export interface PositionInfoReader {
  clearinghouseState(user: `0x${string}`): Promise<HyperliquidClearinghouseStateLike>;
  spotClearinghouseState(user: `0x${string}`): Promise<HyperliquidSpotClearinghouseStateLike>;
  allMids(): Promise<Readonly<Record<string, string>>>;
}

export interface WatchedPositionAccount {
  readonly strategyAccount: string;
  readonly user: `0x${string}`;
  readonly sourceId: string;
  readonly snapshotPrefix: string;
  readonly domain: DomainRef;
  readonly quoteAsset: AssetRef;
  readonly perpBindings: readonly HyperliquidPositionBinding[];
  readonly spotBindings: readonly HyperliquidPositionBinding[];
}

export interface PositionSnapshotPassResult {
  readonly strategyAccount: string;
  readonly status: 'PUBLISHED' | 'FAILED';
  readonly recordHash?: string;
  readonly positionCount?: number;
  readonly detail?: string;
}

/**
 * Reads each watched account, normalizes its perpetual and spot holdings, and publishes one signed
 * snapshot per account. The key signs observations only; it holds no authority over any account.
 * The record binds the hash of the exact responses it was built from, so the observation can be
 * checked against them later. One account failing never stops the others.
 */
export async function runPositionSnapshotPass(input: {
  readonly environment: string;
  readonly accounts: readonly WatchedPositionAccount[];
  readonly reader: PositionInfoReader;
  readonly authority: string;
  readonly signHash: (hash: Uint8Array) => Uint8Array;
  readonly publish: (record: PositionSnapshotRecordInput) => Promise<void>;
  readonly nowMs: () => number;
}): Promise<readonly PositionSnapshotPassResult[]> {
  const results: PositionSnapshotPassResult[] = [];
  const needsMids = input.accounts.some((account) => account.spotBindings.length > 0);
  let mids: Readonly<Record<string, string>> = {};
  try {
    if (needsMids) mids = await input.reader.allMids();
  } catch (error) {
    return input.accounts.map((account) => ({ strategyAccount: account.strategyAccount, status: 'FAILED' as const, detail: `mid prices unavailable: ${(error as Error).message}` }));
  }
  for (const account of input.accounts) {
    try {
      const perp = await input.reader.clearinghouseState(account.user);
      const spot = account.spotBindings.length === 0 ? { balances: [] } : await input.reader.spotClearinghouseState(account.user);
      const observedAtMs = input.nowMs();
      const context = { domain: account.domain, owner: account.strategyAccount, quoteAsset: account.quoteAsset, snapshotPrefix: account.snapshotPrefix };
      const perpSnapshot = normalizeHyperliquidPerpPositions(perp, { ...context, bindings: account.perpBindings });
      const spotSnapshot = normalizeHyperliquidSpotBalances(spot, mids, perp.time, { ...context, bindings: account.spotBindings });
      const evidence = createHash('sha256')
        .update(JSON.stringify({ clearinghouseState: perp, spotClearinghouseState: spot, mids: account.spotBindings.length === 0 ? {} : mids }))
        .digest();
      const unsigned: PositionSnapshotRecordInput = {
        recordVersion: 1,
        environment: input.environment,
        strategyAccount: account.strategyAccount,
        sourceId: account.sourceId,
        observedAtMs: BigInt(Math.max(observedAtMs, perp.time)),
        positions: [...perpSnapshot.positions, ...spotSnapshot.positions],
        unmappedInstruments: [...new Set([...perpSnapshot.unmappedCoins, ...spotSnapshot.unmappedCoins])].slice(0, 64),
        sourceEvidenceHash: new Uint8Array(evidence),
        authority: input.authority,
        signature: new Uint8Array(0),
      };
      const hash = positionSnapshotRecordHash(unsigned);
      const record = { ...unsigned, signature: input.signHash(hash) };
      await input.publish(record);
      results.push({ strategyAccount: account.strategyAccount, status: 'PUBLISHED', recordHash: toHex(hash), positionCount: record.positions.length });
    } catch (error) {
      results.push({ strategyAccount: account.strategyAccount, status: 'FAILED', detail: error instanceof Error ? error.message : 'unknown error' });
    }
  }
  return results;
}

/** An Ed25519 PKCS#8 PEM signer for snapshot hashes. */
export function ed25519HashSigner(pem: string): (hash: Uint8Array) => Uint8Array {
  const key: KeyObject = createPrivateKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('the position authority key must be Ed25519');
  return (hash) => new Uint8Array(sign(null, hash, key));
}

/** Publishes a snapshot to the public API, which verifies the signature before storing it. */
export function httpSnapshotPublisher(
  apiBaseUrl: string,
  fetcher: (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }> = fetch,
): (record: PositionSnapshotRecordInput) => Promise<void> {
  const base = apiBaseUrl.replace(/\/+$/, '');
  return async (record) => {
    const response = await fetcher(`${base}/v1/position-snapshots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(toProtocolJson({ record })),
    });
    if (!response.ok) throw new Error(`snapshot publish failed with ${response.status}: ${(await response.text()).slice(0, 200)}`);
  };
}

export interface PositionSnapshotConfig {
  readonly intervalMs: number;
  readonly environment: string;
  readonly apiBaseUrl: string;
  readonly authority: string;
  readonly authorityKeyPath: string;
  readonly accounts: readonly WatchedPositionAccount[];
}

/**
 * Off unless NARYX_POSITION_WATCHLIST names a watchlist. The watchlist is protocol JSON with
 * intervalMs, environment, apiBaseUrl, authority, and accounts; NARYX_POSITION_AUTHORITY_KEY_FILE
 * names the absolute path of the Ed25519 PKCS#8 PEM key that signs snapshots.
 */
export function loadPositionSnapshotConfig(
  environment: NodeJS.ProcessEnv,
  readText: (path: string) => string,
  parse: (text: string) => unknown,
): PositionSnapshotConfig | undefined {
  const path = environment.NARYX_POSITION_WATCHLIST;
  if (path === undefined || path === '') return undefined;
  const fail = (message: string): never => {
    throw new Error(`Position watchlist: ${message}`);
  };
  const raw = parse(readText(path)) as Record<string, unknown>;
  if (typeof raw !== 'object' || raw === null) fail('must be an object');
  if (typeof raw.intervalMs !== 'number' || !Number.isSafeInteger(raw.intervalMs) || raw.intervalMs < 5_000) fail('intervalMs must be at least 5000');
  if (typeof raw.environment !== 'string' || raw.environment === 'mainnet') fail('environment must be a non-mainnet environment id');
  if (typeof raw.apiBaseUrl !== 'string' || !/^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?)/.test(raw.apiBaseUrl)) fail('apiBaseUrl must be https or a loopback http URL');
  if (typeof raw.authority !== 'string' || raw.authority === '') fail('authority must name the signing key id');
  if (!Array.isArray(raw.accounts) || raw.accounts.length === 0 || raw.accounts.length > 64) fail('accounts must list 1 to 64 accounts');
  const keyPath = environment.NARYX_POSITION_AUTHORITY_KEY_FILE;
  if (keyPath === undefined || !keyPath.startsWith('/')) fail('NARYX_POSITION_AUTHORITY_KEY_FILE must be an absolute path');
  const accounts = (raw.accounts as Record<string, unknown>[]).map((account, index) => {
    if (typeof account.user !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(account.user)) fail(`accounts[${index}].user must be a 20-byte hex address`);
    for (const field of ['strategyAccount', 'sourceId', 'snapshotPrefix']) {
      if (typeof account[field] !== 'string' || account[field] === '') fail(`accounts[${index}].${field} is required`);
    }
    if (!Array.isArray(account.perpBindings) || !Array.isArray(account.spotBindings)) fail(`accounts[${index}] needs perpBindings and spotBindings`);
    return account as unknown as WatchedPositionAccount;
  });
  return Object.freeze({
    intervalMs: raw.intervalMs as number,
    environment: raw.environment as string,
    apiBaseUrl: raw.apiBaseUrl as string,
    authority: raw.authority as string,
    authorityKeyPath: keyPath as string,
    accounts,
  });
}
