"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { CommandOutput } from "./CommandOutput";
import { CloudDataServerStatus } from "./CloudDataServerStatus";
import { cn } from "@/lib/utils";
import {
  generateBootstrapTemplate,
  getCloudFormationCreateStackUrl,
  getBootstrapStackOutputsUrl,
} from "@starkeep/aws-bootstrap";
import {
  readCloudConfig,
  patchCloudConfig,
  writeCloudCredentials,
  writeCognitoSession,
  readCognitoSession,
  regionFromUserPoolId,
  type CloudConfig,
} from "../lib/cloud-config";
import {
  initiateAuth,
  respondNewPasswordChallenge,
  refreshTokens,
  getIdentityPoolCredentials,
  extractEmailFromIdToken,
  type CognitoConfig,
  type STSCredentials,
} from "../lib/cognito-auth";

const LOCAL_DATA_SERVER_URL = "http://127.0.0.1:9820";

async function isLocalDataServerOnline(): Promise<boolean> {
  try {
    const resp = await fetch(`${LOCAL_DATA_SERVER_URL}/health`, { signal: AbortSignal.timeout(1500) });
    return resp.ok;
  } catch {
    return false;
  }
}

async function pushAuthToLocalDataServer(tokens: { idToken: string; refreshToken: string }): Promise<void> {
  const resp = await fetch(`${LOCAL_DATA_SERVER_URL}/auth/tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken: tokens.idToken, refreshToken: tokens.refreshToken }),
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `Local data server rejected tokens (HTTP ${resp.status})`);
  }
}

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

type StepId = 1 | 2 | 3 | 4 | 5;

const STEPS: { id: StepId; label: string }[] = [
  { id: 1, label: "Bootstrap stack" },
  { id: 2, label: "Stack outputs" },
  { id: 3, label: "Create user" },
  { id: 4, label: "Sign in" },
  { id: 5, label: "Deploy" },
];

function openUrl(url: string) {
  window.open(url, "_blank", "noopener,noreferrer");
}

// ---------------------------------------------------------------------------
// Field validation
// ---------------------------------------------------------------------------

function validateUserPoolId(v: string) {
  return /^[a-z]+-[a-z]+-\d+_[A-Za-z0-9]+$/.test(v) ? null : "Format: us-east-1_Xxxxxxxxx";
}
function validateUserPoolClientId(v: string) {
  return /^[A-Za-z0-9]+$/.test(v) ? null : "Must be an alphanumeric string";
}
function validateIdentityPoolId(v: string) {
  return /^[a-z]+-[a-z]+-\d+:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v)
    ? null
    : "Format: us-east-1:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx";
}

// ---------------------------------------------------------------------------
// ToC
// ---------------------------------------------------------------------------

function StepToC({
  currentStep,
  completedSteps,
  onNavigate,
}: {
  currentStep: StepId;
  completedSteps: Set<StepId>;
  onNavigate: (step: StepId) => void;
}) {
  return (
    <nav className="flex flex-col gap-0.5">
      {STEPS.map(({ id, label }) => {
        const isActive = id === currentStep;
        const isDone = completedSteps.has(id);
        const isLocked = !isDone && id > currentStep;

        return (
          <button
            key={id}
            disabled={isLocked || isActive}
            onClick={() => !isLocked && !isActive && onNavigate(id)}
            className={cn(
              "flex items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors",
              isActive && "bg-primary/10 text-primary font-medium cursor-default",
              isDone && !isActive && "text-foreground hover:bg-accent hover:text-accent-foreground cursor-pointer",
              isLocked && "text-muted-foreground cursor-default",
            )}
          >
            <span
              className={cn(
                "flex size-5 shrink-0 items-center justify-center rounded-full border text-xs font-medium",
                isActive && "border-primary bg-primary/10 text-primary",
                isDone && !isActive && "border-border bg-muted text-muted-foreground",
                isLocked && "border-border text-muted-foreground",
              )}
            >
              {isDone && !isActive ? <Check className="size-3" /> : id}
            </span>
            <span className="truncate">{label}</span>
          </button>
        );
      })}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Step 1 — Bootstrap
// ---------------------------------------------------------------------------

function Step1Bootstrap({
  initialStackPrefix,
  initialRegion,
  onContinue,
}: {
  initialStackPrefix: string;
  initialRegion: string;
  onContinue: (stackPrefix: string) => void;
}) {
  // Step 1's region exists only to construct the CloudFormation console URL
  // and the bootstrap template's stack name. It is not persisted: once Step 2
  // captures the userPoolId, region is derived from that going forward.
  const [region, setRegion] = useState(initialRegion);
  const [stackPrefix, setStackPrefix] = useState(initialStackPrefix);
  const [downloaded, setDownloaded] = useState(false);

  const canContinue = !!region.trim() && !!stackPrefix.trim();

  function handleDownload() {
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
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">
        Deploy the Starkeep bootstrap CloudFormation stack. This creates Cognito authentication,
        IAM roles, and S3/Pulumi infrastructure in your AWS account.
      </p>

      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium" htmlFor="region">AWS Region</label>
          <Input
            id="region"
            placeholder="us-east-1"
            value={region}
            onChange={(e) => setRegion(e.currentTarget.value)}
          />
          <p className="text-xs text-muted-foreground">The AWS region where your Starkeep infrastructure will be deployed.</p>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium" htmlFor="stackPrefix">Stack prefix</label>
          <Input
            id="stackPrefix"
            placeholder="starkeep"
            value={stackPrefix}
            onChange={(e) => setStackPrefix(e.currentTarget.value.toLowerCase())}
          />
          <p className="text-xs text-muted-foreground">A short name used to prefix all Starkeep resources. Lowercase letters, numbers, and hyphens only.</p>
        </div>
      </div>

      <Separator />

      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <p className="text-sm font-medium">1. Download the bootstrap template</p>
          <p className="text-xs text-muted-foreground">Generates a CloudFormation YAML template and downloads it to your browser.</p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleDownload}
              disabled={!stackPrefix || !region}
            >
              Download bootstrap template
            </Button>
            {downloaded && (
              <span className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
                <Check className="size-3" /> starkeep-bootstrap-template.yaml
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <p className="text-sm font-medium">2. Deploy the stack in AWS CloudFormation</p>
          <p className="text-xs text-muted-foreground">
            In the CloudFormation console, choose <strong>Upload a template file</strong> and upload the file above.
            Name the stack <code className="font-mono text-xs">{stackPrefix ? `${stackPrefix}-bootstrap` : "starkeep-bootstrap"}</code> and
            wait for <strong>CREATE_COMPLETE</strong> status.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => openUrl(getCloudFormationCreateStackUrl(region))}
            disabled={!region}
            className="w-fit"
          >
            Open CloudFormation console ↗
          </Button>
        </div>
      </div>

      <Alert>
        <AlertDescription>
          Once the stack reaches <strong>CREATE_COMPLETE</strong>, click Continue to enter the stack outputs and finish setting up your account.
        </AlertDescription>
      </Alert>

      <div className="flex justify-end">
        <Button onClick={() => onContinue(stackPrefix)} disabled={!canContinue}>
          Stack is deployed — Continue
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — Stack outputs
// ---------------------------------------------------------------------------

function Step2Outputs({
  stackPrefix,
  initialCognitoConfig,
  onContinue,
  onBack,
}: {
  stackPrefix: string;
  initialCognitoConfig: Partial<CognitoConfig>;
  onContinue: (config: Pick<CognitoConfig, "userPoolId" | "userPoolClientId" | "identityPoolId">) => void;
  onBack: () => void;
}) {
  const [userPoolId, setUserPoolId] = useState(initialCognitoConfig.userPoolId ?? "");
  const [userPoolClientId, setUserPoolClientId] = useState(initialCognitoConfig.userPoolClientId ?? "");
  const [identityPoolId, setIdentityPoolId] = useState(initialCognitoConfig.identityPoolId ?? "");
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  const touch = (field: string) => setTouched((t) => ({ ...t, [field]: true }));

  const errors = {
    userPoolId: validateUserPoolId(userPoolId),
    userPoolClientId: validateUserPoolClientId(userPoolClientId),
    identityPoolId: validateIdentityPoolId(identityPoolId),
  };
  const isValid = Object.values(errors).every((e) => e === null);
  const region = regionFromUserPoolId(userPoolId);

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">
        Open the CloudFormation stack <strong>Outputs</strong> tab and copy the three values below.
      </p>

      <Button
        variant="outline"
        size="sm"
        className="w-fit"
        disabled={!region}
        onClick={() => openUrl(getBootstrapStackOutputsUrl(region, `${stackPrefix}-bootstrap`))}
      >
        Open stack outputs in AWS console ↗
      </Button>

      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium" htmlFor="userPoolId">UserPoolId</label>
          <Input
            id="userPoolId"
            placeholder="us-east-1_Xxxxxxxxx"
            value={userPoolId}
            onChange={(e) => setUserPoolId(e.currentTarget.value.trim())}
            onBlur={() => touch("userPoolId")}
            aria-invalid={touched.userPoolId && !!errors.userPoolId}
            className={cn(touched.userPoolId && errors.userPoolId && "border-destructive")}
          />
          {touched.userPoolId && errors.userPoolId && (
            <p className="text-xs text-destructive">{errors.userPoolId}</p>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium" htmlFor="userPoolClientId">UserPoolClientId</label>
          <Input
            id="userPoolClientId"
            placeholder="3abc4defghij5klmnopq6rstuv"
            value={userPoolClientId}
            onChange={(e) => setUserPoolClientId(e.currentTarget.value.trim())}
            onBlur={() => touch("userPoolClientId")}
            aria-invalid={touched.userPoolClientId && !!errors.userPoolClientId}
            className={cn(touched.userPoolClientId && errors.userPoolClientId && "border-destructive")}
          />
          {touched.userPoolClientId && errors.userPoolClientId && (
            <p className="text-xs text-destructive">{errors.userPoolClientId}</p>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium" htmlFor="identityPoolId">IdentityPoolId</label>
          <Input
            id="identityPoolId"
            placeholder="us-east-1:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            value={identityPoolId}
            onChange={(e) => setIdentityPoolId(e.currentTarget.value.trim())}
            onBlur={() => touch("identityPoolId")}
            aria-invalid={touched.identityPoolId && !!errors.identityPoolId}
            className={cn(touched.identityPoolId && errors.identityPoolId && "border-destructive")}
          />
          {touched.identityPoolId && errors.identityPoolId && (
            <p className="text-xs text-destructive">{errors.identityPoolId}</p>
          )}
        </div>
      </div>

      <div className="flex justify-between">
        <Button variant="ghost" onClick={onBack}>Back</Button>
        <Button
          onClick={() => onContinue({ userPoolId, userPoolClientId, identityPoolId })}
          disabled={!isValid}
        >
          Continue
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 3 — Create user
// ---------------------------------------------------------------------------

function Step3CreateUser({
  cognitoConfig,
  onContinue,
  onBack,
}: {
  cognitoConfig: Partial<CognitoConfig>;
  onContinue: () => void;
  onBack: () => void;
}) {
  const region = cognitoConfig.userPoolId ? regionFromUserPoolId(cognitoConfig.userPoolId) : "us-east-1";
  const consoleLink = cognitoConfig.userPoolId
    ? `https://${region}.console.aws.amazon.com/cognito/v2/idp/user-pools/${cognitoConfig.userPoolId}/users/create`
    : null;

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">
        Your Cognito user pool has been created, but it has no users yet. You need to create your
        account before you can sign in.
      </p>

      <div className="rounded-md border p-4 flex flex-col gap-3">
        <p className="text-sm font-medium">Create your account in the AWS console</p>
        <ol className="flex flex-col gap-1 text-sm text-muted-foreground list-none">
          <li>1. Click the button below to open the Cognito console.</li>
          <li>2. Click <strong>Create user</strong>.</li>
          <li>3. Enter your email address. Cognito will send a temporary password to that address.</li>
          <li>4. Return here once you have received the email.</li>
        </ol>
        {consoleLink ? (
          <Button variant="outline" size="sm" className="w-fit" onClick={() => openUrl(consoleLink)}>
            Open Cognito Users console ↗
          </Button>
        ) : (
          <Alert>
            <AlertDescription>UserPoolId not set — go back and enter outputs.</AlertDescription>
          </Alert>
        )}
      </div>

      <div className="flex justify-between">
        <Button variant="ghost" onClick={onBack}>Back</Button>
        <Button onClick={onContinue}>User Created — Continue</Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 4 — Sign in
// ---------------------------------------------------------------------------

function Step4SignIn({
  cognitoConfig,
  onSuccess,
  onBack,
}: {
  cognitoConfig: CognitoConfig;
  onSuccess: (
    tokens: { idToken: string; refreshToken: string },
    creds: STSCredentials,
    userEmail: string | null,
  ) => void;
  onBack: () => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newPasswordConfirm, setNewPasswordConfirm] = useState("");
  const [session, setSession] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverOnline, setServerOnline] = useState<boolean | null>(null);
  const [serverStarting, setServerStarting] = useState(false);

  // Poll the local data server's reachability. Sign-in pushes the resulting
  // tokens to it (so the data server, the browser, and the cloud all agree on
  // who's signed in), so we require it to be up before allowing sign-in.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const online = await isLocalDataServerOnline();
      if (!cancelled) setServerOnline(online);
    };
    tick();
    const id = setInterval(tick, 2000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const handleStartServer = async () => {
    setServerStarting(true);
    setError(null);
    try {
      await fetch("/api/exec/daemon", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start", id: "local-data-server" }),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setServerStarting(false);
    }
  };

  const handleSignIn = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await initiateAuth(cognitoConfig, email, password);
      if (result.tokens) {
        const creds = await getIdentityPoolCredentials(cognitoConfig, result.tokens.idToken);
        await pushAuthToLocalDataServer(result.tokens);
        const userEmail = extractEmailFromIdToken(result.tokens.idToken);
        onSuccess(
          { idToken: result.tokens.idToken, refreshToken: result.tokens.refreshToken },
          creds,
          userEmail,
        );
      } else if (result.challengeName === "NEW_PASSWORD_REQUIRED") {
        setSession(result.session ?? null);
      } else {
        setError(`Unexpected challenge: ${result.challengeName}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
      const creds = await getIdentityPoolCredentials(cognitoConfig, tokens.idToken);
      await pushAuthToLocalDataServer(tokens);
      const userEmail = extractEmailFromIdToken(tokens.idToken);
      onSuccess({ idToken: tokens.idToken, refreshToken: tokens.refreshToken }, creds, userEmail);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const serverGate = serverOnline === false ? (
    <Alert>
      <AlertDescription className="flex items-center justify-between gap-3">
        <span>
          The local data server isn&apos;t running. It needs to be running so sign-in tokens can be
          handed to it — otherwise sync will use whatever stale tokens it last had.
        </span>
        <Button size="sm" variant="outline" onClick={handleStartServer} disabled={serverStarting}>
          {serverStarting && <span className="mr-2 size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />}
          Start
        </Button>
      </AlertDescription>
    </Alert>
  ) : null;
  const signInDisabled = loading || serverOnline !== true;

  if (session) {
    return (
      <div className="flex flex-col gap-5">
        <p className="text-sm text-muted-foreground">
          Your temporary password has expired. Please set a new permanent password.
        </p>
        {serverGate}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium" htmlFor="newPassword">New password</label>
            <Input
              id="newPassword"
              type="password"
              placeholder="At least 8 characters"
              value={newPassword}
              onChange={(e) => setNewPassword(e.currentTarget.value)}
              disabled={loading}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium" htmlFor="confirmPassword">Confirm new password</label>
            <Input
              id="confirmPassword"
              type="password"
              value={newPasswordConfirm}
              onChange={(e) => setNewPasswordConfirm(e.currentTarget.value)}
              disabled={loading}
            />
          </div>
        </div>
        <div className="flex justify-between">
          <Button variant="ghost" onClick={() => setSession(null)} disabled={loading}>Back</Button>
          <Button
            onClick={handleSetNewPassword}
            disabled={signInDisabled || !newPassword || newPassword.length < 8}
          >
            {loading && <span className="mr-2 size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />}
            Set password and sign in
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">
        Sign in with your email and the temporary password from Cognito.
      </p>
      {serverGate}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium" htmlFor="email">Email</label>
          <Input
            id="email"
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.currentTarget.value)}
            disabled={loading}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium" htmlFor="password">Temporary password</label>
          <Input
            id="password"
            type="password"
            placeholder="From the email Cognito sent"
            value={password}
            onChange={(e) => setPassword(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleSignIn(); }}
            disabled={loading}
          />
          <p className="text-xs text-muted-foreground">From the email Cognito sent when you created your account</p>
        </div>
      </div>
      <div className="flex justify-between">
        <Button variant="ghost" onClick={onBack} disabled={loading}>Back</Button>
        <Button onClick={handleSignIn} disabled={signInDisabled || !email || !password}>
          {loading && <span className="mr-2 size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />}
          Sign in
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 5 — Deploy
// ---------------------------------------------------------------------------

interface DeployOutputs {
  s3Bucket: string;
  auroraEndpoint: string;
  apiGatewayUrl?: string;
}

function Step5Deploy({
  credentials,
  refreshCredentials,
  cloudConfig,
  refreshCloudConfig,
  signInRefreshToken,
  signInUserEmail,
  onSuccess,
  onBack,
  onTokenExpired,
}: {
  credentials: STSCredentials;
  /**
   * Mints a fresh Cognito-Identity-Pool STS session right before the install
   * runs. Cognito's STS creds last ~1 hour from sign-in; if the user paused
   * between Step 4 and Step 5, refreshing here avoids the common case where
   * the installer ExpiredTokens partway through. Returns null if no refresh
   * token is available; throws if the refresh itself fails (caller decides
   * whether to send the user back to Sign In).
   */
  refreshCredentials: () => Promise<STSCredentials | null>;
  cloudConfig: CloudConfig | null;
  refreshCloudConfig: () => Promise<void>;
  signInRefreshToken: string;
  signInUserEmail: string | null;
  onSuccess: (result: DeployOutputs) => void;
  onBack: () => void;
  /** Called when the installer reports EXPIRED_TOKEN — wizard sends the user back to Step 4. */
  onTokenExpired: () => void;
}) {
  const [installing, setInstalling] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [status, setStatus] = useState<"idle" | "running" | "success" | "failure">("idle");
  const [deployResult, setDeployResult] = useState<DeployOutputs | null>(null);
  const [tokenExpired, setTokenExpired] = useState(false);
  const [statusRefreshKey, setStatusRefreshKey] = useState(0);

  const alreadyDeployed = !!(cloudConfig?.s3Bucket && cloudConfig?.auroraEndpoint);
  const showStatusCard = status !== "running" && (deployResult !== null || alreadyDeployed);

  function handleInstall() {
    setInstalling(true);
    setLines([]);
    setStatus("running");
    setTokenExpired(false);
    let aborted = false;

    // One SSE install pass. Streams stdout/stderr lines into the shared log and
    // resolves with a discriminated outcome so the two-pass driver can decide
    // whether to continue. `done` carries the pass's `event: done` data payload
    // (cloud-data-server returns its outputs; Drive returns `{}`).
    type PassResult =
      | { kind: "done"; data: string }
      | { kind: "error"; message: string; tokenExpired: boolean };

    async function runPass(url: string, creds: STSCredentials): Promise<PassResult> {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accessKeyId: creds.accessKeyId,
          secretAccessKey: creds.secretAccessKey,
          sessionToken: creds.sessionToken,
        }),
      });

      if (!resp.ok || !resp.body) {
        let errMsg = `${resp.status} ${resp.statusText}`;
        try {
          const j = (await resp.json()) as { error?: string };
          if (j.error) errMsg = j.error;
        } catch { /* not JSON */ }
        return { kind: "error", message: errMsg, tokenExpired: false };
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
            return { kind: "done", data };
          } else if (eventType === "error") {
            // Server emits structured `{ message, code? }` JSON; keep the
            // older bare-string form working too.
            let message = data;
            let code: string | undefined;
            try {
              const parsed = JSON.parse(data);
              if (typeof parsed === "string") {
                message = parsed;
              } else if (parsed && typeof parsed === "object") {
                if (typeof parsed.message === "string") message = parsed.message;
                if (typeof parsed.code === "string") code = parsed.code;
              }
            } catch {
              /* not JSON — leave message as-is */
            }
            return { kind: "error", message, tokenExpired: code === "EXPIRED_TOKEN" };
          } else if (data) {
            try { setLines((l) => [...l, JSON.parse(data) as string]); }
            catch { setLines((l) => [...l, data]); }
          }
        }
      }
      // Stream ended without a terminal done/error event.
      return { kind: "error", message: "Install stream ended unexpectedly", tokenExpired: false };
    }

    function failPass(r: { message: string; tokenExpired: boolean }): void {
      setLines((l) => [...l, `Error: ${r.message}`]);
      if (r.tokenExpired) setTokenExpired(true);
      setStatus("failure");
    }

    // Mint fresh STS creds right before each pass so a long pause (or a slow
    // cloud-data-server install) doesn't ExpiredToken the next pass.
    async function freshCreds(): Promise<STSCredentials | null> {
      try {
        const fresh = await refreshCredentials();
        return fresh ?? credentials;
      } catch {
        return null;
      }
    }

    async function run() {
      try {
        // ---- Pass 1: cloud-data-server (foundational infra) ----------------
        const creds1 = await freshCreds();
        if (!creds1) {
          setTokenExpired(true);
          setStatus("failure");
          return;
        }
        setLines((l) => [...l, "── Deploying cloud-data-server ──"]);
        const r1 = await runPass("/api/cloud-data-server/install", creds1);
        if (aborted) return;
        if (r1.kind !== "done") {
          failPass(r1);
          return;
        }
        let result: DeployOutputs;
        try {
          const outputs = JSON.parse(r1.data) as {
            auroraHostname: string;
            bucketName: string;
            apiGatewayUrl: string;
          };
          result = {
            s3Bucket: outputs.bucketName,
            auroraEndpoint: outputs.auroraHostname,
            apiGatewayUrl: outputs.apiGatewayUrl,
          };
        } catch {
          setLines((l) => [...l, `Error: malformed done event: ${r1.data}`]);
          setStatus("failure");
          return;
        }

        // ---- Pass 2: Starkeep Drive (User-Data-Owner identity) -------------
        const creds2 = await freshCreds();
        if (!creds2) {
          setTokenExpired(true);
          setStatus("failure");
          return;
        }
        setLines((l) => [...l, "", "── Deploying Starkeep Drive ──"]);
        const r2 = await runPass("/api/drive/install", creds2);
        if (aborted) return;
        if (r2.kind !== "done") {
          failPass(r2);
          return;
        }

        // Both passes succeeded — re-read the config so the status card sees
        // the just-written s3Bucket / auroraEndpoint / apiGatewayUrl.
        await refreshCloudConfig();
        setDeployResult(result);
        setStatus("success");
        setStatusRefreshKey((k) => k + 1);
      } catch (err) {
        if (!aborted) {
          setLines((l) => [...l, `Error: ${err instanceof Error ? err.message : String(err)}`]);
          setStatus("failure");
        }
      } finally {
        setInstalling(false);
      }
    }

    run();
    return () => { aborted = true; };
  }

  const sessionForStatus = signInRefreshToken
    ? { refreshToken: signInRefreshToken, userEmail: signInUserEmail ?? undefined }
    : null;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <p className="text-sm text-muted-foreground">
          Deploy the Starkeep cloud. This runs two passes in sequence:
        </p>
        <ul className="text-sm text-muted-foreground flex flex-col gap-0.5 pl-4">
          <li>• <strong>cloud-data-server</strong> — Aurora DSQL cluster, S3 file bucket, Lambda + API Gateway (Cognito JWT authorizer), shared-schema migrations</li>
          <li>• <strong>Starkeep Drive</strong> — the User-Data-Owner identity that owns shared-record sync (IAM role + grants; no compute)</li>
        </ul>
      </div>

      {status === "idle" && !alreadyDeployed && (
        <Button onClick={handleInstall} disabled={installing}>
          Deploy Starkeep cloud
        </Button>
      )}

      {(status === "running" || lines.length > 0) && (
        <CommandOutput lines={lines} status={status} />
      )}

      {showStatusCard && (
        <CloudDataServerStatus
          cloudConfig={cloudConfig}
          cognitoSession={sessionForStatus}
          refreshKey={statusRefreshKey}
        >
          <Button size="sm" variant="outline" onClick={handleInstall} disabled={installing}>
            {installing && <span className="mr-1 size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />}
            Redeploy
          </Button>
        </CloudDataServerStatus>
      )}

      {status === "success" && deployResult && (
        <div className="flex justify-end">
          <Button onClick={() => onSuccess(deployResult)}>Continue →</Button>
        </div>
      )}

      {status === "failure" && tokenExpired && (
        <>
          <Alert variant="destructive">
            <AlertDescription>
              Your AWS sign-in session expired. Sign in again to retry the deploy —
              your progress so far is preserved.
            </AlertDescription>
          </Alert>
          <Button onClick={onTokenExpired} variant="outline">Sign in again</Button>
        </>
      )}

      {status === "failure" && !tokenExpired && (
        <Button onClick={handleInstall} variant="outline">Retry install</Button>
      )}

      <div className="flex justify-start">
        <Button variant="ghost" onClick={onBack} disabled={installing}>Back</Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main wizard
// ---------------------------------------------------------------------------

interface Props {
  onComplete?: () => void;
}

export function CloudSetupWizard({ onComplete }: Props) {
  const router = useRouter();

  const [currentStep, setCurrentStep] = useState<StepId>(1);
  const [completedSteps, setCompletedSteps] = useState<Set<StepId>>(new Set());
  const [resuming, setResuming] = useState(true);

  // In-memory mirror of the file. Updated on mount and after each PATCH.
  const [cloudConfig, setCloudConfig] = useState<CloudConfig | null>(null);
  const stackPrefix = cloudConfig?.stackPrefix ?? "";
  const cognitoConfig: Partial<CognitoConfig> = cloudConfig
    ? {
        userPoolId: cloudConfig.userPoolId,
        userPoolClientId: cloudConfig.userPoolClientId,
        identityPoolId: cloudConfig.identityPoolId,
      }
    : {};

  // Session state — lives in localStorage, not in the config file.
  const [signInResult, setSignInResult] = useState<{ idToken: string; refreshToken: string } | null>(null);
  const [credentials, setCredentials] = useState<STSCredentials | null>(null);

  const refreshCloudConfig = useCallback(async () => {
    const cfg = await readCloudConfig();
    setCloudConfig(cfg);
  }, []);

  // Mark a step done and optionally advance
  const markDone = useCallback((step: StepId, advance = true) => {
    setCompletedSteps((prev) => {
      const next = new Set(prev);
      next.add(step);
      return next;
    });
    if (advance) setCurrentStep((step + 1) as StepId);
  }, []);

  const handleNavigate = useCallback((targetStep: StepId) => {
    if (targetStep <= 4) {
      setSignInResult(null);
      setCredentials(null);
      setCompletedSteps((prev) => {
        const next = new Set(prev);
        next.delete(4);
        next.delete(5);
        return next;
      });
    }
    setCurrentStep(targetStep);
  }, []);

  // On mount: read the file + cognito session, derive starting step.
  useEffect(() => {
    async function restore() {
      const cfg = await readCloudConfig();
      setCloudConfig(cfg);

      const done = new Set<StepId>();
      if (cfg?.stackPrefix) done.add(1);
      const hasCognito = !!(cfg?.userPoolId && cfg?.userPoolClientId && cfg?.identityPoolId);
      if (hasCognito) done.add(2);

      // Step 3 (create user) leaves no persistent state — it's "done" iff we
      // have a refresh token, since you can't sign in until the user exists.
      const session = await readCognitoSession();
      if (cfg && hasCognito && session?.refreshToken) {
        try {
          const tokens = await refreshTokens(cfg.cognitoConfig, session.refreshToken);
          const creds = await getIdentityPoolCredentials(cfg.cognitoConfig, tokens.idToken);
          setSignInResult({ idToken: tokens.idToken, refreshToken: tokens.refreshToken });
          setCredentials(creds);
          await writeCognitoSession({ ...session, refreshToken: tokens.refreshToken });
          done.add(3);
          done.add(4);
        } catch {
          // Token expired — user will need to re-sign in.
        }
      }

      if (cfg?.s3Bucket && cfg?.auroraEndpoint) done.add(5);

      setCompletedSteps(done);

      const firstIncomplete = ([1, 2, 3, 4, 5] as StepId[]).find((s) => !done.has(s));
      setCurrentStep(firstIncomplete ?? 5);
      setResuming(false);
    }

    restore();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const fullCognitoConfig = (): CognitoConfig | null => {
    if (!cloudConfig) return null;
    return cloudConfig.cognitoConfig;
  };

  const handleComplete = (_result: DeployOutputs) => {
    if (!signInResult || !credentials) return;
    // The install route already wrote the deploy outputs to starkeep-config.json.
    // The wizard has nothing else to persist.
    if (onComplete) {
      onComplete();
    } else {
      router.push("/");
    }
  };

  if (resuming) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
        <div className="size-4 animate-spin rounded-full border-2 border-border border-t-foreground" />
        Resuming session…
      </div>
    );
  }

  const stepTitles: Record<StepId, string> = {
    1: "Bootstrap Stack",
    2: "Stack Outputs",
    3: "Create User",
    4: "Sign In",
    5: "Deploy Starkeep cloud",
  };

  const cogCfg = fullCognitoConfig();

  return (
    <div className="flex gap-6 min-h-[400px]">
      {/* ToC */}
      <div className="w-48 shrink-0">
        <p className="px-3 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Steps</p>
        <StepToC
          currentStep={currentStep}
          completedSteps={completedSteps}
          onNavigate={handleNavigate}
        />
      </div>

      <Separator orientation="vertical" />

      {/* Step content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-5">
          <h2 className="text-base font-semibold">{stepTitles[currentStep]}</h2>
          {completedSteps.has(currentStep) && currentStep !== 5 && (
            <Badge variant="secondary" className="text-xs">Completed</Badge>
          )}
        </div>

        {currentStep === 1 && (
          <Step1Bootstrap
            initialStackPrefix={stackPrefix}
            initialRegion={cloudConfig?.userPoolId ? regionFromUserPoolId(cloudConfig.userPoolId) : ""}
            onContinue={async (prefix) => {
              const isChanging = !!cloudConfig?.stackPrefix && cloudConfig.stackPrefix !== prefix;
              const hasDownstream = !!cloudConfig?.userPoolId;
              if (isChanging && hasDownstream) {
                const confirmed = window.confirm(
                  `Changing the stack prefix will clear stack outputs and all later configuration. Continue?`,
                );
                if (!confirmed) return;
                const updated = await patchCloudConfig({
                  stackPrefix: prefix,
                  stage: prefix,
                  userPoolId: null, userPoolClientId: null, identityPoolId: null,
                  accountId: null, permissionsBoundaryArn: null,
                  foundationalPermissionsBoundaryArn: null,
                  userDataOwnerPermissionsBoundaryArn: null, managerRoleArn: null,
                  installDdlRoleArn: null,
                  pulumiStateBucket: null, s3Bucket: null, auroraEndpoint: null,
                  apiGatewayUrl: null, apiGatewayId: null, authorizerId: null,
                });
                setCloudConfig(updated);
                setSignInResult(null);
                setCredentials(null);
                setCompletedSteps(new Set());
              } else {
                const updated = await patchCloudConfig({ stackPrefix: prefix, stage: prefix });
                setCloudConfig(updated);
              }
              markDone(1);
            }}
          />
        )}

        {currentStep === 2 && (
          <Step2Outputs
            stackPrefix={stackPrefix}
            initialCognitoConfig={cognitoConfig}
            onContinue={async (config) => {
              const isChanging = !!cloudConfig?.userPoolId && cloudConfig.userPoolId !== config.userPoolId;
              const hasDownstream = !!(cloudConfig?.s3Bucket || cloudConfig?.apiGatewayUrl);
              if (isChanging && hasDownstream) {
                const confirmed = window.confirm(
                  `Changing the Cognito configuration will clear deployment outputs and require re-signing in. Continue?`,
                );
                if (!confirmed) return;
                const updated = await patchCloudConfig({
                  userPoolId: config.userPoolId,
                  userPoolClientId: config.userPoolClientId,
                  identityPoolId: config.identityPoolId,
                  s3Bucket: null, auroraEndpoint: null,
                  apiGatewayUrl: null, apiGatewayId: null, authorizerId: null,
                });
                setCloudConfig(updated);
                setSignInResult(null);
                setCredentials(null);
                setCompletedSteps((prev) => {
                  const next = new Set(prev);
                  ([3, 4, 5] as StepId[]).forEach((s) => next.delete(s));
                  return next;
                });
              } else {
                const updated = await patchCloudConfig({
                  userPoolId: config.userPoolId,
                  userPoolClientId: config.userPoolClientId,
                  identityPoolId: config.identityPoolId,
                });
                setCloudConfig(updated);
              }
              markDone(2);
            }}
            onBack={() => handleNavigate(1)}
          />
        )}

        {currentStep === 3 && (
          <Step3CreateUser
            cognitoConfig={cognitoConfig}
            onContinue={() => markDone(3)}
            onBack={() => handleNavigate(2)}
          />
        )}

        {currentStep === 4 && cogCfg && (
          <Step4SignIn
            cognitoConfig={cogCfg}
            onSuccess={async (tokens, creds, userEmail) => {
              setSignInResult(tokens);
              setCredentials(creds);
              await writeCognitoSession({ refreshToken: tokens.refreshToken, userEmail: userEmail ?? undefined });
              await writeCloudCredentials(creds);
              markDone(4);
            }}
            onBack={() => handleNavigate(3)}
          />
        )}

        {currentStep === 5 && credentials && signInResult && cogCfg && (
          <Step5Deploy
            credentials={credentials}
            refreshCredentials={async () => {
              if (!signInResult.refreshToken) return null;
              const tokens = await refreshTokens(cogCfg, signInResult.refreshToken);
              const fresh = await getIdentityPoolCredentials(cogCfg, tokens.idToken);
              setSignInResult({ idToken: tokens.idToken, refreshToken: tokens.refreshToken });
              setCredentials(fresh);
              await pushAuthToLocalDataServer({ idToken: tokens.idToken, refreshToken: tokens.refreshToken });
              const userEmail = extractEmailFromIdToken(tokens.idToken);
              await writeCognitoSession({ refreshToken: tokens.refreshToken, userEmail: userEmail ?? undefined });
              await writeCloudCredentials(fresh);
              return fresh;
            }}
            cloudConfig={cloudConfig}
            refreshCloudConfig={refreshCloudConfig}
            signInRefreshToken={signInResult.refreshToken}
            signInUserEmail={extractEmailFromIdToken(signInResult.idToken)}
            onSuccess={handleComplete}
            onBack={() => handleNavigate(4)}
            onTokenExpired={() => handleNavigate(4)}
          />
        )}

        {currentStep === 5 && (!credentials || !signInResult) && (
          <div className="flex flex-col gap-4">
            <Alert variant="destructive">
              <AlertDescription>
                You need to sign in before deploying. Please complete step 4 first.
              </AlertDescription>
            </Alert>
            <Button variant="outline" onClick={() => handleNavigate(4)}>Go to Sign In</Button>
          </div>
        )}
      </div>
    </div>
  );
}
