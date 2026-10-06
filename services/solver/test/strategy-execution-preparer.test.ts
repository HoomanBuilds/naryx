import assert from 'node:assert/strict';
import test from 'node:test';
import {
  domainRef,
  hash32,
  protocolId,
  type DomainRef,
  type Hash32,
} from '@naryx/protocol-types';
import { hexToBytes, keccak256, type Address, type Hex } from 'viem';
import {
  prepareCompiledStrategyExecution,
  type CompiledStrategyRouteExecution,
} from '../src/index.js';

const ACCOUNT = '0x1111111111111111111111111111111111111111' as Address;
const SOLVER = '0x2222222222222222222222222222222222222222' as Address;
const ADAPTER = '0x3333333333333333333333333333333333333333' as Address;
const TOKEN = '0x4444444444444444444444444444444444444444' as Address;
const HASH_A = `0x${'11'.repeat(32)}` as Hex;
const HASH_B = `0x${'22'.repeat(32)}` as Hex;
const HASH_C = `0x${'33'.repeat(32)}` as Hex;
const HASH_D = `0x${'44'.repeat(32)}` as Hex;
const HASH_E = `0x${'55'.repeat(32)}` as Hex;
const HASH_F = `0x${'66'.repeat(32)}` as Hex;

function bytes(value: Hex): Hash32 {
  return hash32(hexToBytes(value));
}

function evmDomain(): DomainRef {
  return domainRef('eip155:84532', 3, HASH_A);
}

function evmCompiled(): CompiledStrategyRouteExecution {
  const domain = evmDomain();
  return Object.freeze({
    version: 1,
    settlementClass: 'ATOMIC_POSTCONDITION',
    orderHash: bytes(HASH_B),
    graphHash: bytes(HASH_C),
    quoteHash: bytes(HASH_D),
    routeHash: bytes(HASH_E),
    coordination: 'SINGLE_DOMAIN_ATOMIC',
    domains: Object.freeze([Object.freeze({
      domainPlan: Object.freeze({
        domain,
        executionPlanKind: 'EVM_ATOMIC_BATCH',
        legIds: Object.freeze([protocolId('spot-leg')]),
        stageCount: 1,
      }),
      execution: Object.freeze({
        domains: Object.freeze([domain]),
        orderHash: bytes(HASH_B),
        graphHash: bytes(HASH_C),
        quoteHash: bytes(HASH_D),
        routeHash: bytes(HASH_E),
        payload: Object.freeze({
          version: 1,
          planKind: 'EVM_ATOMIC_BATCH',
          guarantee: 'ATOMIC_POSTCONDITION',
          domain,
          strategyAccount: ACCOUNT,
          packageId: HASH_F,
          stages: Object.freeze([Object.freeze({
            stage: 0,
            calls: Object.freeze([Object.freeze({
              legId: 'spot-leg',
              stage: 0,
              materializationClassId: 'naryx.evm.spot-exact',
              adapter: ADAPTER,
              adapterCodeHash: HASH_F,
              gasLimit: 300_000n,
              value: 0n,
              data: '0x12345678abcdef' as Hex,
              dataHash: keccak256('0x12345678abcdef'),
            })]),
          })]),
          totalGasLimit: 300_000n,
        }),
      }),
    })]),
  });
}

