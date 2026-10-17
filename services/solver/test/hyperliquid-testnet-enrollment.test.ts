import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { agentApprovalTypedData, HyperliquidTestnetEnrollmentService } from '../src/hyperliquid-testnet-enrollment.js';
import { loadHyperliquidTestnetAgentSigner } from '../src/hyperliquid-testnet-agent-key.js';
import type { HyperliquidTestnetUserAccount } from '../src/hyperliquid-testnet-per-user-runtime.js';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'naryx-enrollment-'));
  const encryptionKeyPath = join(directory, 'vault.key');
  writeFileSync(encryptionKeyPath, randomBytes(32), { mode: 0o600 });
  const wallet = privateKeyToAccount(generatePrivateKey());
  const owner = wallet.address.toLowerCase() as `0x${string}`;
  const accounts = new Map<string, HyperliquidTestnetUserAccount>();
  let approved = false, submissions = 0, pending = false, safe = true, now = Date.now();
  const options: HyperliquidTestnetEnrollmentService['options'] = {
    environment: 'TESTNET', directory, encryptionKeyPath, bootstrapAccounts: [], now: () => now,
    hasAccount: owner => accounts.has(owner), registerAccount: async a => { accounts.set(a.owner, a); },
    venue: {
      checkApproval: async () => approved,
      submitApproval: async () => { submissions++; if (pending) throw new Error('network outcome unknown'); approved = true; },
      checkAccount: async () => { assert.ok(safe, 'MARGIN_MODE'); },
    },
  };
  const service = new HyperliquidTestnetEnrollmentService(options);
  return { service, options, wallet, owner, directory, accounts,
    approveLater() { approved = true; }, uncertain() { pending = true; },
    unsafe() { safe = false; }, safe() { safe = true; }, advance() { now += 600_001; },
    submissions: () => submissions,
    cleanup() { service.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

test('owner-signed enrollment encrypts keys, verifies approval and restores separate runtimes', async () => {
  const f = fixture();
  try {
    const first = f.service.challenge(f.owner);
    assert.deepEqual(f.service.challenge(f.owner), first);
    const signature = await f.wallet.signTypedData(first.typedData!);
    await f.service.prepare(f.owner, signature);
    const prepared = f.service.status(f.owner);
    assert.equal(prepared.stage, 'PREPARED');
    const keyPath = join(f.directory, `${f.owner}.key`);
    const encrypted = readFileSync(keyPath, 'utf8');
    assert.equal(JSON.parse(encrypted).version, 2);
    assert.equal(encrypted.includes('privateKey'), false);
    assert.throws(() => loadHyperliquidTestnetAgentSigner(keyPath, prepared.agentAddress!), /encrypted/);
    assert.equal(loadHyperliquidTestnetAgentSigner(keyPath, prepared.agentAddress!, f.options.encryptionKeyPath).address.toLowerCase(), prepared.agentAddress);
    const approval = prepared.approvalTypedData!;
    await f.service.confirm(f.owner, await f.wallet.signTypedData(approval));
    assert.equal(f.service.status(f.owner).stage, 'ACTIVE');
    assert.equal(f.submissions(), 1);
    await f.service.confirm(f.owner);
    assert.equal(f.submissions(), 1);
    f.accounts.clear();
    const restored = new HyperliquidTestnetEnrollmentService(f.options);
    try { await restored.restore(); assert.equal(f.accounts.get(f.owner)?.agentAddress, prepared.agentAddress); }
    finally { restored.close(); }
    const tampered = JSON.parse(encrypted); tampered.tag = '00'.repeat(16);
    writeFileSync(keyPath, JSON.stringify(tampered));
    assert.throws(() => loadHyperliquidTestnetAgentSigner(keyPath, prepared.agentAddress!, f.options.encryptionKeyPath));
  } finally { f.cleanup(); }
});

test('wrong owner, expired enrollment and substituted approval cannot create or activate an account', async () => {
  const f = fixture();
  try {
    const challenge = f.service.challenge(f.owner);
    const other = privateKeyToAccount(generatePrivateKey());
    await assert.rejects(f.service.prepare(f.owner, await other.signTypedData(challenge.typedData!)), /must be signed/);
    f.advance();
    await assert.rejects(f.service.prepare(f.owner, await f.wallet.signTypedData(challenge.typedData!)), /fresh enrollment/);
    const renewed = f.service.challenge(f.owner);
    await f.service.prepare(f.owner, await f.wallet.signTypedData(renewed.typedData!));
    const prepared = f.service.status(f.owner);
    const wrong = agentApprovalTypedData(f.owner, other.address, prepared.approvalTypedData!.message.nonce, Date.now() + 86_400_000);
    await assert.rejects(f.service.confirm(f.owner, await f.wallet.signTypedData(wrong)), /Approve this API wallet/);
    assert.equal(f.accounts.size, 0); assert.equal(f.submissions(), 0);
    f.advance();
    const fresh = f.service.challenge(f.owner);
    await f.service.prepare(f.owner, await f.wallet.signTypedData(fresh.typedData!));
    assert.equal(f.service.status(f.owner).agentAddress, prepared.agentAddress);
  } finally { f.cleanup(); }
});

test('ambiguous approvals never rebroadcast and unsafe account settings cannot activate execution', async () => {
  const f = fixture();
  try {
    const challenge = f.service.challenge(f.owner);
    await f.service.prepare(f.owner, await f.wallet.signTypedData(challenge.typedData!));
    f.uncertain();
    await f.service.confirm(f.owner, await f.wallet.signTypedData(f.service.status(f.owner).approvalTypedData!));
    await f.service.confirm(f.owner);
    assert.equal(f.submissions(), 1); assert.equal(f.accounts.size, 0);
    f.approveLater(); f.unsafe();
    await assert.rejects(f.service.confirm(f.owner), /MARGIN_MODE/);
    assert.equal(f.accounts.size, 0);
    f.safe(); await f.service.confirm(f.owner);
    assert.equal(f.accounts.size, 1); assert.equal(f.submissions(), 1);
  } finally { f.cleanup(); }
});
