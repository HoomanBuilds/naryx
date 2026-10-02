#!/usr/bin/env node
// Builds every runtime manifest, config, and env file the services and the web app load, from the
// reviewed release templates, the forge broadcast records or Solana program identities, and live
// read-only RPC. Nothing here signs, broadcasts, or reads a key file. See deployments/tools/README.md.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOLANA_DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const SOLANA_MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const HYPERLIQUID_TESTNET_INFO = 'https://api.hyperliquid-testnet.xyz/info';
const MAINNET_EVM_CHAIN_IDS = new Set([1n, 10n, 56n, 100n, 137n, 324n, 8453n, 42161n, 42170n, 43114n, 59144n, 81457n, 534352n, 999n]);
const MAINNET_IDS = new Set([
  'eip155:1', 'eip155:8453', 'eip155:42161', 'evm:base-mainnet', 'evm:arbitrum-one',
  'hypercore:mainnet', 'svm:mainnet', 'svm:mainnet-beta', 'solana:mainnet-beta',
]);
export const NETWORKS = Object.freeze({
  common: { family: 'none' },
  'base-sepolia': { family: 'evm', chainId: 84532n, domainId: 'eip155:84532', environment: 'testnet' },
  'arbitrum-sepolia': { family: 'evm', chainId: 421614n, domainId: 'eip155:421614', environment: 'testnet' },
  'solana-devnet': { family: 'svm', domainId: 'svm:devnet', environment: 'devnet' },
  'hyperliquid-testnet': { family: 'hypercore', domainId: 'hypercore:testnet', environment: 'testnet' },
});
const SOLANA_PROGRAM_NAMES = ['core', 'package_book', 'perp_adapter', 'perp_venue', 'reservation'];
const MISSING = Symbol('missing');

export class ReleaseError extends Error {}
const fail = (message) => { throw new ReleaseError(message); };

// --- module loading: built dist only, so validation runs the exact code the services run -----------

const requireFrom = (pkg) => createRequire(join(REPO, pkg, 'package.json'));
async function dist(workspace, file) {
  const path = join(REPO, workspace, 'dist', file);
  if (!existsSync(path)) fail(`${workspace}/dist/${file} is missing. Build first (deployments/tools/README.md, "Build").`);
  return import(pathToFileURL(path).href);
}
let protocolModule;
export async function protocol() {
  protocolModule ??= await dist('packages/protocol-types', 'index.js');
  return protocolModule;
}
const viem = () => requireFrom('services/api')('viem');

// --- paths ----------------------------------------------------------------------------------------

