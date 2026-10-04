import { mulDiv } from './arithmetic.js';
import { bytesEqual } from './bytes.js';
import type { PackageAction, RegistryState } from './enums.js';
import { MalformedInputError } from './errors.js';
import {
  type FeePolicyManifest,
  type FeePolicyManifestInput,
  feePolicyManifest,
  feePolicyManifestHash,
} from './fee-policy-manifest.js';
import {
  type DomainManifest,
  type DomainManifestInput,
  domainManifest,
  domainRefFromManifest,
} from './domain-manifest.js';
import {
  type DomainRegistryRecord,
  type DomainRegistryRecordInput,
  domainRegistryRecord,
} from './domain-registry-record.js';
import {
  type PackageOrder,
  type PackageOrderInput,
  packageOrderHash,
} from './package-order.js';
import { validatePackageOrderProfile } from './package-order-profile.js';
import type { AdapterRef, CommitmentHash, FeeCap } from './package-order-primitives.js';
import {
  type PackageTemplateManifest,
  type PackageTemplateManifestInput,
  packageTemplateManifest,
  packageTemplateManifestHash,
} from './package-template-manifest.js';
import {
  type PackageTemplateRegistryRecord,
  type PackageTemplateRegistryRecordInput,
  packageTemplateRegistryRecord,
  packageTemplateRegistryRecordHash,
} from './package-template-registry-record.js';
import {
  assetRef,
  expiry,
  protocolId,
  type AssetAmount,
  type AssetRef,
  type DomainRef,
  type Expiry,
  type Hash32,
  type ManifestHash,
  type ProtocolId,
  type VersionedManifestRef,
} from './primitives.js';
import {
  type RoutePayload,
  type RoutePayloadInput,
  routeHash,
  routePayload,
} from './route-payload.js';
import {
  type SolverQuote,
  type SolverQuoteInput,
  quoteHash,
  solverQuote,
} from './solver-quote.js';

export interface PackageAdmissionInput {
  readonly order: PackageOrderInput;
  readonly quote: SolverQuoteInput;
  readonly route: RoutePayloadInput;
  readonly currentTime: Expiry;
  readonly accountModeClass?: string;
  readonly domainManifest: DomainManifestInput;
  readonly templateManifest: PackageTemplateManifestInput;
  readonly templateRegistryRecord: PackageTemplateRegistryRecordInput;
  readonly feePolicyManifest: FeePolicyManifestInput;
  readonly activeRegistryRecords: readonly DomainRegistryRecordInput[];
}

export interface PackageAdmission {
  readonly order: PackageOrder;
  readonly quote: SolverQuote;
  readonly route: RoutePayload;
  readonly orderHash: Hash32;
  readonly routeHash: CommitmentHash;
  readonly quoteHash: Hash32;
}

function requireCondition(
  condition: boolean,
  context: string,
  message: string,
): asserts condition {
  if (!condition) throw new MalformedInputError(context, message);
}

function sameHash(left: Uint8Array, right: Uint8Array): boolean {
  return bytesEqual(left, right);
}

function sameDomain(left: DomainRef, right: DomainRef): boolean {
  return left.domainId === right.domainId
    && left.domainManifestVersion === right.domainManifestVersion
    && sameHash(left.domainManifestHash, right.domainManifestHash);
}

function sameAsset(left: AssetRef, right: AssetRef): boolean {
  return left.assetId === right.assetId
    && left.decimals === right.decimals
    && sameHash(left.assetManifestHash, right.assetManifestHash);
}

function sameAdapter(left: AdapterRef, right: AdapterRef): boolean {
  return left.adapterId === right.adapterId
    && left.adapterManifestVersion === right.adapterManifestVersion
    && sameHash(left.adapterManifestHash, right.adapterManifestHash);
}

function requireHash(
  actual: Uint8Array,
  expected: Uint8Array,
  context: string,
): void {
  requireCondition(sameHash(actual, expected), context, 'hash mismatch');
}

function requireDomain(
  actual: DomainRef,
  expected: DomainRef,
  context: string,
): void {
  requireCondition(sameDomain(actual, expected), context, 'domain mismatch');
}

function requireAsset(
  actual: AssetRef,
  expected: AssetRef,
  context: string,
): void {
  requireCondition(sameAsset(actual, expected), context, 'asset mismatch');
}

function requireAmountAtMost(
  actual: AssetAmount,
  maximum: AssetAmount,
  context: string,
): void {
  requireAsset(actual.asset, maximum.asset, `${context}.asset`);
  requireCondition(actual.atoms <= maximum.atoms, `${context}.atoms`, 'amount exceeds cap');
}

function requireExactAmount(
  actual: AssetAmount,
  expected: AssetAmount,
  context: string,
): void {
  requireAsset(actual.asset, expected.asset, `${context}.asset`);
  requireCondition(actual.atoms === expected.atoms, `${context}.atoms`, 'amount mismatch');
}

function requireEnvironment(
  actual: ProtocolId,
  expected: ProtocolId,
  context: string,
): void {
  requireCondition(actual === expected, context, 'environment mismatch');
}

function statePermitsAction(state: RegistryState, action: PackageAction): boolean {
  if (state === 'ACTIVE') return true;
  return action === 'EXIT' && (state === 'ENTRY_PAUSED' || state === 'EXIT_ONLY');
}

function validateCurrentTime(input: PackageAdmissionInput): Expiry {
  return expiry(input.currentTime.unit, input.currentTime.value, 'packageAdmission.currentTime');
}

