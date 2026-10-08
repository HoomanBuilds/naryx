import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { getWalletAddress } from '@nktkas/hyperliquid/signing';
import type { HyperliquidNettingResidualMarketBinding } from '@naryx/adapter-hyperliquid';
import {
  adapterRef,
  bytesEqual,
  nettingPolicyManifest,
  parseProtocolJson,
  toHex,
  versionedManifestRef,
  type NettingExternalExecutionIntent,
  type CrossBatchExternalExecutionIntent,
  type NettingInstrumentPolicy,
  type NettingPolicyManifestInput,
} from '@naryx/protocol-types';
import {
  HYPERLIQUID_SERVER_SIGNER_SCOPE,
  HYPERLIQUID_TESTNET_EXCHANGE_URL,
  HyperliquidSdkTestnetOrderSubmitter,
  HyperliquidTestnetHttpExchangeTransport,
  type HyperliquidServerSigner,
  type HyperliquidSubmissionAccount,
  type HyperliquidTestnetExchangeTransport,
} from './index.js';
import {
  HyperliquidNettingResidualTestnetRuntime,
  type HyperliquidNettingResidualRuntimeLane,
  type HyperliquidNettingResidualRuntimeLaneResolver,
} from './hyperliquid-netting-residual-runtime.js';
import { HyperliquidNettingResidualSqliteDurableJournal } from './hyperliquid-netting-residual-sqlite-journal.js';
import { HyperliquidNettingResidualTestnetSubmissionService } from './hyperliquid-netting-residual-testnet-submission.js';
import {
  HyperliquidNettingResidualTestnetHttpEvidence,
  type HyperliquidNettingResidualEvidenceBinding,
} from './hyperliquid-testnet-evidence-http.js';

export const HYPERLIQUID_NETTING_RESIDUAL_ENABLED_ENV =
  'NARYX_HYPERLIQUID_TESTNET_NETTING_RESIDUAL_ENABLED';
export const HYPERLIQUID_NETTING_RESIDUAL_CONFIG_VERSION = 1;

const ADDRESS = /^0x[0-9a-f]{40}$/;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_CONFIG_BYTES = 1_048_576;

export interface HyperliquidNettingResidualLoadedRuntime {
  readonly runtime: HyperliquidNettingResidualTestnetRuntime;
  close(): void;
}

export interface HyperliquidNettingResidualRuntimeDependencies {
  readonly signer: HyperliquidServerSigner;
  readonly transportFactory?: () => HyperliquidTestnetExchangeTransport;
  readonly fetchImplementation?: typeof fetch;
  readonly clock?: () => number;
}

function object(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], context: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${context} fields are invalid`);
  }
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required when Hyperliquid residual execution is enabled`);
  }
  return value;
}

