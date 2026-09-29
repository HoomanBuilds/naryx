import { sha256 } from '@noble/hashes/sha2.js';
import { assertUint8Array, concatBytes } from './bytes.js';
import { MalformedInputError } from './errors.js';
import { hash32, type Hash32 } from './primitives.js';
import { encodeAscii } from './text.js';

export const HASH_DOMAIN = Object.freeze({
  ORDER: 'CON/v1/order',
  ROUTE: 'CON/v1/route',
  ROUTE_ACCOUNTS: 'CON/v1/route-accounts',
  QUOTE: 'CON/v1/quote',
  RESERVATION_ID: 'CON/v1/reservation-id',
  SOLVER_SIGNATURE: 'CON/v1/solver-signature',
  OUTCOME: 'CON/v1/outcome',
  RECEIPT: 'CON/v1/receipt',
  EVIDENCE_MANIFEST: 'CON/v1/evidence-manifest',
  BENCHMARK_MANIFEST: 'CON/v1/benchmark-manifest',
  BENCHMARK_ARM: 'CON/v1/benchmark-arm',
  BENCHMARK_PAIR: 'CON/v1/benchmark-pair',
  PACKAGE_TEMPLATE: 'CON/v1/package-template',
  ECONOMIC_STRATEGY_SERIES: 'CON/v1/economic-strategy-series',
  SERIES_EXECUTION_CLASS: 'CON/v1/series-execution-class',
  PACKAGE_TEMPLATE_REGISTRY_RECORD: 'CON/v1/package-template-registry-record',
  DOMAIN_MANIFEST: 'CON/v1/domain-manifest',
  ASSET_MANIFEST: 'CON/v1/asset-manifest',
  VENUE_MANIFEST: 'CON/v1/venue-manifest',
  MARKET_MANIFEST: 'CON/v1/market-manifest',
  ADAPTER_MANIFEST: 'CON/v1/adapter-manifest',
  PRICE_SOURCE_MANIFEST: 'CON/v1/price-source-manifest',
  DOMAIN_REGISTRY_RECORD: 'CON/v1/domain-registry-record',
  FEE_POLICY: 'CON/v1/fee-policy',
  SOLVER_CAPABILITY: 'CON/v1/solver-capability',
  PRIVATE_RFQ_ENVELOPE: 'CON/v1/private-rfq-envelope',
  PROTOCOL_ID_IDENTITY: 'CON/v1/protocol-id-identity',
  DOMAIN_REF_IDENTITY: 'CON/v1/domain-ref-identity',
  SETTLEMENT_CLASS_IDENTITY: 'CON/v1/settlement-class-identity',
  CASH_CARRY_SERIES_IDENTITY: 'CON/v1/cash-carry-series-identity',
  CASH_CARRY_SERIES_BINDING: 'CON/v1/cash-carry-series-binding',
  ASYNC_BONDED_AUTHORIZATION: 'CON/v1/async-bonded-authorization',
  ASYNC_BONDED_TRANSITION: 'CON/v1/async-bonded-transition',
  PACKAGE_LIFECYCLE_INTENT: 'CON/v1/package-lifecycle-intent',
  PACKAGE_LIFECYCLE_RECEIPT: 'CON/v1/package-lifecycle-receipt',
  AUTHORITY_INVENTORY: 'CON/v1/authority-inventory',
  OPERATION_CAP_POLICY: 'CON/v1/operation-cap-policy',
  FUNDED_OPERATION_MANIFEST: 'CON/v1/funded-operation-manifest',
  SECURITY_FINDING_SUMMARY: 'CON/v1/security-finding-summary',
  READINESS_EVIDENCE: 'CON/v1/readiness-evidence',
  READINESS_DECISION: 'CON/v1/readiness-decision',
  OPERATION_LEDGER_RECORD: 'CON/v1/operation-ledger-record',
  PACKAGE_MATCHING_POLICY: 'CON/v1/package-matching-policy',
  IMPLIED_PACKAGE_QUOTE: 'CON/v1/implied-package-quote',
  PACKAGE_ALLOCATION: 'CON/v1/package-allocation',
  SOLVER_CAPACITY_RECORD: 'CON/v1/solver-capacity-record',
  SOLVER_COMMITMENT_ROOT: 'CON/v1/solver-commitment-root',
  RFQ_DECISION: 'CON/v1/rfq-decision',
  PERFORMANCE_BOND: 'CON/v1/performance-bond',
  NETTING_PROOF: 'CON/v1/netting-proof',
  STRATEGY_STATE: 'CON/v1/strategy-state',
  STRATEGY_TRANSITION: 'CON/v1/strategy-transition',
  PRIVATE_RFQ_RESPONSE: 'CON/v1/private-rfq-response',
  SEALED_AUCTION: 'CON/v1/sealed-auction',
  SEALED_COMMITMENT: 'CON/v1/sealed-commitment',
  SEALED_AUCTION_RESULT: 'CON/v1/sealed-auction-result',
  DISCLOSURE_FIELD: 'CON/v1/disclosure-field',
  DISCLOSURE_ROOT: 'CON/v1/disclosure-root',
  PRIVACY_PROFILE: 'CON/v1/privacy-profile',
  ROUTE_CANDIDATE_SET: 'CON/v1/route-candidate-set',
  ROUTE_SELECTION_OBJECTIVE: 'CON/v1/route-selection-objective',
  ROUTE_DECISION: 'CON/v1/route-decision',
  EXECUTION_QUALITY: 'CON/v1/execution-quality',
  DELIVERY_EVIDENCE: 'CON/v1/delivery-evidence',
  INDEXED_PACKAGE_RECORD: 'CON/v1/indexed-package-record',
} as const);

export type HashDomain = (typeof HASH_DOMAIN)[keyof typeof HASH_DOMAIN];

const DOMAIN_VALUES: readonly string[] = Object.freeze(Object.values(HASH_DOMAIN));

export function domainBytes(domain: HashDomain, context = 'hashDomain'): Uint8Array {
  if (!DOMAIN_VALUES.includes(domain)) {
    throw new MalformedInputError(context, `unregistered hash domain ${String(domain)}`);
  }
  return encodeAscii(domain, context);
}

export function domainHash(
  domain: HashDomain,
  payload: Uint8Array,
  context = 'domainHash',
): Hash32 {
  assertUint8Array(payload, `${context}.payload`);
  return hash32(sha256(concatBytes([domainBytes(domain, context), payload])), context);
}
