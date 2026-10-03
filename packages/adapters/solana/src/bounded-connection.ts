import { Connection, type Commitment, type FetchFn } from '@solana/web3.js';

/** The longest one Solana RPC request may take, so a stalled endpoint fails the request instead of holding it. */
export const SOLANA_RPC_REQUEST_TIMEOUT_MS = 20_000;

/** A web3.js connection whose every HTTP request is bounded by `timeoutMs`. */
export function createBoundedSolanaConnection(
  rpcUrl: string,
  commitment: Commitment,
  timeoutMs: number = SOLANA_RPC_REQUEST_TIMEOUT_MS,
): Connection {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Solana RPC timeout must be a positive integer');
  const bounded = ((input: Parameters<FetchFn>[0], init?: Parameters<FetchFn>[1]) => globalThis.fetch(
    input as Parameters<typeof globalThis.fetch>[0],
    { ...(init as RequestInit | undefined), signal: AbortSignal.timeout(timeoutMs) },
  )) as unknown as FetchFn;
  return new Connection(rpcUrl, { commitment, fetch: bounded });
}
