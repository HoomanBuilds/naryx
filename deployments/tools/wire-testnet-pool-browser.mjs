import { constants, copyFileSync, lstatSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';

export function poolBrowserEnvironment(text, tokenPath) {
  if (!isAbsolute(tokenPath) || resolve(tokenPath) !== tokenPath || /[\r\n"\\]/.test(tokenPath)) throw new Error('Invalid token path');
  const expected = {
    NARYX_HYPERLIQUID_POOL_BROWSER_ENABLED: 'true',
    NARYX_HYPERLIQUID_POOL_BROWSER_ORIGIN: 'http://127.0.0.1:8821',
    NARYX_HYPERLIQUID_POOL_OPERATOR_TOKEN_PATH: tokenPath,
    NARYX_THRESHOLD_AUCTIONS_ENABLED: 'true',
  };
  const parsed = parseEnv(text);
  let result = text;
  for (const [key, value] of Object.entries(expected)) {
    const pattern = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=.*$`, 'gm');
    const matches = [...text.matchAll(pattern)];
    if (matches.length > 1) throw new Error(`Duplicate ${key}`);
    if (parsed[key] && parsed[key] !== value && parsed[key] !== 'false') throw new Error(`Conflicting ${key}`);
    if (parsed[key] === value) continue;
    const assignment = `${key}="${value}"`;
    result = matches.length ? result.replace(pattern, assignment) : `${result}${result.endsWith('\n') ? '' : '\n'}${assignment}\n`;
  }
  return result;
}

async function main() {
  const { values } = parseArgs({ options: { root: { type: 'string' }, apply: { type: 'boolean', default: false } } });
  if (!values.root || !isAbsolute(values.root) || resolve(values.root) !== values.root || values.root === '/') throw new Error('Explicit service root required');
  const privateFile = path => {
    const stat = lstatSync(path);
    if (!stat.isFile() || realpathSync(path) !== path || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()) throw new Error('Owner-only regular file required');
    return readFileSync(path, 'utf8');
  };
  const config = JSON.parse(privateFile(join(values.root, 'release/hyperliquid-pool-v1/runtime.json')));
  if (config.environment !== 'TESTNET' || config.binding?.domain?.domainId !== 'hypercore:testnet') throw new Error('Only the testnet pool can be exposed');
  const token = privateFile(config.operatorTokenPath).trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid pool token');
  const response = await fetch('http://127.0.0.1:8821/v1/pool/browser/config', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: '{}', signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Browser backend returned ${response.status}`);
  const body = await response.json();
  if (body.environment !== 'TESTNET' || body.custody !== 'CUSTODIAL_TESTNET_POOL_V1'
    || body.poolAccount !== config.binding.poolAccount) throw new Error('Pool identity mismatch');
  const path = join(values.root, 'release/env/api.env');
  const before = privateFile(path);
  const after = poolBrowserEnvironment(before, config.operatorTokenPath);
  if (values.apply && before !== after) {
    if (privateFile(path) !== before) throw new Error('Environment changed during validation');
    copyFileSync(path, `${path}.before-pool-browser`, constants.COPYFILE_EXCL);
    writeFileSync(`${path}.pool-browser.pending`, after, { flag: 'wx', mode: 0o600 });
    renameSync(`${path}.pool-browser.pending`, path);
  }
  console.log(JSON.stringify({ environment: 'TESTNET', changed: before !== after, applied: values.apply && before !== after }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
