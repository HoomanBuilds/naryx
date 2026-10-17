import { keccak256, toHex as hex } from 'viem';
import {
  netObligations, nettingExternalExecutionIntent, nettingFinalAllocationReceipt, stringifyProtocolJson, toHex,
  verifyNettingExternalExecutionEvidence,
  type NettingExternalExecutionEvidence, type NettingExternalExecutionIntent, type NettingPolicyManifest,
  type NettingResult,
} from '@naryx/protocol-types';
import type { HyperliquidPooledCollateralStore } from './hyperliquid-pooled-collateral-store.js';
import { poolEpochPlanHash, type HyperliquidPoolEpochClosure, type HyperliquidPoolEpochExecutionPort,
  type HyperliquidPoolEpochLegEvidence, type HyperliquidPoolEpochPlan,
  type HyperliquidPoolEpochRecovery, type HyperliquidPoolCumulativeClose } from './hyperliquid-pool-epoch.js';

export interface HyperliquidPoolResidualPort {
  execute(input: { intent: NettingExternalExecutionIntent; idempotencyKey: string }): Promise<NettingExternalExecutionEvidence>;
  observe(input: { intent: NettingExternalExecutionIntent; idempotencyKey: string }): Promise<NettingExternalExecutionEvidence | undefined>;
  cancelUnsubmitted(input: { intent: NettingExternalExecutionIntent; idempotencyKey: string }): boolean;
}

export interface HyperliquidPoolExecutionReadPort {
  closePrices(policy: NettingPolicyManifest): Promise<Readonly<{
    observedAtMs: number;
    prices: readonly { instrumentId: string; buyLimitPriceTicks: bigint; sellLimitPriceTicks: bigint }[];
  }>>;
  funding(plan: HyperliquidPoolEpochPlan, startTimeMs: number, endTimeMs: number): Promise<HyperliquidPoolEpochClosure['funding']>;
}

interface ExecutionStage {
  readonly planHash: string;
  readonly requestedAtMs: number;
  readonly result: NettingResult;
  readonly intents: readonly NettingExternalExecutionIntent[];
}

interface CompletedStage {
  readonly observedAtMs: number;
  readonly leg: HyperliquidPoolEpochLegEvidence;
}

