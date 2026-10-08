import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HttpDependencyIncidentStatusClient,
  parseDependencyIncidentStatus,
} from '../src/dependency-incident-status-client.js';

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    observedAtMs: 1_000,
    configuredScopeCount: 1,
    unavailableScopeCount: 0,
    scopes: [{
      scopeId: 'hypercore-testnet-cash-carry-small',
      scopeHash: `0x${'11'.repeat(32)}`,
      domainId: 'hypercore:testnet',
      state: 'EXIT_ONLY',
      entryAllowed: false,
      exitAllowed: true,
      revision: '1',
      evidenceCommitment: `0x${'22'.repeat(32)}`,
      evidenceObservedAtMs: '900',
      evidenceValidUntilMs: '1900',
      evidenceFresh: true,
      latestReceiptHash: `0x${'33'.repeat(32)}`,
    }],
    ...overrides,
  };
}

test('dependency incident status client accepts the exact loopback evidence contract', async () => {
  let requested = '';
  const client = new HttpDependencyIncidentStatusClient('http://127.0.0.1:8789', async (input) => {
    requested = String(input);
    return new Response(JSON.stringify(snapshot()), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  const status = await client.current();
  assert.equal(requested, 'http://127.0.0.1:8789/internal/keeper/dependency-incidents');
  assert.equal(status.scopes[0]?.state, 'EXIT_ONLY');
  assert.equal(status.scopes[0]?.exitAllowed, true);
});

test('dependency incident status rejects inconsistent counts and permissions', () => {
  assert.throws(() => parseDependencyIncidentStatus(snapshot({ configuredScopeCount: 2 })), /counts/);
  const invalid = snapshot();
  invalid.scopes[0]!.entryAllowed = true;
  assert.throws(() => parseDependencyIncidentStatus(invalid), /entry permission/);
  assert.throws(
    () => new HttpDependencyIncidentStatusClient('https://keeper.example'),
    /loopback HTTP origin/,
  );
});
