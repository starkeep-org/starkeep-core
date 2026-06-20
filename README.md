# Starkeep

Starkeep is a user-owned data platform that apps are tenants on top of. Your data — photos, documents, and other files — has an identity and a lifetime independent of any one app: it outlives uninstalls, can be operated on by several apps at once, and is typed against a registry the platform owns rather than the app. Apps declare narrow, explicit grants over your data; a single broker (the data-server) mediates every read and write so that every byte is attributable to the app that touched it. The same code paths run on your machine and in your own AWS account, so an app behaves — and is constrained — the same way locally and in the cloud.

For the full picture of the parts and how data moves between them, see [`system-design.md`](system-design.md). For the trust boundaries between those parts, see [`roles-and-permissions.md`](roles-and-permissions.md).

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

## Prerequisites

- **Node.js 22+** and **pnpm 10.20** (`corepack enable` picks up the version pinned in `package.json`).
- For the **cloud path only**: an AWS account, AWS credentials in your environment (`aws configure` / `AWS_PROFILE`), and a deployed bootstrap stack (see below).

---

# Getting started

The flow is: stand up the **admin panel**, use it to start the **local data-server** and install an app **locally**, and feed the app some photos. Once that works end to end on your machine, you can optionally provision your **cloud** account and sync to it.

## Part A — Local install

Everything in Part A runs on your machine. No AWS account is required.

### 1. Install dependencies and build the workspace

```bash
pnpm install
pnpm build
```

`pnpm build` (turbo) compiles the workspace packages the apps depend on.

### 2. Run the admin panel

The admin panel is the command center — it starts the data-server, discovers and installs apps, and shows local/cloud status.

```bash
pnpm --filter admin-web dev
```

Open <http://localhost:3000>. Use `localhost`, not `127.0.0.1` (Next treats the bare IP as a cross-origin dev host).

### 3. Start the local data-server

The data-server is the on-device hub for all data operations: every app on the machine shares its database, type registry, and (later) sync connection. From the admin **dashboard**, start the **local-data-server** daemon. It listens on port **9820**.

> Prefer the terminal? `pnpm --filter @starkeep/local-data-server start` does the same thing.

The data-server creates `~/.starkeep/` on first boot (SQLite db, object store, config with a generated `nodeId`). Set `STARKEEP_DIR` to relocate it.

### 4. Install the Photos app locally

Apps are discovered from directories you register with the admin panel. The sibling `starkeep-apps/` checkout is seeded by default, so Photos should already appear.

1. Open the **Apps** page in admin-web.
2. If Photos isn't listed, use the **App discovery** card to add the parent directory that contains it (e.g. the absolute path to `starkeep-apps/`).
3. Click **Install** on the Photos card. Admin-web reads and validates the app's `starkeep.manifest.json`, prompts you to approve the file-type grants it requests (Photos asks for image access), and registers the app with the data-server.

### 5. Start the Photos app

From the **Apps** page, start Photos. It comes up on port **3000** as a thin client that talks to the data-server over HTTP — so stop admin-web first if it's still holding that port, or run only one of them at a time. Open <http://localhost:3000> to see the (empty) gallery.

### 6. Add photos via a watched folder

The data-server can watch a directory and index files dropped into it as records, running metadata generators automatically (e.g. EXIF extraction for images). Point it at a folder of photos:

```bash
pnpm --filter @starkeep/local-data-server cli watch add /path/to/your/photos
```

The record type is inferred from each file's extension; add `--no-recursive` to watch only the top level. Manage watches with the same CLI:

```bash
pnpm --filter @starkeep/local-data-server cli watch list
pnpm --filter @starkeep/local-data-server cli watch remove /path/to/your/photos
```

Watches persist to `~/.starkeep/watches.json` and are restored on restart.

### 7. View them

Reload the Photos gallery. Files from the watched folder appear as photos, each with extracted metadata (dimensions, camera, capture date, GPS when present). You now have a working local Starkeep. You can also upload directly from the Photos UI.

---

## Part B — Cloud install

The cloud path provisions a data plane in **your own AWS account** and turns on sync, so the same data is available across machines. Local install is not a prerequisite for cloud, but it's the easiest way to confirm the apps work before adding AWS.

The admin panel's **Cloud Setup Wizard** drives this whole sequence; the steps below are what it walks you through.

### 1. Deploy the bootstrap stack

A one-shot CloudFormation stack creates the identities, permission boundaries, and supporting resources (Cognito pools, the Manager/install roles, the Pulumi state bucket, the reserved User-Data-Owner role) that everything else builds on. It produces no data-plane resources. Admin-web can render the template for you (the bootstrap-template build step); deploy it once in your account and keep the stack **outputs** handy.

### 2. Run the Cloud Setup Wizard

In admin-web, open **Cloud setup** and follow the wizard:

1. Enter the bootstrap stack **outputs**.
2. Create a **Cognito user** account (this is the human user identity).
3. **Sign in** to verify the credentials.
4. Deploy the **IAM permissions** stack.
5. **Provision** the user's infrastructure — Aurora DSQL, S3, API Gateway, and Lambdas.

The wizard writes `starkeep-config.json` (DSQL endpoint, S3 bucket, API Gateway URL, Cognito pool IDs). The data-server reads this file to connect; you can also import/export it from **Settings** to move setup between machines.

### 3. Deploy the cloud data-server and Drive

The **cloud-data-server** is the only service in the cloud that touches shared data — every app request runs under the calling app's assumed identity. Deploy it from admin-web (it installs as a built-in app), then install **Starkeep Drive**, the built-in User-Data-Owner that owns the always-on shared-record sync channel.

### 4. Install Photos to the cloud

On the **Apps** page, Photos shows a **cloud** target alongside its local one (its manifest declares both). Use **cloud install** to mint its per-app IAM role, PG role/schema, and API Gateway route, and to deploy its Lambda bundle. The install path is identical to a third-party app's.

### 5. Sync

Once cloud config and Cognito credentials are present, the local data-server syncs automatically in the background — pulling remote changes on an interval and pushing local changes shortly after they occur. Shared records (your photos) flow over Drive's channel and show up on any other device signed into the same account, even one running a different app that holds an image grant. No manual trigger is needed.

### Tearing down

`scripts/teardown-cloud-apps.sh`, `scripts/teardown-cloud-data-server.sh`, and `scripts/teardown-bootstrap.sh` remove the cloud resources (the last covers the non-CloudFormation pieces — state bucket, SSM SecureString, Cognito). `scripts/reset-local-data.sh` wipes `~/.starkeep` for a clean local slate.

---

## Running tests

Three tiers:

1. `pnpm test`      — unit tests (turbo), fast, run by default
2. `pnpm test:e2e`  — local Playwright e2e (see [`e2e/README.md`](e2e/README.md)); requires `pnpm exec playwright install chromium` once
3. `pnpm test:aws`  — cloud e2e against real AWS; inert unless `STARKEEP_AWS_TESTS=1`. ~26 min, real account + cost. See [`e2e-aws/README.md`](e2e-aws/README.md) for the full environment contract.

## Further reading

- [`system-design.md`](system-design.md) — the major parts, how data is classified (shared vs app-specific), and how it moves and syncs.
- [`roles-and-permissions.md`](roles-and-permissions.md) — identities, trust boundaries, and why the admin app never appears on the data path.
- App READMEs: [`apps/admin-web`](apps/admin-web/README.md), [`apps/local-data-server`](apps/local-data-server/README.md).
- Authoring your own app: [`../starkeep-apps/README.md`](../starkeep-apps/README.md).
