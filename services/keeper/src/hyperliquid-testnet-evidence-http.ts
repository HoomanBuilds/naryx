import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { parseProtocolJson, toProtocolJson } from '@naryx/protocol-types';
import type {
  HyperliquidEvidenceMarketBinding,
  HyperliquidEvidenceWindow,
} from './hyperliquid-evidence-collector.js';
import type {
  HyperliquidTestnetEvidencePrepareInput,
  HyperliquidTestnetEvidenceRuntime,
  HyperliquidTestnetEvidenceRuntimeState,
  HyperliquidTestnetSubmissionHandoff,
} from './hyperliquid-testnet-evidence-runtime.js';
import type {
  HyperliquidStrategyAuthoritativeEvidenceCollector,
  HyperliquidStrategyEvidenceRequest,
} from './hyperliquid-strategy-evidence.js';
import type {
  HyperliquidNettingResidualAuthoritativeEvidenceCollector,
  HyperliquidNettingResidualEvidenceRequest,
} from './hyperliquid-netting-residual-evidence.js';
import type { DependencyIncidentStatusReader } from './dependency-incident-status.js';

export const KEEPER_TESTNET_PREPARE_PATH = '/internal/keeper/hyperliquid-testnet/prepare';
export const KEEPER_TESTNET_RECONCILE_PATH = '/internal/keeper/hyperliquid-testnet/reconcile';
export const KEEPER_TESTNET_STRATEGY_RECONCILE_PATH =
  '/internal/keeper/hyperliquid-testnet/strategy/reconcile';
export const KEEPER_TESTNET_NETTING_RESIDUAL_RECONCILE_PATH =
  '/internal/keeper/hyperliquid-testnet/netting-residual/reconcile';
export const KEEPER_DEPENDENCY_INCIDENT_STATUS_PATH = '/internal/keeper/dependency-incidents';

const MAX_BODY_BYTES = 65_536;

export interface KeeperServerConfig {
  readonly host: string;
  readonly port: number;
}

export interface HyperliquidTestnetEvidenceHttpPorts {
  readonly runtime: Pick<HyperliquidTestnetEvidenceRuntime, 'prepare' | 'reconcile'>;
  readonly strategy?: Pick<HyperliquidStrategyAuthoritativeEvidenceCollector, 'collect'>;
  readonly nettingResidual?: Pick<HyperliquidNettingResidualAuthoritativeEvidenceCollector, 'collect'>;
  readonly dependencyIncidents?: Pick<DependencyIncidentStatusReader, 'current'>;
}

class KeeperRequestError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'KeeperRequestError';
    this.code = code;
  }
}

function isLoopbackHost(host: string): boolean {
  if (host === 'localhost' || host === '::1') return true;
  const octets = host.split('.');
  return octets.length === 4 && octets[0] === '127' && octets.every((octet) => {
    if (!/^\d{1,3}$/.test(octet)) return false;
    const value = Number(octet);
    return value >= 0 && value <= 255;
  });
}

function isLoopbackPeer(address: string | undefined): boolean {
  if (address === '::1') return true;
  const host = address?.startsWith('::ffff:') === true ? address.slice(7) : address;
  return host !== undefined && isLoopbackHost(host);
}

function parsePort(value: string | undefined): number {
  if (value === undefined) return 8789;
  if (!/^\d{1,5}$/.test(value)) throw new Error('NARYX_KEEPER_PORT must be a valid TCP port.');
  const port = Number(value);
  if (port < 1 || port > 65535) throw new Error('NARYX_KEEPER_PORT must be a valid TCP port.');
  return port;
}

export function loadKeeperServerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): KeeperServerConfig {
  const host = environment.NARYX_KEEPER_HOST ?? '127.0.0.1';
  if (!isLoopbackHost(host)) {
    throw new Error('NARYX_KEEPER_HOST must be a loopback address.');
  }
  return { host, port: parsePort(environment.NARYX_KEEPER_PORT) };
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.end(JSON.stringify(body));
}

function reject(response: ServerResponse, status: number, code: string, message: string): void {
  sendJson(response, status, { error: { code, message } });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
}

async function readProtocolJson(request: IncomingMessage, context: string): Promise<unknown> {
  const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim();
  if (contentType !== 'application/json') {
    throw new KeeperRequestError('INVALID_CONTENT_TYPE', 'Content-Type must be application/json.');
  }
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    byteLength += buffer.byteLength;
    if (byteLength > MAX_BODY_BYTES) {
      throw new KeeperRequestError('BODY_TOO_LARGE', 'Request body is too large.');
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return parseProtocolJson(text, context);
  } catch {
    throw new KeeperRequestError('INVALID_JSON', 'Request body must be strict protocol JSON.');
  }
}

