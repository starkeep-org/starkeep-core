# Deployment

## Local vs. Cloud

| | Local | Cloud |
|---|---|---|
| **Database** | SQLite | Aurora DSQL |
| **File storage** | Local filesystem | S3 |
| **API** | Data server HTTP | API Gateway + Lambda |
| **Cost** | ~$0 | ~$125/month per user |

Application code doesn't change between environments. Swapping local for cloud is a configuration change — different adapter implementations, same interfaces.

## Per-User Infrastructure

Each user gets their own isolated AWS stack. No resources are shared between users. This means:

- One user's data is never accessible from another user's database or bucket
- A user can revoke an app's access without affecting any other user
- Users can be provisioned and deprovisioned independently

### What Gets Provisioned

**Aurora DSQL cluster** — A PostgreSQL-compatible serverless database that auto-scales with usage. This is the cloud source of truth for the user's records.

**S3 bucket** — Object storage for file attachments (photos, documents, etc.). Organized by record ID.

**API Gateway + Lambda** — The HTTP layer that apps and the data server use to reach the user's cloud data. Lambda functions handle record CRUD, search, and file operations.

**IAM roles** — Scoped permissions that allow Lambda to read and write to the user's database and bucket, and nothing else.

## Provisioning Process

Provisioning is initiated from the admin panel and runs automatically. The steps are:

1. The admin panel submits a deployment request
2. An infrastructure-as-code template is generated for the user's stack
3. Pulumi Automation API executes the template against AWS
4. Resources are created: Aurora DSQL, S3, Lambda functions, API Gateway routes, IAM roles
5. Outputs (API endpoint URL, bucket name, database connection details) are returned to the admin panel

The admin panel displays the outputs when provisioning completes. These are the values the data server needs to enable cloud sync.

Stack names are derived from the user's identifier, so each user's stack is isolated and independently manageable.

## Deprovisioning

Deprovisioning tears down a user's entire stack. All provisioned resources — database, bucket, Lambda functions, IAM roles — are destroyed.

Data in the database and bucket is deleted as part of teardown. If the user's data needs to be preserved, export it before deprovisioning.

## Infrastructure Costs

Estimated cost per user at rest: **~$125/month**.

The main cost drivers:
- **Aurora DSQL** — billed by storage and I/O; dominates the cost at low usage
- **S3** — billed by storage and request count; scales with how much data the user stores
- **Lambda + API Gateway** — billed by invocation; negligible at typical usage levels

Costs scale with usage. A user with many large files or high sync frequency will cost more than a user with small text-only records.
