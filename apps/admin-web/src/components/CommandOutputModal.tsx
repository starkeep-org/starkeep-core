"use client";

import { useEffect, useRef, useState } from "react";
import { Badge, Box, Button, Group, Loader, Modal, ScrollArea, Text } from "@mantine/core";
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
  const viewportRef = useRef<HTMLDivElement>(null);

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
              try { setLines((l) => [...l, `Error: ${JSON.parse(data) as string}`]); } catch { setLines((l) => [...l, `Error: ${data}`]); }
              setStatus("failure");
            } else if (data) {
              try { setLines((l) => [...l, JSON.parse(data) as string]); } catch { setLines((l) => [...l, data]); }
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
  }, [opened, commandId]);

  // Auto-scroll to bottom as lines arrive
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
          <Text fw={600}>{title}</Text>
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
