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
import { cn } from "@/lib/utils";
import {
  generateBootstrapTemplate,
  getCloudFormationCreateStackUrl,
  getBootstrapStackOutputsUrl,
} from "@starkeep/admin-core";
import {
  writeCloudConfig,
  writeCloudCredentials,
  type CloudConfig,
} from "../lib/cloud-config";
import {
  initiateAuth,
  respondNewPasswordChallenge,
  refreshTokens,
  getIdentityPoolCredentials,
  type CognitoConfig,
  type STSCredentials,
} from "../lib/cognito-auth";

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

const STORAGE_KEY = "starkeep-cloud-setup";

interface PersistedSetup {
  stackPrefix?: string;
  userPoolId?: string;
  userPoolClientId?: string;
  identityPoolId?: string;
  refreshToken?: string;
  step3Done?: boolean;
}

function loadPersisted(): PersistedSetup {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as PersistedSetup) : {};
  } catch {
    return {};
  }
}

function savePersisted(patch: Partial<PersistedSetup>) {
  try {
    const existing = loadPersisted();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...existing, ...patch }));
  } catch { /* ignore */ }
}

function clearPersistedFrom(step: StepId) {
  try {
    const existing = loadPersisted();
    if (step <= 1) delete existing.stackPrefix;
    if (step <= 2) {
      delete existing.userPoolId;
      delete existing.userPoolClientId;
      delete existing.identityPoolId;
    }
    if (step <= 3) delete existing.step3Done;
    if (step <= 4) delete existing.refreshToken;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(existing));
  } catch { /* ignore */ }
}

