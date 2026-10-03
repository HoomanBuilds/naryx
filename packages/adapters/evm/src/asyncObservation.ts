import { encodeAbiParameters, getAddress, keccak256, stringToHex, zeroHash, type Address, type Hex } from 'viem';
import {
  ASYNC_COORDINATOR_OBSERVATION_ABI,
  GMX_ENTRY_ADAPTER_OBSERVATION_ABI,
  GMX_EXIT_CONTROLLER_OBSERVATION_ABI,
} from './abi.js';
import {
  chainReference,
  equalAddress,
  equalHash,
  hash32,
  requiredEvmAddress,
  safeCount,
  structField,
  type EvmEvidenceGrade,
  type EvmReadPort,
} from './readPort.js';

export const COORDINATOR_STATE_LABELS = [
  'NONE',
  'RESERVED',
  'REQUEST_SUBMITTED',
  'VENUE_PENDING',
  'EXECUTED',
  'CANCELLED',
  'FROZEN',
  'RECOVERY_PENDING',
  'RECOVERED',
  'MANUAL_INTERVENTION',
  'CLOSED',
] as const;

export const VENUE_STATUS_LABELS = [
  'NONE',
  'PENDING',
  'EXECUTED',
  'CANCELLED',
  'FROZEN',
  'RECOVERED',
  'CONFLICT',
] as const;

const TERMINAL_COMPLETE = 1;
/** After the exit's `cancelAfter` the owner took the spot base token in kind; the receipt carries no quote proceeds. */
const TERMINAL_SPOT_IN_KIND = 2;
const ASYNC_BONDED_EXECUTION_CLASS_ID = keccak256(stringToHex('ASYNC_BONDED_SOLVER'));

export type EvmAsyncLifecycle =
  | 'NOT_FOUND'
  | 'RESERVED'
  | 'REQUEST_SUBMITTED'
  | 'VENUE_PENDING'
  | 'EXECUTED'
  | 'CANCELLED'
  | 'FROZEN'
  | 'RECOVERY_PENDING'
  | 'RECOVERED'
  | 'MANUAL_INTERVENTION'
  | 'CLOSED'
  | 'CONFLICT'
  | 'EVIDENCE_MISMATCH';

export interface EvmAsyncObservationBinding {
  readonly chainReference: bigint;
  readonly coordinator: Address;
  readonly entryAdapter: Address;
  readonly handler: Address;
  readonly exitController?: Address | undefined;
  readonly owner: Address;
  readonly orderHash: Hex;
  readonly quoteHash: Hex;
  readonly routeHash: Hex;
  readonly domainIdHash: Hex;
  readonly domainManifestVersion: number;
  readonly domainManifestHash: Hex;
  readonly executionClassManifestHash: Hex;
}

export interface EvmAsyncObservationKeys {
  readonly packageId: Hex;
  readonly entryRequestKey: Hex;
  readonly exitRequestKey?: Hex | undefined;
  readonly minimumStateVersion?: number | undefined;
  readonly minimumEntryRevision?: number | undefined;
  readonly minimumExitRevision?: number | undefined;
}

export interface EvmAsyncCoordinatorView {
  readonly state: (typeof COORDINATOR_STATE_LABELS)[number];
  readonly stateVersion: number;
  readonly requestKey: Hex;
  readonly outcomeEvidenceHash: Hex;
  readonly recoveryEvidenceHash: Hex;
  readonly hasVenueOutcome: boolean;
  readonly lastVenueOutcome: number;
  readonly recoveryDutyActive: boolean;
  readonly recoveryActionSubmitted: boolean;
  readonly recoveryProven: boolean;
  readonly bondSlashed: boolean;
  readonly evidenceConflict: boolean;
}

export interface EvmAsyncEntryView {
  readonly status: (typeof VENUE_STATUS_LABELS)[number];
  readonly evidenceHash: Hex;
  readonly positionSizeBefore: bigint;
  readonly positionSizeAfter: bigint;
  readonly revision: number;
}

export interface EvmAsyncExitView {
  readonly status: (typeof VENUE_STATUS_LABELS)[number];
  readonly evidenceHash: Hex;
  readonly revision: number;
  readonly reconciling: boolean;
  readonly released: boolean;
}

export interface EvmAsyncFinalReceiptView {
  readonly commitment: Hex;
  readonly packageId: Hex;
  readonly entryRequestKey: Hex;
  readonly exitRequestKey: Hex;
  readonly recipient: Address;
  readonly fullCloseSizeUsd: bigint;
  readonly spotBaseAtoms: bigint;
  readonly spotQuoteAtoms: bigint;
  readonly perpStatus: number;
  readonly terminalState: number;
}

