import { serviceStatus } from "@starkeep/operator/service-control";

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (!id) {
    return Response.json({ error: "id is required" }, { status: 400 });
  }
  return Response.json(await serviceStatus(id));
}
