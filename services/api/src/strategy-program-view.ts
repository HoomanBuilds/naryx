import {
  strategyTemplateDefinitions,
  type GraphLegSide,
  type GraphLifecycleAction,
  type LegFamily,
  type SettlementClass,
  type StrategyTemplateActionSpec,
} from "@naryx/protocol-types";

export type StrategyProgramActivation = "EXECUTABLE_BY_QUALIFIED_LANE" | "ADAPTER_ACTIVATION_REQUIRED";

export interface StrategyExecutionLaneCapability {
  readonly laneId: string;
  readonly templateId: string;
  readonly templateVersion: number;
  readonly actions: readonly GraphLifecycleAction[];
  readonly legs: readonly StrategyExecutionLegCapability[];
  readonly settlementClasses: readonly SettlementClass[];
  readonly domains: readonly string[];
}

export interface StrategyExecutionLegCapability {
  readonly legFamily: LegFamily;
  readonly sides: readonly GraphLegSide[];
  readonly maximumLegs: number;
}

function validId(value: string): boolean {
  return /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

function supportsAction(
  action: StrategyTemplateActionSpec,
  capabilities: readonly StrategyExecutionLegCapability[],
): boolean {
  const slots = capabilities.flatMap((capability, capabilityIndex) =>
    Array.from({ length: capability.maximumLegs }, () => capabilityIndex),
  );
  const requiredRules = action.legRules.flatMap((rule, ruleIndex) =>
    Array.from({ length: rule.minimumCount }, () => ruleIndex),
  );
  const optionalRules = action.legRules.flatMap((rule, ruleIndex) =>
    Array.from({ length: rule.maximumCount - rule.minimumCount }, () => ruleIndex),
  );
  const matches = (ruleIndex: number, slotIndex: number): boolean => {
    const rule = action.legRules[ruleIndex];
    const capabilityIndex = slots[slotIndex];
    const capability = capabilityIndex === undefined ? undefined : capabilities[capabilityIndex];
    return rule !== undefined
      && capability !== undefined
      && rule.allowedFamilies.includes(capability.legFamily)
      && rule.allowedSides.some((side) => capability.sides.includes(side));
  };
  const requestedRules = [...requiredRules];
  const assignedRequestBySlot = Array<number>(slots.length).fill(-1);
  const assignRequest = (requestIndex: number, seenSlots: Set<number>): boolean => {
    const ruleIndex = requestedRules[requestIndex];
    if (ruleIndex === undefined) return true;
    for (let slotIndex = 0; slotIndex < slots.length; slotIndex += 1) {
      if (seenSlots.has(slotIndex) || !matches(ruleIndex, slotIndex)) continue;
      seenSlots.add(slotIndex);
      const previousRequestIndex = assignedRequestBySlot[slotIndex] ?? -1;
      if (previousRequestIndex === -1 || assignRequest(previousRequestIndex, seenSlots)) {
        assignedRequestBySlot[slotIndex] = requestIndex;
        return true;
      }
    }
    return false;
  };
  if (!requiredRules.every((_, index) => assignRequest(index, new Set()))) return false;

  const remainingRequiredLegs = Math.max(0, action.minimumLegs - requiredRules.length);
  if (remainingRequiredLegs === 0) return true;
  let assignedOptionalLegs = 0;
  for (const ruleIndex of optionalRules) {
    const requestIndex = requestedRules.push(ruleIndex) - 1;
    if (assignRequest(requestIndex, new Set())) assignedOptionalLegs += 1;
    if (assignedOptionalLegs >= remainingRequiredLegs) return true;
  }
  return false;
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
    if (value.legs.length === 0) {
      throw new Error(`Strategy execution lane ${value.laneId} leg capabilities are invalid.`);
    }
    for (const leg of value.legs) {
      if (leg.sides.length === 0 || new Set(leg.sides).size !== leg.sides.length
        || !Number.isInteger(leg.maximumLegs) || leg.maximumLegs < 1 || leg.maximumLegs > 64) {
        throw new Error(`Strategy execution lane ${value.laneId} leg capabilities are invalid.`);
      }
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
      legs: Object.freeze(value.legs.map((leg) => Object.freeze({
        ...leg,
        sides: Object.freeze([...leg.sides]),
      }))),
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
          && supportsAction(action, lane.legs)
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
