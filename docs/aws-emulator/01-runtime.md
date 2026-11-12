# AWS Emulator, runtime: install, start, point the JavaScript SDK, S3 round trip

Issue: AI-679 (epic AI-678, wave 1). Spike: [`spikes/aws-emulator/runtime/`](../../spikes/aws-emulator/runtime/).
Workflow: [`.github/workflows/aws-emulator-spike.yml`](../../.github/workflows/aws-emulator-spike.yml).

**Emulator version used: 1.0.322** (release date 2026.11.10, commit `7753983c6e495ec3612695b1336bf4936fc7b7fd`),
Debian package `aws-emulator_1.0.322-1_amd64.deb`. The spike pins this version; `EMULATOR_VERSION=latest` overrides it.

## Findings

1. **It runs in the agent sandbox: yes.** The Debian package installed and started inside the agent's
   container (Debian 12, x86_64, no root, no passwordless sudo), and the S3 round trip with
   `@aws-sdk/client-s3` 3.1009.0 passed. Without root, `apt-get install` is not possible, so the spike
   unpacks the same `.deb` with `dpkg-deb -x` into a temp directory. The package is one binary plus a
   license file, and its only post-install step is a `/usr/bin/aws-emulator` symlink, so nothing is lost.
2. **Startup is fast, the download is not small.** Health was `ok` 0.25 to 0.48 s after launch in the sandbox.
   The package is 163 MiB and the binary 925 MiB, so install time is download plus decompression
   (5.8 to 9.3 s in the sandbox). Idle memory is about 160 MiB according to the guide.
3. **Credentials need no bootstrap step.** Each emulator run generates its own access key pair and writes
   it to `~/.aws/emulator/<port>/emulator_credentials`; pointing `AWS_SHARED_CREDENTIALS_FILE` at it is
   all the SDK needs. No IAM `CreateAccessKey` or STS call is required. Any other key is refused with
   `403 AccessDenied: Sign the request with the emulator credentials`.
4. **TLS trust for Node is `NODE_EXTRA_CA_CERTS`, nothing else.** The JavaScript SDK ignores
   `AWS_CA_BUNDLE` and the config file's `ca_bundle`. Without `NODE_EXTRA_CA_CERTS` every call fails with
   `self-signed certificate` (`DEPTH_ZERO_SELF_SIGNED_CERT`). It must be set before `node` starts and
   adds to Node's default trust (does not replace it), so the same process can still reach other HTTPS hosts.
5. **S3 must be path-style against `127.0.0.1`.** The SDK picks path style on its own for an IP endpoint.
   With `https://localhost:9297` and the default addressing, the SDK sends to `<bucket>.localhost` and
   fails TLS (`ERR_TLS_CERT_ALTNAME_INVALID`); the emulator does not serve virtual-hosted style at all.

### Measured numbers

