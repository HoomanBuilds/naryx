export interface NativeCashPendingTransaction {
  readonly transactionHash: `0x${string}`;
  readonly requestId: string | null;
  readonly action: string;
  readonly phase: 'SUBMITTED' | 'INCLUDED';
}

export const NATIVE_CASH_PENDING_LIMIT = 64;

function validate(value: unknown): NativeCashPendingTransaction {
  const item = value as NativeCashPendingTransaction;
  if (!item || typeof item !== 'object' || Array.isArray(item)
    || !/^0x[0-9a-f]{64}$/i.test(item.transactionHash) || typeof item.action !== 'string' || item.action.length > 80
    || item.action.length === 0 || (item.phase !== 'SUBMITTED' && item.phase !== 'INCLUDED')
    || (item.requestId !== null && (typeof item.requestId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(item.requestId)))) {
    throw new Error('Pending cash transaction is invalid. Preserve the stored receipt journal before recovery.');
  }
  return Object.freeze({ transactionHash: item.transactionHash.toLowerCase() as `0x${string}`,
    requestId: item.requestId, action: item.action, phase: item.phase });
}

export function readNativeCashPending(value: string | null): readonly NativeCashPendingTransaction[] {
  if (value === null) return Object.freeze([]);
  const parsed: unknown = JSON.parse(value);
  const legacy = parsed as { transactionHash?: unknown; phase?: unknown } | null;
  const list = Array.isArray(parsed) ? parsed : legacy && typeof legacy.transactionHash === 'string'
    ? [{ ...legacy, phase: legacy.phase ?? 'SUBMITTED' }] : null;
  if (!list || list.length > NATIVE_CASH_PENDING_LIMIT) throw new Error('Pending cash transaction journal is invalid.');
  const items = list.map(validate);
  if (new Set(items.map(item => item.transactionHash)).size !== items.length) throw new Error('Pending cash transaction journal contains duplicates.');
  return Object.freeze(items);
}

export function updateNativeCashPending(current: readonly NativeCashPendingTransaction[], value: NativeCashPendingTransaction): readonly NativeCashPendingTransaction[] {
  const item = validate(value);
  const previous = current.find(entry => entry.transactionHash === item.transactionHash);
  if (previous && (previous.requestId !== item.requestId || previous.action !== item.action)) throw new Error('Pending cash transaction identity changed.');
  if (!previous && current.length >= NATIVE_CASH_PENDING_LIMIT) throw new Error('Reconcile existing cash transactions before submitting another.');
  return Object.freeze(previous
    ? current.map(entry => entry.transactionHash === item.transactionHash ? item : entry)
    : [...current, item]);
}
