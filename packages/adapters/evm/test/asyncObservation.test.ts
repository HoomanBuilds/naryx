import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { encodeAbiParameters, getFunctionSelector, keccak256, stringToHex, zeroHash, type Abi, type AbiFunction, type AbiParameter, type Address, type Hex } from 'viem';
import {
  ASYNC_COORDINATOR_OBSERVATION_ABI,
  GMX_ENTRY_ADAPTER_OBSERVATION_ABI,
  GMX_EXIT_CONTROLLER_OBSERVATION_ABI,
  observeAsyncBondedPackage,
  type EvmAsyncObservationBinding,
  type EvmAsyncObservationKeys,
  type EvmReadPort,
} from '../src/index.js';

const address = (byte: number): Address => `0x${byte.toString(16).padStart(2, '0').repeat(20)}`;
const hash = (byte: number): Hex => `0x${byte.toString(16).padStart(2, '0').repeat(32)}`;

const coordinator = address(30);
const entryAdapter = address(31);
const exitController = address(32);
const owner = address(33);
const packageId = hash(80);
const entryRequestKey = hash(81);
const exitRequestKey = hash(82);
const executionClassId = keccak256(stringToHex('ASYNC_BONDED_SOLVER'));

const binding: EvmAsyncObservationBinding = {
  chainReference: 421_614n,
  coordinator,
  entryAdapter,
  handler: entryAdapter,
  exitController,
  owner,
  orderHash: hash(51),
  quoteHash: hash(53),
  routeHash: hash(52),
  domainIdHash: hash(70),
  domainManifestVersion: 1,
  domainManifestHash: hash(71),
  executionClassManifestHash: hash(74),
};

const keys: EvmAsyncObservationKeys = { packageId, entryRequestKey };

function terms(overrides: Record<string, unknown> = {}) {
  return {
    domain: { domainIdHash: hash(70), manifestVersion: 1, manifestHash: hash(71) },
    owner,
    solver: address(34),
    adapter: entryAdapter,
    handler: entryAdapter,
    adapterCodeHash: hash(75),
    handlerCodeHash: hash(75),
    orderHash: hash(51),
    quoteHash: hash(53),
    routeHash: hash(52),
    seriesIdentityKey: hash(72),
    seriesBindingVersion: 1,
    seriesBindingHash: hash(73),
    executionClassIdentityHash: executionClassId,
    executionClassManifestHash: hash(74),
    requestPayloadHash: hash(76),
    reservationHash: hash(77),
    bondHash: hash(78),
    recoveryPolicyHash: hash(79),
    evidenceSchemaHash: hash(83),
    ...overrides,
  };
}

function packageRecord(state: number, overrides: Record<string, unknown> = {}) {
  return {
    terms: terms(),
    requestKey: entryRequestKey,
    outcomeEvidenceHash: zeroHash,
    recoveryEvidenceHash: zeroHash,
    venueEvidenceCommitment: zeroHash,
    recoveryEvidenceCommitment: zeroHash,
    state,
    stateVersion: 2,
    admissionGeneration: 1,
    recoveryDutyStartedAt: 0,
    lastVenueOutcome: 0,
    hasVenueOutcome: false,
    recoveryDutyActive: false,
    recoveryActionSubmitted: false,
    recoveryProven: false,
    bondSlashed: false,
    evidenceConflict: false,
    settledLossAtoms: 0n,
    ...overrides,
  };
}

function entryRecord(status: number, overrides: Record<string, unknown> = {}) {
  return {
    status,
    evidenceHash: status === 1 ? zeroHash : hash(90),
    positionSizeBefore: 0n,
    positionSizeAfter: status === 2 ? 1_000n : 0n,
    revision: status === 0 ? 0 : 2,
    ...overrides,
  };
}

function exitRecord(status: number, overrides: Record<string, unknown> = {}) {
  return {
    status,
    evidenceHash: status === 1 ? zeroHash : hash(91),
    revision: status === 0 ? 0 : 2,
    reconciling: false,
    released: false,
    ...overrides,
  };
}

function finalReceipt(overrides: Record<string, unknown> = {}) {
  return {
    commitment: hash(92),
    packageId,
    entryRequestKey,
    exitRequestKey,
    entryRequestPayloadHash: hash(76),
    spotRegistrationHash: hash(93),
    exitAuthorizationHash: hash(94),
    perpEvidenceHash: hash(91),
    spotEvidenceHash: hash(95),
    entryCommitmentsHash: hash(96),
    exitCommitmentsHash: hash(97),
    recipient: owner,
    fullCloseSizeUsd: 1_000n,
    spotBaseAtoms: 500n,
    spotQuoteAtoms: 600n,
    perpStatus: 2,
    terminalState: 1,
    ...overrides,
  };
}

