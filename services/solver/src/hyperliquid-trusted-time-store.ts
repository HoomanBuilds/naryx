import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  hyperliquidTrustedTimeDecisionJson,
  type HyperliquidTrustedTimeDecision,
} from './hyperliquid-trusted-time.js';

const HASH = /^0x[0-9a-f]{64}$/;
const SCOPE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/;
const DECIMAL_INTEGER = /^(0|[1-9][0-9]*)$/;

interface DecisionRow {
  readonly decision_hash: string;
  readonly scope: string;
  readonly selected_time_ms_decimal: string;
  readonly maximum_future_nonce_lead_ms_decimal: string;
  readonly decision_json: string;
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function canonicalInteger(value: number, name: string): string {
  requireCondition(Number.isSafeInteger(value) && value > 0, `${name} must be a positive safe integer`);
  return String(value);
}

function checkedStoredInteger(value: string, name: string): bigint {
  requireCondition(DECIMAL_INTEGER.test(value), `${name} is not canonical integer text`);
  const decoded = BigInt(value);
  requireCondition(decoded > 0n && decoded.toString() === value, `${name} is invalid`);
  return decoded;
}

export function installHyperliquidTrustedTimeStore(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS hyperliquid_trusted_time_decisions (
      decision_hash TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      selected_time_ms_decimal TEXT NOT NULL,
      maximum_future_nonce_lead_ms_decimal TEXT NOT NULL,
      decision_json TEXT NOT NULL,
      created_at_ms_decimal TEXT NOT NULL
    ) STRICT;

    CREATE TRIGGER IF NOT EXISTS hyperliquid_trusted_time_decision_immutable
    BEFORE UPDATE ON hyperliquid_trusted_time_decisions
    BEGIN SELECT RAISE(ABORT, 'Hyperliquid trusted time decisions are immutable'); END;

    CREATE TRIGGER IF NOT EXISTS hyperliquid_trusted_time_decision_no_delete
    BEFORE DELETE ON hyperliquid_trusted_time_decisions
    BEGIN SELECT RAISE(ABORT, 'Hyperliquid trusted time decisions cannot be deleted'); END;
  `);
}

export function persistHyperliquidTrustedTimeDecision(
  database: Database.Database,
  scope: string,
  decision: HyperliquidTrustedTimeDecision,
): void {
  requireCondition(SCOPE.test(scope), 'trusted time decision scope is invalid');
  requireCondition(decision.scope === scope, 'trusted time decision scope differs');
  requireCondition(HASH.test(decision.decisionHash), 'trusted time decision hash is invalid');
  const decisionJson = hyperliquidTrustedTimeDecisionJson(decision);
  const expectedHash = `0x${createHash('sha256').update(decisionJson).digest('hex')}`;
  requireCondition(expectedHash === decision.decisionHash, 'trusted time decision commitment differs');
  const row = database.prepare<[string], DecisionRow>(`
    SELECT decision_hash, scope, selected_time_ms_decimal,
      maximum_future_nonce_lead_ms_decimal, decision_json
    FROM hyperliquid_trusted_time_decisions WHERE decision_hash = ?
  `).get(decision.decisionHash);
  if (row !== undefined) {
    requireCondition(row.scope === scope
      && row.selected_time_ms_decimal === String(decision.selectedTimeMs)
      && row.maximum_future_nonce_lead_ms_decimal
        === String(decision.policy.maximumFutureNonceLeadMs)
      && row.decision_json === decisionJson,
    'trusted time decision replay changed its immutable binding');
    return;
  }
  database.prepare(`
    INSERT INTO hyperliquid_trusted_time_decisions (
      decision_hash, scope, selected_time_ms_decimal,
      maximum_future_nonce_lead_ms_decimal, decision_json, created_at_ms_decimal
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    decision.decisionHash,
    scope,
    canonicalInteger(decision.selectedTimeMs, 'selectedTimeMs'),
    canonicalInteger(decision.policy.maximumFutureNonceLeadMs, 'maximumFutureNonceLeadMs'),
    decisionJson,
    canonicalInteger(decision.observedAtMs, 'observedAtMs'),
  );
}

export function requireHyperliquidTrustedTimeDecision(
  database: Database.Database,
  decisionHash: `0x${string}`,
  selectedTimeMs: bigint,
): bigint {
  requireCondition(HASH.test(decisionHash), 'trusted time decision hash is invalid');
  const row = database.prepare<[string], DecisionRow>(`
    SELECT decision_hash, scope, selected_time_ms_decimal,
      maximum_future_nonce_lead_ms_decimal, decision_json
    FROM hyperliquid_trusted_time_decisions WHERE decision_hash = ?
  `).get(decisionHash);
  requireCondition(row !== undefined, 'trusted time decision is not durably recorded');
  requireCondition(`0x${createHash('sha256').update(row.decision_json).digest('hex')}` === decisionHash,
    'stored trusted time decision commitment differs');
  const storedTime = checkedStoredInteger(row.selected_time_ms_decimal, 'stored trusted time');
  requireCondition(storedTime === selectedTimeMs, 'nonce time differs from the trusted time decision');
  return checkedStoredInteger(
    row.maximum_future_nonce_lead_ms_decimal,
    'stored maximum future nonce lead',
  );
}

export function allocateHyperliquidTrustedNonce(
  trustedTimeMs: bigint,
  previousNonce: bigint,
  maximumFutureNonceLeadMs: bigint,
): bigint {
  requireCondition(trustedTimeMs > 0n && previousNonce >= 0n && maximumFutureNonceLeadMs > 0n,
    'trusted nonce inputs are invalid');
  requireCondition(previousNonce <= trustedTimeMs + maximumFutureNonceLeadMs,
    'durable nonce is beyond trusted time policy; fresh agent replacement is required');
  const nonce = trustedTimeMs > previousNonce ? trustedTimeMs : previousNonce + 1n;
  requireCondition(nonce <= BigInt(Number.MAX_SAFE_INTEGER), 'allocated nonce must fit a safe integer');
  return nonce;
}
