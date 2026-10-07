import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  getAddress,
  http,
  keccak256,
  parseAbi,
  parseAbiParameters,
  type Address,
  type Hex,
  type LocalAccount,
} from 'viem';
import { arbitrumSepolia, baseSepolia } from 'viem/chains';
import type {
  EvmAtomicPackageReceipt,
  EvmAtomicPackageState,
  EvmFirmReservationCrossDomainPort,
  EvmFirmReservationRecord,
  EvmFirmReservationState,
} from './evm-firm-reservation-cross-domain-lane.js';

const RESERVATION_BOOK_ABI = parseAbi([
  'function reservation(bytes32 reservationId) view returns (((bytes32 domainIdHash,uint32 manifestVersion,bytes32 manifestHash) domain,string solverId,address solver,address reclaimOwner,address strategyAccount,uint256 packageNonce,bytes32 orderHash,uint256 reservationNonce,bytes32 quoteHash,bytes32 routeHash,uint256 baseAtoms,uint256 quoteAtoms,uint64 expiry,address consumer,bytes32 consumerCodeHash,uint8 state))',
  'function liveReservation(bytes32 solverStrategyKey) view returns (bytes32)',
]);
const STRATEGY_ACCOUNT_ABI = parseAbi([
  'function nextNonce() view returns (uint256)',
  'function packageState(bytes32 packageId) view returns (((bytes32 templateId,uint32 templateVersion,bytes32 templateManifestHash) template,bytes32 stateHash,bytes32 lastReceiptHash,bool active))',
  'function receipt(bytes32 receiptHash) view returns ((bytes32 packageId,bytes32 orderHash,bytes32 graphHash,bytes32 quoteHash,bytes32 routeHash,uint8 operation,bytes32 previousStateHash,bytes32 nextStateHash,bytes32 callsHash,bytes32 evidenceRoot,(uint32 policyVersion,bytes32 policyManifestHash,address token,uint256 protocolFeeAtoms,uint256 solverFeeAtoms) fees,uint256 nonce,address solver))',
]);
const OCCUPANCY_KEY_PARAMETERS = parseAbiParameters('address solver,address strategyAccount');
const RESERVATION_STATES: readonly EvmFirmReservationState[] = Object.freeze([
  'NONE', 'FUNDED', 'LIVE', 'CONSUMED', 'RELEASED',
]);

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`EVM firm reservation port refused: ${message}`);
}

function record(value: unknown, context: string): Record<string, unknown> {
  requireCondition(typeof value === 'object' && value !== null && !Array.isArray(value), `${context} is invalid`);
  return value as Record<string, unknown>;
}

function bytes32(value: unknown, context: string): Hex {
  requireCondition(typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value), `${context} is not bytes32`);
  return value.toLowerCase() as Hex;
}

function unsigned(value: unknown, context: string): bigint {
  requireCondition(typeof value === 'bigint' && value >= 0n, `${context} is not an unsigned integer`);
  return value;
}

function unsignedNumber(value: unknown, context: string): number {
  requireCondition(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
    `${context} is not an unsigned integer`);
  return value;
}

function reservationRecord(value: unknown): EvmFirmReservationRecord {
  const reservation = record(value, 'reservation');
  const domain = record(reservation.domain, 'reservation domain');
  const stateIndex = unsignedNumber(reservation.state, 'reservation state');
  const state = RESERVATION_STATES[stateIndex];
  requireCondition(state !== undefined, 'reservation state is unknown');
  return Object.freeze({
    domainIdHash: bytes32(domain.domainIdHash, 'reservation domain ID hash'),
    domainManifestVersion: unsignedNumber(domain.manifestVersion, 'reservation domain manifest version'),
    domainManifestHash: bytes32(domain.manifestHash, 'reservation domain manifest hash'),
    solver: getAddress(String(reservation.solver)),
    strategyAccount: getAddress(String(reservation.strategyAccount)),
    packageNonce: unsigned(reservation.packageNonce, 'reservation package nonce'),
    orderHash: bytes32(reservation.orderHash, 'reservation order hash'),
    quoteHash: bytes32(reservation.quoteHash, 'reservation quote hash'),
    routeHash: bytes32(reservation.routeHash, 'reservation route hash'),
    baseAtoms: unsigned(reservation.baseAtoms, 'reservation base atoms'),
    quoteAtoms: unsigned(reservation.quoteAtoms, 'reservation quote atoms'),
    expiry: unsigned(reservation.expiry, 'reservation expiry'),
    state,
  });
}

