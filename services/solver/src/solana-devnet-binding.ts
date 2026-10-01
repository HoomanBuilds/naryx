import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  compileFirmCashCarryPlan,
  type FirmCashCarryBinding,
  type FirmCashCarryQuoteArgs,
} from '@naryx/adapter-solana';
import {
  bytesEqual,
  fromProtocolJson,
  stringifyProtocolJson,
  toProtocolJson,
  type PackageAdmission,
} from '@naryx/protocol-types';
import { ComputeBudgetProgram, PublicKey, TransactionInstruction } from '@solana/web3.js';
import type { SelectedSolanaAdmissionProvider } from './solana-execution-authorization.js';
import {
  deriveSolanaDevnetFirmAccounts,
  firmRouteBindingId,
  priceSolanaDevnetEntry,
  programAddress,
  readSolanaDevnetQuoteState,
  type SolanaDevnetFirmQuoteJournal,
  type SolanaDevnetLiveQuoteState,
} from './solana-devnet-firm-quote.js';
import { requireSolanaDevnet, type SolanaDevnetSolverReadPort, type SolanaDevnetSolverWritePort } from './solana-devnet-rpc.js';
import {
  SOLANA_DEVNET_RESOURCE_NAMES,
  type SolanaDevnetSharedManifest,
  type SolanaDevnetSolverConfig,
  type SolanaDevnetSolverKey,
} from './solana-devnet-solver-config.js';
import {
  BorshReader,
  BorshWriter,
  QUOTE_MODE_FIRM_ONCHAIN,
  QUOTE_SIDE_ASK,
  accountDiscriminator,
  associatedTokenAddress,
  decodeFirmQuoteLock,
  decodeFirmReservation,
  decodePackageQuoteShard,
  decodeQuoteLevelPage,
  decodeResourceIndexActiveRecord,
  decodeSeriesIndexActiveRecord,
  decodeTestPerpPosition,
  decodeTestPerpStrategyController,
  decodeTokenAccount,
  instructionDiscriminator,
  packageFillCommitment,
  reservationIdFor,
  sameDomain,
  sha256,
  type FirmQuoteLockState,
  type FirmReservationState,
} from './solana-devnet-wire.js';

const ATTEMPT_ID = /^local-atomic-[0-9a-f]{64}$/;
const WRITE_COMPUTE_UNITS = 400_000;

export class SolanaDevnetBindingError extends Error {
  readonly code: 'INVALID_REQUEST' | 'ATTEMPT_NOT_FOUND' | 'NOT_READY' | 'BINDING_MISMATCH';

  constructor(code: SolanaDevnetBindingError['code'], message: string) {
    super(`${code}: ${message}`);
    this.name = 'SolanaDevnetBindingError';
    this.code = code;
  }
}

function mismatch(message: string): never {
  throw new SolanaDevnetBindingError('BINDING_MISMATCH', message);
}

