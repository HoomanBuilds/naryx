import { createHash } from 'node:crypto';
import { decimalToAtoms } from '@naryx/adapter-hyperliquid';
import {
  assetRef,
  collateralSnapshotHash,
  toHex,
  toProtocolJson,
  type AssetRef,
  type CollateralSnapshotInput,
} from '@naryx/protocol-types';

export interface CollateralInfoReader {
  clearinghouseState(user: `0x${string}`): Promise<{
    readonly time: number;
    readonly withdrawable: string;
  }>;
}

export interface WatchedCollateralAccount {
  readonly strategyAccount: string;
  readonly user: `0x${string}`;
  readonly owner: string;
  readonly sourceId: string;
  readonly snapshotPrefix: string;
  readonly asset: AssetRef;
  readonly riskDomainId: string;
  readonly haircutBps: bigint;
  readonly withdrawalDelayMs: bigint;
}

export interface CollateralSnapshotPassResult {
  readonly strategyAccount: string;
  readonly status: 'PUBLISHED' | 'FAILED';
  readonly recordHash?: string;
  readonly availableQuoteAtoms?: bigint;
  readonly detail?: string;
}

export async function runCollateralSnapshotPass(input: {
  readonly environment: string;
  readonly accounts: readonly WatchedCollateralAccount[];
  readonly reader: CollateralInfoReader;
  readonly authority: string;
  readonly signHash: (hash: Uint8Array) => Uint8Array;
  readonly publish: (record: CollateralSnapshotInput) => Promise<void>;
  readonly nowMs: () => number;
}): Promise<readonly CollateralSnapshotPassResult[]> {
  const results: CollateralSnapshotPassResult[] = [];
  for (const account of input.accounts) {
    try {
      const state = await input.reader.clearinghouseState(account.user);
      if (!Number.isSafeInteger(state.time) || state.time < 0) throw new Error('clearinghouse time is invalid');
      const observedAtMs = Math.max(input.nowMs(), state.time);
      const available = decimalToAtoms(state.withdrawable, account.asset.decimals, 'clearinghouseState.withdrawable');
      if (available < 0n) throw new Error('withdrawable collateral is negative');
      const evidence = createHash('sha256').update(JSON.stringify(state)).digest();
      const unsigned: CollateralSnapshotInput = {
        version: 2,
        environment: input.environment,
        snapshotId: `${account.snapshotPrefix}:${observedAtMs}`,
        sourceId: account.sourceId,
        strategyAccount: account.strategyAccount,
        owner: account.owner,
        authority: input.authority,
        observedAtMs: BigInt(observedAtMs),
        asset: account.asset,
        riskDomainId: account.riskDomainId,
        mode: 'CROSS',
        ownAvailableQuoteAtoms: available,
        borrowAvailableQuoteAtoms: 0n,
        requestedBorrowQuoteAtoms: 0n,
        borrowCostQuoteAtoms: 0n,
        haircutBps: account.haircutBps,
        withdrawalDelayMs: account.withdrawalDelayMs,
        inventoryEligible: available > 0n,
        withdrawalAllowed: available > 0n,
        sourceEvidenceHash: new Uint8Array(evidence),
        signature: new Uint8Array(64),
      };
      const hash = collateralSnapshotHash(unsigned);
      const record = { ...unsigned, signature: input.signHash(hash) };
      await input.publish(record);
      results.push({
        strategyAccount: account.strategyAccount,
        status: 'PUBLISHED',
        recordHash: toHex(hash),
        availableQuoteAtoms: available,
      });
    } catch (error) {
      results.push({
        strategyAccount: account.strategyAccount,
        status: 'FAILED',
        detail: error instanceof Error ? error.message : 'unknown error',
      });
    }
  }
  return Object.freeze(results);
}

