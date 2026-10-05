import {
  assetAmount,
  strategyEconomicsMetrics,
  strategyPackageQuote,
  strategyPackageQuoteHash,
  type AssetRef,
  type StrategyEconomicsInput,
  type StrategyLegEconomicsInput,
  type StrategyPackageQuote,
  type StrategyPackageQuoteInput,
} from '@naryx/protocol-types';

export interface StrategyQuoteSigner {
  readonly scheme: 'ED25519';
  readonly verificationKey: Uint8Array;
  signDigest(digest: Uint8Array): Uint8Array;
}

export interface StrategyQuoteBuildInput extends Omit<
  StrategyPackageQuoteInput,
  'metrics' | 'totalGrossNotional' | 'totalMarginDelta' | 'totalResidualValue' |
  'netPackageOutcome' | 'solverSignatureScheme' | 'solverVerificationKey' | 'signature'
> {
  readonly economics: StrategyEconomicsInput;
  readonly legEconomics: readonly StrategyLegEconomicsInput[];
  readonly netPackageOutcomeAtoms: bigint;
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sum(values: readonly StrategyLegEconomicsInput[], field: 'grossNotional' | 'marginDelta' | 'residualValue'): bigint {
  return values.reduce((total, value) => total + value[field].atoms, 0n);
}

/** Builds and signs one fee-complete quote for any implemented strategy template. */
export function buildSignedStrategyPackageQuote(input: StrategyQuoteBuildInput, signer: StrategyQuoteSigner): StrategyPackageQuote {
  requireCondition(signer.scheme === 'ED25519', 'the generic strategy quote builder supports Ed25519 signers');
  requireCondition(signer.verificationKey.length === 32, 'the strategy quote verification key must be 32 bytes');
  requireCondition(input.economics.templateId === input.templateId, 'economics template does not match the quote template');
  const quoteAsset: AssetRef = input.quoteAsset;
  const unsigned: StrategyPackageQuoteInput = {
    ...input,
    metrics: strategyEconomicsMetrics(input.economics),
    legEconomics: input.legEconomics,
    netPackageOutcome: assetAmount(quoteAsset, input.netPackageOutcomeAtoms),
    totalGrossNotional: assetAmount(quoteAsset, sum(input.legEconomics, 'grossNotional')),
    totalMarginDelta: assetAmount(quoteAsset, sum(input.legEconomics, 'marginDelta')),
    totalResidualValue: assetAmount(quoteAsset, sum(input.legEconomics, 'residualValue')),
    solverSignatureScheme: signer.scheme,
    solverVerificationKey: Uint8Array.from(signer.verificationKey),
    signature: new Uint8Array(),
  };
  const digest = strategyPackageQuoteHash(unsigned);
  const signature = signer.signDigest(digest);
  requireCondition(signature.length === 64, 'the strategy quote Ed25519 signature must be 64 bytes');
  return strategyPackageQuote({ ...unsigned, signature });
}
