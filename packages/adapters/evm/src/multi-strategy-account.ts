import type { CompiledStrategyExecution } from '@naryx/adapter-core';
import type { DomainRef } from '@naryx/protocol-types';
import {
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  hashTypedData,
  keccak256,
  parseAbi,
  parseAbiParameters,
  stringToHex,
  type Address,
  type Hex,
} from 'viem';
import type { EvmStrategyExecutionPlan, EvmStrategyLegCall } from './strategy-plan.js';

const ACCOUNT_ABI = parseAbi([
  'function execute((bytes32 domainIdHash,uint32 domainManifestVersion,bytes32 domainManifestHash,bytes32 packageId,bytes32 orderHash,bytes32 graphHash,bytes32 quoteHash,bytes32 routeHash,(bytes32 templateId,uint32 templateVersion,bytes32 templateManifestHash) template,(bytes32 classId,uint32 classVersion) settlementClass,uint8 operation,bytes32 previousStateHash,bytes32 nextStateHash,uint256 totalGrossNotionalAtoms,address solver,uint256 nonce,uint256 deadline) execution,((bytes32 subjectId,uint32 manifestVersion,bytes32 manifestHash) adapter,uint8 stage,bool riskIncreasing,address approvalToken,uint256 approvalAtoms,uint256 grossNotionalAtoms,uint256 gasLimit,bytes payload)[] calls,bytes ownerSignature,bytes solverSignature) returns (bytes32 receiptHash)',
  'function executeRecovery((bytes32 domainIdHash,uint32 domainManifestVersion,bytes32 domainManifestHash,bytes32 packageId,bytes32 orderHash,bytes32 graphHash,bytes32 quoteHash,bytes32 routeHash,(bytes32 templateId,uint32 templateVersion,bytes32 templateManifestHash) template,(bytes32 classId,uint32 classVersion) settlementClass,uint8 operation,bytes32 previousStateHash,bytes32 nextStateHash,uint256 totalGrossNotionalAtoms,address solver,uint256 nonce,uint256 deadline) execution,((bytes32 subjectId,uint32 manifestVersion,bytes32 manifestHash) adapter,uint8 stage,bool riskIncreasing,address approvalToken,uint256 approvalAtoms,uint256 grossNotionalAtoms,uint256 gasLimit,bytes payload)[] calls,bytes ownerSignature) returns (bytes32 receiptHash)',
]);

const EXECUTION_PARAMETERS = parseAbiParameters(
  '(bytes32 domainIdHash,uint32 domainManifestVersion,bytes32 domainManifestHash,bytes32 packageId,bytes32 orderHash,bytes32 graphHash,bytes32 quoteHash,bytes32 routeHash,(bytes32 templateId,uint32 templateVersion,bytes32 templateManifestHash) template,(bytes32 classId,uint32 classVersion) settlementClass,uint8 operation,bytes32 previousStateHash,bytes32 nextStateHash,uint256 totalGrossNotionalAtoms,address solver,uint256 nonce,uint256 deadline)',
);
const CALL_PARAMETERS = parseAbiParameters(
  '((bytes32 subjectId,uint32 manifestVersion,bytes32 manifestHash) adapter,uint8 stage,bool riskIncreasing,address approvalToken,uint256 approvalAtoms,uint256 grossNotionalAtoms,uint256 gasLimit,bytes payload)[]',
);

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;
const ZERO_HASH = `0x${'00'.repeat(32)}` as Hex;

export type EvmStrategyOperation =
  | 'ENTRY'
  | 'INCREASE'
  | 'DECREASE'
  | 'REBALANCE'
  | 'ROLL'
  | 'MIGRATE'
  | 'EXIT'
  | 'EMERGENCY_UNWIND';

const OPERATION: Readonly<Record<EvmStrategyOperation, number>> = Object.freeze({
  ENTRY: 1,
  INCREASE: 2,
  DECREASE: 3,
  REBALANCE: 4,
  ROLL: 5,
  MIGRATE: 6,
  EXIT: 7,
  EMERGENCY_UNWIND: 8,
});

