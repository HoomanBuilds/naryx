import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  encodeAbiParameters,
  getEventSelector,
  getFunctionSelector,
  keccak256,
  stringToHex,
  zeroHash,
  type Abi,
  type AbiEvent,
  type AbiFunction,
  type AbiParameter,
  type Address,
  type Hex,
} from 'viem';
import {
  observeEvmAtomicPackage,
  PACKAGE_VERIFIER_OBSERVATION_ABI,
  type EvmAtomicObservationBinding,
  type EvmFinalityPolicy,
  type EvmObservedLog,
  type EvmObservedReceipt,
  type EvmReadPort,
} from '../src/index.js';

const address = (byte: number): Address => `0x${byte.toString(16).padStart(2, '0').repeat(20)}`;
const hash = (byte: number): Hex => `0x${byte.toString(16).padStart(2, '0').repeat(32)}`;

const verifier = address(7);
const strategyAccount = address(1);
const solver = address(8);
const orderHash = hash(51);
const quoteHash = hash(53);
const routeHash = hash(52);
const receiptHash = hash(60);
const transactionHash = hash(61);

const binding: EvmAtomicObservationBinding = {
  chainReference: 84_532n,
  packageVerifier: verifier,
  strategyAccount,
  orderHash,
  quoteHash,
  routeHash,
  executionPlanKind: 'EVM_ATOMIC_BATCH',
};

const finalizedPolicy: EvmFinalityPolicy = { requiredConfirmations: 5, requireFinalized: true };
const confirmationsPolicy: EvmFinalityPolicy = { requiredConfirmations: 5, requireFinalized: false };

const eventSignature = keccak256(stringToHex('PackageVerified(bytes32,address,uint8,address,bool,uint256,uint256,bytes32,bytes32)'));

function packageVerifiedLog(overrides: { receipt?: Hex; account?: Address } = {}): EvmObservedLog {
  const account = (overrides.account ?? strategyAccount).slice(2).toLowerCase();
  return {
    address: verifier,
    topics: [eventSignature, overrides.receipt ?? receiptHash, `0x${'0'.repeat(24)}${account}` as Hex, `0x${'0'.repeat(62)}01` as Hex],
    data: encodeAbiParameters(
      [{ type: 'address' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'bytes32' }],
      [solver, false, 1_000n, 900n, hash(62), hash(63)],
    ),
  };
}

function receiptRecord(overrides: Record<string, unknown> = {}) {
  return {
    domainIdHash: hash(70),
    domainManifestVersion: 1,
    domainManifestHash: hash(71),
    orderHash,
    quoteHash,
    routeHash,
    spotFillCommitment: hash(55),
    packageQuoteIntentHash: hash(62),
    packageQuoteFillCommitment: hash(63),
    seriesIdentityKey: hash(72),
    seriesBindingVersion: 1,
    seriesBindingHash: hash(73),
    action: 1,
    strategyAccount,
    solver,
    recovery: false,
    baseQuantityAtoms: 1_000n,
    spotQuoteAtoms: 900n,
    packageSizeUnits: 2n,
    prePerpBalanceWad: 0n,
    prePerpSizeWad: 0n,
    prePerpEntryNotionalWad: 0n,
    postPerpBalanceWad: 10n,
    postPerpSizeWad: -2n,
    postPerpEntryNotionalWad: 5n,
    entryReceiptHash: zeroHash,
    nonce: 9n,
    ...overrides,
  };
}

function fixturePort(options: {
  receipt?: EvmObservedReceipt | null;
  contractReceipt?: Record<string, unknown> | null;
  chainId?: bigint;
  head?: { latestBlock: bigint; finalizedBlock: bigint | null };
}): EvmReadPort {
  return {
    chainId: async () => options.chainId ?? 84_532n,
    transactionReceipt: async () => options.receipt ?? null,
    readContract: async () => {
      if (options.contractReceipt === null) throw new Error('unreadable');
      return options.contractReceipt ?? receiptRecord();
    },
    chainHead: async () => options.head ?? { latestBlock: 110n, finalizedBlock: 105n },
  };
}

