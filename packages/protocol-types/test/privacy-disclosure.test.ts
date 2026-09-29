import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  commitDisclosureRecord,
  discloseFields,
  paddedLength,
  permittedDisclosureFields,
  privacyProfile,
  toHex,
  verifySelectiveDisclosure,
  type PrivacyConfiguration,
  type PrivacyProfile,
} from '../src/index.js';

const config: PrivacyConfiguration = {
  requestedMode: 'PRIVATE_DIRECT_RFQ',
  discoveryMode: 'LOCAL_CATALOGUE',
  privatePathAvailable: true,
  transportHidesNetworkOrigin: false,
  transportPadsCiphertext: false,
  transportHidesSolverSet: false,
  takerIdentity: 'ANONYMOUS',
  blindTwoWay: true,
  enrichedReceiptDelayValue: 3_600n,
};

const cell = (profile: PrivacyProfile, subject: string, observer: string) =>
  profile.matrix.find((entry) => entry.subject === subject && entry.observer === observer);
const leaks = (profile: PrivacyProfile) => profile.leakage.map((item) => `${item.channel}:${item.observer}:${item.severity}`);

describe('privacy profile', () => {
  test('private RFQ hides content from the relay but reports the metadata it still sees', () => {
    const profile = privacyProfile(config);
    assert.equal(profile.effectiveMode, 'PRIVATE_DIRECT_RFQ');
    assert.equal(profile.matrix.length, 40);
    assert.deepEqual(cell(profile, 'ORDER_CONTENTS', 'RELAY'), { subject: 'ORDER_CONTENTS', observer: 'RELAY', preTrade: 'METADATA_ONLY', postTrade: 'VISIBLE' });
    assert.equal(cell(profile, 'TRADE_DIRECTION', 'SELECTED_SOLVERS')?.preTrade, 'HIDDEN');
    assert.equal(cell(profile, 'ENRICHED_RECEIPT', 'PUBLIC')?.postTrade, 'DELAYED');
    assert.deepEqual(profile.claims, ['CONTENT_CONFIDENTIALITY', 'DISCOVERY_PRIVACY']);
    assert.deepEqual(leaks(profile), [
      'SIZE:RELAY:MEDIUM',
      'TIMING:RELAY:MEDIUM',
      'SENDER:RELAY:MEDIUM',
      'SOLVER_SELECTION:RELAY:MEDIUM',
      'NETWORK_ORIGIN:RELAY:MEDIUM',
      'PUBLIC_SETTLEMENT:PUBLIC:HIGH',
    ]);
  });

  test('public settlement state is never hidden after the trade, whatever the transport', () => {
    const profile = privacyProfile({ ...config, requestedMode: 'SEALED_BATCH_AUCTION', transportHidesNetworkOrigin: true, transportPadsCiphertext: true, transportHidesSolverSet: true });
    for (const subject of ['WALLET_IDENTITY', 'COLLATERAL', 'VENUE_POSITIONS', 'ORDER_CONTENTS']) {
      assert.equal(cell(profile, subject, 'PUBLIC')?.postTrade, 'VISIBLE', subject);
    }
    assert.deepEqual(profile.claims, ['CONTENT_CONFIDENTIALITY', 'SOLVER_QUOTE_SECRECY', 'TRAFFIC_PRIVACY', 'SOLVER_SET_HIDING', 'DISCOVERY_PRIVACY']);
    assert.ok(leaks(profile).includes('PUBLIC_SETTLEMENT:PUBLIC:HIGH'));
    assert.ok(leaks(profile).includes('SIZE:RELAY:LOW'));
  });

  test('an unavailable private path is reported as a downgrade with no privacy claim', () => {
    const profile = privacyProfile({ ...config, privatePathAvailable: false, discoveryMode: 'DIRECT_RELAY_QUERY' });
    assert.equal(profile.downgraded, true);
    assert.equal(profile.effectiveMode, 'PUBLIC_RFQ');
    assert.deepEqual(profile.claims, []);
    assert.equal(cell(profile, 'ORDER_CONTENTS', 'PUBLIC')?.preTrade, 'VISIBLE');
    assert.ok(leaks(profile).includes('DOWNGRADE:PUBLIC:HIGH'));
    assert.ok(leaks(profile).includes('DISCOVERY_INTENT:RELAY:HIGH'));
    assert.notEqual(toHex(profile.profileHash), toHex(privacyProfile(config).profileHash));
  });

  test('padding rounds to a power-of-two bucket', () => {
    assert.equal(paddedLength(0, 256), 256);
    assert.equal(paddedLength(257, 256), 512);
    assert.equal(paddedLength(4_096, 256), 4_096);
    assert.throws(() => paddedLength(10, 300), /power of two/);
  });
});

