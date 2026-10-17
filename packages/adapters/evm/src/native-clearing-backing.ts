import {
  bytesEqual,
  assetRef,
  domainRef,
  nativeClearingAccount,
  nativeClearingDomainState,
  nativeClearingPolicy,
  protocolId,
  toHex,
  type DomainRef,
  type AssetRef,
  type NativeClearingAccount,
  type NativeClearingDomainState,
  type NativeClearingPolicy,
} from '@naryx/protocol-types';
import { encodeAbiParameters, keccak256, parseAbi, type Address, type Hex } from 'viem';
import { hash32, requiredEvmAddress, structField, type EvmContractRead } from './readPort.js';

const ABI = parseAbi([
  'function policyHash() view returns(bytes32)',
  'function collateralToken() view returns(address)',
  'function markAuthority() view returns(address)',
  'function packageQuantityIncrementAtoms() view returns(uint128)',
  'function priceTickQuoteAtoms() view returns(uint128)',
  'function initialMarginQuoteAtomsPerIncrement() view returns(uint128)',
  'function maintenanceMarginQuoteAtomsPerIncrement() view returns(uint128)',
  'function maximumPositionAtoms() view returns(uint128)',
  'function maximumOpenInterestAtoms() view returns(uint128)',
  'function maximumDefaultTransferDiscountBps() view returns(uint16)',
  'function markMaximumStalenessSeconds() view returns(uint64)',
  'function openInterestAtoms() view returns(uint128)',
  'function recoveryReserveQuoteAtoms() view returns(uint256)',
  'function accruedProtocolFees() view returns(uint256)',
  'function feeBps() view returns(uint16)',
  'function entryPaused() view returns(bool)',
  'function account(bytes32 accountId) view returns((address owner,uint256 collateralQuoteAtoms,int256 cashBalanceQuoteAtoms,int128 positionAtoms,uint64 sequence))',
]);
const TOKEN_ABI = parseAbi(['function decimals() view returns(uint8)', 'function balanceOf(address owner) view returns(uint256)']);

export interface EvmNativeClearingBinding {
  readonly domain: DomainRef;
  readonly clearingHouse: Address;
  readonly clearingHouseCodeHash: Hex;
  readonly collateralToken: Address;
  readonly collateralTokenCodeHash: Hex;
  readonly collateralAsset: AssetRef;
}

export interface EvmNativeClearingBackingReadPort {
  chainId(): Promise<bigint>;
  finalizedBlock(): Promise<{ readonly number: bigint; readonly hash: Hex }>;
  blockHash(blockNumber: bigint): Promise<Hex>;
  code(address: Address, blockNumber: bigint): Promise<Hex>;
  read(read: EvmContractRead, blockNumber: bigint): Promise<unknown>;
}

export function evmNativeClearingAccountId(policyHash: Hex, accountId: string): Hex {
  return keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'string' }], [
    hash32(policyHash, 'native clearing policy hash'), protocolId(accountId, 'native clearing account id'),
  ]));
}

export class EvmNativeClearingBackingVerifier {
  readonly #binding: EvmNativeClearingBinding;
  readonly #reads: EvmNativeClearingBackingReadPort;

