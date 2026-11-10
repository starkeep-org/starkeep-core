import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import {
  generateBootstrapTemplate,
  getCloudFormationCreateStackUrl,
  getBootstrapStackOutputsUrl,
  isDeploymentName,
  MAX_DEPLOYMENT_NAME_LENGTH,
  normalizeDeploymentName,
  MAX_INLINE_TEMPLATE_BYTES,
  MAX_STACK_PREFIX_LENGTH,
} from "../src/bootstrap/index.js";

// CFN short-form intrinsics (!Sub / !Ref / !GetAtt) parsed into plain objects
// so the template is assertable as data.
const cfnTags = [
  { tag: "!Sub", resolve: (s: string) => ({ "Fn::Sub": s }) },
  { tag: "!Ref", resolve: (s: string) => ({ Ref: s }) },
  { tag: "!GetAtt", resolve: (s: string) => ({ "Fn::GetAtt": s }) },
  ...(["Not", "Equals"] as const).map((fn) => ({
    tag: `!${fn}`,
    collection: "seq" as const,
    resolve: (seq: { toJSON(): unknown }) => ({ [`Fn::${fn}`]: seq.toJSON() }),
  })),
];

interface CfnResource {
  Type: string;
  Condition?: string;
  DeletionPolicy?: string;
  UpdateReplacePolicy?: string;
  Properties: Record<string, unknown>;
}

interface CfnTemplate {
  Parameters: Record<string, Record<string, unknown>>;
  Conditions: Record<string, unknown>;
  Resources: Record<string, CfnResource>;
  Outputs: Record<string, unknown>;
}

function parseTemplate(stackPrefix?: string): CfnTemplate {
  const raw = generateBootstrapTemplate({
    ...(stackPrefix ? { stackPrefix } : {}),
    deploymentName: "Test Library",
  });
  return parse(raw, { customTags: cfnTags }) as CfnTemplate;
}

const template = parseTemplate();
const resources = template.Resources;

function resourcesOfType(type: string): string[] {
  return Object.entries(resources)
    .filter(([, r]) => r.Type === type)
    .map(([name]) => name);
}

describe("bootstrap template structure", () => {
  it("is valid YAML with CFN short-form intrinsics", () => {
    expect(template.Parameters.StackPrefix).toMatchObject({
      Type: "String",
      Default: "starkeep",
      MaxLength: MAX_STACK_PREFIX_LENGTH,
      AllowedPattern: "^[a-z][a-z0-9-]*$",
    });
  });

  it("creates exactly the five permissions boundaries", () => {
    expect(resourcesOfType("AWS::IAM::ManagedPolicy").sort()).toEqual([
      "AppFoundationalPermissionsBoundary",
      "AppPermissionsBoundary",
      "InstallDdlPermissionsBoundary",
      "InstallInfraPermissionsBoundary",
      "UserDataOwnerPermissionsBoundary",
    ]);
  });

  it("creates exactly the four install-time roles", () => {
    expect(resourcesOfType("AWS::IAM::Role").sort()).toEqual([
      "AdminAppRole",
      "InstallDdlRole",
      "InstallInfraRole",
      "ManagerRole",
    ]);
  });

  it("creates the Cognito auth chain and the three buckets", () => {
    expect(resources.UserPool.Type).toBe("AWS::Cognito::UserPool");
    expect(resources.UserPoolClient.Type).toBe("AWS::Cognito::UserPoolClient");
    expect(resources.DeviceUserPoolClient.Type).toBe("AWS::Cognito::UserPoolClient");
    expect(resources.IdentityPool.Type).toBe("AWS::Cognito::IdentityPool");
    expect(resources.IdentityPoolRoleAttachment.Type).toBe(
      "AWS::Cognito::IdentityPoolRoleAttachment",
    );
    expect(resourcesOfType("AWS::S3::Bucket").sort()).toEqual([
      "AppAssetsBucket",
      "ArtifactsBucket",
      "PulumiStateBucket",
    ]);
  });

  it("lets CloudFront read only the two served prefixes of the app assets bucket", () => {
    // The bucket is public through CloudFront by design. The policy must not
    // reach the deployment record or anything outside the two prefixes, and
    // nothing but CloudFront in this account may read it.
    const bucket = resources.AppAssetsBucket!.Properties;
    expect(bucket.PublicAccessBlockConfiguration).toEqual({
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    });
    const policy = resources.AppAssetsBucketPolicy!;
    expect(policy.Type).toBe("AWS::S3::BucketPolicy");
    const statements = (policy.Properties.PolicyDocument as { Statement: unknown[] }).Statement;
    expect(statements).toEqual([
      {
        Sid: "CloudFrontReadsServedPrefixes",
        Effect: "Allow",
        Principal: { Service: "cloudfront.amazonaws.com" },
        Action: "s3:GetObject",
        Resource: [
          { "Fn::Sub": "arn:aws:s3:::${AppAssetsBucket}/apps/*/_immutable/*" },
          { "Fn::Sub": "arn:aws:s3:::${AppAssetsBucket}/apps/*/_static/*" },
        ],
        Condition: {
          StringLike: {
            "AWS:SourceArn": { "Fn::Sub": "arn:aws:cloudfront::${AWS::AccountId}:distribution/*" },
          },
        },
      },
    ]);
    // No output: the installer and the cloud-data-server program derive the
    // name, and the template sits close to CloudFormation's inline cap.
    expect(template.Outputs).not.toHaveProperty("AppAssetsBucketName");
  });

  it("interpolates a custom stack prefix into generation-time strings", () => {
    const raw = generateBootstrapTemplate({
      stackPrefix: "teststk",
      deploymentName: "Test Library",
    });
    expect(raw).toContain(
      "arn:aws:s3:::teststk-files-*/shared/${aws:PrincipalTag/starkeep:userId}/*",
    );
    expect(raw).not.toContain("arn:aws:s3:::starkeep-files-*");
  });
});

