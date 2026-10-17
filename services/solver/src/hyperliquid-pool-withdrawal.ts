import { HttpTransport, TESTNET_API_URL } from '@nktkas/hyperliquid';
import { usdSend } from '@nktkas/hyperliquid/api/exchange';
import { getWalletAddress, type AbstractWallet } from '@nktkas/hyperliquid/signing';
import { stringifyProtocolJson } from '@naryx/protocol-types';
import { HyperliquidPooledCollateralStore } from './hyperliquid-pooled-collateral-store.js';
import type { HyperliquidPoolFundingReadPort } from './hyperliquid-pool-funding.js';

export interface HyperliquidPoolWithdrawalAction {
  readonly environment: 'TESTNET';
  readonly source: `0x${string}`;
  readonly destination: `0x${string}`;
  readonly debitQuoteAtoms: bigint;
  readonly nonce: number;
}

export interface HyperliquidPoolWithdrawalTransport {
  send(action: HyperliquidPoolWithdrawalAction): Promise<void>;
}

export function hyperliquidTestnetPoolWithdrawalTransport(wallet: AbstractWallet): HyperliquidPoolWithdrawalTransport {
  const transport = new HttpTransport({ isTestnet: true, apiUrl: TESTNET_API_URL, timeout: 10_000 });
  return { async send(action) {
    if (action.environment !== 'TESTNET' || (await getWalletAddress(wallet)).toLowerCase() !== action.source
      || !/^0x(?!0{40}$)[0-9a-f]{40}$/.test(action.destination) || action.source === action.destination
      || typeof action.debitQuoteAtoms !== 'bigint' || action.debitQuoteAtoms <= 0n || action.debitQuoteAtoms >= (1n << 128n)
      || !Number.isSafeInteger(action.nonce) || Math.abs(Date.now() - action.nonce) > 5_000) {
      throw new Error('Invalid testnet pool withdrawal signing boundary');
    }
    const atoms = action.debitQuoteAtoms.toString().padStart(7, '0');
    const amount = `${atoms.slice(0, -6)}.${atoms.slice(-6)}`;
    await usdSend({ transport, wallet, signatureChainId: '0x66eee', nonceManager: () => action.nonce },
      { destination: action.destination, amount });
  } };
}

export class HyperliquidPoolWithdrawalService {
  readonly #store: HyperliquidPooledCollateralStore;
  readonly #reads: HyperliquidPoolFundingReadPort;
  readonly #transport: HyperliquidPoolWithdrawalTransport;
  readonly #clock: () => number;

  constructor(store: HyperliquidPooledCollateralStore, reads: HyperliquidPoolFundingReadPort,
    transport: HyperliquidPoolWithdrawalTransport, clock = Date.now) {
    this.#store = store; this.#reads = reads; this.#transport = transport; this.#clock = clock;
  }

  async submit(id: string): Promise<'ACKNOWLEDGED_AWAITING_EVIDENCE' | 'UNKNOWN_DO_NOT_RESUBMIT' | 'COMPLETE'> {
    const row = this.#store.operation(id);
    if (row?.kind !== 'WITHDRAWAL') throw new Error('Withdrawal reservation does not exist');
    if (row.state === 'COMPLETE') return 'COMPLETE';
    if (row.state !== 'PENDING') throw new Error('Withdrawal reservation was cancelled');
    const prior = this.#store.withdrawalSubmission(id);
    if (prior !== undefined) return prior.state === 'ACKNOWLEDGED' ? 'ACKNOWLEDGED_AWAITING_EVIDENCE' : 'UNKNOWN_DO_NOT_RESUBMIT';
    const request = row.payload as { owner: `0x${string}`; debitQuoteAtoms: bigint; preparedAtMs: number; expiresAtMs: number };
    const proof = await this.#reads.flat(this.#store.binding.poolAccount);
    const nonce = this.#clock();
    if (!Number.isSafeInteger(nonce) || nonce <= request.preparedAtMs || nonce > request.expiresAtMs
      || proof.environment !== 'TESTNET' || proof.account !== this.#store.binding.poolAccount
      || !Number.isSafeInteger(proof.requestedAtMs) || !Number.isSafeInteger(proof.observedAtMs)
      || proof.requestedAtMs <= 0 || proof.requestedAtMs > proof.observedAtMs || proof.observedAtMs > nonce
      || nonce - proof.requestedAtMs > 5_000 || proof.equityQuoteAtoms !== this.#store.totalQuoteAtoms()
      || proof.withdrawableQuoteAtoms !== proof.equityQuoteAtoms) {
      throw new Error('Withdrawal requires fresh, reconciled testnet backing and owner authority');
    }
    const action: HyperliquidPoolWithdrawalAction = { environment: 'TESTNET', source: this.#store.binding.poolAccount,
      destination: request.owner, debitQuoteAtoms: request.debitQuoteAtoms, nonce };
    if (!this.#store.claimWithdrawalSubmission(id, nonce, stringifyProtocolJson(action))) return 'UNKNOWN_DO_NOT_RESUBMIT';
    try {
      await this.#transport.send(action);
      this.#store.acknowledgeWithdrawal(id);
      return 'ACKNOWLEDGED_AWAITING_EVIDENCE';
    } catch {
      return 'UNKNOWN_DO_NOT_RESUBMIT';
    }
  }
}
