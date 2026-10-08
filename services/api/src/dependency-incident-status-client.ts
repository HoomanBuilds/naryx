const STATUS_PATH = '/internal/keeper/dependency-incidents';
const MAX_RESPONSE_BYTES = 262_144;
const HEX_32 = /^0x[0-9a-f]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const DOMAIN_ID = /^[a-z0-9]+:[A-Za-z0-9._-]{1,64}$/;
const STATES = new Set([
  'ACTIVE',
  'ENTRY_PAUSED',
  'EXIT_ONLY',
  'ALL_PAUSED',
  'QUARANTINED',
  'INCIDENT_REVIEW',
]);

export type DependencyIncidentState =
  | 'ACTIVE'
  | 'ENTRY_PAUSED'
  | 'EXIT_ONLY'
  | 'ALL_PAUSED'
  | 'QUARANTINED'
  | 'INCIDENT_REVIEW';

export interface DependencyIncidentScopeStatus {
  readonly scopeId: string;
  readonly scopeHash: `0x${string}`;
  readonly domainId: string;
  readonly state: DependencyIncidentState;
  readonly entryAllowed: boolean;
  readonly exitAllowed: boolean;
  readonly revision: string;
  readonly evidenceCommitment: `0x${string}`;
  readonly evidenceObservedAtMs: string;
  readonly evidenceValidUntilMs: string;
  readonly evidenceFresh: boolean;
  readonly latestReceiptHash: `0x${string}` | null;
}

export interface DependencyIncidentStatusSnapshot {
  readonly version: 1;
  readonly observedAtMs: number;
  readonly configuredScopeCount: number;
  readonly unavailableScopeCount: number;
  readonly scopes: readonly DependencyIncidentScopeStatus[];
}

