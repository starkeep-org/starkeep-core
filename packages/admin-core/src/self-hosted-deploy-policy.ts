/**
 * Single source of truth for the IAM policy statements that grant
 * permission to deploy and operate the Starkeep user-data SST stack
 * (`infra/user-data/sst.config.ts`).
 *
 * Two consumers:
 *   1. `self-hosted-permissions-template.ts` renders these statements into a
 *      managed-policy CloudFormation stack (`{stackPrefix}-deploy-permissions`),
 *      which is created and updated by admin-web post-bootstrap.
 *   2. admin-web reads `statementMetadata` to render a "deploy permissions"
 *      management page that explains why each permission is needed.
 *
 * The bootstrap stack itself does NOT include any of these statements — it
 * only grants the role permission to manage the permissions stack. This
 * decouples iteration on permissions from teardown of the bootstrap stack.
 */

export type CfnValue =
  | string
  | { Sub: string }
  | { GetAtt: string }
  | { Ref: string };

export interface IamStatement {
  Sid: string;
  Effect: "Allow" | "Deny";
  Action: string | string[];
  Resource: CfnValue | CfnValue[];
  Condition?: Record<string, Record<string, CfnValue | CfnValue[]>>;
}

export interface StatementMeta {
  label: string;
  reason: string;
  requiredBy: string[];
}

const SUB = (s: string): CfnValue => ({ Sub: s });

