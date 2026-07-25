import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "AI Usage Dashboard",
    template: "%s · AI Usage Dashboard",
  },
  description: "可扩展的 AI 配额与 Token 用量 Dashboard。",
  openGraph: {
    title: "AI Usage Dashboard",
    description: "本地优先的多平台 AI 配额、Token 与余额仪表盘。",
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
    description: "本地优先的多平台 AI 配额、Token 与余额仪表盘。",
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
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
