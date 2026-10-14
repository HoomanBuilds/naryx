#!/usr/bin/env node
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  runtimeDirectory: { type: 'string' },
  network: { type: 'string' },
  repository: { type: 'string' },
} });
if (values.runtimeDirectory === undefined || !['base-sepolia', 'arbitrum-sepolia'].includes(values.network)) {
  throw new Error('usage: prepare-evm-testnet-risk-policies.mjs --runtimeDirectory <solver-config-directory> --network <base-sepolia|arbitrum-sepolia>');
}

const repository = values.repository === undefined
  ? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
  : resolve(values.repository);
const requireFromSolver = createRequire(join(repository, 'services/solver/package.json'));
const { encodeAbiParameters, encodeFunctionData, getAddress, keccak256, parseAbiParameters, stringToHex, toHex } = requireFromSolver('viem');
const protocol = await import(pathToFileURL(join(repository, 'packages/protocol-types/dist/index.js')).href);
const abi = JSON.parse(readFileSync(join(repository, 'deployments/evm/conformance/abi/RiskDomainRegistry.abi.json'), 'utf8'));

const chainId = values.network === 'base-sepolia' ? 84_532n : 421_614n;
const release = JSON.parse(readFileSync(join(repository, 'deployments/evm', values.network, 'multi-strategy-release.json'), 'utf8'));
if (release.chainId !== Number(chainId) || release.environment !== 'testnet') throw new Error('release chain or environment differs');
const domainParameters = parseAbiParameters('string,uint256,bytes32');
const policyParameters = parseAbiParameters('string,bytes32,bytes32[]');
const files = [
  'evm-option-spread-runtime.json',
  'evm-calendar-spread-runtime.json',
  'evm-treasury-hedge-runtime.json',
  'evm-collateral-conversion-runtime.json',
  'evm-reverse-basis-runtime.json',
];

function adapterIds(value, result = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) adapterIds(item, result);
  } else if (value !== null && typeof value === 'object') {
    if (typeof value.adapterId === 'string') result.add(value.adapterId);
    for (const item of Object.values(value)) adapterIds(item, result);
  }
  return result;
}

const policies = files.map((file) => {
  const root = protocol.parseProtocolJson(readFileSync(join(resolve(values.runtimeDirectory), file), 'utf8'));
  if (root.environment !== 'testnet' || !Array.isArray(root.lanes)) throw new Error(`${file} is not a testnet runtime`);
  const lane = root.lanes.find((candidate) => candidate.domain?.domainId === `eip155:${chainId}`);
  if (lane === undefined) throw new Error(`${file} has no matching chain lane`);
  if (lane.domain.domainManifestVersion !== release.domain.manifestVersion
    || toHex(lane.domain.domainManifestHash) !== release.domain.manifestHash) throw new Error(`${file} domain differs from release`);
  const accountingToken = getAddress(lane.quoteToken.address);
  if (accountingToken !== getAddress(release.conformance.quoteAsset)) throw new Error(`${file} accounting token differs from release`);
  const templateId = lane.templateManifest.templateId;
  const templateHash = keccak256(stringToHex(templateId));
  const dependencies = [...adapterIds(lane)].map((id) => keccak256(stringToHex(id))).sort();
  if (dependencies.length < 2 || dependencies.length > 3) throw new Error(`${file} adapter dependency count is unsupported`);
  const riskDomainId = keccak256(encodeAbiParameters(domainParameters, ['naryx-testnet-risk-domain-v2', chainId, templateHash]));
  const policyManifestHash = keccak256(encodeAbiParameters(policyParameters, ['naryx-testnet-risk-policy-v2', riskDomainId, dependencies]));
  const series = [{
    seriesId: templateHash,
    manifestVersion: 1,
    manifestHash: keccak256(encodeAbiParameters(domainParameters, ['naryx-testnet-series-v1', chainId, templateHash])),
  }];
  const proposed = {
    manifestVersion: 1,
    manifestHash: policyManifestHash,
    domainManifestVersion: release.domain.manifestVersion,
    domainManifestHash: release.domain.manifestHash,
    accountingToken,
    expectedTokenCodeHash: lane.quoteToken.expectedCodeHash,
    grossCapQuoteAtoms: 5_000_000_000_000n,
    netCapQuoteAtoms: 5_000_000_000_000n,
    minimumMarginFloorQuoteAtoms: 1_000_000n,
    maximumLeverageBps: 100_000n,
    maximumStalenessMs: 300_000n,
    maximumTimeToUnwindMs: 3_600_000n,
    requiredRecoveryReserveQuoteAtoms: 1_000_000n,
    aggregateHaircutBps: 100,
  };
  const limits = dependencies.map((dependencyId) => ({ dependencyId, maximumGrossQuoteAtoms: 5_000_000_000_000n }));
  return {
    templateId,
    riskDomainId,
    policyManifestHash,
    dependencyIds: dependencies,
    proposalCalldata: encodeFunctionData({ abi, functionName: 'proposePolicy', args: [riskDomainId, proposed, series, limits] }),
    activationCalldata: encodeFunctionData({ abi, functionName: 'activate', args: [riskDomainId] }),
  };
});

process.stdout.write(`${JSON.stringify({
  network: values.network,
  chainId: Number(chainId),
  registry: release.contracts.riskDomainRegistry.address,
  proposer: release.governance.proposer,
  executor: release.governance.executor,
  delaySeconds: release.governance.delaySeconds,
  policies,
}, null, 2)}\n`);
