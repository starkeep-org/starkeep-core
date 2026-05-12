"use client";

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { CommandOutput } from "./CommandOutput";
import type { STSCredentials } from "../lib/cognito-auth";

interface Props {
  opened: boolean;
  onClose: () => void;
  commandId: string | null;
  credentials?: STSCredentials & { region: string };
  title: string;
  onSuccess?: () => void;
}

export function CommandOutputModal({ opened, onClose, commandId, credentials, title, onSuccess }: Props) {
  const [lines, setLines] = useState<string[]>([]);
  const [status, setStatus] = useState<"idle" | "running" | "success" | "failure">("idle");

  useEffect(() => {
    if (!opened || !commandId) return;

    setLines([]);
    setStatus("running");
    let aborted = false;

    async function run() {
      try {
        const resp = await fetch("/api/exec/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: commandId, credentials }),
        });

        if (!resp.ok || !resp.body) {
          setLines((l) => [...l, `Error: ${resp.status} ${resp.statusText}`]);
          setStatus("failure");
          return;
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done || aborted) break;

          buffer += decoder.decode(value, { stream: true });
          const chunks = buffer.split("\n\n");
          buffer = chunks.pop() ?? "";

          for (const chunk of chunks) {
            let eventType = "message";
            let data = "";
            for (const part of chunk.split("\n")) {
              if (part.startsWith("event: ")) eventType = part.slice(7);
              else if (part.startsWith("data: ")) data = part.slice(6);
            }
            if (eventType === "done") {
              const exitCode = parseInt(data, 10);
              if (exitCode === 0) {
                setStatus("success");
                onSuccess?.();
              } else {
                setStatus("failure");
              }
            } else if (eventType === "error") {
              try { setLines((l) => [...l, `Error: ${JSON.parse(data) as string}`]); }
              catch { setLines((l) => [...l, `Error: ${data}`]); }
              setStatus("failure");
            } else if (data) {
              try { setLines((l) => [...l, JSON.parse(data) as string]); }
              catch { setLines((l) => [...l, data]); }
            }
          }
        }
      } catch (err) {
        if (!aborted) {
          setLines((l) => [...l, `Error: ${err instanceof Error ? err.message : String(err)}`]);
          setStatus("failure");
        }
      }
    }

    run();
    return () => { aborted = true; };
  }, [opened, commandId]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Dialog open={opened} onOpenChange={(open) => { if (!open && status !== "running") onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <CommandOutput lines={lines} status={status} />
        {status !== "running" && (
          <div className="flex justify-end">
            <Button variant="outline" onClick={onClose}>Close</Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
