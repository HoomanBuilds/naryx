import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { privateKeyToAccount } from 'viem/accounts';
import { NativeCashRegistration } from '../src/native-cash-registration.js';

const governor = privateKeyToAccount(`0x${'04'.repeat(32)}`);
const binding = { marketId: 'cash-range', manifestHash: `0x${'11'.repeat(32)}` as const, chainId: 84532,
  clearingHouse: `0x${'22'.repeat(20)}` as const, governor: governor.address };

test('native cash registration requires real governor consent followed by the complete activation delay', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'naryx-cash-registration-')); const path = join(dir, 'registration.sqlite');
  let now = 1_000_000;
  let registry = new NativeCashRegistration(path, [binding], () => now);
  try {
    assert.equal(registry.status(binding.marketId).state, 'INACTIVE');
    const challenge = registry.challenge(binding.marketId, 'ACTIVE');
    now += 100_000;
    const signature = await governor.signTypedData(challenge.typedData);
    const admitted = await registry.authorize(binding.marketId, challenge.challengeId, signature);
    assert.equal(admitted.state, 'INACTIVE'); assert.equal(admitted.pendingState, 'ACTIVE'); assert.equal(admitted.activateAt, 1160);
    registry.close(); registry = new NativeCashRegistration(path, [binding], () => now);
    now += 59_000; assert.equal(registry.status(binding.marketId).state, 'INACTIVE');
    now += 1000; assert.equal(registry.status(binding.marketId).state, 'ACTIVE');
    const exit = registry.challenge(binding.marketId, 'EXIT_ONLY');
    await registry.authorize(binding.marketId, exit.challengeId, await governor.signTypedData(exit.typedData));
    assert.equal(registry.status(binding.marketId).state, 'EXIT_ONLY');
    await registry.authorize(binding.marketId, challenge.challengeId, signature);
    assert.equal(registry.status(binding.marketId).state, 'EXIT_ONLY');
  } finally { registry.close(); rmSync(dir, { recursive: true }); }
});

test('registration rejects wrong authority, wrong market, expired consent and changed immutable bindings', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'naryx-cash-registration-')); const path = join(dir, 'registration.sqlite');
  let now = 1_000_000; const registry = new NativeCashRegistration(path, [binding], () => now);
  try {
    const challenge = registry.challenge(binding.marketId, 'ACTIVE');
    const wrong = privateKeyToAccount(`0x${'05'.repeat(32)}`);
    await assert.rejects(registry.authorize(binding.marketId, challenge.challengeId, await wrong.signTypedData(challenge.typedData)), /governor/);
    const signature = await governor.signTypedData(challenge.typedData);
    await assert.rejects(registry.authorize('other-market', challenge.challengeId, signature), /unknown/);
    now += 300_000;
    await assert.rejects(registry.authorize(binding.marketId, challenge.challengeId, signature), /expired/);
    assert.equal(registry.status(binding.marketId).state, 'INACTIVE');
    assert.throws(() => new NativeCashRegistration(path, [{ ...binding, manifestHash: `0x${'33'.repeat(32)}` }]), /cannot mutate/);
  } finally { registry.close(); rmSync(dir, { recursive: true }); }
});
