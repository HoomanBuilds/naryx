import { isAbsolute, resolve } from 'node:path';

export const LOCAL_FIXTURE_MODE_ENV = 'NARYX_LOCAL_FIXTURE_MODE';
// Matches the services/api default for NARYX_SOLVER_INTERNAL_ORIGIN.
export const DEFAULT_SOLVER_PORT = 8_788;
const LOCAL_FIXTURE_QUOTE_DB = '/tmp/naryx-local/solver-quotes.db';

export type SolverLocalRuntimeConfig =
  | Readonly<{ kind: 'NONE' }>
  | Readonly<{ kind: 'LOCAL_FIXTURE' }>
  | Readonly<{
    kind: 'MANIFEST_VALIDATED';
    manifestPath: string;
    solverId: string;
    authorizationDbPath: string;
  }>;

export interface SolverProcessConfig {
  readonly host: string;
  readonly port: number;
  readonly apiOrigin: string;
  readonly signerPath: string;
  readonly quoteDbPath: string;
  readonly localRuntime: SolverLocalRuntimeConfig;
  readonly sealedAuctions:
    | Readonly<{ kind: 'DISABLED' }>
    | Readonly<{
      kind: 'ENABLED';
      solverId: string;
      keyId: string;
      journalDbPath: string;
      pollIntervalMs: number;
    }>;
}

export function explicitBoolean(value: string | undefined, name: string): boolean {
  if (value === undefined || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error(`${name} must be true or false`);
}

export function tcpPort(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^\d{1,5}$/.test(value)) throw new Error(`${name} must be a TCP port`);
  const parsed = Number(value);
  if (parsed < 1 || parsed > 65_535) throw new Error(`${name} must be a TCP port`);
  return parsed;
}

function loopbackHost(value: string): string {
  if (value === 'localhost' || value === '::1' || /^127(?:\.\d{1,3}){3}$/.test(value)) return value;
  throw new Error('NARYX_SOLVER_HOST must be loopback');
}

function absolutePath(value: string, name: string): string {
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return resolve(value);
}

function present(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

function identifier(value: string | undefined, name: string): string {
  if (value === undefined || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new Error(`${name} must be a protocol identifier`);
  }
  return value;
}

function positiveInteger(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d{0,8}$/.test(value)) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

/**
 * Resolves the solver process configuration. The fixed local fixture catalog is composed only when
 * NARYX_LOCAL_FIXTURE_MODE=true, and only that mode may fall back to a temporary quote database.
 */
export function loadSolverProcessConfig(env: NodeJS.ProcessEnv): SolverProcessConfig {
  const fixtureMode = explicitBoolean(env[LOCAL_FIXTURE_MODE_ENV], LOCAL_FIXTURE_MODE_ENV);
  const manifestPath = env.NARYX_SOLANA_LOCAL_ENVIRONMENT_MANIFEST;
  if (fixtureMode && present(manifestPath)) {
    throw new Error(
      `${LOCAL_FIXTURE_MODE_ENV}=true cannot be combined with NARYX_SOLANA_LOCAL_ENVIRONMENT_MANIFEST`,
    );
  }
  const signerPath = env.NARYX_SOLVER_ED25519_KEY_PATH;
  if (!present(signerPath)) throw new Error('NARYX_SOLVER_ED25519_KEY_PATH is required');
  const quoteDb = env.NARYX_SOLVER_QUOTE_DB;
  if (!present(quoteDb) && !fixtureMode) {
    throw new Error(`NARYX_SOLVER_QUOTE_DB is required unless ${LOCAL_FIXTURE_MODE_ENV}=true`);
  }
  let localRuntime: SolverLocalRuntimeConfig = Object.freeze({ kind: 'NONE' as const });
  if (fixtureMode) {
    localRuntime = Object.freeze({ kind: 'LOCAL_FIXTURE' as const });
  } else if (present(manifestPath)) {
    const authorizationDb = env.NARYX_SOLVER_SOLANA_AUTHORIZATION_DB;
    if (!present(authorizationDb)) {
      throw new Error(
        'NARYX_SOLVER_SOLANA_AUTHORIZATION_DB is required with NARYX_SOLANA_LOCAL_ENVIRONMENT_MANIFEST',
      );
    }
    localRuntime = Object.freeze({
      kind: 'MANIFEST_VALIDATED' as const,
      manifestPath: absolutePath(manifestPath, 'NARYX_SOLANA_LOCAL_ENVIRONMENT_MANIFEST'),
      solverId: env.NARYX_SOLANA_LOCAL_SOLVER_ID ?? '',
      authorizationDbPath: absolutePath(authorizationDb, 'NARYX_SOLVER_SOLANA_AUTHORIZATION_DB'),
    });
  }
  const sealedAuctionsEnabled = explicitBoolean(
    env.NARYX_SEALED_AUCTION_PARTICIPANT_ENABLED,
    'NARYX_SEALED_AUCTION_PARTICIPANT_ENABLED',
  );
  const sealedAuctionPollIntervalMs = sealedAuctionsEnabled
    ? positiveInteger(
      env.NARYX_SEALED_AUCTION_POLL_INTERVAL_MS,
      'NARYX_SEALED_AUCTION_POLL_INTERVAL_MS',
      1_000,
    )
    : 1_000;
  if (sealedAuctionsEnabled && sealedAuctionPollIntervalMs < 100) {
    throw new Error('NARYX_SEALED_AUCTION_POLL_INTERVAL_MS must be at least 100');
  }
  const sealedAuctions = sealedAuctionsEnabled
    ? Object.freeze({
      kind: 'ENABLED' as const,
      solverId: identifier(env.NARYX_SEALED_AUCTION_SOLVER_ID, 'NARYX_SEALED_AUCTION_SOLVER_ID'),
      keyId: identifier(env.NARYX_SEALED_AUCTION_KEY_ID, 'NARYX_SEALED_AUCTION_KEY_ID'),
      journalDbPath: absolutePath(
        env.NARYX_SEALED_AUCTION_JOURNAL_DB ?? '',
        'NARYX_SEALED_AUCTION_JOURNAL_DB',
      ),
      pollIntervalMs: sealedAuctionPollIntervalMs,
    })
    : Object.freeze({ kind: 'DISABLED' as const });
  return Object.freeze({
    host: loopbackHost(env.NARYX_SOLVER_HOST ?? '127.0.0.1'),
    port: tcpPort(env.NARYX_SOLVER_PORT, 'NARYX_SOLVER_PORT', DEFAULT_SOLVER_PORT),
    apiOrigin: env.NARYX_API_INTERNAL_ORIGIN ?? 'http://127.0.0.1:8787',
    signerPath: absolutePath(signerPath, 'NARYX_SOLVER_ED25519_KEY_PATH'),
    quoteDbPath: absolutePath(present(quoteDb) ? quoteDb : LOCAL_FIXTURE_QUOTE_DB, 'NARYX_SOLVER_QUOTE_DB'),
    localRuntime,
    sealedAuctions,
  });
}
