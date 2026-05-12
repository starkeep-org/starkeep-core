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

export interface CloudDataServerInstallOutputs {
  appRoleArn: string;
  auroraHostname: string;
  bucketName: string;
  apiGatewayUrl: string;
  apiGatewayId: string;
  authorizerId: string;
  functionArn: string;
  region: string;
  appliedMigrations: string[];
  skippedMigrations: string[];
}

interface Props {
  opened: boolean;
  onClose: () => void;
  credentials: STSCredentials | null;
  onSuccess?: (outputs: CloudDataServerInstallOutputs) => void;
}

export function CloudDataServerInstallModal({ opened, onClose, credentials, onSuccess }: Props) {
  const [lines, setLines] = useState<string[]>([]);
  const [status, setStatus] = useState<"idle" | "running" | "success" | "failure">("idle");

  useEffect(() => {
    if (!opened || !credentials) return;

    setLines([]);
    setStatus("running");
    let aborted = false;

    async function run() {
      try {
        const resp = await fetch("/api/cloud-data-server/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            accessKeyId: credentials!.accessKeyId,
            secretAccessKey: credentials!.secretAccessKey,
            sessionToken: credentials!.sessionToken,
          }),
        });

        if (!resp.ok || !resp.body) {
          let errMsg = `${resp.status} ${resp.statusText}`;
          try {
            const j = (await resp.json()) as { error?: string };
            if (j.error) errMsg = j.error;
          } catch { /* not JSON */ }
          setLines((l) => [...l, `Error: ${errMsg}`]);
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
              try {
                const outputs = JSON.parse(data) as CloudDataServerInstallOutputs;
                setStatus("success");
                onSuccess?.(outputs);
              } catch {
                setLines((l) => [...l, `Error: malformed done event: ${data}`]);
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
  }, [opened, credentials]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Dialog open={opened} onOpenChange={(open) => { if (!open && status !== "running") onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Install cloud-data-server</DialogTitle>
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
