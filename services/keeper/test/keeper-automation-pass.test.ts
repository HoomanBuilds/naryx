import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  activationConditionHash,
  keeperActionAuthorizationBytes,
  type ActivationConditionInput,
  type KeeperActionAuthorizationInput,
  type StrategyHealthSnapshotInput,
} from '@naryx/protocol-types';
import { KeeperActionJournal, runKeeperAutomationPass, type KeeperAutomationEntry, type KeeperAutomationPorts } from '../src/keeper-automation-pass.js';

const condition: ActivationConditionInput = { conditionVersion: 1, metric: 'BASIS', comparator: 'AT_OR_ABOVE', threshold: 50n, observationUnit: 'EVM_UNIX_SECONDS', maximumObservationAge: 30n };
const health = (overrides: Partial<StrategyHealthSnapshotInput> = {}): StrategyHealthSnapshotInput => ({
  snapshotVersion: 1, environment: 'testnet', strategyId: 'strategy-1', strategyStateHash: '51'.repeat(32), observedAtUnit: 'EVM_UNIX_SECONDS', observedAtValue: 1_000n,
  deltaBaseAtoms: -40n, grossNotionalQuoteAtoms: 10_000n, leverageBps: 30_000n, marginHealthBps: 2_500n, liquidationDistanceBps: 1_800n, basisTicks: 60n, fundingPpm: 120n,
  volatilityPpm: 450_000n, residualBaseAtoms: 0n, maximumLossBoundQuoteAtoms: 900n, dependencyState: 'HEALTHY', recoveryCapacityQuoteAtoms: 5_000n, evidenceHash: '52'.repeat(32), ...overrides,
});
const authorization: KeeperActionAuthorizationInput = {
  authorizationVersion: 1, environment: 'testnet', strategyId: 'strategy-1', templateId: 'cash-and-carry-v1', templateVersion: 1, packageTemplateManifestHash: '44'.repeat(32),
  lifecycleGraphHash: '61'.repeat(32), actionKind: 'REBALANCE', conditionHash: activationConditionHash(condition), maximumCostQuoteAtoms: 100n,
  resultingRiskBound: { maximumLeverageBps: 30_000n, maximumGrossNotionalQuoteAtoms: 10_000n, maximumLossBoundQuoteAtoms: 900n, maximumAbsoluteDeltaBaseAtoms: 40n, minimumMarginHealthBps: 2_000n },
  riskReducing: true, rewardQuoteAtoms: 10n, permittedKeeperIds: [], expiryUnit: 'EVM_UNIX_SECONDS', expiryValue: 2_000n, authorizationNonce: 7n,
};

function owner() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { key: new Uint8Array((publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32)), sign: (bytes: Uint8Array) => new Uint8Array(sign(null, bytes, privateKey)) };
}

test('the keeper dispatches an authorized risk-reducing action once and refuses everything else', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'naryx-keeper-'));
  try {
    const signer = owner();
    const entry: KeeperAutomationEntry = { authorization, ownerKey: signer.key, ownerSignature: signer.sign(keeperActionAuthorizationBytes(authorization)), condition, lifecycleGraphHash: '61'.repeat(32) };
    let basis = 40n;
    let after = health({ deltaBaseAtoms: -10n, grossNotionalQuoteAtoms: 8_000n, leverageBps: 24_000n, maximumLossBoundQuoteAtoms: 700n });
    const dispatched: string[] = [];
    const ports: KeeperAutomationPorts = {
      readHealth: async () => ({ before: health({ basisTicks: basis }), stateHash: '51'.repeat(32), manualTakeover: false }),
      plan: async () => ({ after, costQuoteAtoms: 80n, rewardQuoteAtoms: 10n, grantsAuthority: false }),
      dispatch: async (action) => {
        dispatched.push(action.authorizationHash);
        return 'EXECUTED';
      },
      now: (unit) => (unit === 'EVM_UNIX_SECONDS' ? 1_010n : undefined),
    };
    const journalPath = join(dir, 'journal.jsonl');
    const run = (entries = [entry]) => runKeeperAutomationPass({ keeperId: 'keeper-1', entries, ports, journal: new KeeperActionJournal(journalPath) });

    assert.deepEqual((await run()).map((result) => [result.status, result.detail]), [['NOT_READY', 'CONDITION_NOT_MET']]);
    basis = 60n;
    after = health({ leverageBps: 31_000n });
    assert.deepEqual((await run()).map((result) => [result.status, result.detail]), [['REJECTED', 'RESULTING_RISK_ABOVE_BOUND']]);
    after = health({ deltaBaseAtoms: -10n, grossNotionalQuoteAtoms: 8_000n, leverageBps: 24_000n, maximumLossBoundQuoteAtoms: 700n });
    assert.deepEqual((await run()).map((result) => result.status), ['EXECUTED']);
    // The journal survives a restart and the nonce never runs twice.
    assert.deepEqual((await run()).map((result) => result.status), ['SKIPPED_CONSUMED']);
    assert.equal(dispatched.length, 1);

    const forged = { ...entry, authorization: { ...authorization, authorizationNonce: 8n } };
    assert.deepEqual((await run([forged])).map((result) => [result.status, result.detail]), [['REJECTED', 'OWNER_SIGNATURE_INVALID']]);

    // A lost executor response leaves the nonce consumed rather than risking a second execution.
    const retry = { ...authorization, authorizationNonce: 9n };
    const lost = { ...entry, authorization: retry, ownerSignature: signer.sign(keeperActionAuthorizationBytes(retry)) };
    ports.dispatch = async () => {
      throw new Error('connection reset');
    };
    assert.deepEqual((await run([lost])).map((result) => [result.status, result.detail]), [['FAILED', 'OUTCOME_UNKNOWN']]);
    assert.deepEqual((await run([lost])).map((result) => result.status), ['SKIPPED_CONSUMED']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
