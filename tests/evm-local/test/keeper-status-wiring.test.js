import assert from 'node:assert/strict';
import test from 'node:test';
import { keeperStatusEnvironment } from '../../../deployments/tools/wire-keeper-status.mjs';

test('keeper wiring preserves unrelated environment content and uses the actual port', () => {
  const before = '# local\nUNRELATED="value"\n';
  const keeper = 'NARYX_KEEPER_HOST=127.0.0.1\nNARYX_KEEPER_PORT=8809\n';
  const result = keeperStatusEnvironment(before, keeper);
  assert.equal(result.origin, 'http://127.0.0.1:8809');
  assert.equal(result.text, `${before}NARYX_KEEPER_STATUS_ORIGIN=http://127.0.0.1:8809\n`);
  assert.equal(keeperStatusEnvironment(result.text, keeper).changed, false);
});

test('keeper wiring refuses public endpoints, invalid ports and a conflicting destination', () => {
  for (const host of ['0.0.0.0', 'example.com', '127.0.0.1.example.com']) {
    assert.throws(() => keeperStatusEnvironment('', `NARYX_KEEPER_HOST=${host}\nNARYX_KEEPER_PORT=8809`), /loopback/);
  }
  for (const port of ['0', '65536', '8809/path']) {
    assert.throws(() => keeperStatusEnvironment('', `NARYX_KEEPER_HOST=127.0.0.1\nNARYX_KEEPER_PORT=${port}`), /valid port/);
  }
  assert.throws(() => keeperStatusEnvironment('NARYX_KEEPER_STATUS_ORIGIN=http://127.0.0.1:8789',
    'NARYX_KEEPER_HOST=127.0.0.1\nNARYX_KEEPER_PORT=8809'), /differs/);
});
