"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  Container,
  Title,
  Text,
  Paper,
  Stack,
  Group,
  Badge,
  Code,
  Loader,
  Alert,
  Button,
  TextInput,
  PasswordInput,
  Collapse,
  Modal,
  Divider,
  Anchor,
  SimpleGrid,
  Center,
  Table,
} from "@mantine/core";
import {
  readCloudConfig,
  readCloudCredentials,
  writeCloudConfig,
  writeCloudCredentials,
  credentialsNearExpiry,
  type CloudConfig,
} from "../../src/lib/cloud-config";
import { ModeSelector } from "../../src/components/mode-selector";
import { CommandOutputModal } from "../../src/components/CommandOutputModal";
import {
  initiateAuth,
  respondNewPasswordChallenge,
  refreshTokens,
  getIdentityPoolCredentials,
  type CognitoConfig,
  type STSCredentials,
} from "../../src/lib/cognito-auth";
import {
  projectFullMonth,
  type ServiceCost,
} from "../../src/lib/cost-usage-report";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TypeSummary {
  record_type: string;
  count: number;
}

interface DataTypesResponse {
  types: TypeSummary[];
  total: number;
}

interface Watch {
  id: string;
  directoryPath: string;
  targetType: string;
  state: string;
  totalFiles: number;
  syncedFiles: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function checkUrl(url: string): Promise<boolean> {
  try {
    await fetch(url, { mode: "no-cors", signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
}

function extractEmail(idToken: string): string | null {
  try {
    const payload = JSON.parse(atob(idToken.split(".")[1]));
    return (payload.email as string) ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export default function DashboardPage() {
  const router = useRouter();
  const [refreshKey, setRefreshKey] = useState(0);

  // Local data server
  const [localOnline, setLocalOnline] = useState<boolean | null>(null);
  const [localTypes, setLocalTypes] = useState<DataTypesResponse | null>(null);
  const [localCognitoConfig, setLocalCognitoConfig] = useState<CognitoConfig | null>(null);
  const [localAuthAuthenticated, setLocalAuthAuthenticated] = useState<boolean | null>(null);
  const [photosWebUrl, setPhotosWebUrl] = useState<string | null | undefined>(undefined);
  const [watches, setWatches] = useState<Watch[] | null>(null);
  const [typesExpanded, setTypesExpanded] = useState(false);

  // Local apps
  const [localPhotosWeb, setLocalPhotosWeb] = useState<boolean | null>(null);
  const [localFileBrowser, setLocalFileBrowser] = useState<boolean | null>(null);

  // Remote
  const [cloudConfig, setCloudConfig] = useState<CloudConfig | null | undefined>(undefined);
  const [remoteOnline, setRemoteOnline] = useState<boolean | null>(null);
  const [remoteTypes, setRemoteTypes] = useState<DataTypesResponse | null>(null);
  const [remoteTypesExpanded, setRemoteTypesExpanded] = useState(false);
  const [remotePhotosWeb, setRemotePhotosWeb] = useState<boolean | null>(null);

  // Costs
  const [costs, setCosts] = useState<ServiceCost[] | "loading" | "error" | "no-data">("loading");
  const [costProjection, setCostProjection] = useState<ServiceCost[] | null>(null);

  // Add watch form
  const [watchPath, setWatchPath] = useState("");
  const [watchSubmitting, setWatchSubmitting] = useState(false);
  const [watchError, setWatchError] = useState<string | null>(null);
  const [watchSuccess, setWatchSuccess] = useState<string | null>(null);

  // Daemon start/stop loading
  const [daemonLoading, setDaemonLoading] = useState<Record<string, boolean>>({});

  // Command output modal
  const [outputModal, setOutputModal] = useState<{
    commandId: string;
    title: string;
    credentials?: STSCredentials & { region: string };
  } | null>(null);
  const [outputOpen, setOutputOpen] = useState(false);

  // Confirm modal (for destructive commands)
  const [confirmModal, setConfirmModal] = useState<{
    commandId: string;
    title: string;
    message: string;
    requiresCreds: boolean;
  } | null>(null);

  // Sign-in modal
  const [signInOpen, setSignInOpen] = useState(false);
  const [signInEmail, setSignInEmail] = useState("");
  const [signInPassword, setSignInPassword] = useState("");
  const [signInNewPassword, setSignInNewPassword] = useState("");
  const [signInConfirmPassword, setSignInConfirmPassword] = useState("");
  const [signInChallenge, setSignInChallenge] = useState<{ session: string } | null>(null);
  const [signInError, setSignInError] = useState<string | null>(null);
  const [signInLoading, setSignInLoading] = useState(false);

  // Poll every 2s while any daemon is starting
  const anyDaemonLoading = Object.values(daemonLoading).some(Boolean);
  useEffect(() => {
    if (!anyDaemonLoading) return;
    const timer = setInterval(() => setRefreshKey((k) => k + 1), 2000);
    return () => clearInterval(timer);
  }, [anyDaemonLoading]);

  // Clear loading state once each daemon is confirmed online
  useEffect(() => {
    if (daemonLoading["data-server"] && localOnline === true) {
      setDaemonLoading((l) => ({ ...l, "data-server": false }));
    }
  }, [localOnline]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (daemonLoading["photos-web"] && localPhotosWeb === true) {
      setDaemonLoading((l) => ({ ...l, "photos-web": false }));
    }
  }, [localPhotosWeb]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (daemonLoading["file-browser"] && localFileBrowser === true) {
      setDaemonLoading((l) => ({ ...l, "file-browser": false }));
    }
  }, [localFileBrowser]); // eslint-disable-line react-hooks/exhaustive-deps

  async function startDaemon(id: string) {
    setDaemonLoading((l) => ({ ...l, [id]: true }));
    try {
      await fetch("/api/exec/daemon", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start", id }),
      });
    } catch {
      setDaemonLoading((l) => ({ ...l, [id]: false }));
      return;
    }
    // Safety timeout: clear loading after 90s regardless
    setTimeout(() => {
      setDaemonLoading((l) => ({ ...l, [id]: false }));
      setRefreshKey((k) => k + 1);
    }, 90_000);
  }

  async function stopDaemon(id: string) {
    setDaemonLoading((l) => ({ ...l, [id]: true }));
    try {
      await fetch("/api/exec/daemon", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop", id }),
      });
      setRefreshKey((k) => k + 1);
    } finally {
      setDaemonLoading((l) => ({ ...l, [id]: false }));
    }
  }

  async function runStream(commandId: string, title: string, requiresCreds: boolean) {
    let credentials: (STSCredentials & { region: string }) | undefined;
    if (requiresCreds) {
      const cfg = await readCloudConfig();
      if (!cfg) return;
      let stored = await readCloudCredentials();
      if (!stored) {
        try {
          const tokens = await refreshTokens(cfg.cognitoConfig, cfg.cognitoRefreshToken);
          stored = await getIdentityPoolCredentials(cfg.cognitoConfig, tokens.idToken);
          await writeCloudCredentials(stored);
        } catch {
          return;
        }
      }
      credentials = { ...stored, region: cfg.cognitoConfig.region };
    }
    setOutputModal({ commandId, title, credentials });
    setOutputOpen(true);
  }

  function openConfirm(commandId: string, title: string, message: string, requiresCreds: boolean) {
    setConfirmModal({ commandId, title, message, requiresCreds });
  }

  // Fetch local server data
  useEffect(() => {
    setLocalOnline(null);
    setLocalTypes(null);
    setPhotosWebUrl(undefined);
    setWatches(null);

    const controller = new AbortController();

    async function fetchLocal() {
      try {
        const [typesResp, watchesResp, configResp, authStatusResp] = await Promise.all([
          fetch("http://127.0.0.1:9820/data/types", { signal: controller.signal }),
          fetch("http://127.0.0.1:9820/watches", { signal: controller.signal }),
          fetch("http://127.0.0.1:9820/config", { signal: controller.signal }),
          fetch("http://127.0.0.1:9820/auth/status", { signal: controller.signal }),
        ]);

        if (typesResp.ok) {
          setLocalTypes(await typesResp.json());
          setLocalOnline(true);
        } else {
          setLocalOnline(false);
        }
        if (watchesResp.ok) setWatches((await watchesResp.json()).watches);
        if (configResp.ok) {
          const cfg = await configResp.json();
          setPhotosWebUrl((cfg.photosWebUrl as string | null) ?? null);
          if (cfg.cognitoConfig) setLocalCognitoConfig(cfg.cognitoConfig as CognitoConfig);
        } else {
          setPhotosWebUrl(null);
        }
        if (authStatusResp.ok) {
          const status = await authStatusResp.json();
          setLocalAuthAuthenticated(status.authenticated as boolean);
        }
      } catch {
        if (!controller.signal.aborted) {
          setLocalOnline(false);
          setPhotosWebUrl(null);
        }
      }
    }

    fetchLocal();
    return () => controller.abort();
  }, [refreshKey]);

  // Fetch local app status
  useEffect(() => {
    setLocalPhotosWeb(null);
    setLocalFileBrowser(null);
    checkUrl("http://localhost:3000").then(setLocalPhotosWeb);
    checkUrl("http://localhost:5173").then(setLocalFileBrowser);
  }, [refreshKey]);

  // Read cloud config from localStorage
  useEffect(() => {
    readCloudConfig().then(setCloudConfig);
  }, [refreshKey]);

  // If cloudConfig is absent, try to reconstruct it from PARTIAL_SETUP_KEY + local data-server
  useEffect(() => {
    if (cloudConfig !== null) return;

    async function tryRecover() {
      const saved = localStorage.getItem("starkeep-partial-setup");
      if (!saved) return;
      let partial: {
        userPoolId?: string; userPoolClientId?: string; identityPoolId?: string;
        region?: string; refreshToken?: string; stackPrefix?: string;
      };
      try { partial = JSON.parse(saved); } catch { return; }

      const { userPoolId, userPoolClientId, identityPoolId, region: r, refreshToken: rt, stackPrefix: sp } = partial;
      if (!userPoolId || !userPoolClientId || !identityPoolId || !rt) return;

      const cognitoConfig: CognitoConfig = {
        userPoolId, userPoolClientId, identityPoolId, region: r || "us-east-1",
      };

      try {
        const [tokens, serverData] = await Promise.all([
          refreshTokens(cognitoConfig, rt),
          fetch("http://127.0.0.1:9820/config", { signal: AbortSignal.timeout(2000) })
            .then((res) => (res.ok ? res.json() : null))
            .catch(() => null),
        ]);

        if (!serverData?.s3Bucket || !serverData.s3Region || !serverData.auroraEndpoint) return;

        const creds = await getIdentityPoolCredentials(cognitoConfig, tokens.idToken);
        const config: CloudConfig = {
          stackPrefix: sp || "starkeep",
          s3Bucket: serverData.s3Bucket,
          s3Region: serverData.s3Region,
          auroraEndpoint: serverData.auroraEndpoint,
          apiGatewayUrl: serverData.apiGatewayUrl ?? undefined,
          cognitoConfig,
          cognitoRefreshToken: tokens.refreshToken,
        };
        await writeCloudConfig(config);
        await writeCloudCredentials(creds);
        localStorage.removeItem("starkeep-partial-setup");
        setCloudConfig(config);
      } catch {
        // Recovery failed — ModeSelector stays visible
      }
    }

    tryRecover();
  }, [cloudConfig]);

  // Fetch remote server data
  useEffect(() => {
    setRemoteOnline(null);
    setRemoteTypes(null);

    async function fetchRemote() {
      const cfg = await readCloudConfig();
      if (!cfg?.apiGatewayUrl || !cfg.cognitoRefreshToken) return;

      try {
        const tokens = await refreshTokens(cfg.cognitoConfig, cfg.cognitoRefreshToken);
        const resp = await fetch(`${cfg.apiGatewayUrl}/data/types`, {
          signal: AbortSignal.timeout(8000),
          headers: { Authorization: `Bearer ${tokens.accessToken}` },
        });
        if (resp.ok) {
          setRemoteTypes(await resp.json());
          setRemoteOnline(true);
        } else {
          setRemoteOnline(false);
        }
      } catch {
        setRemoteOnline(false);
      }
    }

    fetchRemote();
  }, [refreshKey]);

  // Check remote photos-web once we have the URL
  useEffect(() => {
    setRemotePhotosWeb(null);
    if (photosWebUrl === undefined || photosWebUrl === null) return;
    checkUrl(photosWebUrl).then(setRemotePhotosWeb);
  }, [photosWebUrl, refreshKey]);

  // Fetch cost data and budget status
  useEffect(() => {
    setCosts("loading");
    setCostProjection(null);

    async function fetchCosts() {
      const cfg = await readCloudConfig();
      if (!cfg) { setCosts("error"); return; }

      let creds: STSCredentials | null = await readCloudCredentials();
      if (!creds || credentialsNearExpiry(creds)) {
        try {
          const tokens = await refreshTokens(cfg.cognitoConfig, cfg.cognitoRefreshToken);
          creds = await getIdentityPoolCredentials(cfg.cognitoConfig, tokens.idToken);
          await writeCloudCredentials(creds);
        } catch {
          setCosts("error");
          return;
        }
      }

      try {
        const resp = await fetch("/api/costs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            credentials: creds,
            s3Region: cfg.s3Region,
            stackPrefix: cfg.stackPrefix,
          }),
        });
        if (!resp.ok) {
          const body = await resp.json().catch(() => ({})) as { error?: string };
          console.error("[costs] API error", resp.status, body.error);
          setCosts("error");
          return;
        }
        const { costs: mtd } = await resp.json() as { costs: ServiceCost[] | null };
        if (mtd === null) {
          setCosts("no-data");
        } else {
          setCosts(mtd);
          setCostProjection(projectFullMonth(mtd));
        }
      } catch (err) {
        console.error("[costs] fetch error", err);
        setCosts("error");
      }
    }

    fetchCosts();
  }, [refreshKey]);

  // ---- Sign-in handlers ----

  async function handleSignIn() {
    const cognitoConfig = localCognitoConfig ?? cloudConfig?.cognitoConfig;
    if (!cognitoConfig) return;
    setSignInLoading(true);
    setSignInError(null);
    try {
      const result = await initiateAuth(cognitoConfig, signInEmail, signInPassword);
      if (result.tokens) {
        const email = extractEmail(result.tokens.idToken);
        await fetch("http://127.0.0.1:9820/auth/tokens", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ idToken: result.tokens.idToken, refreshToken: result.tokens.refreshToken }),
        });
        if (cloudConfig) {
          await writeCloudConfig({
            ...cloudConfig,
            cognitoConfig,
            cognitoRefreshToken: result.tokens.refreshToken,
            userEmail: email ?? undefined,
          });
        }
        setSignInOpen(false);
        setRefreshKey((k) => k + 1);
      } else if (result.challengeName === "NEW_PASSWORD_REQUIRED" && result.session) {
        setSignInChallenge({ session: result.session });
      } else {
        setSignInError("Unexpected response from Cognito");
      }
    } catch (err) {
      setSignInError(err instanceof Error ? err.message : "Sign in failed");
    } finally {
      setSignInLoading(false);
    }
  }

  async function handleNewPassword() {
    const cognitoConfig = localCognitoConfig ?? cloudConfig?.cognitoConfig;
    if (!cognitoConfig || !signInChallenge) return;
    if (signInNewPassword !== signInConfirmPassword) {
      setSignInError("Passwords do not match");
      return;
    }
    setSignInLoading(true);
    setSignInError(null);
    try {
      const tokens = await respondNewPasswordChallenge(
        cognitoConfig,
        signInChallenge.session,
        signInEmail,
        signInNewPassword,
      );
      const email = extractEmail(tokens.idToken);
      await fetch("http://127.0.0.1:9820/auth/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken: tokens.idToken, refreshToken: tokens.refreshToken }),
      });
      if (cloudConfig) {
        await writeCloudConfig({
          ...cloudConfig,
          cognitoConfig,
          cognitoRefreshToken: tokens.refreshToken,
          userEmail: email ?? undefined,
        });
      }
      setSignInOpen(false);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      setSignInError(err instanceof Error ? err.message : "Failed to set new password");
    } finally {
      setSignInLoading(false);
    }
  }

  function openSignIn() {
    setSignInEmail("");
    setSignInPassword("");
    setSignInNewPassword("");
    setSignInConfirmPassword("");
    setSignInChallenge(null);
    setSignInError(null);
    setSignInOpen(true);
  }

  // ---- Watch handlers ----

  async function handleAddWatch() {
    const path = watchPath.trim();
    if (!path) return;
    setWatchError(null);
    setWatchSuccess(null);

    const expanded = path.startsWith("~/") ? path.replace("~", "") : path;
    const duplicate = watches?.some(
      (w) => w.directoryPath === path || w.directoryPath.endsWith(expanded)
    );
    if (duplicate) {
      setWatchError("A watch for this directory already exists.");
      return;
    }

    setWatchSubmitting(true);
    try {
      const resp = await fetch("http://127.0.0.1:9820/watches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ directoryPath: path, targetType: "@starkeep/image", recursive: true }),
      });
      const data = await resp.json();
      if (resp.ok) {
        setWatchPath("");
        setWatchSuccess(`Watch started: ${data.watch?.directoryPath ?? path}`);
        const wResp = await fetch("http://127.0.0.1:9820/watches");
        if (wResp.ok) setWatches((await wResp.json()).watches);
      } else {
        setWatchError(data.error ?? "Failed to add watch.");
      }
    } catch {
      setWatchError("Could not reach the data server.");
    } finally {
      setWatchSubmitting(false);
    }
  }

  async function handleRemoveWatch(id: string) {
    try {
      await fetch(`http://127.0.0.1:9820/watches/${id}`, { method: "DELETE" });
      setWatches((ws) => ws?.filter((w) => w.id !== id) ?? null);
    } catch {
      // server offline
    }
  }

  const signedIn = localAuthAuthenticated ?? false;
  const authStale = signedIn && cloudConfig != null && !cloudConfig.userEmail;

  async function handleSignOut() {
    await fetch("http://127.0.0.1:9820/auth/logout", { method: "POST" }).catch(() => {});
    setRefreshKey((k) => k + 1);
  }

  return (
    <Container size="xl">
      <Group justify="space-between" mb="xl">
        <Title order={1}>Dashboard</Title>
        <Button variant="light" onClick={() => setRefreshKey((k) => k + 1)}>
          Refresh
        </Button>
      </Group>

      <SimpleGrid cols={{ base: 1, xl: 2 }} spacing="xl" style={{ alignItems: "start" }}>
        {/* ── LOCAL ───────────────────────────────────────────────────── */}
        <Stack gap="md">
          <Title order={2}>Local</Title>

          <Paper p="lg" withBorder>
        <Group justify="space-between" mb="sm">
          <Title order={3} size="h4">
            Data Server
          </Title>
          <StatusBadge online={localOnline} />
        </Group>

        {localOnline === false && (
          <Stack gap="md">
            <Alert color="yellow" variant="light" title="Data server not running">
              The local data server must be running for local features to work.
            </Alert>
            <Group justify="flex-end">
              <Button
                variant="light"
                color="green"
                loading={!!daemonLoading["data-server"]}
                onClick={() => startDaemon("data-server")}
              >
                Start
              </Button>
            </Group>
          </Stack>
        )}

        {localOnline === true && localTypes && (
          <Stack gap="sm">
            <Text
              size="sm"
              style={{ cursor: "pointer", textDecoration: "underline dotted" }}
              onClick={() => setTypesExpanded((e) => !e)}
            >
              {localTypes.types.length} type{localTypes.types.length !== 1 ? "s" : ""} registered
              &nbsp;·&nbsp;
              {localTypes.total} record{localTypes.total !== 1 ? "s" : ""} total
            </Text>

            <Collapse in={typesExpanded}>
              <Stack gap={4} pl="sm" pt="xs">
                {localTypes.types.length === 0 ? (
                  <Text size="xs" c="dimmed">
                    No records yet
                  </Text>
                ) : (
                  localTypes.types.map((t) => (
                    <Group key={t.record_type} justify="space-between">
                      <Code fz="xs">{t.record_type}</Code>
                      <Badge variant="light" size="sm">
                        {t.count}
                      </Badge>
                    </Group>
                  ))
                )}
              </Stack>
            </Collapse>

            <Divider my="xs" label="Watches" labelPosition="left" />

            {watches && watches.length > 0 ? (
              <Stack gap="xs">
                {watches.map((w) => (
                  <Group key={w.id} justify="space-between" wrap="nowrap">
                    <Group gap="xs" style={{ minWidth: 0, flex: 1 }}>
                      <Text
                        size="sm"
                        style={{
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          flex: 1,
                        }}
                      >
                        {w.directoryPath}
                      </Text>
                      <Badge variant="outline" size="xs" color="gray">
                        {w.targetType}
                      </Badge>
                    </Group>
                    <Button
                      size="xs"
                      variant="subtle"
                      color="red"
                      onClick={() => handleRemoveWatch(w.id)}
                    >
                      Remove
                    </Button>
                  </Group>
                ))}
              </Stack>
            ) : (
              <Text size="sm" c="dimmed">
                No watches configured
              </Text>
            )}

            <Group gap="xs" mt="xs">
              <TextInput
                placeholder="/path/to/directory or ~/Photos"
                size="xs"
                value={watchPath}
                onChange={(e) => { setWatchPath(e.currentTarget.value); setWatchError(null); setWatchSuccess(null); }}
                onKeyDown={(e) => { if (e.key === "Enter") handleAddWatch(); }}
                style={{ flex: 1 }}
                error={!!watchError}
              />
              <Button
                size="xs"
                onClick={handleAddWatch}
                loading={watchSubmitting}
                disabled={!watchPath.trim()}
              >
                Add watch
              </Button>
            </Group>
            {watchError && <Text size="xs" c="red">{watchError}</Text>}
            {watchSuccess && <Text size="xs" c="green">{watchSuccess}</Text>}
          </Stack>
        )}

      </Paper>

        <Group justify="flex-end">
          <Button
            size="xs"
            variant="light"
            color="red"
            onClick={() => openConfirm("reset-local-data", "Clear local data", "This will permanently delete all local object files, the SQLite database, and watch configs.", false)}
          >
            Clear local data
          </Button>
        </Group>

          {localOnline !== false && (
          <Paper p="lg" withBorder>
            <Title order={3} size="h4" mb="sm">
              Apps
            </Title>
            <Stack gap="sm">
              <LocalAppRow
                name="Photos Web"
                online={localPhotosWeb}
                url="http://localhost:3000"
                loading={!!daemonLoading["photos-web"]}
                onStart={() => startDaemon("photos-web")}
                onStop={() => stopDaemon("photos-web")}
              />
              <LocalAppRow
                name="File Browser"
                online={localFileBrowser}
                url="http://localhost:5173"
                loading={!!daemonLoading["file-browser"]}
                onStart={() => startDaemon("file-browser")}
                onStop={() => stopDaemon("file-browser")}
              />
            </Stack>
          </Paper>
          )}
        </Stack>

        {/* ── REMOTE ──────────────────────────────────────────────────── */}
        <Stack gap="md">
          <Title order={2}>Remote</Title>

          {cloudConfig === undefined ? (
            <Center><Loader size="sm" /></Center>
          ) : cloudConfig === null ? (
            <Paper p="xl" withBorder>
              <ModeSelector onSelect={(mode) => router.push(`/cloud-setup?mode=${mode}`)} />
            </Paper>
          ) : (
            <>
              <Paper p="lg" withBorder>
                <Group justify="space-between" mb="sm">
                  <Title order={3} size="h4">
                    Data Server
                  </Title>
                  {cloudConfig.apiGatewayUrl ? (
                    <StatusBadge online={remoteOnline} />
                  ) : (
                    <Badge color="gray" variant="light">
                      Not configured
                    </Badge>
                  )}
                </Group>

                {!cloudConfig.apiGatewayUrl ? (
                  <Text size="sm" c="dimmed">
                    Complete cloud setup to enable remote features.
                  </Text>
                ) : (
                  <Stack gap="sm">
                    {remoteOnline === true && remoteTypes && (
                      <>
                        <Text
                          size="sm"
                          style={{ cursor: "pointer", textDecoration: "underline dotted" }}
                          onClick={() => setRemoteTypesExpanded((e) => !e)}
                        >
                          {remoteTypes.types.length} type{remoteTypes.types.length !== 1 ? "s" : ""} registered
                          &nbsp;·&nbsp;
                          {remoteTypes.total} record{remoteTypes.total !== 1 ? "s" : ""} total
                        </Text>
                        <Collapse in={remoteTypesExpanded}>
                          <Stack gap={4} pl="sm" pt="xs">
                            {remoteTypes.types.length === 0 ? (
                              <Text size="xs" c="dimmed">
                                No records yet
                              </Text>
                            ) : (
                              remoteTypes.types.map((t) => (
                                <Group key={t.record_type} justify="space-between">
                                  <Code fz="xs">{t.record_type}</Code>
                                  <Badge variant="light" size="sm">
                                    {t.count}
                                  </Badge>
                                </Group>
                              ))
                            )}
                          </Stack>
                        </Collapse>
                      </>
                    )}
                    <Group gap="md" wrap="wrap">
                      <Button
                        size="xs"
                        variant="light"
                        onClick={() => openConfirm("local-deploy", "Redeploy from local", "This will run sst deploy using your current local code. The process may take several minutes.", true)}
                      >
                        Redeploy from local
                      </Button>
                      <Button
                        size="xs"
                        variant="light"
                        color="red"
                        onClick={() => openConfirm("reset-cloud-data", "Clear all cloud data", "This will permanently delete all files from S3 and all records from the Aurora DSQL database.", true)}
                      >
                        Clear all cloud data
                      </Button>
                    </Group>
                  </Stack>
                )}
              </Paper>

              <Paper p="lg" withBorder>
                <Title order={3} size="h4" mb="sm">
                  Apps
                </Title>
                <Stack gap="sm">
                  <RemoteAppRow
                    name="Photos Web"
                    url={localOnline !== null ? (photosWebUrl ?? null) : undefined}
                    online={remotePhotosWeb}
                  />
                  <RemoteAppRow name="File Browser" url={null} online={null} />
                </Stack>
              </Paper>

              <Paper p="lg" withBorder>
                <Stack gap="sm">
                  <Group justify="space-between">
                    <Title order={3} size="h4">
                      Authentication
                    </Title>
                    {signedIn ? (
                      <Group gap="xs">
                        <Badge color={authStale ? "yellow" : "green"} variant="light">
                          {authStale ? "Stale session" : "Signed in"}
                        </Badge>
                        {cloudConfig.userEmail && (
                          <Text size="sm" c="dimmed">
                            {cloudConfig.userEmail}
                          </Text>
                        )}
                        <Button size="xs" variant="subtle" color="red" onClick={handleSignOut}>
                          Sign out
                        </Button>
                      </Group>
                    ) : (
                      <Group gap="xs">
                        <Badge color="gray" variant="light">
                          Not signed in
                        </Badge>
                        {(localCognitoConfig ?? cloudConfig.cognitoConfig) && (
                          <Button size="xs" onClick={openSignIn}>
                            Sign in
                          </Button>
                        )}
                      </Group>
                    )}
                  </Group>
                  {authStale && (
                    <Alert color="yellow" title="Auth config may be invalid">
                      The local data server has a stored session but no confirmed username — this
                      can happen after recreating the bootstrap stack. Sign out to clear the stale
                      session, then sign in again.
                    </Alert>
                  )}
                </Stack>
              </Paper>

              <Paper p="lg" withBorder>
                <Title order={3} size="h4" mb="sm">Costs</Title>

                {costs === "loading" ? (
                  <Center py="sm"><Loader size="sm" /></Center>
                ) : costs === "error" ? (
                  <Text size="sm" c="dimmed">Could not load cost data.</Text>
                ) : costs === "no-data" ? (
                  <Text size="sm" c="dimmed">Cost report configured — data arrives within 24 hours.</Text>
                ) : (
                  <Table fz="sm">
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>Service</Table.Th>
                        <Table.Th style={{ textAlign: "right" }}>Month-to-date</Table.Th>
                        <Table.Th style={{ textAlign: "right" }}>Projected</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {costs.map((row) => {
                        const proj = costProjection?.find((p) => p.service === row.service);
                        return (
                          <Table.Tr key={row.service}>
                            <Table.Td>{row.service}</Table.Td>
                            <Table.Td style={{ textAlign: "right" }}>${row.amount.toFixed(2)}</Table.Td>
                            <Table.Td style={{ textAlign: "right" }} c="dimmed">${(proj?.amount ?? 0).toFixed(2)}</Table.Td>
                          </Table.Tr>
                        );
                      })}
                      <Table.Tr fw={600}>
                        <Table.Td>Total</Table.Td>
                        <Table.Td style={{ textAlign: "right" }}>${costs.reduce((s, r) => s + r.amount, 0).toFixed(2)}</Table.Td>
                        <Table.Td style={{ textAlign: "right" }} c="dimmed">${(costProjection ?? []).reduce((s, r) => s + r.amount, 0).toFixed(2)}</Table.Td>
                      </Table.Tr>
                    </Table.Tbody>
                  </Table>
                )}
              </Paper>
            </>
          )}
        </Stack>
      </SimpleGrid>

      {/* ── Sign-in modal ─────────────────────────────────────────────── */}
      <Modal
        opened={signInOpen}
        onClose={() => {
          setSignInOpen(false);
          setSignInChallenge(null);
        }}
        title="Sign in to cloud"
        size="sm"
      >
        {!signInChallenge ? (
          <Stack gap="sm">
            <TextInput
              label="Email"
              value={signInEmail}
              onChange={(e) => setSignInEmail(e.currentTarget.value)}
              disabled={signInLoading}
            />
            <PasswordInput
              label="Password"
              value={signInPassword}
              onChange={(e) => setSignInPassword(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSignIn();
              }}
              disabled={signInLoading}
            />
            {signInError && (
              <Alert color="red" title="Error">
                {signInError}
              </Alert>
            )}
            <Button onClick={handleSignIn} loading={signInLoading} fullWidth>
              Sign in
            </Button>
          </Stack>
        ) : (
          <Stack gap="sm">
            <Text size="sm">This account requires a new permanent password.</Text>
            <PasswordInput
              label="New password"
              value={signInNewPassword}
              onChange={(e) => setSignInNewPassword(e.currentTarget.value)}
              disabled={signInLoading}
            />
            <PasswordInput
              label="Confirm new password"
              value={signInConfirmPassword}
              onChange={(e) => setSignInConfirmPassword(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleNewPassword();
              }}
              disabled={signInLoading}
            />
            {signInError && (
              <Alert color="red" title="Error">
                {signInError}
              </Alert>
            )}
            <Button onClick={handleNewPassword} loading={signInLoading} fullWidth>
              Set password & sign in
            </Button>
          </Stack>
        )}
      </Modal>

      {/* ── Command output modal ──────────────────────────────────────── */}
      <CommandOutputModal
        opened={outputOpen}
        onClose={() => { setOutputOpen(false); setOutputModal(null); }}
        commandId={outputModal?.commandId ?? null}
        credentials={outputModal?.credentials}
        title={outputModal?.title ?? ""}
      />

      {/* ── Confirm modal ─────────────────────────────────────────────── */}
      <Modal
        opened={confirmModal !== null}
        onClose={() => setConfirmModal(null)}
        title={confirmModal?.title ?? ""}
        size="sm"
      >
        <Stack gap="md">
          <Text size="sm">{confirmModal?.message}</Text>
          <Group justify="flex-end">
            <Button variant="light" onClick={() => setConfirmModal(null)}>Cancel</Button>
            <Button
              color="red"
              onClick={() => {
                const m = confirmModal;
                setConfirmModal(null);
                if (m) runStream(m.commandId, m.title, m.requiresCreds);
              }}
            >
              Confirm
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Container>
  );
}

