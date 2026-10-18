# Releasing AutoCode

The npm package is `opencode-autocode`, licensed under MIT. Beta releases use
public access and the `next` distribution tag. Stable releases must explicitly
select `latest`.

The workflows in this repository run checks and produce artifacts only. They have
no npm publishing step, credentials, or OIDC write permission. npm trusted
publishing is not configured; the current release procedure uses npm credentials
configured locally.

## Prepare the release

1. Choose the version and update `package.json` and `package-lock.json` together.
   A published name/version combination cannot be reused, even after unpublishing;
   corrections require a new version.
2. Record user-visible changes and the release date in `CHANGELOG.md`. Update the
   pinned version in the README and example configuration, and confirm the
   documented commands, screenshots, and OpenCode support match the release.
3. Use Node.js 22.18 or newer, npm, and OpenCode 2.0.28. From a clean checkout:

   ```sh
   npm ci
   npm run release:check
   ```

`release:check` runs type checking, all unit tests, a build, the complete native
smoke suite with a fresh npm cache and ordinary dependency resolution, and a
package contents preview. It needs registry access to install dependencies.
All model traffic stays on a local fake provider, and OpenCode uses temporary
configuration and data directories. It does not use your installed provider
connections or change your OpenCode configuration.

The default `npm run smoke` remains an offline installation check after `npm ci`.
The release check additionally installs only the packed plugin, with lifecycle
scripts disabled, to verify the distributed JavaScript needs no consumer build.
Native checks cover inherited and separate reviewers, settings persistence,
config/log/status/help commands, project review history, compound commands, saved
approvals, hard policies, and actual blocked execution.

CI runs project checks on Node.js 22 and 24 and native installation checks on
Linux and macOS against OpenCode 2.0.28. The manually dispatched **Prepare release**
workflow reruns those checks and uploads the tarball and its npm file manifest,
identified by the source commit. It never publishes to npm or creates a GitHub
release. Review its actual run results before treating CI as verified.

## Pack and inspect

Build a tarball from the exact source commit intended for release:

```sh
npm pack
```

Inspect the resulting `opencode-autocode-<version>.tgz` with `tar -tzf`. Check the
name, version, MIT licence, README, example configuration, root server and TUI
entrypoints, generated JavaScript, type declarations, and dependencies. No local
sessions, validation reports, caches, credentials, or test fixtures belong in the
tarball. `prepack` builds the package, while `prepublishOnly` runs project checks
for a workspace publication. Publishing an existing tarball does not rerun these
checks, so retain the inspected artifact produced after the checks pass.

## Publish and verify

1. Check `npm view opencode-autocode` and verify that the intended npm account can
   publish the package. For a first publication, a 404 does not reserve the name
   or guarantee npm will accept it.
2. Verify authentication with `npm whoami`. If needed, sign in interactively with
   `npm login` and two-factor authentication, or configure an appropriately scoped
   granular token that npm permits to publish. Keep credentials outside the repo.
3. Publish the inspected tarball. For a beta, replace `VERSION` with the exact
   manifest version and keep the `next` tag:

   ```sh
   npm publish ./opencode-autocode-VERSION.tgz --access public --tag next
   ```

   For a stable release, explicitly use `--tag latest`. Do not move a beta to
   `latest` as part of ordinary prerelease publishing.
4. Verify registry metadata for that exact version, including its tarball and
   integrity, and inspect `npm dist-tag ls opencode-autocode`. Confirm that the
   intended tag points to the new version.
5. In a new isolated OpenCode profile, load `opencode-autocode@VERSION` directly
   by package name. Open and save `/autocode config`, run a harmless authorized
   `printf`, and inspect its review with `/autocode log`. Recheck the hard-deny
   behavior. Prepublication tarball checks do not verify registry package
   resolution; record the actual result of this separate installation check.

   `npm run smoke:published` automates this check for the manifest version. It
   installs from npm with fresh caches and configures OpenCode by package name;
   it never falls back to the local checkout or a prepublication tarball.
6. Tag the source commit `vVERSION` and create matching GitHub release notes. Link
   the npm package version and summarize changes, compatibility, and the checks
   actually completed.

Restart the terminal client after upgrading the plugin's TUI companion. If
postpublication verification fails, diagnose the failure and release a corrected
version; do not claim successful validation or attempt to reuse the version.

## Future trusted publishing

After the package exists, npm trusted publishing can be configured for the public
`expiracy/autocode` repository. A publishing workflow should use a GitHub-hosted
runner, a supported npm CLI, `contents: read` and `id-token: write`, and the exact
workflow filename configured in npm. Keep the manifest's repository URL aligned
with this repository. Trusted publishing from a public GitHub repository provides
provenance without storing a long-lived npm publish token.

The existing **Prepare release** workflow only prepares artifacts. Configuring
trusted publishing requires a corresponding npm setup and a publishing workflow;
adding release notes or changing a version alone does not enable it.

References: [npm publishing](https://docs.npmjs.com/creating-and-publishing-unscoped-public-packages/),
[distribution tags](https://docs.npmjs.com/adding-dist-tags-to-packages/),
[trusted publishing](https://docs.npmjs.com/trusted-publishers/), and
[OpenCode package plugins](https://opencode.ai/v2/docs/build/plugins/#publish).