export interface EvmStrategyAdapterIdentity {
  readonly subjectId: Hex;
  readonly manifestVersion: number;
  readonly manifestHash: Hex;
}

export interface EvmStrategyCallPolicy {
  readonly legId: string;
  readonly adapter: EvmStrategyAdapterIdentity;
  readonly expectedAdapterAddress: Address;
  readonly expectedAdapterCodeHash: Hex;
  readonly riskIncreasing: boolean;
  readonly approvalToken?: Address;
  readonly approvalAtoms: bigint;
  readonly grossNotionalAtoms: bigint;
}

export interface EvmMultiStrategyExecution {
  readonly domainIdHash: Hex;
  readonly domainManifestVersion: number;
  readonly domainManifestHash: Hex;
  readonly packageId: Hex;
  readonly orderHash: Hex;
  readonly graphHash: Hex;
  readonly quoteHash: Hex;
  readonly routeHash: Hex;
  readonly template: Readonly<{ templateId: Hex; templateVersion: number; templateManifestHash: Hex }>;
  readonly settlementClass: Readonly<{ classId: Hex; classVersion: number }>;
  readonly operation: number;
  readonly previousStateHash: Hex;
  readonly nextStateHash: Hex;
  readonly totalGrossNotionalAtoms: bigint;
  readonly solver: Address;
  readonly nonce: bigint;
  readonly deadline: bigint;
}

export interface EvmMultiStrategyCall {
  readonly adapter: EvmStrategyAdapterIdentity;
  readonly stage: number;
  readonly riskIncreasing: boolean;
  readonly approvalToken: Address;
  readonly approvalAtoms: bigint;
  readonly grossNotionalAtoms: bigint;
  readonly gasLimit: bigint;
  readonly payload: Hex;
}

