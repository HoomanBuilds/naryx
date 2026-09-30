import { closeSync, existsSync, fsyncSync, openSync, readFileSync, truncateSync, writeSync } from 'node:fs';
import { createPublicKey, verify } from 'node:crypto';
import {
  authorizeKeeperAction,
  keeperActionAuthorizationBytes,
  keeperActionAuthorizationHash,
  parseProtocolJson,
  stringifyProtocolJson,
  toHex,
  type ActivationConditionInput,
  type KeeperActionAuthorizationInput,
  type StrategyHealthSnapshotInput,
} from '@naryx/protocol-types';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** One owner-signed keeper authorization, with the condition and lifecycle graph it binds. */
export interface KeeperAutomationEntry {
  readonly authorization: KeeperActionAuthorizationInput;
  /** The strategy owner's Ed25519 public key and signature over the authorization bytes. */
  readonly ownerKey: Uint8Array;
  readonly ownerSignature: Uint8Array;
  readonly condition: ActivationConditionInput;
  readonly lifecycleGraphHash: string;
}

export interface KeeperActionPlan {
  readonly after: StrategyHealthSnapshotInput;
  readonly costQuoteAtoms: bigint;
  readonly rewardQuoteAtoms: bigint;
  readonly grantsAuthority: boolean;
}

/** What the keeper talks to. It never holds a trading key; the executor enforces its own gates too. */
export interface KeeperAutomationPorts {
  readHealth(strategyId: string): Promise<{ readonly before: StrategyHealthSnapshotInput; readonly stateHash: string; readonly manualTakeover: boolean } | undefined>;
  plan(entry: KeeperAutomationEntry, before: StrategyHealthSnapshotInput): Promise<KeeperActionPlan | undefined>;
  /** QUEUED means the executor re-authorized the action and queued it once for its domain runtime. */
  dispatch(action: { readonly keeperId: string; readonly authorizationHash: string; readonly entry: KeeperAutomationEntry; readonly plan: KeeperActionPlan }): Promise<'EXECUTED' | 'QUEUED' | 'REJECTED'>;
  now(unit: string): bigint | undefined;
}

export type KeeperPassStatus = 'SKIPPED_CONSUMED' | 'NOT_READY' | 'REJECTED' | 'EXECUTED' | 'QUEUED' | 'EXECUTOR_REJECTED' | 'FAILED';

/**
 * The durable record of every authorization a keeper dispatched. A nonce is consumed the moment
 * dispatch begins, before the executor answers, so a crash or a lost response can never lead to
 * a second execution of the same authorization.
 */
export class KeeperActionJournal {
  readonly #path: string;
  readonly #states = new Map<string, string>();

  constructor(path: string) {
    if (!path.startsWith('/')) throw new Error('the keeper action journal needs an absolute path');
    this.#path = path;
    if (existsSync(path)) {
      const lines = readFileSync(path, 'utf8').split('\n');
      for (const [index, line] of lines.entries()) {
        if (line.trim() === '') continue;
        let entry: { authorizationHash: string; state: string };
        try {
          entry = JSON.parse(line) as { authorizationHash: string; state: string };
        } catch (error) {
          // Only a final line torn by a crash mid-write is skipped: its fsync never completed, so no
          // dispatch followed it. Corruption anywhere earlier stops the keeper.
          if (!lines.slice(index + 1).every((rest) => rest.trim() === '')) throw error;
          // Cut the torn tail so later records start on a clean line and the next load stays valid.
          truncateSync(path, Buffer.byteLength(lines.slice(0, index).map((kept) => `${kept}\n`).join(''), 'utf8'));
          break;
        }
        this.#states.set(entry.authorizationHash, entry.state);
      }
    }
  }

  consumed(authorizationHash: string): boolean {
    return this.#states.has(authorizationHash);
  }

  state(authorizationHash: string): string | undefined {
    return this.#states.get(authorizationHash);
  }