function fixturePort(options: {
  package?: Record<string, unknown> | null;
  entry?: Record<string, unknown> | null;
  exit?: Record<string, unknown> | null;
  receipt?: Record<string, unknown> | null;
  ownerOverride?: Hex;
  chainId?: bigint;
}): EvmReadPort {
  const expectedOwnerKey = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [entryAdapter, entryRequestKey]));
  return {
    chainId: async () => options.chainId ?? 421_614n,
    transactionReceipt: async () => null,
    readContract: async (read) => {
      if (read.functionName === 'packageState') return options.package ?? packageRecord(0, { requestKey: zeroHash });
      if (read.functionName === 'requestKeyOwner') {
        const key = read.args?.[0] as Hex;
        if (options.ownerOverride !== undefined) return options.ownerOverride;
        return key.toLowerCase() === expectedOwnerKey.toLowerCase() ? packageId : zeroHash;
      }
      if (read.functionName === 'requestEvidence') return options.entry ?? entryRecord(0);
      if (read.functionName === 'exitEvidence') return options.exit ?? exitRecord(0);
      if (read.functionName === 'finalPackageReceipt') {
        if (options.receipt === null) throw new Error('unreadable');
        return options.receipt ?? finalReceipt({ commitment: zeroHash });
      }
      throw new Error(`unexpected read ${read.functionName}`);
    },
    chainHead: async () => ({ latestBlock: 100n, finalizedBlock: 95n }),
  };
}

test('pending entry normalizes without claiming completion', async () => {
  const observed = await observeAsyncBondedPackage(
    fixturePort({ package: packageRecord(2), entry: entryRecord(1, { revision: 1 }) }),
    binding,
    keys,
  );
  assert.equal(observed.lifecycle, 'REQUEST_SUBMITTED');
  assert.equal(observed.evidenceGrade, 'contract-state');
  assert.equal(observed.exitCompleted, false);
  assert.equal(observed.entry?.status, 'PENDING');
  assert.ok(Object.isFrozen(observed));
});

test('executed entry normalizes with callback-grade evidence', async () => {
  const observed = await observeAsyncBondedPackage(
    fixturePort({ package: packageRecord(4, { outcomeEvidenceHash: hash(90), hasVenueOutcome: true }), entry: entryRecord(2) }),
    binding,
    keys,
  );
  assert.equal(observed.lifecycle, 'EXECUTED');
  assert.equal(observed.evidenceGrade, 'authenticated-callback-record');
  assert.equal(observed.exitCompleted, false);
});

test('recovery and frozen combinations preserve coordinator state', async () => {
  const recovery = await observeAsyncBondedPackage(
    fixturePort({ package: packageRecord(7, { recoveryDutyActive: true }), entry: entryRecord(4) }),
    binding,
    keys,
  );
  assert.equal(recovery.lifecycle, 'RECOVERY_PENDING');

  const frozen = await observeAsyncBondedPackage(
    fixturePort({ package: packageRecord(6, { outcomeEvidenceHash: hash(90), hasVenueOutcome: true }), entry: entryRecord(4) }),
    binding,
    keys,
  );
  assert.equal(frozen.lifecycle, 'FROZEN');

  const recovered = await observeAsyncBondedPackage(
    fixturePort({ package: packageRecord(8, { recoveryEvidenceHash: hash(90) }), entry: entryRecord(5) }),
    binding,
    keys,
  );
  assert.equal(recovered.lifecycle, 'RECOVERED');
  assert.equal(recovered.exitCompleted, false);
});

test('closed exit needs executed entry, executed exit, and a matching final receipt', async () => {
  const observed = await observeAsyncBondedPackage(
    fixturePort({
      package: packageRecord(10, { outcomeEvidenceHash: hash(90), hasVenueOutcome: true, stateVersion: 5 }),
      entry: entryRecord(2),
      exit: exitRecord(2, { released: true }),
      receipt: finalReceipt(),
    }),
    binding,
    { ...keys, exitRequestKey },
  );
  assert.equal(observed.lifecycle, 'CLOSED');
  assert.equal(observed.exitCompleted, true);
  assert.equal(observed.evidenceGrade, 'finalized-contract-receipt');
  assert.equal(observed.finalReceipt?.commitment, hash(92));
});

