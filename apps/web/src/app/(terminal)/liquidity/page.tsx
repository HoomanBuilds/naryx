import type { Metadata } from "next";
import { LiquidityView } from "@/features/terminal/pages/liquidity-view";

export const metadata: Metadata = { title: "Liquidity" };

export default function LiquidityPage() {
  return <LiquidityView />;
}
