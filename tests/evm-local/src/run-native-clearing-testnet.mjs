import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createPublicClient, createWalletClient, encodeDeployData, encodeFunctionData, getAddress,
  getContractAddress, http, keccak256, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia, arbitrumSepolia } from 'viem/chains';
import { nativeClearingPolicy, nativeClearingMarkObservation, nativeClearingAccount, nativeClearingDomainState,
  nativeClearingCollateralAuthorization, packageMatchingPolicy, packageMatchingPolicyHash, parseProtocolJson,
  stringifyProtocolJson, toHex, versionedManifestRef } from '@naryx/protocol-types';
import { evmNativeClearingAccountId } from '@naryx/adapter-evm';

const root = resolve(import.meta.dirname, '../../..');
const budget = 10_000_000_000_000_000n;
const tokenAbi = parseAbi(['function mint(address,uint256)', 'function approve(address,uint256)',
  'function balanceOf(address) view returns(uint256)', 'function decimals() view returns(uint8)']);

export function reserveTestnetBudget(reserved, gas, maxFeePerGas, value = 0n) {
  for (const amount of [reserved, gas, maxFeePerGas, value]) assert.ok(typeof amount === 'bigint' && amount >= 0n, 'Invalid testnet budget amount');
  const next = reserved + gas * maxFeePerGas + value;
  assert.ok(next <= budget, 'Approved per-network test ETH cap exceeded');
  return next;
}

export function buildClearingPolicy(profile, matching, authority) {
  const matchingPolicy = packageMatchingPolicy(matching);
  assert.equal(profile.chainId === 84532 || profile.chainId === 421614, true, 'Sepolia only');
  assert.equal(matchingPolicy.environment, 'testnet');
  assert.equal(matchingPolicy.executionClassId, profile.executionClassId);
  return nativeClearingPolicy({ version: 1, environment: 'testnet',
    clearingDomainId: `${profile.profileId}-clearing-v2`, executionClassId: profile.executionClassId,
    matchingPolicyHash: packageMatchingPolicyHash(matchingPolicy),
    strategySeries: versionedManifestRef(profile.seriesId, profile.seriesVersion, profile.seriesManifestHash),
    riskDomainId: `${profile.profileId}-clearing-risk-v2`,
    markSource: versionedManifestRef(`${profile.profileId}-controlled-clearing-mark-v2`, 1, profile.seriesManifestHash),
    markAuthorityId: getAddress(authority), accountingAsset: profile.quoteAsset,
    packageQuantityIncrementAtoms: 1_000_000_000_000_000n, priceTickQuoteAtoms: 1n,
    initialMarginQuoteAtomsPerIncrement: 200n, maintenanceMarginQuoteAtomsPerIncrement: 100n,
    maximumPositionAtoms: 1_000_000_000_000_000_000n, maximumOpenInterestAtoms: 2_000_000_000_000_000_000n,
    maximumDefaultTransferDiscountBps: 500n, markMaximumStalenessMs: 7_200_000n });
}

