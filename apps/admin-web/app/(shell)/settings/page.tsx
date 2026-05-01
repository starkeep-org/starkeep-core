"use client";

import { useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  Container,
  Title,
  Text,
  Paper,
  Stack,
  Group,
  Button,
  Alert,
  SegmentedControl,
  Textarea,
} from "@mantine/core";
import {
  readCloudConfig,
  writeCloudConfig,
  readCloudCredentials,
  clearCloudConfig,
  type CloudConfig,
  type CloudConfigExport,
} from "../../../src/lib/cloud-config";
import { refreshTokens, getIdentityPoolCredentials, type STSCredentials } from "../../../src/lib/cognito-auth";
import { LOCAL_URL } from "../../../src/lib/data-client";
import { CommandOutputModal } from "../../../src/components/CommandOutputModal";

export default function SettingsPage() {
  return (
    <Container size="md">
      <Title order={1} mb="lg">
        Settings
      </Title>
      <Stack gap="md">
        <CloudConfigSection />
        <RedeploySection />
        <ResetSection />
      </Stack>
    </Container>
  );
}

async function patchLocalServer(patch: Record<string, string | undefined>): Promise<boolean> {
  try {
    const res = await fetch("http://127.0.0.1:9820/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function CloudConfigSection() {
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportSuccess, setExportSuccess] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importMode, setImportMode] = useState<"file" | "sst">("file");
  const [serverPatched, setServerPatched] = useState(false);
  const [sstText, setSstText] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleExport() {
    setExportError(null);
    setExportSuccess(false);
    try {
      const config = await readCloudConfig();
      if (!config) {
        setExportError("No cloud configuration found. Complete the setup wizard first.");
        return;
      }
      const { cognitoRefreshToken: _rt, ...exportData }: CloudConfig = config;
      const json = JSON.stringify(exportData as CloudConfigExport, null, 2);
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "starkeep-cloud-config.json";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setExportSuccess(true);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : "Export failed");
    }
  }

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    setImportError(null);
    setImportSuccess(false);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as Partial<CloudConfigExport>;

      const required: (keyof CloudConfigExport)[] = [
        "stackPrefix",
        "s3Bucket",
        "s3Region",
        "auroraEndpoint",
        "cognitoConfig",
      ];
      for (const field of required) {
        if (!parsed[field]) throw new Error(`Missing required field: ${field}`);
      }

      const existing = await readCloudConfig();
      const merged: CloudConfig = {
        stackPrefix: parsed.stackPrefix!,
        s3Bucket: parsed.s3Bucket!,
        s3Region: parsed.s3Region!,
        auroraEndpoint: parsed.auroraEndpoint!,
        apiGatewayUrl: parsed.apiGatewayUrl ?? existing?.apiGatewayUrl,
        cognitoConfig: parsed.cognitoConfig!,
        cognitoRefreshToken: existing?.cognitoRefreshToken ?? "",
      };

      await writeCloudConfig(merged);
      const patched = await patchLocalServer({
        s3Bucket: merged.s3Bucket,
        s3Region: merged.s3Region,
        auroraEndpoint: merged.auroraEndpoint,
        apiGatewayUrl: merged.apiGatewayUrl,
      });
      setServerPatched(patched);
      setImportSuccess(true);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleSstImport() {
    setImporting(true);
    setImportError(null);
    setImportSuccess(false);
    try {
      const outputs = parseSstOutputs(sstText);
      const bucketName = outputs["bucketName"];
      const auroraHostname = outputs["auroraHostname"];
      const apiGatewayUrl = outputs["apiGatewayUrl"];
      if (!bucketName || !auroraHostname) {
        throw new Error(
          `Could not find required values in output. Parsed: ${JSON.stringify(outputs)}`,
        );
      }

      const existing = await readCloudConfig();
      if (!existing) throw new Error("No existing cloud config — complete the setup wizard first.");

      const updated: CloudConfig = {
        ...existing,
        s3Bucket: bucketName,
        auroraEndpoint: auroraHostname,
        ...(apiGatewayUrl ? { apiGatewayUrl } : {}),
      };

      await writeCloudConfig(updated);
      const patched = await patchLocalServer({
        s3Bucket: bucketName,
        auroraEndpoint: auroraHostname,
        ...(apiGatewayUrl ? { apiGatewayUrl } : {}),
      });
      setServerPatched(patched);
      setSstText("");
      setImportSuccess(true);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setImporting(false);
    }
  }

  return (
    <Paper p="xl" withBorder>
      <Title order={3} mb="xs">
        Cloud Configuration
      </Title>
      <Text c="dimmed" size="sm" mb="md">
        Export your cloud config to share with another device (pool IDs + bucket + DSQL endpoint —
        no credentials or tokens). On the second device, import the file then sign in through the
        setup wizard.
      </Text>

      <Stack gap="sm">
        {exportError && <Alert color="red" title="Export failed">{exportError}</Alert>}
        {exportSuccess && (
          <Alert color="green" title="Exported">
            starkeep-cloud-config.json downloaded — copy it to your other device and use &quot;Import
            Cloud Config&quot; there.
          </Alert>
        )}
        {importError && <Alert color="red" title="Import failed">{importError}</Alert>}
        {importSuccess && serverPatched && (
          <Alert color="green" title="Imported">
            {importMode === "sst"
              ? "Deploy outputs saved and local server config updated."
              : "Cloud config imported. Sign in through the setup wizard to activate this device."}
          </Alert>
        )}
        {importSuccess && !serverPatched && (
          <Alert color="yellow" title="Saved locally — local server not updated">
            Config saved to this browser, but the local data-server wasn&apos;t reachable so
            starkeep-config.json was not updated. Start the data-server and re-import to apply the
            changes.
          </Alert>
        )}

        <Group>
          <Button variant="default" onClick={handleExport}>
            Export Cloud Config
          </Button>
        </Group>

        <Stack gap="xs">
          <SegmentedControl
            value={importMode}
            onChange={(v) => {
              setImportMode(v as "file" | "sst");
              setImportError(null);
              setImportSuccess(false);
              setServerPatched(false);
            }}
            data={[
              { label: "Upload config file", value: "file" },
              { label: "Paste SST output", value: "sst" },
            ]}
          />

          {importMode === "file" && (
            <Button
              variant="default"
              onClick={() => { setImportError(null); setImportSuccess(false); fileInputRef.current?.click(); }}
              loading={importing}
            >
              Import Cloud Config
            </Button>
          )}

          {importMode === "sst" && (
            <Stack gap="xs">
              <Textarea
                placeholder={"Stack starkeep\n  bucketName: starkeep-files-abc123\n  auroraHostname: abc123.dsql.us-east-1.on.aws\n  apiGatewayUrl: https://abc123.execute-api.us-east-1.amazonaws.com"}
                description="Paste the full output from pnpm run local:deploy"
                minRows={4}
                value={sstText}
                onChange={(e) => { setSstText(e.currentTarget.value); setImportError(null); setImportSuccess(false); }}
                disabled={importing}
              />
              <Group justify="flex-end">
                <Button
                  variant="default"
                  onClick={handleSstImport}
                  loading={importing}
                  disabled={!sstText.trim()}
                >
                  Import from output
                </Button>
              </Group>
            </Stack>
          )}
        </Stack>

        <input
          ref={fileInputRef}
          type="file"
          accept=".json,application/json"
          style={{ display: "none" }}
          onChange={handleFileSelected}
        />
      </Stack>
    </Paper>
  );
}

