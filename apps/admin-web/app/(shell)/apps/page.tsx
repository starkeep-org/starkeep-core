"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  readPhotosWebPath,
  writePhotosWebPath,
  readFileBrowserPath,
  writeFileBrowserPath,
  readCloudConfig,
  readCloudCredentials,
  writeCloudCredentials,
  readCognitoSession,
  writeCognitoSession,
} from "../../../src/lib/cloud-config";
import { refreshTokens, getIdentityPoolCredentials } from "../../../src/lib/cognito-auth";

export default function AppsPage() {
  return (
    <div className="max-w-3xl flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Apps</h1>
      <PhotosWebSection />
      <FileBrowserSection />
    </div>
  );
}

async function readFileBrowserInstallStream(
  fileBrowserPath: string,
  onLine: (line: string) => void,
): Promise<{ port: number; pid: number }> {
  const res = await fetch("/api/file-browser/install", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileBrowserPath }),
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
      if (eventType === "done") return JSON.parse(dataLine) as { port: number; pid: number };
      else if (eventType === "error") throw new Error(JSON.parse(dataLine) as string);
      else onLine(JSON.parse(dataLine) as string);
    }
  }
  throw new Error("Install stream ended without a done event");
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
      if (eventType === "done") return JSON.parse(dataLine) as { port: number; pid: number };
      else if (eventType === "error") throw new Error(JSON.parse(dataLine) as string);
      else onLine(JSON.parse(dataLine) as string);
    }
  }
  throw new Error("Install stream ended without a done event");
}

