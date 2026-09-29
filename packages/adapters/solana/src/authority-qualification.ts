import { PublicKey } from '@solana/web3.js';
import { SOLANA_UPGRADEABLE_LOADER_ID } from './deployment-identity.js';

export const SOLANA_DEPLOYMENT_AUTHORITY_ROLES = [
  'ADMIN',
  'OWNER',
  'PAUSER',
  'PROPOSER',
  'EXECUTOR',
  'CANCELLER',
  'FUNDING',
  'BENEFICIARY',
] as const;

export type SolanaDeploymentAuthorityRole = (typeof SOLANA_DEPLOYMENT_AUTHORITY_ROLES)[number];
export type SolanaDeploymentActivationState =
  | 'ACTIVE'
  | 'ENTRY_PAUSED'
  | 'EXIT_ONLY'
  | 'ALL_PAUSED'
  | 'DEPRECATED';

export interface SolanaDeploymentAuthorityBinding {
  readonly role: SolanaDeploymentAuthorityRole;
  readonly authority: PublicKey | string;
}

export interface SolanaDeploymentCapPolicy {
  readonly activationState: SolanaDeploymentActivationState;
  readonly entryCapAtoms: bigint;
  readonly exitCapAtoms: bigint;
  readonly preserveExitWhenDeprecated: boolean;
}

export interface SolanaDeploymentAuthorityPolicy {
  readonly programId: PublicKey | string;
  readonly programDataAddress: PublicKey | string;
  readonly expectedLoader: PublicKey | string;
  readonly expectedDeployedCodeSha256: string;
  readonly requireImmutableVerifier: boolean;
  readonly upgradeAuthority: PublicKey | string | null;
  readonly authorities: readonly SolanaDeploymentAuthorityBinding[];
  readonly forbiddenRoleCollisions: readonly Readonly<{
    left: SolanaDeploymentAuthorityRole;
    right: SolanaDeploymentAuthorityRole;
  }>[];
  readonly capPolicy: SolanaDeploymentCapPolicy;
}

export interface SolanaObservedDeploymentAuthorityEvidence {
  readonly programId: PublicKey | string;
  readonly programOwner: PublicKey | string;
  readonly executable: boolean;
  readonly linkedProgramDataAddress: PublicKey | string;
  readonly programDataAddress: PublicKey | string;
  readonly programDataOwner: PublicKey | string;
  readonly programDataExecutable: boolean;
  readonly deployedCodeSha256: string;
  readonly upgradeAuthority: PublicKey | string | null;
  readonly authorities: readonly SolanaDeploymentAuthorityBinding[];
  readonly activationState: SolanaDeploymentActivationState;
  readonly entryCapAtoms: bigint;
  readonly exitCapAtoms: bigint;
  readonly contextSlot: number;
}

export interface SolanaDeploymentAuthorityReadPort {
  readDeploymentAuthorityEvidence(programId: PublicKey): Promise<SolanaObservedDeploymentAuthorityEvidence | null>;
}

export interface QualifiedSolanaDeploymentAuthority {
  readonly programId: PublicKey;
  readonly programDataAddress: PublicKey;
  readonly deployedCodeSha256: string;
  readonly upgradeAuthority: PublicKey | null;
  readonly authorities: readonly Readonly<{ role: SolanaDeploymentAuthorityRole; authority: PublicKey }>[];
  readonly activationState: SolanaDeploymentActivationState;
  readonly entryCapAtoms: bigint;
  readonly exitCapAtoms: bigint;
  readonly contextSlot: number;
}

