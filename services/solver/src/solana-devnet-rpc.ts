import { SOLANA_DEVNET_GENESIS_HASH } from '@naryx/adapter-solana';
import bs58 from 'bs58';
import {
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type Keypair,
  type TransactionInstruction,
} from '@solana/web3.js';

export type SolanaDevnetAccount = Readonly<{ owner: string; data: Uint8Array }>;

export interface SolanaObservedInstruction {
  readonly programId: string;
  readonly accounts: readonly string[];
  readonly data: Uint8Array;
}

export type SolanaTransactionObservation = Readonly<
  | { status: 'PENDING' | 'FAILED' }
  | {
      status: 'FINALIZED';
      slot: bigint;
      instructions: readonly SolanaObservedInstruction[];
      logMessages: readonly string[];
    }
>;

/** Signerless Devnet reads. Network identity always comes from getGenesisHash, never the URL. */
export interface SolanaDevnetSolverReadPort {
  getGenesisHash(): Promise<string>;
  getFinalizedSlot(): Promise<bigint>;
  getBlockTime(slot: bigint): Promise<bigint>;
  getAccounts(addresses: readonly string[], minContextSlot: bigint): Promise<readonly (SolanaDevnetAccount | null)[]>;
}

export interface SolanaDevnetObservationReadPort extends SolanaDevnetSolverReadPort {
  getTransactionObservation(signature: string): Promise<SolanaTransactionObservation>;
}

/** The only write path: sign with the external solver key and wait for finalization. */
export interface SolanaDevnetSolverWritePort {
  sendAndFinalize(instructions: readonly TransactionInstruction[], signer: Keypair): Promise<string>;
}

function fail(message: string): never {
  throw new Error(`Solana Devnet RPC: ${message}`);
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${context} is malformed`);
  return value as Record<string, unknown>;
}

function address(value: unknown, context: string): string {
  if (typeof value !== 'string') fail(`${context} is malformed`);
  try {
    const checked = new PublicKey(value);
    if (checked.toBase58() !== value) fail(`${context} is not canonical`);
    return value;
  } catch {
    return fail(`${context} is invalid`);
  }
}

function addressList(value: unknown, context: string): readonly string[] {
  if (!Array.isArray(value)) fail(`${context} is malformed`);
  return Object.freeze(value.map((item, index) => address(item, `${context}[${index}]`)));
}

export async function requireSolanaDevnet(port: Pick<SolanaDevnetSolverReadPort, 'getGenesisHash'>): Promise<void> {
  if (await port.getGenesisHash() !== SOLANA_DEVNET_GENESIS_HASH) fail('genesis hash is not Solana Devnet');
}

export class HttpSolanaDevnetSolverRpc implements SolanaDevnetObservationReadPort, SolanaDevnetSolverWritePort {
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

  async getTransactionObservation(signature: string): Promise<SolanaTransactionObservation> {
    const statusResult = record(await this.#call('getSignatureStatuses', [
      [signature], { searchTransactionHistory: true },
    ]), 'signature status');
    if (!Array.isArray(statusResult.value) || statusResult.value.length !== 1) fail('signature status is malformed');
    const statusValue = statusResult.value[0];
    if (statusValue === null) return Object.freeze({ status: 'PENDING' });
    const status = record(statusValue, 'signature status value');
    if (!('err' in status)) fail('signature status has no result');
    if (status.err !== null && status.err !== undefined) return Object.freeze({ status: 'FAILED' });
    if (status.confirmationStatus !== 'finalized') return Object.freeze({ status: 'PENDING' });
    if (typeof status.slot !== 'number' || !Number.isSafeInteger(status.slot) || status.slot <= 0) {
      fail('finalized signature slot is invalid');
    }
    const transactionValue = await this.#call('getTransaction', [signature, {
      commitment: 'finalized',
      encoding: 'json',
      maxSupportedTransactionVersion: 0,
    }]);
    if (transactionValue === null) return Object.freeze({ status: 'PENDING' });
    const result = record(transactionValue, 'finalized transaction');
    if (result.slot !== status.slot) fail('transaction and signature status slots differ');
    const meta = record(result.meta, 'transaction metadata');
    if (!('err' in meta)) fail('transaction metadata has no result');
    if (meta.err !== null) return Object.freeze({ status: 'FAILED' });
    if (!Array.isArray(meta.logMessages) || meta.logMessages.length > 2_048
      || meta.logMessages.some((message) => typeof message !== 'string' || message.length > 4_096)) {
      fail('transaction log messages are malformed');
    }
    const logMessages = Object.freeze([...meta.logMessages] as string[]);
    const transaction = record(result.transaction, 'transaction');
    const message = record(transaction.message, 'transaction message');
    const staticKeys = addressList(message.accountKeys, 'transaction account keys');
    const loaded = meta.loadedAddresses === undefined
      ? { writable: Object.freeze([]) as readonly string[], readonly: Object.freeze([]) as readonly string[] }
      : record(meta.loadedAddresses, 'loaded addresses');
    const writable = 'writable' in loaded
      ? addressList(loaded.writable, 'loaded writable addresses')
      : Object.freeze([]);
    const readonly = 'readonly' in loaded
      ? addressList(loaded.readonly, 'loaded readonly addresses')
      : Object.freeze([]);
    const keys = [...staticKeys, ...writable, ...readonly];
    if (!Array.isArray(message.instructions)) fail('transaction instructions are malformed');
    const instructions = message.instructions.map((value, instructionIndex) => {
      const instruction = record(value, `transaction instruction ${instructionIndex}`);
      if (!Number.isSafeInteger(instruction.programIdIndex)
        || Number(instruction.programIdIndex) < 0
        || Number(instruction.programIdIndex) >= keys.length
        || !Array.isArray(instruction.accounts)
        || instruction.accounts.some((index) => !Number.isSafeInteger(index)
          || Number(index) < 0 || Number(index) >= keys.length)
        || typeof instruction.data !== 'string') {
        fail(`transaction instruction ${instructionIndex} is malformed`);
      }
      let data: Uint8Array;
      try {
        data = Uint8Array.from(bs58.decode(instruction.data));
        if (bs58.encode(data) !== instruction.data) fail(`transaction instruction ${instructionIndex} data is not canonical`);
      } catch {
        return fail(`transaction instruction ${instructionIndex} data is invalid`);
      }
      return Object.freeze({
        programId: keys[Number(instruction.programIdIndex)]!,
        accounts: Object.freeze(instruction.accounts.map((index) => keys[Number(index)]!)),
        data,
      });
    });
    return Object.freeze({
      status: 'FINALIZED',
      slot: BigInt(status.slot),
      instructions: Object.freeze(instructions),
      logMessages,
    });
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
