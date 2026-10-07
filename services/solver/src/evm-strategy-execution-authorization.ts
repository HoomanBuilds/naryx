import {
  encodeEvmMultiStrategyAccountExecution,
  isCanonicalEvmSignature,
} from '@naryx/adapter-evm';
import {
  bytesEqual,
  protocolId,
  strategyPackageQuoteHash,
  type DomainRef,
  type Hash32,
} from '@naryx/protocol-types';
import {
  getAddress,
  keccak256,
  recoverTypedDataAddress,
  stringToHex,
  type Address,
  type Hex,
  type LocalAccount,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { StrategyPackageProvider } from './http-strategy-package-provider.js';
import type { StrategyPreparationService } from './strategy-preparation-service.js';

const TEST_CHAIN_IDS = new Set([84_532, 421_614, 31_337, 31_338]);
const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;

export interface AuthorizedEvmStrategyExecution {
  readonly version: 1;
  readonly domain: DomainRef;
  readonly chainId: number;
  readonly owner: Address;
  readonly to: Address;
  readonly value: 0n;
  readonly data: Hex;
  readonly ownerSignature: Hex;
  readonly solverSignature: Hex;
  readonly packageId: Hex;
  readonly orderHash: Hex;
  readonly quoteHash: Hex;
  readonly routeHash: Hex;
  readonly expectedNextStateHash: Hex;
  readonly deadline: bigint;
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`EVM strategy authorization refused: ${message}`);
}

function hex(bytes: Uint8Array): Hex {
  return `0x${Buffer.from(bytes).toString('hex')}`;
}

export function loadEvmStrategySolverKey(path: string | undefined, expectedAddress: string | undefined): LocalAccount {
  if (path === undefined || !isAbsolute(path)) {
    throw new Error('NARYX_EVM_STRATEGY_SOLVER_KEY_PATH must be an absolute path');
  }
  const status = lstatSync(path);
  if (status.isSymbolicLink() || !status.isFile() || realpathSync(path) !== path
    || (status.mode & 0o077) !== 0 || status.size < 1 || status.size > 512
    || (typeof process.getuid === 'function' && status.uid !== process.getuid())) {
    throw new Error('EVM strategy solver key must be a canonical owner-only regular file');
  }
  const record = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'environment,privateKey,version' || record.version !== 1
    || record.environment !== 'EVM_TESTNET' || typeof record.privateKey !== 'string'
    || !PRIVATE_KEY.test(record.privateKey) || /^0x0+$/.test(record.privateKey)) {
    throw new Error('EVM strategy solver key file fields are invalid');
  }
  const account = privateKeyToAccount(record.privateKey as Hex);
  if (expectedAddress === undefined || account.address.toLowerCase() !== expectedAddress.toLowerCase()) {
    throw new Error('EVM strategy solver key does not match NARYX_EVM_STRATEGY_SOLVER_ADDRESS');
  }
  return account;
}

export class EvmStrategyExecutionAuthorizationService {
  readonly #packages: Pick<StrategyPackageProvider, 'getByQuote'>;
  readonly #preparations: Pick<StrategyPreparationService, 'prepareDocuments'>;
  readonly #solver: LocalAccount;

  constructor(input: Readonly<{
    packages: Pick<StrategyPackageProvider, 'getByQuote'>;
    preparations: Pick<StrategyPreparationService, 'prepareDocuments'>;
    solver: LocalAccount;
  }>) {
    this.#packages = input.packages;
    this.#preparations = input.preparations;
    this.#solver = input.solver;
  }

