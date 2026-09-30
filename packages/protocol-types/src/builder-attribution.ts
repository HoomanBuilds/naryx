import { checkedUnsigned } from './arithmetic.js';
import { assertUint8Array, toHex } from './bytes.js';
import { canonicalBytes } from './encoding.js';
import { DuplicateElementError, MalformedInputError } from './errors.js';
import { domainHash, HASH_DOMAIN } from './hashing.js';
import { commitmentHash, encodeCommitmentHash, type CommitmentHash } from './package-order-primitives.js';
import { encodeProtocolId, protocolId, type ProtocolId } from './primitives.js';

export const BUILDER_MANIFEST_VERSION = 1;
export const BUILDER_ATTRIBUTION_VERSION = 1;
const MAX_ITEMS = 32;
const MAX_FEE_BPS = 100n;

/**
 * A builder's signed identity and fee schedule. It grants attribution and payment rights only:
 * a builder never gains authority over an order, a route, or a position.
 */
export interface BuilderManifestInput {
  readonly manifestVersion: number;
  readonly environment: string;
  readonly builderId: string;
  /** The builder's Ed25519 public key; it signs this manifest's hash. */
  readonly identityKey: Uint8Array;
  readonly payoutAccounts: readonly { readonly domainId: string; readonly account: string }[];
  readonly supportedDomainIds: readonly string[];
  readonly maximumBuilderFeeBpsByTemplate: readonly { readonly templateId: string; readonly maximumFeeBps: bigint }[];
  readonly validFromMs: bigint;
  readonly validUntilMs: bigint;
  readonly nonce: bigint;
  readonly signature: Uint8Array;
}

/** The order owner's signed choice of builder for one order, with the most the builder may take. */
export interface BuilderAttributionInput {
  readonly attributionVersion: number;
  readonly orderHash: Uint8Array | string;
  readonly builderId: string;
  readonly builderManifestHash: Uint8Array | string;
  readonly maximumBuilderFeeBps: bigint;
}

function u64(value: bigint, context: string): bigint {
  if (typeof value !== 'bigint') throw new MalformedInputError(context, 'expected a bigint');
  return checkedUnsigned(value, 64, context);
}

function sortedIds(values: readonly string[], context: string): readonly ProtocolId[] {
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_ITEMS) throw new MalformedInputError(context, `expected 1 to ${MAX_ITEMS} entries`);
  const sorted = values.map((value) => protocolId(value, context)).sort();
  for (let i = 1; i < sorted.length; i += 1) if (sorted[i - 1] === sorted[i]) throw new DuplicateElementError(context, 'entries repeat');
  return Object.freeze(sorted);
}

