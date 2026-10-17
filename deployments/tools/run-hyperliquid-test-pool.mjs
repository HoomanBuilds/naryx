import assert from 'node:assert/strict';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout } from 'node:timers/promises';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(join(repository, 'services/solver/package.json'));
const { HttpTransport, InfoClient, TESTNET_API_URL } = await import(require.resolve('@nktkas/hyperliquid'));
const { approveAgent, updateLeverage, userSetAbstraction, userDexAbstraction } = await import(require.resolve('@nktkas/hyperliquid/api/exchange'));
const { keccak256, toHex } = await import(require.resolve('viem'));
const protocol = await import(pathToFileURL(join(repository, 'packages/protocol-types/dist/index.js')).href);
const moduleAt = name => import(pathToFileURL(join(repository, `services/solver/dist/${name}.js`)).href);
const { loadHyperliquidTestnetAgentSigner } = await moduleAt('hyperliquid-testnet-agent-key');
const { poolConsentTypedData, poolWithdrawalTypedData } = await moduleAt('hyperliquid-pool-funding');
const { poolEpochTypedData } = await moduleAt('hyperliquid-pool-epoch');
const { hyperliquidTestnetPoolFundingReads } = await moduleAt('hyperliquid-pool-funding-reads');
const { hyperliquidTestnetPoolWithdrawalTransport } = await moduleAt('hyperliquid-pool-withdrawal');
const { hyperliquidTestnetPoolExecutionReads } = await moduleAt('hyperliquid-pool-execution-reads');
const { values } = parseArgs({ options: { root: { type: 'string' }, step: { type: 'string' },
  role: { type: 'string' }, id: { type: 'string' }, broadcast: { type: 'boolean', default: false } } });