export interface EvmAsyncBondedObservation {
  readonly lifecycle: EvmAsyncLifecycle;
  readonly evidenceGrade: EvmEvidenceGrade;
  readonly chainReference: bigint;
  readonly packageId: Hex;
  readonly coordinator: EvmAsyncCoordinatorView | null;
  readonly entry: EvmAsyncEntryView | null;
  readonly exit: EvmAsyncExitView | null;
  readonly finalReceipt: EvmAsyncFinalReceiptView | null;
  readonly exitCompleted: boolean;
  readonly reason: string | null;
}

function lowerHash(value: unknown, name: string): Hex {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${name} must be a 32-byte hash`);
  }
  return value.toLowerCase() as Hex;
}

function statusLabel(discriminant: number, name: string): (typeof VENUE_STATUS_LABELS)[number] {
  const label = VENUE_STATUS_LABELS[discriminant];
  if (label === undefined) throw new Error(`${name} discriminant ${discriminant} is out of range`);
  return label;
}

function coordinatorLabel(discriminant: number): (typeof COORDINATOR_STATE_LABELS)[number] {
  const label = COORDINATOR_STATE_LABELS[discriminant];
  if (label === undefined) throw new Error(`coordinator state discriminant ${discriminant} is out of range`);
  return label;
}

function requireBool(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean`);
  return value;
}

function normalizeCoordinator(record: unknown): EvmAsyncCoordinatorView {
  const terms = structField(record, 0, 'terms');
  void terms;
  const state = safeCount(structField(record, 6, 'state'), 'package.state');
  const stateVersion = safeCount(structField(record, 7, 'stateVersion'), 'package.stateVersion');
  const flag = (index: number, name: string): boolean => requireBool(structField(record, index, name), `package.${name}`);
  return Object.freeze({
    state: coordinatorLabel(state),
    stateVersion,
    requestKey: lowerHash(structField(record, 1, 'requestKey'), 'package.requestKey'),
    outcomeEvidenceHash: lowerHash(structField(record, 2, 'outcomeEvidenceHash'), 'package.outcomeEvidenceHash'),
    recoveryEvidenceHash: lowerHash(structField(record, 3, 'recoveryEvidenceHash'), 'package.recoveryEvidenceHash'),
    hasVenueOutcome: flag(11, 'hasVenueOutcome'),
    lastVenueOutcome: safeCount(structField(record, 10, 'lastVenueOutcome'), 'package.lastVenueOutcome'),
    recoveryDutyActive: flag(12, 'recoveryDutyActive'),
    recoveryActionSubmitted: flag(13, 'recoveryActionSubmitted'),
    recoveryProven: flag(14, 'recoveryProven'),
    bondSlashed: flag(15, 'bondSlashed'),
    evidenceConflict: flag(16, 'evidenceConflict'),
  });
}

function normalizeTerms(record: unknown): {
  domainIdHash: Hex;
  domainManifestVersion: number;
  domainManifestHash: Hex;
  owner: Address;
  solver: Address;
  adapter: Address;
  handler: Address;
  orderHash: Hex;
  quoteHash: Hex;
  routeHash: Hex;
  executionClassIdentityHash: Hex;
  executionClassManifestHash: Hex;
} {
  const terms = structField(record, 0, 'terms');
  const domain = structField(terms, 0, 'domain');
  return {
    domainIdHash: lowerHash(structField(domain, 0, 'domainIdHash'), 'terms.domain.domainIdHash'),
    domainManifestVersion: safeCount(structField(domain, 1, 'manifestVersion'), 'terms.domain.manifestVersion'),
    domainManifestHash: lowerHash(structField(domain, 2, 'manifestHash'), 'terms.domain.manifestHash'),
    owner: getAddress(String(structField(terms, 1, 'owner'))),
    solver: getAddress(String(structField(terms, 2, 'solver'))),
    adapter: getAddress(String(structField(terms, 3, 'adapter'))),
    handler: getAddress(String(structField(terms, 4, 'handler'))),
    orderHash: lowerHash(structField(terms, 7, 'orderHash'), 'terms.orderHash'),
    quoteHash: lowerHash(structField(terms, 8, 'quoteHash'), 'terms.quoteHash'),
    routeHash: lowerHash(structField(terms, 9, 'routeHash'), 'terms.routeHash'),
    executionClassIdentityHash: lowerHash(structField(terms, 13, 'executionClassIdentityHash'), 'terms.executionClassIdentityHash'),
    executionClassManifestHash: lowerHash(structField(terms, 14, 'executionClassManifestHash'), 'terms.executionClassManifestHash'),
  };
}