function validateDomainManifest(
  input: PackageAdmissionInput,
  order: PackageOrder,
  quote: SolverQuote,
  route: RoutePayload,
): DomainManifest {
  const manifest = domainManifest(input.domainManifest, 'packageAdmission.domainManifest');
  const activeDomain = domainRefFromManifest(manifest);
  requireEnvironment(manifest.environment, order.environment, 'packageAdmission.domainManifest.environment');
  requireDomain(order.domain, activeDomain, 'packageAdmission.order.domain');
  requireDomain(quote.domain, activeDomain, 'packageAdmission.quote.domain');
  requireDomain(route.domain, activeDomain, 'packageAdmission.route.domain');
  requireCondition(
    manifest.supportedSettlementClasses.includes(order.settlementClass),
    'packageAdmission.domainManifest.supportedSettlementClasses',
    'settlement class is not supported by the active domain',
  );
  return manifest;
}

function validateObjectBindings(
  order: PackageOrder,
  quote: SolverQuote,
  route: RoutePayload,
  expectedOrderHash: Hash32,
  expectedRouteHash: CommitmentHash,
): void {
  requireEnvironment(quote.environment, order.environment, 'packageAdmission.quote.environment');
  requireEnvironment(route.environment, order.environment, 'packageAdmission.route.environment');
  requireHash(quote.orderHash, expectedOrderHash, 'packageAdmission.quote.orderHash');
  requireHash(route.orderHash, expectedOrderHash, 'packageAdmission.route.orderHash');
  requireHash(quote.routeHash, expectedRouteHash, 'packageAdmission.quote.routeHash');
  requireCondition(route.templateId === order.templateId, 'packageAdmission.route.templateId', 'template mismatch');
  requireCondition(route.templateVersion === order.templateVersion, 'packageAdmission.route.templateVersion', 'template version mismatch');
  requireHash(route.packageTemplateManifestHash, order.packageTemplateManifestHash, 'packageAdmission.route.packageTemplateManifestHash');
  requireCondition(route.owner === order.owner, 'packageAdmission.route.owner', 'owner mismatch');
  requireCondition(route.settlementAccount === order.settlementAccount, 'packageAdmission.route.settlementAccount', 'settlement account mismatch');
  requireCondition(route.solver === quote.solverId, 'packageAdmission.route.solver', 'solver mismatch');
  requireCondition(route.direction === order.direction, 'packageAdmission.route.direction', 'direction mismatch');
  requireCondition(route.action === order.action, 'packageAdmission.route.action', 'action mismatch');
  requireCondition(route.partialFillPolicy === order.partialFillPolicy, 'packageAdmission.route.partialFillPolicy', 'partial-fill policy mismatch');
  requireCondition(route.settlementClass === order.settlementClass, 'packageAdmission.route.settlementClass', 'settlement class mismatch');
  const quantityPolicy = order.settlementClass === 'ATOMIC_POSTCONDITION'
    ? 'EXACT_ATOMIC'
    : order.settlementClass === 'ASYNC_BONDED_SOLVER'
      ? 'EXACT_NET'
      : order.hyperliquidQuantityPolicy;
  requireCondition(route.quantityPolicyClass === quantityPolicy, 'packageAdmission.route.quantityPolicyClass', 'quantity policy mismatch');
}

function validateTiming(
  order: PackageOrder,
  quote: SolverQuote,
  route: RoutePayload,
  currentTime: Expiry,
): void {
  requireCondition(order.expiryUnit === currentTime.unit, 'packageAdmission.currentTime.unit', 'clock unit mismatch');
  requireCondition(quote.validUntilUnit === currentTime.unit, 'packageAdmission.quote.validUntilUnit', 'clock unit mismatch');
  requireCondition(route.routeExpiryUnit === currentTime.unit, 'packageAdmission.route.routeExpiryUnit', 'clock unit mismatch');
  requireCondition(currentTime.value < order.expiryValue, 'packageAdmission.order.expiryValue', 'order is expired');
  requireCondition(currentTime.value < quote.validUntilValue, 'packageAdmission.quote.validUntilValue', 'quote is expired');
  requireCondition(currentTime.value < route.routeExpiryValue, 'packageAdmission.route.routeExpiryValue', 'route is expired');
  requireCondition(quote.validUntilValue <= order.expiryValue, 'packageAdmission.quote.validUntilValue', 'quote outlives order');
  requireCondition(route.routeExpiryValue <= quote.validUntilValue, 'packageAdmission.route.routeExpiryValue', 'route outlives quote');
  requireCondition(route.routeExpiryValue <= order.expiryValue, 'packageAdmission.route.routeExpiryValue', 'route outlives order');
}

