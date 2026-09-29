import { getAddress, isAddress, zeroAddress, type Address, type Hex } from 'viem';

export const EVM_DEPLOYMENT_AUTHORITY_ROLES = [
  'UPGRADE',
  'ADMIN',
  'OWNER',
  'PAUSER',
  'PROPOSER',
  'EXECUTOR',
  'CANCELLER',
  'FUNDING',
  'BENEFICIARY',
] as const;

export type EvmDeploymentAuthorityRole = (typeof EVM_DEPLOYMENT_AUTHORITY_ROLES)[number];
export type EvmDeploymentActivationState =
  | 'ACTIVE'
  | 'ENTRY_PAUSED'
  | 'EXIT_ONLY'
  | 'ALL_PAUSED'
  | 'DEPRECATED';

export interface EvmDeploymentAuthorityBinding {
  readonly role: EvmDeploymentAuthorityRole;
  readonly authority: Address;
}

export interface EvmDeploymentCapPolicy {
  readonly activationState: EvmDeploymentActivationState;
  readonly entryCapAtoms: bigint;
  readonly exitCapAtoms: bigint;
  readonly preserveExitWhenDeprecated: boolean;
}

export type EvmDeploymentShapePolicy =
  | Readonly<{ kind: 'DIRECT' }>
  | Readonly<{
    kind: 'PROXY';
    proxyAdmin: Address;
    implementation: Address;
    proxyCodeHash: Hex;
    implementationCodeHash: Hex;
  }>;

export interface EvmDeploymentAuthorityPolicy {
  readonly chainReference: bigint;
  readonly subject: Address;
  readonly expectedCodeHash: Hex;
  readonly deploymentShape: EvmDeploymentShapePolicy;
  readonly requireImmutableVerifier: boolean;
  readonly authorities: readonly EvmDeploymentAuthorityBinding[];
  readonly forbiddenRoleCollisions: readonly Readonly<{
    left: EvmDeploymentAuthorityRole;
    right: EvmDeploymentAuthorityRole;
  }>[];
  readonly capPolicy: EvmDeploymentCapPolicy;
}

export interface EvmObservedDeploymentAuthorityEvidence {
  readonly subject: Address;
  readonly codeHash: Hex;
  readonly deploymentShape:
    | Readonly<{ kind: 'DIRECT' }>
    | Readonly<{
      kind: 'PROXY';
      proxyAdmin: Address;
      implementation: Address;
      proxyCodeHash: Hex;
      implementationCodeHash: Hex;
    }>;
  readonly verifierMutable: boolean;
  readonly authorities: readonly EvmDeploymentAuthorityBinding[];
  readonly activationState: EvmDeploymentActivationState;
  readonly entryCapAtoms: bigint;
  readonly exitCapAtoms: bigint;
  readonly observedBlock: bigint;
}

export interface EvmDeploymentAuthorityReadPort {
  chainId(): Promise<bigint>;
  readDeploymentAuthorityEvidence(subject: Address): Promise<EvmObservedDeploymentAuthorityEvidence | null>;
}

export interface QualifiedEvmDeploymentAuthority {
  readonly chainReference: bigint;
  readonly subject: Address;
  readonly codeHash: Hex;
  readonly authorities: readonly EvmDeploymentAuthorityBinding[];
  readonly activationState: EvmDeploymentActivationState;
  readonly entryCapAtoms: bigint;
  readonly exitCapAtoms: bigint;
  readonly observedBlock: bigint;
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function address(value: unknown, name: string): Address {
  requireCondition(typeof value === 'string' && isAddress(value, { strict: false }), `${name} must be an EVM address`);
  const normalized = getAddress(value);
  requireCondition(normalized !== zeroAddress, `${name} must be nonzero`);
  return normalized;
}

function hash(value: unknown, name: string): Hex {
  requireCondition(typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value), `${name} must be a lowercase 32-byte hash`);
  requireCondition(!/^0x0{64}$/.test(value), `${name} must be nonzero`);
  return value as Hex;
}

function atoms(value: bigint, name: string): bigint {
  requireCondition(typeof value === 'bigint' && value >= 0n, `${name} must be a nonnegative bigint`);
  return value;
}

function validateCaps(
  activationState: EvmDeploymentActivationState,
  entryCapAtoms: bigint,
  exitCapAtoms: bigint,
  preserveExitWhenDeprecated: boolean,
): void {
  const entry = atoms(entryCapAtoms, 'entry cap');
  const exit = atoms(exitCapAtoms, 'exit cap');
  if (activationState === 'ACTIVE') {
    requireCondition(entry > 0n && exit > 0n, 'ACTIVE deployment requires positive entry and exit caps');
  } else if (activationState === 'ENTRY_PAUSED' || activationState === 'EXIT_ONLY') {
    requireCondition(entry === 0n && exit > 0n, `${activationState} deployment must preserve exit capacity and disable entry`);
  } else if (activationState === 'ALL_PAUSED') {
    requireCondition(entry === 0n && exit === 0n, 'ALL_PAUSED deployment requires zero entry and exit caps');
  } else if (activationState === 'DEPRECATED') {
    requireCondition(entry === 0n, 'DEPRECATED deployment must disable entry');
    requireCondition(
      preserveExitWhenDeprecated ? exit > 0n : exit === 0n,
      preserveExitWhenDeprecated
        ? 'DEPRECATED deployment must preserve exit capacity'
        : 'DEPRECATED deployment must have zero exit capacity',
    );
  } else {
    throw new Error('deployment activation state is unrecognized');
  }
}

