import { commitmentHash, fromProtocolJson, toHex } from '@naryx/protocol-types';
import { PublicKey } from '@solana/web3.js';

const MAX_RESPONSE_BYTES = 262_144;
const STEP_KINDS = new Set([
  'CREATE_STRATEGY_ACCOUNT', 'CREATE_TOKEN_ACCOUNTS', 'CREATE_PACKAGE_INVENTORY', 'WRAP_INVENTORY',
  'FUND_INVENTORY', 'CREATE_PERP_POSITION', 'DELEGATE_PERP_POSITION', 'CREATE_PERP_STRATEGY',
  'DEPOSIT_PERP_COLLATERAL',
]);

export type SolanaTreasuryHedgeProvisioningPlan = Readonly<{
  version: 1;
  domainId: 'svm:devnet';
  owner: string;
  packageId: string;
  strategyAccount: string;
  ready: boolean;
  inventoryFundingRequiredAtoms: bigint;
  quoteFundingRequiredAtoms: bigint;
  steps: readonly Readonly<{
    kind: string;
    label: string;
    instructions: readonly Readonly<{
      programId: string;
      accounts: readonly Readonly<{ pubkey: string; isSigner: boolean; isWritable: boolean }>[];
      dataBase64: string;
    }>[];
  }>[];
}>;

export interface SolanaTreasuryHedgeProvisioningPort {
  provision(orderHashHex: string): Promise<SolanaTreasuryHedgeProvisioningPlan>;
}

export class SolanaTreasuryHedgeProvisioningClientError extends Error {
  readonly code: 'INVALID_ENDPOINT' | 'INVALID_REQUEST' | 'NOT_FOUND' | 'UPSTREAM_REJECTED' | 'INVALID_RESPONSE';

  constructor(code: SolanaTreasuryHedgeProvisioningClientError['code'], message: string) {
    super(message);
    this.name = 'SolanaTreasuryHedgeProvisioningClientError';
    this.code = code;
  }
}

function loopbackOrigin(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new SolanaTreasuryHedgeProvisioningClientError('INVALID_ENDPOINT', 'provisioning endpoint must be an absolute URL');
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || url.hostname.startsWith('127.');
  if (url.protocol !== 'http:' || !loopback || url.username !== '' || url.password !== ''
    || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new SolanaTreasuryHedgeProvisioningClientError('INVALID_ENDPOINT', 'provisioning endpoint must be a loopback HTTP origin');
  }
  return url.origin;
}

function address(value: unknown, context: string, rejectDefault = false): string {
  try {
    const checked = new PublicKey(String(value));
    if ((rejectDefault && checked.equals(PublicKey.default)) || checked.toBase58() !== value) throw new Error();
    return checked.toBase58();
  } catch {
    throw new SolanaTreasuryHedgeProvisioningClientError('INVALID_RESPONSE', `${context} is invalid`);
  }
}

