"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { NaryxApiError, NaryxClient, nativeCashAccountTransaction, nativeCashMatchTransaction, nativeCashWalletAccountId,
  readNativeCashPending, updateNativeCashPending, NATIVE_CASH_PENDING_LIMIT,
  type NativeCashMarket, type NativeCashSignedQuote, type NativeCashTransaction, type NativeCashPendingTransaction } from "@naryx/sdk";
import { BaseError, UserRejectedRequestError, InsufficientFundsError, parseUnits, type Hex } from "viem";
import { useConfig } from "wagmi";
import { getConnection, getPublicClient } from "wagmi/actions";
import { ChainIcon } from "@/features/brand/chain-icons";
import { EVM_CHAINS, type EvmDomain } from "@/features/wallet/evm-config";
import { useEvmWallet } from "@/features/wallet/evm-wallet";
import { shortAddress, useWalletModal } from "@/features/wallet/wallet-modal";
import { formatAtomicAmount } from "../format";
import { useTerminal } from "../shell/terminal-context";
import styles from "./pages.module.css";
import cash from "./native-cash.module.css";

const EVENT = "naryx-native-cash-pending";
const pendingMemory = new Map<string, string>();
function subscribe(listener: () => void) {
  window.addEventListener(EVENT, listener); window.addEventListener("storage", listener);
  return () => { window.removeEventListener(EVENT, listener); window.removeEventListener("storage", listener); };
}
function readPending(key: string) {
  try { return window.localStorage.getItem(key) ?? pendingMemory.get(key) ?? null; }
  catch { return pendingMemory.get(key) ?? null; }
}
function writePending(key: string, value: readonly NativeCashPendingTransaction[]) {
  const encoded = value.length === 0 ? null : JSON.stringify(value);
  if (readPending(key) === encoded) return;
  if (encoded === null) pendingMemory.delete(key); else pendingMemory.set(key, encoded);
  try { if (encoded === null) window.localStorage.removeItem(key); else window.localStorage.setItem(key, encoded); } catch { /* Memory retains pending transactions when storage is unavailable. */ }
  window.dispatchEvent(new Event(EVENT));
}
function failure(error: unknown) {
  if (error instanceof Error && /cancelled|canceled/i.test(error.message)) return "Cancelled in your wallet. Nothing else was sent.";
  if (error instanceof BaseError) {
    if (error.walk(e => e instanceof UserRejectedRequestError)) return "Cancelled in your wallet. Nothing else was sent.";
    if (error.walk(e => e instanceof InsufficientFundsError)) return "Add test ETH for network fees, then retry.";
    return "The network refused this transaction. Refresh the account and request a new quote.";
  }
  if (error instanceof NaryxApiError) return error.status === 409
    ? "The request is not qualified yet. Check funding, market availability, and quote expiry."
    : "The cash market service is unavailable. Retry shortly.";
  return "The action could not complete. Refresh the account before retrying.";
}