describe("template size", () => {
  it("fits CloudFormation's inline cap, as the tier-3 suite sends it", () => {
    // `e2e-aws` creates and updates the stack with `TemplateBody`, which
    // CloudFormation refuses past 51,200 bytes before creating anything. The
    // worst case: every `${stackPrefix}` at the longest prefix allowed, the
    // longest name, and the longest address an email can have.
    const raw = generateBootstrapTemplate({
      stackPrefix: "s".repeat(MAX_STACK_PREFIX_LENGTH),
      deploymentName: "x".repeat(MAX_DEPLOYMENT_NAME_LENGTH),
      adminEmail: `${"a".repeat(64)}@${"b".repeat(185)}.com`,
    });
    expect(Buffer.byteLength(raw, "utf8")).toBeLessThanOrEqual(MAX_INLINE_TEMPLATE_BYTES);
  });
});

describe("trust policies (who can assume which role)", () => {
  function trustStatements(roleName: string): Array<Record<string, unknown>> {
    const role = resources[roleName].Properties as unknown as {
      AssumeRolePolicyDocument: { Statement: Array<Record<string, unknown>> };
    };
    return role.AssumeRolePolicyDocument.Statement;
  }

  it("AdminAppRole is assumable only via Cognito federation, gated on the identity pool", () => {
    const [stmt] = trustStatements("AdminAppRole");
    expect(trustStatements("AdminAppRole")).toHaveLength(1);
    expect(stmt).toMatchObject({
      Effect: "Allow",
      Principal: { Federated: "cognito-identity.amazonaws.com" },
      Action: "sts:AssumeRoleWithWebIdentity",
    });
    expect(stmt.Condition).toMatchObject({
      StringEquals: { "cognito-identity.amazonaws.com:aud": { Ref: "IdentityPool" } },
      "ForAnyValue:StringLike": { "cognito-identity.amazonaws.com:amr": "authenticated" },
    });
  });

  it("ManagerRole is assumable only by AdminAppRole", () => {
    const [stmt] = trustStatements("ManagerRole");
    expect(trustStatements("ManagerRole")).toHaveLength(1);
    expect(stmt).toMatchObject({
      Effect: "Allow",
      Principal: { AWS: { "Fn::GetAtt": "AdminAppRole.Arn" } },
      Action: "sts:AssumeRole",
    });
  });

  it.each(["InstallDdlRole", "InstallInfraRole"])(
    "%s is assumable only by ManagerRole and is born under its boundary",
    (roleName) => {
      const [stmt] = trustStatements(roleName);
      expect(trustStatements(roleName)).toHaveLength(1);
      expect(stmt).toMatchObject({
        Effect: "Allow",
        Principal: { AWS: { "Fn::GetAtt": "ManagerRole.Arn" } },
        Action: "sts:AssumeRole",
      });
      const props = resources[roleName].Properties as unknown as {
        PermissionsBoundary: unknown;
      };
      expect(props.PermissionsBoundary).toEqual({
        Ref: roleName.replace("Role", "PermissionsBoundary"),
      });
    },
  );

  it("the federated identity pool maps only starkeep-admins to AdminAppRole, and denies everyone else", () => {
    const props = resources.IdentityPoolRoleAttachment.Properties as unknown as {
      Roles?: unknown;
      RoleMappings: Record<
        string,
        {
          Type: string;
          AmbiguousRoleResolution: string;
          RulesConfiguration: { Rules: Array<Record<string, unknown>> };
        }
      >;
    };
    // No default role: a user who matches no rule gets no credentials.
    expect(props.Roles).toEqual({});
    const mapping = props.RoleMappings["userpool"]!;
    expect(mapping.Type).toBe("Rules");
    expect(mapping.AmbiguousRoleResolution).toBe("Deny");
    expect(mapping.RulesConfiguration.Rules).toEqual([
      {
        Claim: "cognito:groups",
        MatchType: "Contains",
        Value: "starkeep-admins",
        RoleARN: { "Fn::GetAtt": "AdminAppRole.Arn" },
      },
    ]);
  });

  it("defines the two account groups in the user pool", () => {
    const groups = resourcesOfType("AWS::Cognito::UserPoolGroup").map(
      (name) => (resources[name]!.Properties as { GroupName: string }).GroupName,
    );
    expect(groups.sort()).toEqual(["starkeep-admins", "starkeep-users"]);
  });
});

