import { sha256 } from '@noble/hashes/sha2.js';
import { assertUint8Array, concatBytes } from './bytes.js';
import { MalformedInputError } from './errors.js';
import { hash32, type Hash32 } from './primitives.js';
import { encodeAscii } from './text.js';

export const HASH_DOMAIN = Object.freeze({
  ORDER: 'CON/v1/order',
  ROUTE: 'CON/v1/route',
  QUOTE: 'CON/v1/quote',
  SOLVER_SIGNATURE: 'CON/v1/solver-signature',
  OUTCOME: 'CON/v1/outcome',
  RECEIPT: 'CON/v1/receipt',
  EVIDENCE_MANIFEST: 'CON/v1/evidence-manifest',
  BENCHMARK_MANIFEST: 'CON/v1/benchmark-manifest',
  BENCHMARK_ARM: 'CON/v1/benchmark-arm',
  BENCHMARK_PAIR: 'CON/v1/benchmark-pair',
  PACKAGE_TEMPLATE: 'CON/v1/package-template',
  PACKAGE_TEMPLATE_REGISTRY_RECORD: 'CON/v1/package-template-registry-record',
  SOLVER_CAPABILITY: 'CON/v1/solver-capability',
  PRIVATE_RFQ_ENVELOPE: 'CON/v1/private-rfq-envelope',
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
