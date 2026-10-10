"use client";

import { useState } from "react";
import bs58 from "bs58";
import {
  NaryxClient,
  authorizeStrategyCommand,
  fromProtocolJson,
  strategyCommandHash,
  toHex,
  toProtocolJson,
  type SignedStrategyCommandAuthorization,
  type StrategyCommandAuthorizationSigner,
  type StrategyCommandInput,
} from "@naryx/sdk";
import { useEvmWallet } from "@/features/wallet/evm-wallet";
import { useSolanaWallet } from "@/features/wallet/solana-wallet";
import type { ManagedStrategy } from "./strategy-lifecycle-manager";
import styles from "./pages.module.css";

const HASH = /^[0-9a-f]{64}$/;
const EVM_OWNER = /^0x(?!0{40}$)[0-9a-f]{40}$/;

type Proposal = Readonly<{
  version: 1;
  command: StrategyCommandInput;
  commandHash: string;
  authorization: SignedStrategyCommandAuthorization;
}>;

function short(value: string): string {
  return value.length > 24 ? `${value.slice(0, 14)}...${value.slice(-7)}` : value;
}

function clockMs(): number {
  return Date.now();
}

function solanaOwner(value: string): boolean {
  try {
    return bs58.decode(value).length === 32;
  } catch {
    return false;
  }
}

function parseProposal(text: string): Proposal {
  const decoded: unknown = fromProtocolJson(JSON.parse(text) as unknown);
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("Proposal must be a protocol JSON object.");
  const value = decoded as Record<string, unknown>;
  const command = value.command as StrategyCommandInput;
  const authorization = value.authorization as SignedStrategyCommandAuthorization;
  if (value.version !== 1 || command?.parameters?.kind !== "NOVATE" || authorization === undefined
    || typeof value.commandHash !== "string" || typeof authorization.signerId !== "string"
    || typeof authorization.commandHash !== "string" || typeof authorization.signature !== "string"
    || (authorization.scheme !== "ED25519" && authorization.scheme !== "EIP712_SECP256K1")) {
    throw new Error("Proposal is not a supported signed novation.");
  }
  const commandHash = toHex(strategyCommandHash(command));
  if (value.commandHash !== commandHash || authorization.commandHash !== commandHash || authorization.signerId !== command.actorId) {
    throw new Error("Proposal authorization does not bind this command.");
  }
  return Object.freeze({ version: 1, command, commandHash, authorization });
}

