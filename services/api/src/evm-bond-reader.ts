import { BOND_FAULT, openPerformanceBond, type AssetRef, type BondFault, type PerformanceBondLedger } from "@naryx/protocol-types";

/** selector of PerformanceBondVault.bond(bytes32) */
const BOND_SELECTOR = "0x8b3ee973";
const WORDS = 11;

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface EvmBondReaderOptions {
  /** A read-only https (or loopback) JSON-RPC endpoint; the reader holds no key and sends nothing. */
  readonly rpcUrl: string;
  /** The vault's chain; every read first checks that the endpoint serves it. */
  readonly chainId: bigint;
  readonly vault: string;
  /** Registered solver ids by the EVM address that opened their bonds. */
  readonly solverByAddress: ReadonlyMap<string, string>;
  /** Bond assets by token address, as the kernel names them. */
  readonly assetByAddress: ReadonlyMap<string, AssetRef>;
  readonly fetch?: Fetch;
}

/**
 * Reads a performance bond's finalized state from the vault with one `eth_call`, on an endpoint whose
 * `eth_chainId` matches the configured chain, and presents it as the kernel's bond ledger. Paid and
 * still-contestable claims are one encumbrance, which is exactly what the backing check needs. An
 * unknown bond, solver, or asset reads as no bond.
 */
export function createEvmBondReader(options: EvmBondReaderOptions): (bondIdHex: string) => Promise<PerformanceBondLedger | undefined> {
  if (!/^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?)/.test(options.rpcUrl)) throw new Error("RPC URLs must be https or loopback http");
  const vault = options.vault.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(vault)) throw new Error("the vault must be a 20-byte address");
  if (typeof options.chainId !== "bigint" || options.chainId <= 0n) throw new Error("the chain id must be a positive integer");
  const fetcher = options.fetch ?? (fetch as unknown as Fetch);
  const rpc = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    const response = await fetcher(options.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (!response.ok) throw new Error(`${method} answered HTTP ${response.status}`);
    return ((await response.json()) as { result?: unknown }).result;
  };
  return async (bondIdHex) => {
    if (!/^[0-9a-f]{64}$/.test(bondIdHex)) return undefined;
    const chainId = await rpc("eth_chainId", []);
    if (typeof chainId !== "string" || !/^0x[0-9a-f]{1,16}$/i.test(chainId) || BigInt(chainId) !== options.chainId) {
      throw new Error("the bond endpoint serves another chain");
    }
    const result = await rpc("eth_call", [{ to: vault, data: `${BOND_SELECTOR}${bondIdHex}` }, "finalized"]);
    if (typeof result !== "string" || !/^0x([0-9a-f]{64})*$/i.test(result) || (result.length - 2) / 64 !== WORDS) throw new Error("bond read is malformed");
    const data = result.toLowerCase();
    const word = (index: number) => BigInt(`0x${data.slice(2 + index * 64, 2 + (index + 1) * 64)}`);
    const address = (index: number) => `0x${data.slice(2 + index * 64 + 24, 2 + (index + 1) * 64)}`;
    const solver = options.solverByAddress.get(address(0));
    const asset = options.assetByAddress.get(address(1));
    if (word(0) === 0n || solver === undefined || asset === undefined) return undefined;
    const bondAtoms = word(2);
    const encumbered = word(4);
    const mask = Number(word(9));
    const faults = (Object.entries(BOND_FAULT) as [BondFault, number][]).filter(([, bit]) => (mask & (1 << bit)) !== 0).map(([fault]) => fault);
    if (faults.length === 0 || bondAtoms >= 1n << 128n) return undefined;
    const ledger = openPerformanceBond({
      version: 1,
      bondId: bondIdHex,
      solverId: solver,
      asset,
      bondAtoms,
      coveredFaults: faults,
      maximumPayoutPerClaimAtoms: word(3),
      disputeWindowValue: word(6),
      expiresAtValue: word(7),
    });
    const claims = encumbered === 0n ? [] : [{ faultEvidenceHash: ledger.bondHash, fault: faults[0] as BondFault, payoutAtoms: encumbered, filedAtValue: 0n, state: "PENDING" as const }];
    return Object.freeze({ ...ledger, claims: Object.freeze(claims), released: word(10) === 1n });
  };
}
