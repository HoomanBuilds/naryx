#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(join(root, 'services/api/package.json'));
const { createPublicClient, createWalletClient, encodeFunctionData, http, keccak256, parseAbi } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { baseSepolia, arbitrumSepolia } = require('viem/chains');
const { values } = parseArgs({ options: {
  network: { type: 'string' },
  broadcast: { type: 'boolean', default: false },
  'refresh-now': { type: 'boolean', default: false },
  account: { type: 'string' },
  'password-env': { type: 'string', default: 'NARYX_ORACLE_KEYSTORE_PASSWORD' },
} });
const networks = {
  'base-sepolia': { chain: baseSepolia, rpc: process.env.NARYX_BASE_SEPOLIA_RPC_URL },
  'arbitrum-sepolia': { chain: arbitrumSepolia, rpc: process.env.NARYX_ARBITRUM_SEPOLIA_RPC_URL },
};
if (!Object.hasOwn(networks, values.network ?? '')) throw new Error('Choose --network base-sepolia or arbitrum-sepolia.');
const { chain, rpc } = networks[values.network];
if (!rpc) throw new Error('The selected testnet RPC is missing.');
const client = createPublicClient({ chain, transport: http(rpc) });
if (await client.getChainId() !== chain.id) throw new Error('RPC chain identity is not the selected testnet.');
const release = JSON.parse(readFileSync(join(root, 'deployments/evm', values.network, 'multi-strategy-release.json'), 'utf8'));
if (release.chainId !== chain.id || release.environment !== 'testnet' || release.activationState !== 'ACTIVE') {
  throw new Error('The release is not active on this testnet.');
}
const factoryAbi = parseAbi([
  'function instrument() view returns (address)',
  'function instrumentCodeHash() view returns (bytes32)',
]);
const marketAbi = parseAbi([
  'function oracle() view returns (address)',
  'function oracleCodeHash() view returns (bytes32)',
  'function maxOracleAgeSeconds() view returns (uint32)',
]);
const oracleAbi = parseAbi([
  'function owner() view returns (address)',
  'function decimals() view returns (uint8)',
  'function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)',
  'function setAnswer(int256 nextAnswer)',
]);
async function requireCode(address, expected) {
  const code = await client.getCode({ address });
  if (!code || code === '0x' || keccak256(code).toLowerCase() !== expected.toLowerCase()) {
    throw new Error('A release contract code hash changed.');
  }
}
const oracles = new Map();
for (const name of ['perpetual', 'nearFuture', 'farFuture']) {
  const factory = release.contracts[`${name}Factory`];
  const market = release.conformance[`${name}Market`];
  await requireCode(factory.address, factory.runtimeCodeHash);
  const [instrument, instrumentCodeHash] = await Promise.all([
    client.readContract({ address: factory.address, abi: factoryAbi, functionName: 'instrument' }),
    client.readContract({ address: factory.address, abi: factoryAbi, functionName: 'instrumentCodeHash' }),
  ]);
  if (instrument.toLowerCase() !== market.toLowerCase()) throw new Error('The factory market differs from the release.');
  await requireCode(market, instrumentCodeHash);
  const [oracle, oracleCodeHash, maxAge] = await Promise.all([
    client.readContract({ address: market, abi: marketAbi, functionName: 'oracle' }),
    client.readContract({ address: market, abi: marketAbi, functionName: 'oracleCodeHash' }),
    client.readContract({ address: market, abi: marketAbi, functionName: 'maxOracleAgeSeconds' }),
  ]);
  await requireCode(oracle, oracleCodeHash);
  const key = oracle.toLowerCase();
  const old = oracles.get(key);
  oracles.set(key, { oracle, maxAge: old === undefined ? maxAge : Math.min(old.maxAge, maxAge) });
}
let signer;
for (const { oracle, maxAge } of oracles.values()) {
  const [round, owner, decimals, block] = await Promise.all([
    client.readContract({ address: oracle, abi: oracleAbi, functionName: 'latestRoundData' }),
    client.readContract({ address: oracle, abi: oracleAbi, functionName: 'owner' }),
    client.readContract({ address: oracle, abi: oracleAbi, functionName: 'decimals' }),
    client.getBlock(),
  ]);
  const [roundId, answer, , updatedAt, answeredInRound] = round;
  if (decimals !== 8 || answer <= 0n || updatedAt === 0n || updatedAt > block.timestamp || answeredInRound < roundId) {
    throw new Error('The conformance oracle round is invalid.');
  }
  const refreshDue = values['refresh-now'] || block.timestamp - updatedAt >= BigInt(Math.floor(maxAge / 2));
  console.log(JSON.stringify({ network: values.network, oracle, answer: answer.toString(), updatedAt: updatedAt.toString(), refreshDue, broadcast: values.broadcast }));
  if (!values.broadcast || !refreshDue) continue;
  if (signer === undefined) {
    const password = process.env[values['password-env']];
    if (!values.account || !password) throw new Error('Broadcast requires --account and the configured password environment variable.');
    let key;
    try {
      key = execFileSync('cast', ['wallet', 'private-key', '--account', values.account, '--password', password], {
        encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {
      throw new Error('Cannot unlock the oracle owner keystore.');
    }
    signer = privateKeyToAccount(key);
    key = undefined;
  }
  if (signer.address.toLowerCase() !== owner.toLowerCase()) throw new Error('The signer is not the conformance oracle owner.');
  if (await client.getChainId() !== chain.id) throw new Error('RPC chain changed before broadcast.');
  const data = encodeFunctionData({ abi: oracleAbi, functionName: 'setAnswer', args: [answer] });
  const gas = await client.estimateGas({ account: signer, to: oracle, data });
  const fees = await client.estimateFeesPerGas();
  const gasLimit = gas * 12n / 10n;
  if (gasLimit * fees.maxFeePerGas > 1_000_000_000_000_000n) throw new Error('Oracle refresh exceeds the testnet gas budget.');
  const wallet = createWalletClient({ account: signer, chain, transport: http(rpc) });
  const hash = await wallet.sendTransaction({ to: oracle, data, value: 0n, gas: gasLimit, ...fees });
  const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 2 });
  if (receipt.status !== 'success') throw new Error('Oracle refresh reverted.');
  const after = await client.readContract({ address: oracle, abi: oracleAbi, functionName: 'latestRoundData' });
  if (after[1] !== answer || after[0] <= roundId || after[3] <= updatedAt) {
    throw new Error('Oracle refresh did not preserve the answer and advance its round and timestamp.');
  }
  console.log(JSON.stringify({ network: values.network, oracle, transactionHash: hash, blockNumber: receipt.blockNumber.toString(), updatedAt: after[3].toString() }));
}
