import assert from 'node:assert/strict';
import test from 'node:test';
import {
  encodeEvmMultiStrategyAccountExecution,
  encodeEvmMultiStrategyAccountRecovery,
  evmMultiStrategyExecutionHash,
  evmMultiStrategyCallsHash,
  type EvmMultiStrategyAccountEnvelope,
} from '@naryx/adapter-evm';
import {
  crossDomainCompensationAction,
  crossDomainCompensationActionHash,
  crossDomainPlanHash,
  domainRef,
  toHex,
  type CrossDomainEvent,
  type CrossDomainPlanInput,
} from '@naryx/protocol-types';
import {
  encodeFunctionData,
  encodeAbiParameters,
  hashTypedData,
  keccak256,
  parseAbi,
  stringToHex,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  EvmCrossDomainExecutionDriver,
  EvmFirmReservationCrossDomainLane,
  type AuthorizedEvmStrategyExecution,
  type CrossDomainDriverAdvanceInput,
  type EvmAtomicPackageReceipt,
  type EvmAtomicPackageState,
  type EvmFirmReservationCrossDomainPort,
  type EvmFirmReservationRecord,
  type PreparedStrategyDomainTransport,
} from '../src/index.js';
import { EvmRecoverableCrossDomainLane } from '../src/evm-recoverable-cross-domain-lane.js';
import type { EvmCrossDomainSubmissionObservation, EvmRecoverableCrossDomainPort } from '../src/evm-cross-domain-recovery-port.js';
import { EXACT_SPOT_PARAMETERS, validateEvmFullReversal, validateEvmRecoveryAdapterState } from '../src/evm-full-reversal-policy.js';

const RELEASE_ABI = parseAbi(['function releaseExpired(bytes32 reservationId)']);
const hash = (byte: string): string => byte.repeat(64);
const hex = (byte: string): Hex => `0x${hash(byte)}`;
const address = (byte: string): Address => `0x${byte.repeat(40)}` as Address;
const domain = domainRef('eip155:84532', 1, hash('1'));
const reservationId = hex('6');
const accountAddress = address('3');
const bookAddress = address('4');
const owner = privateKeyToAccount(`0x${'1'.repeat(64)}`);
const solver = privateKeyToAccount(`0x${'2'.repeat(64)}`);
const bookCodeHash = hex('7');
const accountCodeHash = hex('8');
const receiptHash = hex('9');
const releaseData = encodeFunctionData({
  abi: RELEASE_ABI,
  functionName: 'releaseExpired',
  args: [reservationId],
});
const compensation = crossDomainCompensationAction({
  actionVersion: 1,
  environment: 'testnet',
  orderHash: hash('a'),
  quoteHash: hash('b'),
  routeHash: hash('c'),
  domain,
  legIds: ['spot'],
  inventoryReservationId: hash('6'),
  actionKind: 'RELEASE_RESERVED_INVENTORY',
  executorClassId: 'evm-firm-reservation-v1',
  executorClassVersion: 1,
  executorClassManifestHash: hash('d'),
  actionPayloadHash: keccak256(releaseData).slice(2),
  maximumCostQuoteAtoms: 10n,
  expiryUnit: 'EVM_UNIX_SECONDS',
  expiryValue: 300n,
});
const plan: CrossDomainPlanInput = {
  planVersion: 1,
  environment: 'testnet',
  orderHash: hash('a'),
  quoteHash: hash('b'),
  routeHash: hash('c'),
  timeUnit: 'EVM_UNIX_SECONDS',
  prepareDeadline: 100n,
  commitDeadline: 200n,
  compensationDeadline: 300n,
  maximumInterimExposureQuoteAtoms: 2_000n,
  legs: [{
    domain,
    legIds: ['spot'],
    inventoryReservationId: hash('6'),
    interimExposureQuoteAtoms: 1_000n,
    compensationActionHash: crossDomainCompensationActionHash(compensation),
  }, {
    domain: domainRef('eip155:421614', 1, hash('e')),
    legIds: ['perp'],
    inventoryReservationId: hash('f'),
    interimExposureQuoteAtoms: 1_000n,
    compensationActionHash: hash('9'),
  }],
};