assert.ok(values.root && isAbsolute(values.root) && resolve(values.root) === values.root);
assert.ok(['status', 'enroll', 'configure', 'deposit', 'epoch', 'withdraw', 'observe'].includes(values.step));
const release = join(values.root, 'release/hyperliquid-pool-v1');
const config = protocol.parseProtocolJson(readFileSync(join(release, 'runtime.json'), 'utf8'));
const identities = JSON.parse(readFileSync(join(release, 'identities.json'), 'utf8'));
const binding = config.binding;
assert.equal(config.environment, 'TESTNET');
assert.equal(binding.domain.domainId, 'hypercore:testnet');
assert.equal(binding.poolAccount, identities.pool.address);
assert.ok(binding.maximumTotalQuoteAtoms <= 20_000_000n);
const roles = ['owner-1', 'owner-2', 'sponsor'];
assert.deepEqual([...binding.dedicatedTestOwners].sort(), roles.map(role => identities[role].address).sort());
const journal = join(values.root, 'data/hyperliquid-pool-v1/operator');
mkdirSync(journal, { recursive: true, mode: 0o700 });
const token = readFileSync(config.operatorTokenPath, 'utf8').trim();
const transport = new HttpTransport({ isTestnet: true, apiUrl: TESTNET_API_URL, timeout: 10_000 });
const info = new InfoClient({ transport });
const reads = hyperliquidTestnetPoolFundingReads(binding.collateralTokenId);
const emit = value => console.log(protocol.stringifyProtocolJson(value));
const read = path => protocol.parseProtocolJson(readFileSync(path, 'utf8'));
const write = (path, value) => {
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, protocol.stringifyProtocolJson(value)); fsyncSync(fd); } finally { closeSync(fd); }
  const directory = openSync(dirname(path), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
};
const wallet = role => loadHyperliquidTestnetAgentSigner(identities[role].keyPath, identities[role].address, config.encryptionKeyPath);
const requireBroadcast = () => assert.equal(values.broadcast, true, '--broadcast is required for signing or writes');
async function api(path, body) {
  const response = await fetch(`http://127.0.0.1:8821/v1/pool/${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : protocol.stringifyProtocolJson(body), signal: AbortSignal.timeout(30_000) });
  const result = protocol.parseProtocolJson(await response.text());
  assert.ok(response.ok, `Pool ${path} returned ${response.status}: ${protocol.stringifyProtocolJson(result)}`);
  return result;
}
async function once(id, action, submit) {
  requireBroadcast();
  const path = join(journal, `${id}.json`);
  if (existsSync(path)) return read(path);
  const attempt = { environment: 'TESTNET', nonce: Date.now(), action };
  write(path, attempt);
  await submit(attempt.nonce);
  write(join(journal, `${id}.ack.json`), { acknowledgedAtMs: Date.now() });
  return attempt;
}
async function findTransfer(source, destination, nonce, amount) {
  const history = await info.userNonFundingLedgerUpdates({ user: source, startTime: nonce, endTime: nonce + 300_000 });
  assert.ok(history.length < 500, 'Transfer history was truncated');
  for (const row of history.filter(row => row.delta.type === 'internalTransfer'
    && row.delta.user.toLowerCase() === source && row.delta.destination.toLowerCase() === destination)) {
    const proof = await reads.transfer(row.hash.toLowerCase(), row.time, source, destination);
    if (proof.nonce === nonce) {
      assert.equal(proof.debitedQuoteAtoms, amount);
      return proof;
    }
  }
  throw new Error('Transfer evidence is pending; rerun observation, never resend');
}
async function waitTransfer(source, destination, nonce, amount) {
  for (let attempt = 0; ; attempt++) {
    try { return await findTransfer(source, destination, nonce, amount); }
    catch (error) {
      const pending = error instanceof Error && (error.message.startsWith('Transfer evidence is pending;')
        || error.name === 'ApiRequestError' && /^invalid block height: [0-9]+$/.test(error.message));
      if (!pending || attempt >= 5) throw error;
      await setTimeout(2_000);
    }
  }
}
async function state() { return api('state'); }
async function standard(role) {
  const user = identities[role].address;
  const signer = wallet(role);
  const client = nonce => ({ transport, wallet: signer, signatureChainId: '0x66eee', nonceManager: () => nonce });
  if (await info.userAbstraction({ user }) !== 'disabled') {
    const [venue, orders, spot] = await Promise.all([info.clearinghouseState({ user }), info.openOrders({ user }),
      info.spotClearinghouseState({ user })]);
    assert.equal(venue.assetPositions.length, 0);
    assert.equal(orders.length, 0);
    assert.equal(spot.balances.length, 0);
    const parameters = { user, abstraction: 'disabled' };
    await once(`standard-${role}`, parameters, nonce => userSetAbstraction(client(nonce), parameters));
  }
  if (await info.userDexAbstraction({ user }) !== false) {
    const parameters = { user, enabled: false };
    await once(`dex-disabled-${role}`, parameters, nonce => userDexAbstraction(client(nonce), parameters));
  }
  assert.equal(await info.userAbstraction({ user }), 'disabled');
  assert.equal(await info.userDexAbstraction({ user }), false);
}
const selectedRole = () => { assert.ok(roles.includes(values.role)); return values.role; };

if (values.step === 'status' || values.step === 'observe') {
  const Database = require('better-sqlite3');
  const db = new Database(config.databasePath, { readonly: true, fileMustExist: true });
  try {
    const snapshot = { state: await state(), venue: await info.clearinghouseState({ user: binding.poolAccount }),
      agents: await info.extraAgents({ user: binding.poolAccount }),
      operations: db.prepare('SELECT id, kind, state, result FROM pool_operations ORDER BY rowid').all()
        .map(row => ({ ...row, result: row.result === null ? null : protocol.parseProtocolJson(row.result) })),
      stages: db.prepare('SELECT operation_id, stage FROM pool_epoch_stages ORDER BY rowid').all() };
    if (values.step === 'observe') {
      assert.ok(values.id && /^[A-Za-z0-9._-]{1,80}$/.test(values.id));
      write(join(journal, `observation-${values.id}.json`), snapshot);
    }
    emit(snapshot);
  } finally { db.close(); }
} else if (values.step === 'enroll') {
  requireBroadcast();
  for (const role of roles) {
    const owner = identities[role].address;
    const path = join(journal, `consent-${role}.json`);
    if (!existsSync(path)) write(path, { owner, signature: await wallet(role).signTypedData(poolConsentTypedData(binding, owner)) });
    await api('enroll', read(path));
  }
  emit(await state());
} else if (values.step === 'configure') {
  requireBroadcast();
  assert.equal((await state()).pending, null);
  await standard('pool');
  await reads.flat(binding.poolAccount);
  const signer = wallet('pool');
  const client = nonce => ({ transport, wallet: signer, signatureChainId: '0x66eee', nonceManager: () => nonce });
  const agents = (await info.extraAgents({ user: binding.poolAccount })).filter(row => row.validUntil === null || row.validUntil > Date.now());
  assert.ok(agents.length === 0 || agents.length === 1 && agents[0].address.toLowerCase() === identities.agent.address,
    'Unexpected agent authority');
  if (agents.length === 0) {
    const parameters = { agentAddress: identities.agent.address, agentName: `naryx-pool valid_until ${Date.now() + 7 * 86_400_000}` };
    await once('approve-agent', parameters, nonce => approveAgent(client(nonce), parameters));
  }
  for (const market of config.markets) {
    const parameters = { asset: market.assetId, isCross: true, leverage: 5 };
    await once(`leverage-${market.assetId}`, parameters, nonce => updateLeverage(client(nonce), parameters));
  }
  const configured = { agents: await info.extraAgents({ user: binding.poolAccount }),
    modes: await Promise.all(config.markets.map(market => info.activeAssetData({ user: binding.poolAccount, coin: market.coin }))) };
  assert.ok(configured.agents.some(row => row.address.toLowerCase() === identities.agent.address
    && row.validUntil !== null && row.validUntil > Date.now() + 86_400_000));
  assert.ok(configured.modes.every(row => row.leverage.type === 'cross' && row.leverage.value === 5));
  emit(configured);
} else if (values.step === 'deposit') {
  requireBroadcast();
  const role = selectedRole();
  const owner = identities[role].address;
  const id = `deposit-${role}-v1`;
  const current = await state();
  assert.equal(current.pending, null);
  assert.ok(current.members.some(row => row.owner === owner));
  const path = join(journal, `${id}.json`);
  if (!existsSync(path)) {
    await standard(role);
    const source = await reads.flat(owner);
    assert.equal(source.equityQuoteAtoms, 7_000_000n, 'Dedicated owner must hold exactly 7 mock USDC');
    const action = { environment: 'TESTNET', source: owner, destination: binding.poolAccount, debitQuoteAtoms: 7_000_000n };
    await once(id, action, nonce => hyperliquidTestnetPoolWithdrawalTransport(wallet(role)).send({ ...action, nonce }));
  }
  const attempt = read(path);
  const proof = await waitTransfer(owner, binding.poolAccount, attempt.nonce, 7_000_000n);
  await standard('pool');
  await api('deposit', { id, owner, transferHash: proof.hash, transferTimeMs: proof.timeMs });
  emit({ deposit: proof, state: await state() });
} else if (values.step === 'epoch') {
  requireBroadcast();
  assert.ok(values.id && /^[A-Za-z0-9._-]{1,80}$/.test(values.id));
  const path = join(journal, `epoch-${values.id}.json`);
  if (!existsSync(path)) {
    const current = await state();
    assert.equal(current.pending, null);
    const entryPolicy = protocol.nettingPolicyManifest(read(config.entryConfigPath).policy);
    const exitPolicy = protocol.nettingPolicyManifest(read(config.exitConfigPath).policy);
    assert.equal(entryPolicy.instruments.length, 1);
    const instrument = entryPolicy.instruments[0];
    const prices = await hyperliquidTestnetPoolExecutionReads(binding.poolAccount, entryPolicy, config.markets,
      binding.collateralTokenId).closePrices(entryPolicy);
    const book = prices.prices[0];
    const sell = book.sellLimitPriceTicks * 999n / 1000n;
    const buy = (book.buyLimitPriceTicks * 1001n + 999n) / 1000n;
    const lots = (10_500_000n + sell * instrument.priceTickQuoteAtoms - 1n) / (sell * instrument.priceTickQuoteAtoms);
    assert.ok(lots * buy * instrument.priceTickQuoteAtoms <= 15_000_000n, 'Net execution exceeds cohort cap');
    const digest = value => keccak256(toHex(protocol.stringifyProtocolJson(value)));
    const obligations = roles.slice(0, 2).map((role, index) => ({ ownerId: identities[role].address,
      strategyOrderHash: digest({ epoch: values.id, role, kind: 'STRATEGY' }),
      packageOrderId: digest({ epoch: values.id, role, kind: 'PACKAGE' }),
      settlementReadinessHash: digest({ epoch: values.id, role, binding, kind: 'READINESS' }),
      legId: 'btc', instrumentId: instrument.instrumentId, sequence: BigInt(index + 1),
      signedQuantityAtoms: (index === 0 ? -1n : 2n) * lots * instrument.quantityIncrementAtoms,
      limitPriceTicks: index === 0 ? sell : buy }));
    const plan = { id: values.id, entryPolicy, exitPolicy, entry: protocol.netObligations(obligations, entryPolicy),
      entryDeadlineMs: Date.now() + 45_000, closeAfterMs: Date.now() + 65_000,
      mandates: roles.map(role => ({ owner: identities[role].address, role: role === 'sponsor' ? 'RECOVERY_SPONSOR' : 'TRADER',
        maximumLossQuoteAtoms: current.members.find(row => row.owner === identities[role].address).balanceQuoteAtoms,
        maximumFeeQuoteAtoms: role === 'sponsor' ? 1_000_000n : 100_000n })) };
    const authorizations = await Promise.all(roles.map(async role => ({ owner: identities[role].address,
      signature: await wallet(role).signTypedData(poolEpochTypedData(binding, plan, identities[role].address)) })));
    write(path, { plan, authorizations });
  }
  emit(await api('epoch', read(path)));
} else if (values.step === 'withdraw') {
  requireBroadcast();
  const role = selectedRole();
  const owner = identities[role].address;
  const id = `withdraw-${role}-v1`;
  const path = join(journal, `${id}.json`);
  const current = await state();
  const Database = require('better-sqlite3');
  const db = new Database(config.databasePath, { readonly: true, fileMustExist: true });
  let operation;
  try { operation = db.prepare('SELECT state FROM pool_operations WHERE id = ?').get(id); }
  finally { db.close(); }
  if (operation?.state === 'COMPLETE') { emit({ id, status: 'COMPLETE', state: current }); process.exit(0); }
  assert.ok(!operation || operation.state === 'PENDING', 'Withdrawal is cancelled; manual review required');
  if (!existsSync(path)) {
    assert.equal(current.pending, null);
    const amount = current.members.find(row => row.owner === owner).balanceQuoteAtoms;
    assert.ok(amount > 0n && amount <= 20_000_000n);
    const request = { id, owner, debitQuoteAtoms: amount, expiresAtMs: Date.now() + 300_000 };
    write(path, { request, signature: await wallet(role).signTypedData(poolWithdrawalTypedData(binding, request)) });
  }
  const signed = read(path);
  if (!operation) await api('withdrawal', signed);
  else assert.equal(current.pending.id, id);
  emit(await api('withdrawal/submit', { id }));
  const evidenceDb = new Database(config.databasePath, { readonly: true, fileMustExist: true });
  let submission;
  try { submission = evidenceDb.prepare('SELECT nonce FROM pool_withdrawal_submissions WHERE operation_id = ?').get(id); }
  finally { evidenceDb.close(); }
  assert.ok(submission, 'No withdrawal submission; inspect reservation before retry');
  const proof = await waitTransfer(binding.poolAccount, owner, submission.nonce, signed.request.debitQuoteAtoms);
  await api('withdrawal/complete', { id, transferHash: proof.hash, transferTimeMs: proof.timeMs });
  emit({ withdrawal: proof, state: await state() });
}