describe("the first admin", () => {
  const firstAdminResources = ["FirstAdmin", "FirstAdminInAdmins", "FirstAdminInUsers"];

  it("takes the email from a parameter that defaults to empty", () => {
    expect(template.Parameters.AdminEmail).toMatchObject({ Type: "String", Default: "" });
    // A re-download for an existing stack passes no email. A generated default
    // would carry a different email into a later update and replace the account.
    expect(parseTemplate("teststk").Parameters.AdminEmail!.Default).toBe("");
  });

  it("bakes in the email the wizard asked for on a new deployment", () => {
    const withEmail = (adminEmail: string) =>
      (
        parse(
          generateBootstrapTemplate({
            stackPrefix: "teststk",
            deploymentName: "Test Library",
            adminEmail,
          }),
          {
            customTags: cfnTags,
          },
        ) as CfnTemplate
      ).Parameters.AdminEmail!.Default;
    expect(withEmail("operator@example.com")).toBe("operator@example.com");
    // An apostrophe is valid in an address and must not end the YAML string.
    expect(withEmail("o'brien@example.com")).toBe("o'brien@example.com");
  });

  it("creates the account only when the stack is given an email", () => {
    expect(template.Conditions.HasAdminEmail).toEqual({
      "Fn::Not": [{ "Fn::Equals": [{ Ref: "AdminEmail" }, ""] }],
    });
    for (const name of firstAdminResources) {
      expect(resources[name]!.Condition).toBe("HasAdminEmail");
    }
  });

  it("retains the account and both memberships when removed or replaced", () => {
    // Clearing AdminEmail removes all three. Removing an attachment takes the
    // admin out of the group, past admin-web's last-admin guard.
    for (const name of firstAdminResources) {
      expect(resources[name]).toMatchObject({
        DeletionPolicy: "Retain",
        UpdateReplacePolicy: "Retain",
      });
    }
  });

  it("pins the account's properties, since any change replaces it in every deployment", () => {
    // A replacement creates the same email again, which Cognito refuses, and
    // the whole bootstrap update rolls back.
    expect(resources.FirstAdmin).toMatchObject({ Type: "AWS::Cognito::UserPoolUser" });
    expect(resources.FirstAdmin!.Properties).toEqual({
      UserPoolId: { Ref: "UserPool" },
      Username: { Ref: "AdminEmail" },
      UserAttributes: [
        { Name: "email", Value: { Ref: "AdminEmail" } },
        { Name: "email_verified", Value: "true" },
      ],
      DesiredDeliveryMediums: ["EMAIL"],
    });
  });

  it("puts the account in both groups", () => {
    for (const [name, group] of [
      ["FirstAdminInAdmins", "AdminsGroup"],
      ["FirstAdminInUsers", "UsersGroup"],
    ] as const) {
      expect(resources[name]!.Type).toBe("AWS::Cognito::UserPoolUserToGroupAttachment");
      expect(resources[name]!.Properties).toEqual({
        UserPoolId: { Ref: "UserPool" },
        GroupName: { Ref: group },
        Username: { Ref: "FirstAdmin" },
      });
    }
  });
});

