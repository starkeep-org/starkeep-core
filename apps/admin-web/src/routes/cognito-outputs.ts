/**
 * The two bootstrap outputs the wizard looks up instead of asking for.
 *
 * Signing in needs only `UserPoolId`, `UserPoolClientId` and `IdentityPoolId`,
 * so the Stack outputs step asks for those three. The other two, the device
 * client and the managed login domain, are first needed by the cloud data
 * server install. Once the operator signs in, the admin-app role can read both
 * from the pool (`ListUserPoolClients` and `DescribeUserPool` in
 * `admin-app-policy.ts`), so the wizard asks this route for them after every
 * sign-in. That also covers a stack update that adds an output: the next
 * sign-in picks it up, and the operator copies nothing.
 *
 * The route only reads. The wizard saves the answer through `PATCH /api/config`
 * the way it saves the three IDs.
 */

import {
  CognitoIdentityProviderClient,
  DescribeUserPoolCommand,
  ListUserPoolClientsCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { readStarkeepConfig } from "../lib/manager-credentials";
import type { STSCredentials } from "../lib/cognito-auth";

interface SessionBody {
  credentials: STSCredentials;
  region: string;
}

export interface CognitoOutputs {
  deviceUserPoolClientId: string;
  cognitoDomain: string;
}

/** The bootstrap template's name for the device client: `${StackPrefix}-devices`. */
export function deviceClientName(stackPrefix: string): string {
  return `${stackPrefix}-devices`;
}

async function findDeviceClientId(
  client: CognitoIdentityProviderClient,
  poolId: string,
  name: string,
): Promise<string | null> {
  let token: string | undefined;
  do {
    const page = await client.send(
      new ListUserPoolClientsCommand({ UserPoolId: poolId, MaxResults: 60, NextToken: token }),
    );
    const match = page.UserPoolClients?.find((c) => c.ClientName === name);
    if (match?.ClientId) return match.ClientId;
    token = page.NextToken;
  } while (token);
  return null;
}

/** Look up the device client and the managed login domain. Body: `{ credentials, region }`. */
export async function POST(req: Request): Promise<Response> {
  const body = (await req.json()) as SessionBody;
  const config = readStarkeepConfig() as { userPoolId?: string; stackPrefix?: string };
  if (!config.userPoolId || !config.stackPrefix) {
    return Response.json(
      { error: "~/.starkeep/config.json has no userPoolId — complete the cloud setup first" },
      { status: 400 },
    );
  }
  const client = new CognitoIdentityProviderClient({
    region: body.region,
    credentials: {
      accessKeyId: body.credentials.accessKeyId,
      secretAccessKey: body.credentials.secretAccessKey,
      sessionToken: body.credentials.sessionToken,
    },
  });
  try {
    const name = deviceClientName(config.stackPrefix);
    const [deviceUserPoolClientId, pool] = await Promise.all([
      findDeviceClientId(client, config.userPoolId, name),
      client.send(new DescribeUserPoolCommand({ UserPoolId: config.userPoolId })),
    ]);
    const domain = pool.UserPool?.Domain;
    // Either gap means the stack predates the resource, or the stack prefix in
    // the config is not the stack's. Updating the stack fixes the first.
    if (!deviceUserPoolClientId) {
      return Response.json(
        {
          error: `The user pool has no app client named ${name}. Update the bootstrap stack with a newly downloaded template, then sign in again.`,
        },
        { status: 404 },
      );
    }
    if (!domain) {
      return Response.json(
        {
          error:
            "The user pool has no managed login domain. Update the bootstrap stack with a newly downloaded template, then sign in again.",
        },
        { status: 404 },
      );
    }
    const outputs: CognitoOutputs = {
      deviceUserPoolClientId,
      cognitoDomain: `${domain}.auth.${body.region}.amazoncognito.com`,
    };
    return Response.json(outputs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api/cognito-outputs] lookup failed", message);
    return Response.json({ error: message }, { status: 500 });
  }
}
