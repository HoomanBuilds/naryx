#!/usr/bin/env node
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const protocol = await import(pathToFileURL(join(repository, 'packages/protocol-types/dist/index.js')).href);
const { values } = parseArgs({
  options: {
    profiles: { type: 'string' },
    output: { type: 'string' },
    'api-base-url': { type: 'string', default: 'http://127.0.0.1:8807' },
  },
});
if (values.profiles === undefined || values.output === undefined) {
  throw new Error('usage: provision-hyperliquid-observation-watchlists.mjs --profiles <file> --output <directory> [--api-base-url <url>]');
}
if (!/^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?$)/.test(values['api-base-url'])) {
  throw new Error('api-base-url must use HTTPS or loopback HTTP');
}

const profilePath = resolve(values.profiles);
const output = resolve(values.output);
if (output === repository || output.startsWith(`${repository}/`)) {
  throw new Error('output must be outside the repository');
}
const source = protocol.parseProtocolJson(readFileSync(profilePath, 'utf8'));
if (source.environment !== 'testnet' || !Array.isArray(source.profiles) || source.profiles.length === 0) {
  throw new Error('profiles must contain at least one Hyperliquid Testnet profile');
}

const first = source.profiles[0];
const settlementAccount = first.settlementAccount;
const domain = first.domain;
const quoteAsset = first.quoteAsset;
if (typeof settlementAccount !== 'string' || !/^0x[0-9a-f]{40}$/.test(settlementAccount)) {
  throw new Error('the settlement account must be a lowercase EVM address');
}
for (const profile of source.profiles) {
  if (profile.settlementAccount !== settlementAccount
    || protocol.stringifyProtocolJson(profile.domain) !== protocol.stringifyProtocolJson(domain)
    || protocol.stringifyProtocolJson(profile.quoteAsset) !== protocol.stringifyProtocolJson(quoteAsset)) {
    throw new Error('all profiles must share one settlement account, domain, and quote asset');
  }
}

const bindings = new Map();
for (const profile of source.profiles) {
  for (const market of profile.markets) {
    const candidate = {
      coin: market.coin,
      venueId: market.venue.subjectId,
      marketId: market.market.subjectId,
      underlyingId: profile.baseAsset.assetId,
      baseAsset: profile.baseAsset,
      riskDomainId: `hypercore-testnet-${market.coin.replaceAll(':', '-')}`,
      dependencyIds: [`venue:${market.venue.subjectId}`, `market:${market.market.subjectId}`],
      closeRoutes: [],
    };
    const existing = bindings.get(market.coin);
    if (existing !== undefined && protocol.stringifyProtocolJson(existing) !== protocol.stringifyProtocolJson(candidate)) {
      throw new Error(`coin ${market.coin} has conflicting position bindings`);
    }
    bindings.set(market.coin, candidate);
  }
}

const strategyAccount = 'hypercore-testnet-shared-account';
const apiBaseUrl = values['api-base-url'];
const positionWatchlist = {
  intervalMs: 30_000,
  environment: 'testnet',
  apiBaseUrl,
  authority: 'hypercore-testnet-observation-v1',
  accounts: [{
    strategyAccount,
    user: settlementAccount,
    sourceId: 'hypercore-testnet-info',
    snapshotPrefix: 'hypercore-testnet-shared',
    domain,
    quoteAsset,
    perpBindings: [...bindings.values()],
    spotBindings: [],
  }],
};
const collateralWatchlist = {
  intervalMs: 30_000,
  environment: 'testnet',
  apiBaseUrl,
  authority: 'hypercore-testnet-observation-v1',
  accounts: [{
    strategyAccount,
    user: settlementAccount,
    owner: settlementAccount,
    sourceId: 'hypercore-testnet-clearinghouse',
    snapshotPrefix: 'hypercore-testnet-collateral',
    asset: quoteAsset,
    riskDomainId: 'hypercore-testnet-cross-margin',
    haircutBps: 250n,
    withdrawalDelayMs: 0n,
  }],
};

mkdirSync(output, { recursive: true, mode: 0o700 });
const write = (name, value) => {
  const destination = join(output, name);
  const temporary = `${destination}.next`;
  writeFileSync(temporary, protocol.stringifyProtocolJson(value), { mode: 0o600 });
  renameSync(temporary, destination);
};
write('hyperliquid-position-watchlist.json', positionWatchlist);
write('hyperliquid-collateral-watchlist.json', collateralWatchlist);
process.stdout.write(`${strategyAccount}\n`);
