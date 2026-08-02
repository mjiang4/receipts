import type { Metadata } from "next";
import { ReceiptsApp } from "./receipts-app";

export const metadata: Metadata = {
  title: "Receipts — your meetings, with memory",
  description:
    "A voice-first meeting participant that catches material conflicts with the company record.",
};

export default function Home() {
  return <ReceiptsApp />;
}