function normalizeEntry(record: unknown): EvmAsyncEntryView {
  const status = safeCount(structField(record, 0, 'status'), 'entry.status');
  const quantity = (index: number, name: string): bigint => {
    const value = structField(record, index, name);
    if (typeof value !== 'bigint' || value < 0n) throw new Error(`${name} must be a non-negative integer`);
    return value;
  };
  return Object.freeze({
    status: statusLabel(status, 'entry'),
    evidenceHash: lowerHash(structField(record, 1, 'evidenceHash'), 'entry.evidenceHash'),
    positionSizeBefore: quantity(2, 'entry.positionSizeBefore'),
    positionSizeAfter: quantity(3, 'entry.positionSizeAfter'),
    revision: safeCount(structField(record, 4, 'revision'), 'entry.revision'),
  });
}

function normalizeExit(record: unknown): EvmAsyncExitView {
  const status = safeCount(structField(record, 0, 'status'), 'exit.status');
  return Object.freeze({
    status: statusLabel(status, 'exit'),
    evidenceHash: lowerHash(structField(record, 1, 'evidenceHash'), 'exit.evidenceHash'),
    revision: safeCount(structField(record, 2, 'revision'), 'exit.revision'),
    reconciling: requireBool(structField(record, 3, 'reconciling'), 'exit.reconciling'),
    released: requireBool(structField(record, 4, 'released'), 'exit.released'),
  });
}

function normalizeFinalReceipt(record: unknown): EvmAsyncFinalReceiptView {
  const quantity = (index: number, name: string): bigint => {
    const value = structField(record, index, name);
    if (typeof value !== 'bigint' || value < 0n) throw new Error(`${name} must be a non-negative integer`);
    return value;
  };
  return Object.freeze({
    commitment: lowerHash(structField(record, 0, 'commitment'), 'finalReceipt.commitment'),
    packageId: lowerHash(structField(record, 1, 'packageId'), 'finalReceipt.packageId'),
    entryRequestKey: lowerHash(structField(record, 2, 'entryRequestKey'), 'finalReceipt.entryRequestKey'),
    exitRequestKey: lowerHash(structField(record, 3, 'exitRequestKey'), 'finalReceipt.exitRequestKey'),
    recipient: getAddress(String(structField(record, 11, 'recipient'))),
    fullCloseSizeUsd: quantity(12, 'finalReceipt.fullCloseSizeUsd'),
    spotBaseAtoms: quantity(13, 'finalReceipt.spotBaseAtoms'),
    spotQuoteAtoms: quantity(14, 'finalReceipt.spotQuoteAtoms'),
    perpStatus: safeCount(structField(record, 15, 'perpStatus'), 'finalReceipt.perpStatus'),
    terminalState: safeCount(structField(record, 16, 'terminalState'), 'finalReceipt.terminalState'),
  });
}

function coordinatorEntryCompatible(state: number, entryStatus: number): boolean {
  switch (state) {
    case 1:
      return entryStatus === 0;
    case 2:
    case 3:
    case 7:
    case 9:
      return entryStatus !== 0;
    case 4:
      return entryStatus === 2;
    case 5:
      return entryStatus === 3;
    case 6:
      return entryStatus === 4;
    case 8:
      return entryStatus === 5;
    case 10:
      return entryStatus === 2 || entryStatus === 5;
    default:
      return false;
  }
}

function fail(
  chain: bigint,
  packageId: Hex,
  coordinator: EvmAsyncCoordinatorView | null,
  entry: EvmAsyncEntryView | null,
  reason: string,
): EvmAsyncBondedObservation {
  return Object.freeze({
    lifecycle: 'EVIDENCE_MISMATCH' as const,
    evidenceGrade: 'contract-state' as const,
    chainReference: chain,
    packageId,
    coordinator,
    entry,
    exit: null,
    finalReceipt: null,
    exitCompleted: false,
    reason,
  });
}

