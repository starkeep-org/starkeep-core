import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ColorSchemeScript, MantineProvider } from "@mantine/core";
import "@mantine/core/styles.css";

export const metadata: Metadata = {
  title: "Starkeep Admin",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <ColorSchemeScript />
      </head>
      <body style={{ margin: 0 }}>
        <MantineProvider>{children}</MantineProvider>
      </body>
    </html>
  );
}
