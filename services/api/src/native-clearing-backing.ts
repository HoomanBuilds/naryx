import { lstatSync, readFileSync } from 'node:fs';
import {
  adjustNativeClearingCollateral,
  adjustNativeClearingRecoveryReserve,
  bytesEqual,
  nativeClearingAccount,
  nativeClearingCollateralAuthorization,
  nativeClearingDomainState,
  nativeClearingMarkObservation,
  nativeClearingMatchAuthorization,
  nativeClearingPolicy,
  parseProtocolJson,
  type NativeClearingAccount,
  type NativeClearingAccountInput,
  type NativeClearingCollateralAuthorizationInput,
  type NativeClearingDomainState,
  type NativeClearingDomainStateInput,
  type NativeClearingPolicy,
  type NativeClearingPolicyInput,
  type NativeClearingMarkObservationInput,
  type NativeClearingMatchAuthorizationInput,
} from '@naryx/protocol-types';
import { EvmNativeClearingBackingVerifier, EvmNativeClearingTransitionVerifier, type EvmNativeClearingBinding, type EvmNativeClearingTransitionReadPort } from '@naryx/adapter-evm';
import { createPublicClient, http, type Hex } from 'viem';
import { NativeClearingStoreError, nativeClearingBackingSnapshot, type NativeClearingBackingCheck, type SqliteNativeClearingStore } from './native-clearing-store.js';

type Clearing = Pick<SqliteNativeClearingStore, 'domain' | 'accounts' | 'account' | 'latestMark' | 'backingSnapshot'>
  & Partial<Pick<SqliteNativeClearingStore, 'contractTransition' | 'recordFinalizedTransition' | 'markByHash'>>;
type Verifier = Pick<EvmNativeClearingBackingVerifier, 'verify'>;
type TransitionVerifier = Pick<EvmNativeClearingTransitionVerifier, 'executionMarkHash' | 'match' | 'recover'>
  & Partial<Pick<EvmNativeClearingTransitionVerifier, 'normalize'>>;

export class NativeClearingBackingService {
  readonly #clearing: Clearing;
  readonly #verifiers: ReadonlyMap<string, Verifier>;
  readonly #clock: () => number;
  readonly #transitions: ReadonlyMap<string, TransitionVerifier>;

  constructor(clearing: Clearing, verifiers: ReadonlyMap<string, Verifier>, clock: () => number = Date.now,
    transitions: ReadonlyMap<string, TransitionVerifier> = new Map()) {
    this.#clearing = clearing;
    this.#verifiers = new Map(verifiers);
    this.#clock = clock;
    this.#transitions = new Map(transitions);
  }

