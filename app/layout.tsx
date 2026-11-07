import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "营销工作台",
  description: "用于抖音获客、项目跟进、培训提升和知识库管理。",
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
