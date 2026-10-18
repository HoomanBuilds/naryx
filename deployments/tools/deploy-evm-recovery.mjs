import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { domainManifestHash, parseProtocolJson, stringifyProtocolJson, toHex } from '../../packages/protocol-types/dist/index.js';

process.umask(0o077);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(`${root}/services/solver/package.json`);
const { createPublicClient, createWalletClient, http, encodeDeployData, encodeFunctionData,
  encodeAbiParameters, parseAbiParameters, keccak256, stringToHex, getAddress, parseAbi } = require('viem');
const { privateKeyToAccount, generatePrivateKey } = require('viem/accounts');
const { baseSepolia, arbitrumSepolia } = require('viem/chains');
const [network, phase] = process.argv.slice(2);
assert.ok(['base-sepolia', 'arbitrum-sepolia'].includes(network), 'Only the two approved testnets are supported');
assert.ok(['deploy', 'propose-domain', 'activate-domain', 'configure', 'activate',
  'propose-risk-dependencies', 'activate-risk-dependencies', 'deploy-calendar-reservation-book', 'inspect'].includes(phase));
const directory = process.env.NARYX_RECOVERY_RELEASE_DIR;
assert.ok(directory && isAbsolute(directory) && !resolve(directory).startsWith(`${root}/`) && resolve(directory) !== root,
  'Use a private external release directory');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const chain = network === 'base-sepolia' ? baseSepolia : arbitrumSepolia;
const rpcUrl = process.env[network === 'base-sepolia' ? 'BASE_SEPOLIA_RPC_URL' : 'ARBITRUM_SEPOLIA_RPC_URL'];
assert.ok(rpcUrl);
const client = createPublicClient({ chain, transport: http(rpcUrl, { timeout: 20000, retryCount: 1 }) });
assert.equal(await client.getChainId(), chain.id);
const prior = JSON.parse(readFileSync(`${root}/deployments/evm/${network}/multi-strategy-release.json`, 'utf8'));
const file = `${directory}/${network}.json`;
const record = existsSync(file) ? structuredClone(parseProtocolJson(readFileSync(file, 'utf8')))
  : { version: 1, environment: 'testnet', chainId: chain.id, gasReservedWei: 0n, transactions: {}, contracts: {} };
