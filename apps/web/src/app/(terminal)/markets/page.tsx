import type { Metadata } from "next";
import { MarketsView } from "@/features/terminal/pages/markets-view";

export const metadata: Metadata = { title: "Markets" };

export default function MarketsPage() {
  return <MarketsView />;
}
