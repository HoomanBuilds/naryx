"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { fromProtocolJson } from "@naryx/sdk";
import { ChainIcon } from "@/features/brand/chain-icons";
import { useEvmWallet } from "@/features/wallet/evm-wallet";
import { useSolanaWallet } from "@/features/wallet/solana-wallet";
import { generalizedTemplateOnLane } from "../generalized-strategy-preparation";
import { marketAssetLabel } from "../market-label";
import { DOMAIN_META, DOMAIN_ORDER, useTerminal } from "../shell/terminal-context";
import type { DomainId } from "../terminal-view-model";
import styles from "./pages.module.css";

/**
 * Open generalized strategy packages (HyperCore native, EVM, and Solana templates other than the
 * cash-and-carry lanes) read from the service's per-owner strategy store. The store reports
 * quantities, not entry values, so no entry notional is shown.
 */
export type StrategyPosition = Readonly<{
  key: string;
  domain: DomainId;
  templateId: string;
  positionId: string;
  seriesId: string;
  size: string;
  /** Base units at full precision, or null when the store reports no decimals. */
  exactSize: string | null;
  legs: readonly string[];
  state: "Open" | "Exiting" | "Unresolved";
}>;

type Source = "native" | "evm" | "solana";

export type StrategyPositionsState = Readonly<{
  positions: readonly StrategyPosition[];
  loading: boolean;
  unreadable: readonly Source[];
}>;

const SOURCE_LABEL: Readonly<Record<Source, string>> = { native: "HyperCore native", evm: "EVM", solana: "Solana" };
const EVM_OWNER = /^0x(?!0{40}$)[0-9a-f]{40}$/;
const HASH = /^[0-9a-f]{64}$/;
const REFRESH_MS = 15_000;

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${context} is malformed.`);
  return value as Record<string, unknown>;
}

function text(value: unknown, context: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`${context} is malformed.`);
  return value;
}

function atoms(value: unknown, context: string): bigint {
  if (typeof value !== "bigint") throw new Error(`${context} is not exact.`);
  return value;
}

function decimals(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 36) throw new Error(`${context} is malformed.`);
  return value;
}

function exact(value: bigint, places: number): string {
  const negative = value < BigInt(0);
  const digits = (negative ? -value : value).toString().padStart(places + 1, "0");
  const fraction = places === 0 ? "" : digits.slice(-places).replace(/0+$/, "");
  return `${negative ? "-" : ""}${places === 0 ? digits : digits.slice(0, -places)}${fraction ? `.${fraction}` : ""}`;
}

function display(value: bigint, places: number): string {
  const [whole, fraction = ""] = exact(value, places).split(".");
  const trimmed = fraction.slice(0, 6).replace(/0+$/, "");
  return `${BigInt(whole).toLocaleString("en-US")}${trimmed ? `.${trimmed}` : ""}`;
}

function templateLabel(templateId: string): string {
  const words = templateId.replace(/-v\d+$/, "").replaceAll("-", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function shortId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 8)}...${id.slice(-4)}` : id;
}

