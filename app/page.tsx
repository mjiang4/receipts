import type { Metadata } from "next";
import { ReceiptsApp } from "./receipts-app";

export const metadata: Metadata = {
  title: "Receipts — your meetings, with memory",
  description:
    "A voice-first meeting participant that checks every 2–3 sentences against the company record.",
};

export default function Home() {
  return <ReceiptsApp />;
}
