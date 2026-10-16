import anchor, { type Idl } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import { domainRef, type DomainRef } from '@naryx/protocol-types';

const { BorshCoder, BN } = anchor;

export type SolanaResourceMarketUnits = Readonly<{
  baseDecimals: number;
  quoteDecimals: number;
  baseLotAtoms: bigint;
  quoteTickAtomsPerBaseLot: bigint;
  minimumQuoteNotionalAtoms: bigint;
}>;

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Market resource is malformed.');
  return value as Record<string, unknown>;
}

function positive(value: unknown): bigint {
  if (!(value instanceof BN)) throw new Error('Market resource units are malformed.');
  const amount = BigInt((value as InstanceType<typeof BN>).toString());
  if (amount <= 0n) throw new Error('Market resource units must be positive.');
  return amount;
}

function decimals(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 255) {
    throw new Error('Market resource decimals are malformed.');
  }
  return value;
}

function hash(value: unknown): Uint8Array {
  if (!Array.isArray(value) || value.length !== 32 || value.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new Error('Market resource hash is malformed.');
  }
  return Uint8Array.from(value);
}

export function decodeSolanaMarketResource(idl: Idl, data: Uint8Array): Readonly<{
  domain: DomainRef;
  manifestHash: Uint8Array;
  subjectAddress: string;
  units: SolanaResourceMarketUnits;
}> {
  const decoded = record(new BorshCoder(idl).accounts.decode('ResourceRecord', Buffer.from(data)));
  const manifest = record(decoded.manifest);
  if (decoded.active !== true || Object.keys(record(manifest.kind)).join(',') !== 'Market'
    || !(manifest.subject_address instanceof PublicKey)) {
    throw new Error('Resource is not an active market.');
  }
  const domain = record(manifest.domain);
  const identity = record(manifest.identity);
  const units = record(manifest.market_units);
  return Object.freeze({
    domain: domainRef(domain.domain_id as string, domain.domain_manifest_version as number, hash(domain.domain_manifest_hash)),
    manifestHash: hash(identity.manifest_hash),
    subjectAddress: manifest.subject_address.toBase58(),
    units: Object.freeze({
      baseDecimals: decimals(units.base_decimals),
      quoteDecimals: decimals(units.quote_decimals),
      baseLotAtoms: positive(units.base_lot_atoms),
      quoteTickAtomsPerBaseLot: positive(units.quote_tick_atoms_per_base_lot),
      minimumQuoteNotionalAtoms: positive(units.minimum_quote_notional_atoms),
    }),
  });
}
