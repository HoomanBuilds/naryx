#!/usr/bin/env node
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const protocol = await import(pathToFileURL(join(repository, 'packages/protocol-types/dist/index.js')).href);
const { values } = parseArgs({
  options: {
    release: { type: 'string' },
    signer: { type: 'string' },
    output: { type: 'string' },
    endpoint: { type: 'string' },
    nonce: { type: 'string', default: '1' },
    'rfq-solver': { type: 'string' },
    'rfq-key-id': { type: 'string' },
    'rfq-public-key': { type: 'string' },
  },
});
if (values.release === undefined || values.signer === undefined || values.output === undefined
  || values.endpoint === undefined) {
  throw new Error('usage: provision-testnet-solver-capabilities.mjs --release <directory> --signer <pem> --output <file> --endpoint <url> [--nonce <positive integer>] [--rfq-solver <id> --rfq-key-id <id> --rfq-public-key <64 hex>]');
}
if (!/^[1-9]\d{0,14}$/.test(values.nonce)) throw new Error('nonce must be a positive integer');
const rfqValues = [values['rfq-solver'], values['rfq-key-id'], values['rfq-public-key']];
if (rfqValues.some((value) => value !== undefined) && rfqValues.some((value) => value === undefined)) {
  throw new Error('RFQ solver, key id, and public key must be provided together');
}
if (values['rfq-public-key'] !== undefined && !/^[0-9a-f]{64}$/.test(values['rfq-public-key'])) {
  throw new Error('RFQ public key must be 64 lowercase hex characters');
}
const release = resolve(values.release);
const output = resolve(values.output);
const manifestNonce = BigInt(values.nonce);
const validUntilValue = (1n << 64n) - 1n;
const maximumNotionalAtoms = 10_000_000_000_000_000_000n;
const rfqPublicKey = values['rfq-public-key'] === undefined
  ? undefined
  : Uint8Array.from(Buffer.from(values['rfq-public-key'], 'hex'));

const readProtocol = (relative) => protocol.parseProtocolJson(
  readFileSync(join(release, relative), 'utf8'),
  relative,
);
const writeProtocol = (relative, value) => {
  const target = join(release, relative);
  const temporary = `${target}.next`;
  writeFileSync(temporary, protocol.stringifyProtocolJson(value));
  renameSync(temporary, target);
};

const privateKey = createPrivateKey(readFileSync(resolve(values.signer)));
if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('signer must be an Ed25519 private key');
const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
if (!(spki instanceof Buffer) || spki.length < 32) throw new Error('signer public key is invalid');
const verificationKey = Uint8Array.from(spki.subarray(-32));

const groups = new Map();
const group = (solverId, validityUnit) => {
  const existing = groups.get(solverId);
  if (existing !== undefined) {
    if (existing.validityUnit !== validityUnit) throw new Error(`solver ${solverId} mixes clock units`);
    return existing;
  }
  const created = {
    solverId,
    validityUnit,
    domains: new Map(),
    templates: new Set(),
    markets: new Map(),
  };
  groups.set(solverId, created);
  return created;
};
const domainKey = (domain) => `${domain.domainId}:${domain.domainManifestVersion}:${Buffer.from(domain.domainManifestHash).toString('hex')}`;
const addLane = (target, lane) => {
  target.domains.set(domainKey(lane.domain), lane.domain);
  target.templates.add(lane.templateId);
  const current = target.markets.get(lane.executionClassId);
  if (current !== undefined && protocol.stringifyProtocolJson(current.quoteAsset) !== protocol.stringifyProtocolJson(lane.quoteAsset)) {
    throw new Error(`market ${lane.executionClassId} changes quote asset`);
  }
  target.markets.set(lane.executionClassId, { quoteAsset: lane.quoteAsset });
};

const evmPaths = [
  'solver/evm-option-spread-runtime.json',
  'solver/evm-calendar-spread-runtime.json',
  'solver/evm-treasury-hedge-runtime.json',
  'solver/evm-collateral-conversion-runtime.json',
  'solver/evm-reverse-basis-runtime.json',
];
const evmDocuments = evmPaths.map((path) => ({ path, document: readProtocol(path) }));
for (const { document } of evmDocuments) {
  for (const lane of document.lanes) {
    addLane(group(lane.solverId, 'EVM_UNIX_SECONDS'), {
      domain: lane.domain,
      templateId: lane.templateManifest.templateId,
      executionClassId: lane.executionClassId,
      quoteAsset: lane.quoteAsset,
    });
  }
}

