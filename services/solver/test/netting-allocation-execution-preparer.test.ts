import assert from 'node:assert/strict';
import test from 'node:test';
import type { CompiledStrategyExecution } from '@naryx/adapter-core';
import {
  compileEvmMultiStrategyAccountEnvelope,
  verifyEvmNettingAllocationObservationBinding,
  type EvmStrategyExecutionPlan,
} from '@naryx/adapter-evm';
import {
  compileSolanaMultiStrategyAccountEnvelope,
  deriveSolanaMultiStrategyAccount,
  verifySolanaNettingAllocationObservationBinding,
  type SolanaStrategyInstructionPlan,
} from '@naryx/adapter-solana';
import {
  assetRef,
  domainRef,
  hash32,
  netObligations,
  nettingFinalAllocationReceipt,
  packageSettlementCommitment,
  versionedManifestRef,
  type DomainRef,
  type NettingPolicyManifestInput,
} from '@naryx/protocol-types';
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import {
  hexToBytes,
  keccak256,
  type Address,
  type Hex,
} from 'viem';
import {
  prepareNettingAllocationExecution,
  type PreparedStrategyDomainExecution,
} from '../src/index.js';

const hex = (byte: number): Hex => `0x${byte.toString(16).padStart(2, '0').repeat(32)}`;
const bytes = (byte: number) => hash32(hexToBytes(hex(byte)));
const address = (byte: number): Address => `0x${byte.toString(16).padStart(2, '0').repeat(20)}`;
const publicKey = (byte: number): PublicKey => new PublicKey(bytes(byte));

function nettingInput(input: Readonly<{
  domain: DomainRef;
  owner: string;
  settlementAccount: string;
  strategyOrderHash: Uint8Array | string;
  graphHash: Uint8Array | string;
  validUntilUnit: 'EVM_UNIX_SECONDS' | 'SOLANA_SLOT';
  validUntilValue: bigint;
  domainExecution: PreparedStrategyDomainExecution;
}>) {
  const policy: NettingPolicyManifestInput = {
    schemaVersion: 1,
    manifestVersion: 1,
    nettingPolicyVersion: 2,
    environment: 'testnet',
    executionClassId: 'atomic-strategy-netting',
    executionClassVersion: 1,
    executionClassManifestHash: bytes(31),
    settlementClass: 'ATOMIC_POSTCONDITION',
    allocationRule: 'PRO_RATA_SEQUENCE',
    externalExecutionMode: 'EXACT_NET_ONLY',
    clearingRule: 'LIMIT_MIDPOINT_BUYER_FAVOR',
    maximumObligations: 4,
    maximumBatchWindowMilliseconds: 1_000n,
    instruments: [{
      instrumentId: 'sol-spot',
      domain: input.domain,
      adapter: { adapterId: 'spot-adapter', adapterManifestVersion: 1, adapterManifestHash: bytes(32) },
      venue: versionedManifestRef('spot-venue', 1, bytes(33)),
      market: versionedManifestRef('sol-usdc', 1, bytes(34)),
      quantityAsset: assetRef('sol', bytes(35), 9),
      quoteAsset: assetRef('usdc', bytes(36), 6),
      legFamily: 'SPOT_SWAP',
      quantityIncrementAtoms: 10n,
      priceTickQuoteAtoms: 1n,
    }],
  };
  const result = netObligations([{
    ownerId: input.owner,
    strategyOrderHash: input.strategyOrderHash,
    packageOrderId: bytes(37),
    settlementReadinessHash: bytes(38),
    legId: 'buy',
    instrumentId: 'sol-spot',
    signedQuantityAtoms: 10n,
    limitPriceTicks: 12n,
    sequence: 1n,
  }, {
    ownerId: 'counterparty',
    strategyOrderHash: bytes(39),
    packageOrderId: bytes(40),
    settlementReadinessHash: bytes(41),
    legId: 'sell',
    instrumentId: 'sol-spot',
    signedQuantityAtoms: -10n,
    limitPriceTicks: 8n,
    sequence: 2n,
  }], policy);
  const finalAllocationReceipt = nettingFinalAllocationReceipt(result, policy, [], []);
  const allocation = finalAllocationReceipt.allocations.find((candidate) => candidate.ownerId === input.owner)!;
  const settlement = packageSettlementCommitment({
    version: 1,
    environment: policy.environment,
    executionClassId: policy.executionClassId,
    packageOrderId: allocation.packageOrderId,
    strategyOrderHash: allocation.strategyOrderHash,
    graphHash: input.graphHash,
    participantId: allocation.ownerId,
    settlementAccount: input.settlementAccount,
    quantity: 10n,
    validUntilUnit: input.validUntilUnit,
    validUntilValue: input.validUntilValue,
  });
  return {
    finalAllocationReceipt,
    allocationReceiptHash: allocation.allocationReceiptHash,
    result,
    policy,
    intents: [],
    externalEvidence: [],
    settlement,
    domainExecution: input.domainExecution,
  } as const;
}