export function builderManifestBytes(input: BuilderManifestInput): Uint8Array {
  const context = 'builderManifest';
  if (typeof input !== 'object' || input === null) throw new MalformedInputError(context, 'expected an object');
  if (input.manifestVersion !== BUILDER_MANIFEST_VERSION) throw new MalformedInputError(`${context}.manifestVersion`, `version must equal ${BUILDER_MANIFEST_VERSION}`);
  assertUint8Array(input.identityKey, `${context}.identityKey`);
  if (input.identityKey.length !== 32) throw new MalformedInputError(`${context}.identityKey`, 'expected a 32-byte Ed25519 key');
  const domains = sortedIds(input.supportedDomainIds, `${context}.supportedDomainIds`);
  const payouts = [...(input.payoutAccounts ?? [])].map((entry) => ({ domainId: protocolId(entry.domainId, `${context}.payoutAccounts.domainId`), account: protocolId(entry.account, `${context}.payoutAccounts.account`) }))
    .sort((a, b) => (a.domainId < b.domainId ? -1 : a.domainId > b.domainId ? 1 : 0));
  if (payouts.length === 0 || payouts.length > MAX_ITEMS) throw new MalformedInputError(`${context}.payoutAccounts`, 'expected 1 to 32 payout accounts');
  for (let i = 1; i < payouts.length; i += 1) if (payouts[i - 1]?.domainId === payouts[i]?.domainId) throw new DuplicateElementError(`${context}.payoutAccounts`, 'a domain has two payout accounts');
  if (payouts.some((entry) => !domains.includes(entry.domainId))) throw new MalformedInputError(`${context}.payoutAccounts`, 'a payout account is on an unsupported domain');
  const fees = [...(input.maximumBuilderFeeBpsByTemplate ?? [])].map((entry) => {
    const bps = u64(entry.maximumFeeBps, `${context}.maximumBuilderFeeBpsByTemplate.maximumFeeBps`);
    if (bps > MAX_FEE_BPS) throw new MalformedInputError(`${context}.maximumBuilderFeeBpsByTemplate`, `a builder fee is at most ${MAX_FEE_BPS} bps`);
    return { templateId: protocolId(entry.templateId, `${context}.maximumBuilderFeeBpsByTemplate.templateId`), maximumFeeBps: bps };
  }).sort((a, b) => (a.templateId < b.templateId ? -1 : a.templateId > b.templateId ? 1 : 0));
  if (fees.length === 0 || fees.length > MAX_ITEMS) throw new MalformedInputError(`${context}.maximumBuilderFeeBpsByTemplate`, 'expected 1 to 32 templates');
  for (let i = 1; i < fees.length; i += 1) if (fees[i - 1]?.templateId === fees[i]?.templateId) throw new DuplicateElementError(`${context}.maximumBuilderFeeBpsByTemplate`, 'a template repeats');
  const validFrom = u64(input.validFromMs, `${context}.validFromMs`);
  const validUntil = u64(input.validUntilMs, `${context}.validUntilMs`);
  if (validUntil <= validFrom) throw new MalformedInputError(`${context}.validUntilMs`, 'a manifest must end after it starts');
  return canonicalBytes((writer) => {
    writer.writeU32(BUILDER_MANIFEST_VERSION, 'manifestVersion');
    encodeProtocolId(writer, protocolId(input.environment, `${context}.environment`), 'environment');
    encodeProtocolId(writer, protocolId(input.builderId, `${context}.builderId`), 'builderId');
    writer.writeFixedBytes(input.identityKey, 32, 'identityKey');
    writer.writeArray(payouts, (w, entry) => {
      encodeProtocolId(w, entry.domainId, 'domainId');
      encodeProtocolId(w, entry.account, 'account');
    }, 'payoutAccounts');
    writer.writeArray(domains, (w, id) => encodeProtocolId(w, id, 'domainId'), 'supportedDomainIds');
    writer.writeArray(fees, (w, entry) => {
      encodeProtocolId(w, entry.templateId, 'templateId');
      w.writeU64(entry.maximumFeeBps, 'maximumFeeBps');
    }, 'maximumBuilderFeeBpsByTemplate');
    writer.writeU64(validFrom, 'validFromMs');
    writer.writeU64(validUntil, 'validUntilMs');
    writer.writeU64(u64(input.nonce, `${context}.nonce`), 'nonce');
  });
}

export function builderManifestHash(input: BuilderManifestInput): CommitmentHash {
  return commitmentHash(domainHash(HASH_DOMAIN.BUILDER_MANIFEST, builderManifestBytes(input)), 'builderManifestHash');
}

