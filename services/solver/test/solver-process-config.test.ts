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
  assert.equal(durable.sealedAuctions.kind, 'DISABLED');
  assert.equal(durable.privateRfqs.kind, 'DISABLED');
  assert.equal(durable.makerControls.kind, 'DISABLED');
  assert.equal(durable.quoteDbPath, '/external/quotes.sqlite');
  // services/api defaults NARYX_SOLVER_INTERNAL_ORIGIN to this port.
  assert.equal(durable.port, 8_788);

  const fixture = loadSolverProcessConfig({ ...base, NARYX_LOCAL_FIXTURE_MODE: 'true' });
  assert.equal(fixture.localRuntime.kind, 'LOCAL_FIXTURE');
  assert.equal(fixture.quoteDbPath, '/tmp/naryx-local/solver-quotes.db');
});

test('maker controls require an explicit solver identity and quote key', () => {
  const enabled = {
    ...base,
    NARYX_SOLVER_QUOTE_DB: '/external/quotes.sqlite',
    NARYX_MAKER_CONTROLS_ENABLED: 'true',
    NARYX_MAKER_SOLVER_ID: 'solver-a',
    NARYX_MAKER_QUOTE_KEY_ID: 'quote-1',
    NARYX_MAKER_SOLVER_API_ORIGIN: 'http://127.0.0.1:8790',
  };
  assert.throws(
    () => loadSolverProcessConfig({ ...enabled, NARYX_MAKER_SOLVER_ID: '' }),
    /NARYX_MAKER_SOLVER_ID must be a protocol identifier/,
  );
  assert.deepEqual(loadSolverProcessConfig(enabled).makerControls, {
    kind: 'ENABLED',
    apiOrigin: 'http://127.0.0.1:8790',
    solverId: 'solver-a',
    keyId: 'quote-1',
  });
});

test('private RFQ participation requires explicit identity and external encryption key configuration', () => {
  const enabled = {
    ...base,
    NARYX_SOLVER_QUOTE_DB: '/external/quotes.sqlite',
    NARYX_PRIVATE_RFQ_PARTICIPANT_ENABLED: 'true',
    NARYX_PRIVATE_RFQ_SOLVER_ID: 'solver-a',
    NARYX_PRIVATE_RFQ_AUTH_KEY_ID: 'quote-1',
    NARYX_PRIVATE_RFQ_ENCRYPTION_KEY_ID: 'rfq-1',
    NARYX_PRIVATE_RFQ_ENCRYPTION_KEY_PATH: '/external/private-rfq.json',
  };
  assert.throws(
    () => loadSolverProcessConfig({ ...enabled, NARYX_PRIVATE_RFQ_ENCRYPTION_KEY_PATH: 'relative.json' }),
    /must be an absolute path/,
  );
  assert.throws(
    () => loadSolverProcessConfig({ ...enabled, NARYX_PRIVATE_RFQ_POLL_INTERVAL_MS: '99' }),
    /at least 100/,
  );
  assert.deepEqual(loadSolverProcessConfig(enabled).privateRfqs, {
    kind: 'ENABLED',
    solverId: 'solver-a',
    authKeyId: 'quote-1',
    encryptionKeyId: 'rfq-1',
    encryptionKeyPath: '/external/private-rfq.json',
    pollIntervalMs: 1_000,
  });
});

test('sealed auction participation requires explicit durable identity and journal configuration', () => {
  const enabled = {
    ...base,
    NARYX_SOLVER_QUOTE_DB: '/external/quotes.sqlite',
    NARYX_SEALED_AUCTION_PARTICIPANT_ENABLED: 'true',
    NARYX_SEALED_AUCTION_SOLVER_ID: 'solver-a',
    NARYX_SEALED_AUCTION_KEY_ID: 'quote-1',
    NARYX_SEALED_AUCTION_JOURNAL_DB: '/external/sealed-auctions.sqlite',
  };
  assert.throws(
    () => loadSolverProcessConfig({ ...enabled, NARYX_SEALED_AUCTION_JOURNAL_DB: 'relative.sqlite' }),
    /must be an absolute path/,
  );
  assert.throws(
    () => loadSolverProcessConfig({ ...enabled, NARYX_SEALED_AUCTION_POLL_INTERVAL_MS: '99' }),
    /at least 100/,
  );
  assert.deepEqual(loadSolverProcessConfig(enabled).sealedAuctions, {
    kind: 'ENABLED',
    solverId: 'solver-a',
    keyId: 'quote-1',
    journalDbPath: '/external/sealed-auctions.sqlite',
    pollIntervalMs: 1_000,
  });
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