  constructor(binding: EvmNativeClearingBinding, reads: EvmNativeClearingBackingReadPort) {
    const domain = domainRef(binding.domain.domainId, binding.domain.domainManifestVersion, binding.domain.domainManifestHash);
    if (domain.domainId !== 'eip155:84532' && domain.domainId !== 'eip155:421614') {
      throw new Error('Native clearing backing is restricted to the supported Sepolia domains.');
    }
    this.#binding = Object.freeze({
      domain,
      clearingHouse: requiredEvmAddress(binding.clearingHouse, 'native clearing house'),
      clearingHouseCodeHash: hash32(binding.clearingHouseCodeHash, 'native clearing house code hash'),
      collateralToken: requiredEvmAddress(binding.collateralToken, 'native clearing collateral token'),
      collateralTokenCodeHash: hash32(binding.collateralTokenCodeHash, 'native clearing token code hash'),
      collateralAsset: assetRef(binding.collateralAsset.assetId, binding.collateralAsset.assetManifestHash, binding.collateralAsset.decimals),
    });
    this.#reads = reads;
  }

  async verify(policyInput: NativeClearingPolicy, stateInput: NativeClearingDomainState, inputs: readonly NativeClearingAccount[], atBlock?: { readonly number: bigint; readonly hash: Hex }) {
    const policy = nativeClearingPolicy(policyInput);
    if (policy.environment !== 'testnet' && policy.environment !== 'devnet') throw new Error('Native clearing backing requires a test environment.');
    const state = nativeClearingDomainState(stateInput, policy);
    if (inputs.length > 100 || new Set(inputs.map((input) => input.accountId)).size !== inputs.length) {
      throw new Error('Native clearing backing requires at most 100 unique accounts.');
    }
    const accounts = inputs.map((input) => nativeClearingAccount(input, policy));
    const binding = this.#binding;
    if (binding.collateralAsset.assetId !== policy.accountingAsset.assetId
      || binding.collateralAsset.decimals !== policy.accountingAsset.decimals
      || !bytesEqual(binding.collateralAsset.assetManifestHash, policy.accountingAsset.assetManifestHash)) {
      throw new Error('Native clearing accounting asset differs from its collateral binding.');
    }
    const chainId = BigInt(binding.domain.domainId.slice('eip155:'.length));
    if (await this.#reads.chainId() !== chainId) throw new Error('Native clearing backing RPC chain differs from its domain.');
    const finalized = await this.#reads.finalizedBlock();
    const block = atBlock ?? finalized;
    if (block.number > finalized.number || (atBlock !== undefined && await this.#reads.blockHash(block.number) !== block.hash)) {
      throw new Error('Native clearing evidence block is not canonical and finalized.');
    }
    if (block.number <= 0n) throw new Error('Native clearing backing requires a finalized block.');
    hash32(block.hash, 'finalized block hash');
    for (const [address, codeHash] of [[binding.clearingHouse, binding.clearingHouseCodeHash], [binding.collateralToken, binding.collateralTokenCodeHash]] as const) {
      const code = await this.#reads.code(address, block.number);
      if (code === '0x' || keccak256(code) !== codeHash) throw new Error('Native clearing backing code identity changed.');
    }
    const read = (functionName: string, args?: readonly unknown[]) => this.#reads.read({ address: binding.clearingHouse, abi: ABI, functionName, ...(args === undefined ? {} : { args }) }, block.number);
    const policyHash = `0x${toHex(policy.policyHash)}` as Hex;
    const expected: readonly (readonly [string, unknown])[] = [
      ['policyHash', policyHash], ['collateralToken', binding.collateralToken],
      ['markAuthority', requiredEvmAddress(policy.markAuthorityId, 'mark authority')],
      ['packageQuantityIncrementAtoms', policy.packageQuantityIncrementAtoms], ['priceTickQuoteAtoms', policy.priceTickQuoteAtoms],
      ['initialMarginQuoteAtomsPerIncrement', policy.initialMarginQuoteAtomsPerIncrement],
      ['maintenanceMarginQuoteAtomsPerIncrement', policy.maintenanceMarginQuoteAtomsPerIncrement],
      ['maximumPositionAtoms', policy.maximumPositionAtoms], ['maximumOpenInterestAtoms', policy.maximumOpenInterestAtoms],
      ['maximumDefaultTransferDiscountBps', Number(policy.maximumDefaultTransferDiscountBps)],
      ['markMaximumStalenessSeconds', policy.markMaximumStalenessMs / 1_000n],
      ['openInterestAtoms', state.openInterestAtoms], ['recoveryReserveQuoteAtoms', state.recoveryReserveQuoteAtoms],
      ['feeBps', 0],
    ];
    if (policy.markMaximumStalenessMs % 1_000n !== 0n) throw new Error('Native clearing mark age is not representable in contract seconds.');
    await Promise.all(expected.map(async ([name, value]) => {
      const observed = await read(name);
      if (typeof value === 'string' && typeof observed === 'string' ? value.toLowerCase() !== observed.toLowerCase() : observed !== value) {
        throw new Error(`Native clearing backing differs at ${name}.`);
      }
    }));
    for (const account of accounts) {
      if (!bytesEqual(account.policyHash, policy.policyHash)) throw new Error('Native clearing account policy differs.');
      const observed = await read('account', [evmNativeClearingAccountId(policyHash, account.accountId)]);
      const owner = requiredEvmAddress(structField(observed, 0, 'owner'), 'onchain clearing owner');
      if (owner !== requiredEvmAddress(account.ownerId, 'clearing ledger owner')) throw new Error('Native clearing account owner differs.');
      for (const [index, name] of ['collateralQuoteAtoms', 'cashBalanceQuoteAtoms', 'positionAtoms', 'sequence'].entries()) {
        if (structField(observed, index + 1, name) !== account[name as keyof NativeClearingAccount]) {
          throw new Error(`Native clearing account differs at ${name}.`);
        }
      }
    }
    const [balance, decimals, fees, entryPaused] = await Promise.all([
      this.#reads.read({ address: binding.collateralToken, abi: TOKEN_ABI, functionName: 'balanceOf', args: [binding.clearingHouse] }, block.number),
      this.#reads.read({ address: binding.collateralToken, abi: TOKEN_ABI, functionName: 'decimals' }, block.number),
      read('accruedProtocolFees'), read('entryPaused'),
    ]);
    if (typeof balance !== 'bigint' || balance < 0n || typeof fees !== 'bigint' || fees < 0n
      || decimals !== policy.accountingAsset.decimals || typeof entryPaused !== 'boolean') throw new Error('Native clearing token backing is invalid.');
    const required = accounts.reduce((sum, account) => sum + account.collateralQuoteAtoms, state.recoveryReserveQuoteAtoms + fees);
    if (balance < required) throw new Error('Native clearing token balance is below the verified collateral and reserves.');
    if (await this.#reads.chainId() !== chainId || await this.#reads.blockHash(block.number) !== block.hash) {
      throw new Error('Native clearing backing chain or finalized block changed during verification.');
    }
    return Object.freeze({
      evidenceGrade: 'FINALIZED_CONTRACT_STATE' as const,
      scope: 'REGISTERED_ACCOUNTS' as const,
      domain: binding.domain,
      clearingHouse: binding.clearingHouse,
      collateralToken: binding.collateralToken,
      blockNumber: block.number,
      blockHash: block.hash,
      tokenBalanceAtoms: balance,
      verifiedCollateralAndReserveAtoms: required,
      verifiedAccountCount: accounts.length,
      entryPaused,
    });
  }
}
