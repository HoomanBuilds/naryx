import { marketCatalogueHash, toHex, type MarketCatalogueInput } from "@naryx/protocol-types";
import type { SqlitePackageExchangeStore } from "./package-exchange-store.js";
import type { SqliteRegistryStore } from "./registry-store.js";

export interface CatalogueIssuerOptions {
  readonly exchange: Pick<SqlitePackageExchangeStore, "listBooks" | "listSeries" | "listExecutionClasses">;
  readonly registry?: Pick<SqliteRegistryStore, "list">;
  readonly environment: string;
  readonly authority: string;
  /** Signs the catalogue hash with the catalogue authority's Ed25519 key; the key never leaves the server. */
  readonly signHash: (hash: Uint8Array) => Uint8Array;
  readonly clockMs?: () => number;
  readonly ttlMs?: number;
}

/**
 * Issues the signed market catalogue from the exchange's books, series, and execution classes and
 * the registered solvers. One catalogue serves every reader until it expires, so what a client
 * downloads never depends on what it is looking for.
 */
export function createCatalogueIssuer(options: CatalogueIssuerOptions): { current(): { readonly catalogue: MarketCatalogueInput; readonly catalogueHash: string } } {
  const clockMs = options.clockMs ?? Date.now;
  const ttlMs = options.ttlMs ?? 60_000;
  let issued: { catalogue: MarketCatalogueInput; catalogueHash: string } | undefined;
  let lastSequence = 0n;

  const build = (nowMs: number) => {
    const classes = new Map<string, { executionClassVersion: number; seriesId: string; seriesVersion: number; settlementClass: MarketCatalogueInput["entries"][number]["settlementClass"]; firmnessClass: string; collateralMode: string; domainIds: string[] }>();
    const series = new Map(options.exchange.listSeries().map((entry) => [entry.seriesId as string, entry]));
    for (const entry of series.values()) {
      for (const executionClass of options.exchange.listExecutionClasses(entry.seriesId)) {
        classes.set(executionClass.executionClassId, {
          executionClassVersion: executionClass.executionClassVersion,
          seriesId: executionClass.seriesId,
          seriesVersion: executionClass.seriesVersion,
          settlementClass: executionClass.settlementClass,
          firmnessClass: executionClass.firmnessClass,
          collateralMode: executionClass.collateralMode,
          domainIds: [...new Set(executionClass.domains.map((domain) => domain.domainId as string))],
        });
      }
    }
    const entries = options.exchange.listBooks().flatMap((book) => {
      const executionClass = classes.get(book.executionClassId);
      const seriesEntry = executionClass === undefined ? undefined : series.get(executionClass.seriesId);
      if (executionClass === undefined || seriesEntry === undefined) return [];
      return [{
        packageMarketId: book.executionClassId,
        executionClassVersion: executionClass.executionClassVersion,
        seriesId: executionClass.seriesId,
        seriesVersion: executionClass.seriesVersion,
        templateId: seriesEntry.templateId,
        templateVersion: seriesEntry.templateVersion,
        underlyingRefs: [...new Set(seriesEntry.underlyingRefs as readonly string[])],
        quoteAsset: seriesEntry.quoteAsset,
        settlementClass: executionClass.settlementClass,
        firmnessClass: executionClass.firmnessClass,
        collateralMode: executionClass.collateralMode,
        domainIds: executionClass.domainIds,
        halted: book.halted,
      }];
    });
    const solverIds = options.registry === undefined ? [] : options.registry.list("SOLVER_CAPABILITY").map((entry) => entry.subjectId);
    const sequence = BigInt(nowMs) > lastSequence ? BigInt(nowMs) : lastSequence + 1n;
    lastSequence = sequence;
    const unsigned: MarketCatalogueInput = {
      catalogueVersion: 1,
      environment: options.environment,
      sequence,
      issuedAtMs: BigInt(nowMs),
      expiresAtMs: BigInt(nowMs + ttlMs),
      entries,
      solverIds,
      authority: options.authority,
      signature: new Uint8Array(0),
    };
    const hash = marketCatalogueHash(unsigned);
    return { catalogue: { ...unsigned, signature: options.signHash(hash) }, catalogueHash: toHex(hash) };
  };

  return {
    current() {
      const nowMs = clockMs();
      if (issued === undefined || BigInt(nowMs) >= issued.catalogue.expiresAtMs) issued = build(nowMs);
      return issued;
    },
  };
}