async function main() {
  const { values } = parseArgs({ options: { network: { type: 'string' }, metadata: { type: 'string' },
    output: { type: 'string' }, step: { type: 'string', default: 'prepare' }, broadcast: { type: 'boolean', default: false },
    'source-account': { type: 'string' }, 'admin-url': { type: 'string' },
    'password-env': { type: 'string', default: 'NARYX_DEPLOYER_PASSWORD' } } });
  const chains = { 'base-sepolia': baseSepolia, 'arbitrum-sepolia': arbitrumSepolia };
  assert.ok(Object.hasOwn(chains, values.network ?? ''), 'Select a supported Sepolia network');
  assert.ok(values.output && isAbsolute(values.output) && !resolve(values.output).startsWith(`${root}/`), 'Evidence must be outside this repository');
  assert.ok(['prepare', 'deploy', 'fund', 'mark', 'reconcile'].includes(values.step), 'Unknown step');
  const chain = chains[values.network];
  const rpc = process.env[chain.id === 84532 ? 'NARYX_BASE_SEPOLIA_RPC_URL' : 'NARYX_ARBITRUM_SEPOLIA_RPC_URL'];
  assert.ok(rpc, 'Testnet RPC is required');
  const client = createPublicClient({ chain, transport: http(rpc, { timeout: 15_000, retryCount: 1 }) });
  assert.equal(await client.getChainId(), chain.id, 'RPC chain identity differs');
  const release = JSON.parse(readFileSync(resolve(root, `deployments/evm/${values.network}/multi-strategy-release.json`), 'utf8'));
  assert.equal(release.environment, 'testnet');
  assert.equal(release.chainId, chain.id);
  const artifact = JSON.parse(readFileSync(resolve(root, 'contracts/evm/out/NativePackageClearingHouse.sol/NativePackageClearingHouse.json'), 'utf8'));
  const password = process.env[values['password-env']];
  assert.ok(password, 'Keystore password environment variable is required');
  const roles = { operator: 'naryx-market-owner-v1', trader: 'naryx-test-trader-v1', maker: 'naryx-clearing-maker-v1',
    backstop: 'naryx-clearing-backstop-v1', pauser: 'naryx-pauser-v1', mark: 'naryx-funding-keeper-v1' };
  const cast = (operation, name) => {
    try { return execFileSync('cast', ['wallet', operation, '--account', name, '--password', password],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim(); }
    catch { throw new Error('Cannot unlock the requested testnet keystore'); }
  };
  const actors = Object.fromEntries(Object.entries(roles).map(([role, name]) => [role, getAddress(cast('address', name))]));
  const collateralToken = getAddress(release.conformance.quoteAsset);
  const code = await client.getCode({ address: collateralToken });
  assert.ok(code && code !== '0x', 'Collateral has no code');
  assert.equal(await client.readContract({ address: collateralToken, abi: tokenAbi, functionName: 'decimals' }), 6);
  let record;
  const save = () => writeFileSync(values.output, `${stringifyProtocolJson(record)}\n`, { mode: 0o600 });
  if (values.step === 'prepare') {
    assert.ok(!existsSync(values.output), 'Inspect the existing evidence instead of replacing it');
    assert.ok(values.metadata && isAbsolute(values.metadata), 'Live release metadata is required');
    const metadata = parseProtocolJson(readFileSync(values.metadata, 'utf8'));
    const profile = metadata.profiles.find((item) => item.chainId === chain.id);
    assert.ok(profile, 'No live profile for this chain');
    const matching = metadata.matchingPolicies.find((item) => item.executionClassId === profile.executionClassId);
    const policy = buildClearingPolicy(profile, matching, actors.mark);
    const configuration = { policyHash: `0x${toHex(policy.policyHash)}`, governor: actors.operator, pauser: actors.pauser,
      markAuthority: actors.mark, packageQuantityIncrementAtoms: policy.packageQuantityIncrementAtoms,
      priceTickQuoteAtoms: policy.priceTickQuoteAtoms, initialMarginQuoteAtomsPerIncrement: policy.initialMarginQuoteAtomsPerIncrement,
      maintenanceMarginQuoteAtomsPerIncrement: policy.maintenanceMarginQuoteAtomsPerIncrement,
      maximumPositionAtoms: policy.maximumPositionAtoms, maximumOpenInterestAtoms: policy.maximumOpenInterestAtoms,
      maximumDefaultTransferDiscountBps: Number(policy.maximumDefaultTransferDiscountBps),
      markMaximumStalenessSeconds: policy.markMaximumStalenessMs / 1_000n, defaultAuctionDurationSeconds: 60n,
      feeUpdateDelaySeconds: 60n, maximumFeeBps: 100 };
    const nonce = await client.getTransactionCount({ address: actors.operator, blockTag: 'pending' });
    const house = getContractAddress({ from: actors.operator, nonce: BigInt(nonce) });
    const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: [collateralToken, configuration] });
    record = { version: 1, environment: 'testnet', chainId: chain.id, actors, policy, configuration,
      matchingPolicy: matching, profile, house, nonce, collateralToken, collateralTokenCodeHash: keccak256(code),
      deploymentDataHash: keccak256(data), transactions: {}, budgetReservedWei: 0n,
      funding: { trader: 1_000_000n, maker: 5_000_000n, backstop: 5_000_000n, reserve: 1_000_000n },
      evidenceScope: 'CONTROLLED_TESTNET_CASH_SETTLED_PACKAGE_NOT_EXTERNAL_LEG_EXECUTION' };
    mkdirSync(dirname(values.output), { recursive: true, mode: 0o700 });
    save();
    console.log(JSON.stringify({ network: values.network, house, collateralToken, fundingTestUSDC: 12, entryPaused: true }));
    return;
  }
  assert.equal(values.broadcast, true, 'Writes require --broadcast');
  record = structuredClone(parseProtocolJson(readFileSync(values.output, 'utf8')));
  assert.equal(record.environment, 'testnet');
  assert.equal(record.chainId, chain.id);
  assert.deepEqual(record.actors, actors);
  assert.equal(record.collateralToken, collateralToken);
  assert.equal(record.collateralTokenCodeHash, keccak256(code));
  const policy = buildClearingPolicy(record.profile, record.matchingPolicy, actors.mark);
  assert.equal(toHex(policy.policyHash), toHex(record.policy.policyHash));
  assert.equal(record.funding.trader + record.funding.maker + record.funding.backstop + record.funding.reserve, 12_000_000n);
  const wallets = new Map();
  const wallet = (name) => {
    if (!wallets.has(name)) wallets.set(name, createWalletClient({ account: privateKeyToAccount(cast('private-key', name)), chain, transport: http(rpc) }));
    return wallets.get(name);
  };
  const send = async (id, name, request) => {
    assert.equal(await client.getChainId(), chain.id, 'Chain changed before signing');
    let transaction = record.transactions[id];
    if (!transaction) {
      const signer = wallet(name);
      const gas = (await client.estimateGas({ ...request, account: signer.account })) * 12n / 10n;
      const fees = await client.estimateFeesPerGas();
      const cost = gas * fees.maxFeePerGas + (request.value ?? 0n);
      const nextBudget = reserveTestnetBudget(record.budgetReservedWei, gas, fees.maxFeePerGas, request.value ?? 0n);
      const prepared = await signer.prepareTransactionRequest({ ...request, gas, ...fees, chain, account: signer.account });
      const raw = await signer.signTransaction(prepared);
      transaction = { hash: keccak256(raw), raw, from: signer.account.address, gasCapWei: cost };
      record.transactions[id] = transaction;
      record.budgetReservedWei = nextBudget;
      save();
    }
    let receipt;
    try { receipt = await client.getTransactionReceipt({ hash: transaction.hash }); } catch {}
    if (!receipt) {
      assert.equal(await client.getChainId(), chain.id);
      try { await client.sendRawTransaction({ serializedTransaction: transaction.raw }); }
      catch (error) { if (!/already known|nonce too low/i.test(error.shortMessage ?? '')) throw error; }
      receipt = await client.waitForTransactionReceipt({ hash: transaction.hash, confirmations: 2 });
    }
    assert.equal(receipt.status, 'success', `${id} reverted`);
    transaction.blockNumber = receipt.blockNumber;
    transaction.blockHash = receipt.blockHash;
    save();
    console.log(JSON.stringify({ step: id, transactionHash: receipt.transactionHash, block: receipt.blockNumber.toString() }));
    return receipt;
  };
  if (values.step === 'deploy') {
    if (await client.getBalance({ address: actors.operator }) < 2_000_000_000_000_000n) {
      assert.ok(values['source-account'], 'A testnet gas source account is required');
      await send('gas-operator', values['source-account'], { to: actors.operator, value: 2_000_000_000_000_000n });
    }
    const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: [collateralToken, record.configuration] });
    assert.equal(keccak256(data), record.deploymentDataHash, 'Deployment configuration changed');
    if (!record.transactions.deploy) assert.equal(await client.getTransactionCount({ address: actors.operator, blockTag: 'pending' }), record.nonce, 'Deployment nonce changed');
    const receipt = await send('deploy', roles.operator, { data, value: 0n });
    assert.equal(getAddress(receipt.contractAddress), getAddress(record.house));
    record.clearingHouseCodeHash = keccak256(await client.getCode({ address: record.house }));
    save();
    return;
  }
  assert.ok(record.clearingHouseCodeHash, 'Deploy and verify the clearing house first');
  assert.equal(keccak256(await client.getCode({ address: record.house })), record.clearingHouseCodeHash);
  if (values.step === 'mark') {
    assert.ok(record.transactions['fund-reserve']?.blockNumber, 'Finish funding first');
    if (await client.getBalance({ address: actors.mark }) < 100_000_000_000_000n) {
      assert.ok(values['source-account'], 'A testnet gas source account is required');
      await send('gas-mark', values['source-account'], { to: actors.mark, value: 400_000_000_000_000n });
    }
    if (!record.mark) {
      const now = (await client.getBlock()).timestamp * 1_000n;
      const observation = nativeClearingMarkObservation({ version: 1, policyHash: policy.policyHash,
        source: policy.markSource, authorityId: policy.markAuthorityId, sourceSequence: 1n,
        priceTicks: 1_000n, observedAtMs: now, validUntilMs: now + policy.markMaximumStalenessMs }, policy);
      record.mark = { observation, authorization: { scheme: 'EIP191_SECP256K1',
        signature: await wallet(roles.mark).signMessage({ message: { raw: observation.observationHash } }) } };
      save();
    }
    const observation = record.mark.observation;
    await send('publish-mark', roles.mark, { to: record.house, data: encodeFunctionData({ abi: artifact.abi,
      functionName: 'publishMark', args: [`0x${toHex(observation.observationHash)}`, observation.priceTicks,
        observation.sourceSequence, observation.validUntilMs / 1_000n] }) });
    return;
  }
  if (values.step === 'reconcile') {
    assert.ok(values['admin-url'], 'A loopback API connection is required');
    const origin = new URL(values['admin-url']);
    assert.ok(origin.protocol === 'http:' && origin.hostname === '127.0.0.1' && origin.pathname === '/', 'Only a loopback API is allowed');
    assert.ok(record.transactions['publish-mark']?.blockNumber && record.mark, 'Publish the controlled testnet mark first');
    const finalized = await client.getBlock({ blockTag: 'finalized' });
    const required = record.transactions['publish-mark'].blockNumber;
    assert.ok(finalized.number >= required, `Waiting for chain finality: ${finalized.number}/${required}`);
    const request = async (path, body) => {
      const response = await fetch(new URL(path, origin), body === undefined ? {} : { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: stringifyProtocolJson(body) });
      const value = parseProtocolJson(await response.text());
      if (response.status === 404 && body === undefined) return undefined;
      assert.ok(response.ok, `${path}: ${response.status} ${value.error?.code ?? value.code ?? 'rejected'}`);
      return value;
    };
    const evidenceBlock = (id) => ({ number: record.transactions[id].blockNumber, hash: record.transactions[id].blockHash });
    const domainPath = `/v1/native-clearing/domains/${policy.clearingDomainId}`;
    let domain = await request(domainPath);
    if (!domain) {
      const state = nativeClearingDomainState({ version: 1, policyHash: policy.policyHash, openInterestAtoms: 0n,
        recoveryReserveQuoteAtoms: 0n, sequence: 0n }, policy);
      await request('/internal/native-clearing/domains', { policy, state, evidenceBlock: evidenceBlock('deploy') });
      domain = await request(domainPath);
    }
    assert.equal(toHex(domain.policy.policyHash), toHex(policy.policyHash));
    const currentMark = await request(`${domainPath}/mark`);
    if (!currentMark) {
      // Funding proofs cover registered account state. The signed mark is verified onchain at execution.
      await request('/internal/native-clearing/marks', { clearingDomainId: policy.clearingDomainId, ...record.mark,
        evidenceBlock: evidenceBlock('deploy') });
    } else assert.equal(toHex(currentMark.observation.observationHash), toHex(record.mark.observation.observationHash));
    for (const role of ['trader', 'maker', 'backstop']) {
      const accountId = `${policy.clearingDomainId}-${role}`;
      let account = (await request(`/v1/native-clearing/accounts/${accountId}`))?.account;
      if (!account) {
        account = nativeClearingAccount({ version: 1, policyHash: policy.policyHash, accountId,
          ownerId: actors[role], collateralQuoteAtoms: 0n, cashBalanceQuoteAtoms: 0n, positionAtoms: 0n, sequence: 0n }, policy);
        await request('/internal/native-clearing/accounts', { clearingDomainId: policy.clearingDomainId, account,
          evidenceBlock: evidenceBlock(`open-${role}`) });
      }
      if (account.collateralQuoteAtoms === record.funding[role] && account.sequence === 1n) continue;
      assert.equal(account.sequence, 0n, 'Unexpected existing clearing activity');
      const authorization = nativeClearingCollateralAuthorization({ version: 1, policyHash: policy.policyHash,
        accountId, ownerId: actors[role], expectedAccountHash: account.accountHash, expectedAccountSequence: account.sequence,
        collateralDeltaQuoteAtoms: record.funding[role], validUntilUnit: 'EVM_UNIX_SECONDS',
        validUntilValue: BigInt(Math.floor(Date.now() / 1000)) + 3600n });
      await request('/internal/native-clearing/collateral', { authorization, ownerSignature: {
        scheme: 'EIP191_SECP256K1', signature: await wallet(roles[role]).signMessage({ message: { raw: authorization.authorizationHash } }),
      }, evidenceBlock: evidenceBlock(`deposit-${role}`) });
    }
    domain = await request(domainPath);
    if (domain.state.recoveryReserveQuoteAtoms === 0n) await request('/internal/native-clearing/reserve', {
      clearingDomainId: policy.clearingDomainId, expectedStateHash: domain.state.stateHash,
      reserveDeltaQuoteAtoms: record.funding.reserve, evidenceBlock: evidenceBlock('fund-reserve') });
    const backing = await request(`${domainPath}/backing`);
    assert.equal(backing.backing.verifiedAccountCount, 3);
    assert.equal(backing.backing.verifiedCollateralAndReserveAtoms, 12_000_000n);
    assert.equal(backing.backing.entryPaused, true);
    record.reconciledAtMs = BigInt(Date.now());
    save();
    console.log(JSON.stringify({ clearingDomainId: policy.clearingDomainId, verifiedAccounts: 3, fundedTestUSDC: 12, entryPaused: true }));
    return;
  }
  assert.equal(await client.readContract({ address: record.house, abi: artifact.abi, functionName: 'entryPaused' }), true);
  for (const role of ['maker', 'backstop']) {
    if (await client.getBalance({ address: actors[role] }) < 100_000_000_000_000n) {
      assert.ok(values['source-account'], 'A testnet gas source account is required');
      await send(`gas-${role}`, values['source-account'], { to: actors[role], value: 400_000_000_000_000n });
    }
  }
  for (const role of ['trader', 'maker', 'backstop']) {
    const id = `${policy.clearingDomainId}-${role}`;
    const accountId = evmNativeClearingAccountId(record.configuration.policyHash, id);
    await send(`open-${role}`, roles[role], { to: record.house, data: encodeFunctionData({ abi: artifact.abi, functionName: 'openAccount', args: [accountId] }) });
    await send(`mint-${role}`, roles.operator, { to: collateralToken, data: encodeFunctionData({ abi: tokenAbi, functionName: 'mint', args: [actors[role], record.funding[role]] }) });
    await send(`approve-${role}`, roles[role], { to: collateralToken, data: encodeFunctionData({ abi: tokenAbi, functionName: 'approve', args: [record.house, record.funding[role]] }) });
    await send(`deposit-${role}`, roles[role], { to: record.house, data: encodeFunctionData({ abi: artifact.abi, functionName: 'deposit', args: [accountId, record.funding[role]] }) });
  }
  await send('mint-reserve', roles.operator, { to: collateralToken, data: encodeFunctionData({ abi: tokenAbi, functionName: 'mint', args: [actors.operator, record.funding.reserve] }) });
  await send('approve-reserve', roles.operator, { to: collateralToken, data: encodeFunctionData({ abi: tokenAbi, functionName: 'approve', args: [record.house, record.funding.reserve] }) });
  await send('fund-reserve', roles.operator, { to: record.house, data: encodeFunctionData({ abi: artifact.abi, functionName: 'fundRecoveryReserve', args: [record.funding.reserve] }) });
  assert.ok(await client.readContract({ address: collateralToken, abi: tokenAbi, functionName: 'balanceOf', args: [record.house] }) >= 12_000_000n);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.shortMessage ?? error.message); process.exitCode = 1; });
}
