import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CTAI · 营销工作台",
  description: "让客户洞察、策略、商机、风控和培训在同一个工作台协作。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body className="antialiased">{children}</body>
    </html>
  );
}