async function responseJson(response: Response): Promise<unknown> {
  if (response.headers.get('content-type')?.split(';', 1)[0]?.trim() !== 'application/json' || response.body === null) {
    throw new SolanaTreasuryHedgeProvisioningClientError('INVALID_RESPONSE', 'provisioning response must be JSON');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    length += item.value.length;
    if (length > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new SolanaTreasuryHedgeProvisioningClientError('INVALID_RESPONSE', 'provisioning response is too large');
    }
    chunks.push(item.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return fromProtocolJson(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  } catch {
    throw new SolanaTreasuryHedgeProvisioningClientError('INVALID_RESPONSE', 'provisioning response is malformed');
  }
}

function plan(value: unknown, expectedOrderHash: string): SolanaTreasuryHedgeProvisioningPlan {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SolanaTreasuryHedgeProvisioningClientError('INVALID_RESPONSE', 'provisioning response must be an object');
  }
  const root = value as Record<string, unknown>;
  if (Object.keys(root).sort().join(',') !== 'provisioning,version' || root.version !== 1
    || typeof root.provisioning !== 'object' || root.provisioning === null || Array.isArray(root.provisioning)) {
    throw new SolanaTreasuryHedgeProvisioningClientError('INVALID_RESPONSE', 'provisioning response fields are invalid');
  }
  const candidate = root.provisioning as Record<string, unknown>;
  if (candidate.version !== 1 || candidate.domainId !== 'svm:devnet' || candidate.packageId !== expectedOrderHash
    || typeof candidate.ready !== 'boolean' || typeof candidate.inventoryFundingRequiredAtoms !== 'bigint'
    || candidate.inventoryFundingRequiredAtoms < 0n || typeof candidate.quoteFundingRequiredAtoms !== 'bigint'
    || candidate.quoteFundingRequiredAtoms < 0n || !Array.isArray(candidate.steps)) {
    throw new SolanaTreasuryHedgeProvisioningClientError('INVALID_RESPONSE', 'provisioning plan identity is invalid');
  }
  address(candidate.owner, 'provisioning owner', true);
  address(candidate.strategyAccount, 'strategy account', true);
  for (const stepValue of candidate.steps) {
    if (typeof stepValue !== 'object' || stepValue === null || Array.isArray(stepValue)) {
      throw new SolanaTreasuryHedgeProvisioningClientError('INVALID_RESPONSE', 'provisioning step is invalid');
    }
    const step = stepValue as Record<string, unknown>;
    if (!STEP_KINDS.has(String(step.kind)) || typeof step.label !== 'string' || step.label.length === 0
      || !Array.isArray(step.instructions) || step.instructions.length === 0) {
      throw new SolanaTreasuryHedgeProvisioningClientError('INVALID_RESPONSE', 'provisioning step fields are invalid');
    }
    for (const instructionValue of step.instructions) {
      if (typeof instructionValue !== 'object' || instructionValue === null || Array.isArray(instructionValue)) {
        throw new SolanaTreasuryHedgeProvisioningClientError('INVALID_RESPONSE', 'provisioning instruction is invalid');
      }
      const instruction = instructionValue as Record<string, unknown>;
      address(instruction.programId, 'provisioning program');
      if (typeof instruction.dataBase64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(instruction.dataBase64)
        || !Array.isArray(instruction.accounts) || instruction.accounts.length === 0) {
        throw new SolanaTreasuryHedgeProvisioningClientError('INVALID_RESPONSE', 'provisioning instruction fields are invalid');
      }
      for (const accountValue of instruction.accounts) {
        if (typeof accountValue !== 'object' || accountValue === null || Array.isArray(accountValue)) {
          throw new SolanaTreasuryHedgeProvisioningClientError('INVALID_RESPONSE', 'provisioning account is invalid');
        }
        const account = accountValue as Record<string, unknown>;
        address(account.pubkey, 'provisioning account');
        if (typeof account.isSigner !== 'boolean' || typeof account.isWritable !== 'boolean') {
          throw new SolanaTreasuryHedgeProvisioningClientError('INVALID_RESPONSE', 'provisioning account flags are invalid');
        }
      }
    }
  }
  if (candidate.ready !== (candidate.steps.length === 0
    && candidate.inventoryFundingRequiredAtoms === 0n && candidate.quoteFundingRequiredAtoms === 0n)) {
    throw new SolanaTreasuryHedgeProvisioningClientError('INVALID_RESPONSE', 'provisioning readiness is inconsistent');
  }
  return root.provisioning as unknown as SolanaTreasuryHedgeProvisioningPlan;
}

export class HttpSolanaTreasuryHedgeProvisioningClient implements SolanaTreasuryHedgeProvisioningPort {
  readonly #origin: string;
  readonly #fetch: typeof fetch;

  constructor(endpoint: string, fetchImplementation: typeof fetch = fetch) {
    this.#origin = loopbackOrigin(endpoint);
    this.#fetch = fetchImplementation;
  }

  async provision(orderHashHex: string): Promise<SolanaTreasuryHedgeProvisioningPlan> {
    let normalized: string;
    try {
      normalized = toHex(commitmentHash(orderHashHex, 'orderHash'));
    } catch {
      throw new SolanaTreasuryHedgeProvisioningClientError('INVALID_REQUEST', 'orderHash must be 32 bytes of lowercase hex');
    }
    if (normalized !== orderHashHex) {
      throw new SolanaTreasuryHedgeProvisioningClientError('INVALID_REQUEST', 'orderHash must be lowercase hex');
    }
    const response = await this.#fetch(`${this.#origin}/internal/strategy-executions/solana-provision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderHash: orderHashHex }),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 404) throw new SolanaTreasuryHedgeProvisioningClientError('NOT_FOUND', 'Strategy order was not found');
    if (!response.ok) throw new SolanaTreasuryHedgeProvisioningClientError('UPSTREAM_REJECTED', `provisioning failed with HTTP ${response.status}`);
    return plan(await responseJson(response), orderHashHex);
  }
}
