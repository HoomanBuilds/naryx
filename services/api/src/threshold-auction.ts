import { createHash } from 'node:crypto';
import { mainnetClient, roundAt, roundTime, timelockDecrypt, type ChainClient, type ChainInfo } from 'tlock-js';
import { decodeArmor } from 'tlock-js/age/armor.js';
import { readAge } from 'tlock-js/age/age-reader-writer.js';
import { verifyBeacon } from 'drand-client/beacon-verification.js';
import { parseProtocolJson, type SealedAuctionDefinition } from '@naryx/protocol-types';
import type { SqlitePrivateDeliveryStore } from './private-delivery-store.js';

const CHAIN_HASH = '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971';
const PUBLIC_KEY = '83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a';

export function verifiedQuicknetInfo(value: unknown): ChainInfo {
  const info = value as ChainInfo | null;
  if (!info || info.hash !== CHAIN_HASH || info.public_key !== PUBLIC_KEY || info.period !== 3
    || info.genesis_time !== 1692803367 || info.schemeID !== 'bls-unchained-g1-rfc9380') {
    throw new Error('Threshold beacon identity mismatch');
  }
  return Object.freeze({ ...info });
}

export function thresholdAuctionWindow(definition: SealedAuctionDefinition, info: ChainInfo) {
  verifiedQuicknetInfo(info);
  if (!['testnet', 'devnet', 'local'].includes(definition.environment.toLowerCase())
    || !['EVM_UNIX_SECONDS', 'HYPERLIQUID_UNIX_MILLISECONDS'].includes(definition.timeUnit)
    || info.hash !== CHAIN_HASH || info.public_key !== PUBLIC_KEY || info.period !== 3
    || info.genesis_time !== 1692803367 || info.schemeID !== 'bls-unchained-g1-rfc9380') {
    throw new Error('Threshold auctions require a test environment and the pinned quicknet network');
  }
  const factor = definition.timeUnit === 'EVM_UNIX_SECONDS' ? 1_000n : 1n;
  const commitMs = definition.commitDeadlineValue * factor;
  const revealMs = definition.revealDeadlineValue * factor;
  if (revealMs > BigInt(Number.MAX_SAFE_INTEGER) || commitMs <= 0n) throw new Error('Invalid threshold auction deadline');
  const round = roundAt(Number(commitMs), info) + 1;
  const releaseAtMs = roundTime(info, round);
  if (releaseAtMs + 60_000 >= Number(revealMs)) throw new Error('Threshold auction needs at least sixty seconds for verified release');
  return { round, releaseAtMs, commitAtMs: Number(commitMs), revealAtMs: Number(revealMs), chainHash: CHAIN_HASH,
    publicKey: PUBLIC_KEY, periodSeconds: 3, genesisTimeSeconds: info.genesis_time };
}

export function verifyThresholdCiphertext(ciphertext: unknown, round: number): string {
  if (typeof ciphertext !== 'string' || Buffer.byteLength(ciphertext) > 32_768 || ciphertext.length < 100
    || !ciphertext.startsWith('-----BEGIN AGE ENCRYPTED FILE-----')) throw new Error('Invalid bounded threshold ciphertext');
  const age = readAge(decodeArmor(ciphertext));
  const recipient = age.header.recipients[0];
  if (age.header.version !== 'age-encryption.org/v1' || age.header.recipients.length !== 1
    || recipient?.type !== 'tlock' || recipient.args.length !== 2
    || recipient.args[0] !== String(round) || recipient.args[1] !== CHAIN_HASH) {
    throw new Error('Ciphertext does not bind the auction release round and network');
  }
  return createHash('sha256').update(ciphertext).digest('hex');
}

