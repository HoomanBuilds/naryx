import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import Database from 'better-sqlite3';
import {
  domainRef, parseProtocolJson, stringifyProtocolJson, toHex,
  type DomainRef,
} from '@naryx/protocol-types';
import { deriveTestPerpEntryLimits, NARYX_TEST_PERP_MARKET_ABI, encodeEvmMultiStrategyAccountRecovery,
  type EvmStrategyAdapterIdentity, type EvmMultiStrategyAccountEnvelope } from '@naryx/adapter-evm';
import { createPublicClient, http, parseAbi, getAddress, keccak256, stringToHex, encodeFunctionData, recoverTypedDataAddress, type Address, type Hex } from 'viem';
import { baseSepolia, arbitrumSepolia } from 'viem/chains';
import {
  prepareCanonicalCalendar, refreshCalendarRecovery, calendarCommitment, CALENDAR_QUANTITY, CALENDAR_COLLATERAL,
  type CalendarDomainObservation,
} from './cross-domain-canonical-calendar.js';
import { validateCrossDomainWalletDraft, type CrossDomainWalletDraft } from './cross-domain-wallet-admission.js';
import type { EvmRecoverableCrossDomainPort } from './evm-cross-domain-recovery-port.js';
import type { EvmRecoverableCrossDomainLaneConfig } from './evm-recoverable-cross-domain-lane.js';
import type { EvmCrossDomainCompensationProfile } from './evm-cross-domain-execution-driver.js';
import type { EvmRecoveryAdapterPolicy } from './evm-full-reversal-policy.js';

const ZERO = `0x${'0'.repeat(64)}` as Hex;
const REGISTRY_ABI = parseAbi([
  'function activeAdapter(bytes32) view returns (((bytes32 domainIdHash,uint32 manifestVersion,bytes32 manifestHash) domain,(bytes32 subjectId,uint32 manifestVersion,bytes32 manifestHash) identity,uint8 mode,address adapter,bytes32 expectedCodeHash,bytes32 adapterClassId,uint32 adapterClassVersion,(bytes32 templateId,uint32 templateVersion,bytes32 templateManifestHash) template,(bytes32 classId,uint32 classVersion) settlementClass,(address token,bytes32 expectedCodeHash) baseAsset,(address token,bytes32 expectedCodeHash) quoteAsset,uint256 maximumGasLimit),(uint8 state,uint256 maximumApprovalAtoms,uint256 maximumGrossNotionalAtoms))',
]);
const ADAPTER_ABI = parseAbi(['function instrument() view returns(address)', 'function expiry() view returns(uint32)']);
const FACTORY_ABI = parseAbi([
  'function accountOf(address) view returns(address)', 'function isAccount(address) view returns(bool)',
  'function adapterOf(address,bytes32) view returns(address)', 'function validateInstance(address,address,bytes32) view returns(bool)',
  'function create(address)', 'function create(address,bytes32)',
]);
const TOKEN_ABI = parseAbi([
  'function decimals() view returns(uint8)', 'function balanceOf(address) view returns(uint256)',
  'function allowance(address,address) view returns(uint256)', 'function approve(address,uint256) returns(bool)',
]);
const CONFIG_ABI = parseAbi(['function entryPaused() view returns(bool)']);
const BOOK_ABI = parseAbi([
  'function reservationId(string,uint32,bytes32,string,bytes32,uint256) pure returns(bytes32)',
  'function reserve(((bytes32 domainIdHash,uint32 manifestVersion,bytes32 manifestHash) domain,string solverId,address solver,address reclaimOwner,address strategyAccount,uint256 packageNonce,bytes32 orderHash,uint256 reservationNonce,uint256 baseAtoms,uint256 quoteAtoms,uint64 expiry,address consumer,bytes32 consumerCodeHash) terms) returns(bytes32)',
  'function finalizeReservation(bytes32,bytes32,bytes32)',
  'function maximumTtlSeconds() view returns(uint64)',
  'function maximumBaseAtomsPerReservation() view returns(uint256)',
]);
interface ReleaseRecord {
  environment: string; activationState: string; chainId: number; owner: Address; account: Address; accountCodeHash: Hex;
  packageId: Hex; solver: Address; domain: { domainId: string; domainManifestVersion: number; domainManifestHash: Hex };
  contracts: Record<string, { address: Address; runtimeCodeHash: Hex }>;
  instances: Record<string, { address: Address; codeHash: Hex }>;
  bindings: { binding: { identity: EvmStrategyAdapterIdentity; adapter: Address; expectedCodeHash: Hex;
    template: { templateId: Hex; templateVersion: number; templateManifestHash: Hex } } }[];
  riskDomainId: Hex; riskPolicy: { manifestVersion: number; manifestHash: Hex };
  dependencies: { dependencyId: Hex }[];
  series: { seriesId: Hex; manifestVersion: number; manifestHash: Hex }[];
  feePolicy: { version: number; manifestHash: Hex; maximumProtocolFeeBps: number; maximumSolverFeeBps: number };
}

