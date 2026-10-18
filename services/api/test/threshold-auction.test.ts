import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { timelockEncrypt, timelockDecrypt, type ChainClient } from 'tlock-js';
import { MAINNET_CHAIN_INFO } from 'tlock-js/drand/defaults.js';
import { sealedAuctionDefinition, sealedQuoteCommitment, toHex } from '@naryx/protocol-types';
import { SqlitePrivateDeliveryStore } from '../src/private-delivery-store.js';
import { ThresholdAuctionBackend, thresholdAuctionWindow, verifiedQuicknetInfo, verifyThresholdCiphertext } from '../src/threshold-auction.js';
import { stringifyProtocolJson } from '@naryx/protocol-types';

const definition = sealedAuctionDefinition({ version: 1, auctionId: 'threshold-roundtrip', environment: 'testnet',
  orderHash: '55'.repeat(32), eligibleSolverIds: ['solver-a'], timeUnit: 'EVM_UNIX_SECONDS',
  commitDeadlineValue: 1792257000n, revealDeadlineValue: 1792257100n, settlementDeadlineValue: 1792257200n,
  minimumValidReveals: 1 });
const beacon = { round: 1, randomness: '1466a6cd24e327188770752f6134001c64d6efcc590ccc26b721611ad96f165a',
  signature: 'b55e7cb2d5c613ee0b2e28d6750aabbb78c39dcc96bd9d38c2c2e12198df95571de8e8e402a0cc48871c7089a2b3af4b' };
const client: ChainClient = {
  options: { disableBeaconVerification: false, noCache: true,
    chainVerificationParams: { chainHash: MAINNET_CHAIN_INFO.hash, publicKey: MAINNET_CHAIN_INFO.public_key } },
  chain: () => ({ baseUrl: 'https://unused.invalid', info: async () => MAINNET_CHAIN_INFO }),
  get: async round => { assert.equal(round, 1); return beacon; }, latest: async () => beacon,
};

test('threshold timing pins the network and never releases before the commit deadline', () => {
  const window = thresholdAuctionWindow(definition, MAINNET_CHAIN_INFO);
  assert.ok(window.releaseAtMs > Number(definition.commitDeadlineValue) * 1000);
  assert.throws(() => thresholdAuctionWindow(sealedAuctionDefinition({ ...definition, environment: 'mainnet' }), MAINNET_CHAIN_INFO));
  assert.throws(() => thresholdAuctionWindow({ ...definition, timeUnit: 'SOLANA_SLOT' }, MAINNET_CHAIN_INFO));
  assert.throws(() => thresholdAuctionWindow(definition, { ...MAINNET_CHAIN_INFO, public_key: '00' }));
  assert.throws(() => thresholdAuctionWindow({ ...definition, revealDeadlineValue: definition.commitDeadlineValue + 30n }, MAINNET_CHAIN_INFO));
  assert.throws(() => thresholdAuctionWindow({ ...definition, revealDeadlineValue: 2n ** 64n }, MAINNET_CHAIN_INFO));
  assert.equal(verifiedQuicknetInfo(MAINNET_CHAIN_INFO).hash, MAINNET_CHAIN_INFO.hash);
  for (const changed of [{ public_key: '00' }, { hash: '00' }, { schemeID: 'pedersen-bls-unchained' }]) {
    assert.throws(() => verifiedQuicknetInfo({ ...MAINNET_CHAIN_INFO, ...changed }));
  }
});

test('threshold ciphertext decrypts against a verified public beacon and rejects substitutions', async () => {
  const ciphertext = await timelockEncrypt(1, Buffer.from('sealed quote opening'), client);
  assert.match(verifyThresholdCiphertext(ciphertext, 1), /^[a-f0-9]{64}$/);
  assert.throws(() => verifyThresholdCiphertext(ciphertext, 2));
  assert.throws(() => verifyThresholdCiphertext('plaintext', 1));
  assert.throws(() => verifyThresholdCiphertext('x'.repeat(32769), 1));
  assert.equal((await timelockDecrypt(ciphertext, client)).toString(), 'sealed quote opening');
  await assert.rejects(timelockDecrypt(ciphertext, { ...client, get: async () => ({ ...beacon, signature: '00'.repeat(48) }) }));
});

test('sealed openings survive restart, reject replacement and reveal only a matching commitment', () => {
  const dir = mkdtempSync(join(tmpdir(), 'naryx-threshold-'));
  const path = join(dir, 'delivery.sqlite');
  let store = new SqlitePrivateDeliveryStore(path);
  try {
    const { auctionHashHex } = store.createAuction(definition);
    const opening = { solverId: 'solver-a', quoteHash: '77'.repeat(32), netOutcomeAtoms: 500n, salt: new Uint8Array(32).fill(4) };
    const window = thresholdAuctionWindow(definition, MAINNET_CHAIN_INFO);
    const sealed = { auctionHash: auctionHashHex, solverId: opening.solverId,
      commitment: toHex(sealedQuoteCommitment(auctionHashHex, opening)), ciphertext: 'bounded-encrypted-fixture',
      ciphertextHash: '88'.repeat(32), round: window.round, releaseAtMs: window.releaseAtMs,
      revealAtMs: window.revealAtMs, nowMs: window.commitAtMs - 1000 };
    store.storeThresholdCommitment(sealed);
    store.storeThresholdCommitment(sealed);
    assert.throws(() => store.storeThresholdCommitment({ ...sealed, ciphertextHash: '99'.repeat(32) }));
    assert.equal(store.pendingThresholdOpenings(window.releaseAtMs - 1, 4).length, 0);
    store.close(); store = new SqlitePrivateDeliveryStore(path);
    assert.equal(store.pendingThresholdOpenings(window.releaseAtMs, 4).length, 1);
    assert.throws(() => store.revealThresholdOpening(auctionHashHex, opening.solverId, opening, window.commitAtMs - 1));
    assert.throws(() => store.revealThresholdOpening(auctionHashHex, opening.solverId, { ...opening, netOutcomeAtoms: 501n }, window.releaseAtMs));
    assert.equal(store.pendingThresholdOpenings(window.releaseAtMs, 4).length, 1);
    store.revealThresholdOpening(auctionHashHex, opening.solverId, opening, window.releaseAtMs);
    store.revealThresholdOpening(auctionHashHex, opening.solverId, opening, window.releaseAtMs);
    assert.equal(store.pendingThresholdOpenings(window.releaseAtMs, 4).length, 0);
    const result = store.auctionView(auctionHashHex, definition.revealDeadlineValue);
    assert.equal(result.phase, 'CLOSED');
    if (result.phase === 'CLOSED') assert.equal(result.result.outcome, 'AWARDED');
  } finally { store.close(); rmSync(dir, { recursive: true }); }
});

