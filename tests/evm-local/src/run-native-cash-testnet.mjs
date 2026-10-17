import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createPublicClient, createWalletClient, encodeDeployData, encodeFunctionData, getAddress,
  getContractAddress, hashTypedData, http, keccak256, parseAbi, recoverTypedDataAddress, stringToHex, zeroAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrumSepolia, baseSepolia } from 'viem/chains';
import { domainRef, nativeClearingPolicy, parseProtocolJson, stringifyProtocolJson, toHex, versionedManifestRef } from '@naryx/protocol-types';
import { evmNativeClearingAccountId } from '@naryx/adapter-evm';
import { reserveTestnetBudget } from './run-native-clearing-testnet.mjs';

const root = resolve(import.meta.dirname, '../../..');
const tokenAbi = parseAbi(['function mint(address,uint256)', 'function approve(address,uint256)',
  'function decimals() view returns(uint8)', 'function balanceOf(address) view returns(uint256)']);
const sourceAbi = parseAbi(['function description() view returns(string)', 'function decimals() view returns(uint8)',
  'function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)']);
const roles = { operator: 'naryx-market-owner-v1', maker: 'naryx-clearing-maker-v1', trader: 'naryx-test-trader-v1',
  mark: 'naryx-funding-keeper-v1', pauser: 'naryx-pauser-v1' };

export function reserveNativeCashOperatorBudget(reservedWei, gas, maxFeePerGas, value = 0n) {
  for (const amount of [reservedWei, gas, maxFeePerGas, value]) assert.ok(typeof amount === 'bigint' && amount >= 0n);
  const next = reservedWei + gas * maxFeePerGas + value;
  assert.ok(next <= 1_000_000_000_000_000n, 'Reserved operator test gas slice is exhausted');
  return next;
}

export function nativeCashSource(chainId) {
  assert.ok(chainId === 84532 || chainId === 421614, 'Native cash setup is Sepolia only');
  return { oracle: getAddress(chainId === 84532 ? '0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1' : '0xd30e2101a97dcbAeBCBC04F14C3f624E67A35165'),
    maximumOracleAgeSeconds: chainId === 84532 ? 1800n : 300n };
}

export function nativeCashPolicy(network, asset, controller, source) {
  assert.ok(network === 'base-sepolia' || network === 'arbitrum-sepolia');
  const seriesId = `${network}-eth-cash-range-v1`;
  const referenceHash = keccak256(stringToHex(stringifyProtocolJson(source))).slice(2);
  return nativeClearingPolicy({ version: 1, environment: 'testnet', clearingDomainId: `${seriesId}-clearing`,
    executionClassId: 'evm-native-cash-range-v1', matchingPolicyHash: keccak256(stringToHex('NATIVE_CASH_RANGE_BILATERAL_RFQ_V1')).slice(2),
    strategySeries: versionedManifestRef(seriesId, 1, referenceHash), riskDomainId: `${seriesId}-risk`,
    markSource: versionedManifestRef(`${network}-eth-usd-chainlink-range-v1`, 1, referenceHash),
    markAuthorityId: controller, accountingAsset: asset, packageQuantityIncrementAtoms: 1n, priceTickQuoteAtoms: 1n,
    initialMarginQuoteAtomsPerIncrement: 4_000_001n, maintenanceMarginQuoteAtomsPerIncrement: 4_000_001n,
    maximumPositionAtoms: 5n, maximumOpenInterestAtoms: 5n, maximumDefaultTransferDiscountBps: 500n,
    markMaximumStalenessMs: 600_000n });
}

