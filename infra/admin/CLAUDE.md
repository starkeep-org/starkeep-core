# Infrastructure App - Context for Claude

## Overview

The **Infrastructure** app (`apps/infra`) contains the SST (Serverless Stack) configuration for deploying Starkeeper's control plane to AWS. This is the infrastructure-as-code that creates the foundational AWS resources needed to run Starkeeper.

**Location**: `apps/infra`

## Purpose

- Deploy Starkeeper control plane infrastructure
- Create S3 bucket for CloudFormation templates
- Optionally create database (Aurora Serverless v2 or use existing)
- Optionally create VPC for production deployments
- Deploy Remix application (currently disabled due to CloudFront restrictions)
- Provide migration Lambda for database schema updates

## What is SST?

SST (Serverless Stack) is an infrastructure-as-code framework built on AWS CDK. It provides:
- Type-safe infrastructure definitions
- Live Lambda development
- Automatic type linking between resources
- Built-in constructs for common patterns (Remix apps, databases, buckets)

**Website**: https://sst.dev/

## Structure

```
apps/infra/
├── sst.config.ts              # SST configuration (main file)
├── sst-env.d.ts               # SST environment types
├── scripts/
│   └── setup-control-plane-user.ts  # Helper script for IAM setup
├── package.json
└── tsconfig.json
```

## SST Configuration

[sst.config.ts](sst.config.ts)

### App Configuration

```typescript
export default $config({
  app(input) {
    return {
      name: "starkeeper",
      removal: input?.stage === "production" ? "retain" : "remove",
      home: "aws",
    };
  },
  async run() {
    // Resources defined here
  }
});
```

**Key Settings**:
- `name: "starkeeper"` - Stack name prefix
- `removal` - Retain resources in production, remove in dev
- `home: "aws"` - Deploy to AWS (vs other clouds)

**Stages**: SST uses stages (dev, staging, production) to deploy multiple environments to same AWS account.

### Resources

#### VPC (Optional)

```typescript
const vpc = process.env.USE_VPC === "true"
  ? new sst.aws.Vpc("ControlPlaneVpc", {
      nat: $app.stage === "production" ? "managed" : "ec2",
    })
  : undefined;
```

**Purpose**: Network isolation for database and Lambda functions

**When to use**:
- Production deployments (required for Aurora in private subnets)
- Security requirements mandate VPC

**NAT Gateway**:
- Production: Managed NAT Gateway (high availability, expensive)
- Dev: EC2-based NAT instance (cheaper, single point of failure)

**Environment Variable**: Set `USE_VPC=true` to enable

#### Database

Three options for database:

**Option 1: Existing Database** (Current Development Setup)
```typescript
if (process.env.DATABASE_URL) {
  databaseUrl = process.env.DATABASE_URL;
}
```

**Use case**: Local development with existing PostgreSQL

**Option 2: Aurora Serverless v2**
```typescript
if (process.env.USE_AURORA === "true" && vpc) {
  database = new sst.aws.Postgres("Database", {
    vpc,
    scaling: {
      min: process.env.DB_MIN_CAPACITY || "0.5 ACU",
      max: process.env.DB_MAX_CAPACITY || "4 ACU",
    },
  });
  databaseUrl = database.url;
}
```

**Use case**: Production deployment with auto-scaling

**Scaling**:
- Min: 0.5 ACU (Aurora Capacity Units) - ~$0.12/hour
- Max: 4 ACU - ~$1/hour
- Scales automatically based on load

**Option 3: Placeholder** (Default)
```typescript
databaseUrl = "postgresql://user:pass@localhost:5432/starkeeper";
```

**Use case**: Deployment without database (must be provided at runtime)

#### S3 Artifacts Bucket

```typescript
const artifactsBucket = new sst.aws.Bucket("ArtifactsBucket", {
  versioning: true,
  public: true,
  cors: [
    {
      allowedOrigins: ["*"],
      allowedMethods: ["GET", "PUT", "POST", "DELETE", "HEAD"],
      allowedHeaders: ["*"],
      maxAge: 3000,
    },
  ],
});
```

**Purpose**: Store CloudFormation templates for customer deployments