function regionFromUserPoolId(userPoolId: string): string {
  const parts = userPoolId.split("_");
  return parts.length > 1 ? parts[0] : "us-east-1";
}

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
  onContinue,
}: {
  onContinue: (stackPrefix: string) => void;
}) {
  const [region, setRegion] = useState("us-east-1");
  const [stackPrefix, setStackPrefix] = useState("starkeep");
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
  const region = regionFromUserPoolId(userPoolId) || "us-east-1";

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">
        Open the CloudFormation stack <strong>Outputs</strong> tab and copy the three values below.
      </p>

      <Button
        variant="outline"
        size="sm"
        className="w-fit"
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

      <Alert>
        <AlertDescription>
          These values are the same across all your devices. After completing setup on this device,
          use <strong>Settings → Export Cloud Config</strong> to share the configuration with other
          devices — they will skip this step and go straight to sign in.
        </AlertDescription>
      </Alert>

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
  onSuccess: (tokens: { idToken: string; refreshToken: string }, creds: STSCredentials) => void;
  onBack: () => void;
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
        const creds = await getIdentityPoolCredentials(cognitoConfig, result.tokens.idToken);
        onSuccess({ idToken: result.tokens.idToken, refreshToken: result.tokens.refreshToken }, creds);
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
      onSuccess({ idToken: tokens.idToken, refreshToken: tokens.refreshToken }, creds);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  if (session) {
    return (
      <div className="flex flex-col gap-5">
        <p className="text-sm text-muted-foreground">
          Your temporary password has expired. Please set a new permanent password.
        </p>
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
            disabled={loading || !newPassword || newPassword.length < 8}
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
        <Button onClick={handleSignIn} disabled={loading || !email || !password}>
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

function Step5Deploy({
  cognitoConfig,
  stackPrefix,
  credentials,
  onSuccess,
  onBack,
}: {
  cognitoConfig: CognitoConfig;
  stackPrefix: string;
  credentials: STSCredentials;
  onSuccess: (result: DeployOutputs) => void;
  onBack: () => void;
}) {
  const [installing, setInstalling] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [status, setStatus] = useState<"idle" | "running" | "success" | "failure">("idle");
  const [deployResult, setDeployResult] = useState<DeployOutputs | null>(null);
  const [showManualEntry, setShowManualEntry] = useState(false);
  const [manualBucket, setManualBucket] = useState("");
  const [manualAurora, setManualAurora] = useState("");
  const [manualApi, setManualApi] = useState("");
  const [readConfigError, setReadConfigError] = useState<string | null>(null);
  const [readingConfig, setReadingConfig] = useState(false);

  const region = cognitoConfig.region;

  function handleInstall() {
    setInstalling(true);
    setLines([]);
    setStatus("running");
    setReadConfigError(null);
    let aborted = false;

    async function run() {
      try {
        const resp = await fetch("/api/cloud-data-server/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            accessKeyId: credentials.accessKeyId,
            secretAccessKey: credentials.secretAccessKey,
            sessionToken: credentials.sessionToken,
          }),
        });

        if (!resp.ok || !resp.body) {
          let errMsg = `${resp.status} ${resp.statusText}`;
          try {
            const j = (await resp.json()) as { error?: string };
            if (j.error) errMsg = j.error;
          } catch { /* not JSON */ }
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
                const outputs = JSON.parse(data) as {
                  auroraHostname: string;
                  bucketName: string;
                  apiGatewayUrl: string;
                  region: string;
                };
                const result: DeployOutputs = {
                  s3Bucket: outputs.bucketName,
                  s3Region: outputs.region,
                  auroraEndpoint: outputs.auroraHostname,
                  apiGatewayUrl: outputs.apiGatewayUrl,
                };
                setDeployResult(result);
                setStatus("success");
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
      } finally {
        setInstalling(false);
      }
    }

    run();
    return () => { aborted = true; };
  }

  async function handleAlreadyInstalled() {
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
  }

  function handleManualSubmit() {
    if (!manualBucket || !manualAurora) return;
    onSuccess({
      s3Bucket: manualBucket.trim(),
      s3Region: region,
      auroraEndpoint: manualAurora.trim(),
      apiGatewayUrl: manualApi.trim() || undefined,
    });
  }

  if (showManualEntry) {
    return (
      <div className="flex flex-col gap-5">
        <p className="text-sm font-medium">Enter deployment outputs manually</p>
        <p className="text-sm text-muted-foreground">Find these values in the AWS console — the infrastructure was deployed successfully.</p>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">S3 Bucket Name</label>
            <Input
              placeholder="starkeep-files-starkeep-abc123"
              value={manualBucket}
              onChange={(e) => setManualBucket(e.currentTarget.value)}
            />
            <p className="text-xs text-muted-foreground">S3 console → find the bucket starting with your stack prefix</p>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">Aurora DSQL Hostname</label>
            <Input
              placeholder="abc123.dsql.us-east-1.on.aws"
              value={manualAurora}
              onChange={(e) => setManualAurora(e.currentTarget.value)}
            />
            <p className="text-xs text-muted-foreground">Aurora DSQL console → your cluster → copy the endpoint hostname</p>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">API Gateway URL <span className="text-muted-foreground font-normal">(optional)</span></label>
            <Input
              placeholder="https://abc123.execute-api.us-east-1.amazonaws.com"
              value={manualApi}
              onChange={(e) => setManualApi(e.currentTarget.value)}
            />
          </div>
        </div>
        <div className="flex justify-between">
          <Button variant="ghost" onClick={() => setShowManualEntry(false)}>Back</Button>
          <Button onClick={handleManualSubmit} disabled={!manualBucket || !manualAurora}>Continue</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <p className="text-sm text-muted-foreground">
          Install the <strong>cloud-data-server</strong> built-in app. This provisions:
        </p>
        <ul className="text-sm text-muted-foreground flex flex-col gap-0.5 pl-4">
          <li>• Aurora DSQL cluster for shared metadata</li>
          <li>• S3 bucket for file storage</li>
          <li>• Lambda function + API Gateway with Cognito JWT authorizer</li>
          <li>• Shared-schema migrations applied under the installer PG role</li>
        </ul>
      </div>

      {status === "idle" && !deployResult && (
        <Button onClick={handleInstall} disabled={installing}>
          Install cloud-data-server
        </Button>
      )}

      {(status !== "idle" || lines.length > 0) && (
        <CommandOutput lines={lines} status={status} />
      )}

      {deployResult && status === "success" && (
        <>
          <Alert>
            <AlertDescription className="flex flex-col gap-2">
              <span>cloud-data-server is installed in your AWS account.</span>
              <Button
                variant="outline"
                size="sm"
                className="w-fit"
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
            </AlertDescription>
          </Alert>
          <div className="flex justify-end">
            <Button onClick={() => onSuccess(deployResult)}>Continue →</Button>
          </div>
        </>
      )}

      {status === "failure" && (
        <Button onClick={handleInstall} variant="outline">Retry install</Button>
      )}

      {readConfigError && (
        <Alert variant="destructive">
          <AlertDescription>{readConfigError}</AlertDescription>
        </Alert>
      )}

      {status === "idle" && !deployResult && (
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={handleAlreadyInstalled} disabled={readingConfig}>
            {readingConfig && <span className="mr-1 size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />}
            Already installed
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setShowManualEntry(true)}>
            Enter outputs manually
          </Button>
        </div>
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

  // Step data (in-memory)
  const [stackPrefix, setStackPrefix] = useState("starkeep");
  const [cognitoConfig, setCognitoConfig] = useState<Partial<CognitoConfig>>({});
  const [signInResult, setSignInResult] = useState<{ idToken: string; refreshToken: string } | null>(null);
  const [credentials, setCredentials] = useState<STSCredentials | null>(null);

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
    if (targetStep >= currentStep) {
      setCurrentStep(targetStep);
      return;
    }

    const stepLabel = STEPS.find((s) => s.id === targetStep)?.label ?? `Step ${targetStep}`;
    const confirmed = window.confirm(
      `Going back to "${stepLabel}" will clear all progress from that step onward. This cannot be undone. Continue?`
    );
    if (!confirmed) return;

    clearPersistedFrom(targetStep);

    if (targetStep <= 1) setStackPrefix("starkeep");
    if (targetStep <= 2) setCognitoConfig({});
    if (targetStep <= 4) {
      setSignInResult(null);
      setCredentials(null);
    }

    setCompletedSteps((prev) => {
      const next = new Set(prev);
      ([1, 2, 3, 4, 5] as StepId[]).forEach((s) => {
        if (s >= targetStep) next.delete(s);
      });
      return next;
    });

    setCurrentStep(targetStep);
  }, [currentStep]);

  // On mount: restore persisted state and determine starting step
  useEffect(() => {
    async function restore() {
      const saved = loadPersisted();

      if (saved.stackPrefix) setStackPrefix(saved.stackPrefix);

      const hasCognito = !!(saved.userPoolId && saved.userPoolClientId && saved.identityPoolId);
      if (hasCognito) {
        setCognitoConfig({
          userPoolId: saved.userPoolId,
          userPoolClientId: saved.userPoolClientId,
          identityPoolId: saved.identityPoolId,
        });
      }

      const done = new Set<StepId>();
      if (saved.stackPrefix) done.add(1);
      if (hasCognito) done.add(2);
      if (saved.step3Done) done.add(3);

      // Try to refresh tokens if we have a refresh token
      if (saved.refreshToken && hasCognito) {
        try {
          const cogCfg: CognitoConfig = {
            userPoolId: saved.userPoolId!,
            userPoolClientId: saved.userPoolClientId!,
            identityPoolId: saved.identityPoolId!,
            region: regionFromUserPoolId(saved.userPoolId!),
          };
          const tokens = await refreshTokens(cogCfg, saved.refreshToken);
          const creds = await getIdentityPoolCredentials(cogCfg, tokens.idToken);
          setSignInResult({ idToken: tokens.idToken, refreshToken: tokens.refreshToken });
          setCredentials(creds);
          done.add(4);
        } catch {
          // Token expired — user will need to re-sign in
        }
      }

      setCompletedSteps(done);

      // Start from the first incomplete step (or step 5 if all done)
      const firstIncomplete = ([1, 2, 3, 4, 5] as StepId[]).find((s) => !done.has(s));
      setCurrentStep(firstIncomplete ?? 5);
      setResuming(false);
    }

    restore();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const fullCognitoConfig = (): CognitoConfig => ({
    userPoolId: cognitoConfig.userPoolId ?? "",
    userPoolClientId: cognitoConfig.userPoolClientId ?? "",
    identityPoolId: cognitoConfig.identityPoolId ?? "",
    region: cognitoConfig.userPoolId ? regionFromUserPoolId(cognitoConfig.userPoolId) : "us-east-1",
  });

  const handleComplete = (result: DeployOutputs) => {
    if (!signInResult || !credentials) return;

    async function finish() {
      const config: CloudConfig = {
        stackPrefix,
        s3Bucket: result.s3Bucket,
        s3Region: result.s3Region,
        auroraEndpoint: result.auroraEndpoint,
        apiGatewayUrl: result.apiGatewayUrl,
        cognitoConfig: fullCognitoConfig(),
        cognitoRefreshToken: signInResult!.refreshToken,
      };
      await writeCloudConfig(config);
      await writeCloudCredentials(credentials!);
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
      localStorage.removeItem(STORAGE_KEY);

      if (onComplete) {
        onComplete();
      } else {
        router.push("/");
      }
    }

    finish();
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
    5: "Deploy cloud-data-server",
  };

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
            onContinue={(prefix) => {
              setStackPrefix(prefix);
              savePersisted({ stackPrefix: prefix });
              markDone(1);
            }}
          />
        )}

        {currentStep === 2 && (
          <Step2Outputs
            stackPrefix={stackPrefix}
            initialCognitoConfig={cognitoConfig}
            onContinue={(config) => {
              setCognitoConfig(config);
              savePersisted({
                userPoolId: config.userPoolId,
                userPoolClientId: config.userPoolClientId,
                identityPoolId: config.identityPoolId,
              });
              markDone(2);
            }}
            onBack={() => handleNavigate(1)}
          />
        )}

        {currentStep === 3 && (
          <Step3CreateUser
            cognitoConfig={cognitoConfig}
            onContinue={() => {
              savePersisted({ step3Done: true });
              markDone(3);
            }}
            onBack={() => handleNavigate(2)}
          />
        )}

        {currentStep === 4 && (
          <Step4SignIn
            cognitoConfig={fullCognitoConfig()}
            onSuccess={(tokens, creds) => {
              setSignInResult(tokens);
              setCredentials(creds);
              savePersisted({ refreshToken: tokens.refreshToken });
              markDone(4);
            }}
            onBack={() => handleNavigate(3)}
          />
        )}

        {currentStep === 5 && credentials && signInResult && (
          <Step5Deploy
            cognitoConfig={fullCognitoConfig()}
            stackPrefix={stackPrefix}
            credentials={credentials}
            onSuccess={handleComplete}
            onBack={() => handleNavigate(4)}
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
