#!/usr/bin/env node
// Offline self-check of the release manifest generator: directive resolution, merge rules, the
// refusals, and a lint of every committed release template. No RPC, no key, no network.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  REPO, NETWORKS, ReleaseError, createResolver, envValues, generate, mergeValues, outsideRepoAbsolute, protocol,
  scanForSecretsAndMainnet,
} from './release-manifests.mjs';

const TEMPLATES = [
  'deployments/tools/release-common.template.json',
  'deployments/evm/base-sepolia/release.template.json',
  'deployments/evm/arbitrum-sepolia/release.template.json',
  'deployments/solana/devnet/release.template.json',
  'deployments/hyperliquid/testnet/release.template.json',
];
const DIRECTIVES = new Set(['$operator', '$release', '$def', '$contract', '$out', '$data', '$env', '$input', '$keccak', '$hex', '$0x',
  '$bytes', '$bigint', '$number', '$string', '$lower', '$join', '$merge', '$same', '$protocol', '$naryxType']);
const RELEASE_ROOTS = {
  evm: ['chainId', 'contracts', 'domainManifest', 'domainManifestHash', 'domainRef'],
  svm: ['genesisHash', 'programs', 'coreIdl', 'coreIdlHash', 'domainManifest', 'domainManifestHash', 'domainRef'],
  hypercore: ['domainManifest', 'domainManifestHash', 'domainRef'],
  none: [],
};

const p = await protocol();
const checks = [];
const check = (name, fn) => checks.push([name, fn]);

check('directives resolve to protocol values and collect missing operator input', () => {
  const ctx = {
    file: 'test', protocol: p, keccak: () => `0x${'ab'.repeat(32)}`, env: { RPC: 'https://rpc.invalid' }, outDir: '/out', dataDir: '/data',
    release: { contracts: { verifier: { addressLower: '0x'.padEnd(42, '1'), codeHash: `0x${'22'.repeat(32)}` } } },
    defs: { id: 'weth' }, inputs: { init: { accounts: { config: 'Cfg' } } }, missing: [],
  };
  const resolve = createResolver(ctx);
  const domain = {
    manifestVersion: 2, environment: 'testnet', domainId: 'eip155:84532', runtimeClassId: 'naryx-evm', runtimeClassVersion: 1,
    chainNamespace: 'eip155', chainReference: '84532', executionVerifierId: 'package-verifier-v1',
    executionVerifierCodeHash: { $bytes: { $release: 'contracts.verifier.codeHash' } }, clockModelId: 'evm-unix-seconds',
    finalityPolicyHash: { $bytes: `0x${'33'.repeat(32)}` }, addressCodecId: 'evm-address-20', supportedSettlementClasses: ['ATOMIC_POSTCONDITION'],
  };
  const value = resolve({
    hash: { $hex: { $protocol: 'domainManifestHash', args: [domain] } },
    contract: { $contract: 'verifier' },
    big: { $naryxType: 'bigint', value: '7' },
    out: { $out: 'api/x.json' },
    env: { $env: 'RPC' },
    input: { $input: 'init', pointer: '/accounts/config' },
    merged: { $merge: [{ a: 1 }, { b: { $def: 'id' } }] },
  }, 'root');
  assert.equal(value.hash, Buffer.from(p.domainManifestHash({
    ...domain, executionVerifierCodeHash: '22'.repeat(32), finalityPolicyHash: '33'.repeat(32),
  })).toString('hex'));
  assert.deepEqual(value.contract, { address: '0x'.padEnd(42, '1'), expectedCodeHash: `0x${'22'.repeat(32)}` });
  assert.equal(value.big, 7n);
  assert.equal(value.out, '/out/api/x.json');
  assert.equal(value.env, 'https://rpc.invalid');
  assert.equal(value.input, 'Cfg');
  assert.deepEqual(value.merged, { a: 1, b: 'weth' });
  assert.equal(typeof resolve({ x: { $bytes: { $operator: 'fill me' } } }, 'root'), 'symbol');
  assert.deepEqual(ctx.missing, ['test: root.x.$bytes - fill me']);
  assert.throws(() => resolve({ $out: '../escape' }, 'root'), ReleaseError);
});

check('merge concatenates arrays without duplicates and refuses conflicting scalars', () => {
  assert.deepEqual(mergeValues({ d: [{ id: 1 }], v: 1 }, { d: [{ id: 1 }, { id: 2 }], v: 1 }, 'f'), { d: [{ id: 1 }, { id: 2 }], v: 1 });
  assert.throws(() => mergeValues({ v: 1 }, { v: 2 }, 'f'), /disagree at f\.v/);
});

