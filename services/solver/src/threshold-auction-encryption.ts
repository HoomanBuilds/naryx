import { roundAt, roundTime, timelockEncrypt, type ChainClient } from 'tlock-js';
import { MAINNET_CHAIN_INFO } from 'tlock-js/drand/defaults.js';
import { sealedAuctionHash, stringifyProtocolJson, toHex, type SealedAuctionDefinition } from '@naryx/protocol-types';

const info = Object.freeze({ ...MAINNET_CHAIN_INFO });
if (info.hash !== '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971'
  || info.public_key !== '83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a'
  || info.period !== 3 || info.genesis_time !== 1692803367 || info.schemeID !== 'bls-unchained-g1-rfc9380') {
  throw new Error('Threshold encryption library does not use the reviewed quicknet identity');
}

const publicParameters: ChainClient = {
  options: { disableBeaconVerification: false, noCache: true,
    chainVerificationParams: { chainHash: info.hash, publicKey: info.public_key } },
  chain: () => ({ baseUrl: `https://api.drand.sh/${info.hash}`, info: async () => info }),
  get: async () => { throw new Error('Encryption cannot request decryption beacons'); },
  latest: async () => { throw new Error('Encryption cannot request decryption beacons'); },
};

export function thresholdReleaseWindow(definition: SealedAuctionDefinition) {
  if (!['testnet', 'devnet', 'local'].includes(definition.environment.toLowerCase())
    || !['EVM_UNIX_SECONDS', 'HYPERLIQUID_UNIX_MILLISECONDS'].includes(definition.timeUnit)) return undefined;
  const factor = definition.timeUnit === 'EVM_UNIX_SECONDS' ? 1000n : 1n;
  const commitMs = definition.commitDeadlineValue * factor;
  const revealMs = definition.revealDeadlineValue * factor;
  if (commitMs < BigInt(info.genesis_time) * 1000n || revealMs > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  const round = roundAt(Number(commitMs), info) + 1;
  const releaseAtMs = roundTime(info, round);
  if (releaseAtMs + 60_000 >= Number(revealMs)) return undefined;
  return { round, releaseAtMs, commitAtMs: Number(commitMs) };
}

export async function encryptSolverAuctionOpening(definition: SealedAuctionDefinition, solverId: string,
  opening: Readonly<{ quoteHash: string; netOutcomeAtoms: bigint; salt: Uint8Array }>, nowMs = Date.now()) {
  const window = thresholdReleaseWindow(definition);
  if (!window || window.commitAtMs <= nowMs || window.commitAtMs - nowMs > 600_000
    || !definition.eligibleSolverIds.some(id => id === solverId)) throw new Error('Threshold opening window or solver is invalid');
  const plaintext = stringifyProtocolJson({ auctionHash: toHex(sealedAuctionHash(definition)), solverId, ...opening });
  if (Buffer.byteLength(plaintext) > 8192) throw new Error('Threshold opening exceeds its bound');
  return timelockEncrypt(window.round, Buffer.from(plaintext), publicParameters);
}
