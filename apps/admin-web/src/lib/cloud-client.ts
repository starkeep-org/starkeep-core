export interface CloudConfig {
  serverUrl: string;
  token: string;
}

let config: CloudConfig | null = null;

export function setCloudConfig(c: CloudConfig | null) {
  config = c;
}

export function getCloudConfig(): CloudConfig | null {
  return config;
}

export function isCloudConnected(): boolean {
  return config !== null;
}

async function cloudFetch(path: string, options?: RequestInit): Promise<Response> {
  if (!config) throw new Error("Not connected to cloud");
  const url = `${config.serverUrl.replace(/\/$/, "")}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.token}`,
      ...options?.headers,
    },
  });
  if (res.status === 401) {
    setCloudConfig(null);
    throw new Error("Session expired — please reconnect");
  }
  return res;
}

export async function cloudLogin(
  serverUrl: string,
  email: string,
  password: string,
): Promise<{ token: string; expiresAt: string }> {
  const url = `${serverUrl.replace(/\/$/, "")}/api/auth`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: "Connection failed" }));
    throw new Error(body.error || `HTTP ${res.status}`);
  }

  const data = await res.json();
  setCloudConfig({ serverUrl, token: data.token });
  return data;
}

export async function cloudListDeployments() {
  const res = await cloudFetch("/api/deployments");
  if (!res.ok) throw new Error(`Failed to list deployments: ${res.status}`);
  const data = await res.json();
  return data.plans;
}

export async function cloudGetPlan(planId: string) {
  const res = await cloudFetch(`/api/plans/${planId}`);
  if (!res.ok) throw new Error(`Failed to get plan: ${res.status}`);
  return res.json();
}

export async function cloudCreatePlan(input: {
  stack_name: string;
  region: string;
  environment: string;
  template_type: string;
  parameters: Record<string, unknown> | null;
}) {
  const res = await cloudFetch("/api/plans", {
    method: "POST",
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`Failed to create plan: ${res.status}`);
  return res.json();
}

export async function cloudDeletePlan(planId: string) {
  const res = await cloudFetch(`/api/plans/${planId}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Failed to delete plan: ${res.status}`);
}