const solanaPath = 'solver/solana-treasury-hedge-runtime.json';
const solanaDocument = readProtocol(solanaPath);
for (const lane of solanaDocument.lanes) {
  addLane(group(lane.solverId, 'SOLANA_SLOT'), {
    domain: lane.domain,
    templateId: lane.templateManifest.templateId,
    executionClassId: lane.executionClassId,
    quoteAsset: lane.quoteAsset,
  });
}

const hyperliquidPaths = [
  'solver/btc-treasury-hedge-testnet-quote.json',
  'solver/btc-funding-spread-testnet-quote.json',
  'solver/btc-hedge-migration-testnet-quote.json',
  'solver/btc-delta-rebalance-testnet-quote.json',
];
const hyperliquidDocuments = hyperliquidPaths.map((path) => ({ path, document: readProtocol(path) }));
for (const { document } of hyperliquidDocuments) {
  addLane(group(document.market.solverId, 'HYPERLIQUID_UNIX_MILLISECONDS'), {
    domain: document.market.domain,
    templateId: document.market.templateId,
    executionClassId: document.generalized.executionClassId,
    quoteAsset: document.market.quoteAsset,
  });
}
if (values['rfq-solver'] !== undefined && !groups.has(values['rfq-solver'])) {
  throw new Error(`RFQ solver is not present in the release: ${values['rfq-solver']}`);
}

const manifests = [];
const hashBySolver = new Map();
for (const target of groups.values()) {
  const unsigned = {
    manifestVersion: 1,
    environment: 'testnet',
    solverId: target.solverId,
    commonControlGroupId: 'naryx-testnet-reference-solvers',
    operatorIdentityScheme: 'ED25519',
    operatorIdentityKey: verificationKey,
    quoteVerificationKeys: [{
      keyId: `${target.solverId}-quote-v1`,
      scheme: 'ED25519',
      verificationKey,
      validFromValue: 0n,
      validUntilValue,
    }],
    rfqEncryptionKeys: target.solverId === values['rfq-solver']
      ? [{
          keyId: values['rfq-key-id'],
          encryptionSuiteId: 'hpke-x25519-sha256-aes256gcm',
          publicKey: rfqPublicKey,
          validFromValue: 0n,
          validUntilValue,
        }]
      : [],
    supportedDomains: [...target.domains.values()],
    supportedTemplateIds: [...target.templates],
    supportedQuoteModes: ['EXECUTION_COMMITMENT'],
    maximumNotionalByMarket: [...target.markets].map(([marketId, market]) => ({
      marketId,
      quoteAsset: market.quoteAsset,
      maximumNotionalAtoms,
    })),
    rfqEndpoints: [values.endpoint],
    validityUnit: target.validityUnit,
    validUntilValue,
    manifestNonce,
    signature: new Uint8Array(64),
  };
  const hash = protocol.solverCapabilityManifestHash(unsigned);
  const manifest = protocol.solverCapabilityManifest({
    ...unsigned,
    signature: Uint8Array.from(sign(null, Buffer.from(hash), privateKey)),
  });
  manifests.push(manifest);
  hashBySolver.set(target.solverId, hash);
}

for (const { path, document } of evmDocuments) {
  writeProtocol(path, {
    ...document,
    lanes: document.lanes.map((lane) => ({
      ...lane,
      solverCapabilityManifestHash: hashBySolver.get(lane.solverId),
    })),
  });
}
writeProtocol(solanaPath, {
  ...solanaDocument,
  lanes: solanaDocument.lanes.map((lane) => ({
    ...lane,
    solverCapabilityManifestHash: hashBySolver.get(lane.solverId),
  })),
});
for (const { path, document } of hyperliquidDocuments) {
  writeProtocol(path, {
    ...document,
    market: {
      ...document.market,
      solverCapabilityManifestHash: hashBySolver.get(document.market.solverId),
    },
  });
}

writeFileSync(output, protocol.stringifyProtocolJson({ version: 1, manifests }));
process.stdout.write(`${JSON.stringify({
  version: 1,
  manifests: manifests.map((manifest) => ({
    solverId: manifest.solverId,
    markets: manifest.maximumNotionalByMarket.length,
    manifestHash: Buffer.from(hashBySolver.get(manifest.solverId)).toString('hex'),
  })),
}, null, 2)}\n`);
