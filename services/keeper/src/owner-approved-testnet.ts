import { createHash, createPublicKey, verify } from 'node:crypto';
import { Connection, PublicKey } from '@solana/web3.js';
import { stringifyProtocolJson } from '@naryx/protocol-types';
import { SOLANA_DEVNET_GENESIS_HASH } from './chain-identity.js';
import {
  applyDependencyTrigger, createDependencyIncidentJournal, dependencyReadinessCommitment,
  dependencyScopeHash, type DependencyIncidentFileStore, type DependencyScopeInput,
  type OwnerApprovedTestnetDecision,
} from './dependency-incident-engine.js';

export interface OwnerApprovedTestnetRelease {
  readonly version: 1;
  readonly policy: 'OWNER_APPROVED_TESTNET';
  readonly environment: 'devnet';
  readonly independentlyReviewed: false;
  readonly decisionVersion: number;
  readonly genesisHash: string;
  readonly scope: DependencyScopeInput;
  readonly releaseHash: string;
  readonly capPolicySha256: string;
  readonly approvedAtMs: bigint;
  readonly expiresAtMs: bigint;
  readonly approver: string;
  readonly programs: readonly {
    readonly programId: string;
    readonly programData: string;
    readonly codeHash: `0x${string}`;
    readonly upgradeAuthority: string;
    readonly deploymentSlot: bigint;
  }[];
  readonly reconciledExit: {
    readonly programId: string;
    readonly entrySignature: string;
    readonly entrySlot: bigint;
    readonly exitSignature: string;
    readonly exitSlot: bigint;
  };
}

export interface SignedOwnerTestnetApproval {
  readonly release: OwnerApprovedTestnetRelease;
  readonly signature: string;
}

