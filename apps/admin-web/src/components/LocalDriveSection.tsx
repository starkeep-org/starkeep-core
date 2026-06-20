"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { getRuntimeConfig, RUNTIME_CONFIG_DEFAULTS } from "@/lib/runtime-config";

// ---------------------------------------------------------------------------
// Starkeep Drive — built-in app installed with the core. Not manifest-discovered;
// it runs under the daemon id "drive". Its URL is the loopback default on a
// real install but ephemeral in a harness-booted stack, so it comes from the
// runtime-config bootstrap (STARKEEP_DRIVE_URL) rather than a hardcoded port.
// ---------------------------------------------------------------------------

async function checkUrl(url: string): Promise<boolean> {
  try {
    await fetch(url, { mode: "no-cors", signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
}

export function LocalDriveSection() {
  const [online, setOnline] = useState<boolean | null>(null);
  const [pending, setPending] = useState<"start" | "stop" | null>(null);
  const [driveUrl, setDriveUrl] = useState<string>(RUNTIME_CONFIG_DEFAULTS.driveUrl);

  useEffect(() => {
    getRuntimeConfig().then((c) => setDriveUrl(c.driveUrl)).catch(() => {});
  }, []);

  useEffect(() => {
    setOnline(null);
    checkUrl(driveUrl).then(setOnline);
  }, [driveUrl]);

  // Poll the URL until it matches the requested transition, with a hard cap.
  const waitForTransition = useCallback(async (want: "start" | "stop") => {
    const MAX_ATTEMPTS = 20; // 20 × 1s = 20s
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const up = await checkUrl(driveUrl);
      setOnline(up);
      if ((want === "start" && up) || (want === "stop" && !up)) return;
    }
  }, [driveUrl]);

  const transition = async (action: "start" | "stop") => {
    setPending(action);
    try {
      await fetch("/api/exec/daemon", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, id: "drive" }),
      });
      await waitForTransition(action);
    } catch {
      /* leave status to the next check */
    } finally {
      setPending(null);
    }
  };

  const running = online === true;
  const busy = pending !== null;

  return (
    <div className="rounded-md border p-3 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="font-medium">Starkeep Drive</span>
          <Badge variant="secondary" className="text-xs">Built-in</Badge>
          {running && (
            <a href={driveUrl} target="_blank" rel="noopener noreferrer" title={`Open ${driveUrl}`}>
              <Badge variant="secondary" className="text-xs bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200 hover:bg-blue-200 dark:hover:bg-blue-800 cursor-pointer">
                Running ↗
              </Badge>
            </a>
          )}
        </div>
        <div className="flex gap-2 items-center">
          {online === false && (
            <Button size="sm" variant="outline" onClick={() => transition("start")} disabled={busy}>
              {pending === "start" && (
                <span className="mr-1 size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
              )}
              {pending === "start" ? "Starting…" : "Start"}
            </Button>
          )}
          {running && (
            <Button size="sm" variant="outline" onClick={() => transition("stop")} disabled={busy}>
              {pending === "stop" && (
                <span className="mr-1 size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
              )}
              {pending === "stop" ? "Stopping…" : "Stop"}
            </Button>
          )}
          {running && (
            <Button asChild size="sm" className="bg-blue-600 text-white hover:bg-blue-700">
              <a href={driveUrl} target="_blank" rel="noopener noreferrer">Open ↗</a>
            </Button>
          )}
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        File browser and shared-data UI, installed with the core.
      </p>
    </div>
  );
}