export function deployPermissionStatements(): IamStatement[] {
  return [
    {
      Sid: "CloudWatchLogsDescribe",
      Effect: "Allow",
      Action: ["logs:DescribeLogGroups", "logs:DescribeLogStreams"],
      Resource: "*",
    },
    {
      Sid: "CloudWatchLogsDelivery",
      Effect: "Allow",
      Action: [
        "logs:CreateLogDelivery",
        "logs:GetLogDelivery",
        "logs:UpdateLogDelivery",
        "logs:DeleteLogDelivery",
        "logs:ListLogDeliveries",
        "logs:PutResourcePolicy",
        "logs:DescribeResourcePolicies",
      ],
      Resource: "*",
    },
    {
      Sid: "CloudWatchLogsDeploy",
      Effect: "Allow",
      Action: "logs:*",
      Resource: [
        SUB("arn:aws:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/lambda/${StackPrefix}*"),
        SUB("arn:aws:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/lambda/${StackPrefix}*:*"),
        SUB("arn:aws:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/codebuild/${StackPrefix}*"),
        SUB("arn:aws:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/codebuild/${StackPrefix}*:*"),
        SUB("arn:aws:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/vendedlogs/apis/${StackPrefix}*"),
        SUB("arn:aws:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/vendedlogs/apis/${StackPrefix}*:*"),
      ],
    },
    {
      Sid: "SstBootstrapSSM",
      Effect: "Allow",
      Action: [
        "ssm:GetParameter",
        "ssm:GetParametersByPath",
        "ssm:PutParameter",
        "ssm:DeleteParameter",
      ],
      Resource: SUB("arn:aws:ssm:${AWS::Region}:${AWS::AccountId}:parameter/sst/*"),
    },
    {
      Sid: "SstBootstrapEcr",
      Effect: "Allow",
      Action: [
        "ecr:CreateRepository",
        "ecr:DescribeRepositories",
        "ecr:TagResource",
        "ecr:ListTagsForResource",
        "ecr:DeleteRepository",
      ],
      Resource: SUB("arn:aws:ecr:${AWS::Region}:${AWS::AccountId}:repository/sst-asset-*"),
    },
    {
      Sid: "S3DeployAccess",
      Effect: "Allow",
      Action: "s3:*",
      Resource: [
        SUB("arn:aws:s3:::${StackPrefix}*"),
        SUB("arn:aws:s3:::${StackPrefix}*/*"),
        "arn:aws:s3:::sst-state-*",
        "arn:aws:s3:::sst-state-*/*",
        "arn:aws:s3:::sst-asset-*",
        "arn:aws:s3:::sst-asset-*/*",
      ],
    },
    {
      Sid: "S3ListAllGlobal",
      Effect: "Allow",
      Action: "s3:ListAllMyBuckets",
      Resource: "*",
    },
    {
      Sid: "CloudFormationDeploy",
      Effect: "Allow",
      Action: [
        "cloudformation:CreateStack",
        "cloudformation:UpdateStack",
        "cloudformation:DeleteStack",
        "cloudformation:DescribeStacks",
        "cloudformation:DescribeStackEvents",
        "cloudformation:DescribeStackResources",
        "cloudformation:GetTemplate",
        "cloudformation:ValidateTemplate",
        "cloudformation:CreateChangeSet",
        "cloudformation:DescribeChangeSet",
        "cloudformation:ExecuteChangeSet",
        "cloudformation:DeleteChangeSet",
        "cloudformation:ListChangeSets",
        "cloudformation:ListStackResources",
        "cloudformation:ListStacks",
        "cloudformation:GetStackPolicy",
        "cloudformation:SetStackPolicy",
      ],
      Resource: "*",
    },
    {
      Sid: "AuroraDsqlDeploy",
      Effect: "Allow",
      Action: [
        "dsql:CreateCluster",
        "dsql:UpdateCluster",
        "dsql:DeleteCluster",
        "dsql:GetCluster",
        "dsql:ListClusters",
        "dsql:TagResource",
        "dsql:UntagResource",
        "dsql:ListTagsForResource",
        "dsql:GetVpcEndpointServiceName",
        "dsql:DbConnect",
        "dsql:DbConnectAdmin",
      ],
      Resource: "*",
    },
    {
      // First dsql:CreateCluster in an account triggers AWS to create the
      // AWSServiceRoleForDSQL service-linked role. Without this permission,
      // the cluster create fails with an AccessDenied that often reads as if
      // it were a DSQL action denial.
      Sid: "IAMServiceLinkedRoleDsql",
      Effect: "Allow",
      Action: "iam:CreateServiceLinkedRole",
      Resource: "arn:aws:iam::*:role/aws-service-role/dsql.amazonaws.com/AWSServiceRoleForDSQL*",
      Condition: {
        StringLike: {
          "iam:AWSServiceName": "dsql.amazonaws.com",
        },
      },
    },
    {
      Sid: "LambdaDeploy",
      Effect: "Allow",
      Action: "lambda:*",
      Resource: SUB("arn:aws:lambda:${AWS::Region}:${AWS::AccountId}:function:${StackPrefix}*"),
    },
    {
      Sid: "LambdaListGlobal",
      Effect: "Allow",
      Action: ["lambda:ListFunctions", "lambda:GetAccountSettings"],
      Resource: "*",
    },
    {
      Sid: "ApiGatewayDeploy",
      Effect: "Allow",
      Action: [
        "apigateway:GET",
        "apigateway:POST",
        "apigateway:PUT",
        "apigateway:DELETE",
        "apigateway:PATCH",
        "apigateway:TagResource",
        "apigateway:UntagResource",
        "apigateway:ListTagsForResource",
      ],
      Resource: "*",
    },
    {
      Sid: "IAMDeployRoles",
      Effect: "Allow",
      Action: [
        "iam:CreateRole",
        "iam:DeleteRole",
        "iam:GetRole",
        "iam:UpdateRole",
        "iam:PutRolePolicy",
        "iam:DeleteRolePolicy",
        "iam:AttachRolePolicy",
        "iam:DetachRolePolicy",
        "iam:GetRolePolicy",
        "iam:ListRolePolicies",
        "iam:ListAttachedRolePolicies",
        "iam:ListInstanceProfilesForRole",
        "iam:TagRole",
        "iam:UntagRole",
      ],
      Resource: SUB("arn:aws:iam::${AWS::AccountId}:role/${StackPrefix}*"),
    },
    {
      Sid: "IAMListGlobal",
      Effect: "Allow",
      Action: "iam:ListRoles",
      Resource: "*",
    },
    {
      Sid: "IAMPassRoleDeploy",
      Effect: "Allow",
      Action: "iam:PassRole",
      Resource: SUB("arn:aws:iam::${AWS::AccountId}:role/${StackPrefix}*"),
      Condition: {
        StringLike: {
          "iam:PassedToService": [
            "cloudformation.amazonaws.com",
            "lambda.amazonaws.com",
            "apigateway.amazonaws.com",
          ],
        },
      },
    },
    {
      Sid: "CurSetup",
      Effect: "Allow",
      Action: ["cur:DescribeReportDefinitions", "cur:PutReportDefinition"],
      Resource: "*",
    },
    {
      Sid: "BudgetsManage",
      Effect: "Allow",
      Action: [
        "budgets:ViewBudget",
        "budgets:CreateBudget",
        "budgets:ModifyBudget",
        "budgets:DeleteBudget",
        "budgets:ViewBudgetAction",
        "budgets:CreateBudgetAction",
        "budgets:UpdateBudgetAction",
        "budgets:DeleteBudgetAction",
        "budgets:ExecuteBudgetAction",
      ],
      Resource: "arn:aws:budgets::*:budget/starkeep-*",
    },
  ];
}

