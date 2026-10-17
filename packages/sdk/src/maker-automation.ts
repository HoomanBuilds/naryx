import {
  packageQuoteShard,
  packageQuoteShardHash,
  prepareShardHeartbeat,
  prepareShardKillSwitch,
  prepareShardReprice,
  quoteReferenceState,
  quoteReferenceStateHash,
  toHex,
  type PackageQuoteShardInput,
  type QuoteReferenceStateInput,
  type ShardFillInput,
} from '@naryx/protocol-types';
import { NaryxEvidenceError } from './client.js';
import type { NaryxSolverClient } from './solver-client.js';

/** The maker's risk controls. Times are in the unit of the shard's levels and heartbeat. */
export interface QuoteAutomationPolicy {
  /** A reference observed longer ago than this stops quoting: the shard's kill switch is set. */
  readonly maxReferenceAge: bigint;
  /** Heartbeat once no more than this remains before the shard expires. */
  readonly heartbeatLead: bigint;
  /** Each heartbeat extends the shard to now plus this. */
  readonly heartbeatExtension: bigint;
  /** Stop quoting once reserved capacity reaches this share of the inventory cap, in basis points. */
  readonly maxInventoryUtilizationBps: number;
}

export type QuoteAutomationAction =
  | { readonly kind: 'HALTED' }
  | { readonly kind: 'RESERVED'; readonly filledSize: bigint; readonly reservedCapacity: bigint }
  | { readonly kind: 'KILLED'; readonly reason: 'STALE_REFERENCE' | 'INVENTORY_LIMIT' | 'UNTRACKED_FILLS' | 'EXPIRED_QUOTES' | 'REFERENCE_CLOCK' | 'REFERENCE_BINDING' }
  | { readonly kind: 'QUOTES_RENEWED'; readonly levelCount: number }
  | { readonly kind: 'REPRICED'; readonly referenceSequence: bigint }
  | { readonly kind: 'HEARTBEAT'; readonly heartbeatExpiry: bigint };

export interface QuoteAutomation {
  /**
   * One pass: read the shard and its settled fills, carry fills of the current signed state into
   * reserved capacity, stop quoting on an inventory or reference breach, reprice to a newer
   * reference, and heartbeat when due. Each change is signed by the caller's signer and published
   * before the next is prepared, so a failed step leaves the last published state in force.
   */
  tick(): Promise<readonly QuoteAutomationAction[]>;
}

export interface QuoteAutomationCheckpoint {
  readonly version: 1;
  readonly shardId: string;
  readonly watchedHashes: readonly string[];
  readonly accountedFills: readonly { readonly shardHash: string; readonly size: bigint }[];
  readonly pending?: { readonly previousShardHash: string; readonly shard: PackageQuoteShardInput;
    readonly foldedFills: readonly { readonly shardHash: string; readonly size: bigint }[] };
}

/**
 * Quote automation for one shard. It holds no key: every shard state is signed through `signShard`.
 * A shard whose kill switch is set is left alone; re-arming it is a deliberate human action.
 */