export function httpCollateralSnapshotPublisher(
  apiBaseUrl: string,
  fetcher: (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }> = fetch,
): (record: CollateralSnapshotInput) => Promise<void> {
  const base = apiBaseUrl.replace(/\/+$/, '');
  return async (record) => {
    const response = await fetcher(`${base}/v1/collateral-snapshots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(toProtocolJson({ record })),
    });
    if (!response.ok) throw new Error(`collateral snapshot publish failed with ${response.status}: ${(await response.text()).slice(0, 200)}`);
  };
}

export interface CollateralSnapshotConfig {
  readonly intervalMs: number;
  readonly environment: string;
  readonly apiBaseUrl: string;
  readonly authority: string;
  readonly authorityKeyPath: string;
  readonly accounts: readonly WatchedCollateralAccount[];
}

export function loadCollateralSnapshotConfig(
  environment: NodeJS.ProcessEnv,
  readText: (path: string) => string,
  parse: (text: string) => unknown,
): CollateralSnapshotConfig | undefined {
  const path = environment.NARYX_COLLATERAL_WATCHLIST;
  if (path === undefined || path === '') return undefined;
  const fail = (message: string): never => {
    throw new Error(`Collateral watchlist: ${message}`);
  };
  const raw = parse(readText(path)) as Record<string, unknown>;
  if (typeof raw !== 'object' || raw === null) fail('must be an object');
  if (typeof raw.intervalMs !== 'number' || !Number.isSafeInteger(raw.intervalMs) || raw.intervalMs < 5_000) fail('intervalMs must be at least 5000');
  if (typeof raw.environment !== 'string' || raw.environment.toLowerCase().includes('mainnet')) fail('environment must be a non-mainnet environment id');
  if (typeof raw.apiBaseUrl !== 'string' || !/^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?)/.test(raw.apiBaseUrl)) fail('apiBaseUrl must be https or a loopback http URL');
  if (typeof raw.authority !== 'string' || raw.authority === '') fail('authority must name the signing key id');
  if (!Array.isArray(raw.accounts) || raw.accounts.length === 0 || raw.accounts.length > 64) fail('accounts must list 1 to 64 accounts');
  const keyPath = environment.NARYX_COLLATERAL_AUTHORITY_KEY_FILE;
  if (keyPath === undefined || !keyPath.startsWith('/')) fail('NARYX_COLLATERAL_AUTHORITY_KEY_FILE must be an absolute path');
  const streams = new Set<string>();
  const accounts = (raw.accounts as Record<string, unknown>[]).map((account, index) => {
    const at = `accounts[${index}]`;
    if (typeof account.user !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(account.user)) fail(`${at}.user must be a 20-byte hex address`);
    for (const field of ['strategyAccount', 'owner', 'sourceId', 'snapshotPrefix', 'riskDomainId']) {
      if (typeof account[field] !== 'string' || account[field] === '') fail(`${at}.${field} is required`);
    }
    if (typeof account.asset !== 'object' || account.asset === null) fail(`${at}.asset is required`);
    const rawAsset = account.asset as Record<string, unknown>;
    if (typeof rawAsset.assetId !== 'string' || !(rawAsset.assetManifestHash instanceof Uint8Array) || typeof rawAsset.decimals !== 'number') {
      fail(`${at}.asset must be a protocol asset reference`);
    }
    if (typeof account.haircutBps !== 'bigint' || account.haircutBps < 0n || account.haircutBps > 10_000n) fail(`${at}.haircutBps must be between 0 and 10000`);
    if (typeof account.withdrawalDelayMs !== 'bigint' || account.withdrawalDelayMs < 0n) fail(`${at}.withdrawalDelayMs must be nonnegative`);
    const checkedAsset = assetRef(
      rawAsset.assetId as string,
      rawAsset.assetManifestHash as Uint8Array,
      rawAsset.decimals as number,
      `${at}.asset`,
    );
    const stream = `${account.strategyAccount}\u0000${account.sourceId}\u0000${checkedAsset.assetId}\u0000${account.riskDomainId}\u0000CROSS`;
    if (streams.has(stream)) fail(`${at} duplicates a collateral stream`);
    streams.add(stream);
    return Object.freeze({
      strategyAccount: account.strategyAccount as string,
      user: account.user as `0x${string}`,
      owner: account.owner as string,
      sourceId: account.sourceId as string,
      snapshotPrefix: account.snapshotPrefix as string,
      asset: checkedAsset,
      riskDomainId: account.riskDomainId as string,
      haircutBps: account.haircutBps as bigint,
      withdrawalDelayMs: account.withdrawalDelayMs as bigint,
    });
  });
  return Object.freeze({
    intervalMs: raw.intervalMs as number,
    environment: raw.environment as string,
    apiBaseUrl: raw.apiBaseUrl as string,
    authority: raw.authority as string,
    authorityKeyPath: keyPath as string,
    accounts: Object.freeze(accounts),
  });
}