async function ownerPositions(base: string, route: string, owner: string, signal: AbortSignal): Promise<readonly unknown[]> {
  const response = await fetch(`${base}${route}?owner=${encodeURIComponent(owner)}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
    credentials: "omit",
    referrerPolicy: "no-referrer",
    signal,
  });
  // 503 means this service runs without that strategy store, which is a missing lane, not a failure.
  if (response.status === 503) return [];
  if (!response.ok) throw new Error(`${route} answered ${response.status}.`);
  const root = record(fromProtocolJson(await response.json()), route);
  if (root.version !== 1 || root.owner !== owner || !Array.isArray(root.positions)) throw new Error(`${route} does not bind the connected owner.`);
  return root.positions;
}

function domainOf(domainId: string): DomainId | null {
  return DOMAIN_ORDER.find((domain) => DOMAIN_META[domain].domainId === domainId) ?? null;
}

function packagePosition(raw: unknown, index: number, owner: string, context: string): StrategyPosition | null {
  const position = record(raw, `${context} ${index}`);
  if (position.owner !== owner) throw new Error(`${context} ${index} belongs to another owner.`);
  if (position.status !== "OPEN") return null;
  const domain = domainOf(text(position.domainId, `${context} ${index} domain`));
  if (domain === null) return null;
  const packageId = text(position.packageIdHex, `${context} ${index} package`);
  if (!HASH.test(packageId)) throw new Error(`${context} ${index} package is malformed.`);
  const quantity = atoms(position.economicQuantityAtoms, `${context} ${index} quantity`);
  const places = decimals(position.baseAssetDecimals, `${context} ${index} decimals`);
  const asset = marketAssetLabel(text(position.baseAssetId, `${context} ${index} base asset`));
  return Object.freeze({
    key: `${context}:${packageId}`,
    domain,
    templateId: text(position.templateId, `${context} ${index} template`),
    positionId: packageId,
    seriesId: text(position.seriesId, `${context} ${index} series`),
    size: `${display(quantity, places)} ${asset}`,
    exactSize: exact(quantity, places),
    legs: [],
    state: "Open",
  });
}

function nativePosition(raw: unknown, index: number, owner: string): StrategyPosition | null {
  const position = record(raw, `Native strategy ${index}`);
  const state = record(position.state, `Native strategy ${index} state`);
  if (position.owner !== owner || state.ownerId !== owner) throw new Error(`Native strategy ${index} belongs to another owner.`);
  const status = position.status;
  if (status === "CLOSED") return null;
  if (status !== "OPEN" && status !== "EXITING" && status !== "UNRESOLVED") throw new Error(`Native strategy ${index} status is malformed.`);
  if (!Array.isArray(state.legs) || state.legs.length === 0) throw new Error(`Native strategy ${index} has no legs.`);
  const legs = state.legs.map((candidate, legIndex) => {
    const leg = record(candidate, `Native strategy ${index} leg ${legIndex}`);
    const quantity = atoms(leg.signedQuantityAtoms, `Native strategy ${index} leg ${legIndex} quantity`);
    return `${text(leg.instrumentId, `Native strategy ${index} leg ${legIndex} instrument`)} ${quantity.toLocaleString("en-US")} atoms`;
  });
  const strategyId = text(position.strategyId, `Native strategy ${index} id`);
  return Object.freeze({
    key: `native:${strategyId}`,
    domain: "hyperliquid",
    templateId: text(position.templateId, `Native strategy ${index} template`),
    positionId: strategyId,
    seriesId: text(state.seriesId, `Native strategy ${index} series`),
    size: `${legs.length} leg${legs.length === 1 ? "" : "s"}`,
    exactSize: null,
    legs: Object.freeze(legs),
    state: status === "OPEN" ? "Open" : status === "EXITING" ? "Exiting" : "Unresolved",
  });
}

export function useStrategyPositions(): StrategyPositionsState {
  const { privateApiBaseUrl } = useTerminal();
  const evmAccount = useEvmWallet().account?.toLowerCase() ?? null;
  const evm = evmAccount !== null && EVM_OWNER.test(evmAccount) ? evmAccount : null;
  const solana = useSolanaWallet().selectedAccount?.address ?? null;
  const base = privateApiBaseUrl?.replace(/\/+$/, "") ?? null;

  const native = useQuery({
    queryKey: ["strategy-positions", "native", base, evm],
    enabled: base !== null && evm !== null,
    refetchInterval: REFRESH_MS,
    queryFn: async ({ signal }) => (await ownerPositions(base!, "/internal/terminal/native-strategies", evm!, signal))
      .flatMap((raw, index) => nativePosition(raw, index, evm!) ?? []),
  });
  const evmQuery = useQuery({
    queryKey: ["strategy-positions", "evm", base, evm],
    enabled: base !== null && evm !== null,
    refetchInterval: REFRESH_MS,
    queryFn: async ({ signal }) => (await ownerPositions(base!, "/internal/terminal/evm-strategies", evm!, signal))
      .flatMap((raw, index) => packagePosition(raw, index, evm!, "EVM strategy") ?? []),
  });
  const solanaQuery = useQuery({
    queryKey: ["strategy-positions", "solana", base, solana],
    enabled: base !== null && solana !== null,
    refetchInterval: REFRESH_MS,
    queryFn: async ({ signal }) => (await ownerPositions(base!, "/internal/terminal/solana-strategies", solana!, signal))
      .flatMap((raw, index) => packagePosition(raw, index, solana!, "Solana strategy") ?? []),
  });

  const sources: readonly (readonly [Source, typeof native])[] = [["solana", solanaQuery], ["evm", evmQuery], ["native", native]];
  return {
    positions: sources.flatMap(([, query]) => query.data ?? []),
    loading: sources.some(([, query]) => query.isLoading),
    unreadable: sources.filter(([, query]) => query.isError).map(([source]) => source),
  };
}

/** The Trade page applies `strategy=1` links as a shared configuration; `lane` and `package` select the position. */
type TradeAction = "EXIT" | "DECREASE" | "EMERGENCY_UNWIND";

/** Links only the actions the Trade builder can construct for this template on this lane. */
function PositionActions({ position, onNavigate }: Readonly<{ position: StrategyPosition; onNavigate: () => void }>) {
  const actions: readonly (readonly [TradeAction, string])[] = position.state === "Open"
    ? [["DECREASE", "Adjust"], ["EXIT", "Exit"]]
    : position.state === "Unresolved" ? [["EMERGENCY_UNWIND", "Emergency unwind"]] : [];
  const available = actions.filter(([action]) => generalizedTemplateOnLane(position.domain, position.templateId, action));
  if (actions.length > 0 && available.length === 0) {
    return <span className={styles.dim}>Exit from Trade is not available for this template yet</span>;
  }
  return (
    <span className={styles.rowActions}>
      {available.map(([action, label]) => (
        <Link key={action} className={styles.ghost} href={tradeHref(position, action)} onClick={onNavigate}>{label}</Link>
      ))}
    </span>
  );
}

function tradeHref(position: StrategyPosition, action: TradeAction): string {
  const params = new URLSearchParams();
  if (position.exactSize !== null) {
    params.set("strategy", "1");
    params.set("domain", position.domain);
    params.set("size", position.exactSize);
    params.set("slippage", "25");
    params.set("quote", "coordinated_limits");
  }
  params.set("template", position.templateId);
  params.set("action", action);
  params.set("mode", action === "DECREASE" ? "entry" : "exit");
  params.set("lane", position.domain);
  params.set("package", position.positionId);
  return `/trade?${params.toString()}`;
}

export function StrategyPositionsTable({ state }: { state: StrategyPositionsState }) {
  const { privateApiBaseUrl, setSelectedDomain } = useTerminal();
  if (privateApiBaseUrl === null) return null;
  const { positions, loading, unreadable } = state;
  return (
    <>
      <div className={styles.subhead}>
        <h3>Strategy positions</h3>
        <p>Option and calendar spreads, treasury and collateral hedges, reverse basis, and HyperCore native strategies, read from the service&apos;s strategy store for the connected wallets.</p>
      </div>
      {unreadable.length > 0 ? (
        <p className={styles.noticeError} role="status">
          Could not read {unreadable.map((source) => SOURCE_LABEL[source]).join(", ")} strategy positions. Retrying.
        </p>
      ) : null}
      <div className={styles.scroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Strategy</th>
              <th scope="col">Chain</th>
              <th scope="col" className={styles.num}>Size</th>
              <th scope="col" className={styles.num}>Entry notional</th>
              <th scope="col">State</th>
              <th scope="col"><span className="sr-only">Action</span></th>
            </tr>
          </thead>
          <tbody>
            {positions.length === 0 ? (
              <tr>
                <td colSpan={6}>
                  <div className={styles.empty}>
                    <strong>{loading ? "Reading strategy positions" : "No open strategy positions"}</strong>
                    <p>Generalized strategy packages appear here after their entry settles. Connect the wallet that owns them.</p>
                  </div>
                </td>
              </tr>
            ) : positions.map((position) => (
              <tr key={position.key}>
                <td title={`${position.templateId}; series ${position.seriesId}`}>
                  <strong>{templateLabel(position.templateId)}</strong>
                  <small className={`${styles.cellDetail} ${styles.mono}`} title={position.positionId}>{shortId(position.positionId)}</small>
                </td>
                <td>
                  <span className={styles.chainCell}>
                    <ChainIcon chain={position.domain} size={20} />
                    <span>
                      <strong>{DOMAIN_META[position.domain].label}</strong>
                      <small>{DOMAIN_META[position.domain].network}</small>
                    </span>
                  </span>
                </td>
                <td className={styles.num}>
                  {position.size}
                  {position.legs.length > 0 ? (
                    <span className={styles.cellStack}>
                      {position.legs.map((leg) => <small key={leg} className={styles.cellDetail}>{leg}</small>)}
                    </span>
                  ) : null}
                </td>
                <td className={styles.num}><span className={styles.dim} title="The strategy store records quantities, not entry values">Not reported</span></td>
                <td>
                  <span className={position.state === "Open" ? styles.pillOk : position.state === "Unresolved" ? styles.pillBad : styles.pillWarn}>
                    {position.state}
                  </span>
                </td>
                <td className={styles.num}>
                  <PositionActions position={position} onNavigate={() => setSelectedDomain(position.domain)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
