"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import {
  Container,
  Title,
  Text,
  Paper,
  Stack,
  Group,
  Button,
  Alert,
  TextInput,
  Badge,
  Anchor,
  Divider,
  ScrollArea,
  Code,
  Loader,
} from "@mantine/core";
import {
  readPhotosWebPath,
  writePhotosWebPath,
  readCloudConfig,
  readCloudCredentials,
  writeCloudCredentials,
} from "../../../src/lib/cloud-config";
import { refreshTokens, getIdentityPoolCredentials } from "../../../src/lib/cognito-auth";

export default function AppsPage() {
  return (
    <Container size="md">
      <Title order={1} mb="lg">
        Apps
      </Title>
      <Stack gap="md">
        <PhotosWebSection />
      </Stack>
    </Container>
  );
}

async function readInstallStream(
  photosWebPath: string,
  onLine: (line: string) => void,
): Promise<{ port: number; pid: number }> {
  const res = await fetch("/api/photos-web/install", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ photosWebPath }),
  });

  if (!res.ok || !res.body) {
    const data = await res.json() as { error?: string };
    throw new Error(data.error ?? "Install failed");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";

    for (const event of events) {
      const lines = event.split("\n");
      const eventType = lines.find((l) => l.startsWith("event:"))?.slice(7).trim();
      const dataLine = lines.find((l) => l.startsWith("data:"))?.slice(5).trim();
      if (!dataLine) continue;

      if (eventType === "done") {
        return JSON.parse(dataLine) as { port: number; pid: number };
      } else if (eventType === "error") {
        throw new Error(JSON.parse(dataLine) as string);
      } else {
        onLine(JSON.parse(dataLine) as string);
      }
    }
  }

  throw new Error("Install stream ended without a done event");
}

