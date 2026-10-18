import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { domainRef, toHex, packageGraphHash, strategyPackageOrderHash, strategyPackageQuoteHash, typedStrategyRouteHash } from '@naryx/protocol-types';
import { keccak256, stringToHex, type Address, type Hex } from 'viem';
import { prepareCanonicalCalendar, refreshCalendarRecovery, type CalendarDomainObservation } from '../src/cross-domain-canonical-calendar.js';
import { validateCrossDomainWalletDraft } from '../src/cross-domain-wallet-admission.js';
import { validateEvmFullReversal } from '../src/evm-full-reversal-policy.js';

const h = (value: string) => keccak256(stringToHex(value));
const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
const now = 1_791_000_000n;
const keys = generateKeyPairSync('ed25519');
const signer = { scheme: 'ED25519' as const,
  verificationKey: Uint8Array.from(createPublicKey(keys.privateKey).export({ format: 'der', type: 'spki' }).subarray(12)),
  signDigest: (value: Uint8Array) => Uint8Array.from(sign(null, value, keys.privateKey)) };

function observations(): CalendarDomainObservation[] {
  return [84532, 421614].map((chain, i) => ({
    domain: domainRef(`eip155:${chain}`, 3, h(`domain-${chain}`)), owner: a(1), account: a(i + 2), accountCodeHash: h('account'),
    packageId: h(`local-package-${chain}`), localTemplateHash: h(`local-template-${chain}`), solver: a(i + 4),
    adapter: a(i + 6), adapterCodeHash: h('adapter'), adapterIdentity: { subjectId: h(`adapter-${chain}`), manifestVersion: 1, manifestHash: h(`adapter-manifest-${chain}`) },
    baseToken: a(10), quoteToken: a(11), instrument: a(i + 12), instrumentCodeHash: h('instrument'),
    role: i === 0 ? 'near-future' : 'far-future', maturity: now + BigInt((i + 1) * 30_000), nonce: 0n, generation: 0n,
    entryNotionalWad: 10n ** 18n, maximumNotionalWad: 102n * 10n ** 16n,
    minimumBalanceWad: 99n * 10n ** 16n, maximumBalanceWad: 10n ** 18n,
    risk: { riskDomainId: h('risk'), policyVersion: 2, policyManifestHash: h('risk-policy'),
      series: { seriesId: h('calendar-spread-v1'), manifestVersion: 1, manifestHash: h(`series-${chain}`) },
      accountingToken: a(11), grossQuoteAtoms: 0n, netQuoteAtoms: 0n, marginQuoteAtoms: 0n, reservedRecoveryQuoteAtoms: 0n,
      observationAgeMs: 0n, timeToUnwindMs: 3_600_000n, dependencyExposures: [{ dependencyId: h(`adapter-${chain}`), grossQuoteAtoms: 0n }] },
    feePolicyVersion: 1, feePolicyManifestHash: h('fees'), reservationId: async order => h(`reservation-${chain}-${order}`),
    reservationBook: { address: a(i + 14), codeHash: h('book'), maximumTtlSeconds: 21_600n, maximumBaseAtoms: 10n ** 15n },
    executorClassId: 'evm-recoverable-package-v1', executorClassVersion: 1, executorClassManifestHash: h('executor'),
  }));
}

