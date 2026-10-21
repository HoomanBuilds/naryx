import assert from 'node:assert/strict';
import test from 'node:test';
import type { SolverCapabilityManifestInput } from '@naryx/protocol-types';
import { solverManifestNow } from '../src/solver-api.js';

test('slot solver authentication requires a trusted observed slot and never substitutes wall time', () => {
  const manifest = { validityUnit: 'SOLANA_SLOT' } as SolverCapabilityManifestInput;
  assert.equal(solverManifestNow(manifest, 1_900_000_000_000, unit => unit === 'SOLANA_SLOT' ? 400_000_000n : undefined), 400_000_000n);
  assert.throws(() => solverManifestNow(manifest, 1_900_000_000_000), /Slot-timed/);
  assert.throws(() => solverManifestNow(manifest, 1_900_000_000_000, () => undefined), /Slot-timed/);
  assert.throws(() => solverManifestNow(manifest, 1_900_000_000_000, () => 0n), /Slot-timed/);
  assert.equal(solverManifestNow({ ...manifest, validityUnit: 'EVM_UNIX_SECONDS' }, 1_900_000_000_000, () => 2n), 1_900_000_000n);
});
