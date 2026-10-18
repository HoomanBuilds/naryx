#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { OracleRefreshJournal, REFRESH_RESERVATION_WEI } from './evm-oracle-refresh-journal.mjs';
import { loadEvmStrategySolverKey } from '../../services/solver/dist/evm-strategy-execution-authorization.js';

process.umask(0o077);
let operation = 'configuration';
process.on('uncaughtException', error => {
  const errorType = /^[A-Za-z]{1,80}$/.test(error.name) ? error.name : 'Error';
  console.error(JSON.stringify({ operation, errorType,
    reason: 'Oracle refresh failed closed. Preserve the journal and inspect onchain state before retrying.' }));
  process.exit(1);
});

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(join(root, 'services/api/package.json'));
const { createPublicClient, createWalletClient, encodeFunctionData, http, keccak256, parseAbi, parseTransaction } = require('viem');
const { estimateL1Fee, estimateOperatorFee } = require('viem/op-stack');
const { privateKeyToAccount } = require('viem/accounts');
const { baseSepolia, arbitrumSepolia } = require('viem/chains');
const { values } = parseArgs({ options: {
  network: { type: 'string' },
  broadcast: { type: 'boolean', default: false },
  'refresh-now': { type: 'boolean', default: false },
  account: { type: 'string' },
  'key-file': { type: 'string' },
  journal: { type: 'string' },
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
if (values.broadcast && (!values.journal || Boolean(values.account) === Boolean(values['key-file']))) {
  throw new Error('Broadcast requires a journal and exactly one signing source.');
}
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
const externalOracles = new Map();
operation = 'release-verification';
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
const canonicalReleasePath = join(root, 'deployments/evm', values.network, 'release.json');
if (existsSync(canonicalReleasePath)) {
  const canonical = JSON.parse(readFileSync(canonicalReleasePath, 'utf8'));
  if (canonical.chainId !== chain.id || canonical.activationState !== 'ACTIVE') {
    throw new Error('The canonical release is not active on this testnet.');
  }
  const market = canonical.contracts.testPerpMarket;
  if (market !== undefined) {
    await requireCode(market.address, market.runtimeCodeHash);
    const [oracle, oracleCodeHash, maxAge] = await Promise.all([
      client.readContract({ address: market.address, abi: marketAbi, functionName: 'oracle' }),
      client.readContract({ address: market.address, abi: marketAbi, functionName: 'oracleCodeHash' }),
      client.readContract({ address: market.address, abi: marketAbi, functionName: 'maxOracleAgeSeconds' }),
    ]);
    await requireCode(oracle, oracleCodeHash);
    const binding = oracles.get(oracle.toLowerCase());
    if (!Number.isSafeInteger(maxAge) || maxAge <= 0) throw new Error('The canonical oracle heartbeat is invalid.');
    if (binding === undefined) {
      externalOracles.set(oracle.toLowerCase(), { oracle, maxAge });
    } else {
      oracles.set(oracle.toLowerCase(), { oracle, maxAge: Math.min(binding.maxAge, maxAge) });
    }
  }
}
for (const { oracle, maxAge } of externalOracles.values()) {
  const [round, block] = await Promise.all([
    client.readContract({ address: oracle, abi: oracleAbi, functionName: 'latestRoundData' }),
    client.getBlock(),
  ]);
  const [roundId, answer, , updatedAt, answeredInRound] = round;
  const fresh = answer > 0n && updatedAt > 0n && updatedAt <= block.timestamp && answeredInRound >= roundId
    && block.timestamp - updatedAt <= BigInt(maxAge);
  console.log(JSON.stringify({ network: values.network, oracle, answer: answer.toString(),
    updatedAt: updatedAt.toString(), maxAgeSeconds: maxAge, fresh, managed: false, readOnly: true }));
}
let signer;
for (const { oracle, maxAge } of oracles.values()) {
  operation = 'round-read';
  const [round, owner, decimals, block] = await Promise.all([
    client.readContract({ address: oracle, abi: oracleAbi, functionName: 'latestRoundData' }),
    client.readContract({ address: oracle, abi: oracleAbi, functionName: 'owner' }),
    client.readContract({ address: oracle, abi: oracleAbi, functionName: 'decimals' }),
    client.getBlock(),
  ]);
  const [roundId, answer, , updatedAt, answeredInRound] = round;
  if (decimals !== 8 || answer <= 0n || roundId <= 0n || updatedAt === 0n || updatedAt > block.timestamp
    || answeredInRound < roundId || !Number.isSafeInteger(maxAge) || maxAge < 2) {
    throw new Error('The conformance oracle round is invalid.');
  }
  const refreshDue = values['refresh-now'] || block.timestamp - updatedAt >= BigInt(Math.floor(maxAge / 2));
  console.log(JSON.stringify({ network: values.network, oracle, answer: answer.toString(), updatedAt: updatedAt.toString(), maxAgeSeconds: maxAge, refreshDue, broadcast: values.broadcast }));
  if (!values.broadcast) continue;
  if (oracles.size !== 1) throw new Error('Unattended refresh requires exactly one bound test oracle per network.');
  const journal = new OracleRefreshJournal(values.journal, chain.id, oracle, owner);
  try {
  let pending = journal.pending();
  if (!refreshDue && !pending) continue;
  if (!pending) {
  operation = 'signing';
  if (signer === undefined) {
    if (values['key-file']) {
      signer = loadEvmStrategySolverKey(values['key-file'], owner);
    } else {
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
  }
  if (signer.address.toLowerCase() !== owner.toLowerCase()) throw new Error('The signer is not the conformance oracle owner.');
  if (await client.getChainId() !== chain.id) throw new Error('RPC chain changed before broadcast.');
  const data = encodeFunctionData({ abi: oracleAbi, functionName: 'setAnswer', args: [answer] });
  const gas = await client.estimateGas({ account: signer, to: oracle, data });
  const fees = await client.estimateFeesPerGas();
  const gasLimit = gas * 12n / 10n;
  if (gasLimit * fees.maxFeePerGas > REFRESH_RESERVATION_WEI / 2n) throw new Error('Oracle refresh exceeds the testnet gas budget.');
  const wallet = createWalletClient({ account: signer, chain, transport: http(rpc) });
  const [latestNonce, pendingNonce] = await Promise.all([
    client.getTransactionCount({ address: signer.address, blockTag: 'latest' }),
    client.getTransactionCount({ address: signer.address, blockTag: 'pending' }),
  ]);
  if (latestNonce !== pendingNonce) throw new Error('The shared owner has pending transactions; refresh deferred.');
  const request = await wallet.prepareTransactionRequest({ to: oracle, data, value: 0n, gas: gasLimit, nonce: pendingNonce, ...fees });
  if (await client.getChainId() !== chain.id) throw new Error('RPC chain changed before signing.');
  const raw = await wallet.signTransaction(request);
  pending = await journal.reserve({ raw, answer, round: roundId, updatedAt });
  }
  const hash = pending.hash;
  let knownReceipt;
  try { knownReceipt = await client.getTransactionReceipt({ hash }); }
  catch (error) { if (error.name !== 'TransactionReceiptNotFoundError') throw error; }
  if (!knownReceipt) {
    operation = 'gas-preflight';
    if (await client.getChainId() !== chain.id) throw new Error('RPC chain changed before broadcast.');
    const current = await client.readContract({ address: oracle, abi: oracleAbi, functionName: 'latestRoundData' });
    if (current[1] !== BigInt(pending.answer) || current[0] !== BigInt(pending.round)
      || current[3] !== BigInt(pending.updated_at)) throw new Error('Oracle round changed before pending refresh; review required.');
    const tx = parseTransaction(pending.raw);
    if (chain.id === baseSepolia.id) {
      const request = { ...tx, account: owner };
      const [l1Fee, operatorFee] = await Promise.all([estimateL1Fee(client, request), estimateOperatorFee(client, request)]);
      if (tx.gas * tx.maxFeePerGas + l1Fee + operatorFee > REFRESH_RESERVATION_WEI / 2n) {
        throw new Error('Oracle refresh total fee estimate exceeds its reservation headroom.');
      }
    }
    operation = 'submission';
    try { await client.sendRawTransaction({ serializedTransaction: pending.raw }); }
    catch (error) { if (!/already known|nonce too low/i.test(error.shortMessage ?? '')) throw error; }
  }
  operation = 'receipt-confirmation';
  const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 2 });
  if ((await client.getBlock({ blockNumber: receipt.blockNumber })).hash !== receipt.blockHash) throw new Error('Oracle refresh receipt is not canonical.');
  const after = await client.readContract({ address: oracle, abi: oracleAbi, functionName: 'latestRoundData' });
  operation = 'fee-reconciliation';
  const rawReceipt = await client.request({ method: 'eth_getTransactionReceipt', params: [hash] });
  let ancillaryWei = 0n;
  if (chain.id === baseSepolia.id) {
    if (typeof rawReceipt?.l1Fee !== 'string' || !/^0x[0-9a-fA-F]+$/.test(rawReceipt.l1Fee)) {
      throw new Error('Base receipt is missing its L1 fee evidence.');
    }
    const operatorFee = await client.readContract({ address: chain.contracts.gasPriceOracle.address,
      abi: parseAbi(['function getOperatorFee(uint256 gasUsed) view returns (uint256)']),
      functionName: 'getOperatorFee', args: [receipt.gasUsed], blockNumber: receipt.blockNumber });
    ancillaryWei = BigInt(rawReceipt.l1Fee) + operatorFee;
  }
  const actualWei = receipt.gasUsed * receipt.effectiveGasPrice + ancillaryWei;
  const success = receipt.status === 'success' && after[1] === BigInt(pending.answer)
    && after[0] > BigInt(pending.round) && after[3] > BigInt(pending.updated_at);
  operation = 'journal-confirmation';
  journal.resolve(hash, success, actualWei);
  console.log(JSON.stringify({ network: values.network, oracle, transactionHash: hash, blockNumber: receipt.blockNumber.toString(),
    updatedAt: after[3].toString(), reservedWei: journal.reserved().toString(), actualWei: actualWei.toString() }));
  } finally { journal.close(); }
}
