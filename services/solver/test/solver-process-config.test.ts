import assert from 'node:assert/strict';
import test from 'node:test';
import { loadSolverProcessConfig } from '../src/solver-process-config.js';

const base = {
  NARYX_SOLVER_ED25519_KEY_PATH: '/external/solver-ed25519-key.pem',
};

test('composes the fixed local fixture only on explicit opt-in and otherwise requires a durable quote database', () => {
  assert.throws(() => loadSolverProcessConfig(base), /NARYX_SOLVER_QUOTE_DB is required/);
  assert.throws(
    () => loadSolverProcessConfig({ ...base, NARYX_LOCAL_FIXTURE_MODE: 'yes' }),
    /NARYX_LOCAL_FIXTURE_MODE must be true or false/,
  );
  assert.throws(() => loadSolverProcessConfig({
    ...base,
    NARYX_LOCAL_FIXTURE_MODE: 'true',
    NARYX_SOLANA_LOCAL_ENVIRONMENT_MANIFEST: '/external/environment-manifest.json',
  }), /cannot be combined/);

  const durable = loadSolverProcessConfig({ ...base, NARYX_SOLVER_QUOTE_DB: '/external/quotes.sqlite' });
  assert.equal(durable.localRuntime.kind, 'NONE');
  assert.equal(durable.quoteDbPath, '/external/quotes.sqlite');
  // services/api defaults NARYX_SOLVER_INTERNAL_ORIGIN to this port.
  assert.equal(durable.port, 8_788);

  const fixture = loadSolverProcessConfig({ ...base, NARYX_LOCAL_FIXTURE_MODE: 'true' });
  assert.equal(fixture.localRuntime.kind, 'LOCAL_FIXTURE');
  assert.equal(fixture.quoteDbPath, '/tmp/naryx-local/solver-quotes.db');
});

test('requires an explicit authorization database for the manifest-validated local runtime', () => {
  const manifest = {
    ...base,
    NARYX_SOLVER_QUOTE_DB: '/external/quotes.sqlite',
    NARYX_SOLANA_LOCAL_ENVIRONMENT_MANIFEST: '/external/environment-manifest.json',
    NARYX_SOLANA_LOCAL_SOLVER_ID: 'local-solver',
  };
  assert.throws(() => loadSolverProcessConfig(manifest), /NARYX_SOLVER_SOLANA_AUTHORIZATION_DB is required/);
  assert.throws(() => loadSolverProcessConfig({
    ...manifest, NARYX_SOLVER_SOLANA_AUTHORIZATION_DB: 'relative.sqlite',
  }), /must be an absolute path/);
  const config = loadSolverProcessConfig({
    ...manifest, NARYX_SOLVER_SOLANA_AUTHORIZATION_DB: '/external/authorizations.sqlite',
  });
  assert.deepEqual(config.localRuntime, {
    kind: 'MANIFEST_VALIDATED',
    manifestPath: '/external/environment-manifest.json',
    solverId: 'local-solver',
    authorizationDbPath: '/external/authorizations.sqlite',
  });
});
