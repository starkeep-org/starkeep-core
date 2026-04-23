import { useState, useEffect } from "react";
import { initiateAuth, respondNewPasswordChallenge } from "./cognito-auth";
import { readCloudConfig, writeCloudConfig, type CloudConfig } from "./cloud-config";

const LOCAL_BASE = "http://127.0.0.1:9820";

interface ServerConfig {
  stage: string;
  s3Bucket: string | null;
  s3Region: string;
  auroraEndpoint: string | null;
  apiGatewayUrl: string | null;
  cognitoConfig: {
    region: string;
    userPoolId: string;
    userPoolClientId: string;
    identityPoolId: string;
  };
}

export function CloudSetupModal({ onClose }: { onClose: () => void }) {
  const [serverConfig, setServerConfig] = useState<ServerConfig | null>(null);
  const [serverConfigError, setServerConfigError] = useState<string | null>(null);
  const [storedConfig, setStoredConfig] = useState<CloudConfig | null>(null);
  const [showSignIn, setShowSignIn] = useState(false);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [session, setSession] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);

  useEffect(() => {
    readCloudConfig().then((c) => {
      setStoredConfig(c);
      if (!c) setShowSignIn(true);
    });
    fetch(`${LOCAL_BASE}/config`)
      .then((r) => (r.ok ? (r.json() as Promise<ServerConfig>) : Promise.reject(r.statusText)))
      .then(setServerConfig)
      .catch((err: unknown) => setServerConfigError(String(err)));
  }, []);

  const cognitoConfig = serverConfig?.cognitoConfig ?? storedConfig?.cognitoConfig;

  const handleSignIn = async () => {
    if (!cognitoConfig || !email || !password) return;
    setSigningIn(true);
    setSignInError(null);
    try {
      const result = await initiateAuth(cognitoConfig, email, password);
      if (result.tokens) {
        await finishSignIn(result.tokens.idToken, result.tokens.refreshToken);
      } else if (result.challengeName === "NEW_PASSWORD_REQUIRED") {
        setSession(result.session ?? null);
      } else {
        setSignInError(`Unexpected challenge: ${result.challengeName}`);
      }
    } catch (err) {
      setSignInError(err instanceof Error ? err.message : String(err));
    } finally {
      setSigningIn(false);
    }
  };

  const handleNewPassword = async () => {
    if (!cognitoConfig || !session) return;
    setSigningIn(true);
    setSignInError(null);
    try {
      const tokens = await respondNewPasswordChallenge(cognitoConfig, session, email, newPassword);
      await finishSignIn(tokens.idToken, tokens.refreshToken);
    } catch (err) {
      setSignInError(err instanceof Error ? err.message : String(err));
    } finally {
      setSigningIn(false);
    }
  };

  const finishSignIn = async (idToken: string, refreshToken: string) => {
    const config: CloudConfig = {
      stackPrefix: serverConfig?.stage ?? storedConfig?.stackPrefix ?? "",
      s3Bucket: serverConfig?.s3Bucket ?? storedConfig?.s3Bucket ?? "",
      s3Region: serverConfig?.s3Region ?? storedConfig?.s3Region ?? "",
      auroraEndpoint: serverConfig?.auroraEndpoint ?? storedConfig?.auroraEndpoint ?? "",
      apiGatewayUrl: serverConfig?.apiGatewayUrl ?? storedConfig?.apiGatewayUrl,
      cognitoConfig: (serverConfig?.cognitoConfig ?? storedConfig?.cognitoConfig)!,
      cognitoRefreshToken: refreshToken,
    };
    await writeCloudConfig(config);
    // Pass tokens to the local data server so it can authenticate for sync.
    // Best-effort: photos-web works fine without the local server.
    fetch(`${LOCAL_BASE}/auth/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken, refreshToken }),
    }).catch(() => {});
    localStorage.setItem("starkeep:dataSource", "remote");
    window.location.reload();
  };

  const handleDisconnect = () => {
    localStorage.removeItem("starkeep:cloud-config");
    localStorage.removeItem("starkeep:cloud-credentials");
    localStorage.setItem("starkeep:dataSource", "local");
    window.location.reload();
  };

  const isSignedIn = !!storedConfig?.cognitoRefreshToken;
  const apiUrl = storedConfig?.apiGatewayUrl ?? serverConfig?.apiGatewayUrl;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.7)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          background: "#1c1c1c",
          border: "1px solid rgba(255,255,255,0.12)",
          borderRadius: 8,
          padding: 24,
          width: 400,
          maxWidth: "calc(100vw - 40px)",
          color: "#e0e0e0",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
          <span style={{ fontWeight: 700, fontSize: 16 }}>Cloud Setup</span>
          <button
            onClick={onClose}
            style={{ background: "none", border: "none", color: "#888", fontSize: 20, cursor: "pointer", lineHeight: 1 }}
          >
            ×
          </button>
        </div>

        {!showSignIn && (
          <>
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, color: "#888", marginBottom: 4 }}>Status</div>
              {isSignedIn ? (
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ color: "#6c6", fontSize: 12 }}>●</span>
                  <span style={{ fontSize: 13, color: "#bbb", wordBreak: "break-all" }}>
                    {apiUrl ?? "Connected"}
                  </span>
                </div>
              ) : (
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ color: "#c66", fontSize: 12 }}>●</span>
                  <span style={{ fontSize: 13, color: "#bbb" }}>
                    {storedConfig ? "Config loaded, not signed in" : "Not configured"}
                  </span>
                </div>
              )}
            </div>

            {serverConfigError && !serverConfig && (
              <div style={{ fontSize: 12, color: "#f88", marginBottom: 12 }}>
                Local server: {serverConfigError}
              </div>
            )}

            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => { setShowSignIn(true); setSignInError(null); }}
                style={btnStyle}
              >
                {isSignedIn ? "Sign in again" : "Sign in"}
              </button>
              {isSignedIn && (
                <button onClick={handleDisconnect} style={{ ...btnStyle, color: "#f88", borderColor: "rgba(255,100,100,0.3)" }}>
                  Disconnect
                </button>
              )}
            </div>
          </>
        )}

        {showSignIn && (
          <>
            {!cognitoConfig && (
              <div style={{ fontSize: 13, color: "#f88", marginBottom: 12 }}>
                {serverConfigError
                  ? `Could not load config from local server: ${serverConfigError}`
                  : "Loading config from local server…"}
              </div>
            )}

            {session ? (
              <>
                <div style={{ fontSize: 13, color: "#ccc", marginBottom: 16 }}>
                  Set a new permanent password to continue.
                </div>
                <label style={labelStyle}>New password</label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  style={inputStyle}
                  autoFocus
                />
                {signInError && <div style={{ fontSize: 12, color: "#f88", marginBottom: 8 }}>{signInError}</div>}
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => setSession(null)} style={btnStyle}>Back</button>
                  <button
                    onClick={() => void handleNewPassword()}
                    disabled={signingIn || !newPassword}
                    style={{ ...btnStyle, background: "rgba(80,180,80,0.15)", borderColor: "rgba(80,180,80,0.4)" }}
                  >
                    {signingIn ? "Setting password…" : "Set password"}
                  </button>
                </div>
              </>
            ) : (
              <>
                <label style={labelStyle}>Email</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  style={inputStyle}
                  autoFocus
                  onKeyDown={(e) => { if (e.key === "Enter") void handleSignIn(); }}
                />
                <label style={labelStyle}>Password</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  style={inputStyle}
                  onKeyDown={(e) => { if (e.key === "Enter") void handleSignIn(); }}
                />
                {signInError && <div style={{ fontSize: 12, color: "#f88", marginBottom: 8 }}>{signInError}</div>}
                <div style={{ display: "flex", gap: 8 }}>
                  {storedConfig && (
                    <button onClick={() => setShowSignIn(false)} style={btnStyle}>Back</button>
                  )}
                  <button
                    onClick={() => void handleSignIn()}
                    disabled={signingIn || !email || !password || !cognitoConfig}
                    style={{ ...btnStyle, background: "rgba(80,140,255,0.15)", borderColor: "rgba(80,140,255,0.4)" }}
                  >
                    {signingIn ? "Signing in…" : "Sign in"}
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.07)",
  border: "1px solid rgba(255,255,255,0.15)",
  color: "#ccc",
  borderRadius: 4,
  padding: "7px 14px",
  cursor: "pointer",
  fontSize: 13,
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  color: "#888",
  marginBottom: 4,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(255,255,255,0.15)",
  borderRadius: 4,
  color: "#e0e0e0",
  padding: "8px 10px",
  fontSize: 13,
  marginBottom: 12,
  boxSizing: "border-box",
  outline: "none",
};
