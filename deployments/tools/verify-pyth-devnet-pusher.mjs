import { readFile } from 'node:fs/promises';

const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const PYTH_PUSH_ORACLE = 'pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT';

const configPath = process.argv[2];
if (!configPath) throw new Error('pusher configuration path is required');

const config = JSON.parse(await readFile(configPath, 'utf8'));
if (
  config['shard-id'] !== 0 ||
  config['pyth-contract-address'] !== PYTH_PUSH_ORACLE ||
  config['keypair-file'] !== '/run/naryx/pyth-pusher-key.json' ||
  !config['hermes-access-token'] ||
  new URL(config.endpoint).protocol !== 'https:' ||
  new URL(config.endpoint).hostname === 'api.devnet.solana.com'
) {
  throw new Error('Pyth pusher configuration is not the approved Devnet shard-0 setup');
}

const response = await fetch(config.endpoint, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getGenesisHash' }),
  signal: AbortSignal.timeout(10_000),
});
if (!response.ok || (await response.json()).result !== DEVNET_GENESIS_HASH) {
  throw new Error('Pyth pusher RPC does not identify as Solana Devnet');
}
console.log('Verified Solana Devnet shard-0 Pyth pusher configuration');
