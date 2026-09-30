import assert from 'node:assert/strict';
import { test } from 'node:test';
import { builderAttributionHash, builderManifestHash, checkBuilderFee, toHex, type BuilderAttributionInput, type BuilderManifestInput } from '../src/index.js';

const manifest: BuilderManifestInput = {
  manifestVersion: 1,
  environment: 'testnet',
  builderId: 'builder-a',
  identityKey: new Uint8Array(32).fill(7),
  payoutAccounts: [{ domainId: 'svm:testnet', account: 'payout-a' }],
  supportedDomainIds: ['svm:testnet', 'eip155:84532'],
  maximumBuilderFeeBpsByTemplate: [{ templateId: 'cash-and-carry-v1', maximumFeeBps: 10n }],
  validFromMs: 1_000n,
  validUntilMs: 9_000n,
  nonce: 1n,
  signature: new Uint8Array(64),
};
const attribution: BuilderAttributionInput = { attributionVersion: 1, orderHash: '11'.repeat(32), builderId: 'builder-a', builderManifestHash: builderManifestHash(manifest), maximumBuilderFeeBps: 5n };
const charge = { domainId: 'svm:testnet', templateId: 'cash-and-carry-v1', notionalAtoms: 1_000_000n, feeAtoms: 500n, orderAcceptedAtMs: 2_000n };

test('builder manifests and attributions hash every term and bound their fees', () => {
  assert.equal(toHex(builderManifestHash({ ...manifest, supportedDomainIds: [...manifest.supportedDomainIds].reverse() })), toHex(builderManifestHash(manifest)));
  assert.notEqual(toHex(builderManifestHash({ ...manifest, nonce: 2n })), toHex(builderManifestHash(manifest)));
  assert.throws(() => builderManifestHash({ ...manifest, payoutAccounts: [{ domainId: 'evm:1', account: 'x' }] }), /unsupported domain/);
  assert.throws(() => builderManifestHash({ ...manifest, maximumBuilderFeeBpsByTemplate: [{ templateId: 't', maximumFeeBps: 101n }] }), /at most 100/);
  assert.notEqual(toHex(builderAttributionHash({ ...attribution, maximumBuilderFeeBps: 6n })), toHex(builderAttributionHash(attribution)));
});

test('a builder fee is payable only within the owner cap, the manifest cap, and its validity', () => {
  assert.deepEqual(checkBuilderFee(manifest, attribution, charge), { payable: true });
  const violations = (change: object, owner = attribution) => {
    const result = checkBuilderFee(manifest, owner, { ...charge, ...change });
    return result.payable ? [] : result.violations;
  };
  assert.deepEqual(violations({ feeAtoms: 501n }), ['FEE_ABOVE_ORDER_CAP']);
  assert.deepEqual(violations({ feeAtoms: 1_001n }, { ...attribution, maximumBuilderFeeBps: 20n }), ['FEE_ABOVE_MANIFEST_CAP']);
  assert.deepEqual(violations({ orderAcceptedAtMs: 9_000n }), ['MANIFEST_NOT_VALID_AT_ORDER']);
  assert.deepEqual(violations({ domainId: 'evm:1', templateId: 'other' }), ['DOMAIN_UNSUPPORTED', 'TEMPLATE_UNSUPPORTED', 'FEE_ABOVE_MANIFEST_CAP'].filter((v) => v !== 'FEE_ABOVE_MANIFEST_CAP'));
  assert.deepEqual(violations({}, { ...attribution, builderManifestHash: '22'.repeat(32) }), ['MANIFEST_MISMATCH']);
});