**Key Settings**:
- `versioning: true` - Keep template history
- `public: true` - CloudFormation needs read access
- CORS enabled for browser uploads (future feature)

**Security Note**: Bucket is public-read but only CloudFormation templates are stored here. No sensitive data.

**S3 Key Structure**: `customer-{customerId}/templates/{templateName}.yaml`

#### Migration Lambda (Optional)

```typescript
const migrationLambda = database ? new sst.aws.Function("MigrationFunction", {
  handler: "packages/db/scripts/migrate-lambda.handler",
  runtime: "nodejs20.x",
  timeout: "5 minutes",
  vpc,
  environment: {
    DATABASE_URL: databaseUrl,
  },
  nodejs: {
    install: ["pg"],
  },
}) : undefined;
```

**Purpose**: Run database migrations in AWS environment

**When created**: Only if database is managed by SST (Aurora)

**Usage**:
```bash
# Invoke migration Lambda
aws lambda invoke --function-name MigrationFunction output.json
```

**Why Lambda?** Aurora Serverless in VPC not directly accessible. Lambda runs in VPC and can reach database.

#### Remix App (Currently Disabled)

```typescript
// TODO: Re-enable once AWS account is verified for CloudFront
// const remix = new sst.aws.Remix("RemixApp", {
//   path: "../admin-remix",
//   link: [artifactsBucket],
//   environment: {
//     DATABASE_URL: databaseUrl,
//     ARTIFACTS_BUCKET: artifactsBucket.name,
//     AWS_ACCOUNT_ID: awsAccountId.accountId,
//   },
// });
```

**Why disabled?** Test AWS account has CloudFront restrictions. Running Remix locally instead.

**Future**: Will deploy Remix app to CloudFront + Lambda when account is verified.

**How it works**:
- SST builds Remix app for production
- Deploys static assets to S3
- Deploys server-side rendering to Lambda
- Creates CloudFront distribution
- Connects environment variables

### Outputs

```typescript
return {
  artifactsBucket: artifactsBucket.name,
  databaseUrl: databaseUrl,
  accountId: awsAccountId.accountId,
  migrationFunction: migrationLambda?.name,
};
```

**Purpose**: Stack outputs shown after deployment

**Access outputs**:
```bash
npx sst deploy
# Outputs:
# artifactsBucket: starkeeper-dev-artifactsbucket-abc123
# databaseUrl: postgresql://...
# accountId: 123456789012
```

## Environment Variables

Configure deployment with environment variables:

**Required**:
- None (all have defaults)

**Optional**:
```bash
# Use existing database instead of creating Aurora
DATABASE_URL=postgresql://user@localhost:5432/starkeeper

# Create VPC for database and Lambda
USE_VPC=true

# Create Aurora Serverless v2 database
USE_AURORA=true
DB_MIN_CAPACITY=0.5 ACU
DB_MAX_CAPACITY=4 ACU

# Deploy Remix app with custom domain
DOMAIN_NAME=starkeeper.example.com
ROUTE53_ZONE_ID=Z1234567890ABC
```

## Deployment Workflows

### Development (Current Setup)

Uses local PostgreSQL, no VPC, no Aurora:

```bash
# Deploy to dev stage
npx sst deploy --stage dev

# Resources created:
# - S3 bucket for templates
# - (Remix app disabled)
```

**Why this is simple**: Development uses local database, no VPC complexity.

### Production (Future Setup)

Uses Aurora, VPC, custom domain:

```bash
# Set environment variables
export USE_VPC=true
export USE_AURORA=true
export DB_MIN_CAPACITY=0.5
export DB_MAX_CAPACITY=4
export DOMAIN_NAME=app.starkeeper.io
export ROUTE53_ZONE_ID=Z123...

# Deploy to production stage
npx sst deploy --stage production

# Resources created:
# - VPC with public/private subnets, NAT Gateway
# - Aurora Serverless v2 in private subnets
# - S3 bucket for templates
# - Migration Lambda in VPC
# - Remix app on CloudFront + Lambda
# - Route53 DNS records
```

