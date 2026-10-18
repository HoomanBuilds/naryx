import { hashTypedData, keccak256, toHex as hex, verifyTypedData } from 'viem';
import {
  mulDiv, ROUNDING, nettingPolicyManifest, nettingPolicyManifestHash, parseProtocolJson,
  stringifyProtocolJson, toHex, verifyNettingResultAgainstPolicy, verifyNettingFinalAllocationReceipt,
  verifyNettingExternalExecutionIntent, verifyNettingExternalExecutionEvidence,
  type NettingPolicyManifest, type NettingResult, type NettingExternalExecutionIntent,
  type NettingExternalExecutionEvidence, type NettingFinalAllocationReceipt,
} from '@naryx/protocol-types';
import { poolBindingHash, verifyPoolFlatEvidence, type HyperliquidPoolFundingReadPort } from './hyperliquid-pool-funding.js';
import { HyperliquidPooledCollateralStore, type HyperliquidPoolBinding } from './hyperliquid-pooled-collateral-store.js';

const ADDRESS = /^0x(?!0{40}$)[0-9a-f]{40}$/;
const HASH = /^0x(?!0{64}$)[0-9a-f]{64}$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const MAX = (1n << 128n) - 1n;

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Pool epoch: ${message}`);
}
function digest(value: unknown): `0x${string}` { return keccak256(hex(stringifyProtocolJson(value))); }
function equal(left: unknown, right: unknown): boolean { return stringifyProtocolJson(left) === stringifyProtocolJson(right); }
function abs(value: bigint): bigint { return value < 0n ? -value : value; }

export interface HyperliquidPoolEpochMandate {
  readonly owner: `0x${string}`;
  readonly role: 'TRADER' | 'RECOVERY_SPONSOR';
  readonly maximumLossQuoteAtoms: bigint;
  readonly maximumFeeQuoteAtoms: bigint;
}

export interface HyperliquidPoolEpochPlan {
  readonly id: string;
  readonly entryPolicy: NettingPolicyManifest;
  readonly exitPolicy: NettingPolicyManifest;
  readonly entry: NettingResult;
  readonly entryDeadlineMs: number;
  readonly closeAfterMs: number;
  readonly mandates: readonly HyperliquidPoolEpochMandate[];
}

export function poolEpochPolicyHash(entry: NettingPolicyManifest, exit: NettingPolicyManifest): `0x${string}` {
  return digest({ version: 1, closeAllocation: 'PRO_RATA_OBSERVED_COST', entryAbortAllocation: 'RECOVERY_SPONSOR',
    entryPolicyHash: toHex(nettingPolicyManifestHash(entry)), exitPolicyHash: toHex(nettingPolicyManifestHash(exit)) });
}

export function poolEpochPlanHash(plan: HyperliquidPoolEpochPlan): `0x${string}` {
  return digest({ version: 1, closeAllocation: 'PRO_RATA_OBSERVED_COST', entryAbortAllocation: 'RECOVERY_SPONSOR',
    id: plan.id, entryPolicyHash: toHex(nettingPolicyManifestHash(plan.entryPolicy)),
    exitPolicyHash: toHex(nettingPolicyManifestHash(plan.exitPolicy)), entryProofHash: toHex(plan.entry.proofHash),
    entryDeadlineMs: plan.entryDeadlineMs, closeAfterMs: plan.closeAfterMs,
    mandates: [...plan.mandates].sort((a, b) => a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0)
      .map(row => ({ owner: row.owner, role: row.role, maximumLossQuoteAtoms: row.maximumLossQuoteAtoms,
        maximumFeeQuoteAtoms: row.maximumFeeQuoteAtoms })) });
}

export function poolEpochTypedData(binding: HyperliquidPoolBinding, plan: HyperliquidPoolEpochPlan, owner: `0x${string}`) {
  return { domain: { name: 'Naryx Custodial Testnet Pool', version: '1', chainId: 421614, verifyingContract: binding.poolAccount },
    types: { PoolEpoch: [{ name: 'owner', type: 'address' }, { name: 'pool', type: 'address' },
      { name: 'bindingHash', type: 'bytes32' }, { name: 'planHash', type: 'bytes32' }] }, primaryType: 'PoolEpoch',
    message: { owner, pool: binding.poolAccount, bindingHash: poolBindingHash(binding), planHash: poolEpochPlanHash(plan) } } as const;
}

export interface HyperliquidPoolEpochLegEvidence {
  readonly result: NettingResult;
  readonly intents: readonly NettingExternalExecutionIntent[];
  readonly evidence: readonly NettingExternalExecutionEvidence[];
  readonly receipt: NettingFinalAllocationReceipt;
}

export interface HyperliquidPoolCumulativeClose {
  readonly kind: 'CUMULATIVE_REDUCE_ONLY_CLOSE';
  readonly result: NettingResult;
  readonly attempts: readonly { result: NettingResult; intent: NettingExternalExecutionIntent;
    evidence: NettingExternalExecutionEvidence }[];
}

export interface HyperliquidPoolEpochClosure {
  readonly account: `0x${string}`;
  readonly environment: 'TESTNET';
  readonly openedAtMs: number;
  readonly closedAtMs: number;
  readonly entry: HyperliquidPoolEpochLegEvidence;
  readonly exit: HyperliquidPoolEpochLegEvidence | HyperliquidPoolCumulativeClose;
  readonly funding: readonly { hash: `0x${string}`; instrumentId: string; timeMs: number;
    netPositionAtoms: bigint; quoteDeltaAtoms: bigint }[];
}

export interface HyperliquidPoolEpochExecutionPort {
  enter(plan: HyperliquidPoolEpochPlan): Promise<void>;
  close(plan: HyperliquidPoolEpochPlan): Promise<void>;
  closure(plan: HyperliquidPoolEpochPlan): Promise<HyperliquidPoolEpochClosure | undefined>;
  recover(plan: HyperliquidPoolEpochPlan): Promise<HyperliquidPoolEpochRecovery | undefined>;
}

export interface HyperliquidPoolEpochRecovery {
  readonly environment: 'TESTNET';
  readonly account: `0x${string}`;
  readonly closedAtMs: number;
  readonly cashDeltaQuoteAtoms: bigint;
  readonly feeQuoteAtoms: bigint;
  readonly evidenceHash: `0x${string}`;
}

function validatePlan(binding: HyperliquidPoolBinding, plan: HyperliquidPoolEpochPlan): void {
  check(ID.test(plan.id) && Number.isSafeInteger(plan.entryDeadlineMs) && plan.entryDeadlineMs > 0
    && Number.isSafeInteger(plan.closeAfterMs) && plan.closeAfterMs > plan.entryDeadlineMs
    && plan.closeAfterMs - plan.entryDeadlineMs <= 300_000, 'invalid epoch identity or window');
  const entryPolicy = nettingPolicyManifest(plan.entryPolicy);
  const exitPolicy = nettingPolicyManifest(plan.exitPolicy);
  check(binding.policyHash === poolEpochPolicyHash(entryPolicy, exitPolicy), 'execution policies differ from the immutable pool');
  verifyNettingResultAgainstPolicy(plan.entry, entryPolicy);
  check(entryPolicy.environment === 'testnet' && exitPolicy.environment === 'testnet'
    && entryPolicy.settlementClass === 'BATCHED_IOC_WITH_RECOVERY'
    && exitPolicy.settlementClass === 'BATCHED_IOC_WITH_RECOVERY'
    && entryPolicy.instruments.length > 0 && entryPolicy.instruments.length <= 8
    && entryPolicy.instruments.length === exitPolicy.instruments.length, 'invalid pooled execution policies');
  for (const instrument of entryPolicy.instruments) {
    const exit = exitPolicy.instruments.find(row => row.instrumentId === instrument.instrumentId);
    check(equal(instrument.domain, binding.domain) && equal(instrument.quoteAsset, binding.quoteAsset)
      && instrument.legFamily === 'PERP_OPEN' && exit !== undefined && exit.legFamily === 'PERP_CLOSE'
      && equal({ ...instrument, instrumentHash: undefined, legFamily: undefined },
        { ...exit, instrumentHash: undefined, legFamily: undefined }), 'entry and reduce-only close instruments differ');
  }
  check(Array.isArray(plan.mandates) && plan.mandates.length >= 2 && plan.mandates.length <= 64
    && new Set(plan.mandates.map(row => row.owner)).size === plan.mandates.length, 'distinct owner mandates are required');
  for (const mandate of plan.mandates) {
    check(ADDRESS.test(mandate.owner) && mandate.owner !== binding.poolAccount
      && (binding.version === 2 || binding.dedicatedTestOwners.includes(mandate.owner))
      && (mandate.role === 'TRADER' || mandate.role === 'RECOVERY_SPONSOR')
      && typeof mandate.maximumLossQuoteAtoms === 'bigint' && mandate.maximumLossQuoteAtoms > 0n && mandate.maximumLossQuoteAtoms <= MAX
      && typeof mandate.maximumFeeQuoteAtoms === 'bigint' && mandate.maximumFeeQuoteAtoms >= 0n
      && mandate.maximumFeeQuoteAtoms <= mandate.maximumLossQuoteAtoms, 'invalid funded owner mandate');
  }
  const traders = plan.mandates.filter(row => row.role === 'TRADER');
  check(traders.length >= 2 && plan.mandates.filter(row => row.role === 'RECOVERY_SPONSOR').length === 1
    && plan.entry.allocations.length > 0 && plan.entry.allocations.length <= 512
    && plan.entry.allocations.every(row => traders.some(owner => owner.owner === row.ownerId))
    && traders.every(owner => plan.entry.allocations.some(row => row.ownerId === owner.owner)), 'entry must cover exactly the trading owners');
  for (const trader of traders) {
    let gross = 0n;
    for (const row of plan.entry.allocations.filter(row => row.ownerId === trader.owner)) {
      const instrument = entryPolicy.instruments.find(item => item.instrumentId === row.instrumentId)!;
      gross += abs(row.signedQuantityAtoms) / instrument.quantityIncrementAtoms * row.limitPriceTicks * instrument.priceTickQuoteAtoms;
    }
    check(gross > 0n && gross <= trader.maximumLossQuoteAtoms * 5n, 'owner gross exposure exceeds five times its loss reservation');
  }
}

function exitProofs(exit: HyperliquidPoolEpochClosure['exit']) {
  return 'kind' in exit ? exit.attempts.map(row => row.evidence) : exit.evidence;
}

function executionTimeline(closure: HyperliquidPoolEpochClosure) {
  const rows = (leg: HyperliquidPoolEpochLegEvidence) => leg.evidence.map(proof => ({ proof,
    instrument: leg.intents.find(intent => equal(intent.intentHash, proof.intentHash))!.instrumentId }));
  return [...rows(closure.entry), ...('kind' in closure.exit
    ? closure.exit.attempts.map(row => ({ proof: row.evidence, instrument: row.intent.instrumentId })) : rows(closure.exit))];
}

export function poolCumulativeCloseAllocations(plan: HyperliquidPoolEpochPlan, exit: HyperliquidPoolCumulativeClose) {
  check(exit.kind === 'CUMULATIVE_REDUCE_ONLY_CLOSE' && exit.attempts.length <= 256, 'invalid cumulative close');
  verifyNettingResultAgainstPolicy(exit.result, plan.exitPolicy);
  const remaining = new Map(exit.result.underlyings.map(row => [row.instrumentId, row.externalNetAtoms]));
  const totals = new Map(exit.result.underlyings.map(row => [row.instrumentId, { gross: 0n, fees: 0n }]));
  const ids = new Set<string>();
  for (const attempt of exit.attempts) {
    verifyNettingResultAgainstPolicy(attempt.result, plan.exitPolicy);
    verifyNettingExternalExecutionIntent(attempt.intent, attempt.result, plan.exitPolicy);
    verifyNettingExternalExecutionEvidence(attempt.evidence, attempt.intent);
    const id = toHex(attempt.intent.intentHash);
    const prior = remaining.get(attempt.intent.instrumentId);
    const requested = attempt.intent.side === 'BUY' ? attempt.intent.quantityAtoms : -attempt.intent.quantityAtoms;
    check(!ids.has(id) && prior !== undefined && prior !== 0n && requested === prior,
      'close retry repeats or exceeds remaining exposure');
    ids.add(id);
    remaining.set(attempt.intent.instrumentId, prior - attempt.evidence.filledSignedQuantityAtoms);
    const total = totals.get(attempt.intent.instrumentId)!;
    total.gross += attempt.evidence.grossQuoteAtoms;
    total.fees += attempt.evidence.feeQuoteAtoms;
  }
  check([...remaining.values()].every(value => value === 0n), 'cumulative close is incomplete');
  const shares = new Map<string, { gross: bigint; fees: bigint }>();
  for (const [instrument, total] of totals) {
    const lines = exit.result.allocations.filter(row => row.instrumentId === instrument && row.externalQuantityAtoms !== 0n);
    const weight = lines.reduce((sum, row) => sum + abs(row.externalQuantityAtoms), 0n);
    check(weight !== 0n || total.gross === 0n && total.fees === 0n, 'unexpected external close cost');
    if (weight === 0n) continue;
    const parts = lines.map(row => ({ id: toHex(row.obligationId),
      gross: total.gross * abs(row.externalQuantityAtoms) / weight, fees: total.fees * abs(row.externalQuantityAtoms) / weight }));
    let gross = total.gross - parts.reduce((sum, row) => sum + row.gross, 0n);
    let fees = total.fees - parts.reduce((sum, row) => sum + row.fees, 0n);
    for (const part of parts) {
      if (gross > 0n) { part.gross++; gross--; }
      if (fees > 0n) { part.fees++; fees--; }
      shares.set(part.id, part);
    }
    check(gross === 0n && fees === 0n, 'close allocation did not conserve cash');
  }
  return exit.result.allocations.map(row => {
    const part = shares.get(toHex(row.obligationId)) ?? { gross: 0n, fees: 0n };
    return { ownerId: row.ownerId, instrumentId: row.instrumentId, totalQuantityAtoms: row.signedQuantityAtoms,
      externalFeeQuoteAtoms: part.fees,
      totalQuoteDeltaAtoms: row.internalQuoteDeltaAtoms + (row.externalQuantityAtoms > 0n ? -part.gross : part.gross) - part.fees };
  });
}

function checkEvidence(plan: HyperliquidPoolEpochPlan, closure: HyperliquidPoolEpochClosure, binding: HyperliquidPoolBinding): void {
  check(closure.environment === 'TESTNET' && closure.account === binding.poolAccount
    && Number.isSafeInteger(closure.openedAtMs) && closure.openedAtMs > 0 && closure.openedAtMs <= plan.entryDeadlineMs
    && Number.isSafeInteger(closure.closedAtMs) && closure.closedAtMs >= closure.openedAtMs, 'closure identity or time differs');
  check(equal(closure.entry.result, plan.entry), 'closure substituted the signed entry');
  verifyNettingFinalAllocationReceipt(closure.entry.receipt, closure.entry.result, plan.entryPolicy, closure.entry.intents, closure.entry.evidence);
  if ('kind' in closure.exit) poolCumulativeCloseAllocations(plan, closure.exit);
  else verifyNettingFinalAllocationReceipt(closure.exit.receipt, closure.exit.result, plan.exitPolicy, closure.exit.intents, closure.exit.evidence);
  const references = new Set<string>();
  for (const [proofs, start, end] of [[closure.entry.evidence, closure.openedAtMs, plan.entryDeadlineMs],
    [exitProofs(closure.exit), closure.openedAtMs, closure.closedAtMs]] as const) {
    for (const proof of proofs) {
      const reference = toHex(proof.executionReferenceHash);
      check(!references.has(reference) && proof.submittedAtUnit === 'HYPERLIQUID_UNIX_MILLISECONDS'
        && proof.observedAtUnit === 'HYPERLIQUID_UNIX_MILLISECONDS' && proof.submittedAtValue >= BigInt(start)
        && proof.submittedAtValue <= BigInt(end) && proof.observedAtValue <= BigInt(closure.closedAtMs),
      'external evidence is repeated or outside the epoch');
      references.add(reference);
    }
  }
}

export function reconcileHyperliquidPoolEpoch(binding: HyperliquidPoolBinding, plan: HyperliquidPoolEpochPlan,
  closure: HyperliquidPoolEpochClosure, initialEquity: bigint, finalEquity: bigint,
) {
  validatePlan(binding, plan);
  checkEvidence(plan, closure, binding);
  const traders = plan.mandates.filter(row => row.role === 'TRADER').sort((a, b) => a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0);
  const balances = new Map(traders.map(row => [row.owner as string, { pnl: 0n, fee: 0n, funding: 0n, positions: new Map<string, bigint>() }]));
  const opening = new Map<string, Map<string, bigint>>();
  const closing = 'kind' in closure.exit ? poolCumulativeCloseAllocations(plan, closure.exit) : closure.exit.receipt.allocations;
  for (const [index, allocations] of [closure.entry.receipt.allocations, closing].entries()) {
    for (const allocation of allocations) {
      const owner = balances.get(allocation.ownerId);
      check(owner !== undefined, 'receipt contains an unauthorized owner');
      owner.pnl += allocation.totalQuoteDeltaAtoms;
      owner.fee += allocation.externalFeeQuoteAtoms;
      owner.positions.set(allocation.instrumentId, (owner.positions.get(allocation.instrumentId) ?? 0n) + allocation.totalQuantityAtoms);
      if (index === 0) {
        const positions = opening.get(allocation.instrumentId) ?? new Map<string, bigint>();
        positions.set(allocation.ownerId, (positions.get(allocation.ownerId) ?? 0n) + allocation.totalQuantityAtoms);
        opening.set(allocation.instrumentId, positions);
      }
    }
  }
  check([...balances.values()].every(row => [...row.positions.values()].every(value => value === 0n)),
    'every owner position must close, not just the net venue position');
  check(Array.isArray(closure.funding) && closure.funding.length <= 1_024, 'funding evidence exceeds the bound');
  const fundingIds = new Set<string>();
  for (const event of closure.funding) {
    const positions = opening.get(event.instrumentId);
    const net = positions === undefined ? 0n : [...positions.values()].reduce((sum, qty) => sum + qty, 0n);
    const relevant = executionTimeline(closure).filter(row => row.instrument === event.instrumentId);
    check(relevant.every(row => BigInt(event.timeMs) < row.proof.submittedAtValue || BigInt(event.timeMs) > row.proof.observedAtValue),
      'funding overlaps an unresolved execution interval');
    const held = relevant.filter(row => row.proof.observedAtValue < BigInt(event.timeMs))
      .reduce((sum, row) => sum + row.proof.filledSignedQuantityAtoms, 0n);
    check(HASH.test(event.hash) && !fundingIds.has(event.hash) && positions !== undefined && net !== 0n
      && event.netPositionAtoms === held && typeof event.quoteDeltaAtoms === 'bigint' && abs(event.quoteDeltaAtoms) <= MAX
      && Number.isSafeInteger(event.timeMs) && event.timeMs >= closure.openedAtMs && event.timeMs <= closure.closedAtMs,
    'funding does not bind the held net position');
    fundingIds.add(event.hash);
    const shares = traders.map(trader => ({ owner: trader.owner,
      share: mulDiv(event.quoteDeltaAtoms, positions.get(trader.owner) ?? 0n, net, ROUNDING.FLOOR) }));
    let remainder = event.quoteDeltaAtoms - shares.reduce((sum, row) => sum + row.share, 0n);
    for (const row of shares) {
      if (remainder > 0n && (positions.get(row.owner) ?? 0n) !== 0n) { row.share++; remainder--; }
      balances.get(row.owner)!.funding += row.share;
    }
    check(remainder === 0n, 'funding rounding did not conserve cash');
  }
  const raw = traders.map(trader => {
    const value = balances.get(trader.owner)!;
    return { owner: trader.owner, pnlQuoteAtoms: value.pnl + value.funding };
  });
  check(initialEquity >= 0n && finalEquity >= 0n && initialEquity <= MAX && finalEquity <= MAX
    && initialEquity + raw.reduce((sum, row) => sum + row.pnlQuoteAtoms, 0n) === finalEquity,
  'closed positions, fees and funding do not reconcile to venue equity');
  let recoveryLoss = 0n;
  let recoveryFees = 0n;
  const allocations = raw.map(row => {
    const mandate = traders.find(trader => trader.owner === row.owner)!;
    const excessFee = balances.get(row.owner)!.fee > mandate.maximumFeeQuoteAtoms
      ? balances.get(row.owner)!.fee - mandate.maximumFeeQuoteAtoms : 0n;
    recoveryFees += excessFee;
    const net = row.pnlQuoteAtoms + excessFee;
    const pnlQuoteAtoms = net < -mandate.maximumLossQuoteAtoms ? -mandate.maximumLossQuoteAtoms : net;
    recoveryLoss += pnlQuoteAtoms - row.pnlQuoteAtoms;
    return { ...row, pnlQuoteAtoms };
  });
  const sponsor = plan.mandates.find(row => row.role === 'RECOVERY_SPONSOR');
  check(recoveryLoss === 0n || sponsor !== undefined && recoveryLoss <= sponsor.maximumLossQuoteAtoms,
    'recovery reserve exhausted; pool remains locked for recapitalization');
  check(recoveryFees === 0n || sponsor !== undefined && recoveryFees <= sponsor.maximumFeeQuoteAtoms,
    'recovery fee authority exhausted; pool remains locked');
  if (sponsor !== undefined) allocations.push({ owner: sponsor.owner, pnlQuoteAtoms: -recoveryLoss });
  return { allocations, recoveryLossQuoteAtoms: recoveryLoss, evidenceHash: digest({ planHash: poolEpochPlanHash(plan), closure, initialEquity, finalEquity }) };
}

export class HyperliquidPoolEpochService {
  readonly store: HyperliquidPooledCollateralStore;
  readonly reads: HyperliquidPoolFundingReadPort;
  readonly execution: HyperliquidPoolEpochExecutionPort;
  readonly clock: () => number;

  constructor(store: HyperliquidPooledCollateralStore, reads: HyperliquidPoolFundingReadPort,
    execution: HyperliquidPoolEpochExecutionPort, clock = Date.now) {
    this.store = store; this.reads = reads; this.execution = execution; this.clock = clock;
  }

  async prepare(plan: HyperliquidPoolEpochPlan, authorizations: readonly { owner: `0x${string}`; signature: `0x${string}` }[]): Promise<void> {
    plan = parseProtocolJson(stringifyProtocolJson(plan)) as HyperliquidPoolEpochPlan;
    authorizations = parseProtocolJson(stringifyProtocolJson(authorizations)) as typeof authorizations;
    validatePlan(this.store.binding, plan);
    check(plan.entryDeadlineMs > this.clock() && plan.entryDeadlineMs <= this.clock() + 60_000, 'entry authority is stale or too far in the future');
    check(authorizations.length === plan.mandates.length && new Set(authorizations.map(row => row.owner)).size === authorizations.length,
      'every owner must sign the exact epoch');
    const reservations = [];
    for (const mandate of plan.mandates) {
      const signature = authorizations.find(row => row.owner === mandate.owner)?.signature;
      const typed = poolEpochTypedData(this.store.binding, plan, mandate.owner);
      check(signature !== undefined && await verifyTypedData({ ...typed, address: mandate.owner, signature }), 'invalid owner epoch signature');
      reservations.push({ owner: mandate.owner, maximumLossQuoteAtoms: mandate.maximumLossQuoteAtoms, authorizationHash: hashTypedData(typed) });
    }
    const proof = await this.reads.flat(this.store.binding.poolAccount);
    verifyPoolFlatEvidence(this.store.binding, proof, this.clock());
    check(this.clock() < plan.entryDeadlineMs, 'entry authority expired during preparation');
    this.store.reserveEpoch({ id: plan.id, reservations, verifiedFlatEquityQuoteAtoms: proof.equityQuoteAtoms,
      context: { planHash: poolEpochPlanHash(plan), plan: stringifyProtocolJson(plan),
        sourceOrderHashes: [...new Set(plan.entry.allocations.map(row => `0x${toHex(row.strategyOrderHash)}`))] } });
  }

  #plan(id: string): { plan: HyperliquidPoolEpochPlan; initialEquity: bigint } {
    const row = this.store.operation(id);
    check(row?.kind === 'EPOCH', 'epoch does not exist');
    const payload = row.payload as { verifiedFlatEquityQuoteAtoms: bigint; context?: { planHash: string; plan: string } };
    check(payload.context !== undefined, 'epoch has no signed execution plan');
    const plan = parseProtocolJson(payload.context.plan) as HyperliquidPoolEpochPlan;
    validatePlan(this.store.binding, plan);
    check(poolEpochPlanHash(plan) === payload.context.planHash, 'stored execution plan changed');
    return { plan, initialEquity: payload.verifiedFlatEquityQuoteAtoms };
  }

  async enter(id: string): Promise<void> {
    const { plan } = this.#plan(id);
    check(this.store.operation(id)?.state === 'PENDING', 'epoch is not pending');
    check(this.store.epochStage(id, 'CLOSE_REQUESTED') === undefined, 'closing epoch cannot request entry');
    check(this.store.epochStage(id, 'RECOVERY_REQUESTED') === undefined, 'recovering epoch cannot request entry');
    if (this.store.epochStage(id, 'ENTRY_REQUESTED') === undefined) {
      check(this.clock() < plan.entryDeadlineMs, 'new entry authority expired');
      this.store.recordEpochStage(id, 'ENTRY_REQUESTED', { planHash: poolEpochPlanHash(plan) });
    }
    await this.execution.enter(plan);
  }

  async close(id: string): Promise<void> {
    const { plan } = this.#plan(id);
    check(this.store.epochStage(id, 'ENTRY_REQUESTED') !== undefined, 'entry has not been requested');
    this.store.recordEpochStage(id, 'CLOSE_REQUESTED', { planHash: poolEpochPlanHash(plan) });
    await this.execution.close(plan);
  }

  async recover(id: string): Promise<'PENDING' | 'RECOVERED'> {
    const { plan, initialEquity } = this.#plan(id);
    if (this.store.operation(id)?.state === 'COMPLETE') {
      check(this.store.epochStage(id, 'RECOVERY_RESULT') !== undefined, 'settled epoch cannot become a recovery');
      return 'RECOVERED';
    }
    check(this.store.epochStage(id, 'ENTRY_RESULT') === undefined, 'opened owner positions need a coordinated close, not entry abort');
    this.store.recordEpochStage(id, 'RECOVERY_REQUESTED', { planHash: poolEpochPlanHash(plan) });
    const recovery = await this.execution.recover(plan);
    if (recovery === undefined) return 'PENDING';
    check(recovery.environment === 'TESTNET' && recovery.account === this.store.binding.poolAccount
      && HASH.test(recovery.evidenceHash) && Number.isSafeInteger(recovery.closedAtMs) && recovery.closedAtMs > 0,
    'recovery evidence does not bind the pool');
    const flat = await this.reads.flat(this.store.binding.poolAccount);
    verifyPoolFlatEvidence(this.store.binding, flat, this.clock());
    const sponsor = plan.mandates.find(row => row.role === 'RECOVERY_SPONSOR')!;
    check(flat.requestedAtMs >= recovery.closedAtMs && initialEquity + recovery.cashDeltaQuoteAtoms === flat.equityQuoteAtoms,
      'recovery cash flows do not reconcile');
    check(recovery.cashDeltaQuoteAtoms >= -sponsor.maximumLossQuoteAtoms && recovery.feeQuoteAtoms >= 0n
      && recovery.feeQuoteAtoms <= sponsor.maximumFeeQuoteAtoms, 'funded recovery sponsor authority is exhausted');
    this.store.recordEpochStage(id, 'RECOVERY_RESULT', recovery);
    this.store.settleEpoch({ id, allocations: plan.mandates.map(row => ({ owner: row.owner,
      pnlQuoteAtoms: row.owner === sponsor.owner ? recovery.cashDeltaQuoteAtoms : 0n })),
      verifiedFlatEquityQuoteAtoms: flat.equityQuoteAtoms, evidenceHash: recovery.evidenceHash });
    return 'RECOVERED';
  }

  async reconcile(id: string): Promise<'PENDING' | 'SETTLED' | 'RECOVERED'> {
    const { plan, initialEquity } = this.#plan(id);
    if (this.store.epochStage(id, 'RECOVERY_REQUESTED') !== undefined) return this.recover(id);
    if (this.store.operation(id)?.state === 'COMPLETE') return 'SETTLED';
    const closure = await this.execution.closure(plan);
    if (closure === undefined) return 'PENDING';
    const flat = await this.reads.flat(this.store.binding.poolAccount);
    verifyPoolFlatEvidence(this.store.binding, flat, this.clock());
    check(flat.requestedAtMs >= closure.closedAtMs, 'flat backing predates closure');
    const result = reconcileHyperliquidPoolEpoch(this.store.binding, plan, closure, initialEquity, flat.equityQuoteAtoms);
    this.store.settleEpoch({ id, allocations: result.allocations, verifiedFlatEquityQuoteAtoms: flat.equityQuoteAtoms, evidenceHash: result.evidenceHash });
    return 'SETTLED';
  }

  async advance(): Promise<'IDLE' | 'OPEN' | 'PENDING' | 'SETTLED' | 'RECOVERED'> {
    const pending = this.store.pending();
    if (pending?.kind !== 'EPOCH') return 'IDLE';
    const { plan } = this.#plan(pending.id);
    if (this.store.epochStage(plan.id, 'RECOVERY_REQUESTED') !== undefined) return this.recover(plan.id);
    if (this.store.epochStage(plan.id, 'ENTRY_RESULT') === undefined) {
      if (this.clock() >= plan.entryDeadlineMs) return this.recover(plan.id);
      await this.enter(plan.id);
    }
    if (this.clock() < plan.closeAfterMs && this.store.epochStage(plan.id, 'CLOSE_REQUESTED') === undefined) return 'OPEN';
    await this.close(plan.id);
    return this.reconcile(plan.id);
  }
}
