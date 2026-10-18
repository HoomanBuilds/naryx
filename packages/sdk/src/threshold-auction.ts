import { sealedAuctionDefinition, sealedAuctionHash, sealedQuoteCommitment, stringifyProtocolJson, toHex,
  type SealedAuctionDefinitionInput } from '@naryx/protocol-types';

export async function encryptThresholdAuctionOpening(definitionInput: SealedAuctionDefinitionInput,
  solverId: string, opening: Readonly<{ quoteHash: string; netOutcomeAtoms: bigint; salt: Uint8Array }>) {
  const definition = sealedAuctionDefinition(definitionInput);
  if (!['testnet', 'devnet', 'local'].includes(definition.environment.toLowerCase())
    || !['EVM_UNIX_SECONDS', 'HYPERLIQUID_UNIX_MILLISECONDS'].includes(definition.timeUnit)
    || !definition.eligibleSolverIds.some(id => id === solverId)) throw new Error('Threshold auction requires an eligible testnet solver');
  const { mainnetClient, roundAt, roundTime, timelockEncrypt, Buffer } = await import('tlock-js');
  const client = mainnetClient();
  const info = await client.chain().info();
  if (info.hash !== '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971'
    || info.period !== 3 || info.genesis_time !== 1692803367 || info.schemeID !== 'bls-unchained-g1-rfc9380') {
    throw new Error('Unsupported threshold beacon network');
  }
  const factor = definition.timeUnit === 'EVM_UNIX_SECONDS' ? 1_000n : 1n;
  const commitAtMs = definition.commitDeadlineValue * factor;
  const revealAtMs = definition.revealDeadlineValue * factor;
  if (revealAtMs > BigInt(Number.MAX_SAFE_INTEGER) || commitAtMs <= BigInt(Date.now())
    || commitAtMs - BigInt(Date.now()) > 600_000n) throw new Error('Invalid threshold auction timing');
  const round = roundAt(Number(commitAtMs), info) + 1;
  if (roundTime(info, round) + 60_000 >= Number(revealAtMs)) throw new Error('Insufficient threshold release window');
  const auctionHash = sealedAuctionHash(definition);
  const commitment = toHex(sealedQuoteCommitment(auctionHash, { solverId, ...opening }));
  const payload = stringifyProtocolJson({ auctionHash: toHex(auctionHash), solverId, ...opening });
  if (Buffer.byteLength(payload) > 8_192) throw new Error('Threshold opening exceeds its bound');
  const ciphertext = await timelockEncrypt(round, Buffer.from(payload), client);
  if (Date.now() >= Number(commitAtMs)) throw new Error('Commit window expired while encrypting');
  return { commitment, ciphertext, round, releaseAtMs: roundTime(info, round) };
}