describe("the invitation email", () => {
  const message = (
    resources.UserPool!.Properties.AdminCreateUserConfig as {
      InviteMessageTemplate: { EmailSubject: string; EmailMessage: string };
    }
  ).InviteMessageTemplate;

  it("puts the temporary password alone in its own paragraph", () => {
    // A tap or a double-click then selects exactly the password. The old
    // template ended the sentence with a period right after the password.
    expect(message.EmailMessage).toContain(
      '<p style="font-family: monospace; font-size: 18px">{####}</p>',
    );
    expect(message.EmailMessage).not.toMatch(/\{####\}[^<]/);
    expect(message.EmailMessage).not.toMatch(/[^>]\{####\}/);
  });

  it("is titled the way the wizard tells the operator to look for it", () => {
    expect(message.EmailSubject).toBe("Your Starkeep account");
  });

  it("names the deployment and the username", () => {
    expect(message.EmailMessage).toContain(
      "<p>Your new Starkeep account (Test Library) is ready. Welcome!</p>",
    );
    expect(message.EmailMessage).toContain(
      "<p>Sign in with {username} and this temporary password:</p>",
    );
  });

  it("refuses a name with markup or a Cognito placeholder", () => {
    expect(() => generateBootstrapTemplate({ deploymentName: "Tom & Jerry" })).toThrow();
    expect(() => generateBootstrapTemplate({ deploymentName: "Lab {####}" })).toThrow();
  });
});

describe("the deployment name", () => {
  it("accepts 1 to 32 letters, digits, single spaces, hyphens and underscores", () => {
    expect(isDeploymentName("Koller Family")).toBe(true);
    expect(isDeploymentName("Starkeep e2e_test-2")).toBe(true);
    expect(isDeploymentName("x".repeat(MAX_DEPLOYMENT_NAME_LENGTH))).toBe(true);
    expect(isDeploymentName("")).toBe(false);
    expect(isDeploymentName(" Koller")).toBe(false);
    expect(isDeploymentName("Koller ")).toBe(false);
    expect(isDeploymentName("Koller  Family")).toBe(false);
    expect(isDeploymentName("x".repeat(MAX_DEPLOYMENT_NAME_LENGTH + 1))).toBe(false);
    expect(isDeploymentName("Koller\nFamily")).toBe(false);
    expect(isDeploymentName("Koller\tFamily")).toBe(false);
  });

  it("refuses punctuation, markup, braces and letters outside ASCII", () => {
    for (const name of ["Tom's", "A & B", "<b>", "Lab {####}", "{username}", "Café", "家族"]) {
      expect(isDeploymentName(name)).toBe(false);
    }
  });

  it("normalizes away the spaces at either end and between words", () => {
    expect(normalizeDeploymentName("  Koller   Family ")).toBe("Koller Family");
    expect(isDeploymentName(normalizeDeploymentName("  Koller   Family "))).toBe(true);
  });

  it("is required to generate the template", () => {
    expect(() => generateBootstrapTemplate({ deploymentName: "" })).toThrow(/deployment name/);
  });
});

describe("the managed login page", () => {
  it("runs the pool on the Essentials tier, which managed login needs", () => {
    expect(resources.UserPool!.Properties.UserPoolTier).toBe("ESSENTIALS");
  });

  it("gives the pool a prefix domain on the managed login version", () => {
    const domain = resources.UserPoolDomain!;
    expect(domain.Type).toBe("AWS::Cognito::UserPoolDomain");
    expect(domain.Properties).toEqual({
      Domain: { "Fn::Sub": "${StackPrefix}-${AWS::AccountId}" },
      UserPoolId: { Ref: "UserPool" },
      ManagedLoginVersion: 2,
    });
  });

  it("outputs the page's full host name", () => {
    expect((template.Outputs.CognitoDomain as { Value: unknown }).Value).toEqual({
      "Fn::Sub": "${UserPoolDomain}.auth.${AWS::Region}.amazoncognito.com",
    });
  });
});

describe("the device client", () => {
  const props = () => resources.DeviceUserPoolClient!.Properties as Record<string, unknown>;

  it("signs devices in with a password and refreshes, and offers no other flow", () => {
    expect((props().ExplicitAuthFlows as string[]).sort()).toEqual([
      "ALLOW_REFRESH_TOKEN_AUTH",
      "ALLOW_USER_PASSWORD_AUTH",
    ]);
    expect(props().GenerateSecret).toBe(false);
    expect(props().AllowedOAuthFlows).toBeUndefined();
    expect(props().CallbackURLs).toBeUndefined();
  });

  it("issues fifteen-minute ID tokens and ten-year refresh tokens, revocable one at a time", () => {
    expect(props().TokenValidityUnits).toEqual({
      IdToken: "minutes",
      AccessToken: "minutes",
      RefreshToken: "days",
    });
    expect(props().IdTokenValidity).toBe(15);
    expect(props().RefreshTokenValidity).toBe(3650);
    expect(props().EnableTokenRevocation).toBe(true);
    expect(props().PreventUserExistenceErrors).toBe("ENABLED");
  });

  it("is not trusted by the identity pool, so a device token reaches no AWS role", () => {
    const providers = (
      resources.IdentityPool!.Properties as {
        CognitoIdentityProviders: Array<{ ClientId: unknown }>;
      }
    ).CognitoIdentityProviders;
    expect(providers).toHaveLength(1);
    expect(providers[0]!.ClientId).toEqual({ Ref: "UserPoolClient" });
  });
});

describe("stack outputs", () => {
  it("exposes every output the wizard and installer consume", () => {
    expect(Object.keys(template.Outputs).sort()).toEqual(
      [
        "UserPoolId",
        "UserPoolClientId",
        "DeviceUserPoolClientId",
        "CognitoDomain",
        "IdentityPoolId",
        "AdminAppRoleArn",
        "ManagerRoleArn",
        "AppPermissionsBoundaryArn",
        "AppFoundationalPermissionsBoundaryArn",
        "UserDataOwnerPermissionsBoundaryArn",
        "InstallDdlRoleArn",
        "InstallInfraRoleArn",
        "PulumiStateBucketName",
        "ArtifactsBucketName",
        "Region",
        "StackPrefix",
      ].sort(),
    );
  });
});

describe("console URL helpers", () => {
  it("builds the create-stack URL with an optional stack name", () => {
    expect(getCloudFormationCreateStackUrl("us-east-1")).toBe(
      "https://us-east-1.console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/create/template",
    );
    expect(getCloudFormationCreateStackUrl("us-east-1", { stackName: "my stack" })).toContain(
      "stackName=my%20stack",
    );
  });

  it("builds the stack-outputs URL filtered to the stack name", () => {
    const url = getBootstrapStackOutputsUrl("eu-west-1");
    expect(url).toContain("eu-west-1.console.aws.amazon.com/cloudformation");
    expect(url).toContain("filteringText=starkeep-bootstrap");
  });

  it("quotes a condition operator YAML would read as null", () => {
    // `Null:` unquoted is a YAML null key, and CloudFormation rejects the
    // statement. The per-user boundaries split sessions on a Null condition.
    const raw = generateBootstrapTemplate({ deploymentName: "Test Library" });
    expect(raw).toContain("'Null':");
    expect(raw).not.toMatch(/^\s+Null:/m);
  });
});