function validateTemplate(
  input: PackageAdmissionInput,
  order: PackageOrder,
  route: RoutePayload,
  currentTime: Expiry,
): Readonly<{
  manifest: PackageTemplateManifest;
  record: PackageTemplateRegistryRecord;
}> {
  const manifest = packageTemplateManifest(input.templateManifest, 'packageAdmission.templateManifest');
  const manifestIdentity = packageTemplateManifestHash(manifest);
  requireEnvironment(manifest.environment, order.environment, 'packageAdmission.templateManifest.environment');
  requireCondition(manifest.templateId === order.templateId, 'packageAdmission.templateManifest.templateId', 'template mismatch');
  requireCondition(manifest.templateVersion === order.templateVersion, 'packageAdmission.templateManifest.templateVersion', 'template version mismatch');
  requireHash(manifestIdentity, order.packageTemplateManifestHash, 'packageAdmission.order.packageTemplateManifestHash');
  requireCondition(manifest.supportedDomains.some((domain) => sameDomain(domain, order.domain)), 'packageAdmission.templateManifest.supportedDomains', 'domain is not supported');
  requireCondition(manifest.supportedDirections.includes(order.direction), 'packageAdmission.templateManifest.supportedDirections', 'direction is not supported');
  requireCondition(manifest.supportedSettlementClasses.includes(order.settlementClass), 'packageAdmission.templateManifest.supportedSettlementClasses', 'settlement class is not supported');
  requireCondition(manifest.legCount === route.legs.length, 'packageAdmission.templateManifest.legCount', 'route leg count mismatch');

  const record = packageTemplateRegistryRecord(input.templateRegistryRecord, 'packageAdmission.templateRegistryRecord');
  requireEnvironment(record.environment, order.environment, 'packageAdmission.templateRegistryRecord.environment');
  requireDomain(record.domain, order.domain, 'packageAdmission.templateRegistryRecord.domain');
  requireCondition(record.templateId === order.templateId, 'packageAdmission.templateRegistryRecord.templateId', 'template mismatch');
  requireCondition(record.templateVersion === order.templateVersion, 'packageAdmission.templateRegistryRecord.templateVersion', 'template version mismatch');
  requireHash(record.packageTemplateManifestHash, manifestIdentity, 'packageAdmission.templateRegistryRecord.packageTemplateManifestHash');
  requireHash(route.templateRegistryRecordHash, packageTemplateRegistryRecordHash(record), 'packageAdmission.route.templateRegistryRecordHash');
  requireCondition(record.activationUnit === currentTime.unit, 'packageAdmission.templateRegistryRecord.activationUnit', 'clock unit mismatch');
  requireCondition(record.activationValue <= currentTime.value, 'packageAdmission.templateRegistryRecord.activationValue', 'template record is not active yet');
  requireCondition(statePermitsAction(record.registryState, order.action), 'packageAdmission.templateRegistryRecord.registryState', 'template state forbids the action');
  return Object.freeze({ manifest, record });
}

function registryRecordMatchesAdapter(
  record: DomainRegistryRecord,
  adapter: AdapterRef,
): boolean {
  return record.recordKind === 'ADAPTER'
    && record.subjectId === adapter.adapterId
    && record.subjectManifestVersion === adapter.adapterManifestVersion
    && sameHash(record.subjectManifestHash, adapter.adapterManifestHash);
}

function registryRecordMatchesRef(
  record: DomainRegistryRecord,
  kind: 'VENUE' | 'MARKET',
  reference: VersionedManifestRef,
): boolean {
  return record.recordKind === kind
    && record.subjectId === reference.subjectId
    && record.subjectManifestVersion === reference.manifestVersion
    && sameHash(record.subjectManifestHash, reference.manifestHash);
}

function registryRecordMatchesAsset(
  record: DomainRegistryRecord,
  asset: AssetRef,
): boolean {
  return record.recordKind === 'ASSET'
    && record.subjectId === asset.assetId
    && sameHash(record.subjectManifestHash, asset.assetManifestHash);
}

function validateActiveRecord(
  record: DomainRegistryRecord,
  order: PackageOrder,
  currentTime: Expiry,
  context: string,
): void {
  requireEnvironment(record.environment, order.environment, `${context}.environment`);
  requireDomain(record.domain, order.domain, `${context}.domain`);
  requireCondition(record.activationUnit === currentTime.unit, `${context}.activationUnit`, 'clock unit mismatch');
  requireCondition(record.activationValue <= currentTime.value, `${context}.activationValue`, 'record is not active yet');
  requireCondition(statePermitsAction(record.registryState, order.action), `${context}.registryState`, 'record state forbids the action');
  requireCondition(record.allowedSettlementClasses.includes(order.settlementClass), `${context}.allowedSettlementClasses`, 'settlement class is not allowed');
  requireCondition(
    record.allowedTemplates.some((template) =>
      template.templateId === order.templateId
      && template.templateVersion === order.templateVersion
      && sameHash(template.packageTemplateManifestHash, order.packageTemplateManifestHash)),
    `${context}.allowedTemplates`,
    'template is not allowed',
  );
}

function findOneRecord(
  records: readonly DomainRegistryRecord[],
  predicate: (record: DomainRegistryRecord) => boolean,
  context: string,
): DomainRegistryRecord {
  const matches = records.filter(predicate);
  requireCondition(matches.length === 1, context, matches.length === 0 ? 'active record is missing' : 'active record is ambiguous');
  return matches[0] as DomainRegistryRecord;
}