interface CalendarRuntimeLane {
  rpcUrl: string;
  allowedOwners: readonly Address[];
  allowedAccounts: readonly Address[];
  signerAddress: Address;
  lane: EvmRecoverableCrossDomainLaneConfig;
  compensationProfile: EvmCrossDomainCompensationProfile;
  port: EvmRecoverableCrossDomainPort & { remainingBudgetWei(): bigint };
}

function requireCondition(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Calendar preparation refused: ${message}`);
}

function readRecord(path: string): ReleaseRecord {
  requireCondition(isAbsolute(path) && statSync(path).isFile() && statSync(path).size <= 1_048_576, 'invalid release record');
  return parseProtocolJson(readFileSync(path, 'utf8')) as ReleaseRecord;
}

export function createCrossDomainCalendarRuntime(input: {
  directory: string; databasePath: string; signingKeyPath: string; lanes: readonly CalendarRuntimeLane[];
}) {
  requireCondition(isAbsolute(input.directory) && isAbsolute(input.databasePath) && isAbsolute(input.signingKeyPath), 'absolute runtime paths required');
  const key = createPrivateKey(readFileSync(input.signingKeyPath));
  requireCondition(key.asymmetricKeyType === 'ed25519', 'quote key must be Ed25519');
  const publicKey = createPublicKey(key).export({ format: 'der', type: 'spki' });
  requireCondition(publicKey.length === 44, 'invalid quote key');
  const signer = { scheme: 'ED25519' as const, verificationKey: Uint8Array.from(publicKey.subarray(12)),
    signDigest: (digest: Uint8Array) => Uint8Array.from(sign(null, digest, key)) };
  const contexts = input.lanes.map(lane => {
    requireCondition(lane.lane.chainReference === 84_532n || lane.lane.chainReference === 421_614n, 'unsupported network');
    const base = lane.lane.chainReference === 84_532n;
    const release = readRecord(join(input.directory, base ? 'base-sepolia.json' : 'arbitrum-sepolia.json'));
    requireCondition(release.environment === 'testnet' && release.activationState === 'ACTIVE'
      && BigInt(release.chainId) === lane.lane.chainReference && release.domain.domainId === lane.lane.domain.domainId
      && release.domain.domainManifestVersion === lane.lane.domain.domainManifestVersion
      && release.domain.domainManifestHash === `0x${toHex(lane.lane.domain.domainManifestHash)}`
      && lane.allowedOwners.some(o => getAddress(o) === getAddress(release.owner))
      && lane.allowedAccounts.some(a => getAddress(a) === getAddress(release.account))
      && getAddress(release.solver) === getAddress(lane.signerAddress), 'release is outside the configured test cohort');
    const factory = release.contracts[base ? 'nearFutureFactory' : 'farFutureFactory']!;
    const instance = release.instances[base ? 'nearFutureFactory' : 'farFutureFactory']!;
    const binding = release.bindings.find(b => getAddress(b.binding.adapter) === getAddress(factory.address))?.binding;
    const adapterPolicy = lane.lane.recoveryAdapters.find(a => getAddress(a.address) === getAddress(instance.address));
    requireCondition(binding && adapterPolicy?.kind === 'RECOVERABLE_FUTURE' && adapterPolicy.codeHash === instance.codeHash,
      'registered recoverable future is missing');
    requireCondition(binding.template.templateId === keccak256(stringToHex('calendar-spread-v1')) && binding.template.templateVersion === 1,
      'local template is not the supported calendar template');
    const client = createPublicClient({ chain: base ? baseSepolia : arbitrumSepolia, transport: http(lane.rpcUrl, { timeout: 15_000, retryCount: 1 }) });
    return { lane, release, factory, instance, binding, adapterPolicy, client, role: base ? 'near-future' as const : 'far-future' as const };
  });
  const db = new Database(input.databasePath);
  db.pragma('journal_mode = WAL'); db.pragma('synchronous = FULL');
  db.exec('CREATE TABLE IF NOT EXISTS canonical_calendars (order_hash TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL, draft_json TEXT NOT NULL, documents_json TEXT NOT NULL) STRICT');
  db.exec('CREATE TABLE IF NOT EXISTS canonical_calendar_exits (order_hash TEXT NOT NULL, domain_id TEXT NOT NULL, envelope_json TEXT, receipt_hash TEXT, PRIMARY KEY(order_hash,domain_id)) STRICT');
  db.exec('CREATE TABLE IF NOT EXISTS calendar_accounts (domain_id TEXT NOT NULL, owner TEXT NOT NULL, account TEXT NOT NULL, adapter TEXT NOT NULL, code_hash TEXT NOT NULL, PRIMARY KEY(domain_id,owner), UNIQUE(domain_id,account)) STRICT');

  function storedContext(context: typeof contexts[number], owner: Address) {
    if (getAddress(context.release.owner) === getAddress(owner)) return context;
    const row = db.prepare('SELECT account, adapter, code_hash FROM calendar_accounts WHERE domain_id=? AND owner=?')
      .get(context.release.domain.domainId, owner.toLowerCase()) as { account: Address; adapter: Address; code_hash: Hex } | undefined;
    requireCondition(row, 'set up your strategy accounts on both chains first');
    return { ...context, release: { ...context.release, owner, account: row.account },
      instance: { address: row.adapter, codeHash: row.code_hash },
      adapterPolicy: { ...context.adapterPolicy, address: row.adapter, codeHash: row.code_hash } };
  }
  const ownerContexts = (owner: Address) => contexts.map(context => storedContext(context, owner));
  async function onboarding(ownerValue: string) {
    requireCondition(/^0x(?!0{40}$)[0-9a-fA-F]{40}$/.test(ownerValue), 'valid wallet required');
    const owner = getAddress(ownerValue);
    const chains = await Promise.all(contexts.map(async context => {
      const { client, lane, release: r, factory } = context;
      const accountFactory = r.contracts.accountFactory!;
      requireCondition(await client.getChainId() === r.chainId
        && await lane.port.codeHash(accountFactory.address) === accountFactory.runtimeCodeHash
        && await lane.port.codeHash(factory.address) === factory.runtimeCodeHash, 'factory or chain identity changed');
      const account = await client.readContract({ address: accountFactory.address, abi: FACTORY_ABI, functionName: 'accountOf', args: [owner] });
      const adapter = await client.readContract({ address: factory.address, abi: FACTORY_ABI, functionName: 'adapterOf', args: [account, r.packageId] });
      const [accountCode, adapterCode, balance] = await Promise.all([
        client.getCode({ address: account }), client.getCode({ address: adapter }),
        client.readContract({ address: context.adapterPolicy.quoteToken, abi: TOKEN_ABI, functionName: 'balanceOf', args: [account] }),
      ]);
      const transactions: { kind: string; to: Address; data: Hex; value: string }[] = [];
      if (!accountCode || accountCode === '0x') transactions.push({ kind: 'CREATE_ACCOUNT', to: accountFactory.address,
        data: encodeFunctionData({ abi: FACTORY_ABI, functionName: 'create', args: [owner] }), value: '0' });
      else requireCondition(keccak256(accountCode) === r.accountCodeHash
        && await client.readContract({ address: accountFactory.address, abi: FACTORY_ABI, functionName: 'isAccount', args: [account] })
        && getAddress(await lane.port.accountOwner(account)) === owner, 'account does not belong to this wallet');
      if (!adapterCode || adapterCode === '0x') transactions.push({ kind: 'CREATE_ADAPTER', to: factory.address,
        data: encodeFunctionData({ abi: FACTORY_ABI, functionName: 'create', args: [account, r.packageId] }), value: '0' });
      else {
        requireCondition(accountCode && accountCode !== '0x'
          && await client.readContract({ address: factory.address, abi: FACTORY_ABI, functionName: 'validateInstance', args: [adapter, account, r.packageId] }),
        'adapter is not registered by the approved factory');
        const codeHash = keccak256(adapterCode);
        const existing = db.prepare('SELECT account, adapter, code_hash FROM calendar_accounts WHERE domain_id=? AND owner=?')
          .get(r.domain.domainId, owner.toLowerCase()) as { account: string; adapter: string; code_hash: string } | undefined;
        requireCondition(!existing || (getAddress(existing.account) === getAddress(account)
          && getAddress(existing.adapter) === getAddress(adapter) && existing.code_hash === codeHash), 'registered account identity changed');
        db.prepare('INSERT OR IGNORE INTO calendar_accounts VALUES (?,?,?,?,?)')
          .run(r.domain.domainId, owner.toLowerCase(), getAddress(account), getAddress(adapter), codeHash);
      }
      const required = 2n * CALENDAR_COLLATERAL;
      if (balance < required) transactions.push({ kind: 'FUND_ACCOUNT', to: context.adapterPolicy.quoteToken,
        data: encodeFunctionData({ abi: parseAbi(['function transfer(address,uint256) returns(bool)']), functionName: 'transfer', args: [account, required - balance] }), value: '0' });
      return { domainId: r.domain.domainId, chainId: r.chainId, account, adapter,
        quoteToken: context.adapterPolicy.quoteToken, requiredQuoteAtoms: required.toString(), balanceQuoteAtoms: balance.toString(),
        ready: transactions.length === 0, transactions };
    }));
    return { owner, marketId: profile.marketId, preparationAccount: chains.find(c => c.chainId === 84532)!.account,
      ready: chains.every(c => c.ready), chains };
  }

  async function observe(context: typeof contexts[number], requireFlat: boolean): Promise<CalendarDomainObservation> {
    const { client, release: r, lane, factory, instance, binding, adapterPolicy, role } = context;
    requireCondition(await client.getChainId() === r.chainId, 'RPC chain identity differs');
    const block = await client.getBlock({ blockTag: 'latest' });
    requireCondition(BigInt(Math.floor(Date.now() / 1_000)) - block.timestamp <= 60n, 'RPC head is stale');
    const [active, owner, nonce, adapterState, state, balance, instrument, maturity, paused, maximumTtlSeconds, maximumBaseAtoms] = await Promise.all([
      client.readContract({ address: r.contracts.adapterRegistry!.address, abi: REGISTRY_ABI, functionName: 'activeAdapter', args: [binding.identity.subjectId], blockNumber: block.number }),
      lane.port.accountOwner(r.account), lane.port.accountNextNonce(r.account), lane.port.recoveryAdapterState(adapterPolicy),
      lane.port.packageState(r.account, r.packageId),
      client.readContract({ address: adapterPolicy.quoteToken, abi: TOKEN_ABI, functionName: 'balanceOf', args: [r.account], blockNumber: block.number }),
      client.readContract({ address: instance.address, abi: ADAPTER_ABI, functionName: 'instrument', blockNumber: block.number }),
      client.readContract({ address: instance.address, abi: ADAPTER_ABI, functionName: 'expiry', blockNumber: block.number }),
      client.readContract({ address: r.contracts.protocolConfig!.address, abi: CONFIG_ABI, functionName: 'entryPaused', blockNumber: block.number }),
      client.readContract({ address: lane.lane.reservationBook, abi: BOOK_ABI, functionName: 'maximumTtlSeconds', blockNumber: block.number }),
      client.readContract({ address: lane.lane.reservationBook, abi: BOOK_ABI, functionName: 'maximumBaseAtomsPerReservation', blockNumber: block.number }),
    ]);
    const [registered, control] = active;
    requireCondition(!paused && control.state === 0 && control.maximumApprovalAtoms >= CALENDAR_COLLATERAL
      && registered.identity.manifestHash === binding.identity.manifestHash
      && registered.identity.manifestVersion === binding.identity.manifestVersion
      && registered.template.templateManifestHash === binding.template.templateManifestHash
      && registered.template.templateId === binding.template.templateId && registered.template.templateVersion === 1
      && registered.mode === 1 && getAddress(registered.adapter) === getAddress(factory.address)
      && registered.expectedCodeHash === factory.runtimeCodeHash
      && registered.domain.domainIdHash === keccak256(stringToHex(r.domain.domainId))
      && registered.domain.manifestVersion === r.domain.domainManifestVersion && registered.domain.manifestHash === r.domain.domainManifestHash
      && registered.adapterClassId === keccak256(stringToHex('naryx.evm.future-recoverable')) && registered.adapterClassVersion === 1
      && registered.settlementClass.classId === keccak256(stringToHex('ATOMIC_POSTCONDITION')) && registered.settlementClass.classVersion === 1
      && getAddress(registered.baseAsset.token) === getAddress(adapterPolicy.baseToken)
      && getAddress(registered.quoteAsset.token) === getAddress(adapterPolicy.quoteToken), 'live registration differs from the qualified projection');
    requireCondition(getAddress(owner) === getAddress(r.owner) && adapterState.packageId === r.packageId
      && getAddress(adapterState.account) === getAddress(r.account) && adapterState.codeHash === instance.codeHash,
    'account or adapter ownership changed');
    if (requireFlat) requireCondition(!state.active && state.stateHash === ZERO && adapterState.derivative
      && adapterState.derivative.sizeWad === 0n && adapterState.derivative.balanceWad === 0n
      && adapterState.derivative.entryNotionalWad === 0n && adapterState.derivative.reserveAtoms === 0n
      && adapterState.derivative.entryPayloadHash === ZERO && balance >= 2n * CALENDAR_COLLATERAL,
    'account must be flat with funded collateral and recovery margin');
    const codeTargets = [[r.account, r.accountCodeHash], [factory.address, factory.runtimeCodeHash],
      [registered.baseAsset.token, registered.baseAsset.expectedCodeHash], [registered.quoteAsset.token, registered.quoteAsset.expectedCodeHash],
      [r.contracts.adapterRegistry!.address, r.contracts.adapterRegistry!.runtimeCodeHash],
      [lane.lane.reservationBook, lane.lane.reservationBookCodeHash]] as const;
    await Promise.all(codeTargets.map(async ([address, expected]) => {
      requireCondition(await lane.port.codeHash(address) === expected, 'registered dependency code changed');
    }));
    const [instrumentCode, preview, fee, initialMargin, scale, decimals] = await Promise.all([
      client.getCode({ address: instrument, blockNumber: block.number }),
      client.readContract({ address: instrument, abi: NARYX_TEST_PERP_MARKET_ABI, functionName: 'previewOpen',
        args: [role === 'near-future' ? CALENDAR_QUANTITY : -CALENDAR_QUANTITY, 10n ** 18n], blockNumber: block.number }),
      client.readContract({ address: instrument, abi: NARYX_TEST_PERP_MARKET_ABI, functionName: 'takerFeeBps', blockNumber: block.number }),
      client.readContract({ address: instrument, abi: NARYX_TEST_PERP_MARKET_ABI, functionName: 'initialMarginBps', blockNumber: block.number }),
      client.readContract({ address: instrument, abi: NARYX_TEST_PERP_MARKET_ABI, functionName: 'collateralScale', blockNumber: block.number }),
      client.readContract({ address: adapterPolicy.quoteToken, abi: TOKEN_ABI, functionName: 'decimals', blockNumber: block.number }),
    ]);
    requireCondition(instrumentCode && instrumentCode !== '0x' && scale === 1_000_000_000_000n && decimals === 6, 'unsupported instrument or accounting scale');
    const limits = deriveTestPerpEntryLimits({ previewEntryNotionalWad: preview[1], balanceWad: 10n ** 18n, oracleMoveAllowanceBps: 200n,
      market: { takerFeeBps: BigInt(fee), initialMarginBps: BigInt(initialMargin), collateralScale: scale } });
    requireCondition((limits.maximumPostPerpEntryNotionalWad + scale - 1n) / scale <= control.maximumGrossNotionalAtoms,
      'quantity exceeds live registration limits');
    const series = r.series.find(s => s.seriesId === binding.template.templateId);
    requireCondition(series && r.feePolicy.maximumProtocolFeeBps === 0 && r.feePolicy.maximumSolverFeeBps === 0, 'unsupported series or service fee policy');
    requireCondition((await client.getBlock({ blockNumber: block.number })).hash === block.hash, 'observation block changed');
    const domain: DomainRef = domainRef(r.domain.domainId, r.domain.domainManifestVersion, r.domain.domainManifestHash);
    return { domain, owner, account: r.account, accountCodeHash: r.accountCodeHash, packageId: r.packageId,
      localTemplateHash: binding.template.templateManifestHash, solver: r.solver, adapter: instance.address, adapterCodeHash: instance.codeHash,
      adapterIdentity: binding.identity, baseToken: adapterPolicy.baseToken, quoteToken: adapterPolicy.quoteToken,
      instrument, instrumentCodeHash: keccak256(instrumentCode), role, maturity: BigInt(maturity), nonce, generation: adapterState.derivative!.generation,
      entryNotionalWad: preview[1], minimumBalanceWad: limits.minimumPostPerpBalanceWad, maximumBalanceWad: limits.maximumPostPerpBalanceWad,
      maximumNotionalWad: limits.maximumPostPerpEntryNotionalWad,
      risk: { riskDomainId: r.riskDomainId, policyVersion: r.riskPolicy.manifestVersion, policyManifestHash: r.riskPolicy.manifestHash,
        series, accountingToken: adapterPolicy.quoteToken, grossQuoteAtoms: 0n, netQuoteAtoms: 0n, marginQuoteAtoms: 0n, reservedRecoveryQuoteAtoms: 0n,
        observationAgeMs: 0n, timeToUnwindMs: 3_600_000n, dependencyExposures: r.dependencies.map(d => ({ ...d, grossQuoteAtoms: 0n })) },
      feePolicyVersion: r.feePolicy.version, feePolicyManifestHash: r.feePolicy.manifestHash,
      reservationBook: { address: lane.lane.reservationBook, codeHash: lane.lane.reservationBookCodeHash,
        maximumTtlSeconds, maximumBaseAtoms },
      reservationId: (orderHash, reservationNonce) => client.readContract({ address: lane.lane.reservationBook, abi: BOOK_ABI,
        functionName: 'reservationId', args: [domain.domainId, domain.domainManifestVersion, r.domain.domainManifestHash,
          'registered-cross-domain-calendar-v1', orderHash, reservationNonce] }),
      ...lane.compensationProfile };
  }

  const profile = { marketId: 'base-arbitrum-calendar-v1', displayName: 'Cross-chain calendar spread',
    owner: contexts[0]!.release.owner, preparationAccount: contexts.find(c => c.role === 'near-future')!.release.account,
    quantityAtoms: CALENDAR_QUANTITY.toString(), collateralPerChainAtoms: CALENDAR_COLLATERAL.toString(), quoteDecimals: 6 };
  const budget = () => contexts.map(({ lane }) => ({ domainId: lane.lane.domain.domainId,
    remainingWei: lane.port.remainingBudgetWei(),
    requiredWei: (lane.lane.commitGasLimit + lane.lane.compensationGasLimit + 1_250_000n) * lane.lane.maximumFeePerGasWei }));
  const hasBudget = () => budget().every(b => b.remainingWei >= b.requiredWei);
  return {
    profile,
    onboarding,
    recoveryAdapters(domainId: string, account: Address): readonly EvmRecoveryAdapterPolicy[] | undefined {
      const context = contexts.find(c => c.release.domain.domainId === domainId);
      if (!context) return undefined;
      const row = db.prepare('SELECT adapter, code_hash FROM calendar_accounts WHERE domain_id=? AND account=?')
        .get(domainId, getAddress(account)) as { adapter: Address; code_hash: Hex } | undefined;
      return row ? [{ ...context.adapterPolicy, address: row.adapter, codeHash: row.code_hash }] : undefined;
    },
    ownsAccount(domainId: string, owner: Address, account: Address) {
      const row = db.prepare('SELECT account FROM calendar_accounts WHERE domain_id=? AND owner=?')
        .get(domainId, owner.toLowerCase()) as { account: Address } | undefined;
      return row !== undefined && getAddress(row.account) === getAddress(account);
    },
    market: () => ({ ...profile, access: 'SELF_SERVICE_TESTNET', executionBudgetAvailable: hasBudget(), gasAllowances: budget().map(b => ({
      domainId: b.domainId, remainingWei: b.remainingWei.toString(), requiredWei: b.requiredWei.toString() })) }),
    close() { db.close(); },
    async inspect() {
      const observations = await Promise.all(contexts.map(c => observe(c, true)));
      const prepared = await prepareCanonicalCalendar({ owner: getAddress(profile.owner), requestId: 'readonly-calendar-readiness',
        now: BigInt(Math.floor(Date.now() / 1_000)), observations, signer });
      validateCrossDomainWalletDraft(prepared.draft);
      return { preparationReady: true, executionBudgetAvailable: hasBudget(), environment: 'testnet', domains: prepared.draft.execution.domains.map(d => d.domain.domainId),
        orderHash: toHex(prepared.draft.execution.orderHash), quoteHash: toHex(prepared.draft.execution.quoteHash),
        staged: false, broadcast: false };
    },
    async prepare(value: unknown) {
      requireCondition(typeof value === 'object' && value !== null && !Array.isArray(value), 'invalid order request');
      const request = value as Record<string, unknown>;
      requireCondition(Object.keys(request).sort().join(',') === 'expiresAt,marketId,owner,requestId,signature'
        && request.marketId === 'base-arbitrum-calendar-v1' && typeof request.owner === 'string'
        && /^0x[0-9a-fA-F]{40}$/.test(request.owner) && typeof request.requestId === 'string'
        && /^[a-zA-Z0-9._:-]{16,96}$/.test(request.requestId)
        && typeof request.expiresAt === 'string' && /^[0-9]{1,12}$/.test(request.expiresAt)
        && typeof request.signature === 'string' && /^0x[0-9a-fA-F]{130}$/.test(request.signature), 'unsupported market or request fields');
      const owner = getAddress(request.owner);
      const selected = ownerContexts(owner);
      const now = BigInt(Math.floor(Date.now() / 1_000));
      requireCondition(BigInt(request.expiresAt) > now && BigInt(request.expiresAt) <= now + 300n, 'preparation request expired');
      const recovered = await recoverTypedDataAddress({
        domain: { name: 'Naryx Cross-chain Preparation', version: '1', chainId: 84_532, verifyingContract: selected.find(c => c.role === 'near-future')!.release.account },
        primaryType: 'PrepareCalendar', types: { PrepareCalendar: [
          { name: 'owner', type: 'address' }, { name: 'marketId', type: 'string' },
          { name: 'requestId', type: 'string' }, { name: 'expiresAt', type: 'uint256' },
        ] }, message: { owner, marketId: request.marketId, requestId: request.requestId, expiresAt: BigInt(request.expiresAt) },
        signature: request.signature as Hex,
      });
      requireCondition(getAddress(recovered) === owner, 'preparation requires the owner signature');
      const requestKey = `${owner.toLowerCase()}:${request.requestId}`;
      const prior = db.prepare('SELECT draft_json FROM canonical_calendars WHERE request_key = ?').get(requestKey) as { draft_json: string } | undefined;
      if (prior) return parseProtocolJson(prior.draft_json) as CrossDomainWalletDraft;
      requireCondition(hasBudget(), 'worker allowance must cover entry, full recovery and inventory release before preparing');
      const observations = await Promise.all(selected.map(c => observe(c, true)));
      const prepared = await prepareCanonicalCalendar({ owner, requestId: request.requestId,
        now: BigInt(Math.floor(Date.now() / 1_000)), observations, signer });
      validateCrossDomainWalletDraft(prepared.draft);
      db.prepare('INSERT INTO canonical_calendars VALUES (?, ?, ?, ?)').run(toHex(prepared.draft.execution.orderHash), requestKey,
        stringifyProtocolJson(prepared.draft), stringifyProtocolJson(prepared.documents));
      return prepared.draft;
    },
    async validate(draft: CrossDomainWalletDraft) {
      const row = db.prepare('SELECT draft_json FROM canonical_calendars WHERE order_hash = ?').get(toHex(draft.execution.orderHash)) as { draft_json: string } | undefined;
      requireCondition(row && row.draft_json === stringifyProtocolJson(draft), 'preparation is not the stored canonical execution');
      const observations = await Promise.all(ownerContexts(getAddress(draft.owner)).map(c => observe(c, true)));
      for (const o of observations) {
        const entry = draft.execution.domains.find(d => d.domain.domainId === o.domain.domainId);
        requireCondition(entry?.kind === 'EVM_MULTI_STRATEGY_ACCOUNT' && entry.envelope.execution.nonce === o.nonce,
          'prepared account nonce changed');
      }
    },
    documents(orderHash: string) {
      requireCondition(/^[0-9a-f]{64}$/.test(orderHash), 'invalid order hash');
      const row = db.prepare('SELECT documents_json FROM canonical_calendars WHERE order_hash = ?').get(orderHash) as { documents_json: string } | undefined;
      return row ? parseProtocolJson(row.documents_json) : undefined;
    },
    async exit(draft: CrossDomainWalletDraft, domainId: string, signature?: Hex) {
      const orderHash = toHex(draft.execution.orderHash);
      const stored = db.prepare('SELECT draft_json FROM canonical_calendars WHERE order_hash = ?').get(orderHash) as { draft_json: string } | undefined;
      requireCondition(stored?.draft_json === stringifyProtocolJson(draft), 'exit requires a canonical order');
      const context = ownerContexts(getAddress(draft.owner)).find(c => c.release.domain.domainId === domainId);
      const original = draft.lanes.find(l => l.domainId === domainId)?.recovery;
      requireCondition(context && original, 'exit domain is unsupported');
      const { lane, client, instance, adapterPolicy, release: r } = context;
      requireCondition(await lane.port.chainId() === lane.lane.chainReference, 'exit RPC chain changed');
      const [owner, nonce, state, adapterState] = await Promise.all([
        lane.port.accountOwner(r.account), lane.port.accountNextNonce(r.account), lane.port.packageState(r.account, r.packageId),
        lane.port.recoveryAdapterState(adapterPolicy),
      ]);
      requireCondition(getAddress(owner) === getAddress(draft.owner) && adapterState.codeHash === adapterPolicy.codeHash
        && adapterState.packageId === r.packageId && getAddress(adapterState.account) === getAddress(r.account), 'exit ownership or deployment changed');
      if (!state.active && state.stateHash === ZERO && adapterState.derivative?.sizeWad === 0n
        && adapterState.derivative.balanceWad === 0n && adapterState.derivative.reserveAtoms === 0n
        && adapterState.derivative.entryNotionalWad === 0n && adapterState.derivative.entrySizeWad === 0n
        && adapterState.derivative.entryPayloadHash === ZERO) {
        const receipt = state.lastReceiptHash === ZERO ? undefined : await lane.port.packageReceipt(r.account, state.lastReceiptHash);
        const receiptHash = receipt?.orderHash === `0x${orderHash}` && receipt.packageId === r.packageId ? state.lastReceiptHash : null;
        db.prepare('INSERT INTO canonical_calendar_exits VALUES (?, ?, NULL, ?) ON CONFLICT(order_hash,domain_id) DO UPDATE SET receipt_hash=excluded.receipt_hash')
          .run(orderHash, domainId, receiptHash);
        return { state: receiptHash === null ? 'FLAT' : 'CLOSED', domainId, receiptHash };
      }
      requireCondition(state.active && state.stateHash === original.execution.previousStateHash, 'package state differs from this entry');
      const now = await lane.port.currentTime();
      const row = db.prepare('SELECT envelope_json FROM canonical_calendar_exits WHERE order_hash=? AND domain_id=?')
        .get(orderHash, domainId) as { envelope_json: string | null } | undefined;
      let envelope = row?.envelope_json ? parseProtocolJson(row.envelope_json) as EvmMultiStrategyAccountEnvelope : undefined;
      if (signature === undefined && (!envelope || envelope.execution.nonce !== nonce || envelope.execution.deadline <= now + 60n)) {
        const maturity = await client.readContract({ address: instance.address, abi: ADAPTER_ABI, functionName: 'expiry' });
        envelope = refreshCalendarRecovery(original, lane.lane.domain, adapterPolicy.codeHash, Number(maturity), nonce, now + 900n);
        db.prepare('INSERT INTO canonical_calendar_exits VALUES (?, ?, ?, NULL) ON CONFLICT(order_hash,domain_id) DO UPDATE SET envelope_json=excluded.envelope_json, receipt_hash=NULL')
          .run(orderHash, domainId, stringifyProtocolJson(envelope));
      }
      requireCondition(envelope && envelope.execution.nonce === nonce && envelope.execution.deadline > now, 'exit approval expired or account nonce changed');
      if (signature === undefined) return { state: 'PREPARED', domainId, envelope };
      requireCondition(getAddress(await recoverTypedDataAddress({ ...envelope.ownerTypedData, signature })) === getAddress(owner), 'exit signature belongs to another owner');
      return { state: 'READY', domainId, transaction: { to: envelope.account, value: '0',
        data: encodeEvmMultiStrategyAccountRecovery({ envelope, ownerSignature: signature }) } };
    },
    async reserve(draft: CrossDomainWalletDraft) {
      const stored = db.prepare('SELECT draft_json, documents_json FROM canonical_calendars WHERE order_hash = ?')
        .get(toHex(draft.execution.orderHash)) as { draft_json: string; documents_json: string } | undefined;
      if (!stored) return false;
      requireCondition(stored.draft_json === stringifyProtocolJson(draft), 'reservation draft differs from the canonical execution');
      const documents = parseProtocolJson(stored.documents_json) as { order: { nonce: bigint } };
      for (const { lane, client, release: r, adapterPolicy } of ownerContexts(getAddress(draft.owner))) {
        requireCondition(await lane.port.chainId() === lane.lane.chainReference
          && await lane.port.codeHash(lane.lane.reservationBook) === lane.lane.reservationBookCodeHash, 'reservation domain or code changed');
        const leg = draft.lanes.find(l => l.domainId === r.domain.domainId)!;
        const domain = draft.execution.domains.find(d => d.domain.domainId === r.domain.domainId)!;
        requireCondition(domain.kind === 'EVM_MULTI_STRATEGY_ACCOUNT', 'unsupported reservation account');
        const current = await lane.port.reservation(lane.lane.reservationBook, leg.inventoryReservationId);
        const orderHash = `0x${toHex(draft.execution.orderHash)}` as Hex;
        const quoteHash = `0x${toHex(draft.execution.quoteHash)}` as Hex;
        const routeHash = `0x${toHex(draft.execution.routeHash)}` as Hex;
        const submit = (step: string, to: Address, data: Hex, gas: bigint) => lane.port.submit({
          operationId: `${toHex(calendarCommitment({ orderHash, chainId: r.chainId }))}:${step}`, to, data, gas,
          maximumFeePerGasWei: lane.lane.maximumFeePerGasWei,
        });
        if (current.state === 'NONE') {
          requireCondition(await lane.port.liveReservationId(lane.lane.reservationBook, r.solver, r.account) === ZERO,
            'account inventory is reserved by another package');
          const [balance, allowance] = await Promise.all([
            client.readContract({ address: adapterPolicy.baseToken, abi: TOKEN_ABI, functionName: 'balanceOf', args: [r.solver] }),
            client.readContract({ address: adapterPolicy.baseToken, abi: TOKEN_ABI, functionName: 'allowance', args: [r.solver, lane.lane.reservationBook] }),
          ]);
          if (balance < CALENDAR_QUANTITY) return false;
          if (allowance < CALENDAR_QUANTITY) {
            await submit('APPROVE_INVENTORY', adapterPolicy.baseToken, encodeFunctionData({ abi: TOKEN_ABI, functionName: 'approve',
              args: [lane.lane.reservationBook, CALENDAR_QUANTITY] }), 100_000n);
            return false;
          }
          await submit('RESERVE_INVENTORY', lane.lane.reservationBook, encodeFunctionData({ abi: BOOK_ABI, functionName: 'reserve', args: [{
            domain: { domainIdHash: keccak256(stringToHex(r.domain.domainId)), manifestVersion: r.domain.domainManifestVersion,
              manifestHash: r.domain.domainManifestHash }, solverId: 'registered-cross-domain-calendar-v1', solver: r.solver,
            reclaimOwner: r.solver, strategyAccount: r.account, packageNonce: domain.envelope.execution.nonce, orderHash,
            reservationNonce: documents.order.nonce, baseAtoms: CALENDAR_QUANTITY, quoteAtoms: CALENDAR_COLLATERAL,
            expiry: draft.plan.commitDeadline + 240n, consumer: r.account, consumerCodeHash: r.accountCodeHash,
          }] }), 700_000n);
          return false;
        }
        requireCondition(getAddress(current.solver) === getAddress(r.solver) && getAddress(current.strategyAccount) === getAddress(r.account)
          && current.orderHash === orderHash && current.baseAtoms === CALENDAR_QUANTITY && current.quoteAtoms === CALENDAR_COLLATERAL
          && current.packageNonce === domain.envelope.execution.nonce && current.expiry === draft.plan.commitDeadline + 240n,
        'reservation differs from the signed package');
        if (current.state === 'FUNDED') {
          await submit('FINALIZE_INVENTORY', lane.lane.reservationBook, encodeFunctionData({ abi: BOOK_ABI, functionName: 'finalizeReservation',
            args: [leg.inventoryReservationId, quoteHash, routeHash] }), 150_000n);
          return false;
        }
        requireCondition(current.state === 'LIVE' && current.quoteHash === quoteHash && current.routeHash === routeHash,
          'reservation is not live for the signed quote and route');
      }
      return true;
    },
  };
}