export interface EvmMultiStrategyAccountEnvelope {
  readonly account: Address;
  readonly execution: EvmMultiStrategyExecution;
  readonly calls: readonly EvmMultiStrategyCall[];
  readonly executionHash: Hex;
  readonly callsHash: Hex;
  readonly ownerDigest: Hex;
  readonly solverDigest: Hex;
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function hash32(value: Hex, context: string): Hex {
  requireCondition(/^0x[0-9a-fA-F]{64}$/.test(value) && value.toLowerCase() !== ZERO_HASH, `${context} must be a nonzero bytes32`);
  return value.toLowerCase() as Hex;
}

function domainHash(value: DomainRef): Hex {
  return keccak256(stringToHex(value.domainId));
}

function callPolicy(call: EvmStrategyLegCall, values: readonly EvmStrategyCallPolicy[]): EvmStrategyCallPolicy {
  const matches = values.filter((value) => value.legId === call.legId);
  requireCondition(matches.length === 1, `leg ${call.legId} must resolve to exactly one account policy`);
  const result = matches[0]!;
  requireCondition(getAddress(result.expectedAdapterAddress) === getAddress(call.adapter), `leg ${call.legId} adapter address mismatch`);
  requireCondition(hash32(result.expectedAdapterCodeHash, `leg ${call.legId} adapter code hash`) === call.adapterCodeHash.toLowerCase(), `leg ${call.legId} adapter code hash mismatch`);
  requireCondition(Number.isInteger(result.adapter.manifestVersion) && result.adapter.manifestVersion > 0, `leg ${call.legId} adapter version is invalid`);
  requireCondition(result.approvalAtoms >= 0n && result.grossNotionalAtoms > 0n, `leg ${call.legId} account bounds are invalid`);
  requireCondition((result.approvalAtoms === 0n) === (result.approvalToken === undefined), `leg ${call.legId} approval token and amount must appear together`);
  return result;
}

function riskDirectionAllowed(operation: EvmStrategyOperation, riskIncreasing: boolean): boolean {
  if (operation === 'ENTRY' || operation === 'INCREASE') return riskIncreasing;
  if (operation === 'DECREASE' || operation === 'EXIT' || operation === 'EMERGENCY_UNWIND') return !riskIncreasing;
  return true;
}

function bytes32(value: Uint8Array, context: string): Hex {
  return hash32(`0x${Buffer.from(value).toString('hex')}`, context);
}

export function compileEvmMultiStrategyAccountEnvelope(input: Readonly<{
  compiled: CompiledStrategyExecution<EvmStrategyExecutionPlan>;
  account: Address;
  chainId: number;
  operation: EvmStrategyOperation;
  packageId: Hex;
  templateId: string;
  templateVersion: number;
  templateManifestHash: Hex;
  previousStateHash?: Hex;
  nextStateHash?: Hex;
  totalGrossNotionalAtoms: bigint;
  solver: Address;
  nonce: bigint;
  deadline: bigint;
  callPolicies: readonly EvmStrategyCallPolicy[];
}>): EvmMultiStrategyAccountEnvelope {
  const plan = input.compiled.payload;
  requireCondition(plan.version === 1 && plan.planKind === 'EVM_ATOMIC_BATCH' && plan.guarantee === 'ATOMIC_POSTCONDITION', 'multi-strategy account requires an atomic EVM plan');
  requireCondition(plan.stages.length > 0 && plan.stages.length <= 16, 'multi-strategy account requires 1 to 16 stages');
  requireCondition(Number.isSafeInteger(input.chainId) && input.chainId > 0, 'chain id is invalid');
  requireCondition(Number.isInteger(input.templateVersion) && input.templateVersion > 0, 'template version is invalid');
  requireCondition(input.totalGrossNotionalAtoms > 0n && input.nonce >= 0n && input.deadline > 0n, 'execution quantity, nonce, or deadline is invalid');
  const account = getAddress(input.account);
  requireCondition(getAddress(plan.strategyAccount) === account, 'plan strategy account mismatch');
  requireCondition(hash32(plan.packageId, 'plan package id') === hash32(input.packageId, 'package id'), 'plan package id mismatch');
  const calls = plan.stages.flatMap((stage, stageIndex) => {
    requireCondition(stage.stage === stageIndex && stage.calls.length > 0, 'plan stages must be contiguous and nonempty');
    return stage.calls.map((call): EvmMultiStrategyCall => {
      requireCondition(call.stage === stage.stage, `leg ${call.legId} stage mismatch`);
      const policy = callPolicy(call, input.callPolicies);
      requireCondition(riskDirectionAllowed(input.operation, policy.riskIncreasing), `leg ${call.legId} risk direction conflicts with the lifecycle operation`);
      return Object.freeze({
        adapter: Object.freeze({
          subjectId: hash32(policy.adapter.subjectId, `leg ${call.legId} adapter subject`),
          manifestVersion: policy.adapter.manifestVersion,
          manifestHash: hash32(policy.adapter.manifestHash, `leg ${call.legId} adapter manifest`),
        }),
        stage: call.stage,
        riskIncreasing: policy.riskIncreasing,
        approvalToken: policy.approvalToken === undefined ? ZERO_ADDRESS : getAddress(policy.approvalToken),
        approvalAtoms: policy.approvalAtoms,
        grossNotionalAtoms: policy.grossNotionalAtoms,
        gasLimit: call.gasLimit,
        payload: call.data,
      });
    });
  });
  requireCondition(calls.length > 0 && calls.length <= 16 && calls.length === input.callPolicies.length, 'call policies do not cover the plan exactly');
  requireCondition(
    calls.reduce((total, call) => total + call.grossNotionalAtoms, 0n) === input.totalGrossNotionalAtoms,
    'execution gross notional must equal the sum of call notionals',
  );
  const previousStateHash = input.previousStateHash === undefined ? ZERO_HASH : input.previousStateHash.toLowerCase() as Hex;
  const nextStateHash = input.nextStateHash === undefined ? ZERO_HASH : input.nextStateHash.toLowerCase() as Hex;
  requireCondition((input.operation === 'ENTRY') === (previousStateHash === ZERO_HASH), 'entry is the only operation without a previous state');
  requireCondition((input.operation === 'EXIT' || input.operation === 'EMERGENCY_UNWIND') === (nextStateHash === ZERO_HASH), 'only terminal operations produce a zero next state');
  if (previousStateHash !== ZERO_HASH) hash32(previousStateHash, 'previous state hash');
  if (nextStateHash !== ZERO_HASH) hash32(nextStateHash, 'next state hash');
  const execution: EvmMultiStrategyExecution = Object.freeze({
    domainIdHash: domainHash(plan.domain),
    domainManifestVersion: plan.domain.domainManifestVersion,
    domainManifestHash: bytes32(plan.domain.domainManifestHash, 'domain manifest hash'),
    packageId: hash32(input.packageId, 'package id'),
    orderHash: bytes32(input.compiled.orderHash, 'order hash'),
    graphHash: bytes32(input.compiled.graphHash, 'graph hash'),
    quoteHash: bytes32(input.compiled.quoteHash, 'quote hash'),
    routeHash: bytes32(input.compiled.routeHash, 'route hash'),
    template: Object.freeze({
      templateId: keccak256(stringToHex(input.templateId)),
      templateVersion: input.templateVersion,
      templateManifestHash: hash32(input.templateManifestHash, 'template manifest hash'),
    }),
    settlementClass: Object.freeze({ classId: keccak256(stringToHex('ATOMIC_POSTCONDITION')), classVersion: 1 }),
    operation: OPERATION[input.operation],
    previousStateHash,
    nextStateHash,
    totalGrossNotionalAtoms: input.totalGrossNotionalAtoms,
    solver: getAddress(input.solver),
    nonce: input.nonce,
    deadline: input.deadline,
  });
  const executionHash = keccak256(encodeAbiParameters(EXECUTION_PARAMETERS, [execution]));
  const callsHash = keccak256(encodeAbiParameters(CALL_PARAMETERS, [calls]));
  const domain = Object.freeze({ name: 'Naryx Multi Strategy Account', version: '1', chainId: input.chainId, verifyingContract: account });
  const ownerDigest = hashTypedData({
    domain,
    primaryType: 'OwnerExecution',
    types: { OwnerExecution: [{ name: 'executionHash', type: 'bytes32' }, { name: 'callsHash', type: 'bytes32' }] },
    message: { executionHash, callsHash },
  });
  const solverDigest = hashTypedData({
    domain,
    primaryType: 'SolverExecution',
    types: { SolverExecution: [{ name: 'executionHash', type: 'bytes32' }, { name: 'callsHash', type: 'bytes32' }] },
    message: { executionHash, callsHash },
  });
  return Object.freeze({ account, execution, calls: Object.freeze(calls), executionHash, callsHash, ownerDigest, solverDigest });
}

export function encodeEvmMultiStrategyAccountExecution(input: Readonly<{
  envelope: EvmMultiStrategyAccountEnvelope;
  ownerSignature: Hex;
  solverSignature: Hex;
}>): Hex {
  requireCondition(/^0x[0-9a-fA-F]+$/.test(input.ownerSignature) && /^0x[0-9a-fA-F]+$/.test(input.solverSignature), 'execution signatures must be hex bytes');
  return encodeFunctionData({
    abi: ACCOUNT_ABI,
    functionName: 'execute',
    args: [input.envelope.execution, [...input.envelope.calls], input.ownerSignature, input.solverSignature],
  });
}

export function encodeEvmMultiStrategyAccountRecovery(input: Readonly<{
  envelope: EvmMultiStrategyAccountEnvelope;
  ownerSignature: Hex;
}>): Hex {
  requireCondition(/^0x[0-9a-fA-F]+$/.test(input.ownerSignature), 'owner signature must be hex bytes');
  requireCondition(input.envelope.execution.solver === ZERO_ADDRESS, 'recovery execution must not name a solver');
  requireCondition(
    input.envelope.execution.operation === OPERATION.DECREASE
      || input.envelope.execution.operation === OPERATION.EXIT
      || input.envelope.execution.operation === OPERATION.EMERGENCY_UNWIND,
    'recovery execution must reduce or close risk',
  );
  requireCondition(input.envelope.calls.every((call) => !call.riskIncreasing), 'recovery calls must not increase risk');
  return encodeFunctionData({
    abi: ACCOUNT_ABI,
    functionName: 'executeRecovery',
    args: [input.envelope.execution, [...input.envelope.calls], input.ownerSignature],
  });
}