function validateAdaptersAndAccounts(
  input: PackageAdmissionInput,
  order: PackageOrder,
  route: RoutePayload,
  template: PackageTemplateManifest,
  currentTime: Expiry,
): void {
  requireCondition(Array.isArray(input.activeRegistryRecords), 'packageAdmission.activeRegistryRecords', 'expected an array');
  const records = input.activeRegistryRecords.map((record, index) =>
    domainRegistryRecord(record, `packageAdmission.activeRegistryRecords[${index}]`));
  for (const [index, leg] of route.legs.entries()) {
    const permitted = leg.legRole === 'SPOT' ? order.permittedSpotAdapters : order.permittedPerpAdapters;
    const templatePermitted = leg.legRole === 'SPOT'
      ? template.allowedSpotAdapterIds
      : template.allowedPerpAdapterIds;
    requireCondition(permitted.some((adapter) => sameAdapter(adapter, leg.adapter)), `packageAdmission.route.legs[${index}].adapter`, 'adapter is not permitted by the order');
    requireCondition(templatePermitted.includes(leg.adapter.adapterId), `packageAdmission.route.legs[${index}].adapter`, 'adapter is not permitted by the template');
    const adapterRecord = findOneRecord(records, (record) => registryRecordMatchesAdapter(record, leg.adapter), `packageAdmission.route.legs[${index}].adapter`);
    const venueRecord = findOneRecord(records, (record) => registryRecordMatchesRef(record, 'VENUE', leg.venue), `packageAdmission.route.legs[${index}].venue`);
    const marketRecord = findOneRecord(records, (record) => registryRecordMatchesRef(record, 'MARKET', leg.market), `packageAdmission.route.legs[${index}].market`);
    validateActiveRecord(adapterRecord, order, currentTime, `packageAdmission.route.legs[${index}].adapterRecord`);
    validateActiveRecord(venueRecord, order, currentTime, `packageAdmission.route.legs[${index}].venueRecord`);
    validateActiveRecord(marketRecord, order, currentTime, `packageAdmission.route.legs[${index}].marketRecord`);
    const action = route.actions[leg.actionSequence];
    requireCondition(action !== undefined, `packageAdmission.route.legs[${index}].actionSequence`, 'action is missing');
    requireCondition(action.legIndex === leg.legIndex, `packageAdmission.route.actions[${leg.actionSequence}].legIndex`, 'action leg mismatch');
    requireCondition(action.adapter !== undefined && sameAdapter(action.adapter, leg.adapter), `packageAdmission.route.actions[${leg.actionSequence}].adapter`, 'action adapter mismatch');
    const target = route.accountBindings.find((binding) => binding.routeBindingId === action.targetBindingId);
    requireCondition(target?.adapter !== undefined && sameAdapter(target.adapter, leg.adapter), `packageAdmission.route.actions[${leg.actionSequence}].targetBindingId`, 'target account adapter mismatch');
  }
  requireCondition(route.actions.length === route.legs.length, 'packageAdmission.route.actions', 'initial activation requires one action per leg');
  for (const [index, binding] of route.accountBindings.entries()) {
    if (binding.adapter === undefined) continue;
    requireCondition(route.legs.some((leg) => sameAdapter(leg.adapter, binding.adapter as AdapterRef)), `packageAdmission.route.accountBindings[${index}].adapter`, 'account adapter is not used by a leg');
  }
}

function distinctAssets(values: readonly AssetRef[]): readonly AssetRef[] {
  const result: AssetRef[] = [];
  for (const value of values) {
    if (!result.some((candidate) => sameAsset(candidate, value))) result.push(value);
  }
  return result;
}

function validateActiveAssets(
  input: PackageAdmissionInput,
  order: PackageOrder,
  quote: SolverQuote,
  route: RoutePayload,
  feePolicy: FeePolicyManifest,
  currentTime: Expiry,
): void {
  const records = input.activeRegistryRecords.map((record, index) =>
    domainRegistryRecord(record, `packageAdmission.activeRegistryRecords[${index}]`));
  const assets = distinctAssets([
    ...route.legs.flatMap((leg) => [leg.baseAsset, leg.quoteAsset]),
    ...route.serviceCharges.map((charge) => charge.asset),
    ...quote.expectedNormalizedVenueFeesByAsset.map((fee) => fee.asset),
    quote.protocolFee.asset,
    quote.solverFee.asset,
    quote.expectedPriorityFee.asset,
    ...quote.maxRecoveryCostAtomsByAsset.map((cap) => cap.asset),
    ...feePolicy.passThroughCostRules.map((rule) => assetRef(
        rule.costAssetId,
        rule.costAssetManifestHash,
        rule.costAssetDecimals,
        'packageAdmission.feePolicyManifest.passThroughCostRules.asset',
      )),
  ]);
  for (const [index, asset] of assets.entries()) {
    const record = findOneRecord(
      records,
      (candidate) => registryRecordMatchesAsset(candidate, asset),
      `packageAdmission.assets[${index}]`,
    );
    validateActiveRecord(record, order, currentTime, `packageAdmission.assets[${index}].record`);
  }
}

