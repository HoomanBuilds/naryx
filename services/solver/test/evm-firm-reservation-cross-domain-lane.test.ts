import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  encodeEvmMultiStrategyAccountExecution,
  encodeEvmMultiStrategyAccountRecovery,
  evmMultiStrategyExecutionHash,
  evmMultiStrategyCallsHash,
  type EvmMultiStrategyAccountEnvelope,
} from '@naryx/adapter-evm';
import {
  commitmentHash,
  crossDomainCompensationAction,
  crossDomainCompensationActionHash,
  crossDomainPlanHash,
  domainRef,
  hash32,
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
  parseAbiParameters,
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
import { EXACT_SPOT_PARAMETERS, RECOVERABLE_PERP_ENTRY_PARAMETERS, RECOVERABLE_PERP_CLOSE_PARAMETERS,
  validateEvmFullReversal, validateEvmRecoveryAdapterState, validateEvmDerivativeRecoveryState,
  type EvmRecoveryAdapterPolicy, type EvmRecoveryAdapterState } from '../src/evm-full-reversal-policy.js';
import { SqliteCrossDomainJobStore, validateCrossDomainJob, type CrossDomainJob } from '../src/cross-domain-job-store.js';
import { CrossDomainWorker } from '../src/cross-domain-worker.js';
import { loadCrossDomainRuntime } from '../src/cross-domain-runtime.js';

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
  operationIds: string[] = [];
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
    operationId?: string;
    to: Address;
    data: Hex;
    gas: bigint;
    maximumFeePerGasWei: bigint;
  }>): Promise<Hex> {
    if (input.operationId !== undefined) this.operationIds.push(input.operationId);
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
    accountOwner: async () => owner.address,
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

test('failed entry releases unused inventory without charging the filled-position loss ceiling', async () => {
  const f = await recoverableSetup();
  f.config.maximumCompensationCostQuoteAtoms = -1n;
  assert.throws(() => f.lane(), /recovery loss limit/);
  f.config.maximumCompensationCostQuoteAtoms = 10n;
  f.observed.set(`${f.input.planHash}:COMMIT`, { status: 'REVERTED', transactionHash: hex('f') });
  let releaseGas = 0n;
  const submit = f.base.submit.bind(f.base);
  f.base.submit = async input => { releaseGas = input.gas; return submit(input); };
  f.base.now = f.base.reservationValue.expiry - 1n;
  assert.equal((await f.lane().start(f.input)).status, 'PENDING');
  assert.equal(f.base.submitted.length, 0);
  f.base.now = f.base.reservationValue.expiry + 1n;
  assert.equal((await f.lane().start(f.input)).status, 'OBSERVED');
  assert.equal(releaseGas, 300_000n);
  assert.equal(f.base.submitted[0]?.to, bookAddress);
  assert.equal(f.base.submitted[0]?.data, releaseData);
  assert.equal((await f.lane().awaitFinality({ ...f.input, evidenceHash: commitmentHash(f.input.planLeg.inventoryReservationId) })).status, 'FINALIZED');
  assert.equal(f.base.nonce, 0n);
});

test('admission requires live ownership and both authorizations before any submission', async () => {
  const f = await recoverableSetup();
  const input = { ...f.input, phase: 'PREPARE' as const, action: { kind: 'PREPARE' as const, domainId: domain.domainId } };
  await f.lane().validateAdmission(input);
  const lane = f.lane();
  const accountOwner = lane.port.accountOwner;
  Object.assign(lane.port, { accountOwner: async () => address('f') });
  await assert.rejects(lane.validateAdmission(input), /does not own/);
  Object.assign(lane.port, { accountOwner });
  const tampered = { ...input, execution: { ...f.input.execution, envelope: { ...f.entry,
    calls: f.entry.calls.map(call => ({ ...call, gasLimit: call.gasLimit + 1n })) } } };
  await assert.rejects(lane.validateAdmission(tampered), /signatures recover/);
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

test('derivative recovery binds the entry generation, complete position and collateral loss limit', async () => {
  const f = await recoverableSetup();
  const policy: EvmRecoveryAdapterPolicy = { ...f.config.recoveryAdapters[0]!, kind: 'RECOVERABLE_PERP' };
  const identity = { packageId: f.entry.execution.packageId, orderHash: f.entry.execution.orderHash,
    quoteHash: f.entry.execution.quoteHash, routeHash: f.entry.execution.routeHash };
  const opening = { ...identity,
    expectedPrePositionHash: keccak256(encodeAbiParameters(parseAbiParameters('int128,int128,uint128,uint128,int128'), [0n, 0n, 0n, 0n, 0n])),
    tradeArgs: [hex('1'), hex('2')] as const, expectedPostSizeWad: -10n,
    minimumPostBalanceWad: 200n, maximumPostBalanceWad: 200n,
    minimumPostEntryNotionalWad: 10n, maximumPostEntryNotionalWad: 10n,
    expectedReserveBeforeAtoms: 0n, minimumReserveAfterAtoms: 300n, maximumReserveAfterAtoms: 300n,
    collateralInAtoms: 500n, collateralOutAtoms: 0n, withdrawAll: false, minimumCollateralOutAtoms: 0n, maximumCollateralOutAtoms: 0n };
  const entryPayload = encodeAbiParameters(RECOVERABLE_PERP_ENTRY_PARAMETERS, [1, 1n, opening]);
  const close = { ...identity, generation: 1n, entryPayloadHash: keccak256(entryPayload), expectedSizeWad: -10n,
    tradeArgs: [hex('1'), hex('3')] as const, minimumCollateralOutAtoms: 497n, maximumCollateralOutAtoms: 600n };
  const entry = { ...f.entry, calls: [{ ...f.entry.calls[0]!, payload: entryPayload, approvalAtoms: 500n, riskIncreasing: true }] };
  const recovery = { ...f.recovery.envelope, calls: [{ ...f.recovery.envelope.calls[0]!, approvalAtoms: 0n,
    payload: encodeAbiParameters(RECOVERABLE_PERP_CLOSE_PARAMETERS, [2, close]) }] };
  const validate = (change = {}) => validateEvmFullReversal(entry, { ...recovery, calls: [{ ...recovery.calls[0]!,
    payload: encodeAbiParameters(RECOVERABLE_PERP_CLOSE_PARAMETERS, [2, { ...close, ...change }]) }] }, [policy]);
  const reversal = validate();
  assert.equal(reversal.maximumEntryQuoteAtoms, 502n);
  assert.equal(reversal.maximumLossQuoteAtoms, 5n);
  assert.equal(reversal.spotBaseDeltas.size, 0);
  for (const change of [{ generation: 2n }, { entryPayloadHash: hex('f') }]) assert.throws(() => validate(change), /exact entry/);
  assert.throws(() => validate({ expectedSizeWad: -9n }), /exact entry size/);
  assert.throws(() => validate({ minimumCollateralOutAtoms: 0n }), /proceeds/);
  assert.throws(() => validateEvmFullReversal(entry, { ...recovery, calls: [{ ...recovery.calls[0]!, approvalAtoms: 1n }] }, [policy]), /approval/);
  assert.throws(() => validateEvmFullReversal({ ...entry, calls: [{ ...entry.calls[0]!, payload: `${entryPayload}00` }] }, recovery, [policy]), /noncanonical/);
  const state: EvmRecoveryAdapterState = { ...policy, account: accountAddress, packageId: identity.packageId,
    classId: keccak256(stringToHex('naryx.evm.perp-recoverable')), classVersion: 1,
    derivative: { generation: 0n, entryPayloadHash: hex('0'), entrySizeWad: 0n, sizeWad: 0n, balanceWad: 0n, entryNotionalWad: 0n, reserveAtoms: 0n } };
  const binding = reversal.derivatives.get(policy.address)!;
  validateEvmRecoveryAdapterState(policy, state, entry);
  validateEvmDerivativeRecoveryState(binding, state);
  assert.throws(() => validateEvmDerivativeRecoveryState(binding, state, true), /flatten/);
  const active = { ...state, derivative: { ...state.derivative!, generation: 1n, entryPayloadHash: close.entryPayloadHash,
    entrySizeWad: -10n, sizeWad: -10n, balanceWad: 190n, entryNotionalWad: 10n, reserveAtoms: 300n } };
  validateEvmDerivativeRecoveryState(binding, active);
  assert.throws(() => validateEvmDerivativeRecoveryState(binding, active, true), /flatten/);
  const closed = { ...state, derivative: { ...state.derivative!, generation: 1n } };
  validateEvmDerivativeRecoveryState(binding, closed, true);
  assert.throws(() => validateEvmDerivativeRecoveryState(binding, { ...closed, derivative: { ...closed.derivative, reserveAtoms: 1n } }, true), /flatten/);
  assert.throws(() => validateEvmDerivativeRecoveryState(binding, { ...closed, derivative: { ...closed.derivative, generation: 2n } }), /unrelated/);
  assert.throws(() => validateEvmRecoveryAdapterState(policy, { ...state, classId: keccak256(stringToHex('naryx.evm.perp-exact')) }, entry), /deployment/);
  validateEvmRecoveryAdapterState({ ...policy, kind: 'RECOVERABLE_FUTURE' }, { ...state,
    classId: keccak256(stringToHex('naryx.evm.future-recoverable')) }, entry);
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
  assert.equal(f.base.operationIds[0], `${f.input.planHash}:COMPENSATE`);
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

async function durableJobFixture() {
  const f = await recoverableSetup();
  const secondDomain = plan.legs[1]!.domain;
  const secondCompensation = { ...f.input.compensation, domain: secondDomain,
    inventoryReservationId: plan.legs[1]!.inventoryReservationId, legIds: plan.legs[1]!.legIds };
  const jobPlan = { ...f.input.plan, legs: [f.input.plan.legs[0]!, { ...f.input.plan.legs[1]!,
    compensationActionHash: crossDomainCompensationActionHash(secondCompensation) }] };
  const job: CrossDomainJob = {
    version: 1, bundle: { plan: jobPlan, compensations: [f.input.compensation, secondCompensation] },
    execution: { version: 1,
      identity: { packageId: hash32(hash('2')), templateId: 'test-spot-package', templateVersion: 1,
        templateManifestHash: hash32(hash('5')), operation: 'ENTRY' },
      settlementClass: 'CROSS_DOMAIN_PREPOSITIONED', coordination: 'CROSS_DOMAIN_PREPOSITIONED',
      orderHash: hash32(jobPlan.orderHash), graphHash: hash32(hash('3')), quoteHash: hash32(jobPlan.quoteHash),
      routeHash: hash32(jobPlan.routeHash), crossDomainPlanHash: crossDomainPlanHash(jobPlan),
      domains: [f.input.execution, { ...f.input.execution, domain: secondDomain }],
    },
    authorizations: [{ domainId: domain.domainId, entry: f.authorization, recovery: f.recovery },
      { domainId: secondDomain.domainId, entry: { ...f.authorization, domain: secondDomain, chainId: 421_614 }, recovery: f.recovery }],
  };
  return job;
}

test('durable job intake is immutable, fences accounts and retains escalation fences across restart', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'naryx-cross-domain-jobs-'));
  let store = new SqliteCrossDomainJobStore(join(folder, 'jobs.sqlite'));
  try {
    const job = await durableJobFixture();
    const hash = store.admit(job);
    assert.equal(store.admit(job), hash);
    store.close();
    store = new SqliteCrossDomainJobStore(join(folder, 'jobs.sqlite'));
    assert.equal(validateCrossDomainJob(store.get(hash)!), hash);
    const changedSignature = { ...job, authorizations: job.authorizations.map(a => ({ ...a, entry: { ...a.entry, ownerSignature: hex('f') } })) };
    assert.throws(() => store.admit(changedSignature), /immutable authorizations/);
    const anotherPlan = { ...job.bundle.plan, prepareDeadline: job.bundle.plan.prepareDeadline + 1n };
    const another = { ...job, bundle: { ...job.bundle, plan: anotherPlan },
      execution: { ...job.execution, crossDomainPlanHash: crossDomainPlanHash(anotherPlan) } };
    assert.throws(() => store.admit(another), /fenced/);
    store.record(hash, 'ESCALATION_REQUIRED');
    assert.equal(store.active().length, 0);
    assert.throws(() => store.admit(another), /fenced/);
    assert.throws(() => store.record(hash, 'TERMINAL'), /only active/);
  } finally { store.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('worker coalesces ticks, resumes durable jobs and never advances a terminal job', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'naryx-cross-domain-worker-'));
  const store = new SqliteCrossDomainJobStore(join(folder, 'jobs.sqlite'));
  try {
    const job = await durableJobFixture();
    const hash = store.admit(job);
    let attempts = 0;
    const worker = new CrossDomainWorker(store, { advance: async () => {
      attempts++;
      await Promise.resolve();
      if (attempts === 1) throw new Error('transient endpoint failure');
      return { planHash: hash, status: 'TERMINAL', state: { terminalState: 'RECOVERED_FLAT' } as never };
    } }, { validate: () => {}, reconcileTerminal: async () => true });
    await worker.drain();
    assert.equal(attempts, 0);
    await Promise.all([worker.tick(), worker.tick()]);
    assert.equal(attempts, 1);
    assert.equal(store.active().length, 1);
    await worker.tick();
    assert.equal(store.active().length, 0);
    await worker.tick();
    assert.equal(attempts, 2);
  } finally { store.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('manual-intervention terminal outcomes never release account fences', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'naryx-cross-domain-fenced-'));
  const store = new SqliteCrossDomainJobStore(join(folder, 'jobs.sqlite'));
  try {
    const job = await durableJobFixture();
    const hash = store.admit(job);
    const worker = new CrossDomainWorker(store, { advance: async () => ({ planHash: hash, status: 'TERMINAL',
      state: { terminalState: 'MANUAL_INTERVENTION' } as never }) }, { validate: () => {}, reconcileTerminal: async () => true });
    await worker.tick();
    assert.equal(store.active().length, 0);
    const nextPlan = { ...job.bundle.plan, prepareDeadline: 101n };
    assert.throws(() => store.admit({ ...job, bundle: { ...job.bundle, plan: nextPlan },
      execution: { ...job.execution, crossDomainPlanHash: crossDomainPlanHash(nextPlan) } }), /fenced/);
  } finally { store.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('cross-domain runtime is explicitly disabled by default', async () => {
  assert.equal(await loadCrossDomainRuntime({}), undefined);
  assert.equal(await loadCrossDomainRuntime({ NARYX_CROSS_DOMAIN_ENABLED: 'false' }), undefined);
  await assert.rejects(loadCrossDomainRuntime({ NARYX_CROSS_DOMAIN_ENABLED: 'yes' }), /enable flag/);
  await assert.rejects(loadCrossDomainRuntime({ NARYX_CROSS_DOMAIN_ENABLED: 'true' }), /missing runtime config/);
});

test('running workers enforce their own cohort and require chain evidence before clearing fences', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'naryx-cross-domain-policy-'));
  const store = new SqliteCrossDomainJobStore(join(folder, 'jobs.sqlite'));
  try {
    let calls = 0;
    let allowed = false;
    let chainReconciled = false;
    const job = await durableJobFixture();
    const hash = store.admit(job);
    const worker = new CrossDomainWorker(store, { advance: async () => {
      calls++;
      return { planHash: hash, status: 'TERMINAL', state: { terminalState: 'NO_EFFECT' } as never };
    } }, { validate: () => { if (!allowed) throw new Error('unqualified cohort'); },
      reconcileTerminal: async () => chainReconciled });
    await worker.tick();
    assert.equal(calls, 0);
    allowed = true;
    await worker.tick();
    assert.equal(calls, 1);
    assert.equal(store.active().length, 1);
    chainReconciled = true;
    await worker.tick();
    assert.equal(store.active().length, 0);
  } finally { store.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('unused reservations release only after finalized expiry and under a distinct journal operation', async () => {
  const f = await recoverableSetup();
  const lane = f.lane(), submit = lane.port.submit.bind(lane.port);
  let releaseGas = 0n;
  Object.assign(lane.port, { submit: async (input: Parameters<typeof submit>[0]) => {
    if (input.operationId.endsWith(':RELEASE')) releaseGas = input.gas;
    return submit(input);
  } });
  assert.equal(await f.lane().settleUnusedReservation(f.input), false);
  assert.equal(f.base.submitted.length, 0);
  f.base.now = 251n;
  assert.equal(await f.lane().settleUnusedReservation(f.input), false);
  assert.equal(f.base.submitted[0]?.to, bookAddress);
  assert.equal(f.base.submitted[0]?.data, releaseData);
  assert.equal(f.base.operationIds[0], `${f.input.planHash}:RELEASE`);
  assert.equal(releaseGas, 300_000n);
  assert.equal(await f.lane().settleUnusedReservation(f.input), true);
  assert.equal(f.base.submitted.length, 1);
  f.base.reservationValue = { ...f.base.reservationValue, state: 'LIVE', orderHash: hex('f') };
  await assert.rejects(f.lane().settleUnusedReservation(f.input), /reservation differs/);
});