  record(authorizationHash: string, state: 'DISPATCHING' | 'EXECUTED' | 'QUEUED' | 'EXECUTOR_REJECTED' | 'OUTCOME_UNKNOWN', detail = ''): void {
    const fd = openSync(this.#path, 'a', 0o600);
    try {
      writeSync(fd, `${JSON.stringify({ authorizationHash, state, detail, atMs: Date.now() })}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.#states.set(authorizationHash, state);
  }
}

function ownerSigned(entry: KeeperAutomationEntry): boolean {
  if (!(entry.ownerKey instanceof Uint8Array) || entry.ownerKey.length !== 32) return false;
  const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(entry.ownerKey)]), format: 'der', type: 'spki' });
  return verify(null, keeperActionAuthorizationBytes(entry.authorization), key, entry.ownerSignature);
}

/**
 * One pass over the configured authorizations. For each: the owner's signature must verify, the
 * nonce must be unconsumed, the strategy's observed health and state hash are read, the executor
 * projects the action, and the kernel decides with every bound (condition, cost, reward,
 * resulting risk, risk reduction, manual takeover, expiry). Only an authorized action is
 * dispatched, and its nonce is journaled as consumed before dispatch.
 */
export async function runKeeperAutomationPass(input: {
  readonly keeperId: string;
  readonly entries: readonly KeeperAutomationEntry[];
  readonly ports: KeeperAutomationPorts;
  readonly journal: KeeperActionJournal;
}): Promise<readonly { readonly strategyId: string; readonly authorizationHash?: string; readonly status: KeeperPassStatus; readonly detail?: string }[]> {
  const results = [];
  for (const entry of input.entries) {
    const strategyId = entry.authorization.strategyId;
    let authorizationHash: string;
    try {
      authorizationHash = toHex(keeperActionAuthorizationHash(entry.authorization));
      if (!ownerSigned(entry)) {
        results.push({ strategyId, authorizationHash, status: 'REJECTED' as const, detail: 'OWNER_SIGNATURE_INVALID' });
        continue;
      }
    } catch (error) {
      results.push({ strategyId, status: 'REJECTED' as const, detail: (error as Error).message });
      continue;
    }
    if (input.journal.consumed(authorizationHash)) {
      results.push({ strategyId, authorizationHash, status: 'SKIPPED_CONSUMED' as const });
      continue;
    }
    try {
      const at = input.ports.now(entry.authorization.expiryUnit);
      const health = await input.ports.readHealth(strategyId);
      if (at === undefined || health === undefined) {
        results.push({ strategyId, authorizationHash, status: 'NOT_READY' as const, detail: at === undefined ? 'TIME_UNIT_UNSUPPORTED' : 'HEALTH_UNAVAILABLE' });
        continue;
      }
      const plan = await input.ports.plan(entry, health.before);
      if (plan === undefined) {
        results.push({ strategyId, authorizationHash, status: 'NOT_READY' as const, detail: 'NO_PLAN' });
        continue;
      }
      const decision = authorizeKeeperAction(entry.authorization, {
        keeperId: input.keeperId,
        lifecycleGraphHash: entry.lifecycleGraphHash,
        condition: entry.condition,
        before: health.before,
        after: plan.after,
        currentStrategyStateHash: health.stateHash,
        costQuoteAtoms: plan.costQuoteAtoms,
        rewardQuoteAtoms: plan.rewardQuoteAtoms,
        grantsAuthority: plan.grantsAuthority,
        manualTakeover: health.manualTakeover,
        nonceConsumed: false,
        atValue: at,
      });
      if (!decision.authorized) {
        // An unmet condition simply waits for a later pass; every other rejection is reported.
        results.push({ strategyId, authorizationHash, status: decision.reason === 'CONDITION_NOT_MET' ? ('NOT_READY' as const) : ('REJECTED' as const), detail: decision.reason });
        continue;
      }
      input.journal.record(authorizationHash, 'DISPATCHING');
      let outcome: 'EXECUTED' | 'QUEUED' | 'REJECTED';
      try {
        outcome = await input.ports.dispatch({ keeperId: input.keeperId, authorizationHash, entry, plan });
      } catch (error) {
        // The executor may or may not have acted; the nonce stays consumed and the owner reconciles.
        input.journal.record(authorizationHash, 'OUTCOME_UNKNOWN', (error as Error).message);
        results.push({ strategyId, authorizationHash, status: 'FAILED' as const, detail: 'OUTCOME_UNKNOWN' });
        continue;
      }
      const state = outcome === 'REJECTED' ? ('EXECUTOR_REJECTED' as const) : outcome;
      input.journal.record(authorizationHash, state);
      results.push({ strategyId, authorizationHash, status: state });
    } catch (error) {
      results.push({ strategyId, authorizationHash, status: 'FAILED' as const, detail: (error as Error).message });
    }
  }
  return results;
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/**
 * Ports to a loopback executor: `GET /internal/keeper/strategies/{id}/health`,
 * `POST /internal/keeper/plan`, and `POST /internal/keeper/execute`. The executor re-checks the
 * owner signature and every bound against its own health view before it queues an action.
 */
export function httpKeeperPorts(executorOrigin: string, fetcher: Fetch = fetch as unknown as Fetch): Omit<KeeperAutomationPorts, 'now'> {
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?$/.test(executorOrigin)) throw new Error('the keeper executor must be a loopback origin');
  const call = async (method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> => {
    const response = await fetcher(`${executorOrigin}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: stringifyProtocolJson(body) }),
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`${path} answered HTTP ${response.status}`);
    return parseProtocolJson(await response.text());
  };
  return {
    async readHealth(strategyId) {
      return (await call('GET', `/internal/keeper/strategies/${encodeURIComponent(strategyId)}/health`)) as Awaited<ReturnType<KeeperAutomationPorts['readHealth']>>;
    },
    async plan(entry, before) {
      return (await call('POST', '/internal/keeper/plan', { authorization: entry.authorization, before })) as KeeperActionPlan | undefined;
    },
    async dispatch(action) {
      const answer = (await call('POST', '/internal/keeper/execute', {
        keeperId: action.keeperId,
        authorization: action.entry.authorization,
        ownerSignature: action.entry.ownerSignature,
        condition: action.entry.condition,
        lifecycleGraphHash: action.entry.lifecycleGraphHash,
      })) as { status?: string } | undefined;
      return answer?.status === 'EXECUTED' || answer?.status === 'QUEUED' ? answer.status : 'REJECTED';
    },
  };
}