export function builderAttributionBytes(input: BuilderAttributionInput): Uint8Array {
  if (typeof input !== 'object' || input === null) throw new MalformedInputError('builderAttribution', 'expected an object');
  if (input.attributionVersion !== BUILDER_ATTRIBUTION_VERSION) throw new MalformedInputError('builderAttribution.attributionVersion', `version must equal ${BUILDER_ATTRIBUTION_VERSION}`);
  const bps = u64(input.maximumBuilderFeeBps, 'builderAttribution.maximumBuilderFeeBps');
  if (bps > MAX_FEE_BPS) throw new MalformedInputError('builderAttribution.maximumBuilderFeeBps', `a builder fee is at most ${MAX_FEE_BPS} bps`);
  return canonicalBytes((writer) => {
    writer.writeU32(BUILDER_ATTRIBUTION_VERSION, 'attributionVersion');
    encodeCommitmentHash(writer, commitmentHash(input.orderHash, 'builderAttribution.orderHash'), 'orderHash');
    encodeProtocolId(writer, protocolId(input.builderId, 'builderAttribution.builderId'), 'builderId');
    encodeCommitmentHash(writer, commitmentHash(input.builderManifestHash, 'builderAttribution.builderManifestHash'), 'builderManifestHash');
    writer.writeU64(bps, 'maximumBuilderFeeBps');
  });
}

export function builderAttributionHash(input: BuilderAttributionInput): CommitmentHash {
  return commitmentHash(domainHash(HASH_DOMAIN.BUILDER_ATTRIBUTION, builderAttributionBytes(input)), 'builderAttributionHash');
}

export type BuilderFeeViolation =
  | 'MANIFEST_MISMATCH'
  | 'BUILDER_MISMATCH'
  | 'MANIFEST_NOT_VALID_AT_ORDER'
  | 'DOMAIN_UNSUPPORTED'
  | 'TEMPLATE_UNSUPPORTED'
  | 'FEE_ABOVE_ORDER_CAP'
  | 'FEE_ABOVE_MANIFEST_CAP';

/**
 * Whether a charged builder fee is payable: the order owner attributed the order to this exact
 * manifest; the manifest covers the domain and template and was valid when the order was
 * accepted; and the fee is within both the owner's cap and the manifest's cap, each in basis
 * points of the package notional, rounded down. A fee of zero is always payable.
 */
export function checkBuilderFee(
  manifest: BuilderManifestInput,
  attribution: BuilderAttributionInput,
  charge: { readonly domainId: string; readonly templateId: string; readonly notionalAtoms: bigint; readonly feeAtoms: bigint; readonly orderAcceptedAtMs: bigint },
): { readonly payable: true } | { readonly payable: false; readonly violations: readonly BuilderFeeViolation[] } {
  const violations: BuilderFeeViolation[] = [];
  if (toHex(builderManifestHash(manifest)) !== toHex(commitmentHash(attribution.builderManifestHash, 'checkBuilderFee.builderManifestHash'))) violations.push('MANIFEST_MISMATCH');
  if (manifest.builderId !== attribution.builderId) violations.push('BUILDER_MISMATCH');
  if (charge.orderAcceptedAtMs < manifest.validFromMs || charge.orderAcceptedAtMs >= manifest.validUntilMs) violations.push('MANIFEST_NOT_VALID_AT_ORDER');
  if (!manifest.supportedDomainIds.includes(charge.domainId)) violations.push('DOMAIN_UNSUPPORTED');
  const templateCap = manifest.maximumBuilderFeeBpsByTemplate.find((entry) => entry.templateId === charge.templateId)?.maximumFeeBps;
  if (templateCap === undefined) violations.push('TEMPLATE_UNSUPPORTED');
  const cap = (bps: bigint) => (charge.notionalAtoms * bps) / 10_000n;
  if (charge.feeAtoms > cap(attribution.maximumBuilderFeeBps)) violations.push('FEE_ABOVE_ORDER_CAP');
  if (templateCap !== undefined && charge.feeAtoms > cap(templateCap)) violations.push('FEE_ABOVE_MANIFEST_CAP');
  return violations.length === 0 || charge.feeAtoms === 0n && !violations.includes('MANIFEST_MISMATCH') && !violations.includes('BUILDER_MISMATCH')
    ? Object.freeze({ payable: true as const })
    : Object.freeze({ payable: false as const, violations: Object.freeze(violations) });
}