test('canonical cross-chain calendar binds real documents and distinct local registrations', async () => {
  const source = observations();
  const { draft, documents } = await prepareCanonicalCalendar({ owner: a(1), requestId: 'canonical-calendar-request-1', now, observations: source, signer });
  validateCrossDomainWalletDraft(draft);
  assert.equal(draft.plan.prepareDeadline - now, 10_800n);
  assert.equal(draft.plan.commitDeadline - now, 14_400n);
  assert.ok(draft.plan.compensationDeadline < source[0]!.maturity);
  assert.equal(toHex(draft.execution.orderHash), toHex(strategyPackageOrderHash(documents.order)));
  assert.equal(toHex(draft.execution.graphHash), toHex(packageGraphHash(documents.graph)));
  assert.equal(toHex(draft.execution.routeHash), toHex(typedStrategyRouteHash(documents.route)));
  assert.equal(toHex(draft.execution.quoteHash), toHex(strategyPackageQuoteHash(documents.quote)));
  assert.equal(verify(null, draft.execution.quoteHash, keys.publicKey, documents.quote.signature), true);
  for (const domain of draft.execution.domains) {
    assert.equal(domain.kind, 'EVM_MULTI_STRATEGY_ACCOUNT');
    if (domain.kind !== 'EVM_MULTI_STRATEGY_ACCOUNT') throw new Error('wrong kind');
    const o = source.find(o => o.domain.domainId === domain.domain.domainId)!;
    assert.equal(domain.envelope.execution.packageId, o.packageId);
    assert.equal(domain.envelope.execution.template.templateManifestHash, o.localTemplateHash);
    assert.notEqual(o.localTemplateHash, `0x${toHex(draft.execution.identity.templateManifestHash)}`);
    const reversal = validateEvmFullReversal(domain.envelope, draft.lanes.find(l => l.domainId === o.domain.domainId)!.recovery,
      [{ address: o.adapter, codeHash: o.adapterCodeHash, kind: 'RECOVERABLE_FUTURE', baseToken: o.baseToken, quoteToken: o.quoteToken }]);
    assert.equal(reversal.maximumEntryQuoteAtoms, 1_000_000n);
    assert.equal(reversal.maximumLossQuoteAtoms, 100_000n);
    const original = draft.lanes.find(l => l.domainId === o.domain.domainId)!.recovery;
    const renewed = refreshCalendarRecovery(original, o.domain, o.adapterCodeHash, Number(o.maturity), 1n, now + 20_000n);
    assert.equal(renewed.execution.deadline, now + 20_000n);
    assert.equal(renewed.execution.previousStateHash, original.execution.previousStateHash);
    assert.notEqual(renewed.ownerDigest, original.ownerDigest);
    assert.equal(validateEvmFullReversal(domain.envelope, renewed,
      [{ address: o.adapter, codeHash: o.adapterCodeHash, kind: 'RECOVERABLE_FUTURE', baseToken: o.baseToken, quoteToken: o.quoteToken }]).maximumLossQuoteAtoms, 100_000n);
    assert.throws(() => refreshCalendarRecovery(original, domainRef('eip155:1', 3, h('wrong')), o.adapterCodeHash, Number(o.maturity), 1n, now + 20_000n), /refused/);
  }
});

test('projection changes alter canonical commitments; mismatched owner, domain and overflow fail closed', async () => {
  const input = { owner: a(1), requestId: 'canonical-calendar-request-2', now, signer };
  const first = await prepareCanonicalCalendar({ ...input, observations: observations() });
  const changed = observations(); changed[0] = { ...changed[0]!, localTemplateHash: h('new-registration') };
  const second = await prepareCanonicalCalendar({ ...input, observations: changed });
  assert.notEqual(toHex(first.draft.execution.graphHash), toHex(second.draft.execution.graphHash));
  for (const mutation of [
    { owner: a(99) }, { generation: (1n << 64n) - 1n },
    { domain: domainRef('eip155:1', 3, h('mainnet')) }, { maturity: now + 28_800n },
    { reservationBook: { ...observations()[0]!.reservationBook, maximumTtlSeconds: 3_600n } },
    { reservationBook: { ...observations()[0]!.reservationBook, maximumBaseAtoms: 99_999_999_999_999n } },
  ]) {
    const source = observations(); source[0] = { ...source[0]!, ...mutation };
    await assert.rejects(prepareCanonicalCalendar({ ...input, observations: source }), /refused/);
  }
  const boundary = observations();
  boundary[0] = { ...boundary[0]!, reservationBook: { ...boundary[0]!.reservationBook, maximumTtlSeconds: 14_640n } };
  await prepareCanonicalCalendar({ ...input, observations: boundary });
});
