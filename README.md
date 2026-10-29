# Starkeep

Starkeep is a modern self-hosting system that allows you to keep your own data and run your own apps on your own hardware and (optionally) your own serverless cloud infra. Starkeep's advantages over traditional self-hosting include:

- Ultra-low, scale-to-zero running costs thanks to fully serverless architecture - **Starkeep costs ~$0 to run**, you just (essentially) pay for actual storage and transfer costs.
- Common data storage and indexing layer makes building apps easy and eliminates unnecessary container silos
- Common, built-in cloud <-> local sync layer that syncs both user files and app specific data
- Run apps locally on device and/or in the cloud
- Enterprise-grade security, backups, and versioning built-in
- **Easy enough for anyone to set up and run**, with limitless potential for developers

## Current Project Status

Starkeep is currently in alpha, pre-production status. The whole system and all the benefits described above are fully implemented end-to-end, including a proof-of-concept installable Photos app (available in the sister repo starkeep-apps), and extensive automated tests.

However, there are some significant known limitations, making Starkeep probably not yet suitable for "production" (that is personal use), yet:

- Starkeep does not yet provide a way to update its foundational bootstrap deployment. Of course, you can update it yourself since it runs on your infra, but there's no out of the box update support yet.
- Custom DNS support has not been added to the system yet.
- Starkeep does not yet support non-default Lambda concurrency limits (i.e. beyond the new account default limit of 10). This is because increasing that limit requires making a request to Amazon and could complicate the setup, which we wanted to keep as simple as possible. We'll sort this out soon.
- The apps - essentially Drive (built-in) and Photos (installable) - are mostly bare bones proof-of-concept level and lack the features you'd likely need to use these apps as real replacements for, say, your current Photos app. We'll get there!

## Overview

The Starkeep Core repo includes four built-in system apps:

- **Starkeep Admin**: The management hub. Sign in, discover, install and run apps. Currently, the Admin app runs locally only.
- **Local Data Server**: A local service responsible for indexing, lookup, enforcing data semantics, and bookkeeping sync on the local side.
- **Starkeep Drive**: A general purpose storage app with two special powers: it is the only app allowed to operate on all file types (including unknown), and its identity is used to sync data between local and cloud. Currently, the Starkeep Drive app runs locally only.
- **Cloud Data Server**: The cloud analog of the local data server: responsible for indexing, lookup, enforcing data semantics, and bookkeeping sync on the cloud side. Runs in a Lambda.

Beyond the core, Starkeep is designed for many "installable" apps to run on top by interacting with the Local and/or Cloud Data Servers. Each installable app declares the file types it can operate on in its manifest, and users accept the type permissions at install time.

For now, we provide an example "Photos" app available in a separate repo, [`starkeep-apps`](https://github.com/starkeep-org/starkeep-apps).

For the full picture of the parts and how data moves between them, see [`system-design.md`](system-design.md). For the trust boundaries between those parts, see [`data-roles-and-permissions.md`](data-roles-and-permissions.md).

## Getting started

[`getting-started.md`](getting-started.md) walks through running Starkeep on your computer, installing the Photos example app, deploying Starkeep to your own AWS account, adding phones, computers and people, removing Starkeep, and running the tests.

## Security

Starkeep's cloud-side security posture has been assessed in a written threat model: [`SECURITY.md`](SECURITY.md). It covers the cloud data server (broker, DSQL, files bucket, API Gateway), cloud apps and their install/uninstall lifecycle, the Cognito + IAM bootstrap, sign-in for cloud apps, computers and phones, the isolation between people on one deployment, and the cloud sync path, working from the boundary of the operator's own AWS account. Each threat carries an honest posture label — Strong, Adequate, Partial, Deferred by design, or Out of scope / accepted.

A companion breadth-first evaluation against the OWASP ASVS 5.0 standard — every chapter, high level — lives in [`owasp-asvs-evaluation.md`](owasp-asvs-evaluation.md).

## Further reading

- [`system-design.md`](system-design.md) — the major parts, how data is classified (shared vs app-specific), and how it moves and syncs.
- [`data-roles-and-permissions.md`](data-roles-and-permissions.md) — identities, trust boundaries, and why the admin app never appears on the data path.
- App READMEs: [`apps/admin-web`](apps/admin-web/README.md), [`apps/local-data-server`](apps/local-data-server/README.md).

## Repository layout

```
starkeep-core/
  apps/
    admin-web/           Admin panel — the command center for setup, install, and status
    local-data-server/   On-device data broker (HTTP); embeds the SDK, runs sync + watches local folders
    drive/               Starkeep Drive UI — the built-in User-Data-Owner app
  packages/              SDK, storage adapters, sync engine, access control, installer, bootstrap, …
    admin-installer/builtin-apps/
      cloud-data-server/ The cloud-side data broker, deployed as a built-in app
      starkeep-drive/    The cloud-side Drive built-in
  scripts/               Teardown + local reset helpers
  e2e/  e2e-aws/         Platform end-to-end suites (local Playwright / real AWS)
```

First-party _apps_ (e.g. Photos) live in the sibling [`starkeep-apps/`](../starkeep-apps) checkout. They install through the same path a third-party app would — there is no privileged wiring against `starkeep-core`.