async function fixture() {
  const execution = {
    domainIdHash: keccak256(stringToHex(domain.domainId)),
    domainManifestVersion: domain.domainManifestVersion,
    domainManifestHash: hex('1'),
    packageId: hex('2'),
    orderHash: hex('a'),
    graphHash: hex('3'),
    quoteHash: hex('b'),
    routeHash: hex('c'),
    template: { templateId: hex('4'), templateVersion: 1, templateManifestHash: hex('5') },
    settlementClass: { classId: hex('6'), classVersion: 1 },
    operation: 1,
    previousStateHash: hex('0'),
    nextStateHash: hex('7'),
    totalGrossNotionalAtoms: 1_000n,
    risk: {
      riskDomainId: hex('1'), policyVersion: 1, policyManifestHash: hex('2'),
      series: { seriesId: hex('3'), manifestVersion: 1, manifestHash: hex('4') },
      accountingToken: address('5'), grossQuoteAtoms: 1_000n, netQuoteAtoms: 1_000n,
      marginQuoteAtoms: 1_000n, reservedRecoveryQuoteAtoms: 1_000n,
      observationAgeMs: 0n, timeToUnwindMs: 60_000n,
      dependencyExposures: [{ dependencyId: hex('9'), grossQuoteAtoms: 1_000n }],
    },
    fees: {
      policyVersion: 1,
      policyManifestHash: hex('8'),
      token: address('5'),
      protocolFeeAtoms: 1n,
      solverFeeAtoms: 1n,
    },
    solver: solver.address,
    nonce: 0n,
    deadline: 200n,
  } as const;
  const calls = [{
    adapter: { subjectId: hex('9'), manifestVersion: 1, manifestHash: hex('a') },
    target: address('6'),
    stage: 0,
    riskIncreasing: true,
    approvalToken: address('5'),
    approvalAtoms: 500n,
    grossNotionalAtoms: 1_000n,
    gasLimit: 500_000n,
    payload: encodeAbiParameters(EXACT_SPOT_PARAMETERS, [{ packageId: execution.packageId, orderHash: execution.orderHash,
      quoteHash: execution.quoteHash, routeHash: execution.routeHash, action: 1, baseAtoms: 1_000n, quoteBoundAtoms: 500n }]),
  }] as const;
  const typedDomain = {
    name: 'Naryx Multi Strategy Account',
    version: '1',
    chainId: 84_532,
    verifyingContract: accountAddress,
  } as const;
  const message = { executionHash: evmMultiStrategyExecutionHash(execution), callsHash: evmMultiStrategyCallsHash(calls) } as const;
  const ownerTypedData = {
    domain: typedDomain,
    primaryType: 'OwnerExecution',
    types: { OwnerExecution: [{ name: 'executionHash', type: 'bytes32' }, { name: 'callsHash', type: 'bytes32' }] },
    message,
  } as const;
  const solverTypedData = {
    domain: typedDomain,
    primaryType: 'SolverExecution',
    types: { SolverExecution: [{ name: 'executionHash', type: 'bytes32' }, { name: 'callsHash', type: 'bytes32' }] },
    message,
  } as const;
  const envelope: EvmMultiStrategyAccountEnvelope = {
    account: accountAddress,
    execution,
    calls,
    executionHash: message.executionHash,
    callsHash: message.callsHash,
    ownerTypedData,
    solverTypedData,
    ownerDigest: hashTypedData(ownerTypedData),
    solverDigest: hashTypedData(solverTypedData),
  };
  const ownerSignature = await owner.signTypedData(ownerTypedData);
  const solverSignature = await solver.signTypedData(solverTypedData);
  const authorization: AuthorizedEvmStrategyExecution = {
    version: 1,
    domain,
    chainId: 84_532,
    owner: owner.address,
    to: accountAddress,
    value: 0n,
    data: encodeEvmMultiStrategyAccountExecution({ envelope, ownerSignature, solverSignature }),
    ownerSignature,
    solverSignature,
    packageId: execution.packageId,
    orderHash: execution.orderHash,
    quoteHash: execution.quoteHash,
    routeHash: execution.routeHash,
    expectedNextStateHash: execution.nextStateHash,
    deadline: execution.deadline,
  };
  const transport: PreparedStrategyDomainTransport = {
    kind: 'EVM_MULTI_STRATEGY_ACCOUNT',
    domain,
    routeSettlementClass: 'CROSS_DOMAIN_PREPOSITIONED',
    localGuarantee: 'ATOMIC_POSTCONDITION',
    legIds: ['spot'],
    envelope,
  };
  return { authorization, transport };
}