async function main() {
  const { values } = parseArgs({ options: { network: { type: 'string' }, output: { type: 'string' },
    'previous-evidence': { type: 'string' }, 'password-env': { type: 'string', default: 'SETRYN_DEPLOYER_PASSWORD' },
    'service-origin': { type: 'string' },
    step: { type: 'string', default: 'prepare' }, broadcast: { type: 'boolean', default: false } } });
  const chain = values.network === 'base-sepolia' ? baseSepolia : values.network === 'arbitrum-sepolia' ? arbitrumSepolia : undefined;
  assert.ok(chain, 'Select a supported Sepolia network');
  assert.ok(values.output && isAbsolute(values.output) && !resolve(values.output).startsWith(root + '/'), 'Checkpoint must be outside the repository');
  assert.ok(['prepare', 'deploy', 'fund', 'mark', 'register', 'activate', 'pause', 'entry', 'exit', 'observe'].includes(values.step), 'Unknown native cash step');
  const rpc = process.env[chain.id === 84532 ? 'NARYX_BASE_SEPOLIA_RPC_URL' : 'NARYX_ARBITRUM_SEPOLIA_RPC_URL'];
  assert.ok(rpc, 'Testnet RPC is required');
  const client = createPublicClient({ chain, transport: http(rpc, { timeout: 15_000, retryCount: 1 }) });
  assert.equal(await client.getChainId(), chain.id);
  const password = process.env[values['password-env']];
  assert.ok(password, 'Local keystore password is required');
  const cast = (method, role) => {
    try { return execFileSync('cast', ['wallet', method, '--account', roles[role], '--password', password],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim(); } catch { throw new Error('Cannot unlock native cash test role'); }
  };
  const actors = Object.fromEntries(Object.keys(roles).map(role => [role, getAddress(cast('address', role))]));
  const release = JSON.parse(readFileSync(resolve(root, `deployments/evm/${values.network}/multi-strategy-release.json`), 'utf8'));
  assert.equal(release.environment, 'testnet'); assert.equal(release.chainId, chain.id);
  const artifact = JSON.parse(readFileSync(resolve(root, 'contracts/evm/out/NativeCashRangeMarket.sol/NativeCashRangeMarket.json'), 'utf8'));
  const houseArtifact = JSON.parse(readFileSync(resolve(root, 'contracts/evm/out/NativePackageClearingHouse.sol/NativePackageClearingHouse.json'), 'utf8'));
  const collateralToken = getAddress(release.conformance.quoteAsset);
  const source = { chainId: BigInt(chain.id), ...nativeCashSource(chain.id), sequencerFeed: zeroAddress, markUpdater: actors.mark,
    lowerBound: 1000n * 10n ** 8n, upperBound: 5000n * 10n ** 8n, underlyingAtomsPerPackage: 10n ** 15n,
    sequencerGracePeriodSeconds: 0n, oracleDecimals: 8, underlyingDecimals: 18, allowMissingSequencer: true };
  const collateralCode = await client.getCode({ address: collateralToken });
  if (values.step !== 'observe' && values.step !== 'pause') {
    const [description, decimals, round, block] = await Promise.all([
      client.readContract({ address: source.oracle, abi: sourceAbi, functionName: 'description' }),
      client.readContract({ address: source.oracle, abi: sourceAbi, functionName: 'decimals' }),
      client.readContract({ address: source.oracle, abi: sourceAbi, functionName: 'latestRoundData' }), client.getBlock(),
    ]);
    assert.equal(description, 'ETH / USD'); assert.equal(decimals, 8);
    assert.ok(round[1] > 0n && round[3] <= block.timestamp && block.timestamp - round[3] < source.maximumOracleAgeSeconds, 'Source is stale');
  }
  assert.ok(collateralCode && collateralCode !== '0x');
  assert.equal(await client.readContract({ address: collateralToken, abi: tokenAbi, functionName: 'decimals' }), 6);
  let record;
  const save = () => writeFileSync(values.output, stringifyProtocolJson(record) + '\n', { mode: 0o600 });
  if (values.step === 'prepare') {
    assert.ok(!existsSync(values.output), 'Existing native cash evidence must not be replaced');
    assert.ok(values['previous-evidence'] && isAbsolute(values['previous-evidence']), 'Prior budget evidence is required');
    const previous = parseProtocolJson(readFileSync(values['previous-evidence'], 'utf8'));
    assert.equal(previous.environment, 'testnet'); assert.equal(previous.chainId, chain.id);
    assert.ok(previous.budgetReservedWei >= 0n && previous.budgetReservedWei <= 10n ** 16n);
    const priorFunding = Object.values(previous.funding).reduce((sum, amount) => sum + amount, 0n);
    assert.ok(priorFunding + 50_000_000n <= 100_000_000n, 'Approved test token budget exceeded');
    const nonce = await client.getTransactionCount({ address: actors.operator, blockTag: 'pending' });
    const controller = getContractAddress({ from: actors.operator, nonce: BigInt(nonce) });
    assert.equal(previous.collateralToken, collateralToken);
    const policy = nativeCashPolicy(values.network, previous.policy.accountingAsset, controller, source);
    const configuration = { policyHash: `0x${toHex(policy.policyHash)}`, governor: actors.operator, pauser: actors.pauser,
      markAuthority: zeroAddress, packageQuantityIncrementAtoms: 1n, priceTickQuoteAtoms: 1n,
      initialMarginQuoteAtomsPerIncrement: policy.initialMarginQuoteAtomsPerIncrement,
      maintenanceMarginQuoteAtomsPerIncrement: policy.maintenanceMarginQuoteAtomsPerIncrement,
      maximumPositionAtoms: policy.maximumPositionAtoms, maximumOpenInterestAtoms: policy.maximumOpenInterestAtoms,
      maximumDefaultTransferDiscountBps: 500, markMaximumStalenessSeconds: 600n, defaultAuctionDurationSeconds: 60n,
      feeUpdateDelaySeconds: 60n, maximumFeeBps: 100 };
    const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: [collateralToken, configuration, source] });
    record = { version: 1, environment: 'testnet', chainId: chain.id, network: values.network, actors, source, nonce,
      controller, policy, configuration, collateralToken, collateralTokenCodeHash: keccak256(collateralCode),
      domain: domainRef(`eip155:${chain.id}`, release.domain.manifestVersion, release.domain.manifestHash),
      deploymentDataHash: keccak256(data), transactions: {}, budgetReservedWei: previous.budgetReservedWei,
      funding: { maker: 40_000_000n, trader: 10_000_000n }, priorFundingQuoteAtoms: priorFunding,
      disclosure: 'NATIVE_CASH_RANGE_ONLY_NOT_ROUTED_POSITIONS; TESTNET_WITHOUT_SEQUENCER_FEED' };
    mkdirSync(dirname(values.output), { recursive: true, mode: 0o700 }); save();
    console.log(stringifyProtocolJson({ controller, collateralToken, maker: actors.maker, trader: actors.trader,
      funding: record.funding, budgetAlreadyReservedWei: record.budgetReservedWei, entryPaused: true })); return;
  }
  assert.equal(values.broadcast, true, 'Writes require explicit --broadcast');
  record = structuredClone(parseProtocolJson(readFileSync(values.output, 'utf8')));
  assert.equal(record.environment, 'testnet'); assert.equal(record.chainId, chain.id);
  assert.deepEqual(record.actors, actors); assert.deepEqual(record.source, source);
  assert.equal(record.collateralToken, collateralToken); assert.equal(record.collateralTokenCodeHash, keccak256(collateralCode));
  const wallets = new Map();
  const wallet = role => {
    if (!wallets.has(role)) wallets.set(role, createWalletClient({ account: privateKeyToAccount(cast('private-key', role)), chain, transport: http(rpc) }));
    return wallets.get(role);
  };
  const send = async (id, role, request) => {
    assert.equal(await client.getChainId(), chain.id);
    let transaction = record.transactions[id];
    if (!transaction) {
      const signer = wallet(role);
      const gas = (await client.estimateGas({ ...request, account: signer.account })) * 12n / 10n;
      const fees = await client.estimateFeesPerGas();
      const next = reserveTestnetBudget(record.budgetReservedWei, gas, fees.maxFeePerGas, request.value ?? 0n);
      if (record.transactions['deposit-trader']) {
        record.operatorGasReservedWei = reserveNativeCashOperatorBudget(record.operatorGasReservedWei ?? 0n, gas, fees.maxFeePerGas, request.value ?? 0n);
      }
      const prepared = await signer.prepareTransactionRequest({ ...request, gas, ...fees });
      const raw = await signer.signTransaction(prepared);
      transaction = { hash: keccak256(raw), raw, from: signer.account.address };
      record.transactions[id] = transaction; record.budgetReservedWei = next; save();
    }
    let receipt; try { receipt = await client.getTransactionReceipt({ hash: transaction.hash }); } catch {}
    if (!receipt) {
      assert.equal(await client.getChainId(), chain.id);
      try { await client.sendRawTransaction({ serializedTransaction: transaction.raw }); }
      catch (error) { if (!/already known|nonce too low/i.test(error.shortMessage ?? '')) throw error; }
      receipt = await client.waitForTransactionReceipt({ hash: transaction.hash, confirmations: 2 });
    }
    assert.equal(receipt.status, 'success', `${id} reverted`);
    transaction.blockNumber = receipt.blockNumber; save();
    console.log(JSON.stringify({ step: id, hash: transaction.hash, block: String(receipt.blockNumber) })); return receipt;
  };
  if (values.step === 'deploy') {
    const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: [collateralToken, record.configuration, source] });
    assert.equal(keccak256(data), record.deploymentDataHash);
    if (!record.transactions.deploy) assert.equal(await client.getTransactionCount({ address: actors.operator, blockTag: 'pending' }), record.nonce);
    const receipt = await send('deploy', 'operator', { data, value: 0n });
    assert.equal(getAddress(receipt.contractAddress), getAddress(record.controller));
    record.house = await client.readContract({ address: record.controller, abi: artifact.abi, functionName: 'clearingHouse' });
    record.controllerCodeHash = keccak256(await client.getCode({ address: record.controller }));
    record.houseCodeHash = keccak256(await client.getCode({ address: record.house })); save(); return;
  }
  assert.ok(record.house && record.houseCodeHash && record.controllerCodeHash, 'Deploy the reviewed controller first');
  assert.equal(keccak256(await client.getCode({ address: record.house })), record.houseCodeHash);
  assert.equal(keccak256(await client.getCode({ address: record.controller })), record.controllerCodeHash);
  const houseCall = (id, role, functionName, args) => send(id, role, { to: record.house, data: encodeFunctionData({ abi: houseArtifact.abi, functionName, args }) });
  if (values.step === 'fund') {
    assert.equal(await client.readContract({ address: record.house, abi: houseArtifact.abi, functionName: 'entryPaused' }), true);
    assert.deepEqual(record.funding, { maker: 40_000_000n, trader: 10_000_000n });
    for (const role of ['maker', 'trader']) {
      const amount = record.funding[role];
      const id = evmNativeClearingAccountId(record.configuration.policyHash, `${record.network}-cash-range-${role}-v1`);
      await send(`mint-${role}`, 'operator', { to: collateralToken, data: encodeFunctionData({ abi: tokenAbi, functionName: 'mint', args: [actors[role], amount] }) });
      await houseCall(`open-${role}`, role, 'openAccount', [id]);
      await send(`approve-${role}`, role, { to: collateralToken, data: encodeFunctionData({ abi: tokenAbi, functionName: 'approve', args: [record.house, amount] }) });
      await houseCall(`deposit-${role}`, role, 'deposit', [id, amount]);
    }
    assert.equal(await client.readContract({ address: collateralToken, abi: tokenAbi, functionName: 'balanceOf', args: [record.house] }), 50_000_000n); return;
  }
  if (values.step === 'mark') {
    const [price, roundId, updatedAt, until] = await client.readContract({ address: record.controller, abi: artifact.abi, functionName: 'previewMark' });
    const current = await client.readContract({ address: record.house, abi: houseArtifact.abi, functionName: 'currentMark' });
    const sequence = current[2] + 1n;
    const id = `mark-${sequence}`;
    assert.ok(!record.transactions[id], 'Existing mark transaction must be inspected instead of recreated');
    const observationHash = keccak256(stringToHex(stringifyProtocolJson({ policyHash: record.configuration.policyHash,
      controller: record.controller, sourceRound: roundId, priceTicks: price, sourceUpdatedAt: updatedAt, sourceSequence: sequence, validUntil: until })));
    await send(id, 'mark', { to: record.controller, data: encodeFunctionData({ abi: artifact.abi,
      functionName: 'refreshMark', args: [observationHash, price, sequence, until] }) }); return;
  }
  if (values.step === 'register') {
    const marketId = `${record.network}-eth-cash-range-v1`;
    const markets = await service('/v1/native-cash/markets');
    const market = markets.markets.find(item => item.marketId === marketId);
    assert.equal(market?.binding.clearingHouse, record.house);
    assert.equal(market.binding.controllerCodeHash, record.controllerCodeHash);
    assert.equal(market.binding.clearingHouseCodeHash, record.houseCodeHash);
    assert.equal(toHex(market.binding.policy.policyHash), toHex(record.policy.policyHash));
    if (!record.registration) {
      const challenge = await service(`/internal/native-cash/registrations/${marketId}/challenge`, { state: 'ACTIVE' });
      assert.equal(getAddress(challenge.governor), actors.operator);
      assert.equal(challenge.typedData.domain.name, 'Naryx Native Cash Activation');
      assert.equal(challenge.typedData.domain.version, '1');
      assert.equal(challenge.typedData.domain.chainId, chain.id);
      assert.equal(challenge.typedData.domain.verifyingContract, record.house);
      assert.equal(challenge.typedData.primaryType, 'NativeCashActivation');
      assert.equal(challenge.typedData.message.marketManifestHash, keccak256(stringToHex(stringifyProtocolJson(market.binding))));
      assert.equal(challenge.typedData.message.nextState, 1);
      assert.ok(challenge.typedData.message.sequence > 0n);
      const now = BigInt(Math.floor(Date.now() / 1000));
      assert.ok(challenge.typedData.message.notBefore >= now + 55n && challenge.typedData.message.validUntil <= now + 305n);
      assert.equal(await client.getChainId(), chain.id);
      const signature = await wallet('operator').signTypedData(challenge.typedData);
      record.registration = { challenge, signature }; save();
    }
    const result = await service(`/internal/native-cash/registrations/${marketId}/authorize`, {
      challengeId: record.registration.challenge.challengeId, signature: record.registration.signature });
    record.registration.result = result; save();
    console.log(JSON.stringify({ marketId, state: result.state, pendingState: result.pendingState, activateAt: result.activateAt })); return;
  }
  if (values.step === 'activate') {
    assert.ok(record.transactions['deposit-maker'] && record.transactions['deposit-trader'], 'Funding must finish before activation');
    await client.readContract({ address: record.controller, abi: artifact.abi, functionName: 'previewMark' });
    const markets = await service('/v1/native-cash/markets');
    const market = markets.markets.find(item => item.binding.clearingHouse === record.house);
    assert.ok(market && market.reference.registration.state === 'ACTIVE', 'Delayed governor-signed registration is not active');
    assert.equal(market.binding.controllerCodeHash, record.controllerCodeHash);
    assert.equal(market.binding.clearingHouseCodeHash, record.houseCodeHash);
    assert.equal(toHex(market.binding.policy.policyHash), toHex(record.policy.policyHash));
    const mark = await client.readContract({ address: record.house, abi: houseArtifact.abi, functionName: 'currentMark' });
    assert.ok(mark[4] > (await client.getBlock()).timestamp + 60n, 'Fresh oracle worker mark is required');
    await houseCall('activate-entry', 'operator', 'setEntryPaused', [false]); return;
  }
  async function service(path, body) {
    const origin = new URL(values['service-origin'] ?? 'http://invalid');
    assert.ok(origin.protocol === 'http:' && origin.hostname === '127.0.0.1' && origin.pathname === '/', 'A direct loopback service origin is required');
    const response = await fetch(origin.origin + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15_000),
      ...(body === undefined ? {} : { body: stringifyProtocolJson(body) }) });
    const payload = parseProtocolJson(await response.text());
    assert.equal(response.ok, true, `Native cash service has not qualified this operation (${response.status})`); return payload;
  }
  if (values.step === 'observe') {
    for (const action of ['entry', 'exit']) {
      const trade = record[`trade-${action}`];
      assert.ok(trade?.signed && record.transactions[`trade-${action}`], 'Complete both controlled trades first');
      const result = await service(`/v1/native-cash/quotes/${trade.signed.requestId}/settlement`,
        { transactionHash: record.transactions[`trade-${action}`].hash });
      trade.receipt = result.result; save();
      console.log(JSON.stringify({ action, status: trade.receipt.evidenceGrade, transactionHash: trade.receipt.transactionHash }));
    }
    return;
  }
  if (values.step === 'entry' || values.step === 'exit') {
    const action = values.step;
    const key = `trade-${action}`;
    const accountId = `${record.network}-cash-range-trader-v1`;
    if (!record[key]) { record[key] = { requestId: `native-cash-${record.network}-${action}-${Date.now()}`, rejected: [] }; save(); }
    const trade = record[key];
    if (!record.transactions[key]) {
      const account = await client.readContract({ address: record.house, abi: houseArtifact.abi, functionName: 'account',
        args: [evmNativeClearingAccountId(record.configuration.policyHash, accountId)] });
      assert.equal(account.owner, actors.trader);
      assert.equal(account.positionAtoms, action === 'entry' ? 0n : 1n, 'Unexpected trader exposure');
      const now = (await client.getBlock()).timestamp;
      if (trade.signed && trade.signed.quote.match.expiry <= now + 10n) {
        trade.rejected.push(trade.signed); delete trade.signed; delete trade.ownerSignature;
        trade.requestId = `native-cash-${record.network}-${action}-${Date.now()}`; save();
      }
      if (!trade.signed) {
        try {
          const response = await service('/v1/native-cash/quotes', { requestId: trade.requestId,
            marketId: `${record.network}-eth-cash-range-v1`, owner: actors.trader, accountId,
            side: action === 'entry' ? 'BUY' : 'SELL', quantityAtoms: 1n });
          trade.signed = response.result; save();
        } catch (error) {
          let existing;
          try { existing = await service(`/v1/native-cash/quotes/${trade.requestId}`); } catch {}
          if (existing?.result) { trade.signed = existing.result; save(); }
          else {
            trade.rejectedRequests ??= []; trade.rejectedRequests.push(trade.requestId);
            trade.requestId = `native-cash-${record.network}-${action}-${Date.now()}`; save(); throw error;
          }
        }
      }
      const { quote, makerSignature } = trade.signed;
      assert.ok(quote.match.expiry > (await client.getBlock()).timestamp + 5n, 'Stored quote expired; rerun to obtain a fresh quote');
      assert.equal(quote.chainId, chain.id); assert.equal(quote.clearingHouse, record.house);
      assert.equal(quote.marketId, `${record.network}-eth-cash-range-v1`);
      assert.equal(quote.owner, actors.trader); assert.equal(quote.makerOwner, actors.maker);
      assert.equal(quote.side, action === 'entry' ? 'BUY' : 'SELL');
      assert.equal(quote.match.quantityAtoms, 1n); assert.equal(quote.match.maxFeeBps, 0);
      assert.ok(quote.match.priceTicks >= 1n && quote.match.priceTicks <= 4_000_001n);
      assert.equal(quote.typedData.message.policyHash, record.configuration.policyHash);
      assert.equal(hashTypedData(quote.typedData), quote.digest);
      assert.equal(await client.readContract({ address: record.house, abi: houseArtifact.abi, functionName: 'matchDigest', args: [quote.match] }), quote.digest);
      assert.equal(getAddress(await recoverTypedDataAddress({ ...quote.typedData, signature: makerSignature })), actors.maker);
      if (!trade.ownerSignature) {
        assert.equal(await client.getChainId(), chain.id);
        trade.ownerSignature = await wallet('trader').signTypedData(quote.typedData); save();
      }
    }
    const { quote, makerSignature } = trade.signed;
    await houseCall(key, 'trader', 'executeMatch', [quote.match,
      action === 'entry' ? trade.ownerSignature : makerSignature, action === 'entry' ? makerSignature : trade.ownerSignature]); return;
  }
  await houseCall('pause', 'pauser', 'setEntryPaused', [true]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.shortMessage ?? error.message); process.exitCode = 1; });
}
