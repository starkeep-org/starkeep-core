/**
 * A second account, end to end on real AWS: a member.
 *
 * The rest of the journey runs as the admin alone, so nothing else here shows
 * that two accounts keep two libraries. These steps add the member flow from
 * `explainer-member-user-flows-2026-10-18.md`, as device sign-in reshaped it
 * (`plan-device-sign-in-2026-10-18.md`):
 *
 * 1. An admin creates the account with admin-web's own Users routes.
 * 2. The member's machine knows only the cloud's address. It learns how to
 *    sign in from `/auth/config`, answers the first sign-in's new-password
 *    challenge, and binds its library to the member.
 * 3. The member's data reaches the cloud in the member's slice, and neither
 *    account's machine or cloud view sees the other's.
 * 4. The admin resets the password, takes the member out of the data group and
 *    back, and disables the account, and each act has its documented effect.
 *
 * The member is deleted at the end with the operator's ambient credentials, so
 * a rerun against a kept-up stack starts from a fresh account and a fresh
 * `sub`.
 *
 * Account creation goes through the SDK as the admin role rather than through
 * admin-web's `CREATE` route, because `CREATE` asks Cognito to email the
 * invitation and this suite has no mailbox to read it from. "Reset password"
 * hands the temporary password back instead, which is what the member's first
 * sign-in needs.
 */

import { afterAll, expect, it } from "vitest";
import { pathToFileURL } from "node:url";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import { startLocalDataServer, type LocalDataServer } from "@starkeep/testkit";
import { driveCreds, createRecordWithBytes, eventually, solidPng, type LdsApp } from "@starkeep/e2e";
import type { AppCredentials } from "@starkeep/app-client";
import {
  cognitoPasswordAuthTokens,
  getIdentityPoolCredentials,
  regionFromUserPoolId,
} from "@starkeep/admin-installer";
import { createCognitoClient, USER_TOKEN_HEADER } from "@starkeep/protocol-primitives";
import { REGION } from "./env.js";
import type { AdminSession } from "./installers.js";
import type { RunPaths, TestStackConfig } from "./run-state.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MEMBER_EMAIL = "tier3-member@starkeep.test";

export interface MemberStepsContext {
  readonly paths: RunPaths;
  readonly config: () => TestStackConfig;
  readonly session: () => AdminSession;
  /** The admin machine's local Drive app. */
  readonly adminDrive: () => LdsApp;
  /** The admin's record from the journey's sync step. */
  readonly adminRecordId: () => string;
  /** A cloud app's compute acting for the person whose ID token this is. */
  readonly cloudAppAs: (local: AppCredentials, idToken: () => string) => LdsApp;
}

/** The slice of admin-web's Users routes these steps drive. */
interface UsersRoutes {
  LIST(req: Request): Promise<Response>;
  SET_GROUP(req: Request): Promise<Response>;
  SET_ENABLED(req: Request): Promise<Response>;
  RESET_PASSWORD(req: Request): Promise<Response>;
}

interface UserView {
  username: string;
  email: string | null;
  enabled: boolean;
  status: string | null;
  admin: boolean;
  data: boolean;
}