function evmDomainExecution(): PreparedStrategyDomainExecution {
  const domain = domainRef('eip155:84532', 1, bytes(1));
  const account = address(1);
  const solver = address(2);
  const adapter = address(3);
  const token = address(4);
  const packageId = hex(5);
  const compiled: CompiledStrategyExecution<EvmStrategyExecutionPlan> = {
    domains: [domain],
    orderHash: bytes(6),
    graphHash: bytes(7),
    quoteHash: bytes(8),
    routeHash: bytes(9),
    payload: {
      version: 1,
      planKind: 'EVM_ATOMIC_BATCH',
      guarantee: 'ATOMIC_POSTCONDITION',
      domain,
      strategyAccount: account,
      packageId,
      stages: [{
        stage: 0,
        calls: [{
          legId: 'spot-leg',
          stage: 0,
          materializationClassId: 'typed-spot-leg-v1',
          adapter,
          adapterCodeHash: hex(10),
          gasLimit: 300_000n,
          value: 0n,
          data: '0x12345678',
          dataHash: keccak256('0x12345678'),
        }],
      }],
      totalGasLimit: 300_000n,
    },
  };
  const envelope = compileEvmMultiStrategyAccountEnvelope({
    compiled,
    account,
    chainId: 84_532,
    operation: 'ENTRY',
    packageId,
    templateId: 'cash-and-carry-v1',
    templateVersion: 1,
    templateManifestHash: hex(11),
    nextStateHash: hex(12),
    totalGrossNotionalAtoms: 100n,
    fees: {
      policyVersion: 1,
      policyManifestHash: hex(13),
      token,
      protocolFeeAtoms: 1n,
      solverFeeAtoms: 2n,
    },
    solver,
    nonce: 3n,
    deadline: 2_000_000_000n,
    callPolicies: [{
      legId: 'spot-leg',
      adapter: { subjectId: hex(14), manifestVersion: 1, manifestHash: hex(15) },
      expectedAdapterAddress: adapter,
      expectedAdapterCodeHash: hex(10),
      riskIncreasing: true,
      approvalToken: token,
      approvalAtoms: 10n,
      grossNotionalAtoms: 100n,
    }],
  });
  return Object.freeze({
    kind: 'EVM_MULTI_STRATEGY_ACCOUNT',
    domain,
    routeSettlementClass: 'ATOMIC_POSTCONDITION',
    localGuarantee: 'ATOMIC_POSTCONDITION',
    legIds: Object.freeze(['spot-leg']),
    envelope,
  });
}

function solanaDomainExecution(): PreparedStrategyDomainExecution {
  const domain = domainRef('svm:devnet', 1, bytes(16));
  const coreProgram = publicKey(1);
  const multiStrategyProgram = publicKey(2);
  const owner = publicKey(3);
  const solver = publicKey(4);
  const adapter = publicKey(5);
  const strategyAccount = deriveSolanaMultiStrategyAccount({ programId: multiStrategyProgram, owner });
  const packageId = bytes(17);
  const instruction = new TransactionInstruction({
    programId: adapter,
    keys: [{ pubkey: strategyAccount, isSigner: true, isWritable: false }],
    data: Buffer.from([1, 2, 3]),
  });
  const compiled: CompiledStrategyExecution<SolanaStrategyInstructionPlan> = {
    domains: [domain],
    orderHash: bytes(18),
    graphHash: bytes(19),
    quoteHash: bytes(20),
    routeHash: bytes(21),
    payload: {
      version: 1,
      planKind: 'SVM_ATOMIC_CPI',
      guarantee: 'ATOMIC_POSTCONDITION',
      domain,
      packageId,
      feePayer: owner.toBase58(),
      requiredSignerPubkeys: [owner.toBase58(), strategyAccount.toBase58()],
      instructions: [{
        legId: 'spot-leg',
        stage: 0,
        materializationClassId: 'naryx.solana.spot-exact',
        programId: adapter.toBase58(),
        expectedProgramDataHash: bytes(22),
        computeUnitLimit: 200_000,
        instruction,
      }],
      totalComputeUnitLimit: 200_000,
    },
  };
  const envelope = compileSolanaMultiStrategyAccountEnvelope({
    compiled,
    coreProgramId: coreProgram,
    multiStrategyProgramId: multiStrategyProgram,
    owner,
    solver,
    operation: 'ENTRY',
    packageId,
    templateId: 'cash-and-carry-v1',
    templateVersion: 1,
    templateManifestHash: bytes(23),
    settlementManifestHash: bytes(24),
    nextStateHash: bytes(25),
    totalGrossNotionalAtoms: 100n,
    fees: {
      quoteAssetSubjectId: bytes(26),
      quoteAssetManifestVersion: 1,
      quoteAssetManifestHash: bytes(27),
      policyVersion: 1,
      policyManifestHash: bytes(28),
      mint: publicKey(6),
      protocolRecipient: publicKey(7),
      protocolFeeAtoms: 1n,
      solverFeeAtoms: 2n,
    },
    nonce: 3n,
    deadlineSlot: 500n,
    policies: [{
      legId: 'spot-leg',
      adapterSubjectId: bytes(29),
      adapterManifestVersion: 1,
      adapterManifestHash: bytes(30),
      adapterProgram: adapter,
      adapterProgramData: publicKey(8),
      riskIncreasing: true,
      grossNotionalAtoms: 100n,
    }],
  });
  return Object.freeze({
    kind: 'SOLANA_MULTI_STRATEGY_ACCOUNT',
    domain,
    routeSettlementClass: 'ATOMIC_POSTCONDITION',
    localGuarantee: 'ATOMIC_POSTCONDITION',
    legIds: Object.freeze(['spot-leg']),
    envelope,
  });
}