function ResetSection() {
  const [confirming, setConfirming] = useState(false);
  const router = useRouter();

  async function handleReset() {
    await fetch(`${LOCAL_URL}/auth/logout`, { method: "POST" }).catch(() => {});
    await clearCloudConfig();
    router.push("/cloud-setup");
  }

  return (
    <Paper p="xl" withBorder>
      <Title order={3} mb="xs">
        Reset Cloud Configuration
      </Title>
      <Text c="dimmed" size="sm" mb="md">
        Clears all stored cloud config and credentials from this browser so you can run the setup
        wizard from scratch. Use this after recreating a CloudFormation bootstrap stack.
      </Text>

      <Stack gap="sm">
        {confirming ? (
          <>
            <Alert color="red" title="Are you sure?">
              This will remove all saved cloud config, credentials, and setup state from this
              browser. You will need to complete the setup wizard again.
            </Alert>
            <Group>
              <Button color="red" onClick={handleReset}>
                Yes, reset everything
              </Button>
              <Button variant="default" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </Group>
          </>
        ) : (
          <Group>
            <Button color="red" variant="light" onClick={() => setConfirming(true)}>
              Reset Cloud Config
            </Button>
          </Group>
        )}
      </Stack>
    </Paper>
  );
}

function parseSstOutputs(raw: string): Record<string, string> {
  const clean = raw.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
  const result: Record<string, string> = {};
  for (const m of clean.matchAll(/^\s+(\w+):\s+(.+?)\s*$/gm)) {
    if (m[1] && m[2]) result[m[1]] = m[2].trim();
  }
  if (!result["bucketName"] && !result["auroraHostname"]) {
    for (const m of clean.matchAll(/^\s+(\w+)\s{2,}(.+?)\s*$/gm)) {
      if (m[1] && m[2]) result[m[1]] = m[2].trim();
    }
  }
  return result;
}

