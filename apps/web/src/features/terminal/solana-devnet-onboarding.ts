"use client";

import bs58 from "bs58";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Solana Devnet account onboarding. The private service reads which per-wallet accounts are still
 * missing (token accounts, test perp position, collateral, delegate, strategy, executor authority)
 * and returns unsigned instructions for them. Every instruction is checked here against a strict
 * template: an allowlisted program from the response, the exact account metas for its kind, the
 * connected wallet as the only signer, and a bounded collateral deposit. Each step becomes one v0
 * transaction the wallet signs and sends; the next step is shown only after the previous one is
 * finalized and the service re-read the accounts.
 */

const SOLANA_DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const SOLANA_DEVNET_RPC = process.env.NEXT_PUBLIC_SOLANA_DEVNET_RPC_URL || "https://api.devnet.solana.com";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
/** The Devnet package base asset is SOL; the service bounds the size again in atoms. */
export const SOLANA_DEVNET_BASE_DECIMALS = 9;
const PACKET_LIMIT = 1232;
const FINALITY_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 2_000;
const ZERO = BigInt(0);
/** naryx_test_perp pays at most 10,000 test USDC per claim and a step carries at most eight claims. */
const MAX_CLAIM_ATOMS = BigInt(10_000_000_000);
const MAX_CLAIMS_PER_STEP = 8;
const EIGHT = BigInt(8);
const TEN = BigInt(10);

export type SolanaDevnetOnboardingStepKind =
  | "CREATE_TOKEN_ACCOUNTS"
  | "CLAIM_TEST_COLLATERAL"
  | "INITIALIZE_POSITION"
  | "DEPOSIT_COLLATERAL"
  | "SET_POSITION_DELEGATE"
  | "INITIALIZE_STRATEGY"
  | "INITIALIZE_EXECUTOR_AUTHORITY";

type Meta = Readonly<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
type Instruction = Readonly<{ programId: string; accounts: readonly Meta[]; data: Uint8Array }>;

export type SolanaDevnetOnboardingStep = Readonly<{
  kind: SolanaDevnetOnboardingStepKind;
  label: string;
  instructions: readonly Instruction[];
}>;

export type SolanaDevnetAccountStatus = Readonly<{
  /** The active order context; the entry order is created under it with the wallet as settlement account. */
  contextId: string;
  owner: string;
  ready: boolean;
  requiredCollateralAtoms: bigint;
  /** The test perp faucet authority when the quote mint is its free test USDC; null otherwise. */
  testCollateralFaucet: string | null;
  /** The wallet's open package, read from chain; null when none (or an older service). */
  openPackage: SolanaDevnetOpenPackage | null;
  steps: readonly SolanaDevnetOnboardingStep[];
}>;

export type SolanaDevnetOpenPackage = Readonly<{
  spotQuantityAtoms: bigint;
  entryNotionalAtoms: bigint;
  baseDecimals: number;
  quoteDecimals: number;
}>;

function openPackageOf(value: unknown): SolanaDevnetOpenPackage | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) fail("open package is malformed");
  const places = (entry: unknown, name: string) => {
    if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < 0 || entry > 18) fail(`${name} is invalid`);
    return entry;
  };
  return Object.freeze({
    spotQuantityAtoms: decimal(value.spotQuantityAtoms, "openPackage.spotQuantityAtoms"),
    entryNotionalAtoms: decimal(value.entryNotionalAtoms, "openPackage.entryNotionalAtoms"),
    baseDecimals: places(value.baseDecimals, "openPackage.baseDecimals"),
    quoteDecimals: places(value.quoteDecimals, "openPackage.quoteDecimals"),
  });
}

const STEP_ORDER: readonly SolanaDevnetOnboardingStepKind[] = [
  "CREATE_TOKEN_ACCOUNTS",
  "CLAIM_TEST_COLLATERAL",
  "INITIALIZE_POSITION",
  "DEPOSIT_COLLATERAL",
  "SET_POSITION_DELEGATE",
  "INITIALIZE_STRATEGY",
  "INITIALIZE_EXECUTOR_AUTHORITY",
];

