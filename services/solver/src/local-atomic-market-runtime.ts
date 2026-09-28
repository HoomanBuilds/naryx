import type { LocalAtomicMarketCatalog } from '@naryx/adapter-core';
import { payloadTemplateHash, type ActionCommitmentInput, type RouteAccountBindingInput } from '@naryx/protocol-types';
import {
  InMemoryAtomicQuoteNonceSource,
  createConfiguredAtomicMarketProviders,
  type AtomicQuoteNonceSource,
  type ConfiguredAtomicMarketProviders,
} from './configured-atomic-market.js';

export interface LocalAtomicMarketRuntime {
  readonly catalog: LocalAtomicMarketCatalog;
  readonly providers: ConfiguredAtomicMarketProviders;
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a;
}

function bindings(catalog: LocalAtomicMarketCatalog): readonly RouteAccountBindingInput[] {
  const venue = catalog.programs.conformanceVenue;
  const core = catalog.programs.core;
  return Object.freeze([
    { routeBindingId: 'trader', accountIdentity: core, authorityIdentity: core },
    { routeBindingId: 'market', adapter: catalog.adapter, adapterBindingId: 'market', accountIdentity: venue },
    { routeBindingId: 'position', adapter: catalog.adapter, adapterBindingId: 'position', accountIdentity: core },
    { routeBindingId: 'trader-base', adapter: catalog.adapter, adapterBindingId: 'trader-base', accountIdentity: core },
    { routeBindingId: 'trader-quote', adapter: catalog.adapter, adapterBindingId: 'trader-quote', accountIdentity: core },
    { routeBindingId: 'spot-base-vault', adapter: catalog.adapter, adapterBindingId: 'spot-base-vault', accountIdentity: venue },
    { routeBindingId: 'spot-quote-vault', adapter: catalog.adapter, adapterBindingId: 'spot-quote-vault', accountIdentity: venue },
    { routeBindingId: 'perp-quote-vault', adapter: catalog.adapter, adapterBindingId: 'perp-quote-vault', accountIdentity: venue },
    { routeBindingId: 'conformance-program', adapter: catalog.adapter, adapterBindingId: 'program', accountIdentity: venue, codeIdentity: venue },
  ]);
}

function actions(catalog: LocalAtomicMarketCatalog): readonly ActionCommitmentInput[] {
  const accountMetas = [
    { routeBindingId: 'trader', isSigner: true, isWritable: true },
    { routeBindingId: 'market', isSigner: false, isWritable: true },
    { routeBindingId: 'position', isSigner: false, isWritable: true },
    { routeBindingId: 'trader-base', isSigner: false, isWritable: true },
    { routeBindingId: 'trader-quote', isSigner: false, isWritable: true },
    { routeBindingId: 'spot-base-vault', isSigner: false, isWritable: true },
    { routeBindingId: 'spot-quote-vault', isSigner: false, isWritable: true },
    { routeBindingId: 'perp-quote-vault', isSigner: false, isWritable: true },
    { routeBindingId: 'conformance-program', isSigner: false, isWritable: false },
  ] as const;
  const payload = {
    codecId: 'solana-conformance-cpi-v1',
    templateLength: 0,
    templateHash: payloadTemplateHash(new Uint8Array(), []),
    lateBoundFields: [],
  } as const;
  return Object.freeze([
    {
      sequence: 0,
      actionClassId: 'conformance-spot-buy-exact-output',
      legIndex: 0,
      adapter: catalog.adapter,
      targetBindingId: 'conformance-program',
      authorityBindingId: 'trader',
      accountMetas,
      payload,
    },
    {
      sequence: 1,
      actionClassId: 'conformance-perpetual-open-short',
      legIndex: 1,
      adapter: catalog.adapter,
      targetBindingId: 'conformance-program',
      authorityBindingId: 'trader',
      accountMetas,
      payload,
    },
  ]);
}

export function localConformanceSlot(nowMs = Date.now()): bigint {
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) throw new Error('local clock is invalid');
  return BigInt(Math.floor(nowMs / 400));
}

export function createLocalAtomicMarketRuntime(
  catalog: LocalAtomicMarketCatalog,
  nonceSource: AtomicQuoteNonceSource = new InMemoryAtomicQuoteNonceSource(),
  currentClock: () => bigint = () => localConformanceSlot(),
): LocalAtomicMarketRuntime {
  const spreadQuoteAtoms = catalog.pricing.perpetual.quoteAtoms * catalog.pricing.spot.baseAtoms
    - catalog.pricing.spot.quoteAtoms * catalog.pricing.perpetual.baseAtoms;
  const spreadBaseAtoms = catalog.pricing.perpetual.baseAtoms * catalog.pricing.spot.baseAtoms;
  const spreadDivisor = gcd(spreadQuoteAtoms, spreadBaseAtoms);
  const providers = createConfiguredAtomicMarketProviders({
    candidateId: catalog.solver.candidateId,
    active: true,
    capacityBaseAtoms: catalog.solver.capacityBaseAtoms,
    evidenceGrade: 'LOCAL_CONFORMANCE',
    solverId: catalog.solver.solverId,
    solverCapabilityManifestHash: catalog.solver.capabilityManifestHash,
    templateRegistryRecordHash: catalog.template.templateRegistryRecordHash,
    feePolicyVersion: catalog.feePolicy.version,
    feePolicyManifestHash: catalog.feePolicy.manifestHash,
    routeTtl: catalog.solver.routeTtlSlots,
    quoteTtl: catalog.solver.quoteTtlSlots,
    currentClock,
    nonceSource,
    spot: {
      adapter: catalog.adapter,
      venue: catalog.spotVenue,
      market: catalog.spotMarket,
      limitPrice: catalog.pricing.spot,
      actionSequence: 0,
    },
    perpetual: {
      adapter: catalog.adapter,
      venue: catalog.perpetualVenue,
      market: catalog.perpetualMarket,
      limitPrice: catalog.pricing.perpetual,
      actionSequence: 1,
    },
    entrySpread: {
      baseAsset: catalog.baseAsset,
      quoteAsset: catalog.quoteAsset,
      quoteAtoms: spreadQuoteAtoms / spreadDivisor,
      baseAtoms: spreadBaseAtoms / spreadDivisor,
      roundingDirection: 'CEIL',
    },
    marginBps: catalog.solver.marginBps,
    fees: {
      baseAssetFeeBps: 0,
      venueFeeBps: 0,
      builderFeeBps: 0,
      protocolFeeBps: 0,
      solverFeeBps: 0,
      priorityFeeQuoteAtoms: 0n,
      builderRecipient: 'local-builder-treasury',
      protocolRecipient: 'local-protocol-treasury',
      solverRecipient: 'local-solver-treasury',
      collectionAuthority: catalog.programs.core,
      collectionModeId: 'local-conformance-no-fees',
    },
    accountBindings: bindings(catalog),
    ownerAccountBindingIds: ['trader'],
    settlementAccountBindingIds: [],
    actions: actions(catalog),
    preconditions: [],
    postconditions: [],
    evidenceRequirements: {
      schemaVersion: 1,
      profileId: 'solana-local-conformance-v1',
      requiredPreStateComponentIds: ['venue-market', 'venue-position'],
      requiredPostStateComponentIds: ['execution-receipt', 'venue-position'],
      requiredActionEvidenceTypeIds: ['solana-transaction'],
      stateReferenceSchemaHash: catalog.domain.domainManifestHash,
      receiptSchemaHash: catalog.template.packageTemplateManifestHash,
      outcomeSchemaHash: catalog.feePolicy.manifestHash,
    },
  });
  return Object.freeze({ catalog, providers });
}
