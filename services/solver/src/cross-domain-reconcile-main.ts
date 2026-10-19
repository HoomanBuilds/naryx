import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { bytesEqual, commitmentHash, crossDomainCompensationAction, parseProtocolJson, stringifyProtocolJson, toHex } from '@naryx/protocol-types';
import { getAddress, type Address } from 'viem';
import { toAccount } from 'viem/accounts';
import { SqliteCrossDomainJobStore } from './cross-domain-job-store.js';
import { HttpCrossDomainCoordinationJournal } from './http-cross-domain-coordination-journal.js';
import { finalizedClockSkewHistory, verifyFinalizedClockSkew } from './cross-domain-clock-reconciliation.js';
import { createViemEvmFirmReservationCrossDomainPort } from './evm-firm-reservation-cross-domain-port.js';
import { EvmRecoverableCrossDomainLane, type EvmRecoverableCrossDomainLaneConfig } from './evm-recoverable-cross-domain-lane.js';
import { EvmCrossDomainExecutionDriver, type EvmCrossDomainCompensationProfile, type EvmCrossDomainLaneInput } from './evm-cross-domain-execution-driver.js';
import { loadEvmStrategySolverKey } from './evm-strategy-execution-authorization.js';

interface Configuration {
  version: number; environment: string; jobDatabasePath: string; apiOrigin: string;
  lanes: { rpcEnvironmentVariable: string; signerAddress: Address; signerKeyPath: string; submissionJournalPath: string;
    maximumGasBudgetWei: bigint; alreadySpentWei: bigint; allowedOwners: Address[]; allowedAccounts: Address[];
    lane: EvmRecoverableCrossDomainLaneConfig; compensationProfile: EvmCrossDomainCompensationProfile }[];
}

const [planHash, mode] = process.argv.slice(2);
assert.ok(planHash && /^[0-9a-f]{64}$/.test(planHash)
  && (mode === undefined || mode === '--apply' || mode === '--release-expired-inventory') && process.argv.length <= 4,
  'Usage: cross-domain-reconcile-main.js PLAN_HASH [--apply|--release-expired-inventory]');
assert.equal(process.env.NARYX_CROSS_DOMAIN_ENABLED, 'true');
const path = process.env.NARYX_CROSS_DOMAIN_CONFIG;
assert.ok(path && isAbsolute(path));
const config = parseProtocolJson(readFileSync(path, 'utf8')) as Configuration;
assert.ok(config.version === 1 && config.environment === 'testnet' && config.lanes.length === 2
  && new Set(config.lanes.map(item => item.lane.chainReference)).size === 2
  && config.lanes.every(item => [84_532n, 421_614n].includes(item.lane.chainReference)));