test('confirmed package needs transaction success plus matching log and contract receipt', async () => {
  const port = fixturePort({
    receipt: { status: 'success', blockNumber: 100n, logs: [packageVerifiedLog()] },
  });
  const observed = await observeEvmAtomicPackage(port, binding, transactionHash, finalizedPolicy);
  assert.equal(observed.lifecycle, 'FINALIZED');
  assert.equal(observed.evidenceGrade, 'finalized-contract-receipt');
  assert.equal(observed.receiptHash, receiptHash);
  assert.equal(observed.packageReceipt?.orderHash, orderHash);
  assert.equal(observed.packageReceipt?.quoteHash, quoteHash);
  assert.equal(observed.packageReceipt?.routeHash, routeHash);
  assert.equal(observed.packageReceipt?.baseQuantityAtoms, 1_000n);
  assert.equal(observed.confirmations, 11);
  assert.ok(Object.isFrozen(observed));
});

test('unconfirmed package evidence stays submitted', async () => {
  const port = fixturePort({
    receipt: { status: 'success', blockNumber: 108n, logs: [packageVerifiedLog()] },
    head: { latestBlock: 110n, finalizedBlock: null },
  });
  const observed = await observeEvmAtomicPackage(port, binding, transactionHash, finalizedPolicy);
  assert.equal(observed.lifecycle, 'SUBMITTED');
  assert.equal(observed.packageReceipt?.receiptHash, receiptHash);
});

test('confirmed but unfinalized package stays confirmed when finality is required', async () => {
  const port = fixturePort({
    receipt: { status: 'success', blockNumber: 100n, logs: [packageVerifiedLog()] },
    head: { latestBlock: 110n, finalizedBlock: 90n },
  });
  const observed = await observeEvmAtomicPackage(port, binding, transactionHash, finalizedPolicy);
  assert.equal(observed.lifecycle, 'CONFIRMED');
  assert.equal(observed.evidenceGrade, 'contract-state');
});

test('missing, reverted, and log-free transactions never read as package completion', async () => {
  const missing = await observeEvmAtomicPackage(fixturePort({ receipt: null }), binding, transactionHash, confirmationsPolicy);
  assert.equal(missing.lifecycle, 'NOT_FOUND');

  const reverted = await observeEvmAtomicPackage(
    fixturePort({ receipt: { status: 'reverted', blockNumber: 100n, logs: [] } }),
    binding,
    transactionHash,
    confirmationsPolicy,
  );
  assert.equal(reverted.lifecycle, 'REVERTED');

  const noLog = await observeEvmAtomicPackage(
    fixturePort({ receipt: { status: 'success', blockNumber: 100n, logs: [] } }),
    binding,
    transactionHash,
    confirmationsPolicy,
  );
  assert.equal(noLog.lifecycle, 'EVIDENCE_MISMATCH');
  assert.equal(noLog.packageReceipt, null);
});

test('mismatched commitments and wrong chain fail closed', async () => {
  const mismatched = await observeEvmAtomicPackage(
    fixturePort({
      receipt: { status: 'success', blockNumber: 100n, logs: [packageVerifiedLog()] },
      contractReceipt: receiptRecord({ orderHash: hash(99) }),
    }),
    binding,
    transactionHash,
    confirmationsPolicy,
  );
  assert.equal(mismatched.lifecycle, 'EVIDENCE_MISMATCH');

  const wrongChain = await observeEvmAtomicPackage(
    fixturePort({
      receipt: { status: 'success', blockNumber: 100n, logs: [packageVerifiedLog()] },
      chainId: 421_614n,
    }),
    binding,
    transactionHash,
    confirmationsPolicy,
  );
  assert.equal(wrongChain.lifecycle, 'EVIDENCE_MISMATCH');

  const foreignLog = await observeEvmAtomicPackage(
    fixturePort({ receipt: { status: 'success', blockNumber: 100n, logs: [packageVerifiedLog({ account: address(9) })] } }),
    binding,
    transactionHash,
    confirmationsPolicy,
  );
  assert.equal(foreignLog.lifecycle, 'EVIDENCE_MISMATCH');
});

test('asynchronous routes never go through the atomic observer', async () => {
  const port = fixturePort({ receipt: null });
  await assert.rejects(
    observeEvmAtomicPackage(port, { ...binding, executionPlanKind: 'HYPERCORE_BATCHED_IOC' } as unknown as EvmAtomicObservationBinding, transactionHash, confirmationsPolicy),
    /async bonded observer/,
  );
});

