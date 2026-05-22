# Getting Started

## Prerequisites

- Node.js 22 or later (required for the built-in `node:sqlite` module)
- pnpm 10.20.0 or later
- An AWS account (required for cloud deployment)

## Local Development

### 1. Clone and Install

```bash
git clone <repo>
cd data-protocol
pnpm install && pnpm build
```

### 2. Start the Admin Panel

Open the admin panel first — it is the command center and will guide you through the remaining setup steps.

```bash
pnpm --filter admin-web dev
```

The admin panel walks you through bootstrapping your user identity, provisioning cloud infrastructure, and configuring the data server. Follow the in-app prompts and return to the terminal steps below when directed.

### 3. Start the Data Server

The data server is a local HTTP hub that exposes the full SDK over REST. All apps on the same machine talk to it rather than embedding the SDK themselves.

```bash
pnpm --filter @starkeep/data-server dev
```

Once running, the data server stores records in a SQLite database at `~/.starkeep/data/starkeep.db` and files at `~/.starkeep/objects/`.

### 4. Run an Example App

With the data server running, you can start any example app:

```bash
pnpm --filter photos-web dev
```

### What You Get Locally

- Full record storage, metadata generation, search, and aggregations via SQLite and the local filesystem
- The data server's HTTP API available to any local app
- Sync is available locally but has nothing to sync to until cloud infrastructure is provisioned

## Cloud Deployment

The admin panel guides you through each step. Open it and follow the prompts.

### 1. Bootstrap Your User Account

The admin panel walks you through creating or connecting a user account and registering your identity with the control plane. This is a one-time step per user.

### 2. Provision Your Cloud Infrastructure

From the admin panel, initiate deployment for your user. The provisioning process creates:

- **Aurora DSQL cluster** — your cloud database
- **S3 bucket** — your file storage
- **API Gateway + Lambda** — the HTTP layer apps use to reach your cloud data

Provisioning is fully automated. No manual AWS steps are required.

### 3. Connect Local to Cloud

After provisioning completes, the admin panel displays your cloud endpoint and the credentials the data server needs to reach it. Configure the data server with these values. From that point forward, local writes sync to your cloud stack automatically.

### 4. Verify

Upload a photo or create a record locally, trigger a sync, and confirm the record appears in the cloud view in the admin panel.

## Next Steps

- [Concepts](concepts.md) — Understand records, metadata, sync, and access control
- [Building an App](building-an-app.md) — Define types, store data, add metadata generators, and expose an API
- [Deployment](deployment.md) — Details on what gets provisioned and how