/**
 * NARYX_KEEPER_AUTOMATION_CONFIG names an absolute protocol JSON file: `keeperId`,
 * `executorOrigin` (loopback), `intervalMs` (at least 5000), `journalPath` (absolute), and
 * `entries`. Keeper automation is off without it.
 */
export function loadKeeperAutomationConfig(
  environment: NodeJS.ProcessEnv,
  read: (path: string) => string,
): { readonly keeperId: string; readonly executorOrigin: string; readonly intervalMs: number; readonly journalPath: string; readonly entries: readonly KeeperAutomationEntry[] } | undefined {
  const path = environment.NARYX_KEEPER_AUTOMATION_CONFIG;
  if (path === undefined || path === '') return undefined;
  const fail = (message: string): never => {
    throw new Error(`Keeper automation configuration: ${message}`);
  };
  if (!path.startsWith('/')) fail('NARYX_KEEPER_AUTOMATION_CONFIG must be an absolute path');
  const raw = parseProtocolJson(read(path)) as Record<string, unknown>;
  if (typeof raw.keeperId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(raw.keeperId)) fail('keeperId is required');
  if (typeof raw.executorOrigin !== 'string' || !/^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?$/.test(raw.executorOrigin)) fail('executorOrigin must be a loopback origin');
  if (typeof raw.intervalMs !== 'number' || !Number.isSafeInteger(raw.intervalMs) || raw.intervalMs < 5_000) fail('intervalMs must be at least 5000');
  if (typeof raw.journalPath !== 'string' || !raw.journalPath.startsWith('/')) fail('journalPath must be absolute');
  if (!Array.isArray(raw.entries) || raw.entries.length === 0 || raw.entries.length > 256) fail('entries must list 1 to 256 authorizations');
  return Object.freeze({
    keeperId: raw.keeperId as string,
    executorOrigin: raw.executorOrigin as string,
    intervalMs: raw.intervalMs as number,
    journalPath: raw.journalPath as string,
    entries: raw.entries as KeeperAutomationEntry[],
  });
}
