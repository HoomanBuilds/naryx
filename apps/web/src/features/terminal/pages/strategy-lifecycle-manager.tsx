"use client";

import { useMemo, useState, type FormEvent } from "react";
import bs58 from "bs58";
import {
  NaryxClient,
  type StrategyCommandAuthorizationSigner,
  type StrategyCommandInput,
  type StrategyState,
} from "@naryx/sdk";
import { useEvmWallet } from "@/features/wallet/evm-wallet";
import { useSolanaWallet } from "@/features/wallet/solana-wallet";
import styles from "./pages.module.css";

const ID = /^[A-Za-z0-9._:-]{1,128}$/;
const EVM_OWNER = /^0x(?!0{40}$)[0-9a-f]{40}$/;
const AUTHORITIES = ["REBALANCE", "ROLL", "DECREASE", "EXIT", "EMERGENCY_UNWIND"] as const;
type Authority = typeof AUTHORITIES[number];
type Action = "APPLY_EXECUTION" | "ASSIGN_INTERNAL" | "DELEGATE" | "REVOKE_DELEGATION" | "SPLIT" | "MERGE";
type PreparedOpen = Awaited<ReturnType<NaryxClient["prepareStrategyOpen"]>>;

export type ManagedStrategy = Readonly<{
  strategyId: string;
  environment: string;
  state: StrategyState;
  stateHash: string;
}>;

function short(value: string): string {
  return value.length > 24 ? `${value.slice(0, 14)}...${value.slice(-7)}` : value;
}