function parsePrepareRequest(value: unknown): HyperliquidTestnetEvidencePrepareInput {
  if (!isRecord(value) || !hasExactKeys(value, ['account', 'attemptId', 'binding', 'plan', 'window'])) {
    throw new KeeperRequestError(
      'INVALID_REQUEST',
      'Prepare request must contain only attemptId, plan, account, binding, window.',
    );
  }
  return value as unknown as HyperliquidTestnetEvidencePrepareInput;
}

function parseReconcileRequest(value: unknown): {
  prepared: HyperliquidTestnetEvidenceRuntimeState;
  handoff: HyperliquidTestnetSubmissionHandoff;
  binding: HyperliquidEvidenceMarketBinding;
  window: HyperliquidEvidenceWindow;
} {
  if (!isRecord(value) || !hasExactKeys(value, ['binding', 'handoff', 'prepared', 'window'])) {
    throw new KeeperRequestError(
      'INVALID_REQUEST',
      'Reconcile request must contain only prepared, handoff, binding, window.',
    );
  }
  const typed = value as unknown as {
    prepared: HyperliquidTestnetEvidenceRuntimeState;
    handoff: HyperliquidTestnetSubmissionHandoff;
    binding: HyperliquidEvidenceMarketBinding;
    window: HyperliquidEvidenceWindow;
  };
  if (!isRecord(typed.prepared) || !isRecord(typed.handoff)
    || !isRecord(typed.binding) || !isRecord(typed.window)) {
    throw new KeeperRequestError('INVALID_REQUEST', 'Reconcile request fields are invalid.');
  }
  return typed;
}

function parseStrategyReconcileRequest(value: unknown): HyperliquidStrategyEvidenceRequest {
  const keys = [
    'account', 'actionHash', 'attemptId', 'batchStage', 'clientOrderIds',
    'binding', 'durableRevision', 'legIds', 'plan', 'requestCommitment', 'window',
  ];
  if (!isRecord(value) || !hasExactKeys(value, keys)) {
    throw new KeeperRequestError(
      'INVALID_REQUEST',
      'Strategy reconcile request fields are invalid.',
    );
  }
  return value as unknown as HyperliquidStrategyEvidenceRequest;
}

function parseNettingResidualReconcileRequest(
  value: unknown,
): HyperliquidNettingResidualEvidenceRequest {
  const keys = [
    'account', 'actionHash', 'attemptId', 'binding', 'clientOrderId',
    'durableRevision', 'instrumentHash', 'intentHash', 'plan',
    'requestCommitment', 'window',
  ];
  if (!isRecord(value) || !hasExactKeys(value, keys)) {
    throw new KeeperRequestError(
      'INVALID_REQUEST',
      'Netting residual reconcile request fields are invalid.',
    );
  }
  return value as unknown as HyperliquidNettingResidualEvidenceRequest;
}