function packageStateRecord(value: unknown): EvmAtomicPackageState {
  const state = record(value, 'package state');
  requireCondition(typeof state.active === 'boolean', 'package active flag is invalid');
  return Object.freeze({
    stateHash: bytes32(state.stateHash, 'package state hash'),
    lastReceiptHash: bytes32(state.lastReceiptHash, 'package receipt hash'),
    active: state.active,
  });
}

function packageReceiptRecord(value: unknown): EvmAtomicPackageReceipt {
  const receipt = record(value, 'package receipt');
  return Object.freeze({
    packageId: bytes32(receipt.packageId, 'receipt package ID'),
    orderHash: bytes32(receipt.orderHash, 'receipt order hash'),
    quoteHash: bytes32(receipt.quoteHash, 'receipt quote hash'),
    routeHash: bytes32(receipt.routeHash, 'receipt route hash'),
    nextStateHash: bytes32(receipt.nextStateHash, 'receipt next state hash'),
    nonce: unsigned(receipt.nonce, 'receipt nonce'),
    solver: getAddress(String(receipt.solver)),
  });
}

export function createViemEvmFirmReservationCrossDomainPort(input: Readonly<{
  rpcUrl: string;
  chainReference: 84_532n | 421_614n;
  account: LocalAccount;
}>): EvmFirmReservationCrossDomainPort {
  requireCondition(/^https?:\/\//.test(input.rpcUrl), 'RPC URL must be HTTP or HTTPS');
  const chain = input.chainReference === 84_532n ? baseSepolia : arbitrumSepolia;
  const publicClient = createPublicClient({ chain, transport: http(input.rpcUrl) });
  const walletClient = createWalletClient({ account: input.account, chain, transport: http(input.rpcUrl) });
  const finalizedRead = (request: Readonly<{
    address: Address;
    abi: typeof RESERVATION_BOOK_ABI | typeof STRATEGY_ACCOUNT_ABI;
    functionName: string;
    args?: readonly unknown[];
  }>) => publicClient.readContract({
    address: request.address,
    abi: request.abi,
    functionName: request.functionName,
    ...(request.args === undefined ? {} : { args: request.args }),
    blockTag: 'finalized',
  } as never);

  return Object.freeze({
    chainId: async () => BigInt(await publicClient.getChainId()),
    currentTime: async () => (await publicClient.getBlock({ blockTag: 'latest' })).timestamp,
    codeHash: async (address: Address) => {
      const code = await publicClient.getCode({ address, blockTag: 'finalized' });
      return code === undefined || code === '0x' ? null : keccak256(code);
    },
    reservation: async (book: Address, reservationId: Hex) => reservationRecord(await finalizedRead({
      address: getAddress(book),
      abi: RESERVATION_BOOK_ABI,
      functionName: 'reservation',
      args: [reservationId],
    })),
    liveReservationId: async (book: Address, solver: Address, strategyAccount: Address) => bytes32(
      await finalizedRead({
        address: getAddress(book),
        abi: RESERVATION_BOOK_ABI,
        functionName: 'liveReservation',
        args: [keccak256(encodeAbiParameters(OCCUPANCY_KEY_PARAMETERS, [
          getAddress(solver), getAddress(strategyAccount),
        ]))],
      }),
      'live reservation ID',
    ),
    accountNextNonce: async (account: Address) => unsigned(await finalizedRead({
      address: getAddress(account),
      abi: STRATEGY_ACCOUNT_ABI,
      functionName: 'nextNonce',
    }), 'account nonce'),
    packageState: async (account: Address, packageId: Hex) => packageStateRecord(await finalizedRead({
      address: getAddress(account),
      abi: STRATEGY_ACCOUNT_ABI,
      functionName: 'packageState',
      args: [packageId],
    })),
    packageReceipt: async (account: Address, receiptHash: Hex) => packageReceiptRecord(await finalizedRead({
      address: getAddress(account),
      abi: STRATEGY_ACCOUNT_ABI,
      functionName: 'receipt',
      args: [receiptHash],
    })),
    submit: async (request: Parameters<EvmFirmReservationCrossDomainPort['submit']>[0]) => {
      requireCondition(BigInt(await publicClient.getChainId()) === input.chainReference,
        'RPC chain identity differs before write');
      requireCondition(request.gas > 0n && request.maximumFeePerGasWei > 0n,
        'transaction gas bounds are invalid');
      return walletClient.sendTransaction({
        account: input.account,
        chain,
        to: getAddress(request.to),
        data: request.data,
        value: 0n,
        gas: request.gas,
        maxFeePerGas: request.maximumFeePerGasWei,
        maxPriorityFeePerGas: request.maximumFeePerGasWei,
      });
    },
  });
}
