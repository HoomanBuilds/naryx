import { createHash } from 'node:crypto';
import {
  assetAmount, assetRef, adapterRef, versionedManifestRef, packageGraph, packageGraphHash,
  packageTemplateManifestHash, strategyPackageOrder, strategyPackageOrderHash,
  typedStrategyRouteHash, protocolId, commitmentHash, toHex, stringifyProtocolJson,
  validateStrategyTemplateGraph, strategyPackageQuoteHash,
  type DomainRef, type PackageTemplateManifestInput, type TypedStrategyRoute,
} from '@naryx/protocol-types';
import {
  compileEvmMultiStrategyAccountEnvelope, encodeTestPerpTradeArgs,
  type EvmStrategyRiskTerms, type EvmStrategyAdapterIdentity, type EvmMultiStrategyAccountEnvelope,
} from '@naryx/adapter-evm';
import { decodeAbiParameters, encodeAbiParameters, keccak256, parseAbiParameters, stringToHex, type Address, type Hex } from 'viem';
import { buildSignedStrategyPackageQuote, type StrategyQuoteSigner } from './strategy-quote-builder.js';
import { RECOVERABLE_PERP_ENTRY_PARAMETERS, RECOVERABLE_PERP_CLOSE_PARAMETERS } from './evm-full-reversal-policy.js';
import type { CrossDomainWalletDraft } from './cross-domain-wallet-admission.js';

const ZERO = `0x${'0'.repeat(64)}` as Hex;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const TEMPLATE = 'calendar-spread-v1';
const CLASS = 'registered-cross-domain-calendar-v1';
const SCALE = 1_000_000_000_000n;
export const CALENDAR_QUANTITY = 100_000_000_000_000n;
export const CALENDAR_COLLATERAL = 1_000_000n;
export const CALENDAR_RECOVERY_LOSS = 100_000n;

export function calendarCommitment(value: unknown) {
  return commitmentHash(createHash('sha256').update('NARYX/registered-calendar/v1\0')
    .update(stringifyProtocolJson(value)).digest());
}

export interface CalendarDomainObservation {
  readonly domain: DomainRef;
  readonly owner: Address;
  readonly account: Address;
  readonly accountCodeHash: Hex;
  readonly packageId: Hex;
  readonly localTemplateHash: Hex;
  readonly solver: Address;
  readonly adapter: Address;
  readonly adapterCodeHash: Hex;
  readonly adapterIdentity: EvmStrategyAdapterIdentity;
  readonly baseToken: Address;
  readonly quoteToken: Address;
  readonly instrument: Address;
  readonly instrumentCodeHash: Hex;
  readonly role: 'near-future' | 'far-future';
  readonly maturity: bigint;
  readonly nonce: bigint;
  readonly generation: bigint;
  readonly entryNotionalWad: bigint;
  readonly minimumBalanceWad: bigint;
  readonly maximumBalanceWad: bigint;
  readonly maximumNotionalWad: bigint;
  readonly risk: EvmStrategyRiskTerms;
  readonly feePolicyVersion: number;
  readonly feePolicyManifestHash: Hex;
  readonly reservationId: (orderHash: Hex, nonce: bigint) => Promise<Hex>;
  readonly executorClassId: string;
  readonly executorClassVersion: number;
  readonly executorClassManifestHash: Uint8Array | string;
}