**Cost Estimate** (production):
- Aurora: ~$90/month (0.5 ACU minimum)
- NAT Gateway: ~$32/month
- CloudFront: ~$1/month (low traffic)
- Lambda: ~$1/month (low traffic)
- **Total**: ~$125/month

### Hybrid (Recommended for Now)

Use managed Aurora but run Remix locally:

```bash
export USE_VPC=true
export USE_AURORA=true

npx sst deploy --stage dev

# Then run Remix locally:
npx dotenv-cli -e .env -- npm run dev --workspace=@starkeeper/admin-remix
```

**Why?** CloudFront restrictions prevent Remix deployment, but Aurora gives production-like database.

## SST Commands

### Deploy Stack

```bash
# Deploy to default stage (dev)
npx sst deploy

# Deploy to specific stage
npx sst deploy --stage production

# Deploy with confirmation prompts disabled
npx sst deploy --stage production --yes
```

### Remove Stack

```bash
# Remove dev stack (deletes all resources)
npx sst remove --stage dev

# Remove production stack (retains resources due to retention policy)
npx sst remove --stage production
```

**Warning**: `sst remove` deletes S3 bucket and data!

### List Resources

```bash
# Show all deployed resources
npx sst list

# Show specific stage
npx sst list --stage production
```

### Run Migrations

```bash
# If using Aurora and Migration Lambda exists
aws lambda invoke \
  --function-name starkeeper-dev-MigrationFunction \
  --region us-east-1 \
  output.json

cat output.json
```

### Live Development (Future)

When Remix is deployed to SST:

```bash
# Start live development
npx sst dev

# Changes to Lambda code hot-reload in AWS
# Changes to Remix code rebuild and redeploy
```

## Infrastructure Stages

SST stages allow multiple environments in same AWS account:

**dev** (default):
- Used for development
- Resources auto-removed on `sst remove`
- Cheaper configuration (EC2 NAT vs managed NAT)
- Stack names: `starkeeper-dev-*`

**staging**:
- Pre-production testing
- Resources retained on removal
- Production-like configuration
- Stack names: `starkeeper-staging-*`

**production**:
- Live production
- Resources always retained
- High availability configuration
- Stack names: `starkeeper-production-*`

**Switch stages**:
```bash
npx sst deploy --stage staging
```

## Integration with Other Packages

### With `@starkeeper/admin-remix`

When Remix is deployed via SST:

```typescript
const remix = new sst.aws.Remix("RemixApp", {
  path: "../admin-remix",
  link: [artifactsBucket],  // Auto-wires bucket name to environment
  environment: {
    DATABASE_URL: databaseUrl,
    ARTIFACTS_BUCKET: artifactsBucket.name,
  },
});
```

SST automatically:
1. Builds Remix app for production
2. Uploads to S3 and Lambda
3. Injects environment variables
4. Creates CloudFront distribution

### With `@starkeeper/db`

Database URL passed as environment variable:

```typescript
environment: {
  DATABASE_URL: databaseUrl,
}
```

Application code accesses via `process.env.DATABASE_URL`.

### With `@starkeeper/providers`

AWS account ID needed for cross-account access:

```typescript
const awsAccountId = await aws.getCallerIdentity({});

// Passed to Remix app
environment: {
  AWS_ACCOUNT_ID: awsAccountId.accountId,
}
```

## Security Considerations

### S3 Bucket Public Access

Bucket is public-read for CloudFormation to access templates:

```typescript
public: true
```

**Safe because**:
- Only CloudFormation templates stored (infrastructure-as-code)
- No credentials or secrets
- Templates are customer-specific (via S3 key prefix)

**Future**: Use signed URLs for private access.

### Database in VPC

Aurora created in private subnets:

```typescript
const vpc = new sst.aws.Vpc("ControlPlaneVpc");
database = new sst.aws.Postgres("Database", { vpc });
```

**Security**:
- Not publicly accessible
- Only Lambda in VPC can connect
- Security groups control access

### IAM Permissions

SST needs broad IAM permissions to create resources. Required actions:
- CloudFormation: Create/update stacks
- S3: Create/manage buckets
- Lambda: Create/manage functions
- RDS: Create/manage databases
- EC2: Create VPCs, security groups
- IAM: Create roles for Lambda