class Port implements EvmFirmReservationCrossDomainPort {
  now = 50n;
  nonce = 0n;
  submitted: readonly Readonly<{ to: Address; data: Hex }>[] = [];
  reservationValue: EvmFirmReservationRecord = {
    domainIdHash: keccak256(stringToHex(domain.domainId)),
    domainManifestVersion: domain.domainManifestVersion,
    domainManifestHash: hex('1'),
    solver: solver.address,
    strategyAccount: accountAddress,
    packageNonce: 0n,
    orderHash: hex('a'),
    quoteHash: hex('b'),
    routeHash: hex('c'),
    baseAtoms: 1_000n,
    quoteAtoms: 500n,
    expiry: 250n,
    state: 'LIVE',
  };
  packageStateValue: EvmAtomicPackageState = {
    stateHash: hex('0'),
    lastReceiptHash: hex('0'),
    active: false,
  };
  readonly packageReceiptValue: EvmAtomicPackageReceipt = {
    packageId: hex('2'),
    orderHash: hex('a'),
    quoteHash: hex('b'),
    routeHash: hex('c'),
    nextStateHash: hex('7'),
    nonce: 0n,
    solver: solver.address,
  };

  async chainId(): Promise<bigint> { return 84_532n; }
  async currentTime(): Promise<bigint> { return this.now; }
  async codeHash(target: Address): Promise<Hex | null> {
    if (target.toLowerCase() === bookAddress.toLowerCase()) return bookCodeHash;
    if (target.toLowerCase() === accountAddress.toLowerCase()) return accountCodeHash;
    return null;
  }
  async reservation(): Promise<EvmFirmReservationRecord> { return this.reservationValue; }
  async liveReservationId(): Promise<Hex> {
    return this.reservationValue.state === 'LIVE' ? reservationId : hex('0');
  }
  async accountNextNonce(): Promise<bigint> { return this.nonce; }
  async packageState(): Promise<EvmAtomicPackageState> { return this.packageStateValue; }
  async packageReceipt(): Promise<EvmAtomicPackageReceipt> { return this.packageReceiptValue; }
  async submit(input: Readonly<{
    to: Address;
    data: Hex;
    gas: bigint;
    maximumFeePerGasWei: bigint;
  }>): Promise<Hex> {
    this.submitted = [...this.submitted, { to: input.to, data: input.data }];
    if (input.to.toLowerCase() === accountAddress.toLowerCase()) {
      this.nonce = 1n;
      this.packageStateValue = { stateHash: hex('7'), lastReceiptHash: receiptHash, active: true };
      this.reservationValue = { ...this.reservationValue, state: 'CONSUMED' };
    } else {
      this.reservationValue = { ...this.reservationValue, state: 'RELEASED' };
    }
    return hex('f');
  }
}

