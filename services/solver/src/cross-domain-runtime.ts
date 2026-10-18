import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { bytesEqual, parseProtocolJson, toHex, crossDomainPlanHash, crossDomainCompensationAction, commitmentHash } from '@naryx/protocol-types';
import { getAddress, keccak256, stringToHex, type Address } from 'viem';
import { CrossDomainExecutionCoordinator } from './cross-domain-execution-coordinator.js';
import { SqliteCrossDomainJobStore, validateCrossDomainJob, type CrossDomainJob } from './cross-domain-job-store.js';
import { CrossDomainWorker } from './cross-domain-worker.js';
import { HttpCrossDomainCoordinationJournal } from './http-cross-domain-coordination-journal.js';
import { EvmCrossDomainExecutionDriver, type EvmCrossDomainCompensationProfile, type EvmCrossDomainLaneInput } from './evm-cross-domain-execution-driver.js';
import { EvmRecoverableCrossDomainLane, type EvmRecoverableCrossDomainLaneConfig } from './evm-recoverable-cross-domain-lane.js';
import { createViemEvmFirmReservationCrossDomainPort } from './evm-firm-reservation-cross-domain-port.js';
import { loadEvmStrategySolverKey } from './evm-strategy-execution-authorization.js';
import { validateEvmFullReversal } from './evm-full-reversal-policy.js';
import { CrossDomainWalletAdmission, validateCrossDomainWalletDraft, type CrossDomainWalletDraft } from './cross-domain-wallet-admission.js';
import { createCrossDomainCalendarRuntime } from './cross-domain-calendar-runtime.js';

interface LaneConfiguration {
  readonly rpcEnvironmentVariable: string;
  readonly signerAddress: Address;
  readonly signerKeyPath: string;
  readonly submissionJournalPath: string;
  readonly maximumGasBudgetWei: bigint;
  readonly alreadySpentWei: bigint;
  readonly maximumEntryQuoteAtoms: bigint;
  readonly allowedOwners: readonly Address[];
  readonly allowedAccounts: readonly Address[];
  readonly lane: EvmRecoverableCrossDomainLaneConfig;
  readonly compensationProfile: EvmCrossDomainCompensationProfile;
}

