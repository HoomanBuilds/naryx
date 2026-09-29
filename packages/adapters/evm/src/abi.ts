import type { Abi, AbiParameter } from 'viem';

const manifestReference = [
  { name: 'subjectId', type: 'bytes32' },
  { name: 'manifestVersion', type: 'uint32' },
  { name: 'manifestHash', type: 'bytes32' },
] as const satisfies readonly AbiParameter[];

const resourceReference = [
  { name: 'manifest', type: 'tuple', components: manifestReference },
  { name: 'localAddress', type: 'address' },
  { name: 'expectedCodeHash', type: 'bytes32' },
] as const satisfies readonly AbiParameter[];

const legAdmission = [
  { name: 'adapter', type: 'tuple', components: resourceReference },
  { name: 'adapterClassId', type: 'bytes32' },
  { name: 'adapterClassVersion', type: 'uint32' },
  { name: 'market', type: 'tuple', components: resourceReference },
  { name: 'venue', type: 'tuple', components: resourceReference },
  { name: 'quantityAtoms', type: 'uint256' },
  { name: 'limitQuoteAtomsPerBaseLot', type: 'uint256' },
] as const satisfies readonly AbiParameter[];

const assetAdmission = [
  { name: 'manifest', type: 'tuple', components: manifestReference },
  { name: 'localAddress', type: 'address' },
  { name: 'expectedCodeHash', type: 'bytes32' },
  { name: 'decimals', type: 'uint8' },
] as const satisfies readonly AbiParameter[];

export const EVM_EXECUTION_COMPONENTS = [
  { name: 'domainIdHash', type: 'bytes32' },
  { name: 'domainManifestVersion', type: 'uint32' },
  { name: 'domainManifestHash', type: 'bytes32' },
  { name: 'orderHash', type: 'bytes32' },
  { name: 'quoteHash', type: 'bytes32' },
  { name: 'routeHash', type: 'bytes32' },
  { name: 'spotFillCommitment', type: 'bytes32' },
  { name: 'packageQuoteIntentHash', type: 'bytes32' },
  { name: 'seriesIdentityKey', type: 'bytes32' },
  { name: 'seriesBindingVersion', type: 'uint32' },
  { name: 'seriesBindingHash', type: 'bytes32' },
  { name: 'action', type: 'uint8' },
  { name: 'strategyAccount', type: 'address' },
  { name: 'solver', type: 'address' },
  { name: 'spotPort', type: 'address' },
  { name: 'perpObserver', type: 'address' },
  { name: 'perpInstrument', type: 'address' },
  { name: 'perpExpiry', type: 'uint32' },
  { name: 'baseToken', type: 'address' },
  { name: 'quoteToken', type: 'address' },
  { name: 'baseQuantityAtoms', type: 'uint256' },
  { name: 'perpQuantityWad', type: 'uint256' },
  { name: 'spotQuoteBoundAtoms', type: 'uint256' },
  { name: 'packageNotionalQuoteAtoms', type: 'uint256' },
  { name: 'packageSizeUnits', type: 'uint128' },
  { name: 'expectedPrePerpBalanceWad', type: 'int128' },
  { name: 'expectedPrePerpSizeWad', type: 'int128' },
  { name: 'expectedPrePerpEntryNotionalWad', type: 'uint128' },
  { name: 'expectedPostPerpSizeWad', type: 'int128' },
  { name: 'minimumPostPerpBalanceWad', type: 'int128' },
  { name: 'maximumPostPerpBalanceWad', type: 'int128' },
  { name: 'maximumPostPerpEntryNotionalWad', type: 'uint128' },
  { name: 'entryReceiptHash', type: 'bytes32' },
  { name: 'nonce', type: 'uint256' },
  { name: 'deadline', type: 'uint256' },
] as const satisfies readonly AbiParameter[];

export const EVM_CASH_CARRY_ADMISSION_COMPONENTS = [
  {
    name: 'domain',
    type: 'tuple',
    components: [
      { name: 'domainIdHash', type: 'bytes32' },
      { name: 'manifestVersion', type: 'uint32' },
      { name: 'manifestHash', type: 'bytes32' },
    ],
  },
  {
    name: 'template',
    type: 'tuple',
    components: [
      { name: 'templateId', type: 'bytes32' },
      { name: 'templateVersion', type: 'uint32' },
      { name: 'templateManifestHash', type: 'bytes32' },
    ],
  },
  {
    name: 'settlementClass',
    type: 'tuple',
    components: [
      { name: 'classId', type: 'bytes32' },
      { name: 'classVersion', type: 'uint32' },
    ],
  },
  { name: 'spot', type: 'tuple', components: legAdmission },
  { name: 'perpetual', type: 'tuple', components: legAdmission },
  { name: 'baseAsset', type: 'tuple', components: assetAdmission },
  { name: 'quoteAsset', type: 'tuple', components: assetAdmission },
  { name: 'action', type: 'uint8' },
  { name: 'packageNotionalQuoteAtoms', type: 'uint256' },
] as const satisfies readonly AbiParameter[];

