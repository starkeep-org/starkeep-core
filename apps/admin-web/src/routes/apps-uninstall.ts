import { uninstallLocalApp } from "@starkeep/operator/local-apps";
import { withAppLock } from "../lib/app-lock";

export async function POST(req: Request) {
  const body = (await req.json()) as { appId?: string };
  const { appId } = body;
  if (!appId) {
    return Response.json({ error: "appId is required" }, { status: 400 });
  }
  return withAppLock(appId, `admin-web uninstall ${appId}`, async () => {
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
  });
}
