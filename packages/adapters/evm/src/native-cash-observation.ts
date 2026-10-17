import { bytesEqual, toHex } from '@naryx/protocol-types';
import { decodeEventLog, decodeFunctionData, hashTypedData, keccak256, parseAbi, toEventSelector, type Hex } from 'viem';
import { NATIVE_CASH_HOUSE_ABI, type EvmNativeCashRangeBinding, type EvmNativeCashRangeQuote } from './native-cash-range.js';
import type { EvmNativeClearingTransitionReadPort } from './native-clearing-transition.js';
import { structField } from './readPort.js';
import { evmNativeClearingAccountId } from './native-clearing-backing.js';

const EVENTS = parseAbi([
  'event PackageMatched(bytes32 indexed authorizationHash,bytes32 indexed longAccountId,bytes32 indexed shortAccountId,uint128 quantityAtoms,uint128 priceTicks,uint256 feeAtoms)',
]);

export async function observeNativeCashMatch(binding: EvmNativeCashRangeBinding,
  reads: EvmNativeClearingTransitionReadPort, quote: EvmNativeCashRangeQuote, transactionHash: Hex) {
  if (binding.kind !== 'EVM_NATIVE_CASH_RANGE_V1' || binding.policy.environment !== 'testnet'
    || !['eip155:84532', 'eip155:421614'].includes(binding.domain.domainId)
    || quote.kind !== binding.kind || quote.marketId !== binding.marketId || quote.environment !== 'testnet'
    || quote.makerOwner !== binding.makerOwner || !['BUY', 'SELL'].includes(quote.side)
    || quote.makerAuthorization?.kind !== binding.makerAuthorization?.kind
    || quote.makerAuthorization?.codeHash !== binding.makerAuthorization?.codeHash
    || quote.maximumPriceTicks !== binding.maximumPriceTicks || quote.priceTicks !== quote.match.priceTicks
    || quote.match.priceTicks < 1n || quote.match.priceTicks > binding.maximumPriceTicks
    || (quote.side === 'BUY' ? quote.match.shortAccountId : quote.match.longAccountId)
      !== evmNativeClearingAccountId(`0x${toHex(binding.policy.policyHash)}`, binding.makerAccountId)
    || quote.clearingHouse !== binding.clearingHouse || quote.chainId !== Number(binding.domain.domainId.slice(7))
    || quote.domain.domainId !== binding.domain.domainId || quote.domain.domainManifestVersion !== binding.domain.domainManifestVersion
    || !bytesEqual(quote.domain.domainManifestHash, binding.domain.domainManifestHash)
    || quote.typedData.domain.verifyingContract !== binding.clearingHouse
    || quote.typedData.domain.chainId !== quote.chainId
    || quote.typedData.message.policyHash !== `0x${toHex(binding.policy.policyHash)}`
    || hashTypedData(quote.typedData) !== quote.digest
    || Object.entries(quote.match).some(([key, value]) => quote.typedData.message[key as keyof typeof quote.typedData.message] !== value)
    || !/^0x[0-9a-f]{64}$/i.test(transactionHash) || reads.transaction === undefined
    || await reads.chainId() !== BigInt(quote.chainId)) throw new Error('Native cash settlement binding differs.');
  const receipt = await reads.receipt(transactionHash);
  const finalized = await reads.finalizedBlock();
  if (receipt.status !== 'success' || receipt.transactionHash.toLowerCase() !== transactionHash.toLowerCase()
    || receipt.blockNumber < quote.observedBlock.number || receipt.blockNumber > finalized.number
    || /^0x0{64}$/.test(receipt.blockHash) || await reads.blockHash(receipt.blockNumber) !== receipt.blockHash) {
    throw new Error('Native cash settlement is not successful, canonical and finalized.');
  }
  for (const [address, hash] of [[binding.controller, binding.controllerCodeHash],
    [binding.clearingHouse, binding.clearingHouseCodeHash], [binding.collateralToken, binding.collateralTokenCodeHash],
    ...(binding.makerAuthorization === undefined ? [] : [[binding.makerOwner, binding.makerAuthorization.codeHash] as const])] as const) {
    if (keccak256(await reads.code(address, receipt.blockNumber)) !== hash) throw new Error('Native cash settlement code differs.');
  }
  const transaction = await reads.transaction(transactionHash);
  if (transaction.hash.toLowerCase() !== transactionHash.toLowerCase()
    || transaction.to?.toLowerCase() !== binding.clearingHouse.toLowerCase() || transaction.value !== 0n
    || transaction.blockNumber !== receipt.blockNumber || transaction.blockHash !== receipt.blockHash) {
    throw new Error('Native cash settlement transaction differs.');
  }
  const decoded = decodeFunctionData({ abi: NATIVE_CASH_HOUSE_ABI, data: transaction.input });
  if (decoded.functionName !== 'executeMatch') throw new Error('Native cash settlement is not a match call.');
  const match = decoded.args[0];
  if (Object.entries(quote.match).some(([key, value]) => match[key as keyof typeof match] !== value)
    || await reads.timestamp(receipt.blockNumber) >= quote.match.expiry) throw new Error('Native cash settlement terms differ.');
  const [long, short, digest] = await Promise.all([
    reads.read({ address: binding.clearingHouse, abi: NATIVE_CASH_HOUSE_ABI, functionName: 'account', args: [match.longAccountId] }, receipt.blockNumber),
    reads.read({ address: binding.clearingHouse, abi: NATIVE_CASH_HOUSE_ABI, functionName: 'account', args: [match.shortAccountId] }, receipt.blockNumber),
    reads.read({ address: binding.clearingHouse, abi: NATIVE_CASH_HOUSE_ABI, functionName: 'matchDigest', args: [match] }, receipt.blockNumber),
  ]);
  if (String(structField(long, 0, 'owner')).toLowerCase() !== (quote.side === 'BUY' ? quote.owner : quote.makerOwner).toLowerCase()
    || String(structField(short, 0, 'owner')).toLowerCase() !== (quote.side === 'BUY' ? quote.makerOwner : quote.owner).toLowerCase()
    || digest !== quote.digest) throw new Error('Native cash settlement owners or digest differ.');
  const logs = receipt.logs.filter(log => log.address.toLowerCase() === binding.clearingHouse.toLowerCase()
    && log.topics[0] === toEventSelector('PackageMatched(bytes32,bytes32,bytes32,uint128,uint128,uint256)'));
  if (logs.length !== 1 || logs[0]!.removed || logs[0]!.logIndex === null) throw new Error('Native cash settlement has ambiguous match evidence.');
  const event = decodeEventLog({ abi: EVENTS, data: logs[0]!.data, topics: logs[0]!.topics, strict: true });
  if (event.args.authorizationHash !== match.authorizationHash || event.args.longAccountId !== match.longAccountId
    || event.args.shortAccountId !== match.shortAccountId || event.args.priceTicks !== match.priceTicks
    || event.args.quantityAtoms !== match.quantityAtoms || event.args.feeAtoms !== 0n
    || await reads.read({ address: binding.clearingHouse, abi: NATIVE_CASH_HOUSE_ABI,
      functionName: 'consumedAuthorization', args: [match.authorizationHash] }, receipt.blockNumber) !== true) {
    throw new Error('Native cash settlement event or authorization differs.');
  }
  if (await reads.chainId() !== BigInt(quote.chainId) || await reads.blockHash(receipt.blockNumber) !== receipt.blockHash) {
    throw new Error('Native cash settlement chain changed during verification.');
  }
  return Object.freeze({ version: 1, kind: 'NATIVE_CASH_RANGE_MATCH' as const, environment: 'testnet' as const,
    evidenceGrade: 'FINALIZED_CONTRACT_RECEIPT' as const, marketId: binding.marketId, domain: binding.domain,
    clearingHouse: binding.clearingHouse, owner: quote.owner, makerOwner: quote.makerOwner, quoteDigest: quote.digest,
    authorizationHash: match.authorizationHash, transactionHash, blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash, logIndex: logs[0]!.logIndex, side: quote.side,
    quantityAtoms: match.quantityAtoms, priceTicks: match.priceTicks, feeAtoms: event.args.feeAtoms });
}