function fail(message: string): never {
  throw new Error(`Devnet account setup rejected: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function address(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) fail(`${name} is not a Solana address`);
  let bytes: Uint8Array;
  try {
    bytes = bs58.decode(value);
  } catch {
    fail(`${name} is not a Solana address`);
  }
  if (bytes.length !== 32) fail(`${name} is not a Solana address`);
  return value;
}

function decimal(value: unknown, name: string): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,30})$/.test(value)) fail(`${name} is not a decimal integer`);
  return BigInt(value);
}

function base64(value: unknown, name: string): Uint8Array {
  if (typeof value !== "string" || value.length > 2048 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) fail(`${name} is not base64`);
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

async function anchorDiscriminator(name: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`global:${name}`));
  return new Uint8Array(digest).slice(0, 8);
}

function u64Le(data: Uint8Array, offset: number): bigint {
  let value = ZERO;
  for (let index = 7; index >= 0; index -= 1) value = (value << EIGHT) | BigInt(data[offset + index]!);
  return value;
}

type Template = readonly Readonly<{ key: string; signer?: boolean; writable?: boolean }>[];

function requireMetas(instruction: Instruction, template: Template, name: string): void {
  if (instruction.accounts.length !== template.length) fail(`${name} has an unexpected account list`);
  template.forEach((expected, index) => {
    const meta = instruction.accounts[index]!;
    if (meta.pubkey !== expected.key || meta.isSigner !== (expected.signer === true) || meta.isWritable !== (expected.writable === true)) {
      fail(`${name} account ${index} does not match the reviewed template`);
    }
  });
}

/**
 * Validates the service response for the connected wallet. Anything outside the reviewed templates,
 * any extra signer, any program outside the response allowlist, and any deposit larger than the
 * reported requirement fails closed.
 */
export async function parseSolanaDevnetAccountStatus(value: unknown, expectedOwner: string): Promise<SolanaDevnetAccountStatus> {
  if (!isRecord(value) || value.domainId !== "svm:devnet" || value.environment !== "DEVNET") fail("response is not a Devnet account status");
  const owner = address(value.owner, "owner");
  if (owner !== expectedOwner || value.settlementAccount !== owner) fail("response is for a different wallet");
  if (typeof value.contextId !== "string" || !/^[A-Za-z0-9:_.-]{1,128}$/.test(value.contextId)) fail("order context id is invalid");
  const contextId = value.contextId;
  if (!isRecord(value.accounts) || !isRecord(value.programs) || !isRecord(value.market) || !isRecord(value.mints) || !Array.isArray(value.steps)) {
    fail("response is malformed");
  }
  const accounts = value.accounts;
  const derived = (name: string) => address(accounts[name], `accounts.${name}`);
  const trader = derived("trader");
  if (trader !== owner) fail("trader account is not the wallet");
  const position = derived("position");
  const strategy = derived("strategy");
  const executor = derived("executorAuthority");
  const programs = {
    core: address(value.programs.core, "programs.core"),
    perpAdapter: address(value.programs.perpAdapter, "programs.perpAdapter"),
    perpVenue: address(value.programs.perpVenue, "programs.perpVenue"),
  };
  if (value.programs.token !== TOKEN_PROGRAM || value.programs.associatedToken !== ASSOCIATED_TOKEN_PROGRAM || value.programs.system !== SYSTEM_PROGRAM) {
    fail("token, associated token, or system program id is not the canonical program");
  }
  if (new Set([programs.core, programs.perpAdapter, programs.perpVenue, TOKEN_PROGRAM, ASSOCIATED_TOKEN_PROGRAM, SYSTEM_PROGRAM]).size !== 6) {
    fail("program allowlist is not distinct");
  }
  const market = address(value.market.address, "market.address");
  const collateralVault = address(value.market.collateralVault, "market.collateralVault");
  const baseMint = address(value.mints.base, "mints.base");
  const quoteMint = address(value.mints.quote, "mints.quote");
  const requiredCollateral = decimal(value.requiredCollateralAtoms, "requiredCollateralAtoms");
  const faucet = value.testCollateralFaucet === null || value.testCollateralFaucet === undefined
    ? null : address(value.testCollateralFaucet, "testCollateralFaucet");
  const tokenAccounts = new Map([
    [derived("traderBase"), { owner, mint: baseMint }],
    [derived("traderQuote"), { owner, mint: quoteMint }],
    [derived("executorBase"), { owner: executor, mint: baseMint }],
    [derived("executorQuote"), { owner: executor, mint: quoteMint }],
  ]);
  const traderQuote = derived("traderQuote");
  const payer = { key: owner, signer: true, writable: true } as const;
  const discriminators = Object.fromEntries(await Promise.all(
    ["initialize_position", "deposit", "set_delegate", "initialize_test_perp_strategy", "initialize_cash_carry_strategy", "claim_test_collateral"]
      .map(async (name) => [name, await anchorDiscriminator(name)] as const),
  ));

  if (value.steps.length > STEP_ORDER.length) fail("too many setup steps");
  let previous = -1;
  const steps = value.steps.map((candidate, stepIndex): SolanaDevnetOnboardingStep => {
    if (!isRecord(candidate) || typeof candidate.label !== "string" || candidate.label.length > 120 || !Array.isArray(candidate.instructions)) {
      fail(`step ${stepIndex} is malformed`);
    }
    const kind = candidate.kind as SolanaDevnetOnboardingStepKind;
    const order = STEP_ORDER.indexOf(kind);
    if (order <= previous) fail(`step ${stepIndex} is unknown or out of order`);
    previous = order;
    const instructions = candidate.instructions.map((raw, index): Instruction => {
      if (!isRecord(raw) || !Array.isArray(raw.accounts) || raw.accounts.length > 16) fail(`step ${kind} instruction ${index} is malformed`);
      return Object.freeze({
        programId: address(raw.programId, "programId"),
        accounts: Object.freeze(raw.accounts.map((meta, metaIndex) => {
          if (!isRecord(meta) || typeof meta.isSigner !== "boolean" || typeof meta.isWritable !== "boolean") fail(`step ${kind} meta ${metaIndex} is malformed`);
          return Object.freeze({ pubkey: address(meta.pubkey, "meta"), isSigner: meta.isSigner, isWritable: meta.isWritable });
        })),
        data: base64(raw.dataBase64, "dataBase64"),
      });
    });
    const expectSingle = (programId: string) => {
      if (instructions.length !== 1 || instructions[0]!.programId !== programId) fail(`${kind} must be one instruction to its reviewed program`);
      return instructions[0]!;
    };
    const exactData = (instruction: Instruction, expected: Uint8Array) => {
      if (!bytesEqual(instruction.data, expected)) fail(`${kind} instruction data is not the reviewed call`);
    };
    const prefix = (instruction: Instruction, discriminator: Uint8Array, length: number) => {
      if (instruction.data.length !== length || !bytesEqual(instruction.data.slice(0, 8), discriminator)) fail(`${kind} instruction data is not the reviewed call`);
    };
    switch (kind) {
      case "CREATE_TOKEN_ACCOUNTS": {
        if (instructions.length === 0 || instructions.length > 4) fail("token account step has an unexpected size");
        const seen = new Set<string>();
        for (const instruction of instructions) {
          if (instruction.programId !== ASSOCIATED_TOKEN_PROGRAM) fail("token account step targets another program");
          const ata = instruction.accounts[1]?.pubkey ?? "";
          const expected = tokenAccounts.get(ata);
          if (expected === undefined || seen.has(ata)) fail("token account step creates an unexpected account");
          seen.add(ata);
          requireMetas(instruction, [
            payer, { key: ata, writable: true }, { key: expected.owner }, { key: expected.mint }, { key: SYSTEM_PROGRAM }, { key: TOKEN_PROGRAM },
          ], kind);
          exactData(instruction, Uint8Array.of(1));
        }
        break;
      }
      case "CLAIM_TEST_COLLATERAL": {
        if (faucet === null) fail("claim step without a test collateral faucet");
        if (instructions.length === 0 || instructions.length > MAX_CLAIMS_PER_STEP) fail("claim step has an unexpected size");
        for (const instruction of instructions) {
          if (instruction.programId !== programs.perpVenue) fail("claim step targets another program");
          requireMetas(instruction, [
            { key: owner, signer: true }, { key: quoteMint, writable: true }, { key: faucet },
            { key: traderQuote, writable: true }, { key: TOKEN_PROGRAM },
          ], kind);
          prefix(instruction, discriminators.claim_test_collateral!, 16);
          const amount = u64Le(instruction.data, 8);
          if (amount === ZERO || amount > MAX_CLAIM_ATOMS) fail("claim exceeds the faucet bound");
        }
        break;
      }
      case "INITIALIZE_POSITION": {
        const instruction = expectSingle(programs.perpVenue);
        requireMetas(instruction, [payer, { key: market }, { key: position, writable: true }, { key: SYSTEM_PROGRAM }], kind);
        exactData(instruction, discriminators.initialize_position!);
        break;
      }
      case "DEPOSIT_COLLATERAL": {
        const instruction = expectSingle(programs.perpVenue);
        requireMetas(instruction, [
          { key: owner, signer: true }, { key: market }, { key: position, writable: true },
          { key: collateralVault, writable: true }, { key: traderQuote, writable: true }, { key: TOKEN_PROGRAM },
        ], kind);
        prefix(instruction, discriminators.deposit!, 16);
        const amount = u64Le(instruction.data, 8);
        if (amount === ZERO || amount > requiredCollateral) fail("deposit exceeds the reported collateral requirement");
        break;
      }
      case "SET_POSITION_DELEGATE": {
        const instruction = expectSingle(programs.perpVenue);
        requireMetas(instruction, [{ key: owner, signer: true }, { key: position, writable: true }], kind);
        prefix(instruction, discriminators.set_delegate!, 40);
        if (bs58.encode(instruction.data.slice(8)) !== strategy) fail("delegate is not the wallet's strategy");
        break;
      }
      case "INITIALIZE_STRATEGY": {
        const instruction = expectSingle(programs.perpAdapter);
        requireMetas(instruction, [payer, { key: strategy, writable: true }, { key: market }, { key: position }, { key: SYSTEM_PROGRAM }], kind);
        prefix(instruction, discriminators.initialize_test_perp_strategy!, 80);
        if (bs58.encode(instruction.data.slice(40, 72)) !== executor) fail("strategy controller is not the wallet's Naryx executor");
        if (u64Le(instruction.data, 72) === ZERO) fail("strategy size bound is zero");
        break;
      }
      case "INITIALIZE_EXECUTOR_AUTHORITY": {
        const instruction = expectSingle(programs.core);
        if (instruction.accounts.length !== 11) fail("executor step has an unexpected account list");
        // Registry accounts are read-only core PDAs; only the executor authority is created.
        const keys = instruction.accounts.map((meta) => meta.pubkey);
        requireMetas(instruction, [
          payer, ...keys.slice(1, 6).map((key) => ({ key })), { key: baseMint }, { key: quoteMint }, { key: strategy },
          { key: executor, writable: true }, { key: SYSTEM_PROGRAM },
        ], kind);
        exactData(instruction, discriminators.initialize_cash_carry_strategy!);
        break;
      }
      default:
        fail(`step ${stepIndex} is unknown`);
    }
    return Object.freeze({ kind, label: candidate.label, instructions: Object.freeze(instructions) });
  });
  if (value.ready !== (steps.length === 0)) fail("readiness does not match the step list");
  return Object.freeze({
    contextId, owner, ready: steps.length === 0, requiredCollateralAtoms: requiredCollateral, testCollateralFaucet: faucet,
    openPackage: openPackageOf(value.openPackage), steps: Object.freeze(steps),
  });
}

function compactU16(value: number): number[] {
  const out: number[] = [];
  let remaining = value;
  for (;;) {
    const byte = remaining & 0x7f;
    remaining >>= 7;
    if (remaining === 0) {
      out.push(byte);
      return out;
    }
    out.push(byte | 0x80);
  }
}

/** Serializes one unsigned v0 transaction with the wallet as fee payer and only signer. */
export function buildOnboardingTransaction(step: SolanaDevnetOnboardingStep, owner: string, recentBlockhash: string): Uint8Array {
  const keys = new Map<string, { signer: boolean; writable: boolean; order: number }>();
  const touch = (key: string, signer: boolean, writable: boolean) => {
    const current = keys.get(key);
    keys.set(key, current === undefined
      ? { signer, writable, order: keys.size }
      : { signer: current.signer || signer, writable: current.writable || writable, order: current.order });
  };
  touch(owner, true, true);
  for (const instruction of step.instructions) {
    for (const meta of instruction.accounts) touch(meta.pubkey, meta.isSigner, meta.isWritable);
    touch(instruction.programId, false, false);
  }
  const rank = (key: string, entry: { signer: boolean; writable: boolean }) =>
    key === owner ? 0 : entry.signer ? (entry.writable ? 1 : 2) : entry.writable ? 3 : 4;
  const ordered = [...keys.entries()].sort(([leftKey, left], [rightKey, right]) =>
    rank(leftKey, left) - rank(rightKey, right) || left.order - right.order);
  const signers = ordered.filter(([, entry]) => entry.signer);
  if (signers.length !== 1 || signers[0]![0] !== owner) fail("the wallet must be the only signer");
  const index = new Map(ordered.map(([key], position) => [key, position]));
  if (ordered.length > 64) fail("transaction touches too many accounts");
  const blockhash = bs58.decode(recentBlockhash);
  if (blockhash.length !== 32) fail("recent blockhash is invalid");
  const message: number[] = [
    0x80,
    1,
    0,
    ordered.filter(([, entry]) => !entry.signer && !entry.writable).length,
    ...compactU16(ordered.length),
    ...ordered.flatMap(([key]) => Array.from(bs58.decode(key))),
    ...blockhash,
    ...compactU16(step.instructions.length),
  ];
  for (const instruction of step.instructions) {
    message.push(index.get(instruction.programId)!, ...compactU16(instruction.accounts.length));
    for (const meta of instruction.accounts) message.push(index.get(meta.pubkey)!);
    message.push(...compactU16(instruction.data.length), ...instruction.data);
  }
  message.push(...compactU16(0));
  const transaction = Uint8Array.from([...compactU16(1), ...new Array<number>(64).fill(0), ...message]);
  if (transaction.length > PACKET_LIMIT) fail("transaction exceeds the packet limit");
  return transaction;
}

async function devnetRpc(method: string, params: readonly unknown[]): Promise<unknown> {
  const response = await fetch(SOLANA_DEVNET_RPC, {
    method: "POST",
    cache: "no-store",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`Devnet RPC ${method} failed with ${response.status}.`);
  const payload = await response.json() as unknown;
  if (!isRecord(payload) || payload.error !== undefined) throw new Error(`Devnet RPC ${method} returned an error.`);
  return payload.result;
}

async function devnetBlockhash(): Promise<Readonly<{ blockhash: string; lastValidBlockHeight: number }>> {
  if (await devnetRpc("getGenesisHash", []) !== SOLANA_DEVNET_GENESIS_HASH) throw new Error("The Devnet RPC endpoint is not Solana Devnet.");
  const result = await devnetRpc("getLatestBlockhash", [{ commitment: "confirmed" }]);
  const value = isRecord(result) && isRecord(result.value) ? result.value : undefined;
  if (value === undefined || typeof value.blockhash !== "string" || typeof value.lastValidBlockHeight !== "number") {
    throw new Error("Devnet RPC returned an invalid blockhash.");
  }
  return { blockhash: value.blockhash, lastValidBlockHeight: value.lastValidBlockHeight };
}

async function waitForFinality(signature: string, lastValidBlockHeight: number): Promise<void> {
  const deadline = Date.now() + FINALITY_TIMEOUT_MS;
  for (;;) {
    const result = await devnetRpc("getSignatureStatuses", [[signature], { searchTransactionHistory: false }]);
    const status = isRecord(result) && Array.isArray(result.value) ? result.value[0] : undefined;
    if (isRecord(status)) {
      if (status.err !== null && status.err !== undefined) throw new Error("The setup transaction failed on Devnet.");
      if (status.confirmationStatus === "finalized") return;
    } else {
      const height = await devnetRpc("getBlockHeight", [{ commitment: "confirmed" }]);
      if (typeof height === "number" && height > lastValidBlockHeight) throw new Error("The setup transaction expired before it landed.");
    }
    if (Date.now() > deadline) throw new Error("The setup transaction has not finalized yet. Check it in your wallet, then retry.");
    await new Promise((resolve) => window.setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

/**
 * Claims free Devnet test USDC for the wallet: reads the account status with the claim flag, then
 * signs and finalizes the token account and claim steps only. Returns false when the deployment's
 * quote mint has no faucet or the wallet already holds the faucet maximum.
 */
export async function claimSolanaDevnetTestUsdc(input: Readonly<{
  owner: string;
  readStatus(owner: string, sizeAtoms: string, signal?: AbortSignal, claimTestCollateral?: boolean): Promise<SolanaDevnetAccountStatus>;
  signAndSend(transaction: Uint8Array): Promise<string>;
  onProgress?(message: string): void;
}>): Promise<boolean> {
  const { owner, readStatus, signAndSend, onProgress } = input;
  for (let round = 0; round < 2; round += 1) {
    const status = await readStatus(owner, "0", undefined, true);
    if (status.testCollateralFaucet === null) throw new Error("This deployment's Devnet quote mint has no public faucet.");
    const step = status.steps[0];
    if (step === undefined || (step.kind !== "CREATE_TOKEN_ACCOUNTS" && step.kind !== "CLAIM_TEST_COLLATERAL")) return false;
    onProgress?.(step.kind === "CREATE_TOKEN_ACCOUNTS" ? "Approve the token account setup" : "Approve the test USDC claim");
    const { blockhash, lastValidBlockHeight } = await devnetBlockhash();
    const signature = await signAndSend(buildOnboardingTransaction(step, owner, blockhash));
    onProgress?.("Waiting for Devnet finality");
    await waitForFinality(signature, lastValidBlockHeight);
    if (step.kind === "CLAIM_TEST_COLLATERAL") return true;
  }
  return false;
}

export function solanaDevnetSizeAtoms(size: string): string {
  const match = /^(0|[1-9][0-9]{0,12})(?:\.([0-9]{1,9}))?$/.exec(size.trim());
  if (!match) return "0";
  return (BigInt(match[1]!) * TEN ** BigInt(SOLANA_DEVNET_BASE_DECIMALS)
    + BigInt((match[2] ?? "").padEnd(SOLANA_DEVNET_BASE_DECIMALS, "0") || "0")).toString();
}

/** Canonical decimal size for base atoms: no trailing fractional zeros, the inverse of the above. */
export function solanaDevnetSizeFromAtoms(atoms: string): string {
  const value = BigInt(atoms);
  const scale = TEN ** BigInt(SOLANA_DEVNET_BASE_DECIMALS);
  const fraction = (value % scale).toString().padStart(SOLANA_DEVNET_BASE_DECIMALS, "0").replace(/0+$/, "");
  return fraction.length === 0 ? (value / scale).toString() : `${value / scale}.${fraction}`;
}

type OnboardingState = Readonly<{
  key: string;
  status: SolanaDevnetAccountStatus | null;
  error: string | null;
  busy: string | null;
}>;

export type SolanaDevnetOnboarding = Readonly<{
  /** True once the service reports no missing account for the current wallet and size. */
  ready: boolean;
  loading: boolean;
  status: SolanaDevnetAccountStatus | null;
  nextStep: SolanaDevnetOnboardingStep | null;
  error: string | null;
  busy: string | null;
  advance(): Promise<void>;
}>;

export function useSolanaDevnetOnboarding(input: Readonly<{
  enabled: boolean;
  owner: string | null;
  sizeAtoms: string;
  readStatus(owner: string, sizeAtoms: string, signal?: AbortSignal): Promise<SolanaDevnetAccountStatus>;
  signAndSend(transaction: Uint8Array): Promise<string>;
}>): SolanaDevnetOnboarding {
  const { enabled, owner, sizeAtoms, readStatus, signAndSend } = input;
  const key = enabled && owner ? `${owner}|${sizeAtoms}` : "";
  const [state, setState] = useState<OnboardingState | null>(null);
  const [revision, setRevision] = useState(0);
  const running = useRef(false);

  useEffect(() => {
    if (!enabled || !owner) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      readStatus(owner, sizeAtoms, controller.signal)
        .then((status) => {
          if (!controller.signal.aborted) setState((current) => ({ key: `${owner}|${sizeAtoms}`, status, error: null, busy: current?.key === `${owner}|${sizeAtoms}` ? current.busy : null }));
        })
        .catch((cause) => {
          if (controller.signal.aborted) return;
          setState({ key: `${owner}|${sizeAtoms}`, status: null, error: cause instanceof Error ? cause.message : "Devnet account read failed.", busy: null });
        });
    }, 300);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [enabled, owner, readStatus, revision, sizeAtoms]);

  const current = state?.key === key ? state : null;
  const nextStep = current?.status?.steps[0] ?? null;

  const advance = useCallback(async () => {
    if (running.current || !owner || key === "") return;
    if (!nextStep) {
      setRevision((value) => value + 1);
      return;
    }
    running.current = true;
    const update = (patch: Partial<OnboardingState>) =>
      setState((previous) => (previous?.key === key ? { ...previous, ...patch } : previous));
    try {
      update({ busy: "Waiting for wallet approval", error: null });
      const { blockhash, lastValidBlockHeight } = await devnetBlockhash();
      const signature = await signAndSend(buildOnboardingTransaction(nextStep, owner, blockhash));
      update({ busy: "Waiting for Devnet finality" });
      await waitForFinality(signature, lastValidBlockHeight);
      update({ busy: "Refreshing account" });
      const status = await readStatus(owner, sizeAtoms);
      setState({ key, status, error: null, busy: null });
    } catch (cause) {
      update({
        busy: null,
        error: cause instanceof Error && /reject|denied|cancel/i.test(cause.message)
          ? "Setup cancelled in the wallet."
          : cause instanceof Error ? cause.message : "Devnet account setup failed.",
      });
    } finally {
      running.current = false;
    }
  }, [key, nextStep, owner, readStatus, signAndSend, sizeAtoms]);

  return {
    ready: current?.status?.ready === true,
    loading: key !== "" && (current === null || (current.status === null && current.error === null)),
    status: current?.status ?? null,
    nextStep,
    error: current?.error ?? null,
    busy: current?.busy ?? null,
    advance,
  };
}
