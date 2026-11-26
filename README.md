# Overview

Starkeep is a modern self-hosting system that allows you to keep your own data, easily build and run your own apps, and do it all on your own hardware and your own serverless cloud infra.

- Fully serverless cloud architecture provides ultra-low running costs. Most users pay only for storage in their own cloud account. 1TB of photos and videos can cost less than $2 / month.
- Create and run mobile apps, desktop apps, and web apps.
- Local-first philosophy. Storage, sync, and apps generally work offline by default.
- Common data storage and content-addressed indexing layer makes building apps easy and eliminates unnecessary data silos.
- Common, built-in sync layer that syncs both user data files and app specific data.
- Multi-user support within a deployment, with separate admin and data roles.
- Enterprise-grade security and built-in file versioning.
- Easy enough for anyone to set up and run, with limitless potential for developers.

[![Join us on Discord](https://img.shields.io/badge/Join%20us-Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.gg/7fKjYaCxVy)

# Why Starkeep

Many commercial apps take your data, lightly repackage it, provide your own data back to you using a frontend they control, and then charge you for it. Big Tech's Photos apps are obvious examples, along with many others. The model leaves users helpless and potentially locked out from their own data, whenever the app decides to lock down APIs, increase pricing, or otherwise cripple their product. Not to mention that the "privacy" policies of these apps usually permit all sorts of things being done with your data, especially in the consumer space. AI has dramatically increased the urgency of these problems.

Starkeep's goal is to disrupt _all_ of these products with a universal solution anyone, even non-technical people, can easily host themselves, with minimal running cost to users and minimal boilerplate for building apps. This is possible because all of these apps have more or less the same shape, and more or less do the same things. They can all handle data in the same way. They really only need different frontends.

The breadth and ambition of Starkeep is what makes this different from traditional self-hosting. The traditional server-based containerized approach to self-hosted apps means users have to deal with a variety of different feature sets and paradigms, and there's little or no interoperability among apps. Meanwhile, in order to build apps for traditional self-hosting, developers have to reinvent basic systems like storage, sync, user management, etc that really only need to be solved once.

# Get Started

## Installing Starkeep

One command clones Starkeep into `~/.starkeep/platform`, installs it and starts the local services:

```sh
curl -fsSL https://starkeep.app/install.sh | sh
```

To read the script first, run `curl -fsSL https://starkeep.app/install.sh | less`. Its source is `scripts/install.sh` in this repository.

To keep the checkout somewhere you choose, run the same steps by hand:

```sh
git clone https://github.com/starkeep-org/starkeep-core.git
cd starkeep-core
pnpm starkeep setup
```

Either way, setup offers a `~/.local/bin/starkeep` link so that `starkeep` works from any folder. Then:

- [Run Starkeep on your computer](#run-starkeep-on-your-computer) walks through Admin, the local web app.
- [Deploy Starkeep Cloud](#deploy-starkeep-to-your-aws-account)

## After Installing

- (Optional) [Install Starkeep Photos](#6-recommended-install-and-open-photos), the flagship Starkeep app
- [Create your own Starkeep App](docs/authoring-an-app.md)
- [Upgrade Starkeep](#upgrade-starkeep)
- [Terminal command reference](#from-the-terminal)

## Before you begin

You need the following on your computer:

- Node.js 24 or later.
- pnpm 10.20 or later, as a `pnpm` command on your `PATH`.
- A checkout of this repository, `starkeep-core`.
- A checkout of [`starkeep-apps`](https://github.com/starkeep-org/starkeep-apps) is optional but highly recommended so you can try out the Starkeep Photos app and examine its implementation. A typical location is `~/starkeep-apps`.

The cloud setup also needs an AWS account. The setup wizard explains how to create one.

## Run Starkeep on your computer

### 1. Install dependencies

Run the following command at the root of `starkeep-core`:

```sh
pnpm starkeep setup
```

Setup runs `pnpm install`, which also builds the workspace packages, and starts the local data server and Drive. To rebuild later without reinstalling, run `pnpm build`.

Admin installs each app's dependencies when you install the app, so apps such as Photos and the Example App need no separate install step.

### 2. Start Starkeep Admin

Starkeep Admin is a local web app for starting Starkeep's services, installing apps, and setting up the cloud.

1. Run `starkeep admin`. The command starts Admin and opens `http://localhost:3000` in your browser.

   To work on Admin itself, run `pnpm --filter admin-web dev` instead, which reloads on every change.

Admin listens on `127.0.0.1` and refuses any request addressed to a name other than `localhost`, `127.0.0.1` or `[::1]`. To reach Admin under another address, add its IP address or hostname (as a comma-separated list) to `STARKEEP_ADMIN_DEV_ORIGINS` in `.env.local` at the root of `starkeep-core`. Caution, setting this key makes Admin listen on all network interfaces instead of only 127.0.0.1.

### 3. Start the local data server

The local data server stores and indexes the files in folders you choose to watch and the data that Starkeep apps save. Every Starkeep app on this computer reads and writes through the data server. The data server runs sync once you set up the cloud.

`starkeep setup` starts the data server. Otherwise, in the **Local** section, find the **Data Server** card and click **Start Data Server**, or run `starkeep start data-server`. The data server listens on port 9820.

On first start, the data server creates `~/.starkeep/` to hold its database, object storage for files and configuration. To keep that state somewhere else, set `STARKEEP_DIR` to an absolute path in `.env.local` at the root of `starkeep-core`. The file `.env.example` lists the supported settings.

### 4. (Optional) Add a folder of files

The data server can watch folders on your computer. Each file in a watched folder becomes a record that Starkeep apps can see. The data server picks up new and changed files as they appear.

1. Create a folder and copy a few files into it, such as some photos and a document.
2. On the **Data Server** card, click **Add Local Folder**.
3. Enter the folder's path in the **Local folders** dialog and click **Add folder**.

Starkeep uses symlinks instead of copies locally, so your actual files stay in their original location while becoming accessible to Starkeep apps (and synced to the cloud if you set that up).

You can use a different app (such as Photos) to add files if you prefer.

### 5. (Optional) Open Drive

Starkeep Drive is a basic local app that lets you see all the files kept in Starkeep.

1. On the **Starkeep Drive** card, click **Start Drive**.
2. Click **Open Drive ↗**.

The files from your folder appear in Drive, which confirms that the data server indexed them.

### 6. (Recommended) Install and open Photos

Admin finds apps by scanning folders that you register. A registered folder that holds a `starkeep.manifest.json` file is one app. In any other registered folder, each folder directly inside it that holds a `starkeep.manifest.json` file counts as an app. **Discover apps** shows the apps each folder contributed and the reason for any folder that it skipped.

A new install registers one folder, `starkeep-core/example-app`, so the Example App card shows by default. The Example App performs every operation an app can, on invented files. To hide its card, choose **Hide** from the card's menu.

To show Photos, click **Discover apps** in the header and add the path of your `starkeep-apps` checkout, such as `~/starkeep-apps`.

1. On the Photos card, click **Install Photos**.
2. Click **Approve & Install** to finish the install. This gives Photos permission to read and write photo and video files to your common storage.
3. Click **Start Photos**, then click **Open Photos ↗**.

Photos shows the images from your watched folder, or use the mobile app to add photos from your phone.

## Deploy Starkeep to your AWS account

The cloud stores a copy of your data in your own AWS account and syncs it across your computers and phones. It also enables you to run web apps in the cloud that you can access from anywhere.

Only the accounts you create can sign in to your deployment and reach its data. The Starkeep organization has no access.

Everything below is a one-time setup. Deploy from one computer only. To add a second computer, follow [Sync another computer with your cloud](#sync-another-computer-with-your-cloud) instead. A second deployment creates a separate cloud that does not share your data.

The steps below use Admin's setup wizard. `starkeep setup --cloud` runs the same setup from a terminal in one command; see [Deploy the cloud](#deploy-the-cloud).

### Prerequisite

Starkeep Cloud runs on your AWS account (support for more providers will come later). If you don't have an AWS account, you can create one for free.

### 1. Open the setup wizard and deploy the bootstrap stack

In the **Cloud** section of the dashboard, click **Deploy Starkeep Cloud**.

The first step deploys your bootstrap stack. The stack creates the sign-in service and the identities and permission limits that the rest of the deployment uses.

1. Enter a **Deployment name** of up to 32 characters. Use letters, numbers, spaces, hyphens, and underscores. Sign-in pages and new account emails show this name.
2. Choose an **AWS Region** and keep the default **Stack prefix**, `starkeep`, unless you need several deployments in one account.
3. Enter your email address to create your Starkeep Admin account. This account will be able to manage users and apps in the cloud. This email is private to you, no one else sees it, not even the Starkeep organization.
4. Click **Download bootstrap template**.
5. Click **Open CloudFormation console ↗** and follow **Show full instructions** to create the stack from the downloaded template.
6. Wait about a minute until the stack's **Outputs** tab lists values, then click **Stack is deployed — Continue**.

### 2. Copy the stack outputs

1. Open the stack's **Outputs** tab through the **CloudFormation stack** link in the wizard.
2. Copy each of the four values into the wizard field with the same name, then click **Continue**:
   - **CognitoDomain**
   - **IdentityPoolId**
   - **UserPoolClientId**
   - **UserPoolId**

Please note that none of these values are credentials and none are sensitive.

### 3. Sign in to your admin account

1. Check the email you entered in Step 1 for your temporary password.
2. Click **Open the sign-in page**. The Starkeep sign-in page opens in the same browser tab.
3. Enter the email address and the temporary password. The page then asks you to choose a permanent password of at least eight characters.
4. The page returns you to the wizard. Click **Continue**.

The `starkeep` command on this computer uses the same sign-in. A sign-in that goes unused for twelve hours ends. Sign in again in Admin, or with `starkeep login --admin`.

### 4. Deploy the Starkeep cloud

1. Click **Deploy Starkeep cloud**. The deployment takes a few minutes to complete.
2. When the deployment completes, click **Continue →** to return to the dashboard.

### 5. Sign this computer in to sync

This computer syncs only after you sign it in. A **Sign in to sync** button now sits under the dashboard's **Local** heading.

1. Click **Sign in to sync**. The sign-in page opens, or returns at once while it still remembers your admin sign-in.
2. Wait for the line under the heading to change from "Signed in as `<email>`. Connecting to this cloud…" to "Local apps sync with this cloud as `<email>`." A **Sign out** link follows the sentence.
3. Open Drive to see the sync state of your files.

From now on, the data server syncs your computer's local Starkeep with your cloud Starkeep in the background.

### 6. Install Photos in the cloud

Installing the Photos web app in the cloud allows you to access your photos remotely.

1. In the **Cloud** section, find the Photos card and click **Install Photos in cloud**. The install builds Photos, uploads it and creates its cloud resources. The install takes a few minutes, and a failed install usually succeeds on **Retry**.
2. When the card reads **Installed**, click **Open Photos ↗**.
3. Sign in on the Starkeep sign-in page with your Starkeep account.

Photos then shows the photos that synced from this computer.

## Install the Photos mobile app

Starkeep Photos is available as an Android app you can build yourself. (Starkeep Photos for iOS is in the works.)

Until the app is available in the Play Store, see the [Starkeep Discord](https://discord.gg/7fKjYaCxVy) for an APK download link. You can also build the APK from source as described under [Build the APK from source](#build-the-apk-from-source-optional) below.

### 1. Register the Photos mobile app on Starkeep Cloud

In the Admin's **Cloud** section, click **Register Photos Mobile** on the Photos Mobile card.

### 2. Install the app on your Android phone

Download the APK to your phone and install it. You may need to turn on the "Install unknown apps" setting in order to install apps downloaded outside the Play Store.

### 3. Sign in

1. In the Admin app, copy the address from the **Cloud address** line under the **Cloud** heading.
2. Open **Starkeep Photos** on the phone and tap **Sign in to Starkeep Cloud**.
3. Enter the cloud address and tap **Sign in**. The phone's browser opens your cloud's sign-in page.
4. Sign in with your Starkeep account. The browser returns you to the app.

Now your phone will sync with your Starkeep cloud. The app will sync with the cloud and ingest the most recent 14 days of photos/videos from your camera roll, along with new photos/videos you take.

### Build the APK from source (optional)

You can build the APK yourself (and modify it) if you want.

#### 1. Prerequisites

You need the following:

- The `starkeep-apps` dependencies. Run `pnpm install` at the root of `starkeep-apps` if you haven't already.
- JDK 17. Run `java -version` to check.
- The Android SDK, with platform tools. Android Studio installs both. Set `ANDROID_HOME` to the SDK folder, such as `~/Library/Android/sdk` on macOS.
- An Android phone with USB debugging turned on, connected over USB.
- A Starkeep account with the **Data** role. The main cloud account you created when you deployed the cloud has that role by default.

#### 2. Generate the Android project

Run the following command at the root of `starkeep-apps` to generate the Android project.

```sh
pnpm --filter @starkeep/photos-mobile prebuild
```

Run the command again after any change to `app.json`, the app icons or the native dependencies. Add `--clean` to the end of the command to regenerate the project from scratch.

#### 3. Build the app

```sh
cd photos-mobile/android
./gradlew assembleRelease
```

The first build downloads Gradle and the Android dependencies. The build writes the app to `photos-mobile/android/app/build/outputs/apk/release/app-release.apk`.

#### 4. Install the app on the phone

1. Run `adb devices` and confirm that the phone appears as `device`. Accept the USB debugging prompt on the phone if one appears.
2. From `photos-mobile/android`, install the app:

   ```sh
   adb install -r app/build/outputs/apk/release/app-release.apk
   ```

The `-r` flag updates an installed copy and keeps the app's data.

#### About the signing key

The build uses Expo's public debug key, and the Photos manifest declares that key's certificate by default. Anyone can build an app that the cloud accepts as Photos, so treat this build as a development build.

## Sync another computer with your cloud

A second computer joins the cloud you already deployed. The second computer syncs your data but does not administer the cloud. Manage users, cloud apps and costs from the computer that deployed the cloud.

1. On the second computer, follow steps 1 to 3 of [Run Starkeep on your computer](#run-starkeep-on-your-computer) to install Starkeep and start Admin and the local data server.
2. On the computer that deployed the cloud, copy the address from the **Cloud address** line under the dashboard's **Cloud** heading.
3. On the second computer, click **Join Existing Cloud** under the dashboard's **Cloud** heading. Do not click **Deploy Starkeep Cloud**.
4. Paste the address into the form that opens and click **Join**. The local data server restarts.
5. Click **Sign in to sync**, and sign in with your Starkeep account on the page that opens. A person whose account an admin just created uses the temporary password from their invitation email, and the page asks them to choose a permanent one.
6. Wait for the section to change from "Signed in as `<email>`. Connecting to `<address>`…" to "Local apps sync with `<address>` as `<email>`."

From a terminal, `starkeep setup --join <address>` does steps 3 to 5.

The second computer now syncs your library with the cloud in the background. A person you add under [Add users to your Starkeep deployment](#add-users-to-your-starkeep-deployment-optional) joins from their own computer the same way.

## Add users to your Starkeep deployment (optional)

One deployment can hold several people, and each person gets a separate library. Nobody can see another person's data. The dashboard's **Cloud Users** section appears below the **Cloud** section while admin-web is signed in as an admin.

1. In the section's **Add a user** box, enter the new person's email address.
2. Choose the person's **Roles**:
   - **Data** gives the user their own data library that syncs with the cloud.
   - **Admin** allows this user to manage other users, cloud apps and settings.
3. Click **Add user**.

The new user will be emailed a temporary password, and they choose a permanent password at first sign-in. Send the new user your cloud address. The new user joins with that address as described in [Sync another computer with your cloud](#sync-another-computer-with-your-cloud).

## Upgrade Starkeep

Upgrading Starkeep will not affect your data.

From a terminal, `starkeep update` does every step below: it pulls this checkout and each app's repository, restarts the data server and Drive, previews and applies the bootstrap update with your terminal's AWS credentials after you confirm, redeploys the cloud data server and Drive when they differ from the checkout, and then updates the apps, the cloud first. `starkeep update --platform` does the platform steps alone. A redeploy refuses when the cloud runs commits this checkout lacks, such as a feature branch, and names them; `--force` deploys anyway. `starkeep cloud status` shows what the cloud runs against this checkout.

### 1. Upgrade the local data server

1. Pull the latest from `starkeep-core` and install it with `pnpm install`.
2. In Admin, choose **Stop** from the **Data Server** card's triple-dot menu.
3. Click **Start Data Server** on the **Data Server** card.

### 2. Upgrade the cloud data server and cloud Drive

1. Rarely, an upgrade requires a bootstrap update, which should be run on the terminal with `starkeep cloud bootstrap-update --apply` (or `scripts/update-bootstrap.sh --apply`, which runs it). This command requires your terminal's AWS credentials with sufficient permissions. This command runs outside Admin for security reasons. Most upgrades skip this step.
2. On the **Data Server** card in the **Cloud** section, choose **Manage deployment…** from the menu.
3. On the **Deploy Starkeep cloud** step, click **Redeploy**. The redeploy updates the cloud data server first and then cloud Drive.

### 3. Upgrade the apps

1. Pull the latest code, or run `starkeep update`, which pulls each app's repository and applies the new code to the cloud and then to this computer.
2. Restart each local app from Admin. If the app's manifest changed, you'll be shown a consent dialog before updating.
3. To upgrade cloud apps from Admin, click **Redeploy <app name>** from the triple-dot menu to deploy the new code.

## From the terminal

The `starkeep` command performs Admin's tasks from a terminal, such as on a computer you reach over SSH. Run `pnpm starkeep <command>` at the root of `starkeep-core`, or `starkeep <command>` anywhere once setup has linked it. A relative folder path resolves against the folder you run the command in. `starkeep help <command>` describes each command and names the credentials it uses.

```sh
starkeep status                                  # what runs, and this computer's sync sign-in
starkeep start                                   # the data server, Drive and every app marked to run
starkeep stop photos                             # stop an app and clear its mark to run
starkeep logs data-server -f                     # follow a service's log
starkeep source add ~/starkeep-apps              # add a folder to app discovery
starkeep list                                    # the apps discovery finds, and what is installed here and in the cloud
starkeep install photos --local                  # show the consent text, then install on this computer
starkeep install photos --cloud                  # install in the cloud: the data side and every surface
starkeep install photos --web                    # install only the cloud web app
starkeep uninstall photos --local                # uninstall; the app's data stays
starkeep uninstall photos --cloud --delete-data  # uninstall from the cloud and delete the data it kept
starkeep update                                  # update the platform, then pull each app's repository and apply it, cloud first
starkeep update --platform                       # update this checkout, the bootstrap stack, the cloud data server and Drive
starkeep update --undo                           # return to the commits before the last update
starkeep cloud status                            # what the cloud runs, against this checkout
starkeep cloud bootstrap-update                  # preview the bootstrap stack's update; --apply applies it
starkeep reset-local                             # list the local data reset-local --apply deletes
starkeep login --admin                           # sign in as the cloud's admin, in the browser
starkeep login --sync                            # sign this computer in to sync, in the browser
starkeep logout --admin                          # end the admin sign-in that Admin shares
```

`install` and `uninstall` always take a target: `--local`, `--cloud`, `--web` or `--mobile`, and the flags combine. Every command accepts `--json`, which prints one JSON event per line and a final result. A command that needs an answer and has no terminal to ask exits with code 3; pass `--yes` to approve.

A cloud command signs in as the admin, with the same sign-in Admin uses, and opens the sign-in page in your browser when no sign-in is open. Only the bootstrap stack uses your terminal's AWS credentials. The cloud work runs in the background: a closed terminal leaves it running, and running the same command again, or opening Admin, follows it. The whole log of each cloud run is in `~/.starkeep/installs/`.

### Deploy the cloud

```sh
starkeep setup --cloud --region us-east-2 --name "Home" --admin-email you@example.com
```

The command signs in to AWS with your terminal's credentials, such as `aws sso login` or an `AWS_PROFILE`, and shows the account and the region before it creates the bootstrap stack. Cognito then emails the admin address a temporary password. The command opens the sign-in page in your browser, where you sign in with that password and choose a permanent one. It then installs the cloud data server and Drive, which takes 10 to 20 minutes, and signs this computer in to sync. The sync sign-in opens the browser again, and the sign-in page usually remembers you.

Each step checks first whether it is done, so after a failure you fix the cause and run the same command again. `--prefix` names the stack prefix (`starkeep` by default), `--domain` attaches a custom domain, and `--apps photos,example-app` installs apps in the cloud at the end.

To join a cloud that already exists, run `starkeep setup --join <address>`.

### Install an app in the cloud

```sh
starkeep install photos --cloud
```

The command builds the app's bundle from its folder on this computer and installs the app's data side and every surface the manifest offers. `--web` or `--mobile` installs one surface only. A cloud install needs no local install. The same command upgrades an installed app, and `starkeep update` upgrades every app.

The scripts in `packages/admin-installer/scripts` that these commands replaced stay for the end-to-end tests. Use the `starkeep` command instead.

## Removing Starkeep Cloud

The scripts in `scripts/` remove what Starkeep created. Each cloud script removes the layers above it first:

- `scripts/teardown-cloud-apps.sh` removes every cloud app.
- **DANGER** `scripts/teardown-cloud-data-server.sh` removes the cloud apps, then it removes the Starkeep S3 bucket, DSQL database, cloud data server Lambda and the Drive role. **All your data will be removed from the cloud.** Local copies are unaffected.
- **DANGER** `scripts/teardown-bootstrap.sh` removes everything above, then the bootstrap stack and the resources outside CloudFormation: the state bucket, the stored passphrase and the Cognito resources. **This completely removes Starkeep from the cloud.**

The cloud scripts need `python3` and the AWS CLI, signed in with administrator credentials for the deployment's AWS account. The cloud scripts follow three rules:

- Each cloud script requires `--prefix <stack prefix>` and `--region <region>`, so a teardown never guesses which deployment to remove. In an interactive shell, the script asks for a missing value. An unattended run fails instead.
- The database has deletion protection. `teardown-cloud-data-server.sh` removes the database only after you confirm at the prompt or pass `--force`.
- `teardown-bootstrap.sh` never prompts about the database. Pass `--force` to remove the database. Without `--force`, the database stays in your account.

Pass `--dry-run` to any cloud script to see what it would remove. The script lists each resource it found, including the lists of the layers above it, and removes nothing. A cloud script that cannot remove a resource keeps going, lists each failure at the end, and exits with an error.

## Removing Starkeep locally

`scripts/reset-local-data.sh` deletes the files, the database and the list of watched folders that this machine holds in Starkeep. The script keeps the cloud address and this computer's sign-in.

The script deletes files that you added through an app, such as photos imported into Photos. Files in watched folders stay in place, because Starkeep only links to them.

This script does not affect cloud data. Please note that your data may re-sync down from the cloud if you are syncing with the cloud and your local data server is running.

## Run the tests

The repository has four test tiers:

1. `pnpm test` runs the unit tests. CI requires them.
2. `pnpm test:integration` runs the suites that start processes, open sockets or boot a database engine. CI runs them as an advisory job, and `pnpm release:publish` runs them before a release.
3. `pnpm test:e2e` runs the local browser tests with Playwright. Run `pnpm --filter @starkeep/e2e exec playwright install chromium` once beforehand. CI runs these tests as an advisory job. See [`e2e/README.md`](e2e/README.md).
4. `pnpm test:aws` runs the full journey against a real AWS account, using a separate disposable test deployment with the prefix `sktest`. The suite does nothing unless `STARKEEP_AWS_TESTS=1` is set, and it requires `STARKEEP_AWS_E2E_REGION`, a region that none of your live deployments use. A full run takes about 26 minutes and creates real resources in the account, then tears them down by default upon success. See [`e2e-aws/README.md`](e2e-aws/README.md).

# Security

Starkeep's cloud-side security posture has been assessed in a written threat model: [`SECURITY.md`](SECURITY.md). It covers the cloud data server (broker, DSQL, files bucket, API Gateway), cloud apps and their install/uninstall lifecycle, the Cognito + IAM bootstrap, and the cloud sync path.

# Further reading

- [`docs/system-design.md`](docs/system-design.md) — the major parts, how data is classified (shared vs app-specific), and how it moves and syncs.
- [`docs/data-roles-and-permissions.md`](docs/data-roles-and-permissions.md) — identities, trust boundaries, and why the admin app never appears on the data path.
- App READMEs: [`apps/admin-web`](apps/admin-web/README.md), [`apps/local-data-server`](apps/local-data-server/README.md).