const store = new SqliteCrossDomainJobStore(config.jobDatabasePath);
const ports: ReturnType<typeof createViemEvmFirmReservationCrossDomainPort>[] = [];
const pendingInventory: { item: Configuration['lanes'][number]; input: EvmCrossDomainLaneInput }[] = [];
try {
  assert.equal(store.status(planHash)?.status, 'ESCALATION_REQUIRED');
  const job = store.get(planHash)!;
  const journal = new HttpCrossDomainCoordinationJournal(config.apiOrigin);
  const snapshot = await journal.snapshot(planHash);
  const denySigning = async (): Promise<never> => { throw new Error('Reconciliation cannot sign or broadcast'); };
  const resolution = await verifyFinalizedClockSkew(snapshot.plan, snapshot.events, Date.now(), async domainId => {
    const item = config.lanes.find(item => item.lane.domain.domainId === domainId)!;
    const execution = job.execution.domains.find(domain => domain.domain.domainId === domainId)!;
    const auth = job.authorizations.find(auth => auth.domainId === domainId)!;
    assert.equal(execution.kind, 'EVM_MULTI_STRATEGY_ACCOUNT');
    assert.ok(item && auth && execution.kind === 'EVM_MULTI_STRATEGY_ACCOUNT');
    assert.ok(item.allowedOwners.some(owner => getAddress(owner) === getAddress(auth.entry.owner))
      && item.allowedAccounts.some(account => getAddress(account) === getAddress(execution.envelope.account)),
    'Operator reconciliation is limited to the configured dedicated accounts');
    const rpcUrl = process.env[item.rpcEnvironmentVariable];
    assert.ok(rpcUrl);
    assert.ok(item.lane.chainReference === 84_532n || item.lane.chainReference === 421_614n);
    const port = createViemEvmFirmReservationCrossDomainPort({ rpcUrl, chainReference: item.lane.chainReference,
      account: toAccount({ address: item.signerAddress, signMessage: denySigning, signTransaction: denySigning, signTypedData: denySigning }),
      submissionJournalPath: item.submissionJournalPath, maximumGasBudgetWei: item.maximumGasBudgetWei, alreadySpentWei: item.alreadySpentWei });
    ports.push(port);
    assert.equal(await port.chainId(), item.lane.chainReference);
    assert.ok(await port.reconcilePending(), 'A transaction is still pending');
    assert.equal(getAddress(await port.accountOwner(execution.envelope.account)), getAddress(auth.entry.owner));
    const lane = new EvmRecoverableCrossDomainLane(item.lane, port, {
      resolve: async () => auth.entry, resolveRecovery: async () => auth.recovery,
    });
    const input: EvmCrossDomainLaneInput = { planHash, plan: job.bundle.plan,
      planLeg: job.bundle.plan.legs.find(leg => leg.domain.domainId === domainId)!,
      compensation: crossDomainCompensationAction(job.bundle.compensations.find(value => value.domain.domainId === domainId)!),
      execution, events: snapshot.events, phase: 'COMMIT', action: { kind: 'RECONCILE_COMMIT', domainId } };
    new EvmCrossDomainExecutionDriver(lane, item.compensationProfile).validateInput(input);
    const verified = await lane.reconcileCommit(input);
    assert.equal(verified.status, 'FINALIZED');
    assert.ok(verified.status === 'FINALIZED');
    const observed = await port.observeSubmission(`${planHash}:COMMIT`, execution.envelope.account);
    assert.ok(observed.status === 'SUCCESS');
    const state = await port.packageState(execution.envelope.account, execution.envelope.execution.packageId);
    assert.ok(state.active && state.stateHash === execution.envelope.execution.nextStateHash
      && await port.accountNextNonce(execution.envelope.account) === execution.envelope.execution.nonce + 1n,
    'Account no longer has the exact finalized entry');
    const reservation = await port.reservation(item.lane.reservationBook, `0x${toHex(commitmentHash(input.planLeg.inventoryReservationId))}`);
    assert.ok(['LIVE', 'CONSUMED', 'RELEASED'].includes(reservation.state), 'Reservation state is unexplained');
    assert.equal(getAddress(reservation.strategyAccount), getAddress(execution.envelope.account), 'Reservation account differs');
    assert.equal(reservation.orderHash, execution.envelope.execution.orderHash, 'Reservation order differs');
    assert.equal(reservation.quoteHash, execution.envelope.execution.quoteHash, 'Reservation quote differs');
    assert.equal(reservation.routeHash, execution.envelope.execution.routeHash, 'Reservation route differs');
    if (reservation.state === 'LIVE') {
      assert.ok(await port.currentTime() > reservation.expiry, 'Reserved inventory has not expired');
      pendingInventory.push({ item, input });
    } else assert.ok(await lane.settleUnusedReservation(input), 'Reservation has not finalized');
    return { status: verified.status, evidenceHash: toHex(commitmentHash(verified.evidenceHash)), transactionHash: observed.transactionHash };
  });
  assert.ok(bytesEqual(commitmentHash(resolution.planHash), commitmentHash(planHash)));
  const recheck = await journal.snapshot(planHash);
  assert.equal(finalizedClockSkewHistory(recheck.plan, recheck.events, BigInt(Math.floor(Date.now() / 1000))).historyHash,
    resolution.historyHash, 'Journal changed during reconciliation');
  if (mode === '--release-expired-inventory') {
    for (const { item, input } of pendingInventory) {
      assert.ok(item.lane.chainReference === 84_532n || item.lane.chainReference === 421_614n);
      const port = createViemEvmFirmReservationCrossDomainPort({ rpcUrl: process.env[item.rpcEnvironmentVariable]!,
        chainReference: item.lane.chainReference, account: loadEvmStrategySolverKey(item.signerKeyPath, item.signerAddress),
        submissionJournalPath: item.submissionJournalPath, maximumGasBudgetWei: item.maximumGasBudgetWei, alreadySpentWei: item.alreadySpentWei });
      ports.push(port);
      const lane = new EvmRecoverableCrossDomainLane(item.lane, port, { resolve: async () => undefined, resolveRecovery: async () => undefined });
      await lane.settleUnusedReservation(input);
    }
  }
  if (mode === '--apply') {
    assert.equal(pendingInventory.length, 0, 'Expired inventory must finish its journaled release first');
    store.resolveFinalizedClockSkew(resolution);
  }
  console.log(stringifyProtocolJson({ applied: mode === '--apply', broadcastAllowed: mode === '--release-expired-inventory',
    pendingInventory: pendingInventory.map(value => value.item.lane.domain.domainId), resolution }));
} finally {
  for (const port of ports) port.close();
  store.close();
}
