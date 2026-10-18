import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { domainRef, domainManifestHash, parseProtocolJson, stringifyProtocolJson, toHex } from '../../packages/protocol-types/dist/index.js';

process.umask(0o077);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(`${root}/services/solver/package.json`);
const { createPublicClient, http, keccak256, stringToHex, getAddress } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { baseSepolia, arbitrumSepolia } = require('viem/chains');
const directory = process.env.NARYX_RECOVERY_RELEASE_DIR;
assert.ok(directory && isAbsolute(directory) && !resolve(directory).startsWith(`${root}/`) && resolve(directory) !== root,
  'Use a private external release directory');
const artifact = name => JSON.parse(readFileSync(`${root}/contracts/evm/out/${name}.sol/${name}.json`, 'utf8'));
const save = (name, value) => {
  const path = `${directory}/${name}.json`;
  writeFileSync(`${path}.next`, stringifyProtocolJson(value));
  renameSync(`${path}.next`, path);
};
const executorManifest = {
  executorClassId: 'evm-recoverable-package-v1', executorClassVersion: 1,
  environment: 'testnet', actionKinds: ['REVERSE_FILLED_LEGS'],
  modules: Object.fromEntries(['evm-recoverable-cross-domain-lane', 'evm-full-reversal-policy', 'evm-firm-reservation-cross-domain-port']
    .map(name => [name, keccak256(readFileSync(`${root}/services/solver/dist/${name}.js`))])),
};
const executorClassManifestHash = keccak256(stringToHex(stringifyProtocolJson(executorManifest)));
const lanes = [];
const observations = [];
for (const [network, chain, rpcVariable] of [
  ['base-sepolia', baseSepolia, 'BASE_SEPOLIA_RPC_URL'],
  ['arbitrum-sepolia', arbitrumSepolia, 'ARBITRUM_SEPOLIA_RPC_URL'],
]) {
  const record = parseProtocolJson(readFileSync(`${directory}/${network}.json`, 'utf8'));
  assert.equal(record.activationState, 'ACTIVE');
  assert.equal(record.environment, 'testnet');
  assert.equal(record.chainId, chain.id);
  assert.equal(record.domain.domainId, `eip155:${chain.id}`);
  assert.equal(record.domain.domainManifestHash, `0x${toHex(domainManifestHash(record.domainManifest))}`);
  const rpc = process.env[rpcVariable];
  assert.ok(rpc, 'Testnet RPC is missing');
  const client = createPublicClient({ chain, transport: http(rpc) });
  assert.equal(await client.getChainId(), chain.id);
  const address = name => record.contracts[name].address;
  const read = (name, target, functionName, args = []) => client.readContract({ address: target, abi: artifact(name).abi, functionName, args });
  const contracts = [...Object.values(record.contracts).map(c => [c.address, c.runtimeCodeHash]),
    ...Object.values(record.instances).map(c => [c.address, c.codeHash]), [record.account, record.accountCodeHash]];
  for (const [address, expected] of contracts) {
    const code = await client.getCode({ address });
    assert.ok(code && code !== '0x', 'Deployment code missing');
    assert.equal(keccak256(code), expected, 'Deployment code changed');
  }
  assert.deepEqual(await read('ProtocolConfig', address('protocolConfig'), 'domain'),
    [record.domain.domainId, record.domain.domainManifestVersion, record.domain.domainManifestHash]);
  assert.equal(await read('ProtocolConfig', address('protocolConfig'), 'entryPaused'), false);
  for (const { binding, control } of record.bindings) {
    const [active, limits] = await read('TypedStrategyAdapterRegistry', address('adapterRegistry'), 'activeAdapter', [binding.identity.subjectId]);
    assert.equal(active.identity.manifestHash, binding.identity.manifestHash);
    assert.equal(getAddress(active.adapter), getAddress(binding.adapter));
    assert.deepEqual(limits, control);
  }
  const fee = await read('StrategyFeePolicyRegistry', address('feePolicyRegistry'), 'policy', [keccak256(stringToHex('multi-strategy-fees'))]);
  assert.equal(fee.manifestHash, record.feePolicy.manifestHash);
  assert.equal(fee.paused, false);
  const riskVersion = record.riskPolicy.manifestVersion;
  assert.equal(await read('RiskDomainRegistry', address('riskDomainRegistry'), 'activeVersion', [record.riskDomainId]), riskVersion);
  const risk = await read('RiskDomainRegistry', address('riskDomainRegistry'), 'policy', [record.riskDomainId, riskVersion]);
  assert.equal(risk.activated, true);
  assert.equal(risk.lifecycle, 1);
  assert.equal(risk.config.manifestHash, record.riskPolicy.manifestHash);
  for (const { binding } of record.bindings) {
    const cap = await read('RiskDomainRegistry', address('riskDomainRegistry'), 'dependencyCap',
      [record.riskDomainId, riskVersion, binding.identity.subjectId]);
    assert.equal(cap, record.riskPolicy.grossCapQuoteAtoms, 'Risk policy must cover every exact adapter subject');
  }
  const signer = JSON.parse(readFileSync(`${directory}/${network}-solver.json`, 'utf8'));
  assert.equal(signer.environment, 'EVM_TESTNET');
  assert.equal(privateKeyToAccount(signer.privateKey).address, getAddress(record.solver));
  const balance = await client.getBalance({ address: record.solver });
  assert.ok(balance >= 250_000_000_000_000n, 'Dedicated solver gas funding missing');
  const prior = JSON.parse(readFileSync(`${root}/deployments/evm/${network}/multi-strategy-release.json`, 'utf8'));
  lanes.push({
    rpcEnvironmentVariable: `NARYX_${rpcVariable}`, signerAddress: record.solver,
    signerKeyPath: `/srv/naryx/keys/recovery-${network}-solver.json`,
    submissionJournalPath: `/srv/naryx/data/cross-domain/${network}.sqlite`,
    maximumGasBudgetWei: 250_000_000_000_000n, alreadySpentWei: 0n,
    maximumEntryQuoteAtoms: 10_000_000n, allowedOwners: [record.owner], allowedAccounts: [record.account],
    lane: {
      domain: domainRef(record.domain.domainId, record.domain.domainManifestVersion, record.domain.domainManifestHash),
      chainReference: BigInt(chain.id), reservationBook: address('reservationBook'),
      reservationBookCodeHash: record.contracts.reservationBook.runtimeCodeHash, strategyAccountCodeHash: record.accountCodeHash,
      commitGasLimit: 4_000_000n, compensationGasLimit: 4_000_000n, maximumFeePerGasWei: 25_000_000n,
      maximumCompensationCostQuoteAtoms: 1_000_000n,
      recoveryAdapters: Object.entries(record.instances).map(([name, instance]) => ({ ...instance,
        kind: name === 'spotFactory' ? 'SPOT' : name === 'perpetualFactory' ? 'RECOVERABLE_PERP' : 'RECOVERABLE_FUTURE',
        baseToken: prior.conformance.baseAsset, quoteToken: prior.conformance.quoteAsset,
      })),
    },
    compensationProfile: { executorClassId: executorManifest.executorClassId, executorClassVersion: 1,
      executorClassManifestHash, allowedActionKinds: ['REVERSE_FILLED_LEGS'] },
  });
  observations.push({ network, chainId: chain.id, checkedAt: new Date().toISOString(),
    blockNumber: await client.getBlockNumber(), checkedCodeHashes: contracts.length, domain: record.domain,
    account: record.account, solver: record.solver, solverGasBalanceWei: balance, contracts: record.contracts,
    transactions: Object.fromEntries(Object.entries(record.transactions).map(([id, tx]) => [id,
      { hash: tx.hash, blockNumber: tx.blockNumber, actualGasWei: tx.actualGasWei, value: tx.value ?? 0n }])) });
  console.log(JSON.stringify({ network, policyState: 'ACTIVE', checkedCodeHashes: contracts.length, solver: record.solver }));
}
save('executor-manifest', executorManifest);
save('activation-observations', observations);
save('cross-domain-runtime', { version: 1, environment: 'testnet',
  jobDatabasePath: '/srv/naryx/data/cross-domain/jobs.sqlite', apiOrigin: 'http://127.0.0.1:8807', pollIntervalMs: 5000, lanes });
