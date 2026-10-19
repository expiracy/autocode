# Releasing AutoCode

AutoCode ships as `opencode-autocode` under the MIT licence. The package requires
Node.js 22.18 or newer and the OpenCode v2 plugin API. CI checks Node.js 22.18 and
24 and runs native integrations with OpenCode 2.0.28 on Linux and macOS. Windows
host support is not part of this release's verified scope.

`0.1.0-beta.1` is staged at npm and still needs human approval. The public
`0.0.0-stage` package is npm's placeholder, not an installable AutoCode release.
Do not treat an uploaded stage, a passing rehearsal, or a placeholder as a live
release. Review any earlier staged candidate independently; it is not an artifact
produced by the controlled workflow below.

## Delivery contract

Pull requests, merge queues, and pushes to `main` run `.github/workflows/ci.yml`.
It typechecks and tests on both supported Node versions, lints the workflows with
checksummed actionlint 1.7.12, and builds JavaScript and **one npm tarball**. Its
`artifacts/manifest.json` records the source commit, repository, package name and
version, MIT licence, release channel, filename, SHA-256, SHA-512 integrity, and
build Node/npm versions. Prereleases use `next`; stable versions use `latest`.

The uploaded package contains `package.tgz` and `manifest.json`. CI passes its
immutable GitHub artifact ID to every consumer. Fresh-cache installation checks
on Node.js 22.18 and 24 and native OpenCode checks on Linux and macOS verify and
install that exact archive, without rebuilding or repacking it. Consumer
installation disables lifecycle scripts and resolves runtime dependencies and
peers normally from npm. Native tests use temporary profiles and a local fake
provider; they do not use maintainer provider connections or execute the
rejection fixtures.

The aggregate **CI required** job passes only when workflow lint, unit checks,
packaging, installation, and native integrations all pass. Failure, cancellation,
or skipping any dependency fails the aggregate. Require this check from the
GitHub Actions app in `main` protection, require branches to be up to date, and
apply the protection to administrators. Do not add path filters that prevent the
required workflow from running. See the repository's actual protection settings
before claiming merge enforcement is active.

Actions are pinned to commit SHAs, jobs have timeouts, checkout credentials are
not persisted, and normal jobs use read-only repository permissions. Dependabot
proposes weekly npm and Actions updates. Package artifacts are retained for 30
days and diagnostics for 14 days. Host diagnostics include sanitized logs and
result metadata, not profiles, credentials, or conversation payloads. Download
release evidence before its retention period expires.

## One-time delivery setup

The workflow is ready to rehearse without npm credentials. Staging additionally
requires both external gates below; workflow source alone does not configure
them.

1. In GitHub, create the `npm-staging` environment. Allow deployments only from
   branch `main`, without a matching tag rule. The staging job names this
   environment, and npm must match the same name. A required GitHub reviewer can
   add an earlier staging gate; final npm approval remains separate.
2. As a package maintainer, configure an npm trusted publisher for package
   `opencode-autocode`, repository `expiracy/autocode`, workflow filename
   `release.yml`, and environment `npm-staging`. Allow **staging only**. Leave
   direct publishing and dist-tag modification disabled. Using an interactive
   maintainer session with 2FA, the equivalent CLI command is:

   ```sh
   npm trust github opencode-autocode \
     --repo=expiracy/autocode \
     --file=release.yml \
     --environment=npm-staging \
     --allow-stage-publish
   ```

   npm trust administration requires interactive maintainer authentication and
   account 2FA; a stored automation token is not a substitute. Check the actual
   trust entry with `npm trust list opencode-autocode` or npm's package settings.
   npm requires a new trust entry to be validated within two days. If it expires,
   recreate it when an explicitly requested staging run is ready.

Use GitHub-hosted runners. The staging job pins npm 12.2.0, satisfying staged
publishing's npm 11.15/Node 22.14 minimum. It has `contents: read` and
`id-token: write`; no other job gets an OIDC token. The delivery helper rejects
missing OIDC identity and token authentication instead of falling back to a
stored npm key. Do not add `NPM_TOKEN`, `NODE_AUTH_TOKEN`, npm credentials, a
final-publication job, or a direct-publish fallback.