async function setup() {
  const built = await fixture();
  const port = new Port();
  const lane = new EvmFirmReservationCrossDomainLane({
    domain,
    chainReference: 84_532n,
    reservationBook: bookAddress,
    reservationBookCodeHash: bookCodeHash,
    strategyAccountCodeHash: accountCodeHash,
    commitGasLimit: 2_000_000n,
    compensationGasLimit: 200_000n,
    maximumFeePerGasWei: 10_000_000_000n,
    maximumCompensationCostQuoteAtoms: 5n,
  }, port, {
    resolve: async (planHash, domainId) => planHash === toHex(crossDomainPlanHash(plan))
      && domainId === domain.domainId ? built.authorization : undefined,
  });
  const driver = new EvmCrossDomainExecutionDriver(lane, {
    executorClassId: compensation.executorClassId,
    executorClassVersion: compensation.executorClassVersion,
    executorClassManifestHash: compensation.executorClassManifestHash,
    allowedActionKinds: ['RELEASE_RESERVED_INVENTORY'],
  });
  const input = (
    action: CrossDomainDriverAdvanceInput['action'],
    events: readonly CrossDomainEvent[] = [],
  ): CrossDomainDriverAdvanceInput => ({
    planHash: toHex(crossDomainPlanHash(plan)),
    action,
    plan,
    planLeg: plan.legs[0]!,
    compensation,
    execution: built.transport,
    events,
  });
  return { driver, input, port, lane };
}

function eventSummary(event: CrossDomainEvent | undefined) {
  return {
    kind: event?.kind,
    finality: event !== undefined && 'finality' in event ? event.finality : undefined,
  };
}

test('prepares and finalizes one firm atomic EVM package entry', async () => {
  const { driver, input, port } = await setup();
  const prepared = await driver.advance(input({ kind: 'PREPARE', domainId: domain.domainId }));
  assert.deepEqual(eventSummary(prepared), { kind: 'PREPARED', finality: 'FINALIZED' });
  const observed = await driver.advance(input({ kind: 'COMMIT', domainId: domain.domainId }, [prepared!])) as CrossDomainEvent;
  assert.deepEqual(eventSummary(observed), { kind: 'COMMITTED', finality: 'OBSERVED' });
  const finalized = await driver.advance(input(
    { kind: 'AWAIT_FINALITY', domainId: domain.domainId },
    [prepared!, observed],
  ));
  assert.deepEqual(eventSummary(finalized), { kind: 'COMMITTED', finality: 'FINALIZED' });
  assert.equal(port.submitted.length, 1);
  assert.equal(port.submitted[0]?.to, accountAddress);
});

test('releases only the exact expired reservation during compensation', async () => {
  const { driver, input, port } = await setup();
  port.now = 251n;
  port.reservationValue = {
    ...port.reservationValue,
    quoteHash: hex('0'),
    routeHash: hex('0'),
    state: 'FUNDED',
  };
  const observed = await driver.advance(input({ kind: 'COMPENSATE', domainId: domain.domainId })) as CrossDomainEvent;
  assert.deepEqual(eventSummary(observed), { kind: 'COMPENSATED', finality: 'OBSERVED' });
  const finalized = await driver.advance(input(
    { kind: 'AWAIT_FINALITY', domainId: domain.domainId },
    [observed],
  ));
  assert.deepEqual(eventSummary(finalized), { kind: 'COMPENSATED', finality: 'FINALIZED' });
  assert.equal(port.submitted.length, 1);
  assert.equal(port.submitted[0]?.to, bookAddress);
  assert.equal(port.submitted[0]?.data, releaseData);
});

test('preparation requires reservation coverage through commit and a bounded release window', async () => {
  const { driver, input, port } = await setup();
  for (const expiry of [plan.commitDeadline, plan.compensationDeadline]) {
    port.reservationValue = { ...port.reservationValue, expiry };
    const result = await driver.advance(input({ kind: 'PREPARE', domainId: domain.domainId }));
    assert.equal(result?.kind, 'PREPARE_FAILED');
  }
  assert.equal(port.submitted.length, 0);
});

test('reservation release cannot be presented as a filled-position reversal', async () => {
  const { lane, input, port } = await setup();
  const request = input({ kind: 'COMPENSATE', domainId: domain.domainId });
  await assert.rejects(() => lane.start({ ...request, phase: 'COMPENSATE',
    compensation: { ...request.compensation, actionKind: 'REVERSE_FILLED_LEGS' } }), /cannot reverse filled legs/);
  assert.equal(port.submitted.length, 0);
});

