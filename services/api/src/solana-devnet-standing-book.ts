import type { IncomingMessage, ServerResponse } from 'node:http';

const PATH = '/internal/terminal/solana-devnet/standing-book';
const NATURAL = /^(0|[1-9][0-9]*)$/;
const SIGNED = /^-?(0|[1-9][0-9]*)$/;

export type SolanaStandingLevel = Readonly<{
  levelId: string;
  referenceOffsetAtoms: string;
  remainingCapacityUnits: string;
  minPackageSizeUnits: string;
  maxPackageSizeUnits: string;
  expirySlot: string;
}>;

export type SolanaStandingBook = Readonly<{
  version: 1;
  domainId: 'svm:devnet';
  shard: string;
  seriesManifestHash: string;
  finalizedSlot: string;
  referencePackagePriceAtoms: string;
  bid: SolanaStandingLevel | null;
  ask: SolanaStandingLevel | null;
}>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function level(value: unknown, slot: bigint): value is SolanaStandingLevel | null {
  if (value === null) return true;
  if (!record(value) || Object.keys(value).sort().join(',') !==
    'expirySlot,levelId,maxPackageSizeUnits,minPackageSizeUnits,referenceOffsetAtoms,remainingCapacityUnits') return false;
  if (![value.levelId, value.remainingCapacityUnits, value.minPackageSizeUnits, value.maxPackageSizeUnits, value.expirySlot]
    .every((item) => typeof item === 'string' && NATURAL.test(item))
    || typeof value.referenceOffsetAtoms !== 'string' || !SIGNED.test(value.referenceOffsetAtoms)) return false;
  return BigInt(value.expirySlot as string) > slot
    && BigInt(value.minPackageSizeUnits as string) > 0n
    && BigInt(value.maxPackageSizeUnits as string) >= BigInt(value.minPackageSizeUnits as string)
    && BigInt(value.remainingCapacityUnits as string) >= BigInt(value.minPackageSizeUnits as string);
}

export function parseSolanaStandingBook(value: unknown): SolanaStandingBook {
  if (!record(value) || Object.keys(value).sort().join(',') !==
    'ask,bid,domainId,finalizedSlot,referencePackagePriceAtoms,seriesManifestHash,shard,version'
    || value.version !== 1 || value.domainId !== 'svm:devnet'
    || typeof value.shard !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value.shard)
    || typeof value.seriesManifestHash !== 'string' || !/^[0-9a-f]{64}$/.test(value.seriesManifestHash)
    || typeof value.finalizedSlot !== 'string' || !NATURAL.test(value.finalizedSlot)
    || typeof value.referencePackagePriceAtoms !== 'string' || !SIGNED.test(value.referencePackagePriceAtoms)
    || !level(value.bid, BigInt(value.finalizedSlot)) || !level(value.ask, BigInt(value.finalizedSlot))) {
    throw new Error('Solana Devnet standing book response is malformed.');
  }
  return value as SolanaStandingBook;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(body));
}

export function createSolanaDevnetStandingBookRoutes(origin: string): (request: IncomingMessage, response: ServerResponse) => boolean {
  const upstream = new URL('/internal/solana-devnet/standing-book', origin);
  if (upstream.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(upstream.hostname)) {
    throw new Error('Solana Devnet standing book source must be a loopback HTTP origin.');
  }
  return (request, response) => {
    const url = new URL(request.url ?? '/', 'http://private-terminal.local');
    if (url.pathname !== PATH) return false;
    if (url.search !== '') {
      send(response, 400, { error: { code: 'INVALID_QUERY', message: 'Standing book takes no query parameters.' } });
      return true;
    }
    if (request.method !== 'GET') {
      response.setHeader('Allow', 'GET, OPTIONS');
      send(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Only GET is allowed.' } });
      return true;
    }
    void fetch(upstream, { signal: AbortSignal.timeout(8_000) })
      .then(async (result) => {
        if (!result.ok) throw new Error('Standing book source is unavailable.');
        return parseSolanaStandingBook(await result.json());
      })
      .then((book) => send(response, 200, book))
      .catch(() => send(response, 503, { error: { code: 'STANDING_BOOK_UNAVAILABLE', message: 'Finalized Solana Devnet book is unavailable.' } }));
    return true;
  };
}
