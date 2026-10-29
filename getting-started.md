# Getting started

This guide installs Starkeep on your computer, adds the Photos example app, and then optionally deploys Starkeep to your own AWS account so your data syncs across devices.

Part A runs entirely on your computer and needs no AWS account. Part B adds the cloud. You can stop after Part A and still use Starkeep's apps locally, offline.

## Before you begin

You need the following on your computer:

- Node.js 22 or later.
- pnpm 10.20 or later.
- A checkout of this repository, `starkeep-core`.
- A checkout of [`starkeep-apps`](https://github.com/starkeep-org/starkeep-apps) beside `starkeep-core`, in the same parent folder. The Photos example app lives there.

Part B also needs an AWS account. The setup wizard explains how to create one.

---

## Part A: run Starkeep on your computer

### 1. Install dependencies

Run the following command at the root of `starkeep-core`:

```bash
pnpm install
```

The install also builds the workspace packages. To rebuild later without reinstalling, run `pnpm build`.

Then run the same command at the root of `starkeep-apps`. Installed apps run straight out of their source checkout, so each app's dependencies must be present before admin-web can start the app.

### 2. Start Starkeep Admin

Starkeep Admin (admin-web) is where you start Starkeep's services, install apps and set up the cloud. Start it from the root of `starkeep-core`:

```bash
pnpm --filter admin-web dev
```

Open `http://localhost:3000` in a browser on the same computer. The dashboard shows a **Local** section and a **Cloud** section.

Admin-web answers only on this computer. It listens on `127.0.0.1` and refuses any request addressed to a name other than `localhost`. To reach it from another device on your network, see [Reach admin-web from another device](#reach-admin-web-from-another-device).

### 3. Start the local data server

The local data server stores and indexes everything on this computer. Every app on the computer reads and writes through it, and it runs sync once you set up the cloud.

In the **Local** section, find the **Data Server** card and click **Start Data Server**. The data server listens on port 9820.

On first start, the data server creates `~/.starkeep/` to hold its database, files and configuration. To keep that state somewhere else, set `STARKEEP_DIR` to an absolute path in `.env.local` at the root of `starkeep-core`. The file `.env.example` lists the supported settings.

### 4. Add a folder of files

The data server can watch folders on your computer. Each file in a watched folder becomes a record that apps can see, and the data server picks up new and changed files as they appear.

1. Create a folder and copy a few files into it, such as some photos and a document.
2. On the **Data Server** card, click **Add Local Folder**. The button reads **Manage Local Folders** once you have added a folder.
3. Enter the folder's path in the **Local folders** dialog and click **Add folder**.

The card then counts the watched folders and files, for example `1 folder · 12/12 files`.

### 5. Open Drive

Starkeep Drive comes with Starkeep and can see every file type. On the **Starkeep Drive** card, click **Start Drive**, then click **Open Drive ↗**. The files from your folder appear in Drive, which confirms that the data server indexed them.

### 6. Install and open Photos

Admin-web finds apps by scanning folders that you register. Each folder inside a registered folder that holds a `starkeep.manifest.json` file counts as an app. Admin-web registers the sibling `starkeep-apps` checkout by default, so the Photos card appears in the **Local** section without extra steps.

If the Photos card is missing, click **Discover apps** in the header and add the absolute path of your `starkeep-apps` checkout in the **App discovery** dialog.

1. On the Photos card, click **Install Photos**. Admin-web lists the kinds of files Photos asks for, such as images and videos. Click **Approve & Install** to finish the install.
2. Click **Start Photos**, then click **Open Photos ↗**.

Photos shows the images from your watched folder. Photos is an example app. It shows how Starkeep apps work, and it does not yet replace a full photo library app.

---

## Part B: deploy Starkeep to your AWS account

The cloud stores a copy of your data in your own AWS account and syncs it between your computers and phones. It also runs web versions of your apps, such as Photos, that you can open from any browser. Nobody else, including the Starkeep project, can reach your deployment.

Finish Part A first. The cloud setup runs from admin-web, and a cloud web app can only install after the same app is installed on this computer.

### 1. Open the setup wizard

In the **Cloud** section of the dashboard, click **Deploy Starkeep Cloud**. The wizard has five steps, listed on its left. You can close the wizard and come back later, and the wizard resumes at the first unfinished step.

After the cloud is deployed, reopen the wizard from **Manage deployment…** in the menu of the cloud **Data Server** card.

### 2. Deploy the bootstrap stack

The bootstrap stack is an AWS CloudFormation stack. The stack creates the sign-in service and the identities and permission limits that the rest of the deployment uses. You deploy the stack once.

1. Choose an **AWS Region** and keep the default **Stack prefix**, `starkeep`, unless you need several deployments in one account.
2. Click **Download bootstrap template**.
3. Click **Open CloudFormation console ↗** and follow **Show full instructions** to create the stack from the downloaded template. The instructions also cover creating a new AWS account.
4. Wait about a minute, until the stack's **Outputs** tab lists values, then click **Stack is deployed — Continue**.

### 3. Copy the stack outputs

Open the stack's **Outputs** tab through the link in the wizard. Copy the five values into the matching fields: **CognitoDomain**, **DeviceUserPoolClientId**, **IdentityPoolId**, **UserPoolClientId** and **UserPoolId**. Then click **Continue**.

### 4. Create your account

Your Starkeep account lives in your own AWS account, in Amazon Cognito. Click **Create user ↗** to open the Cognito console, and follow **Show full instructions**:

1. Choose **Send an email invitation**, enter your email address and choose **Generate a password**.
2. Click **Create user**. Cognito emails you a temporary password within a minute. The period at the end of the email's sentence is not part of the password.
3. Open the new user and add the user to both groups, **starkeep-admins** and **starkeep-users**. The first group lets you administer the deployment. The second group gives you a data library that syncs. Admin-web refuses to sign in an account outside **starkeep-admins**.
4. Return to the wizard and click **User Created — Continue**.

### 5. Sign in

Enter your email address and the temporary password, and click **Sign in**. Cognito then asks for a permanent password. Choose a password of at least eight characters and click **Set password and sign in**.

### 6. Deploy the Starkeep cloud

Click **Deploy Starkeep cloud**. The deploy runs two passes and streams its progress:

- The **cloud data server** pass creates the database, the file bucket, the API and the sign-in page for cloud apps. This pass takes several minutes.
- The **Starkeep Drive** pass creates the identity that syncs your shared files. This pass adds no running services.

The wizard restarts the local data server when the deploy finishes, so the data server picks up the new cloud address. If the deploy fails, click **Retry install**. Most failures clear on a retry. If your sign-in expires during a long deploy, click **Sign in again**, and the wizard keeps your progress.

Click **Continue →** to return to the dashboard.

### 7. Sign this computer in to sync

This computer syncs only after you sign it in. A sign-in form now sits under the dashboard's **Local** heading.

Enter the email address and password of your Starkeep account and click **Sign in to sync**. The line under the heading reads "Connecting…" for a moment, then "Local apps sync with this cloud". A **Sign out** link follows the sentence. From then on, the data server syncs in the background. The data server pushes local changes soon after they happen and pulls changes from the cloud regularly.

Open Drive to see the sync state of your files.

### 8. Install Photos in the cloud

In the **Cloud** section, find the Photos card and click **Install Photos in cloud**. The install builds Photos, uploads it and creates its cloud resources. The install takes a few minutes, and a failed install usually succeeds on **Retry**.

When the card reads **Installed**, click **Open Photos ↗**. Sign in on the Starkeep sign-in page with your Starkeep account. Photos then shows the photos that synced from this computer.

### 9. Add your phone or another computer (optional)

The **Cloud address** line under the **Cloud** heading shows the address that phones and other computers sign in with. Click the copy icon beside the address to copy the address.

- **Another computer.** Complete Part A on the other computer. In the other computer's **Cloud** section, paste the address into the **This machine** card, click **Join**, and sign in.
- **A phone.** The Photos Mobile app for Android signs in with the same address and account. The [`starkeep-apps` README](https://github.com/starkeep-org/starkeep-apps#readme) explains how to build and install the app.

### 10. Add people (optional)

One deployment can hold several people, and each person gets a separate library. Nobody can see another person's data.

The dashboard's **Cloud Users** section appears below the **Cloud** section while admin-web is signed in as an admin. In the section's **Add a user** box, enter the new person's email address, choose the roles, and click **Add user**. Cognito emails the person a temporary password, and the person chooses a permanent password at first sign-in.

The **Roles** checkboxes set the new account's groups. **Data** starts checked and gives the person a library that syncs. **Admin** starts unchecked. Leave **Admin** unchecked unless the person should manage users, cloud apps and settings.

---

## Reach admin-web from another device

Admin-web refuses requests from other devices by default. To allow them, add the names or addresses that other devices use for this computer to `STARKEEP_ADMIN_DEV_ORIGINS` in `.env.local` at the root of `starkeep-core`, separated by commas:

```bash
STARKEEP_ADMIN_DEV_ORIGINS=192.168.1.51
```

Restart admin-web after the change. Admin-web then listens on every network interface and accepts those names. Any device on the network can then reach admin-web, so set this value only on a network you trust.

## Remove Starkeep

The scripts in `scripts/` remove what Starkeep created. Each script removes the layers above it first:

- `scripts/teardown-cloud-apps.sh` removes every cloud app.
- `scripts/teardown-cloud-data-server.sh` removes the cloud apps, then the cloud data server with its database and file bucket.
- `scripts/teardown-bootstrap.sh` removes everything above, then the bootstrap stack and the resources outside CloudFormation: the state bucket, the stored passphrase and the Cognito resources.
- `scripts/reset-local-data.sh` deletes `~/.starkeep` and starts this computer from a clean slate.

The cloud scripts require `--prefix <stack prefix>` and `--region <region>`, so a teardown never guesses which deployment to remove. The database has deletion protection. A teardown removes the database only after you confirm at the prompt or pass `--force`, and removing the database deletes the data stored in the cloud.

## Run the tests

The repository has four test tiers:

1. `pnpm test` runs the unit tests. CI requires them.
2. `pnpm test:integration` runs the suites that start processes, open sockets or boot a database engine. CI runs them as an advisory job, and `pnpm release:publish` runs them before a release.
3. `pnpm test:e2e` runs the local browser tests with Playwright. Run `pnpm exec playwright install chromium` once beforehand. See [`e2e/README.md`](e2e/README.md).
4. `pnpm test:aws` runs the full journey against a real AWS account. The suite does nothing unless `STARKEEP_AWS_TESTS=1` is set. The journey takes about fifteen minutes and costs a small amount. See [`e2e-aws/README.md`](e2e-aws/README.md).
