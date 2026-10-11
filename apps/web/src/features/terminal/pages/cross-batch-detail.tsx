"use client";

import { toHex, type NaryxClient, type VerifiedCrossBatchClearing } from "@naryx/sdk";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { ReadState, compact, publicClient } from "./public-read";
import styles from "./pages.module.css";

const atoms = (value: bigint) => `${value.toLocaleString("en-US")} atoms`;

function SourceBatch({ client, scope, proofHash, planHash, instrumentId }: { client: NaryxClient; scope: string; proofHash: string; planHash: string; instrumentId: string }) {
  const query = useQuery({
    queryKey: ["netting-batch", scope, proofHash],
    retry: false,
    staleTime: 15_000,
    queryFn: () => client.getNettingBatch(proofHash),
  });
  return (
    <ReadState query={query} subject={`Netting batch ${compact(proofHash)}`}>
      {(batch) => {
        const underlying = batch.result.underlyings.find((entry) => entry.instrumentId === instrumentId);
        // The SDK re-reads every plan a batch references by its hash and verifies it before returning.
        const planReread = batch.crossBatchClearings.some((entry) => toHex(entry.plan.planHash) === planHash);
        return (
          <dl className={styles.facts}>
            <dt>Batch proof</dt><dd className={styles.mono} title={batch.proofHash}>{compact(batch.proofHash)} verified</dd>
            <dt>Settlement</dt><dd>{batch.settlementStatus.replaceAll("_", " ")}</dd>
            <dt>External execution</dt><dd>{batch.externalExecutionStatus.replaceAll("_", " ")}</dd>
            <dt>Packages / allocations</dt><dd className={styles.mono}>{batch.packages.length} / {batch.result.allocations.length}</dd>
            <dt>Gross buy / sell</dt><dd className={styles.mono}>{underlying === undefined ? "-" : `${atoms(underlying.grossBuyAtoms)} / ${atoms(underlying.grossSellAtoms)}`}</dd>
            <dt>Matched in batch</dt><dd className={styles.mono}>{underlying === undefined ? "-" : atoms(underlying.internalMatchedAtoms)}</dd>
            <dt>Net to external</dt><dd className={styles.mono}>{underlying === undefined ? "-" : atoms(underlying.externalNetAtoms)}</dd>
            <dt>This plan by hash</dt>
            <dd><span className={planReread ? styles.pillOk : styles.pillWarn}>{planReread ? "Re-read and verified" : "Not referenced by this batch"}</span></dd>
          </dl>
        );
      }}
    </ReadState>
  );
}

/** Plan and source batch evidence for one pooled clearing, read only when its row is opened. */
export function CrossBatchDetail({ baseUrl, clearing }: { baseUrl: string | null; clearing: VerifiedCrossBatchClearing }) {
  const client = useMemo(() => publicClient(baseUrl), [baseUrl]);
  const { plan } = clearing;
  const planHash = toHex(plan.planHash);
  const proofHashes = [...new Set(plan.sources.map((source) => toHex(source.nettingProofHash)))].sort();
  return (
    <div className={styles.transparencyGrid}>
      <div className={styles.transparencyPanel}>
        <h3>Clearing plan</h3>
        <dl className={styles.facts}>
          <dt>Plan hash</dt><dd className={styles.mono} title={planHash}>{compact(planHash)} verified</dd>
          <dt>Instrument</dt><dd className={styles.mono}>{plan.instrumentId}</dd>
          <dt>Internal price</dt><dd className={styles.mono}>{plan.internalClearingPriceTicks.toString()} ticks</dd>
          <dt>Internally matched</dt><dd className={styles.mono}>{atoms(plan.internalMatchedQuantityAtoms)}</dd>
          <dt>External residual</dt>
          <dd className={styles.mono}>
            {plan.externalSide === undefined ? "None" : `${plan.externalSide} ${atoms(plan.externalQuantityAtoms)} limit ${plan.externalLimitPriceTicks?.toString() ?? "-"}`}
          </dd>
          <dt>Max external fee</dt><dd className={styles.mono}>{plan.maximumExternalFeeQuoteAtoms.toLocaleString("en-US")} {plan.quoteAsset.assetId} atoms</dd>
          <dt>Valid until</dt><dd className={styles.mono}>{plan.validUntilValue.toString()} {plan.validUntilUnit}</dd>
          <dt>Execution evidence</dt><dd>{clearing.evidence === undefined ? "None recorded" : clearing.evidence.outcome.replaceAll("_", " ")}</dd>
          <dt>Receipt</dt><dd className={styles.mono}>{clearing.receipt === undefined ? "Not issued" : compact(toHex(clearing.receipt.receiptHash))}</dd>
        </dl>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Source intent</th>
              <th>Side</th>
              <th className={styles.num}>Quantity</th>
              <th className={styles.num}>Internal</th>
              <th className={styles.num}>External</th>
            </tr>
          </thead>
          <tbody>
            {plan.sources.map((source) => {
              const intentHash = toHex(source.sourceIntentHash);
              return (
                <tr key={intentHash}>
                  <td className={styles.mono} title={`Intent ${intentHash} in batch ${toHex(source.nettingProofHash)}`}>{compact(intentHash)}</td>
                  <td>{source.side}</td>
                  <td className={styles.num}>{source.quantityAtoms.toLocaleString("en-US")}</td>
                  <td className={styles.num}>{source.internalQuantityAtoms.toLocaleString("en-US")}</td>
                  <td className={styles.num}>{source.externalQuantityAtoms.toLocaleString("en-US")}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className={styles.transparencyPanel}>
        <h3>Source netting batches</h3>
        {client === null ? (
          <p className={styles.readNote}>Batch evidence needs an HTTPS public API.</p>
        ) : proofHashes.map((proofHash) => (
          <SourceBatch key={proofHash} client={client} scope={baseUrl ?? ""} proofHash={proofHash} planHash={planHash} instrumentId={plan.instrumentId} />
        ))}
      </div>
    </div>
  );
}