export const statementMetadata: Record<string, StatementMeta> = {
  CloudWatchLogsDescribe: {
    label: "Describe CloudWatch log groups",
    reason: "SST queries log groups during deploy to wire up Lambda outputs.",
    requiredBy: ["sst"],
  },
  CloudWatchLogsDelivery: {
    label: "Manage CloudWatch vended log delivery",
    reason: "API Gateway v2 access logging uses the Vended Logs API; SST configures access logs unconditionally on the $default stage.",
    requiredBy: ["user-data:api-gateway"],
  },
  CloudWatchLogsDeploy: {
    label: "Write to Lambda / API Gateway / CodeBuild log groups",
    reason: "Create and tag log groups for user-data Lambdas, the API Gateway access log, and CodeBuild remote-deploy logs.",
    requiredBy: ["user-data:lambda", "user-data:api-gateway", "remote-deploy"],
  },
  SstBootstrapSSM: {
    label: "SST bootstrap SSM parameters",
    reason: "SST stores its bootstrap config (state bucket name, asset bucket name) under /sst/* in Parameter Store.",
    requiredBy: ["sst"],
  },
  SstBootstrapEcr: {
    label: "SST asset ECR repository",
    reason: "SST always creates an sst-asset-* ECR repository at bootstrap, even for zip-bundled Lambdas. Without this, the very first deploy fails with ecr:CreateRepository AccessDenied.",
    requiredBy: ["sst"],
  },
  S3DeployAccess: {
    label: "Read/write user-data and SST state buckets",
    reason: "Manage the user-data S3 bucket plus SST's sst-state-* (Pulumi state) and sst-asset-* (Lambda asset upload) buckets.",
    requiredBy: ["sst", "user-data:s3"],
  },
  S3ListAllGlobal: {
    label: "List all S3 buckets",
    reason: "SST enumerates buckets to find its state and asset buckets during deploy.",
    requiredBy: ["sst"],
  },
  CloudFormationDeploy: {
    label: "CloudFormation stack lifecycle",
    reason: "SST drives all resource creation via CloudFormation change sets.",
    requiredBy: ["sst"],
  },
  AuroraDsqlDeploy: {
    label: "Aurora DSQL cluster lifecycle and direct connection",
    reason: "Create and manage the per-stage DSQL cluster, plus DbConnect/DbConnectAdmin so the desktop can query the cluster directly.",
    requiredBy: ["user-data:dsql", "desktop:dsql-direct"],
  },
  IAMServiceLinkedRoleDsql: {
    label: "Create AWSServiceRoleForDSQL on first cluster create",
    reason: "AWS auto-creates the DSQL service-linked role on first dsql:CreateCluster in an account; without this permission, the cluster create fails.",
    requiredBy: ["user-data:dsql"],
  },
  LambdaDeploy: {
    label: "Lambda function lifecycle",
    reason: "Create, update, and delete user-data Lambda functions (including function URL config for the photos-web static server).",
    requiredBy: ["user-data:lambda"],
  },
  LambdaListGlobal: {
    label: "List Lambda functions and account settings",
    reason: "SST lists functions and reads account-level concurrency/quota settings during deploy.",
    requiredBy: ["sst"],
  },
  ApiGatewayDeploy: {
    label: "API Gateway v2 HTTP API management",
    reason: "Create the user-data HTTP API, routes, JWT authorizer, and integrations.",
    requiredBy: ["user-data:api-gateway"],
  },
  IAMDeployRoles: {
    label: "Create and manage Lambda execution roles",
    reason: "SST creates a per-function execution role for each Lambda with the user-defined permissions (DSQL connect, S3 access).",
    requiredBy: ["user-data:lambda"],
  },
  IAMListGlobal: {
    label: "List IAM roles",
    reason: "SST enumerates roles during deploy to detect existing resources.",
    requiredBy: ["sst"],
  },
  IAMPassRoleDeploy: {
    label: "Pass execution roles to AWS services",
    reason: "Hand the per-function execution role to Lambda, API Gateway, and CloudFormation when creating those resources.",
    requiredBy: ["user-data:lambda", "user-data:api-gateway"],
  },
  CurSetup: {
    label: "Create and read AWS Cost and Usage Report",
    reason: "Set up a CUR report delivering to the billing S3 bucket so admin-web can display MTD costs without the per-request Cost Explorer fee.",
    requiredBy: ["admin-web:costs"],
  },
  BudgetsManage: {
    label: "Create and manage AWS Budgets",
    reason: "Create, update, and delete a monthly budget with a Budget Action that automatically shuts off Lambda access to DSQL and S3 when the limit is breached.",
    requiredBy: ["admin-web:costs"],
  },
};