function validateLegsAndQuantities(
  order: PackageOrder,
  quote: SolverQuote,
  route: RoutePayload,
): void {
  const spot = route.legs.find((leg) => leg.legRole === 'SPOT');
  const perpetual = route.legs.find((leg) => leg.legRole === 'PERPETUAL');
  requireCondition(spot !== undefined && perpetual !== undefined, 'packageAdmission.route.legs', 'spot and perpetual legs are required');
  requireAsset(spot.baseAsset, order.quantity.asset, 'packageAdmission.route.spot.baseAsset');
  requireAsset(perpetual.baseAsset, order.quantity.asset, 'packageAdmission.route.perpetual.baseAsset');
  const quoteAsset = order.action === 'ENTRY'
    ? order.maxSpotQuoteIn?.asset
    : order.minSpotQuoteOut?.asset;
  requireCondition(quoteAsset !== undefined, 'packageAdmission.order', 'spot quote asset is missing');
  requireAsset(spot.quoteAsset, quoteAsset, 'packageAdmission.route.spot.quoteAsset');
  requireAsset(perpetual.quoteAsset, quoteAsset, 'packageAdmission.route.perpetual.quoteAsset');
  requireAsset(spot.quantity.asset, order.quantity.asset, 'packageAdmission.route.spot.quantity.asset');
  requireAsset(perpetual.quantity.asset, order.quantity.asset, 'packageAdmission.route.perpetual.quantity.asset');
  requireCondition(perpetual.quantity.atoms === order.quantity.atoms, 'packageAdmission.route.perpetual.quantity.atoms', 'perpetual quantity mismatch');
  const exactNetClass = order.settlementClass === 'ATOMIC_POSTCONDITION'
    || order.settlementClass === 'ASYNC_BONDED_SOLVER';
  const grossSpot = exactNetClass
    ? order.quantity
    : order.hyperliquidGrossSpotQuantity;
  requireCondition(grossSpot !== undefined, 'packageAdmission.order.hyperliquidGrossSpotQuantity', 'gross spot quantity is missing');
  requireCondition(spot.quantity.atoms === grossSpot.atoms, 'packageAdmission.route.spot.quantity.atoms', 'spot quantity mismatch');
  requireExactAmount(quote.expectedGrossSpotQuantity, grossSpot, 'packageAdmission.quote.expectedGrossSpotQuantity');
  requireAsset(quote.expectedNetSpotQuantity.asset, order.quantity.asset, 'packageAdmission.quote.expectedNetSpotQuantity.asset');
  requireAsset(quote.expectedBaseAssetFee.asset, order.quantity.asset, 'packageAdmission.quote.expectedBaseAssetFee.asset');
  requireCondition(quote.expectedBaseAssetFee.atoms >= 0n, 'packageAdmission.quote.expectedBaseAssetFee.atoms', 'base-asset fee is negative');
  if (exactNetClass) {
    const expectedNet = order.action === 'ENTRY'
      ? grossSpot.atoms - quote.expectedBaseAssetFee.atoms
      : -grossSpot.atoms - quote.expectedBaseAssetFee.atoms;
    requireCondition(quote.expectedNetSpotQuantity.atoms === expectedNet, 'packageAdmission.quote.expectedNetSpotQuantity.atoms', 'atomic net spot quantity mismatch');
  } else {
    requireCondition(order.hyperliquidMinNetSpotDelta !== undefined && order.hyperliquidMaxNetSpotDelta !== undefined, 'packageAdmission.order.hyperliquidMinNetSpotDelta', 'net spot interval is missing');
    requireCondition(
      quote.expectedNetSpotQuantity.atoms >= order.hyperliquidMinNetSpotDelta.atoms
        && quote.expectedNetSpotQuantity.atoms <= order.hyperliquidMaxNetSpotDelta.atoms,
      'packageAdmission.quote.expectedNetSpotQuantity.atoms',
      'net spot quantity is outside the signed interval',
    );
  }
  const expectedSides = order.action === 'ENTRY'
    ? { spot: 'BUY', perpetual: 'SELL', reduceOnly: false } as const
    : { spot: 'SELL', perpetual: 'BUY', reduceOnly: true } as const;
  requireCondition(spot.side === expectedSides.spot, 'packageAdmission.route.spot.side', 'spot side mismatch');
  requireCondition(perpetual.side === expectedSides.perpetual, 'packageAdmission.route.perpetual.side', 'perpetual side mismatch');
  requireCondition(perpetual.reduceOnly === expectedSides.reduceOnly, 'packageAdmission.route.perpetual.reduceOnly', 'perpetual reduce-only mismatch');
}