export function createHyperliquidTestnetEvidenceRequestHandler(
  ports: HyperliquidTestnetEvidenceHttpPorts,
) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (!isLoopbackPeer(request.socket.remoteAddress)) {
      reject(response, 403, 'LOOPBACK_REQUIRED', 'Keeper evidence access is loopback-only.');
      return;
    }
    const url = new URL(request.url ?? '/', 'http://keeper.local');
    if (url.search !== '') {
      reject(response, 404, 'NOT_FOUND', 'Route not found.');
      return;
    }
    if (url.pathname === KEEPER_DEPENDENCY_INCIDENT_STATUS_PATH) {
      if (request.method !== 'GET') {
        response.setHeader('Allow', 'GET');
        reject(response, 405, 'METHOD_NOT_ALLOWED', 'Only GET is allowed.');
        return;
      }
      if (ports.dependencyIncidents === undefined) {
        reject(response, 503, 'DEPENDENCY_INCIDENT_STATUS_DISABLED', 'Dependency incident status is unavailable.');
        return;
      }
      try {
        sendJson(response, 200, toProtocolJson(
          await ports.dependencyIncidents.current(),
          'keeper.dependencyIncidents.result',
        ));
      } catch {
        reject(response, 503, 'DEPENDENCY_INCIDENT_STATUS_UNAVAILABLE', 'Dependency incident status is unavailable.');
      }
      return;
    }
    if (url.pathname === KEEPER_TESTNET_PREPARE_PATH) {
      if (request.method !== 'POST') {
        response.setHeader('Allow', 'POST');
        reject(response, 405, 'METHOD_NOT_ALLOWED', 'Only POST is allowed.');
        return;
      }
      let raw: unknown;
      try {
        raw = await readProtocolJson(request, 'keeper.prepare.request');
      } catch (error) {
        if (error instanceof KeeperRequestError) {
          reject(response, 400, error.code, error.message);
          return;
        }
        reject(response, 400, 'INVALID_JSON', 'Request body must be strict protocol JSON.');
        return;
      }
      try {
        const input = parsePrepareRequest(raw);
        const result = await ports.runtime.prepare(input);
        sendJson(response, 200, toProtocolJson(result, 'keeper.prepare.result'));
      } catch (error) {
        if (error instanceof KeeperRequestError) {
          reject(response, 400, error.code, error.message);
          return;
        }
        reject(response, 400, 'INVALID_REQUEST', 'Prepare request failed closed.');
      }
      return;
    }
    if (url.pathname === KEEPER_TESTNET_RECONCILE_PATH) {
      if (request.method !== 'POST') {
        response.setHeader('Allow', 'POST');
        reject(response, 405, 'METHOD_NOT_ALLOWED', 'Only POST is allowed.');
        return;
      }
      let raw: unknown;
      try {
        raw = await readProtocolJson(request, 'keeper.reconcile.request');
      } catch (error) {
        if (error instanceof KeeperRequestError) {
          reject(response, 400, error.code, error.message);
          return;
        }
        reject(response, 400, 'INVALID_JSON', 'Request body must be strict protocol JSON.');
        return;
      }
      try {
        const parsed = parseReconcileRequest(raw);
        const result = await ports.runtime.reconcile(
          parsed.prepared,
          parsed.handoff,
          parsed.binding,
          parsed.window,
        );
        sendJson(response, 200, toProtocolJson(result, 'keeper.reconcile.result'));
      } catch (error) {
        if (error instanceof KeeperRequestError) {
          reject(response, 400, error.code, error.message);
          return;
        }
        reject(response, 400, 'INVALID_REQUEST', 'Reconcile request failed closed.');
      }
      return;
    }
    if (url.pathname === KEEPER_TESTNET_STRATEGY_RECONCILE_PATH) {
      if (request.method !== 'POST') {
        response.setHeader('Allow', 'POST');
        reject(response, 405, 'METHOD_NOT_ALLOWED', 'Only POST is allowed.');
        return;
      }
      if (ports.strategy === undefined) {
        reject(response, 503, 'STRATEGY_EVIDENCE_DISABLED', 'Strategy evidence is unavailable.');
        return;
      }
      let raw: unknown;
      try {
        raw = await readProtocolJson(request, 'keeper.strategy.reconcile.request');
      } catch (error) {
        if (error instanceof KeeperRequestError) {
          reject(response, 400, error.code, error.message);
          return;
        }
        reject(response, 400, 'INVALID_JSON', 'Request body must be strict protocol JSON.');
        return;
      }
      try {
        const result = await ports.strategy.collect(parseStrategyReconcileRequest(raw));
        sendJson(response, 200, toProtocolJson(result, 'keeper.strategy.reconcile.result'));
      } catch {
        reject(response, 400, 'INVALID_REQUEST', 'Strategy reconcile request failed closed.');
      }
      return;
    }
    if (url.pathname === KEEPER_TESTNET_NETTING_RESIDUAL_RECONCILE_PATH) {
      if (request.method !== 'POST') {
        response.setHeader('Allow', 'POST');
        reject(response, 405, 'METHOD_NOT_ALLOWED', 'Only POST is allowed.');
        return;
      }
      if (ports.nettingResidual === undefined) {
        reject(response, 503, 'NETTING_RESIDUAL_EVIDENCE_DISABLED',
          'Netting residual evidence is unavailable.');
        return;
      }
      let raw: unknown;
      try {
        raw = await readProtocolJson(request, 'keeper.netting-residual.reconcile.request');
      } catch (error) {
        if (error instanceof KeeperRequestError) {
          reject(response, 400, error.code, error.message);
          return;
        }
        reject(response, 400, 'INVALID_JSON', 'Request body must be strict protocol JSON.');
        return;
      }
      try {
        const result = await ports.nettingResidual.collect(
          parseNettingResidualReconcileRequest(raw),
        );
        sendJson(response, 200, toProtocolJson(result,
          'keeper.netting-residual.reconcile.result'));
      } catch {
        reject(response, 400, 'INVALID_REQUEST',
          'Netting residual reconcile request failed closed.');
      }
      return;
    }
    reject(response, 404, 'NOT_FOUND', 'Route not found.');
  };
}

export function createHyperliquidTestnetEvidenceServer(
  ports: HyperliquidTestnetEvidenceHttpPorts,
) {
  const handler = createHyperliquidTestnetEvidenceRequestHandler(ports);
  return createServer((request, response) => {
    handler(request, response).catch(() => {
      if (!response.headersSent) {
        reject(response, 500, 'INTERNAL_ERROR', 'Request handling failed.');
      } else {
        response.destroy();
      }
    });
  });
}
