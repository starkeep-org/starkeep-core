import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Starkeep Drive",
  description: "Unified view of all your shared data.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
