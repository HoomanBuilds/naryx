"use client";

import { useState } from "react";
import type {
  MakerControlResult,
  MakerOperationsSnapshot,
  PrivateHttpTerminalProvider,
} from "../private-http-terminal-provider";
import styles from "./pages.module.css";

type OperationState = Readonly<{
  status: "idle" | "pending" | "success" | "error";
  message: string | null;
}>;

export function MakerControlPanel({
  provider,
  snapshot,
  refresh,
}: {
  provider: PrivateHttpTerminalProvider;
  snapshot: MakerOperationsSnapshot;
  refresh(): void;
}) {
  const [shardId, setShardId] = useState("");
  const [operatorToken, setOperatorToken] = useState("");
  const [operation, setOperation] = useState<OperationState>({ status: "idle", message: null });
  const shard = snapshot.shards.find((candidate) => candidate.shardId === shardId) ?? snapshot.shards[0] ?? null;
  const validToken = operatorToken.length >= 32 && operatorToken.length <= 256;

  const apply = async (action: "cancel-all" | "kill-switch") => {
    if (shard === null || !validToken) return;
    const description = action === "cancel-all"
      ? `Cancel every quote in ${shard.shardId}? Existing fills are unaffected.`
      : `Activate the kill switch for ${shard.shardId}? The web console cannot re-arm it.`;
    if (!window.confirm(description)) return;
    setOperation({ status: "pending", message: action === "cancel-all" ? "Cancelling the observed shard state..." : "Activating the shard kill switch..." });
    try {
      const result: MakerControlResult = await provider.applyMakerControl({
        action,
        shardId: shard.shardId,
        expectedShardHash: shard.shardHash,
        expectedShardSequence: shard.shardSequence,
        operatorToken,
      });
      setOperatorToken("");
      setOperation({
        status: "success",
        message: result.changed
          ? `${result.action.replaceAll("_", " ")} admitted at shard sequence ${result.shardSequence.toString()}.`
          : "The shard already had the requested safe state.",
      });
      refresh();
    } catch (error) {
      setOperation({ status: "error", message: error instanceof Error ? error.message : "Maker control failed closed." });
    }
  };

  return (
    <section className={styles.card} aria-labelledby="maker-controls-title">
      <div className={styles.cardHead}>
        <div>
          <h2 id="maker-controls-title">Emergency quote controls</h2>
          <p>Exact-state controls are signed inside the solver process. The browser can request cancellation or halt, but cannot place quotes or re-arm a killed shard.</p>
        </div>
        <span className={styles.pillWarn}>Restricted operation</span>
      </div>
      {snapshot.shards.length === 0 ? (
        <div className={styles.empty}><strong>No controllable shard</strong><p>Publish a signed quote shard before using emergency controls.</p></div>
      ) : (
        <div className={`${styles.cardBody} ${styles.makerControlGrid}`}>
          <label className={styles.field}>
            <span>Observed quote shard</span>
            <select value={shard?.shardId ?? ""} onChange={(event) => { setShardId(event.target.value); setOperation({ status: "idle", message: null }); }}>
              {snapshot.shards.map((candidate) => <option key={candidate.shardId} value={candidate.shardId}>{candidate.shardId}</option>)}
            </select>
          </label>
          <label className={styles.field}>
            <span>Operator token</span>
            <input
              type="password"
              autoComplete="off"
              value={operatorToken}
              minLength={32}
              maxLength={256}
              placeholder="Held in page memory only"
              onChange={(event) => setOperatorToken(event.target.value)}
              aria-invalid={operatorToken.length > 0 && !validToken}
            />
          </label>
          <div className={styles.makerObservedState}>
            <span>Observed state</span>
            <strong>{shard?.state.replaceAll("_", " ") ?? "Unavailable"}</strong>
            <small>Sequence {shard?.shardSequence.toString() ?? "-"}</small>
          </div>
          <button
            type="button"
            className={styles.ghost}
            disabled={operation.status === "pending" || !validToken || shard === null || shard.quoteLevels.length === 0}
            onClick={() => void apply("cancel-all")}
          >
            {operation.status === "pending" ? "Control pending..." : "Cancel all quotes"}
          </button>
          <button
            type="button"
            className={styles.dangerButton}
            disabled={operation.status === "pending" || !validToken || shard === null || shard.state === "KILLED"}
            onClick={() => void apply("kill-switch")}
          >
            {operation.status === "pending" ? "Control pending..." : "Activate kill switch"}
          </button>
        </div>
      )}
      {operation.message ? <p className={operation.status === "success" ? styles.noticeOk : operation.status === "error" ? styles.noticeError : styles.notice}>{operation.message}</p> : null}
    </section>
  );
}