export const NARYX_STRATEGY_ACCOUNT_ABI: Abi = [
  {
    type: 'function',
    name: 'executePackage',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'execution', type: 'tuple', components: EVM_EXECUTION_COMPONENTS },
      { name: 'admission', type: 'tuple', components: EVM_CASH_CARRY_ADMISSION_COMPONENTS },
      { name: 'traderSignature', type: 'bytes' },
      { name: 'solverSignature', type: 'bytes' },
      { name: 'perpArgs', type: 'bytes32[2]' },
    ],
    outputs: [{ name: 'receiptHash', type: 'bytes32' }],
  },
];

const packageVerifierReceipt = [
  { name: 'domainIdHash', type: 'bytes32' },
  { name: 'domainManifestVersion', type: 'uint32' },
  { name: 'domainManifestHash', type: 'bytes32' },
  { name: 'orderHash', type: 'bytes32' },
  { name: 'quoteHash', type: 'bytes32' },
  { name: 'routeHash', type: 'bytes32' },
  { name: 'spotFillCommitment', type: 'bytes32' },
  { name: 'packageQuoteIntentHash', type: 'bytes32' },
  { name: 'packageQuoteFillCommitment', type: 'bytes32' },
  { name: 'seriesIdentityKey', type: 'bytes32' },
  { name: 'seriesBindingVersion', type: 'uint32' },
  { name: 'seriesBindingHash', type: 'bytes32' },
  { name: 'action', type: 'uint8' },
  { name: 'strategyAccount', type: 'address' },
  { name: 'solver', type: 'address' },
  { name: 'recovery', type: 'bool' },
  { name: 'baseQuantityAtoms', type: 'uint256' },
  { name: 'spotQuoteAtoms', type: 'uint256' },
  { name: 'packageSizeUnits', type: 'uint128' },
  { name: 'prePerpBalanceWad', type: 'int128' },
  { name: 'prePerpSizeWad', type: 'int128' },
  { name: 'prePerpEntryNotionalWad', type: 'uint128' },
  { name: 'postPerpBalanceWad', type: 'int128' },
  { name: 'postPerpSizeWad', type: 'int128' },
  { name: 'postPerpEntryNotionalWad', type: 'uint128' },
  { name: 'entryReceiptHash', type: 'bytes32' },
  { name: 'nonce', type: 'uint256' },
] as const satisfies readonly AbiParameter[];

const packageVerifierOpenPackage = [
  { name: 'entryReceiptHash', type: 'bytes32' },
  { name: 'seriesIdentityKey', type: 'bytes32' },
  { name: 'seriesBindingVersion', type: 'uint32' },
  { name: 'seriesBindingHash', type: 'bytes32' },
  { name: 'routeHash', type: 'bytes32' },
  { name: 'spotPort', type: 'address' },
  { name: 'perpObserver', type: 'address' },
  { name: 'perpInstrument', type: 'address' },
  { name: 'perpExpiry', type: 'uint32' },
  { name: 'baseToken', type: 'address' },
  { name: 'quoteToken', type: 'address' },
  { name: 'baseQuantityAtoms', type: 'uint256' },
  { name: 'perpQuantityWad', type: 'uint256' },
  { name: 'packageSizeUnits', type: 'uint128' },
  { name: 'entryPerpNotionalWad', type: 'uint128' },
] as const satisfies readonly AbiParameter[];

export const PACKAGE_VERIFIER_OBSERVATION_ABI: Abi = [
  {
    type: 'function',
    name: 'receipt',
    stateMutability: 'view',
    inputs: [{ name: 'receiptHash', type: 'bytes32' }],
    outputs: [{ name: '', type: 'tuple', components: packageVerifierReceipt }],
  },
  {
    type: 'function',
    name: 'openPackage',
    stateMutability: 'view',
    inputs: [{ name: 'strategyAccount', type: 'address' }],
    outputs: [{ name: '', type: 'tuple', components: packageVerifierOpenPackage }],
  },
  {
    type: 'event',
    name: 'PackageVerified',
    inputs: [
      { name: 'receiptHash', type: 'bytes32', indexed: true },
      { name: 'strategyAccount', type: 'address', indexed: true },
      { name: 'action', type: 'uint8', indexed: true },
      { name: 'solver', type: 'address', indexed: false },
      { name: 'recovery', type: 'bool', indexed: false },
      { name: 'baseQuantityAtoms', type: 'uint256', indexed: false },
      { name: 'spotQuoteAtoms', type: 'uint256', indexed: false },
      { name: 'packageQuoteIntentHash', type: 'bytes32', indexed: false },
      { name: 'packageQuoteFillCommitment', type: 'bytes32', indexed: false },
    ],
  },
];

