import { chownSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parseArgs, parseEnv } from 'node:util';

const { values } = parseArgs({ options: { root: { type: 'string' }, apply: { type: 'boolean', default: false } } });
if (values.root === undefined || !isAbsolute(values.root) || resolve(values.root) !== values.root) {
  throw new Error('--root must name the absolute canonical service root');
}
const root = values.root;
const apiPath = join(root, 'release/env/api.env');
const solverPath = join(root, 'release/env/solver.env');
const apiBytes = readFileSync(apiPath, 'utf8');
const solverBytes = readFileSync(solverPath, 'utf8');
const api = parseEnv(apiBytes);
const solver = parseEnv(solverBytes);
const address = (name) => {
  const value = solver[name];
  if (typeof value !== 'string' || !/^0x(?!0{40}$)[0-9a-f]{40}$/.test(value)) throw new Error(`${name} is invalid`);
  return value;
};
if (api.NARYX_HYPERLIQUID_TESTNET_ENVIRONMENT !== 'TESTNET'
  || solver.NARYX_HYPERLIQUID_TESTNET_ENVIRONMENT !== 'TESTNET'
  || solver.NARYX_HYPERLIQUID_TESTNET_ACCOUNT_KIND !== 'MASTER') {
  throw new Error('only an existing Hyperliquid TESTNET master-account runtime may be migrated');
}
const owner = address('NARYX_HYPERLIQUID_TESTNET_MASTER_ACCOUNT');
if (address('NARYX_HYPERLIQUID_TESTNET_TRADING_ACCOUNT') !== owner) {
  throw new Error('master and trading account must be identical');
}
const agentAddress = address('NARYX_HYPERLIQUID_TESTNET_AGENT_ADDRESS');
if (agentAddress === owner) throw new Error('the API wallet must not be the owner wallet');
const requiredPath = (name) => {
  const path = solver[name];
  if (typeof path !== 'string' || !isAbsolute(path) || !statSync(path).isFile()) {
    throw new Error(`${name} must name an existing absolute file`);
  }
  return path;
};
const signerLeaseId = solver.NARYX_HYPERLIQUID_TESTNET_SIGNER_LEASE_ID;
if (typeof signerLeaseId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(signerLeaseId)) {
  throw new Error('the existing signer lease is invalid');
}
const registry = {
  version: 1, environment: 'TESTNET', accounts: [{
    owner, agentAddress,
    agentKeyPath: requiredPath('NARYX_HYPERLIQUID_TESTNET_AGENT_KEY_PATH'),
    journalPath: requiredPath('NARYX_HYPERLIQUID_TESTNET_JOURNAL_DB'),
    signerLeaseId,
  }],
};
const registryPath = join(root, 'release/env/hyperliquid-testnet-user-accounts.json');
const registryBytes = `${JSON.stringify(registry, null, 2)}\n`;
if (existsSync(registryPath) && readFileSync(registryPath, 'utf8') !== registryBytes) {
  throw new Error('an existing user registry differs; refusing to replace it');
}
const update = (text, changes) => {
  for (const [key, value] of Object.entries(changes)) {
    const pattern = new RegExp(`^${key}=.*$`, 'gm');
    const line = `${key}=${JSON.stringify(value)}`;
    text = pattern.test(text) ? text.replace(pattern, line) : `${text.trimEnd()}\n${line}\n`;
  }
  return text;
};
const updates = [
  [apiPath, apiBytes, update(apiBytes, {
    NARYX_HYPERLIQUID_TESTNET_ACCOUNT_MODE: 'PER_USER',
    NARYX_HYPERLIQUID_TESTNET_NETTING_EXECUTION_ENABLED: 'false',
  })],
  [solverPath, solverBytes, update(solverBytes, {
    NARYX_HYPERLIQUID_TESTNET_ACCOUNT_MODE: 'PER_USER',
    NARYX_HYPERLIQUID_TESTNET_USER_ACCOUNTS: registryPath,
    NARYX_HYPERLIQUID_TESTNET_NETTING_RESIDUAL_ENABLED: 'false',
  })],
];
let backupPath = null;
if (values.apply) {
  backupPath = join(root, 'release/backups', `per-user-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  mkdirSync(backupPath, { recursive: true, mode: 0o700 });
  for (const [path, original] of updates) {
    if (readFileSync(path, 'utf8') !== original) throw new Error('service environment changed during preparation');
    copyFileSync(path, join(backupPath, path === apiPath ? 'api.env' : 'solver.env'));
  }
  if (!existsSync(registryPath)) {
    const ownership = statSync(solverPath);
    writeFileSync(registryPath, registryBytes, { flag: 'wx', mode: 0o600 });
    chownSync(registryPath, ownership.uid, ownership.gid);
  }
  for (const [path, , next] of updates) {
    const ownership = statSync(path);
    const temporary = `${path}.per-user-pending`;
    writeFileSync(temporary, next, { flag: 'wx', mode: 0o600 });
    chownSync(temporary, ownership.uid, ownership.gid);
    renameSync(temporary, path);
  }
}
console.log(JSON.stringify({
  applied: values.apply, environment: 'TESTNET', owner, agentAddress, registryPath,
  preservedJournal: registry.accounts[0].journalPath,
  preservedSignerLease: signerLeaseId, sharedResidualExecution: false, backupPath,
}));
