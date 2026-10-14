import { writeFile } from 'node:fs/promises';

const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const PYTH_PUSH_ORACLE = 'pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT';

const outputPath = process.argv[2];
const rpcUrl = process.env.NARYX_PYTH_DEVNET_RPC_URL;
const apiKey = process.env.NARYX_PYTH_API_KEY;

if (!outputPath || !rpcUrl || !apiKey) {
  throw new Error('output path, NARYX_PYTH_DEVNET_RPC_URL, and NARYX_PYTH_API_KEY are required');
}
const parsedRpcUrl = new URL(rpcUrl);
if (parsedRpcUrl.protocol !== 'https:') {
  throw new Error('the Pyth pusher RPC must use HTTPS');
}
if (parsedRpcUrl.hostname === 'api.devnet.solana.com') {
  throw new Error('the shared Solana Devnet RPC cannot safely run this pusher beside Naryx');
}

const response = await fetch(rpcUrl, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getGenesisHash' }),
  signal: AbortSignal.timeout(10_000),
});
if (!response.ok || (await response.json()).result !== DEVNET_GENESIS_HASH) {
  throw new Error('RPC does not identify as Solana Devnet');
}

const config = {
  endpoint: rpcUrl,
  'keypair-file': '/run/naryx/pyth-pusher-key.json',
  'price-config-file': '/run/naryx/pyth-sol-usd.yaml',
  'price-service-endpoint': 'https://pyth.dourolabs.app/hermes',
  'hermes-access-token': apiKey,
  'pyth-contract-address': PYTH_PUSH_ORACLE,
  'shard-id': 0,
  'pushing-frequency': 30,
  'polling-frequency': 30,
  'enable-metrics': false,
};

await writeFile(outputPath, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
console.log(`Wrote Devnet-only Pyth pusher configuration to ${outputPath}`);