function realpathOfNearest(path) {
  let current = path;
  const rest = [];
  while (!existsSync(current)) {
    rest.unshift(current.slice(dirname(current).length + 1));
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return join(realpathSync(current), ...rest);
}

export function insideRepo(path) {
  const root = realpathSync(REPO);
  const real = realpathOfNearest(resolve(path));
  return real === root || real.startsWith(root + sep);
}

export function outsideRepoAbsolute(path, name) {
  if (typeof path !== 'string' || !isAbsolute(path)) fail(`${name} must be an absolute path.`);
  if (insideRepo(path)) fail(`${name} must be outside the repository: ${path}`);
  return resolve(path);
}

function safeRelative(path, name) {
  if (typeof path !== 'string' || path.length === 0 || isAbsolute(path) || normalize(path).split(sep).includes('..')) {
    fail(`${name} must be a relative path without '..': ${String(path)}`);
  }
  return normalize(path);
}

// --- template directives --------------------------------------------------------------------------

function lookup(root, dotted, what) {
  let value = root;
  for (const part of dotted.split('.')) {
    if (value === null || typeof value !== 'object' || !(part in value)) fail(`${what} ${dotted} is not available.`);
    value = value[part];
  }
  return value;
}

function pointer(root, path, what) {
  if (path === '' || path === undefined) return root;
  let value = root;
  for (const raw of path.replace(/^\//, '').split('/')) {
    const part = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (value === null || typeof value !== 'object' || !(part in value)) fail(`${what} has no ${path}.`);
    value = value[part];
  }
  return value;
}

function hexOf(value, where) {
  if (value instanceof Uint8Array) return Buffer.from(value).toString('hex');
  if (typeof value === 'string' && /^(0x)?([0-9a-fA-F]{2})*$/.test(value)) return value.replace(/^0x/, '').toLowerCase();
  return fail(`${where}: expected bytes or a hex string.`);
}

export function createResolver(ctx) {
  const { protocol: p, keccak } = ctx;
  const resolveNode = (node, path) => {
    if (Array.isArray(node)) return node.map((entry, index) => resolveNode(entry, `${path}[${index}]`));
    if (node === null || typeof node !== 'object' || node instanceof Uint8Array) return node;
    const keys = Object.keys(node);
    if (keys.includes('$naryxType')) return p.fromProtocolJson(node, path);
    const directive = keys.find((key) => key.startsWith('$'));
    if (directive === undefined) {
      const output = {};
      for (const key of keys) output[key] = resolveNode(node[key], `${path}.${key}`);
      return output;
    }
    if (directive === '$operator') {
      ctx.missing.push(`${ctx.file}: ${path} - ${node.$operator}`);
      return MISSING;
    }
    const arg = resolveNode(node[directive], `${path}.${directive}`);
    if (containsMissing(arg)) return MISSING;
    // After a missing operator value, later lookups that depend on it report it once instead of failing.
    const soft = (fn) => {
      try { return fn(); } catch (error) { if (ctx.missing.length > 0) return MISSING; throw error; }
    };
    switch (directive) {
      case '$release': return soft(() => lookup(ctx.release, arg, `${ctx.file}: ${path}: release value`));
      case '$def': return soft(() => lookup(ctx.defs, arg, `${ctx.file}: ${path}: definition`));
      case '$out': return join(ctx.outDir, safeRelative(arg, `${path} $out`));
      case '$data': return join(ctx.dataDir, safeRelative(arg, `${path} $data`));
      case '$env': {
        const value = ctx.env[arg];
        if (value === undefined || value === '') {
          if (node.optional === true) return '';
          fail(`${ctx.file}: ${path}: environment variable ${arg} must be set.`);
        }
        return value;
      }
      case '$contract': return soft(() => {
        const entry = lookup(ctx.release, `contracts.${arg}`, `${ctx.file}: ${path}: contract`);
        return { address: entry.addressLower, expectedCodeHash: entry.codeHash };
      });
      case '$input': return p.fromProtocolJson(pointer(lookup(ctx.inputs, arg, `${ctx.file}: ${path}: input`), node.pointer ?? '', `input ${arg}`), path);
      case '$keccak': return Uint8Array.from(Buffer.from(keccak(arg).slice(2), 'hex'));
      case '$hex': return hexOf(arg, `${ctx.file}: ${path}`);
      case '$0x': return `0x${hexOf(arg, `${ctx.file}: ${path}`)}`;
      case '$bytes': return arg instanceof Uint8Array ? arg : Uint8Array.from(Buffer.from(hexOf(arg, `${ctx.file}: ${path}`), 'hex'));
      case '$bigint': return BigInt(arg);
      case '$number': {
        const number = Number(arg);
        if (!Number.isSafeInteger(number)) fail(`${ctx.file}: ${path}: not a safe integer.`);
        return number;
      }
      case '$string': return String(arg);
      case '$lower': return String(arg).toLowerCase();
      case '$join': return arg.map(String).join(node.separator ?? '');
      case '$merge': return Object.assign({}, ...arg);
      case '$same': {
        if (!Array.isArray(arg) || arg.length < 2 || arg.some((entry) => canonical(entry) !== canonical(arg[0]))) {
          fail(`${ctx.file}: ${path}: values that must be identical differ.`);
        }
        return arg[0];
      }
      case '$protocol': {
        const fn = p[arg];
        if (typeof fn !== 'function') fail(`${ctx.file}: ${path}: protocol-types has no function ${arg}.`);
        const args = resolveNode(node.args ?? [], `${path}.args`);
        if (containsMissing(args)) return MISSING;
        return fn(...args);
      }
      default: return fail(`${ctx.file}: ${path}: unknown directive ${directive}.`);
    }
  };
  return (node, path) => {
    const value = resolveNode(node, path);
    return containsMissing(value) ? MISSING : value;
  };
}

function containsMissing(value) {
  if (value === MISSING) return true;
  if (Array.isArray(value)) return value.some(containsMissing);
  if (value !== null && typeof value === 'object' && !(value instanceof Uint8Array)) return Object.values(value).some(containsMissing);
  return false;
}

// --- merge and serialization ----------------------------------------------------------------------

function canonical(value) {
  return JSON.stringify(value, (_, entry) => {
    if (typeof entry === 'bigint') return `bigint:${entry}`;
    if (entry instanceof Uint8Array) return `bytes:${Buffer.from(entry).toString('hex')}`;
    if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
      return Object.fromEntries(Object.keys(entry).sort().map((key) => [key, entry[key]]));
    }
    return entry;
  });
}

export function mergeValues(left, right, path) {
  const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array);
  if (plain(left) && plain(right)) {
    const output = { ...left };
    for (const [key, value] of Object.entries(right)) output[key] = key in output ? mergeValues(output[key], value, `${path}.${key}`) : value;
    return output;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    const seen = new Set(left.map(canonical));
    return [...left, ...right.filter((entry) => !seen.has(canonical(entry)) && seen.add(canonical(entry)))];
  }
  if (canonical(left) !== canonical(right)) fail(`Release files disagree at ${path}.`);
  return left;
}

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
// PRIVATE_TERMINAL names the private terminal API URL the web bundle needs, not key material.
const SECRET_ENV_NAME = /(PRIVATE(?!_TERMINAL_)|SECRET|MNEMONIC|SEED|PASSWORD|_KEY$|_KEYPAIR$|_TOKEN$)/;

