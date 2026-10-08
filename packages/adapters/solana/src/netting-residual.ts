import {
  bytesEqual,
  commitmentHash,
  nettingExternalExecutionEvidence,
  nettingInstrumentHash,
  type AdapterRef,
  type AssetRef,
  type CommitmentHash,
  type DomainRef,
  type NettingExternalExecutionEvidence,
  type NettingExternalExecutionIntent,
  type NettingInstrumentPolicy,
  type VersionedManifestRef,
} from '@naryx/protocol-types';
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js';

const PLACE_BOUNDED_RESIDUAL_DISCRIMINATOR = Buffer.from('4820954c32b25f8e', 'hex');
const NETTING_RESIDUAL_RECEIPT_SEED = Buffer.from('netting-residual-receipt', 'ascii');
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const U64_MAX = (1n << 64n) - 1n;

export interface SolanaTestPerpNettingResidualBinding {
  readonly domain: DomainRef;
  readonly adapter: AdapterRef;
  readonly venue: VersionedManifestRef;
  readonly market: VersionedManifestRef;
  readonly programId: PublicKey | string;
  readonly marketAddress: PublicKey | string;
  readonly positionAddress: PublicKey | string;
  readonly oracleAddress: PublicKey | string;
  readonly collateralVaultAddress: PublicKey | string;
  readonly feeVaultAddress: PublicKey | string;
  readonly insuranceVaultAddress: PublicKey | string;
  readonly executionAccount: PublicKey | string;
  readonly baseLotAtoms: bigint;
  readonly quoteAtomsPerTickPerBaseLot: bigint;
}

export interface SolanaTestPerpNettingResidualPlan {
  readonly version: 1;
  readonly guarantee: 'SINGLE_TRANSACTION_BOUNDED_FILL_WITH_RECEIPT';
  readonly intentHash: CommitmentHash;
  readonly domain: DomainRef;
  readonly instrumentHash: CommitmentHash;
  readonly quantityAsset: AssetRef;
  readonly quoteAsset: AssetRef;
  readonly requestedSignedQuantityAtoms: bigint;
  readonly side: 'BUY' | 'SELL';
  readonly baseLots: bigint;
  readonly limitPriceTicks: bigint;
  readonly reduceOnly: boolean;
  readonly maximumFeeQuoteAtoms: bigint;
  readonly requestExpirySlot: bigint;
  readonly executionAccount: string;
  readonly receiptAddress: string;
  readonly instruction: TransactionInstruction;
}

