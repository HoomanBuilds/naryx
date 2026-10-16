import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { sealedAuctionDefinition, sealedAuctionHash, stringifyProtocolJson, toHex } from '@naryx/protocol-types';
import {
  SealedAuctionParticipant,
  HttpSealedAuctionRelay,
  SqliteSealedAuctionJournal,
  type EligibleSealedAuctionPage,
  type SealedAuctionQuotePort,
  type SealedAuctionRelayPort,
} from '../src/index.js';

const START_MS = 1_900_000_000_000;
const START_S = BigInt(START_MS / 1_000);

test('an expired revealed auction stops retrying its settlement award', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'naryx-sealed-expired-'));
  const journal = new SqliteSealedAuctionJournal(join(directory, 'journal.sqlite'));
  const definition = sealedAuctionDefinition({
    version: 1, auctionId: 'expired-award', environment: 'testnet', orderHash: '55'.repeat(32),
    eligibleSolverIds: ['solver-a'], timeUnit: 'EVM_UNIX_SECONDS',
    commitDeadlineValue: START_S + 10n, revealDeadlineValue: START_S + 20n,
    settlementDeadlineValue: START_S + 30n, minimumValidReveals: 1,
  });
  const auctionHash = toHex(sealedAuctionHash(definition));
  journal.discover({ auctions: [{ cursor: 1, auctionHash, definition, createdAtMs: START_MS }], nextCursor: 1 }, START_MS);
  journal.saveOpening(auctionHash, '77'.repeat(32), 1n, new Uint8Array(32).fill(1), START_MS);
  journal.mark(auctionHash, 'OPENING_READY', 'COMMITTED', START_MS);
  journal.mark(auctionHash, 'COMMITTED', 'REVEALED', START_MS + 11_000);
  const participant = new SealedAuctionParticipant({
    solverId: 'solver-a', journal, clockMs: () => START_MS + 30_000,
    quotes: { quote: async () => assert.fail('an expired award must not request a quote') },
    relay: {
      poll: async () => ({ auctions: [], nextCursor: 1 }),
      commit: async () => assert.fail('unexpected commitment'),
      reveal: async () => assert.fail('unexpected reveal'),
      view: async () => assert.fail('an expired award must not poll the relay'),
      finalizeAward: async () => assert.fail('an expired award must not finalize'),
    },
  });
  try {
    await participant.tick();
    assert.equal(journal.get(auctionHash)?.awardState, 'NOT_AWARDED');
    assert.equal(journal.active().length, 0);
  } finally {
    journal.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('auction relay authenticates private solver actions but not public view and award routes', async () => {
  const definition = sealedAuctionDefinition({
    version: 1, auctionId: 'transport-auction', environment: 'testnet', orderHash: '55'.repeat(32),
    eligibleSolverIds: ['solver-a'], timeUnit: 'EVM_UNIX_SECONDS',
    commitDeadlineValue: START_S + 20n, revealDeadlineValue: START_S + 35n,
    settlementDeadlineValue: START_S + 50n, minimumValidReveals: 1,
  });
  const auctionHash = toHex(sealedAuctionHash(definition));
  const quoteHash = '77'.repeat(32);
  let signatures = 0;
  const relay = new HttpSealedAuctionRelay({
    origin: 'http://127.0.0.1:8787', solverId: 'solver-a', keyId: 'quote-key', clockMs: () => START_MS,
    signer: { signDigest: () => { signatures += 1; return new Uint8Array(64).fill(1); } },
    fetch: async (url, options) => {
      const path = new URL(String(url)).pathname;
      const headers = new Headers(options?.headers);
      const privateRoute = path.startsWith('/v1/solver/');
      assert.equal(headers.has('X-Naryx-Signature'), privateRoute);
      assert.equal(headers.has('X-Naryx-Key'), privateRoute);
      const body = privateRoute ? {} : path.endsWith('/award')
        ? { auctionHash, quoteHash, awardSolverId: 'solver-a' }
        : { definition, phase: 'COMMIT' };
      return new Response(stringifyProtocolJson(body), { headers: { 'Content-Type': 'application/json' } });
    },
  });
  await relay.commit(auctionHash, '66'.repeat(32));
  await relay.view(auctionHash);
  await relay.finalizeAward(auctionHash, quoteHash);
  assert.equal(signatures, 1);
});

test('persists an opening and resumes through award finalization across restarts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'naryx-sealed-auction-'));
  const path = join(directory, 'journal.sqlite');
  let nowMs = START_MS;
  const definition = sealedAuctionDefinition({
    version: 1,
    auctionId: 'auction-1',
    environment: 'testnet',
    orderHash: '55'.repeat(32),
    eligibleSolverIds: ['solver-a'],
    timeUnit: 'EVM_UNIX_SECONDS',
    commitDeadlineValue: START_S + 10n,
    revealDeadlineValue: START_S + 20n,
    settlementDeadlineValue: START_S + 30n,
    minimumValidReveals: 1,
  });
  const auctionHash = toHex(sealedAuctionHash(definition));
  const page: EligibleSealedAuctionPage = {
    auctions: [{ cursor: 1, auctionHash, definition, createdAtMs: START_MS }],
    nextCursor: 1,
  };
  const commitments: string[] = [];
  const reveals: { quoteHash: string; netOutcomeAtoms: bigint; salt: Uint8Array }[] = [];
  const finalized: string[] = [];
  let failFirstCommit = true;
  const relay: SealedAuctionRelayPort = {
    poll: async (after) => after === 0 ? page : { auctions: [], nextCursor: after },
    commit: async (_hash, commitment) => {
      commitments.push(commitment);
      if (failFirstCommit) {
        failFirstCommit = false;
        throw new Error('temporary relay failure');
      }
    },
    reveal: async (_hash, opening) => { reveals.push(opening); },
    view: async () => ({
      phase: 'CLOSED',
      outcome: 'AWARDED',
      winner: { solverId: 'solver-a', quoteHash: '77'.repeat(32) },
    }),
    finalizeAward: async (_hash, quoteHash) => { finalized.push(quoteHash); },
  };
  let quoteCalls = 0;
  const quotes: SealedAuctionQuotePort = {
    quote: async ({ orderHash }) => {
      quoteCalls += 1;
      return {
        quoteHash: '77'.repeat(32),
        orderHash,
        environment: 'testnet',
        solverId: 'solver-a',
        validUntilUnit: 'EVM_UNIX_SECONDS',
        validUntilValue: START_S + 40n,
        netOutcomeAtoms: 500n,
      };
    },
  };
  const build = (journal: SqliteSealedAuctionJournal) => new SealedAuctionParticipant({
    solverId: 'solver-a',
    relay,
    quotes,
    journal,
    clockMs: () => nowMs,
    salt: () => new Uint8Array(32).fill(9),
  });

  try {
    const firstJournal = new SqliteSealedAuctionJournal(path);
    await build(firstJournal).tick();
    assert.equal(firstJournal.get(auctionHash)?.status, 'OPENING_READY');
    firstJournal.close();

    const secondJournal = new SqliteSealedAuctionJournal(path);
    await build(secondJournal).tick();
    assert.equal(secondJournal.get(auctionHash)?.status, 'COMMITTED');
    assert.equal(commitments.length, 2);
    assert.equal(commitments[0], commitments[1]);
    secondJournal.close();

    nowMs += 11_000;
    const thirdJournal = new SqliteSealedAuctionJournal(path);
    await build(thirdJournal).tick();
    assert.equal(thirdJournal.get(auctionHash)?.status, 'REVEALED');
    assert.equal(thirdJournal.get(auctionHash)?.awardState, 'FINALIZED');
    assert.equal(quoteCalls, 2);
    assert.deepEqual(finalized, ['77'.repeat(32)]);
    assert.deepEqual(reveals.map((opening) => [opening.quoteHash, opening.netOutcomeAtoms, [...opening.salt]]), [
      ['77'.repeat(32), 500n, [...new Uint8Array(32).fill(9)]],
    ]);
    thirdJournal.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('records a discovered auction as missed without creating an opening after commit closes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'naryx-sealed-auction-missed-'));
  const journal = new SqliteSealedAuctionJournal(join(directory, 'journal.sqlite'));
  const definition = sealedAuctionDefinition({
    version: 1,
    auctionId: 'auction-missed',
    environment: 'testnet',
    orderHash: '55'.repeat(32),
    eligibleSolverIds: ['solver-a'],
    timeUnit: 'EVM_UNIX_SECONDS',
    commitDeadlineValue: START_S - 1n,
    revealDeadlineValue: START_S + 10n,
    settlementDeadlineValue: START_S + 20n,
    minimumValidReveals: 1,
  });
  const auctionHash = toHex(sealedAuctionHash(definition));
  try {
    const participant = new SealedAuctionParticipant({
      solverId: 'solver-a',
      relay: {
        poll: async (after) => after === 0
          ? { auctions: [{ cursor: 1, auctionHash, definition, createdAtMs: START_MS }], nextCursor: 1 }
          : { auctions: [], nextCursor: after },
        commit: async () => undefined,
        reveal: async () => undefined,
        view: async () => { throw new Error('view must not be requested'); },
        finalizeAward: async () => { throw new Error('award must not be finalized'); },
      },
      quotes: { quote: async () => { throw new Error('quote must not be requested'); } },
      journal,
      clockMs: () => START_MS,
    });
    await participant.tick();
    assert.equal(journal.get(auctionHash)?.status, 'MISSED_COMMIT');
  } finally {
    journal.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