function requireCondition(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Owner-approved testnet qualification refused: ${message}`);
}

const HASH = /^0x[0-9a-f]{64}$/;
const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
const MAX_VALIDITY_MS = 7n * 24n * 60n * 60n * 1_000n;

export function ownerTestnetApprovalMessage(release: OwnerApprovedTestnetRelease): Buffer {
  return Buffer.from(`naryx/owner-approved-solana-devnet/v1\n${stringifyProtocolJson(release)}`);
}

export function validateOwnerTestnetApproval(
  signed: SignedOwnerTestnetApproval, trustedApprover: string, capPolicyText: string,
): OwnerApprovedTestnetDecision {
  const r = signed.release;
  requireCondition(r.version === 1 && r.policy === 'OWNER_APPROVED_TESTNET'
    && r.environment === 'devnet' && r.independentlyReviewed === false
    && r.genesisHash === SOLANA_DEVNET_GENESIS_HASH && r.scope.domain.domainId === 'svm:devnet', 'not an owner-approved devnet release');
  requireCondition(r.approver === trustedApprover && new PublicKey(r.approver).toBase58() === trustedApprover, 'untrusted approver');
  requireCondition(Number.isSafeInteger(r.decisionVersion) && r.decisionVersion > 0
    && HASH.test(r.releaseHash) && !/^0x0{64}$/.test(r.releaseHash), 'invalid release identity');
  requireCondition(typeof r.approvedAtMs === 'bigint' && typeof r.expiresAtMs === 'bigint'
    && r.approvedAtMs >= 0n && r.expiresAtMs > r.approvedAtMs
    && r.expiresAtMs - r.approvedAtMs <= MAX_VALIDITY_MS, 'approval must expire within seven days');
  requireCondition(r.capPolicySha256 === createHash('sha256').update(capPolicyText).digest('hex'), 'execution cap policy changed');
  const caps = JSON.parse(capPolicyText) as { version: number; domains: { domainId: string; maxPrincipalAtomsPerOperation: string; maxRecoveryLossAtomsPerOperation: string }[] };
  const matches = caps.domains.filter(c => c.domainId === 'svm:devnet');
  requireCondition(caps.version === 1 && matches.length === 1
    && /^\d+$/.test(matches[0]!.maxPrincipalAtomsPerOperation) && BigInt(matches[0]!.maxPrincipalAtomsPerOperation) > 0n
    && /^\d+$/.test(matches[0]!.maxRecoveryLossAtomsPerOperation), 'bounded devnet execution caps are required');
  requireCondition(r.programs.length > 0 && r.programs.length <= 32
    && new Set(r.programs.map(p => p.programId)).size === r.programs.length
    && new Set(r.programs.map(p => p.programData)).size === r.programs.length, 'program inventory is empty or repeated');
  for (const p of r.programs) {
    requireCondition(new PublicKey(p.programId).toBase58() === p.programId
      && new PublicKey(p.programData).toBase58() === p.programData
      && p.upgradeAuthority === r.approver && HASH.test(p.codeHash)
      && typeof p.deploymentSlot === 'bigint' && p.deploymentSlot > 0n, 'program identity or authority is invalid');
  }
  const exit = r.reconciledExit;
  requireCondition(r.programs.some(p => p.programId === exit.programId)
    && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(exit.entrySignature)
    && /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(exit.exitSignature)
    && exit.entrySignature !== exit.exitSignature && typeof exit.entrySlot === 'bigint'
    && typeof exit.exitSlot === 'bigint' && exit.exitSlot > exit.entrySlot
    && r.programs.every(p => p.deploymentSlot < exit.entrySlot), 'funded exit evidence does not follow this release');
  requireCondition(/^[0-9a-f]{128}$/.test(signed.signature), 'invalid owner signature');
  const publicKey = createPublicKey({ key: Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'), new PublicKey(trustedApprover).toBuffer(),
  ]), format: 'der', type: 'spki' });
  const message = ownerTestnetApprovalMessage(r);
  requireCondition(verify(null, message, publicKey, Buffer.from(signed.signature, 'hex')), 'owner signature does not verify');
  return Object.freeze({ schemaVersion: 1, decisionVersion: r.decisionVersion, environment: 'devnet',
    qualificationPolicy: 'OWNER_APPROVED_TESTNET', independentlyReviewed: false, releaseHash: r.releaseHash,
    scopeHash: dependencyScopeHash(r.scope), approvalHash: `0x${createHash('sha256').update(message).digest('hex')}`,
    status: 'READY' });
}

export async function observeOwnerTestnetRelease(
  release: OwnerApprovedTestnetRelease, rpc: Connection,
  codeHash: (data: Uint8Array) => string | null,
): Promise<void> {
  requireCondition(await rpc.getGenesisHash() === SOLANA_DEVNET_GENESIS_HASH, 'RPC is not Solana devnet');
  const addresses = release.programs.flatMap(p => [new PublicKey(p.programId), new PublicKey(p.programData)]);
  const accounts = await rpc.getMultipleAccountsInfoAndContext(addresses, { commitment: 'finalized' });
  for (const [i, p] of release.programs.entries()) {
    const program = accounts.value[i * 2], data = accounts.value[i * 2 + 1];
    requireCondition(program?.executable && program.owner.toBase58() === LOADER
      && program.data.length === 36 && program.data.readUInt32LE(0) === 2
      && new PublicKey(program.data.subarray(4)).toBase58() === p.programData, 'program deployment pointer changed');
    requireCondition(data && data.owner.toBase58() === LOADER && data.data.length > 45
      && data.data.readUInt32LE(0) === 3 && data.data[12] === 1
      && new PublicKey(data.data.subarray(13, 45)).toBase58() === p.upgradeAuthority
      && data.data.readBigUInt64LE(4) === p.deploymentSlot && codeHash(data.data) === p.codeHash,
    'program code, deployment slot or upgrade authority changed');
  }
  const proof = release.reconciledExit;
  for (const [signature, slot] of [[proof.entrySignature, proof.entrySlot], [proof.exitSignature, proof.exitSlot]] as const) {
    const tx = await rpc.getTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 });
    requireCondition(tx?.meta && tx.meta.err === null && BigInt(tx.slot) === slot, 'funded cycle is not finalized');
    const keys = tx.transaction.message.getAccountKeys(tx.meta.loadedAddresses === undefined
      ? undefined : { accountKeysFromLookups: tx.meta.loadedAddresses });
    requireCondition(tx.transaction.message.compiledInstructions.some(ix => keys.get(ix.programIdIndex)?.toBase58() === proof.programId),
      'funded evidence did not invoke the approved program');
  }
}

export async function refreshOwnerTestnetJournal(input: {
  approval: SignedOwnerTestnetApproval; trustedApprover: string; capPolicyText: string;
  store: Pick<DependencyIncidentFileStore, 'load' | 'save'>; nowMs: bigint;
  observe(release: OwnerApprovedTestnetRelease): Promise<void>;
}): Promise<void> {
  let current;
  try { current = await input.store.load(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const decision = validateOwnerTestnetApproval(input.approval, input.trustedApprover, input.capPolicyText);
  const release = input.approval.release;
  const expires = input.nowMs + 300_000n < release.expiresAtMs ? input.nowMs + 300_000n : release.expiresAtMs;
  const evidence = { scopeHash: decision.scopeHash, readinessDecision: decision,
    readinessDecisionCommitment: dependencyReadinessCommitment(decision), evidenceCommitment: decision.approvalHash,
    observedAtMs: input.nowMs, validUntilMs: expires, exitSafe: true };
  if (current) {
    requireCondition(current.scopeHash === decision.scopeHash
      && current.latestEvidence.qualificationPolicy === 'OWNER_APPROVED_TESTNET'
      && current.latestEvidence.readinessDecisionCommitment === dependencyReadinessCommitment(decision), 'existing journal belongs to another approval');
    if (current.state !== 'ACTIVE' || current.receipts.length !== 0) return;
  }
  try {
    requireCondition(input.nowMs >= release.approvedAtMs && input.nowMs < release.expiresAtMs, 'approval is not currently valid');
    await input.observe(release);
  } catch {
    if (current) await input.store.save(applyDependencyTrigger(current, {
      expectedRevision: current.revision, trigger: 'SIGNER_FENCING', occurredAtMs: input.nowMs,
      evidence: { ...evidence, exitSafe: false, validUntilMs: input.nowMs + 300_000n },
    }));
    throw new Error('Owner-approved devnet checks failed; scope remains unavailable or quarantined.');
  }
  await input.store.save(createDependencyIncidentJournal(release.scope, evidence, input.nowMs));
}
