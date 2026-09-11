import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "线框工坊 | Wireframe Studio",
  description: "从界面图片到可编辑线框图，为 Codex 交付明确的界面规范。",
  other: {
    "codex-preview": "development",
  },
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
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
