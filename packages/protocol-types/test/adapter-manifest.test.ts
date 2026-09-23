import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  CanonicalWriter,
  DuplicateElementError,
  MalformedInputError,
  RangeViolationError,
  accountAndAuthorityBinding,
  adapterManifest,
  adapterManifestBytes,
  adapterManifestHash,
  domainRef,
  encodeAdapterManifest,
  identityConstraint,
  signerRule,
  toHex,
  type AccountAndAuthorityBindingInput,
  type AdapterManifest,
  type AdapterManifestInput,
} from '../src/index.js';
import { loadFixture, type AdapterManifestFixture } from './fixtures.js';

const fixture = loadFixture<AdapterManifestFixture>('adapter-manifest.json');

const DOMAIN_HASH = '11'.repeat(32);
const VENUE_HASH = '22'.repeat(32);
const MARKET_HASH = '33'.repeat(32);
const ASSET_HASH = '44'.repeat(32);
const TEMPLATE_HASH = '55'.repeat(32);
const ACCOUNTING_HASH = '66'.repeat(32);

function binding(
  bindingId: string,
  overrides: Partial<AccountAndAuthorityBindingInput> = {},
): AccountAndAuthorityBindingInput {
  return {
    bindingId,
    accountRole: 'venue-market',
    accountIdentity: { source: 'EXACT', exactIdentity: `${bindingId}-account` },
    codeIdentity: { source: 'EXACT', exactIdentity: 'venue-program-v1' },
    ownerIdentity: {
      source: 'CLASS_DERIVED',
      ruleId: 'token-account-owner-v1',
      ruleVersion: 1,
    },
    accessModes: ['OBSERVE', 'INVOKE'],
    authorityRole: 'trader-authority',
    authorityIdentity: {
      source: 'SIGNED_ORDER',
      ruleId: 'order-trader-v1',
      ruleVersion: 1,
    },
    signerRule: { mode: 'RUNTIME_SIGNATURE', schemeId: 'solana-ed25519-v1' },
    ...overrides,
  };
}

function manifestInput(overrides: Partial<AdapterManifestInput> = {}): AdapterManifestInput {
  return {
    manifestVersion: 1,
    environment: 'devnet',
    adapterId: 'phoenix-perp-v1',
    adapterClass: 'svm-phoenix-perp',
    adapterClassVersion: 1,
    domain: domainRef('solana-devnet', 1, DOMAIN_HASH),
    venueId: 'phoenix',
    venueManifestHash: VENUE_HASH,
    codeIdentity: 'phoenix-program-build-v1',
    supportedMarkets: [
      { marketId: 'sol-perp', marketManifestHash: MARKET_HASH },
    ],
    supportedAssets: [
      { assetId: 'usdc-solana-devnet', assetManifestHash: ASSET_HASH },
    ],
    supportedLegTypes: ['PERPETUAL'],
    supportedSettlementClasses: ['ATOMIC_POSTCONDITION'],
    supportedTemplates: [
      {
        templateId: 'cash-and-carry-v1',
        templateVersion: 1,
        packageTemplateManifestHash: TEMPLATE_HASH,
      },
    ],
    accountAndAuthorityMap: [binding('market')],
    accountingSchemaHash: ACCOUNTING_HASH,
    ...overrides,
  };
}

