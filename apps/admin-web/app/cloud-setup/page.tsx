"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Container,
  Title,
  Text,
  Button,
  Stepper,
  Stack,
  Alert,
  TextInput,
  PasswordInput,
  Group,
  Paper,
  Code,
  Loader,
  Badge,
} from "@mantine/core";
import {
  getBootstrapStackOutputsUrl,
  generateBootstrapTemplate,
  getCloudFormationCreateStackUrl,
} from "@starkeep/admin-core";
import {
  writeCloudConfig,
  writeCloudCredentials,
  type CloudConfig,
} from "../../src/lib/cloud-config";
import {
  initiateAuth,
  respondNewPasswordChallenge,
  refreshTokens,
  getIdentityPoolCredentials,
  type CognitoConfig,
  type STSCredentials,
} from "../../src/lib/cognito-auth";
import { ModeSelector, type SetupMode } from "../../src/components/mode-selector";
import {
  CloudDataServerInstallModal,
  type CloudDataServerInstallOutputs,
} from "../../src/components/CloudDataServerInstallModal";

function openUrl(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
}


function Step2Outputs({
  onNext,
  onBack,
  region,
  stackPrefix,
  cognitoConfig,
  setCognitoConfig,
}: {
  onNext: () => void;
  onBack: () => void;
  region: string;
  stackPrefix: string;
  cognitoConfig: Partial<CognitoConfig>;
  setCognitoConfig: (v: Partial<CognitoConfig>) => void;
}) {
  const stackName = `${stackPrefix}-bootstrap`;

  const update = (key: keyof CognitoConfig, value: string) =>
    setCognitoConfig({ ...cognitoConfig, [key]: value });

  const isComplete =
    !!cognitoConfig.userPoolId &&
    !!cognitoConfig.userPoolClientId &&
    !!cognitoConfig.identityPoolId;

  return (
    <Stack gap="md">
      <Text>
        Open the CloudFormation stack <strong>Outputs</strong> tab and copy the three values below.
      </Text>

      <Button
        variant="light"
        size="sm"
        onClick={() => openUrl(getBootstrapStackOutputsUrl(region, stackName))}
      >
        Open stack outputs in AWS console
      </Button>

      <TextInput
        label="UserPoolId"
        description="Format: us-east-1_Xxxxxxxxx"
        placeholder={`${region}_Xxxxxxxxx`}
        value={cognitoConfig.userPoolId ?? ""}
        onChange={(e) => update("userPoolId", e.currentTarget.value.trim())}
      />

      <TextInput
        label="UserPoolClientId"
        description="32-character alphanumeric string"
        placeholder="3abc4defghij5klmnopq6rstuv"
        value={cognitoConfig.userPoolClientId ?? ""}
        onChange={(e) => update("userPoolClientId", e.currentTarget.value.trim())}
      />

      <TextInput
        label="IdentityPoolId"
        description="Format: us-east-1:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
        placeholder={`${region}:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`}
        value={cognitoConfig.identityPoolId ?? ""}
        onChange={(e) => update("identityPoolId", e.currentTarget.value.trim())}
      />

      <Alert color="blue" title="One-time setup">
        These values are the same across all your devices. After completing setup on this device,
        use <strong>Settings → Export Cloud Config</strong> to share the configuration with other
        devices — they will skip this step and go straight to sign in.
      </Alert>

      <Group justify="space-between" mt="md">
        <Button variant="subtle" onClick={onBack}>
          Back
        </Button>
        <Button onClick={onNext} disabled={!isComplete}>
          Continue
        </Button>
      </Group>
    </Stack>
  );
}

function Step3CreateAccount({
  onNext,
  onBack,
  cognitoConfig,
  region,
}: {
  onNext: () => void;
  onBack: () => void;
  cognitoConfig: Partial<CognitoConfig>;
  region: string;
}) {
  const consoleLink = cognitoConfig.userPoolId
    ? `https://${region}.console.aws.amazon.com/cognito/v2/idp/user-pools/${cognitoConfig.userPoolId}/users/create`
    : null;

  return (
    <Stack gap="md">
      <Text>
        Your Cognito user pool has been created, but it has no users yet. You need to create your
        account before you can sign in.
      </Text>

      <Paper p="md" withBorder>
        <Stack gap="sm">
          <Text fw={500}>Create your account in the AWS console</Text>
          <Text size="sm" c="dimmed">
            1. Click the button below to open the Cognito console.
            <br />
            2. Click <strong>Create user</strong>.
            <br />
            3. Enter your email address. Cognito will send a temporary password to that address.
            <br />
            4. Return here once you have received the email.
          </Text>
          {consoleLink ? (
            <Button variant="light" onClick={() => openUrl(consoleLink)}>
              Open Cognito Users console
            </Button>
          ) : (
            <Alert color="yellow">UserPoolId not set — go back and enter outputs.</Alert>
          )}
        </Stack>
      </Paper>

      <Group justify="space-between" mt="md">
        <Button variant="subtle" onClick={onBack}>
          Back
        </Button>
        <Button onClick={onNext}>I have received the temporary password</Button>
      </Group>
    </Stack>
  );
}

