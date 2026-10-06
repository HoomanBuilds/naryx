import {
  strategyTemplateDefinitions,
  type GraphLifecycleAction,
  type LegFamily,
  type SettlementClass,
} from "@naryx/protocol-types";

export type StrategyProgramActivation = "EXECUTABLE_BY_QUALIFIED_LANE" | "ADAPTER_ACTIVATION_REQUIRED";

export interface StrategyExecutionLaneCapability {
  readonly laneId: string;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly actions: readonly GraphLifecycleAction[];
  readonly legFamilies: readonly LegFamily[];
  readonly settlementClasses: readonly SettlementClass[];
  readonly domains: readonly string[];
}

function validId(value: string): boolean {
  return /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

function checkedCapabilities(values: readonly StrategyExecutionLaneCapability[]): readonly StrategyExecutionLaneCapability[] {
  const laneIds = new Set<string>();
  return Object.freeze(values.map((value) => {
    if (!validId(value.laneId) || !validId(value.templateId) || value.templateVersion < 1 || !Number.isInteger(value.templateVersion)) {
      throw new Error("Strategy execution lane identity is invalid.");
    }
    if (laneIds.has(value.laneId)) throw new Error(`Strategy execution lane ${value.laneId} is repeated.`);
    laneIds.add(value.laneId);
    if (value.actions.length === 0 || new Set(value.actions).size !== value.actions.length) {
      throw new Error(`Strategy execution lane ${value.laneId} actions are invalid.`);
    }
    if (value.legFamilies.length === 0 || new Set(value.legFamilies).size !== value.legFamilies.length) {
      throw new Error(`Strategy execution lane ${value.laneId} leg families are invalid.`);
    }
    if (value.settlementClasses.length === 0 || new Set(value.settlementClasses).size !== value.settlementClasses.length) {
      throw new Error(`Strategy execution lane ${value.laneId} settlement classes are invalid.`);
    }
    if (value.domains.length === 0 || value.domains.some((domain) => !validId(domain)) || new Set(value.domains).size !== value.domains.length) {
      throw new Error(`Strategy execution lane ${value.laneId} domains are invalid.`);
    }
    return Object.freeze({
      ...value,
      actions: Object.freeze([...value.actions]),
      legFamilies: Object.freeze([...value.legFamilies]),
      settlementClasses: Object.freeze([...value.settlementClasses]),
      domains: Object.freeze([...value.domains]),
    });
  }));
}

export function strategyProgramView(capabilities: readonly StrategyExecutionLaneCapability[]) {
  const lanes = checkedCapabilities(capabilities);
  return Object.freeze({
    version: 1 as const,
    templates: Object.freeze(strategyTemplateDefinitions().map((template) => {
      const matching = lanes.filter((lane) =>
        lane.templateId === template.templateId && lane.templateVersion === template.templateVersion,
      );
      const actions = template.actionSpecs.map((action) => {
        const qualifiedLanes = matching.filter((lane) =>
          lane.actions.includes(action.action)
          && lane.settlementClasses.some((settlementClass) => action.allowedSettlementClasses.includes(settlementClass))
          && action.legRules.every((rule) =>
            rule.minimumCount === 0 || rule.allowedFamilies.some((family) => lane.legFamilies.includes(family)),
          )
        ).map((lane) => lane.laneId).sort();
        return Object.freeze({
          action: action.action,
          minimumLegs: action.minimumLegs,
          maximumLegs: action.maximumLegs,
          settlementClasses: action.allowedSettlementClasses,
          legRoles: action.legRules.map((leg) => ({
            legTypeId: leg.legTypeId,
            allowedFamilies: leg.allowedFamilies,
            allowedSides: leg.allowedSides,
            minimumCount: leg.minimumCount,
            maximumCount: leg.maximumCount,
          })),
          activation: qualifiedLanes.length === 0
            ? 'ADAPTER_ACTIVATION_REQUIRED' as const
            : 'EXECUTABLE_BY_QUALIFIED_LANE' as const,
          qualifiedLanes: Object.freeze(qualifiedLanes),
        });
      });
      const qualifiedLanes = [...new Set(actions.flatMap((action) => action.qualifiedLanes))].sort();
      return Object.freeze({
        templateId: template.templateId,
        templateVersion: template.templateVersion,
        displayName: template.displayName,
        quoteConventionId: template.quoteConventionId,
        riskClassId: template.riskClassId,
        lifecycleConventionId: template.lifecycleConventionId,
        metricIds: template.metricIds,
        actions: Object.freeze(actions),
        activation: qualifiedLanes.length === 0
          ? 'ADAPTER_ACTIVATION_REQUIRED' as const
          : 'EXECUTABLE_BY_QUALIFIED_LANE' as const,
        qualifiedLanes: Object.freeze(qualifiedLanes),
      });
    })),
  });
}
