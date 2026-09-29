import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { parseProtocolJson } from "@naryx/protocol-types";
import type {
  EconomicStrategySeriesSupportInput,
  SeriesExecutionClassSupportInput,
} from "@naryx/protocol-types";
import { SqlitePackageExchangeStore } from "./package-exchange-store.js";
import { createPublicMarketRequestHandler } from "./public-market-api.js";

const MAX_SUPPORT_MANIFEST_BYTES = 65_536;
const DEFAULT_REQUESTS_PER_MINUTE = 120;

export type PublicMarketClockUnit = "UNIX_SECONDS" | "UNIX_MILLISECONDS";

export interface PublicMarketRuntime {
  readonly handler: (request: IncomingMessage, response: ServerResponse) => boolean;
  readonly clockUnit: PublicMarketClockUnit;
  readonly requestsPerMinute: number;
  close(): void;
}

export class PublicMarketConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicMarketConfigError";
  }
}

function absolute(value: string | undefined, name: string): string {
  if (value === undefined || value === "") throw new PublicMarketConfigError(`${name} is required when the public market API is enabled.`);
  if (!isAbsolute(value)) throw new PublicMarketConfigError(`${name} must be an absolute path.`);
  return resolve(value);
}

function stringList(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== "string" || entry === "")) {
    throw new PublicMarketConfigError(`Support manifest field ${field} must be a nonempty list of identifiers.`);
  }
  return value as readonly string[];
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PublicMarketConfigError(`Support manifest field ${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function loadSupport(path: string): {
  clockUnit: PublicMarketClockUnit;
  seriesSupport: EconomicStrategySeriesSupportInput;
  executionClassSupport: SeriesExecutionClassSupportInput;
} {
  if (statSync(path).size > MAX_SUPPORT_MANIFEST_BYTES) throw new PublicMarketConfigError("Support manifest is too large.");
  let parsed: unknown;
  try {
    parsed = parseProtocolJson(readFileSync(path, "utf8"));
  } catch {
    throw new PublicMarketConfigError("Support manifest is not valid protocol JSON.");
  }
  const manifest = object(parsed, "root");
  const keys = Object.keys(manifest).sort();
  if (keys.join(",") !== "clockUnit,executionClassSupport,seriesSupport,version" || manifest.version !== 1) {
    throw new PublicMarketConfigError("Support manifest must be version 1 with exactly clockUnit, seriesSupport, and executionClassSupport.");
  }
  if (manifest.clockUnit !== "UNIX_SECONDS" && manifest.clockUnit !== "UNIX_MILLISECONDS") {
    throw new PublicMarketConfigError("Support manifest clockUnit must be UNIX_SECONDS or UNIX_MILLISECONDS; slot-timed books need a slot source.");
  }
  const series = object(manifest.seriesSupport, "seriesSupport");
  const classes = object(manifest.executionClassSupport, "executionClassSupport");
  return {
    clockUnit: manifest.clockUnit,
    seriesSupport: {
      supportedTemplateIds: stringList(series.supportedTemplateIds, "seriesSupport.supportedTemplateIds"),
      supportedQuoteConventionIds: stringList(series.supportedQuoteConventionIds, "seriesSupport.supportedQuoteConventionIds"),
      supportedRiskClassIds: stringList(series.supportedRiskClassIds, "seriesSupport.supportedRiskClassIds"),
      supportedLifecycleConventionIds: stringList(series.supportedLifecycleConventionIds, "seriesSupport.supportedLifecycleConventionIds"),
    },
    executionClassSupport: {
      supportedVenueClassIds: stringList(classes.supportedVenueClassIds, "executionClassSupport.supportedVenueClassIds"),
      supportedCollateralModeIds: stringList(classes.supportedCollateralModeIds, "executionClassSupport.supportedCollateralModeIds"),
      supportedSettlementClasses: stringList(
        classes.supportedSettlementClasses,
        "executionClassSupport.supportedSettlementClasses",
      ) as SeriesExecutionClassSupportInput["supportedSettlementClasses"],
      supportedFirmnessClassIds: stringList(classes.supportedFirmnessClassIds, "executionClassSupport.supportedFirmnessClassIds"),
    },
  };
}

/**
 * Loads the read-only public market API. It is off unless NARYX_PUBLIC_MARKET_ENABLED is exactly
 * "true", and then requires an absolute exchange database path and support manifest. It opens the
 * exchange store and serves reads only; it never registers documents or accepts orders.
 */
export function loadPublicMarketRuntime(
  environment: NodeJS.ProcessEnv = process.env,
  clockMs: () => number = Date.now,
): PublicMarketRuntime | undefined {
  const enabled = environment.NARYX_PUBLIC_MARKET_ENABLED ?? "false";
  if (enabled !== "true" && enabled !== "false") throw new PublicMarketConfigError("NARYX_PUBLIC_MARKET_ENABLED must be true or false.");
  if (enabled === "false") return undefined;
  const databasePath = absolute(environment.NARYX_EXCHANGE_DB, "NARYX_EXCHANGE_DB");
  const support = loadSupport(absolute(environment.NARYX_EXCHANGE_SUPPORT_MANIFEST, "NARYX_EXCHANGE_SUPPORT_MANIFEST"));
  const rawRate = environment.NARYX_PUBLIC_MARKET_REQUESTS_PER_MINUTE ?? String(DEFAULT_REQUESTS_PER_MINUTE);
  if (!/^[1-9]\d{0,4}$/.test(rawRate) || Number(rawRate) > 10_000) {
    throw new PublicMarketConfigError("NARYX_PUBLIC_MARKET_REQUESTS_PER_MINUTE must be between 1 and 10000.");
  }
  const requestsPerMinute = Number(rawRate);
  const store = new SqlitePackageExchangeStore(databasePath, {
    seriesSupport: support.seriesSupport,
    executionClassSupport: support.executionClassSupport,
  });
  const nowValue = support.clockUnit === "UNIX_SECONDS"
    ? () => BigInt(Math.floor(clockMs() / 1_000))
    : () => BigInt(Math.floor(clockMs()));
  return Object.freeze({
    handler: createPublicMarketRequestHandler({
      store,
      nowValue,
      rateLimit: { windowMs: 60_000, maxRequests: requestsPerMinute },
      clockMs,
    }),
    clockUnit: support.clockUnit,
    requestsPerMinute,
    close: () => store.close(),
  });
}
