# Releasing ands

## npm (`andsh`)
1. Bump `version` in `packages/cli/package.json`.
2. Push a tag `npm-v<version>` (for example `npm-v0.1.0`). `.github/workflows/npm.yml` tests on
   Linux, macOS and Windows, then publishes `packages/cli/pkg` with provenance using the `NPM_TOKEN` secret.
   By hand instead: `npm run build:npm && npm publish packages/cli/pkg --access public`.

## Desktop app
The app's code is in the private `barzaken/ands-cloud` (`apps/desktop`). It is built here, for free,
by `.github/workflows/desktop.yml`, and released here, where ands.sh/download and the updater point.
ands-cloud starts the build with a `repository_dispatch` (its own `desktop.yml`): a push to its main
releases the version in `tauri.conf.json` if that tag does not exist yet; a pull request only builds.
By hand: run "Desktop app" here with an ands-cloud ref and, to release, a tag like `v0.1.7`.

Two secrets connect the repos (one fine-grained token owned by Bar can serve both):

| Repo | Secret | Token permission |
| --- | --- | --- |
| barzaken/ands | `ANDS_CLOUD_TOKEN` | barzaken/ands-cloud: Contents read |
| barzaken/ands-cloud | `ANDS_DISPATCH_TOKEN` | barzaken/ands: Contents read and write |

Signing turns on by itself when the secrets exist:

| Secret | What |
| --- | --- |
| `APPLE_CERTIFICATE` | base64 of the "Developer ID Application" .p12 |
| `APPLE_CERTIFICATE_PASSWORD` | the .p12 password |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Name (TEAMID)` |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | Apple ID, app-specific password, team id (notarization) |
| `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` | the app registration allowed to sign |
| `AZURE_SIGNING_ENDPOINT`, `AZURE_SIGNING_ACCOUNT`, `AZURE_CERT_PROFILE` | the Trusted Signing account |

The account service, the website and their setup are documented in the private barzaken/ands-cloud.
