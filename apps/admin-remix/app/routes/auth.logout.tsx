import type { ActionFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { logout } from "../lib/auth.server";

export async function action({ request }: ActionFunctionArgs) {
  const setCookie = await logout(request);
  return redirect("/auth/login", {
    headers: {
      "Set-Cookie": setCookie,
    },
  });
}

export default function Logout() {
  return null;
}
