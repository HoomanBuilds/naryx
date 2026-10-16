#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(join(root, 'services/solver/package.json'));
const { createPublicClient, createWalletClient, decodeFunctionData, getAddress, http, keccak256 } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { baseSepolia, arbitrumSepolia } = require('viem/chains');
const protocol = await import(pathToFileURL(join(root, 'packages/protocol-types/dist/index.js')).href);
const { values } = parseArgs({ options: { plan: { type: 'string' }, deployment: { type: 'string' },
  phase: { type: 'string' }, broadcast: { type: 'boolean', default: false }, account: { type: 'string' },
  'password-env': { type: 'string', default: 'NARYX_GOVERNANCE_PASSWORD' } } });
if (!values.plan || !values.deployment || !['propose', 'activate'].includes(values.phase)) throw new Error('Provide plan, deployment, and propose or activate phase.');
const plan = protocol.parseProtocolJson(readFileSync(resolve(values.plan), 'utf8'));
const deployed = JSON.parse(readFileSync(resolve(values.deployment), 'utf8'));
const chain = plan.chainId === 84532 ? baseSepolia : plan.chainId === 421614 ? arbitrumSepolia : undefined;
if (!chain || plan.environment !== 'testnet' || deployed.environment !== 'testnet' || deployed.chainId !== chain.id) throw new Error('Only the matching Sepolia testnet is allowed.');
const release = JSON.parse(readFileSync(join(root, 'deployments/evm', deployed.network, 'multi-strategy-release.json'), 'utf8'));
if (release.chainId !== chain.id || release.environment !== 'testnet' || release.activationState !== 'ACTIVE'
  || getAddress(plan.registry) !== getAddress(release.contracts.adapterRegistry.address)) throw new Error('Activation differs from the reviewed registry.');
const rpc = process.env[chain.id === 84532 ? 'NARYX_BASE_SEPOLIA_RPC_URL' : 'NARYX_ARBITRUM_SEPOLIA_RPC_URL'];
if (!rpc) throw new Error('The testnet RPC is missing.');
const client = createPublicClient({ chain, transport: http(rpc) });
if (await client.getChainId() !== chain.id) throw new Error('RPC chain identity differs.');
for (const entry of [release.contracts.adapterRegistry, deployed.contracts.reverseLendingFactory, deployed.contracts.reverseLendingPool]) {
  const code = await client.getCode({ address: getAddress(entry.address) });
  if (!code || keccak256(code).toLowerCase() !== entry.runtimeCodeHash.toLowerCase()) throw new Error('A reviewed contract code changed.');
}
const abi = JSON.parse(readFileSync(join(root, 'contracts/evm/out/TypedStrategyAdapterRegistry.sol/TypedStrategyAdapterRegistry.json'), 'utf8')).abi;
const proposed = decodeFunctionData({ abi, data: plan.proposeCalldata });
const activation = decodeFunctionData({ abi, data: plan.activateCalldata });
const binding = proposed.args?.[0];
if (proposed.functionName !== 'proposeRegistration' || activation.functionName !== 'activateRegistration'
  || activation.args[0] !== plan.subjectId || binding.identity.subjectId !== plan.subjectId
  || binding.identity.manifestVersion !== plan.adapterVersion || binding.identity.manifestHash !== plan.adapterManifestHash
  || getAddress(binding.adapter) !== getAddress(deployed.contracts.reverseLendingFactory.address)
  || binding.expectedCodeHash !== deployed.contracts.reverseLendingFactory.runtimeCodeHash) throw new Error('Activation calldata differs from the replacement identity.');
const required = values.phase === 'propose' ? release.governance.proposer : release.governance.executor;
console.log(JSON.stringify({ phase: values.phase, chainId: chain.id, registry: plan.registry,
  subjectId: plan.subjectId, adapterVersion: plan.adapterVersion, actor: required, broadcast: values.broadcast }));
if (!values.broadcast) process.exit(0);
if (!values.account || !process.env[values['password-env']]) throw new Error('Broadcast requires the governance keystore and password environment variable.');
let key;
try { key = execFileSync('cast', ['wallet', 'private-key', '--account', values.account,
  '--password', process.env[values['password-env']]], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim(); }
catch { throw new Error('Cannot unlock the governance keystore.'); }
const signer = privateKeyToAccount(key);
key = undefined;
if (getAddress(signer.address) !== getAddress(required)) throw new Error('The keystore does not hold the required role.');
if (values.phase === 'activate') {
  const pending = await client.readContract({ address: plan.registry, abi, functionName: 'pendingRegistration', args: [plan.subjectId] });
  if (!pending.exists || pending.binding.identity.manifestHash !== plan.adapterManifestHash
    || (await client.getBlock()).timestamp < pending.activationTimestamp) throw new Error('The exact delayed proposal is not ready.');
}
const data = values.phase === 'propose' ? plan.proposeCalldata : plan.activateCalldata;
const gas = await client.estimateGas({ account: signer, to: plan.registry, data, value: 0n });
const fees = await client.estimateFeesPerGas(), gasLimit = gas * 12n / 10n;
if (gasLimit * fees.maxFeePerGas > 1_000_000_000_000_000n) throw new Error('Activation exceeds the testnet gas budget.');
if (await client.getChainId() !== chain.id) throw new Error('RPC chain changed before broadcast.');
const wallet = createWalletClient({ account: signer, chain, transport: http(rpc) });
const transactionHash = await wallet.sendTransaction({ to: plan.registry, data, value: 0n, gas: gasLimit, ...fees });
console.log(JSON.stringify({ phase: values.phase, transactionHash }));
const receipt = await client.waitForTransactionReceipt({ hash: transactionHash, confirmations: 2 });
if (receipt.status !== 'success') throw new Error('Activation transaction reverted.');
console.log(JSON.stringify({ phase: values.phase, transactionHash, status: receipt.status, blockNumber: receipt.blockNumber.toString() }));
