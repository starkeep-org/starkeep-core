import {
  CostAndUsageReportServiceClient,
  DescribeReportDefinitionsCommand,
  PutReportDefinitionCommand,
} from "@aws-sdk/client-cost-and-usage-report-service";
import {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
  PutBucketPolicyCommand,
  ListObjectsV2Command,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import type { STSCredentials } from "./cognito-auth";

export interface ServiceCost {
  service: string;
  amount: number;
}

const SERVICE_LABELS: Record<string, string> = {
  AWSLambda: "Lambda",
  AmazonS3: "S3",
  AmazonAuroraDSQL: "Aurora DSQL",
};

const KNOWN_SERVICES = new Set(Object.keys(SERVICE_LABELS));

const SKIP_LINE_ITEM_TYPES = new Set(["Tax", "Credit", "Refund", "RIFee", "SavingsPlanRecurringFee"]);

function makeCurClient(creds: STSCredentials): CostAndUsageReportServiceClient {
  // CUR service endpoint is always us-east-1 (global service).
  return new CostAndUsageReportServiceClient({
    region: "us-east-1",
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    },
  });
}

function makeS3Client(creds: STSCredentials, region: string): S3Client {
  return new S3Client({
    region,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    },
  });
}

async function getAccountId(creds: STSCredentials): Promise<string> {
  const sts = new STSClient({
    region: "us-east-1",
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      sessionToken: creds.sessionToken,
    },
  });
  const { Account } = await sts.send(new GetCallerIdentityCommand({}));
  if (!Account) throw new Error("Could not determine AWS account ID");
  return Account;
}

async function ensureCurSetup(
  creds: STSCredentials,
  billingBucket: string,
  s3Region: string,
  reportName: string,
  accountId: string,
): Promise<void> {
  const s3 = makeS3Client(creds, s3Region);

  // Create the bucket if needed.
  try {
    await s3.send(new HeadBucketCommand({ Bucket: billingBucket }));
  } catch {
    const createParams =
      s3Region === "us-east-1"
        ? { Bucket: billingBucket }
        : { Bucket: billingBucket, CreateBucketConfiguration: { LocationConstraint: s3Region as never } };
    await s3.send(new CreateBucketCommand(createParams));
  }

  // Idempotency check: skip CUR report creation if it already exists.
  const curClient = makeCurClient(creds);
  const existing = await curClient.send(new DescribeReportDefinitionsCommand({}));
  const alreadyExists = existing.ReportDefinitions?.some((r) => r.ReportName === reportName);
  if (alreadyExists) return;

  // Allow the AWS billing service to deliver reports to the bucket.
  const bucketArn = `arn:aws:s3:::${billingBucket}`;
  const curSourceArn = `arn:aws:cur:us-east-1:${accountId}:definition/*`;
  const curCondition = { StringEquals: { "aws:SourceArn": curSourceArn, "aws:SourceAccount": accountId } };
  const policy = {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "AllowCurServiceCheck",
        Effect: "Allow",
        Principal: { Service: "billingreports.amazonaws.com" },
        Action: ["s3:GetBucketAcl", "s3:GetBucketPolicy"],
        Resource: bucketArn,
        Condition: curCondition,
      },
      {
        Sid: "AllowCurDelivery",
        Effect: "Allow",
        Principal: { Service: "billingreports.amazonaws.com" },
        Action: "s3:PutObject",
        Resource: `${bucketArn}/*`,
        Condition: curCondition,
      },
    ],
  };
  await s3.send(
    new PutBucketPolicyCommand({ Bucket: billingBucket, Policy: JSON.stringify(policy) }),
  );

  // Create the CUR report definition.
  await curClient.send(
    new PutReportDefinitionCommand({
      ReportDefinition: {
        ReportName: reportName,
        TimeUnit: "DAILY",
        Format: "textORcsv",
        Compression: "GZIP",
        AdditionalSchemaElements: [],
        S3Bucket: billingBucket,
        S3Prefix: "reports",
        S3Region: s3Region as never,
        RefreshClosedReports: true,
        ReportVersioning: "OVERWRITE_REPORT",
      },
    }),
  );
}

function billingPeriodPrefix(reportName: string, today = new Date()): string {
  const y = today.getFullYear();
  const m = today.getMonth(); // 0-based
  const pad = (n: number) => String(n).padStart(2, "0");
  const start = `${y}${pad(m + 1)}01`;
  // End date is first day of next month.
  const endDate = new Date(y, m + 1, 1);
  const end = `${endDate.getFullYear()}${pad(endDate.getMonth() + 1)}01`;
  return `reports/${reportName}/${start}-${end}/`;
}

