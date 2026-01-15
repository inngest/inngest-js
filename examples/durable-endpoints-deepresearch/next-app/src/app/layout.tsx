import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "DeepResearch - Inngest Durable Endpoints",
  description: "AI-powered deep research tool showcasing Inngest's durable execution and step functions.",
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
