import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { sealedAuctionDefinition, sealedQuoteCommitment, toHex } from '../../../packages/protocol-types/dist/index.js';
import { SqlitePrivateDeliveryStore } from '../../../services/api/dist/private-delivery-store.js';
import { ThresholdAuctionBackend } from '../../../services/api/dist/threshold-auction.js';
import { encryptSolverAuctionOpening } from '../../../services/solver/dist/threshold-auction-encryption.js';

const { values } = parseArgs({ options: { output: { type: 'string' } } });
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const output = values.output;
if (!output || !isAbsolute(output) || resolve(output) !== output || existsSync(output)
  || output.startsWith(root + sep) || realpathSync(dirname(output)) !== dirname(output)) {
  throw new Error('--output must be a new canonical directory outside the checkout');
}
mkdirSync(output, { mode: 0o700 });
const store = new SqlitePrivateDeliveryStore(resolve(output, 'isolated-release-check.sqlite'));
const backend = new ThresholdAuctionBackend(store);
try {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const definition = sealedAuctionDefinition({ version: 1, auctionId: `threshold-release-check-${now}`,
    environment: 'testnet', orderHash: createHash('sha256').update(`isolated-no-trade-${now}`).digest('hex'),
    eligibleSolverIds: ['release-check-solver'], timeUnit: 'EVM_UNIX_SECONDS',
    commitDeadlineValue: now + 15n, revealDeadlineValue: now + 95n,
    settlementDeadlineValue: now + 130n, minimumValidReveals: 1 });
  const { auctionHashHex } = store.createAuction(definition);
  const opening = { solverId: 'release-check-solver', quoteHash: createHash('sha256').update('no-execution-quote').digest('hex'),
    netOutcomeAtoms: 0n, salt: randomBytes(32) };
  const ciphertext = await encryptSolverAuctionOpening(definition, opening.solverId, opening);
  const commitment = toHex(sealedQuoteCommitment(auctionHashHex, opening));
  const accepted = await backend.seal(auctionHashHex, opening.solverId, { commitment, ciphertext });
  const before = store.thresholdOpeningStatus(auctionHashHex, opening.solverId);
  if (before?.state !== 'SEALED' || Date.now() >= accepted.releaseAtMs) throw new Error('Check missed its pre-release boundary');
  console.log(JSON.stringify({ scope: 'isolated-live-beacon-check-no-trades', auctionHash: auctionHashHex,
    round: accepted.round, state: before.state, releaseAtMs: accepted.releaseAtMs }));
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline && store.thresholdOpeningStatus(auctionHashHex, opening.solverId)?.state !== 'REVEALED') {
    await new Promise(done => setTimeout(done, 1000));
    await backend.advance();
  }
  const after = store.thresholdOpeningStatus(auctionHashHex, opening.solverId);
  if (after?.state !== 'REVEALED') throw new Error('Verified live beacon did not release the opening within the check window');
  const evidence = { scope: 'isolated-live-beacon-check-no-trades', auctionHash: auctionHashHex,
    round: accepted.round, releaseAtMs: accepted.releaseAtMs, observedAtMs: Date.now(),
    before: before.state, after: after.state, ciphertextHash: accepted.ciphertextHash,
    publicMarketDatabaseModified: false, venueTransactions: 0 };
  writeFileSync(resolve(output, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(evidence));
} finally { backend.close(); store.close(); }
