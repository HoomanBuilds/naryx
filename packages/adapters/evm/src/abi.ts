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

const execution = [
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

const admission = [
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
      { name: 'execution', type: 'tuple', components: execution },
      { name: 'admission', type: 'tuple', components: admission },
      { name: 'traderSignature', type: 'bytes' },
      { name: 'solverSignature', type: 'bytes' },
      { name: 'perpArgs', type: 'bytes32[2]' },
    ],
    outputs: [{ name: 'receiptHash', type: 'bytes32' }],
  },
];