async function recoverableSetup() {
  const built = await fixture();
  assert.equal(built.transport.kind, 'EVM_MULTI_STRATEGY_ACCOUNT');
  if (built.transport.kind !== 'EVM_MULTI_STRATEGY_ACCOUNT') throw new Error('fixture kind');
  const entry = built.transport.envelope;
  const execution = { ...entry.execution, operation: 7, previousStateHash: entry.execution.nextStateHash,
    nextStateHash: hex('0'), nonce: 1n, deadline: 301n, solver: address('0'),
    fees: { policyVersion: 0, policyManifestHash: hex('0'), token: address('0'), protocolFeeAtoms: 0n, solverFeeAtoms: 0n } };
  const calls = entry.calls.map(call => ({ ...call, riskIncreasing: false, approvalToken: address('7'), approvalAtoms: 1_000n,
    payload: encodeAbiParameters(EXACT_SPOT_PARAMETERS, [{ packageId: execution.packageId, orderHash: execution.orderHash,
      quoteHash: execution.quoteHash, routeHash: execution.routeHash, action: 2, baseAtoms: 1_000n, quoteBoundAtoms: 497n }]) }));
  const message = { executionHash: evmMultiStrategyExecutionHash(execution), callsHash: evmMultiStrategyCallsHash(calls) };
  const ownerTypedData = { ...entry.ownerTypedData, message };
  const envelope = { ...entry, execution, calls, ...message, ownerTypedData, ownerDigest: hashTypedData(ownerTypedData) };
  const recovery = { envelope, ownerSignature: await owner.signTypedData(ownerTypedData) };
  const data = encodeEvmMultiStrategyAccountRecovery(recovery);
  const action = crossDomainCompensationAction({ ...compensation, actionKind: 'REVERSE_FILLED_LEGS', actionPayloadHash: keccak256(data) });
  const recoverablePlan = { ...plan, planVersion: 2 as const,
    legs: [{ ...plan.legs[0]!, compensationActionHash: crossDomainCompensationActionHash(action) }, plan.legs[1]!] };
  const planHash = toHex(crossDomainPlanHash(recoverablePlan));
  const observed = new Map<string, EvmCrossDomainSubmissionObservation>();
  const base = new Port();
  const port: EvmRecoverableCrossDomainPort = Object.assign(base, {
    finalizedTime: async () => base.now,
    observeSubmission: async (id: string) => observed.get(id) ?? { status: 'ABSENT' as const },
    recoveryAdapterState: async () => ({ codeHash: hex('d'), account: accountAddress, packageId: entry.execution.packageId,
      classId: keccak256(stringToHex('naryx.evm.spot-exact')), classVersion: 1, baseToken: address('7'), quoteToken: address('5') }),
  });
  const config = { domain, chainReference: 84_532n, reservationBook: bookAddress,
    reservationBookCodeHash: bookCodeHash, strategyAccountCodeHash: accountCodeHash,
    commitGasLimit: 2_000_000n, compensationGasLimit: 2_000_000n,
    maximumFeePerGasWei: 1n, maximumCompensationCostQuoteAtoms: 5n,
    recoveryAdapters: [{ address: address('6'), codeHash: hex('d'), kind: 'SPOT' as const, baseToken: address('7'), quoteToken: address('5') }] };
  const lane = () => new EvmRecoverableCrossDomainLane(config, port, {
    resolve: async () => built.authorization, resolveRecovery: async () => recovery,
  });
  const input = { planHash, plan: recoverablePlan, planLeg: recoverablePlan.legs[0]!, compensation: action,
    execution: built.transport, events: [], phase: 'COMPENSATE' as const,
    action: { kind: 'COMPENSATE' as const, domainId: domain.domainId } };
  const success = (envelope: EvmMultiStrategyAccountEnvelope, calldata: Hex): EvmCrossDomainSubmissionObservation => ({
    status: 'SUCCESS', transactionHash: hex('f'), to: accountAddress, data: calldata,
    receipt: { ...envelope.execution, callsHash: evmMultiStrategyCallsHash(envelope.calls) },
    tokenDeltas: new Map([[address('7'), envelope.execution.operation === 1 ? 1_000n : -1_000n],
      [address('5'), envelope.execution.operation === 1 ? -502n : 497n]]),
  });
  return { base, observed, lane, input, entry, recovery, data, success, config, authorization: built.authorization };
}

