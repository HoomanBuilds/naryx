import {
  packageQuoteShard,
  packageQuoteShardHash,
  prepareShardHeartbeat,
  prepareShardKillSwitch,
  prepareShardReprice,
  quoteReferenceState,
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
  | { readonly kind: 'KILLED'; readonly reason: 'STALE_REFERENCE' | 'INVENTORY_LIMIT' }
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
}): QuoteAutomation {
  const { policy } = options;
  if (policy.maxInventoryUtilizationBps <= 0 || policy.maxInventoryUtilizationBps > 10_000 || policy.heartbeatExtension <= policy.heartbeatLead || policy.maxReferenceAge <= 0n) {
    throw new TypeError('the policy needs a utilization limit in (0, 10000], an extension longer than its lead, and a positive reference age');
  }
  /** States this automation saw as current or published, and the fill size of each already folded into reserved capacity. */
  const watched = new Set<string>();
  const accounted = new Map<string, bigint>();
  const sign = async (unsigned: PackageQuoteShardInput): Promise<PackageQuoteShardInput> => {
    const hash = packageQuoteShardHash(unsigned);
    const signature = await options.signShard(hash);
    if (!(signature instanceof Uint8Array) || signature.length !== 64) throw new TypeError('the shard signer must return a 64-byte signature');
    watched.add(toHex(hash));
    return { ...unsigned, signature };
  };

  return {
    async tick() {
      const served = (await options.client.getShard(options.shardId)) as { shard?: PackageQuoteShardInput; shardHash?: string };
      if (served.shard === undefined) throw new NaryxEvidenceError('the shard read carried no shard');
      let shard: PackageQuoteShardInput = packageQuoteShard(served.shard);
      if (served.shardHash !== toHex(packageQuoteShardHash(shard))) throw new NaryxEvidenceError('the served shard does not match its hash');
      if (shard.killSwitchState === 'ACTIVE') return [{ kind: 'HALTED' }];
      const actions: QuoteAutomationAction[] = [];
      const kill = async (reason: 'STALE_REFERENCE' | 'INVENTORY_LIMIT') => {
        shard = await sign(prepareShardKillSwitch(shard, 'ACTIVE'));
        await options.client.killSwitch(shard);
        actions.push({ kind: 'KILLED', reason });
        return actions;
      };

      // Capital: settled fills are never offered again. Fills of the current state, and late fills of
      // any earlier state this automation watched, are folded into reserved capacity exactly once.
      const currentHash = toHex(packageQuoteShardHash(shard));
      watched.add(currentHash);
      const fills: readonly { readonly shardHash: string; readonly fill: ShardFillInput }[] = await options.client.getShardFills(options.shardId);
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
        shard = await sign({ ...shard, reservedCapacity, shardSequence: shard.shardSequence + 1n, signature: new Uint8Array(0) });
        await options.client.putShard(shard);
        for (const [hash, total] of folded) accounted.set(hash, total);
        actions.push({ kind: 'RESERVED', filledSize: filled, reservedCapacity });
      }
      if (shard.inventoryCap === 0n || shard.reservedCapacity * 10_000n >= shard.inventoryCap * BigInt(policy.maxInventoryUtilizationBps)) return kill('INVENTORY_LIMIT');

      // Reference: stale observations stop quoting; newer ones reprice every level at once.
      const reference = quoteReferenceState(await options.readReference());
      const now = options.now();
      if (reference.observedAtValue > now || now - reference.observedAtValue > policy.maxReferenceAge) return kill('STALE_REFERENCE');
      if (reference.referenceSequence > shard.referenceSequence) {
        shard = await sign(prepareShardReprice(shard, reference));
        await options.client.replaceShard(shard);
        actions.push({ kind: 'REPRICED', referenceSequence: reference.referenceSequence });
      }

      if (shard.heartbeatExpiry <= now + policy.heartbeatLead) {
        const heartbeatExpiry = now + policy.heartbeatExtension;
        shard = await sign(prepareShardHeartbeat(shard, heartbeatExpiry));
        await options.client.heartbeat(shard);
        actions.push({ kind: 'HEARTBEAT', heartbeatExpiry });
      }
      return actions;
    },
  };
}