interface RuntimeConfiguration {
  readonly version: 1;
  readonly environment: 'testnet';
  readonly jobDatabasePath: string;
  readonly apiOrigin: string;
  readonly pollIntervalMs: number;
  readonly lanes: readonly LaneConfiguration[];
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Cross-domain runtime refused: ${message}`);
}

function readBounded(path: string) {
  requireCondition(isAbsolute(path) && statSync(path).isFile() && statSync(path).size <= 1_048_576, 'invalid configuration or job file');
  return parseProtocolJson(readFileSync(path, 'utf8'));
}

export async function loadCrossDomainRuntime(environment: NodeJS.ProcessEnv) {
  if (environment.NARYX_CROSS_DOMAIN_ENABLED !== 'true') {
    requireCondition(environment.NARYX_CROSS_DOMAIN_ENABLED === undefined || environment.NARYX_CROSS_DOMAIN_ENABLED === 'false', 'invalid enable flag');
    return undefined;
  }
  const path = environment.NARYX_CROSS_DOMAIN_CONFIG;
  requireCondition(path !== undefined, 'missing runtime config');
  const config = readBounded(path) as RuntimeConfiguration;
  requireCondition(config.version === 1 && config.environment === 'testnet' && config.lanes.length === 2,
    'only a two-domain testnet cohort is supported');
  requireCondition(Number.isSafeInteger(config.pollIntervalMs) && config.pollIntervalMs >= 1_000 && config.pollIntervalMs <= 30_000,
    'poll interval must be between one and thirty seconds');
  requireCondition(new Set(config.lanes.map(l => l.lane.chainReference)).size === 2, 'repeated runtime chain');
  const store = new SqliteCrossDomainJobStore(config.jobDatabasePath);
  const ports: ReturnType<typeof createViemEvmFirmReservationCrossDomainPort>[] = [];
  let calendar: ReturnType<typeof createCrossDomainCalendarRuntime> | undefined;
  try {
    const lanes: { item: LaneConfiguration; account: ReturnType<typeof loadEvmStrategySolverKey>; lane: EvmRecoverableCrossDomainLane; driver: EvmCrossDomainExecutionDriver; port: typeof ports[number] }[] = [];
    for (const item of config.lanes) {
      const chain = item.lane.chainReference;
      requireCondition(chain === 84_532n || chain === 421_614n, 'only Base and Arbitrum Sepolia are enabled');
      requireCondition(item.maximumGasBudgetWei > 0n && item.maximumGasBudgetWei <= 10_000_000_000_000_000n
        && item.alreadySpentWei >= 0n && item.alreadySpentWei <= item.maximumGasBudgetWei, 'gas budget exceeds testnet limit');
      requireCondition(item.maximumEntryQuoteAtoms > 0n && item.allowedOwners.length > 0 && item.allowedAccounts.length > 0,
        'funded test cohort or entry cap missing');
      requireCondition(/^[A-Z][A-Z0-9_]+$/.test(item.rpcEnvironmentVariable), 'invalid RPC environment variable');
      const rpcUrl = environment[item.rpcEnvironmentVariable];
      requireCondition(rpcUrl !== undefined, 'RPC endpoint unavailable');
      const account = loadEvmStrategySolverKey(item.signerKeyPath, item.signerAddress);
      const port = createViemEvmFirmReservationCrossDomainPort({ rpcUrl, chainReference: chain, account,
        submissionJournalPath: item.submissionJournalPath, maximumGasBudgetWei: item.maximumGasBudgetWei, alreadySpentWei: item.alreadySpentWei });
      ports.push(port);
      requireCondition(await port.chainId() === chain, 'RPC chain identity differs from configured testnet');
      await port.reconcilePending();
      const authorization = (hash: string, domainId: string) => store.get(hash)?.authorizations.find(a => a.domainId === domainId);
      const lane = new EvmRecoverableCrossDomainLane(item.lane, port, {
        resolve: async (hash, domainId) => authorization(hash, domainId)?.entry,
        resolveRecovery: async (hash, domainId) => authorization(hash, domainId)?.recovery,
      });
      lanes.push({ item, account, lane, driver: new EvmCrossDomainExecutionDriver(lane, item.compensationProfile), port });
    }
    const journal = new HttpCrossDomainCoordinationJournal(config.apiOrigin);
    const coordinator = new CrossDomainExecutionCoordinator(journal, lanes.map(l => l.driver));
    const checkCohort = (job: CrossDomainJob) => {
      validateCrossDomainJob(job);
      for (const { item } of lanes) {
        const domain = job.execution.domains.find(d => d.domain.domainId === item.lane.domain.domainId);
        const auth = job.authorizations.find(a => a.domainId === item.lane.domain.domainId);
        requireCondition(domain?.kind === 'EVM_MULTI_STRATEGY_ACCOUNT' && auth !== undefined, 'runtime does not cover job');
        requireCondition(domain.domain.domainManifestVersion === item.lane.domain.domainManifestVersion
          && bytesEqual(domain.domain.domainManifestHash, item.lane.domain.domainManifestHash), 'unqualified domain manifest');
        requireCondition(domain.envelope.execution.domainIdHash === keccak256(stringToHex(domain.domain.domainId))
          && domain.envelope.execution.domainManifestVersion === domain.domain.domainManifestVersion
          && domain.envelope.execution.domainManifestHash === `0x${toHex(domain.domain.domainManifestHash)}`
          && domain.envelope.execution.orderHash === `0x${toHex(job.execution.orderHash)}`
          && domain.envelope.execution.quoteHash === `0x${toHex(job.execution.quoteHash)}`
          && domain.envelope.execution.routeHash === `0x${toHex(job.execution.routeHash)}`, 'account execution binds another domain or route');
        requireCondition(item.allowedOwners.some(a => getAddress(a) === getAddress(auth.entry.owner))
          && item.allowedAccounts.some(a => getAddress(a) === getAddress(domain.envelope.account))
          && getAddress(domain.envelope.execution.solver) === getAddress(item.signerAddress), 'job is outside the dedicated test cohort');
        const reversal = validateEvmFullReversal(domain.envelope, auth.recovery.envelope, item.lane.recoveryAdapters);
        requireCondition(reversal.maximumEntryQuoteAtoms <= item.maximumEntryQuoteAtoms, 'job exceeds funded entry cap');
      }
    };
    for (const hash of store.active()) checkCohort(store.get(hash)!);
    const admit = async (job: CrossDomainJob) => {
      checkCohort(job);
      const planHash = toHex(crossDomainPlanHash(job.bundle.plan));
      if (store.get(planHash) !== undefined) return { planHash, admittedPlanHash: store.admit(job) };
      requireCondition(BigInt(Math.floor(Date.now() / 1_000)) < job.bundle.plan.prepareDeadline, 'job preparation expired');
      for (const { item, port } of lanes) {
        const domainId = item.lane.domain.domainId;
        const auth = job.authorizations.find(a => a.domainId === domainId)!;
        const lane = new EvmRecoverableCrossDomainLane(item.lane, port, {
          resolve: async () => auth.entry, resolveRecovery: async () => auth.recovery,
        });
        const input: EvmCrossDomainLaneInput = { planHash, plan: job.bundle.plan,
          planLeg: job.bundle.plan.legs.find(l => l.domain.domainId === domainId)!,
          compensation: crossDomainCompensationAction(job.bundle.compensations.find(c => c.domain.domainId === domainId)!),
          execution: job.execution.domains.find(d => d.domain.domainId === domainId)!,
          events: [], action: { kind: 'PREPARE', domainId }, phase: 'PREPARE' };
        new EvmCrossDomainExecutionDriver(lane, item.compensationProfile).validateInput(input);
        await lane.validateAdmission(input);
      }
      requireCondition(BigInt(Math.floor(Date.now() / 1_000)) < job.bundle.plan.prepareDeadline, 'job expired during admission');
      return { planHash, admittedPlanHash: store.admit(job) };
    };
    requireCondition(environment.NARYX_CROSS_DOMAIN_WALLET_ENABLED === undefined
      || environment.NARYX_CROSS_DOMAIN_WALLET_ENABLED === 'false'
      || environment.NARYX_CROSS_DOMAIN_WALLET_ENABLED === 'true', 'invalid wallet approval flag');
    if (environment.NARYX_CROSS_DOMAIN_CALENDAR_DIR?.trim()) {
      requireCondition(environment.NARYX_CROSS_DOMAIN_WALLET_ENABLED === 'true'
        && environment.NARYX_CROSS_DOMAIN_QUOTE_KEY_PATH !== undefined, 'calendar requires wallet admission and a quote signer');
      calendar = createCrossDomainCalendarRuntime({ directory: environment.NARYX_CROSS_DOMAIN_CALENDAR_DIR,
        databasePath: `${config.jobDatabasePath}.calendar.sqlite`, signingKeyPath: environment.NARYX_CROSS_DOMAIN_QUOTE_KEY_PATH,
        lanes: lanes.map(({ item, port }) => ({ ...item, port, rpcUrl: environment[item.rpcEnvironmentVariable]! })) });
    }
    const checkDraft = async (value: unknown): Promise<CrossDomainWalletDraft> => {
      const draft = value as CrossDomainWalletDraft;
      validateCrossDomainWalletDraft(draft);
      for (const { item, port } of lanes) {
        const domain = draft.execution.domains.find(domain => domain.domain.domainId === item.lane.domain.domainId);
        const recovery = draft.lanes.find(lane => lane.domainId === item.lane.domain.domainId);
        requireCondition(domain?.kind === 'EVM_MULTI_STRATEGY_ACCOUNT' && recovery !== undefined, 'draft does not cover the runtime');
        requireCondition(domain.domain.domainManifestVersion === item.lane.domain.domainManifestVersion
          && bytesEqual(domain.domain.domainManifestHash, item.lane.domain.domainManifestHash)
          && item.allowedOwners.some(owner => getAddress(owner) === getAddress(draft.owner))
          && item.allowedAccounts.some(account => getAddress(account) === getAddress(domain.envelope.account))
          && getAddress(domain.envelope.execution.solver) === getAddress(item.signerAddress), 'draft is outside the approved test cohort');
        requireCondition(await port.chainId() === item.lane.chainReference
          && await port.codeHash(domain.envelope.account) === item.lane.strategyAccountCodeHash
          && getAddress(await port.accountOwner(domain.envelope.account)) === getAddress(draft.owner)
          && await port.accountNextNonce(domain.envelope.account) === domain.envelope.execution.nonce,
        'draft account code, owner or nonce changed');
        requireCondition(recovery.executorClassId === item.compensationProfile.executorClassId
          && recovery.executorClassVersion === item.compensationProfile.executorClassVersion
          && bytesEqual(commitmentHash(recovery.executorClassManifestHash), commitmentHash(item.compensationProfile.executorClassManifestHash)),
        'draft recovery class differs from the runtime');
        const reversal = validateEvmFullReversal(domain.envelope, recovery.recovery, item.lane.recoveryAdapters);
        requireCondition(reversal.maximumEntryQuoteAtoms <= item.maximumEntryQuoteAtoms
          && reversal.maximumLossQuoteAtoms <= recovery.maximumRecoveryCostQuoteAtoms
          && recovery.maximumRecoveryCostQuoteAtoms <= item.lane.maximumCompensationCostQuoteAtoms, 'draft exceeds the approved limits');
      }
      return draft;
    };
    const walletApprovals = environment.NARYX_CROSS_DOMAIN_WALLET_ENABLED !== 'true' ? undefined
      : new CrossDomainWalletAdmission(`${config.jobDatabasePath}.wallet.sqlite`, {
        prepare: checkDraft,
        signSolver: async envelope => {
          const lane = lanes.find(lane => getAddress(lane.account.address) === getAddress(envelope.execution.solver));
          requireCondition(lane !== undefined, 'solver is not configured');
          return lane.account.signTypedData(envelope.solverTypedData);
        },
        validate: async (draft, job) => {
          await checkDraft(draft); checkCohort(job);
          if (calendar?.documents(toHex(draft.execution.orderHash))) await calendar.validate(draft);
        },
        async reserve(_id, _draft, job) {
          if (calendar?.documents(toHex(_draft.execution.orderHash))) return calendar.reserve(_draft);
          // Operator preparations still require their exact inventory to be funded separately.
          for (const { item, port } of lanes) {
            const leg = job.bundle.plan.legs.find(leg => leg.domain.domainId === item.lane.domain.domainId)!;
            if ((await port.reservation(item.lane.reservationBook, `0x${toHex(commitmentHash(leg.inventoryReservationId))}`)).state !== 'LIVE') return false;
          }
          return true;
        },
        async release(_id, _draft, job) {
          let released = true;
          for (const { lane, port } of lanes) {
            const domainId = lane.domain.domainId;
            const input: EvmCrossDomainLaneInput = { planHash: validateCrossDomainJob(job), plan: job.bundle.plan,
              planLeg: job.bundle.plan.legs.find(leg => leg.domain.domainId === domainId)!,
              compensation: crossDomainCompensationAction(job.bundle.compensations.find(action => action.domain.domainId === domainId)!),
              execution: job.execution.domains.find(domain => domain.domain.domainId === domainId)!,
              events: [], action: { kind: 'PREPARE', domainId }, phase: 'PREPARE' };
            if (!await lane.settleUnusedReservation(input) || !await port.reconcilePending()) released = false;
          }
          return released;
        },
        admit, status: hash => store.status(hash), now: () => BigInt(Math.floor(Date.now() / 1_000)),
      });
    return {
      walletApprovals,
      calendarProfile: calendar?.profile,
      calendarMarket: () => calendar?.market(),
      calendarDocuments: (orderHash: string) => calendar?.documents(orderHash),
      inspectCalendar: () => calendar?.inspect(),
      async prepareCalendar(value: unknown) {
        requireCondition(calendar !== undefined && walletApprovals !== undefined, 'canonical preparation is disabled');
        return walletApprovals.prepare(await calendar.prepare(value));
      },
      async calendarExit(value: unknown) {
        requireCondition(calendar !== undefined && walletApprovals !== undefined && typeof value === 'object' && value !== null, 'calendar exit is disabled');
        const request = value as Record<string, unknown>;
        requireCondition(Object.keys(request).sort().join(',') === (request.signature === undefined ? 'domainId,draftId' : 'domainId,draftId,signature')
          && typeof request.draftId === 'string' && typeof request.domainId === 'string'
          && (request.signature === undefined || (typeof request.signature === 'string' && /^0x[0-9a-fA-F]{130}$/.test(request.signature))), 'invalid exit request');
        const current = walletApprovals.get(request.draftId);
        requireCondition(current?.state === 'ADMITTED' && current.planHash !== null
          && store.status(current.planHash)?.status === 'TERMINAL', 'wait for coordinator reconciliation before a manual exit');
        return calendar.exit(current.draft, request.domainId, request.signature as `0x${string}` | undefined);
      },
      worker: new CrossDomainWorker(store, coordinator, {
        validate: checkCohort,
        async reconcileTerminal(job, result) {
          for (const { lane, port } of lanes) {
            const domainId = lane.domain.domainId;
            const input: EvmCrossDomainLaneInput = { planHash: result.planHash, plan: job.bundle.plan,
              planLeg: job.bundle.plan.legs.find(l => l.domain.domainId === domainId)!,
              compensation: crossDomainCompensationAction(job.bundle.compensations.find(c => c.domain.domainId === domainId)!),
              execution: job.execution.domains.find(d => d.domain.domainId === domainId)!,
              events: [], action: { kind: 'RECONCILE_COMMIT', domainId }, phase: 'COMMIT' };
            const committed = await lane.reconcileCommit(input);
            if (result.state.terminalState === 'FINALIZED_COMPLETE') {
              if (committed.status !== 'FINALIZED') return false;
            } else if (committed.status === 'PENDING') return false;
            else if (committed.status === 'FINALIZED') {
              const recovered = await lane.awaitFinality({ ...input, phase: 'COMPENSATE', evidenceHash: commitmentHash(input.planLeg.inventoryReservationId) });
              if (recovered.status !== 'FINALIZED') return false;
            }
            if (!await lane.settleUnusedReservation(input)) return false;
            if (!await port.reconcilePending()) return false;
          }
          return true;
        },
      }),
      pollIntervalMs: config.pollIntervalMs,
      admit,
      status: (hash: string) => store.status(hash),
      async enqueue(path: string) {
        return admit(readBounded(path) as CrossDomainJob);
      },
      close() { walletApprovals?.close(); calendar?.close(); for (const port of ports) port.close(); store.close(); },
    };
  } catch (error) {
    calendar?.close();
    for (const port of ports) port.close();
    store.close();
    throw error;
  }
}
