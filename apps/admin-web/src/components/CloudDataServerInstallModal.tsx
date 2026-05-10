"use client";

/**
 * Modal that drives /api/cloud-data-server/install via SSE and surfaces
 * progress lines + the final outputs (apiGatewayUrl, bucketName, etc.).
 *
 * Distinct from CommandOutputModal — that one wraps /api/exec/stream which
 * expects shelled-out subprocess commands keyed by id, with a numeric exit
 * code in the `done` event. The cloud-data-server install runs in-process
 * inside the Next.js server and returns a JSON outputs object on `done`.
 */

import { useEffect, useRef, useState } from "react";
import { Badge, Box, Button, Group, Loader, Modal, ScrollArea, Text } from "@mantine/core";
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
  /** When non-null, the modal triggers the install on open. */
  credentials: STSCredentials | null;
  onSuccess?: (outputs: CloudDataServerInstallOutputs) => void;
}

export function CloudDataServerInstallModal({
  opened,
  onClose,
  credentials,
  onSuccess,
}: Props) {
  const [lines, setLines] = useState<string[]>([]);
  const [status, setStatus] = useState<"idle" | "running" | "success" | "failure">("idle");
  const viewportRef = useRef<HTMLDivElement>(null);

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
          } catch { /* response might not be JSON if SSE start failed */ }
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

  useEffect(() => {
    if (viewportRef.current) {
      viewportRef.current.scrollTop = viewportRef.current.scrollHeight;
    }
  }, [lines]);

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={
        <Group gap="sm">
          <Text fw={600}>Install cloud-data-server</Text>
          {status === "running" && <Loader size="xs" />}
          {status === "success" && <Badge color="green">Success</Badge>}
          {status === "failure" && <Badge color="red">Failed</Badge>}
        </Group>
      }
      size="xl"
      closeOnClickOutside={status !== "running"}
      closeOnEscape={status !== "running"}
    >
      <ScrollArea h={420} viewportRef={viewportRef}>
        <Box
          style={{
            fontFamily: "monospace",
            fontSize: 12,
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
            padding: "4px 0",
          }}
        >
          {lines.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
          {lines.length === 0 && status === "running" && (
            <Text size="xs" c="dimmed">Starting…</Text>
          )}
        </Box>
      </ScrollArea>
      {status !== "running" && (
        <Group justify="flex-end" mt="md">
          <Button variant="light" onClick={onClose}>Close</Button>
        </Group>
      )}
    </Modal>
  );
}
