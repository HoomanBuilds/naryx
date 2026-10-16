import { parseAbi } from 'viem';

export const NARYX_MULTI_STRATEGY_ACCOUNT_STATE_ABI = parseAbi([
  'function packageState(bytes32 packageId) view returns (((bytes32 templateId,uint32 templateVersion,bytes32 templateManifestHash) template,bytes32 riskDomainId,uint32 riskPolicyVersion,bytes32 riskPolicyManifestHash,(bytes32 seriesId,uint32 manifestVersion,bytes32 manifestHash) series,bytes32 stateHash,bytes32 lastReceiptHash,bool active))',
  'function receipt(bytes32 receiptHash) view returns ((bytes32 packageId,bytes32 orderHash,bytes32 graphHash,bytes32 quoteHash,bytes32 routeHash,uint8 operation,bytes32 previousStateHash,bytes32 nextStateHash,bytes32 callsHash,bytes32 evidenceRoot,bytes32 riskDomainId,uint32 riskPolicyVersion,bytes32 riskPolicyManifestHash,(uint32 policyVersion,bytes32 policyManifestHash,address token,uint256 protocolFeeAtoms,uint256 solverFeeAtoms) fees,uint256 nonce,address solver))',
]);
