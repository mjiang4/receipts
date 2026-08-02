import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "https";
  const metadataBase = new URL(
    host ? `${protocol}://${host}` : "http://localhost:3000",
  );

  return {
    metadataBase,
    title: "Receipts",
    description:
      "A voice-first meeting participant that automatically checks completed thoughts against the company record.",
    openGraph: {
      title: "Receipts — your meetings, with a memory",
      description:
        "A voice-first meeting participant that speaks up when the company record disagrees.",
      type: "website",
      images: [{ url: "/og.png", width: 1672, height: 941, alt: "Receipts — your meetings, with a memory" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "Receipts — your meetings, with a memory",
      description:
        "A voice-first meeting participant that speaks up when the company record disagrees.",
      images: ["/og.png"],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
