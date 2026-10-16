import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import anchor, { type Idl } from '@coral-xyz/anchor';
import { PublicKey } from '@solana/web3.js';
import { decodeSolanaMarketResource } from '../src/resource-market-accounts.js';

const { BorshCoder, BN } = anchor;
const idl = JSON.parse(readFileSync(new URL('../../../../../deployments/solana/devnet/test-perp/idl/naryx_core.devnet-test-perp.json', import.meta.url), 'utf8')) as Idl;
const coder = new BorshCoder(idl);
const hash = Array(32).fill(7);

function fixture() {
  return {
    manifest: {
      kind: { Market: {} },
      domain: { domain_id: 'svm:devnet', domain_manifest_version: 1, domain_manifest_hash: hash },
      identity: { subject_id: hash, manifest_version: 1, manifest_hash: hash },
      subject_address: PublicKey.default, program_id: PublicKey.default, program_data: PublicKey.default, code_identity: hash,
      decimals: 9, quote_decimals: 6, role: { Spot: {} },
      adapter_class: null, venue: null, market: null, base_asset: null, quote_asset: null,
      allowed_template: null, settlement: null,
      market_units: {
        base_decimals: 9, quote_decimals: 6, base_lot_atoms: new BN(1_000_000), quote_tick_atoms_per_base_lot: new BN(1),
        minimum_quote_notional_atoms: new BN(1_000_000), multiplier_numerator: new BN(1), multiplier_denominator: new BN(1),
      },
    },
    control: { lifecycle: { Active: {} }, quote_limit: null }, pending_control: null, active: true, bump: 255,
  };
}

test('reads exact market units from the core resource account and rejects nonmarket or zero-unit records', async () => {
  const value = fixture();
  const decoded = decodeSolanaMarketResource(idl, await coder.accounts.encode('ResourceRecord', value));
  assert.equal(decoded.units.minimumQuoteNotionalAtoms, 1_000_000n);
  assert.equal(decoded.units.baseLotAtoms, 1_000_000n);
  assert.equal(decoded.domain.domainId, 'svm:devnet');
  assert.throws(() => decodeSolanaMarketResource(idl, new Uint8Array(8)), /discriminator/);
  const asset = await coder.accounts.encode('ResourceRecord', { ...value, manifest: { ...value.manifest, kind: { Asset: {} } } });
  assert.throws(() => decodeSolanaMarketResource(idl, asset), /active market/);
  const inactive = await coder.accounts.encode('ResourceRecord', { ...value, active: false });
  assert.throws(() => decodeSolanaMarketResource(idl, inactive), /active market/);
  value.manifest.market_units.minimum_quote_notional_atoms = new BN(0);
  const zero = await coder.accounts.encode('ResourceRecord', value);
  assert.throws(() => decodeSolanaMarketResource(idl, zero), /positive/);
});
