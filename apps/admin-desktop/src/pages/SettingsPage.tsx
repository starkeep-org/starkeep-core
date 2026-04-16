import { useState } from "react";
import {
  Container, Title, Text, Paper, Stack, Badge, Group, Button,
  TextInput, PasswordInput, Alert, SegmentedControl,
} from "@mantine/core";
import { cloudLogin, isCloudConnected, setCloudConfig, getCloudConfig } from "../lib/cloud-client";

type ConnectionMode = "local" | "cloud";

export function SettingsPage() {
  const [mode, setMode] = useState<ConnectionMode>(
    isCloudConnected() ? "cloud" : "local",
  );
  const [serverUrl, setServerUrl] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const cloudConfig = getCloudConfig();

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!serverUrl || !email || !password) {
      setError("All fields are required");
      return;
    }
    setConnecting(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await cloudLogin(serverUrl, email, password);
      setSuccess(`Connected! Token expires ${new Date(result.expiresAt).toLocaleDateString()}`);
      setMode("cloud");
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = () => {
    setCloudConfig(null);
    setMode("local");
    setSuccess(null);
  };

  return (
    <Container size="md">
      <Title order={1} mb="lg">Settings</Title>

      <Stack gap="md">
        <Paper p="xl" withBorder>
          <Group justify="space-between" mb="md">
            <Title order={3}>Connection Mode</Title>
            <Badge
              variant="light"
              color={mode === "cloud" ? "blue" : "green"}
            >
              {mode === "cloud" ? "Cloud" : "Local"}
            </Badge>
          </Group>

          <SegmentedControl
            value={mode}
            onChange={(v) => setMode(v as ConnectionMode)}
            data={[
              { label: "Local", value: "local" },
              { label: "Starkeep Cloud", value: "cloud" },
            ]}
            fullWidth
            mb="md"
          />

          {mode === "local" && (
            <Text c="dimmed" size="sm">
              Data is stored locally in SQLite at ~/.starkeep/admin.db.
              AWS credentials are read from your environment (~/.aws/credentials).
            </Text>
          )}

          {mode === "cloud" && !cloudConfig && (
            <form onSubmit={handleConnect}>
              <Stack gap="sm" mt="md">
                {error && <Alert color="red" title="Error">{error}</Alert>}
                {success && <Alert color="green" title="Connected">{success}</Alert>}

                <TextInput
                  label="Server URL"
                  placeholder="https://admin.starkeep.example.com"
                  value={serverUrl}
                  onChange={(e) => setServerUrl(e.currentTarget.value)}
                  required
                />
                <TextInput
                  label="Email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.currentTarget.value)}
                  required
                />
                <PasswordInput
                  label="Password"
                  value={password}
                  onChange={(e) => setPassword(e.currentTarget.value)}
                  required
                />
                <Button type="submit" loading={connecting}>
                  Connect
                </Button>
              </Stack>
            </form>
          )}

          {mode === "cloud" && cloudConfig && (
            <Stack gap="sm" mt="md">
              {success && <Alert color="green" title="Connected">{success}</Alert>}
              <Text size="sm">
                Connected to <strong>{cloudConfig.serverUrl}</strong>
              </Text>
              <Button variant="subtle" color="red" onClick={handleDisconnect}>
                Disconnect
              </Button>
            </Stack>
          )}
        </Paper>

        <Paper p="xl" withBorder>
          <Title order={3} mb="sm">AWS Configuration</Title>
          <Text c="dimmed" size="sm">
            AWS credentials are read from your local environment (~/.aws/credentials or environment variables).
            Configure cross-account IAM roles in the AWS Settings wizard to manage infrastructure in target accounts.
          </Text>
        </Paper>
      </Stack>
    </Container>
  );
}