function CashMarket({ market, client, baseUrl }: { market: NativeCashMarket; client: NaryxClient; baseUrl: string }) {
  const domain: EvmDomain = market.binding.domain.domainId === "eip155:84532" ? "base" : "arbitrum";
  const network = EVM_CHAINS[domain];
  const wallet = useEvmWallet();
  const { notify } = useTerminal();
  const modal = useWalletModal();
  const config = useConfig();
  const queryClient = useQueryClient();
  const owner = wallet.account;
  const accountId = owner ? nativeCashWalletAccountId(owner) : null;
  const storageKey = `naryx.cash.${baseUrl}.${market.binding.clearingHouse}.${owner?.toLowerCase() ?? "disconnected"}`;
  const rawPending = useSyncExternalStore(subscribe, () => readPending(storageKey), () => null);
  const journal = useMemo(() => {
    try { return { entries: readNativeCashPending(rawPending), invalid: false }; }
    catch { return { entries: [], invalid: true }; }
  }, [rawPending]);
  const pending = journal.invalid || journal.entries.some(item => item.phase === "SUBMITTED");
  const [amount, setAmount] = useState("10");
  const [quantity, setQuantity] = useState("1");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [signed, setSigned] = useState<NativeCashSignedQuote | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const lock = useRef(false);
  const accountQuery = useQuery({ queryKey: ["native-cash-account", baseUrl, market.marketId, owner],
    enabled: owner !== null, retry: false, refetchInterval: 15_000, refetchIntervalInBackground: false,
    queryFn: () => client.getNativeCashAccount(market, owner!, accountId!) });
  const tradesQuery = useQuery({ queryKey: ["native-cash-trades", baseUrl, market.marketId],
    queryFn: () => client.getNativeCashTrades(market), retry: false, refetchInterval: 30_000, refetchIntervalInBackground: false });
  const standingBook = useQuery({ queryKey: ["native-cash-book", baseUrl, market.marketId],
    enabled: market.binding.makerAuthorization !== undefined, queryFn: () => client.getNativeCashBook(market),
    retry: false, refetchInterval: 10_000, refetchIntervalInBackground: false });
  const account = accountQuery.data;
  const decimals = market.binding.policy.accountingAsset.decimals;
  const token = (value: bigint) => formatAtomicAmount(value, decimals, "test USDC");
  let amountAtoms = BigInt(0);
  if (/^(?:0|[1-9][0-9]{0,2})(?:\.[0-9]{1,6})?$/.test(amount)) {
    try { amountAtoms = parseUnits(amount, decimals); } catch { /* Invalid amounts remain disabled. */ }
  }
  const validAmount = amountAtoms > BigInt(0) && amountAtoms <= BigInt(100) * BigInt(10) ** BigInt(decimals);
  const quantityAtoms = /^[1-9][0-9]{0,2}$/.test(quantity) ? BigInt(quantity) : BigInt(0);
  const validQuantity = quantityAtoms > BigInt(0) && quantityAtoms <= market.binding.policy.maximumPositionAtoms;
  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: ["native-cash-account", baseUrl, market.marketId] });
    await queryClient.invalidateQueries({ queryKey: ["native-cash-trades", baseUrl, market.marketId] });
  }, [queryClient, baseUrl, market.marketId]);

  useEffect(() => {
    if (!signed) return;
    const timer = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [signed]);

  const reconciliation = useQuery({ queryKey: ["native-cash-pending", baseUrl, market.marketId, owner, rawPending],
    enabled: journal.entries.length > 0 && !!owner, retry: false, refetchInterval: 15_000, refetchIntervalInBackground: false,
    queryFn: async () => {
      const rpc = getPublicClient(config, { chainId: network.id });
      if (!rpc) throw new Error("Unavailable.");
      return Promise.all(journal.entries.map(async item => {
        try {
          const receipt = await rpc.getTransactionReceipt({ hash: item.transactionHash });
          if (receipt.status === "reverted") return { item, state: "reverted" as const };
          if (item.requestId) {
            try {
              const settled = await client.observeNativeCashSettlement(market, item.requestId, item.transactionHash);
              if (settled.owner.toLowerCase() !== owner!.toLowerCase()) throw new Error("Settlement owner differs.");
            } catch { return { item, state: "included" as const }; }
          }
          return { item, state: "confirmed" as const };
        } catch { return { item, state: "unavailable" as const }; }
      }));
    } });
  useEffect(() => {
    if (!reconciliation.data?.some(result => result.state === "confirmed" || result.state === "reverted"
      || result.state === "included" && result.item.phase === "SUBMITTED")) return;
    let cancelled = false;
    void refresh().then(() => {
      if (cancelled) return;
      let queue = readNativeCashPending(readPending(storageKey));
      for (const result of reconciliation.data!) {
        if (!queue.some(item => item.transactionHash === result.item.transactionHash)) continue;
        if (result.state === "included") queue = updateNativeCashPending(queue, { ...result.item, phase: "INCLUDED" });
        if (result.state === "confirmed" || result.state === "reverted") {
          queue = queue.filter(item => item.transactionHash !== result.item.transactionHash);
          notify(result.state === "confirmed" ? "ok" : "bad", result.state === "confirmed"
            ? `${result.item.action} confirmed and recorded.` : "Transaction reverted. No cash position was changed.");
        }
      }
      writePending(storageKey, queue);
    }).catch(() => notify("bad", "Cash account refresh failed. Your pending transaction journal has been preserved."));
    return () => { cancelled = true; };
  }, [reconciliation.data, storageKey, refresh, notify]);

  function requireOwner() {
    const connection = getConnection(config);
    if (!owner || connection.address?.toLowerCase() !== owner.toLowerCase() || connection.chainId !== network.id) {
      throw new Error("Wallet changed.");
    }
  }
  async function send(transaction: NativeCashTransaction, action: string, requestId: string | null = null) {
    requireOwner();
    if (readNativeCashPending(readPending(storageKey)).length >= NATIVE_CASH_PENDING_LIMIT) throw new Error("Pending journal is full.");
    const rpc = getPublicClient(config, { chainId: network.id });
    if (!rpc || await rpc.getChainId() !== network.id) throw new Error("Network differs.");
    setBusy("Checking transaction");
    await rpc.call({ account: owner!, to: transaction.to, data: transaction.data, value: BigInt(0) });
    requireOwner();
    setBusy("Confirm transaction in wallet");
    const transactionHash = await wallet.sendTransaction(domain, transaction) as Hex;
    writePending(storageKey, updateNativeCashPending(readNativeCashPending(readPending(storageKey)),
      { transactionHash, requestId, action, phase: "SUBMITTED" }));
    setSigned(null);
    setMessage(requestId ? "Transaction sent. Controls unlock after inclusion and account refresh; finalized evidence is recorded separately. Do not resubmit this trade." : "Transaction sent. Waiting for confirmation.");
  }
  async function act(action: "open" | "approve" | "deposit" | "normalize" | "withdraw") {
    if (lock.current || pending || !account || !owner) return;
    lock.current = true; setBusy("Preparing transaction"); setMessage(null); setSigned(null);
    try {
      const latest = await client.getNativeCashAccount(market, owner, accountId!);
      await send(nativeCashAccountTransaction(market, latest, action, amountAtoms),
        action === "normalize" ? "Realized cash settlement" : action === "open" ? "Account opening" : action === "approve" ? "Exact approval" : action === "deposit" ? "Deposit" : "Withdrawal");
    } catch (error) { setMessage(failure(error)); }
    finally { lock.current = false; setBusy(null); }
  }
  async function quote(side: "BUY" | "SELL", size = quantityAtoms) {
    if (lock.current || pending || !owner || !accountId || size <= BigInt(0)) return;
    lock.current = true; setBusy("Requesting maker quote"); setMessage(null); setSigned(null);
    try {
      requireOwner();
      const result = await client.requestNativeCashQuote(market, { requestId: `cash-${crypto.randomUUID()}`,
        marketId: market.marketId, accountId, owner, side, quantityAtoms: size });
      requireOwner(); setNow(Math.floor(Date.now() / 1000)); setSigned(result);
    } catch (error) { setMessage(failure(error)); }
    finally { lock.current = false; setBusy(null); }
  }
  async function trade() {
    if (!signed || lock.current || pending || signed.quote.owner.toLowerCase() !== owner?.toLowerCase()) return;
    lock.current = true; setMessage(null); setBusy("Sign the quoted trade in your wallet");
    try {
      requireOwner();
      const signature = await wallet.signTypedData(domain, signed.quote.typedData) as Hex;
      requireOwner();
      const transaction = await nativeCashMatchTransaction(signed, signature, BigInt(Math.floor(Date.now() / 1000)));
      await send(transaction, "Cash trade", signed.requestId);
    } catch (error) { setSigned(null); setMessage(failure(error)); }
    finally { lock.current = false; setBusy(null); }
  }
  const disabled = !!busy || !!pending || accountQuery.isError || accountQuery.isFetching
    || wallet.awaitingWallet || wallet.switching || !wallet.onChain(domain);
  const expiry = signed ? Number(signed.quote.match.expiry) - now : 0;
  const quoteCurrent = signed && signed.quote.owner.toLowerCase() === owner?.toLowerCase() && expiry > 0;
  const explorer = network.blockExplorers.default.url;
  return <article className={styles.card}>
    <header className={styles.cardHead}>
      <div className={cash.marketName}><ChainIcon chain={domain} size={22} /><div><h3>ETH cash range{market.binding.makerAuthorization ? " - standing book" : ""}</h3><p>{network.name} · Fully collateralized · Cash only</p></div></div>
      <a className={styles.ghost} href={`${explorer}/address/${market.binding.clearingHouse}`} target="_blank" rel="noreferrer" title={market.binding.clearingHouse}>House {shortAddress(market.binding.clearingHouse)}</a>
    </header>
    <div className={cash.body}>
      <p className={cash.terms}>This is a bounded ETH-price cash market, not a spot/perp package. One unit tracks the controller&apos;s clamped 0.001 ETH exposure from $1,000 to $5,000, plus its minimum price tick. No ETH or external venue position is delivered.</p>
      {market.binding.makerAuthorization ? <div className={cash.review}><h4>Contract-backed standing liquidity</h4>
        {standingBook.data ? <dl className={cash.metrics}>
          <div><dt>Bid / available units</dt><dd>{token(standingBook.data.bidTicks)} / {standingBook.data.bidQuantity.toLocaleString("en-US")} units</dd></div>
          <div><dt>Ask / available units</dt><dd>{token(standingBook.data.askTicks)} / {standingBook.data.askQuantity.toLocaleString("en-US")} units</dd></div>
        </dl> : <p>{standingBook.isError ? "Standing book unavailable. Current state must qualify before execution." : "Reading funded maker inventory."}</p>}
        <p className={cash.terms}>Prices and capacity come from the maker contract. Exact terms, maker inventory and owner margin are rechecked at acceptance. This is not an exclusive inventory reservation.</p>
      </div> : null}
      {!owner ? <button className={styles.connect} onClick={() => modal.open("evm")}>Connect EVM wallet</button>
        : !wallet.onChain(domain) ? <button className={styles.connect} disabled={wallet.switching} onClick={() => void wallet.switchNetwork(domain)}>Switch to {network.name}</button> : null}
      {owner ? <>
        <dl className={cash.metrics}>
          <div><dt>Wallet collateral</dt><dd>{account ? token(account.walletBalanceAtoms) : accountQuery.isError ? "Unavailable" : "Reading"}</dd></div>
          <div><dt>Deposited collateral</dt><dd>{account ? token(account.collateralQuoteAtoms) : "-"}</dd></div>
          <div><dt>Cash balance</dt><dd>{account ? token(account.cashBalanceQuoteAtoms) : "-"}</dd></div>
          <div><dt>Open position</dt><dd>{account ? `${account.positionAtoms.toLocaleString("en-US")} units` : "-"}</dd></div>
        </dl>
        {accountQuery.isError ? <p role="alert">Account read failed. Refresh before sending funds.</p> : null}
        {!account?.opened ? <button className={styles.connect} disabled={disabled || !account} onClick={() => void act("open")}>Open my clearing account</button> : <>
          <div className={cash.controls}>
            <label>Collateral amount <span className={cash.input}><input aria-label={`${network.name} collateral amount`} inputMode="decimal" value={amount} disabled={!!busy || !!pending} onChange={e => { setAmount(e.target.value); setSigned(null); }} /><span>test USDC</span></span></label>
            {account.allowanceAtoms < amountAtoms ? <button className={styles.ghost} disabled={disabled || !validAmount || amountAtoms > account.walletBalanceAtoms} onClick={() => void act("approve")}>Approve exact amount</button>
              : <button className={styles.ghost} disabled={disabled || !validAmount || amountAtoms > account.walletBalanceAtoms} onClick={() => void act("deposit")}>Deposit collateral</button>}
            <button className={styles.ghost} disabled={disabled || !validAmount || account.positionAtoms !== BigInt(0) || account.cashBalanceQuoteAtoms !== BigInt(0) || amountAtoms > account.collateralQuoteAtoms} onClick={() => void act("withdraw")}>Withdraw to wallet</button>
          </div>
          <p className={cash.terms}>Maximum 100 test USDC per action. Get collateral from <Link href="/portfolio">Portfolio&apos;s test USDC faucet</Link>. Close the position and settle realized cash before withdrawing. Test ETH pays network fees.</p>
          {account.positionAtoms === BigInt(0) && account.cashBalanceQuoteAtoms !== BigInt(0) ? <button className={styles.ghost} disabled={disabled} onClick={() => void act("normalize")}>Settle realized cash into collateral</button> : null}
          <div className={cash.controls}>
            <label>Package units <span className={cash.input}><input aria-label={`${network.name} cash package units`} inputMode="numeric" value={quantity} disabled={!!busy || !!pending} onChange={e => { setQuantity(e.target.value); setSigned(null); }} /></span></label>
            <button className={styles.ghost} disabled={disabled || !validQuantity} onClick={() => void quote("BUY")}>Get buy quote</button>
            <button className={styles.ghost} disabled={disabled || !validQuantity} onClick={() => void quote("SELL")}>Get sell quote</button>
            {account.positionAtoms !== BigInt(0) ? <button className={styles.ghost} disabled={disabled} onClick={() => void quote(account.positionAtoms > BigInt(0) ? "SELL" : "BUY", account.positionAtoms > BigInt(0) ? account.positionAtoms : -account.positionAtoms)}>Quote full exit</button> : null}
          </div>
          <p className={cash.terms}>Full-range margin: {token(market.binding.policy.initialMarginQuoteAtomsPerIncrement)} per unit. Quotes depend on funded maker capacity and current marks. A quote is not an onchain inventory lock.</p>
        </>}
      </> : null}
      {signed && signed.quote.owner.toLowerCase() === owner?.toLowerCase() ? <div className={cash.review}>
        <h4>Review cash trade</h4>
        <dl className={cash.metrics}>
          <div><dt>Side / quantity</dt><dd>{signed.quote.side} {signed.quote.match.quantityAtoms.toLocaleString("en-US")} units</dd></div>
          <div><dt>Price per unit</dt><dd>{token(signed.quote.match.priceTicks)}</dd></div>
          <div><dt>Total cash exchange</dt><dd>{token(signed.quote.match.priceTicks * signed.quote.match.quantityAtoms)}</dd></div>
          <div><dt>Reference per unit</dt><dd>{token(signed.quote.referencePriceTicks)}</dd></div>
          <div><dt>Service fee</dt><dd>0 test USDC</dd></div>
          <div><dt>Quote validity</dt><dd>{expiry > 0 ? `${expiry} seconds` : "Expired. Request again."}</dd></div>
        </dl>
        <p className={cash.terms}>Your wallet signs the exact match, then submits one transaction on {network.name}. Maker {shortAddress(signed.quote.makerOwner)}. No external positions are created.</p>
        <button className={styles.connect} disabled={disabled || !quoteCurrent} onClick={() => void trade()}>Sign and execute cash trade</button>
        <button className={styles.ghost} disabled={!!busy} onClick={() => setSigned(null)}>Dismiss quote</button>
      </div> : null}
      {busy ? <p role="status">{busy}</p> : null}
      {journal.invalid ? <p role="alert">The stored transaction journal needs recovery. Preserve browser storage and inspect your wallet history before proceeding.</p> : null}
      {journal.entries.length > 0 ? <div role="status"><p>{pending ? "Waiting for transaction inclusion. Do not submit again." : "Transactions included. Trading is available while finalized receipts reconcile in the background."}</p>
        {journal.entries.map(item => <p key={item.transactionHash}><a href={`${explorer}/tx/${item.transactionHash}`} target="_blank" rel="noreferrer">{item.action}: {shortAddress(item.transactionHash)}</a> - {item.phase === "INCLUDED" ? "Included, awaiting finalized evidence" : "Submitted"}</p>)}
        <button className={styles.ghost} disabled={reconciliation.isFetching} onClick={() => void reconciliation.refetch()}>Check confirmation</button>
      </div> : null}
      {message ? <p role="status">{message}</p> : null}
      {wallet.error ? <p role="alert">{wallet.error}</p> : null}
      <button className={styles.ghost} disabled={!!busy || accountQuery.isFetching} onClick={() => void refresh()}>Refresh account</button>
      <div className={cash.tape}>
        <h4>Finalized testnet trades</h4>
        {tradesQuery.isError ? <p>Trade history is temporarily unavailable.</p> : tradesQuery.isPending ? <p>Reading finalized trade receipts.</p> : !tradesQuery.data?.length ? <p>No finalized cash trades yet. Submitted trades appear after finality.</p> : <div className={styles.scroll}><table className={styles.table}>
          <thead><tr><th>Side</th><th className={styles.num}>Units</th><th className={styles.num}>Price / unit</th><th>Owner</th><th>Receipt</th></tr></thead>
          <tbody>{tradesQuery.data.slice(0, 10).map(t => <tr key={t.transactionHash}><td>{t.side}</td><td className={styles.num}>{t.quantityAtoms.toLocaleString("en-US")}</td><td className={styles.num}>{token(t.priceTicks)}</td><td title={t.owner}>{shortAddress(t.owner)}</td><td><a href={`${explorer}/tx/${t.transactionHash}`} target="_blank" rel="noreferrer">View transaction</a></td></tr>)}</tbody>
        </table></div>}
        <p className={cash.terms}>Owner-signed testnet executions, including controlled verification trades. Not organic production volume.</p>
      </div>
    </div>
  </article>;
}

