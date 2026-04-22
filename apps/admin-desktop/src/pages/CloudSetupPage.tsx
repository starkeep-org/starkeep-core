import { useState, useCallback, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
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
  Anchor,
  Divider,
  Loader,
  Badge,
  Collapse,
} from "@mantine/core";
import { open as tauriShellOpen } from "@tauri-apps/plugin-shell";
import { invoke } from "@tauri-apps/api/core";
import {
  generateSelfHostedBootstrapTemplate,
  getCloudFormationCreateStackUrl,
  getBootstrapStackOutputsUrl,
} from "@starkeep/admin-core";
import {
  isTauri,
  writeBootstrapTemplate,
  writeCloudConfig,
  writeCloudCredentials,
  type CloudConfig,
} from "../lib/cloud-config";
import {
  initiateAuth,
  respondNewPasswordChallenge,
  getIdentityPoolCredentials,
  type CognitoConfig,
  type STSCredentials,
} from "../lib/cognito-auth";

// ---------------------------------------------------------------------------
/**
 * Parse SST v4 deploy output into a key/value map.
 * Handles both "key: value" and "key   value" formats, and strips ANSI codes.
 */
function parseSstOutputs(raw: string): Record<string, string> {
  const clean = raw.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
  const result: Record<string, string> = {};

  // Try "  key: value" (colon separator)
  for (const m of clean.matchAll(/^\s+(\w+):\s+(.+?)\s*$/gm)) {
    if (m[1] && m[2]) result[m[1]] = m[2].trim();
  }

  // Fallback: "  key   value" (2+ space separator, no colon)
  if (!result["bucketName"] && !result["auroraHostname"]) {
    for (const m of clean.matchAll(/^\s+(\w+)\s{2,}(.+?)\s*$/gm)) {
      if (m[1] && m[2]) result[m[1]] = m[2].trim();
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
/** Opens a URL in the system browser (Tauri) or a new tab (web). */
function openUrl(url: string) {
  if (isTauri()) {
    tauriShellOpen(url);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

// ---------------------------------------------------------------------------
// Mode selector — shown before the wizard starts
// ---------------------------------------------------------------------------
type SetupMode = "fresh" | "resume" | "signin";

function ModeSelector({
  onSelect,
}: {
  onSelect: (mode: SetupMode) => void;
}) {
  const [showClearPanel, setShowClearPanel] = useState(false);
  const [clearRegion, setClearRegion] = useState("us-east-1");
  const [clearPrefix, setClearPrefix] = useState("starkeep");

  return (
    <Stack gap="lg">
      <Text>
        Starkeep Cloud runs entirely on <strong>your own AWS account</strong> — your data never
        leaves infrastructure you control.
      </Text>

      <Stack gap="sm">
        <Paper p="md" withBorder style={{ cursor: "pointer" }} onClick={() => onSelect("fresh")}>
          <Stack gap="xs">
            <Text fw={600}>Set up Starkeep Cloud</Text>
            <Text size="sm" c="dimmed">
              First-time setup. You'll deploy a CloudFormation stack and create your account.
              You'll need an AWS account —{" "}
              <Anchor size="sm" onClick={(e) => { e.stopPropagation(); openUrl("https://aws.amazon.com/free"); }}>
                create a free one here
              </Anchor>.
            </Text>
          </Stack>
        </Paper>

        <Paper p="md" withBorder style={{ cursor: "pointer" }} onClick={() => onSelect("resume")}>
          <Stack gap="xs">
            <Text fw={600}>Resume partial setup</Text>
            <Text size="sm" c="dimmed">
              You've already deployed the bootstrap CloudFormation stack but haven't finished
              setting up your account or data infrastructure.
            </Text>
          </Stack>
        </Paper>

        <Paper p="md" withBorder style={{ cursor: "pointer" }} onClick={() => onSelect("signin")}>
          <Stack gap="xs">
            <Text fw={600}>Sign in to existing account</Text>
            <Text size="sm" c="dimmed">
              You've already created your account. Sign in and finish setting up, or connect a new device.
            </Text>
          </Stack>
        </Paper>
      </Stack>

      <Divider />

      <Anchor
        size="sm"
        c="dimmed"
        onClick={() => setShowClearPanel((v) => !v)}
        style={{ cursor: "pointer" }}
      >
        Start over — clear existing bootstrap
      </Anchor>

      <Collapse in={showClearPanel}>
        <Paper p="md" withBorder>
          <Stack gap="sm">
            <Text fw={500} c="red">Clear your existing bootstrap stack</Text>
            <Text size="sm" c="dimmed">
              Use this if you want to wipe your existing Starkeep bootstrap and start fresh.
              This must be done manually in the AWS console — follow the steps below.
            </Text>

            <Group grow>
              <TextInput
                label="AWS Region"
                value={clearRegion}
                onChange={(e) => setClearRegion(e.currentTarget.value)}
                placeholder="us-east-1"
                size="sm"
              />
              <TextInput
                label="Stack prefix"
                value={clearPrefix}
                onChange={(e) => setClearPrefix(e.currentTarget.value.toLowerCase())}
                placeholder="starkeep"
                size="sm"
              />
            </Group>

            <Text size="sm">
              <strong>Steps to delete your bootstrap:</strong>
            </Text>
            <Stack gap={4} pl="md">
              <Text size="sm">1. Open the AWS CloudFormation console (button below).</Text>
              <Text size="sm">
                2. Find the stack named <Code>{clearPrefix}-bootstrap</Code>, select it, and choose{" "}
                <strong>Delete</strong>. Wait for deletion to complete (1–2 minutes).
              </Text>
              <Text size="sm">
                3. Delete the S3 bucket named <Code>{clearPrefix}-deploy-artifacts</Code> — CloudFormation
                cannot delete non-empty buckets, so empty and delete it manually from the S3 console.
              </Text>
              <Text size="sm">
                4. Return here and choose <strong>Set up Starkeep Cloud</strong> to start fresh.
              </Text>
            </Stack>

            <Button
              variant="light"
              color="red"
              size="sm"
              onClick={() =>
                openUrl(
                  `https://${clearRegion}.console.aws.amazon.com/cloudformation/home?region=${clearRegion}#/stacks`
                )
              }
              disabled={!clearRegion}
            >
              Open CloudFormation console ({clearRegion || "select region"})
            </Button>
          </Stack>
        </Paper>
      </Collapse>
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Step 1 — Bootstrap AWS
// ---------------------------------------------------------------------------
function Step1Bootstrap({
  onNext,
  onBack,
  region,
  setRegion,
  stackPrefix,
  setStackPrefix,
}: {
  onNext: () => void;
  onBack: () => void;
  region: string;
  setRegion: (v: string) => void;
  stackPrefix: string;
  setStackPrefix: (v: string) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // TODO: Replace this save-template + manual-upload flow with a CloudFormation Quick Create link
  // using generateQuickCreateLink() from packages/admin-core/src/quick-create.ts.
  // Quick Create requires the template to be hosted at a publicly accessible S3 URL (not a local
  // file). Implement once the static bootstrap template is uploaded to the admin S3 artifacts
  // bucket and its public URL is known. (~80 words)
  const handleSaveTemplate = async () => {
    setSaving(true);
    setError(null);
    try {
      const yaml = generateSelfHostedBootstrapTemplate({ stackPrefix });
      if (isTauri()) {
        const path = await writeBootstrapTemplate(yaml);
        setSavedPath(path);
      } else {
        const blob = new Blob([yaml], { type: "text/yaml" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "starkeep-bootstrap-template.yaml";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        setSavedPath("starkeep-bootstrap-template.yaml (downloaded)");
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleOpenConsole = () => {
    openUrl(getCloudFormationCreateStackUrl(region));
  };

  return (
    <Stack gap="md">
      <Text>
        We will create a CloudFormation stack in your AWS account that sets up Cognito
        authentication and the IAM permissions admin-desktop needs to deploy your data
        infrastructure.
      </Text>

      <TextInput
        label="AWS Region"
        description="The AWS region where your Starkeep infrastructure will be deployed."
        placeholder="us-east-1"
        value={region}
        onChange={(e) => setRegion(e.currentTarget.value)}
      />

      <TextInput
        label="Stack prefix"
        description="A short name used to prefix all Starkeep resources (e.g. 'starkeep'). Lowercase letters, numbers, and hyphens only."
        placeholder="starkeep"
        value={stackPrefix}
        onChange={(e) => setStackPrefix(e.currentTarget.value.toLowerCase())}
      />

      {error && <Alert color="red" title="Error">{error}</Alert>}

      <Paper p="md" withBorder>
        <Stack gap="sm">
          <Text fw={500}>Step 1 — Save the bootstrap template</Text>
          <Text size="sm" c="dimmed">
            This generates a CloudFormation template file. In the desktop app it is saved to{" "}
            <Code>~/.starkeep/bootstrap-template.yaml</Code>; in a browser it will be downloaded
            directly.
          </Text>
          <Button
            variant="light"
            loading={saving}
            onClick={handleSaveTemplate}
            disabled={!stackPrefix || !region}
          >
            Save bootstrap template
          </Button>
          {savedPath && (
            <Text size="sm" c="green">
              Saved to: <Code>{savedPath}</Code>
            </Text>
          )}
        </Stack>
      </Paper>

      <Paper p="md" withBorder>
        <Stack gap="sm">
          <Text fw={500}>Step 2 — Open the AWS CloudFormation console</Text>
          <Text size="sm" c="dimmed">
            In the CloudFormation console, choose <strong>Upload a template file</strong> and
            upload the file you saved above. Name the stack{" "}
            <Code>{stackPrefix ? `${stackPrefix}-bootstrap` : "starkeep-bootstrap"}</Code> and
            leave <strong>StackPrefix</strong> as{" "}
            <Code>{stackPrefix || "starkeep"}</Code>.
          </Text>
          <Button variant="light" onClick={handleOpenConsole} disabled={!region}>
            Open CloudFormation console ({region || "select region first"})
          </Button>
        </Stack>
      </Paper>

      <Text size="sm" c="dimmed">
        After the stack reaches <strong>CREATE_COMPLETE</strong> status, click Continue.
        Already deployed this bootstrap stack previously? Click Continue.
      </Text>

      <Group justify="space-between" mt="md">
        <Button variant="subtle" onClick={onBack}>Back</Button>
        <Button onClick={onNext} disabled={!region || !stackPrefix}>
          Stack is deployed — Continue
        </Button>
      </Group>
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — Enter stack outputs (manual copy-paste from CloudFormation console)
// ---------------------------------------------------------------------------

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
        Open the CloudFormation stack <strong>Outputs</strong> tab and copy the three values
        below.
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
        <Button variant="subtle" onClick={onBack}>Back</Button>
        <Button onClick={onNext} disabled={!isComplete}>
          Continue
        </Button>
      </Group>
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Step 3 — Create Cognito account (manual via AWS console)
// ---------------------------------------------------------------------------

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
        Your Cognito user pool has been created, but it has no users yet. You need to create
        your account before you can sign in.
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
        <Button variant="subtle" onClick={onBack}>Back</Button>
        <Button onClick={onNext}>I have received the temporary password</Button>
      </Group>
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Step 4 — Sign in with Cognito
// ---------------------------------------------------------------------------
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
      const tokens = await respondNewPasswordChallenge(
        cognitoConfig,
        session,
        email,
        newPassword
      );
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
            <Button variant="subtle" onClick={onBack}>Back</Button>
            <Button
              loading={loading}
              disabled={!email || !password}
              onClick={handleSignIn}
            >
              Sign in
            </Button>
          </Group>
        </>
      ) : (
        <>
          <Text>
            Your temporary password has expired. Please set a new permanent password.
          </Text>
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
            <Button variant="subtle" onClick={() => setSession(null)}>Back</Button>
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

// ---------------------------------------------------------------------------
// Step 5 — Deploy data infrastructure via CodeBuild
// ---------------------------------------------------------------------------

interface DeployOutputs {
  s3Bucket: string;
  s3Region: string;
  auroraEndpoint: string;
  apiGatewayUrl?: string;
}

const POLL_INTERVAL_MS = 5000;

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
  const [deploying, setDeploying] = useState(false);
  const [phase, setPhase] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [showManualEntry, setShowManualEntry] = useState(false);
  const [manualBucket, setManualBucket] = useState("");
  const [manualAurora, setManualAurora] = useState("");
  const [manualApi, setManualApi] = useState("");
  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [phase]);

  const handleDeploy = useCallback(async () => {
    setDeploying(true);
    setError(null);
    setPhase("Preparing deployment…");

    try {
      const awsCreds = {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        sessionToken: credentials.sessionToken,
      };

      const { CodeBuildClient, StartBuildCommand, BatchGetBuildsCommand } = await import("@aws-sdk/client-codebuild");

      const cb = new CodeBuildClient({ region, credentials: awsCreds });

      const artifactsBucket = `${stackPrefix}-deploy-artifacts`;
      const sourceKey = `${stackPrefix}-user-data-source.zip`;
      const outputsKey = `${stackPrefix}-outputs.json`;

      const s3Creds = {
        accessKeyId: awsCreds.accessKeyId,
        secretAccessKey: awsCreds.secretAccessKey,
        sessionToken: awsCreds.sessionToken ?? "",
      };

      setPhase("Uploading deployment source to S3…");
      const zipResponse = await fetch("/user-data-source.zip");
      if (!zipResponse.ok) throw new Error("Could not load user-data-source.zip — run pnpm build:artifact first");
      const zipBytes = await zipResponse.arrayBuffer();
      // Encode to base64 in chunks to avoid call-stack limits on large files
      const zipArray = new Uint8Array(zipBytes);
      let binary = "";
      const chunkSize = 8192;
      for (let i = 0; i < zipArray.length; i += chunkSize) {
        binary += String.fromCharCode(...zipArray.subarray(i, i + chunkSize));
      }
      const bodyBase64 = btoa(binary);
      await invoke("s3_put_object", {
        bucket: artifactsBucket,
        key: sourceKey,
        bodyBase64,
        contentType: "application/zip",
        credentials: s3Creds,
        region,
      });

      setPhase("Starting CodeBuild deployment…");
      const startResult = await cb.send(new StartBuildCommand({
        projectName: `${stackPrefix}-deploy`,
        environmentVariablesOverride: [
          { name: "STAGE", value: stackPrefix, type: "PLAINTEXT" },
          { name: "USER_POOL_ID", value: cognitoConfig.userPoolId, type: "PLAINTEXT" },
          { name: "USER_POOL_CLIENT_ID", value: cognitoConfig.userPoolClientId, type: "PLAINTEXT" },
        ],
      }));

      const buildId = startResult.build?.id;
      if (!buildId) throw new Error("CodeBuild did not return a build ID");

      let buildStatus = "IN_PROGRESS";
      while (buildStatus === "IN_PROGRESS") {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        const pollResult = await cb.send(new BatchGetBuildsCommand({ ids: [buildId] }));
        const build = pollResult.builds?.[0];
        if (!build) throw new Error("Could not retrieve build status");

        buildStatus = build.buildStatus ?? "IN_PROGRESS";
        const currentPhase = build.currentPhase ?? "";
        setPhase(`CodeBuild: ${currentPhase} (${buildStatus === "IN_PROGRESS" ? "running" : buildStatus})`);
      }

      if (buildStatus !== "SUCCEEDED") {
        throw new Error(`CodeBuild deployment ${buildStatus.toLowerCase()}. Check the AWS CodeBuild console for details.`);
      }

      setPhase("Reading deployment outputs…");
      const rawOutput = await invoke<string>("s3_get_object_text", {
        bucket: artifactsBucket,
        key: `${stackPrefix}-raw-output.txt`,
        credentials: s3Creds,
        region,
      });

      const outputs = parseSstOutputs(rawOutput);
      const bucketName = outputs["bucketName"];
      const auroraHostname = outputs["auroraHostname"];
      const apiGatewayUrl = outputs["apiGatewayUrl"];

      if (!bucketName || !auroraHostname) {
        throw new Error(
          "Deployment outputs missing expected values.\n\n" +
          `Parsed: ${JSON.stringify(outputs)}\n\n` +
          `Raw output (last 2000 chars):\n${rawOutput.slice(-2000)}`
        );
      }

      onSuccess({
        s3Bucket: bucketName,
        s3Region: region,
        auroraEndpoint: auroraHostname,
        apiGatewayUrl,
      });
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setDeploying(false);
    }
  }, [credentials, region, stackPrefix, cognitoConfig, onSuccess]);

  const handleManualSubmit = () => {
    if (!manualBucket || !manualAurora) return;
    onSuccess({
      s3Bucket: manualBucket.trim(),
      s3Region: region,
      auroraEndpoint: manualAurora.trim(),
      apiGatewayUrl: manualApi.trim() || undefined,
    });
  };

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
          <Button variant="subtle" onClick={() => setShowManualEntry(false)}>Back</Button>
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
        We will now deploy your Starkeep data infrastructure via AWS CodeBuild. This creates:
      </Text>
      <Stack gap="xs" pl="md">
        <Text size="sm">• S3 bucket for file storage</Text>
        <Text size="sm">• Aurora DSQL cluster for remote metadata index</Text>
        <Text size="sm">• Lambda function + API Gateway for data access</Text>
      </Stack>
      <Text size="sm" c="dimmed">
        The deployment runs in your AWS account via CodeBuild and takes 5–10 minutes.
        Aurora DSQL clusters take 2–5 minutes to become active.
      </Text>

      {error && (
        <Alert color="red" title="Deployment failed">
          {error}
        </Alert>
      )}

      <Text size="sm" c="dimmed">
        If you already deployed successfully or want to enter values from the AWS console,{" "}
        <Anchor size="sm" onClick={() => setShowManualEntry(true)}>
          enter the outputs manually
        </Anchor>.
      </Text>

      {deploying && phase && (
        <Paper withBorder p="sm">
          <Group gap="sm">
            <Loader size="xs" />
            <Text size="sm" c="dimmed">{phase}</Text>
          </Group>
          <div ref={logsEndRef} />
        </Paper>
      )}

      <Group justify="space-between" mt="md">
        <Button variant="subtle" onClick={onBack} disabled={deploying}>Back</Button>
        <Button
          loading={deploying}
          onClick={handleDeploy}
          disabled={deploying}
        >
          {deploying ? "Deploying…" : "Deploy data infrastructure"}
        </Button>
      </Group>
    </Stack>
  );
}


// ---------------------------------------------------------------------------
// Main wizard
// ---------------------------------------------------------------------------
const PARTIAL_SETUP_KEY = "starkeep-partial-setup";

export function CloudSetupPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<SetupMode | null>(null);
  // active step index within the wizard (0=Bootstrap, 1=Outputs, 2=CreateAccount, 3=SignIn, 4=Deploy)
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [skipCreateAccount, setSkipCreateAccount] = useState(false);

  // Collected across steps
  const [region, setRegion] = useState("us-east-1");
  const [stackPrefix, setStackPrefix] = useState("starkeep");
  const [cognitoConfig, setCognitoConfig] = useState<Partial<CognitoConfig>>({});
  const [signInResult, setSignInResult] = useState<{ idToken: string; refreshToken: string } | null>(null);
  const [credentials, setCredentials] = useState<STSCredentials | null>(null);

  // Load partial setup state from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem(PARTIAL_SETUP_KEY);
    if (!saved) return;
    try {
      const { region: r, stackPrefix: sp, ...cog } = JSON.parse(saved);
      if (r) setRegion(r);
      if (sp) setStackPrefix(sp);
      if (cog.userPoolId || cog.userPoolClientId || cog.identityPoolId) {
        setCognitoConfig(cog);
      }
    } catch { /* ignore malformed */ }
  }, []);

  // Persist partial setup state to localStorage whenever fields change (after mode is selected)
  useEffect(() => {
    if (mode === null) return;
    localStorage.setItem(PARTIAL_SETUP_KEY, JSON.stringify({
      region,
      stackPrefix,
      ...cognitoConfig,
    }));
  }, [mode, region, stackPrefix, cognitoConfig]);

  const fullCognitoConfig = (): CognitoConfig => ({
    userPoolId: cognitoConfig.userPoolId ?? "",
    userPoolClientId: cognitoConfig.userPoolClientId ?? "",
    identityPoolId: cognitoConfig.identityPoolId ?? "",
    region,
  });

  const handleSelectMode = (selectedMode: SetupMode) => {
    setMode(selectedMode);
    if (selectedMode === "resume") {
      setActive(1);
      setSkipCreateAccount(false);
    } else if (selectedMode === "signin") {
      setActive(1);
      setSkipCreateAccount(true);
    } else {
      setActive(0);
      setSkipCreateAccount(false);
    }
  };

  const handleSignInSuccess = async (tokens: { idToken: string; refreshToken: string }) => {
    setSignInResult(tokens);
    setError(null);
    try {
      const creds = await getIdentityPoolCredentials(fullCognitoConfig(), tokens.idToken);
      setCredentials(creds);
      setActive(4);
    } catch (err) {
      setError(`Failed to get AWS credentials: ${String(err instanceof Error ? err.message : err)}`);
    }
  };

  const handleDeploySuccess = async (result: DeployOutputs) => {
    if (!signInResult || !credentials) {
      setError("Session expired — please sign in again.");
      setActive(3);
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
      localStorage.removeItem(PARTIAL_SETUP_KEY);
      navigate("/");
    } catch (err) {
      setError(`Failed to save cloud config: ${String(err instanceof Error ? err.message : err)}`);
    }
  };

  // Mode not yet chosen — show the mode selector
  if (mode === null) {
    return (
      <Container size="sm" py="xl">
        <Group mb="lg" justify="space-between">
          <Title order={2}>Starkeep Cloud Setup</Title>
        </Group>
        <Paper p="xl" withBorder>
          <ModeSelector onSelect={handleSelectMode} />
        </Paper>
      </Container>
    );
  }

  // Wizard for "fresh" and "resume" modes
  const stepTitles = [
    "Bootstrap AWS",
    "Stack outputs",
    "Create account",
    "Sign in",
    "Deploy infrastructure",
  ];

  return (
    <Container size="sm" py="xl">
      <Group mb="lg" justify="space-between">
        <Title order={2}>Set up Starkeep Cloud</Title>
        <Badge variant="light" color="blue">
          {mode === "fresh" ? "New setup" : mode === "signin" ? "Existing account" : "Resume setup"}
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
          <Step1Bootstrap
            onNext={() => setActive(1)}
            onBack={() => setMode(null)}
            region={region}
            setRegion={setRegion}
            stackPrefix={stackPrefix}
            setStackPrefix={setStackPrefix}
          />
        )}
        {active === 1 && (
          <Step2Outputs
            onNext={() => {
              setCognitoConfig({ ...cognitoConfig, region });
              setActive(skipCreateAccount ? 3 : 2);
            }}
            onBack={() => {
              if (mode === "resume" || mode === "signin") {
                setMode(null);
              } else {
                setActive(0);
              }
            }}
            region={region}
            stackPrefix={stackPrefix}
            cognitoConfig={cognitoConfig}
            setCognitoConfig={setCognitoConfig}
          />
        )}
        {active === 2 && (
          <Step3CreateAccount
            onNext={() => setActive(3)}
            onBack={() => setActive(1)}
            cognitoConfig={{ ...cognitoConfig, region }}
            region={region}
          />
        )}
        {active === 3 && (
          <Step4SignIn
            onSuccess={handleSignInSuccess}
            onBack={() => setActive(skipCreateAccount ? 1 : 2)}
            cognitoConfig={fullCognitoConfig()}
          />
        )}
        {active === 4 && credentials && signInResult && (
          <Step5DeployInfra
            onSuccess={handleDeploySuccess}
            onBack={() => setActive(3)}
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