**Principle**: SST uses AdministratorAccess in control plane account. This is different from limited access in target accounts.

## Troubleshooting

### "Error: No AWS credentials found"

**Fix**: Configure AWS credentials:
```bash
aws configure
# Or use environment variables
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
```

### "Error: Stack already exists"

**Cause**: Trying to deploy to stage that already exists

**Fix**:
```bash
# Update existing stack
npx sst deploy --stage dev

# Or remove and redeploy
npx sst remove --stage dev
npx sst deploy --stage dev
```

### "VPC required but USE_VPC not set"

**Cause**: Aurora requires VPC but `USE_VPC=true` not set

**Fix**:
```bash
export USE_VPC=true
export USE_AURORA=true
npx sst deploy
```

### "CloudFormation stack stuck in UPDATE_IN_PROGRESS"

**Cause**: SST deployment interrupted

**Fix**:
1. Check AWS CloudFormation console
2. If truly stuck, cancel update:
   ```bash
   aws cloudformation cancel-update-stack --stack-name starkeeper-dev
   ```
3. Re-run deployment

### "Cannot delete S3 bucket - bucket not empty"

**Cause**: S3 bucket has templates stored

**Fix**:
```bash
# Empty bucket first
aws s3 rm s3://starkeeper-dev-artifactsbucket-abc123 --recursive

# Then remove stack
npx sst remove --stage dev
```

## Cost Optimization

### Development

Minimize costs in dev:
- Use existing database (`DATABASE_URL`) instead of Aurora
- Don't create VPC (`USE_VPC=false`)
- Run Remix locally instead of deploying
- Use `removal: "remove"` for dev stage

**Dev cost**: ~$1/month (just S3)

### Production

Balance cost and reliability:
- Aurora 0.5 ACU minimum (instead of RDS)
- Managed NAT Gateway (reliability over EC2 NAT)
- CloudFront (caching reduces Lambda invocations)
- S3 lifecycle policies (delete old template versions)

**Production cost**: ~$125/month

### Staging

Use same config as production but lower traffic:
- Same Aurora scaling
- Shared NAT Gateway with dev (if needed)
- No custom domain

**Staging cost**: ~$100/month

## Future Enhancements

### Multi-Region Deployment

```typescript
// Deploy to multiple regions
const regions = ["us-east-1", "us-west-2", "eu-west-1"];

for (const region of regions) {
  new sst.aws.Bucket(`ArtifactsBucket-${region}`, {
    transform: {
      bucket: {
        location: region,
      },
    },
  });
}
```

### Database Replicas

```typescript
const database = new sst.aws.Postgres("Database", {
  vpc,
  replicas: 2,  // Read replicas
});
```

### Custom Remix SSR Optimization

```typescript
const remix = new sst.aws.Remix("RemixApp", {
  edge: true,  // Deploy to CloudFront edge
  warm: 10,    // Keep 10 Lambda instances warm
});
```

### Monitoring and Alerts

```typescript
const alarm = new aws.cloudwatch.MetricAlarm("DatabaseCPU", {
  metricName: "CPUUtilization",
  threshold: 80,
  alarmActions: [snsTopicArn],
});
```

## Key Insights

1. **SST simplifies AWS deployment** - No manual CloudFormation or CDK
2. **Stages enable multi-environment** - Dev, staging, production in one account
3. **VPC optional for dev** - Saves cost and complexity
4. **Aurora scales to zero** - Serverless v2 can pause when idle (future feature)
5. **Public S3 bucket is safe** - Only infrastructure code, no secrets
6. **Remix deployment blocked** - CloudFront restriction forces local development
7. **Migration Lambda needed for Aurora** - Can't access private database from outside VPC

## Related Documentation

- SST Documentation: https://sst.dev/docs/
- AWS CloudFormation: https://docs.aws.amazon.com/cloudformation/
- Aurora Serverless v2: https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2.html
- AWS VPC: https://docs.aws.amazon.com/vpc/
- Remix on SST: https://sst.dev/docs/component/aws/remix
