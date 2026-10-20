/**
 * The deployment's accounts: who administers it, whose data syncs, and who
 * may sign in at all.
 *
 * - **Admin** (`starkeep-admins`): manages users, cloud apps, settings and the
 *   deployment. Only admins can sign in to admin-web's cloud sections.
 * - **Data** (`starkeep-users`): has a library that syncs through the cloud.
 *
 * An admin may hold either or both.
 *
 * Creating an account sends Cognito's invitation email with a temporary
 * password. "Reset password" gives an account a new temporary password, shown
 * once for the admin to send. "Sign out all devices" ends every sign-in the
 * account holds, which is how a lost phone is cut off. Disabling an account
 * signs it out everywhere too.
 */

import { useCallback, useEffect, useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { operatorSession } from "@/lib/operator-session";

interface UserView {
  readonly username: string;
  readonly email: string | null;
  readonly enabled: boolean;
  readonly status: string | null;
  readonly admin: boolean;
  readonly data: boolean;
}

type ListState =
  | { kind: "loading" }
  | { kind: "ready"; users: readonly UserView[] }
  | { kind: "error"; message: string };

/** POST one users route with the operator's session. Returns the refreshed list. */
async function call(
  path: string,
  extra: Record<string, unknown> = {},
): Promise<{ users: UserView[]; temporaryPassword?: string }> {
  const session = await operatorSession();
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      credentials: session.credentials,
      stackPrefix: session.stackPrefix,
      region: session.region,
      userSub: session.userSub,
      ...extra,
    }),
  });
  const body = (await res.json()) as {
    users?: UserView[];
    temporaryPassword?: string;
    error?: string;
  };
  if (!res.ok || !body.users) throw new Error(body.error ?? `Request failed (${res.status})`);
  return {
    users: body.users,
    ...(body.temporaryPassword ? { temporaryPassword: body.temporaryPassword } : {}),
  };
}

export function UsersSection() {
  const [list, setList] = useState<ListState>({ kind: "loading" });
  const [email, setEmail] = useState("");
  const [newAdmin, setNewAdmin] = useState(false);
  const [newData, setNewData] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setList({ kind: "ready", users: (await call("/api/users/list")).users });
    } catch (err) {
      setList({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(
    path: string,
    extra: Record<string, unknown>,
    done: (result: { temporaryPassword?: string }) => string,
  ) {
    setBusy(true);
    setMessage(null);
    try {
      const result = await call(path, extra);
      setList({ kind: "ready", users: result.users });
      setMessage({ kind: "ok", text: done(result) });
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  const create = () =>
    act("/api/users", { email: email.trim(), admin: newAdmin, data: newData }, () => {
      setEmail("");
      return `Created ${email.trim()}. Cognito has emailed a temporary password.`;
    });

  const setGroup = (user: UserView, group: "starkeep-admins" | "starkeep-users", member: boolean) =>
    act(
      "/api/users/group",
      { username: user.username, group, member },
      () => `Updated ${user.email ?? user.username}.`,
    );

  const setEnabled = (user: UserView, enabled: boolean) =>
    act("/api/users/enabled", { username: user.username, enabled }, () =>
      enabled
        ? `Enabled ${user.email ?? user.username}. They sign in again on each device.`
        : `Disabled ${user.email ?? user.username} and signed them out of every device.`,
    );

  const signOutEverywhere = (user: UserView) =>
    act(
      "/api/users/sign-out",
      { username: user.username },
      () =>
        `Signed ${user.email ?? user.username} out of every device. Each one stops syncing within ` +
        "15 minutes and asks them to sign in again.",
    );

  const resetPassword = (user: UserView) =>
    act(
      "/api/users/password",
      { username: user.username },
      ({ temporaryPassword }) =>
        `New temporary password for ${user.email ?? user.username}: ${temporaryPassword ?? "(none)"}. ` +
        "Send it to them; they choose their own at their next sign-in. It is not shown again.",
    );

  return (
    <Collapsible className="rounded-lg border p-4">
      <CollapsibleTrigger className="group flex w-full items-center gap-2 text-left">
        <h3 className="font-medium">Users</h3>
        <ChevronDownIcon className="ml-auto size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>

      <CollapsibleContent className="space-y-4 pt-4">
        <p className="text-muted-foreground text-sm">
          An admin manages users, cloud apps and settings. A user with data has a library that
          syncs. An account can be either or both.
        </p>

        <div className="space-y-2">
          <div className="flex gap-2">
            <Input
              placeholder="Email address"
              value={email}
              aria-label="New user's email"
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy}
            />
            <Button onClick={() => void create()} disabled={busy || email.trim() === ""}>
              Add user
            </Button>
          </div>
          <div className="flex gap-4 text-sm">
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={newAdmin}
                onChange={(e) => setNewAdmin(e.target.checked)}
              />{" "}
              Admin
            </label>
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={newData}
                onChange={(e) => setNewData(e.target.checked)}
              />{" "}
              Has data
            </label>
          </div>
        </div>

        {message && (
          <p
            className={message.kind === "error" ? "text-sm text-destructive" : "text-sm"}
            role="status"
          >
            {message.text}
          </p>
        )}

        {list.kind === "loading" ? (
          <p className="text-muted-foreground text-sm">Loading users…</p>
        ) : list.kind === "error" ? (
          <Alert variant="destructive">
            <AlertTitle>Could not load users</AlertTitle>
            <AlertDescription>{list.message}</AlertDescription>
          </Alert>
        ) : (
          <ul className="divide-y rounded-md border" aria-label="Users">
            {list.users.map((user) => (
              <li key={user.username} className="flex flex-wrap items-center gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {user.email ?? user.username}
                    {!user.enabled && (
                      <span className="ml-2 text-xs text-muted-foreground">Disabled</span>
                    )}
                    {user.status === "FORCE_CHANGE_PASSWORD" && (
                      <span className="ml-2 text-xs text-muted-foreground">Invited</span>
                    )}
                  </p>
                </div>
                <label className="flex items-center gap-1 text-sm">
                  <input
                    type="checkbox"
                    checked={user.admin}
                    disabled={busy}
                    aria-label={`${user.email ?? user.username} is an admin`}
                    onChange={(e) => void setGroup(user, "starkeep-admins", e.target.checked)}
                  />
                  Admin
                </label>
                <label className="flex items-center gap-1 text-sm">
                  <input
                    type="checkbox"
                    checked={user.data}
                    disabled={busy}
                    aria-label={`${user.email ?? user.username} has data`}
                    onChange={(e) => void setGroup(user, "starkeep-users", e.target.checked)}
                  />
                  Has data
                </label>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void resetPassword(user)}
                >
                  Reset password
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void signOutEverywhere(user)}
                >
                  Sign out all devices
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void setEnabled(user, !user.enabled)}
                >
                  {user.enabled ? "Disable" : "Enable"}
                </Button>
              </li>
            ))}
          </ul>
        )}

        <p className="text-muted-foreground text-xs">
          Each user signs in on their own devices to sync. A user who forgets their password gets a
          new temporary one here.
        </p>
      </CollapsibleContent>
    </Collapsible>
  );
}