export function NativeCashMarkets() {
  const { publicApiBaseUrl, privateApiBaseUrl } = useTerminal();
  const baseUrl = publicApiBaseUrl ?? privateApiBaseUrl;
  const client = useMemo(() => baseUrl ? new NaryxClient({ baseUrl }) : null, [baseUrl]);
  const query = useQuery({ queryKey: ["native-cash-markets", baseUrl], enabled: !!client,
    queryFn: () => client!.getNativeCashMarkets(), retry: false, staleTime: 30_000 });
  return <section id="native-cash-markets" className={cash.section} aria-labelledby="native-cash-title">
    <div><h2 id="native-cash-title">Funded cash markets</h2><p className={cash.terms}>Wallet-owned clearing accounts on Base and Arbitrum testnets. Separate from routed strategy books.</p></div>
    {!baseUrl ? <p>Configure the terminal API to load cash markets.</p> : query.isError ? <p role="alert">Cash markets could not load. <button className={styles.ghost} onClick={() => void query.refetch()}>Retry</button></p>
      : query.isPending ? <p>Loading registered cash markets.</p> : query.data?.length === 0 ? <p>No cash markets are registered.</p>
        : <div className={cash.grid}>{query.data?.map(market => <CashMarket key={market.marketId} market={market} client={client!} baseUrl={baseUrl} />)}</div>}
  </section>;
}