export function renderStatementsYaml(
  statements: IamStatement[],
  indentSpaces: number,
): string {
  const indent = " ".repeat(indentSpaces);
  const lines: string[] = [];

  for (const s of statements) {
    lines.push(`${indent}- Sid: ${s.Sid}`);
    lines.push(`${indent}  Effect: ${s.Effect}`);
    lines.push(...renderActionOrResource("Action", s.Action, indent + "  "));
    lines.push(...renderActionOrResource("Resource", s.Resource, indent + "  "));
    if (s.Condition) {
      lines.push(`${indent}  Condition:`);
      for (const [op, kvs] of Object.entries(s.Condition)) {
        lines.push(`${indent}    ${op}:`);
        for (const [k, v] of Object.entries(kvs)) {
          if (Array.isArray(v)) {
            lines.push(`${indent}      ${quoteKey(k)}:`);
            for (const item of v) {
              lines.push(`${indent}        - ${renderCfnScalar(item)}`);
            }
          } else {
            lines.push(`${indent}      ${quoteKey(k)}: ${renderCfnScalar(v)}`);
          }
        }
      }
    }
  }

  return lines.join("\n");
}

function renderActionOrResource(
  key: "Action" | "Resource",
  value: string | CfnValue | (string | CfnValue)[],
  indent: string,
): string[] {
  if (Array.isArray(value)) {
    if (value.length === 1) {
      return [`${indent}${key}: ${renderCfnScalar(value[0]!)}`];
    }
    const lines = [`${indent}${key}:`];
    for (const item of value) {
      lines.push(`${indent}  - ${renderCfnScalar(item)}`);
    }
    return lines;
  }
  return [`${indent}${key}: ${renderCfnScalar(value)}`];
}

function renderCfnScalar(v: CfnValue): string {
  if (typeof v === "string") return quoteScalar(v);
  if ("Sub" in v) return `!Sub '${escapeSingleQuoted(v.Sub)}'`;
  if ("GetAtt" in v) return `!GetAtt ${v.GetAtt}`;
  if ("Ref" in v) return `!Ref ${v.Ref}`;
  throw new Error(`Unsupported CfnValue: ${JSON.stringify(v)}`);
}

function quoteScalar(s: string): string {
  return `'${escapeSingleQuoted(s)}'`;
}

function quoteKey(k: string): string {
  // YAML keys with colons or other punctuation must be quoted.
  if (/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(k)) return k;
  return `'${escapeSingleQuoted(k)}'`;
}

function escapeSingleQuoted(s: string): string {
  return s.replace(/'/g, "''");
}