interface ClosedStage {
  readonly observedAtMs: number;
  readonly leg: HyperliquidPoolCumulativeClose;
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Pool execution: ${message}`);
}

function digest(value: unknown): `0x${string}` { return keccak256(hex(stringifyProtocolJson(value))); }
function abs(value: bigint): bigint { return value < 0n ? -value : value; }

function makeIntents(plan: HyperliquidPoolEpochPlan, result: NettingResult, policy: NettingPolicyManifest, validUntil: number) {
  return result.underlyings.filter(row => row.externalNetAtoms !== 0n).map(row => nettingExternalExecutionIntent(result, policy, {
    instrumentId: row.instrumentId, validUntilUnit: 'HYPERLIQUID_UNIX_MILLISECONDS', validUntilValue: BigInt(validUntil),
    sourceFeeCaps: result.allocations.filter(allocation => allocation.instrumentId === row.instrumentId && allocation.externalQuantityAtoms !== 0n)
      .map(allocation => {
        const mandate = plan.mandates.find(owner => owner.owner === allocation.ownerId);
        check(mandate?.role === 'TRADER', 'fee source has no trading mandate');
        const legs = plan.entry.allocations.filter(entry => entry.ownerId === allocation.ownerId).length;
        return { obligationId: allocation.obligationId, maximumFeeQuoteAtoms: mandate.maximumFeeQuoteAtoms / (2n * BigInt(legs)) };
      }),
  }));
}

export class HyperliquidPoolNettingExecution implements HyperliquidPoolEpochExecutionPort {
  readonly #store: HyperliquidPooledCollateralStore;
  readonly #entry: HyperliquidPoolResidualPort;
  readonly #exit: HyperliquidPoolResidualPort;
  readonly #reads: HyperliquidPoolExecutionReadPort;
  readonly #clock: () => number;

  constructor(store: HyperliquidPooledCollateralStore, entry: HyperliquidPoolResidualPort,
    exit: HyperliquidPoolResidualPort, reads: HyperliquidPoolExecutionReadPort, clock = Date.now) {
    this.#store = store; this.#entry = entry; this.#exit = exit; this.#reads = reads; this.#clock = clock;
  }

  #authorized(plan: HyperliquidPoolEpochPlan): void {
    const operation = this.#store.operation(plan.id);
    const context = (operation?.payload as { context?: { planHash: string } } | undefined)?.context;
    check(operation?.kind === 'EPOCH' && operation.state === 'PENDING' && context?.planHash === poolEpochPlanHash(plan),
      'execution is not bound to the funded signed epoch');
  }

  async #prices(policy: NettingPolicyManifest) {
    const quote = await this.#reads.closePrices(policy);
    const now = this.#clock();
    check(Number.isSafeInteger(quote.observedAtMs) && quote.observedAtMs > 0 && quote.observedAtMs <= now
      && now - quote.observedAtMs <= 5_000 && quote.prices.length === policy.instruments.length
      && new Set(quote.prices.map(row => row.instrumentId)).size === quote.prices.length
      && policy.instruments.every(instrument => quote.prices.some(row => row.instrumentId === instrument.instrumentId
        && row.sellLimitPriceTicks > 0n && row.buyLimitPriceTicks >= row.sellLimitPriceTicks)),
    'execution reference is stale or incomplete');
    return quote;
  }

  async #execute(plan: HyperliquidPoolEpochPlan, stage: ExecutionStage, kind: 'ENTRY' | 'EXIT', runtime: HyperliquidPoolResidualPort): Promise<void> {
    const policy = kind === 'ENTRY' ? plan.entryPolicy : plan.exitPolicy;
    const proofs: NettingExternalExecutionEvidence[] = [];
    for (const intent of stage.intents) {
      const proofKey = `${kind}_PROOF_${toHex(intent.intentHash)}`;
      let proof = this.#store.epochStage(plan.id, proofKey) as NettingExternalExecutionEvidence | undefined;
      if (proof === undefined) {
        this.#store.recordEpochStage(plan.id, `${kind}_DISPATCH_${toHex(intent.intentHash)}`, { intentHash: intent.intentHash });
        proof = await runtime.execute({ intent, idempotencyKey: toHex(intent.intentHash) });
        verifyNettingExternalExecutionEvidence(proof, intent);
        this.#store.recordEpochStage(plan.id, proofKey, proof);
      }
      verifyNettingExternalExecutionEvidence(proof, intent);
      check(proof.outcome === 'EXACT_FILLED', 'non-exact venue execution requires recovery; owner cash stays locked');
      proofs.push(proof);
    }
    const receipt = nettingFinalAllocationReceipt(stage.result, policy, stage.intents, proofs);
    this.#store.recordEpochStage(plan.id, `${kind}_RESULT`, {
      observedAtMs: proofs.reduce((latest, proof) => Math.max(latest, Number(proof.observedAtValue)), stage.requestedAtMs),
      leg: { result: stage.result, intents: stage.intents, evidence: proofs, receipt } } satisfies CompletedStage);
  }

  async enter(plan: HyperliquidPoolEpochPlan): Promise<void> {
    this.#authorized(plan);
    if (this.#store.epochStage(plan.id, 'ENTRY_RESULT') !== undefined) return;
    check(this.#store.epochStage(plan.id, 'CLOSE_REQUESTED') === undefined, 'close has already begun');
    let stage = this.#store.epochStage(plan.id, 'ENTRY_PLAN') as ExecutionStage | undefined;
    if (stage === undefined) {
      const prices = await this.#prices(plan.entryPolicy);
      for (const owner of plan.mandates.filter(row => row.role === 'TRADER')) {
        const gross = plan.entry.allocations.filter(row => row.ownerId === owner.owner).reduce((sum, row) => {
          const instrument = plan.entryPolicy.instruments.find(item => item.instrumentId === row.instrumentId)!;
          const reference = prices.prices.find(item => item.instrumentId === row.instrumentId)!.buyLimitPriceTicks;
          const price = row.limitPriceTicks > reference ? row.limitPriceTicks : reference;
          return sum + abs(row.signedQuantityAtoms) / instrument.quantityIncrementAtoms * price * instrument.priceTickQuoteAtoms;
        }, 0n);
        check(gross <= owner.maximumLossQuoteAtoms * 5n, 'current owner exposure exceeds its funded limit');
      }
      const now = this.#clock();
      check(Number.isSafeInteger(now) && now > 0 && now < plan.entryDeadlineMs, 'entry deadline expired');
      stage = { planHash: poolEpochPlanHash(plan), requestedAtMs: now, result: plan.entry,
        intents: makeIntents(plan, plan.entry, plan.entryPolicy, plan.entryDeadlineMs) };
      this.#store.recordEpochStage(plan.id, 'ENTRY_PLAN', stage);
    }
    await this.#execute(plan, stage, 'ENTRY', this.#entry);
  }

  async close(plan: HyperliquidPoolEpochPlan): Promise<void> {
    this.#authorized(plan);
    if (this.#store.epochStage(plan.id, 'EXIT_RESULT') !== undefined) return;
    check(this.#store.epochStage(plan.id, 'ENTRY_RESULT') !== undefined, 'entry needs terminal evidence before close');
    let stage = this.#store.epochStage(plan.id, 'EXIT_PLAN') as ExecutionStage | undefined;
    if (stage === undefined) {
      const quote = await this.#prices(plan.exitPolicy);
      const now = this.#clock();
      const result = netObligations(plan.entry.allocations.map((allocation, i) => {
        const price = quote.prices.find(row => row.instrumentId === allocation.instrumentId);
        check(price !== undefined && price.sellLimitPriceTicks > 0n && price.buyLimitPriceTicks >= price.sellLimitPriceTicks,
          'close quote is outside the admitted market');
        const sourceHash = keccak256(hex(stringifyProtocolJson({ planHash: poolEpochPlanHash(plan),
          obligationId: allocation.obligationId, action: 'FULL_REDUCE_ONLY_CLOSE' })));
        return { ownerId: allocation.ownerId, strategyOrderHash: sourceHash, packageOrderId: sourceHash,
          settlementReadinessHash: poolEpochPlanHash(plan), legId: allocation.legId, instrumentId: allocation.instrumentId,
          signedQuantityAtoms: -allocation.signedQuantityAtoms, sequence: BigInt(i + 1),
          limitPriceTicks: allocation.signedQuantityAtoms < 0n ? price.buyLimitPriceTicks : price.sellLimitPriceTicks };
      }), plan.exitPolicy);
      stage = { planHash: poolEpochPlanHash(plan), requestedAtMs: now, result,
        intents: makeIntents(plan, result, plan.exitPolicy, now + 120_000) };
      this.#store.recordEpochStage(plan.id, 'EXIT_PLAN', stage);
    }
    const attempts: HyperliquidPoolCumulativeClose['attempts'][number][] = [];
    const sponsor = plan.mandates.find(row => row.role === 'RECOVERY_SPONSOR')!;
    let recoveryFees = 0n;
    for (const initial of stage.intents) {
      let remaining = initial.side === 'BUY' ? initial.quantityAtoms : -initial.quantityAtoms;
      for (let attempt = 0; remaining !== 0n && attempt < 32; attempt++) {
        const key = `CLOSE_${digest({ instrument: initial.instrumentId, attempt }).slice(2)}`;
        let request = this.#store.epochStage(plan.id, `${key}_REQUEST`) as { result: NettingResult; intent: NettingExternalExecutionIntent } | undefined;
        if (request === undefined) {
          if (attempt === 0) request = { result: stage.result, intent: initial };
          else {
            const prices = await this.#prices(plan.exitPolicy);
            const price = prices.prices.find(row => row.instrumentId === initial.instrumentId)!;
            const source = digest({ planHash: poolEpochPlanHash(plan), instrument: initial.instrumentId, attempt, remaining, action: 'CLOSE_REMAINDER' });
            const result = netObligations([{ ownerId: sponsor.owner, strategyOrderHash: source, packageOrderId: source,
              settlementReadinessHash: poolEpochPlanHash(plan), legId: 'recovery', instrumentId: initial.instrumentId,
              signedQuantityAtoms: remaining, limitPriceTicks: remaining > 0n ? price.buyLimitPriceTicks : price.sellLimitPriceTicks,
              sequence: 1n }], plan.exitPolicy);
            check(recoveryFees <= sponsor.maximumFeeQuoteAtoms, 'close recovery fee budget exhausted');
            request = { result, intent: nettingExternalExecutionIntent(result, plan.exitPolicy, {
              instrumentId: initial.instrumentId, validUntilUnit: 'HYPERLIQUID_UNIX_MILLISECONDS',
              validUntilValue: BigInt(this.#clock() + 120_000), sourceFeeCaps: [{ obligationId: result.allocations[0]!.obligationId,
                maximumFeeQuoteAtoms: sponsor.maximumFeeQuoteAtoms - recoveryFees }] }) };
          }
          this.#store.recordEpochStage(plan.id, `${key}_REQUEST`, request);
        }
        check((request.intent.side === 'BUY' ? request.intent.quantityAtoms : -request.intent.quantityAtoms) === remaining,
          'close order exceeds remaining exposure');
        let proof = this.#store.epochStage(plan.id, `${key}_PROOF`) as NettingExternalExecutionEvidence | undefined;
        if (proof === undefined) {
          if (request.intent.validUntilValue <= BigInt(this.#clock())
            && this.#exit.cancelUnsubmitted({ intent: request.intent, idempotencyKey: toHex(request.intent.intentHash) })) {
            this.#store.recordEpochStage(plan.id, `${key}_CANCELLED`, { intentHash: request.intent.intentHash });
            continue;
          }
          proof = await this.#exit.execute({ intent: request.intent, idempotencyKey: toHex(request.intent.intentHash) });
          verifyNettingExternalExecutionEvidence(proof, request.intent);
          this.#store.recordEpochStage(plan.id, `${key}_PROOF`, proof);
        }
        verifyNettingExternalExecutionEvidence(proof, request.intent);
        if (attempt > 0) recoveryFees += proof.feeQuoteAtoms;
        attempts.push({ ...request, evidence: proof });
        remaining -= proof.filledSignedQuantityAtoms;
      }
      check(remaining === 0n, 'close attempt bound reached; exposure remains locked for operator recovery');
    }
    this.#store.recordEpochStage(plan.id, 'EXIT_RESULT', {
      observedAtMs: attempts.reduce((latest, row) => Math.max(latest, Number(row.evidence.observedAtValue)), stage.requestedAtMs),
      leg: { kind: 'CUMULATIVE_REDUCE_ONLY_CLOSE', result: stage.result, attempts } } satisfies ClosedStage);
  }

  async closure(plan: HyperliquidPoolEpochPlan): Promise<HyperliquidPoolEpochClosure | undefined> {
    this.#authorized(plan);
    const entryPlan = this.#store.epochStage(plan.id, 'ENTRY_PLAN') as ExecutionStage | undefined;
    const entry = this.#store.epochStage(plan.id, 'ENTRY_RESULT') as CompletedStage | undefined;
    const exit = this.#store.epochStage(plan.id, 'EXIT_RESULT') as ClosedStage | undefined;
    if (entryPlan === undefined || entry === undefined || exit === undefined) return undefined;
    return { account: this.#store.binding.poolAccount, environment: 'TESTNET', openedAtMs: entryPlan.requestedAtMs,
      closedAtMs: exit.observedAtMs, entry: entry.leg, exit: exit.leg,
      funding: await this.#reads.funding(plan, entryPlan.requestedAtMs, exit.observedAtMs) };
  }

  async recover(plan: HyperliquidPoolEpochPlan): Promise<HyperliquidPoolEpochRecovery | undefined> {
    this.#authorized(plan);
    check(this.#store.epochStage(plan.id, 'RECOVERY_REQUESTED') !== undefined
      && this.#store.epochStage(plan.id, 'ENTRY_RESULT') === undefined, 'entry abort has not been authorized');
    const completed = this.#store.epochStage(plan.id, 'ABORT_RESULT') as HyperliquidPoolEpochRecovery | undefined;
    if (completed !== undefined) return completed;
    const stage = this.#store.epochStage(plan.id, 'ENTRY_PLAN') as ExecutionStage | undefined;
    const sponsor = plan.mandates.find(row => row.role === 'RECOVERY_SPONSOR')!;
    const evidence: NettingExternalExecutionEvidence[] = [];
    const references = new Set<string>();
    let cash = 0n;
    let fees = 0n;
    const apply = (intent: NettingExternalExecutionIntent, proof: NettingExternalExecutionEvidence) => {
      verifyNettingExternalExecutionEvidence(proof, intent);
      const reference = toHex(proof.executionReferenceHash);
      check(!references.has(reference), 'recovery evidence repeats');
      references.add(reference);
      cash += (proof.filledSignedQuantityAtoms > 0n ? -proof.grossQuoteAtoms : proof.grossQuoteAtoms) - proof.feeQuoteAtoms;
      fees += proof.feeQuoteAtoms;
      check(fees <= sponsor.maximumFeeQuoteAtoms, 'recovery fee authority is exhausted');
      evidence.push(proof);
    };
    const positions = new Map<string, bigint>();
    for (const intent of stage?.intents ?? []) {
      if (this.#store.epochStage(plan.id, `ENTRY_DISPATCH_${toHex(intent.intentHash)}`) === undefined) continue;
      const key = `ENTRY_PROOF_${toHex(intent.intentHash)}`;
      let proof = this.#store.epochStage(plan.id, key) as NettingExternalExecutionEvidence | undefined;
      if (proof === undefined) {
        if (this.#entry.cancelUnsubmitted({ intent, idempotencyKey: toHex(intent.intentHash) })) {
          this.#store.recordEpochStage(plan.id, `ENTRY_CANCELLED_${toHex(intent.intentHash)}`, { intentHash: intent.intentHash });
          continue;
        }
        proof = await this.#entry.observe({ intent, idempotencyKey: toHex(intent.intentHash) });
        if (proof === undefined) return undefined;
        verifyNettingExternalExecutionEvidence(proof, intent);
        this.#store.recordEpochStage(plan.id, key, proof);
      }
      apply(intent, proof);
      positions.set(intent.instrumentId, (positions.get(intent.instrumentId) ?? 0n) + proof.filledSignedQuantityAtoms);
    }
    for (const instrument of plan.exitPolicy.instruments) {
      let remaining = positions.get(instrument.instrumentId) ?? 0n;
      for (let attempt = 0; remaining !== 0n && attempt < 32; attempt++) {
        const key = `ABORT_${digest({ instrument: instrument.instrumentId, attempt }).slice(2)}`;
        let intent = this.#store.epochStage(plan.id, `${key}_INTENT`) as NettingExternalExecutionIntent | undefined;
        if (intent === undefined) {
          const prices = await this.#prices(plan.exitPolicy);
          const price = prices.prices.find(row => row.instrumentId === instrument.instrumentId)!;
          const source = digest({ planHash: poolEpochPlanHash(plan), instrument: instrument.instrumentId, attempt, remaining });
          const result = netObligations([{ ownerId: sponsor.owner, strategyOrderHash: source, packageOrderId: source,
            settlementReadinessHash: poolEpochPlanHash(plan), legId: 'recovery', instrumentId: instrument.instrumentId,
            signedQuantityAtoms: -remaining, limitPriceTicks: remaining > 0n ? price.sellLimitPriceTicks : price.buyLimitPriceTicks,
            sequence: 1n }], plan.exitPolicy);
          intent = nettingExternalExecutionIntent(result, plan.exitPolicy, { instrumentId: instrument.instrumentId,
            validUntilUnit: 'HYPERLIQUID_UNIX_MILLISECONDS', validUntilValue: BigInt(this.#clock() + 120_000),
            sourceFeeCaps: [{ obligationId: result.allocations[0]!.obligationId, maximumFeeQuoteAtoms: sponsor.maximumFeeQuoteAtoms - fees }] });
          this.#store.recordEpochStage(plan.id, `${key}_INTENT`, intent);
        }
        check((intent.side === 'BUY' ? intent.quantityAtoms : -intent.quantityAtoms) === -remaining,
          'recovery order no longer reduces the evidenced exposure');
        let proof = this.#store.epochStage(plan.id, `${key}_PROOF`) as NettingExternalExecutionEvidence | undefined;
        if (proof === undefined) {
          if (intent.validUntilValue <= BigInt(this.#clock())
            && this.#exit.cancelUnsubmitted({ intent, idempotencyKey: toHex(intent.intentHash) })) {
            this.#store.recordEpochStage(plan.id, `${key}_CANCELLED`, { intentHash: intent.intentHash });
            continue;
          }
          proof = await this.#exit.execute({ intent, idempotencyKey: toHex(intent.intentHash) });
          verifyNettingExternalExecutionEvidence(proof, intent);
          this.#store.recordEpochStage(plan.id, `${key}_PROOF`, proof);
        }
        apply(intent, proof);
        remaining += proof.filledSignedQuantityAtoms;
      }
      if (remaining !== 0n) return undefined;
    }
    const closedAtMs = Math.max(this.#clock(), ...evidence.map(proof => Number(proof.observedAtValue)));
    const funding = await this.#reads.funding(plan, stage?.requestedAtMs ?? closedAtMs, closedAtMs);
    check(funding.length <= 1_024 && new Set(funding.map(row => row.hash)).size === funding.length
      && funding.every(row => plan.exitPolicy.instruments.some(instrument => instrument.instrumentId === row.instrumentId)
        && Number.isSafeInteger(row.timeMs) && row.timeMs >= (stage?.requestedAtMs ?? closedAtMs) && row.timeMs <= closedAtMs),
    'recovery funding is duplicated or outside the epoch');
    cash += funding.reduce((sum, row) => sum + row.quoteDeltaAtoms, 0n);
    const result: HyperliquidPoolEpochRecovery = { environment: 'TESTNET', account: this.#store.binding.poolAccount,
      closedAtMs, cashDeltaQuoteAtoms: cash, feeQuoteAtoms: fees,
      evidenceHash: digest({ planHash: poolEpochPlanHash(plan), evidence, funding }) };
    this.#store.recordEpochStage(plan.id, 'ABORT_RESULT', result);
    return result;
  }
}