function requireCondition(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function publicKey(value: PublicKey | string, name: string): PublicKey {
  try {
    const checked = value instanceof PublicKey ? value : new PublicKey(value);
    requireCondition(value instanceof PublicKey || checked.toBase58() === value, `${name} must be canonical base58`);
    return checked;
  } catch {
    throw new Error(`${name} must be a Solana public key`);
  }
}

function sha256(value: string, name: string): string {
  requireCondition(/^[0-9a-f]{64}$/.test(value), `${name} must be lowercase SHA-256 hex`);
  requireCondition(!/^0{64}$/.test(value), `${name} must be nonzero`);
  return value;
}

function atoms(value: bigint, name: string): bigint {
  requireCondition(typeof value === 'bigint' && value >= 0n, `${name} must be a nonnegative bigint`);
  return value;
}

function validateCaps(
  state: SolanaDeploymentActivationState,
  entryCapAtoms: bigint,
  exitCapAtoms: bigint,
  preserveExitWhenDeprecated: boolean,
): void {
  const entry = atoms(entryCapAtoms, 'entry cap');
  const exit = atoms(exitCapAtoms, 'exit cap');
  if (state === 'ACTIVE') {
    requireCondition(entry > 0n && exit > 0n, 'ACTIVE deployment requires positive entry and exit caps');
  } else if (state === 'ENTRY_PAUSED' || state === 'EXIT_ONLY') {
    requireCondition(entry === 0n && exit > 0n, `${state} deployment must preserve exit capacity and disable entry`);
  } else if (state === 'ALL_PAUSED') {
    requireCondition(entry === 0n && exit === 0n, 'ALL_PAUSED deployment requires zero entry and exit caps');
  } else if (state === 'DEPRECATED') {
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
  bindings: readonly SolanaDeploymentAuthorityBinding[],
  name: string,
): ReadonlyMap<SolanaDeploymentAuthorityRole, PublicKey> {
  requireCondition(Array.isArray(bindings) && bindings.length > 0, `${name} must not be empty`);
  const allowed = new Set<string>(SOLANA_DEPLOYMENT_AUTHORITY_ROLES);
  const mapped = new Map<SolanaDeploymentAuthorityRole, PublicKey>();
  for (const binding of bindings) {
    requireCondition(allowed.has(binding.role), `${name} contains an unrecognized role`);
    requireCondition(!mapped.has(binding.role), `${name} contains duplicate role ${binding.role}`);
    mapped.set(binding.role, publicKey(binding.authority, `${binding.role} authority`));
  }
  return mapped;
}

function sameKey(left: PublicKey, right: PublicKey): boolean {
  return left.equals(right);
}

export async function qualifySolanaDeploymentAuthority(
  policy: SolanaDeploymentAuthorityPolicy,
  port: SolanaDeploymentAuthorityReadPort,
): Promise<QualifiedSolanaDeploymentAuthority> {
  const programId = publicKey(policy.programId, 'policy program id');
  const programDataAddress = publicKey(policy.programDataAddress, 'policy ProgramData address');
  const derivedProgramData = PublicKey.findProgramAddressSync([programId.toBuffer()], SOLANA_UPGRADEABLE_LOADER_ID)[0];
  requireCondition(sameKey(derivedProgramData, programDataAddress), 'policy ProgramData address is not derived from program id');
  const loader = publicKey(policy.expectedLoader, 'expected loader');
  const expectedCodeHash = sha256(policy.expectedDeployedCodeSha256, 'expected deployed code hash');
  const expectedUpgradeAuthority = policy.upgradeAuthority === null
    ? null
    : publicKey(policy.upgradeAuthority, 'expected upgrade authority');
  requireCondition(!(policy.requireImmutableVerifier && expectedUpgradeAuthority !== null), 'immutable verifier policy cannot expect an upgrade authority');
  const expectedAuthorities = authorityMap(policy.authorities, 'authority policy');
  validateCaps(
    policy.capPolicy.activationState,
    policy.capPolicy.entryCapAtoms,
    policy.capPolicy.exitCapAtoms,
    policy.capPolicy.preserveExitWhenDeprecated,
  );

  const observed = await port.readDeploymentAuthorityEvidence(programId);
  requireCondition(observed !== null, 'deployment authority evidence is missing');
  requireCondition(sameKey(publicKey(observed.programId, 'observed program id'), programId), 'deployment authority program mismatch');
  requireCondition(observed.executable, 'deployment program is not executable');
  requireCondition(sameKey(publicKey(observed.programOwner, 'observed program owner'), loader), 'deployment program loader mismatch');
  requireCondition(!observed.programDataExecutable, 'deployment ProgramData must not be executable');
  requireCondition(sameKey(publicKey(observed.programDataOwner, 'observed ProgramData owner'), loader), 'deployment ProgramData loader mismatch');
  requireCondition(
    sameKey(publicKey(observed.programDataAddress, 'observed ProgramData address'), programDataAddress)
      && sameKey(publicKey(observed.linkedProgramDataAddress, 'linked ProgramData address'), programDataAddress),
    'deployment ProgramData mismatch',
  );
  requireCondition(sha256(observed.deployedCodeSha256, 'observed deployed code hash') === expectedCodeHash, 'deployment code hash drift');

  const observedUpgradeAuthority = observed.upgradeAuthority === null
    ? null
    : publicKey(observed.upgradeAuthority, 'observed upgrade authority');
  requireCondition(!(policy.requireImmutableVerifier && observedUpgradeAuthority !== null), 'deployment verifier is mutable');
  requireCondition(
    (expectedUpgradeAuthority === null && observedUpgradeAuthority === null)
      || (expectedUpgradeAuthority !== null
        && observedUpgradeAuthority !== null
        && sameKey(expectedUpgradeAuthority, observedUpgradeAuthority)),
    'unexpected upgrade authority',
  );

  const observedAuthorities = authorityMap(observed.authorities, 'observed authorities');
  requireCondition(observedAuthorities.size === expectedAuthorities.size, 'observed authority role set mismatch');
  for (const [role, expected] of expectedAuthorities) {
    const actual = observedAuthorities.get(role);
    requireCondition(actual !== undefined && sameKey(actual, expected), `unexpected ${role.toLowerCase()} authority`);
  }
  for (const collision of policy.forbiddenRoleCollisions) {
    requireCondition(collision.left !== collision.right, 'forbidden collision must name two different roles');
    const left = observedAuthorities.get(collision.left);
    const right = observedAuthorities.get(collision.right);
    requireCondition(left !== undefined && right !== undefined, 'forbidden collision names an absent role');
    requireCondition(!sameKey(left, right), `${collision.left} and ${collision.right} authorities must be separated`);
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
  requireCondition(Number.isSafeInteger(observed.contextSlot) && observed.contextSlot > 0, 'observed context slot is invalid');

  return Object.freeze({
    programId,
    programDataAddress,
    deployedCodeSha256: expectedCodeHash,
    upgradeAuthority: observedUpgradeAuthority,
    authorities: Object.freeze(policy.authorities.map((binding) => Object.freeze({
      role: binding.role,
      authority: expectedAuthorities.get(binding.role)!,
    }))),
    activationState: observed.activationState,
    entryCapAtoms: observed.entryCapAtoms,
    exitCapAtoms: observed.exitCapAtoms,
    contextSlot: observed.contextSlot,
  });
}
