"use client";

import { useState, useCallback, useEffect, useRef, Suspense } from "react";
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
  Textarea,
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
import { getBootstrapStackOutputsUrl } from "@starkeep/admin-core";
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
import { s3PutObject, s3GetObjectText } from "../../src/lib/s3";

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

function openUrl(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
}


type SetupMode = "fresh" | "resume" | "signin";

function ModeSelector({ onSelect }: { onSelect: (mode: SetupMode) => void }) {
  const [showClearPanel, setShowClearPanel] = useState(false);
  const [clearRegion, setClearRegion] = useState("us-east-1");
  const [clearPrefix, setClearPrefix] = useState("starkeep");

  return (
    <Stack gap="lg">
      <Text>
        Your Starkeep Cloud bootstrap stack is already deployed. Choose an option below to continue.
      </Text>

      <Stack gap="sm">
        <Paper p="md" withBorder style={{ cursor: "pointer" }} onClick={() => onSelect("resume")}>
          <Stack gap="xs">
            <Text fw={600}>Create Starkeep Cloud Admin Account</Text>
            <Text size="sm" c="dimmed">
              First time here? Enter your CloudFormation stack outputs and create your admin account.
            </Text>
          </Stack>
        </Paper>

        <Paper p="md" withBorder style={{ cursor: "pointer" }} onClick={() => onSelect("signin")}>
          <Stack gap="xs">
            <Text fw={600}>Sign In to Starkeep Cloud Admin</Text>
            <Text size="sm" c="dimmed">
              You already have an admin account. Sign in and finish setting up, or connect a new
              device.
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
            <Text fw={500} c="red">
              Clear your existing bootstrap stack
            </Text>
            <Text size="sm" c="dimmed">
              Use this if you want to wipe your existing Starkeep bootstrap and start fresh. This
              must be done manually in the AWS console — follow the steps below.
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
                3. Delete the S3 bucket named <Code>{clearPrefix}-deploy-artifacts</Code> —
                CloudFormation cannot delete non-empty buckets, so empty and delete it manually
                from the S3 console.
              </Text>
              <Text size="sm">
                4. Return to the bootstrap app to re-deploy the bootstrap stack, then come back here.
              </Text>
            </Stack>

            <Button
              variant="light"
              color="red"
              size="sm"
              onClick={() =>
                openUrl(
                  `https://${clearRegion}.console.aws.amazon.com/cloudformation/home?region=${clearRegion}#/stacks`,
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

const POLL_INTERVAL_MS = 5000;

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
  a.download = ".starkeep-config.json";
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
  const [deploying, setDeploying] = useState(false);
  const [phase, setPhase] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [showManualEntry, setShowManualEntry] = useState(false);
  const [deployResult, setDeployResult] = useState<DeployOutputs | null>(null);
  const [manualBucket, setManualBucket] = useState("");
  const [manualAurora, setManualAurora] = useState("");
  const [manualApi, setManualApi] = useState("");
  const [sstPasteText, setSstPasteText] = useState("");
  const [sstPasteError, setSstPasteError] = useState<string | null>(null);
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

      const { CodeBuildClient, StartBuildCommand, BatchGetBuildsCommand } =
        await import("@aws-sdk/client-codebuild");

      const cb = new CodeBuildClient({ region, credentials: awsCreds });

      const artifactsBucket = `${stackPrefix}-deploy-artifacts`;
      const sourceKey = `${stackPrefix}-user-data-source.zip`;

      setPhase("Uploading deployment source to S3…");
      const zipResponse = await fetch("/user-data-source.zip");
      if (!zipResponse.ok)
        throw new Error(
          "Could not load user-data-source.zip — run pnpm build:artifact first",
        );
      const zipBytes = await zipResponse.arrayBuffer();
      const zipArray = new Uint8Array(zipBytes);
      let binary = "";
      const chunkSize = 8192;
      for (let i = 0; i < zipArray.length; i += chunkSize) {
        binary += String.fromCharCode(...zipArray.subarray(i, i + chunkSize));
      }
      const bodyBase64 = btoa(binary);
      await s3PutObject(
        artifactsBucket,
        sourceKey,
        bodyBase64,
        "application/zip",
        credentials,
        region,
      );

      setPhase("Starting CodeBuild deployment…");
      const startResult = await cb.send(
        new StartBuildCommand({
          projectName: `${stackPrefix}-deploy`,
          environmentVariablesOverride: [
            { name: "STAGE", value: stackPrefix, type: "PLAINTEXT" },
            { name: "USER_POOL_ID", value: cognitoConfig.userPoolId, type: "PLAINTEXT" },
            {
              name: "USER_POOL_CLIENT_ID",
              value: cognitoConfig.userPoolClientId,
              type: "PLAINTEXT",
            },
          ],
        }),
      );

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
        setPhase(
          `CodeBuild: ${currentPhase} (${buildStatus === "IN_PROGRESS" ? "running" : buildStatus})`,
        );
      }

      if (buildStatus !== "SUCCEEDED") {
        throw new Error(
          `CodeBuild deployment ${buildStatus.toLowerCase()}. Check the AWS CodeBuild console for details.`,
        );
      }

      setPhase("Reading deployment outputs…");
      const rawOutput = await s3GetObjectText(
        artifactsBucket,
        `${stackPrefix}-raw-output.txt`,
        credentials,
        region,
      );

      const outputs = parseSstOutputs(rawOutput);
      const bucketName = outputs["bucketName"];
      const auroraHostname = outputs["auroraHostname"];
      const apiGatewayUrl = outputs["apiGatewayUrl"];

      if (!bucketName || !auroraHostname) {
        throw new Error(
          "Deployment outputs missing expected values.\n\n" +
            `Parsed: ${JSON.stringify(outputs)}\n\n` +
            `Raw output (last 2000 chars):\n${rawOutput.slice(-2000)}`,
        );
      }

      setDeployResult({
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
  }, [credentials, region, stackPrefix, cognitoConfig]);

  const handleManualSubmit = () => {
    if (!manualBucket || !manualAurora) return;
    setDeployResult({
      s3Bucket: manualBucket.trim(),
      s3Region: region,
      auroraEndpoint: manualAurora.trim(),
      apiGatewayUrl: manualApi.trim() || undefined,
    });
  };

  const handleSstPasteSubmit = () => {
    setSstPasteError(null);
    const outputs = parseSstOutputs(sstPasteText);
    const bucketName = outputs["bucketName"];
    const auroraHostname = outputs["auroraHostname"];
    const apiGatewayUrl = outputs["apiGatewayUrl"];
    if (!bucketName || !auroraHostname) {
      setSstPasteError(
        `Could not find required values in output. Parsed: ${JSON.stringify(outputs)}`,
      );
      return;
    }
    onSuccess({
      s3Bucket: bucketName,
      s3Region: region,
      auroraEndpoint: auroraHostname,
      apiGatewayUrl,
    });
  };

  if (deployResult) {
    return (
      <Stack gap="md">
        <Alert color="green" title="Deployment complete">
          Your Starkeep data infrastructure is ready.
        </Alert>
        <Text size="sm">
          To deploy or remove infrastructure from your local machine using{" "}
          <Code>pnpm run local:deploy</Code> / <Code>pnpm run local:remove</Code>, download your
          CLI config and place it in the repo root.
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
          Download CLI config (.starkeep-config.json)
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
        We will now deploy your Starkeep data infrastructure via AWS CodeBuild. This creates:
      </Text>
      <Stack gap="xs" pl="md">
        <Text size="sm">• S3 bucket for file storage</Text>
        <Text size="sm">• Aurora DSQL cluster for remote metadata index</Text>
        <Text size="sm">• Lambda function + API Gateway for data access</Text>
      </Stack>
      <Text size="sm" c="dimmed">
        The deployment runs in your AWS account via CodeBuild and takes 5–10 minutes. Aurora DSQL
        clusters take 2–5 minutes to become active.
      </Text>

      {error && <Alert color="red" title="Deployment failed">{error}</Alert>}

      <Divider label="Local deployment" labelPosition="left" />
      <Text size="sm" c="dimmed">
        To deploy from your local machine instead of CodeBuild, download the CLI config and run{" "}
        <Code>pnpm run local:deploy</Code> from <Code>infra/user-data/</Code>.
      </Text>
      <Button
        variant="light"
        disabled={deploying}
        onClick={() =>
          downloadCliConfig({
            region,
            stage: stackPrefix,
            userPoolId: cognitoConfig.userPoolId,
            userPoolClientId: cognitoConfig.userPoolClientId,
            identityPoolId: cognitoConfig.identityPoolId,
          })
        }
      >
        Download CLI config (.starkeep-config.json)
      </Button>
      <Textarea
        label="Paste SST deploy output"
        description="After running pnpm run local:deploy, paste the full terminal output here."
        placeholder="Stack starkeep&#10;  bucketName: starkeep-files-abc123&#10;  auroraHostname: abc123.dsql.us-east-1.on.aws&#10;  apiGatewayUrl: https://abc123.execute-api.us-east-1.amazonaws.com"
        minRows={4}
        value={sstPasteText}
        onChange={(e) => { setSstPasteText(e.currentTarget.value); setSstPasteError(null); }}
        disabled={deploying}
      />
      {sstPasteError && <Alert color="red" title="Parse error">{sstPasteError}</Alert>}
      <Group justify="flex-end">
        <Button
          variant="light"
          disabled={deploying || !sstPasteText.trim()}
          onClick={handleSstPasteSubmit}
        >
          Configure from output
        </Button>
      </Group>

      <Divider label="Remote deployment" labelPosition="left" />
      <Text size="sm" c="dimmed">
        If you already deployed successfully or want to enter values from the AWS console,{" "}
        <Anchor size="sm" onClick={() => setShowManualEntry(true)}>
          enter the outputs manually
        </Anchor>
        .
      </Text>

      {deploying && phase && (
        <Paper withBorder p="sm">
          <Group gap="sm">
            <Loader size="xs" />
            <Text size="sm" c="dimmed">
              {phase}
            </Text>
          </Group>
          <div ref={logsEndRef} />
        </Paper>
      )}

      <Group justify="space-between" mt="md">
        <Button variant="subtle" onClick={onBack} disabled={deploying}>
          Back
        </Button>
        <Button loading={deploying} onClick={handleDeploy} disabled={deploying}>
          {deploying ? "Deploying…" : "Deploy data infrastructure"}
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
    if (selectedMode === "resume") {
      setActive(0);
      setSkipCreateAccount(false);
    } else if (selectedMode === "signin") {
      setActive(0);
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
      // Push deploy outputs to the local data-server so .starkeep-config.json is updated on disk.
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

  const stepTitles = [
    "Stack outputs",
    "Create account",
    "Sign in",
    "Deploy infrastructure",
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