export function envValues(content, file) {
  const values = {};
  for (const [name, raw] of Object.entries(content)) {
    if (!ENV_NAME.test(name)) fail(`${file}: ${name} is not an environment variable name.`);
    if (SECRET_ENV_NAME.test(name) && !/_QUOTE_TOKEN$/.test(name)) fail(`${file}: ${name} would carry key material; only key file paths are written.`);
    const value = typeof raw === 'string' ? raw
      : typeof raw === 'number' || typeof raw === 'boolean' || typeof raw === 'bigint' ? String(raw)
        : raw !== null && typeof raw === 'object' && !(raw instanceof Uint8Array) ? JSON.stringify(raw)
          : fail(`${file}: ${name} has an unsupported value.`);
    if (/[\n\r']/.test(value)) fail(`${file}: ${name} contains a newline or single quote.`);
    if (/(_KEY_PATH|_KEY_FILE|_KEYPAIR_PATH)$/.test(name) && value !== '') outsideRepoAbsolute(value, `${file}: ${name}`);
    values[name] = value;
  }
  return values;
}

function serialize(format, content, file, p) {
  if (format === 'env') {
    const values = envValues(content, file);
    return `${Object.keys(values).sort().map((name) => `${name}=${/^[A-Za-z0-9_./:,@+-]*$/.test(values[name]) ? values[name] : `'${values[name]}'`}`).join('\n')}\n`;
  }
  if (format === 'json') {
    return `${JSON.stringify(content, (_, value) => {
      if (typeof value === 'bigint' || value instanceof Uint8Array) fail(`${file}: plain JSON cannot hold bigint or bytes.`);
      return value;
    }, 2)}\n`;
  }
  if (format === 'protocol-json') {
    const tagged = p.toProtocolJson(content, file);
    const pretty = `${JSON.stringify(tagged, null, 2)}\n`;
    return Buffer.byteLength(pretty) < 1_000_000 ? pretty : `${JSON.stringify(tagged)}\n`;
  }
  return fail(`${file}: unknown output format ${format}.`);
}

export function scanForSecretsAndMainnet(value, path) {
  if (typeof value === 'string') {
    if (MAINNET_IDS.has(value)) fail(`${path} names a mainnet domain (${value}).`);
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)) fail(`${path} contains a private key.`);
    if (/^\[\s*\d{1,3}(\s*,\s*\d{1,3}){63}\s*\]$/.test(value)) fail(`${path} looks like a keypair file body.`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 64 && value.every((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 255)) fail(`${path} looks like a keypair.`);
    value.forEach((entry, index) => scanForSecretsAndMainnet(entry, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === 'object' && !(value instanceof Uint8Array)) {
    for (const [key, entry] of Object.entries(value)) {
      if (/^(privateKey|secretKey|mnemonic|seed|secret)$/i.test(key)) fail(`${path}.${key} would carry key material.`);
      scanForSecretsAndMainnet(entry, `${path}.${key}`);
    }
  }
}

// --- live, read-only identity -------------------------------------------------------------------

function forgeAddresses(record, file) {
  const returns = record.returns;
  if (returns === null || typeof returns !== 'object' || Object.keys(returns).length !== 1) fail(`${file}: .returns must hold the one Deployment struct.`);
  const value = Object.values(returns)[0]?.value;
  if (typeof value !== 'string') fail(`${file}: .returns value is missing.`);
  return value.match(/0x[0-9a-fA-F]{40}/g) ?? [];
}

function forgeCreation(record, address) {
  const lower = address.toLowerCase();
  for (const tx of record.transactions ?? []) {
    if (tx.transactionType === 'CREATE' && tx.contractAddress?.toLowerCase() === lower) return { hash: tx.hash, contractName: tx.contractName };
    for (const extra of tx.additionalContracts ?? []) {
      if (extra.address?.toLowerCase() === lower) return { hash: tx.hash, contractName: undefined };
    }
  }
  return undefined;
}

async function evmLive(release, ctx, network) {
  const v = viem();
  const rpcUrl = ctx.env[release.rpcUrlEnv];
  if (typeof rpcUrl !== 'string' || !/^https?:\/\//.test(rpcUrl)) fail(`${ctx.file}: set ${release.rpcUrlEnv} to a read-only HTTP(S) RPC URL.`);
  const client = v.createPublicClient({ transport: v.http(rpcUrl, { retryCount: 2, timeout: 20_000 }) });
  const chainId = BigInt(await client.getChainId());
  if (MAINNET_EVM_CHAIN_IDS.has(chainId)) fail(`${ctx.file}: RPC serves mainnet chain ${chainId}; refusing.`);
  if (chainId !== network.chainId) fail(`${ctx.file}: RPC eth_chainId is ${chainId}, expected ${network.chainId}.`);
  for (const [name, input] of Object.entries(ctx.inputs)) {
    if (input?.chain !== undefined && BigInt(input.chain) !== chainId) fail(`${ctx.file}: input ${name} was broadcast to chain ${input.chain}.`);
  }
  const contracts = {};
  const resolveSpec = createResolver(ctx);
  for (const [name, rawSpec] of Object.entries(release.contracts ?? {})) {
    const spec = resolveSpec(rawSpec, `contracts.${name}`);
    if (spec === MISSING) continue;
    let address;
    let creation;
    if (spec.return !== undefined) {
      const record = ctx.inputs[spec.return];
      if (record === undefined) fail(`${ctx.file}: contracts.${name} names unknown input ${spec.return}.`);
      address = forgeAddresses(record, spec.return)[spec.index];
      if (address === undefined) fail(`${ctx.file}: input ${spec.return} has no return address at index ${spec.index}.`);
      creation = forgeCreation(record, address);
      if (creation === undefined) fail(`${ctx.file}: ${name} at ${address} was not created by input ${spec.return}.`);
      if (spec.name !== undefined && creation.contractName !== undefined && creation.contractName !== spec.name) {
        fail(`${ctx.file}: ${name} at ${address} was created as ${creation.contractName}, expected ${spec.name}.`);
      }
    } else if (spec.call !== undefined) {
      const target = contracts[spec.call] ?? fail(`${ctx.file}: contracts.${name} calls unknown contract ${spec.call}.`);
      address = await client.readContract({ address: target.address, abi: v.parseAbi([`function ${spec.fn}() view returns (address)`]), functionName: spec.fn });
    } else if (typeof spec.address === 'string') {
      address = spec.address;
    } else {
      fail(`${ctx.file}: contracts.${name} needs return, call, or address.`);
    }
    address = v.getAddress(address);
    if (spec.expect !== undefined && v.getAddress(spec.expect) !== address) fail(`${ctx.file}: ${name} is ${address}, expected ${spec.expect}.`);
    const code = await client.getCode({ address });
    if (code === undefined || code === '0x') fail(`${ctx.file}: ${name} at ${address} has no code.`);
    const codeHash = v.keccak256(code);
    if (spec.expectCodeHash !== undefined && spec.expectCodeHash.toLowerCase() !== codeHash) fail(`${ctx.file}: ${name} code hash ${codeHash} differs from the pinned ${spec.expectCodeHash}.`);
    const entry = { address, addressLower: address.toLowerCase(), codeHash, codeHashBytes: Uint8Array.from(Buffer.from(codeHash.slice(2), 'hex')) };
    if (creation !== undefined) {
      const receipt = await client.getTransactionReceipt({ hash: creation.hash });
      if (receipt.status !== 'success') fail(`${ctx.file}: deployment transaction of ${name} did not succeed.`);
      Object.assign(entry, { deployTx: creation.hash, deployBlock: receipt.blockNumber });
    }
    contracts[name] = entry;
  }
  ctx.release.chainId = chainId;
  ctx.release.contracts = contracts;
  ctx.client = client;
}

async function evmDomainCheck(release, ctx) {
  if (release.domainCheck === undefined || ctx.release.domainManifest === undefined) return;
  const v = viem();
  const config = ctx.release.contracts[release.domainCheck.contract] ?? fail(`${ctx.file}: domainCheck names an unknown contract.`);
  const abi = v.parseAbi([
    'function domain() view returns (string, uint32, bytes32)',
    'function entryPaused() view returns (bool)',
  ]);
  const [domainId, version, hash] = await ctx.client.readContract({ address: config.address, abi, functionName: 'domain' });
  const expectedHash = `0x${Buffer.from(ctx.release.domainManifestHash).toString('hex')}`;
  if (domainId !== ctx.release.domainManifest.domainId || Number(version) !== ctx.release.domainManifest.manifestVersion || hash.toLowerCase() !== expectedHash) {
    fail(`${ctx.file}: ProtocolConfig.domain() is ${domainId} v${version} ${hash}; the reviewed manifest is v${ctx.release.domainManifest.manifestVersion} ${expectedHash}. Finish the domain rotation first.`);
  }
  ctx.release.entryPaused = await ctx.client.readContract({ address: config.address, abi, functionName: 'entryPaused' });
}

// The cash-and-carry template manifest commits to the reviewed domain reference, so it is activated in
// ProtocolConfig after the domain rotation rather than passed at deployment. Refuse output until it is.
async function evmTemplateCheck(release, ctx) {
  if (release.templateCheck === undefined || ctx.client === undefined) return;
  const expected = ctx.defs[release.templateCheck.definition];
  if (expected === undefined || containsMissing(expected)) return;
  const v = viem();
  const config = ctx.release.contracts[release.templateCheck.contract] ?? fail(`${ctx.file}: templateCheck names an unknown contract.`);
  const abi = v.parseAbi(['function cashCarryTemplateManifestHash() view returns (bytes32)']);
  const hash = await ctx.client.readContract({ address: config.address, abi, functionName: 'cashCarryTemplateManifestHash' });
  const expectedHash = `0x${hexOf(expected, `${ctx.file}: templateCheck.definition`)}`;
  if (hash.toLowerCase() !== expectedHash) {
    fail(`${ctx.file}: ProtocolConfig.cashCarryTemplateManifestHash() is ${hash}; the reviewed template manifest hash is ${expectedHash}. Activate the reviewed template first.`);
  }
}

async function svmLive(release, ctx) {
  const adapter = await dist('packages/adapters/solana', 'index.js');
  const { PublicKey } = requireFrom('packages/adapters/solana')('@solana/web3.js');
  const rpcUrl = ctx.env[release.rpcUrlEnv];
  if (typeof rpcUrl !== 'string' || !/^https?:\/\//.test(rpcUrl)) fail(`${ctx.file}: set ${release.rpcUrlEnv} to a read-only HTTP(S) RPC URL.`);
  const port = new adapter.ConnectionSolanaDeploymentIdentityReadPort(rpcUrl);
  const genesis = await port.getGenesisHash();
  if (genesis === SOLANA_MAINNET_GENESIS) fail(`${ctx.file}: RPC serves Solana mainnet-beta; refusing.`);
  if (genesis !== SOLANA_DEVNET_GENESIS) fail(`${ctx.file}: RPC genesis ${genesis} is not Solana Devnet.`);
  const resolveSpec = createResolver(ctx);
  const specs = Object.entries(release.programs ?? {}).map(([name, raw]) => [name, resolveSpec(raw, `programs.${name}`)]);
  const ready = specs.filter(([, spec]) => spec !== MISSING);
  const programs = {};
  if (ready.length > 0) {
    const slot = await port.getContextSlot();
    const ids = ready.map(([, spec]) => new PublicKey(spec.programId));
    const programAccounts = (await port.getMultipleAccounts(ids, slot)).accounts;
    const dataAddresses = programAccounts.map((account, index) => {
      const name = ready[index][0];
      if (account === null || !account.executable || account.data.length !== 36 || Buffer.from(account.data).readUInt32LE(0) !== 2) {
        fail(`${ctx.file}: ${name} is not a deployed upgradeable program.`);
      }
      return new PublicKey(account.data.subarray(4, 36));
    });
    const dataAccounts = (await port.getMultipleAccounts(dataAddresses, slot)).accounts;
    for (const [index, [name, spec]] of ready.entries()) {
      const data = dataAccounts[index]?.data ?? fail(`${ctx.file}: ${name} ProgramData is missing.`);
      const bytes = Buffer.from(data);
      if (bytes.readUInt32LE(0) !== 3) fail(`${ctx.file}: ${name} ProgramData is not initialized.`);
      const deploymentSlot = bytes.readBigUInt64LE(4);
      const authority = bytes[12] === 0 ? null : new PublicKey(bytes.subarray(13, 45)).toBase58();
      if ((spec.upgradeAuthority ?? null) !== authority) fail(`${ctx.file}: ${name} upgrade authority is ${authority ?? 'none'}, reviewed ${spec.upgradeAuthority ?? 'none'}.`);
      const elfSha256 = adapter.solanaProgramElfSha256(data.subarray(45));
      const reviewedSha = spec.artifactSha256 ?? (spec.artifactPath === undefined ? undefined
        : Buffer.from(adapter.solanaProgramElfSha256(readFileSync(spec.artifactPath))).toString('hex'));
      if (reviewedSha === undefined) fail(`${ctx.file}: programs.${name} needs artifactSha256 or artifactPath of the reviewed .so.`);
      if (reviewedSha.replace(/^0x/, '').toLowerCase() !== Buffer.from(elfSha256).toString('hex')) {
        fail(`${ctx.file}: ${name} live program ELF does not match the reviewed artifact.`);
      }
      const show = spec.programShowJson === undefined ? undefined : JSON.parse(readFileSync(spec.programShowJson, 'utf8'));
      if (show !== undefined && (show.programId !== spec.programId || show.programdataAddress !== dataAddresses[index].toBase58()
        || BigInt(show.lastDeploySlot) !== deploymentSlot || (show.authority === 'none' ? null : show.authority) !== authority)) {
        fail(`${ctx.file}: ${name} differs from its solana program show record.`);
      }
      const headerIdentity = adapter.solanaProgramDataHeaderIdentity(data);
      programs[name] = {
        programId: new PublicKey(spec.programId).toBase58(),
        programDataAddress: dataAddresses[index].toBase58(),
        deploymentSlot,
        upgradeAuthority: authority,
        headerIdentity,
        elfSha256,
        elfSha256Hex0x: `0x${Buffer.from(elfSha256).toString('hex')}`,
        expectation: {
          name,
          programId: new PublicKey(spec.programId).toBase58(),
          programDataAddress: dataAddresses[index].toBase58(),
          deploymentSlot,
          upgradeAuthority: authority === null ? { kind: 'IMMUTABLE' } : { kind: 'EXACT', authority },
          programDataHeaderIdentity: headerIdentity,
          programElfSha256: elfSha256,
        },
      };
    }
    const manifestPrograms = SOLANA_PROGRAM_NAMES.filter((name) => programs[name] !== undefined).map((name) => programs[name].expectation);
    if (manifestPrograms.length > 0) await adapter.verifySolanaDevnetDeploymentIdentity(manifestPrograms, port);
  }
  ctx.release.genesisHash = genesis;
  ctx.release.programs = programs;
  if (release.coreIdlPath !== undefined) {
    const p = ctx.protocol;
    const path = isAbsolute(release.coreIdlPath) ? release.coreIdlPath : join(REPO, release.coreIdlPath);
    // The loaders hash the parsed protocol-JSON form, whose object keys are sorted.
    const idl = p.fromProtocolJson(p.toProtocolJson(JSON.parse(readFileSync(path, 'utf8'))));
    if (programs.core !== undefined && new PublicKey(idl.address).toBase58() !== programs.core.programId) {
      fail(`${ctx.file}: ${release.coreIdlPath} address is not the deployed core program. Rebuild the devnet-test-perp IDL after anchor keys sync.`);
    }
    ctx.release.coreIdl = idl;
    ctx.release.coreIdlHash = adapter.solanaIdlContentHash(idl);
  }
}

// --- one release file -----------------------------------------------------------------------------

async function prepareRelease(path, options) {
  const p = await protocol();
  const release = JSON.parse(readFileSync(path, 'utf8'));
  if (release.schemaVersion !== 1) fail(`${path}: schemaVersion must be 1.`);
  const network = NETWORKS[release.network] ?? fail(`${path}: unknown network ${release.network}.`);
  const ctx = {
    file: path, protocol: p, keccak: (value) => viem().keccak256(viem().stringToHex(value)),
    env: options.env, outDir: options.outDir, dataDir: options.dataDir,
    release: { network: release.network }, defs: {}, inputs: {}, missing: [],
  };
  const resolveNode = createResolver(ctx);
  for (const [name, raw] of Object.entries(release.inputs ?? {})) {
    const inputPath = resolveNode(raw, `inputs.${name}`);
    if (inputPath === MISSING) continue;
    if (!isAbsolute(inputPath)) fail(`${path}: inputs.${name} must be an absolute path.`);
    ctx.inputs[name] = JSON.parse(readFileSync(inputPath, 'utf8'));
  }
  if (network.family === 'evm') await evmLive(release, ctx, network);
  if (network.family === 'svm') await svmLive(release, ctx);
  if (release.domainManifest !== undefined) {
    const input = resolveNode(release.domainManifest, 'domainManifest');
    if (input !== MISSING) {
      if (input.domainId !== network.domainId || input.environment !== network.environment) {
        fail(`${path}: domainManifest must be the ${network.environment} ${network.domainId} domain.`);
      }
      ctx.release.domainManifest = p.domainManifest(input);
      ctx.release.domainManifestHash = p.domainManifestHash(input);
      ctx.release.domainRef = p.domainRefFromManifest(input);
      if (network.family === 'evm') await evmDomainCheck(release, ctx);
    }
  }
  for (const [name, raw] of Object.entries(release.definitions ?? {})) {
    ctx.defs[name] = resolveNode(raw, `definitions.${name}`);
  }
  if (network.family === 'evm') await evmTemplateCheck(release, ctx);
  const outputs = {};
  for (const [relative, spec] of Object.entries(release.outputs ?? {})) {
    const file = safeRelative(relative, `${path}: outputs key`);
    const content = resolveNode(spec.content, `outputs.${relative}`);
    outputs[file] = { format: spec.format, content };
  }
  return { network: release.network, ctx, outputs };
}

function releaseRecord(prepared) {
  const { release } = prepared.ctx;
  const hex = (value) => (value instanceof Uint8Array ? Buffer.from(value).toString('hex') : value);
  return {
    network: release.network,
    generatedAt: new Date().toISOString(),
    ...(release.chainId === undefined ? {} : { chainId: release.chainId.toString() }),
    ...(release.genesisHash === undefined ? {} : { genesisHash: release.genesisHash }),
    ...(release.domainManifest === undefined ? {} : {
      domainManifest: JSON.parse(JSON.stringify(prepared.ctx.protocol.toProtocolJson(release.domainManifest))),
      domainManifestHash: hex(release.domainManifestHash),
    }),
    ...(release.entryPaused === undefined ? {} : { entryPaused: release.entryPaused }),
    ...(release.contracts === undefined ? {} : {
      contracts: Object.fromEntries(Object.entries(release.contracts).map(([name, entry]) => [name, {
        address: entry.address, codeHash: entry.codeHash,
        ...(entry.deployTx === undefined ? {} : { deployTx: entry.deployTx, deployBlock: entry.deployBlock.toString() }),
      }])),
    }),
    ...(release.programs === undefined ? {} : {
      programs: Object.fromEntries(Object.entries(release.programs).map(([name, entry]) => [name, {
        programId: entry.programId, programDataAddress: entry.programDataAddress, deploymentSlot: entry.deploymentSlot.toString(),
        upgradeAuthority: entry.upgradeAuthority, programDataHeaderIdentity: hex(entry.headerIdentity), programElfSha256: hex(entry.elfSha256),
      }])),
    }),
    ...(release.coreIdlHash === undefined ? {} : { coreIdlHash: hex(release.coreIdlHash) }),
  };
}

// --- validation with the services' own loaders --------------------------------------------------

async function validate(written, envs, liveEnv, log) {
  const scratch = mkdtempSync(join(tmpdir(), 'naryx-release-check-'));
  const closers = [];
  const readText = (path) => readFileSync(path, 'utf8');
  const nonceSource = { next: () => 1n };
  try {
    const api = envs['api.env'];
    if (api !== undefined) {
      const http = await dist('services/api', 'http-server.js');
      const composition = await dist('services/api', 'runtime-composition.js');
      composition.loadPrivateTerminalStartupConfig(api, http.loadPrivateTerminalServerConfig(api));
      const { SqliteExecutionIntentStore } = await dist('services/api', 'execution-intent-store.js');
      const { SqliteInternalOrderStore } = await dist('services/api', 'internal-order-store.js');
      const intents = new SqliteExecutionIntentStore(join(scratch, 'intents.db'));
      const orders = new SqliteInternalOrderStore(join(scratch, 'orders.db'));
      closers.push(() => intents.close(), () => orders.close());
      if (api.NARYX_BASE_TESTNET_RUNTIME_ENABLED === 'true') {
        const base = await dist('services/api', 'base-sepolia-runtime.js');
        const order = await dist('services/api', 'base-sepolia-order-context.js');
        const { SqlitePreparedEvmTestnetAtomicStore } = await dist('services/api', 'evm-testnet-prepared-store.js');
        const { createHttpBaseSepoliaSolverAuthorizer } = await dist('services/api', 'base-sepolia-solver-authorization.js');
        const manifest = base.loadBaseSepoliaRuntimeManifest(api.NARYX_BASE_SEPOLIA_RUNTIME_MANIFEST);
        const client = base.createViemBaseSepoliaReadClient(api.NARYX_BASE_SEPOLIA_RPC_URL);
        const store = new SqlitePreparedEvmTestnetAtomicStore(join(scratch, 'base-prepared.db'));
        closers.push(() => store.close());
        await base.createBaseSepoliaRuntime({
          manifest, intents, orders, client, store,
          solverAuthorizer: createHttpBaseSepoliaSolverAuthorizer(api.NARYX_BASE_SEPOLIA_SOLVER_ORIGIN ?? 'http://127.0.0.1:8794'),
        });
        await order.createBaseSepoliaOrderRuntime({
          config: order.loadBaseSepoliaOrderContextConfig(api.NARYX_BASE_SEPOLIA_ORDER_CONTEXT),
          deployment: manifest.deployment, port: client, orders,
        });
        log('api: Base Sepolia runtime manifest and order context load and pass live validation');
      }
      if (api.NARYX_ARBITRUM_TESTNET_RUNTIME_ENABLED === 'true' || api.NARYX_ARBITRUM_SEPOLIA_ORDER_CONTEXT_ENABLED === 'true') {
        const arbitrum = await dist('services/api', 'arbitrum-sepolia-runtime-client.js');
        const order = await dist('services/api', 'arbitrum-sepolia-order-context.js');
        const manifest = arbitrum.loadArbitrumSepoliaRuntimeManifest(api.NARYX_ARBITRUM_SEPOLIA_RUNTIME_MANIFEST);
        await arbitrum.createArbitrumSepoliaRuntime({
          manifest, intents, orders, client: arbitrum.createViemArbitrumSepoliaReadClient(api.NARYX_ARBITRUM_SEPOLIA_RPC_URL),
        });
        if (api.NARYX_ARBITRUM_SEPOLIA_ORDER_CONTEXT_ENABLED === 'true') {
          await order.createArbitrumSepoliaOrderRuntime({
            config: order.loadArbitrumSepoliaOrderContextConfig(api.NARYX_ARBITRUM_SEPOLIA_ORDER_CONTEXT),
            deployment: manifest.deployment,
            port: order.createViemArbitrumSepoliaPriceReadPort(api.NARYX_ARBITRUM_SEPOLIA_RPC_URL),
          });
        }
        log('api: Arbitrum Sepolia runtime manifest and order context load and pass live validation');
      }
      if (api.NARYX_SOLANA_DEVNET_RUNTIME_ENABLED === 'true' || api.NARYX_SOLANA_DEVNET_ORDER_CONTEXT_ENABLED === 'true') {
        const solana = await dist('services/api', 'solana-devnet-runtime.js');
        const order = await dist('services/api', 'solana-devnet-order-context.js');
        const adapter = await dist('packages/adapters/solana', 'index.js');
        const manifest = solana.loadSolanaDevnetRuntimeManifest(api.NARYX_SOLANA_DEVNET_RUNTIME_MANIFEST);
        await adapter.verifySolanaDevnetDeploymentIdentity(manifest.programs, new adapter.ConnectionSolanaDeploymentIdentityReadPort(api.NARYX_SOLANA_DEVNET_RPC_URL));
        if (api.NARYX_SOLANA_DEVNET_ORDER_CONTEXT_ENABLED === 'true') {
          await order.createSolanaDevnetOrderRuntime({
            manifest, config: order.loadSolanaDevnetOrderContextConfig(api.NARYX_SOLANA_DEVNET_ORDER_CONTEXT),
            port: new order.HttpSolanaDevnetMarketReadPort(api.NARYX_SOLANA_DEVNET_RPC_URL),
          });
        }
        log('api: Solana Devnet runtime manifest and order context load and pass live validation');
      }
      if (api.NARYX_HYPERLIQUID_TESTNET_RUNTIME_ENABLED === 'true') {
        if (api.NARYX_HYPERLIQUID_TESTNET_ENVIRONMENT !== 'TESTNET') fail('api.env: NARYX_HYPERLIQUID_TESTNET_ENVIRONMENT must be TESTNET.');
        const hyperliquid = await dist('services/api', 'hyperliquid-testnet-runtime-client.js');
        const config = hyperliquid.loadHyperliquidTestnetRuntimeConfig(api.NARYX_HYPERLIQUID_TESTNET_RUNTIME_CONFIG);
        await hyperliquidMetadataCheck(config);
        log('api: Hyperliquid Testnet runtime config loads and matches live testnet metadata');
      }
      if (api.NARYX_EXECUTION_POLICY_FILE !== undefined) {
        const policy = await dist('services/api', 'testnet-execution-policy.js');
        policy.loadTestnetExecutionPolicy(api.NARYX_EXECUTION_POLICY_FILE);
        log('api: testnet execution policy loads');
      }
    }
    const solver = envs['solver.env'];
    if (solver !== undefined) {
      (await dist('services/solver', 'solver-process-config.js')).loadSolverProcessConfig(solver);
      if (solver.NARYX_BASE_SEPOLIA_QUOTE_ENABLED === 'true') {
        const base = await dist('services/solver', 'base-sepolia-quote-runtime.js');
        const deployment = base.loadBaseSepoliaSolverDeployment(solver.NARYX_BASE_SEPOLIA_RUNTIME_MANIFEST);
        base.loadBaseSepoliaQuoteRuntime(solver, { nonceSource, deployment, chain: base.createViemBaseSepoliaReadPort(solver.NARYX_BASE_SEPOLIA_RPC_URL) });
        log('solver: Base Sepolia quote config loads');
      }
      if (solver.NARYX_ARBITRUM_SEPOLIA_QUOTE_ENABLED === 'true') {
        (await dist('services/solver', 'arbitrum-sepolia-quote-runtime.js')).loadArbitrumSepoliaQuoteRuntime(solver, { nonceSource });
        log('solver: Arbitrum Sepolia quote config loads');
      }
      if (solver.NARYX_ARBITRUM_SEPOLIA_EXECUTOR_ENABLED === 'true') {
        (await dist('services/solver', 'arbitrum-sepolia-executor.js')).loadArbitrumSepoliaExecutorConfig(solver.NARYX_ARBITRUM_SEPOLIA_EXECUTOR_CONFIG);
        log('solver: Arbitrum Sepolia executor config loads');
      }
      if (solver.NARYX_SOLANA_DEVNET_SOLVER_ENABLED === 'true') {
        const solana = await dist('services/solver', 'solana-devnet-solver-config.js');
        const config = solana.loadSolanaDevnetSolverConfig(solver.NARYX_SOLANA_DEVNET_SOLVER_CONFIG);
        solana.loadSolanaDevnetSharedManifest(config.runtimeManifestPath);
        log('solver: Solana Devnet solver config and shared manifest load');
      }
      if (solver.NARYX_HYPERLIQUID_TESTNET_EXECUTOR_ENABLED === 'true') {
        await hyperliquidExecutorCheck(solver);
        log('solver: Hyperliquid Testnet executor markets and tokens match live testnet metadata');
      }
      if (solver.NARYX_HYPERLIQUID_TESTNET_QUOTE_ENABLED === 'true') {
        (await dist('services/solver', 'hyperliquid-testnet-quote-config.js')).loadHyperliquidTestnetQuoteRuntime(solver, {
          nonceSource, market: {}, currentTimeMs: () => BigInt(Date.now()),
        });
        log('solver: Hyperliquid Testnet quote config loads');
      }
    }
    const keeper = envs['keeper.env'];
    if (keeper !== undefined) {
      const { parseProtocolJson } = await protocol();
      const chain = await dist('services/keeper', 'chain-identity.js');
      const monitor = await dist('services/keeper', 'code-hash-monitor.js');
      const funding = await dist('services/keeper', 'funding-mirror.js');
      chain.loadKeeperRpcUrls(keeper);
      const watch = monitor.loadCodeHashMonitorConfig(keeper, readText, parseProtocolJson);
      if (watch !== undefined) {
        const readers = Object.fromEntries([...watch.rpcUrls].map(([chainRef, url]) => [chainRef, monitor.createCodeReader(chainRef, url)]));
        const observations = await monitor.observeCode(watch.targets, readers, BigInt(Date.now()));
        const bad = observations.filter((entry) => entry.status !== 'MATCH');
        if (bad.length > 0) fail(`keeper: code watch targets do not match live code: ${bad.map((entry) => `${entry.targetId} ${entry.status}`).join(', ')}`);
        log(`keeper: code watchlist loads and all ${observations.length} targets MATCH live code`);
      }
      if (funding.loadFundingMirrorConfig(keeper, readText) !== undefined) log('keeper: funding mirror config loads');
    }
    const web = envs['.env.production'];
    if (web !== undefined) {
      for (const [name, value] of Object.entries(web)) {
        if (!name.startsWith('NEXT_PUBLIC_')) fail(`web/.env.production: ${name} is not a NEXT_PUBLIC_ variable.`);
        if (value === '') continue;
        if (/_URL$/.test(name) && !/^https?:\/\/[^\s]+$/.test(value)) fail(`web/.env.production: ${name} must be an HTTP(S) URL.`);
        if (/_QUOTE_TOKEN$/.test(name) && !/^0x[0-9a-fA-F]{40}$/.test(value)) fail(`web/.env.production: ${name} must be an EVM address.`);
        if (/_QUOTE_MINT$/.test(name) && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) fail(`web/.env.production: ${name} must be a Solana mint.`);
        if (/_CONTEXT_ID$|_MARKET_ID$/.test(name) && !/^[A-Za-z0-9:_.-]{1,128}$/.test(value)) fail(`web/.env.production: ${name} is not a valid id.`);
      }
      log('web: .env.production values are well formed');
    }
    const indexerFiles = Object.keys(envs).filter((name) => /^indexer[.-].*\.env$/.test(name));
    if (indexerFiles.length > 0) {
      delete process.env.NARYX_INDEXER_DB;
      const indexer = await dist('services/indexer', 'main.js');
      for (const name of indexerFiles) {
        if (indexer.loadEvmIndexerConfig(envs[name]) === undefined) fail(`${name}: NARYX_INDEXER_DB is not set.`);
        log(`indexer: ${name} loads`);
      }
    }
  } finally {
    for (const close of closers) {
      try { close(); } catch { /* best effort */ }
    }
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function hyperliquidMetadataCheck(config) {
  const post = async (body) => {
    const response = await fetch(HYPERLIQUID_TESTNET_INFO, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) fail(`Hyperliquid Testnet info returned HTTP ${response.status}.`);
    return response.json();
  };
  const [meta, spotMeta] = await Promise.all([post({ type: 'meta' }), post({ type: 'spotMeta' })]);
  const perpetual = meta.universe?.[config.market.perpetual.assetIndex];
  const token = spotMeta.tokens?.find((entry) => entry.index === config.market.spot.tokenIndex);
  const universe = spotMeta.universe?.find((entry) => entry.index === config.market.spot.universeIndex);
  if (perpetual === undefined || perpetual.szDecimals !== config.market.perpetual.sizeDecimals) fail('Hyperliquid perpetual asset index or size decimals do not match testnet metadata.');
  if (token === undefined || token.szDecimals !== config.market.spot.sizeDecimals) fail('Hyperliquid spot token index or size decimals do not match testnet metadata.');
  // Balances and base-token fees are reconciled exactly at each token's full precision (weiDecimals).
  const quote = spotMeta.tokens?.find((entry) => entry.index === config.market.quoteTokenIndex);
  if (config.orderContext !== undefined && token.weiDecimals !== config.orderContext.baseAsset.decimals) {
    fail('Hyperliquid base asset decimals must equal the spot token weiDecimals on testnet.');
  }
  if (config.orderContext !== undefined && quote?.weiDecimals !== config.orderContext.quoteAsset.decimals) {
    fail('Hyperliquid quote asset decimals must equal the quote token weiDecimals on testnet.');
  }
  if (universe === undefined || !universe.tokens.includes(config.market.spot.tokenIndex) || !universe.tokens.includes(config.market.quoteTokenIndex)) {
    fail('Hyperliquid spot universe does not pair the configured spot and quote tokens.');
  }
}

/** The executor's market qualification names, token ids, and canonical flags must be the live testnet ones. */
async function hyperliquidExecutorCheck(solver) {
  const post = async (body) => {
    const response = await fetch(HYPERLIQUID_TESTNET_INFO, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) fail(`Hyperliquid Testnet info returned HTTP ${response.status}.`);
    return response.json();
  };
  const [meta, spotMeta] = await Promise.all([post({ type: 'meta' }), post({ type: 'spotMeta' })]);
  const env = (name) => solver[`NARYX_HYPERLIQUID_TESTNET_${name}`];
  const token = (prefix) => {
    const entry = spotMeta.tokens?.find((item) => item.name === env(`${prefix}_NAME`));
    if (entry === undefined) fail(`solver.env: ${prefix}_NAME is not a Hyperliquid Testnet spot token.`);
    if (String(entry.tokenId).toLowerCase() !== env(`${prefix}_ID`)) fail(`solver.env: ${prefix}_ID is not the live tokenId of ${env(`${prefix}_NAME`)}.`);
    if (String(entry.isCanonical === true) !== env(`${prefix}_CANONICAL`)) fail(`solver.env: ${prefix}_CANONICAL does not match testnet metadata.`);
    return entry;
  };
  const base = token('SPOT_TOKEN');
  const quote = token('QUOTE_TOKEN');
  if (String(base.szDecimals) !== env('SPOT_SIZE_DECIMALS')) fail('solver.env: SPOT_SIZE_DECIMALS does not match the spot token szDecimals.');
  const universe = spotMeta.universe?.find((item) => item.name === env('SPOT_UNIVERSE_NAME'));
  if (universe === undefined || !universe.tokens.includes(base.index) || !universe.tokens.includes(quote.index)) {
    fail('solver.env: SPOT_UNIVERSE_NAME is not the live spot pair of the configured tokens.');
  }
  if (String(universe.isCanonical === true) !== env('SPOT_UNIVERSE_CANONICAL')) fail('solver.env: SPOT_UNIVERSE_CANONICAL does not match testnet metadata.');
  const allowed = String(env('ALLOWED_SPOT_TOKEN_INDICES')).split(',').map(Number);
  if (!allowed.includes(base.index) || !allowed.includes(quote.index)) fail('solver.env: ALLOWED_SPOT_TOKEN_INDICES must hold the spot and quote token indexes.');
  const perpetual = meta.universe?.find((item) => item.name === env('PERPETUAL_NAME'));
  if (perpetual === undefined || String(perpetual.szDecimals) !== env('PERPETUAL_SIZE_DECIMALS')) {
    fail('solver.env: PERPETUAL_NAME or PERPETUAL_SIZE_DECIMALS does not match testnet metadata.');
  }
}

// --- command --------------------------------------------------------------------------------------

export async function generate({ releaseFiles, outDir, dataDir, env = process.env, log = () => {}, skipValidation = false }) {
  outDir = outsideRepoAbsolute(outDir, '--out');
  dataDir = outsideRepoAbsolute(dataDir, '--data-dir');
  if (existsSync(outDir) && readdirSync(outDir).length > 0) fail(`--out ${outDir} must be empty or absent.`);
  if (releaseFiles.length === 0) fail('Pass at least one --release file.');
  const seen = new Set();
  const prepared = [];
  for (const file of releaseFiles) {
    const item = await prepareRelease(resolve(file), { env, outDir, dataDir });
    if (seen.has(item.network)) fail(`Two release files name ${item.network}.`);
    seen.add(item.network);
    prepared.push(item);
  }
  if (!seen.has('common')) fail('Pass the shared release file (network "common") with the network release files.');
  const missing = prepared.flatMap((item) => item.ctx.missing);
  if (missing.length > 0) fail(`Fill every reviewed operator value first:\n  ${missing.join('\n  ')}`);
  const merged = {};
  for (const item of prepared) {
    for (const [file, output] of Object.entries(item.outputs)) {
      if (merged[file] === undefined) merged[file] = output;
      else if (merged[file].format !== output.format) fail(`${file} has conflicting formats.`);
      else merged[file] = { format: output.format, content: mergeValues(merged[file].content, output.content, file) };
    }
    if (item.network !== 'common') merged[`release-records/${item.network}.json`] = { format: 'json', content: releaseRecord(item) };
  }
  const p = await protocol();
  const texts = {};
  const envs = {};
  for (const [file, output] of Object.entries(merged)) {
    scanForSecretsAndMainnet(output.content, file);
    texts[file] = serialize(output.format, output.content, file, p);
    if (output.format === 'env') envs[file.split('/').pop()] = envValues(output.content, file);
  }
  const written = [];
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  try {
    for (const [file, text] of Object.entries(texts)) {
      const path = join(outDir, file);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, text, { mode: 0o600, flag: 'wx' });
      written.push(path);
    }
    if (!skipValidation) await validate(written, envs, env, log);
  } catch (error) {
    for (const path of written) rmSync(path, { force: true });
    throw error;
  }
  return { files: Object.keys(texts).sort(), outDir };
}

async function main() {
  const { values } = parseArgs({
    options: {
      release: { type: 'string', multiple: true, default: [] },
      out: { type: 'string' },
      'data-dir': { type: 'string' },
    },
  });
  const log = (line) => process.stdout.write(`${line}\n`);
  const result = await generate({ releaseFiles: values.release, outDir: values.out, dataDir: values['data-dir'], log });
  log(`Wrote ${result.files.length} files to ${result.outDir}:`);
  for (const file of result.files) log(`  ${file}`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`release-manifests: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