| Where                                                                                        | Install mode           | Download s | Install s (download + verify + install)       | Startup s (launch → health `ok`) | Binary size             | S3 round trip |
| -------------------------------------------------------------------------------------------- | ---------------------- | ---------- | --------------------------------------------- | -------------------------------- | ----------------------- | ------------- |
| Agent sandbox (Debian 12 container, x86_64, no root), 2026-11-12, run 1                      | `extract` (`dpkg-deb`) | 1.68       | 5.81 (signature not yet verified in this run) | 0.26                             | 970 692 256 B (925 MiB) | ok            |
| Agent sandbox, run 2 (lint and tests running alongside)                                      | `extract` (`dpkg-deb`) | 1.81       | 9.31 (not verified)                           | 0.48                             | same                    | ok            |
| Agent sandbox, run 3 (final script, signature verified with `gpgv`)                          | `extract` (`dpkg-deb`) | 1.53       | 7.55                                          | 0.25                             | same                    | ok            |
| GitHub Actions `ubuntu-latest` (Ubuntu 26.04), 2026-11-12, run 43139326209                   | `apt` (`sudo apt-get`) | 0.47       | 13.71 (signature verified with `gpgv`)        | 0.16                             | 970 692 256 B (925 MiB) | ok            |
| GitHub Actions `ubuntu-latest` (Ubuntu 26.04), 2026-11-12, run 43141161803 (PR's final head) | `apt` (`sudo apt-get`) | 0.44       | 17.62 (signature verified with `gpgv`)        | 0.20                             | same                    | ok            |

The Actions rows come from runs [43139326209](https://github.com/myleshenderson/starkeep-core/actions/runs/43139326209)
and [43141161803](https://github.com/myleshenderson/starkeep-core/actions/runs/43141161803) of
`aws-emulator-spike.yml` on the AI-679 pull request (the job's summary box prints every value in this
table). Round-trip timings there (64 KiB object), run 43139326209: CreateBucket 60 ms, PutObject 5 ms,
GetObject 3 ms, ListObjectsV2 3 ms, DeleteObject 2 ms, ListObjectsV2 1 ms, DeleteBucket 1 ms; run
43141161803: CreateBucket 83 ms, PutObject 10 ms, GetObject 5 ms, ListObjectsV2 4 ms, DeleteObject 3 ms,
ListObjectsV2 2 ms, DeleteBucket 2 ms.

Round-trip timings in the sandbox (64 KiB object): CreateBucket 86 ms (first call: TLS handshake and
credential load), PutObject 13 ms, GetObject 9 ms, ListObjectsV2 6 ms, DeleteObject 4 ms,
ListObjectsV2 5 ms, DeleteBucket 2 ms.

## Recipe

### 1. Install

Packages live under `https://downloads.aws.com/aws-emulator/packages/aws-emulator/LTS/`. The list of
published versions is `versions.json` in that folder. Pinned version (what the spike uses):

```bash
VERSION=1.0.322
ARCH=amd64   # or arm64
URL=https://downloads.aws.com/aws-emulator/packages/aws-emulator/LTS/aws-emulator_${VERSION}-1_${ARCH}.deb
# Latest instead: https://downloads.aws.com/aws-emulator/packages/aws-emulator/LTS/latest/aws-emulator_${ARCH}.deb
curl -fsSLo aws-emulator.deb "$URL"
```

Verify the signature. The guide calls this optional; the spike always does it and refuses to install on failure. With `gpg` (the guide's commands):

```bash
curl -fsSLo aws-emulator.deb.sig "$URL.sig"
curl -fsSLo aws-publishing.asc https://downloads.aws.com/keys/gpg/current.asc
gpg --import aws-publishing.asc
gpg --fingerprint ssm-publishing@amazon.com   # must be 98BC F336 A3BE 53B7 34E9 67C5 2E5B F49B D940 F624
gpg --verify aws-emulator.deb.sig aws-emulator.deb
```

Without `gpg` (the agent sandbox has only `gpgv`, which `apt` itself depends on, so it is on every
Debian and Ubuntu machine), decode the armored key and require the pinned key as signer:

```bash
awk '/^-----BEGIN/ { h = 1; next } h && /^$/ { b = 1; next } /^=|^-----END/ { b = 0 } b' aws-publishing.asc \
  | base64 -d >aws-publishing.gpg
gpgv --status-fd 1 --keyring ./aws-publishing.gpg aws-emulator.deb.sig aws-emulator.deb \
  | awk '$2 == "VALIDSIG" { print $NF }'   # must print 98BCF336A3BE53B734E967C52E5BF49BD940F624
```

Checking the `VALIDSIG` primary fingerprint (rather than only that the key is in the keyring) means a
second key in `current.asc` could not sign for AWS. A `.deb` with one byte changed gives `BADSIG`.

Then either, with root (GitHub Actions):

```bash
sudo apt-get install -y ./aws-emulator.deb      # binary at /opt/aws-emulator/bin, symlink /usr/bin/aws-emulator
aws-emulator -v
```

or, without root (agent sandbox):

```bash
dpkg-deb -x aws-emulator.deb "$DIR"
"$DIR/opt/aws-emulator/bin/aws-emulator" -v
```

The only runtime dependency is glibc (`libc6 >= 2.17`).

### 2. Start and wait for health

```bash
aws-emulator --telemetry off &              # -p <port> or EMULATOR_DATA_PORT to move off 9297
CA=~/.aws/emulator/9297/ca.pem
for i in $(seq 300); do
  [ -s "$CA" ] && [ "$(curl -sf --cacert "$CA" https://127.0.0.1:9297/__admin/health)" = ok ] && break
  sleep 0.1
done
```

On start the emulator writes `ca.pem`, `truststore.p12` (Java), `config` and `emulator_credentials` into
`~/.aws/emulator/<port>/` (mode 0600, directory 0700). A new certificate and new keys are generated on
every start. SIGTERM stops it cleanly and deletes that directory along with all emulated resources (state
is in memory only). A run that is killed with SIGKILL leaves the directory behind; the spike deletes it
before starting so a stale `ca.pem` cannot fail the health probe.

Telemetry is on by default; the spike turns it off with `--telemetry off` (`EMULATOR_TELEMETRY=off`
also works).

### 3. Point `@aws-sdk/client-s3` at it, including TLS trust and credentials

Environment for the process that runs the SDK (port 9297):

```bash
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_PROFILE
export AWS_ENDPOINT_URL=https://127.0.0.1:9297
export AWS_SHARED_CREDENTIALS_FILE=~/.aws/emulator/9297/emulator_credentials   # the credential bootstrap
export AWS_CONFIG_FILE=~/.aws/emulator/9297/config
export NODE_EXTRA_CA_CERTS=~/.aws/emulator/9297/ca.pem                         # TLS trust for Node
export AWS_CA_BUNDLE=~/.aws/emulator/9297/ca.pem                               # for the AWS CLI; Node ignores it
export AWS_EC2_METADATA_DISABLED=true
export AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1
```

Client:

```js
const s3 = new S3Client({
  endpoint: process.env.AWS_ENDPOINT_URL, // keep 127.0.0.1, never localhost
  region: "us-east-1",
  forcePathStyle: true, // the emulator only serves path-style S3
  disableHostPrefix: true, // the guide's JS v3 setting for host-prefixed operations (not S3)
});
```

Credentials come from the SDK's default chain via `AWS_SHARED_CREDENTIALS_FILE`. Variables that hold
other keys must be unset because environment variables win over the file. The spike also refuses to run
unless `AWS_ENDPOINT_URL` is `https://127.0.0.1:<port>`, so a missing variable cannot send its requests
to real AWS.

The emulator accepts additional keys created through its own IAM or STS, but the generated keys are
enough for everything in this spike and the guide says the emulator never denies a request signed with them.

### 4. What the spike does

[`run.sh`](../../spikes/aws-emulator/runtime/run.sh) runs steps 1 to 3, then
[`s3-roundtrip.mjs`](../../spikes/aws-emulator/runtime/s3-roundtrip.mjs) does CreateBucket, PutObject
(64 KiB of random bytes), GetObject (bytes compared), ListObjectsV2 (exactly that key), DeleteObject,
ListObjectsV2 (empty), DeleteBucket, and the script prints the summary. One command:

```bash
bash spikes/aws-emulator/runtime/run.sh
```

## Evidence

Sandbox run of the final `run.sh` (run 3), 2026-11-12:

```
================ AWS Emulator runtime spike (AI-679) ================
emulator version : 1.0.322 (released 2026.11.10, commit 7753983c6e495ec3612695b1336bf4936fc7b7fd)
package          : https://downloads.aws.com/aws-emulator/packages/aws-emulator/LTS/aws-emulator_1.0.322-1_amd64.deb
signature        : valid signature by 98BCF336A3BE53B734E967C52E5BF49BD940F624 (gpgv)
install mode     : extract
package size     : 170938884 bytes (163 MiB)
binary size      : 970692256 bytes (925 MiB)
download seconds : 1.53
install seconds  : 7.55   (download + verify + install)
startup seconds  : 0.25   (launch to GET /__admin/health = ok)
s3 round trip    : ok
on stop          : credentials file removed
=====================================================================
```

Negative checks run by hand against the same emulator (same script, one setting changed):

| Change                                                | Result                                                                                                       |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `AWS_CA_BUNDLE` set, `NODE_EXTRA_CA_CERTS` not set    | `self-signed certificate` (`DEPTH_ZERO_SELF_SIGNED_CERT`) on the first call                                  |
| Credentials file holding a made-up key pair           | HTTP 403 `AccessDenied: Sign the request with the emulator credentials`                                      |
| Endpoint `https://localhost:9297`, default addressing | `ERR_TLS_CERT_ALTNAME_INVALID`: `Host: vhost-test.localhost. is not in the cert's altnames` (bucket in host) |

The signing key fingerprint was also checked independently of gpg: the public-key packet in
`current.asc` hashes to `98BCF336A3BE53B734E967C52E5BF49BD940F624`, user ID `SSM Publishing <ssm-publishing@amazon.com>`,
which matches the guide.

## Gaps found

- **Large artifact.** 163 MiB download, 925 MiB on disk. Every CI job that uses it pays the download
  unless the `.deb` is cached (for example `actions/cache` keyed on the pinned version).
- **No root, no `apt-get`.** The documented install needs root. `dpkg-deb -x` works and is equivalent for
  this package (verified by reading its `postinst`/`postrm`: they only manage the `/usr/bin` symlink), but
  it is not a documented path and the guide says package contents other than the command can change.
- **Node needs `NODE_EXTRA_CA_CERTS` at process start.** It cannot be set from inside a running Node
  process, and the certificate changes on every start, so the test runner must be started after the
  emulator (or the CA passed per client through a custom `requestHandler`).
- **Path-style only; endpoint must be `127.0.0.1`.** Virtual-hosted-style addressing is not served
  (upstream `issues/things-that-do-not-work/20261029T083133Z-s3-virtual-hosted-style-bucket-addressing-is-unreachable.md`).
  S3 Control requests can never reach it (the SDK always puts the account ID in the host).
- **Security behavior is not AWS behavior.** Per the security page, requests signed with the emulator's own
  key are never denied, and S3 bucket policies and KMS key policies are not checked (upstream also lists
  `20261027T000203Z-iam-s3-s3-getobject-performs-no-iam-authorization-a-principal.md`). Tests of scoped
  STS/Cognito credentials against S3 cannot show that the scoping works.
- **Known S3 fidelity issues that touch what `packages/storage-s3` uses** (upstream
  `issues/things-that-do-not-work/`, not reproduced here): conditional requests (`If-Match`/`If-None-Match`,
  range reads, object lock, restore) in `20261025T032458Z-s3-object-plane-10-root-causes-conditional-requests.md`;
  legacy (SigV2 query) presigned GET in `20261027T190000Z-s3-legacy-query-credential-presigned-get.md`
  (the SDK's SigV4 presigner is not that form); `UploadPart` missing the CRC64NVME checksum header in
  `20261029T072224Z-s3-uploadpart-does-not-return-x-amz-checksum.md`. That directory lists at least 1,000
  entries (the GitHub contents API stops at 1,000); 95 of those 1,000 name S3.
- **One Region per emulator.** The guide says to run one emulator per Region.
- **Telemetry is on by default.** CI and agent runs should pass `--telemetry off`.

## What this means for starkeep-core

- The epic can continue as far as the sandbox is concerned: the emulator installs and starts in the agent
  sandbox (proven here). The GitHub Actions path (`sudo apt-get install`, Node 22) is proven by runs
  43139326209 and 43141161803 on the AI-679 pull request (S3 round trip ok). In the sandbox the S3 SDK path that
  `packages/storage-s3` uses (same `@aws-sdk/client-s3` version, 3.1009.0) works against it with only
  environment configuration plus `forcePathStyle: true`. `S3ObjectStorageAdapter` builds its `S3Client`
  with `region` and `credentials` only, so pointing it at the emulator would need `endpoint` and
  `forcePathStyle` to be configurable (or `AWS_ENDPOINT_URL` plus an IP endpoint, which the SDK already
  turns into path style). That is a later issue's call; this spike changes no product code.
- Reuse this recipe as is: `run.sh` steps for install and start, the environment block for the SDK, and
  the 127.0.0.1 endpoint guard in `s3-roundtrip.mjs`.
- Experiments that rely on credential scoping (Cognito Identity Pool sessions, per-user key prefixes
  enforced by IAM) cannot be proven against the emulator: it does not enforce bucket policies, and its own
  key is always allowed. Treat a pass there as "the calls are well-formed", not "access is restricted".
- Presigned PUT/GET (SigV4 query form) and multipart uploads are used by `storage-s3` and are not covered by
  this spike; the upstream issue list suggests checking them before relying on the emulator for those paths.
