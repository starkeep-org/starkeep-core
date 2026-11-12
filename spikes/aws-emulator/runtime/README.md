# aws-emulator runtime spike (AI-679)

Installs [AWS Emulator](https://github.com/aws/aws-emulator) from its Debian
package, starts it, waits for `GET /__admin/health`, runs an S3 round trip
(create bucket, put, get and compare bytes, list, delete) with
`@aws-sdk/client-s3`, and prints a one-screen summary: version, install
seconds, startup seconds, round trip ok/fail.

Findings and the reusable recipe: [docs/aws-emulator/01-runtime.md](../../../docs/aws-emulator/01-runtime.md).

## Run it

From the repo root, on Linux (x86_64 or arm64) with Node 22+, `pnpm`, `curl`,
`dpkg-deb` and `gpgv` (the last two come with `apt` on Debian and Ubuntu):

```bash
bash spikes/aws-emulator/runtime/run.sh
```

No AWS account or credentials are needed or used. The script removes every
other credential source the SDK could use (static keys, `AWS_PROFILE`, web
identity, container credentials) from the round trip's environment, refuses any
endpoint other than `https://127.0.0.1:<port>`, and signs with the keys the
emulator generates for that run.

The package signature is always verified with `gpgv` against the AWS signing
key pinned in `run.sh`; the script refuses to install a package that fails.

It is standalone: its own `package.json` and `pnpm-lock.yaml`, not in the root
`pnpm-workspace.yaml` (it installs with `pnpm install --ignore-workspace`), and
not run by `ci.yml`. CI runs it only through
`.github/workflows/aws-emulator-spike.yml`.

## Options (environment variables)

| Variable             | Default            | Meaning                                                                                                                                                                  |
| -------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `EMULATOR_VERSION`   | pinned in `run.sh` | Package version to install, or `latest`.                                                                                                                                 |
| `EMULATOR_INSTALL`   | `extract`          | `extract`: `dpkg-deb -x` into the work dir, no root. `apt`: `sudo apt-get install ./aws-emulator.deb` (the documented path; installs system-wide; the workflow uses it). |
| `EMULATOR_DATA_PORT` | `9297`             | Port the emulator listens on (1-65535). The script refuses to start if anything already listens there.                                                                   |

The emulator runs with telemetry off and is stopped with SIGTERM at the end,
which deletes its `~/.aws/emulator/<port>/` files (keys, CA, config). The
package, extracted binary and emulator log go to
`$RUNNER_TEMP/aws-emulator-spike` (or `$TMPDIR`, else `/tmp`), recreated each run.