function RedeploySection() {
  const [modalOpen, setModalOpen] = useState(false);
  const [credentials, setCredentials] = useState<(STSCredentials & { region: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const handleOpen = useCallback(async () => {
    setError(null);
    setSuccess(false);
    try {
      const config = await readCloudConfig();
      if (!config) throw new Error("No cloud configuration found. Complete the setup wizard first.");
      const tokens = await refreshTokens(config.cognitoConfig, config.cognitoRefreshToken);
      const creds = await getIdentityPoolCredentials(config.cognitoConfig, tokens.idToken);
      setCredentials({ ...creds, region: config.s3Region });
      setModalOpen(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const handleSuccess = useCallback(async () => {
    setModalOpen(false);
    try {
      const config = await readCloudConfig();
      if (!config) return;
      const res = await fetch("/api/exec/deploy-outputs");
      const data = await res.json() as { s3Bucket?: string; s3Region?: string; auroraEndpoint?: string; apiGatewayUrl?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to read deploy outputs");
      await writeCloudConfig({
        ...config,
        s3Bucket: data.s3Bucket ?? config.s3Bucket,
        s3Region: data.s3Region ?? config.s3Region,
        auroraEndpoint: data.auroraEndpoint ?? config.auroraEndpoint,
        apiGatewayUrl: data.apiGatewayUrl ?? config.apiGatewayUrl,
      });
      setSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  return (
    <Paper p="xl" withBorder>
      <Title order={3} mb="xs">
        Infrastructure
      </Title>
      <Text c="dimmed" size="sm" mb="md">
        Redeploy the remote Starkeep infrastructure (S3, Aurora DSQL, Lambda, API Gateway) using
        the current source. Updates cloud config with any new endpoints on success.
      </Text>

      <Stack gap="sm">
        {error && <Alert color="red" title="Deployment failed">{error}</Alert>}
        {success && (
          <Alert color="green" title="Deployment succeeded">
            Infrastructure redeployed and cloud config updated.
          </Alert>
        )}
        <Group>
          <Button onClick={handleOpen} color="blue">
            Redeploy Infrastructure
          </Button>
        </Group>
      </Stack>

      <CommandOutputModal
        opened={modalOpen}
        onClose={() => setModalOpen(false)}
        commandId="local-deploy"
        credentials={credentials ?? undefined}
        title="Redeploy Infrastructure"
        onSuccess={handleSuccess}
      />
    </Paper>
  );
}