Check npm's package publishing access settings too. Requiring 2FA and disallowing
traditional publish tokens keeps all automated delivery on the approved OIDC
path. Review existing trusted publishers so another entry cannot allow direct
publishing unintentionally. Changing these settings is a maintainer action, not
something a rehearsal verifies.

## Prepare the candidate

1. Update `package.json` and `package-lock.json` together. Use a prerelease version
   for beta delivery, update `CHANGELOG.md`, and keep README/example version pins
   aligned. Set `publishConfig.tag` to `next` for prereleases or `latest` for stable
   versions; artifact verification rejects a mismatched channel. npm versions
   cannot be reused after publication.
2. Confirm licence, exported server and TUI entrypoints, documentation, runtime
   versions, and OpenCode support. Do not include local state, credentials,
   validation transcripts, or caches in the package.
3. Merge the candidate through a pull request after **CI required** passes. Keep
   the source commit you intend to release available on protected `main`.
4. For a local check before opening the PR:

   ```sh
   npm ci --ignore-scripts
   npm run check
   npm run lint:workflows
   npm run smoke:registry
   ```

   Local smoke checks are useful preparation; they do not replace the exact
   artifact checks in the release workflow.

## Rehearse, then request staging

Open GitHub Actions → **Release** → **Run workflow**, choose `main`, and leave
`delivery` at its default `rehearsal`. The equivalent CLI request is:

```sh
gh workflow run release.yml --ref main -f delivery=rehearsal
```

The workflow runs the full CI pipeline at its dispatch commit. Rehearsal downloads
and verifies the tested artifact and reports its manifest, without requesting
OIDC credentials or sending anything to npm. Inspect the actual run, aggregate
result, manifest, package contents, and diagnostics. A successful run does not
prove npm trust is configured.

Only when a maintainer explicitly wants to submit that candidate for review,
select `delivery: stage` from `main`:

```sh
gh workflow run release.yml --ref main -f delivery=stage
```

This run again creates one package and tests that same artifact. After every CI
check passes, the `npm-staging` job verifies the downloaded artifact's source,
version, licence, release channel, and checksums, then submits the existing
archive using npm OIDC staged delivery. It does not run project install/build
scripts, rebuild the archive, or publish it. Retain the workflow URL, source
commit, version, checksum manifest, and npm stage identifier as the review record.
A failed OIDC exchange or stage submission fails delivery; fix the configuration
instead of substituting a token.

## Human publication and verification

A package maintainer must review the stage in npm's **Staged Packages** tab,
compare it with the tested workflow artifact, and approve it with 2FA. Verify
name, version, source commit, integrity, package contents, release notes, and the
intended `next` or `latest` channel before approval. npm OIDC cannot perform this
approval, and no repository workflow attempts it.

After the human approval:

1. Verify registry metadata and integrity for that exact version and inspect
   `npm dist-tag ls opencode-autocode`. Beta versions must remain on `next`.
2. Run `npm run smoke:published` from the matching source revision. This installs
   the manifest version from npm with fresh caches, configures OpenCode by the
   exact package name/version, and runs the native suite. It cannot fall back to
   the local build or the tested prepublication archive.
3. Only after actual registry installation succeeds, mark the published-package
   scenario complete, update the README's staged status, and create a matching
   `vVERSION` source tag and GitHub release notes with links to npm and the tested
   workflow run.

Restart the terminal client after upgrading its TUI companion. If registry
verification fails, investigate and prepare a corrected version; do not claim a
successful release check or reuse a published version.

References: [npm staged publishing](https://docs.npmjs.com/staged-publishing/),
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/),
[trust configuration CLI](https://docs.npmjs.com/cli/v11/commands/npm-trust/),
[GitHub required checks](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks),
and [OpenCode package plugins](https://opencode.ai/v2/docs/build/plugins/#publish).