async function decompressGzip(compressed: Uint8Array): Promise<string> {
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  // Ensure the buffer is a plain ArrayBuffer before passing to the Web Streams API.
  writer.write(new Uint8Array(compressed) as unknown as Uint8Array<ArrayBuffer>);
  writer.close();

  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(merged);
}

// RFC 4180 CSV field parser — handles quoted fields containing commas and escaped quotes.
function parseRow(line: string): string[] {
  const fields: string[] = [];
  let i = 0;
  while (i <= line.length) {
    if (line[i] === '"') {
      i++;
      let value = "";
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') {
          value += '"';
          i += 2;
        } else if (line[i] === '"') {
          i++;
          break;
        } else {
          value += line[i++];
        }
      }
      fields.push(value);
      if (line[i] === ",") i++;
    } else {
      const end = line.indexOf(",", i);
      if (end === -1) {
        fields.push(line.slice(i).trim());
        break;
      }
      fields.push(line.slice(i, end).trim());
      i = end + 1;
    }
  }
  return fields;
}

function parseCsvCosts(csv: string): Record<string, number> {
  const lines = csv.split("\n");
  if (lines.length < 2) return {};

  const headers = parseRow(lines[0]!);
  const productCodeIdx = headers.indexOf("lineItem/ProductCode");
  const costIdx = headers.indexOf("lineItem/UnblendedCost");
  const typeIdx = headers.indexOf("lineItem/LineItemType");

  if (productCodeIdx === -1 || costIdx === -1) return {};

  const totals: Record<string, number> = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line?.trim()) continue;
    const cols = parseRow(line);
    if (typeIdx !== -1 && SKIP_LINE_ITEM_TYPES.has(cols[typeIdx] ?? "")) continue;
    const service = cols[productCodeIdx] ?? "";
    const amount = parseFloat(cols[costIdx] ?? "0");
    if (service && !isNaN(amount)) {
      totals[service] = (totals[service] ?? 0) + amount;
    }
  }
  return totals;
}

export async function fetchMtdCostsByService(
  creds: STSCredentials,
  s3Region: string,
  stackPrefix: string,
): Promise<ServiceCost[] | null> {
  const accountId = await getAccountId(creds);
  const billingBucket = `${stackPrefix}-billing-${accountId}`;
  const reportName = `${stackPrefix}-billing`;

  await ensureCurSetup(creds, billingBucket, s3Region, reportName, accountId);

  const s3 = makeS3Client(creds, s3Region);
  const prefix = billingPeriodPrefix(reportName);

  const listed = await s3.send(
    new ListObjectsV2Command({ Bucket: billingBucket, Prefix: prefix }),
  );
  if (!listed.Contents?.length) return null;

  // Find manifest file.
  const manifestKey = listed.Contents.find((o) => o.Key?.endsWith("-Manifest.json"))?.Key;
  if (!manifestKey) return null;

  const manifestObj = await s3.send(new GetObjectCommand({ Bucket: billingBucket, Key: manifestKey }));
  const manifestText = await manifestObj.Body!.transformToString();
  const manifest = JSON.parse(manifestText) as { reportKeys?: string[] };
  const reportKeys = manifest.reportKeys ?? [];

  const rawByService: Record<string, number> = {};
  for (const key of reportKeys) {
    const obj = await s3.send(new GetObjectCommand({ Bucket: billingBucket, Key: key }));
    const bytes = await obj.Body!.transformToByteArray();
    const csv = await decompressGzip(bytes);
    const chunk = parseCsvCosts(csv);
    for (const [service, amount] of Object.entries(chunk)) {
      rawByService[service] = (rawByService[service] ?? 0) + amount;
    }
  }

  const knownOrder = Object.keys(SERVICE_LABELS);
  const known: ServiceCost[] = knownOrder
    .map((code) => ({ service: SERVICE_LABELS[code]!, amount: rawByService[code] ?? 0 }))
    .filter(({ amount }) => amount > 0);

  const unknown: ServiceCost[] = Object.entries(rawByService)
    .filter(([code]) => !KNOWN_SERVICES.has(code))
    .filter(([, amount]) => amount > 0)
    .map(([code, amount]) => ({ service: code, amount }))
    .sort((a, b) => b.amount - a.amount);

  return [...known, ...unknown];
}

export function projectFullMonth(costs: ServiceCost[], today = new Date()): ServiceCost[] {
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  // Days elapsed = day-of-month (1-based), minimum 1 to avoid division by zero.
  const daysElapsed = Math.max(today.getDate(), 1);
  const factor = daysInMonth / daysElapsed;
  return costs.map(({ service, amount }) => ({
    service,
    amount: amount * factor,
  }));
}