export interface DependencyIncidentStatusPort {
  current(): Promise<DependencyIncidentStatusSnapshot>;
}

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], name: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${name} fields are invalid.`);
  }
}

function safeInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}

function hash(value: unknown, name: string): `0x${string}` {
  if (typeof value !== 'string' || !HEX_32.test(value)) throw new Error(`${name} is invalid.`);
  return value as `0x${string}`;
}

function decimal(value: unknown, name: string): string {
  if (typeof value !== 'string' || !DECIMAL.test(value)) throw new Error(`${name} is invalid.`);
  return value;
}

export function parseDependencyIncidentStatus(value: unknown): DependencyIncidentStatusSnapshot {
  if (!isRecord(value)) throw new Error('Dependency incident status is invalid.');
  exactKeys(
    value,
    ['version', 'observedAtMs', 'configuredScopeCount', 'unavailableScopeCount', 'scopes'],
    'Dependency incident status',
  );
  if (value.version !== 1 || !Array.isArray(value.scopes)) {
    throw new Error('Dependency incident status is invalid.');
  }
  const configuredScopeCount = safeInteger(value.configuredScopeCount, 'Configured incident scope count');
  const unavailableScopeCount = safeInteger(value.unavailableScopeCount, 'Unavailable incident scope count');
  if (value.scopes.length + unavailableScopeCount !== configuredScopeCount) {
    throw new Error('Dependency incident scope counts are inconsistent.');
  }
  const scopeHashes = new Set<string>();
  const scopes = value.scopes.map((entry, index): DependencyIncidentScopeStatus => {
    if (!isRecord(entry)) throw new Error(`Dependency incident scope ${index} is invalid.`);
    exactKeys(entry, [
      'scopeId', 'scopeHash', 'domainId', 'state', 'entryAllowed', 'exitAllowed', 'revision',
      'evidenceCommitment', 'evidenceObservedAtMs', 'evidenceValidUntilMs', 'evidenceFresh',
      'latestReceiptHash',
    ], `Dependency incident scope ${index}`);
    const scopeHash = hash(entry.scopeHash, `Dependency incident scope ${index} hash`);
    if (scopeHashes.has(scopeHash)) throw new Error('Dependency incident scope is duplicated.');
    scopeHashes.add(scopeHash);
    if (typeof entry.state !== 'string' || !STATES.has(entry.state) ||
        typeof entry.entryAllowed !== 'boolean' || typeof entry.exitAllowed !== 'boolean' ||
        typeof entry.evidenceFresh !== 'boolean') {
      throw new Error(`Dependency incident scope ${index} permissions are invalid.`);
    }
    if (entry.entryAllowed !== (entry.state === 'ACTIVE')) {
      throw new Error(`Dependency incident scope ${index} entry permission is inconsistent.`);
    }
    const evidenceObservedAtMs = decimal(
      entry.evidenceObservedAtMs,
      `Dependency incident scope ${index} evidence time`,
    );
    const evidenceValidUntilMs = decimal(
      entry.evidenceValidUntilMs,
      `Dependency incident scope ${index} evidence expiry`,
    );
    if (BigInt(evidenceValidUntilMs) <= BigInt(evidenceObservedAtMs)) {
      throw new Error(`Dependency incident scope ${index} evidence window is invalid.`);
    }
    return Object.freeze({
      scopeId: text(entry.scopeId, `Dependency incident scope ${index} id`),
      scopeHash,
      domainId: (() => {
        const domainId = text(entry.domainId, `Dependency incident scope ${index} domain`);
        if (!DOMAIN_ID.test(domainId)) throw new Error(`Dependency incident scope ${index} domain is invalid.`);
        return domainId;
      })(),
      state: entry.state as DependencyIncidentState,
      entryAllowed: entry.entryAllowed,
      exitAllowed: entry.exitAllowed,
      revision: decimal(entry.revision, `Dependency incident scope ${index} revision`),
      evidenceCommitment: hash(
        entry.evidenceCommitment,
        `Dependency incident scope ${index} evidence commitment`,
      ),
      evidenceObservedAtMs,
      evidenceValidUntilMs,
      evidenceFresh: entry.evidenceFresh,
      latestReceiptHash: entry.latestReceiptHash === null
        ? null
        : hash(entry.latestReceiptHash, `Dependency incident scope ${index} receipt hash`),
    });
  });
  return Object.freeze({
    version: 1,
    observedAtMs: safeInteger(value.observedAtMs, 'Dependency incident status time'),
    configuredScopeCount,
    unavailableScopeCount,
    scopes: Object.freeze(scopes),
  });
}

function loopbackOrigin(value: string): string {
  const url = new URL(value);
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || url.hostname.startsWith('127.');
  if (url.protocol !== 'http:' || !loopback || url.username !== '' || url.password !== '' ||
      url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error('NARYX_KEEPER_STATUS_ORIGIN must be a loopback HTTP origin.');
  }
  return url.origin;
}

export class HttpDependencyIncidentStatusClient implements DependencyIncidentStatusPort {
  readonly #origin: string;
  readonly #fetch: FetchLike;

  constructor(origin: string, fetchImplementation: FetchLike = globalThis.fetch) {
    this.#origin = loopbackOrigin(origin);
    this.#fetch = fetchImplementation;
  }

  async current(): Promise<DependencyIncidentStatusSnapshot> {
    const response = await this.#fetch(`${this.#origin}${STATUS_PATH}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) throw new Error('Keeper dependency incident status is unavailable.');
    const body = await response.text();
    if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) {
      throw new Error('Keeper dependency incident status is too large.');
    }
    try {
      return parseDependencyIncidentStatus(JSON.parse(body) as unknown);
    } catch {
      throw new Error('Keeper dependency incident status is invalid.');
    }
  }
}

export function loadDependencyIncidentStatusClient(
  environment: NodeJS.ProcessEnv,
  fetchImplementation: FetchLike = globalThis.fetch,
): HttpDependencyIncidentStatusClient | undefined {
  const origin = environment.NARYX_KEEPER_STATUS_ORIGIN;
  return origin === undefined || origin === ''
    ? undefined
    : new HttpDependencyIncidentStatusClient(origin, fetchImplementation);
}