test('version-two recovery reverses a filled package and requires finalized close evidence after restart', async () => {
  const f = await recoverableSetup();
  f.base.now = 220n;
  f.base.nonce = 1n;
  f.base.packageStateValue = { active: true, stateHash: hex('7'), lastReceiptHash: receiptHash };
  f.base.reservationValue = { ...f.base.reservationValue, state: 'CONSUMED' };
  f.observed.set(`${f.input.planHash}:COMMIT`, f.success(f.entry, f.authorization.data));
  const submitted = await f.lane().start(f.input);
  assert.equal(submitted.status, 'OBSERVED');
  assert.equal(f.base.submitted[0]?.data, f.data);
  assert.equal(f.base.submitted[0]?.to, accountAddress);
  f.observed.set(`${f.input.planHash}:COMPENSATE`, { status: 'PENDING' });
  assert.equal((await f.lane().start(f.input)).status, 'PENDING');
  assert.equal(f.base.submitted.length, 1);
  f.observed.set(`${f.input.planHash}:COMPENSATE`, f.success(f.recovery.envelope, f.data));
  await assert.rejects(f.lane().start(f.input), /did not close/);
  f.base.nonce = 2n;
  f.base.packageStateValue = { active: false, stateHash: hex('0'), lastReceiptHash: hex('0') };
  const closeEvidence = f.success(f.recovery.envelope, f.data);
  assert.equal(closeEvidence.status, 'SUCCESS');
  if (closeEvidence.status !== 'SUCCESS') throw new Error('fixture evidence');
  f.observed.set(`${f.input.planHash}:COMPENSATE`, { ...closeEvidence, tokenDeltas: new Map([[address('7'), -999n], [address('5'), 497n]]) });
  await assert.rejects(f.lane().start(f.input), /full spot quantity/);
  f.observed.set(`${f.input.planHash}:COMPENSATE`, { ...closeEvidence, tokenDeltas: new Map([[address('7'), -1_000n], [address('5'), 496n]]) });
  await assert.rejects(f.lane().start(f.input), /realized recovery loss/);
  f.observed.set(`${f.input.planHash}:COMPENSATE`, closeEvidence);
  assert.equal((await f.lane().start(f.input)).status, 'FINALIZED');
  assert.equal(f.base.submitted.length, 1);
});

test('full reversal derives the loss bound and rejects partial, uncovered and unknown legs', async () => {
  const f = await recoverableSetup();
  const envelope = f.recovery.envelope;
  const validate = (value = envelope, policies = f.config.recoveryAdapters) => validateEvmFullReversal(f.entry, value, policies);
  assert.equal(validate().maximumLossQuoteAtoms, 5n);
  assert.throws(() => validate({ ...envelope, calls: [] }), /every entry leg/);
  assert.throws(() => validate(envelope, []), /unqualified/);
  assert.throws(() => validate({ ...envelope, calls: [envelope.calls[0]!, envelope.calls[0]!] }), /every entry leg/);
  const payload = (baseAtoms: bigint, quoteBoundAtoms: bigint) => encodeAbiParameters(EXACT_SPOT_PARAMETERS, [{
    packageId: envelope.execution.packageId, orderHash: envelope.execution.orderHash,
    quoteHash: envelope.execution.quoteHash, routeHash: envelope.execution.routeHash, action: 2, baseAtoms, quoteBoundAtoms,
  }]);
  assert.throws(() => validate({ ...envelope, calls: [{ ...envelope.calls[0]!, payload: payload(999n, 497n) }] }), /entire exact/);
  assert.throws(() => validate({ ...envelope, calls: [{ ...envelope.calls[0]!, payload: payload(1_000n, 0n) }] }), /proceeds/);
  assert.equal(validate({ ...envelope, calls: [{ ...envelope.calls[0]!, payload: payload(1_000n, 496n) }] }).maximumLossQuoteAtoms, 6n);
  f.config.maximumCompensationCostQuoteAtoms = 4n;
  await assert.rejects(f.lane().start(f.input), /recovery cost/);
  assert.equal(f.base.submitted.length, 0);
});

