/**
 * A sandbox for running the teardown scripts in `scripts/` against a fake
 * `aws` CLI.
 *
 * The fake holds an account's resources in a JSON state file. Read calls
 * answer from the state, `--query` runs through the same JMESPath library the
 * real CLI uses, and destructive calls remove the resource, so a test can
 * compare the account before and after a run. A call for a missing resource
 * fails with that service's not-found error. A call the fake does not model
 * fails with `FakeUnmodeled`, so a script that starts calling something new
 * fails its tests until the fake learns the call.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_SCRIPTS = join(__dirname, "..", "..", "..", "..", "scripts");
const JMESPATH = createRequire(__filename).resolve("jmespath");

export const ACCOUNT_ID = "123456789012";
export const REGION = "us-east-2";

export interface Role {
  RoleName: string;
  Tags?: Record<string, string>;
  PermissionsBoundaryArn?: string;
  AttachedPolicies?: string[];
  InlinePolicies?: string[];
}

export interface Account {
  /** Stack name → logical ID → physical ID. */
  stacks: Record<string, Record<string, string>>;
  userPools: {
    Id: string;
    Name: string;
    Tags: Record<string, string>;
    DeletionProtection: string;
  }[];
  identityPools: { IdentityPoolId: string; IdentityPoolName: string }[];
  lambdas: string[];
  logGroups: string[];
  roles: Role[];
  /** Managed policy ARNs. */
  policies: string[];
  apis: { Name: string; ApiId: string }[];
  dsqlClusters: {
    identifier: string;
    tags: Record<string, string>;
    deletionProtectionEnabled: boolean;
  }[];
  distributions: { Id: string; Comment: string; DomainName: string }[];
  certificates: { CertificateArn: string; DomainName: string; Tags: Record<string, string> }[];
  buckets: string[];
  ssmParameters: string[];
  curReports: string[];
  /**
   * Calls that fail: when the call's joined arguments contain `match`, it prints
   * `error`. With `times`, the error fires that many times and then stops.
   */
  errors: { match: string; error: string; times?: number }[];
}

export function emptyAccount(): Account {
  return {
    stacks: {},
    userPools: [],
    identityPools: [],
    lambdas: [],
    logGroups: [],
    roles: [],
    policies: [],
    apis: [],
    dsqlClusters: [],
    distributions: [],
    certificates: [],
    buckets: [],
    ssmParameters: [],
    curReports: [],
    errors: [],
  };
}

/** The resources a full install of one deployment leaves in the account. */
export function deployment(prefix: string): Account {
  const managed = { "starkeep:managed": "true" };
  const userPool = `${REGION}_${prefix}Pool`;
  const identityPool = `${REGION}:${prefix}-identity`;
  const cluster = `${prefix}cluster`;
  const boundaries = ["app", "foundational", "install-ddl", "install-infra"].map(
    (b) => `arn:aws:iam::${ACCOUNT_ID}:policy/${prefix}-${b}-permissions-boundary`,
  );
  return {
    ...emptyAccount(),
    stacks: {
      [`${prefix}-bootstrap`]: { UserPool: userPool, IdentityPool: identityPool },
    },
    userPools: [
      {
        Id: userPool,
        Name: `${prefix}-auth`,
        Tags: { StackPrefix: prefix },
        DeletionProtection: "INACTIVE",
      },
    ],
    identityPools: [{ IdentityPoolId: identityPool, IdentityPoolName: `${prefix}_admin` }],
    lambdas: [`${prefix}-app-cloud-data-server-api`, `${prefix}-app-photos-web`],
    logGroups: [
      `/aws/lambda/${prefix}-app-cloud-data-server-api`,
      `/aws/lambda/${prefix}-app-photos-web`,
    ],
    roles: [
      { RoleName: `${prefix}-app-photos-role`, Tags: managed, InlinePolicies: ["runtime"] },
      { RoleName: `${prefix}-app-cloud-data-server-role`, Tags: managed },
      { RoleName: `${prefix}-app-admin-role`, Tags: managed },
      { RoleName: `${prefix}-manager-role` },
      { RoleName: `${prefix}-install-ddl-role` },
      { RoleName: `${prefix}-install-infra-role` },
    ],
    policies: boundaries,
    apis: [{ Name: `${prefix}-gateway`, ApiId: `${prefix}api` }],
    dsqlClusters: [
      {
        identifier: cluster,
        tags: { "starkeep:appId": "cloud-data-server", "starkeep:stackPrefix": prefix },
        deletionProtectionEnabled: true,
      },
    ],
    distributions: [
      {
        Id: `E${prefix.toUpperCase()}`,
        Comment: `${prefix} platform CDN`,
        DomainName: `${prefix}.cloudfront.net`,
      },
    ],
    certificates: [
      {
        CertificateArn: `arn:aws:acm:us-east-1:${ACCOUNT_ID}:certificate/${prefix}-cert`,
        DomainName: `${prefix}.example.com`,
        Tags: {
          "starkeep:appId": "cloud-data-server",
          "starkeep:stackPrefix": prefix,
          "starkeep:customDomainMode": "external",
        },
      },
    ],
    buckets: ["pulumi-state", "artifacts", "app-assets", "files", "billing"].map(
      (b) => `${prefix}-${b}-${ACCOUNT_ID}-${REGION}`,
    ),
    ssmParameters: [
      `/${prefix}/pulumi/passphrase`,
      `/${prefix}/app-creds/photos`,
      `/${prefix}/app-creds/_cloudfront-signing`,
      `/${prefix}/app-creds/_delegation-signing`,
      `/${prefix}/platform/deployment-settings`,
    ],
    curReports: [`${prefix}-billing`],
  };
}

