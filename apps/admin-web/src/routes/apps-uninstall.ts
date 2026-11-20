import { uninstallLocalApp } from "@starkeep/operator/local-apps";

export async function POST(req: Request) {
  const body = (await req.json()) as { appId?: string };
  const { appId } = body;
  if (!appId) {
    return Response.json({ error: "appId is required" }, { status: 400 });
  }
  const result = await uninstallLocalApp(appId);
  if (!result.ok) {
    return Response.json(
      result.status === 502
        ? { error: result.error, detail: result.detail }
        : { error: result.error, status: result.status, body: result.detail },
      { status: result.status },
    );
  }
  return Response.json({ appId, ok: true });
}
