export type StrategyProgramAction = Readonly<{
  action: string;
  minimumLegs: number;
  maximumLegs: number;
  settlementClasses: readonly string[];
  legRoles: readonly Readonly<{
    legTypeId: string;
    allowedFamilies: readonly string[];
    allowedSides: readonly string[];
    minimumCount: number;
    maximumCount: number;
  }>[];
}>;

export type StrategyProgramTemplate = Readonly<{
  templateId: string;
  templateVersion: number;
  displayName: string;
  quoteConventionId: string;
  riskClassId: string;
  lifecycleConventionId: string;
  metricIds: readonly string[];
  actions: readonly StrategyProgramAction[];
  activation: "EXECUTABLE_BY_QUALIFIED_LANE" | "ADAPTER_ACTIVATION_REQUIRED";
}>;

export type StrategyProgram = Readonly<{
  version: 1;
  templates: readonly StrategyProgramTemplate[];
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTemplate(value: unknown): StrategyProgramTemplate {
  if (!isRecord(value) || typeof value.templateId !== "string" || typeof value.displayName !== "string" ||
      value.templateVersion !== 1 || typeof value.quoteConventionId !== "string" ||
      typeof value.riskClassId !== "string" || typeof value.lifecycleConventionId !== "string" ||
      !Array.isArray(value.metricIds) || !value.metricIds.every((metric) => typeof metric === "string") ||
      !Array.isArray(value.actions) ||
      (value.activation !== "EXECUTABLE_BY_QUALIFIED_LANE" && value.activation !== "ADAPTER_ACTIVATION_REQUIRED")) {
    throw new Error("Strategy program template is invalid.");
  }
  const actions = value.actions.map((action): StrategyProgramAction => {
    if (!isRecord(action) || typeof action.action !== "string" ||
        typeof action.minimumLegs !== "number" || typeof action.maximumLegs !== "number" ||
        !Array.isArray(action.settlementClasses) || !action.settlementClasses.every((item) => typeof item === "string") ||
        !Array.isArray(action.legRoles)) {
      throw new Error("Strategy program action is invalid.");
    }
    const legRoles = action.legRoles.map((leg) => {
      if (!isRecord(leg) || typeof leg.legTypeId !== "string" ||
          !Array.isArray(leg.allowedFamilies) || !leg.allowedFamilies.every((item) => typeof item === "string") ||
          !Array.isArray(leg.allowedSides) || !leg.allowedSides.every((item) => typeof item === "string") ||
          typeof leg.minimumCount !== "number" || typeof leg.maximumCount !== "number") {
        throw new Error("Strategy program leg role is invalid.");
      }
      return Object.freeze({
        legTypeId: leg.legTypeId,
        allowedFamilies: Object.freeze([...leg.allowedFamilies]),
        allowedSides: Object.freeze([...leg.allowedSides]),
        minimumCount: leg.minimumCount,
        maximumCount: leg.maximumCount,
      });
    });
    return Object.freeze({
      action: action.action,
      minimumLegs: action.minimumLegs,
      maximumLegs: action.maximumLegs,
      settlementClasses: Object.freeze([...action.settlementClasses]),
      legRoles: Object.freeze(legRoles),
    });
  });
  return Object.freeze({
    templateId: value.templateId,
    templateVersion: 1,
    displayName: value.displayName,
    quoteConventionId: value.quoteConventionId,
    riskClassId: value.riskClassId,
    lifecycleConventionId: value.lifecycleConventionId,
    metricIds: Object.freeze([...value.metricIds]),
    actions: Object.freeze(actions),
    activation: value.activation,
  });
}

export async function fetchStrategyProgram(baseUrl: string, signal?: AbortSignal): Promise<StrategyProgram> {
  const response = await fetch(`${baseUrl}/internal/terminal/strategy-program`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal,
  });
  if (!response.ok) throw new Error("Strategy program is unavailable.");
  const value: unknown = await response.json();
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.templates)) {
    throw new Error("Strategy program response is invalid.");
  }
  return Object.freeze({ version: 1, templates: Object.freeze(value.templates.map(parseTemplate)) });
}
