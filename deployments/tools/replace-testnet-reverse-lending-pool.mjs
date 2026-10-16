#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(join(root, 'services/solver/package.json'));
const { createPublicClient, createWalletClient, encodeDeployData, getAddress, http, keccak256, parseAbi } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { baseSepolia, arbitrumSepolia } = require('viem/chains');
const { values } = parseArgs({ options: {
  network: { type: 'string' }, output: { type: 'string' }, broadcast: { type: 'boolean', default: false },
  account: { type: 'string' }, 'password-env': { type: 'string', default: 'NARYX_DEPLOYER_PASSWORD' },
} });
const networks = {
  'base-sepolia': { chain: baseSepolia, rpc: process.env.NARYX_BASE_SEPOLIA_RPC_URL },
  'arbitrum-sepolia': { chain: arbitrumSepolia, rpc: process.env.NARYX_ARBITRUM_SEPOLIA_RPC_URL },
};
if (!Object.hasOwn(networks, values.network ?? '')) throw new Error('Select a supported Sepolia network.');
const { chain, rpc } = networks[values.network];
if (!rpc) throw new Error('The selected testnet RPC is missing.');
const client = createPublicClient({ chain, transport: http(rpc) });
if (await client.getChainId() !== chain.id) throw new Error('RPC chain identity differs from the selected testnet.');
const release = JSON.parse(readFileSync(join(root, 'deployments/evm', values.network, 'multi-strategy-release.json'), 'utf8'));
if (release.chainId !== chain.id || release.environment !== 'testnet' || release.activationState !== 'ACTIVE') {
  throw new Error('The deployment reference is not active on this testnet.');
}
const artifact = (name) => JSON.parse(readFileSync(join(root, 'contracts/evm/out', `${name}.sol`, `${name}.json`), 'utf8'));
const poolArtifact = artifact('NaryxTestLendingPool');
const factoryArtifact = artifact('AaveV3TypedLendingAdapterFactory');
const factory = release.contracts.reverseLendingFactory;
const accountFactory = release.contracts.accountFactory;
const assertCode = async (address, expected) => {
  const code = await client.getCode({ address: getAddress(address) });
  if (!code || keccak256(code).toLowerCase() !== expected.toLowerCase()) throw new Error('A reviewed code identity changed.');
};
await assertCode(factory.address, factory.runtimeCodeHash);
await assertCode(accountFactory.address, accountFactory.runtimeCodeHash);
const pool = getAddress(release.conformance.reverseLendingPool);
const poolAbi = parseAbi([
  'function collateralToken() view returns(address)', 'function debtToken() view returns(address)',
  'function collateralPriceDebtAtomsPerWholeToken() view returns(uint256)',
  'function loanToValueBps() view returns(uint16)', 'function liquidationThresholdBps() view returns(uint16)',
]);
const fields = await Promise.all(['collateralToken', 'debtToken', 'collateralPriceDebtAtomsPerWholeToken',
  'loanToValueBps', 'liquidationThresholdBps'].map((functionName) => client.readContract({ address: pool, abi: poolAbi, functionName })));
if (getAddress(fields[0]) !== getAddress(release.conformance.quoteAsset)
  || getAddress(fields[1]) !== getAddress(release.conformance.baseAsset)) throw new Error('Reverse pool token identities differ.');
const oldPoolCode = await client.getCode({ address: pool });
if (!oldPoolCode || oldPoolCode === '0x') throw new Error('The old pool has no code.');
const factoryAccountCodeHash = await client.readContract({ address: getAddress(accountFactory.address),
  abi: parseAbi(['function accountCodeHash() view returns(bytes32)']), functionName: 'accountCodeHash' });
console.log(JSON.stringify({ network: values.network, oldPool: pool, oldFactory: factory.address,
  collateralToken: fields[0], debtToken: fields[1], broadcast: values.broadcast }));
if (!values.broadcast) process.exit(0);
if (!values.output || !values.account || !process.env[values['password-env']]) {
  throw new Error('Broadcast requires an unused output path, a keystore account, and its password environment variable.');
}
const output = resolve(values.output);
if (existsSync(output)) throw new Error('The output already exists; inspect the prior deployment instead of redeploying.');
mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
let key;
try {
  key = execFileSync('cast', ['wallet', 'private-key', '--account', values.account,
    '--password', process.env[values['password-env']]], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
} catch { throw new Error('Cannot unlock the testnet deployer keystore.'); }
const signer = privateKeyToAccount(key);
key = undefined;
const wallet = createWalletClient({ account: signer, chain, transport: http(rpc) });
const record = { version: 1, environment: 'testnet', network: values.network, chainId: chain.id,
  oldPool: pool, oldPoolCodeHash: keccak256(oldPoolCode), oldFactory: factory.address,
  deployer: signer.address, activationState: 'UNREGISTERED', contracts: {} };
const save = () => writeFileSync(output, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
save();
async function deploy(name, contract, args) {
  if (await client.getChainId() !== chain.id) throw new Error('RPC chain changed before deployment.');
  const data = encodeDeployData({ abi: contract.abi, bytecode: contract.bytecode.object, args });
  const gas = await client.estimateGas({ account: signer, data });
  const fees = await client.estimateFeesPerGas();
  const gasLimit = gas * 12n / 10n;
  if (gasLimit * fees.maxFeePerGas > 2_000_000_000_000_000n) throw new Error('Deployment exceeds the testnet gas budget.');
  const transactionHash = await wallet.sendTransaction({ data, gas: gasLimit, value: 0n, ...fees });
  record.contracts[name] = { transactionHash };
  save();
  const receipt = await client.waitForTransactionReceipt({ hash: transactionHash, confirmations: 2 });
  if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error('Deployment did not succeed.');
  const address = getAddress(receipt.contractAddress);
  const code = await client.getCode({ address });
  if (!code || code === '0x') throw new Error('The deployed contract has no code.');
  record.contracts[name] = { address, transactionHash, runtimeCodeHash: keccak256(code) };
  save();
  console.log(JSON.stringify({ name, ...record.contracts[name] }));
  return address;
}
const replacement = await deploy('reverseLendingPool', poolArtifact, fields);
const replacementCode = record.contracts.reverseLendingPool.runtimeCodeHash;
const collateralCode = await client.getCode({ address: getAddress(fields[0]) });
const debtCode = await client.getCode({ address: getAddress(fields[1]) });
await deploy('reverseLendingFactory', factoryArtifact, [{ chainId: BigInt(chain.id),
  accountFactory: getAddress(accountFactory.address), pool: replacement,
  collateralToken: getAddress(fields[0]), debtToken: getAddress(fields[1]),
  accountFactoryCodeHash: accountFactory.runtimeCodeHash, strategyAccountCodeHash: factoryAccountCodeHash,
  poolCodeHash: replacementCode, collateralTokenCodeHash: keccak256(collateralCode), debtTokenCodeHash: keccak256(debtCode),
}]);
