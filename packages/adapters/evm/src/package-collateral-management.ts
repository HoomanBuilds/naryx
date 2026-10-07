import {
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  parseAbiParameters,
  stringToHex,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import type { EvmStrategyAdapterIdentity } from './multi-strategy-account.js';

const ACCOUNT_ABI = parseAbi([
  'function managePackageCollateral((bytes32 packageId,bytes32 intentHash,(bytes32 templateId,uint32 templateVersion,bytes32 templateManifestHash) template,(bytes32 classId,uint32 classVersion) settlementClass,(bytes32 subjectId,uint32 manifestVersion,bytes32 manifestHash) adapter,address target,uint8 action,address assetToken,uint256 inputAtoms,uint256 minimumOutputAtoms,uint256 maximumOutputAtoms,address approvalToken,uint256 approvalAtoms,uint256 grossNotionalAtoms,uint256 gasLimit,bytes32 payloadHash,uint256 nonce,uint256 deadline) management,bytes payload) returns (bytes32 evidenceHash)',
]);
const TOKEN_ABI = parseAbi(['function approve(address spender,uint256 amount) returns (bool)']);
const COLLATERAL_PAYLOAD = parseAbiParameters(
  '(bytes32 packageId,bytes32 intentHash,bytes32 expectedPreAccountDataHash,uint8 action,uint256 inputAtoms,uint256 minimumOutputAtoms,uint256 maximumOutputAtoms,uint256 minimumPostCollateralBase,uint256 maximumPostCollateralBase,uint256 minimumPostHealthFactor)',
);
const INTENT_PARAMETERS = parseAbiParameters(
  'bytes32,uint256,address,address,bytes32,bytes32,bytes32,uint8,address,uint256,uint256,uint256,bytes32,uint256,uint256,uint256,uint256,uint256',
);

const ZERO_HASH = `0x${'00'.repeat(32)}` as Hex;

export type EvmPackageCollateralAction = 'SUPPLY' | 'WITHDRAW';

export interface EvmPackageCollateralTransaction {
  readonly kind: 'RESET_COLLATERAL_ALLOWANCE' | 'APPROVE_COLLATERAL' | 'MANAGE_PACKAGE_COLLATERAL';
  readonly to: Address;
  readonly data: Hex;
  readonly value: 0n;
}

export interface EvmPackageCollateralManagementPlan {
  readonly version: 1;
  readonly chainId: number;
  readonly owner: Address;
  readonly strategyAccount: Address;
  readonly quoteHash: Hex;
  readonly packageId: Hex;
  readonly intentHash: Hex;
  readonly action: EvmPackageCollateralAction;
  readonly assetToken: Address;
  readonly inputAtoms: bigint;
  readonly minimumOutputAtoms: bigint;
  readonly maximumOutputAtoms: bigint;
  readonly transactions: readonly EvmPackageCollateralTransaction[];
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function hash32(value: Hex, context: string): Hex {
  const normalized = value.toLowerCase() as Hex;
  requireCondition(/^0x[0-9a-f]{64}$/.test(normalized) && normalized !== ZERO_HASH, `${context} must be a nonzero bytes32`);
  return normalized;
}

function u32(value: number, context: string): number {
  requireCondition(Number.isInteger(value) && value > 0 && value <= 0xffff_ffff, `${context} must be a positive u32`);
  return value;
}

export function compileEvmPackageCollateralManagement(input: Readonly<{
  chainId: number;
  owner: Address;
  strategyAccount: Address;
  quoteHash: Hex;
  packageId: Hex;
  templateId: string;
  templateVersion: number;
  templateManifestHash: Hex;
  adapter: EvmStrategyAdapterIdentity;
  adapterAddress: Address;
  assetToken: Address;
  action: EvmPackageCollateralAction;
  inputAtoms: bigint;
  currentOwnerAllowanceAtoms: bigint;
  expectedPreAccountDataHash: Hex;
  minimumOutputAtoms: bigint;
  maximumOutputAtoms: bigint;
  minimumPostCollateralBase: bigint;
  maximumPostCollateralBase: bigint;
  minimumPostHealthFactor: bigint;
  grossNotionalAtoms: bigint;
  gasLimit: bigint;
  nonce: bigint;
  deadline: bigint;
}>): EvmPackageCollateralManagementPlan {
  requireCondition(Number.isSafeInteger(input.chainId) && input.chainId > 0, 'chain id is invalid');
  const owner = getAddress(input.owner);
  const strategyAccount = getAddress(input.strategyAccount);
  const adapterAddress = getAddress(input.adapterAddress);
  const assetToken = getAddress(input.assetToken);
  requireCondition(owner !== zeroAddress && strategyAccount !== zeroAddress && adapterAddress !== zeroAddress
    && assetToken !== zeroAddress, 'collateral management address is zero');
  const packageId = hash32(input.packageId, 'package id');
  const templateManifestHash = hash32(input.templateManifestHash, 'template manifest hash');
  const adapter = Object.freeze({
    subjectId: hash32(input.adapter.subjectId, 'adapter subject'),
    manifestVersion: u32(input.adapter.manifestVersion, 'adapter manifest version'),
    manifestHash: hash32(input.adapter.manifestHash, 'adapter manifest hash'),
  });
  requireCondition(/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(input.templateId), 'template id is invalid');
  const templateVersion = u32(input.templateVersion, 'template version');
  requireCondition(input.inputAtoms > 0n && input.minimumOutputAtoms > 0n
    && input.minimumOutputAtoms <= input.maximumOutputAtoms
    && input.minimumPostCollateralBase <= input.maximumPostCollateralBase
    && input.grossNotionalAtoms > 0n && input.gasLimit > 0n && input.nonce >= 0n && input.deadline > 0n,
  'collateral management bounds are invalid');
  requireCondition(input.currentOwnerAllowanceAtoms >= 0n, 'owner allowance is negative');
  requireCondition(input.action === 'SUPPLY' || input.action === 'WITHDRAW', 'collateral action is invalid');
  const action = input.action === 'SUPPLY' ? 1 : 2;
  const quoteHash = hash32(input.quoteHash, 'quote hash');
  const expectedPreAccountDataHash = hash32(input.expectedPreAccountDataHash, 'pre-account data hash');
  const templateId = keccak256(stringToHex(input.templateId));
  const adapterCommitment = keccak256(encodeAbiParameters(
    parseAbiParameters('bytes32,uint32,bytes32'),
    [adapter.subjectId, adapter.manifestVersion, adapter.manifestHash],
  ));
  const intentHash = keccak256(encodeAbiParameters(INTENT_PARAMETERS, [
    keccak256(stringToHex('NARYX_PACKAGE_COLLATERAL_INTENT_V1')),
    BigInt(input.chainId),
    owner,
    strategyAccount,
    quoteHash,
    packageId,
    adapterCommitment,
    action,
    assetToken,
    input.inputAtoms,
    input.minimumOutputAtoms,
    input.maximumOutputAtoms,
    expectedPreAccountDataHash,
    input.minimumPostCollateralBase,
    input.maximumPostCollateralBase,
    input.minimumPostHealthFactor,
    input.nonce,
    input.deadline,
  ]));
  const payload = encodeAbiParameters(COLLATERAL_PAYLOAD, [{
    packageId,
    intentHash,
    expectedPreAccountDataHash,
    action,
    inputAtoms: input.inputAtoms,
    minimumOutputAtoms: input.minimumOutputAtoms,
    maximumOutputAtoms: input.maximumOutputAtoms,
    minimumPostCollateralBase: input.minimumPostCollateralBase,
    maximumPostCollateralBase: input.maximumPostCollateralBase,
    minimumPostHealthFactor: input.minimumPostHealthFactor,
  }]);
  const supplying = input.action === 'SUPPLY';
  const management = Object.freeze({
    packageId,
    intentHash,
    template: Object.freeze({ templateId, templateVersion, templateManifestHash }),
    settlementClass: Object.freeze({ classId: keccak256(stringToHex('ATOMIC_POSTCONDITION')), classVersion: 1 }),
    adapter,
    target: adapterAddress,
    action,
    assetToken,
    inputAtoms: input.inputAtoms,
    minimumOutputAtoms: input.minimumOutputAtoms,
    maximumOutputAtoms: input.maximumOutputAtoms,
    approvalToken: supplying ? assetToken : zeroAddress,
    approvalAtoms: supplying ? input.inputAtoms : 0n,
    grossNotionalAtoms: input.grossNotionalAtoms,
    gasLimit: input.gasLimit,
    payloadHash: keccak256(payload),
    nonce: input.nonce,
    deadline: input.deadline,
  });
  const transactions: EvmPackageCollateralTransaction[] = [];
  if (supplying && input.currentOwnerAllowanceAtoms !== input.inputAtoms) {
    if (input.currentOwnerAllowanceAtoms !== 0n) {
      transactions.push(Object.freeze({
        kind: 'RESET_COLLATERAL_ALLOWANCE',
        to: assetToken,
        data: encodeFunctionData({ abi: TOKEN_ABI, functionName: 'approve', args: [strategyAccount, 0n] }),
        value: 0n,
      }));
    }
    transactions.push(Object.freeze({
      kind: 'APPROVE_COLLATERAL',
      to: assetToken,
      data: encodeFunctionData({ abi: TOKEN_ABI, functionName: 'approve', args: [strategyAccount, input.inputAtoms] }),
      value: 0n,
    }));
  }
  transactions.push(Object.freeze({
    kind: 'MANAGE_PACKAGE_COLLATERAL',
    to: strategyAccount,
    data: encodeFunctionData({ abi: ACCOUNT_ABI, functionName: 'managePackageCollateral', args: [management, payload] }),
    value: 0n,
  }));
  return Object.freeze({
    version: 1,
    chainId: input.chainId,
    owner,
    strategyAccount,
    quoteHash,
    packageId,
    intentHash,
    action: input.action,
    assetToken,
    inputAtoms: input.inputAtoms,
    minimumOutputAtoms: input.minimumOutputAtoms,
    maximumOutputAtoms: input.maximumOutputAtoms,
    transactions: Object.freeze(transactions),
  });
}