export function createQuoteAutomation(options: {
  readonly client: Pick<NaryxSolverClient, 'getShard' | 'getShardFills' | 'putShard' | 'replaceShard' | 'heartbeat' | 'killSwitch'>;
  readonly shardId: string;
  readonly policy: QuoteAutomationPolicy;
  readonly readReference: () => Promise<QuoteReferenceStateInput>;
  readonly now: () => bigint;
  readonly signShard: (shardHash: Uint8Array) => Promise<Uint8Array>;
  readonly checkpointStore?: { load(): Promise<QuoteAutomationCheckpoint | undefined>; save(checkpoint: QuoteAutomationCheckpoint): Promise<void> };
  readonly refreshLevels?: (shard: PackageQuoteShardInput, reference: QuoteReferenceStateInput, now: bigint) => Promise<PackageQuoteShardInput['quoteLevels']>;
}): QuoteAutomation {
  const { policy } = options;
  if (!Number.isInteger(policy.maxInventoryUtilizationBps) || policy.maxInventoryUtilizationBps <= 0 || policy.maxInventoryUtilizationBps > 10_000
    || policy.heartbeatLead < 0n || policy.heartbeatExtension <= policy.heartbeatLead || policy.maxReferenceAge <= 0n) {
    throw new TypeError('the policy needs a utilization limit in (0, 10000], an extension longer than its lead, and a positive reference age');
  }
  /** States this automation saw as current or published, and the fill size of each already folded into reserved capacity. */
  const watched = new Set<string>();
  const accounted = new Map<string, bigint>();
  let pending: QuoteAutomationCheckpoint['pending'];
  let loaded = false;
  let ticking = false;
  const save = async () => options.checkpointStore?.save({ version: 1, shardId: options.shardId,
    watchedHashes: [...watched], accountedFills: [...accounted].map(([shardHash, size]) => ({ shardHash, size })),
    ...(pending === undefined ? {} : { pending }) });
  const sign = async (unsigned: PackageQuoteShardInput): Promise<PackageQuoteShardInput> => {
    const hash = packageQuoteShardHash(unsigned);
    const signature = await options.signShard(hash);
    if (!(signature instanceof Uint8Array) || signature.length !== 64) throw new TypeError('the shard signer must return a 64-byte signature');
    watched.add(toHex(hash));
    return { ...unsigned, signature };
  };

  const tick = async (): Promise<readonly QuoteAutomationAction[]> => {
      if (!loaded) {
        const checkpoint = await options.checkpointStore?.load();
        if (checkpoint !== undefined) {
          const validHash = (hash: string) => /^[0-9a-f]{64}$/.test(hash);
          if (checkpoint.version !== 1 || checkpoint.shardId !== options.shardId
            || !checkpoint.watchedHashes.every(validHash)
            || new Set(checkpoint.watchedHashes).size !== checkpoint.watchedHashes.length
            || new Set(checkpoint.accountedFills.map((fill) => fill.shardHash)).size !== checkpoint.accountedFills.length
            || checkpoint.accountedFills.some((fill) => !validHash(fill.shardHash) || !checkpoint.watchedHashes.includes(fill.shardHash)
              || typeof fill.size !== 'bigint' || fill.size < 0n || fill.size >= 1n << 128n)) throw new NaryxEvidenceError('maker checkpoint is invalid');
          for (const hash of checkpoint.watchedHashes) watched.add(hash);
          for (const fill of checkpoint.accountedFills) accounted.set(fill.shardHash, fill.size);
          pending = checkpoint.pending;
          if (pending !== undefined && (!validHash(pending.previousShardHash)
            || !watched.has(toHex(packageQuoteShardHash(pending.shard)))
            || pending.foldedFills.some((fill) => !watched.has(fill.shardHash) || typeof fill.size !== 'bigint'
              || fill.size < (accounted.get(fill.shardHash) ?? 0n) || fill.size >= 1n << 128n))) throw new NaryxEvidenceError('maker pending checkpoint is invalid');
        }
        loaded = true;
      }
      const served = (await options.client.getShard(options.shardId)) as { shard?: PackageQuoteShardInput; shardHash?: string };
      if (served.shard === undefined) throw new NaryxEvidenceError('the shard read carried no shard');
      let shard: PackageQuoteShardInput = packageQuoteShard(served.shard);
      if (served.shardHash !== toHex(packageQuoteShardHash(shard))) throw new NaryxEvidenceError('the served shard does not match its hash');
      if (`${shard.templateId}.${shard.marketGroupId}` !== options.shardId) throw new NaryxEvidenceError('the served shard identity differs');
      if (pending !== undefined) {
        const next = packageQuoteShard(pending.shard);
        if (`${next.templateId}.${next.marketGroupId}` !== options.shardId) throw new NaryxEvidenceError('the pending shard identity differs');
        const nextHash = toHex(packageQuoteShardHash(next));
        if (served.shardHash === pending.previousShardHash) await options.client.putShard(next);
        else if (served.shardHash !== nextHash) throw new NaryxEvidenceError('maker state changed outside the pending update');
        shard = next;
        for (const fill of pending.foldedFills) accounted.set(fill.shardHash, fill.size);
        pending = undefined;
        await save();
      }
      if (shard.killSwitchState === 'ACTIVE') return [{ kind: 'HALTED' }];
      const actions: QuoteAutomationAction[] = [];
      const publish = async (unsigned: PackageQuoteShardInput, method: 'putShard' | 'replaceShard' | 'heartbeat' | 'killSwitch', folded: readonly [string, bigint][] = []) => {
        const next = await sign(unsigned);
        pending = { previousShardHash: toHex(packageQuoteShardHash(shard)), shard: next,
          foldedFills: folded.map(([shardHash, size]) => ({ shardHash, size })) };
        await save();
        await options.client[method](next);
        shard = next;
        for (const [hash, size] of folded) accounted.set(hash, size);
        pending = undefined;
        await save();
      };
      const kill = async (reason: Extract<QuoteAutomationAction, { kind: 'KILLED' }>['reason']) => {
        await publish(prepareShardKillSwitch(shard, 'ACTIVE'), 'killSwitch');
        actions.push({ kind: 'KILLED', reason });
        return actions;
      };

      // Capital: settled fills are never offered again. Fills of the current state, and late fills of
      // any earlier state this automation watched, are folded into reserved capacity exactly once.
      const currentHash = toHex(packageQuoteShardHash(shard));
      watched.add(currentHash);
      const fills: readonly { readonly shardHash: string; readonly fill: ShardFillInput }[] = await options.client.getShardFills(options.shardId);
      if (fills.some((entry) => !watched.has(entry.shardHash))) return kill('UNTRACKED_FILLS');
      const totals = new Map<string, bigint>();
      for (const entry of fills) totals.set(entry.shardHash, (totals.get(entry.shardHash) ?? 0n) + entry.fill.size);
      const folded: [string, bigint][] = [];
      let filled = 0n;
      for (const [hash, total] of totals) {
        if (!watched.has(hash)) continue;
        const prior = accounted.get(hash) ?? 0n;
        if (total > prior) {
          filled += total - prior;
          folded.push([hash, total]);
        }
      }
      if (filled > 0n) {
        const reservedCapacity = shard.reservedCapacity + filled > shard.inventoryCap ? shard.inventoryCap : shard.reservedCapacity + filled;
        await publish({ ...shard, reservedCapacity, shardSequence: shard.shardSequence + 1n, signature: new Uint8Array(0) }, 'putShard', folded);
        actions.push({ kind: 'RESERVED', filledSize: filled, reservedCapacity });
      }
      if (shard.inventoryCap === 0n || shard.reservedCapacity * 10_000n >= shard.inventoryCap * BigInt(policy.maxInventoryUtilizationBps)) return kill('INVENTORY_LIMIT');

      // Reference: stale observations stop quoting; newer ones reprice every level at once.
      const reference = quoteReferenceState(await options.readReference());
      const now = options.now();
      if (reference.environment !== shard.environment || reference.marketGroupId !== shard.marketGroupId
        || reference.referenceSequence < shard.referenceSequence
        || (reference.referenceSequence === shard.referenceSequence && toHex(quoteReferenceStateHash(reference)) !== toHex(packageQuoteShard(shard).referenceStateHash))) return kill('REFERENCE_BINDING');
      if (shard.quoteLevels.some((level) => level.validUntilUnit !== reference.observedAtUnit)) return kill('REFERENCE_CLOCK');
      if (reference.observedAtValue > now || now - reference.observedAtValue > policy.maxReferenceAge) return kill('STALE_REFERENCE');
      if (reference.referenceSequence > shard.referenceSequence) {
        await publish(prepareShardReprice(shard, reference), 'replaceShard');
        actions.push({ kind: 'REPRICED', referenceSequence: reference.referenceSequence });
      }

      if (shard.quoteLevels.some((level) => level.validUntilValue <= now + policy.heartbeatLead)) {
        if (options.refreshLevels !== undefined) {
          const quoteLevels = await options.refreshLevels(shard, reference, now);
          if (quoteLevels.length === 0 || quoteLevels.some((level) => level.validUntilUnit !== reference.observedAtUnit
            || level.validUntilValue <= now + policy.heartbeatLead)) return kill('EXPIRED_QUOTES');
          await publish({ ...shard, quoteLevels, shardSequence: shard.shardSequence + 1n, signature: new Uint8Array(0) }, 'putShard');
          actions.push({ kind: 'QUOTES_RENEWED', levelCount: quoteLevels.length });
        } else if (shard.quoteLevels.some((level) => level.validUntilValue <= now)) return kill('EXPIRED_QUOTES');
      }

      if (shard.heartbeatExpiry <= now + policy.heartbeatLead) {
        const heartbeatExpiry = now + policy.heartbeatExtension;
        await publish(prepareShardHeartbeat(shard, heartbeatExpiry), 'heartbeat');
        actions.push({ kind: 'HEARTBEAT', heartbeatExpiry });
      }
      await save();
      return actions;
  };
  return {
    async tick() {
      if (ticking) throw new NaryxEvidenceError('maker automation tick is already running');
      ticking = true;
      try { return await tick(); }
      finally { ticking = false; }
    },
  };
}