  async #verify(policy: NativeClearingPolicy, state: NativeClearingDomainState, accounts: readonly NativeClearingAccount[], atBlock?: { readonly number: bigint; readonly hash: Hex }) {
    const verifier = this.#verifiers.get(policy.clearingDomainId);
    if (verifier === undefined) throw new NativeClearingStoreError('BACKING_UNAVAILABLE', 'No reviewed onchain backing is configured for this clearing domain.');
    try {
      return await verifier.verify(policy, state, accounts, atBlock);
    } catch {
      throw new NativeClearingStoreError('BACKING_UNVERIFIED', 'Finalized onchain clearing state does not verify the proposed ledger state.');
    }
  }

  async current(clearingDomainId: string) {
    const domain = this.#clearing.domain(clearingDomainId);
    if (domain === undefined) throw new NativeClearingStoreError('DOMAIN_NOT_FOUND', 'Native clearing domain was not found.');
    return this.#verify(domain.policy, domain.state, this.#clearing.accounts(clearingDomainId));
  }

  async observe(kind: 'MATCH' | 'DEFAULT' | 'NORMALIZE', body: Record<string, unknown>) {
    if (typeof body.clearingDomainId !== 'string' || typeof body.transactionHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(body.transactionHash)) {
      throw new NativeClearingStoreError('INVALID_INPUT', 'Clearing domain and transaction hash are required.');
    }
    const verifier = this.#transitions.get(body.clearingDomainId);
    if (verifier === undefined || this.#clearing.recordFinalizedTransition === undefined) throw new NativeClearingStoreError('BACKING_UNAVAILABLE', 'Clearing transaction reconciliation is not configured.');
    const domain = this.#clearing.domain(body.clearingDomainId);
    if (domain === undefined) throw new NativeClearingStoreError('DOMAIN_NOT_FOUND', 'Native clearing domain was not found.');
    const existing = this.#clearing.contractTransition?.(body.transactionHash);
    if (existing !== undefined) {
      if (existing.kind !== kind || !bytesEqual(existing.receipt.policyHash, domain.policy.policyHash)) throw new NativeClearingStoreError('SETTLEMENT_CONFLICT', 'Clearing transaction belongs to another operation.');
      if (existing.kind === 'MATCH') {
        const authorization = nativeClearingMatchAuthorization({
          ...body.authorization as Omit<NativeClearingMatchAuthorizationInput, 'currentExpiryUnit' | 'currentExpiryValue'>,
          currentExpiryUnit: 'EVM_UNIX_SECONDS', currentExpiryValue: existing.proof.executedAtMs / 1_000n,
        });
        if (!bytesEqual(authorization.authorizationHash, existing.authorizationHash)) throw new NativeClearingStoreError('SETTLEMENT_CONFLICT', 'Clearing transaction belongs to another match authorization.');
      } else if (existing.kind === 'NORMALIZE') {
        if (body.accountId !== existing.receipt.accountId) throw new NativeClearingStoreError('SETTLEMENT_CONFLICT', 'Clearing transaction belongs to another account.');
      } else if (body.auctionId !== existing.receipt.resolutionId) {
        throw new NativeClearingStoreError('SETTLEMENT_CONFLICT', 'Clearing transaction belongs to another recovery auction.');
      }
      return existing;
    }
    const before = this.#clearing.backingSnapshot(body.clearingDomainId);
    if (kind === 'NORMALIZE') {
      if (typeof body.accountId !== 'string' || verifier.normalize === undefined) throw new NativeClearingStoreError('INVALID_INPUT', 'A supported normalization account is required.');
      let transition;
      try {
        transition = await verifier.normalize({ policy: domain.policy, state: domain.state,
          accounts: this.#clearing.accounts(body.clearingDomainId), accountId: body.accountId, transactionHash: body.transactionHash as Hex });
      } catch {
        throw new NativeClearingStoreError('BACKING_UNVERIFIED', 'Finalized owner call and clearing normalization state could not be verified.');
      }
      return this.#clearing.recordFinalizedTransition(body.clearingDomainId, before, transition);
    }
    let mark;
    try {
      const observationHash = await verifier.executionMarkHash(body.transactionHash as Hex);
      mark = this.#clearing.markByHash?.(body.clearingDomainId, observationHash);
    } catch {
      throw new NativeClearingStoreError('BACKING_UNVERIFIED', 'Clearing execution mark cannot be verified.');
    }
    if (mark === undefined) throw new NativeClearingStoreError('MARK_UNAVAILABLE', 'Clearing mark is unavailable.');
    const input = { policy: domain.policy, state: domain.state, accounts: this.#clearing.accounts(body.clearingDomainId),
      mark, transactionHash: body.transactionHash as Hex };
    let transition;
    try {
      transition = kind === 'MATCH'
        ? await verifier.match({ ...input, authorization: body.authorization as Omit<NativeClearingMatchAuthorizationInput, 'currentExpiryUnit' | 'currentExpiryValue'> })
        : await verifier.recover({ ...input, auctionId: body.auctionId as string });
    } catch {
      throw new NativeClearingStoreError('BACKING_UNVERIFIED', 'Clearing transaction is not finalized or does not verify the ledger transition.');
    }
    return this.#clearing.recordFinalizedTransition(body.clearingDomainId, before, transition);
  }

  async verifyMutation(path: string, body: Record<string, unknown>): Promise<NativeClearingBackingCheck> {
    if (!['domains', 'accounts', 'reserve', 'marks', 'collateral'].some((action) => path === `/internal/native-clearing/${action}`)) {
      throw new NativeClearingStoreError('BACKING_OPERATION_UNSUPPORTED', 'This clearing operation has no onchain reconciliation route.');
    }
    let policy: NativeClearingPolicy;
    let state: NativeClearingDomainState;
    let accounts: readonly NativeClearingAccount[];
    let beforeSnapshot: string;
    let mark: ReturnType<Clearing['latestMark']>;
    let atBlock: { number: bigint; hash: Hex } | undefined;
    if (body.evidenceBlock !== undefined) {
      const value = body.evidenceBlock as Record<string, unknown>;
      if (typeof value !== 'object' || value === null || Object.keys(value).sort().join(',') !== 'hash,number'
        || typeof value.number !== 'bigint' || value.number <= 0n || typeof value.hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value.hash)) {
        throw new NativeClearingStoreError('INVALID_INPUT', 'Clearing evidence block is invalid.');
      }
      atBlock = { number: value.number, hash: value.hash as Hex };
    }
    if (path === '/internal/native-clearing/domains') {
      policy = nativeClearingPolicy(body.policy as unknown as NativeClearingPolicyInput);
      state = nativeClearingDomainState(body.state as unknown as NativeClearingDomainStateInput, policy);
      if (state.openInterestAtoms !== 0n || state.recoveryReserveQuoteAtoms !== 0n || state.sequence !== 0n) {
        throw new NativeClearingStoreError('INVALID_GENESIS', 'A backed clearing domain begins empty; reserve funding must be verified separately.');
      }
      accounts = [];
      beforeSnapshot = this.#clearing.backingSnapshot(policy.clearingDomainId);
    } else {
      let command: ReturnType<typeof nativeClearingCollateralAuthorization> | undefined;
      if (path === '/internal/native-clearing/collateral') command = nativeClearingCollateralAuthorization(body.authorization as unknown as NativeClearingCollateralAuthorizationInput);
      const account = command === undefined ? undefined : this.#clearing.account(command.accountId);
      const clearingDomainId = account === undefined
        ? body.clearingDomainId
        : [...this.#verifiers.keys()].find((id) => {
          const domain = this.#clearing.domain(id);
          return domain !== undefined && bytesEqual(domain.policy.policyHash, account.policyHash);
        });
      if (typeof clearingDomainId !== 'string') throw new NativeClearingStoreError('ACCOUNT_NOT_FOUND', 'Native clearing account domain was not found.');
      beforeSnapshot = this.#clearing.backingSnapshot(clearingDomainId);
      const domain = this.#clearing.domain(clearingDomainId);
      if (domain === undefined) throw new NativeClearingStoreError('DOMAIN_NOT_FOUND', 'Native clearing domain was not found.');
      ({ policy, state } = domain);
      accounts = this.#clearing.accounts(clearingDomainId);
      mark = this.#clearing.latestMark(clearingDomainId);
      if (path === '/internal/native-clearing/accounts') {
        const next = nativeClearingAccount(body.account as unknown as NativeClearingAccountInput, policy);
        const existing = accounts.find((candidate) => candidate.accountId === next.accountId);
        accounts = existing === undefined ? [...accounts, next] : accounts;
      } else if (path === '/internal/native-clearing/reserve') {
        state = adjustNativeClearingRecoveryReserve(state, policy, body.reserveDeltaQuoteAtoms as bigint);
      } else if (path === '/internal/native-clearing/collateral' && command !== undefined && account !== undefined) {
        if (mark === undefined) throw new NativeClearingStoreError('MARK_UNAVAILABLE', 'Native clearing mark is unavailable.');
        const next = adjustNativeClearingCollateral(account, policy, command.collateralDeltaQuoteAtoms, mark.priceTicks, mark.observedAtMs, BigInt(this.#clock()));
        accounts = accounts.map((candidate) => candidate.accountId === next.accountId ? next : candidate);
      } else if (path === '/internal/native-clearing/marks') {
        mark = nativeClearingMarkObservation(body.observation as unknown as NativeClearingMarkObservationInput, policy);
      } else {
        throw new NativeClearingStoreError('BACKING_OPERATION_UNSUPPORTED', 'This clearing operation has no onchain reconciliation route.');
      }
    }
    const tradingReconciliation = this.#transitions.has(policy.clearingDomainId);
    if (!tradingReconciliation && path !== '/internal/native-clearing/marks' && (state.openInterestAtoms !== 0n || accounts.some((account) => account.positionAtoms !== 0n || account.cashBalanceQuoteAtoms !== 0n))) {
      throw new NativeClearingStoreError('BACKING_OPERATION_UNSUPPORTED', 'Funding reconciliation requires flat native clearing accounts.');
    }
    const proof = await this.#verify(policy, state, accounts, atBlock);
    if (!tradingReconciliation && path !== '/internal/native-clearing/marks' && !proof.entryPaused) throw new NativeClearingStoreError('BACKING_OPERATION_UNSUPPORTED', 'Funding reconciliation requires native clearing entries to remain paused.');
    return Object.freeze({ clearingDomainId: policy.clearingDomainId, action: path.slice('/internal/native-clearing/'.length),
      beforeSnapshot, afterSnapshot: nativeClearingBackingSnapshot({ policy, state }, accounts, mark), proof });
  }
}

export function loadNativeClearingBacking(
  path: string | undefined,
  clearing: Clearing,
  environment: Readonly<Record<string, string | undefined>>,
  clock?: () => number,
): NativeClearingBackingService {
  const verifiers = new Map<string, Verifier>();
  const transitions = new Map<string, EvmNativeClearingTransitionVerifier>();
  if (path !== undefined) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 262_144) throw new Error('Native clearing backing configuration must be a bounded regular file.');
    const config = parseProtocolJson(readFileSync(path, 'utf8')) as {
      version?: unknown;
      bindings?: readonly { clearingDomainId: string; binding: EvmNativeClearingBinding; rpcEnvironmentVariable: string }[];
    };
    if (config.version !== 1 || !Array.isArray(config.bindings) || config.bindings.length > 32
      || Object.keys(config).sort().join(',') !== 'bindings,version') throw new Error('Native clearing backing configuration is invalid.');
    for (const entry of config.bindings) {
      if (typeof entry.clearingDomainId !== 'string' || typeof entry.rpcEnvironmentVariable !== 'string'
        || !/^NARYX_[A-Z0-9_]+_RPC_URL$/.test(entry.rpcEnvironmentVariable)
        || Object.keys(entry).sort().join(',') !== 'binding,clearingDomainId,rpcEnvironmentVariable'
        || verifiers.has(entry.clearingDomainId)) throw new Error('Native clearing backing binding is invalid or repeated.');
      const rpc = environment[entry.rpcEnvironmentVariable];
      if (!rpc) throw new Error('Native clearing backing RPC is not configured.');
      const client = createPublicClient({ transport: http(rpc, { timeout: 10_000, retryCount: 2, retryDelay: 500 }) });
      const reads: EvmNativeClearingTransitionReadPort = {
        chainId: async () => BigInt(await client.getChainId()),
        finalizedBlock: async () => {
          const block = await client.getBlock({ blockTag: 'finalized' });
          if (block.number === null || block.hash === null) throw new Error('Finalized clearing block is unavailable.');
          return { number: block.number, hash: block.hash };
        },
        blockHash: async (blockNumber) => {
          const block = await client.getBlock({ blockNumber });
          if (block.hash === null) throw new Error('Finalized clearing block is unavailable.');
          return block.hash;
        },
        code: async (address, blockNumber) => await client.getCode({ address, blockNumber }) ?? '0x',
        read: async (read, blockNumber) => client.readContract({ ...read, blockNumber }),
        receipt: (transactionHash) => client.getTransactionReceipt({ hash: transactionHash }),
        transaction: (transactionHash) => client.getTransaction({ hash: transactionHash }),
        timestamp: async (blockNumber) => (await client.getBlock({ blockNumber })).timestamp,
        clearingLogs: (blockNumber) => client.getLogs({ address: entry.binding.clearingHouse, fromBlock: blockNumber, toBlock: blockNumber }),
      };
      verifiers.set(entry.clearingDomainId, new EvmNativeClearingBackingVerifier(entry.binding, reads));
      transitions.set(entry.clearingDomainId, new EvmNativeClearingTransitionVerifier(entry.binding, reads));
    }
  }
  return new NativeClearingBackingService(clearing, verifiers, clock, transitions);
}