test('observation ABI matches the published verifier selectors and tuples', () => {
  const published = JSON.parse(readFileSync(
    new URL('../../../../../deployments/evm/conformance/abi/PackageVerifier.abi.json', import.meta.url),
    'utf8',
  )) as Abi;
  const findFunction = (abi: Abi, name: string): AbiFunction => {
    for (const item of abi) {
      if (typeof item === 'object' && item !== null && 'type' in item && 'name' in item) {
        const candidate = item as { type?: unknown; name?: unknown };
        if (candidate.type === 'function' && candidate.name === name) return item as AbiFunction;
      }
    }
    throw new Error(`missing function ${name}`);
  };
  const findEvent = (abi: Abi, name: string): AbiEvent => {
    for (const item of abi) {
      if (typeof item === 'object' && item !== null && 'type' in item && 'name' in item) {
        const candidate = item as { type?: unknown; name?: unknown };
        if (candidate.type === 'event' && candidate.name === name) return item as AbiEvent;
      }
    }
    throw new Error(`missing event ${name}`);
  };
  const canonicalParams = (params: readonly AbiParameter[] | undefined): unknown => (params ?? []).map((entry) => {
    const param = entry as { name?: unknown; type?: unknown; indexed?: unknown; components?: unknown };
    const normalized: { name: string; type: string; indexed?: boolean; components?: unknown } = {
      name: typeof param.name === 'string' ? param.name : '',
      type: typeof param.type === 'string' ? param.type : '',
    };
    if (typeof param.indexed === 'boolean') normalized.indexed = param.indexed;
    if (Array.isArray(param.components)) normalized.components = canonicalParams(param.components as AbiParameter[]);
    return normalized;
  });
  const outputsSelector = (outputs: readonly AbiParameter[] | undefined): Hex => {
    const inputs = (outputs ?? []).map((output, index) => ({ ...(output as unknown as Record<string, unknown>), name: `parity${index}` }));
    return getFunctionSelector({
      type: 'function',
      name: '__parity__',
      inputs: inputs as unknown as AbiFunction['inputs'],
      outputs: [],
      stateMutability: 'view',
    });
  };
  for (const name of ['receipt', 'openPackage'] as const) {
    const minimal = findFunction(PACKAGE_VERIFIER_OBSERVATION_ABI, name);
    const expected = findFunction(published, name);
    assert.equal(getFunctionSelector(minimal), getFunctionSelector(expected));
    assert.deepEqual(canonicalParams(minimal.inputs), canonicalParams(expected.inputs));
    assert.deepEqual(canonicalParams(minimal.outputs), canonicalParams(expected.outputs));
    assert.equal(outputsSelector(minimal.outputs), outputsSelector(expected.outputs));
  }
  const minimalEvent = findEvent(PACKAGE_VERIFIER_OBSERVATION_ABI, 'PackageVerified');
  const expectedEvent = findEvent(published, 'PackageVerified');
  assert.equal(getEventSelector(minimalEvent), getEventSelector(expectedEvent));
  assert.deepEqual(canonicalParams(minimalEvent.inputs), canonicalParams(expectedEvent.inputs));
});

test('unknown receipt status fails closed', async () => {
  const observed = await observeEvmAtomicPackage(
    fixturePort({ receipt: { status: 'pending', blockNumber: 100n, logs: [] } as unknown as EvmObservedReceipt }),
    binding,
    transactionHash,
    confirmationsPolicy,
  );
  assert.equal(observed.lifecycle, 'EVIDENCE_MISMATCH');
});

test('invalid chain head values fail closed', async () => {
  const finalizedBeyondLatest = await observeEvmAtomicPackage(
    fixturePort({
      receipt: { status: 'success', blockNumber: 100n, logs: [packageVerifiedLog()] },
      head: { latestBlock: 110n, finalizedBlock: 111n },
    }),
    binding,
    transactionHash,
    confirmationsPolicy,
  );
  assert.equal(finalizedBeyondLatest.lifecycle, 'EVIDENCE_MISMATCH');

  const negativeLatest = await observeEvmAtomicPackage(
    fixturePort({
      receipt: { status: 'success', blockNumber: 100n, logs: [packageVerifiedLog()] },
      head: { latestBlock: -1n, finalizedBlock: null } as unknown as { latestBlock: bigint; finalizedBlock: bigint | null },
    }),
    binding,
    transactionHash,
    confirmationsPolicy,
  );
  assert.equal(negativeLatest.lifecycle, 'EVIDENCE_MISMATCH');
});

test('non-boolean receipt flag fails closed', async () => {
  const observed = await observeEvmAtomicPackage(
    fixturePort({
      receipt: { status: 'success', blockNumber: 100n, logs: [packageVerifiedLog()] },
      contractReceipt: receiptRecord({ recovery: 1 }),
    }),
    binding,
    transactionHash,
    confirmationsPolicy,
  );
  assert.equal(observed.lifecycle, 'EVIDENCE_MISMATCH');
});