test('recovery preserves immutable risk policy and series identity', async () => {
  const f = await recoverableSetup();
  const risk = f.recovery.envelope.execution.risk;
  for (const change of [{ policyVersion: risk.policyVersion + 1 }, { policyManifestHash: hex('f') },
    { series: { ...risk.series, seriesId: hex('f') } }, { series: { ...risk.series, manifestVersion: 2 } },
    { series: { ...risk.series, manifestHash: hex('f') } }]) {
    f.recovery.envelope.execution.risk = { ...risk, ...change };
    await assert.rejects(f.lane().start(f.input), /exact close/);
  }
  assert.equal(f.base.submitted.length, 0);
});

test('owner recovery rejects nonzero fee policy fields before entering', async () => {
  const f = await recoverableSetup();
  const fees = f.recovery.envelope.execution.fees;
  for (const change of [{ policyVersion: 1 }, { policyManifestHash: hex('1') }, { token: address('5') }]) {
    f.recovery.envelope.execution.fees = { ...fees, ...change };
    await assert.rejects(f.lane().start({ ...f.input, phase: 'PREPARE' }), /exact close/);
  }
  assert.equal(f.base.submitted.length, 0);
});

test('recovery refuses unqualified derivative classes and changed deployments', async () => {
  const f = await recoverableSetup();
  const policy = f.config.recoveryAdapters[0]!;
  const state = { ...policy, account: accountAddress, packageId: f.entry.execution.packageId,
    classId: keccak256(stringToHex('naryx.evm.spot-exact')), classVersion: 1 };
  validateEvmRecoveryAdapterState(policy, state, f.entry);
  assert.throws(() => validateEvmRecoveryAdapterState(policy, { ...state, classId: keccak256(stringToHex('naryx.evm.perp-exact')) }, f.entry), /deployment/);
  assert.throws(() => validateEvmRecoveryAdapterState(policy, { ...state, codeHash: hex('0') }, f.entry), /deployment/);
  assert.throws(() => validateEvmFullReversal(f.entry, f.recovery.envelope, [{ ...policy, kind: 'PERP' as never }]), /unsupported adapter class/);
});

test('unknown commits remain fenced; absent commits need finalized expiry before releasing inventory', async () => {
  const f = await recoverableSetup();
  assert.equal((await f.lane().reconcileCommit(f.input)).status, 'PENDING');
  f.base.now = 251n;
  f.observed.set(`${f.input.planHash}:COMMIT`, { status: 'PENDING' });
  assert.equal((await f.lane().start(f.input)).status, 'PENDING');
  assert.equal(f.base.submitted.length, 0);
  f.observed.delete(`${f.input.planHash}:COMMIT`);
  assert.equal((await f.lane().reconcileCommit(f.input)).status, 'DEFINITIVE_COMMIT_FAILURE');
  assert.equal((await f.lane().start(f.input)).status, 'OBSERVED');
  assert.equal(f.base.submitted[0]?.data, releaseData);
  assert.equal((await f.lane().start(f.input)).status, 'FINALIZED');
});

test('recovery rejects altered payload, risk increase, wrong owner and wrong state without submission', async () => {
  const f = await recoverableSetup();
  await assert.rejects(f.lane().start({ ...f.input, compensation: { ...f.input.compensation, actionPayloadHash: hex('0') as never } }), /commitment/);
  const original = f.recovery.ownerSignature;
  f.recovery.ownerSignature = await solver.signTypedData(f.recovery.envelope.ownerTypedData);
  await assert.rejects(f.lane().start(f.input), /not the entry owner/);
  f.recovery.ownerSignature = original;
  f.recovery.envelope.calls[0]!.riskIncreasing = true;
  await assert.rejects(f.lane().start(f.input), /calls or signature/);
  f.recovery.envelope.calls[0]!.riskIncreasing = false;
  f.recovery.envelope.execution.previousStateHash = hex('9');
  await assert.rejects(f.lane().start(f.input), /exact close/);
  assert.equal(f.base.submitted.length, 0);
});