  async authorize(input: Readonly<{
    quoteHash: Hash32;
    ownerSignature: Hex;
    domainId?: string;
  }>): Promise<AuthorizedEvmStrategyExecution | undefined> {
    requireCondition(isCanonicalEvmSignature(input.ownerSignature), 'owner signature is not canonical ECDSA');
    const documents = await this.#packages.getByQuote(input.quoteHash);
    if (documents === undefined) return undefined;
    requireCondition(bytesEqual(strategyPackageQuoteHash(documents.quote), input.quoteHash), 'quote provider returned another package');
    const prepared = await this.#preparations.prepareDocuments(documents);
    const singleDomain = prepared.settlementClass === 'ATOMIC_POSTCONDITION'
      && prepared.coordination === 'SINGLE_DOMAIN_ATOMIC'
      && prepared.domains.length === 1;
    const crossDomain = prepared.settlementClass === 'CROSS_DOMAIN_PREPOSITIONED'
      && prepared.coordination === 'CROSS_DOMAIN_PREPOSITIONED'
      && prepared.crossDomainPlanHash !== undefined
      && prepared.domains.length >= 2;
    requireCondition(singleDomain || crossDomain, 'package is not an atomic or prepositioned EVM execution');
    const requestedDomainId = input.domainId === undefined
      ? undefined
      : protocolId(input.domainId, 'domainId');
    requireCondition(!crossDomain || requestedDomainId !== undefined,
      'cross-domain authorization requires an exact domain ID');
    const matches = prepared.domains.filter((candidate) => candidate.kind === 'EVM_MULTI_STRATEGY_ACCOUNT'
      && (requestedDomainId === undefined || candidate.domain.domainId === requestedDomainId));
    requireCondition(matches.length === 1, 'prepared package does not resolve to exactly one EVM strategy account execution');
    const domainExecution = matches[0]!;
    requireCondition(domainExecution.kind === 'EVM_MULTI_STRATEGY_ACCOUNT', 'prepared package is not an EVM strategy account execution');
    requireCondition(domainExecution.routeSettlementClass === (crossDomain ? 'CROSS_DOMAIN_PREPOSITIONED' : 'ATOMIC_POSTCONDITION'),
      'prepared domain settlement class differs from the package');
    const envelope = domainExecution.envelope;
    requireCondition(TEST_CHAIN_IDS.has(envelope.ownerTypedData.domain.chainId)
      && envelope.ownerTypedData.domain.chainId === envelope.solverTypedData.domain.chainId,
    'execution chain is not an allowed test chain');
    requireCondition(domainExecution.domain.domainId === `eip155:${envelope.ownerTypedData.domain.chainId}`
      && envelope.execution.domainIdHash === keccak256(stringToHex(domainExecution.domain.domainId))
      && envelope.execution.domainManifestVersion === domainExecution.domain.domainManifestVersion
      && envelope.execution.domainManifestHash === hex(domainExecution.domain.domainManifestHash),
    'prepared execution domain identity is inconsistent');
    requireCondition(getAddress(envelope.execution.solver) === this.#solver.address,
      'prepared solver differs from the configured signing account');
    const recovered = await recoverTypedDataAddress({
      domain: envelope.ownerTypedData.domain,
      types: envelope.ownerTypedData.types,
      primaryType: envelope.ownerTypedData.primaryType,
      message: envelope.ownerTypedData.message,
      signature: input.ownerSignature,
    });
    requireCondition(recovered.toLowerCase() === documents.order.owner.toLowerCase(),
      'owner signature does not authorize the prepared package');
    const solverSignature = await this.#solver.signTypedData({
      domain: envelope.solverTypedData.domain,
      types: envelope.solverTypedData.types,
      primaryType: envelope.solverTypedData.primaryType,
      message: envelope.solverTypedData.message,
    });
    requireCondition(isCanonicalEvmSignature(solverSignature), 'solver produced a noncanonical signature');
    const data = encodeEvmMultiStrategyAccountExecution({
      envelope,
      ownerSignature: input.ownerSignature,
      solverSignature,
    });
    return Object.freeze({
      version: 1,
      domain: domainExecution.domain,
      chainId: envelope.ownerTypedData.domain.chainId,
      owner: getAddress(documents.order.owner),
      to: envelope.account,
      value: 0n,
      data,
      ownerSignature: input.ownerSignature,
      solverSignature,
      packageId: envelope.execution.packageId,
      orderHash: hex(prepared.orderHash),
      quoteHash: hex(prepared.quoteHash),
      routeHash: hex(prepared.routeHash),
      expectedNextStateHash: envelope.execution.nextStateHash,
      deadline: envelope.execution.deadline,
    });
  }
}
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
