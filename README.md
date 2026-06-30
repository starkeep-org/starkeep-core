# Starkeep

Starkeep is a modern self-hosting system that allows you to keep your own data and run your own apps on your own hardware and cloud infra. Starkeep's advantages over traditional self-hosting:

- Common data storage and indexing layer for your data files (photos, documents, etc)
- Runs locally on device and/or in the cloud, with P2P sync built in 
- Ultra-low, scale-to-zero running costs
- Enterprise-grade security and backups built-in
- Easy enough for anyone to run, with limitless potential for developers

The Starkeep Core repo includes four built-in system apps:

- **Starkeep Admin**: The management hub. Sign in, discover, install and run apps. Currently the Admin app runs locally only.
- **Local Data Server**: A local service responsible for indexing, lookup, enforcing data semantics, and bookkeeping sync on the local side.
- **Starkeep Drive**: A general purpose storage app with two special powers: it is the only app allowed to operate on all file types (including unknown), and its identity is used to sync data between local and cloud. Currently, the Starkeep Drive app runs locally only.
- **Cloud Data Server**: The cloud analog of the local data server: responsible for indexing, lookup, enforcing data semantics, and bookkeeping sync on the cloud side. Runs in a Lambda.

Beyond the core, Starkeep is designed for many "installable" apps to run on top by interacting with the Local and/or Cloud Data Servers. Each installable app declares the file types it can operate on in its manifest, and users accept the type permissions at install time.

For now, we provide an example "Photos" app available in a separate repo, `starkeep-apps`.

For the full picture of the parts and how data moves between them, see [`system-design.md`](system-design.md). For the trust boundaries between those parts, see [`data-roles-and-permissions.md`](data-roles-and-permissions.md).

## Prerequisites

- **Node.js 22+** and **pnpm 10.20** (`corepack enable` picks up the version pinned in `package.json`).

---

# Getting started

## Part A — Local install

Everything in Part A runs on your machine. No AWS account is required.

### 1. Install dependencies

```bash
pnpm install
```

This also builds the workspace packages the apps depend on (a `postinstall` runs `turbo run build`). To rebuild later without reinstalling, run `pnpm build`.

### 2. Run the admin app

The admin app is the command center, allowing you to install and start other apps and monitor status.

```bash
pnpm --filter admin-web dev
```

### 3. Start the local data-server

The data-server is the on-device hub for all data operations: every app on the machine shares its database, type registry, and (later) sync connection. From the admin **Dashboard**, start the **local-data-server** daemon. It listens on port **9820**.

The data-server creates `~/.starkeep/` on first boot (SQLite db, object store, config with a generated `nodeId`). Set `STARKEEP_DIR` to relocate it.

### 4. Add files via a watched folder

The local data server can watch a directory and index files dropped into it. 

Create a folder, drop a few files into it (any mix of images and other types). Then add the folder location under Watches in the Local Data Server section of the Admin app.

### 5. Start the Drive app and confirm the files landed

Drive is the built-in, general-purpose storage app that can see and sync every file type. From the admin **Dashboard**, start and then open **Drive**. The files you dropped into the watched folder should appear as records, confirming the data-server indexed them. 

### 6. Install the Photos app locally

Apps are discovered from directories you register with the admin panel. `starkeep-apps/`  is seeded by default.

1. Open the **Dashboard** in admin-web.
2. If Photos isn't listed, make sure you have a local checkout of the `starkeep-apps` repo. Use the **App discovery** card to add the parent directory that contains it (e.g. the absolute path to `starkeep-apps/`).
3. Click **Install** on the Photos card. Admin reads and validates the app's `starkeep.manifest.json`, prompts you to approve the file-type grants it requests, and registers the app with the data-server.

### 7. Start the Photos app

From the **Dashboard**, start Photos and then open it by clicking the link. For now, the photos app is an example app primarily meant to showcase Starkeep's system functionality.

---

## Part B — Cloud install