// ---------------------------------------------------------------------------
// Shared sub-components
// ---------------------------------------------------------------------------

function StatusBadge({ online }: { online: boolean | null }) {
  if (online === null) return <Loader size="xs" />;
  return (
    <Badge color={online ? "green" : "red"} variant="light">
      {online ? "Online" : "Offline"}
    </Badge>
  );
}

function LocalAppRow({
  name,
  online,
  url,
  loading,
  onStart,
  onStop,
}: {
  name: string;
  online: boolean | null;
  url: string;
  loading: boolean;
  onStart: () => void;
  onStop: () => void;
}) {
  return (
    <Group justify="space-between">
      <Group gap="xs">
        <Text size="sm" fw={500}>
          {name}
        </Text>
        <StatusBadge online={online} />
      </Group>
      <Group gap="xs">
        {online === true && (
          <Anchor href={url} target="_blank" size="sm">
            Open ↗
          </Anchor>
        )}
        {online === true && (
          <Button size="xs" variant="subtle" color="red" loading={loading} onClick={onStop}>
            Stop
          </Button>
        )}
        {online === false && (
          <Button size="xs" variant="light" color="green" loading={loading} onClick={onStart}>
            Start
          </Button>
        )}
      </Group>
    </Group>
  );
}

function RemoteAppRow({
  name,
  url,
  online,
}: {
  name: string;
  url: string | null | undefined;
  online: boolean | null;
}) {
  return (
    <Group justify="space-between">
      <Group gap="xs">
        <Text size="sm" fw={500}>
          {name}
        </Text>
        {url === undefined ? (
          <Loader size="xs" />
        ) : url === null ? (
          <Badge color="gray" variant="light" size="sm">
            Not deployed
          </Badge>
        ) : online === null ? (
          <Loader size="xs" />
        ) : (
          <Badge color={online ? "green" : "red"} variant="light" size="sm">
            {online ? "Online" : "Offline"}
          </Badge>
        )}
      </Group>
      {url !== null && url !== undefined && online === true && (
        <Anchor href={url} target="_blank" size="sm">
          Open ↗
        </Anchor>
      )}
    </Group>
  );
}