export function StrategyNovation({
  baseUrl,
  strategies,
  refresh,
}: {
  baseUrl: string;
  strategies: readonly ManagedStrategy[];
  refresh(): Promise<void>;
}) {
  const solana = useSolanaWallet();
  const evm = useEvmWallet();
  const [selectedId, setSelectedId] = useState(strategies[0]?.strategyId ?? "");
  const [newOwnerId, setNewOwnerId] = useState("");
  const [evidence, setEvidence] = useState<Readonly<Record<string, string>>>({});
  const [proposalText, setProposalText] = useState("");
  const [reviewed, setReviewed] = useState<Proposal | null>(null);
  const [busy, setBusy] = useState<"idle" | "signing" | "submitting">("idle");
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const selected = strategies.find((strategy) => strategy.strategyId === selectedId) ?? strategies[0] ?? null;
  const venues = selected ? [...new Set(selected.state.legs.map((leg) => leg.venueId))].sort() : [];
  const transferable = selected !== null && selected.state.venuePositionsTransferable
    && !selected.state.legalTransferRestricted && selected.state.liabilities.every((liability) => liability.transferable);

  const signerFor = (owner: string): StrategyCommandAuthorizationSigner => {
    if (EVM_OWNER.test(owner)) {
      if (evm.account?.toLowerCase() !== owner) throw new Error(`Connect EVM wallet ${short(owner)}.`);
      return { scheme: "EIP712_SECP256K1", signerId: owner, sign: (typedData) => evm.signChainlessTypedData(typedData) };
    }
    if (!solanaOwner(owner) || solana.selectedAccount?.address !== owner || !solana.canSignMessage) {
      throw new Error(`Connect Solana wallet ${short(owner)} with message signing.`);
    }
    return { scheme: "ED25519", signerId: owner, sign: async (message) => bs58.decode(await solana.signMessage(message)) };
  };

  const createProposal = async () => {
    if (selected === null) return;
    setBusy("signing");
    setNotice(null);
    try {
      if (!transferable) throw new Error("This strategy is not transferable. Exit and re-enter under the new owner.");
      if ((!EVM_OWNER.test(newOwnerId) && !solanaOwner(newOwnerId)) || newOwnerId === selected.state.ownerId) {
        throw new Error("Enter a different canonical EVM or Solana owner address.");
      }
      const venueConfirmations = venues.map((venueId) => {
        const evidenceHash = evidence[venueId]?.trim().toLowerCase() ?? "";
        if (!HASH.test(evidenceHash)) throw new Error(`Enter the 32-byte transfer evidence hash for ${venueId}.`);
        return { venueId, evidenceHash };
      });
      const command: StrategyCommandInput = {
        commandVersion: 1,
        environment: selected.environment,
        strategyId: selected.strategyId,
        actorId: selected.state.ownerId,
        expectedStateVersion: selected.state.stateVersion,
        expectedStateHash: selected.stateHash,
        atValue: BigInt(clockMs()),
        parameters: { kind: "NOVATE", newOwnerId, venueConfirmations },
      };
      const authorization = await authorizeStrategyCommand(command, signerFor(command.actorId));
      const proposal: Proposal = Object.freeze({ version: 1, command, commandHash: authorization.commandHash, authorization });
      const text = JSON.stringify(toProtocolJson(proposal), null, 2);
      setProposalText(text);
      setReviewed(proposal);
      setNotice({ kind: "ok", text: "Current owner signed the canonical proposal. Send the proposal text to the incoming owner within five minutes." });
    } catch (error) {
      setReviewed(null);
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Novation proposal failed." });
    } finally {
      setBusy("idle");
    }
  };

  const reviewProposal = () => {
    setNotice(null);
    try {
      const proposal = parseProposal(proposalText);
      const age = clockMs() - Number(proposal.command.atValue);
      if (!Number.isSafeInteger(age) || age < -300_000 || age > 300_000) throw new Error("Proposal is outside the strategy book's five-minute command window.");
      setReviewed(proposal);
      setNotice({ kind: "ok", text: `Verified ${proposal.commandHash.slice(0, 12)}... locally. Connect the incoming owner to consent.` });
    } catch (error) {
      setReviewed(null);
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Proposal review failed." });
    }
  };

  const consentAndSubmit = async () => {
    if (reviewed === null || reviewed.command.parameters.kind !== "NOVATE") return;
    setBusy("submitting");
    setNotice(null);
    try {
      const newOwner = reviewed.command.parameters.newOwnerId;
      const consent = await authorizeStrategyCommand(reviewed.command, signerFor(newOwner));
      const result = await new NaryxClient({ baseUrl }).submitPreparedStrategyCommand(
        reviewed.command,
        reviewed.authorization,
        [consent],
      );
      setNotice({ kind: "ok", text: `Both owner signatures and venue evidence admitted as ${result.commandHash.slice(0, 12)}...` });
      setProposalText("");
      setReviewed(null);
      await refresh();
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Novation submission failed." });
    } finally {
      setBusy("idle");
    }
  };

  if (selected === null) return null;
  const reviewedNewOwner = reviewed?.command.parameters.kind === "NOVATE" ? reviewed.command.parameters.newOwnerId : null;

  return (
    <section className={styles.card} aria-labelledby="novation-title">
      <div className={styles.cardHead}>
        <div>
          <h2 id="novation-title">Two-party strategy novation</h2>
          <p>Transfer a complete strategy only after both owners sign the same state-bound command and every venue confirms its position transfer.</p>
        </div>
        <span className={transferable ? styles.pillOk : styles.pillWarn}>{transferable ? "Transferable state" : "Exit and re-enter"}</span>
      </div>
      <div className={`${styles.cardBody} ${styles.novationGrid}`}>
        <div className={styles.novationPane}>
          <h3>1. Current owner creates proposal</h3>
          <label className={styles.field}>
            <span>Strategy</span>
            <select value={selected.strategyId} onChange={(event) => { setSelectedId(event.target.value); setEvidence({}); setReviewed(null); setNotice(null); }}>
              {strategies.map((strategy) => <option key={strategy.strategyId} value={strategy.strategyId}>{short(strategy.strategyId)}</option>)}
            </select>
          </label>
          <label className={styles.field}><span>Incoming owner address</span><input className={styles.mono} value={newOwnerId} onChange={(event) => setNewOwnerId(event.target.value.trim())} spellCheck={false} /></label>
          {venues.map((venueId) => (
            <label key={venueId} className={styles.field}>
              <span>{venueId} transfer evidence hash</span>
              <input className={styles.mono} value={evidence[venueId] ?? ""} onChange={(event) => setEvidence({ ...evidence, [venueId]: event.target.value })} placeholder="64 lowercase hexadecimal characters" spellCheck={false} />
            </label>
          ))}
          <button type="button" className={styles.connect} disabled={busy !== "idle" || !transferable} onClick={() => void createProposal()}>{busy === "signing" ? "Awaiting owner signature..." : "Sign novation proposal"}</button>
        </div>
        <div className={styles.novationPane}>
          <h3>2. Incoming owner verifies and consents</h3>
          <label className={styles.field}>
            <span>Portable signed proposal</span>
            <textarea className={styles.novationPayload} value={proposalText} onChange={(event) => { setProposalText(event.target.value); setReviewed(null); setNotice(null); }} placeholder="Paste protocol JSON from the current owner" spellCheck={false} />
          </label>
          <div className={styles.lifecycleActions}>
            <button type="button" className={styles.ghost} disabled={proposalText.trim() === "" || busy !== "idle"} onClick={reviewProposal}>Verify proposal</button>
            <button type="button" className={styles.connect} disabled={reviewedNewOwner === null || busy !== "idle"} onClick={() => void consentAndSubmit()}>{busy === "submitting" ? "Signing and submitting..." : "Consent and submit"}</button>
          </div>
          {reviewed ? (
            <dl className={styles.novationReview}>
              <div><dt>Strategy</dt><dd>{short(reviewed.command.strategyId)}</dd></div>
              <div><dt>From</dt><dd>{short(reviewed.command.actorId)}</dd></div>
              <div><dt>To</dt><dd>{short(reviewedNewOwner ?? "")}</dd></div>
              <div><dt>Command</dt><dd>{reviewed.commandHash.slice(0, 16)}...</dd></div>
            </dl>
          ) : null}
        </div>
      </div>
      {notice ? <p className={notice.kind === "ok" ? styles.noticeOk : styles.noticeError} role="status">{notice.text}</p> : null}
    </section>
  );
}