assert.equal(record.chainId, chain.id);
assert.equal(record.environment, 'testnet');
const save = () => { writeFileSync(`${file}.next`, stringifyProtocolJson(record)); renameSync(`${file}.next`, file); };
const hash = value => keccak256(stringToHex(value));
const manifest = value => keccak256(stringToHex(stringifyProtocolJson(value)));
const artifact = name => JSON.parse(readFileSync(`${root}/contracts/evm/out/${name}.sol/${name}.json`, 'utf8'));
const codeHash = async (address, blockNumber) => {
  let code;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try { code = await client.getCode({ address, ...(blockNumber === undefined ? {} : { blockNumber }) }); }
    catch (error) { if (attempt === 5) throw error; }
    if (code && code !== '0x') break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.ok(code && code !== '0x', 'Contract code missing');
  return keccak256(code);
};
const read = (name, address, functionName, args = []) => client.readContract({ address, abi: artifact(name).abi, functionName, args });
const keys = new Map();
function signer(role) {
  if (keys.has(role)) return keys.get(role);
  const account = process.env[`NARYX_RECOVERY_${role.toUpperCase()}_ACCOUNT`];
  assert.ok(account && process.env.FOUNDRY_PASSWORD, 'Approved signer and password required');
  const passwordPath = `${directory}/.${role}-password-${process.pid}`;
  writeFileSync(passwordPath, process.env.FOUNDRY_PASSWORD, { mode: 0o600, flag: 'wx' });
  let privateKey;
  try { privateKey = execFileSync('cast', ['wallet', 'private-key', '--account', account, '--password-file', passwordPath],
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim(); }
  catch { throw new Error(`Could not unlock ${role} testnet signer`); }
  finally { unlinkSync(passwordPath); }
  const result = privateKeyToAccount(privateKey);
  if (role !== 'deployer') assert.equal(result.address, getAddress(prior.governance[role]));
  else assert.equal(result.address, getAddress(process.env.NARYX_RECOVERY_DEPLOYER_ADDRESS));
  keys.set(role, result);
  return result;
}
async function send(id, role, data, to, value = 0n) {
  assert.equal(process.env.NARYX_RECOVERY_BROADCAST, 'true', 'Broadcast is disabled');
  assert.equal(await client.getChainId(), chain.id);
  const account = signer(role);
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
  let item = record.transactions[id];
  if (item) {
    assert.equal(item.data, data, 'Journal payload changed');
    assert.equal(item.to, to);
    assert.equal(item.signer, account.address);
    assert.equal(item.value ?? 0n, value);
  } else {
    let estimate;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try { estimate = await client.estimateGas({ account: account.address, data, ...(to ? { to } : {}), value }); break; }
      catch (error) { if (attempt === 5) throw error; await new Promise(resolve => setTimeout(resolve, 1000)); }
    }
    const gas = estimate * 13n / 10n;
    assert.ok(gas > 0n && gas <= 15_000_000n, 'Gas estimate exceeds deployment ceiling');
    const fees = await client.estimateFeesPerGas();
    assert.ok(fees.maxFeePerGas > 0n && fees.maxFeePerGas <= 1_000_000_000n, 'Fee exceeds ceiling');
    const budget = gas * fees.maxFeePerGas * 2n + value;
    const used = Object.values(record.transactions).reduce((total, item) => total +
      (item.actualGasWei === undefined ? item.budget : item.actualGasWei + (item.value ?? 0n)), 0n);
    assert.ok(used + budget <= 3_000_000_000_000_000n, 'Recovery deployment exceeds 0.003 test ETH budget');
    assert.ok(await client.getBalance({ address: account.address }) >= budget, 'Signer needs test ETH');
    const request = await wallet.prepareTransactionRequest({ data, ...(to ? { to } : {}), value, gas, ...fees });
    const raw = await wallet.signTransaction(request);
    item = { signer: account.address, to, data, value, raw, hash: keccak256(raw), budget };
    record.gasReservedWei += budget;
    record.transactions[id] = item;
    save();
  }
  let receipt;
  try { receipt = await client.getTransactionReceipt({ hash: item.hash }); } catch {}
  if (!receipt) {
    assert.equal(await client.getChainId(), chain.id);
    try { await client.sendRawTransaction({ serializedTransaction: item.raw }); }
    catch (error) { if (!/already known|nonce too low/i.test(error.shortMessage ?? '')) throw error; }
    receipt = await client.waitForTransactionReceipt({ hash: item.hash, timeout: 120000 });
  }
  assert.equal(receipt.status, 'success', `Transaction failed: ${id}`);
  item.blockNumber = receipt.blockNumber;
  item.contractAddress = receipt.contractAddress;
  item.actualGasWei = receipt.gasUsed * receipt.effectiveGasPrice + (receipt.l1Fee ?? 0n);
  assert.ok(item.actualGasWei + value <= item.budget, 'Observed gas exceeded reserved budget');
  save();
  console.log(JSON.stringify({ network, step: id, hash: item.hash, address: receipt.contractAddress }));
  return receipt;
}
async function deploy(id, name, args) {
  const a = artifact(name);
  const data = encodeDeployData({ abi: a.abi, bytecode: a.bytecode.object, args });
  const receipt = await send(`deploy-${id}`, 'deployer', data);
  assert.ok(receipt.contractAddress);
  const runtimeCodeHash = await codeHash(receipt.contractAddress, receipt.blockNumber);
  record.contracts[id] = { address: receipt.contractAddress, runtimeCodeHash, deploymentTransaction: receipt.transactionHash };
  save();
  return receipt.contractAddress;
}
const address = id => { assert.ok(record.contracts[id]); return record.contracts[id].address; };
const call = (id, role, name, target, functionName, args = []) => send(id, role,
  encodeFunctionData({ abi: artifact(name).abi, functionName, args }), target);
