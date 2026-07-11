"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { Check, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  MAX_STACK_PREFIX_LENGTH,
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
import { localDataServerUrl } from "../lib/runtime-config";

async function isLocalDataServerOnline(): Promise<boolean> {
  try {
    const base = await localDataServerUrl();
    const resp = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) });
    return resp.ok;
  } catch {
    return false;
  }
}

async function pushAuthToLocalDataServer(tokens: { idToken: string; refreshToken: string }): Promise<void> {
  const base = await localDataServerUrl();
  const resp = await fetch(`${base}/auth/tokens`, {
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

const AWS_REGIONS: { slug: string; label: string }[] = [
  { slug: "us-east-1", label: "US East (N. Virginia)" },
  { slug: "us-east-2", label: "US East (Ohio)" },
  { slug: "us-west-2", label: "US West (Oregon)" },
  { slug: "ap-northeast-3", label: "Asia Pacific (Osaka)" },
  { slug: "ap-northeast-1", label: "Asia Pacific (Tokyo)" },
  { slug: "ap-northeast-2", label: "Asia Pacific (Seoul)" },
  { slug: "eu-west-1", label: "Europe (Ireland)" },
  { slug: "eu-west-2", label: "Europe (London)" },
  { slug: "eu-west-3", label: "Europe (Paris)" },
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
  onContinue: (stackPrefix: string, region: string) => void;
}) {
  // Step 1's region exists only to construct the CloudFormation console URL
  // and the bootstrap template's stack name. It is not persisted: once Step 2
  // captures the userPoolId, region is derived from that going forward.
  const [region, setRegion] = useState(initialRegion || "us-east-1");
  const [stackPrefix, setStackPrefix] = useState(initialStackPrefix || "starkeep");
  const [downloaded, setDownloaded] = useState(false);
  const [showInstructions, setShowInstructions] = useState(false);
  const downloadStepRef = useRef<HTMLDivElement>(null);

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
        Starkeep cloud runs in your own AWS account. Don&apos;t worry, setup is quick and painless.
      </p>

      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium" htmlFor="region">AWS Region</label>
          <Select value={region} onValueChange={setRegion}>
            <SelectTrigger id="region" className="w-full">
              <SelectValue placeholder="Select a region" />
            </SelectTrigger>
            <SelectContent>
              {AWS_REGIONS.map(({ slug, label }) => (
                <SelectItem key={slug} value={slug}>
                  {label} ({slug})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">The AWS region where your Starkeep infrastructure will be deployed.</p>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium" htmlFor="stackPrefix">Stack prefix</label>
          <Input
            id="stackPrefix"
            placeholder="starkeep"
            value={stackPrefix}
            maxLength={MAX_STACK_PREFIX_LENGTH}
            onChange={(e) => setStackPrefix(e.currentTarget.value.toLowerCase())}
          />
          <p className="text-xs text-muted-foreground">A short name used to prefix all Starkeep resources. Lowercase letters, numbers, and hyphens only ({MAX_STACK_PREFIX_LENGTH} chars max).</p>
        </div>
      </div>

      <Separator />

      <div className="flex flex-col gap-3">
        <div ref={downloadStepRef} className="flex flex-col gap-1.5 scroll-mt-4">
          <p className="text-sm font-medium">1. Download the bootstrap template</p>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
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
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setShowInstructions(true);
              openUrl(getCloudFormationCreateStackUrl(region, { stackName: `${stackPrefix}-bootstrap` }));
              requestAnimationFrame(() => {
                downloadStepRef.current?.scrollIntoView({ block: "start" });
              });
            }}
            disabled={!region}
            className="w-fit"
          >
            Open CloudFormation console ↗
          </Button>
        </div>
      </div>

      {!showInstructions ? (
        <button
          type="button"
          onClick={() => setShowInstructions(true)}
          className="text-sm font-medium text-primary hover:underline w-fit"
        >
          Show full instructions
        </button>
      ) : (
        <Alert className="p-5">
          <AlertDescription className="block space-y-3 text-sm text-foreground">
            <h4 className="text-base font-semibold text-foreground">AWS Setup Walkthrough</h4>

            <p>
              Starkeep Cloud runs on your own AWS account, so a <strong>one-time</strong> setup is
              required. This usually takes about 5 minutes to complete.
            </p>

            <p>
              First, click the <strong>Open CloudFormation console</strong> button just above. This
              links to AWS.
            </p>

            <p>
              Unless you’re already signed in to AWS, click <strong>Create a new AWS account</strong>{" "}
              (or <strong>Sign in as root user email</strong> if you already have an AWS account you
              want to use).
            </p>

            <p>
              After signing in, you should be on the <strong>Create Stack</strong> page. If you’re
              not, just click the <strong>Open CloudFormation console</strong> button (above) again
              and it will take you to the right place. Then follow these steps:
            </p>

            <ol className="list-decimal space-y-1.5 pl-5">
              <li>
                Under <strong>Specify template</strong> (2nd section), select{" "}
                <strong>Upload a template file</strong>
              </li>
              <li>
                Click <strong>Choose file</strong> and select the template .yaml file downloaded from
                Starkeep Setup
              </li>
              <li>
                Click <strong>Next</strong>
              </li>
              <li>
                Click <strong>Next</strong> again without modifying the values (these are preset based
                on your input during Starkeep Setup)
              </li>
              <li>
                When the next page loads, scroll to the bottom and check the checkbox “
                <strong>
                  I acknowledge that AWS CloudFormation might create IAM resources with custom names.
                </strong>
                ”
              </li>
              <li>
                Click <strong>Next</strong>
              </li>
              <li>
                Scroll to the bottom of the final page and click <strong>Submit</strong>.
              </li>
              <li>
                Click on the <strong>Outputs</strong> tab. It will say “No outputs” at first, but once
                the stack finishing deploying (take about a minute) you will see various properties
                show up.
              </li>
              <li>
                Once you see Outputs properties show up, go back to your Starkeep Cloud Setup tab and click{" "}
                <strong>Stack is deployed - Continue</strong>.
              </li>
            </ol>

            <button
              type="button"
              onClick={() => setShowInstructions(false)}
              className="text-sm font-medium text-primary hover:underline"
            >
              Hide instructions
            </button>
          </AlertDescription>
        </Alert>
      )}

      <div className="flex justify-end">
        <Button onClick={() => onContinue(stackPrefix, region)} disabled={!canContinue}>
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
  fallbackRegion,
  initialCognitoConfig,
  onContinue,
  onBack,
}: {
  stackPrefix: string;
  fallbackRegion: string;
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
  const region = regionFromUserPoolId(userPoolId) || fallbackRegion;

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">
        Open the{" "}
        {region ? (
          <a
            href={getBootstrapStackOutputsUrl(region, `${stackPrefix}-bootstrap`)}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-primary underline hover:no-underline"
          >
            CloudFormation stack
          </a>
        ) : (
          "CloudFormation stack"
        )}{" "}
        <strong>Outputs</strong> tab and copy the three values below.
      </p>

      <p className="text-sm text-muted-foreground">The outputs are listed in alphabetical order.</p>

      <div className="flex flex-col gap-4">
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
  const [showInstructions, setShowInstructions] = useState(false);
  const region = cognitoConfig.userPoolId ? regionFromUserPoolId(cognitoConfig.userPoolId) : "us-east-1";
  const consoleLink = cognitoConfig.userPoolId
    ? `https://${region}.console.aws.amazon.com/cognito/v2/idp/user-pools/${cognitoConfig.userPoolId}/users/create`
    : null;

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">
        Next, you&rsquo;ll create your Starkeep Cloud user account. This user exists within your own
        AWS account. No one else (including the Starkeep Org) has access.
      </p>

      {consoleLink ? (
        <>
          <Button
            variant="secondary"
            size="sm"
            className="w-fit"
            onClick={() => {
              setShowInstructions(true);
              openUrl(consoleLink);
            }}
          >
            Create user ↗
          </Button>

          {!showInstructions ? (
            <button
              type="button"
              onClick={() => setShowInstructions(true)}
              className="text-sm font-medium text-primary hover:underline w-fit"
            >
              Show full instructions
            </button>
          ) : (
            <Alert className="p-5">
              <AlertDescription className="block space-y-3 text-sm text-foreground">
                <p>Make sure you&rsquo;re signed into your AWS account, then:</p>

                <ol className="list-decimal space-y-1.5 pl-5">
                  <li>
                    Click <strong>Create User</strong>
                  </li>
                  <li>
                    Under <strong>User Information / Invitation message</strong>, choose{" "}
                    <strong>Send an email invitation</strong>
                  </li>
                  <li>Enter your email address</li>
                  <li>
                    Under <strong>Temporary password</strong>, choose{" "}
                    <strong>Generate a password</strong>
                  </li>
                  <li>
                    Click <strong>Create user</strong>
                  </li>
                  <li>
                    Within a minute you should receive an email with the temporary password
                    <p className="mt-1.5">
                      Please note: the email from AWS says: “Your temporary password is{" "}
                      &lt;password&gt;.” The period at the end of this sentence is NOT part of your
                      temp password.
                    </p>
                  </li>
                  <li>
                    Click <strong>User created - Continue</strong>.
                  </li>
                </ol>

                <button
                  type="button"
                  onClick={() => setShowInstructions(false)}
                  className="text-sm font-medium text-primary hover:underline"
                >
                  Hide instructions
                </button>
              </AlertDescription>
            </Alert>
          )}
        </>
      ) : (
        <Alert>
          <AlertDescription>UserPoolId not set — go back and enter outputs.</AlertDescription>
        </Alert>
      )}

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
        <span className="flex items-center gap-2">
          <TriangleAlert className="size-4 shrink-0" />
          You must start your local data server to continue cloud setup.
        </span>
        <Button size="sm" onClick={handleStartServer} disabled={serverStarting}>
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
            <label className="text-sm font-medium" htmlFor="starkeep-new-password">New password</label>
            <Input
              id="starkeep-new-password"
              name="starkeep-new-password"
              type="password"
              autoComplete="new-password"
              placeholder="At least 8 characters"
              value={newPassword}
              onChange={(e) => setNewPassword(e.currentTarget.value)}
              disabled={loading}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium" htmlFor="starkeep-confirm-password">Confirm new password</label>
            <Input
              id="starkeep-confirm-password"
              name="starkeep-confirm-password"
              type="password"
              autoComplete="new-password"
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
        You should receive an email &ldquo;Your Starkeep account&rdquo; with a temp password.
      </p>
      {serverGate}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium" htmlFor="starkeep-signin-email">Email</label>
          <Input
            id="starkeep-signin-email"
            name="starkeep-signin-email"
            type="text"
            inputMode="email"
            autoComplete="off"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.currentTarget.value)}
            disabled={loading}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium" htmlFor="starkeep-temp-password">Password</label>
          <Input
            id="starkeep-temp-password"
            name="starkeep-temp-password"
            type="password"
            autoComplete="new-password"
            placeholder="Shown in the email you received, or already set by you"
            value={password}
            onChange={(e) => setPassword(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleSignIn(); }}
            disabled={loading}
          />
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
  publicBaseUrl?: string;
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
            publicBaseUrl?: string;
          };
          result = {
            s3Bucket: outputs.bucketName,
            auroraEndpoint: outputs.auroraHostname,
            apiGatewayUrl: outputs.apiGatewayUrl,
            publicBaseUrl: outputs.publicBaseUrl,
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

        // Both passes succeeded. The installer rewrote ~/.starkeep/config.json
        // with the new cloud outputs, but the local-data-server only reads
        // CLOUD_URL / builds its sync supervisor at boot — so bounce it once,
        // now, after the *whole* deploy. Doing it here (rather than inside a
        // pass's install route) means the daemon reboots exactly once, against a
        // fully-provisioned cloud, with no restart racing the next pass's auth
        // refresh. Best-effort: the deploy has already succeeded, so a failed
        // restart is a warning, not a failure.
        try {
          const resp = await fetch("/api/exec/daemon", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "restart", id: "local-data-server" }),
          });
          const body = (await resp.json().catch(() => ({}))) as { restarted?: boolean; error?: string };
          if (resp.ok && body.restarted) {
            setLines((l) => [...l, "", "[Restarted local-data-server to apply new cloud config]"]);
          } else if (!resp.ok) {
            setLines((l) => [...l, `[Warning: could not restart local-data-server: ${body.error ?? resp.statusText}]`]);
          }
        } catch (err) {
          setLines((l) => [...l, `[Warning: could not restart local-data-server: ${err instanceof Error ? err.message : String(err)}]`]);
        }

        // Re-read the config so the status card sees the just-written
        // s3Bucket / auroraEndpoint / apiGatewayUrl.
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
  // Region chosen in step 1. Not persisted to cloud config (once a userPoolId
  // is captured, region is derived from it), but kept here so step 2 can build
  // the stack-outputs console link before any userPoolId has been entered.
  const [bootstrapRegion, setBootstrapRegion] = useState("");
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
            onContinue={async (prefix, region) => {
              setBootstrapRegion(region);
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
                  apiGatewayUrl: null, publicBaseUrl: null, apiGatewayId: null, authorizerId: null,
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
            fallbackRegion={bootstrapRegion}
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
                  apiGatewayUrl: null, publicBaseUrl: null, apiGatewayId: null, authorizerId: null,
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
              // Notifying the local daemon is a side-benefit, not part of minting
              // credentials — and it races with the daemon restart that pass 1's
              // installer fires right before pass 2 calls this. If the daemon is
              // mid-restart the fetch throws ECONNREFUSED; swallowing it here keeps
              // that transient failure from bubbling up as a null "session expired"
              // and aborting the deploy. The daemon refreshes its own auth anyway.
              try {
                await pushAuthToLocalDataServer({ idToken: tokens.idToken, refreshToken: tokens.refreshToken });
              } catch (err) {
                console.warn("[cloud-setup] could not push refreshed auth to local-data-server (continuing):", err);
              }
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
