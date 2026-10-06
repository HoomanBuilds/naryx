import { readFileSync, statSync } from "node:fs";
import {
  parseProtocolJson,
  type DomainManifestInput,
  type EconomicStrategySeriesInput,
  type PackageMatchingPolicyInput,
  type PackageTemplateManifestInput,
  type SeriesExecutionClassInput,
} from "@naryx/protocol-types";
import type { SqlitePackageExchangeStore } from "./package-exchange-store.js";
import type { SqliteRegistryStore } from "./registry-store.js";

const MAX_BOOTSTRAP_BYTES = 2_097_152;

export class PublicMarketBootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicMarketBootstrapError";
  }
}

export interface PublicMarketBookBootstrap {
  readonly executionClassId: string;
  readonly executionClassVersion: number;
}

export interface PublicMarketBootstrap {
  readonly version: 1;
  readonly environment: string;
  readonly domainManifests: readonly DomainManifestInput[];
  readonly packageTemplateManifests: readonly PackageTemplateManifestInput[];
  readonly matchingPolicies: readonly PackageMatchingPolicyInput[];
  readonly series: readonly EconomicStrategySeriesInput[];
  readonly executionClasses: readonly SeriesExecutionClassInput[];
  readonly books: readonly PublicMarketBookBootstrap[];
}

type Exchange = Pick<
  SqlitePackageExchangeStore,
  "registerMatchingPolicy" | "registerSeries" | "registerExecutionClass" | "openBook"
>;
type Registry = Pick<SqliteRegistryStore, "registerDomain" | "registerPackageTemplate">;

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PublicMarketBootstrapError(`${context} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, context: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new PublicMarketBootstrapError(`${context} must be a nonempty array.`);
  }
  return value;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], context: string): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    throw new PublicMarketBootstrapError(`${context} fields are invalid.`);
  }
}

function environment(value: unknown, expected: string, context: string): void {
  if (value !== expected) throw new PublicMarketBootstrapError(`${context} does not match ${expected}.`);
}

function unique(values: readonly Record<string, unknown>[], key: (value: Record<string, unknown>) => string, context: string): void {
  const identities = values.map(key);
  if (new Set(identities).size !== identities.length) {
    throw new PublicMarketBootstrapError(`${context} repeats an identity.`);
  }
}

export function loadPublicMarketBootstrap(path: string, expectedEnvironment: string): PublicMarketBootstrap {
  if (statSync(path).size > MAX_BOOTSTRAP_BYTES) {
    throw new PublicMarketBootstrapError("Public market bootstrap file is too large.");
  }
  let decoded: unknown;
  try {
    decoded = parseProtocolJson(readFileSync(path, "utf8"));
  } catch {
    throw new PublicMarketBootstrapError("Public market bootstrap is not valid protocol JSON.");
  }
  const root = record(decoded, "Public market bootstrap");
  exactKeys(root, [
    "version", "environment", "domainManifests", "packageTemplateManifests",
    "matchingPolicies", "series", "executionClasses", "books",
  ], "Public market bootstrap");
  if (root.version !== 1 || typeof root.environment !== "string" || root.environment !== expectedEnvironment
    || expectedEnvironment.toLowerCase().includes("mainnet")) {
    throw new PublicMarketBootstrapError("Public market bootstrap must be version 1 for the configured non-mainnet environment.");
  }

  const domainManifests = array(root.domainManifests, "domainManifests").map((value, index) => {
    const input = record(value, `domainManifests[${index}]`);
    environment(input.environment, expectedEnvironment, `domainManifests[${index}].environment`);
    return input as unknown as DomainManifestInput;
  });
  const packageTemplateManifests = array(root.packageTemplateManifests, "packageTemplateManifests").map((value, index) => {
    const input = record(value, `packageTemplateManifests[${index}]`);
    environment(input.environment, expectedEnvironment, `packageTemplateManifests[${index}].environment`);
    return input as unknown as PackageTemplateManifestInput;
  });
  const matchingPolicies = array(root.matchingPolicies, "matchingPolicies").map((value, index) => {
    const input = record(value, `matchingPolicies[${index}]`);
    environment(input.environment, expectedEnvironment, `matchingPolicies[${index}].environment`);
    return input as unknown as PackageMatchingPolicyInput;
  });
  const series = array(root.series, "series").map((value, index) =>
    record(value, `series[${index}]`) as unknown as EconomicStrategySeriesInput,
  );
  const executionClasses = array(root.executionClasses, "executionClasses").map((value, index) =>
    record(value, `executionClasses[${index}]`) as unknown as SeriesExecutionClassInput,
  );
  const books = array(root.books, "books").map((value, index) => {
    const input = record(value, `books[${index}]`);
    exactKeys(input, ["executionClassId", "executionClassVersion"], `books[${index}]`);
    if (typeof input.executionClassId !== "string" || input.executionClassId.length === 0
      || !Number.isSafeInteger(input.executionClassVersion) || (input.executionClassVersion as number) < 1) {
      throw new PublicMarketBootstrapError(`books[${index}] identity is invalid.`);
    }
    return Object.freeze({
      executionClassId: input.executionClassId,
      executionClassVersion: input.executionClassVersion as number,
    });
  });

  unique(domainManifests as unknown as Record<string, unknown>[], (value) => `${value.domainId}:${value.manifestVersion}`, "domainManifests");
  unique(packageTemplateManifests as unknown as Record<string, unknown>[], (value) => `${value.templateId}:${value.templateVersion}`, "packageTemplateManifests");
  unique(matchingPolicies as unknown as Record<string, unknown>[], (value) => String(value.executionClassId), "matchingPolicies");
  unique(series as unknown as Record<string, unknown>[], (value) => `${value.seriesId}:${value.seriesVersion}`, "series");
  unique(executionClasses as unknown as Record<string, unknown>[], (value) => `${value.executionClassId}:${value.executionClassVersion}`, "executionClasses");
  unique(books as unknown as Record<string, unknown>[], (value) => String(value.executionClassId), "books");

  return Object.freeze({
    version: 1,
    environment: expectedEnvironment,
    domainManifests: Object.freeze(domainManifests),
    packageTemplateManifests: Object.freeze(packageTemplateManifests),
    matchingPolicies: Object.freeze(matchingPolicies),
    series: Object.freeze(series),
    executionClasses: Object.freeze(executionClasses),
    books: Object.freeze(books),
  });
}

export function applyPublicMarketBootstrap(
  bootstrap: PublicMarketBootstrap,
  exchange: Exchange,
  registry: Registry,
): Readonly<{ domains: number; templates: number; series: number; executionClasses: number; books: number }> {
  for (const manifest of bootstrap.domainManifests) registry.registerDomain(manifest);
  for (const manifest of bootstrap.packageTemplateManifests) registry.registerPackageTemplate(manifest);
  for (const policy of bootstrap.matchingPolicies) exchange.registerMatchingPolicy(policy);
  for (const value of bootstrap.series) exchange.registerSeries(value);
  for (const executionClass of bootstrap.executionClasses) exchange.registerExecutionClass(executionClass);
  for (const book of bootstrap.books) exchange.openBook(book.executionClassId, book.executionClassVersion);
  return Object.freeze({
    domains: bootstrap.domainManifests.length,
    templates: bootstrap.packageTemplateManifests.length,
    series: bootstrap.series.length,
    executionClasses: bootstrap.executionClasses.length,
    books: bootstrap.books.length,
  });
}
