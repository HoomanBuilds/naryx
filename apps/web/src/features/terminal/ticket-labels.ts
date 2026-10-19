const SETTLEMENT_LABELS: Readonly<Record<string, string>> = {
  ATOMIC_POSTCONDITION: "Atomic transaction",
  ASYNC_BONDED_SOLVER: "Bonded asynchronous",
  BATCHED_IOC_WITH_RECOVERY: "IOC with recovery",
  CROSS_DOMAIN_PREPOSITIONED: "Coordinated across chains",
  MANUAL_CONTROLLED_RECOVERY: "Controlled recovery",
};

export function settlementLabel(settlementClass: unknown): string {
  if (settlementClass === null || settlementClass === undefined) return "Selected with quote";
  return typeof settlementClass === "string" && Object.hasOwn(SETTLEMENT_LABELS, settlementClass)
    ? SETTLEMENT_LABELS[settlementClass]
    : "Unrecognized settlement";
}

export function lifecycleActionLabel(action: string): string {
  const label = action.replaceAll("_", " ").toLowerCase();
  return label.charAt(0).toUpperCase() + label.slice(1);
}
