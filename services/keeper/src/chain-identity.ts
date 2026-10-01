/** The runtime family a chain reference names: EVM for `eip155:*`, SVM for a Solana cluster. */
export type CodeChain = 'EVM' | 'SVM';

/** Genesis hashes are the chain data that prove which Solana cluster an endpoint serves. */
export const SOLANA_DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export const SOLANA_MAINNET_BETA_GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

const SOLANA_CLUSTERS: ReadonlyMap<string, string> = new Map([
  ['solana:devnet', SOLANA_DEVNET_GENESIS_HASH],
  ['solana:mainnet-beta', SOLANA_MAINNET_BETA_GENESIS_HASH],
]);
const EIP155 = /^eip155:([1-9][0-9]{0,18})$/;
const QUANTITY = /^0x(0|[1-9a-fA-F][0-9a-fA-F]*)$/;
const BASE58_HASH = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export type ChainIdentity =
  | { readonly chainRef: string; readonly chain: 'EVM'; readonly chainId: bigint }
  | { readonly chainRef: string; readonly chain: 'SVM'; readonly genesisHash: string };

export type FetchLike = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** The endpoint answered with chain data of another chain than the one it is configured for. */
export class RpcIdentityMismatchError extends Error {
  readonly chainRef: string;

  constructor(chainRef: string, observed: string) {
    super(`RPC endpoint configured for ${chainRef} serves ${observed}`);
    this.name = 'RpcIdentityMismatchError';
    this.chainRef = chainRef;
  }
}

/** Parses `eip155:<decimal chain id>`, `solana:devnet`, or `solana:mainnet-beta`; anything else fails closed. */
export function chainIdentity(chainRef: unknown): ChainIdentity {
  if (typeof chainRef !== 'string') throw new Error('chain reference must be a string');
  const evm = EIP155.exec(chainRef);
  if (evm !== null) return Object.freeze({ chainRef, chain: 'EVM' as const, chainId: BigInt(evm[1] as string) });
  const genesisHash = SOLANA_CLUSTERS.get(chainRef);
  if (genesisHash === undefined) throw new Error(`chain reference ${chainRef} is not eip155:<chain id>, solana:devnet, or solana:mainnet-beta`);
  return Object.freeze({ chainRef, chain: 'SVM' as const, genesisHash });
}

/** An RPC URL is https, or plain http only to a loopback host. The URL itself never appears in an error, since it may carry a provider key. */
export function rpcUrl(value: unknown, context: string): string {
  let parsed: URL;
  try {
    parsed = new URL(String(value));
  } catch {
    throw new Error(`${context} is not a URL`);
  }
  const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]';
  if (typeof value !== 'string' || !(parsed.protocol === 'https:' || (parsed.protocol === 'http:' && loopback))) {
    throw new Error(`${context} must be https, or http to a loopback host`);
  }
  return value;
}

export async function jsonRpc(fetchImpl: FetchLike, url: string, method: string, params: unknown[]): Promise<unknown> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`${method} answered ${response.status}`);
  const body = (await response.json()) as { result?: unknown; error?: { message?: unknown } };
  if (body.error !== undefined) throw new Error(`${method} failed: ${String(body.error?.message ?? 'error')}`);
  return body.result;
}

/**
 * Proves from chain data that `url` serves `identity`: `eth_chainId` on EVM and `getGenesisHash` on
 * Solana. A well-formed answer for another chain throws RpcIdentityMismatchError; a failed or
 * malformed answer throws an ordinary error. Neither is ever treated as a match.
 */
export async function verifyRpcIdentity(fetchImpl: FetchLike, url: string, identity: ChainIdentity): Promise<void> {
  if (identity.chain === 'EVM') {
    const result = await jsonRpc(fetchImpl, url, 'eth_chainId', []);
    if (typeof result !== 'string' || !QUANTITY.test(result)) throw new Error('eth_chainId returned a malformed chain id');
    if (BigInt(result) !== identity.chainId) throw new RpcIdentityMismatchError(identity.chainRef, `eip155:${BigInt(result)}`);
    return;
  }
  const result = await jsonRpc(fetchImpl, url, 'getGenesisHash', []);
  if (typeof result !== 'string' || !BASE58_HASH.test(result)) throw new Error('getGenesisHash returned a malformed hash');
  if (result !== identity.genesisHash) throw new RpcIdentityMismatchError(identity.chainRef, `genesis ${result}`);
}

/**
 * NARYX_KEEPER_RPC_URLS is a JSON object mapping each chain reference the keeper reads to one RPC
 * URL, for example `{"eip155:84532":"https://...","eip155:421614":"https://...","solana:devnet":"https://..."}`.
 * Unset, it is empty. The URL label is never trusted: every read first verifies the chain identity.
 */
export function loadKeeperRpcUrls(environment: NodeJS.ProcessEnv): ReadonlyMap<string, string> {
  const raw = environment.NARYX_KEEPER_RPC_URLS;
  if (raw === undefined || raw === '') return new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // The parser's message quotes the input, which may hold a provider key.
    throw new Error('NARYX_KEEPER_RPC_URLS must be a JSON object of chain reference to RPC URL');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('NARYX_KEEPER_RPC_URLS must be a JSON object of chain reference to RPC URL');
  const urls = new Map<string, string>();
  for (const [chainRef, url] of Object.entries(parsed)) {
    chainIdentity(chainRef);
    urls.set(chainRef, rpcUrl(url, `NARYX_KEEPER_RPC_URLS ${chainRef}`));
  }
  return urls;
}

/**
 * The keeper's SOLANA_SLOT clock: each read proves the endpoint's genesis hash, then reads `getSlot`
 * at `confirmed` commitment. Expiry is `at >= expiry` and observation age grows with `at`, so the
 * later clock is the conservative one: `finalized` trails `confirmed` by about 32 slots and would let
 * an action through up to that many slots after its expiry.
 */
export function solanaSlotReader(chainRef: string, url: string, fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike): () => Promise<bigint> {
  const identity = chainIdentity(chainRef);
  if (identity.chain !== 'SVM') throw new Error('a Solana slot clock needs a Solana chain reference');
  const endpoint = rpcUrl(url, `${chainRef} RPC URL`);
  return async () => {
    await verifyRpcIdentity(fetchImpl, endpoint, identity);
    const slot = await jsonRpc(fetchImpl, endpoint, 'getSlot', [{ commitment: 'confirmed' }]);
    if (typeof slot !== 'number' || !Number.isSafeInteger(slot) || slot < 0) throw new Error('getSlot returned a malformed slot');
    return BigInt(slot);
  };
}