/** Merges copies of the accounts, list by list, so a test can change the result freely. */
export function mergeAccounts(...accounts: Account[]): Account {
  const out = emptyAccount();
  for (const a of structuredClone(accounts)) {
    out.stacks = { ...out.stacks, ...a.stacks };
    for (const key of Object.keys(out) as (keyof Account)[]) {
      if (key === "stacks") continue;
      (out[key] as unknown[]).push(...(a[key] as unknown[]));
    }
  }
  return out;
}

/** Every identifier a deployment's resources carry, for "never named" assertions. */
export function identifiersOf(a: Account): string[] {
  return [
    ...Object.keys(a.stacks),
    ...Object.values(a.stacks).flatMap((r) => Object.values(r)),
    ...a.userPools.map((p) => p.Id),
    ...a.identityPools.map((p) => p.IdentityPoolId),
    ...a.lambdas,
    ...a.logGroups,
    ...a.roles.map((r) => r.RoleName),
    ...a.policies,
    ...a.apis.flatMap((x) => [x.ApiId, x.Name]),
    ...a.dsqlClusters.map((c) => c.identifier),
    ...a.distributions.map((d) => d.Id),
    ...a.certificates.map((c) => c.CertificateArn),
    ...a.buckets,
    ...a.ssmParameters,
    ...a.curReports,
  ];
}

/** Whether a logged call only reads. */
export function isReadCall(call: string): boolean {
  const [service, op] = call.split(" ");
  return service === "sts" || op === "wait" || /^(list|describe|get|head)-/.test(op);
}

const FAKE_AWS = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const jmespath = require(process.env.FAKE_AWS_JMESPATH);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_AWS_LOG, args.join(" ") + "\n");
const statePath = process.env.FAKE_AWS_STATE;
const st = JSON.parse(fs.readFileSync(statePath, "utf8"));
const [service, op] = args;
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const opName = op.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join("");

function fail(code, message) {
  process.stderr.write("\nAn error occurred (" + code + ") when calling the " + opName + " operation: " + message + "\n");
  process.exit(254);
}
function notFound(what) {
  const code = { iam: "NoSuchEntity", ssm: "ParameterNotFound", apigatewayv2: "NotFoundException" }[service]
    || "ResourceNotFoundException";
  fail(code, what + " not found");
}
for (const e of st.errors) {
  if (!args.join(" ").includes(e.match)) continue;
  if (e.times !== undefined) {
    if (e.times <= 0) continue;
    e.times -= 1;
    fs.writeFileSync(statePath, JSON.stringify(st));
  }
  process.stderr.write(e.error + "\n");
  process.exit(254);
}
function out(result) {
  const q = opt("--query");
  const v = q ? jmespath.search(result, q) : result;
  if (opt("--output") === "text") {
    const t = (x) => x === null || x === undefined ? "None"
      : typeof x === "boolean" ? (x ? "True" : "False") : String(x);
    process.stdout.write((Array.isArray(v) ? v.map(t).join("\t") : t(v)) + "\n");
  } else {
    process.stdout.write(JSON.stringify(v) + "\n");
  }
  process.exit(0);
}
function find(list, pred, what) {
  const item = list.find(pred);
  if (!item) notFound(what);
  return item;
}
function remove(list, pred, what) {
  const i = list.findIndex(pred);
  if (i < 0) notFound(what);
  list.splice(i, 1);
  fs.writeFileSync(statePath, JSON.stringify(st));
  out({});
}
const tagList = (tags, k = "Key", v = "Value") => Object.entries(tags || {}).map(([a, b]) => ({ [k]: a, [v]: b }));
const role = () => find(st.roles, (r) => r.RoleName === opt("--role-name"), opt("--role-name"));
const arnOfCluster = (c) => "arn:aws:dsql:us-east-2:123456789012:cluster/" + c.identifier;