function PhotosWebSection() {
  const [path, setPath] = useState("");
  const [installing, setInstalling] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [running, setRunning] = useState<boolean | null>(null);
  const [port, setPort] = useState<number | null>(null);
  const [installLog, setInstallLog] = useState<string[]>([]);
  const [localError, setLocalError] = useState<string | null>(null);
  const [localSuccess, setLocalSuccess] = useState(false);

  const [deploying, setDeploying] = useState(false);
  const [deployLog, setDeployLog] = useState<string[]>([]);
  const [deployError, setDeployError] = useState<string | null>(null);
  const [deploySuccess, setDeploySuccess] = useState(false);

  const installLogEndRef = useRef<HTMLDivElement>(null);
  const deployLogEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    readPhotosWebPath().then((saved) => { if (saved) setPath(saved); });
    checkStatus();
  }, []);

  useEffect(() => {
    installLogEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [installLog]);

  useEffect(() => {
    deployLogEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [deployLog]);

  const checkStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/exec/daemon/status?id=photos-web");
      if (res.ok) {
        const data = await res.json() as { running: boolean; port?: number };
        setRunning(data.running);
        setPort(data.port ?? null);
      }
    } catch {
      setRunning(false);
      setPort(null);
    }
  }, []);

  const handleInstall = async () => {
    if (!path.trim()) return;
    setInstalling(true);
    setLocalError(null);
    setLocalSuccess(false);
    setInstallLog([]);
    try {
      await writePhotosWebPath(path.trim());
      const result = await readInstallStream(path.trim(), (line) =>
        setInstallLog((prev) => [...prev, line]),
      );
      setLocalSuccess(true);
      setRunning(true);
      setPort(result.port);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstalling(false);
    }
  };

  const handleStop = async () => {
    setStopping(true);
    setLocalError(null);
    try {
      await fetch("/api/exec/daemon", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop", id: "photos-web" }),
      });
      setRunning(false);
      setPort(null);
      setLocalSuccess(false);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setStopping(false);
    }
  };

  const handleDeploy = async () => {
    if (!path.trim()) return;
    setDeploying(true);
    setDeployLog([]);
    setDeployError(null);
    setDeploySuccess(false);

    try {
      const config = await readCloudConfig();
      if (!config) throw new Error("No cloud configuration — complete the setup wizard first.");

      let creds = await readCloudCredentials();
      if (!creds) {
        const tokens = await refreshTokens(config.cognitoConfig, config.cognitoRefreshToken);
        creds = await getIdentityPoolCredentials(config.cognitoConfig, tokens.idToken);
        await writeCloudCredentials(creds);
      }

      const credentials = { ...creds, region: config.cognitoConfig.region };

      const res = await fetch("/api/photos-web/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ photosWebPath: path.trim(), credentials }),
      });

      if (!res.ok || !res.body) {
        const data = await res.json() as { error?: string };
        throw new Error(data.error ?? "Deploy request failed");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";

        for (const event of events) {
          const lines = event.split("\n");
          const eventType = lines.find((l) => l.startsWith("event:"))?.slice(7).trim();
          const dataLine = lines.find((l) => l.startsWith("data:"))?.slice(5).trim();
          if (!dataLine) continue;

          if (eventType === "done") {
            const result = JSON.parse(dataLine) as { exitCode: number; photosCloudConfig: Record<string, unknown> | null };
            if (result.exitCode !== 0) {
              throw new Error(`Deploy exited with code ${result.exitCode}`);
            }
            setDeploySuccess(true);
            if (result.photosCloudConfig) {
              // Re-install to update runtime config with new cloud URLs
              setDeployLog((prev) => [...prev, "Re-installing with updated cloud config..."]);
              const reinstall = await readInstallStream(path.trim(), (line) =>
                setDeployLog((prev) => [...prev, line]),
              );
              setPort(reinstall.port);
              setRunning(true);
            }
          } else if (eventType === "error") {
            throw new Error(JSON.parse(dataLine) as string);
          } else {
            setDeployLog((prev) => [...prev, JSON.parse(dataLine) as string]);
          }
        }
      }
    } catch (err) {
      setDeployError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeploying(false);
    }
  };

  return (
    <Paper p="xl" withBorder>
      <Group justify="space-between" mb="xs">
        <Title order={3}>Photos Web</Title>
        {running === true && <Badge color="green" variant="light">Running</Badge>}
        {running === false && <Badge color="gray" variant="light">Stopped</Badge>}
      </Group>

      <Text c="dimmed" size="sm" mb="md">
        Manage the photos-web app from your local checkout.
      </Text>

      <TextInput
        label="Photos Web repo path"
        placeholder="~/projects/starkeep/photos"
        value={path}
        onChange={(e) => { setPath(e.currentTarget.value); }}
        disabled={installing || deploying}
        mb="md"
      />

      {/* ── LOCAL ── */}
      <Text fw={500} size="sm" mb="xs">Local</Text>
      <Stack gap="sm" mb="lg">
        {localError && <Alert color="red" title="Error">{localError}</Alert>}
        {localSuccess && port && (
          <Alert color="green" title="Running">
            photos-web is running at{" "}
            <Anchor href={`http://localhost:${port}`} target="_blank">{`http://localhost:${port}`}</Anchor>
          </Alert>
        )}
        <Group>
          <Button onClick={handleInstall} loading={installing} disabled={!path.trim()}>
            {running ? "Reinstall & Restart" : "Install & Start"}
          </Button>
          {running && (
            <Button variant="default" onClick={handleStop} loading={stopping}>Stop</Button>
          )}
          {running && port && (
            <Anchor href={`http://localhost:${port}`} target="_blank" size="sm">Open photos-web ↗</Anchor>
          )}
        </Group>

        {(installing || installLog.length > 0) && (
          <ScrollArea h={200} type="auto">
            <Code block style={{ fontSize: 11, whiteSpace: "pre-wrap" }}>
              {installLog.join("\n")}
            </Code>
            <div ref={installLogEndRef} />
          </ScrollArea>
        )}
      </Stack>

      <Divider mb="md" />

      {/* ── CLOUD ── */}
      <Text fw={500} size="sm" mb="xs">Cloud</Text>
      <Text c="dimmed" size="sm" mb="sm">
        Deploy photos-web infrastructure to AWS (thumbnail Lambda, static server Lambda,
        API Gateway). Requires cloud setup to be complete.
      </Text>
      <Stack gap="sm">
        {deployError && <Alert color="red" title="Deploy failed">{deployError}</Alert>}
        {deploySuccess && (
          <Alert color="green" title="Deployed">
            Photos infrastructure deployed. Runtime config updated with new cloud URLs.
          </Alert>
        )}

        <Group>
          <Button onClick={handleDeploy} loading={deploying} disabled={!path.trim()} color="blue">
            Deploy to cloud
          </Button>
          {deploying && <Loader size="xs" />}
        </Group>

        {(deploying || deployLog.length > 0) && (
          <ScrollArea h={240} type="auto">
            <Code block style={{ fontSize: 11, whiteSpace: "pre-wrap" }}>
              {deployLog.join("\n")}
            </Code>
            <div ref={deployLogEndRef} />
          </ScrollArea>
        )}
      </Stack>
    </Paper>
  );
}