test('prepares an exact EVM account signature envelope from a compiled package route', () => {
  const compiled = evmCompiled();
  const prepared = prepareCompiledStrategyExecution({
    compiled,
    identity: {
      packageId: bytes(HASH_F),
      templateId: 'cash-and-carry-v1',
      templateVersion: 1,
      templateManifestHash: bytes(HASH_A),
      operation: 'ENTRY',
      nextStateHash: bytes(HASH_B),
    },
    bindings: [{
      kind: 'EVM_MULTI_STRATEGY_ACCOUNT',
      domain: evmDomain(),
      account: ACCOUNT,
      chainId: 84_532,
      solver: SOLVER,
      totalGrossNotionalAtoms: 100_000_000n,
      nonce: 0n,
      deadline: 2_000_000_000n,
      callPolicies: [{
        legId: 'spot-leg',
        adapter: { subjectId: HASH_C, manifestVersion: 1, manifestHash: HASH_D },
        expectedAdapterAddress: ADAPTER,
        expectedAdapterCodeHash: HASH_F,
        riskIncreasing: true,
        approvalToken: TOKEN,
        approvalAtoms: 50_000_000n,
        grossNotionalAtoms: 100_000_000n,
      }],
    }],
  });

  assert.equal(prepared.domains.length, 1);
  const execution = prepared.domains[0]!;
  assert.equal(execution.kind, 'EVM_MULTI_STRATEGY_ACCOUNT');
  if (execution.kind !== 'EVM_MULTI_STRATEGY_ACCOUNT') throw new Error('unexpected prepared execution kind');
  assert.equal(execution.localGuarantee, 'ATOMIC_POSTCONDITION');
  assert.equal(execution.envelope.execution.packageId, HASH_F);
  assert.equal(execution.envelope.calls[0]?.payload, '0x12345678abcdef');
  assert.notEqual(execution.envelope.ownerDigest, execution.envelope.solverDigest);
});

test('passes a bounded HyperCore plan only through an explicit matching executor binding', () => {
  const domain = domainRef('hypercore:testnet', 1, HASH_A);
  const compiled = Object.freeze({
    version: 1 as const,
    settlementClass: 'BATCHED_IOC_WITH_RECOVERY' as const,
    orderHash: bytes(HASH_B),
    graphHash: bytes(HASH_C),
    quoteHash: bytes(HASH_D),
    routeHash: bytes(HASH_E),
    coordination: 'SINGLE_DOMAIN_BOUNDED_RECOVERY' as const,
    domains: Object.freeze([Object.freeze({
      domainPlan: Object.freeze({
        domain,
        executionPlanKind: 'HYPERCORE_BATCHED_IOC' as const,
        legIds: Object.freeze([protocolId('perp-leg')]),
        stageCount: 1,
      }),
      execution: Object.freeze({
        domains: Object.freeze([domain]),
        orderHash: bytes(HASH_B),
        graphHash: bytes(HASH_C),
        quoteHash: bytes(HASH_D),
        routeHash: bytes(HASH_E),
        payload: Object.freeze({
          version: 1 as const,
          guarantee: 'BATCHED_IOC_WITH_BOUNDED_RECOVERY' as const,
          domain,
          orderHash: bytes(HASH_B),
          graphHash: bytes(HASH_C),
          quoteHash: bytes(HASH_D),
          routeHash: bytes(HASH_E),
          requestExpiryMs: 2_000_000_000_000n,
          orders: Object.freeze([]),
          batches: Object.freeze([]),
          recoveryAuthorizations: Object.freeze([]),
          maximumRecoveryCostQuoteAtoms: 0n,
        }),
      }),
    })]),
  });
  const identity = {
    packageId: bytes(HASH_F),
    templateId: 'perpetual-funding-spread-v1',
    templateVersion: 1,
    templateManifestHash: bytes(HASH_A),
    operation: 'ENTRY' as const,
    nextStateHash: bytes(HASH_B),
  };

  const prepared = prepareCompiledStrategyExecution({
    compiled,
    identity,
    bindings: [{ kind: 'HYPERCORE_EXECUTOR', domain }],
  });
  assert.equal(prepared.domains[0]?.kind, 'HYPERCORE_EXECUTOR');
  assert.equal(prepared.domains[0]?.localGuarantee, 'BATCHED_IOC_WITH_BOUNDED_RECOVERY');

  assert.throws(
    () => prepareCompiledStrategyExecution({
      compiled,
      identity,
      bindings: [{ kind: 'HYPERCORE_EXECUTOR', domain: evmDomain() }],
    }),
    /must resolve to exactly one execution binding/,
  );
});