export function defineMemberSteps(m: MemberStepsContext): void {
  let users: UsersRoutes;
  let memberSub: string;
  let temporaryPassword: string;
  let chosenPassword: string;
  let memberLds: LocalDataServer | undefined;
  let memberDir: string | undefined;
  let memberDrive: LdsApp;
  let memberRecordId: string;

  /** The member's own address for the cloud: what the admin sends. */
  const cloudAddress = () => m.config().publicBaseUrl ?? m.config().apiGatewayUrl!;

  /** The ID token cloud Photos would hold for the member: the admin client's. */
  async function memberAppToken(): Promise<string> {
    return (await cognitoPasswordAuthTokens(m.config(), MEMBER_EMAIL, chosenPassword)).idToken;
  }

  /** A sign-in through the pool's device client, as a desktop or phone makes it. */
  function deviceClient() {
    return createCognitoClient({ region: REGION, userPoolClientId: m.config().deviceUserPoolClientId });
  }

  /** Call one of admin-web's Users routes as the signed-in admin. */
  async function callUsers(
    route: keyof UsersRoutes,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const session = m.session();
    const adminSub = (
      JSON.parse(Buffer.from(session.idToken.split(".")[1]!, "base64url").toString("utf8")) as { sub: string }
    ).sub;
    const req = new Request("http://localhost/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        credentials: {
          ...session.awsCredentials,
          expiration: new Date(Date.now() + 3_600_000).toISOString(),
        },
        stackPrefix: m.config().stackPrefix,
        region: session.region,
        userSub: adminSub,
        ...body,
      }),
    });
    // The routes read the user pool from `$STARKEEP_DIR/config.json`, as
    // admin-web does on the operator's machine.
    const saved = process.env.STARKEEP_DIR;
    process.env.STARKEEP_DIR = m.paths.dataDir;
    try {
      const res = await users[route](req);
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    } finally {
      if (saved === undefined) delete process.env.STARKEEP_DIR;
      else process.env.STARKEEP_DIR = saved;
    }
  }

  async function memberStatus(): Promise<Record<string, unknown>> {
    return (await (await fetch(`${memberLds!.url}/auth/status`)).json()) as Record<string, unknown>;
  }

  async function deleteMember(): Promise<void> {
    // The operator's ambient credentials: no Starkeep identity deletes accounts.
    const cognito = new CognitoIdentityProviderClient({ region: regionFromUserPoolId(m.config().userPoolId) });
    try {
      await cognito.send(new AdminDeleteUserCommand({ UserPoolId: m.config().userPoolId, Username: MEMBER_EMAIL }));
    } catch (err) {
      if ((err as { name?: string }).name !== "UserNotFoundException") throw err;
    }
  }

  afterAll(async () => {
    await memberLds?.stop();
    if (memberDir) await rm(memberDir, { recursive: true, force: true });
  });

  it("the cloud tells a device how to sign in, on the gateway and through CloudFront", async () => {
    const config = m.config();
    for (const base of [config.apiGatewayUrl!, config.publicBaseUrl!]) {
      const res = await fetch(`${base}/auth/config`);
      const text = await res.text();
      expect(res.status, `${base}/auth/config: ${text}`).toBe(200);
      expect(JSON.parse(text)).toEqual({
        region: regionFromUserPoolId(config.userPoolId),
        userPoolId: config.userPoolId,
        deviceClientId: config.deviceUserPoolClientId,
      });
    }
  });

  it("refuses an admin-client token that arrives with no app signature", async () => {
    // A cloud app's Lambda holds tokens like this one. Without the device
    // client's `aud`, the broker must not treat the bare token as a device.
    const res = await fetch(`${m.config().apiGatewayUrl}/apps/starkeep-drive/deployment/settings`, {
      headers: { [USER_TOKEN_HEADER]: m.session().idToken },
    });
    expect(res.status, await res.text()).toBe(401);
  });

  it("an admin creates a member with admin-web's Users routes", async () => {
    users = (await import(
      pathToFileURL(resolve(REPO_ROOT, "apps/admin-web/src/routes/users.ts")).href
    )) as UsersRoutes;
    await deleteMember();

    // As the admin role, the way admin-web's CREATE runs, minus the email.
    const session = m.session();
    const asAdmin = new CognitoIdentityProviderClient({ region: session.region, credentials: session.awsCredentials });
    const created = await asAdmin.send(
      new AdminCreateUserCommand({
        UserPoolId: m.config().userPoolId,
        Username: MEMBER_EMAIL,
        UserAttributes: [
          { Name: "email", Value: MEMBER_EMAIL },
          { Name: "email_verified", Value: "true" },
        ],
        MessageAction: "SUPPRESS",
      }),
    );
    memberSub = created.User!.Username!;

    const grouped = await callUsers("SET_GROUP", { username: memberSub, group: "starkeep-users", member: true });
    expect(grouped.status, JSON.stringify(grouped.body)).toBe(200);

    const reset = await callUsers("RESET_PASSWORD", { username: memberSub });
    expect(reset.status, JSON.stringify(reset.body)).toBe(200);
    temporaryPassword = reset.body.temporaryPassword as string;
    expect(temporaryPassword).toMatch(/^.{16}$/);

    const listed = await callUsers("LIST", {});
    const member = (listed.body.users as UserView[]).find((u) => u.username === memberSub);
    expect(member).toMatchObject({
      email: MEMBER_EMAIL,
      enabled: true,
      status: "FORCE_CHANGE_PASSWORD",
      admin: false,
      data: true,
    });
  });

  it("the member's machine joins by address alone, and its first sign-in asks for a new password", async () => {
    // A member's machine after "Join": the cloud's address and nothing else.
    // No pool ids, no device key, no cloud install of its own.
    memberLds = await startLocalDataServer({
      config: { apiGatewayUrl: cloudAddress() },
      deviceKey: false,
    });
    memberDir = memberLds.starkeepDir;
    memberDrive = await driveCreds(memberLds.url);
    expect(await memberStatus()).toMatchObject({ state: "signed-out", libraryUserId: null });

    const login = (body: Record<string, unknown>) =>
      fetch(`${memberLds!.url}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    const first = await login({ email: MEMBER_EMAIL, password: temporaryPassword });
    expect(await first.json()).toEqual({ challenge: "NEW_PASSWORD_REQUIRED" });

    chosenPassword = `Member-${randomBytes(9).toString("base64url")}`;
    const second = await login({ email: MEMBER_EMAIL, password: temporaryPassword, newPassword: chosenPassword });
    const body = (await second.json()) as Record<string, unknown>;
    expect(second.status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({ ok: true, email: MEMBER_EMAIL, userId: memberSub });
    expect(await memberStatus()).toMatchObject({
      state: "signed-in",
      userId: memberSub,
      libraryUserId: memberSub,
    });
  });

  it("the member gets no AWS credentials from the identity pool", async () => {
    const idToken = await memberAppToken();
    await expect(getIdentityPoolCredentials(m.config(), idToken)).rejects.toThrow();
  });

  it("the member's record reaches the cloud in the member's slice, and only the member sees it", async () => {
    const bytes = solidPng([...randomBytes(3)] as [number, number, number], 16 + (randomBytes(1)[0]! % 48));
    const { record } = await createRecordWithBytes(memberDrive, { bytes, fileName: "member.png" });
    memberRecordId = record.id;

    // The member's view, as cloud Photos would read it: Drive's signature and
    // the member's own token.
    let token = await memberAppToken();
    const asMember = m.cloudAppAs(m.adminDrive(), () => token);
    await eventually(
      async () => {
        await memberDrive.fetch("/sync/now", { method: "POST" });
        token = await memberAppToken();
        const res = await asMember.fetch(`/data/records/${memberRecordId}`);
        expect(res.status, await res.clone().text()).toBe(200);
      },
      { timeoutMs: 120_000, intervalMs: 3_000 },
    );

    const res = await asMember.fetch(`/data/records/${memberRecordId}`);
    const json = (await res.json()) as Record<string, unknown>;
    const stored = (json.record ?? json) as { objectStorageKey?: string; object_storage_key?: string };
    expect(stored.objectStorageKey ?? stored.object_storage_key).toMatch(new RegExp(`^shared/${memberSub}/`));

    // The admin's view of the same cloud holds none of it.
    const asAdmin = m.cloudAppAs(m.adminDrive(), () => m.session().idToken);
    expect((await asAdmin.fetch(`/data/records/${memberRecordId}`)).status).toBe(404);
    const adminList = (await (await asAdmin.fetch("/data/records")).json()) as { records: Array<{ id: string }> };
    expect(adminList.records.map((r) => r.id)).not.toContain(memberRecordId);
  });

  it("neither machine receives the other account's records", async () => {
    await m.adminDrive().fetch("/sync/now", { method: "POST" });
    await memberDrive.fetch("/sync/now", { method: "POST" });

    expect((await m.adminDrive().fetch(`/data/records/${memberRecordId}`)).status).toBe(404);
    expect((await memberDrive.fetch(`/data/records/${m.adminRecordId()}`)).status).toBe(404);
    const memberList = (await (await memberDrive.fetch("/data/records")).json()) as { records: Array<{ id: string }> };
    expect(memberList.records.map((r) => r.id)).toContain(memberRecordId);
    expect(memberList.records.map((r) => r.id)).not.toContain(m.adminRecordId());
  });

  it("a password reset leaves the member's machine signed in, and the next sign-in asks for a new password", async () => {
    const reset = await callUsers("RESET_PASSWORD", { username: memberSub });
    expect(reset.status, JSON.stringify(reset.body)).toBe(200);
    const temporary = reset.body.temporaryPassword as string;

    expect(await memberStatus()).toMatchObject({ state: "signed-in", userId: memberSub });

    const client = deviceClient();
    const first = await client.signIn(MEMBER_EMAIL, temporary);
    expect(first.kind).toBe("new-password-required");
    chosenPassword = `Member-${randomBytes(9).toString("base64url")}`;
    if (first.kind === "new-password-required") {
      await client.setNewPassword(MEMBER_EMAIL, first.session, chosenPassword);
    }
  });

  it("taking the member out of the data group refuses a fresh device token, and adding them back restores it", async () => {
    const settingsAsDevice = async () => {
      const result = await deviceClient().signIn(MEMBER_EMAIL, chosenPassword);
      if (result.kind !== "tokens") throw new Error(`unexpected challenge: ${result.kind}`);
      return fetch(`${m.config().apiGatewayUrl}/apps/starkeep-drive/deployment/settings`, {
        headers: { [USER_TOKEN_HEADER]: result.tokens.idToken },
      });
    };

    expect((await settingsAsDevice()).status).toBe(200);

    const out = await callUsers("SET_GROUP", { username: memberSub, group: "starkeep-users", member: false });
    expect(out.status, JSON.stringify(out.body)).toBe(200);
    const refused = await settingsAsDevice();
    expect(refused.status, await refused.text()).toBe(403);

    const back = await callUsers("SET_GROUP", { username: memberSub, group: "starkeep-users", member: true });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect((await settingsAsDevice()).status).toBe(200);
  });

  it("disabling the member ends the member machine's session at its next start", async () => {
    const disabled = await callUsers("SET_ENABLED", { username: memberSub, enabled: false });
    expect(disabled.status, JSON.stringify(disabled.body)).toBe(200);

    // A restart asks the pool for a fresh token at once; the pool refuses the
    // revoked refresh token, and the machine shows it is signed out.
    await memberLds!.stopKeepData();
    memberLds = await startLocalDataServer({ starkeepDir: memberDir!, deviceKey: false });
    await eventually(async () => expect(await memberStatus()).toMatchObject({ state: "signed-out" }), {
      timeoutMs: 60_000,
      intervalMs: 1_000,
    });
    // The library stays the member's: a later sign-in as anyone else is refused.
    expect(await memberStatus()).toMatchObject({ libraryUserId: memberSub });

    await deleteMember();
  });
}
