// Creates the per-app compute program's inputs on the emulator, the way the
// cloud-data-server stack and the orchestrator would have in a real account:
// HTTP API + $default stage, JWT and REQUEST authorizers, the exec role, the
// artifacts bucket with apps/<appId>/latest/dist.zip, the Pulumi state bucket
// and /<prefix>/pulumi/passphrase.

import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  ApiGatewayV2Client,
  CreateApiCommand,
  CreateAuthorizerCommand,
  CreateStageCommand,
} from "@aws-sdk/client-apigatewayv2";
import {
  AdminCreateUserCommand,
  AdminInitiateAuthCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
  CreateUserPoolClientCommand,
  CreateUserPoolCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { CreateRoleCommand, IAMClient } from "@aws-sdk/client-iam";
import { CreateFunctionCommand, DeleteFunctionCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { CreateBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { REGION, describeError } from "./lib.mjs";

const lambdaTrust = JSON.stringify({
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Principal: { Service: "lambda.amazonaws.com" },
      Action: "sts:AssumeRole",
    },
  ],
});

export async function createInputs({ rec, stackPrefix, appIds, bundles, tinyZip }) {
  const s3 = new S3Client({ region: REGION, forcePathStyle: true });
  const apigw = new ApiGatewayV2Client({ region: REGION });
  const iam = new IAMClient({ region: REGION });
  const lambda = new LambdaClient({ region: REGION });
  const ssm = new SSMClient({ region: REGION });
  const cognito = new CognitoIdentityProviderClient({ region: REGION });
  const S = "inputs";
  const ctx = { stackPrefix };

  await rec.step(S, "STS GetCallerIdentity", async () => {
    const r = await new STSClient({ region: REGION }).send(new GetCallerIdentityCommand({}));
    ctx.accountId = r.Account;
    return { detail: `account ${r.Account}` };
  });

  // The JWT authorizer needs an issuer whose tokens the emulator can verify.
  // An emulator user pool is the only such issuer (04-cognito.md).
  await rec.step(S, "Cognito pool, client, user, ID token (JWT authorizer issuer)", async () => {
    const pool = await cognito.send(
      new CreateUserPoolCommand({ PoolName: `${stackPrefix}-users` }),
    );
    ctx.userPoolId = pool.UserPool.Id;
    const client = await cognito.send(
      new CreateUserPoolClientCommand({
        UserPoolId: ctx.userPoolId,
        ClientName: "admin",
        ExplicitAuthFlows: ["ALLOW_ADMIN_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
      }),
    );
    ctx.userPoolClientId = client.UserPoolClient.ClientId;
    const username = "spike@example.invalid";
    const password = `Aa1!${randomBytes(12).toString("hex")}`;
    await cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: ctx.userPoolId,
        Username: username,
        MessageAction: "SUPPRESS",
      }),
    );
    await cognito.send(
      new AdminSetUserPasswordCommand({
        UserPoolId: ctx.userPoolId,
        Username: username,
        Password: password,
        Permanent: true,
      }),
    );
    const auth = await cognito.send(
      new AdminInitiateAuthCommand({
        UserPoolId: ctx.userPoolId,
        ClientId: ctx.userPoolClientId,
        AuthFlow: "ADMIN_USER_PASSWORD_AUTH",
        AuthParameters: { USERNAME: username, PASSWORD: password },
      }),
    );
    ctx.idToken = auth.AuthenticationResult.IdToken;
    ctx.issuer = JSON.parse(Buffer.from(ctx.idToken.split(".")[1], "base64url").toString()).iss;
    return { detail: `pool ${ctx.userPoolId}, iss ${ctx.issuer}` };
  });

  await rec.step(S, "API Gateway v2 CreateApi (HTTP) + $default stage, auto-deploy", async () => {
    const api = await apigw.send(
      new CreateApiCommand({ Name: `${stackPrefix}-api`, ProtocolType: "HTTP" }),
    );
    ctx.apiGatewayId = api.ApiId;
    ctx.apiGatewayUrl = api.ApiEndpoint;
    ctx.apiGatewayExecutionArn = `arn:aws:execute-api:${REGION}:${ctx.accountId}:${api.ApiId}`;
    await apigw.send(
      new CreateStageCommand({ ApiId: api.ApiId, StageName: "$default", AutoDeploy: true }),
    );
    return { detail: `apiId ${api.ApiId}, ApiEndpoint ${api.ApiEndpoint}` };
  });

  await rec.step(S, "CreateAuthorizer JWT (issuer = emulator pool)", async () => {
    const a = await apigw.send(
      new CreateAuthorizerCommand({
        ApiId: ctx.apiGatewayId,
        Name: "cognito-jwt",
        AuthorizerType: "JWT",
        IdentitySource: ["$request.header.Authorization"],
        JwtConfiguration: { Issuer: ctx.issuer, Audience: [ctx.userPoolClientId] },
      }),
    );
    ctx.authorizerId = a.AuthorizerId;
    return { detail: `authorizerId ${a.AuthorizerId}` };
  });

  await rec.step(S, "CreateAuthorizer REQUEST (session cookie)", async () => {
    // The real one is the cloud-data-server's Cookie authorizer Lambda, which is
    // out of scope. The ARN names a function that does not exist; no route this
    // spike invokes is CUSTOM-gated.
    const fnArn = `arn:aws:lambda:${REGION}:${ctx.accountId}:function:${stackPrefix}-session-authorizer`;
    const a = await apigw.send(
      new CreateAuthorizerCommand({
        ApiId: ctx.apiGatewayId,
        Name: "session",
        AuthorizerType: "REQUEST",
        AuthorizerUri: `arn:aws:apigateway:${REGION}:lambda:path/2015-03-31/functions/${fnArn}/invocations`,
        IdentitySource: ["$request.header.Cookie"],
        AuthorizerPayloadFormatVersion: "2.0",
        EnableSimpleResponses: true,
      }),
    );
    ctx.sessionAuthorizerId = a.AuthorizerId;
    return { detail: `sessionAuthorizerId ${a.AuthorizerId} (authorizer Lambda not deployed)` };
  });

  await rec.step(S, "IAM CreateRole exec role (lambda.amazonaws.com trust)", async () => {
    const r = await iam.send(
      new CreateRoleCommand({
        RoleName: `${stackPrefix}-app-exec`,
        AssumeRolePolicyDocument: lambdaTrust,
      }),
    );
    ctx.appExecRoleArn = r.Role.Arn;
    ctx.appRoleArn = r.Role.Arn.replace(/-exec$/, "-data");
    return { detail: r.Role.Arn };
  });

  // [G-lambda-role]: does Lambda accept a function without a usable role?
  await rec.step(S, "[G-lambda-role] CreateFunction with no Role", async () => {
    try {
      await lambda.send(
        new CreateFunctionCommand({
          FunctionName: `${stackPrefix}-norole`,
          Runtime: "nodejs22.x",
          Handler: "index.handler",
          Code: { ZipFile: tinyZip },
        }),
      );
      await lambda.send(new DeleteFunctionCommand({ FunctionName: `${stackPrefix}-norole` }));
      return { outcome: "differs", detail: "accepted (AWS rejects: Role is required)" };
    } catch (err) {
      return { detail: `rejected, as AWS does: ${describeError(err)}` };
    }
  });
  await rec.step(
    S,
    "[G-lambda-role] CreateFunction with a role ARN that does not exist",
    async () => {
      const role = `arn:aws:iam::${ctx.accountId}:role/${stackPrefix}-no-such-role`;
      try {
        await lambda.send(
          new CreateFunctionCommand({
            FunctionName: `${stackPrefix}-ghostrole`,
            Runtime: "nodejs22.x",
            Role: role,
            Handler: "index.handler",
            Code: { ZipFile: tinyZip },
          }),
        );
        await lambda.send(new DeleteFunctionCommand({ FunctionName: `${stackPrefix}-ghostrole` }));
        return {
          outcome: "differs",
          detail:
            "accepted (AWS: InvalidParameterValueException, role cannot be assumed by Lambda)",
        };
      } catch (err) {
        return { detail: `rejected, as AWS does: ${describeError(err)}` };
      }
    },
  );

  ctx.artifactsBucket = `${stackPrefix}-artifacts`;
  ctx.pulumiStateBucket = `${stackPrefix}-pulumi-state`;
  ctx.filesBucket = `${stackPrefix}-files`;
  ctx.dsqlHostname = "dsql-not-emulated.invalid"; // DSQL has no data plane; never dialled here
  ctx.bundleHash = {};
  for (const bucket of [ctx.artifactsBucket, ctx.pulumiStateBucket, ctx.filesBucket]) {
    await rec.step(S, `S3 CreateBucket ${bucket}`, async () => {
      await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    });
  }
  for (const appId of appIds) {
    await rec.step(S, `S3 PutObject apps/${appId}/latest/dist.zip`, async () => {
      const body = bundles[appId];
      await s3.send(
        new PutObjectCommand({
          Bucket: ctx.artifactsBucket,
          Key: `apps/${appId}/latest/dist.zip`,
          Body: body,
        }),
      );
      // As orchestrator.ts computes it.
      ctx.bundleHash[appId] = createHash("sha256").update(body).digest("base64");
      return { detail: `${body.length} bytes, sha256 ${ctx.bundleHash[appId]}` };
    });
  }

  await rec.step(
    S,
    `SSM PutParameter /${stackPrefix}/pulumi/passphrase (SecureString)`,
    async () => {
      ctx.passphrase = randomBytes(24).toString("base64url");
      await ssm.send(
        new PutParameterCommand({
          Name: `/${stackPrefix}/pulumi/passphrase`,
          Type: "SecureString",
          Value: ctx.passphrase,
        }),
      );
    },
  );

  return ctx;
}

export function readBundle(path) {
  return readFileSync(path);
}