const asyncCoordinatorDomainRef = [
  { name: 'domainIdHash', type: 'bytes32' },
  { name: 'manifestVersion', type: 'uint32' },
  { name: 'manifestHash', type: 'bytes32' },
] as const satisfies readonly AbiParameter[];

const asyncCoordinatorTerms = [
  { name: 'domain', type: 'tuple', components: asyncCoordinatorDomainRef },
  { name: 'owner', type: 'address' },
  { name: 'solver', type: 'address' },
  { name: 'adapter', type: 'address' },
  { name: 'handler', type: 'address' },
  { name: 'adapterCodeHash', type: 'bytes32' },
  { name: 'handlerCodeHash', type: 'bytes32' },
  { name: 'orderHash', type: 'bytes32' },
  { name: 'quoteHash', type: 'bytes32' },
  { name: 'routeHash', type: 'bytes32' },
  { name: 'seriesIdentityKey', type: 'bytes32' },
  { name: 'seriesBindingVersion', type: 'uint32' },
  { name: 'seriesBindingHash', type: 'bytes32' },
  { name: 'executionClassIdentityHash', type: 'bytes32' },
  { name: 'executionClassManifestHash', type: 'bytes32' },
  { name: 'requestPayloadHash', type: 'bytes32' },
  { name: 'reservationHash', type: 'bytes32' },
  { name: 'bondHash', type: 'bytes32' },
  { name: 'recoveryPolicyHash', type: 'bytes32' },
  { name: 'evidenceSchemaHash', type: 'bytes32' },
  { name: 'bondRecipient', type: 'address' },
  { name: 'recoveryReserveRecipient', type: 'address' },
  { name: 'slashRecipient', type: 'address' },
  { name: 'lossAsset', type: 'address' },
  { name: 'residualAsset', type: 'address' },
  { name: 'bondAtoms', type: 'uint256' },
  { name: 'recoveryReserveAtoms', type: 'uint256' },
  { name: 'maxAggregateLossAtoms', type: 'uint256' },
  { name: 'maxIntermediateResidualAtoms', type: 'uint256' },
  { name: 'maxTerminalResidualAtoms', type: 'uint256' },
  { name: 'nonce', type: 'uint256' },
  { name: 'submissionDeadline', type: 'uint64' },
  { name: 'venueDeadline', type: 'uint64' },
  { name: 'recoveryDeadline', type: 'uint64' },
] as const satisfies readonly AbiParameter[];

const asyncCoordinatorPackage = [
  { name: 'terms', type: 'tuple', components: asyncCoordinatorTerms },
  { name: 'requestKey', type: 'bytes32' },
  { name: 'outcomeEvidenceHash', type: 'bytes32' },
  { name: 'recoveryEvidenceHash', type: 'bytes32' },
  { name: 'venueEvidenceCommitment', type: 'bytes32' },
  { name: 'recoveryEvidenceCommitment', type: 'bytes32' },
  { name: 'state', type: 'uint8' },
  { name: 'stateVersion', type: 'uint64' },
  { name: 'admissionGeneration', type: 'uint64' },
  { name: 'recoveryDutyStartedAt', type: 'uint64' },
  { name: 'lastVenueOutcome', type: 'uint8' },
  { name: 'hasVenueOutcome', type: 'bool' },
  { name: 'recoveryDutyActive', type: 'bool' },
  { name: 'recoveryActionSubmitted', type: 'bool' },
  { name: 'recoveryProven', type: 'bool' },
  { name: 'bondSlashed', type: 'bool' },
  { name: 'evidenceConflict', type: 'bool' },
  { name: 'settledLossAtoms', type: 'uint256' },
] as const satisfies readonly AbiParameter[];

export const ASYNC_COORDINATOR_OBSERVATION_ABI: Abi = [
  {
    type: 'function',
    name: 'packageState',
    stateMutability: 'view',
    inputs: [{ name: 'id', type: 'bytes32' }],
    outputs: [{ name: '', type: 'tuple', components: asyncCoordinatorPackage }],
  },
  {
    type: 'function',
    name: 'requestKeyOwner',
    stateMutability: 'view',
    inputs: [{ name: 'adapterRequestKey', type: 'bytes32' }],
    outputs: [{ name: 'packageId', type: 'bytes32' }],
  },
];

