import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Trip Booking - Inngest Durable Workflows",
  description: "Comprehensive trip booking example showcasing Inngest's durable execution, step functions, error handling, and compensation patterns.",
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