describe('selective disclosure', () => {
  const salt = (fill: number) => new Uint8Array(32).fill(fill);
  const text = (value: string) => new TextEncoder().encode(value);
  const record = commitDisclosureRecord('receipt-1', [
    { name: 'realizedPnl', value: text('1250'), salt: salt(1) },
    { name: 'wallet', value: text('owner'), salt: salt(2) },
    { name: 'fees', value: text('12'), salt: salt(3) },
  ]);

  test('an auditor verifies exactly the disclosed fields against the committed root', () => {
    const disclosure = discloseFields(record, ['fees', 'realizedPnl']);
    assert.deepEqual(disclosure.withheld.map((field) => field.name), ['wallet']);
    const revealed = verifySelectiveDisclosure(record.root, disclosure);
    assert.deepEqual([...revealed.keys()], ['fees', 'realizedPnl']);
    assert.equal(new TextDecoder().decode(revealed.get('realizedPnl')), '1250');
  });

  test('altered values, dropped fields, and foreign roots are rejected', () => {
    const disclosure = discloseFields(record, ['fees']);
    const altered = { ...disclosure, revealed: [{ ...(disclosure.revealed[0] as never as object), value: text('1') }] } as never;
    assert.throws(() => verifySelectiveDisclosure(record.root, altered), /committed root/);
    assert.throws(() => verifySelectiveDisclosure(record.root, { ...disclosure, withheld: disclosure.withheld.slice(1) }), /committed root/);
    const other = commitDisclosureRecord('receipt-2', [{ name: 'fees', value: text('12'), salt: salt(3) }]);
    assert.throws(() => verifySelectiveDisclosure(other.root, disclosure), /committed root/);
    assert.throws(() => discloseFields(record, ['missing']), /no field/);
    assert.throws(() => commitDisclosureRecord('r', [{ name: 'a', value: text('1'), salt: salt(1).slice(0, 8) }]), /salt must be 32 bytes/);
  });

  test('the same value under different salts commits differently', () => {
    const first = commitDisclosureRecord('r', [{ name: 'a', value: text('1'), salt: salt(1) }]);
    const second = commitDisclosureRecord('r', [{ name: 'a', value: text('1'), salt: salt(2) }]);
    assert.notEqual(toHex(first.root), toHex(second.root));
  });

  test('disclosure rules release fields per audience after their delay', () => {
    const rules = [
      { audience: 'AUDITOR' as const, fieldNames: ['fees', 'realizedPnl', 'wallet'], delayValue: 0n },
      { audience: 'PUBLIC' as const, fieldNames: ['fees'], delayValue: 3_600n },
    ];
    assert.deepEqual(permittedDisclosureFields(rules, 'AUDITOR', 100n, 100n), ['fees', 'realizedPnl', 'wallet']);
    assert.deepEqual(permittedDisclosureFields(rules, 'PUBLIC', 100n, 3_699n), []);
    assert.deepEqual(permittedDisclosureFields(rules, 'PUBLIC', 100n, 3_700n), ['fees']);
    assert.deepEqual(permittedDisclosureFields(rules, 'COUNTERPARTY', 100n, 9_999n), []);
  });
});