test('pending exit and recovered entry are not a completed exit', async () => {
  const pendingExit = await observeAsyncBondedPackage(
    fixturePort({
      package: packageRecord(4, { outcomeEvidenceHash: hash(90), hasVenueOutcome: true }),
      entry: entryRecord(2),
      exit: exitRecord(1, { revision: 1 }),
      receipt: finalReceipt({ commitment: zeroHash }),
    }),
    binding,
    { ...keys, exitRequestKey },
  );
  assert.equal(pendingExit.lifecycle, 'EXECUTED');
  assert.equal(pendingExit.exitCompleted, false);
  assert.notEqual(pendingExit.evidenceGrade, 'finalized-contract-receipt');
});

test('conflicts normalize to conflict instead of success', async () => {
  const adapterConflict = await observeAsyncBondedPackage(
    fixturePort({ package: packageRecord(3), entry: entryRecord(6) }),
    binding,
    keys,
  );
  assert.equal(adapterConflict.lifecycle, 'CONFLICT');

  const coordinatorConflict = await observeAsyncBondedPackage(
    fixturePort({ package: packageRecord(9, { evidenceConflict: true }), entry: entryRecord(2) }),
    binding,
    keys,
  );
  assert.equal(coordinatorConflict.lifecycle, 'CONFLICT');
});

test('mismatched ownership, terms, revisions, and receipts fail closed', async () => {
  const badOwner = await observeAsyncBondedPackage(
    fixturePort({ package: packageRecord(2), entry: entryRecord(1, { revision: 1 }), ownerOverride: hash(99) }),
    binding,
    keys,
  );
  assert.equal(badOwner.lifecycle, 'EVIDENCE_MISMATCH');

  const badTerms = await observeAsyncBondedPackage(
    fixturePort({
      package: { ...packageRecord(2), terms: terms({ orderHash: hash(99) }) },
      entry: entryRecord(1, { revision: 1 }),
    }),
    binding,
    keys,
  );
  assert.equal(badTerms.lifecycle, 'EVIDENCE_MISMATCH');

  const regressed = await observeAsyncBondedPackage(
    fixturePort({ package: packageRecord(4, { outcomeEvidenceHash: hash(90), hasVenueOutcome: true }), entry: entryRecord(2) }),
    binding,
    { ...keys, minimumStateVersion: 9 },
  );
  assert.equal(regressed.lifecycle, 'EVIDENCE_MISMATCH');

  const badReceipt = await observeAsyncBondedPackage(
    fixturePort({
      package: packageRecord(10, { outcomeEvidenceHash: hash(90), hasVenueOutcome: true, stateVersion: 5 }),
      entry: entryRecord(2),
      exit: exitRecord(2),
      receipt: finalReceipt({ packageId: hash(99) }),
    }),
    binding,
    { ...keys, exitRequestKey },
  );
  assert.equal(badReceipt.lifecycle, 'EVIDENCE_MISMATCH');

  const exitWithoutEntry = await observeAsyncBondedPackage(
    fixturePort({
      package: packageRecord(8, { recoveryEvidenceHash: hash(90) }),
      entry: entryRecord(5),
      exit: exitRecord(2),
      receipt: finalReceipt(),
    }),
    binding,
    { ...keys, exitRequestKey },
  );
  assert.equal(exitWithoutEntry.lifecycle, 'EVIDENCE_MISMATCH');
});

test('unknown packages and wrong chains never read as success', async () => {
  const missing = await observeAsyncBondedPackage(
    fixturePort({ package: packageRecord(0, { requestKey: zeroHash, stateVersion: 0 }) }),
    binding,
    { packageId, entryRequestKey: zeroHash },
  );
  assert.equal(missing.lifecycle, 'NOT_FOUND');

  const wrongChain = await observeAsyncBondedPackage(
    fixturePort({ package: packageRecord(2), entry: entryRecord(1, { revision: 1 }), chainId: 84_532n }),
    binding,
    keys,
  );
  assert.equal(wrongChain.lifecycle, 'EVIDENCE_MISMATCH');
});

