import type {
  DomainRef,
  Hash32,
  PackageAdmission,
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