check('refuses repository paths, mainnet identities, and key material', () => {
  assert.throws(() => outsideRepoAbsolute(join(REPO, 'out'), '--out'), /outside the repository/);
  assert.throws(() => outsideRepoAbsolute('relative/out', '--out'), /absolute/);
  assert.equal(outsideRepoAbsolute(join(tmpdir(), 'naryx-out'), '--out'), join(tmpdir(), 'naryx-out'));
  assert.throws(() => scanForSecretsAndMainnet({ domainId: 'eip155:8453' }, 'f'), /mainnet/);
  assert.throws(() => scanForSecretsAndMainnet({ k: Array.from({ length: 64 }, (_, i) => i) }, 'f'), /keypair/);
  assert.throws(() => envValues({ NARYX_SOLVER_PRIVATE_KEY: '0x1' }, 'f'), /key material/);
  assert.throws(() => envValues({ NARYX_BASE_SEPOLIA_SOLVER_KEY_PATH: join(REPO, 'k.json') }, 'f'), /outside the repository/);
  assert.equal(envValues({ NARYX_BASE_SEPOLIA_SOLVER_KEY_PATH: '/secure/k.json' }, 'f').NARYX_BASE_SEPOLIA_SOLVER_KEY_PATH, '/secure/k.json');
});

check('every template uses known directives, declared definitions, and release values of its family', () => {
  const outputs = new Set(TEMPLATES.flatMap((file) => Object.keys(JSON.parse(readFileSync(join(REPO, file), 'utf8')).outputs ?? {})));
  for (const file of TEMPLATES) {
    const template = JSON.parse(readFileSync(join(REPO, file), 'utf8'));
    const family = NETWORKS[template.network]?.family;
    assert.ok(family !== undefined, `${file}: unknown network`);
    const defs = new Set(Object.keys(template.definitions ?? {}));
    const contracts = new Set(Object.keys(template.contracts ?? {}));
    const programs = new Set(Object.keys(template.programs ?? {}));
    const walk = (node, path) => {
      if (Array.isArray(node)) return node.forEach((entry, index) => walk(entry, `${path}[${index}]`));
      if (node === null || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node)) {
        if (key.startsWith('$')) {
          assert.ok(DIRECTIVES.has(key), `${file}: ${path} uses unknown directive ${key}`);
          if (key === '$def') assert.ok(defs.has(value.split('.')[0]), `${file}: ${path} names undeclared definition ${value}`);
          if (key === '$contract') assert.ok(contracts.has(value), `${file}: ${path} names undeclared contract ${value}`);
          if (key === '$out') assert.ok(outputs.has(value), `${file}: ${path} points at ${value}, which no template writes`);
          if (key === '$protocol') assert.equal(typeof p[value], 'function', `${file}: ${path} calls missing ${value}`);
          if (key === '$release' && typeof value === 'string') {
            const [root, name] = value.split('.');
            assert.ok(RELEASE_ROOTS[family].includes(root), `${file}: ${path} reads ${value}, not produced for ${family}`);
            if (root === 'contracts') assert.ok(contracts.has(name), `${file}: ${path} reads undeclared contract ${name}`);
            if (root === 'programs') assert.ok(programs.has(name), `${file}: ${path} reads undeclared program ${name}`);
          }
        }
        walk(value, `${path}.${key}`);
      }
    };
    walk(template, file);
  }
});

check('an unfilled common and Hyperliquid release stops before writing and lists the operator values', async () => {
  const out = join(tmpdir(), `naryx-release-selfcheck-${process.pid}`);
  await assert.rejects(generate({
    releaseFiles: [join(REPO, TEMPLATES[0]), join(REPO, TEMPLATES[4])], outDir: out, dataDir: join(out, 'data'), env: {},
  }), (error) => error instanceof ReleaseError && /Fill every reviewed operator value/.test(error.message)
    && /NARYX_TERMINAL_ORIGIN/.test(error.message) && /tradingAccount/.test(error.message));
});

let failed = 0;
for (const [name, fn] of checks) {
  try {
    await fn();
    process.stdout.write(`ok - ${name}\n`);
  } catch (error) {
    failed += 1;
    process.stdout.write(`not ok - ${name}\n  ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
process.stdout.write(`${checks.length - failed}/${checks.length} checks passed\n`);
process.exitCode = failed === 0 ? 0 : 1;