test('prepares exact EVM and Solana allocation authorizations and evidence bindings', () => {
  const evmExecution = evmDomainExecution();
  assert.equal(evmExecution.kind, 'EVM_MULTI_STRATEGY_ACCOUNT');
  if (evmExecution.kind !== 'EVM_MULTI_STRATEGY_ACCOUNT') return;
  const evm = prepareNettingAllocationExecution(nettingInput({
    domain: evmExecution.domain,
    owner: address(5),
    settlementAccount: evmExecution.envelope.account,
    strategyOrderHash: evmExecution.envelope.execution.orderHash,
    graphHash: evmExecution.envelope.execution.graphHash,
    validUntilUnit: 'EVM_UNIX_SECONDS',
    validUntilValue: evmExecution.envelope.execution.deadline,
    domainExecution: evmExecution,
  }));
  assert.equal(evm.kind, 'EVM_MULTI_STRATEGY_ACCOUNT');
  if (evm.kind !== 'EVM_MULTI_STRATEGY_ACCOUNT') return;
  verifyEvmNettingAllocationObservationBinding(evm.observation.binding, evm.authorization);

  const solanaExecution = solanaDomainExecution();
  assert.equal(solanaExecution.kind, 'SOLANA_MULTI_STRATEGY_ACCOUNT');
  if (solanaExecution.kind !== 'SOLANA_MULTI_STRATEGY_ACCOUNT') return;
  const solana = prepareNettingAllocationExecution(nettingInput({
    domain: solanaExecution.domain,
    owner: solanaExecution.envelope.owner.toBase58(),
    settlementAccount: solanaExecution.envelope.strategyAccount.toBase58(),
    strategyOrderHash: solanaExecution.envelope.orderHash,
    graphHash: solanaExecution.envelope.graphHash,
    validUntilUnit: 'SOLANA_SLOT',
    validUntilValue: solanaExecution.envelope.deadlineSlot,
    domainExecution: solanaExecution,
  }));
  assert.equal(solana.kind, 'SOLANA_MULTI_STRATEGY_ACCOUNT');
  if (solana.kind !== 'SOLANA_MULTI_STRATEGY_ACCOUNT') return;
  verifySolanaNettingAllocationObservationBinding(solana.observation.binding, solana.authorization);
});

test('refuses a runtime without exact allocation settlement evidence semantics', () => {
  const evmExecution = evmDomainExecution();
  assert.equal(evmExecution.kind, 'EVM_MULTI_STRATEGY_ACCOUNT');
  if (evmExecution.kind !== 'EVM_MULTI_STRATEGY_ACCOUNT') return;
  const input = nettingInput({
    domain: evmExecution.domain,
    owner: address(5),
    settlementAccount: evmExecution.envelope.account,
    strategyOrderHash: evmExecution.envelope.execution.orderHash,
    graphHash: evmExecution.envelope.execution.graphHash,
    validUntilUnit: 'EVM_UNIX_SECONDS',
    validUntilValue: evmExecution.envelope.execution.deadline,
    domainExecution: { kind: 'EVM_ASYNC_EXECUTOR' } as PreparedStrategyDomainExecution,
  });
  assert.throws(() => prepareNettingAllocationExecution(input), /does not support EVM_ASYNC_EXECUTOR/);
});
