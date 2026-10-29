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

1. Run the following command at the root of `starkeep-core`:

   ```bash
   pnpm install
   ```

   The install also builds the workspace packages. To rebuild later without reinstalling, run `pnpm build`.

2. Run the same command at the root of `starkeep-apps`. Installed apps run straight out of their source checkout, so each app's dependencies must be present before admin-web can start the app.

### 2. Start Starkeep Admin

Starkeep Admin (admin-web) is where you start Starkeep's services, install apps and set up the cloud.

1. Start admin-web from the root of `starkeep-core`:

   ```bash
   pnpm --filter admin-web dev
   ```

2. Open `http://localhost:3000` in a browser on the same computer. The dashboard shows a **Local** section and a **Cloud** section.

Admin-web answers only on this computer. It listens on `127.0.0.1` and refuses any request addressed to a name other than `localhost`, `127.0.0.1` or `[::1]`. To reach it from another device on your network, see [Reach admin-web from another device](#reach-admin-web-from-another-device).

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

Starkeep Drive comes with Starkeep and can see every file type.

1. On the **Starkeep Drive** card, click **Start Drive**.
2. Click **Open Drive ↗**.

The files from your folder appear in Drive, which confirms that the data server indexed them.

### 6. Install and open Photos

Admin-web finds apps by scanning folders that you register. Each folder inside a registered folder that holds a `starkeep.manifest.json` file counts as an app. Admin-web registers the sibling `starkeep-apps` checkout by default, so the Photos card appears in the **Local** section without extra steps.

If the Photos card is missing, click **Discover apps** in the header and add the absolute path of your `starkeep-apps` checkout in the **App discovery** dialog.

1. On the Photos card, click **Install Photos**. Admin-web lists the kinds of files Photos asks for, such as images and videos.
2. Click **Approve & Install** to finish the install.
3. Click **Start Photos**, then click **Open Photos ↗**.

Photos shows the images from your watched folder. Photos is an example app. It shows how Starkeep apps work, and it does not yet replace a full photo library app.

---

## Part B: deploy Starkeep to your AWS account

The cloud stores a copy of your data in your own AWS account and syncs it between your computers and phones. It also runs web versions of your apps, such as Photos, that you can open from any browser. Only the accounts you create can sign in to your deployment and reach its data. The Starkeep project has no access.

Finish Part A first. The cloud setup runs from admin-web, and a cloud web app can only install after the same app is installed on this computer.

### 1. Open the setup wizard

In the **Cloud** section of the dashboard, click **Deploy Starkeep Cloud**. The wizard has five steps, listed on its left.

- You can close the wizard and come back later. The wizard resumes at the first unfinished step.
- After the cloud is deployed, reopen the wizard from **Manage deployment…** in the menu of the cloud **Data Server** card.

### 2. Deploy the bootstrap stack

The bootstrap stack is an AWS CloudFormation stack. The stack creates the sign-in service and the identities and permission limits that the rest of the deployment uses. You deploy the stack once.

1. Choose an **AWS Region** and keep the default **Stack prefix**, `starkeep`, unless you need several deployments in one account.
2. Click **Download bootstrap template**.
3. Click **Open CloudFormation console ↗** and follow **Show full instructions** to create the stack from the downloaded template. The instructions also cover creating a new AWS account.
4. Wait about a minute, until the stack's **Outputs** tab lists values, then click **Stack is deployed — Continue**.

### 3. Copy the stack outputs

1. Open the stack's **Outputs** tab through the **CloudFormation stack** link in the wizard.
2. Copy each of the five values into the wizard field with the same name:
   - **CognitoDomain**
   - **DeviceUserPoolClientId**
   - **IdentityPoolId**
   - **UserPoolClientId**
   - **UserPoolId**
3. Click **Continue**.

### 4. Create your account

Your Starkeep account lives in your own AWS account, in Amazon Cognito.

1. Click **Create user ↗** to open the Cognito console, and follow **Show full instructions**.
2. Choose **Send an email invitation**, enter your email address and choose **Generate a password**.
3. Click **Create user**. Cognito emails you a temporary password within a minute. The period at the end of the email's sentence is not part of the password.
4. Open the new user and add the user to both groups:
   - **starkeep-admins** lets you administer the deployment. Admin-web refuses to sign in an account outside this group.
   - **starkeep-users** gives you a data library that syncs.
5. Return to the wizard and click **User Created — Continue**.

### 5. Sign in

1. Enter your email address and the temporary password, and click **Sign in**.
2. Cognito then asks for a permanent password. Choose a password of at least eight characters and click **Set password and sign in**.

### 6. Deploy the Starkeep cloud

1. Click **Deploy Starkeep cloud**. The deploy runs two passes and streams its progress:
   - The **cloud data server** pass creates the database, the file bucket, the API and the sign-in page for cloud apps. This pass takes several minutes.
   - The **Starkeep Drive** pass creates the identity that syncs your shared files. This pass adds no running services.
2. Click **Continue →** to return to the dashboard.

During and after the deploy:

- The wizard restarts the local data server when the deploy finishes, so the data server picks up the new cloud address.
- If the deploy fails, click **Retry install**. Most failures clear on a retry.
- If your sign-in expires during a long deploy, click **Sign in again**, and the wizard keeps your progress.

### 7. Sign this computer in to sync

This computer syncs only after you sign it in. A sign-in form now sits under the dashboard's **Local** heading.

1. Enter the email address and password of your Starkeep account and click **Sign in to sync**.
2. Wait for the line under the heading to change from "Signed in as `<email>`. Connecting to this cloud…" to "Local apps sync with this cloud as `<email>`." A **Sign out** link follows the sentence.
3. Open Drive to see the sync state of your files.

From then on, the data server syncs in the background. The data server pushes local changes soon after they happen and pulls changes from the cloud regularly.

### 8. Install Photos in the cloud

1. In the **Cloud** section, find the Photos card and click **Install Photos in cloud**. The install builds Photos, uploads it and creates its cloud resources. The install takes a few minutes, and a failed install usually succeeds on **Retry**.
2. When the card reads **Installed**, click **Open Photos ↗**.
3. Sign in on the Starkeep sign-in page with your Starkeep account.

Photos then shows the photos that synced from this computer.

### 9. Add your phone or another computer (optional)

The **Cloud address** line under the **Cloud** heading shows the address that phones and other computers sign in with. Click the copy icon beside the address to copy the address.

To add another computer:

1. Complete Part A on the other computer.
2. In the other computer's **Cloud** section, paste the address into the **This machine** card and click **Join**.
3. Sign in with your Starkeep account.

To add a phone, install the Photos Mobile app for Android and sign in with the same address and account. The [`starkeep-apps` README](https://github.com/starkeep-org/starkeep-apps#readme) explains how to build and install the app.

### 10. Add people (optional)

One deployment can hold several people, and each person gets a separate library. Nobody can see another person's data. The dashboard's **Cloud Users** section appears below the **Cloud** section while admin-web is signed in as an admin.

1. In the section's **Add a user** box, enter the new person's email address.
2. Choose the person's **Roles**:
   - **Data** starts checked and gives the person a library that syncs.
   - **Admin** starts unchecked. Leave **Admin** unchecked unless the person should manage users, cloud apps and settings.
3. Click **Add user**.

Cognito emails the person a temporary password, and the person chooses a permanent password at first sign-in.

---

## Reach admin-web from another device

Admin-web refuses requests from other devices by default. Any device on the network can reach admin-web once you allow it, so do this only on a network you trust.

1. Add the names or addresses that other devices use for this computer to `STARKEEP_ADMIN_DEV_ORIGINS` in `.env.local` at the root of `starkeep-core`, separated by commas:

   ```bash
   STARKEEP_ADMIN_DEV_ORIGINS=192.168.1.51
   ```

2. Restart admin-web. Admin-web then listens on every network interface and accepts those names.

## Remove Starkeep

The scripts in `scripts/` remove what Starkeep created. Each cloud script removes the layers above it first:

- `scripts/teardown-cloud-apps.sh` removes every cloud app.
- `scripts/teardown-cloud-data-server.sh` removes the cloud apps, then the cloud data server with its database and file bucket.
- `scripts/teardown-bootstrap.sh` removes everything above, then the bootstrap stack and the resources outside CloudFormation: the state bucket, the stored passphrase and the Cognito resources.

The cloud scripts need the AWS CLI, signed in with administrator credentials for the deployment's AWS account. `teardown-bootstrap.sh` also needs `python3`. The cloud scripts follow three rules:

- Each cloud script requires `--prefix <stack prefix>` and `--region <region>`, so a teardown never guesses which deployment to remove. In an interactive shell, the script asks for a missing value. An unattended run fails instead.
- The database has deletion protection. `teardown-cloud-data-server.sh` removes the database only after you confirm at the prompt or pass `--force`.
- `teardown-bootstrap.sh` never prompts about the database. Pass `--force` to remove the database. Without `--force`, the database stays in your account.

Removing the database deletes the data stored in the cloud.

`scripts/reset-local-data.sh` deletes this computer's local data: the stored files, the database and the list of watched folders. The script keeps the cloud address and this computer's sign-in. Start the data server afterwards to begin again with an empty library.

## Run the tests

The repository has four test tiers:

1. `pnpm test` runs the unit tests. CI requires them.
2. `pnpm test:integration` runs the suites that start processes, open sockets or boot a database engine. CI runs them as an advisory job, and `pnpm release:publish` runs them before a release.
3. `pnpm test:e2e` runs the local browser tests with Playwright. Run `pnpm exec playwright install chromium` once beforehand. CI runs these tests as an advisory job. See [`e2e/README.md`](e2e/README.md).
4. `pnpm test:aws` runs the full journey against a real AWS account. The suite does nothing unless `STARKEEP_AWS_TESTS=1` is set. A full run takes about 26 minutes and creates real resources in the account. See [`e2e-aws/README.md`](e2e-aws/README.md).