function authorityMap(
  bindings: readonly EvmDeploymentAuthorityBinding[],
  name: string,
): ReadonlyMap<EvmDeploymentAuthorityRole, Address> {
  requireCondition(Array.isArray(bindings) && bindings.length > 0, `${name} must not be empty`);
  const allowed = new Set<string>(EVM_DEPLOYMENT_AUTHORITY_ROLES);
  const mapped = new Map<EvmDeploymentAuthorityRole, Address>();
  for (const binding of bindings) {
    requireCondition(allowed.has(binding.role), `${name} contains an unrecognized role`);
    requireCondition(!mapped.has(binding.role), `${name} contains duplicate role ${binding.role}`);
    mapped.set(binding.role, address(binding.authority, `${binding.role} authority`));
  }
  return mapped;
}

function compareShape(policy: EvmDeploymentShapePolicy, observed: EvmObservedDeploymentAuthorityEvidence['deploymentShape']): void {
  requireCondition(policy.kind === observed.kind, 'deployment proxy shape mismatch');
  if (policy.kind === 'DIRECT' || observed.kind === 'DIRECT') return;
  requireCondition(
    address(observed.proxyAdmin, 'observed proxy admin') === address(policy.proxyAdmin, 'expected proxy admin'),
    'proxy admin mismatch',
  );
  requireCondition(
    address(observed.implementation, 'observed implementation') === address(policy.implementation, 'expected implementation'),
    'proxy implementation mismatch',
  );
  requireCondition(hash(observed.proxyCodeHash, 'observed proxy code hash') === hash(policy.proxyCodeHash, 'expected proxy code hash'), 'proxy code hash drift');
  requireCondition(
    hash(observed.implementationCodeHash, 'observed implementation code hash')
      === hash(policy.implementationCodeHash, 'expected implementation code hash'),
    'implementation code hash drift',
  );
}

export async function qualifyEvmDeploymentAuthority(
  policy: EvmDeploymentAuthorityPolicy,
  port: EvmDeploymentAuthorityReadPort,
): Promise<QualifiedEvmDeploymentAuthority> {
  requireCondition(typeof policy.chainReference === 'bigint' && policy.chainReference > 0n, 'chain reference must be positive');
  const subject = address(policy.subject, 'policy subject');
  const expectedCodeHash = hash(policy.expectedCodeHash, 'expected code hash');
  const expectedAuthorities = authorityMap(policy.authorities, 'authority policy');
  validateCaps(
    policy.capPolicy.activationState,
    policy.capPolicy.entryCapAtoms,
    policy.capPolicy.exitCapAtoms,
    policy.capPolicy.preserveExitWhenDeprecated,
  );

  requireCondition(await port.chainId() === policy.chainReference, 'observed chain ID does not match authority policy');
  const observed = await port.readDeploymentAuthorityEvidence(subject);
  requireCondition(observed !== null, 'deployment authority evidence is missing');
  requireCondition(address(observed.subject, 'observed subject') === subject, 'deployment authority subject mismatch');
  requireCondition(hash(observed.codeHash, 'observed code hash') === expectedCodeHash, 'deployment code hash drift');
  compareShape(policy.deploymentShape, observed.deploymentShape);
  requireCondition(!(policy.requireImmutableVerifier && observed.verifierMutable), 'deployment verifier is mutable');

  const observedAuthorities = authorityMap(observed.authorities, 'observed authorities');
  requireCondition(observedAuthorities.size === expectedAuthorities.size, 'observed authority role set mismatch');
  for (const [role, expected] of expectedAuthorities) {
    requireCondition(observedAuthorities.get(role) === expected, `unexpected ${role.toLowerCase()} authority`);
  }
  for (const collision of policy.forbiddenRoleCollisions) {
    requireCondition(collision.left !== collision.right, 'forbidden collision must name two different roles');
    const left = observedAuthorities.get(collision.left);
    const right = observedAuthorities.get(collision.right);
    requireCondition(left !== undefined && right !== undefined, 'forbidden collision names an absent role');
    requireCondition(left !== right, `${collision.left} and ${collision.right} authorities must be separated`);
  }

  requireCondition(observed.activationState === policy.capPolicy.activationState, 'deployment activation state mismatch');
  requireCondition(atoms(observed.entryCapAtoms, 'observed entry cap') === policy.capPolicy.entryCapAtoms, 'deployment entry cap mismatch');
  requireCondition(atoms(observed.exitCapAtoms, 'observed exit cap') === policy.capPolicy.exitCapAtoms, 'deployment exit cap mismatch');
  validateCaps(
    observed.activationState,
    observed.entryCapAtoms,
    observed.exitCapAtoms,
    policy.capPolicy.preserveExitWhenDeprecated,
  );
  requireCondition(typeof observed.observedBlock === 'bigint' && observed.observedBlock >= 0n, 'observed block is invalid');

  return Object.freeze({
    chainReference: policy.chainReference,
    subject,
    codeHash: expectedCodeHash,
    authorities: Object.freeze(policy.authorities.map((binding) => Object.freeze({
      role: binding.role,
      authority: expectedAuthorities.get(binding.role)!,
    }))),
    activationState: observed.activationState,
    entryCapAtoms: observed.entryCapAtoms,
    exitCapAtoms: observed.exitCapAtoms,
    observedBlock: observed.observedBlock,
  });
}
