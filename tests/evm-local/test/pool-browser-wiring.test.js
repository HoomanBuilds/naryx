import assert from 'node:assert/strict';
import test from 'node:test';
import { poolBrowserEnvironment } from '../../../deployments/tools/wire-testnet-pool-browser.mjs';

test('pool browser activation preserves unrelated settings and rejects conflicting identities', () => {
  const token = '/srv/naryx/private/pool-token';
  const original = 'EXISTING=untouched\nNARYX_HYPERLIQUID_POOL_BROWSER_ENABLED=false\n';
  const result = poolBrowserEnvironment(original, token);
  assert.ok(result.startsWith('EXISTING=untouched\n'));
  assert.ok(result.includes('NARYX_HYPERLIQUID_POOL_BROWSER_ENABLED="true"'));
  assert.equal(poolBrowserEnvironment(result, token), result);
  assert.throws(() => poolBrowserEnvironment('NARYX_HYPERLIQUID_POOL_BROWSER_ORIGIN=https://outside.example', token));
  assert.throws(() => poolBrowserEnvironment('NARYX_THRESHOLD_AUCTIONS_ENABLED=false\nNARYX_THRESHOLD_AUCTIONS_ENABLED=true', token));
  assert.throws(() => poolBrowserEnvironment('', '/unsafe\npath'));
});