describe('adapter identity and authority constraints', () => {
  test('identity sources enforce exact or derived fields exclusively', () => {
    assert.equal(
      identityConstraint({ source: 'EXACT', exactIdentity: 'program-v1' }).exactIdentity,
      'program-v1',
    );
    assert.equal(
      identityConstraint({
        source: 'SIGNED_ROUTE',
        ruleId: 'route-account-v1',
        ruleVersion: 1,
      }).ruleVersion,
      1,
    );
    assert.throws(() => identityConstraint({ source: 'EXACT' }), MalformedInputError);
    assert.throws(
      () =>
        identityConstraint({
          source: 'EXACT',
          exactIdentity: 'program-v1',
          ruleId: 'forbidden',
          ruleVersion: 1,
        }),
      MalformedInputError,
    );
    assert.throws(
      () => identityConstraint({ source: 'CLASS_DERIVED', exactIdentity: 'forbidden' }),
      MalformedInputError,
    );
  });

  test('signer modes enforce their scheme rule', () => {
    assert.deepEqual(signerRule({ mode: 'NONE' }), { mode: 'NONE' });
    assert.throws(
      () => signerRule({ mode: 'NONE', schemeId: 'unexpected' }),
      MalformedInputError,
    );
    assert.throws(
      () => signerRule({ mode: 'VERIFIED_AUTHORIZATION' }),
      MalformedInputError,
    );
  });

  test('bindings require access and canonical binding order', () => {
    assert.throws(
      () => accountAndAuthorityBinding(binding('empty', { accessModes: [] })),
      MalformedInputError,
    );
    assert.equal(
      adapterManifest(
        manifestInput({ accountAndAuthorityMap: [binding('a'), binding('b')] }),
      ).accountAndAuthorityMap.length,
      2,
    );
    assert.throws(
      () =>
        adapterManifest(
          manifestInput({ accountAndAuthorityMap: [binding('b'), binding('a')] }),
        ),
      MalformedInputError,
    );
    assert.throws(
      () =>
        adapterManifest(
          manifestInput({ accountAndAuthorityMap: [binding('a'), binding('a')] }),
        ),
      DuplicateElementError,
    );
  });
});

describe('adapter manifest canonical identity', () => {
  test('canonical bytes and domain-separated digest match the golden vector', () => {
    assert.equal(toHex(adapterManifestBytes(manifestInput())), fixture.canonicalHex);
    assert.equal(toHex(adapterManifestHash(manifestInput())), fixture.digestHex);
  });

  test('supported sets canonicalize while duplicate references reject', () => {
    const canonical = adapterManifest(
      manifestInput({
        supportedLegTypes: ['SPOT', 'PERPETUAL'],
        supportedSettlementClasses: [
          'BATCHED_IOC_WITH_RECOVERY',
          'ATOMIC_POSTCONDITION',
        ],
      }),
    );
    assert.deepEqual(canonical.supportedLegTypes, ['SPOT', 'PERPETUAL']);
    assert.deepEqual(canonical.supportedSettlementClasses, [
      'ATOMIC_POSTCONDITION',
      'BATCHED_IOC_WITH_RECOVERY',
    ]);
    assert.throws(
      () => adapterManifest(manifestInput({ supportedLegTypes: ['SPOT', 'SPOT'] })),
      DuplicateElementError,
    );
    assert.throws(
      () =>
        adapterManifest(
          manifestInput({
            supportedAssets: [
              { assetId: 'usdc-solana-devnet', assetManifestHash: ASSET_HASH },
              { assetId: 'usdc-solana-devnet', assetManifestHash: ASSET_HASH },
            ],
          }),
        ),
      DuplicateElementError,
    );
  });

  test('versions and hashes use their exact runtime types', () => {
    assert.throws(() => adapterManifest(manifestInput({ manifestVersion: 0 })), MalformedInputError);
    assert.throws(
      () => adapterManifest(manifestInput({ adapterClassVersion: 0x1_0000_0000 })),
      RangeViolationError,
    );
    assert.throws(
      () => adapterManifest(manifestInput({ venueManifestHash: '00'.repeat(32) })),
      MalformedInputError,
    );
  });

  test('the encoder rejects a forged hash and returned hashes are defensive copies', () => {
    const manifest = adapterManifest(manifestInput());
    const before = toHex(adapterManifestHash(manifest));
    manifest.venueManifestHash[0] = 0xff;
    assert.equal(toHex(adapterManifestHash(manifest)), before);

    const forged = {
      ...manifest,
      venueManifestHash: VENUE_HASH,
    } as unknown as AdapterManifest;
    assert.throws(
      () => encodeAdapterManifest(new CanonicalWriter(), forged),
      MalformedInputError,
    );
  });

  test('a bound capability changes canonical identity', () => {
    const initial = toHex(adapterManifestHash(manifestInput()));
    const changed = toHex(
      adapterManifestHash(manifestInput({ codeIdentity: 'phoenix-program-build-v2' })),
    );
    assert.notEqual(initial, changed);
    assert.ok(adapterManifestBytes(manifestInput()).length > 0);
  });
});