The cloud path provisions a data plane in **your own AWS account** and turns on sync, so the same data is available across machines. Local install is not a prerequisite for cloud, but it's the easiest way to confirm the apps work before adding AWS.

The admin panel's **Cloud Setup Wizard** drives this whole sequence.

### 1. Deploy the bootstrap stack

A CloudFormation stack creates the identities, permission boundaries, and supporting resources needed for subsequent steps.

### 2. Enter the bootstrap stack **outputs**

These config values are needed to support sign-in with the user account you're about to create.

### 3. Create a **Cognito user** account

This is the account you'll use to sign in to your Starkeep.

### 4. **Sign in** to your account

You'll need to update the temp password.

### 5. Install the Starkeep Cloud Data Server

The cloud data server enables cloud backup and sync, and is the only service in the cloud that touches shared data — every app request runs under the calling app's assumed identity.

With the Cloud Data Server installed, sync starts working automatically. Open the Drive app to see the sync status of files you've added locally. 

### 6. Install the Photos example app to the cloud

The Photos cloud app is a simple proof of concept that runs on a Lambda (Cloudfront coming soon). Install, then sign in to see your photos in the cloud.

Note: you need to checkout the sister repo `starkeep-apps` to get the Photos

### 5. Sync

Once cloud config and Cognito credentials are present, the local data-server syncs automatically in the background — pulling remote changes on an interval and pushing local changes shortly after they occur. Shared records (your photos) flow over Drive's channel and show up on any other device signed into the same account, even one running a different app that holds an image grant. No manual trigger is needed.

### Tearing down

`scripts/teardown-cloud-apps.sh`, `scripts/teardown-cloud-data-server.sh`, and `scripts/teardown-bootstrap.sh` remove the cloud resources (the last covers the non-CloudFormation pieces — state bucket, SSM SecureString, Cognito). `scripts/reset-local-data.sh` wipes `~/.starkeep` for a clean local slate.

---

## Running tests

Three tiers:

1. `pnpm test`      — unit tests (turbo), fast, run by default
2. `pnpm test:e2e`  — local Playwright e2e (see [`e2e/README.md`](e2e/README.md)); requires `pnpm exec playwright install chromium` once
3. `pnpm test:aws`  — cloud e2e against real AWS; inert unless `STARKEEP_AWS_TESTS=1`. ~15 min, real account + (trivial) cost. See [`e2e-aws/README.md`](e2e-aws/README.md) for the full environment contract.

## Further reading

- [`system-design.md`](system-design.md) — the major parts, how data is classified (shared vs app-specific), and how it moves and syncs.
- [`data-roles-and-permissions.md`](data-roles-and-permissions.md) — identities, trust boundaries, and why the admin app never appears on the data path.
- App READMEs: [`apps/admin-web`](apps/admin-web/README.md), [`apps/local-data-server`](apps/local-data-server/README.md).
- Authoring your own app: [`authoring-an-app.md`](authoring-an-app.md) (and the app-author install steps in [`../starkeep-apps/README.md`](../starkeep-apps/README.md)).

## Repository layout

```
starkeep-core/
  apps/
    admin-web/           Admin panel — the command center for setup, install, and status
    local-data-server/   On-device data broker (HTTP); embeds the SDK, runs sync + file watches
    drive/               Starkeep Drive UI — the built-in User-Data-Owner app
  packages/              SDK, storage adapters, sync engine, access control, installer, bootstrap, …
    admin-installer/builtin-apps/
      cloud-data-server/ The cloud-side data broker, deployed as a built-in app
      starkeep-drive/    The cloud-side Drive built-in
  scripts/               Teardown + local reset helpers
  e2e/  e2e-aws/         Platform end-to-end suites (local Playwright / real AWS)
```

First-party *apps* (e.g. Photos) live in the sibling [`starkeep-apps/`](../starkeep-apps) checkout. They install through the same path a third-party app would — there is no privileged wiring against `starkeep-core`.