if (op === "wait") out({});
switch (service + " " + op) {
  case "sts get-caller-identity": out({ Account: "123456789012" });

  case "cloudformation describe-stack-resource": {
    const name = opt("--stack-name");
    const stack = st.stacks[name];
    if (!stack) fail("ValidationError", "Stack '" + name + "' does not exist");
    const id = stack[opt("--logical-resource-id")];
    if (!id) fail("ValidationError", "Resource " + opt("--logical-resource-id") + " does not exist for stack " + name);
    out({ StackResourceDetail: { PhysicalResourceId: id } });
  }
  case "cloudformation describe-stacks": {
    const name = opt("--stack-name");
    if (!st.stacks[name]) fail("ValidationError", "Stack with id " + name + " does not exist");
    out({ Stacks: [{ StackName: name }] });
  }
  case "cloudformation delete-stack":
    delete st.stacks[opt("--stack-name")];
    fs.writeFileSync(statePath, JSON.stringify(st));
    out({});

  case "cognito-idp list-user-pools": out({ UserPools: st.userPools.map((p) => ({ Id: p.Id, Name: p.Name })) });
  case "cognito-idp describe-user-pool": {
    const p = find(st.userPools, (x) => x.Id === opt("--user-pool-id"), "User pool " + opt("--user-pool-id"));
    out({ UserPool: { Id: p.Id, Name: p.Name, UserPoolTags: p.Tags, DeletionProtection: p.DeletionProtection } });
  }
  case "cognito-idp update-user-pool":
    find(st.userPools, (x) => x.Id === opt("--user-pool-id"), "User pool");
    out({});
  case "cognito-idp delete-user-pool":
    remove(st.userPools, (x) => x.Id === opt("--user-pool-id"), "User pool " + opt("--user-pool-id"));
  case "cognito-identity list-identity-pools": out({ IdentityPools: st.identityPools });
  case "cognito-identity describe-identity-pool":
    out(find(st.identityPools, (x) => x.IdentityPoolId === opt("--identity-pool-id"), "IdentityPool"));
  case "cognito-identity delete-identity-pool":
    remove(st.identityPools, (x) => x.IdentityPoolId === opt("--identity-pool-id"), "IdentityPool " + opt("--identity-pool-id"));

  case "lambda list-functions": out({ Functions: st.lambdas.map((n) => ({ FunctionName: n })) });
  case "lambda delete-function": remove(st.lambdas, (n) => n === opt("--function-name"), "Function");
  case "logs describe-log-groups": {
    const prefix = opt("--log-group-name-prefix") || "";
    out({ logGroups: st.logGroups.filter((g) => g.startsWith(prefix)).map((g) => ({ logGroupName: g })) });
  }
  case "logs delete-log-group": remove(st.logGroups, (g) => g === opt("--log-group-name"), "Log group");

  case "iam list-roles":
    out({ Roles: st.roles.map((r) => ({
      RoleName: r.RoleName,
      ...(r.PermissionsBoundaryArn ? { PermissionsBoundary: { PermissionsBoundaryArn: r.PermissionsBoundaryArn } } : {}),
    })) });
  case "iam list-role-tags": out({ Tags: tagList(role().Tags) });
  case "iam get-role": out({ Role: { RoleName: role().RoleName } });
  case "iam list-attached-role-policies":
    out({ AttachedPolicies: (role().AttachedPolicies || []).map((a) => ({ PolicyArn: a })) });
  case "iam list-role-policies": out({ PolicyNames: role().InlinePolicies || [] });
  case "iam delete-role-permissions-boundary": {
    const r = role();
    if (!r.PermissionsBoundaryArn) notFound("Permissions boundary");
    delete r.PermissionsBoundaryArn;
    fs.writeFileSync(statePath, JSON.stringify(st));
    out({});
  }
  case "iam detach-role-policy": {
    const r = role();
    r.AttachedPolicies = (r.AttachedPolicies || []).filter((a) => a !== opt("--policy-arn"));
    fs.writeFileSync(statePath, JSON.stringify(st));
    out({});
  }
  case "iam delete-role-policy": {
    const r = role();
    r.InlinePolicies = (r.InlinePolicies || []).filter((p) => p !== opt("--policy-name"));
    fs.writeFileSync(statePath, JSON.stringify(st));
    out({});
  }
  case "iam delete-role": remove(st.roles, (r) => r.RoleName === opt("--role-name"), "Role");
  case "iam get-policy": out({ Policy: { Arn: find(st.policies, (p) => p === opt("--policy-arn"), "Policy") } });
  case "iam list-entities-for-policy": out({ PolicyRoles: [] });
  case "iam list-policy-versions": out({ Versions: [] });
  case "iam delete-policy": remove(st.policies, (p) => p === opt("--policy-arn"), "Policy");

  case "apigatewayv2 get-apis": out({ Items: st.apis });
  case "apigatewayv2 delete-api": remove(st.apis, (a) => a.ApiId === opt("--api-id"), "API");

  case "dsql list-clusters":
    out({ clusters: st.dsqlClusters.map((c) => ({ identifier: c.identifier, arn: arnOfCluster(c) })) });
  case "dsql list-tags-for-resource":
    out({ tags: find(st.dsqlClusters, (c) => arnOfCluster(c) === opt("--resource-arn"), "Cluster").tags });
  case "dsql get-cluster": {
    const c = find(st.dsqlClusters, (x) => x.identifier === opt("--identifier"), "Cluster");
    out({ identifier: c.identifier, status: "ACTIVE", deletionProtectionEnabled: c.deletionProtectionEnabled });
  }
  case "dsql update-cluster":
    find(st.dsqlClusters, (x) => x.identifier === opt("--identifier"), "Cluster").deletionProtectionEnabled = false;
    fs.writeFileSync(statePath, JSON.stringify(st));
    out({});
  case "dsql delete-cluster": {
    const c = find(st.dsqlClusters, (x) => x.identifier === opt("--identifier"), "Cluster");
    if (c.deletionProtectionEnabled) fail("ValidationException", "Cluster has deletion protection enabled");
    remove(st.dsqlClusters, (x) => x === c, "Cluster");
  }

  case "cloudfront list-distributions":
    out({ DistributionList: st.distributions.length ? { Items: st.distributions } : { Quantity: 0 } });
  case "cloudfront get-distribution": {
    const d = find(st.distributions, (x) => x.Id === opt("--id"), "Distribution");
    out({ ETag: "E1", Distribution: { Id: d.Id, DomainName: d.DomainName, Status: "Deployed",
      DistributionConfig: { Enabled: false } } });
  }
  case "cloudfront get-distribution-config":
    find(st.distributions, (x) => x.Id === opt("--id"), "Distribution");
    out({ ETag: "E1", DistributionConfig: { Enabled: false, Aliases: { Quantity: 0 } } });
  case "cloudfront delete-distribution": remove(st.distributions, (x) => x.Id === opt("--id"), "Distribution");
  case "cloudfront list-key-groups": out({ KeyGroupList: { Items: [] } });
  case "cloudfront list-public-keys": out({ PublicKeyList: { Items: [] } });
  case "cloudfront list-origin-access-controls": out({ OriginAccessControlList: { Items: [] } });
  case "cloudfront list-cache-policies": out({ CachePolicyList: { Items: [] } });
  case "cloudfront describe-function": fail("NoSuchFunctionExists", "The function does not exist");

  case "acm list-certificates":
    out({ CertificateSummaryList: st.certificates.map((c) => ({ CertificateArn: c.CertificateArn })) });
  case "acm list-tags-for-certificate":
    out({ Tags: tagList(find(st.certificates, (c) => c.CertificateArn === opt("--certificate-arn"), "Certificate").Tags) });
  case "acm describe-certificate": {
    const c = find(st.certificates, (x) => x.CertificateArn === opt("--certificate-arn"), "Certificate");
    out({ Certificate: { CertificateArn: c.CertificateArn, DomainName: c.DomainName, InUseBy: [] } });
  }
  case "acm delete-certificate":
    remove(st.certificates, (c) => c.CertificateArn === opt("--certificate-arn"), "Certificate");
  case "route53 list-hosted-zones": out({ HostedZones: [] });

  case "s3api head-bucket":
    if (!st.buckets.includes(opt("--bucket"))) fail("404", "Not Found");
    out({});
  case "s3api list-object-versions": out({});
  case "s3api list-objects-v2": out({});
  case "s3api delete-bucket-policy": out({});
  case "s3api delete-bucket": remove(st.buckets, (b) => b === opt("--bucket"), "Bucket");

  case "ssm get-parameter":
    out({ Parameter: { Name: find(st.ssmParameters, (p) => p === opt("--name"), "Parameter") } });
  case "ssm get-parameters-by-path":
    out({ Parameters: st.ssmParameters.filter((p) => p.startsWith(opt("--path"))).map((p) => ({ Name: p })) });
  case "ssm delete-parameter": remove(st.ssmParameters, (p) => p === opt("--name"), "Parameter");

  case "cur describe-report-definitions":
    out({ ReportDefinitions: st.curReports.map((n) => ({ ReportName: n })) });
  case "cur delete-report-definition": remove(st.curReports, (n) => n === opt("--report-name"), "Report");

  default:
    fail("FakeUnmodeled", args.join(" "));
}
`;

export interface RunResult {
  status: number | null;
  output: string;
  /** Every aws call, as its space-joined arguments. */
  calls: string[];
  /** The account after the run. */
  account: Account;
}

export interface Sandbox {
  dir: string;
  configFile: string;
  /** Replaces one of the copied scripts with `body`. */
  stub(script: string, body: string): void;
  run(script: string, args: string[], account: Account): RunResult;
  cleanup(): void;
}

/**
 * Copies every script in `scripts/` into a temp directory, puts the fake `aws`
 * first on PATH, and points STARKEEP_DIR at a temp config. `homeConfig`, when
 * given, becomes `$HOME/.starkeep/config.json`, the config a run without
 * STARKEEP_DIR would read.
 */
export function createSandbox(
  config: Record<string, unknown>,
  homeConfig?: Record<string, unknown>,
): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "teardown-"));
  for (const sub of ["scripts", "bin", "starkeep", "env"]) mkdirSync(join(dir, sub));
  if (homeConfig) {
    mkdirSync(join(dir, ".starkeep"));
    writeFileSync(join(dir, ".starkeep", "config.json"), JSON.stringify(homeConfig));
  }
  for (const f of readdirSync(REPO_SCRIPTS)) {
    if (!f.endsWith(".sh")) continue;
    copyFileSync(join(REPO_SCRIPTS, f), join(dir, "scripts", f));
    chmodSync(join(dir, "scripts", f), 0o755);
  }
  writeFileSync(join(dir, "bin", "aws"), FAKE_AWS);
  chmodSync(join(dir, "bin", "aws"), 0o755);
  // The scripts wait between retries of a throttled call. The tests skip the wait.
  writeFileSync(join(dir, "bin", "sleep"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(dir, "bin", "sleep"), 0o755);
  const configFile = join(dir, "starkeep", "config.json");
  writeFileSync(configFile, JSON.stringify(config));

  return {
    dir,
    configFile,
    stub(script, body) {
      writeFileSync(join(dir, "scripts", script), body);
      chmodSync(join(dir, "scripts", script), 0o755);
    },
    run(script, args, account) {
      const state = join(dir, "state.json");
      const log = join(dir, "aws.log");
      writeFileSync(state, JSON.stringify(account));
      writeFileSync(log, "");
      const result = spawnSync("bash", [join(dir, "scripts", script), ...args], {
        encoding: "utf8",
        env: {
          PATH: `${join(dir, "bin")}:${process.env.PATH}`,
          HOME: dir,
          STARKEEP_DIR: join(dir, "starkeep"),
          STARKEEP_ENV_DIR: join(dir, "env"),
          FAKE_AWS_LOG: log,
          FAKE_AWS_STATE: state,
          FAKE_AWS_JMESPATH: JMESPATH,
        },
      });
      return {
        status: result.status,
        output: result.stdout + result.stderr,
        calls: readFileSync(log, "utf8").split("\n").filter(Boolean),
        account: JSON.parse(readFileSync(state, "utf8")) as Account,
      };
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