export interface SolanaTestPerpNettingResidualObservation {
  readonly intentHash: Uint8Array | string;
  readonly authority: PublicKey | string;
  readonly market: PublicKey | string;
  readonly position: PublicKey | string;
  readonly terminalStatus: 'SUCCEEDED' | 'REVERTED';
  readonly side: 'BUY' | 'SELL';
  readonly baseLots: bigint;
  readonly fillPricePerLot: bigint;
  readonly grossQuoteAtoms: bigint;
  readonly feeQuoteAtoms: bigint;
  readonly executionSlot: bigint;
  readonly submittedAtSlot: bigint;
  readonly observedAtSlot: bigint;
  readonly executionReferenceHash: Uint8Array | string;
  readonly authoritativeEvidenceHash: Uint8Array | string;
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function key(value: PublicKey | string, context: string): PublicKey {
  try {
    return value instanceof PublicKey ? value : new PublicKey(value);
  } catch {
    throw new Error(`${context} must be a Solana public key`);
  }
}

function sameDomain(left: DomainRef, right: DomainRef): boolean {
  return left.domainId === right.domainId
    && left.domainManifestVersion === right.domainManifestVersion
    && bytesEqual(left.domainManifestHash, right.domainManifestHash);
}

function sameAdapter(left: AdapterRef, right: AdapterRef): boolean {
  return left.adapterId === right.adapterId
    && left.adapterManifestVersion === right.adapterManifestVersion
    && bytesEqual(left.adapterManifestHash, right.adapterManifestHash);
}

function sameManifest(left: VersionedManifestRef, right: VersionedManifestRef): boolean {
  return left.subjectId === right.subjectId
    && left.manifestVersion === right.manifestVersion
    && bytesEqual(left.manifestHash, right.manifestHash);
}

function sameAsset(left: AssetRef, right: AssetRef): boolean {
  return left.assetId === right.assetId
    && left.decimals === right.decimals
    && bytesEqual(left.assetManifestHash, right.assetManifestHash);
}

function u64(value: bigint, context: string): Buffer {
  requireCondition(value >= 0n && value <= U64_MAX, `${context} must fit u64`);
  const result = Buffer.allocUnsafe(8);
  result.writeBigUInt64LE(value);
  return result;
}

function boundedInstructionData(input: Readonly<{
  intentHash: Uint8Array;
  side: 'BUY' | 'SELL';
  baseLots: bigint;
  limitPriceTicks: bigint;
  lastValidSlot: bigint;
  reduceOnly: boolean;
  maximumFeeAtoms: bigint;
}>): Buffer {
  requireCondition(input.intentHash.length === 32 && input.intentHash.some((byte) => byte !== 0),
    'residual intent hash must be nonzero');
  return Buffer.concat([
    PLACE_BOUNDED_RESIDUAL_DISCRIMINATOR,
    Buffer.from(input.intentHash),
    Buffer.from([input.side === 'BUY' ? 0 : 1]),
    u64(input.baseLots, 'residual base lots'),
    u64(input.limitPriceTicks, 'residual limit price ticks'),
    u64(input.lastValidSlot, 'residual expiry slot'),
    Buffer.from([input.reduceOnly ? 1 : 0]),
    u64(input.maximumFeeAtoms, 'residual maximum fee'),
  ]);
}

export function deriveSolanaNettingResidualReceipt(input: Readonly<{
  programId: PublicKey | string;
  positionAddress: PublicKey | string;
  intentHash: Uint8Array;
}>): PublicKey {
  requireCondition(input.intentHash.length === 32 && input.intentHash.some((byte) => byte !== 0),
    'residual intent hash must be nonzero');
  return PublicKey.findProgramAddressSync([
    NETTING_RESIDUAL_RECEIPT_SEED,
    key(input.positionAddress, 'residual position').toBuffer(),
    Buffer.from(input.intentHash),
  ], key(input.programId, 'test perp program'))[0];
}

export function compileSolanaTestPerpNettingResidualPlan(input: Readonly<{
  intent: NettingExternalExecutionIntent;
  instrument: NettingInstrumentPolicy;
  binding: SolanaTestPerpNettingResidualBinding;
}>): SolanaTestPerpNettingResidualPlan {
  const { intent, instrument, binding } = input;
  requireCondition(intent.domain.domainId === 'svm:devnet' && sameDomain(binding.domain, intent.domain),
    'only the bound Solana Devnet domain can execute this residual');
  requireCondition(intent.validUntilUnit === 'SOLANA_SLOT',
    'Solana residual intent requires a slot expiry');
  requireCondition(bytesEqual(nettingInstrumentHash(instrument), intent.instrumentHash)
    && instrument.instrumentId === intent.instrumentId,
  'residual intent and instrument policy differ');
  requireCondition(sameAdapter(binding.adapter, intent.adapter)
    && sameAdapter(instrument.adapter, intent.adapter)
    && sameManifest(binding.venue, intent.venue)
    && sameManifest(instrument.venue, intent.venue)
    && sameManifest(binding.market, intent.market)
    && sameManifest(instrument.market, intent.market),
  'residual market binding differs from the signed instrument');
  requireCondition(sameAsset(instrument.quantityAsset, intent.quantityAsset)
    && sameAsset(instrument.quoteAsset, intent.quoteAsset)
    && instrument.quantityIncrementAtoms === intent.quantityIncrementAtoms
    && instrument.priceTickQuoteAtoms === intent.priceTickQuoteAtoms,
  'residual asset or lattice binding differs from the signed instrument');
  requireCondition(instrument.legFamily === 'PERP_OPEN'
    || instrument.legFamily === 'PERP_CLOSE'
    || instrument.legFamily === 'PERP_INCREASE'
    || instrument.legFamily === 'PERP_DECREASE',
  `Solana test perp cannot execute residual ${instrument.legFamily}`);
  requireCondition(binding.baseLotAtoms === intent.quantityIncrementAtoms
    && binding.quoteAtomsPerTickPerBaseLot === intent.priceTickQuoteAtoms,
  'test perp lot or tick lattice differs from the signed instrument');
  requireCondition(intent.quantityAtoms % binding.baseLotAtoms === 0n,
    'Solana residual quantity is off its signed increment lattice');
  const baseLots = intent.quantityAtoms / binding.baseLotAtoms;
  requireCondition(baseLots > 0n && baseLots <= BigInt(Number.MAX_SAFE_INTEGER),
    'Solana residual base lots exceed the venue bound');
  u64(intent.limitPriceTicks, 'residual limit price ticks');
  u64(intent.maximumFeeQuoteAtoms, 'residual maximum fee');
  u64(intent.validUntilValue, 'residual expiry slot');
  const programId = key(binding.programId, 'test perp program');
  const executionAccount = key(binding.executionAccount, 'residual execution account');
  const positionAddress = key(binding.positionAddress, 'residual position');
  const receipt = deriveSolanaNettingResidualReceipt({
    programId,
    positionAddress,
    intentHash: intent.intentHash,
  });
  const reduceOnly = instrument.legFamily === 'PERP_CLOSE'
    || instrument.legFamily === 'PERP_DECREASE';
  const instruction = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: executionAccount, isSigner: true, isWritable: true },
      { pubkey: key(binding.marketAddress, 'test perp market'), isSigner: false, isWritable: true },
      { pubkey: positionAddress, isSigner: false, isWritable: true },
      { pubkey: key(binding.oracleAddress, 'test perp oracle'), isSigner: false, isWritable: false },
      { pubkey: key(binding.collateralVaultAddress, 'test perp collateral vault'), isSigner: false, isWritable: true },
      { pubkey: key(binding.feeVaultAddress, 'test perp fee vault'), isSigner: false, isWritable: true },
      { pubkey: key(binding.insuranceVaultAddress, 'test perp insurance vault'), isSigner: false, isWritable: true },
      { pubkey: receipt, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: boundedInstructionData({
      intentHash: intent.intentHash,
      side: intent.side,
      baseLots,
      limitPriceTicks: intent.limitPriceTicks,
      lastValidSlot: intent.validUntilValue,
      reduceOnly,
      maximumFeeAtoms: intent.maximumFeeQuoteAtoms,
    }),
  });
  return Object.freeze({
    version: 1,
    guarantee: 'SINGLE_TRANSACTION_BOUNDED_FILL_WITH_RECEIPT',
    intentHash: intent.intentHash,
    domain: intent.domain,
    instrumentHash: intent.instrumentHash,
    quantityAsset: intent.quantityAsset,
    quoteAsset: intent.quoteAsset,
    requestedSignedQuantityAtoms: intent.side === 'BUY' ? intent.quantityAtoms : -intent.quantityAtoms,
    side: intent.side,
    baseLots,
    limitPriceTicks: intent.limitPriceTicks,
    reduceOnly,
    maximumFeeQuoteAtoms: intent.maximumFeeQuoteAtoms,
    requestExpirySlot: intent.validUntilValue,
    executionAccount: executionAccount.toBase58(),
    receiptAddress: receipt.toBase58(),
    instruction,
  });
}