function Step4SignIn({
  onSuccess,
  onBack,
  cognitoConfig,
}: {
  onSuccess: (tokens: { idToken: string; refreshToken: string }) => void;
  onBack: () => void;
  cognitoConfig: CognitoConfig;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newPasswordConfirm, setNewPasswordConfirm] = useState("");
  const [session, setSession] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSignIn = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await initiateAuth(cognitoConfig, email, password);
      if (result.tokens) {
        onSuccess({ idToken: result.tokens.idToken, refreshToken: result.tokens.refreshToken });
      } else if (result.challengeName === "NEW_PASSWORD_REQUIRED") {
        setSession(result.session ?? null);
      } else {
        setError(`Unexpected challenge: ${result.challengeName}`);
      }
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setLoading(false);
    }
  };

  const handleSetNewPassword = async () => {
    if (newPassword !== newPasswordConfirm) {
      setError("Passwords do not match");
      return;
    }
    if (!session) {
      setError("Session expired — please sign in again");
      setSession(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const tokens = await respondNewPasswordChallenge(cognitoConfig, session, email, newPassword);
      onSuccess({ idToken: tokens.idToken, refreshToken: tokens.refreshToken });
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Stack gap="md">
      {!session ? (
        <>
          <Text>Sign in with your email and the temporary password from Cognito.</Text>
          {error && <Alert color="red" title="Sign in failed">{error}</Alert>}
          <TextInput
            label="Email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.currentTarget.value)}
          />
          <PasswordInput
            label="Temporary password"
            description="From the email Cognito sent when you created your account"
            value={password}
            onChange={(e) => setPassword(e.currentTarget.value)}
          />
          <Group justify="space-between" mt="md">
            <Button variant="subtle" onClick={onBack}>
              Back
            </Button>
            <Button loading={loading} disabled={!email || !password} onClick={handleSignIn}>
              Sign in
            </Button>
          </Group>
        </>
      ) : (
        <>
          <Text>Your temporary password has expired. Please set a new permanent password.</Text>
          {error && <Alert color="red" title="Error">{error}</Alert>}
          <PasswordInput
            label="New password"
            description="At least 8 characters"
            value={newPassword}
            onChange={(e) => setNewPassword(e.currentTarget.value)}
          />
          <PasswordInput
            label="Confirm new password"
            value={newPasswordConfirm}
            onChange={(e) => setNewPasswordConfirm(e.currentTarget.value)}
          />
          <Group justify="space-between" mt="md">
            <Button variant="subtle" onClick={() => setSession(null)}>
              Back
            </Button>
            <Button
              loading={loading}
              disabled={!newPassword || newPassword.length < 8}
              onClick={handleSetNewPassword}
            >
              Set password and sign in
            </Button>
          </Group>
        </>
      )}
    </Stack>
  );
}

interface DeployOutputs {
  s3Bucket: string;
  s3Region: string;
  auroraEndpoint: string;
  apiGatewayUrl?: string;
}

function downloadCliConfig(config: {
  region: string;
  stage: string;
  userPoolId: string;
  userPoolClientId: string;
  identityPoolId: string;
  s3Bucket?: string;
  s3Region?: string;
  auroraEndpoint?: string;
  apiGatewayUrl?: string;
}) {
  const json = JSON.stringify(config, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "starkeep-config.json";
  a.click();
  URL.revokeObjectURL(url);
}

function Step5DeployInfra({
  onSuccess,
  onBack,
  cognitoConfig,
  stackPrefix,
  region,
  credentials,
}: {
  onSuccess: (result: DeployOutputs) => void;
  onBack: () => void;
  cognitoConfig: CognitoConfig;
  stackPrefix: string;
  region: string;
  credentials: STSCredentials;
}) {
  const [showManualEntry, setShowManualEntry] = useState(false);
  const [deployResult, setDeployResult] = useState<DeployOutputs | null>(null);
  const [manualBucket, setManualBucket] = useState("");
  const [manualAurora, setManualAurora] = useState("");
  const [manualApi, setManualApi] = useState("");
  const [readConfigError, setReadConfigError] = useState<string | null>(null);
  const [readingConfig, setReadingConfig] = useState(false);
  const [installModalOpen, setInstallModalOpen] = useState(false);

  const handleManualSubmit = () => {
    if (!manualBucket || !manualAurora) return;
    setDeployResult({
      s3Bucket: manualBucket.trim(),
      s3Region: region,
      auroraEndpoint: manualAurora.trim(),
      apiGatewayUrl: manualApi.trim() || undefined,
    });
  };

  const handleReadFromConfig = async () => {
    setReadingConfig(true);
    setReadConfigError(null);
    try {
      const res = await fetch("/api/exec/deploy-outputs");
      const data = (await res.json()) as {
        s3Bucket?: string;
        s3Region?: string;
        auroraEndpoint?: string;
        apiGatewayUrl?: string;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "Failed to read deploy outputs");
      onSuccess({
        s3Bucket: data.s3Bucket!,
        s3Region: data.s3Region ?? region,
        auroraEndpoint: data.auroraEndpoint!,
        apiGatewayUrl: data.apiGatewayUrl,
      });
    } catch (err) {
      setReadConfigError(err instanceof Error ? err.message : String(err));
    } finally {
      setReadingConfig(false);
    }
  };

  const handleInstallSuccess = (outputs: CloudDataServerInstallOutputs) => {
    // Don't auto-close: keep the modal open so the user can scroll the
    // install log. Stash the outputs and let them click Continue on the
    // success card that renders when deployResult is set.
    setInstallModalOpen(false);
    setDeployResult({
      s3Bucket: outputs.bucketName,
      s3Region: outputs.region,
      auroraEndpoint: outputs.auroraHostname,
      apiGatewayUrl: outputs.apiGatewayUrl,
    });
  };

  if (deployResult) {
    return (
      <Stack gap="md">
        <Alert color="green" title="Install complete">
          cloud-data-server is installed in your AWS account.
        </Alert>
        <Text size="sm">
          To re-run the install (or future updates) from your local machine, download your CLI
          config and place it in the repo root, then run{" "}
          <Code>pnpm --filter @starkeep/admin-installer cli:install-cloud-data-server</Code>. The
          install is idempotent — safe to re-run.
        </Text>
        <Button
          variant="light"
          onClick={() =>
            downloadCliConfig({
              region,
              stage: stackPrefix,
              userPoolId: cognitoConfig.userPoolId,
              userPoolClientId: cognitoConfig.userPoolClientId,
              identityPoolId: cognitoConfig.identityPoolId,
              s3Bucket: deployResult.s3Bucket,
              s3Region: deployResult.s3Region,
              auroraEndpoint: deployResult.auroraEndpoint,
              apiGatewayUrl: deployResult.apiGatewayUrl,
            })
          }
        >
          Download CLI config (starkeep-config.json)
        </Button>
        <Group justify="flex-end" mt="md">
          <Button onClick={() => onSuccess(deployResult)}>Continue</Button>
        </Group>
      </Stack>
    );
  }

  if (showManualEntry) {
    return (
      <Stack gap="md">
        <Text fw={500}>Enter deployment outputs manually</Text>
        <Text size="sm" c="dimmed">
          Find these values in the AWS console — the infrastructure was deployed successfully.
        </Text>
        <TextInput
          label="S3 Bucket Name"
          description="S3 console → find the bucket starting with your stack prefix (e.g. starkeep-files-...)"
          placeholder="starkeep-files-starkeep-abc123"
          value={manualBucket}
          onChange={(e) => setManualBucket(e.currentTarget.value)}
          required
        />
        <TextInput
          label="Aurora DSQL Hostname"
          description="Aurora DSQL console → your cluster → copy the endpoint hostname"
          placeholder="abc123.dsql.us-east-1.on.aws"
          value={manualAurora}
          onChange={(e) => setManualAurora(e.currentTarget.value)}
          required
        />
        <TextInput
          label="API Gateway URL (optional)"
          description="API Gateway console → your API → copy the invoke URL"
          placeholder="https://abc123.execute-api.us-east-1.amazonaws.com"
          value={manualApi}
          onChange={(e) => setManualApi(e.currentTarget.value)}
        />
        <Group justify="space-between" mt="md">
          <Button variant="subtle" onClick={() => setShowManualEntry(false)}>
            Back
          </Button>
          <Button onClick={handleManualSubmit} disabled={!manualBucket || !manualAurora}>
            Continue
          </Button>
        </Group>
      </Stack>
    );
  }

  return (
    <Stack gap="md">
      <Text>
        Install the <strong>cloud-data-server</strong> built-in app. This is the cloud-side
        broker — Manager mints its IAM role, attaches a temporary install policy, runs Pulumi to
        provision the resources, applies any new shared-schema migrations, and detaches the
        temporary policy. Resources created:
      </Text>
      <Stack gap="xs" pl="md">
        <Text size="sm">• Aurora DSQL cluster for shared metadata</Text>
        <Text size="sm">• S3 bucket for file storage</Text>
        <Text size="sm">• Lambda function (the protocol-core broker) + API Gateway with Cognito JWT authorizer</Text>
        <Text size="sm">• Shared-schema migrations applied under the installer PG role</Text>
      </Stack>

      <Button variant="filled" onClick={() => setInstallModalOpen(true)}>
        Install cloud-data-server
      </Button>
      <Text size="sm" c="dimmed">
        The install runs in this Next.js process — output streams here. Re-running is safe; existence
        checks and Pulumi handle idempotency, and previously-applied migrations are skipped.
      </Text>

      {readConfigError && (
        <Alert color="red" title="Could not read config">
          {readConfigError}
        </Alert>
      )}

      <Group justify="flex-end">
        <Button variant="subtle" loading={readingConfig} onClick={handleReadFromConfig}>
          Already installed
        </Button>
        <Button variant="subtle" onClick={() => setShowManualEntry(true)}>
          Enter outputs manually
        </Button>
      </Group>

      <CloudDataServerInstallModal
        opened={installModalOpen}
        onClose={() => setInstallModalOpen(false)}
        credentials={installModalOpen ? credentials : null}
        onSuccess={handleInstallSuccess}
      />

      <Group justify="space-between" mt="md">
        <Button variant="subtle" onClick={onBack}>
          Back
        </Button>
      </Group>
    </Stack>
  );
}

function BootstrapStep({
  region,
  onRegionChange,
  stackPrefix,
  onStackPrefixChange,
  onContinue,
  onBack,
}: {
  region: string;
  onRegionChange: (v: string) => void;
  stackPrefix: string;
  onStackPrefixChange: (v: string) => void;
  onContinue: () => void;
  onBack: () => void;
}) {
  const [downloaded, setDownloaded] = useState(false);

  const handleDownload = () => {
    const yaml = generateBootstrapTemplate({ stackPrefix });
    const blob = new Blob([yaml], { type: "text/yaml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "starkeep-bootstrap-template.yaml";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setDownloaded(true);
  };

  return (
    <Stack gap="md">
      <Text>
        Deploy the Starkeep bootstrap CloudFormation stack. This creates Cognito authentication,
        IAM roles, and S3/Pulumi infrastructure in your AWS account.
      </Text>

      <TextInput
        label="AWS Region"
        description="The AWS region where your Starkeep infrastructure will be deployed."
        placeholder="us-east-1"
        value={region}
        onChange={(e) => onRegionChange(e.currentTarget.value)}
      />

      <TextInput
        label="Stack prefix"
        description="A short name used to prefix all Starkeep resources. Lowercase letters, numbers, and hyphens only."
        placeholder="starkeep"
        value={stackPrefix}
        onChange={(e) => onStackPrefixChange(e.currentTarget.value.toLowerCase())}
      />

      <Paper p="md" withBorder>
        <Stack gap="sm">
          <Text fw={500}>Step 1 — Download the bootstrap template</Text>
          <Text size="sm" c="dimmed">
            This generates a CloudFormation YAML template and downloads it to your browser.
          </Text>
          <Button
            variant="light"
            onClick={handleDownload}
            disabled={!stackPrefix || !region}
          >
            Download bootstrap template
          </Button>
          {downloaded && (
            <Text size="sm" c="green">
              Downloaded: <Code>starkeep-bootstrap-template.yaml</Code>
            </Text>
          )}
        </Stack>
      </Paper>

      <Paper p="md" withBorder>
        <Stack gap="sm">
          <Text fw={500}>Step 2 — Deploy the stack in AWS CloudFormation</Text>
          <Text size="sm" c="dimmed">
            In the CloudFormation console, choose <strong>Upload a template file</strong> and upload
            the file above. Name the stack{" "}
            <Code>{stackPrefix ? `${stackPrefix}-bootstrap` : "starkeep-bootstrap"}</Code> and leave{" "}
            <strong>StackPrefix</strong> as <Code>{stackPrefix || "starkeep"}</Code>. Wait for the
            stack to reach <strong>CREATE_COMPLETE</strong> status.
          </Text>
          <Button
            variant="light"
            onClick={() => openUrl(getCloudFormationCreateStackUrl(region))}
            disabled={!region}
          >
            Open CloudFormation console ({region || "select region first"})
          </Button>
        </Stack>
      </Paper>

      <Alert color="blue" variant="light">
        Once the stack reaches <strong>CREATE_COMPLETE</strong>, click Continue to enter the stack
        outputs and finish setting up your account.
      </Alert>

      <Group justify="space-between" mt="md">
        <Button variant="subtle" onClick={onBack}>
          Back
        </Button>
        <Button onClick={onContinue} disabled={!region || !stackPrefix}>
          Stack is deployed — Continue
        </Button>
      </Group>
    </Stack>
  );
}

const PARTIAL_SETUP_KEY = "starkeep-partial-setup";

function CloudSetupPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [mode, setMode] = useState<SetupMode | null>(null);
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [skipCreateAccount, setSkipCreateAccount] = useState(false);

  const [region, setRegion] = useState("us-east-1");
  const [stackPrefix, setStackPrefix] = useState("starkeep");
  const [cognitoConfig, setCognitoConfig] = useState<Partial<CognitoConfig>>({});
  const [signInResult, setSignInResult] = useState<{
    idToken: string;
    refreshToken: string;
  } | null>(null);
  const [credentials, setCredentials] = useState<STSCredentials | null>(null);
  const [resuming, setResuming] = useState(false);
  const [localConfigPrefilled, setLocalConfigPrefilled] = useState(false);

  // Best-effort: pre-fill Cognito config from the local data-server if it's running
  useEffect(() => {
    fetch("http://127.0.0.1:9820/config", { signal: AbortSignal.timeout(2000) })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { cognitoConfig?: { userPoolId?: string; userPoolClientId?: string; identityPoolId?: string; region?: string } } | null) => {
        const c = data?.cognitoConfig;
        if (c?.userPoolId && c.userPoolClientId && c.identityPoolId) {
          if (c.region) setRegion(c.region);
          setCognitoConfig({ userPoolId: c.userPoolId, userPoolClientId: c.userPoolClientId, identityPoolId: c.identityPoolId });
          setLocalConfigPrefilled(true);
        }
      })
      .catch(() => {});
  }, []);

  // Auto-advance past the outputs step once prefill resolves (handles URL-params navigation
  // where mode is set before the fetch above completes)
  useEffect(() => {
    if (!localConfigPrefilled || mode === null || active !== 0) return;
    setActive(skipCreateAccount ? 2 : 1);
  }, [localConfigPrefilled]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const saved = localStorage.getItem(PARTIAL_SETUP_KEY);
    if (!saved) return;
    try {
      const { region: r, stackPrefix: sp, refreshToken: rt, ...cog } = JSON.parse(saved);
      if (r) setRegion(r);
      if (sp) setStackPrefix(sp);
      const hasCognitoConfig = !!(cog.userPoolId && cog.userPoolClientId && cog.identityPoolId);
      if (hasCognitoConfig) setCognitoConfig(cog);

      if (rt && hasCognitoConfig) {
        const resumeConfig: CognitoConfig = {
          userPoolId: cog.userPoolId,
          userPoolClientId: cog.userPoolClientId,
          identityPoolId: cog.identityPoolId,
          region: r || "us-east-1",
        };
        setResuming(true);
        refreshTokens(resumeConfig, rt)
          .then(async (tokens) => {
            const creds = await getIdentityPoolCredentials(resumeConfig, tokens.idToken);

            // If the local data-server has the full deployment outputs, reconstruct
            // CloudConfig and complete setup without manual input.
            try {
              const serverResp = await fetch("http://127.0.0.1:9820/config", {
                signal: AbortSignal.timeout(2000),
              });
              if (serverResp.ok) {
                const serverData = await serverResp.json();
                if (serverData.s3Bucket && serverData.s3Region && serverData.auroraEndpoint) {
                  const config: CloudConfig = {
                    stackPrefix: sp || "starkeep",
                    s3Bucket: serverData.s3Bucket,
                    s3Region: serverData.s3Region,
                    auroraEndpoint: serverData.auroraEndpoint,
                    apiGatewayUrl: serverData.apiGatewayUrl ?? undefined,
                    cognitoConfig: resumeConfig,
                    cognitoRefreshToken: tokens.refreshToken,
                  };
                  await writeCloudConfig(config);
                  await writeCloudCredentials(creds);
                  localStorage.removeItem(PARTIAL_SETUP_KEY);
                  router.push("/");
                  return;
                }
              }
            } catch {
              // Local server unavailable — fall through to deploy step
            }

            setSignInResult({ idToken: tokens.idToken, refreshToken: tokens.refreshToken });
            setCredentials(creds);
            setMode("signin");
            setSkipCreateAccount(true);
            setActive(3);
          })
          .catch(() => {
            // Token expired or invalid — fall through to ModeSelector
          })
          .finally(() => setResuming(false));
      }
    } catch {
      /* ignore malformed */
    }
  }, []);

  useEffect(() => {
    if (mode === null) return;
    // Preserve any stored refreshToken when updating other partial setup fields
    const existing = (() => {
      try { return JSON.parse(localStorage.getItem(PARTIAL_SETUP_KEY) ?? "{}"); }
      catch { return {}; }
    })();
    localStorage.setItem(
      PARTIAL_SETUP_KEY,
      JSON.stringify({ ...existing, region, stackPrefix, ...cognitoConfig }),
    );
  }, [mode, region, stackPrefix, cognitoConfig]);

  useEffect(() => {
    const urlMode = searchParams.get("mode") as SetupMode | null;
    const urlRegion = searchParams.get("region");
    const urlStackPrefix = searchParams.get("stackPrefix");
    if (!urlMode && !urlRegion && !urlStackPrefix) return;
    if (urlRegion) setRegion(urlRegion);
    if (urlStackPrefix) setStackPrefix(urlStackPrefix);
    if (urlMode) handleSelectMode(urlMode);
    window.history.replaceState({}, "", "/cloud-setup");
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const fullCognitoConfig = (): CognitoConfig => ({
    userPoolId: cognitoConfig.userPoolId ?? "",
    userPoolClientId: cognitoConfig.userPoolClientId ?? "",
    identityPoolId: cognitoConfig.identityPoolId ?? "",
    region,
  });

  const handleSelectMode = (selectedMode: SetupMode) => {
    setMode(selectedMode);
    if (selectedMode === "fresh") {
      setActive(0);
      setSkipCreateAccount(false);
    } else if (selectedMode === "resume") {
      setActive(localConfigPrefilled ? 1 : 0);
      setSkipCreateAccount(false);
    } else if (selectedMode === "signin") {
      setActive(localConfigPrefilled ? 2 : 0);
      setSkipCreateAccount(true);
    }
  };

  const handleSignInSuccess = async (tokens: { idToken: string; refreshToken: string }) => {
    setSignInResult(tokens);
    setError(null);
    try {
      const creds = await getIdentityPoolCredentials(fullCognitoConfig(), tokens.idToken);
      setCredentials(creds);
      // Persist refresh token so the session can be resumed after a page reload
      localStorage.setItem(
        PARTIAL_SETUP_KEY,
        JSON.stringify({ region, stackPrefix, ...cognitoConfig, refreshToken: tokens.refreshToken }),
      );
      setActive(3);
    } catch (err) {
      setError(
        `Failed to get AWS credentials: ${String(err instanceof Error ? err.message : err)}`,
      );
    }
  };

  const handleDeploySuccess = async (result: DeployOutputs) => {
    if (!signInResult || !credentials) {
      setError("Session expired — please sign in again.");
      setActive(2);
      return;
    }
    try {
      const config: CloudConfig = {
        stackPrefix,
        s3Bucket: result.s3Bucket,
        s3Region: result.s3Region,
        auroraEndpoint: result.auroraEndpoint,
        apiGatewayUrl: result.apiGatewayUrl,
        cognitoConfig: fullCognitoConfig(),
        cognitoRefreshToken: signInResult.refreshToken,
      };
      await writeCloudConfig(config);
      await writeCloudCredentials(credentials);
      // Push deploy outputs to the local data-server so starkeep-config.json is updated on disk.
      // Best-effort: if the local server isn't running this is a no-op.
      await fetch("http://127.0.0.1:9820/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          s3Bucket: result.s3Bucket,
          s3Region: result.s3Region,
          auroraEndpoint: result.auroraEndpoint,
          ...(result.apiGatewayUrl ? { apiGatewayUrl: result.apiGatewayUrl } : {}),
        }),
      }).catch(() => {});
      localStorage.removeItem(PARTIAL_SETUP_KEY);
      router.push("/");
    } catch (err) {
      setError(
        `Failed to save cloud config: ${String(err instanceof Error ? err.message : err)}`,
      );
    }
  };

  if (resuming) {
    return (
      <Container size="sm" py="xl">
        <Group mb="lg" justify="space-between">
          <Title order={2}>Starkeep Cloud Admin</Title>
        </Group>
        <Paper p="xl" withBorder>
          <Group gap="sm">
            <Loader size="sm" />
            <Text size="sm" c="dimmed">Resuming session…</Text>
          </Group>
        </Paper>
      </Container>
    );
  }

  if (mode === null) {
    return (
      <Container size="sm" py="xl">
        <Group mb="lg" justify="space-between">
          <Title order={2}>Starkeep Cloud Admin</Title>
        </Group>
        <Paper p="xl" withBorder>
          <ModeSelector onSelect={handleSelectMode} />
        </Paper>
      </Container>
    );
  }

  if (mode === "fresh") {
    return (
      <Container size="sm" py="xl">
        <Group mb="lg" justify="space-between">
          <Title order={2}>Starkeep Cloud Admin</Title>
          <Badge variant="light" color="teal">Deploy bootstrap</Badge>
        </Group>
        <Paper p="xl" withBorder>
          <BootstrapStep
            region={region}
            onRegionChange={setRegion}
            stackPrefix={stackPrefix}
            onStackPrefixChange={setStackPrefix}
            onContinue={() => {
              setMode("resume");
              setActive(0);
              setSkipCreateAccount(false);
            }}
            onBack={() => setMode(null)}
          />
        </Paper>
      </Container>
    );
  }

  const stepTitles = [
    "Stack outputs",
    "Create account",
    "Sign in",
    "Install cloud-data-server",
  ];

  return (
    <Container size="sm" py="xl">
      <Group mb="lg" justify="space-between">
        <Title order={2}>Starkeep Cloud Admin</Title>
        <Badge variant="light" color="blue">
          {mode === "signin" ? "Existing account" : "Resume setup"}
        </Badge>
      </Group>

      {error && <Alert color="red" mb="md">{error}</Alert>}

      <Stepper active={active} orientation="vertical" mb="xl">
        {stepTitles.map((title, i) => (
          <Stepper.Step key={i} label={title} />
        ))}
      </Stepper>

      <Paper p="xl" withBorder>
        {active === 0 && (
          <Step2Outputs
            onNext={() => {
              setCognitoConfig({ ...cognitoConfig, region });
              setActive(skipCreateAccount ? 2 : 1);
            }}
            onBack={() => setMode(null)}
            region={region}
            stackPrefix={stackPrefix}
            cognitoConfig={cognitoConfig}
            setCognitoConfig={setCognitoConfig}
          />
        )}
        {active === 1 && (
          <Step3CreateAccount
            onNext={() => setActive(2)}
            onBack={() => setActive(0)}
            cognitoConfig={{ ...cognitoConfig, region }}
            region={region}
          />
        )}
        {active === 2 && (
          <Step4SignIn
            onSuccess={handleSignInSuccess}
            onBack={() => setActive(skipCreateAccount ? 0 : 1)}
            cognitoConfig={fullCognitoConfig()}
          />
        )}
        {active === 3 && credentials && signInResult && (
          <Step5DeployInfra
            onSuccess={handleDeploySuccess}
            onBack={() => setActive(2)}
            cognitoConfig={fullCognitoConfig()}
            stackPrefix={stackPrefix}
            region={region}
            credentials={credentials}
          />
        )}
      </Paper>
    </Container>
  );
}

export default function CloudSetupPageWrapper() {
  return (
    <Suspense>
      <CloudSetupPage />
    </Suspense>
  );
}