function enabled(environment: NodeJS.ProcessEnv): boolean {
  const value = environment[HYPERLIQUID_NETTING_RESIDUAL_ENABLED_ENV];
  if (value === undefined || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error(`${HYPERLIQUID_NETTING_RESIDUAL_ENABLED_ENV} must be true or false`);
}

function address(environment: NodeJS.ProcessEnv, name: string): `0x${string}` {
  const value = required(environment, name);
  if (!ADDRESS.test(value)) throw new Error(`${name} must be a lowercase 20-byte address`);
  return value as `0x${string}`;
}

function account(environment: NodeJS.ProcessEnv): HyperliquidSubmissionAccount {
  const accountKind = required(environment, 'NARYX_HYPERLIQUID_TESTNET_ACCOUNT_KIND');
  if (accountKind !== 'MASTER' && accountKind !== 'SUBACCOUNT') {
    throw new Error('NARYX_HYPERLIQUID_TESTNET_ACCOUNT_KIND must be MASTER or SUBACCOUNT');
  }
  const masterAccount = address(environment, 'NARYX_HYPERLIQUID_TESTNET_MASTER_ACCOUNT');
  const tradingAccount = address(environment, 'NARYX_HYPERLIQUID_TESTNET_TRADING_ACCOUNT');
  if ((accountKind === 'MASTER') !== (masterAccount === tradingAccount)) {
    throw new Error('Hyperliquid account kind does not match the master and trading accounts');
  }
  return Object.freeze({ masterAccount, tradingAccount, accountKind });
}

function positiveInteger(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  maximum: number,
): number {
  const value = environment[name];
  if (value === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new Error(`${name} must be no greater than ${maximum}`);
  }
  return parsed;
}

function sameAdapter(
  left: HyperliquidNettingResidualMarketBinding['adapter'],
  right: NettingInstrumentPolicy['adapter'],
): boolean {
  return left.adapterId === right.adapterId
    && left.adapterManifestVersion === right.adapterManifestVersion
    && bytesEqual(left.adapterManifestHash, right.adapterManifestHash);
}

function sameManifest(
  left: HyperliquidNettingResidualMarketBinding['venue'],
  right: NettingInstrumentPolicy['venue'],
): boolean {
  return left.subjectId === right.subjectId
    && left.manifestVersion === right.manifestVersion
    && bytesEqual(left.manifestHash, right.manifestHash);
}

function marketBinding(value: unknown): HyperliquidNettingResidualMarketBinding {
  const raw = object(value, 'Hyperliquid residual market binding');
  exactKeys(raw, [
    'adapter', 'venue', 'market', 'assetId', 'sizeDecimals', 'maximumPriceDecimals',
  ], 'Hyperliquid residual market binding');
  if (!Number.isSafeInteger(raw.assetId) || Number(raw.assetId) < 0
    || Number(raw.assetId) > 0xffff_ffff
    || !Number.isSafeInteger(raw.sizeDecimals) || Number(raw.sizeDecimals) < 0
    || Number(raw.sizeDecimals) > 8
    || !Number.isSafeInteger(raw.maximumPriceDecimals)
    || Number(raw.maximumPriceDecimals) < 0 || Number(raw.maximumPriceDecimals) > 8) {
    throw new Error('Hyperliquid residual market numeric fields are invalid');
  }
  const venue = object(raw.venue, 'Hyperliquid residual venue');
  const market = object(raw.market, 'Hyperliquid residual market');
  return Object.freeze({
    adapter: adapterRef(raw.adapter as never),
    venue: versionedManifestRef(
      String(venue.subjectId), Number(venue.manifestVersion), venue.manifestHash as never,
    ),
    market: versionedManifestRef(
      String(market.subjectId), Number(market.manifestVersion), market.manifestHash as never,
    ),
    assetId: Number(raw.assetId),
    sizeDecimals: Number(raw.sizeDecimals),
    maximumPriceDecimals: Number(raw.maximumPriceDecimals),
  });
}

function evidenceBinding(value: unknown): HyperliquidNettingResidualEvidenceBinding {
  const raw = object(value, 'Hyperliquid residual evidence binding');
  exactKeys(raw, [
    'assetId', 'marketKind', 'baseFeeToken', 'quoteFeeToken',
  ], 'Hyperliquid residual evidence binding');
  if (!Number.isSafeInteger(raw.assetId) || Number(raw.assetId) < 0
    || Number(raw.assetId) > 0xffff_ffff
    || (raw.marketKind !== 'SPOT' && raw.marketKind !== 'PERPETUAL')
    || typeof raw.baseFeeToken !== 'string' || !TOKEN.test(raw.baseFeeToken)
    || typeof raw.quoteFeeToken !== 'string' || !TOKEN.test(raw.quoteFeeToken)
    || raw.baseFeeToken === raw.quoteFeeToken) {
    throw new Error('Hyperliquid residual evidence binding is invalid');
  }
  return Object.freeze({
    assetId: Number(raw.assetId),
    marketKind: raw.marketKind,
    baseFeeToken: raw.baseFeeToken,
    quoteFeeToken: raw.quoteFeeToken,
  });
}

export class HyperliquidNettingResidualLaneRegistry
implements HyperliquidNettingResidualRuntimeLaneResolver {
  readonly #lanes: ReadonlyMap<string, HyperliquidNettingResidualRuntimeLane>;

  constructor(path: string) {
    if (!isAbsolute(path)) {
      throw new Error('Hyperliquid residual config path must be absolute');
    }
    const resolved = resolve(path);
    if (statSync(resolved).size > MAX_CONFIG_BYTES) {
      throw new Error('Hyperliquid residual config is too large');
    }
    let parsed: unknown;
    try {
      parsed = parseProtocolJson(readFileSync(resolved, 'utf8'));
    } catch {
      throw new Error('Hyperliquid residual config is not valid protocol JSON');
    }
    const root = object(parsed, 'Hyperliquid residual config');
    exactKeys(root, ['version', 'environment', 'policy', 'bindings'], 'Hyperliquid residual config');
    if (root.version !== HYPERLIQUID_NETTING_RESIDUAL_CONFIG_VERSION
      || root.environment !== 'TESTNET' || !Array.isArray(root.bindings)
      || root.bindings.length === 0) {
      throw new Error('Hyperliquid residual config must be a nonempty Testnet version 1 config');
    }
    const policy = nettingPolicyManifest(root.policy as NettingPolicyManifestInput);
    if (policy.environment !== 'testnet'
      || policy.settlementClass !== 'BATCHED_IOC_WITH_RECOVERY'
      || policy.externalExecutionMode !== 'EXACT_NET_ONLY'
      || policy.instruments.some((instrument) => instrument.domain.domainId !== 'hypercore:testnet')) {
      throw new Error('Hyperliquid residual policy is not an exact Testnet netting policy');
    }
    const lanes = new Map<string, HyperliquidNettingResidualRuntimeLane>();
    for (const value of root.bindings) {
      const raw = object(value, 'Hyperliquid residual binding');
      exactKeys(raw, ['instrumentId', 'marketBinding', 'evidenceBinding'],
        'Hyperliquid residual binding');
      if (typeof raw.instrumentId !== 'string') {
        throw new Error('Hyperliquid residual instrument id is invalid');
      }
      const instrument = policy.instruments.find((entry) => entry.instrumentId === raw.instrumentId);
      if (instrument === undefined || lanes.has(instrument.instrumentId)) {
        throw new Error('Hyperliquid residual binding must name one unique policy instrument');
      }
      const market = marketBinding(raw.marketBinding);
      const evidence = evidenceBinding(raw.evidenceBinding);
      const expectedKind = instrument.legFamily === 'SPOT_SWAP' ? 'SPOT' : 'PERPETUAL';
      if (!sameAdapter(market.adapter, instrument.adapter)
        || !sameManifest(market.venue, instrument.venue)
        || !sameManifest(market.market, instrument.market)
        || evidence.assetId !== market.assetId
        || evidence.marketKind !== expectedKind) {
        throw new Error('Hyperliquid residual binding differs from its policy instrument');
      }
      lanes.set(instrument.instrumentId, Object.freeze({
        instrument,
        marketBinding: market,
        evidenceBinding: evidence,
      }));
    }
    if (lanes.size !== policy.instruments.length) {
      throw new Error('Hyperliquid residual bindings do not cover every policy instrument');
    }
    this.#lanes = lanes;
  }

  resolve(
    intent: NettingExternalExecutionIntent | CrossBatchExternalExecutionIntent,
  ): HyperliquidNettingResidualRuntimeLane {
    const lane = this.#lanes.get(intent.instrumentId);
    if (lane === undefined || toHex(lane.instrument.instrumentHash) !== toHex(intent.instrumentHash)) {
      throw new Error('residual intent is outside the configured netting policy');
    }
    return lane;
  }
}

export async function loadHyperliquidNettingResidualTestnetRuntime(
  environment: NodeJS.ProcessEnv,
  dependencies: HyperliquidNettingResidualRuntimeDependencies,
): Promise<HyperliquidNettingResidualLoadedRuntime | undefined> {
  if (!enabled(environment)) return undefined;
  if (required(environment, 'NARYX_HYPERLIQUID_TESTNET_ENVIRONMENT') !== 'TESTNET') {
    throw new Error('Hyperliquid residual execution environment must be TESTNET');
  }
  if (dependencies.signer.signerScope !== HYPERLIQUID_SERVER_SIGNER_SCOPE) {
    throw new Error('Hyperliquid residual execution requires the server-side Testnet signer');
  }
  const expectedAgent = address(environment, 'NARYX_HYPERLIQUID_TESTNET_AGENT_ADDRESS');
  const signerAddress = (await getWalletAddress(dependencies.signer)).toLowerCase();
  if (signerAddress !== expectedAgent) {
    throw new Error('Hyperliquid residual signer does not match the configured agent');
  }
  const configuredAccount = account(environment);
  const journal = new HyperliquidNettingResidualSqliteDurableJournal({
    databasePath: required(environment, 'NARYX_HYPERLIQUID_TESTNET_JOURNAL_DB'),
  });
  try {
    const transport = (dependencies.transportFactory
      ?? (() => new HyperliquidTestnetHttpExchangeTransport()))();
    if (transport.isTestnet !== true || transport.apiUrl !== HYPERLIQUID_TESTNET_EXCHANGE_URL) {
      throw new Error('Hyperliquid residual transport is not exact Testnet');
    }
    const keeperOrigin = required(environment, 'NARYX_HYPERLIQUID_TESTNET_KEEPER_ORIGIN');
    const runtime = new HyperliquidNettingResidualTestnetRuntime(
      new HyperliquidNettingResidualLaneRegistry(required(
        environment, 'NARYX_HYPERLIQUID_TESTNET_NETTING_RESIDUAL_CONFIG',
      )),
      journal,
      new HyperliquidNettingResidualTestnetSubmissionService(
        journal,
        new HyperliquidSdkTestnetOrderSubmitter(dependencies.signer, transport),
      ),
      new HyperliquidNettingResidualTestnetHttpEvidence({
        keeperOrigin,
        ...(dependencies.fetchImplementation === undefined
          ? {} : { fetchImplementation: dependencies.fetchImplementation }),
      }),
      {
        account: configuredAccount,
        agentWallet: expectedAgent,
        signerLeaseId: required(
          environment, 'NARYX_HYPERLIQUID_TESTNET_SIGNER_LEASE_ID',
        ),
        vaultAddress: configuredAccount.accountKind === 'SUBACCOUNT'
          ? configuredAccount.tradingAccount : null,
        maximumEvidenceAgeMs: positiveInteger(
          environment,
          'NARYX_HYPERLIQUID_TESTNET_NETTING_MAX_EVIDENCE_AGE_MS',
          60_000,
          86_400_000,
        ),
        maximumSnapshotSkewMs: positiveInteger(
          environment,
          'NARYX_HYPERLIQUID_TESTNET_NETTING_MAX_SNAPSHOT_SKEW_MS',
          5_000,
          60_000,
        ),
        maximumFillPages: positiveInteger(
          environment,
          'NARYX_HYPERLIQUID_TESTNET_NETTING_MAX_FILL_PAGES',
          16,
          64,
        ),
        ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
      },
    );
    return Object.freeze({ runtime, close: () => journal.close() });
  } catch (error) {
    journal.close();
    throw error;
  }
}
