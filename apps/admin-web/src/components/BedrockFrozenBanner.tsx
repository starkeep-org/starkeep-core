"use client";

// Dashboard banner for a live Bedrock freeze (budget-guardrail plan §4.7).
//
// Settings is where the guardrail is MANAGED, but apps silently losing a
// capability with no visible reason is the bad outcome this exists to prevent —
// so the frozen state also surfaces on the page the operator actually opens.
//
// Renders nothing at all unless a freeze is live, and reads that from the same
// live-AWS status route Settings uses. Never from a cached flag: a freeze
// self-clears at the month boundary, and a stale banner claiming apps are broken
// when they recovered is worse than no banner.

import { useEffect, useState } from "react";
import Link from "next/link";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  readCloudConfig,
  readCloudCredentials,
  credentialsNearExpiry,
} from "@/lib/cloud-config";
import { shortDate, type BedrockBudgetView } from "./BedrockBudgetSection";

export function BedrockFrozenBanner() {
  const [view, setView] = useState<BedrockBudgetView | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Deliberately does NOT refresh credentials: a banner is not worth a token
      // round-trip on every dashboard load, and Settings will refresh when the
      // operator goes to act on it.
      const cfg = await readCloudConfig();
      if (!cfg) return;
      const creds = await readCloudCredentials();
      if (!creds || credentialsNearExpiry(creds)) return;
      try {
        const res = await fetch("/api/capabilities/bedrock-budget", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(creds),
        });
        if (!res.ok) return;
        const body = (await res.json()) as BedrockBudgetView;
        if (!cancelled && body.frozen) setView(body);
      } catch {
        // A dashboard must render without the cloud. Silence is right here.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!view) return null;

  return (
    <Alert variant="destructive">
      <AlertTitle>Bedrock is frozen — apps cannot use AI right now</AlertTitle>
      <AlertDescription>
        The spend guardrail removed the capability role&apos;s Bedrock permission after a budget
        breach. It lifts itself when the new billing month begins on{" "}
        {shortDate(view.selfClearsAt)}, or you can lift it now from{" "}
        <Link href="/settings" className="underline">
          Settings
        </Link>
        .
      </AlertDescription>
    </Alert>
  );
}
