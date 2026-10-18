import { hashTypedData, keccak256, toHex, verifyTypedData } from 'viem';
import { stringifyProtocolJson } from '@naryx/protocol-types';
import { HyperliquidPooledCollateralStore, type HyperliquidPoolBinding } from './hyperliquid-pooled-collateral-store.js';

const ADDRESS = /^0x(?!0{40}$)[0-9a-f]{40}$/;
const HASH = /^0x[0-9a-f]{64}$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const MAX_AGE_MS = 5_000;
const TYPES = { PoolConsent: [
  { name: 'owner', type: 'address' }, { name: 'pool', type: 'address' },
  { name: 'bindingHash', type: 'bytes32' },
  { name: 'policyHash', type: 'bytes32' }, { name: 'custodyMode', type: 'string' },
], PoolWithdrawal: [
  { name: 'owner', type: 'address' }, { name: 'pool', type: 'address' },
  { name: 'bindingHash', type: 'bytes32' },
  { name: 'policyHash', type: 'bytes32' }, { name: 'requestId', type: 'string' },
  { name: 'debitQuoteAtoms', type: 'uint128' }, { name: 'expiresAtMs', type: 'uint48' },
] } as const;

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Pool funding: ${message}`);
}

function domain(binding: HyperliquidPoolBinding) {
  return { name: 'Naryx Custodial Testnet Pool', version: '1', chainId: 421614,
    verifyingContract: binding.poolAccount } as const;
}

export function poolBindingHash(binding: HyperliquidPoolBinding): `0x${string}` {
  return keccak256(toHex(stringifyProtocolJson({ version: binding.version, environment: binding.environment,
    domainId: binding.domain.domainId, domainManifestVersion: binding.domain.domainManifestVersion,
    domainManifestHash: binding.domain.domainManifestHash, poolAccount: binding.poolAccount,
    policyHash: binding.policyHash, quoteAssetId: binding.quoteAsset.assetId,
    quoteAssetManifestHash: binding.quoteAsset.assetManifestHash, quoteDecimals: binding.quoteAsset.decimals,
    collateralTokenId: binding.collateralTokenId, dedicatedTestOwners: [...binding.dedicatedTestOwners].sort(),
    maximumTotalQuoteAtoms: binding.maximumTotalQuoteAtoms })));
}

export function poolConsentTypedData(binding: HyperliquidPoolBinding, owner: `0x${string}`) {
  return { domain: domain(binding), types: { PoolConsent: TYPES.PoolConsent }, primaryType: 'PoolConsent' as const,
    message: { owner, pool: binding.poolAccount, bindingHash: poolBindingHash(binding),
      policyHash: binding.policyHash, custodyMode: binding.version === 2 ? 'CUSTODIAL_TESTNET_POOL_V2' : 'CUSTODIAL_TESTNET_POOL_V1' } };
}

export interface PoolWithdrawalRequest {
  readonly id: string;
  readonly owner: `0x${string}`;
  readonly debitQuoteAtoms: bigint;
  readonly expiresAtMs: number;
}

export function poolWithdrawalTypedData(binding: HyperliquidPoolBinding, request: PoolWithdrawalRequest) {
  return { domain: domain(binding), types: { PoolWithdrawal: TYPES.PoolWithdrawal }, primaryType: 'PoolWithdrawal' as const,
    message: { owner: request.owner, pool: binding.poolAccount, bindingHash: poolBindingHash(binding), policyHash: binding.policyHash,
      requestId: request.id, debitQuoteAtoms: request.debitQuoteAtoms, expiresAtMs: request.expiresAtMs } };
}

export interface HyperliquidPoolFlatEvidence {
  readonly environment: 'TESTNET';
  readonly account: `0x${string}`;
  readonly equityQuoteAtoms: bigint;
  readonly withdrawableQuoteAtoms: bigint;
  readonly requestedAtMs: number;
  readonly observedAtMs: number;
}

export interface HyperliquidPoolTransferEvidence {
  readonly environment: 'TESTNET';
  readonly hash: string;
  readonly source: `0x${string}`;
  readonly destination: `0x${string}`;
  readonly debitedQuoteAtoms: bigint;
  readonly receivedQuoteAtoms: bigint;
  readonly timeMs: number;
  readonly nonce: number;
}

export interface HyperliquidPoolFundingReadPort {
  flat(account: `0x${string}`): Promise<HyperliquidPoolFlatEvidence>;
  transfer(hash: string, timeMs: number, source: `0x${string}`, destination: `0x${string}`): Promise<HyperliquidPoolTransferEvidence>;
}

export function verifyPoolFlatEvidence(binding: HyperliquidPoolBinding, proof: HyperliquidPoolFlatEvidence, now: number): void {
  check(proof.environment === 'TESTNET' && proof.account === binding.poolAccount
    && Number.isSafeInteger(now) && Number.isSafeInteger(proof.requestedAtMs) && proof.requestedAtMs > 0
    && Number.isSafeInteger(proof.observedAtMs) && proof.requestedAtMs <= proof.observedAtMs
    && proof.observedAtMs <= now && now - proof.requestedAtMs <= MAX_AGE_MS
    && typeof proof.equityQuoteAtoms === 'bigint' && proof.equityQuoteAtoms >= 0n
    && proof.withdrawableQuoteAtoms === proof.equityQuoteAtoms, 'fresh flat withdrawable testnet backing is required');
}

export class HyperliquidPoolFundingService {
  readonly #store: HyperliquidPooledCollateralStore;
  readonly #reads: HyperliquidPoolFundingReadPort;
  readonly #clock: () => number;

  constructor(store: HyperliquidPooledCollateralStore, reads: HyperliquidPoolFundingReadPort, clock = Date.now) {
    this.#store = store; this.#reads = reads; this.#clock = clock;
  }

  async #flat() {
    const proof = await this.#reads.flat(this.#store.binding.poolAccount);
    verifyPoolFlatEvidence(this.#store.binding, proof, this.#clock());
    return proof;
  }

  async enroll(owner: `0x${string}`, signature: `0x${string}`): Promise<void> {
    check(ADDRESS.test(owner), 'invalid owner');
    const typed = poolConsentTypedData(this.#store.binding, owner);
    check(await verifyTypedData({ ...typed, address: owner, signature }), 'owner must explicitly consent to pooled custody');
    this.#store.enroll(owner, hashTypedData(typed));
  }

  async #transfer(hash: string, timeMs: number, source: `0x${string}`, destination: `0x${string}`) {
    check(HASH.test(hash) && !/^0x0+$/.test(hash) && Number.isSafeInteger(timeMs)
      && timeMs > 0 && timeMs <= this.#clock(), 'invalid transfer identity');
    const proof = await this.#reads.transfer(hash, timeMs, source, destination);
    check(proof.environment === 'TESTNET' && proof.hash === hash && proof.timeMs === timeMs
      && Number.isSafeInteger(proof.nonce) && proof.nonce > 0 && proof.nonce <= timeMs
      && proof.source === source && proof.destination === destination
      && typeof proof.debitedQuoteAtoms === 'bigint' && proof.debitedQuoteAtoms > 0n
      && typeof proof.receivedQuoteAtoms === 'bigint' && proof.receivedQuoteAtoms > 0n
      && proof.receivedQuoteAtoms <= proof.debitedQuoteAtoms, 'transfer evidence does not bind both owners and amounts');
    return proof;
  }

  async creditDeposit(input: Readonly<{ id: string; owner: `0x${string}`; transferHash: string; transferTimeMs: number }>): Promise<void> {
    check(ID.test(input.id) && ADDRESS.test(input.owner), 'invalid deposit identity');
    const transfer = await this.#transfer(input.transferHash, input.transferTimeMs, input.owner, this.#store.binding.poolAccount);
    const prior = this.#store.operation(input.id);
    if (prior !== undefined) {
      this.#store.creditDeposit({ id: input.id, owner: input.owner,
        receivedQuoteAtoms: transfer.receivedQuoteAtoms, transferHash: transfer.hash }, 0n);
      return;
    }
    const flat = await this.#flat();
    const backed = this.#store.totalQuoteAtoms() + transfer.receivedQuoteAtoms;
    check(flat.requestedAtMs >= transfer.timeMs
      && (this.#store.binding.version === 2 ? flat.equityQuoteAtoms >= backed : flat.equityQuoteAtoms === backed),
    'deposit is not fully backed by the observed pool equity');
    this.#store.creditDeposit({ id: input.id, owner: input.owner,
      receivedQuoteAtoms: transfer.receivedQuoteAtoms, transferHash: transfer.hash }, flat.equityQuoteAtoms);
  }

  async prepareWithdrawal(request: PoolWithdrawalRequest, signature: `0x${string}`) {
    check(ID.test(request.id) && ADDRESS.test(request.owner) && Number.isSafeInteger(request.expiresAtMs)
      && request.expiresAtMs > this.#clock() && request.expiresAtMs <= this.#clock() + 600_000
      && typeof request.debitQuoteAtoms === 'bigint' && request.debitQuoteAtoms > 0n
      && request.debitQuoteAtoms < (1n << 128n), 'invalid or expired withdrawal');
    const typed = poolWithdrawalTypedData(this.#store.binding, request);
    check(await verifyTypedData({ ...typed, address: request.owner, signature }), 'withdrawal requires the owner signature');
    const prior = this.#store.operation(request.id);
    if (prior !== undefined) {
      const stored = prior.payload as { owner: string; debitQuoteAtoms: bigint; authorizationHash: string };
      check(prior.kind === 'WITHDRAWAL' && stored.owner === request.owner
        && stored.debitQuoteAtoms === request.debitQuoteAtoms && stored.authorizationHash === hashTypedData(typed),
      'withdrawal replay changed its owner authorization');
      check(prior.state !== 'CANCELLED', 'cancelled withdrawal requires a new owner authorization');
      return Object.freeze({ source: this.#store.binding.poolAccount, destination: request.owner,
        maximumDebitQuoteAtoms: request.debitQuoteAtoms, expiresAtMs: request.expiresAtMs,
        status: prior.state === 'COMPLETE' ? 'COMPLETE' as const : 'PENDING_DO_NOT_RESUBMIT' as const });
    }
    const flat = await this.#flat();
    this.#store.prepareWithdrawal({ id: request.id, owner: request.owner, debitQuoteAtoms: request.debitQuoteAtoms,
      authorizationHash: hashTypedData(typed), verifiedFlatEquityQuoteAtoms: flat.equityQuoteAtoms,
      preparedAtMs: this.#clock(), expiresAtMs: request.expiresAtMs });
    return Object.freeze({ source: this.#store.binding.poolAccount, destination: request.owner,
      maximumDebitQuoteAtoms: request.debitQuoteAtoms, expiresAtMs: request.expiresAtMs, status: 'RESERVED_NOT_SUBMITTED' as const });
  }

  async completeWithdrawal(input: Readonly<{ id: string; transferHash: string; transferTimeMs: number }>): Promise<void> {
    const row = this.#store.operation(input.id);
    check(row?.kind === 'WITHDRAWAL', 'withdrawal does not exist');
    check(row.state !== 'CANCELLED', 'cancelled withdrawal cannot settle');
    const request = row.payload as { owner: `0x${string}`; debitQuoteAtoms: bigint; preparedAtMs: number; expiresAtMs: number };
    check(input.transferTimeMs > request.preparedAtMs, 'withdrawal transfer is outside its authorization window');
    const transfer = await this.#transfer(input.transferHash, input.transferTimeMs, this.#store.binding.poolAccount, request.owner);
    const submission = this.#store.withdrawalSubmission(input.id);
    check(transfer.nonce > request.preparedAtMs && transfer.nonce <= request.expiresAtMs
      && (submission === undefined || transfer.nonce === submission.nonce), 'withdrawal transfer nonce differs from owner authority');
    check(transfer.debitedQuoteAtoms === request.debitQuoteAtoms, 'withdrawal debit differs from the signed amount');
    if (row.state === 'COMPLETE') {
      const result = row.result as { verifiedFlatEquityQuoteAtoms: bigint };
      this.#store.completeWithdrawal({ id: input.id, transferHash: transfer.hash,
        verifiedFlatEquityQuoteAtoms: result.verifiedFlatEquityQuoteAtoms });
      return;
    }
    const flat = await this.#flat();
    check(flat.requestedAtMs >= transfer.timeMs, 'withdrawal backing predates the transfer');
    this.#store.completeWithdrawal({ id: input.id, transferHash: transfer.hash, verifiedFlatEquityQuoteAtoms: flat.equityQuoteAtoms });
  }

  async releaseExpiredUnsubmittedWithdrawal(id: string): Promise<void> {
    const flat = await this.#flat();
    this.#store.releaseExpiredUnsubmittedWithdrawal(id, this.#clock(), flat.equityQuoteAtoms);
  }
}