function requireCondition(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Canonical calendar refused: ${message}`);
}

// A projection binds local onchain registrations, not aliases that change their meaning.
export function calendarProjection(observation: CalendarDomainObservation) {
  return {
    domain: observation.domain, account: observation.account.toLowerCase(), accountCodeHash: observation.accountCodeHash,
    packageId: observation.packageId, templateId: TEMPLATE, templateVersion: 1,
    localTemplateHash: observation.localTemplateHash, adapter: observation.adapter.toLowerCase(),
    adapterCodeHash: observation.adapterCodeHash, adapterIdentity: observation.adapterIdentity,
    baseToken: observation.baseToken.toLowerCase(), quoteToken: observation.quoteToken.toLowerCase(),
    instrument: observation.instrument.toLowerCase(), instrumentCodeHash: observation.instrumentCodeHash,
    role: observation.role, maturity: observation.maturity,
  };
}

export function refreshCalendarRecovery(original: EvmMultiStrategyAccountEnvelope, domain: DomainRef, adapterCodeHash: Hex, maturity: number, nonce: bigint, deadline: bigint) {
  requireCondition(original.calls.length === 1 && original.execution.operation === 8, 'expected one full calendar recovery');
  const call = original.calls[0]!;
  const [mode, close] = decodeAbiParameters(RECOVERABLE_PERP_CLOSE_PARAMETERS, call.payload);
  requireCondition(mode === 2 && nonce >= original.execution.nonce && deadline > 0n
    && original.execution.domainIdHash === keccak256(stringToHex(domain.domainId))
    && original.execution.domainManifestVersion === domain.domainManifestVersion
    && original.execution.domainManifestHash === `0x${toHex(domain.domainManifestHash)}`, 'recovery nonce, domain or mode changed');
  const tradeArgs = encodeTestPerpTradeArgs({ deadline, expiry: maturity, sizeDeltaWad: -close.expectedSizeWad, balanceDeltaWad: 0n })
    .map(value => `0x${toHex(value)}`) as [Hex, Hex];
  const payload = encodeAbiParameters(RECOVERABLE_PERP_CLOSE_PARAMETERS, [mode, { ...close, tradeArgs,
    maximumCollateralOutAtoms: (1n << 128n) - 1n }]);
  const legId = domain.domainId === 'eip155:84532' ? 'near-future' : 'far-future';
  const execution = original.execution;
  return compileEvmMultiStrategyAccountEnvelope({
    compiled: { orderHash: commitmentHash(execution.orderHash), graphHash: commitmentHash(execution.graphHash),
      quoteHash: commitmentHash(execution.quoteHash), routeHash: commitmentHash(execution.routeHash), domains: [domain],
      payload: { version: 1, planKind: 'EVM_ATOMIC_BATCH', guarantee: 'ATOMIC_POSTCONDITION', domain,
        strategyAccount: original.account, packageId: execution.packageId, totalGasLimit: call.gasLimit,
        stages: [{ stage: 0, calls: [{ legId, stage: 0, materializationClassId: CLASS, adapter: call.target,
          adapterCodeHash, gasLimit: call.gasLimit,
          value: 0n, data: payload, dataHash: keccak256(payload) }] }] } },
    account: original.account, chainId: Number(domain.domainId.slice(7)), operation: 'EMERGENCY_UNWIND', packageId: execution.packageId,
    templateId: TEMPLATE, templateVersion: 1, templateManifestHash: execution.template.templateManifestHash,
    previousStateHash: execution.previousStateHash, nextStateHash: execution.nextStateHash, totalGrossNotionalAtoms: execution.totalGrossNotionalAtoms,
    risk: execution.risk, fees: execution.fees, solver: ZERO_ADDRESS, nonce, deadline,
    callPolicies: [{ legId, adapter: call.adapter, expectedAdapterAddress: call.target,
      expectedAdapterCodeHash: adapterCodeHash,
      riskIncreasing: false, approvalAtoms: 0n, grossNotionalAtoms: call.grossNotionalAtoms }],
  });
}

export async function prepareCanonicalCalendar(input: {
  owner: Address; requestId: string; now: bigint; observations: readonly CalendarDomainObservation[];
  signer: StrategyQuoteSigner;
}) {
  const observations = [...input.observations].sort((a, b) => a.role === 'near-future' ? -1 : b.role === 'near-future' ? 1 : 0);
  requireCondition(observations.length === 2, 'two registered domains are required');
  const [near, far] = observations as [CalendarDomainObservation, CalendarDomainObservation];
  requireCondition(near.role === 'near-future' && far.role === 'far-future'
    && near.domain.domainId === 'eip155:84532' && far.domain.domainId === 'eip155:421614', 'unsupported domain projection');
  requireCondition(near.maturity < far.maturity && near.maturity > input.now + 7_200n, 'maturities are expired or reversed');
  requireCondition(/^[a-zA-Z0-9._:-]{16,96}$/.test(input.requestId) && input.now > 0n, 'invalid request identity or time');
  for (const observation of observations) {
    requireCondition(observation.owner.toLowerCase() === input.owner.toLowerCase()
      && observation.generation >= 0n && observation.generation < (1n << 64n) - 1n
      && observation.nonce >= 0n && observation.nonce < (1n << 256n) - 1n,
    'owner, nonce or generation is invalid');
    requireCondition(observation.entryNotionalWad > 0n && observation.maximumNotionalWad >= observation.entryNotionalWad
      && observation.minimumBalanceWad > 0n && observation.maximumBalanceWad >= observation.minimumBalanceWad,
    'invalid observed execution bounds');
  }
  const projections = observations.map(calendarProjection);
  const projectionHash = calendarCommitment(projections);
  const base = assetRef('test-base-unit', calendarCommitment({ kind: 'test-base-unit', decimals: 18, projections }), 18);
  const quoteAsset = assetRef('test-usdc-unit', calendarCommitment({ kind: 'test-usdc-unit', decimals: 6, projections }), 6);
  const template: PackageTemplateManifestInput = {
    manifestVersion: 2, environment: 'testnet', templateId: TEMPLATE, templateVersion: 1,
    supportedDomains: observations.map(o => o.domain), legCount: 2, legTypes: ['near-future', 'far-future'],
    supportedDirections: ['LONG_SPOT_SHORT_PERP'], supportedSettlementClasses: ['CROSS_DOMAIN_PREPOSITIONED'],
    allowedSpotAdapterIds: [], allowedPerpAdapterIds: [], allowedAdapterIds: observations.map(o => o.adapterIdentity.subjectId),
    entryCompilerVersion: 1, exitCompilerVersion: 1,
    orderSchemaHash: calendarCommitment({ schema: 'StrategyPackageOrder', version: 1 }),
    quoteSchemaHash: calendarCommitment({ schema: 'StrategyPackageQuote', version: 1 }),
    routeSchemaHash: calendarCommitment({ schema: 'TypedStrategyRoute', version: 1 }),
    receiptSchemaHash: calendarCommitment({ schema: 'StrategyPackageReceipt', version: 1 }),
    riskPolicyHash: calendarCommitment(observations.map(o => o.risk)),
  };
  const templateHash = packageTemplateManifestHash(template);
  const seriesHash = calendarCommitment({ templateHash, projections });
  const executionClassHash = calendarCommitment({ classId: CLASS, version: 1, projections,
    quantity: CALENDAR_QUANTITY, collateral: CALENDAR_COLLATERAL, maximumLoss: CALENDAR_RECOVERY_LOSS });
  const common = { templateId: TEMPLATE, templateVersion: 1, packageTemplateManifestHash: templateHash,
    seriesId: 'base-arbitrum-calendar-v1', seriesVersion: 1, seriesManifestHash: seriesHash,
    executionClassId: CLASS, executionClassVersion: 1, executionClassManifestHash: executionClassHash };
  const nonce = BigInt(`0x${toHex(calendarCommitment({ owner: input.owner.toLowerCase(), requestId: input.requestId })).slice(0, 16)}`);
  const prepareDeadline = input.now + 900n;
  const commitDeadline = input.now + 1_200n;
  const compensationDeadline = input.now + 7_200n;
  const graph = packageGraph({
    ...common, graphVersion: 1, environment: 'testnet', lifecycleAction: 'ENTRY', owner: input.owner.toLowerCase(),
    strategyAccountRefs: observations.map(o => o.account.toLowerCase()), settlementClass: 'CROSS_DOMAIN_PREPOSITIONED',
    legs: observations.map(o => ({
      legId: o.role, legFamily: 'FUTURE_OPEN', legTypeId: o.role, domain: o.domain,
      adapter: adapterRef({ adapterId: o.adapterIdentity.subjectId, adapterManifestVersion: o.adapterIdentity.manifestVersion,
        adapterManifestHash: o.adapterIdentity.manifestHash }),
      venue: versionedManifestRef(o.instrument.toLowerCase(), 1, o.instrumentCodeHash),
      market: versionedManifestRef(o.adapter.toLowerCase(), 1, o.adapterCodeHash),
      assets: [base, quoteAsset], quantityAsset: base, side: o.role === 'near-future' ? 'BUY' : 'SELL',
      quantityAtoms: CALENDAR_QUANTITY, minimumQuantityAtoms: CALENDAR_QUANTITY,
      maximumFeeQuoteAtoms: CALENDAR_COLLATERAL,
      preconditionHashes: [calendarCommitment(calendarProjection(o))], postconditionHashes: [],
      timeInForce: 'IOC', legExpiryValue: commitDeadline,
    })),
    dependencyEdges: [], executionGroups: observations.map(o => ({ groupId: o.role, kind: 'ALL_OR_NONE', legIds: [o.role] })),
    policyHashes: { netting: calendarCommitment('no-cross-owner-netting'), privacy: calendarCommitment('public-testnet'),
      solver: calendarCommitment(observations.map(o => o.solver)), delivery: projectionHash,
      resource: calendarCommitment({ callsPerDomain: 1, gasPerCall: 1_500_000n }), portfolioRiskLimits: template.riskPolicyHash },
    recoverySlots: observations.map(o => ({ legId: o.role, action: 'ROLLBACK', maximumQuantityAtoms: CALENDAR_QUANTITY,
      maximumCostQuoteAtoms: CALENDAR_RECOVERY_LOSS })),
    maximumRecoveryCostQuoteAtoms: 2n * CALENDAR_RECOVERY_LOSS,
    expiryUnit: 'EVM_UNIX_SECONDS', packageExpiryValue: compensationDeadline, nonce,
  });
  requireCondition(validateStrategyTemplateGraph(graph).valid, 'calendar graph is not supported');
  const graphHash = packageGraphHash(graph);
  const order = strategyPackageOrder({
    ...common, version: 1, environment: 'testnet', graphHash,
    quoteConventionId: 'forward-basis-v1', riskClassId: 'calendar-spread-v1',
    owner: input.owner.toLowerCase(), settlementAccount: input.owner.toLowerCase(), lifecycleAction: 'ENTRY',
    settlementClass: 'CROSS_DOMAIN_PREPOSITIONED', packageOrderType: 'MARKETABLE_LIMIT', packageTimeInForce: 'FOK',
    economicQuantity: assetAmount(base, CALENDAR_QUANTITY), quoteAsset, metricLimits: [],
    maximumServiceFeesByAsset: [], maximumVenueFeesByAsset: [{ asset: quoteAsset, maxAtoms: 2n * CALENDAR_COLLATERAL }],
    maximumNetworkFeesByAsset: [], maximumRecoveryCostByAsset: [{ asset: quoteAsset, maxAtoms: 2n * CALENDAR_RECOVERY_LOSS }],
    maximumMarginIncrease: assetAmount(quoteAsset, 2n * CALENDAR_COLLATERAL), maximumResidualValue: assetAmount(quoteAsset, 0n),
    expiryUnit: 'EVM_UNIX_SECONDS', expiryValue: compensationDeadline, nonce,
  });
  const orderHash = strategyPackageOrderHash(order);
  const route: TypedStrategyRoute = {
    version: 1, environment: protocolId('testnet'), orderHash, graphHash, solverId: protocolId(CLASS),
    settlementClass: 'CROSS_DOMAIN_PREPOSITIONED',
    legs: graph.legs.map(leg => ({ legId: leg.legId, domain: leg.domain, adapter: leg.adapter, legFamily: leg.legFamily,
      materializationClassId: protocolId(CLASS), executionPlanKind: 'EVM_ATOMIC_BATCH', stage: 0, groupId: leg.legId })),
    domainPlans: observations.map(o => ({ domain: o.domain, executionPlanKind: 'EVM_ATOMIC_BATCH', legIds: [protocolId(o.role)], stageCount: 1 })),
    routeExpiryUnit: 'EVM_UNIX_SECONDS', routeExpiryValue: compensationDeadline,
  };
  const routeHash = typedStrategyRouteHash(route);
  const quote = buildSignedStrategyPackageQuote({
    ...common, version: 1, environment: 'testnet', domains: observations.map(o => o.domain), orderHash, graphHash, routeHash,
    quoteConventionId: 'forward-basis-v1', riskClassId: 'calendar-spread-v1', solverId: CLASS,
    solverCapabilityManifestHash: executionClassHash, quoteMode: 'EXECUTION_COMMITMENT', settlementClass: 'CROSS_DOMAIN_PREPOSITIONED', quoteAsset,
    economics: { templateId: TEMPLATE, values: { nearPriceTicks: near.entryNotionalWad, farPriceTicks: far.entryNotionalWad,
      nearMaturityMs: near.maturity * 1_000n, farMaturityMs: far.maturity * 1_000n, netMarginAtoms: 2n * CALENDAR_COLLATERAL } },
    legEconomics: observations.map(o => ({ legId: o.role, quantity: assetAmount(base, CALENDAR_QUANTITY),
      grossNotional: assetAmount(quoteAsset, (o.maximumNotionalWad + SCALE - 1n) / SCALE),
      marginDelta: assetAmount(quoteAsset, CALENDAR_COLLATERAL), venueFee: assetAmount(quoteAsset, (10n ** 18n - o.minimumBalanceWad + SCALE - 1n) / SCALE),
      builderFee: assetAmount(quoteAsset, 0n), residualValue: assetAmount(quoteAsset, 0n) })),
    netPackageOutcomeAtoms: 0n, serviceCharges: [], passThroughCosts: [], feePolicyVersion: 1,
    feePolicyManifestHash: calendarCommitment(observations.map(o => ({ domain: o.domain, version: o.feePolicyVersion, manifestHash: o.feePolicyManifestHash }))),
    validUntilUnit: 'EVM_UNIX_SECONDS', validUntilValue: prepareDeadline, quoteNonce: nonce,
  }, input.signer);
  const quoteHash = strategyPackageQuoteHash(quote);
  const commitments = { orderHash, graphHash, quoteHash, routeHash };
  const domains: CrossDomainWalletDraft['execution']['domains'][number][] = [];
  const lanes: CrossDomainWalletDraft['lanes'][number][] = [];
  for (const o of observations) {
    const identity = { packageId: o.packageId, orderHash: `0x${toHex(orderHash)}` as Hex,
      quoteHash: `0x${toHex(quoteHash)}` as Hex, routeHash: `0x${toHex(routeHash)}` as Hex };
    const size = o.role === 'near-future' ? CALENDAR_QUANTITY : -CALENDAR_QUANTITY;
    const args = (deadline: bigint, sizeDeltaWad: bigint, balanceDeltaWad: bigint) => encodeTestPerpTradeArgs({
      deadline, expiry: Number(o.maturity), sizeDeltaWad, balanceDeltaWad,
    }).map(value => `0x${toHex(value)}`) as [Hex, Hex];
    const payload = encodeAbiParameters(RECOVERABLE_PERP_ENTRY_PARAMETERS, [1, o.generation + 1n, { ...identity,
      expectedPrePositionHash: keccak256(encodeAbiParameters(parseAbiParameters('int128,int128,uint128,uint128,int128'), [0n, 0n, 0n, 0n, 0n])),
      tradeArgs: args(commitDeadline, size, CALENDAR_COLLATERAL * SCALE), expectedPostSizeWad: size,
      minimumPostBalanceWad: o.minimumBalanceWad, maximumPostBalanceWad: o.maximumBalanceWad,
      minimumPostEntryNotionalWad: o.entryNotionalWad * 98n / 100n, maximumPostEntryNotionalWad: o.maximumNotionalWad,
      expectedReserveBeforeAtoms: 0n, minimumReserveAfterAtoms: 0n, maximumReserveAfterAtoms: 0n,
      collateralInAtoms: CALENDAR_COLLATERAL, collateralOutAtoms: 0n, withdrawAll: false, minimumCollateralOutAtoms: 0n, maximumCollateralOutAtoms: 0n,
    }]);
    const recoveryPayload = encodeAbiParameters(RECOVERABLE_PERP_CLOSE_PARAMETERS, [2, { ...identity,
      generation: o.generation + 1n, entryPayloadHash: keccak256(payload), expectedSizeWad: size,
      tradeArgs: args(compensationDeadline, -size, 0n), minimumCollateralOutAtoms: CALENDAR_COLLATERAL - CALENDAR_RECOVERY_LOSS,
      maximumCollateralOutAtoms: CALENDAR_COLLATERAL + CALENDAR_RECOVERY_LOSS,
    }]);
    const notional = (o.maximumNotionalWad + SCALE - 1n) / SCALE;
    const nextState = `0x${toHex(calendarCommitment({ identity, projection: calendarProjection(o), generation: o.generation + 1n }))}` as Hex;
    const envelope = (recovery: boolean) => compileEvmMultiStrategyAccountEnvelope({
      compiled: { ...commitments, domains: [o.domain], payload: { version: 1, planKind: 'EVM_ATOMIC_BATCH', guarantee: 'ATOMIC_POSTCONDITION',
        domain: o.domain, strategyAccount: o.account, packageId: o.packageId, totalGasLimit: 1_500_000n,
        stages: [{ stage: 0, calls: [{ legId: o.role, stage: 0, materializationClassId: CLASS, value: 0n,
          adapter: o.adapter, adapterCodeHash: o.adapterCodeHash, gasLimit: 1_500_000n, data: recovery ? recoveryPayload : payload,
          dataHash: keccak256(recovery ? recoveryPayload : payload) }] }] } },
      account: o.account, chainId: Number(o.domain.domainId.slice(7)), operation: recovery ? 'EMERGENCY_UNWIND' : 'ENTRY',
      packageId: o.packageId, templateId: TEMPLATE, templateVersion: 1, templateManifestHash: o.localTemplateHash,
      previousStateHash: recovery ? nextState : ZERO, nextStateHash: recovery ? ZERO : nextState, totalGrossNotionalAtoms: notional,
      risk: { ...o.risk, grossQuoteAtoms: recovery ? 0n : notional, netQuoteAtoms: recovery ? 0n : notional,
        marginQuoteAtoms: recovery ? 0n : CALENDAR_COLLATERAL, reservedRecoveryQuoteAtoms: recovery ? 0n : CALENDAR_COLLATERAL,
        dependencyExposures: o.risk.dependencyExposures.map(d => ({ ...d, grossQuoteAtoms: !recovery && d.dependencyId === o.adapterIdentity.subjectId ? notional : 0n })) },
      fees: recovery ? { policyVersion: 0, policyManifestHash: ZERO, token: ZERO_ADDRESS, protocolFeeAtoms: 0n, solverFeeAtoms: 0n }
        : { policyVersion: o.feePolicyVersion, policyManifestHash: o.feePolicyManifestHash, token: o.quoteToken, protocolFeeAtoms: 0n, solverFeeAtoms: 0n },
      solver: recovery ? ZERO_ADDRESS : o.solver, nonce: o.nonce + (recovery ? 1n : 0n), deadline: recovery ? compensationDeadline : commitDeadline,
      callPolicies: [{ legId: o.role, adapter: o.adapterIdentity, expectedAdapterAddress: o.adapter, expectedAdapterCodeHash: o.adapterCodeHash,
        riskIncreasing: !recovery, ...(recovery ? {} : { approvalToken: o.quoteToken }), approvalAtoms: recovery ? 0n : CALENDAR_COLLATERAL,
        grossNotionalAtoms: notional }],
    });
    domains.push({ kind: 'EVM_MULTI_STRATEGY_ACCOUNT', domain: o.domain, routeSettlementClass: 'CROSS_DOMAIN_PREPOSITIONED',
      localGuarantee: 'ATOMIC_POSTCONDITION', legIds: [o.role], envelope: envelope(false) });
    lanes.push({ domainId: o.domain.domainId, inventoryReservationId: await o.reservationId(identity.orderHash, nonce),
      interimExposureQuoteAtoms: notional, recovery: envelope(true), maximumRecoveryCostQuoteAtoms: CALENDAR_RECOVERY_LOSS,
      executorClassId: o.executorClassId, executorClassVersion: o.executorClassVersion, executorClassManifestHash: o.executorClassManifestHash });
  }
  const draft: CrossDomainWalletDraft = {
    version: 1, owner: input.owner, execution: { version: 1,
      identity: { packageId: calendarCommitment({ owner: input.owner.toLowerCase(), requestId: input.requestId }),
        templateId: TEMPLATE, templateVersion: 1, templateManifestHash: templateHash, operation: 'ENTRY' },
      settlementClass: 'CROSS_DOMAIN_PREPOSITIONED', coordination: 'CROSS_DOMAIN_PREPOSITIONED', ...commitments, domains },
    plan: { planVersion: 2, environment: 'testnet', orderHash, quoteHash, routeHash, timeUnit: 'EVM_UNIX_SECONDS',
      prepareDeadline, commitDeadline, compensationDeadline,
      maximumInterimExposureQuoteAtoms: lanes.reduce((sum, lane) => sum + lane.interimExposureQuoteAtoms, 0n) }, lanes,
  };
  return { draft, documents: { template, projections, graph, order, route, quote } };
}
