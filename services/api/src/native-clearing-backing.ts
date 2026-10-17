import { lstatSync, readFileSync } from 'node:fs';
import {
  adjustNativeClearingCollateral,
  adjustNativeClearingRecoveryReserve,
  bytesEqual,
  nativeClearingAccount,
  nativeClearingCollateralAuthorization,
  nativeClearingDomainState,
  nativeClearingMarkObservation,
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
} from '@naryx/protocol-types';
import { EvmNativeClearingBackingVerifier, type EvmNativeClearingBinding } from '@naryx/adapter-evm';
import { createPublicClient, http } from 'viem';
import { NativeClearingStoreError, nativeClearingBackingSnapshot, type NativeClearingBackingCheck, type SqliteNativeClearingStore } from './native-clearing-store.js';

type Clearing = Pick<SqliteNativeClearingStore, 'domain' | 'accounts' | 'account' | 'latestMark' | 'backingSnapshot'>;
type Verifier = Pick<EvmNativeClearingBackingVerifier, 'verify'>;

export class NativeClearingBackingService {
  readonly #clearing: Clearing;
  readonly #verifiers: ReadonlyMap<string, Verifier>;
  readonly #clock: () => number;

  constructor(clearing: Clearing, verifiers: ReadonlyMap<string, Verifier>, clock: () => number = Date.now) {
    this.#clearing = clearing;
    this.#verifiers = new Map(verifiers);
    this.#clock = clock;
  }

  async #verify(policy: NativeClearingPolicy, state: NativeClearingDomainState, accounts: readonly NativeClearingAccount[]) {
    const verifier = this.#verifiers.get(policy.clearingDomainId);
    if (verifier === undefined) throw new NativeClearingStoreError('BACKING_UNAVAILABLE', 'No reviewed onchain backing is configured for this clearing domain.');
    try {
      return await verifier.verify(policy, state, accounts);
    } catch {
      throw new NativeClearingStoreError('BACKING_UNVERIFIED', 'Finalized onchain clearing state does not verify the proposed ledger state.');
    }
  }

  async current(clearingDomainId: string) {
    const domain = this.#clearing.domain(clearingDomainId);
    if (domain === undefined) throw new NativeClearingStoreError('DOMAIN_NOT_FOUND', 'Native clearing domain was not found.');
    return this.#verify(domain.policy, domain.state, this.#clearing.accounts(clearingDomainId));
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
    if (state.openInterestAtoms !== 0n || accounts.some((account) => account.positionAtoms !== 0n || account.cashBalanceQuoteAtoms !== 0n)) {
      throw new NativeClearingStoreError('BACKING_OPERATION_UNSUPPORTED', 'Funding reconciliation requires flat native clearing accounts.');
    }
    const proof = await this.#verify(policy, state, accounts);
    if (!proof.entryPaused) throw new NativeClearingStoreError('BACKING_OPERATION_UNSUPPORTED', 'Funding reconciliation requires native clearing entries to remain paused.');
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
      const client = createPublicClient({ transport: http(rpc, { timeout: 10_000, retryCount: 0 }) });
      verifiers.set(entry.clearingDomainId, new EvmNativeClearingBackingVerifier(entry.binding, {
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
      }));
    }
  }
  return new NativeClearingBackingService(clearing, verifiers, clock);
}