function compareSignedRate(
  leftQuoteAtoms: bigint,
  leftBaseAtoms: bigint,
  rightQuoteAtoms: bigint,
  rightBaseAtoms: bigint,
): number {
  const left = leftQuoteAtoms * rightBaseAtoms;
  const right = rightQuoteAtoms * leftBaseAtoms;
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateOutcome(
  order: PackageOrder,
  quote: SolverQuote,
): void {
  if (order.action === 'ENTRY') {
    requireCondition(quote.quotedOutcome.kind === 'ENTRY_SPREAD', 'packageAdmission.quote.quotedOutcome', 'entry requires an entry spread');
    requireCondition(order.maxEntrySpread !== undefined && order.maxSpotQuoteIn !== undefined, 'packageAdmission.order.maxEntrySpread', 'entry limits are missing');
    requireAsset(quote.quotedOutcome.entrySpread.baseAsset, order.maxEntrySpread.baseAsset, 'packageAdmission.quote.quotedOutcome.entrySpread.baseAsset');
    requireAsset(quote.quotedOutcome.entrySpread.quoteAsset, order.maxEntrySpread.quoteAsset, 'packageAdmission.quote.quotedOutcome.entrySpread.quoteAsset');
    requireCondition(
      compareSignedRate(
        quote.quotedOutcome.entrySpread.quoteAtoms,
        quote.quotedOutcome.entrySpread.baseAtoms,
        order.maxEntrySpread.quoteAtoms,
        order.maxEntrySpread.baseAtoms,
      ) <= 0,
      'packageAdmission.quote.quotedOutcome.entrySpread',
      'entry spread exceeds the signed maximum',
    );
    requireAmountAtMost(quote.expectedSpotNotional, order.maxSpotQuoteIn, 'packageAdmission.quote.expectedSpotNotional');
  } else {
    requireCondition(quote.quotedOutcome.kind === 'EXIT_QUOTE_OUTCOME', 'packageAdmission.quote.quotedOutcome', 'exit requires an exit outcome');
    requireCondition(order.minExitQuoteOutcome !== undefined && order.minSpotQuoteOut !== undefined, 'packageAdmission.order.minExitQuoteOutcome', 'exit limits are missing');
    requireAsset(quote.quotedOutcome.exitQuoteOutcome.asset, order.minExitQuoteOutcome.asset, 'packageAdmission.quote.quotedOutcome.exitQuoteOutcome.asset');
    requireCondition(quote.quotedOutcome.exitQuoteOutcome.atoms >= order.minExitQuoteOutcome.atoms, 'packageAdmission.quote.quotedOutcome.exitQuoteOutcome.atoms', 'exit outcome is below the signed minimum');
    requireAsset(quote.expectedSpotNotional.asset, order.minSpotQuoteOut.asset, 'packageAdmission.quote.expectedSpotNotional.asset');
    requireCondition(quote.expectedSpotNotional.atoms >= order.minSpotQuoteOut.atoms, 'packageAdmission.quote.expectedSpotNotional.atoms', 'spot proceeds are below the signed minimum');
  }
  requireAmountAtMost(quote.expectedMarginDelta, order.maxMarginAdded, 'packageAdmission.quote.expectedMarginDelta');
}

function findFeeCap(
  values: readonly FeeCap[],
  asset: AssetRef,
  context: string,
): FeeCap {
  const cap = values.find((value) => sameAsset(value.asset, asset));
  requireCondition(cap !== undefined, context, 'fee asset has no signed cap');
  return cap;
}

function findPassThroughCap(
  manifest: FeePolicyManifest,
  category: 'VENUE' | 'NETWORK' | 'RECOVERY',
  asset: AssetRef,
  context: string,
): bigint {
  const rule = manifest.passThroughCostRules.find((value) =>
    value.costCategory === category
      && value.costAssetId === asset.assetId
      && value.costAssetDecimals === asset.decimals
      && sameHash(value.costAssetManifestHash, asset.assetManifestHash));
  requireCondition(rule !== undefined, context, 'fee policy has no matching pass-through rule');
  return rule.maxAtoms;
}

function expectedServiceFee(
  rule: FeePolicyManifest['serviceFeeRules'][number],
  quote: SolverQuote,
  context: string,
): bigint {
  if (rule.fixedAtoms !== undefined) return rule.fixedAtoms;
  const maximumOneSidedNotional = quote.expectedSpotNotional.atoms > quote.expectedPerpNotional.atoms
    ? quote.expectedSpotNotional.atoms
    : quote.expectedPerpNotional.atoms;
  return mulDiv(
    maximumOneSidedNotional,
    rule.rateValue as bigint,
    rule.rateScale,
    rule.roundingDirection,
    context,
  );
}

function quotedServiceFee(
  quote: SolverQuote,
  category: 'PROTOCOL' | 'SOLVER' | 'BUILDER',
  asset: AssetRef,
  context: string,
): bigint {
  if (category === 'PROTOCOL') {
    requireAsset(quote.protocolFee.asset, asset, `${context}.asset`);
    return quote.protocolFee.atoms;
  }
  if (category === 'SOLVER') {
    requireAsset(quote.solverFee.asset, asset, `${context}.asset`);
    return quote.solverFee.atoms;
  }
  const value = quote.expectedBuilderFeesByAsset.find((fee) => sameAsset(fee.asset, asset));
  requireCondition(value !== undefined, context, 'builder fee asset is missing');
  return value.atoms;
}

function validateFeePolicy(
  input: PackageAdmissionInput,
  order: PackageOrder,
  quote: SolverQuote,
  route: RoutePayload,
  currentTime: Expiry,
): FeePolicyManifest {
  const manifest = feePolicyManifest(input.feePolicyManifest, 'packageAdmission.feePolicyManifest');
  const identity = feePolicyManifestHash(manifest);
  requireEnvironment(manifest.environment, order.environment, 'packageAdmission.feePolicyManifest.environment');
  requireDomain(manifest.domain, order.domain, 'packageAdmission.feePolicyManifest.domain');
  requireCondition(manifest.scopeDirection === order.direction, 'packageAdmission.feePolicyManifest.scopeDirection', 'direction mismatch');
  requireCondition(manifest.feePolicyVersion === quote.feePolicyVersion && manifest.feePolicyVersion === route.feePolicyVersion, 'packageAdmission.feePolicyManifest.feePolicyVersion', 'fee policy version mismatch');
  requireHash(quote.feePolicyManifestHash, identity, 'packageAdmission.quote.feePolicyManifestHash');
  requireHash(route.feePolicyManifestHash, identity, 'packageAdmission.route.feePolicyManifestHash');
  requireCondition(manifest.activationUnit === currentTime.unit, 'packageAdmission.feePolicyManifest.activationUnit', 'clock unit mismatch');
  requireCondition(manifest.activationValue <= currentTime.value, 'packageAdmission.feePolicyManifest.activationValue', 'fee policy is not active yet');
  if (manifest.expiryValue !== undefined) {
    requireCondition(currentTime.value < manifest.expiryValue, 'packageAdmission.feePolicyManifest.expiryValue', 'fee policy is expired');
  }
  if (manifest.scopeQuantityPolicyClass === undefined) {
    requireCondition(manifest.serviceFeeRules.length === 0 && manifest.passThroughCostRules.length === 0, 'packageAdmission.feePolicyManifest', 'unscoped policy must be zero');
  } else {
    requireCondition(manifest.scopeQuantityPolicyClass === route.quantityPolicyClass, 'packageAdmission.feePolicyManifest.scopeQuantityPolicyClass', 'quantity policy mismatch');
    requireCondition(manifest.scopeSettlementClass === order.settlementClass, 'packageAdmission.feePolicyManifest.scopeSettlementClass', 'settlement class mismatch');
    requireCondition(input.accountModeClass !== undefined, 'packageAdmission.accountModeClass', 'account mode is required');
    requireCondition(manifest.scopeAccountModeClass === protocolId(input.accountModeClass as string, 'packageAdmission.accountModeClass'), 'packageAdmission.accountModeClass', 'account mode mismatch');
  }

  requireCondition(route.serviceCharges.length === manifest.serviceFeeRules.length, 'packageAdmission.route.serviceCharges', 'service charge set does not match fee policy');
  for (const [index, rule] of manifest.serviceFeeRules.entries()) {
    const asset = assetRef(rule.feeAssetId, rule.feeAssetManifestHash, rule.feeAssetDecimals, `packageAdmission.feePolicyManifest.serviceFeeRules[${index}].asset`);
    requireAsset(asset, quote.expectedSpotNotional.asset, `packageAdmission.feePolicyManifest.serviceFeeRules[${index}].asset`);
    const quoted = quotedServiceFee(quote, rule.feeCategory, asset, `packageAdmission.quote.serviceFee[${index}]`);
    const policyMaximum = expectedServiceFee(rule, quote, `packageAdmission.feePolicyManifest.serviceFeeRules[${index}]`);
    requireCondition(quoted <= policyMaximum, `packageAdmission.quote.serviceFee[${index}]`, 'service fee exceeds policy');
    const charge = route.serviceCharges.find((value) => value.feeCategory === rule.feeCategory && sameAsset(value.asset, asset));
    requireCondition(charge !== undefined, `packageAdmission.route.serviceCharges[${index}]`, 'service charge is missing');
    requireCondition(charge.atoms === quoted, `packageAdmission.route.serviceCharges[${index}].atoms`, 'service charge does not equal accepted quote');
    requireCondition(charge.recipientIdentity === rule.recipientIdentity, `packageAdmission.route.serviceCharges[${index}].recipientIdentity`, 'fee recipient mismatch');
    requireCondition(charge.collectionAuthority === rule.collectionAuthority, `packageAdmission.route.serviceCharges[${index}].collectionAuthority`, 'collection authority mismatch');
  }

  const hasServiceRule = (
    category: 'PROTOCOL' | 'SOLVER' | 'BUILDER',
    asset: AssetRef,
  ): boolean => manifest.serviceFeeRules.some((rule) =>
    rule.feeCategory === category
      && rule.feeAssetId === asset.assetId
      && rule.feeAssetDecimals === asset.decimals
      && sameHash(rule.feeAssetManifestHash, asset.assetManifestHash));
  if (quote.protocolFee.atoms !== 0n) {
    requireCondition(hasServiceRule('PROTOCOL', quote.protocolFee.asset), 'packageAdmission.quote.protocolFee', 'fee policy has no protocol rule');
  }
  if (quote.solverFee.atoms !== 0n) {
    requireCondition(hasServiceRule('SOLVER', quote.solverFee.asset), 'packageAdmission.quote.solverFee', 'fee policy has no solver rule');
  }
  for (const [index, fee] of quote.expectedBuilderFeesByAsset.entries()) {
    if (fee.atoms !== 0n) {
      requireCondition(hasServiceRule('BUILDER', fee.asset), `packageAdmission.quote.expectedBuilderFeesByAsset[${index}]`, 'fee policy has no builder rule');
    }
  }

  requireAmountAtMost(quote.protocolFee, order.maxProtocolFee, 'packageAdmission.quote.protocolFee');
  requireAmountAtMost(quote.solverFee, order.maxSolverFee, 'packageAdmission.quote.solverFee');
  requireAmountAtMost(quote.expectedPriorityFee, order.maxPriorityFee, 'packageAdmission.quote.expectedPriorityFee');
  requireCondition(quote.protocolFee.atoms >= 0n, 'packageAdmission.quote.protocolFee.atoms', 'negative protocol fee is not activated');
  requireCondition(quote.solverFee.atoms >= 0n, 'packageAdmission.quote.solverFee.atoms', 'negative solver fee is not activated');
  requireCondition(quote.expectedPriorityFee.atoms >= 0n, 'packageAdmission.quote.expectedPriorityFee.atoms', 'priority fee is negative');

  if (quote.expectedPriorityFee.atoms !== 0n) {
    requireCondition(quote.expectedPriorityFee.atoms <= findPassThroughCap(manifest, 'NETWORK', quote.expectedPriorityFee.asset, 'packageAdmission.quote.expectedPriorityFee'), 'packageAdmission.quote.expectedPriorityFee.atoms', 'priority fee exceeds policy');
  }
  for (const [index, fee] of quote.expectedNormalizedVenueFeesByAsset.entries()) {
    requireCondition(fee.atoms >= 0n, `packageAdmission.quote.expectedNormalizedVenueFeesByAsset[${index}].atoms`, 'negative venue fee is not activated');
    requireCondition(fee.atoms <= findFeeCap(order.maxVenueFeeAtomsByAsset, fee.asset, `packageAdmission.quote.expectedNormalizedVenueFeesByAsset[${index}]`).maxAtoms, `packageAdmission.quote.expectedNormalizedVenueFeesByAsset[${index}].atoms`, 'venue fee exceeds order cap');
    if (fee.atoms !== 0n) {
      requireCondition(fee.atoms <= findPassThroughCap(manifest, 'VENUE', fee.asset, `packageAdmission.quote.expectedNormalizedVenueFeesByAsset[${index}]`), `packageAdmission.quote.expectedNormalizedVenueFeesByAsset[${index}].atoms`, 'venue fee exceeds policy');
    }
  }
  requireCondition(quote.maxRecoveryCostAtomsByAsset.length === order.maxRecoveryCostAtomsByAsset.length, 'packageAdmission.quote.maxRecoveryCostAtomsByAsset', 'recovery cap set mismatch');
  for (const [index, cap] of quote.maxRecoveryCostAtomsByAsset.entries()) {
    const orderCap = findFeeCap(order.maxRecoveryCostAtomsByAsset, cap.asset, `packageAdmission.quote.maxRecoveryCostAtomsByAsset[${index}]`);
    requireCondition(cap.maxAtoms <= orderCap.maxAtoms, `packageAdmission.quote.maxRecoveryCostAtomsByAsset[${index}].maxAtoms`, 'recovery cap exceeds order');
    requireCondition(cap.maxAtoms <= findPassThroughCap(manifest, 'RECOVERY', cap.asset, `packageAdmission.quote.maxRecoveryCostAtomsByAsset[${index}]`), `packageAdmission.quote.maxRecoveryCostAtomsByAsset[${index}].maxAtoms`, 'recovery cap exceeds policy');
  }
  return manifest;
}

function validateExecutableQuoteShape(
  order: PackageOrder,
  quote: SolverQuote,
): void {
  requireCondition(quote.quoteMode !== 'IMPLIED', 'packageAdmission.quote.quoteMode', 'implied quotes are not executable');
  const firm = quote.quoteMode === 'FIRM_SIMULATED' || quote.quoteMode === 'FIRM_ONCHAIN' || quote.quoteMode === 'FIRM_BONDED';
  requireCondition((quote.quoteMode === 'FIRM_BONDED') === (quote.performanceBondId !== undefined), 'packageAdmission.quote.performanceBondId', 'a performance bond backs exactly FIRM_BONDED quotes');
  if (order.settlementClass === 'BATCHED_IOC_WITH_RECOVERY') {
    requireCondition(quote.quoteMode === 'EXECUTION_COMMITMENT', 'packageAdmission.quote.quoteMode', 'Hyperliquid requires an execution commitment');
  }
  if (firm) {
    const supportedFirmAction = order.action === 'ENTRY'
      ? order.settlementClass === 'ATOMIC_POSTCONDITION'
        || order.settlementClass === 'ASYNC_BONDED_SOLVER'
      : order.settlementClass === 'ATOMIC_POSTCONDITION';
    requireCondition(
      supportedFirmAction,
      'packageAdmission.quote.quoteMode',
      'firm quotes require atomic entry or exit, or asynchronous bonded entry',
    );
    requireCondition(quote.reservationId !== undefined, 'packageAdmission.quote.reservationId', 'firm quote reservation is missing');
  } else {
    requireCondition(quote.reservationId === undefined, 'packageAdmission.quote.reservationId', 'non-firm quote cannot carry a reservation');
  }
}

function frozenAdmission(
  order: PackageOrder,
  quote: SolverQuote,
  route: RoutePayload,
  orderIdentity: Hash32,
  routeIdentity: CommitmentHash,
  quoteIdentity: Hash32,
): PackageAdmission {
  const capturedOrder = Uint8Array.from(orderIdentity) as Hash32;
  const capturedRoute = Uint8Array.from(routeIdentity) as CommitmentHash;
  const capturedQuote = Uint8Array.from(quoteIdentity) as Hash32;
  return Object.freeze({
    order,
    quote,
    route,
    get orderHash(): Hash32 { return Uint8Array.from(capturedOrder) as Hash32; },
    get routeHash(): CommitmentHash { return Uint8Array.from(capturedRoute) as CommitmentHash; },
    get quoteHash(): Hash32 { return Uint8Array.from(capturedQuote) as Hash32; },
  });
}

export function validatePackageAdmission(
  input: PackageAdmissionInput,
): PackageAdmission {
  if (typeof input !== 'object' || input === null) {
    throw new MalformedInputError('packageAdmission', 'expected an object');
  }
  const order = validatePackageOrderProfile(input.order, 'packageAdmission.order');
  const quote = solverQuote(input.quote, 'packageAdmission.quote');
  const route = routePayload(input.route, 'packageAdmission.route');
  const currentTime = validateCurrentTime(input);
  const orderIdentity = packageOrderHash(order);
  const routeIdentity = routeHash(route);
  const quoteIdentity = quoteHash(quote);
  validateDomainManifest(input, order, quote, route);
  validateObjectBindings(order, quote, route, orderIdentity, routeIdentity);
  validateTiming(order, quote, route, currentTime);
  const template = validateTemplate(input, order, route, currentTime);
  validateAdaptersAndAccounts(input, order, route, template.manifest, currentTime);
  validateLegsAndQuantities(order, quote, route);
  validateOutcome(order, quote);
  const feePolicy = validateFeePolicy(input, order, quote, route, currentTime);
  validateActiveAssets(input, order, quote, route, feePolicy, currentTime);
  validateExecutableQuoteShape(order, quote);
  return frozenAdmission(order, quote, route, orderIdentity, routeIdentity, quoteIdentity);
}
