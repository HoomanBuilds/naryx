import { copyFileSync, constants, lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';

export function keeperStatusEnvironment(apiText, keeperText) {
  const keeper = parseEnv(keeperText);
  const host = keeper.NARYX_KEEPER_HOST;
  const port = keeper.NARYX_KEEPER_PORT;
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)
    || !/^[1-9][0-9]{0,4}$/.test(port ?? '') || Number(port) > 65535) {
    throw new Error('Keeper must have an explicit loopback host and valid port');
  }
  const origin = `http://${host === '::1' ? '[::1]' : host}:${port}`;
  const api = parseEnv(apiText);
  const assignments = apiText.split('\n').filter(line => /^\s*(?:export\s+)?NARYX_KEEPER_STATUS_ORIGIN\s*=/.test(line));
  if (assignments.length > 1) throw new Error('Duplicate keeper status configuration');
  if (api.NARYX_KEEPER_STATUS_ORIGIN === origin) return { origin, text: apiText, changed: false };
  if (api.NARYX_KEEPER_STATUS_ORIGIN && api.NARYX_KEEPER_STATUS_ORIGIN !== origin) {
    throw new Error('Existing keeper status origin differs; review it before replacement');
  }
  const text = assignments.length === 0
    ? `${apiText}${apiText.endsWith('\n') ? '' : '\n'}NARYX_KEEPER_STATUS_ORIGIN=${origin}\n`
    : apiText.replace(/^\s*(?:export\s+)?NARYX_KEEPER_STATUS_ORIGIN\s*=.*$/m, `NARYX_KEEPER_STATUS_ORIGIN=${origin}`);
  return { origin, text, changed: true };
}

async function main() {
  const { values } = parseArgs({ options: { root: { type: 'string' }, apply: { type: 'boolean', default: false } } });
  if (!values.root || !isAbsolute(values.root) || resolve(values.root) !== values.root || values.root === '/') {
    throw new Error('--root must name the explicit Naryx service root');
  }
  const apiPath = join(values.root, 'release/env/api.env');
  const keeperPath = join(values.root, 'release/env/keeper.env');
  for (const path of [apiPath, keeperPath]) {
    const stat = lstatSync(path);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()) {
      throw new Error('Service environments must be owner-only regular files owned by the current user');
    }
  }
  const before = readFileSync(apiPath, 'utf8');
  const result = keeperStatusEnvironment(before, readFileSync(keeperPath, 'utf8'));
  const response = await fetch(`${result.origin}/internal/keeper/dependency-incidents`, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`Keeper status refused with HTTP ${response.status}`);
  const snapshot = await response.json();
  if (snapshot.version !== 1 || !Array.isArray(snapshot.scopes)
    || !Number.isSafeInteger(snapshot.configuredScopeCount) || snapshot.configuredScopeCount < 0
    || !Number.isSafeInteger(snapshot.unavailableScopeCount) || snapshot.unavailableScopeCount < 0
    || snapshot.scopes.length + snapshot.unavailableScopeCount !== snapshot.configuredScopeCount) {
    throw new Error('Keeper status response is inconsistent');
  }
  if (values.apply && result.changed) {
    if (readFileSync(apiPath, 'utf8') !== before) throw new Error('API environment changed during validation');
    copyFileSync(apiPath, `${apiPath}.before-keeper-status`, constants.COPYFILE_EXCL);
    const temporary = `${apiPath}.keeper-status.pending`;
    writeFileSync(temporary, result.text, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, apiPath);
  }
  console.log(JSON.stringify({ origin: result.origin, changed: result.changed, applied: values.apply && result.changed,
    configuredScopeCount: snapshot.configuredScopeCount, unavailableScopeCount: snapshot.unavailableScopeCount }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