const tokenAbi = parseAbi(['function decimals() view returns(uint8)']);
const baseToken = prior.conformance.baseAsset;
const quoteToken = prior.conformance.quoteAsset;
const feeSubjectId = hash('multi-strategy-fees');
if (phase === 'deploy') {
  for (const name of ['accountDeployer', 'perpetualFactory', 'nearFutureFactory', 'farFutureFactory', 'spotFactory']) {
    assert.equal(await codeHash(prior.contracts[name].address), prior.contracts[name].runtimeCodeHash);
  }
  const keyPath = `${directory}/${network}-solver.json`;
  if (!existsSync(keyPath)) writeFileSync(keyPath, JSON.stringify({ version: 1, environment: 'EVM_TESTNET', privateKey: generatePrivateKey() }));
  record.solver = privateKeyToAccount(JSON.parse(readFileSync(keyPath, 'utf8')).privateKey).address;
  record.owner = getAddress(process.env.NARYX_RECOVERY_OWNER_ADDRESS);
  save();
  const config = await deploy('protocolConfig', 'ProtocolConfig', [`eip155:${chain.id}`, 1, hash(`naryx-recovery-unqualified:${chain.id}`),
    60n, prior.governance.proposer, prior.governance.canceller, prior.governance.executor, prior.governance.pauser]);
  const solverRegistry = await deploy('solverRegistry', 'SolverRegistry', [config, record.solver]);
  const adapters = await deploy('adapterRegistry', 'TypedStrategyAdapterRegistry', [config]);
  const fees = await deploy('feePolicyRegistry', 'StrategyFeePolicyRegistry', [config]);
  const risks = await deploy('riskDomainRegistry', 'RiskDomainRegistry', [config]);
  const factory = await deploy('accountFactory', 'NaryxMultiStrategyAccountFactory', [config, solverRegistry, adapters, fees, risks,
    prior.contracts.accountDeployer.address, feeSubjectId]);
  record.accountCodeHash = await read('NaryxMultiStrategyAccountFactory', factory, 'accountCodeHash');
  const baseHash = await codeHash(baseToken), quoteHash = await codeHash(quoteToken);
  for (const id of ['perpetualFactory', 'nearFutureFactory', 'farFutureFactory']) {
    const previous = prior.contracts[id].address;
    const previousAbi = artifact('SynFuturesTypedPerpAdapterFactory').abi;
    const fields = Object.fromEntries(await Promise.all(['instrument', 'observer', 'marginGate', 'expiry'].map(async functionName =>
      [functionName, await client.readContract({ address: previous, abi: previousAbi, functionName })])));
    await deploy(id, 'RecoverableTypedPerpAdapterFactory', [{ chainId: BigInt(chain.id), datedFuture: id !== 'perpetualFactory',
      accountFactory: factory, baseToken, collateralToken: quoteToken, ...fields, accountFactoryCodeHash: await codeHash(factory),
      strategyAccountCodeHash: record.accountCodeHash, baseTokenCodeHash: baseHash, collateralTokenCodeHash: quoteHash,
      instrumentCodeHash: await codeHash(fields.instrument), observerCodeHash: await codeHash(fields.observer), marginGateCodeHash: await codeHash(fields.marginGate) }]);
  }
  const baseDecimals = await client.readContract({ address: baseToken, abi: tokenAbi, functionName: 'decimals' });
  const quoteDecimals = await client.readContract({ address: quoteToken, abi: tokenAbi, functionName: 'decimals' });
  assert.equal(quoteDecimals, 6, 'Recovery budget assumes six-decimal test quote assets');
  await deploy('spotFactory', 'UniswapV3TypedSpotAdapterFactory', [{ chainId: BigInt(chain.id), accountFactory: factory,
    factory: prior.conformance.uniswapFactory, pool: prior.conformance.spotPool, baseToken, quoteToken,
    baseTokenDecimals: baseDecimals, quoteTokenDecimals: quoteDecimals, poolFee: prior.conformance.spotPoolFee,
    accountFactoryCodeHash: await codeHash(factory), strategyAccountCodeHash: record.accountCodeHash,
    factoryCodeHash: await codeHash(prior.conformance.uniswapFactory), poolCodeHash: await codeHash(prior.conformance.spotPool),
    baseTokenCodeHash: baseHash, quoteTokenCodeHash: quoteHash }]);
  record.baseUnit = 10n ** BigInt(baseDecimals);
  record.domainManifest = { ...prior.domainManifest, manifestVersion: 3, executionVerifierId: 'multi-strategy-account-v1',
    executionVerifierCodeHash: record.accountCodeHash, supportedSettlementClasses: ['ATOMIC_POSTCONDITION'] };
  record.domain = { domainId: `eip155:${chain.id}`, domainManifestVersion: 3, domainManifestHash: `0x${toHex(domainManifestHash(record.domainManifest))}` };
  save();
} else if (phase === 'propose-domain') {
  await call('propose-domain', 'proposer', 'ProtocolConfig', address('protocolConfig'), 'proposeDomain', [3, record.domain.domainManifestHash]);
} else if (phase === 'activate-domain') {
  await call('activate-domain', 'executor', 'ProtocolConfig', address('protocolConfig'), 'activateDomain');
  await deploy('reservationBook', 'FirmInventoryReservationBook', [address('protocolConfig'), baseToken, quoteToken, 3600n,
    record.baseUnit / 1000n, record.baseUnit / 100n]);
  await call('create-account', 'deployer', 'NaryxMultiStrategyAccountFactory', address('accountFactory'), 'create', [record.owner]);
  record.account = await read('NaryxMultiStrategyAccountFactory', address('accountFactory'), 'accountOf', [record.owner]);
  record.packageId = hash(`naryx-recovery-cohort-v1:${chain.id}:${record.account}`);
  record.instances = {};
  for (const id of ['spotFactory', 'perpetualFactory', 'nearFutureFactory', 'farFutureFactory']) {
    const name = id === 'spotFactory' ? 'UniswapV3TypedSpotAdapterFactory' : 'RecoverableTypedPerpAdapterFactory';
    await call(`create-${id}`, 'deployer', name, address(id), 'create', [record.account, record.packageId]);
    const instance = await read(name, address(id), 'adapterOf', [record.account, record.packageId]);
    record.instances[id] = { address: instance, codeHash: await codeHash(instance) };
    save();
  }
} else if (phase === 'deploy-calendar-reservation-book') {
  assert.equal(record.activationState, 'ACTIVE');
  const old = address('reservationBook');
  const occupancy = await read('FirmInventoryReservationBook', old, 'solverStrategyKey', [record.solver, record.account]);
  assert.equal(await read('FirmInventoryReservationBook', old, 'liveReservation', [occupancy]), `0x${'0'.repeat(64)}`,
    'Resolve existing inventory before activating another reservation book');
  const perReservation = await read('FirmInventoryReservationBook', old, 'maximumBaseAtomsPerReservation');
  const perSolver = await read('FirmInventoryReservationBook', old, 'maximumReservedBaseAtomsPerSolver');
  await deploy('calendarReservationBook', 'FirmInventoryReservationBook',
    [address('protocolConfig'), baseToken, quoteToken, 21_600n, perReservation, perSolver]);
  assert.equal(await read('FirmInventoryReservationBook', address('calendarReservationBook'), 'maximumTtlSeconds'), 21_600n);
} else if (phase === 'configure') {
  const domain = { domainIdHash: hash(record.domain.domainId), manifestVersion: 3, manifestHash: record.domain.domainManifestHash };
  const templates = ['cash-and-carry-v1', 'calendar-spread-v1', 'perpetual-funding-spread-v1'];
  record.templates = templates.map(id => ({ templateId: hash(id), templateVersion: 1,
    templateManifestHash: manifest({ id, version: 1, domain: record.domain, adapterSemantics: 'generation-bound-recovery-v1' }) }));
  record.series = record.templates.map(t => ({ seriesId: t.templateId, manifestVersion: 1,
    manifestHash: manifest({ domain: record.domain, template: t, recovery: 'exact-entry-generation' }) }));
  record.series.sort((a, b) => {
    const params = parseAbiParameters('bytes32,uint32,bytes32');
    return keccak256(encodeAbiParameters(params, [a.seriesId, 1, a.manifestHash])).localeCompare(
      keccak256(encodeAbiParameters(params, [b.seriesId, 1, b.manifestHash])));
  });
  record.bindings = [];
  for (const [id, templateIds] of [['spotFactory', [0]], ['perpetualFactory', [0, 2]], ['nearFutureFactory', [1]], ['farFutureFactory', [1]]]) {
    for (const templateIndex of templateIds) {
      const binding = { domain, identity: { subjectId: hash(`recovery:${chain.id}:${id}:${templateIndex}`), manifestVersion: 1,
        manifestHash: hash('pending') }, mode: 1, adapter: address(id), expectedCodeHash: await codeHash(address(id)),
        adapterClassId: hash(id === 'spotFactory' ? 'naryx.evm.spot-exact' : id === 'perpetualFactory' ? 'naryx.evm.perp-recoverable' : 'naryx.evm.future-recoverable'),
        adapterClassVersion: 1, template: record.templates[templateIndex], settlementClass: { classId: hash('ATOMIC_POSTCONDITION'), classVersion: 1 },
        baseAsset: { token: baseToken, expectedCodeHash: await codeHash(baseToken) },
        quoteAsset: { token: quoteToken, expectedCodeHash: await codeHash(quoteToken) }, maximumGasLimit: 2_000_000n };
      const control = { state: 0, maximumApprovalAtoms: id === 'spotFactory' ? record.baseUnit : 10_000_000n,
        maximumGrossNotionalAtoms: 20_000_000n };
      binding.identity.manifestHash = manifest({ ...binding, identity: { ...binding.identity, manifestHash: undefined }, control });
      record.bindings.push({ binding, control });
    }
  }
  const quoteCodeHash = await codeHash(quoteToken);
  record.feePolicy = { version: 1, manifestHash: hash('pending'), token: quoteToken, expectedTokenCodeHash: quoteCodeHash,
    protocolRecipient: record.owner, maximumProtocolFeeBps: 0, maximumSolverFeeBps: 0, paused: false };
  record.feePolicy.manifestHash = manifest({ ...record.feePolicy, manifestHash: undefined, domain: record.domain });
  record.riskDomainId = hash(`recovery-risk-v1:${chain.id}`);
  record.dependencies = record.bindings.map(({ binding }) => ({ dependencyId: binding.identity.subjectId,
    maximumGrossQuoteAtoms: 20_000_000n })).sort((a, b) => a.dependencyId.localeCompare(b.dependencyId));
  record.riskPolicy = { manifestVersion: 1, manifestHash: hash('pending'), domainManifestVersion: 3,
    domainManifestHash: record.domain.domainManifestHash, accountingToken: quoteToken, expectedTokenCodeHash: quoteCodeHash,
    grossCapQuoteAtoms: 20_000_000n, netCapQuoteAtoms: 20_000_000n, minimumMarginFloorQuoteAtoms: 1_000_000n,
    maximumLeverageBps: 50_000n, maximumStalenessMs: 60_000n, maximumTimeToUnwindMs: 3_600_000n,
    requiredRecoveryReserveQuoteAtoms: 1_000_000n, aggregateHaircutBps: 100 };
  record.riskPolicy.manifestHash = manifest({ ...record.riskPolicy, manifestHash: undefined, series: record.series, dependencies: record.dependencies });
  save();
  for (const { binding, control } of record.bindings) await call(`propose-${binding.identity.subjectId}`, 'proposer',
    'TypedStrategyAdapterRegistry', address('adapterRegistry'), 'proposeRegistration', [binding, control]);
  await call('propose-fees', 'proposer', 'StrategyFeePolicyRegistry', address('feePolicyRegistry'), 'proposePolicy', [feeSubjectId, record.feePolicy]);
  await call('propose-risk', 'proposer', 'RiskDomainRegistry', address('riskDomainRegistry'), 'proposePolicy',
    [record.riskDomainId, record.riskPolicy, record.series, record.dependencies]);
  await call('propose-unpause', 'proposer', 'ProtocolConfig', address('protocolConfig'), 'scheduleUnpause');
} else if (phase === 'activate') {
  for (const { binding } of record.bindings) await call(`activate-${binding.identity.subjectId}`, 'executor',
    'TypedStrategyAdapterRegistry', address('adapterRegistry'), 'activateRegistration', [binding.identity.subjectId]);
  await call('activate-fees', 'executor', 'StrategyFeePolicyRegistry', address('feePolicyRegistry'), 'activate', [feeSubjectId]);
  await call('activate-risk', 'executor', 'RiskDomainRegistry', address('riskDomainRegistry'), 'activate', [record.riskDomainId]);
  await call('activate-unpause', 'executor', 'ProtocolConfig', address('protocolConfig'), 'activateUnpause');
  await send('fund-dedicated-solver', 'deployer', '0x', record.solver, 300_000_000_000_000n);
  record.activationState = 'ACTIVE'; save();
} else if (phase === 'propose-risk-dependencies') {
  if (record.riskUpgrade === undefined) {
    const latest = await read('RiskDomainRegistry', address('riskDomainRegistry'), 'latestVersion', [record.riskDomainId]);
    const dependencies = record.bindings.map(({ binding }) => ({ dependencyId: binding.identity.subjectId,
      maximumGrossQuoteAtoms: record.riskPolicy.grossCapQuoteAtoms }))
      .sort((a, b) => a.dependencyId.localeCompare(b.dependencyId));
    const policy = { ...record.riskPolicy, manifestVersion: latest + 1, manifestHash: hash('pending') };
    policy.manifestHash = manifest({ ...policy, manifestHash: undefined, series: record.series, dependencies });
    record.riskUpgrade = { policy, dependencies }; save();
  }
  await call(`propose-risk-v${record.riskUpgrade.policy.manifestVersion}`, 'proposer', 'RiskDomainRegistry',
    address('riskDomainRegistry'), 'proposePolicy',
    [record.riskDomainId, record.riskUpgrade.policy, record.series, record.riskUpgrade.dependencies]);
} else if (phase === 'activate-risk-dependencies') {
  assert.ok(record.riskUpgrade);
  await call(`activate-risk-v${record.riskUpgrade.policy.manifestVersion}`, 'executor', 'RiskDomainRegistry',
    address('riskDomainRegistry'), 'activate', [record.riskDomainId]);
  record.riskPolicy = record.riskUpgrade.policy;
  record.dependencies = record.riskUpgrade.dependencies;
  save();
} else {
  console.log(JSON.stringify({ network, chainId: chain.id, activationState: record.activationState ?? 'PENDING',
    contracts: record.contracts, account: record.account, solver: record.solver, gasReservedWei: String(record.gasReservedWei) }));
}