export function solanaTestPerpNettingResidualEvidence(input: Readonly<{
  intent: NettingExternalExecutionIntent;
  plan: SolanaTestPerpNettingResidualPlan;
  observation: SolanaTestPerpNettingResidualObservation;
}>): NettingExternalExecutionEvidence {
  const { intent, plan, observation } = input;
  requireCondition(plan.version === 1
    && plan.guarantee === 'SINGLE_TRANSACTION_BOUNDED_FILL_WITH_RECEIPT'
    && plan.domain.domainId === 'svm:devnet'
    && bytesEqual(plan.intentHash, intent.intentHash)
    && plan.requestedSignedQuantityAtoms === (intent.side === 'BUY' ? intent.quantityAtoms : -intent.quantityAtoms)
    && plan.maximumFeeQuoteAtoms === intent.maximumFeeQuoteAtoms
    && plan.requestExpirySlot === intent.validUntilValue,
  'Solana residual execution plan differs from the intent');
  requireCondition(bytesEqual(commitmentHash(observation.intentHash, 'observed residual intent'), plan.intentHash),
    'Solana residual observation cites another execution');
  requireCondition(key(observation.authority, 'observed residual authority').toBase58() === plan.executionAccount,
    'Solana residual observation cites another execution account');
  const succeeded = observation.terminalStatus === 'SUCCEEDED';
  if (succeeded) {
    requireCondition(observation.side === plan.side
      && observation.baseLots === plan.baseLots
      && observation.grossQuoteAtoms === observation.fillPricePerLot * observation.baseLots
      && observation.feeQuoteAtoms <= plan.maximumFeeQuoteAtoms,
    'Solana residual receipt violates the bounded trade');
  } else {
    requireCondition(observation.baseLots === 0n
      && observation.fillPricePerLot === 0n
      && observation.grossQuoteAtoms === 0n
      && observation.feeQuoteAtoms === 0n,
    'reverted Solana residual cannot carry fill amounts');
  }
  return nettingExternalExecutionEvidence({
    version: 1,
    intentHash: intent.intentHash,
    outcome: succeeded ? 'EXACT_FILLED' : 'REJECTED',
    filledSignedQuantityAtoms: succeeded ? plan.requestedSignedQuantityAtoms : 0n,
    grossQuoteAtoms: succeeded ? observation.grossQuoteAtoms : 0n,
    feeQuoteAtoms: succeeded ? observation.feeQuoteAtoms : 0n,
    submittedAtUnit: 'SOLANA_SLOT',
    submittedAtValue: observation.submittedAtSlot,
    observedAtUnit: 'SOLANA_SLOT',
    observedAtValue: observation.observedAtSlot,
    executionReferenceHash: observation.executionReferenceHash,
    authoritativeEvidenceHash: observation.authoritativeEvidenceHash,
  }, intent);
}