function FileBrowserSection() {
  const [path, setPath] = useState("");
  const [installing, setInstalling] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [running, setRunning] = useState<boolean | null>(null);
  const [port, setPort] = useState<number | null>(null);
  const [installLog, setInstallLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    readFileBrowserPath().then((saved) => { if (saved) setPath(saved); });
    checkStatus();
  }, []);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [installLog]);

  const checkStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/exec/daemon/status?id=file-browser");
      if (res.ok) {
        const data = await res.json() as { running: boolean; port?: number };
        setRunning(data.running); setPort(data.port ?? null);
      }
    } catch { setRunning(false); setPort(null); }
  }, []);

  const handleInstall = async () => {
    if (!path.trim()) return;
    setInstalling(true); setError(null); setSuccess(false); setInstallLog([]);
    try {
      await writeFileBrowserPath(path.trim());
      const result = await readFileBrowserInstallStream(path.trim(), (line) => setInstallLog((prev) => [...prev, line]));
      setSuccess(true); setRunning(true); setPort(result.port);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setInstalling(false); }
  };

  const handleStop = async () => {
    setStopping(true); setError(null);
    try {
      await fetch("/api/exec/daemon", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "stop", id: "file-browser" }) });
      setRunning(false); setPort(null); setSuccess(false);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setStopping(false); }
  };

  return (
    <div className="rounded-lg border p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">File Browser</h2>
        {running === true && <Badge variant="secondary" className="text-xs bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">Running</Badge>}
        {running === false && <Badge variant="secondary" className="text-xs">Stopped</Badge>}
      </div>
      <p className="text-sm text-muted-foreground">Manage the file-browser app from your local checkout.</p>

      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium">File Browser repo path</label>
        <Input
          placeholder="~/projects/starkeep/starkeep-apps/file-browser"
          value={path}
          onChange={(e) => setPath(e.currentTarget.value)}
          disabled={installing}
        />
      </div>

      {error && <Alert variant="destructive"><AlertTitle>Error</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
      {success && port && (
        <Alert>
          <AlertTitle>Running</AlertTitle>
          <AlertDescription>
            file-browser is running at{" "}
            <a href={`http://localhost:${port}`} target="_blank" rel="noopener noreferrer" className="underline">{`http://localhost:${port}`}</a>
          </AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap gap-2">
        <Button onClick={handleInstall} disabled={installing || !path.trim()}>
          {installing && <span className="mr-1 size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />}
          {running ? "Reinstall & Restart" : "Install & Start"}
        </Button>
        {running && (
          <Button variant="outline" onClick={handleStop} disabled={stopping}>
            {stopping && <span className="mr-1 size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />}
            Stop
          </Button>
        )}
        {running && port && (
          <a href={`http://localhost:${port}`} target="_blank" rel="noopener noreferrer" className="text-sm underline self-center">Open file-browser ↗</a>
        )}
      </div>

      {(installing || installLog.length > 0) && (
        <ScrollArea className="h-48 rounded-md border">
          <pre className="p-3 font-mono text-xs whitespace-pre-wrap">{installLog.join("\n")}</pre>
          <div ref={logEndRef} />
        </ScrollArea>
      )}
    </div>
  );
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
  const [cloudDeployed, setCloudDeployed] = useState<boolean | null>(null);
  const [cloudConfig, setCloudConfig] = useState<Record<string, unknown> | null>(null);
  const [coreDeployed, setCoreDeployed] = useState<boolean | null>(null);

  const installLogEndRef = useRef<HTMLDivElement>(null);
  const deployLogEndRef = useRef<HTMLDivElement>(null);

  const checkCloudStatus = useCallback(async (p: string) => {
    if (!p.trim()) { setCloudDeployed(null); return; }
    try {
      const res = await fetch(`/api/photos-web/deploy?path=${encodeURIComponent(p.trim())}`);
      if (res.ok) {
        const data = await res.json() as { deployed: boolean; photosCloudConfig: Record<string, unknown> | null; coreDeployed: boolean };
        setCloudDeployed(data.deployed); setCloudConfig(data.photosCloudConfig ?? null); setCoreDeployed(data.coreDeployed ?? null);
      }
    } catch { setCloudDeployed(null); }
  }, []);

  useEffect(() => {
    readPhotosWebPath().then((saved) => { if (saved) { setPath(saved); checkCloudStatus(saved); } });
    checkStatus();
  }, []);

  useEffect(() => { installLogEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [installLog]);
  useEffect(() => { deployLogEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [deployLog]);

  const checkStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/exec/daemon/status?id=photos-web");
      if (res.ok) { const data = await res.json() as { running: boolean; port?: number }; setRunning(data.running); setPort(data.port ?? null); }
    } catch { setRunning(false); setPort(null); }
  }, []);

  const handleInstall = async () => {
    if (!path.trim()) return;
    setInstalling(true); setLocalError(null); setLocalSuccess(false); setInstallLog([]);
    try {
      await writePhotosWebPath(path.trim());
      const result = await readInstallStream(path.trim(), (line) => setInstallLog((prev) => [...prev, line]));
      setLocalSuccess(true); setRunning(true); setPort(result.port);
    } catch (err) { setLocalError(err instanceof Error ? err.message : String(err)); }
    finally { setInstalling(false); }
  };

  const handleStop = async () => {
    setStopping(true); setLocalError(null);
    try {
      await fetch("/api/exec/daemon", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "stop", id: "photos-web" }) });
      setRunning(false); setPort(null); setLocalSuccess(false);
    } catch (err) { setLocalError(err instanceof Error ? err.message : String(err)); }
    finally { setStopping(false); }
  };

  const handleDeploy = async () => {
    if (!path.trim()) return;
    setDeploying(true); setDeployLog([]); setDeployError(null); setDeploySuccess(false);
    try {
      const config = await readCloudConfig();
      if (!config) throw new Error("No cloud configuration — complete the setup wizard first.");
      let creds = await readCloudCredentials();
      if (!creds) {
        const session = await readCognitoSession();
        if (!session?.refreshToken) throw new Error("Not signed in — sign in before deploying.");
        const tokens = await refreshTokens(config.cognitoConfig, session.refreshToken);
        creds = await getIdentityPoolCredentials(config.cognitoConfig, tokens.idToken);
        await writeCloudCredentials(creds);
        await writeCognitoSession({ ...session, refreshToken: tokens.refreshToken });
      }
      const credentials = { ...creds, region: config.region };
      const res = await fetch("/api/photos-web/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ photosWebPath: path.trim(), credentials }),
      });
      if (!res.ok || !res.body) { const data = await res.json() as { error?: string }; throw new Error(data.error ?? "Deploy request failed"); }
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
            if (result.exitCode !== 0) throw new Error(`Deploy exited with code ${result.exitCode}`);
            setDeploySuccess(true); setCloudDeployed(true);
            if (result.photosCloudConfig) {
              setCloudConfig(result.photosCloudConfig);
              const webUrl = result.photosCloudConfig.photosWebUrl;
              if (typeof webUrl === "string") setDeployLog((prev) => [...prev, `Remote app URL: ${webUrl}`]);
              setDeployLog((prev) => [...prev, "Re-installing with updated cloud config..."]);
              const reinstall = await readInstallStream(path.trim(), (line) => setDeployLog((prev) => [...prev, line]));
              setPort(reinstall.port); setRunning(true);
              setDeployLog((prev) => [...prev, `Local dev server: http://localhost:${reinstall.port}`]);
            }
          } else if (eventType === "error") {
            throw new Error(JSON.parse(dataLine) as string);
          } else {
            setDeployLog((prev) => [...prev, JSON.parse(dataLine) as string]);
          }
        }
      }
    } catch (err) { setDeployError(err instanceof Error ? err.message : String(err)); }
    finally { setDeploying(false); }
  };

  return (
    <div className="rounded-lg border p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">Photos Web</h2>
        {running === true && <Badge variant="secondary" className="text-xs bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">Running</Badge>}
        {running === false && <Badge variant="secondary" className="text-xs">Stopped</Badge>}
      </div>
      <p className="text-sm text-muted-foreground">Manage the photos-web app from your local checkout.</p>

      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium">Photos Web repo path</label>
        <Input
          placeholder="~/projects/starkeep/photos"
          value={path}
          onChange={(e) => setPath(e.currentTarget.value)}
          disabled={installing || deploying}
        />
      </div>

      {/* Local */}
      <div className="flex flex-col gap-3">
        <p className="text-sm font-medium">Local</p>
        {localError && <Alert variant="destructive"><AlertTitle>Error</AlertTitle><AlertDescription>{localError}</AlertDescription></Alert>}
        {localSuccess && port && (
          <Alert>
            <AlertTitle>Running</AlertTitle>
            <AlertDescription>
              photos-web is running at{" "}
              <a href={`http://localhost:${port}`} target="_blank" rel="noopener noreferrer" className="underline">{`http://localhost:${port}`}</a>
            </AlertDescription>
          </Alert>
        )}
        <div className="flex flex-wrap gap-2">
          <Button onClick={handleInstall} disabled={installing || !path.trim()}>
            {installing && <span className="mr-1 size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />}
            {running ? "Reinstall & Restart" : "Install & Start"}
          </Button>
          {running && (
            <Button variant="outline" onClick={handleStop} disabled={stopping}>
              {stopping && <span className="mr-1 size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />}
              Stop
            </Button>
          )}
          {running && port && (
            <a href={`http://localhost:${port}`} target="_blank" rel="noopener noreferrer" className="text-sm underline self-center">Open photos-web ↗</a>
          )}
        </div>
        {(installing || installLog.length > 0) && (
          <ScrollArea className="h-48 rounded-md border">
            <pre className="p-3 font-mono text-xs whitespace-pre-wrap">{installLog.join("\n")}</pre>
            <div ref={installLogEndRef} />
          </ScrollArea>
        )}
      </div>

      <Separator />

      {/* Cloud */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium">Cloud</p>
          {cloudDeployed === true && <Badge variant="secondary" className="text-xs bg-teal-100 text-teal-800 dark:bg-teal-900 dark:text-teal-200">Deployed</Badge>}
          {cloudDeployed === true && cloudConfig && typeof cloudConfig.photosWebUrl === "string" && (
            <a href={cloudConfig.photosWebUrl} target="_blank" rel="noopener noreferrer" className="text-sm underline">{cloudConfig.photosWebUrl} ↗</a>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          Deploy photos-web infrastructure to AWS (thumbnail Lambda, static server Lambda, API Gateway). Requires cloud setup to be complete.
        </p>
        {deployError && <Alert variant="destructive"><AlertTitle>Deploy failed</AlertTitle><AlertDescription>{deployError}</AlertDescription></Alert>}
        {deploySuccess && <Alert><AlertTitle>Deployed</AlertTitle><AlertDescription>Photos infrastructure deployed. Runtime config updated with new cloud URLs.</AlertDescription></Alert>}
        <div className="flex flex-wrap gap-2">
          <Button onClick={handleDeploy} disabled={deploying || !path.trim() || coreDeployed === false}>
            {deploying && <span className="mr-1 size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />}
            Deploy to cloud
          </Button>
        </div>
        {coreDeployed === false && <p className="text-xs text-muted-foreground">Core infrastructure must be deployed first.</p>}
        {(deploying || deployLog.length > 0) && (
          <ScrollArea className="h-60 rounded-md border">
            <pre className="p-3 font-mono text-xs whitespace-pre-wrap">{deployLog.join("\n")}</pre>
            <div ref={deployLogEndRef} />
          </ScrollArea>
        )}
      </div>
    </div>
  );
}