async function boundedBeaconJson(url: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(8_000), redirect: 'error' });
  if (!response.ok || !response.body) throw new Error('Threshold beacon unavailable');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > 8_192) throw new Error('Threshold beacon response too large'); chunks.push(value); }
  } finally { await reader.cancel(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export class ThresholdAuctionBackend {
  readonly #store: SqlitePrivateDeliveryStore;
  readonly #client: ChainClient;
  readonly #clock: () => number;
  #running = false;
  readonly #timer: ReturnType<typeof setInterval>;

  constructor(store: SqlitePrivateDeliveryStore, clock = Date.now) {
    this.#store = store; this.#clock = clock;
    const upstream = mainnetClient();
    const baseUrl = `https://api.drand.sh/${CHAIN_HASH}`;
    let info: Promise<ChainInfo> | undefined;
    const beacons = new Map<number, Promise<Awaited<ReturnType<ChainClient['get']>>>>();
    this.#client = { options: upstream.options,
      chain: () => ({ baseUrl, info: () => {
        info ??= boundedBeaconJson(`${baseUrl}/info`).then(verifiedQuicknetInfo).catch(error => { info = undefined; throw error; });
        return info;
      } }),
      get: (round) => {
        if (!beacons.has(round)) {
          if (beacons.size >= 32) beacons.delete(beacons.keys().next().value!);
          beacons.set(round, boundedBeaconJson(`${baseUrl}/public/${round}`).then(async beacon => {
            if (!await verifyBeacon(await this.#client.chain().info(), beacon, round)) throw new Error('Invalid threshold beacon');
            return beacon;
          }).catch(error => { beacons.delete(round); throw error; }));
        }
        return beacons.get(round)!;
      },
      latest: () => boundedBeaconJson(`${baseUrl}/public/latest`) };
    this.#timer = setInterval(() => { void this.advance().catch(() => undefined); }, 2_000);
    this.#timer.unref();
  }

  close() { clearInterval(this.#timer); }

  async policy(auctionHash: string) {
    const definition = this.#store.auctionDefinition(auctionHash);
    return { mode: 'TIMED_THRESHOLD_REVEAL', auctionHash,
      ...thresholdAuctionWindow(definition, await this.#client.chain().info()),
      disclosure: 'Opening becomes decryptable to everyone after release. Threshold collusion can reveal it early. No plaintext fallback.' };
  }

  async seal(auctionHash: string, solverId: string, body: Record<string, unknown>) {
    if (Object.keys(body).sort().join(',') !== 'ciphertext,commitment') throw new Error('Invalid threshold commitment');
    const policy = await this.policy(auctionHash);
    if (this.#clock() >= policy.commitAtMs || policy.commitAtMs - this.#clock() > 600_000) throw new Error('Threshold commit window unavailable');
    const ciphertextHash = verifyThresholdCiphertext(body.ciphertext, policy.round);
    this.#store.storeThresholdCommitment({ auctionHash, solverId, commitment: body.commitment as string,
      ciphertext: body.ciphertext as string, ciphertextHash, round: policy.round,
      releaseAtMs: policy.releaseAtMs, revealAtMs: policy.revealAtMs, nowMs: this.#clock() });
    return { accepted: true, ciphertextHash, round: policy.round, releaseAtMs: policy.releaseAtMs, mode: policy.mode };
  }

  async advance() {
    if (this.#running) return;
    this.#running = true;
    try {
      const rows = this.#store.pendingThresholdOpenings(this.#clock(), 4);
      await Promise.all(rows.map(async row => {
        this.#store.markThresholdAttempt(row.auctionHash, row.solverId, this.#clock());
        if (this.#clock() >= row.revealAtMs) { this.#store.expireThresholdOpening(row.auctionHash, row.solverId); return; }
        try {
          const policy = await this.policy(row.auctionHash);
          if (policy.round !== row.round) throw new Error('Threshold policy changed');
          verifyThresholdCiphertext(row.ciphertext, policy.round);
          const plaintext = await timelockDecrypt(row.ciphertext, this.#client);
          if (plaintext.byteLength > 8_192) throw new Error('Threshold opening exceeds its bound');
          const opening = parseProtocolJson(plaintext.toString('utf8')) as Record<string, unknown>;
          if (!opening || Object.keys(opening).sort().join(',') !== 'auctionHash,netOutcomeAtoms,quoteHash,salt,solverId'
            || opening.auctionHash !== row.auctionHash || opening.solverId !== row.solverId) throw new Error('Threshold opening identity mismatch');
          this.#store.revealThresholdOpening(row.auctionHash, row.solverId, opening, this.#clock());
        } catch { /* Keep the commitment sealed until a valid release or its signed deadline. */ }
      }));
    } finally { this.#running = false; }
  }
}
