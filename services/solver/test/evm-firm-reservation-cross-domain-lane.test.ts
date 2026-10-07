import assert from 'node:assert/strict';
import test from 'node:test';
import {
  encodeEvmMultiStrategyAccountExecution,
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
    approvalToken: address('7'),
    approvalAtoms: 1_000n,
    grossNotionalAtoms: 1_000n,
    gasLimit: 500_000n,
    payload: '0x12345678' as Hex,
  }] as const;
  const typedDomain = {
    name: 'Naryx Multi Strategy Account',
    version: '1',
    chainId: 84_532,
    verifyingContract: accountAddress,
  } as const;
  const message = { executionHash: hex('b'), callsHash: hex('c') } as const;
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
    expiry: 60n,
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
  return { driver, input, port };
}

function eventSummary(event: CrossDomainEvent | undefined) {
  return {
    kind: event?.kind,
    finality: event === undefined || event.kind === 'PREPARE_FAILED' ? undefined : event.finality,
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
  port.now = 61n;
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