test('observation ABIs match the published coordinator, adapter, and exit selectors and tuples', () => {
  const load = (file: string): Abi => JSON.parse(readFileSync(
    new URL(`../../../../../deployments/evm/conformance/abi/${file}`, import.meta.url),
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
  const canonicalParams = (params: readonly AbiParameter[] | undefined): unknown => (params ?? []).map((entry) => {
    const param = entry as { name?: unknown; type?: unknown; components?: unknown };
    const normalized: { name: string; type: string; components?: unknown } = {
      name: typeof param.name === 'string' ? param.name : '',
      type: typeof param.type === 'string' ? param.type : '',
    };
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
  const check = (minimalAbi: Abi, publishedFile: string, name: string): void => {
    const minimal = findFunction(minimalAbi, name);
    const expected = findFunction(load(publishedFile), name);
    assert.equal(getFunctionSelector(minimal), getFunctionSelector(expected));
    assert.deepEqual(canonicalParams(minimal.inputs), canonicalParams(expected.inputs));
    assert.deepEqual(canonicalParams(minimal.outputs), canonicalParams(expected.outputs));
    assert.equal(outputsSelector(minimal.outputs), outputsSelector(expected.outputs));
  };
  check(ASYNC_COORDINATOR_OBSERVATION_ABI, 'AsyncBondedPackageCoordinator.abi.json', 'packageState');
  check(ASYNC_COORDINATOR_OBSERVATION_ABI, 'AsyncBondedPackageCoordinator.abi.json', 'requestKeyOwner');
  check(GMX_ENTRY_ADAPTER_OBSERVATION_ABI, 'GmxV2ArbitrumAdapter.abi.json', 'requestEvidence');
  check(GMX_EXIT_CONTROLLER_OBSERVATION_ABI, 'GmxV2ExitController.abi.json', 'exitEvidence');
  check(GMX_EXIT_CONTROLLER_OBSERVATION_ABI, 'GmxV2ExitController.abi.json', 'finalPackageReceipt');
});

test('terminal exit without evidence fails closed', async () => {
  const cancelledWithoutEvidence = await observeAsyncBondedPackage(
    fixturePort({
      package: packageRecord(10, { outcomeEvidenceHash: hash(90), hasVenueOutcome: true, stateVersion: 5 }),
      entry: entryRecord(2),
      exit: exitRecord(3, { evidenceHash: zeroHash }),
      receipt: finalReceipt({ commitment: zeroHash }),
    }),
    binding,
    { ...keys, exitRequestKey },
  );
  assert.equal(cancelledWithoutEvidence.lifecycle, 'EVIDENCE_MISMATCH');
});

test('stored final receipt before release is not a completed exit', async () => {
  const observed = await observeAsyncBondedPackage(
    fixturePort({
      package: packageRecord(10, { outcomeEvidenceHash: hash(90), hasVenueOutcome: true, stateVersion: 5 }),
      entry: entryRecord(2),
      exit: exitRecord(2, { released: false }),
      receipt: finalReceipt(),
    }),
    binding,
    { ...keys, exitRequestKey },
  );
  assert.equal(observed.lifecycle, 'CLOSED');
  assert.equal(observed.exitCompleted, false);
  assert.equal(observed.finalReceipt?.commitment, hash(92));
  assert.notEqual(observed.evidenceGrade, 'finalized-contract-receipt');
});

test('released exit without a final receipt fails closed', async () => {
  const observed = await observeAsyncBondedPackage(
    fixturePort({
      package: packageRecord(10, { outcomeEvidenceHash: hash(90), hasVenueOutcome: true, stateVersion: 5 }),
      entry: entryRecord(2),
      exit: exitRecord(2, { released: true }),
      receipt: finalReceipt({ commitment: zeroHash }),
    }),
    binding,
    { ...keys, exitRequestKey },
  );
  assert.equal(observed.lifecycle, 'EVIDENCE_MISMATCH');
});

test('non-boolean coordinator and exit flags fail closed', async () => {
  const badCoordinator = await observeAsyncBondedPackage(
    fixturePort({ package: packageRecord(2, { hasVenueOutcome: 1 }), entry: entryRecord(1, { revision: 1 }) }),
    binding,
    keys,
  );
  assert.equal(badCoordinator.lifecycle, 'EVIDENCE_MISMATCH');

  const badExit = await observeAsyncBondedPackage(
    fixturePort({
      package: packageRecord(10, { outcomeEvidenceHash: hash(90), hasVenueOutcome: true, stateVersion: 5 }),
      entry: entryRecord(2),
      exit: exitRecord(2, { released: 1, evidenceHash: hash(91) } as unknown as Record<string, unknown>),
      receipt: finalReceipt(),
    }),
    binding,
    { ...keys, exitRequestKey },
  );
  assert.equal(badExit.lifecycle, 'EVIDENCE_MISMATCH');
});