export async function observeAsyncBondedPackage(
  port: EvmReadPort,
  binding: EvmAsyncObservationBinding,
  keys: EvmAsyncObservationKeys,
): Promise<EvmAsyncBondedObservation> {
  const expectedChain = chainReference(binding.chainReference, 'chainReference');
  const coordinator = requiredEvmAddress(binding.coordinator, 'coordinator');
  const entryAdapter = requiredEvmAddress(binding.entryAdapter, 'entryAdapter');
  const handler = requiredEvmAddress(binding.handler, 'handler');
  const owner = requiredEvmAddress(binding.owner, 'owner');
  const orderHash = hash32(binding.orderHash, 'orderHash');
  const quoteHash = hash32(binding.quoteHash, 'quoteHash');
  const routeHash = hash32(binding.routeHash, 'routeHash');
  const domainIdHash = hash32(binding.domainIdHash, 'domainIdHash');
  const domainManifestHash = hash32(binding.domainManifestHash, 'domainManifestHash');
  const executionClassManifestHash = hash32(binding.executionClassManifestHash, 'executionClassManifestHash');
  if (!Number.isSafeInteger(binding.domainManifestVersion) || binding.domainManifestVersion <= 0) {
    throw new Error('domainManifestVersion must be a positive safe integer');
  }
  const packageId = hash32(keys.packageId, 'packageId');
  const entryRequestKey = hash32(keys.entryRequestKey, 'entryRequestKey');
  const exitRequestKey = keys.exitRequestKey === undefined ? null : hash32(keys.exitRequestKey, 'exitRequestKey');
  if (exitRequestKey !== null && binding.exitController === undefined) {
    throw new Error('an exit request key requires the expected exit controller address');
  }
  const exitController = binding.exitController === undefined ? null : requiredEvmAddress(binding.exitController, 'exitController');

  const observedChain = await port.chainId();
  if (observedChain !== expectedChain) {
    return fail(expectedChain, packageId, null, null, 'observed chain ID does not match the expected chain reference');
  }

  let packageRecord: unknown;
  try {
    packageRecord = await port.readContract({ address: coordinator, abi: ASYNC_COORDINATOR_OBSERVATION_ABI, functionName: 'packageState', args: [packageId] });
  } catch {
    return fail(expectedChain, packageId, null, null, 'coordinator package state is unreadable');
  }
  let view: EvmAsyncCoordinatorView;
  try {
    view = normalizeCoordinator(packageRecord);
  } catch {
    return fail(expectedChain, packageId, null, null, 'coordinator package state failed to decode');
  }
  if (view.state === 'NONE') {
    return Object.freeze({
      lifecycle: 'NOT_FOUND' as const,
      evidenceGrade: 'none' as const,
      chainReference: expectedChain,
      packageId,
      coordinator: null,
      entry: null,
      exit: null,
      finalReceipt: null,
      exitCompleted: false,
      reason: 'package ID is unknown to the coordinator',
    });
  }
  if (view.stateVersion < 1) return fail(expectedChain, packageId, view, null, 'coordinator state version is not monotonic');
  if (keys.minimumStateVersion !== undefined && view.stateVersion < keys.minimumStateVersion) {
    return fail(expectedChain, packageId, view, null, 'coordinator state version regressed below the caller minimum');
  }

  let terms: ReturnType<typeof normalizeTerms>;
  try {
    terms = normalizeTerms(packageRecord);
  } catch {
    return fail(expectedChain, packageId, view, null, 'coordinator terms failed to decode');
  }
  if (
    !equalHash(terms.domainIdHash, domainIdHash) || terms.domainManifestVersion !== binding.domainManifestVersion
    || !equalHash(terms.domainManifestHash, domainManifestHash)
  ) {
    return fail(expectedChain, packageId, view, null, 'coordinator terms domain does not match the expected domain');
  }
  if (!equalAddress(terms.owner, owner)) return fail(expectedChain, packageId, view, null, 'coordinator terms owner mismatch');
  if (!equalAddress(terms.adapter, entryAdapter) || !equalAddress(terms.handler, handler)) {
    return fail(expectedChain, packageId, view, null, 'coordinator terms adapter or handler mismatch');
  }
  if (!equalHash(terms.orderHash, orderHash) || !equalHash(terms.quoteHash, quoteHash) || !equalHash(terms.routeHash, routeHash)) {
    return fail(expectedChain, packageId, view, null, 'coordinator terms order, quote, or route hash mismatch');
  }
  if (
    terms.executionClassIdentityHash.toLowerCase() !== ASYNC_BONDED_EXECUTION_CLASS_ID.toLowerCase()
    || !equalHash(terms.executionClassManifestHash, executionClassManifestHash)
  ) {
    return fail(expectedChain, packageId, view, null, 'coordinator terms execution class mismatch');
  }
  if (!equalHash(view.requestKey, entryRequestKey)) {
    return fail(expectedChain, packageId, view, null, 'coordinator request key does not match the bound entry request key');
  }

  let entry: EvmAsyncEntryView | null = null;
  if (entryRequestKey !== zeroHash) {
    const adapterRequestKey = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [entryAdapter, entryRequestKey]));
    let ownerRecord: unknown;
    try {
      ownerRecord = await port.readContract({ address: coordinator, abi: ASYNC_COORDINATOR_OBSERVATION_ABI, functionName: 'requestKeyOwner', args: [adapterRequestKey] });
    } catch {
      return fail(expectedChain, packageId, view, null, 'request key ownership is unreadable');
    }
    const ownerPackageId = typeof ownerRecord === 'string' ? ownerRecord.toLowerCase() : '';
    if (ownerPackageId !== packageId) {
      return fail(expectedChain, packageId, view, null, 'request key ownership does not resolve to the bound package ID');
    }
    let entryRecord: unknown;
    try {
      entryRecord = await port.readContract({ address: entryAdapter, abi: GMX_ENTRY_ADAPTER_OBSERVATION_ABI, functionName: 'requestEvidence', args: [entryRequestKey] });
    } catch {
      return fail(expectedChain, packageId, view, null, 'entry adapter evidence is unreadable');
    }
    try {
      entry = normalizeEntry(entryRecord);
    } catch {
      return fail(expectedChain, packageId, view, null, 'entry adapter evidence failed to decode');
    }
    if (entry.revision < 1) return fail(expectedChain, packageId, view, entry, 'entry revision is not monotonic');
    if (keys.minimumEntryRevision !== undefined && entry.revision < keys.minimumEntryRevision) {
      return fail(expectedChain, packageId, view, entry, 'entry revision regressed below the caller minimum');
    }
    const terminal = entry.status === 'EXECUTED' || entry.status === 'CANCELLED' || entry.status === 'FROZEN' || entry.status === 'RECOVERED' || entry.status === 'CONFLICT';
    if (terminal && entry.evidenceHash === zeroHash) {
      return fail(expectedChain, packageId, view, entry, 'terminal entry status carries no evidence commitment');
    }
  } else if (view.state !== 'RESERVED') {
    return fail(expectedChain, packageId, view, null, 'missing entry request key for a submitted package');
  }

  if (view.evidenceConflict || entry?.status === 'CONFLICT') {
    const grade: EvmEvidenceGrade = entry !== null && entry.evidenceHash !== zeroHash ? 'authenticated-callback-record' : 'contract-state';
    return Object.freeze({
      lifecycle: 'CONFLICT' as const,
      evidenceGrade: grade,
      chainReference: expectedChain,
      packageId,
      coordinator: view,
      entry,
      exit: null,
      finalReceipt: null,
      exitCompleted: false,
      reason: 'conflicting venue or recovery evidence requires manual intervention',
    });
  }

  const stateIndex = COORDINATOR_STATE_LABELS.indexOf(view.state);
  const entryStatus = entry === null ? 0 : VENUE_STATUS_LABELS.indexOf(entry.status);
  if (!coordinatorEntryCompatible(stateIndex, entryStatus)) {
    return fail(expectedChain, packageId, view, entry, 'coordinator and entry adapter states are incompatible');
  }

  if (view.state === 'EXECUTED' || view.state === 'CANCELLED' || view.state === 'FROZEN') {
    if (view.outcomeEvidenceHash === zeroHash) {
      return fail(expectedChain, packageId, view, entry, 'terminal coordinator state carries no outcome evidence');
    }
  }
  if (view.state === 'RECOVERED' && view.recoveryEvidenceHash === zeroHash) {
    return fail(expectedChain, packageId, view, entry, 'recovered coordinator state carries no recovery evidence');
  }
  if (view.state === 'CLOSED' && entryRequestKey !== zeroHash && view.outcomeEvidenceHash === zeroHash && view.recoveryEvidenceHash === zeroHash) {
    return fail(expectedChain, packageId, view, entry, 'closed package carries no outcome or recovery evidence');
  }

  let exit: EvmAsyncExitView | null = null;
  let finalReceipt: EvmAsyncFinalReceiptView | null = null;
  let exitCompleted = false;
  if (exitRequestKey !== null && exitRequestKey !== zeroHash && exitController !== null) {
    if (view.state !== 'EXECUTED' && view.state !== 'CLOSED') {
      return fail(expectedChain, packageId, view, entry, 'exit evidence exists before entry completion');
    }
    if (entry === null || entry.status !== 'EXECUTED') {
      return fail(expectedChain, packageId, view, entry, 'exit evidence exists without an executed entry');
    }
    let exitRecord: unknown;
    try {
      exitRecord = await port.readContract({ address: exitController, abi: GMX_EXIT_CONTROLLER_OBSERVATION_ABI, functionName: 'exitEvidence', args: [exitRequestKey] });
    } catch {
      return fail(expectedChain, packageId, view, entry, 'exit controller evidence is unreadable');
    }
    try {
      exit = normalizeExit(exitRecord);
    } catch {
      return fail(expectedChain, packageId, view, entry, 'exit controller evidence failed to decode');
    }
    if (exit.status === 'NONE') return fail(expectedChain, packageId, view, entry, 'exit request key is unknown to the exit controller');
    if (
      (exit.status === 'EXECUTED' || exit.status === 'CANCELLED' || exit.status === 'FROZEN' || exit.status === 'RECOVERED' || exit.status === 'CONFLICT')
      && exit.evidenceHash === zeroHash
    ) {
      return fail(expectedChain, packageId, view, entry, 'terminal exit status carries no evidence commitment');
    }
    if (exit.status === 'CONFLICT') {
      return Object.freeze({
        lifecycle: 'CONFLICT' as const,
        evidenceGrade: 'authenticated-callback-record' as const,
        chainReference: expectedChain,
        packageId,
        coordinator: view,
        entry,
        exit,
        finalReceipt: null,
        exitCompleted: false,
        reason: 'conflicting exit evidence requires manual intervention',
      });
    }
    if (exit.revision < 1) return fail(expectedChain, packageId, view, entry, 'exit revision is not monotonic');
    if (keys.minimumExitRevision !== undefined && exit.revision < keys.minimumExitRevision) {
      return fail(expectedChain, packageId, view, entry, 'exit revision regressed below the caller minimum');
    }
    let receiptRecord: unknown = null;
    try {
      receiptRecord = await port.readContract({ address: exitController, abi: GMX_EXIT_CONTROLLER_OBSERVATION_ABI, functionName: 'finalPackageReceipt', args: [exitRequestKey] });
    } catch {
      receiptRecord = null;
    }
    let parsed: EvmAsyncFinalReceiptView | null = null;
    if (receiptRecord !== null && receiptRecord !== undefined) {
      try {
        const candidate = normalizeFinalReceipt(receiptRecord);
        if (candidate.commitment !== zeroHash) parsed = candidate;
      } catch {
        return fail(expectedChain, packageId, view, entry, 'final package receipt failed to decode');
      }
    }
    if (parsed !== null) {
      if (
        !equalHash(parsed.packageId, packageId) || !equalHash(parsed.entryRequestKey, entryRequestKey)
        || !equalHash(parsed.exitRequestKey, exitRequestKey)
        || !(parsed.terminalState === TERMINAL_COMPLETE ? parsed.spotQuoteAtoms > 0n
          : parsed.terminalState === TERMINAL_SPOT_IN_KIND && parsed.spotQuoteAtoms === 0n)
        || parsed.perpStatus !== VENUE_STATUS_LABELS.indexOf(exit.status)
      ) {
        return fail(expectedChain, packageId, view, entry, 'final package receipt does not match the bound package and exit');
      }
      finalReceipt = parsed;
    } else if (exit.status === 'EXECUTED' && exit.released) {
      return fail(expectedChain, packageId, view, entry, 'released exit carries no final package receipt');
    }
    exitCompleted = exit.status === 'EXECUTED' && exit.evidenceHash !== zeroHash && exit.released && finalReceipt !== null;
  }

  const grade: EvmEvidenceGrade = exitCompleted
    ? 'finalized-contract-receipt'
    : entry !== null && entry.evidenceHash !== zeroHash || exit !== null && exit.evidenceHash !== zeroHash
      ? 'authenticated-callback-record'
      : 'contract-state';
  return Object.freeze({
    lifecycle: view.state,
    evidenceGrade: grade,
    chainReference: expectedChain,
    packageId,
    coordinator: view,
    entry,
    exit,
    finalReceipt,
    exitCompleted,
    reason: null,
  });
}
