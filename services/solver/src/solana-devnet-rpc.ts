import { SOLANA_DEVNET_GENESIS_HASH } from '@naryx/adapter-solana';
import {
  TransactionMessage,
  VersionedTransaction,
  type Keypair,
  type TransactionInstruction,
} from '@solana/web3.js';

export type SolanaDevnetAccount = Readonly<{ owner: string; data: Uint8Array }>;

/** Signerless Devnet reads. Network identity always comes from getGenesisHash, never the URL. */
export interface SolanaDevnetSolverReadPort {
  getGenesisHash(): Promise<string>;
  getFinalizedSlot(): Promise<bigint>;
  getBlockTime(slot: bigint): Promise<bigint>;
  getAccounts(addresses: readonly string[], minContextSlot: bigint): Promise<readonly (SolanaDevnetAccount | null)[]>;
}

/** The only write path: sign with the external solver key and wait for finalization. */
export interface SolanaDevnetSolverWritePort {
  sendAndFinalize(instructions: readonly TransactionInstruction[], signer: Keypair): Promise<string>;
}

function fail(message: string): never {
  throw new Error(`Solana Devnet RPC: ${message}`);
}

export async function requireSolanaDevnet(port: Pick<SolanaDevnetSolverReadPort, 'getGenesisHash'>): Promise<void> {
  if (await port.getGenesisHash() !== SOLANA_DEVNET_GENESIS_HASH) fail('genesis hash is not Solana Devnet');
}

export class HttpSolanaDevnetSolverRpc implements SolanaDevnetSolverReadPort, SolanaDevnetSolverWritePort {
  readonly #url: string;
  readonly #writesEnabled: boolean;

  constructor(rpcUrl: string, options: Readonly<{ writesEnabled: boolean }>) {
    const url = new URL(rpcUrl);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost'))) {
      fail('RPC URL must be HTTPS');
    }
    this.#url = url.toString();
    this.#writesEnabled = options.writesEnabled;
  }

  async #call(method: string, params: readonly unknown[]): Promise<unknown> {
    const response = await fetch(this.#url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) fail(`${method} returned HTTP ${response.status}`);
    const envelope = await response.json() as { result?: unknown; error?: { message?: unknown } };
    if (envelope.error !== undefined || !('result' in envelope)) {
      fail(`${method} failed${typeof envelope.error?.message === 'string' ? `: ${envelope.error.message.slice(0, 200)}` : ''}`);
    }
    return envelope.result;
  }

  async getGenesisHash(): Promise<string> {
    return String(await this.#call('getGenesisHash', []));
  }

  async getFinalizedSlot(): Promise<bigint> {
    const slot = await this.#call('getSlot', [{ commitment: 'finalized' }]);
    if (typeof slot !== 'number' || !Number.isSafeInteger(slot) || slot <= 0) fail('finalized slot is invalid');
    return BigInt(slot);
  }

  async getBlockTime(slot: bigint): Promise<bigint> {
    const time = await this.#call('getBlockTime', [Number(slot)]);
    if (typeof time !== 'number' || !Number.isSafeInteger(time) || time <= 0) fail('block time is unavailable');
    return BigInt(time);
  }

  async getAccounts(addresses: readonly string[], minContextSlot: bigint): Promise<readonly (SolanaDevnetAccount | null)[]> {
    const output: (SolanaDevnetAccount | null)[] = [];
    for (let start = 0; start < addresses.length; start += 100) {
      const chunk = addresses.slice(start, start + 100);
      const result = await this.#call('getMultipleAccounts', [
        chunk, { encoding: 'base64', commitment: 'finalized', minContextSlot: Number(minContextSlot) },
      ]) as { value?: unknown };
      if (!Array.isArray(result?.value) || result.value.length !== chunk.length) fail('account read is malformed');
      for (const entry of result.value as unknown[]) {
        if (entry === null) { output.push(null); continue; }
        const account = entry as { owner?: unknown; data?: unknown };
        if (typeof account.owner !== 'string' || !Array.isArray(account.data) || typeof account.data[0] !== 'string') {
          fail('account encoding is invalid');
        }
        output.push(Object.freeze({ owner: account.owner, data: Uint8Array.from(Buffer.from(account.data[0], 'base64')) }));
      }
    }
    return output;
  }

  async sendAndFinalize(instructions: readonly TransactionInstruction[], signer: Keypair): Promise<string> {
    if (!this.#writesEnabled) fail('solver writes are disabled');
    // Network identity is verified from chain data immediately before every write.
    await requireSolanaDevnet(this);
    const latest = await this.#call('getLatestBlockhash', [{ commitment: 'finalized' }]) as {
      value?: { blockhash?: unknown; lastValidBlockHeight?: unknown };
    };
    const blockhash = latest?.value?.blockhash;
    const lastValid = latest?.value?.lastValidBlockHeight;
    if (typeof blockhash !== 'string' || typeof lastValid !== 'number') fail('latest blockhash is invalid');
    const message = new TransactionMessage({
      payerKey: signer.publicKey,
      recentBlockhash: blockhash,
      instructions: [...instructions],
    }).compileToV0Message();
    const transaction = new VersionedTransaction(message);
    transaction.sign([signer]);
    const signature = await this.#call('sendTransaction', [
      Buffer.from(transaction.serialize()).toString('base64'),
      { encoding: 'base64', preflightCommitment: 'confirmed' },
    ]);
    if (typeof signature !== 'string') fail('sendTransaction returned no signature');
    for (;;) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
      const statuses = await this.#call('getSignatureStatuses', [[signature], { searchTransactionHistory: false }]) as {
        value?: readonly ({ err?: unknown; confirmationStatus?: unknown } | null)[];
      };
      const status = statuses?.value?.[0];
      if (status !== null && status !== undefined) {
        if (status.err !== null && status.err !== undefined) fail(`transaction ${signature} failed`);
        if (status.confirmationStatus === 'finalized') return signature;
      }
      const height = await this.#call('getBlockHeight', [{ commitment: 'confirmed' }]);
      if (typeof height === 'number' && height > lastValid) fail(`transaction ${signature} expired before finalization`);
    }
  }
}