function notReady(message: string): never {
  throw new SolanaDevnetBindingError('NOT_READY', message);
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function quoteArgsBytes(args: FirmCashCarryQuoteArgs): Buffer {
  return new BorshWriter()
    .bytes(args.packageBookCodeIdentity).bytes(args.seriesManifestHash).bytes(args.executionClassManifestHash)
    .u64(args.expectedReferenceSequence).u64(args.expectedShardSequence).u8(args.slotIndex).u64(args.levelId)
    .u64(args.expectedLevelSequence).u8(args.expectedSide).u64(args.packageSizeUnits).i128(args.expectedPackagePrice)
    .u64(args.expectedMaxFeeAtoms).u64(args.expectedExpirySlot).bytes(args.expectedSettlementClassIdentityHash)
    .u8(args.expectedQuoteMode).bytes(args.expectedReservationPolicyHash).bytes(args.reservationId)
    .bytes(args.expectedFillCommitment)
    .done();
}

/** `firm_quote_args_hash` in naryx_core: sha256 of the domain tag and the Borsh quote args. */
export function solanaDevnetQuoteArgsHash(args: FirmCashCarryQuoteArgs): Uint8Array {
  return sha256(Buffer.from('NARYX/firm-quote-args/v1', 'ascii'), quoteArgsBytes(args));
}

function perLot(price: Readonly<{ quoteAtoms: bigint; baseAtoms: bigint }>, lot: bigint, rounding: 'CEIL' | 'FLOOR'): bigint {
  const numerator = price.quoteAtoms * lot;
  return rounding === 'CEIL' ? (numerator + price.baseAtoms - 1n) / price.baseAtoms : numerator / price.baseAtoms;
}

function decodeSolverRegistryActive(data: Uint8Array): readonly string[] {
  const reader = new BorshReader(data, accountDiscriminator('SolverRegistry'), 'SolverRegistry');
  const length = reader.u32();
  if (length > 64) mismatch('solver registry is malformed');
  return Array.from({ length }, () => reader.key());
}

export type SolanaDevnetBindingDependencies = Readonly<{
  manifest: SolanaDevnetSharedManifest;
  config: SolanaDevnetSolverConfig;
  rpc: SolanaDevnetSolverReadPort;
  writer?: SolanaDevnetSolverWritePort;
  key: SolanaDevnetSolverKey;
  journal: SolanaDevnetFirmQuoteJournal;
  admissions: SelectedSolanaAdmissionProvider;
}>;

/**
 * Builds the firm binding for a selected Devnet attempt from live finalized accounts. With solver
 * writes enabled it first funds and finalizes the inventory reservation and locks the firm quote,
 * each finalized before the next step; without them it binds only an already live reservation and
 * an unconsumed lock. The execution digest is signed only after the plan compiles locally.
 */
export function createSolanaDevnetBindingService(dependencies: SolanaDevnetBindingDependencies) {
  const { manifest, config, rpc, key, journal } = dependencies;
  const pending = new Map<string, Promise<FirmCashCarryBinding>>();
  const core = programAddress(manifest, 'core');
  const reservationProgram = programAddress(manifest, 'reservation');

  async function read(addresses: readonly string[], slot: bigint) {
    const accounts = await rpc.getAccounts(addresses, slot);
    return accounts;
  }

  function quoteArgsFor(
    admission: PackageAdmission,
    state: SolanaDevnetLiveQuoteState,
    record: Readonly<{ slotIndex: number; levelId: bigint }>,
    accounts: Readonly<Record<string, string>>,
    reservationId: Uint8Array,
    expiry: bigint,
    units: bigint,
  ): FirmCashCarryQuoteArgs {
    const level = state.levels[record.slotIndex];
    if (level === undefined || !level.active || level.epoch !== state.shard.epoch || level.levelId !== record.levelId
      || level.side !== QUOTE_SIDE_ASK || level.quoteMode !== QUOTE_MODE_FIRM_ONCHAIN || level.expirySlot !== expiry
      || units > level.remainingCapacity) {
      notReady('the quoted firm ask level is no longer live; request a new quote');
    }
    const packagePrice = state.shard.referencePackagePrice + level.referenceOffset;
    const fill = packageFillCommitment({
      domain: manifest.domain,
      shard: config.accounts.packageBookShard,
      solver: config.solverId,
      solverId: state.shard.solverId,
      consumerAuthority: accounts.quoteLock!,
      seriesManifestHash: config.series.seriesManifestHash,
      executionClassManifestHash: config.series.executionClassManifestHash,
      referenceStateHash: state.shard.referenceStateHash,
      level,
      referenceSequence: state.shard.referenceSequence,
      shardSequenceAfter: state.shard.shardSequence + 1n,
      packageSizeUnits: units,
      packagePrice,
      reservationId,
      orderHash: admission.orderHash,
      quoteHash: admission.quoteHash,
      routeHash: admission.routeHash,
    });
    return Object.freeze({
      packageBookCodeIdentity: programAddress(manifest, 'package_book').codeIdentity,
      seriesManifestHash: config.series.seriesManifestHash,
      executionClassManifestHash: config.series.executionClassManifestHash,
      expectedReferenceSequence: state.shard.referenceSequence,
      expectedShardSequence: state.shard.shardSequence,
      slotIndex: record.slotIndex,
      levelId: level.levelId,
      expectedLevelSequence: level.levelSequence,
      expectedSide: 2,
      packageSizeUnits: units,
      expectedPackagePrice: packagePrice,
      expectedMaxFeeAtoms: 0n,
      expectedExpirySlot: expiry,
      expectedSettlementClassIdentityHash: level.settlementClassIdentityHash,
      expectedQuoteMode: 2,
      expectedReservationPolicyHash: level.reservationPolicyHash,
      reservationId,
      expectedFillCommitment: fill,
    });
  }

  async function build(attemptId: string): Promise<FirmCashCarryBinding> {
    if (!ATTEMPT_ID.test(attemptId)) throw new SolanaDevnetBindingError('INVALID_REQUEST', 'attemptId is invalid');
    const admission = await dependencies.admissions(attemptId);
    if (admission === undefined) throw new SolanaDevnetBindingError('ATTEMPT_NOT_FOUND', 'attempt was not found');
    const { order, quote, route } = admission;
    const record = journal.get(hex(admission.orderHash));
    if (record === undefined || record.response.quoteHash !== hex(admission.quoteHash)
      || record.response.routeHash !== hex(admission.routeHash)) {
      mismatch('selected attempt is not a firm quote this solver signed');
    }
    if (!sameDomain(order.domain, manifest.domain) || quote.quoteMode !== 'FIRM_ONCHAIN'
      || quote.solverId !== config.solverId || route.solver !== config.solverId || quote.reservationId === undefined
      || !bytesEqual(quote.solverVerificationKey, key.verificationKey)) {
      mismatch('selected quote is not this solver\'s Devnet firm quote');
    }
    const reservationNonce = Uint8Array.from(Buffer.from(record.reservationNonceHex, 'hex'));
    const reservationId = reservationIdFor(manifest.domain, config.solverId, admission.orderHash, reservationNonce);
    if (!bytesEqual(reservationId, quote.reservationId)) mismatch('quote reservation id does not match the journal');
    const quantity = order.quantity.atoms;
    const units = quantity / config.series.spotBaseAtomsPerPackageUnit;
    const expiry = [order.expiryValue, quote.validUntilValue, route.routeExpiryValue].reduce((left, right) => (left < right ? left : right));
    const firmQuoteAtoms = quote.expectedSpotNotional.atoms;

    let state = await readSolanaDevnetQuoteState(rpc, manifest, config);
    if (state.slot >= expiry) notReady('the firm quote has expired; request a new quote');
    const accounts = deriveSolanaDevnetFirmAccounts({
      manifest, config, market: state.market, owner: order.owner, orderHash: admission.orderHash, nonce: order.nonce, reservationId,
    });
    for (const binding of route.accountBindings) {
      const name = binding.routeBindingId.startsWith('firm-') ? binding.routeBindingId.slice(5) : undefined;
      if (name === undefined || accounts[name] !== binding.accountIdentity) mismatch(`route binding ${binding.routeBindingId} does not match live derivation`);
    }

    // Trader readiness: own strategy controlled by the executor, delegated position, prefunded collateral.
    const traderReads = await read([
      accounts.riseStrategy!, accounts.testPerpPosition!, accounts.executorAuthority!, accounts.solverRegistry!,
    ], state.slot);
    const [strategyAccount, positionAccount, executorAccount, registryAccount] = traderReads;
    if (strategyAccount === null || strategyAccount === undefined || strategyAccount.owner !== programAddress(manifest, 'perp_adapter').programId) {
      notReady('trader strategy is not initialized');
    }
    const strategy = decodeTestPerpStrategyController(strategyAccount.data);
    if (strategy.owner !== order.owner || strategy.controller !== accounts.executorAuthority || strategy.position !== accounts.testPerpPosition) {
      notReady('trader strategy is not controlled by the Naryx executor');
    }
    if (positionAccount === null || positionAccount === undefined || positionAccount.owner !== programAddress(manifest, 'perp_venue').programId) {
      notReady('trader test perp position is not initialized');
    }
    const position = decodeTestPerpPosition(positionAccount.data);
    if (position.owner !== order.owner || position.delegate !== accounts.riseStrategy || position.baseLots !== 0n) {
      notReady('trader position is not flat or not delegated to the strategy');
    }
    if (executorAccount === null || executorAccount === undefined || executorAccount.owner !== core.programId) {
      notReady('trader executor authority is not initialized');
    }
    if (registryAccount === null || registryAccount === undefined || registryAccount.owner !== core.programId
      || !decodeSolverRegistryActive(registryAccount.data).includes(config.solverId)) {
      mismatch('solver is not active in the core solver registry');
    }
    const pricing = priceSolanaDevnetEntry(config, state.market, state.oraclePricePerLot, quantity);
    // The program requires prefunded collateral at or above this floor before and after the fee.
    const minimumCollateral = pricing.initialMarginAtoms > 0n ? pricing.initialMarginAtoms : 1n;
    if (position.collateralAtoms < minimumCollateral + pricing.perpFeeAtoms) {
      notReady(`trader collateral ${position.collateralAtoms} is below the required ${minimumCollateral + pricing.perpFeeAtoms} atoms`);
    }

    // Inventory reservation: fund and finalize when absent, finalize when funded, then lock.
    const [reservationAccount] = await read([accounts.reservation!], state.slot);
    let reservation: FirmReservationState | undefined = reservationAccount === null || reservationAccount === undefined
      ? undefined : decodeFirmReservation(reservationAccount.data);
    if (reservation === undefined || reservation.state === 'FUNDED') {
      if (dependencies.writer === undefined) notReady('reservation is not live and solver writes are disabled');
      if (quantity > config.maxQuantityAtoms || quantity > state.reservationClass.maxBaseAtoms) mismatch('reservation exceeds the reviewed base limit');
      const instructions: TransactionInstruction[] = [ComputeBudgetProgram.setComputeUnitLimit({ units: WRITE_COMPUTE_UNITS })];
      if (reservation === undefined) {
        const solverBase = associatedTokenAddress(config.solverId, config.resources.baseAsset.subjectAddress).toBase58();
        instructions.push(new TransactionInstruction({
          programId: new PublicKey(reservationProgram.programId),
          keys: [
            [config.solverId, true, true], [core.programId, false, false], [core.programDataAddress, false, false],
            [accounts.config!, false, false], [accounts.reservationClass!, false, false], [accounts.reservationCapacity!, false, true],
            [accounts.reservation!, false, true], [accounts.livePair!, false, true], [accounts.reservationVault!, false, true],
            [config.resources.baseAsset.subjectAddress, false, false], [config.resources.quoteAsset.subjectAddress, false, false],
            [solverBase, false, true], [accounts.solverQuote!, false, false], [accounts.executorBase!, false, false],
            [accounts.executorQuote!, false, false], [accounts.tokenProgram!, false, false], [accounts.systemProgram!, false, false],
          ].map(([pubkey, isSigner, isWritable]) => ({ pubkey: new PublicKey(pubkey as string), isSigner: isSigner as boolean, isWritable: isWritable as boolean })),
          data: new BorshWriter()
            .bytes(instructionDiscriminator('fund_reservation'))
            .domain(manifest.domain).bytes(reservationId).string(config.solverId).key(accounts.executorAuthority!)
            .u64(order.nonce).bytes(admission.orderHash).bytes(admission.routeHash).bytes(reservationNonce)
            .u64(quantity).u64(firmQuoteAtoms).u64(expiry)
            .done(),
        }));
      }
      instructions.push(new TransactionInstruction({
        programId: new PublicKey(reservationProgram.programId),
        keys: [
          { pubkey: new PublicKey(config.solverId), isSigner: true, isWritable: false },
          { pubkey: new PublicKey(accounts.reservationClass!), isSigner: false, isWritable: false },
          { pubkey: new PublicKey(accounts.reservation!), isSigner: false, isWritable: true },
        ],
        data: Buffer.concat([instructionDiscriminator('finalize_reservation'), Buffer.from(admission.quoteHash)]),
      }));
      await dependencies.writer.sendAndFinalize(instructions, key.keypair);
      state = await readSolanaDevnetQuoteState(rpc, manifest, config);
      const [funded] = await read([accounts.reservation!], state.slot);
      reservation = funded === null || funded === undefined ? undefined : decodeFirmReservation(funded.data);
    }
    if (reservation === undefined || reservation.state !== 'LIVE') notReady('reservation is not live');

    const [lockAccount] = await read([accounts.quoteLock!], state.slot);
    let lock: FirmQuoteLockState | undefined = lockAccount === null || lockAccount === undefined ? undefined : decodeFirmQuoteLock(lockAccount.data);
    let quoteArgs: FirmCashCarryQuoteArgs;
    if (lock === undefined) {
      if (dependencies.writer === undefined) notReady('quote lock is absent and solver writes are disabled');
      quoteArgs = quoteArgsFor(admission, state, record, accounts, reservationId, expiry, units);
      journal.recordLockArgs(record.orderHash, stringifyProtocolJson(quoteArgs, 'lockArgs'));
    } else {
      if (record.lockArgsJson === undefined) mismatch('a quote lock exists without journaled lock arguments');
      quoteArgs = fromProtocolJson(JSON.parse(record.lockArgsJson), 'lockArgs') as FirmCashCarryQuoteArgs;
    }

    const assemble = (slot: bigint, liveReservation: FirmReservationState, tokens: FirmCashCarryBinding['tokenAccounts'], signature: Uint8Array): FirmCashCarryBinding => {
      const deployments = Object.fromEntries((['core', 'reservation', 'packageBook', 'perpAdapter', 'perpVenue'] as const).map((name) => {
        const program = programAddress(manifest, { core: 'core', reservation: 'reservation', packageBook: 'package_book', perpAdapter: 'perp_adapter', perpVenue: 'perp_venue' }[name]);
        return [name, { programId: program.programId, programDataAddress: program.programDataAddress, codeIdentity: program.codeIdentity }];
      })) as unknown as FirmCashCarryBinding['deployments'];
      const resource = (name: typeof SOLANA_DEVNET_RESOURCE_NAMES[number]) => {
        const value = config.resources[name];
        return {
          manifestHash: value.manifestHash,
          subjectAddress: value.subjectAddress,
          programId: value.programId,
          ...(value.codeIdentity === undefined ? {} : { codeIdentity: value.codeIdentity }),
          ...(value.adapterClassId === undefined ? {} : { adapterClassId: value.adapterClassId }),
        };
      };
      const spotLimit = perLot(route.legs[0]!.limitPrice, config.spotBaseLotAtoms, 'CEIL');
      const perpLimit = perLot(route.legs[1]!.limitPrice, state.market.baseLotAtoms, 'FLOOR');
      const spotNotional = (quantity / config.spotBaseLotAtoms) * spotLimit;
      const perpNotional = (quantity / state.market.baseLotAtoms) * perpLimit;
      const entries = Object.entries(accounts).map(([name, address]) => [name, { address, routeBindingId: firmRouteBindingId(name) }]);
      return {
        environment: 'devnet',
        domain: manifest.domain,
        coreIdl: manifest.coreIdl,
        expectedCoreIdlHash: manifest.expectedCoreIdlHash,
        deployments,
        perpVenueKind: 'NARYX_TEST_PERP',
        accounts: Object.fromEntries(entries) as unknown as FirmCashCarryBinding['accounts'],
        riseDynamicAccounts: [],
        tokenAccounts: tokens,
        resources: {
          spotAdapter: resource('spotAdapter'), perpAdapter: resource('perpAdapter'), spotMarket: resource('spotMarket'),
          perpMarket: resource('perpMarket'), spotVenue: resource('spotVenue'), perpVenue: resource('perpVenue'),
          baseAsset: resource('baseAsset'), quoteAsset: resource('quoteAsset'),
          spotBaseLotAtoms: config.spotBaseLotAtoms,
          perpBaseLotAtoms: state.market.baseLotAtoms,
          perpQuoteTickAtomsPerBaseLot: state.market.quoteTickAtomsPerBaseLot,
        },
        series: { ...config.series, entrySide: 'ASK' },
        reservationClass: {
          version: 2,
          domain: state.reservationClass.domain,
          policyHash: state.reservationClass.policyHash,
          baseMint: state.reservationClass.baseMint,
          quoteMint: state.reservationClass.quoteMint,
          maxTtlSlots: state.reservationClass.maxTtlSlots,
          maxBaseAtoms: state.reservationClass.maxBaseAtoms,
          maxSolverReservedBaseAtoms: state.reservationClass.maxSolverReservedBaseAtoms,
        },
        reservation: {
          fundingFinalized: true,
          state: 'LIVE',
          domain: liveReservation.domain,
          reservationId: liveReservation.reservationId,
          reservationNonce: liveReservation.reservationNonce,
          solverId: liveReservation.solverId,
          solver: liveReservation.solver,
          strategyAuthority: liveReservation.strategyAuthority,
          packageNonce: liveReservation.packageNonce,
          orderHash: liveReservation.orderHash,
          quoteHash: liveReservation.quoteHash,
          routeHash: liveReservation.routeHash,
          baseMint: liveReservation.baseMint,
          quoteMint: liveReservation.quoteMint,
          solverReclaimBase: liveReservation.solverReclaimBase,
          solverQuote: liveReservation.solverQuote,
          strategyBase: liveReservation.strategyBase,
          strategyQuote: liveReservation.strategyQuote,
          baseAtoms: liveReservation.baseAtoms,
          quoteAtoms: liveReservation.quoteAtoms,
          expirySlot: liveReservation.expirySlot,
          action: 'ENTRY',
        },
        quoteLock: {
          consumed: false,
          domain: manifest.domain,
          solver: config.solverId,
          reservation: accounts.reservation!,
          reservationId,
          reservationPolicyHash: quoteArgs.expectedReservationPolicyHash,
          orderHash: admission.orderHash,
          quoteHash: admission.quoteHash,
          routeHash: admission.routeHash,
          quoteArgsHash: solanaDevnetQuoteArgsHash(quoteArgs),
          seriesManifestHash: config.series.seriesManifestHash,
          executionClassManifestHash: config.series.executionClassManifestHash,
          fillCommitment: quoteArgs.expectedFillCommitment,
          packageSizeUnits: units,
          baseAtoms: liveReservation.baseAtoms,
          quoteAtoms: liveReservation.quoteAtoms,
          expirySlot: expiry,
        },
        executionArgs: {
          spotQuantityAtoms: quantity,
          perpQuantityAtoms: quantity,
          spotLimitQuoteAtomsPerBaseLot: spotLimit,
          perpLimitQuoteAtomsPerBaseLot: perpLimit,
          packageNotionalAtoms: spotNotional > perpNotional ? spotNotional : perpNotional,
          spotSqrtPriceLimit: 1n,
          minimumRiseCollateralQuoteLots: minimumCollateral,
          clientOrderId: BigInt(`0x${hex(admission.orderHash).slice(0, 32)}`),
          expirySlot: expiry,
          nonce: order.nonce,
        },
        quoteArgs,
        firmQuoteAtoms,
        resourceAdmissionCommitment: config.resourceAdmissionCommitment,
        solverSignature: signature,
        computeUnitLimit: config.computeUnitLimit,
        currentSlot: slot,
        traderRouteBindingId: firmRouteBindingId('trader'),
        solverRouteBindingId: firmRouteBindingId('solver'),
      } as unknown as FirmCashCarryBinding;
    };

    const tokenNames = ['reservationVault', 'solverQuote', 'traderBase', 'traderQuote', 'executorBase', 'executorQuote'] as const;
    const readTokens = async (slot: bigint): Promise<FirmCashCarryBinding['tokenAccounts']> => {
      const tokenAccounts = await read(tokenNames.map((name) => accounts[name]!), slot);
      return Object.fromEntries(tokenNames.map((name, index) => {
        const account = tokenAccounts[index];
        if (account === null || account === undefined || account.owner !== accounts.tokenProgram) notReady(`${name} token account is absent`);
        const token = decodeTokenAccount(account.data);
        return [name, { mint: token.mint, authority: token.owner, amountAtoms: token.amount }];
      })) as unknown as FirmCashCarryBinding['tokenAccounts'];
    };

    if (lock === undefined) {
      const tokens = await readTokens(state.slot);
      const plan = compileFirmCashCarryPlan(admission, assemble(state.slot, reservation, tokens, new Uint8Array(64)));
      await dependencies.writer!.sendAndFinalize([
        ComputeBudgetProgram.setComputeUnitLimit({ units: WRITE_COMPUTE_UNITS }),
        ...plan.solverLock.instructions,
      ], key.keypair);
    }

    // Final evidence: everything re-read at one finalized slot after the last write.
    await requireSolanaDevnet(rpc);
    const slot = await rpc.getFinalizedSlot();
    const [finalReservationAccount, finalLockAccount, ...registry] = await read([
      accounts.reservation!, accounts.quoteLock!,
      ...SOLANA_DEVNET_RESOURCE_NAMES.map((name) => config.accounts.indexes[name]), config.accounts.seriesIndex,
    ], slot);
    if (finalReservationAccount === null || finalReservationAccount === undefined || finalReservationAccount.owner !== reservationProgram.programId) notReady('reservation is absent');
    if (finalLockAccount === null || finalLockAccount === undefined || finalLockAccount.owner !== core.programId) notReady('quote lock is absent');
    const finalReservation = decodeFirmReservation(finalReservationAccount.data);
    lock = decodeFirmQuoteLock(finalLockAccount.data);
    if (finalReservation.state !== 'LIVE' || lock.consumed || !bytesEqual(lock.quoteArgsHash, solanaDevnetQuoteArgsHash(quoteArgs))
      || !bytesEqual(lock.fillCommitment, quoteArgs.expectedFillCommitment)) {
      mismatch('live reservation or quote lock does not match the journaled firm quote');
    }
    SOLANA_DEVNET_RESOURCE_NAMES.forEach((name, index) => {
      const account = registry[index];
      if (account === null || account === undefined || account.owner !== core.programId
        || decodeResourceIndexActiveRecord(account.data) !== new PublicKey(config.accounts.records[name]).toBase58()) {
        mismatch(`registry index ${name} does not point at the reviewed active record`);
      }
    });
    const seriesIndex = registry[SOLANA_DEVNET_RESOURCE_NAMES.length];
    if (seriesIndex === null || seriesIndex === undefined || seriesIndex.owner !== core.programId
      || decodeSeriesIndexActiveRecord(seriesIndex.data) !== new PublicKey(config.accounts.seriesRecord).toBase58()) {
      mismatch('series index does not point at the reviewed active record');
    }
    const tokens = await readTokens(slot);
    const unsigned = assemble(slot, finalReservation, tokens, new Uint8Array(64));
    const plan = compileFirmCashCarryPlan(admission, unsigned);
    const signature = key.signDigest(plan.executionDigest);
    return Object.freeze({ ...unsigned, solverSignature: signature });
  }

  return Object.freeze({
    readBinding(attemptId: string): Promise<FirmCashCarryBinding> {
      const active = pending.get(attemptId);
      if (active !== undefined) return active;
      const task = build(attemptId).finally(() => pending.delete(attemptId));
      pending.set(attemptId, task);
      return task;
    },
  });
}

function isLoopback(address: string | undefined): boolean {
  const candidate = address?.startsWith('::ffff:') === true ? address.slice(7) : address;
  return candidate === '::1' || (candidate?.startsWith('127.') ?? false);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > 1_024) throw new SolanaDevnetBindingError('INVALID_REQUEST', 'request body is too large');
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

/** POST /internal/solana-devnet/attempt-binding {attemptId} -> {binding}. Loopback only. */
export function createSolanaDevnetBindingServer(service: ReturnType<typeof createSolanaDevnetBindingService>): Server {
  return createServer((request, response) => {
    if (!isLoopback(request.socket.remoteAddress)) {
      sendJson(response, 403, { error: { code: 'LOOPBACK_REQUIRED', message: 'binding access is loopback-only' } });
      return;
    }
    const url = new URL(request.url ?? '/', 'http://solver.internal');
    if (url.pathname !== '/internal/solana-devnet/attempt-binding' || url.search !== '') {
      sendJson(response, 404, { error: { code: 'NOT_FOUND', message: 'internal route was not found' } });
      return;
    }
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST');
      sendJson(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'only POST is allowed' } });
      return;
    }
    void (async () => {
      try {
        const body = await readBody(request);
        if (typeof body !== 'object' || body === null || Array.isArray(body) || Object.keys(body).join(',') !== 'attemptId'
          || typeof (body as { attemptId?: unknown }).attemptId !== 'string') {
          throw new SolanaDevnetBindingError('INVALID_REQUEST', 'request must contain only attemptId');
        }
        const binding = await service.readBinding((body as { attemptId: string }).attemptId);
        sendJson(response, 200, { binding: toProtocolJson(binding, 'binding') });
      } catch (error) {
        if (error instanceof SolanaDevnetBindingError) {
          const status = error.code === 'ATTEMPT_NOT_FOUND' ? 404 : error.code === 'INVALID_REQUEST' ? 400 : 409;
          sendJson(response, status, { error: { code: error.code, message: error.message } });
          return;
        }
        sendJson(response, 502, { error: { code: 'BINDING_FAILED', message: 'Solana Devnet binding failed closed' } });
      }
    })();
  });
}

export { decodePackageQuoteShard, decodeQuoteLevelPage };
