import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "AI Usage Dashboard",
    template: "%s · AI Usage Dashboard",
  },
  description: "An extensible AI quota and token usage dashboard.",
  openGraph: {
    title: "AI Usage Dashboard",
    description:
      "A local-first dashboard for AI quotas, tokens, and balances across providers.",
    type: "website",
    images: [
      {
        url: "/og.png",
        width: 1731,
        height: 909,
        alt: "AI Usage Dashboard",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "AI Usage Dashboard",
    description:
      "A local-first dashboard for AI quotas, tokens, and balances across providers.",
    images: ["/og.png"],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0b0d10",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