export const GMX_ENTRY_ADAPTER_OBSERVATION_ABI: Abi = [
  {
    type: 'function',
    name: 'requestEvidence',
    stateMutability: 'view',
    inputs: [{ name: 'requestKey', type: 'bytes32' }],
    outputs: [
      { name: 'status', type: 'uint8' },
      { name: 'evidenceHash', type: 'bytes32' },
      { name: 'positionSizeBefore', type: 'uint256' },
      { name: 'positionSizeAfter', type: 'uint256' },
      { name: 'revision', type: 'uint64' },
    ],
  },
];

const exitFinalReceipt = [
  { name: 'commitment', type: 'bytes32' },
  { name: 'packageId', type: 'bytes32' },
  { name: 'entryRequestKey', type: 'bytes32' },
  { name: 'exitRequestKey', type: 'bytes32' },
  { name: 'entryRequestPayloadHash', type: 'bytes32' },
  { name: 'spotRegistrationHash', type: 'bytes32' },
  { name: 'exitAuthorizationHash', type: 'bytes32' },
  { name: 'perpEvidenceHash', type: 'bytes32' },
  { name: 'spotEvidenceHash', type: 'bytes32' },
  { name: 'entryCommitmentsHash', type: 'bytes32' },
  { name: 'exitCommitmentsHash', type: 'bytes32' },
  { name: 'recipient', type: 'address' },
  { name: 'fullCloseSizeUsd', type: 'uint256' },
  { name: 'spotBaseAtoms', type: 'uint256' },
  { name: 'spotQuoteAtoms', type: 'uint256' },
  { name: 'perpStatus', type: 'uint8' },
  { name: 'terminalState', type: 'uint8' },
] as const satisfies readonly AbiParameter[];

export const GMX_EXIT_CONTROLLER_OBSERVATION_ABI: Abi = [
  {
    type: 'function',
    name: 'exitEvidence',
    stateMutability: 'view',
    inputs: [{ name: 'requestKey', type: 'bytes32' }],
    outputs: [
      { name: 'status', type: 'uint8' },
      { name: 'evidenceHash', type: 'bytes32' },
      { name: 'revision', type: 'uint64' },
      { name: 'reconciling', type: 'bool' },
      { name: 'released', type: 'bool' },
    ],
  },
  {
    type: 'function',
    name: 'finalPackageReceipt',
    stateMutability: 'view',
    inputs: [{ name: 'requestKey', type: 'bytes32' }],
    outputs: [{ name: '', type: 'tuple', components: exitFinalReceipt }],
  },
];

const localAtomicExecution = [
  { name: 'domainIdHash', type: 'bytes32' },
  { name: 'domainManifestVersion', type: 'uint32' },
  { name: 'domainManifestHash', type: 'bytes32' },
  { name: 'orderHash', type: 'bytes32' },
  { name: 'quoteHash', type: 'bytes32' },
  { name: 'routeHash', type: 'bytes32' },
  { name: 'action', type: 'uint8' },
  { name: 'quantity', type: 'uint256' },
  { name: 'limitQuote', type: 'uint256' },
  { name: 'collateral', type: 'uint256' },
  { name: 'trader', type: 'address' },
  { name: 'recipient', type: 'address' },
  { name: 'solver', type: 'address' },
  { name: 'venue', type: 'address' },
  { name: 'executor', type: 'address' },
  { name: 'chainId', type: 'uint256' },
  { name: 'entryReceiptHash', type: 'bytes32' },
  { name: 'nonce', type: 'uint256' },
  { name: 'deadline', type: 'uint256' },
] as const satisfies readonly AbiParameter[];

export const ATOMIC_PACKAGE_EXECUTOR_ABI: Abi = [
  {
    type: 'function',
    name: 'execute',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'execution', type: 'tuple', components: localAtomicExecution },
      { name: 'traderSignature', type: 'bytes' },
      { name: 'solverSignature', type: 'bytes' },
    ],
    outputs: [{ name: 'receiptHash', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'traderPermitDigest',
    stateMutability: 'view',
    inputs: [{ name: 'execution', type: 'tuple', components: localAtomicExecution }],
    outputs: [{ name: 'digest', type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'solverAuthorizationDigest',
    stateMutability: 'view',
    inputs: [{ name: 'execution', type: 'tuple', components: localAtomicExecution }],
    outputs: [{ name: 'digest', type: 'bytes32' }],
  },
];
