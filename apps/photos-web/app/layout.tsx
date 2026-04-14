import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Starkeep Photos",
  description: "Your photos, your data",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, minHeight: "100vh", background: "#111" }}>
        {children}
      </body>
    </html>
  );
}