test('release admission caps simultaneous work across auctions without appending refused commitments', () => {
  const dir = mkdtempSync(join(tmpdir(), 'naryx-threshold-capacity-'));
  const store = new SqlitePrivateDeliveryStore(join(dir, 'delivery.sqlite'));
  const window = thresholdAuctionWindow(definition, MAINNET_CHAIN_INFO);
  const submit = (index: number, solverId: string) => {
    const { auctionHashHex } = store.createAuction({ ...definition, auctionId: `capacity-${index}`, eligibleSolverIds: [solverId] });
    const input = { auctionHash: auctionHashHex, solverId, commitment: '77'.repeat(32), ciphertext: 'encrypted-fixture',
      ciphertextHash: '88'.repeat(32), round: window.round, releaseAtMs: window.releaseAtMs,
      revealAtMs: window.revealAtMs, nowMs: window.commitAtMs - 1000 };
    return { auctionHashHex, input };
  };
  try {
    for (let index = 0; index < 8; index++) store.storeThresholdCommitment(submit(index, `solver-${Math.floor(index / 2)}`).input);
    const refused = submit(9, 'solver-5');
    assert.throws(() => store.storeThresholdCommitment(refused.input), /capacity is full/);
    const view = store.auctionView(refused.auctionHashHex, definition.commitDeadlineValue - 1n);
    assert.ok(view.phase !== 'CLOSED' && view.commitmentCount === 0);
    const first = store.pendingThresholdOpenings(window.releaseAtMs, 4);
    for (const row of first) store.markThresholdAttempt(row.auctionHash, row.solverId, window.releaseAtMs);
    const second = store.pendingThresholdOpenings(window.releaseAtMs, 4);
    assert.equal(new Set([...first, ...second].map(row => row.auctionHash)).size, 8);
    for (const row of first) store.expireThresholdOpening(row.auctionHash, row.solverId);
    store.storeThresholdCommitment(refused.input);
    assert.throws(() => store.storeThresholdCommitment(submit(10, 'solver-3').input), /capacity is full/);
  } finally { store.close(); rmSync(dir, { recursive: true }); }
});

test('backend releases a durable encrypted opening using the verified beacon, without solver reveal', async context => {
  const dir = mkdtempSync(join(tmpdir(), 'naryx-threshold-backend-'));
  const store = new SqlitePrivateDeliveryStore(join(dir, 'delivery.sqlite'));
  const genesis = MAINNET_CHAIN_INFO.genesis_time;
  const nextBeacon = { round: 2, randomness: '5782d6987841c654515a0e72b2d1ebb4e741234042c37cb19608ae50d93fb60c',
    signature: 'b6b6a585449b66eb12e875b64fcbab3799861a00e4dbf092d99e969a5eac57dd3f798acf61e705fe4f093db926626807' };
  const auction = { ...definition, commitDeadlineValue: BigInt(genesis),
    revealDeadlineValue: BigInt(genesis + 100), settlementDeadlineValue: BigInt(genesis + 200) };
  let now = (genesis - 2) * 1000;
  let infoReads = 0;
  let beaconReads = 0;
  context.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url.endsWith('/info')) { infoReads++; return Response.json(MAINNET_CHAIN_INFO); }
    assert.ok(url.endsWith('/public/2'));
    if (++beaconReads === 1) return Response.json({ ...nextBeacon, signature: '00'.repeat(48) });
    return Response.json(nextBeacon);
  });
  const backend = new ThresholdAuctionBackend(store, () => now);
  try {
    const { auctionHashHex } = store.createAuction(auction);
    const opening = { auctionHash: auctionHashHex, solverId: 'solver-a', quoteHash: '77'.repeat(32),
      netOutcomeAtoms: 500n, salt: new Uint8Array(32).fill(4) };
    const ciphertext = await timelockEncrypt(2, Buffer.from(stringifyProtocolJson(opening)), client);
    await backend.seal(auctionHashHex, opening.solverId, { ciphertext, commitment: toHex(sealedQuoteCommitment(auctionHashHex, opening)) });
    await backend.advance();
    assert.equal(store.pendingThresholdOpenings(now, 4).length, 0);
    now = (genesis + 3) * 1000 + 1;
    await backend.advance();
    assert.equal(store.pendingThresholdOpenings(now, 4).length, 1);
    await backend.advance();
    const result = store.auctionView(auctionHashHex, auction.revealDeadlineValue);
    assert.ok(result.phase === 'CLOSED' && result.result.outcome === 'AWARDED');
    assert.equal(infoReads, 1);
    assert.equal(beaconReads, 2);
  } finally { backend.close(); store.close(); rmSync(dir, { recursive: true }); }
});
