import type {
  AdmittedStrategyPackage,
  DomainRef,
  Hash32,
  PackageAdmission,
  TypedStrategyRoute,
} from '@naryx/protocol-types';

export interface CompiledExecution<TPayload> {
  readonly domain: DomainRef;
  readonly orderHash: Hash32;
  readonly quoteHash: Hash32;
  readonly routeHash: Hash32;
  readonly payload: TPayload;
}

export interface SimulationEvidence {
  readonly succeeded: boolean;
  readonly error?: string;
  readonly logs: readonly string[];
  readonly resourceUnits?: bigint;
}

export interface ExecutionEvidence<TReceipt> {
  readonly executionReference: string;
  readonly domain: DomainRef;
  readonly orderHash: Hash32;
  readonly quoteHash: Hash32;
  readonly routeHash: Hash32;
  readonly receipt: TReceipt;
}

export interface ExecutionAdapter<TPayload, TReceipt> {
  compile(admission: PackageAdmission): Promise<CompiledExecution<TPayload>>;
  simulate(compiled: CompiledExecution<TPayload>): Promise<SimulationEvidence>;
  readEvidence(
    executionReference: string,
    admission: PackageAdmission,
  ): Promise<ExecutionEvidence<TReceipt> | null>;
}

export interface CompiledStrategyExecution<TPayload> {
  readonly domains: readonly DomainRef[];
  readonly orderHash: Hash32;
  readonly graphHash: Hash32;
  readonly quoteHash: Hash32;
  readonly routeHash: Hash32;
  readonly payload: TPayload;
}

export interface StrategyExecutionEvidence<TReceipt> {
  readonly executionReference: string;
  readonly domains: readonly DomainRef[];
  readonly orderHash: Hash32;
  readonly graphHash: Hash32;
  readonly quoteHash: Hash32;
  readonly routeHash: Hash32;
  readonly receipt: TReceipt;
}

export interface StrategyExecutionAdapter<TPayload, TReceipt> {
  compile(
    admission: AdmittedStrategyPackage,
    route: TypedStrategyRoute,
  ): Promise<CompiledStrategyExecution<TPayload>>;
  simulate(compiled: CompiledStrategyExecution<TPayload>): Promise<SimulationEvidence>;
  readEvidence(
    executionReference: string,
    admission: AdmittedStrategyPackage,
    route: TypedStrategyRoute,
  ): Promise<StrategyExecutionEvidence<TReceipt> | null>;
}

export {
  LOCAL_ATOMIC_MARKET_CATALOG_V1,
  localConformanceSlot,
  parseLocalAtomicMarketCatalog,
  type LocalAtomicMarketCatalog,
} from './local-atomic-market-catalog.js';

export {
  createSolanaLocalEnvironmentManifest,
  createSolanaLocalEnvironmentManifestJson,
  deriveSolanaLocalRuntime,
  parseSolanaLocalEnvironmentManifest,
  validateSolanaLocalRpcSnapshot,
  type SolanaLocalEnvironmentManifest,
  type SolanaLocalManifestFacts,
  type SolanaLocalProgramIdentity,
  type SolanaLocalRpcSnapshot,
} from './solana-local-environment.js';