function hex(value: string | Uint8Array): string {
  return typeof value === "string" ? value : [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function StrategyEntryManager({
  baseUrl,
  refresh,
  initialReceiptHash = "",
}: {
  baseUrl: string;
  refresh(): Promise<void>;
  initialReceiptHash?: string;
}) {
  const solana = useSolanaWallet();
  const evm = useEvmWallet();
  const [receiptHash, setReceiptHash] = useState(
    /^[0-9a-f]{64}$/.test(initialReceiptHash) ? initialReceiptHash : "",
  );
  const [prepared, setPrepared] = useState<PreparedOpen | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const signer = (owner: string): StrategyCommandAuthorizationSigner => {
    if (EVM_OWNER.test(owner)) {
      if (evm.account?.toLowerCase() !== owner) throw new Error("Connect the EVM wallet that executed this entry.");
      return { scheme: "EIP712_SECP256K1", signerId: owner, sign: (typedData) => evm.signChainlessTypedData(typedData) };
    }
    if (solana.selectedAccount?.address !== owner || !solana.canSignMessage) {
      throw new Error("Connect the Solana wallet that executed this entry and supports message signing.");
    }
    return { scheme: "ED25519", signerId: owner, sign: async (message) => bs58.decode(await solana.signMessage(message)) };
  };

  const review = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      const value = receiptHash.trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(value)) throw new Error("Enter a 32-byte lowercase receipt hash.");
      const result = await new NaryxClient({ baseUrl }).prepareStrategyOpen(value);
      signer(result.command.actorId);
      setPrepared(result);
    } catch (cause) {
      setPrepared(null);
      setNotice({ kind: "error", text: cause instanceof Error ? cause.message : "Receipt review failed." });
    } finally {
      setBusy(false);
    }
  };

  const open = async () => {
    if (prepared === null) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await new NaryxClient({ baseUrl }).submitAuthorizedStrategyCommand(
        prepared.command,
        signer(prepared.command.actorId),
      );
      setNotice({ kind: "ok", text: `Strategy recorded as ${short(prepared.command.strategyId)} from ${result.commandHash.slice(0, 12)}...` });
      setPrepared(null);
      setReceiptHash("");
      await refresh();
    } catch (cause) {
      setNotice({ kind: "error", text: cause instanceof Error ? cause.message : "Strategy opening failed." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={styles.card} aria-labelledby="strategy-entry-title">
      <div className={styles.cardHead}>
        <div>
          <h2 id="strategy-entry-title">Record executed strategy</h2>
          <p>Convert one finalized entry receipt into wallet-owned lifecycle state. The server derives every leg from settled evidence.</p>
        </div>
        <span className={styles.pill}>Receipt bound</span>
      </div>
      <form className={`${styles.cardBody} ${styles.lifecycleForm}`} onSubmit={(event) => void review(event)}>
        <div className={styles.lifecycleGrid}>
          <label className={styles.field}>
            <span>Finalized entry receipt hash</span>
            <input
              className={styles.mono}
              value={receiptHash}
              onChange={(event) => { setReceiptHash(event.target.value); setPrepared(null); setNotice(null); }}
              placeholder="64 lowercase hexadecimal characters"
              spellCheck={false}
            />
          </label>
        </div>
        <div className={styles.lifecycleActions}>
          <p>{prepared === null
            ? "Review derives the strategy identity, positions, ratios, liabilities, and owner from the receipt."
            : `${prepared.command.parameters.kind === "OPEN" ? prepared.command.parameters.state.legs.length : 0} legs, state ${prepared.stateHash.slice(0, 12)}..., owner ${short(prepared.command.actorId)}.`}</p>
          {prepared === null ? (
            <button type="submit" className={styles.connect} disabled={busy}>{busy ? "Reviewing" : "Review receipt"}</button>
          ) : (
            <button type="button" className={styles.connect} disabled={busy} onClick={() => void open()}>{busy ? "Signing" : "Sign and record"}</button>
          )}
        </div>
        {notice ? <p className={notice.kind === "ok" ? styles.noticeOk : styles.noticeError} role="status">{notice.text}</p> : null}
      </form>
    </section>
  );
}

export function StrategyLifecycleManager({
  baseUrl,
  strategies,
  refresh,
  initialReceiptHash = "",
  initialStateHash = "",
}: {
  baseUrl: string;
  strategies: readonly ManagedStrategy[];
  refresh(): Promise<void>;
  initialReceiptHash?: string;
  initialStateHash?: string;
}) {
  const solana = useSolanaWallet();
  const evm = useEvmWallet();
  const linkedStrategyId = /^[0-9a-f]{64}$/.test(initialStateHash)
    ? strategies.find((strategy) => strategy.stateHash === initialStateHash)?.strategyId ?? ""
    : "";
  const linkedExecution = linkedStrategyId !== "" && /^[0-9a-f]{64}$/.test(initialReceiptHash);
  const [selectedId, setSelectedId] = useState(linkedStrategyId || strategies[0]?.strategyId || "");
  const [action, setAction] = useState<Action>(linkedExecution ? "APPLY_EXECUTION" : "ASSIGN_INTERNAL");
  const [transitionReceiptHash, setTransitionReceiptHash] = useState(linkedExecution ? initialReceiptHash : "");
  const [subaccountId, setSubaccountId] = useState("primary");
  const [delegateId, setDelegateId] = useState("");
  const [authorities, setAuthorities] = useState<readonly Authority[]>(["REBALANCE", "DECREASE", "EXIT"]);
  const [delegationHours, setDelegationHours] = useState("24");
  const [revokeId, setRevokeId] = useState("");
  const [firstChildId, setFirstChildId] = useState("");
  const [secondChildId, setSecondChildId] = useState("");
  const [firstShareBps, setFirstShareBps] = useState("5000");
  const [otherStrategyId, setOtherStrategyId] = useState("");
  const [mergedStrategyId, setMergedStrategyId] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const selected = strategies.find((strategy) => strategy.strategyId === selectedId) ?? strategies[0] ?? null;
  const mergeCandidates = useMemo(() => selected === null ? [] : strategies.filter((strategy) => (
    strategy.strategyId !== selected.strategyId
    && strategy.state.ownerId === selected.state.ownerId
    && strategy.state.open
  )), [selected, strategies]);

  const signer = (): StrategyCommandAuthorizationSigner => {
    if (selected === null) throw new Error("Select a strategy.");
    const owner = selected.state.ownerId;
    if (EVM_OWNER.test(owner)) {
      if (evm.account?.toLowerCase() !== owner) throw new Error("Connect the EVM wallet that owns this strategy.");
      return {
        scheme: "EIP712_SECP256K1",
        signerId: owner,
        sign: (typedData) => evm.signChainlessTypedData(typedData),
      };
    }
    if (solana.selectedAccount?.address !== owner || !solana.canSignMessage) {
      throw new Error("Connect the Solana wallet that owns this strategy and supports message signing.");
    }
    return {
      scheme: "ED25519",
      signerId: owner,
      sign: async (message) => bs58.decode(await solana.signMessage(message)),
    };
  };

  const parameters = (): StrategyCommandInput["parameters"] => {
    if (action === "APPLY_EXECUTION") throw new Error("A settled execution is derived from its receipt.");
    if (action === "ASSIGN_INTERNAL") {
      if (!ID.test(subaccountId)) throw new Error("Subaccount id must be 1 to 128 letters, numbers, dots, colons, underscores, or hyphens.");
      return { kind: action, subaccountId };
    }
    if (action === "DELEGATE") {
      const hours = Number(delegationHours);
      if (!ID.test(delegateId)) throw new Error("Delegate id is malformed.");
      if (authorities.length === 0) throw new Error("Select at least one risk-reducing authority.");
      if (!Number.isSafeInteger(hours) || hours < 1 || hours > 720) throw new Error("Delegation duration must be 1 to 720 hours.");
      return { kind: action, delegateId, authorities, expiresAtValue: BigInt(Date.now() + hours * 3_600_000) };
    }
    if (action === "REVOKE_DELEGATION") {
      if (!ID.test(revokeId)) throw new Error("Select a current delegate.");
      return { kind: action, delegateId: revokeId };
    }
    if (action === "SPLIT") {
      if (!ID.test(firstChildId) || !ID.test(secondChildId) || firstChildId === secondChildId) throw new Error("Two distinct child strategy ids are required.");
      const share = BigInt(firstShareBps);
      if (share <= BigInt(0) || share >= BigInt(10_000)) throw new Error("First share must be between 1 and 9,999 basis points.");
      return { kind: action, childStrategyIds: [firstChildId, secondChildId], firstShareBps: share };
    }
    const other = mergeCandidates.find((strategy) => strategy.strategyId === otherStrategyId);
    if (other === undefined || !ID.test(mergedStrategyId)) throw new Error("Select another strategy and name the merged strategy.");
    return {
      kind: action,
      otherStrategyId: other.strategyId,
      otherExpectedStateVersion: other.state.stateVersion,
      otherExpectedStateHash: other.stateHash,
      mergedStrategyId,
    };
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (selected === null) return;
    setBusy(true);
    setNotice(null);
    try {
      const client = new NaryxClient({ baseUrl });
      const command: StrategyCommandInput = action === "APPLY_EXECUTION"
        ? (await client.prepareStrategyTransition(selected.strategyId, transitionReceiptHash.trim().toLowerCase())).command
        : {
          commandVersion: 1,
          environment: selected.environment,
          strategyId: selected.strategyId,
          actorId: selected.state.ownerId,
          expectedStateVersion: selected.state.stateVersion,
          expectedStateHash: selected.stateHash,
          atValue: BigInt(Date.now()),
          parameters: parameters(),
        };
      if (command.actorId !== selected.state.ownerId
        || command.expectedStateVersion !== selected.state.stateVersion
        || hex(command.expectedStateHash) !== selected.stateHash) {
        throw new Error("The prepared lifecycle command does not bind the selected strategy state.");
      }
      const result = await client.submitAuthorizedStrategyCommand(command, signer());
      setNotice({ kind: "ok", text: `${action.replaceAll("_", " ")} recorded as ${result.commandHash.slice(0, 12)}...` });
      await refresh();
    } catch (cause) {
      setNotice({ kind: "error", text: cause instanceof Error ? cause.message : "Strategy command failed." });
    } finally {
      setBusy(false);
    }
  };

  if (selected === null) return null;

  return (
    <section className={styles.card} aria-labelledby="lifecycle-title">
      <div className={styles.cardHead}>
        <div>
          <h2 id="lifecycle-title">Strategy lifecycle</h2>
          <p>Signed internal controls. Position changes still require settled execution receipts.</p>
        </div>
        <span className={styles.pillOk}>State v{selected.state.stateVersion.toString()}</span>
      </div>
      <form className={`${styles.cardBody} ${styles.lifecycleForm}`} onSubmit={(event) => void submit(event)}>
        <div className={styles.lifecycleGrid}>
          <label className={styles.field}>
            <span>Strategy</span>
            <select value={selected.strategyId} onChange={(event) => { setSelectedId(event.target.value); setNotice(null); }}>
              {strategies.map((strategy) => <option key={strategy.strategyId} value={strategy.strategyId}>{short(strategy.strategyId)}</option>)}
            </select>
          </label>
          <label className={styles.field}>
            <span>Command</span>
            <select value={action} onChange={(event) => { setAction(event.target.value as Action); setNotice(null); }}>
              <option value="APPLY_EXECUTION">Apply settled execution</option>
              <option value="ASSIGN_INTERNAL">Assign internally</option>
              <option value="DELEGATE">Delegate risk reduction</option>
              <option value="REVOKE_DELEGATION">Revoke delegation</option>
              <option value="SPLIT">Split accounting position</option>
              <option value="MERGE">Merge compatible positions</option>
            </select>
          </label>
          {action === "APPLY_EXECUTION" ? (
            <label className={styles.field}>
              <span>Finalized lifecycle receipt hash</span>
              <input
                className={styles.mono}
                value={transitionReceiptHash}
                onChange={(event) => setTransitionReceiptHash(event.target.value)}
                placeholder="64 lowercase hexadecimal characters"
                spellCheck={false}
              />
            </label>
          ) : null}
          {action === "ASSIGN_INTERNAL" ? (
            <label className={styles.field}><span>Subaccount id</span><input value={subaccountId} onChange={(event) => setSubaccountId(event.target.value)} /></label>
          ) : null}
          {action === "DELEGATE" ? (
            <>
              <label className={styles.field}><span>Delegate wallet id</span><input value={delegateId} onChange={(event) => setDelegateId(event.target.value)} /></label>
              <label className={styles.field}><span>Duration in hours</span><input inputMode="numeric" value={delegationHours} onChange={(event) => setDelegationHours(event.target.value)} /></label>
              <fieldset className={styles.authorities}>
                <legend>Allowed risk-reducing actions</legend>
                {AUTHORITIES.map((authority) => (
                  <label key={authority}>
                    <input
                      type="checkbox"
                      checked={authorities.includes(authority)}
                      onChange={(event) => setAuthorities(event.target.checked ? [...authorities, authority] : authorities.filter((item) => item !== authority))}
                    />
                    {authority.replaceAll("_", " ")}
                  </label>
                ))}
              </fieldset>
            </>
          ) : null}
          {action === "REVOKE_DELEGATION" ? (
            <label className={styles.field}>
              <span>Delegate</span>
              <select value={revokeId} onChange={(event) => setRevokeId(event.target.value)}>
                <option value="">Select delegate</option>
                {selected.state.delegations.map((delegation) => <option key={delegation.delegateId} value={delegation.delegateId}>{short(delegation.delegateId)}</option>)}
              </select>
            </label>
          ) : null}
          {action === "SPLIT" ? (
            <>
              <label className={styles.field}><span>First child id</span><input value={firstChildId} onChange={(event) => setFirstChildId(event.target.value)} /></label>
              <label className={styles.field}><span>Second child id</span><input value={secondChildId} onChange={(event) => setSecondChildId(event.target.value)} /></label>
              <label className={styles.field}><span>First share in bps</span><input inputMode="numeric" value={firstShareBps} onChange={(event) => setFirstShareBps(event.target.value)} /></label>
            </>
          ) : null}
          {action === "MERGE" ? (
            <>
              <label className={styles.field}>
                <span>Other strategy</span>
                <select value={otherStrategyId} onChange={(event) => setOtherStrategyId(event.target.value)}>
                  <option value="">Select compatible strategy</option>
                  {mergeCandidates.map((strategy) => <option key={strategy.strategyId} value={strategy.strategyId}>{short(strategy.strategyId)}</option>)}
                </select>
              </label>
              <label className={styles.field}><span>Merged strategy id</span><input value={mergedStrategyId} onChange={(event) => setMergedStrategyId(event.target.value)} /></label>
            </>
          ) : null}
        </div>
        <div className={styles.lifecycleActions}>
          <p>{action === "APPLY_EXECUTION"
            ? "The service derives the exact next state from the finalized receipt and rejects any unexplained position delta."
            : `Owner ${short(selected.state.ownerId)}. The command binds state hash ${selected.stateHash.slice(0, 12)}...`}</p>
          <button type="submit" className={styles.connect} disabled={busy}>{busy ? "Signing" : "Review and sign"}</button>
        </div>
        {notice ? <p className={notice.kind === "ok" ? styles.noticeOk : styles.noticeError} role="status">{notice.text}</p> : null}
      </form>
    </section>
  );
}
