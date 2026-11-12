// AI-682: create Starkeep's Cognito resources through the API on a running AWS
// Emulator, mirroring packages/aws-bootstrap/src/bootstrap/bootstrap-template.ts,
// then run the real sign-in, token, identity-pool and user-management code
// against them and record every step.
//
// Runs under tsx (run.sh): the product modules are TypeScript source, imported
// by relative path, and their @aws-sdk imports resolve from each package's own
// node_modules, i.e. the SDK versions the repo ships. The product clients are
// built with `{ region }` (plus explicit credentials for the user routes), so
// their endpoint comes from AWS_ENDPOINT_URL. The device client takes the
// `endpoint` option, the seam STARKEEP_COGNITO_ENDPOINT feeds in
// apps/local-data-server/server.ts.
//
// The spike's own SDK clients do what the bootstrap stack does (create the pool,
// clients, groups, identity pool, role) and what the template's
// AdminUser resources do (the first admin). They never stand in for a product
// function.
//
// Prints one JSON document on stdout for report.mjs. No token, password or key
// is printed: only shapes and decoded, non-secret claims.

import { randomBytes, webcrypto } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import {
  CognitoIdentityProviderClient,
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  CreateGroupCommand,
  CreateUserPoolClientCommand,
  CreateUserPoolCommand,
  CreateUserPoolDomainCommand,
  DescribeUserPoolClientCommand,
  DescribeUserPoolCommand,
  DescribeUserPoolDomainCommand,
  InitiateAuthCommand,
  ListTagsForResourceCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  CognitoIdentityClient,
  CreateIdentityPoolCommand,
  DescribeIdentityPoolCommand,
  GetCredentialsForIdentityCommand,
  GetIdCommand,
  GetIdentityPoolRolesCommand,
  SetIdentityPoolRolesCommand,
} from "@aws-sdk/client-cognito-identity";
import { IAMClient, CreateRoleCommand, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import { S3Client, CreateBucketCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";

import * as adminWeb from "../../../apps/admin-web/src/lib/cognito-auth.ts";
import * as installer from "../../../packages/admin-installer/src/cognito-auth.ts";
import {
  createCognitoClient,
  idTokenClaims,
} from "../../../packages/protocol-primitives/src/device-session/cognito-client.ts";
import { verifyIdToken, issuerFor } from "../../../packages/app-client/src/auth/verify.ts";
import { refreshTokens as appClientRefresh } from "../../../packages/app-client/src/auth/cognito.ts";
import * as usersRoutes from "../../../apps/admin-web/src/routes/users.ts";

import {
  guardEnvironment,
  guardFetch,
  describeError,
  diffs,
  decodeJwt,
  shape,
  keyIdShape,
  Recorder,
} from "./lib.mjs";

const endpoint = guardEnvironment();
const fetchLog = guardFetch();
const region = "us-east-1";
const prefix = `spk${randomBytes(3).toString("hex")}`;
const rec = new Recorder();

// The user routes read the pool id from $STARKEEP_DIR/config.json. run.sh points
// STARKEEP_DIR at a throwaway directory; refuse anything else.
const starkeepDir = process.env.STARKEEP_DIR ?? "";
const workRoot = resolve(process.env.SPIKE_WORK ?? tmpdir()) + sep;
if (!starkeepDir || !resolve(starkeepDir).startsWith(workRoot)) {
  console.error(`[spike] STARKEEP_DIR must be a throwaway directory under the spike's work dir`);
  process.exit(2);
}

const idp = new CognitoIdentityProviderClient({ region });
const identity = new CognitoIdentityClient({ region });
const iam = new IAMClient({ region });
const sts = new STSClient({ region });
const s3Setup = new S3Client({ endpoint, region, forcePathStyle: true });

// Passwords for this run only: random, never printed.
const pw = () => `Sp1!${randomBytes(9).toString("base64url")}`;
const emailFor = (who) => `${prefix}-${who}@example.com`;

// What the template asks for, one place, so the readback rows compare against it.
const INVITE_SUBJECT = "Your Starkeep account";
const INVITE_MESSAGE =
  "<p>Your new Starkeep account (Spike) is ready. Welcome!</p> " +
  "<p>Sign in with {username} and this temporary password:</p> " +
  '<p style="font-family: monospace; font-size: 18px">{####}</p>';
const POOL_INPUT = {
  PoolName: `${prefix}-auth`,
  UserPoolTier: "ESSENTIALS",
  AdminCreateUserConfig: {
    AllowAdminCreateUserOnly: true,
    InviteMessageTemplate: { EmailSubject: INVITE_SUBJECT, EmailMessage: INVITE_MESSAGE },
  },
  AutoVerifiedAttributes: ["email"],
  UsernameAttributes: ["email"],
  Schema: [{ Name: "email", AttributeDataType: "String", Required: true, Mutable: false }],
  EmailConfiguration: { EmailSendingAccount: "COGNITO_DEFAULT" },
  Policies: {
    PasswordPolicy: {
      MinimumLength: 8,
      RequireUppercase: false,
      RequireLowercase: false,
      RequireNumbers: false,
      RequireSymbols: false,
    },
  },
  UserPoolTags: { "starkeep:managed": "true", StackPrefix: prefix },
};
const ADMIN_CLIENT_INPUT = {
  ClientName: `${prefix}-admin`,
  GenerateSecret: false,
  ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
  TokenValidityUnits: { RefreshToken: "days" },
  RefreshTokenValidity: 30,
  PreventUserExistenceErrors: "ENABLED",
};
const DEVICE_CLIENT_INPUT = {
  ClientName: `${prefix}-devices`,
  GenerateSecret: false,
  ExplicitAuthFlows: ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
  TokenValidityUnits: { IdToken: "minutes", AccessToken: "minutes", RefreshToken: "days" },
  IdTokenValidity: 15,
  AccessTokenValidity: 15,
  RefreshTokenValidity: 3650,
  EnableTokenRevocation: true,
  PreventUserExistenceErrors: "ENABLED",
};

/**
 * Create with the template's full input; if the emulator rejects it, record the
 * error, then retry without one optional property at a time to name the one it
 * rejects. Returns the created resource (or undefined).
 */
async function createWithFallback(op, input, optionalKeys, send, show) {
  const first = await rec.op(op, () => send(input), undefined, show);
  if (first !== undefined) return first;
  for (const key of optionalKeys) {
    const { [key]: _dropped, ...rest } = input;
    const retry = await rec.op(
      `${op}, retried without ${key}`,
      () => send(rest),
      () => `the full template input is rejected; without ${key} it is accepted`,
      show,
    );
    if (retry !== undefined) return retry;
  }
  return undefined;
}

let pool, poolId, adminClientId, deviceClientId, identityPoolId, roleArn, accountId;
const facts = {};

try {
  // ==== 1. The pool and everything the bootstrap stack hangs off it ==============
  rec.section("pool");

  accountId = (
    await rec.op(
      "STS GetCallerIdentity (emulator key; account id for the domain prefix)",
      () => sts.send(new GetCallerIdentityCommand({})),
      undefined,
      (r) => `Account ${r.Account}, Arn ${r.Arn}`,
    )
  )?.Account;

  pool = await createWithFallback(
    `CreateUserPool ${prefix}-auth (template's properties)`,
    POOL_INPUT,
    [
      "UserPoolTier",
      "EmailConfiguration",
      "Schema",
      "UsernameAttributes",
      "AutoVerifiedAttributes",
      "UserPoolTags",
    ],
    (input) => idp.send(new CreateUserPoolCommand(input)).then((r) => r.UserPool),
    (p) => `Id ${p.Id}, Arn ${p.Arn}`,
  );
  poolId = pool?.Id;
  if (!poolId) throw new Error("no user pool, nothing else can run");

  await rec.op(
    "DescribeUserPool: every template property read back",
    () => idp.send(new DescribeUserPoolCommand({ UserPoolId: poolId })).then((r) => r.UserPool),
    (p) => {
      const email = p.SchemaAttributes?.find((a) => a.Name === "email");
      const pp = p.Policies?.PasswordPolicy ?? {};
      return diffs([
        ["Id format <region>_<id>", /^us-east-1_\w+$/.test(p.Id), true],
        ["UserPoolTier", p.UserPoolTier, "ESSENTIALS"],
        ["AllowAdminCreateUserOnly", p.AdminCreateUserConfig?.AllowAdminCreateUserOnly, true],
        [
          "InviteMessageTemplate.EmailSubject",
          p.AdminCreateUserConfig?.InviteMessageTemplate?.EmailSubject,
          INVITE_SUBJECT,
        ],
        [
          "InviteMessageTemplate.EmailMessage",
          p.AdminCreateUserConfig?.InviteMessageTemplate?.EmailMessage,
          INVITE_MESSAGE,
        ],
        ["AutoVerifiedAttributes", p.AutoVerifiedAttributes, ["email"]],
        ["UsernameAttributes", p.UsernameAttributes, ["email"]],
        ["Schema email Required", email?.Required, true],
        ["Schema email Mutable", email?.Mutable, false],
        ["EmailSendingAccount", p.EmailConfiguration?.EmailSendingAccount, "COGNITO_DEFAULT"],
        ["PasswordPolicy.MinimumLength", pp.MinimumLength, 8],
        [
          "PasswordPolicy.Require*",
          [pp.RequireUppercase, pp.RequireLowercase, pp.RequireNumbers, pp.RequireSymbols],
          [false, false, false, false],
        ],
        ["UserPoolTags", p.UserPoolTags, POOL_INPUT.UserPoolTags],
      ]);
    },
    (p) =>
      `all match: tier ${p.UserPoolTier}, admin-create-only, invite template, email username/auto-verify/` +
      `immutable+required, ${p.EmailConfiguration?.EmailSendingAccount}, password min ${p.Policies?.PasswordPolicy?.MinimumLength} no Require*, tags`,
  );

  await rec.op(
    "ListTagsForResource (pool ARN)",
    () => idp.send(new ListTagsForResourceCommand({ ResourceArn: pool.Arn })).then((r) => r.Tags),
    (tags) => diffs([["Tags", tags, POOL_INPUT.UserPoolTags]]),
    (tags) => JSON.stringify(tags),
  );

  const adminClient = await createWithFallback(
    `CreateUserPoolClient ${prefix}-admin`,
    { UserPoolId: poolId, ...ADMIN_CLIENT_INPUT },
    ["PreventUserExistenceErrors", "TokenValidityUnits"],
    (input) => idp.send(new CreateUserPoolClientCommand(input)).then((r) => r.UserPoolClient),
    (c) => `ClientId ${c.ClientId}`,
  );
  adminClientId = adminClient?.ClientId;
  const deviceClient = await createWithFallback(
    `CreateUserPoolClient ${prefix}-devices`,
    { UserPoolId: poolId, ...DEVICE_CLIENT_INPUT },
    ["EnableTokenRevocation", "PreventUserExistenceErrors", "TokenValidityUnits"],
    (input) => idp.send(new CreateUserPoolClientCommand(input)).then((r) => r.UserPoolClient),
    (c) => `ClientId ${c.ClientId}`,
  );
  deviceClientId = deviceClient?.ClientId;

  for (const [name, id, input] of [
    ["admin", adminClientId, ADMIN_CLIENT_INPUT],
    ["devices", deviceClientId, DEVICE_CLIENT_INPUT],
  ]) {
    if (!id) continue;
    await rec.op(
      `DescribeUserPoolClient ${name}: template properties read back`,
      () =>
        idp
          .send(new DescribeUserPoolClientCommand({ UserPoolId: poolId, ClientId: id }))
          .then((r) => r.UserPoolClient),
      (c) =>
        diffs([
          ["ClientSecret absent", c.ClientSecret === undefined, true],
          [
            "ExplicitAuthFlows",
            [...(c.ExplicitAuthFlows ?? [])].sort(),
            [...input.ExplicitAuthFlows].sort(),
          ],
          [
            "TokenValidityUnits",
            pick(c.TokenValidityUnits, Object.keys(input.TokenValidityUnits)),
            input.TokenValidityUnits,
          ],
          ["RefreshTokenValidity", c.RefreshTokenValidity, input.RefreshTokenValidity],
          ["IdTokenValidity", c.IdTokenValidity, input.IdTokenValidity],
          ["AccessTokenValidity", c.AccessTokenValidity, input.AccessTokenValidity],
          ["EnableTokenRevocation", c.EnableTokenRevocation, input.EnableTokenRevocation ?? true],
          ["PreventUserExistenceErrors", c.PreventUserExistenceErrors, "ENABLED"],
        ]),
      (c) =>
        `all match: no secret, ${c.ExplicitAuthFlows?.join("+")}, refresh ${c.RefreshTokenValidity} ` +
        `${c.TokenValidityUnits?.RefreshToken}` +
        (c.IdTokenValidity
          ? `, id/access ${c.IdTokenValidity}/${c.AccessTokenValidity} ${c.TokenValidityUnits?.IdToken}`
          : "") +
        `, revocation ${c.EnableTokenRevocation}, PreventUserExistenceErrors ${c.PreventUserExistenceErrors}`,
    );
  }

  for (const group of ["starkeep-admins", "starkeep-users"]) {
    await rec.op(
      `CreateGroup ${group}`,
      () => idp.send(new CreateGroupCommand({ UserPoolId: poolId, GroupName: group })),
      undefined,
      (r) => `GroupName ${r.Group?.GroupName}`,
    );
  }

  const domain = `${prefix}-${accountId ?? "000000000000"}`;
  await rec.op(
    `CreateUserPoolDomain ${prefix}-<account> (ManagedLoginVersion 2; control plane only)`,
    () =>
      idp.send(
        new CreateUserPoolDomainCommand({
          Domain: domain,
          UserPoolId: poolId,
          ManagedLoginVersion: 2,
        }),
      ),
    undefined,
    (r) =>
      `ManagedLoginVersion ${r.ManagedLoginVersion ?? "absent"}, CloudFrontDomain ${r.CloudFrontDomain ?? "absent"}`,
  );
  await rec.op(
    "DescribeUserPoolDomain",
    () =>
      idp
        .send(new DescribeUserPoolDomainCommand({ Domain: domain }))
        .then((r) => r.DomainDescription),
    (d) =>
      diffs([
        ["UserPoolId", d?.UserPoolId, poolId],
        ["Status", d?.Status, "ACTIVE"],
        ["ManagedLoginVersion", d?.ManagedLoginVersion, 2],
      ]),
    (d) => `Status ${d?.Status}, CloudFrontDistribution ${d?.CloudFrontDistribution ?? "absent"}`,
  );

  const providerName = `cognito-idp.${region}.amazonaws.com/${poolId}`;
  const idPool = await rec.op(
    `CreateIdentityPool ${prefix}_admin (provider ${"cognito-idp.us-east-1.amazonaws.com/<poolId>"} for the admin client)`,
    () =>
      identity.send(
        new CreateIdentityPoolCommand({
          IdentityPoolName: `${prefix}_admin`,
          AllowUnauthenticatedIdentities: false,
          CognitoIdentityProviders: [
            { ClientId: adminClientId, ProviderName: providerName, ServerSideTokenCheck: false },
          ],
        }),
      ),
    undefined,
    (r) => `IdentityPoolId ${r.IdentityPoolId}`,
  );
  identityPoolId = idPool?.IdentityPoolId;
  await rec.op(
    "DescribeIdentityPool: template properties read back",
    () => identity.send(new DescribeIdentityPoolCommand({ IdentityPoolId: identityPoolId })),
    (r) =>
      diffs([
        ["AllowUnauthenticatedIdentities", r.AllowUnauthenticatedIdentities, false],
        [
          "CognitoIdentityProviders",
          r.CognitoIdentityProviders,
          [{ ProviderName: providerName, ClientId: adminClientId, ServerSideTokenCheck: false }],
        ],
      ]),
    (r) =>
      `all match: unauthenticated ${r.AllowUnauthenticatedIdentities}, 1 provider, ServerSideTokenCheck false`,
  );

  // The admin-app role. Its trust policy is the template's; its permission
  // policy is left out: IAM evaluation is out of scope, and the emulator does
  // not scope Cognito-vended sessions to the role anyway ([G-cid-session]).
  const role = await rec.op(
    `IAM CreateRole ${prefix}-app-admin-role (template trust policy and tags, no permission policy)`,
    () =>
      iam.send(
        new CreateRoleCommand({
          RoleName: `${prefix}-app-admin-role`,
          AssumeRolePolicyDocument: JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Principal: { Federated: "cognito-identity.amazonaws.com" },
                Action: "sts:AssumeRoleWithWebIdentity",
                Condition: {
                  StringEquals: { "cognito-identity.amazonaws.com:aud": identityPoolId },
                  "ForAnyValue:StringLike": {
                    "cognito-identity.amazonaws.com:amr": "authenticated",
                  },
                },
              },
            ],
          }),
          Tags: [
            { Key: "starkeep:managed", Value: "true" },
            { Key: "starkeep:appId", Value: "admin" },
            { Key: "StackPrefix", Value: prefix },
          ],
        }),
      ),
    undefined,
    (r) => `Arn ${r.Role?.Arn}`,
  );
  roleArn = role?.Role?.Arn;

  const roleMappings = {
    [`${providerName}:${adminClientId}`]: {
      Type: "Rules",
      AmbiguousRoleResolution: "Deny",
      RulesConfiguration: {
        Rules: [
          {
            Claim: "cognito:groups",
            MatchType: "Contains",
            Value: "starkeep-admins",
            RoleARN: roleArn,
          },
        ],
      },
    },
  };
  await rec.op(
    "SetIdentityPoolRoles Roles {} + rule cognito:groups Contains starkeep-admins → role, Deny",
    () =>
      identity.send(
        new SetIdentityPoolRolesCommand({
          IdentityPoolId: identityPoolId,
          Roles: {},
          RoleMappings: roleMappings,
        }),
      ),
    undefined,
    () => "accepted",
  );
  await rec.op(
    "GetIdentityPoolRoles: read back",
    () => identity.send(new GetIdentityPoolRolesCommand({ IdentityPoolId: identityPoolId })),
    (r) =>
      diffs([
        ["Roles", r.Roles ?? {}, {}],
        ["RoleMappings", r.RoleMappings, roleMappings],
      ]),
    () => "Roles {}, RoleMappings as set",
  );

  // ==== 2. The first admin, as apps/admin-web/src/routes/users.ts creates one ====
  rec.section("users");

  /**
   * AdminCreateUser exactly as users.ts CREATE sends it (no MessageAction, so
   * Cognito would email the invitation). If that is refused, retry with
   * MessageAction SUPPRESS, as e2e-aws/src/admin-user.ts sends it.
   */
  async function createUser(who, groups, { rows = true } = {}) {
    const email = emailFor(who);
    const temp = pw();
    const op = rows ? rec.op.bind(rec) : quiet;
    const base = {
      UserPoolId: poolId,
      Username: email,
      UserAttributes: [
        { Name: "email", Value: email },
        { Name: "email_verified", Value: "true" },
      ],
      DesiredDeliveryMediums: ["EMAIL"],
    };
    let created = await op(
      `AdminCreateUser ${who} (users.ts input: email, email_verified, DesiredDeliveryMediums EMAIL, no MessageAction)`,
      () => idp.send(new AdminCreateUserCommand(base)),
      undefined,
      (r) =>
        `UserStatus ${r.User?.UserStatus}, Username ${r.User?.Username === email ? "= email" : "a generated id (sub)"}`,
    );
    if (!created) {
      created = await op(
        `AdminCreateUser ${who}, retried with MessageAction SUPPRESS (as e2e-aws sends)`,
        () => idp.send(new AdminCreateUserCommand({ ...base, MessageAction: "SUPPRESS" })),
        () => "SUPPRESS is needed",
        (r) => `UserStatus ${r.User?.UserStatus}`,
      );
    }
    const username = created?.User?.Username ?? email;
    for (const group of groups) {
      await op(
        `AdminAddUserToGroup ${who} → ${group}`,
        () =>
          idp.send(
            new AdminAddUserToGroupCommand({
              UserPoolId: poolId,
              Username: username,
              GroupName: group,
            }),
          ),
        undefined,
        () => "added",
      );
    }
    await op(
      `AdminSetUserPassword ${who} Permanent false`,
      () =>
        idp.send(
          new AdminSetUserPasswordCommand({
            UserPoolId: poolId,
            Username: username,
            Password: temp,
            Permanent: false,
          }),
        ),
      undefined,
      () => "set",
    );
    await op(
      `AdminGetUser ${who}: status and attributes`,
      () => idp.send(new AdminGetUserCommand({ UserPoolId: poolId, Username: username })),
      (r) =>
        diffs([
          ["UserStatus", r.UserStatus, "FORCE_CHANGE_PASSWORD"],
          ["email_verified", attr(r.UserAttributes, "email_verified"), "true"],
          ["email", attr(r.UserAttributes, "email"), email],
        ]),
      (r) =>
        `UserStatus ${r.UserStatus}, email_verified ${attr(r.UserAttributes, "email_verified")}`,
    );
    return { who, email, username, temp };
  }

  const first = await createUser("admin1", ["starkeep-admins", "starkeep-users"]);
  // One more user per code path (each one answers NEW_PASSWORD_REQUIRED once),
  // and one that is in starkeep-users only. Same calls; one summary row each.
  const others = {};
  for (const [who, groups] of [
    ["installer", ["starkeep-admins", "starkeep-users"]],
    ["device", ["starkeep-admins", "starkeep-users"]],
    ["member", ["starkeep-users"]],
  ]) {
    await rec.op(
      `create ${who} (same calls${groups.length === 1 ? ", starkeep-users only" : ", both groups"})`,
      async () => (others[who] = await createUser(who, groups, { rows: false })),
      undefined,
      () => "created, grouped, temporary password set",
    );
  }

  // ==== 3. Sign-in through the real code paths ===================================
  rec.section("signin");
  const adminCfg = { region, userPoolClientId: adminClientId };
  const newPw = { admin1: pw(), installer: pw(), device: pw(), member: pw() };

  // --- admin-web: apps/admin-web/src/lib/cognito-auth.ts ---
  const challenge = await rec.op(
    "admin-web initiateAuth (USER_PASSWORD_AUTH, temporary password)",
    () => adminWeb.initiateAuth(adminCfg, first.email, first.temp),
    (r) =>
      diffs([
        ["challengeName", r.challengeName, "NEW_PASSWORD_REQUIRED"],
        ["session present", typeof r.session === "string" && r.session.length > 0, true],
        ["tokens absent", r.tokens === undefined, true],
      ]),
    (r) => `challengeName ${r.challengeName}, session ${shape(r.session)}`,
  );
  let adminTokens;
  if (challenge?.session) {
    adminTokens = await rec.op(
      "admin-web respondNewPasswordChallenge (NEW_PASSWORD_REQUIRED)",
      () =>
        adminWeb.respondNewPasswordChallenge(
          adminCfg,
          challenge.session,
          first.email,
          newPw.admin1,
        ),
      (t) => diffs([["expiresIn", t.expiresIn, 3600]]),
      showTokens,
    );
  }
  const adminWorkaround = !adminTokens;
  if (adminWorkaround) {
    await permanent(first, newPw.admin1);
    adminTokens = (
      await rec.op(
        "admin-web initiateAuth with the new password (after the workaround)",
        () => adminWeb.initiateAuth(adminCfg, first.email, newPw.admin1),
        (r) => diffs([["tokens", !!r.tokens, true]]),
        (r) => (r.tokens ? showTokens(r.tokens) : `challenge ${r.challengeName}`),
      )
    )?.tokens;
  }
  if (adminTokens) {
    const refreshed = await rec.op(
      "admin-web refreshTokens (REFRESH_TOKEN_AUTH)",
      () => adminWeb.refreshTokens(adminCfg, adminTokens.refreshToken),
      (t) =>
        diffs([
          ["new idToken", t.idToken !== adminTokens.idToken && !!t.idToken, true],
          ["refresh token echoed", t.refreshToken === adminTokens.refreshToken, true],
        ]),
      showTokens,
    );
    if (refreshed) adminTokens = { ...adminTokens, idToken: refreshed.idToken, refreshed: true };
  }
  if (!adminWorkaround) {
    await rec.op(
      "admin-web initiateAuth with the new password (no challenge)",
      () => adminWeb.initiateAuth(adminCfg, first.email, newPw.admin1),
      (r) => diffs([["tokens", !!r.tokens, true]]),
      (r) => (r.tokens ? showTokens(r.tokens) : `challenge ${r.challengeName}`),
    );
  }
  await rec.op(
    "AdminGetUser admin1 after first sign-in",
    () => idp.send(new AdminGetUserCommand({ UserPoolId: poolId, Username: first.username })),
    (r) => diffs([["UserStatus", r.UserStatus, "CONFIRMED"]]),
    (r) => `UserStatus ${r.UserStatus}`,
  );
  await rec.refused(
    "admin-web initiateAuth, wrong password",
    () => adminWeb.initiateAuth(adminCfg, first.email, "wrong-password-1"),
    "NotAuthorizedException",
    (err) =>
      err?.name === "NotAuthorizedException"
        ? null
        : `error class ${err?.name}, AWS gives NotAuthorizedException`,
  );
  await rec.refused(
    "admin-web initiateAuth, unknown user (PreventUserExistenceErrors ENABLED)",
    () => adminWeb.initiateAuth(adminCfg, emailFor("nobody"), "whatever-123"),
    "NotAuthorizedException",
    (err) =>
      err?.name === "NotAuthorizedException"
        ? null
        : `error class ${err?.name}; with PreventUserExistenceErrors ENABLED AWS gives NotAuthorizedException`,
  );

  // Does the SDK sign InitiateAuth? A spike client with a middleware that sees
  // the request after the signing step answers it for the SDK paths.
  await rec.op(
    "SDK InitiateAuth request: is it SigV4-signed? (spike client, same SDK version)",
    async () => {
      const probe = new CognitoIdentityProviderClient({ region });
      let auth = "not seen";
      probe.middlewareStack.addRelativeTo(
        (next) => async (args) => {
          auth = args.request.headers.authorization ?? args.request.headers.Authorization ?? "none";
          return next(args);
        },
        { relation: "after", toMiddleware: "httpSigningMiddleware", name: "spikeSeeAuth" },
      );
      try {
        await probe.send(
          new InitiateAuthCommand({
            AuthFlow: "USER_PASSWORD_AUTH",
            ClientId: adminClientId,
            AuthParameters: { USERNAME: first.email, PASSWORD: "wrong-password-1" },
          }),
        );
      } catch {
        // NotAuthorized; only the header matters here.
      }
      return auth === "none"
        ? "unsigned (no Authorization header)"
        : `signed: ${auth.split(" ")[0]}`;
    },
  );

  // --- admin-installer: packages/admin-installer/src/cognito-auth.ts ---
  await rec.op(
    "installer regionFromUserPoolId(poolId)",
    () => installer.regionFromUserPoolId(poolId),
    (r) => diffs([["region", r, region]]),
  );
  let prompted = 0;
  let installerTokens = await rec.op(
    "installer cognitoPasswordAuthTokens (USER_PASSWORD_AUTH → NEW_PASSWORD_REQUIRED via promptNewPassword)",
    () =>
      installer.cognitoPasswordAuthTokens(
        { userPoolId: poolId, userPoolClientId: adminClientId },
        others.installer.email,
        others.installer.temp,
        async () => {
          prompted += 1;
          return newPw.installer;
        },
      ),
    () => diffs([["promptNewPassword calls", prompted, 1]]),
    (t) =>
      `prompted ${prompted}x; idToken ${shape(t.idToken)}, refreshToken ${shape(t.refreshToken)}`,
  );
  const installerWorkaround = !installerTokens;
  if (installerWorkaround) {
    await permanent(others.installer, newPw.installer);
    installerTokens = await rec.op(
      "installer cognitoPasswordAuthTokens, new password (after the workaround)",
      () =>
        installer.cognitoPasswordAuthTokens(
          { userPoolId: poolId, userPoolClientId: adminClientId },
          others.installer.email,
          newPw.installer,
        ),
      undefined,
      (t) => `idToken ${shape(t.idToken)}, refreshToken ${shape(t.refreshToken)}`,
    );
  }
  if (installerTokens) {
    await rec.op(
      "installer tokens: REFRESH_TOKEN_AUTH (installer has no refresh; admin-web refreshTokens on its token)",
      () => adminWeb.refreshTokens(adminCfg, installerTokens.refreshToken),
      undefined,
      showTokens,
    );
  }
  if (installerTokens && !installerWorkaround) {
    await rec.op(
      "installer cognitoPasswordAuthTokens again, new password (no prompt)",
      () =>
        installer.cognitoPasswordAuthTokens(
          { userPoolId: poolId, userPoolClientId: adminClientId },
          others.installer.email,
          newPw.installer,
        ),
      undefined,
      (t) => `idToken ${shape(t.idToken)}`,
    );
  }

  // --- device: packages/protocol-primitives/src/device-session/cognito-client.ts ---
  // `endpoint` is what STARKEEP_COGNITO_ENDPOINT sets in local-data-server/server.ts.
  // Every call is an unsigned JSON POST over fetch.
  const device = createCognitoClient({
    region,
    userPoolClientId: deviceClientId,
    endpoint: `${endpoint}/`,
  });
  const signIn = await rec.op(
    "device signIn (unsigned fetch InitiateAuth USER_PASSWORD_AUTH, endpoint seam)",
    () => device.signIn(others.device.email, others.device.temp),
    (r) => diffs([["kind", r.kind, "new-password-required"]]),
    (r) => `kind ${r.kind}${r.session ? `, session ${shape(r.session)}` : ""}`,
  );
  let deviceTokens;
  if (signIn?.kind === "new-password-required") {
    deviceTokens = await rec.op(
      "device setNewPassword (unsigned RespondToAuthChallenge NEW_PASSWORD_REQUIRED)",
      () => device.setNewPassword(others.device.email, signIn.session, newPw.device),
      (t) => {
        const { payload } = decodeJwt(t.idToken);
        return diffs([
          ["expiresIn", t.expiresIn, 900],
          ["ID token exp - iat (s)", payload.exp - payload.iat, 900],
        ]);
      },
      showTokens,
    );
  }
  if (!deviceTokens) {
    await permanent(others.device, newPw.device);
    deviceTokens = (
      await rec.op(
        "device signIn with the new password (after the workaround)",
        () => device.signIn(others.device.email, newPw.device),
        (r) => {
          if (r.kind !== "tokens") return `kind ${r.kind}`;
          const { payload } = decodeJwt(r.tokens.idToken);
          return diffs([
            ["expiresIn", r.tokens.expiresIn, 900],
            ["ID token exp - iat (s)", payload.exp - payload.iat, 900],
          ]);
        },
        (r) => (r.kind === "tokens" ? showTokens(r.tokens) : `kind ${r.kind}`),
      )
    )?.tokens;
  }
  if (deviceTokens) {
    await rec.op(
      "device refresh (unsigned REFRESH_TOKEN_AUTH)",
      () => device.refresh(deviceTokens.refreshToken),
      (t) => diffs([["refresh token echoed", t.refreshToken === deviceTokens.refreshToken, true]]),
      showTokens,
    );
    await rec.op(
      "device idTokenClaims (decoded, unverified)",
      () => idTokenClaims(deviceTokens.idToken),
      (c) => diffs([["groups", [...c.groups].sort(), ["starkeep-admins", "starkeep-users"]]]),
      (c) =>
        `sub ${c.sub ? "present" : "absent"}, email ${c.email === others.device.email ? "= user" : c.email}, groups ${c.groups.join(",")}`,
    );
    await rec.op(
      "device revoke (unsigned RevokeToken)",
      () => device.revoke(deviceTokens.refreshToken),
      undefined,
      () => "revoked",
    );
    await rec.refused(
      "device refresh after revoke",
      () => device.refresh(deviceTokens.refreshToken),
      "NotAuthorizedException (Refresh Token has been revoked)",
      (err) =>
        err?.code === "NotAuthorizedException" && err?.status === 400
          ? null
          : `code ${err?.code}, status ${err?.status}`,
    );
  }
  await rec.refused(
    "device signIn, wrong password",
    () => device.signIn(others.device.email, "wrong-password-1"),
    "NotAuthorizedException",
    (err) =>
      err?.code === "NotAuthorizedException" && err?.status === 400
        ? null
        : `code ${err?.code}, status ${err?.status}`,
  );

  // --- app-client: packages/app-client/src/auth/cognito.ts hard-codes the host ---
  await rec.op(
    "app-client refreshTokens (no endpoint option): where does it send?",
    async () => {
      const before = fetchLog.length;
      try {
        await appClientRefresh(
          { region, userPoolClientId: deviceClientId, userPoolId: poolId },
          "x",
        );
      } catch {
        // The fetch guard refuses the public host.
      }
      return fetchLog
        .slice(before)
        .map((f) => `${f.url} (${f.allowed ? "sent" : "refused by guard"})`)
        .join(", ");
    },
    (r) => (r.includes("127.0.0.1") ? null : "starkeep seam: no way to point it at the emulator"),
    (r) => r,
  );

  // ==== 4. Token verification =====================================================
  rec.section("verify");
  const tokensToInspect = [
    ["admin-web ID token (admin client, after refresh)", adminTokens?.idToken, adminClientId],
    ["device ID token (devices client)", deviceTokens?.idToken, deviceClientId],
  ];
  for (const [label, token, aud] of tokensToInspect) {
    if (!token) continue;
    const decoded = await rec.op(
      `decode ${label}`,
      () => decodeJwt(token),
      (d) =>
        diffs([
          ["aud", d.payload.aud, aud],
          ["token_use", d.payload.token_use, "id"],
          [
            "email_verified (AWS includes it once the attribute is set)",
            d.payload.email_verified,
            true,
          ],
        ]),
      (d) => claimFacts(d),
    );
    facts[label] = decoded && claimFacts(decoded);
  }
  if (adminTokens?.accessToken) {
    await rec.op(
      "decode admin-web access token",
      () => decodeJwt(adminTokens.accessToken),
      undefined,
      (d) =>
        `alg ${d.header.alg}, token_use ${d.payload.token_use}, client_id ${d.payload.client_id === adminClientId ? "= admin client" : d.payload.client_id}, ` +
        `iss ${d.payload.iss}, cognito:groups ${JSON.stringify(d.payload["cognito:groups"])}, scope ${d.payload.scope}`,
    );
  }

  const idToken = adminTokens?.idToken;
  if (idToken) {
    const cfg = { region, userPoolClientId: adminClientId, userPoolId: poolId };
    await rec.op(
      "app-client verifyIdToken(emulator ID token)",
      async () => {
        const before = fetchLog.length;
        const result = await verifyIdToken(idToken, cfg);
        return { result, fetches: fetchLog.slice(before).map((f) => f.url) };
      },
      (r) => (r.result === null ? "returns null (an AWS-issued token verifies)" : null),
      (r) =>
        `result ${JSON.stringify(r.result)}; fetches during the call: ${r.fetches.length ? r.fetches.join(", ") : "none (no JWKS fetch)"}`,
    );
    await rec.op(
      "where verifyIdToken stops: its checks replayed on the token, in order",
      async () => {
        const { header, payload } = decodeJwt(idToken);
        const steps = [
          `three parts: ${idToken.split(".").length === 3}`,
          `verify.ts:122 alg === "RS256": ${header.alg === "RS256"} (alg is ${header.alg}) → returns null here`,
          `if reached: verify.ts:43 JWKS URL https://cognito-idp.${region}.amazonaws.com/<poolId>/.well-known/jwks.json (public host)`,
          `if reached: verify.ts:56 keeps kty RSA only; emulator JWKS has kty EC`,
          `if reached: verify.ts:147 iss === issuerFor(cfg): ${payload.iss === issuerFor(cfg)} (expects ${issuerFor(cfg).replace(poolId, "<poolId>")})`,
          `if reached: verify.ts:148 aud === client: ${payload.aud === adminClientId}; :149 token_use id: ${payload.token_use === "id"}`,
        ];
        return steps.join(" | ");
      },
      undefined,
      (s) => s,
    );

    const { header, payload } = decodeJwt(idToken);
    const jwksUrl = `${endpoint}/${poolId}/.well-known/jwks.json`;
    const jwks = await rec.op(
      "GET <endpoint>/<poolId>/.well-known/jwks.json",
      async () => {
        const res = await fetch(jwksUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
        return res.json();
      },
      (j) =>
        j.keys?.some((k) => k.kid === header.kid)
          ? null
          : `no key with the token's kid ${header.kid}`,
      (j) =>
        (j.keys ?? [])
          .map(
            (k) =>
              `kty ${k.kty}, crv ${k.crv}, alg ${k.alg}, use ${k.use}, kid ${k.kid === header.kid ? "= token kid" : k.kid}`,
          )
          .join("; "),
    );
    if (typeof payload.iss === "string" && payload.iss.startsWith(endpoint)) {
      await rec.op(
        "GET <iss>/.well-known/jwks.json (the OIDC-conventional URL)",
        async () => {
          const res = await fetch(`${payload.iss}/.well-known/jwks.json`);
          return {
            status: res.status,
            same: JSON.stringify(await res.json()) === JSON.stringify(jwks),
          };
        },
        (r) => diffs([["status", r.status, 200]]),
        (r) => `HTTP ${r.status}, same document: ${r.same}`,
      );
    }
    const jwk = jwks?.keys?.find((k) => k.kid === header.kid);
    if (jwk) {
      const key = await webcrypto.subtle.importKey(
        "jwk",
        { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, ext: true },
        { name: "ECDSA", namedCurve: jwk.crv },
        false,
        ["verify"],
      );
      const verifyEs256 = (token) => {
        const [h, p, s] = token.split(".");
        return webcrypto.subtle.verify(
          { name: "ECDSA", hash: "SHA-256" },
          key,
          Buffer.from(s, "base64url"),
          new TextEncoder().encode(`${h}.${p}`),
        );
      };
      await rec.op(
        "crypto.subtle ES256 verify of the admin ID token with the JWKS key",
        () => verifyEs256(idToken),
        (ok) => (ok ? null : "signature does not verify"),
        (ok) => `verified: ${ok} (ECDSA P-256, SHA-256, raw r||s signature)`,
      );
      if (deviceTokens?.idToken) {
        await rec.op(
          "crypto.subtle ES256 verify of the device ID token",
          () => verifyEs256(deviceTokens.idToken),
          (ok) => (ok ? null : "signature does not verify"),
          (ok) => `verified: ${ok}`,
        );
      }
      await rec.op(
        "crypto.subtle ES256 verify, payload altered (control)",
        () => {
          const [h, p, s] = idToken.split(".");
          const forged = JSON.parse(Buffer.from(p, "base64url").toString());
          forged["cognito:groups"] = ["starkeep-admins", "forged"];
          return verifyEs256(
            `${h}.${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${s}`,
          );
        },
        (ok) => (ok ? "an altered token verifies" : null),
        (ok) => `verified: ${ok}`,
      );
    }
  }

  // ==== 5. Identity pool, then S3 with the vended keys ============================
  rec.section("identity");
  const fullCfg = { region, userPoolId: poolId, userPoolClientId: adminClientId, identityPoolId };
  let vended;
  if (idToken) {
    vended = await rec.op(
      "admin-web getIdentityPoolCredentials (GetId + GetCredentialsForIdentity)",
      () => adminWeb.getIdentityPoolCredentials(fullCfg, idToken),
      (c) =>
        diffs([
          ["AccessKeyId prefix ASIA", c.accessKeyId.startsWith("ASIA"), true],
          ["expiration in the future", Date.parse(c.expiration) > Date.now(), true],
        ]),
      (c) =>
        `accessKeyId ${keyIdShape(c.accessKeyId)}, secret ${shape(c.secretAccessKey)}, sessionToken ${shape(c.sessionToken)}, ` +
        `expires in ${Math.round((Date.parse(c.expiration) - Date.now()) / 60000)} min`,
    );
  }
  if (installerTokens) {
    await rec.op(
      "installer getIdentityPoolCredentials",
      () =>
        installer.getIdentityPoolCredentials(
          { userPoolId: poolId, userPoolClientId: adminClientId, identityPoolId },
          installerTokens.idToken,
        ),
      (c) => diffs([["AccessKeyId prefix ASIA", c.accessKeyId.startsWith("ASIA"), true]]),
      (c) => `accessKeyId ${keyIdShape(c.accessKeyId)}`,
    );
  }
  if (vended) {
    const asVended = {
      accessKeyId: vended.accessKeyId,
      secretAccessKey: vended.secretAccessKey,
      sessionToken: vended.sessionToken,
    };
    await rec.op(
      "STS GetCallerIdentity with the vended keys (whose session is it?)",
      () => new STSClient({ region, credentials: asVended }).send(new GetCallerIdentityCommand({})),
      (r) =>
        r.Arn?.includes(`assumed-role/${prefix}-app-admin-role/`)
          ? null
          : `not a session of the mapped role (AWS: arn:aws:sts::<acct>:assumed-role/${prefix}-app-admin-role/CognitoIdentityCredentials)`,
      (r) => `Arn ${r.Arn}`,
    );
    const bucket = `${prefix}-files`;
    const otherBucket = `${prefix}-other`;
    for (const b of [bucket, otherBucket]) {
      await rec.op(`S3 CreateBucket ${b.replace(prefix, "<prefix>")} (emulator key, setup)`, () =>
        s3Setup.send(new CreateBucketCommand({ Bucket: b })).then(() => b),
      );
    }
    const vendedS3 = new S3Client({
      endpoint,
      region,
      forcePathStyle: true,
      credentials: asVended,
    });
    const put = (b, key) =>
      vendedS3.send(new PutObjectCommand({ Bucket: b, Key: key, Body: "vended" }));
    await rec.refused(
      "S3 PutObject with the vended keys, role has no policy yet",
      () => put(bucket, "spike/no-policy.txt"),
      "AccessDenied (no identity-based policy allows s3:PutObject)",
    );
    // A one-statement policy, not the admin-app policy: enough to show that a
    // request signed with the vended keys is well-formed and accepted.
    await rec.op(
      "IAM PutRolePolicy: s3:PutObject on <prefix>-files/* only (setup)",
      () =>
        iam.send(
          new PutRolePolicyCommand({
            RoleName: `${prefix}-app-admin-role`,
            PolicyName: "SpikePutObject",
            PolicyDocument: JSON.stringify({
              Version: "2012-10-17",
              Statement: [
                { Effect: "Allow", Action: "s3:PutObject", Resource: `arn:aws:s3:::${bucket}/*` },
              ],
            }),
          }),
        ),
      undefined,
      () => "attached",
    );
    await rec.op(
      "S3 PutObject with the vended keys, policy allows it",
      () => put(bucket, "spike/vended.txt"),
      undefined,
      (r) => `HTTP ${r.$metadata.httpStatusCode}, ETag ${r.ETag}`,
    );
    await rec.refused(
      "S3 PutObject with the vended keys to <prefix>-other (outside the policy; control)",
      () => put(otherBucket, "spike/vended.txt"),
      "AccessDenied",
    );
    await rec.refused(
      "S3 PutObject with a made-up key pair (control)",
      () =>
        new S3Client({
          endpoint,
          region,
          forcePathStyle: true,
          credentials: {
            accessKeyId: "AKIASPIKEMADEUP00000",
            secretAccessKey: "made-up-secret-not-a-credential",
          },
        }).send(new PutObjectCommand({ Bucket: bucket, Key: "spike/madeup.txt", Body: "x" })),
      "403 InvalidAccessKeyId",
    );
  }
  // Refusals the identity pool must make.
  const loginKey = `cognito-idp.${region}.amazonaws.com/${poolId}`;
  const getCreds = async (token) => {
    let stage = "GetId";
    try {
      const id = await identity.send(
        new GetIdCommand({ IdentityPoolId: identityPoolId, Logins: { [loginKey]: token } }),
      );
      stage = "GetCredentialsForIdentity";
      return await identity.send(
        new GetCredentialsForIdentityCommand({
          IdentityId: id.IdentityId,
          Logins: { [loginKey]: token },
        }),
      );
    } catch (err) {
      err.message = `at ${stage}: ${err.message}`;
      throw err;
    }
  };
  if (deviceTokens?.idToken) {
    // The device's refresh token was revoked above; sign in again for this check.
    const again = (await quiet("", () => device.signIn(others.device.email, newPw.device)))?.tokens;
    if (again?.idToken) {
      await rec.refused(
        "GetId + GetCredentialsForIdentity with a devices-client ID token (pool trusts the admin client only)",
        () => getCreds(again.idToken),
        "NotAuthorizedException (token is not from a supported provider of this identity pool)",
        (err) =>
          err?.name === "NotAuthorizedException"
            ? null
            : `refused, but with ${err?.name}; AWS answers NotAuthorizedException`,
      );
    }
  }
  // Setup, not under test: a permanent password, so the member signs in
  // without the NEW_PASSWORD_REQUIRED challenge whatever its state.
  await quiet("", () =>
    idp.send(
      new AdminSetUserPasswordCommand({
        UserPoolId: poolId,
        Username: others.member.username,
        Password: newPw.member,
        Permanent: true,
      }),
    ),
  );
  const memberSignIn = await quiet("", () =>
    installer.cognitoPasswordAuthTokens(
      { userPoolId: poolId, userPoolClientId: adminClientId },
      others.member.email,
      newPw.member,
    ),
  );
  if (memberSignIn) {
    await rec.refused(
      "admin-web getIdentityPoolCredentials, starkeep-users-only member",
      () => adminWeb.getIdentityPoolCredentials(fullCfg, memberSignIn.idToken),
      "(refused locally from cognito:groups before any call)",
    );
    await rec.refused(
      "GetId + GetCredentialsForIdentity direct, member token (no rule matches, AmbiguousRoleResolution Deny)",
      () => getCreds(memberSignIn.idToken),
      "an error (no rule matches and AmbiguousRoleResolution is Deny)",
    );
  }

  // ==== 6. admin-web user management: the real route handlers, as the admin =====
  // The routes take the operator's identity-pool credentials from the request
  // body and the pool id from $STARKEEP_DIR/config.json.
  // The admin-app role has no Cognito permission at this point (its only policy
  // is the one-statement S3 policy above), so these rows also show whether the
  // emulator evaluates IAM for cognito-idp calls signed with vended keys.
  rec.section("routes");
  if (vended) {
    mkdirSync(starkeepDir, { recursive: true });
    writeFileSync(join(starkeepDir, "config.json"), JSON.stringify({ userPoolId: poolId }));
    const session = { credentials: vended, stackPrefix: prefix, region };
    const call = async (handler, extra) => {
      const res = await handler(
        new Request("http://admin-web.invalid/api/users", {
          method: "POST",
          body: JSON.stringify({ ...session, ...extra }),
        }),
      );
      const body = await res.json();
      if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${body.error}`);
      return body;
    };
    const userView = (body, email) => body.users.find((u) => u.email === email);
    const showUsers = (body) =>
      `${body.users.length} users: ${body.users.map((u) => `${u.email.split("@")[0].slice(prefix.length + 1)}(${u.status}${u.admin ? ",admin" : ""}${u.data ? ",data" : ""}${u.enabled ? "" : ",disabled"})`).join(" ")}`;

    await rec.op(
      "users.ts LIST",
      () => call(usersRoutes.LIST),
      (b) => diffs([["user count", b.users.length, 4]]),
      showUsers,
    );
    const invitee = emailFor("invitee");
    await rec.op(
      "users.ts CREATE {email, data} (AdminCreateUser without MessageAction: Cognito emails the invite)",
      () => call(usersRoutes.CREATE, { email: invitee, data: true }),
      (b) =>
        diffs([
          [
            "invitee",
            pickUser(userView(b, invitee)),
            { status: "FORCE_CHANGE_PASSWORD", admin: false, data: true, enabled: true },
          ],
        ]),
      showUsers,
    );
    const inviteeName = (await quiet("", () => call(usersRoutes.LIST)))?.users.find(
      (u) => u.email === invitee,
    )?.username;
    await rec.op(
      "users.ts SET_GROUP invitee → starkeep-admins",
      () =>
        call(usersRoutes.SET_GROUP, {
          username: inviteeName,
          group: "starkeep-admins",
          member: true,
        }),
      (b) => diffs([["invitee admin", userView(b, invitee)?.admin, true]]),
      () => "admin",
    );
    const reset = await rec.op(
      "users.ts RESET_PASSWORD invitee (AdminSetUserPassword Permanent false)",
      () => call(usersRoutes.RESET_PASSWORD, { username: inviteeName }),
      (b) => diffs([["status", userView(b, invitee)?.status, "FORCE_CHANGE_PASSWORD"]]),
      (b) =>
        `temporaryPassword ${shape(b.temporaryPassword)}, status ${userView(b, invitee)?.status}`,
    );
    if (reset) {
      await rec.op(
        "admin-web initiateAuth with the route's temporary password",
        () => adminWeb.initiateAuth(adminCfg, invitee, reset.temporaryPassword),
        (r) => diffs([["challengeName", r.challengeName, "NEW_PASSWORD_REQUIRED"]]),
        (r) => `challengeName ${r.challengeName}`,
      );
    }
    const installerName = (await quiet("", () => call(usersRoutes.LIST)))?.users.find(
      (u) => u.email === others.installer.email,
    )?.username;
    await rec.op(
      "users.ts SIGN_OUT_EVERYWHERE installer (AdminUserGlobalSignOut)",
      () => call(usersRoutes.SIGN_OUT_EVERYWHERE, { username: installerName }),
      undefined,
      () => "signed out",
    );
    if (installerTokens) {
      await rec.refused(
        "admin-web refreshTokens with installer's refresh token after global sign-out",
        () => adminWeb.refreshTokens(adminCfg, installerTokens.refreshToken),
        "NotAuthorizedException (Refresh Token has been revoked)",
      );
    }
    await rec.op(
      "users.ts SET_ENABLED invitee false (AdminDisableUser + AdminUserGlobalSignOut)",
      () => call(usersRoutes.SET_ENABLED, { username: inviteeName, enabled: false }),
      (b) => diffs([["invitee enabled", userView(b, invitee)?.enabled, false]]),
      () => "disabled",
    );
    if (reset) {
      await rec.refused(
        "admin-web initiateAuth as the disabled invitee",
        () => adminWeb.initiateAuth(adminCfg, invitee, reset.temporaryPassword),
        "NotAuthorizedException (User is disabled.)",
        (err) => (err?.name === "NotAuthorizedException" ? null : `error class ${err?.name}`),
      );
    }
    await rec.op(
      "users.ts SET_ENABLED invitee true",
      () => call(usersRoutes.SET_ENABLED, { username: inviteeName, enabled: true }),
      (b) => diffs([["invitee enabled", userView(b, invitee)?.enabled, true]]),
      () => "enabled",
    );
    await rec.op(
      "users.ts SET_GROUP admin1 out of starkeep-admins (others remain, so allowed)",
      () =>
        call(usersRoutes.SET_GROUP, {
          username: first.username,
          group: "starkeep-admins",
          member: false,
        }),
      (b) => diffs([["admin1 admin", userView(b, first.email)?.admin, false]]),
      () => "removed",
    );
  }
} catch (err) {
  rec.aborted(err);
}

rec.emit({
  prefix,
  facts,
  fetches: fetchLog.map(
    (f) => `${f.allowed ? "sent" : "refused"} ${f.url.replace(/\/us-east-1_\w+\//, "/<poolId>/")}`,
  ),
});

// ---- helpers -----------------------------------------------------------------------

function pick(obj, keys) {
  return Object.fromEntries(keys.map((k) => [k, obj?.[k]]));
}

function pickUser(u) {
  return u && { status: u.status, admin: u.admin, data: u.data, enabled: u.enabled };
}

function attr(attrs, name) {
  return attrs?.find((a) => a.Name === name)?.Value;
}

function showTokens(t) {
  const { header, payload } = decodeJwt(t.idToken);
  return (
    `idToken ${shape(t.idToken)} (alg ${header.alg}), accessToken ${shape(t.accessToken)}, ` +
    `refreshToken ${shape(t.refreshToken)}, expiresIn ${t.expiresIn}, id exp-iat ${payload.exp - payload.iat}s`
  );
}

function claimFacts({ header, payload }) {
  return (
    `alg ${header.alg}, kid ${header.kid}, typ ${header.typ ?? "absent"}, iss ${payload.iss}, ` +
    `aud ${payload.aud === adminClientId ? "= admin client" : payload.aud === deviceClientId ? "= devices client" : payload.aud}, ` +
    `token_use ${payload.token_use}, cognito:groups ${JSON.stringify(payload["cognito:groups"])}, ` +
    `email ${payload.email ? "present" : "absent"}, email_verified ${payload.email_verified}, ` +
    `cognito:username ${payload["cognito:username"] ? "present" : "absent"}, exp-iat ${payload.exp - payload.iat}s, auth_time ${payload.auth_time ? "present" : "absent"}`
  );
}

/**
 * The workaround when RespondToAuthChallenge is refused: make the new password
 * permanent with AdminSetUserPassword (spike client, as an admin would), which
 * moves the user to CONFIRMED, so the code path can sign in without the challenge.
 */
async function permanent(user, password) {
  return rec.op(
    `workaround: AdminSetUserPassword ${user.who} Permanent true (spike client)`,
    () =>
      idp.send(
        new AdminSetUserPasswordCommand({
          UserPoolId: poolId,
          Username: user.username,
          Password: password,
          Permanent: true,
        }),
      ),
    undefined,
    () => "set; user CONFIRMED without answering the challenge",
  );
}

/** Run a step without a row (setup for a later row); errors are swallowed. */
async function quiet(_op, fn) {
  try {
    return await fn();
  } catch (err) {
    console.error(`[spike] unrecorded step failed: ${describeError(err)}`);
    return undefined;
  }
}

void describeError;
