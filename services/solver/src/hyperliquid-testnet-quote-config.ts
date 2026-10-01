import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { parseProtocolJson } from '@naryx/protocol-types';
import type { AtomicQuoteNonceSource } from './configured-atomic-market.js';
import {
  HyperliquidSdkTestnetMarketReadClient,
  type HyperliquidTestnetQuoteMarketReadPort,
} from './hyperliquid-testnet-market-preflight.js';
import {
  createHyperliquidTestnetQuoteRuntime,
  type HyperliquidTestnetQuoteRuntime,
  type HyperliquidTestnetQuoteRuntimeInput,
} from './hyperliquid-testnet-quote-runtime.js';

export const HYPERLIQUID_TESTNET_QUOTE_ENABLED_ENV =
  'NARYX_HYPERLIQUID_TESTNET_QUOTE_ENABLED';
export const HYPERLIQUID_TESTNET_QUOTE_CONFIG_VERSION = 2;

const ADDRESS = /^0x[0-9a-f]{40}$/;

export interface HyperliquidTestnetQuoteConfigDependencies {
  readonly nonceSource: AtomicQuoteNonceSource;
  readonly market?: HyperliquidTestnetQuoteMarketReadPort;
  readonly currentTimeMs?: () => bigint;
}

function enabled(value: string | undefined): boolean {
  if (value === undefined || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error(`${HYPERLIQUID_TESTNET_QUOTE_ENABLED_ENV} must be true or false`);
}

export function loadHyperliquidTestnetQuoteRuntime(
  env: NodeJS.ProcessEnv,
  dependencies: HyperliquidTestnetQuoteConfigDependencies,
): HyperliquidTestnetQuoteRuntime | undefined {
  if (!enabled(env[HYPERLIQUID_TESTNET_QUOTE_ENABLED_ENV])) return undefined;
  const configuredPath = env.NARYX_HYPERLIQUID_TESTNET_QUOTE_CONFIG;
  if (configuredPath === undefined || configuredPath.length === 0 || !isAbsolute(configuredPath)) {
    throw new Error('NARYX_HYPERLIQUID_TESTNET_QUOTE_CONFIG must be an absolute path');
  }
  const tradingAccount = env.NARYX_HYPERLIQUID_TESTNET_TRADING_ACCOUNT;
  if (tradingAccount === undefined || !ADDRESS.test(tradingAccount)) {
    throw new Error('NARYX_HYPERLIQUID_TESTNET_TRADING_ACCOUNT must be a lowercase 20-byte address');
  }
  const decoded = parseProtocolJson(
    readFileSync(resolve(configuredPath), 'utf8'),
    'hyperliquidTestnetQuoteConfig',
  );
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    throw new Error('Hyperliquid Testnet quote config must be an object');
  }
  const record = decoded as Record<string, unknown>;
  if (record.version !== HYPERLIQUID_TESTNET_QUOTE_CONFIG_VERSION
    || typeof record.market !== 'object' || record.market === null
    || Array.isArray(record.market)) {
    throw new Error(
      `Hyperliquid Testnet quote config must contain version ${HYPERLIQUID_TESTNET_QUOTE_CONFIG_VERSION} market configuration`,
    );
  }
  return createHyperliquidTestnetQuoteRuntime({
    ...(record.market as Omit<
      HyperliquidTestnetQuoteRuntimeInput,
      'enabled' | 'currentTimeMs' | 'nonceSource' | 'market' | 'tradingAccount'
    >),
    enabled: true,
    tradingAccount: tradingAccount as `0x${string}`,
    market: dependencies.market ?? new HyperliquidSdkTestnetMarketReadClient(),
    currentTimeMs: dependencies.currentTimeMs ?? (() => BigInt(Date.now())),
    nonceSource: dependencies.nonceSource,
  });
}
